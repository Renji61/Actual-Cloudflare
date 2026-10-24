// The Actual sync server's core features, rewritten for Cloudflare.
//
// Ported from packages/sync-server in https://github.com/actualbudget/actual
// (app-account.js, account-db.js, accounts/password.js, app-sync.ts,
// app-sync/validation.js and sync-simple.js). Routes, status codes and
// response bodies match the original so the official web app works as-is.
//
// Included: password login, budget files, sync and end-to-end encryption.
// Not included: bank sync, OpenID, multiple users and user administration.
// Those endpoints answer "not configured" so the app hides or disables them.

import {
  create,
  fromBinary,
  merkle,
  MessageEnvelopeSchema,
  SyncRequestSchema,
  SyncResponseSchema,
  Timestamp,
  toBinary,
} from './vendor/crdt';

import { empty, json, notFound, preflight, text, withCors } from './http';
import { hashPassword, isValidPassword, verifyPassword } from './password';
import type { BlobStore, ServerConfig, Sql } from './storage';

const TOKEN_EXPIRATION_NEVER = -1;
const SYNC_FORMAT_VERSION = 2;
const ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const OK_RESPONSE = { status: 'ok' };

// Same limits as the original login rate limiter: 5 failed attempts per
// 15 minutes per client.
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_FAILURES = 5;

// JSON bodies are small, so they are the only bodies read before the request
// is authenticated. Uploads and sync requests are read later, with the
// (larger) configured limit.
const JSON_LIMIT_BYTES = 1024 * 1024;

const BANK_SYNC_PREFIXES = [
  '/gocardless',
  '/simplefin',
  '/pluggyai',
  '/akahu',
  '/enablebanking',
];

type Session = {
  token: string;
  expires_at: number;
  user_id: string;
  auth_method: string;
};

type FileRow = {
  id: string;
  group_id: string | null;
  sync_version: number | string | null;
  encrypt_meta: string | null;
  encrypt_keyid: string | null;
  encrypt_salt: string | null;
  encrypt_test: string | null;
  deleted: number;
  name: string | null;
  owner: string | null;
};

type Ctx = {
  request: Request;
  method: string;
  path: string;
  /** Parsed JSON body, or {} when the request has no JSON body. */
  body: Record<string, any>;
  /** Raw body, only set for JSON requests. Binary bodies are read on demand by readRawBody(). */
  raw: ArrayBuffer | null;
};

class HttpError extends Error {
  constructor(public response: Response) {
    super('http-error');
  }
}

export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && ID_REGEX.test(id);
}

/** Compares two secrets without leaking where they differ. */
async function secretsEqual(a: string, b: string) {
  const encoder = new TextEncoder();
  const [x, y] = await Promise.all(
    [a, b].map(async v => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(v)))),
  );
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export function blobKey(fileId: string) {
  return `user-files/file-${fileId}.blob`;
}

export class ActualServer {
  constructor(
    private sql: Sql,
    private blobs: BlobStore,
    private config: ServerConfig,
  ) {}

  async handle(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return preflight(request);
    }
    try {
      return withCors(await this.dispatch(request));
    } catch (err) {
      if (err instanceof HttpError) return withCors(err.response);
      console.log('Error on endpoint', request.method, new URL(request.url).pathname, err);
      return withCors(json({ status: 'error', reason: 'internal-error' }, 500));
    }
  }

  // ---------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------

  private async dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let path = url.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    const method = request.method === 'HEAD' ? 'GET' : request.method;

    const info = this.publicInfo(method, path);
    if (info) return info;

    const ctx: Ctx = { request, method, path, ...(await this.readJsonBody(request)) };

    if (path.startsWith('/account/')) return this.account(ctx);
    if (path.startsWith('/sync/')) return this.syncApp(ctx);
    if (path === '/secret' || path.startsWith('/secret/')) return this.secrets(ctx);
    if (path === '/admin/owner-created' && method === 'GET') {
      return json(this.ownerCount() > 0);
    }
    if (path === '/admin/users' && method === 'GET') {
      // The app maps over the list, so answer with an empty one.
      this.requireSession(ctx);
      return json([]);
    }
    if (path.startsWith('/admin/') || path.startsWith('/openid/')) {
      this.requireSession(ctx);
      return json(
        { status: 'error', reason: 'not-supported', details: 'disabled-on-this-server' },
        404,
      );
    }
    const bank = BANK_SYNC_PREFIXES.find(p => path.startsWith(p + '/'));
    if (bank) return this.bankSync(ctx, path.slice(bank.length));

    return notFound(request.method, url.pathname);
  }

  private publicInfo(method: string, path: string): Response | null {
    if (method !== 'GET') return null;
    switch (path) {
      case '/health':
        return json({ status: 'UP' });
      case '/mode':
        return text('production');
      case '/info':
        return json({
          build: {
            name: '@actual-app/sync-server',
            description: 'actual syncing server (Cloudflare port)',
            version: this.config.version,
          },
        });
      case '/metrics':
        return json({ mem: {}, uptime: 0 });
    }
    return null;
  }

  /** Reads a JSON body (at most 1 MB). Other bodies are left unread. */
  private async readJsonBody(request: Request): Promise<Pick<Ctx, 'body' | 'raw'>> {
    const type = (request.headers.get('content-type') || '').toLowerCase();
    if (
      request.method === 'GET' ||
      request.method === 'HEAD' ||
      !request.body ||
      !type.includes('application/json')
    ) {
      return { body: {}, raw: null };
    }

    const raw = await this.readLimited(request, JSON_LIMIT_BYTES);
    const source = new TextDecoder().decode(raw).trim();
    if (!source) return { body: {}, raw };
    try {
      const parsed = JSON.parse(source);
      return { body: parsed && typeof parsed === 'object' ? parsed : {}, raw };
    } catch {
      throw new HttpError(text('Bad Request', 400));
    }
  }

  /** Reads the raw body of an upload or sync request, up to the configured limit. */
  private async readRawBody(ctx: Ctx): Promise<ArrayBuffer> {
    if (ctx.raw) return ctx.raw;
    if (!ctx.request.body) return new ArrayBuffer(0);
    return this.readLimited(ctx.request, this.config.uploadLimitMB * 1024 * 1024);
  }

  private async readLimited(request: Request, limit: number): Promise<ArrayBuffer> {
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > limit) throw new HttpError(text('PayloadTooLargeError', 413));

    const raw = await request.arrayBuffer();
    if (raw.byteLength > limit) throw new HttpError(text('PayloadTooLargeError', 413));
    return raw;
  }

  // ---------------------------------------------------------------------
  // Sessions and users
  // ---------------------------------------------------------------------

  private getSession(ctx: Ctx): Session | Response {
    let token = ctx.body.token;
    if (!token) token = ctx.request.headers.get('x-actual-token');

    const session =
      typeof token === 'string' && token
        ? this.sql.first<Session>(
            `SELECT sessions.* FROM sessions
               JOIN users ON users.id = sessions.user_id
              WHERE sessions.token = ? AND users.enabled = 1`,
            token,
          )
        : null;

    if (!session) {
      return json(
        { status: 'error', reason: 'unauthorized', details: 'token-not-found' },
        401,
      );
    }

    if (
      session.expires_at !== TOKEN_EXPIRATION_NEVER &&
      session.expires_at * 1000 <= Date.now()
    ) {
      return json({ status: 'error', reason: 'token-expired' }, 401);
    }

    return session;
  }

  private requireSession(ctx: Ctx): Session {
    const session = this.getSession(ctx);
    if (session instanceof Response) throw new HttpError(session);
    return session;
  }

  private isAdmin(userId: string) {
    const row = this.sql.first<{ role: string }>('SELECT role FROM users WHERE id = ?', userId);
    return row?.role === 'ADMIN';
  }

  private ownerCount() {
    // Same query as getOwnerCount() in the original server: only owners with a
    // user name (OpenID users) count, so a password-only server reports none.
    const row = this.sql.first<{ n: number }>(
      "SELECT count(*) AS n FROM users WHERE user_name <> '' AND owner = 1",
    );
    return row?.n ?? 0;
  }

  private needsBootstrap() {
    return this.sql.all('SELECT method FROM auth').length === 0;
  }

  private listLoginMethods() {
    return this.sql
      .all<{ method: string; display_name: string; active: number }>(
        'SELECT method, display_name, active FROM auth',
      )
      .map(r => ({ method: r.method, active: r.active, displayName: r.display_name }));
  }

  private tokenExpiry() {
    const minutes = this.config.tokenExpiration;
    return minutes === 'never'
      ? TOKEN_EXPIRATION_NEVER
      : Math.floor(Date.now() / 1000) + minutes * 60;
  }

  private async loginWithPassword(password: unknown) {
    if (!isValidPassword(password)) return { error: 'invalid-password' };

    const auth = this.sql.first<{ extra_data: string }>(
      "SELECT extra_data FROM auth WHERE method = 'password'",
    );
    if (!auth?.extra_data) return { error: 'invalid-password' };

    if (!(await verifyPassword(password, auth.extra_data))) {
      return { error: 'invalid-password' };
    }

    return this.sql.transaction(() => {
      // The password may have changed while it was being verified.
      const current = this.sql.first<{ extra_data: string }>(
        "SELECT extra_data FROM auth WHERE method = 'password'",
      );
      if (current?.extra_data !== auth.extra_data) {
        return { error: 'invalid-password' };
      }

      let user = this.sql.first<{ id: string }>("SELECT id FROM users WHERE user_name = ''");
      if (!user) {
        user = { id: crypto.randomUUID() };
        this.sql.run(
          "INSERT INTO users (id, user_name, display_name, enabled, owner, role) VALUES (?, '', '', 1, 1, 'ADMIN')",
          user.id,
        );
      }

      const token = crypto.randomUUID();
      this.sql.run(
        'INSERT INTO sessions (token, expires_at, user_id, auth_method) VALUES (?, ?, ?, ?)',
        token,
        this.tokenExpiry(),
        user.id,
        'password',
      );
      this.sql.run(
        'DELETE FROM sessions WHERE expires_at <> -1 AND expires_at < ?',
        Math.floor(Date.now() / 1000) - 3600,
      );
      return { token };
    });
  }

  // ---------------------------------------------------------------------
  // Login rate limiting
  // ---------------------------------------------------------------------

  private clientKey(ctx: Ctx) {
    return ctx.request.headers.get('cf-connecting-ip') || 'unknown';
  }

  /**
   * Reserves an attempt for the client. This runs without awaiting, so
   * parallel requests can't all pass the check before any of them is counted.
   * Returns the start of the client's window, or a 429 response.
   */
  private reserveAttempt(client: string, now: number): number | Response {
    const row = this.sql.first<{ count: number; window_start: number }>(
      'SELECT count, window_start FROM auth_failures WHERE client = ?',
      client,
    );

    if (!row || now - row.window_start >= AUTH_WINDOW_MS) {
      // Start a new window, and drop the windows that have long expired.
      this.sql.run('DELETE FROM auth_failures WHERE window_start <= ?', now - AUTH_WINDOW_MS);
      this.sql.run(
        'INSERT INTO auth_failures (client, count, window_start) VALUES (?, 1, ?) ON CONFLICT (client) DO UPDATE SET count = 1, window_start = excluded.window_start',
        client,
        now,
      );
      return now;
    }

    if (row.count >= AUTH_MAX_FAILURES) {
      const retryAfter = Math.ceil((row.window_start + AUTH_WINDOW_MS - now) / 1000);
      return json({ status: 'error', reason: 'too-many-requests' }, 429, {
        'Retry-After': String(retryAfter),
      });
    }

    this.sql.run('UPDATE auth_failures SET count = count + 1 WHERE client = ?', client);
    return row.window_start;
  }

  /**
   * Like express-rate-limit with skipSuccessfulRequests: every attempt is
   * counted up front and given back if the request succeeds.
   */
  private async rateLimited(ctx: Ctx, handler: () => Promise<Response>) {
    const client = this.clientKey(ctx);
    const windowStart = this.reserveAttempt(client, Date.now());
    if (windowStart instanceof Response) return windowStart;

    const response = await handler();

    if (response.status < 400) {
      this.sql.run(
        'UPDATE auth_failures SET count = max(count - 1, 0) WHERE client = ? AND window_start = ?',
        client,
        windowStart,
      );
    }
    return response;
  }

  // ---------------------------------------------------------------------
  // /account
  // ---------------------------------------------------------------------

  private async account(ctx: Ctx): Promise<Response> {
    const route = `${ctx.method} ${ctx.path.slice('/account'.length)}`;

    switch (route) {
      case 'GET /needs-bootstrap': {
        const methods = this.listLoginMethods();
        return json({
          status: 'ok',
          data: {
            bootstrapped: !this.needsBootstrap(),
            loginMethod: methods.length === 1 ? methods[0].method : 'password',
            availableLoginMethods: methods,
            multiuser: false,
          },
        });
      }

      case 'POST /bootstrap':
        return this.rateLimited(ctx, () => this.bootstrap(ctx.body));

      case 'POST /reset-password':
        // Replaces the reset-password script of the original server.
        if (!this.config.resetToken) return notFound(ctx.request.method, ctx.path);
        return this.rateLimited(ctx, () => this.resetPassword(ctx));

      case 'GET /login-methods':
        return json({ status: 'ok', methods: this.listLoginMethods() });

      case 'POST /login':
        return this.rateLimited(ctx, async () => {
          const { error, token } = await this.loginWithPassword(ctx.body.password);
          if (error) return json({ status: 'error', reason: error }, 400);
          return json({ status: 'ok', data: { token } });
        });

      case 'POST /logout': {
        const token = ctx.body.token;
        if (typeof token !== 'string' || !token) {
          return json({ status: 'error', reason: 'invalid-token' }, 400);
        }
        this.sql.run('DELETE FROM sessions WHERE token = ?', token);
        return json({ status: 'ok', data: {} });
      }

      case 'POST /change-password':
        return this.rateLimited(ctx, () => this.changePassword(ctx));

      case 'POST /server-prefs': {
        const session = this.getSession(ctx);
        if (session instanceof Response) return session;
        if (!this.isAdmin(session.user_id)) {
          return json(
            { status: 'error', reason: 'forbidden', details: 'permission-not-found' },
            403,
          );
        }
        const prefs = ctx.body.prefs;
        if (!prefs || typeof prefs !== 'object') {
          return json({ status: 'error', reason: 'invalid-prefs' }, 400);
        }
        this.sql.transaction(() => {
          for (const [key, value] of Object.entries(prefs)) {
            this.sql.run(
              'INSERT INTO server_prefs (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
              key,
              value == null ? null : String(value),
            );
          }
        });
        return json({ status: 'ok', data: {} });
      }

      case 'GET /validate': {
        const session = this.getSession(ctx);
        if (session instanceof Response) return session;
        const user = this.sql.first<{
          user_name: string;
          display_name: string;
          role: string;
        }>('SELECT * FROM users WHERE id = ?', session.user_id);
        if (!user) {
          return json({ status: 'error', reason: 'User not found' }, 400);
        }
        const prefs: Record<string, unknown> = {};
        for (const row of this.sql.all<{ key: string; value: string }>(
          'SELECT key, value FROM server_prefs',
        )) {
          prefs[row.key] = row.value;
        }
        return json({
          status: 'ok',
          data: {
            validated: true,
            userName: user.user_name,
            permission: user.role,
            userId: session.user_id,
            displayName: user.display_name,
            loginMethod: session.auth_method,
            prefs,
          },
        });
      }
    }

    return notFound(ctx.request.method, ctx.path);
  }

  private createPasswordAuth(hash: string): boolean {
    return this.sql.transaction(() => {
      // Check again: another request may have bootstrapped while hashing.
      if (!this.needsBootstrap()) return false;
      this.sql.run(
        "INSERT INTO auth (method, display_name, extra_data, active) VALUES ('password', 'Password', ?, 1)",
        hash,
      );
      return true;
    });
  }

  /** Sets the password from the optional SETUP_PASSWORD secret, only while no password exists. */
  async bootstrapFromSecret(): Promise<void> {
    const password = this.config.setupPassword;
    if (!password || !this.needsBootstrap()) return;
    if (!isValidPassword(password)) {
      console.error('SETUP_PASSWORD is not a valid password; ignoring it.');
      return;
    }
    this.createPasswordAuth(await hashPassword(password));
  }

  private async bootstrap(settings: Record<string, any>): Promise<Response> {
    const fail = (reason: string) => json({ status: 'error', reason }, 400);

    // Same order of checks as bootstrap() in the original server.
    if (!settings || typeof settings !== 'object') return fail('invalid-login-settings');
    if ('password' in settings && !isValidPassword(settings.password)) {
      return fail('invalid-password');
    }
    if (!this.needsBootstrap()) return fail('already-bootstrapped');
    if ('openId' in settings) return fail('openid-not-supported');
    if (!('password' in settings)) return fail('no-auth-method-selected');

    const hash = await hashPassword(settings.password);

    if (!this.createPasswordAuth(hash)) return fail('already-bootstrapped');

    const result = await this.loginWithPassword(settings.password);
    if (result.error) return fail(result.error);
    return json({ status: 'ok', data: result });
  }

  private async resetPassword(ctx: Ctx): Promise<Response> {
    const given = ctx.request.headers.get('x-reset-token') ?? '';
    if (!(await secretsEqual(given, this.config.resetToken ?? ''))) {
      return json({ status: 'error', reason: 'unauthorized' }, 401);
    }

    // Users, files and sync data stay, so the owner keeps every budget.
    this.sql.transaction(() => {
      this.sql.run('DELETE FROM auth');
      this.sql.run('DELETE FROM sessions');
    });
    return json({ status: 'ok', data: {} });
  }

  private async changePassword(ctx: Ctx): Promise<Response> {
    const session = this.getSession(ctx);
    if (session instanceof Response) return session;

    if (!this.isAdmin(session.user_id)) {
      return json({ status: 'error', reason: 'forbidden', details: 'permission-not-found' }, 403);
    }
    if (session.auth_method !== 'password') {
      return json(
        { status: 'error', reason: 'forbidden', details: 'password-auth-not-active' },
        403,
      );
    }

    const { password, currentPassword } = ctx.body;
    if (!isValidPassword(currentPassword)) {
      return json({ status: 'error', reason: 'invalid-current-password' }, 400);
    }
    if (!isValidPassword(password)) {
      return json({ status: 'error', reason: 'invalid-password' }, 400);
    }

    const auth = this.sql.first<{ extra_data: string }>(
      "SELECT extra_data FROM auth WHERE method = 'password'",
    );
    if (!auth) return json({ status: 'error', reason: 'no-password-method' }, 400);
    if (!(await verifyPassword(currentPassword, auth.extra_data))) {
      return json({ status: 'error', reason: 'invalid-current-password' }, 400);
    }

    const hashed = await hashPassword(password);
    const error = this.sql.transaction(() => {
      const current = this.sql.first<{ extra_data: string }>(
        "SELECT extra_data FROM auth WHERE method = 'password'",
      );
      if (current?.extra_data !== auth.extra_data) return 'invalid-current-password';
      this.sql.run("UPDATE auth SET extra_data = ? WHERE method = 'password'", hashed);
      this.sql.run("DELETE FROM sessions WHERE auth_method = 'password'");
      return null;
    });
    if (error) return json({ status: 'error', reason: error }, 400);
    return json({ status: 'ok', data: {} });
  }

  // ---------------------------------------------------------------------
  // /sync
  // ---------------------------------------------------------------------

  private getFile(fileId: string): FileRow | null {
    const row = this.sql.first<FileRow>('SELECT * FROM files WHERE id = ?', fileId);
    return row && !row.deleted ? row : null;
  }

  /** Mirrors verifyFileExists() in the original server. */
  private findFile(fileId: unknown, notFoundBody: string | object): FileRow {
    if (!isValidId(fileId)) throw new HttpError(text('invalid fileId', 400));
    const file = this.getFile(fileId);
    if (!file) {
      throw new HttpError(
        typeof notFoundBody === 'string' ? text(notFoundBody, 400) : json(notFoundBody, 400),
      );
    }
    return file;
  }

  private requireFileOwner(file: FileRow, userId: string) {
    if (file.owner === userId || this.isAdmin(userId)) return;
    throw new HttpError(text('file-access-not-allowed', 403));
  }

  private usersWithAccess(file: FileRow) {
    const owner = file.owner
      ? this.sql.first<{ id: string; display_name: string; user_name: string }>(
          'SELECT id, display_name, user_name FROM users WHERE id = ?',
          file.owner,
        )
      : null;
    return owner
      ? [
          {
            userId: owner.id,
            displayName: owner.display_name,
            userName: owner.user_name,
            owner: true,
          },
        ]
      : [];
  }

  private async syncApp(ctx: Ctx): Promise<Response> {
    const session = this.requireSession(ctx);
    const userId = session.user_id;
    const headers = ctx.request.headers;
    const route = `${ctx.method} ${ctx.path.slice('/sync'.length)}`;

    switch (route) {
      case 'POST /sync':
        return this.sync(ctx, userId);

      case 'POST /user-get-key': {
        const file = this.findFile(ctx.body.fileId, 'file-not-found');
        this.requireFileOwner(file, userId);
        return json({
          status: 'ok',
          data: { id: file.encrypt_keyid, salt: file.encrypt_salt, test: file.encrypt_test },
        });
      }

      case 'POST /user-create-key': {
        const { fileId, keyId, keySalt, testContent } = ctx.body;
        const file = this.findFile(fileId, 'file-not-found');
        this.requireFileOwner(file, userId);
        this.updateFile(file.id, {
          encrypt_salt: keySalt,
          encrypt_keyid: keyId,
          encrypt_test: testContent,
        });
        return json(OK_RESPONSE);
      }

      case 'POST /reset-user-file': {
        const file = this.findFile(ctx.body.fileId, 'User or file not found');
        this.requireFileOwner(file, userId);
        const groupId = file.group_id;
        this.sql.transaction(() => {
          this.updateFile(file.id, { group_id: null });
          if (groupId) {
            this.sql.run('DELETE FROM messages_binary WHERE group_id = ?', groupId);
            this.sql.run('DELETE FROM messages_merkles WHERE group_id = ?', groupId);
          }
        });
        return json(OK_RESPONSE);
      }

      case 'POST /upload-user-file':
        return this.upload(ctx, userId);

      case 'GET /download-user-file': {
        const fileId = headers.get('x-actual-file-id');
        if (fileId === null) return text('Single file ID is required', 400);
        const file = this.findFile(fileId, 'User or file not found');
        this.requireFileOwner(file, userId);

        const object = await this.blobs.get(blobKey(file.id));
        if (!object || !object.body) return text('Not Found', 404);
        return new Response(object.body, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(object.size),
            'Content-Disposition': `attachment;filename=${file.id}`,
          },
        });
      }

      case 'POST /update-user-filename': {
        const file = this.findFile(ctx.body.fileId, 'file-not-found');
        this.requireFileOwner(file, userId);
        this.updateFile(file.id, { name: ctx.body.name });
        return json(OK_RESPONSE);
      }

      case 'GET /list-user-files': {
        const rows = this.isAdmin(userId)
          ? this.sql.all<FileRow>('SELECT * FROM files WHERE deleted = 0 LIMIT 1000')
          : this.sql.all<FileRow>(
              'SELECT * FROM files WHERE owner = ? AND deleted = 0 LIMIT 1000',
              userId,
            );
        return json({
          status: 'ok',
          data: rows.map(row => ({
            deleted: row.deleted ? 1 : 0,
            fileId: row.id,
            groupId: row.group_id,
            name: row.name,
            encryptKeyId: row.encrypt_keyid,
            owner: row.owner,
            usersWithAccess: this.usersWithAccess(row),
          })),
        });
      }

      case 'GET /get-user-file-info': {
        const file = this.findFile(headers.get('x-actual-file-id'), {
          status: 'error',
          reason: 'file-not-found',
        });
        this.requireFileOwner(file, userId);
        return json({
          status: 'ok',
          data: {
            deleted: file.deleted ? 1 : 0,
            fileId: file.id,
            groupId: file.group_id,
            name: file.name,
            encryptMeta: file.encrypt_meta ? JSON.parse(file.encrypt_meta) : null,
            usersWithAccess: this.usersWithAccess(file),
          },
        });
      }

      case 'POST /delete-user-file': {
        const fileId = ctx.body.fileId;
        if (!fileId) {
          return json(
            { details: 'fileId-required', reason: 'unprocessable-entity', status: 'error' },
            422,
          );
        }
        const file = this.findFile(fileId, 'file-not-found');
        this.requireFileOwner(file, userId);
        this.updateFile(file.id, { deleted: 1 });
        return json(OK_RESPONSE);
      }
    }

    return notFound(ctx.request.method, ctx.path);
  }

  private updateFile(id: string, update: Partial<Omit<FileRow, 'id'>>) {
    const entries = Object.entries(update).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    this.sql.run(
      `UPDATE files SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...entries.map(([, v]) => v),
      id,
    );
  }

  private async upload(ctx: Ctx, userId: string): Promise<Response> {
    const headers = ctx.request.headers;
    const nameHeader = headers.get('x-actual-name');
    if (nameHeader === null) return text('single x-actual-name is required', 400);

    let name: string;
    try {
      name = decodeURIComponent(nameHeader);
    } catch {
      return text('Bad Request', 400);
    }

    const fileId = headers.get('x-actual-file-id');
    if (!fileId) return text('fileId is required', 400);
    if (!isValidId(fileId)) return text('invalid fileId', 400);

    const groupIdHeader = headers.get('x-actual-group-id');
    const encryptMeta = headers.get('x-actual-encrypt-meta');
    const syncFormatVersion = headers.get('x-actual-format');

    let groupId: string | null = null;
    if (groupIdHeader !== null) {
      if (!isValidId(groupIdHeader)) return text('invalid groupId', 400);
      groupId = groupIdHeader;
    }

    let keyId: string | null = null;
    if (encryptMeta) {
      try {
        keyId = JSON.parse(encryptMeta).keyId ?? null;
      } catch {
        return text('invalid encrypt meta', 400);
      }
    }

    const currentFile = this.getFile(fileId);
    if (currentFile) this.requireFileOwner(currentFile, userId);

    if (currentFile) {
      // Same checks as validateUploadedFile() in the original server.
      if (groupId !== currentFile.group_id) return text('file-has-reset', 400);
      if (keyId !== currentFile.encrypt_keyid) return text('file-has-new-key', 400);
    }

    // Only now, with the session and headers checked, is the file read.
    const raw = await this.readRawBody(ctx);

    try {
      await this.blobs.put(blobKey(fileId), raw);
    } catch (err) {
      console.log('Error writing file', err);
      return json({ status: 'error' }, 500);
    }

    const syncVersion = syncFormatVersion === null ? null : Number(syncFormatVersion);

    if (!currentFile) {
      // A file id that was deleted earlier is re-created from scratch.
      const newGroupId = crypto.randomUUID();
      this.sql.run(
        `INSERT INTO files (id, group_id, sync_version, name, encrypt_meta, encrypt_salt, encrypt_test, encrypt_keyid, deleted, owner)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?)
         ON CONFLICT (id) DO UPDATE SET group_id = excluded.group_id, sync_version = excluded.sync_version,
           name = excluded.name, encrypt_meta = excluded.encrypt_meta, encrypt_salt = NULL,
           encrypt_test = NULL, encrypt_keyid = NULL, deleted = 0, owner = excluded.owner`,
        fileId,
        newGroupId,
        syncVersion,
        name,
        encryptMeta,
        userId,
      );
      return json({ status: 'ok', groupId: newGroupId });
    }

    if (!groupId) {
      // Sync state was reset, so start a new group.
      groupId = crypto.randomUUID();
      this.updateFile(fileId, { group_id: groupId });
    }

    this.updateFile(fileId, {
      sync_version: syncVersion,
      encrypt_meta: encryptMeta,
      name,
    });

    return json({ status: 'ok', groupId });
  }

  private async sync(ctx: Ctx, userId: string): Promise<Response> {
    // The session was validated in syncApp(), so reading the body is safe.
    const raw = await this.readRawBody(ctx);
    let requestPb;
    try {
      requestPb = fromBinary(SyncRequestSchema, new Uint8Array(raw));
    } catch (e) {
      console.log('Error parsing sync request', e);
      return json({ status: 'error', reason: 'internal-error' }, 500);
    }

    const fileId = requestPb.fileId || null;
    const groupId = requestPb.groupId || null;
    const keyId = requestPb.keyId || null;
    const since = requestPb.since || null;
    const messages = requestPb.messages;

    if (!since) {
      return json(
        { details: 'since-required', reason: 'unprocessable-entity', status: 'error' },
        422,
      );
    }

    const file = this.findFile(fileId, 'file-not-found');
    this.requireFileOwner(file, userId);

    // Same checks, in the same order, as validateSyncedFile().
    if (file.sync_version == null || Number(file.sync_version) < SYNC_FORMAT_VERSION) {
      return text('file-old-version', 400);
    }
    if (file.group_id == null) return text('file-needs-upload', 400);
    const uploadedKeyId = file.encrypt_meta ? JSON.parse(file.encrypt_meta).keyId : null;
    if (uploadedKeyId !== file.encrypt_keyid) return text('file-key-mismatch', 400);
    if (groupId !== file.group_id) return text('file-has-reset', 400);
    if (keyId !== file.encrypt_keyid) return text('file-has-new-key', 400);

    const group = file.group_id;

    const { trie, newMessages } = this.sql.transaction(() => {
      const newMessages = this.sql.all<{
        timestamp: string;
        is_encrypted: number;
        content: ArrayBuffer;
      }>(
        `SELECT timestamp, is_encrypted, content FROM messages_binary
          WHERE group_id = ? AND timestamp > ?
          ORDER BY timestamp`,
        group,
        since,
      );

      const stored = this.sql.first<{ merkle: string }>(
        'SELECT merkle FROM messages_merkles WHERE group_id = ?',
        group,
      );
      let trie = stored ? JSON.parse(stored.merkle) : {};

      for (const msg of messages) {
        const exists = this.sql.first(
          'SELECT 1 AS found FROM messages_binary WHERE group_id = ? AND timestamp = ?',
          group,
          msg.timestamp,
        );
        if (exists) continue;
        this.sql.run(
          'INSERT INTO messages_binary (group_id, timestamp, is_encrypted, content) VALUES (?, ?, ?, ?)',
          group,
          msg.timestamp,
          msg.isEncrypted ? 1 : 0,
          msg.content.slice().buffer,
        );
        trie = merkle.insert(trie, Timestamp.parse(msg.timestamp)!);
      }

      trie = merkle.prune(trie);
      this.sql.run(
        'INSERT INTO messages_merkles (group_id, merkle) VALUES (?, ?) ON CONFLICT (group_id) DO UPDATE SET merkle = excluded.merkle',
        group,
        JSON.stringify(trie),
      );

      return { trie, newMessages };
    });

    const responsePb = create(SyncResponseSchema, {
      merkle: JSON.stringify(trie),
      messages: newMessages.map(msg =>
        create(MessageEnvelopeSchema, {
          timestamp: msg.timestamp,
          isEncrypted: msg.is_encrypted === 1,
          content: new Uint8Array(msg.content),
        }),
      ),
    });

    return new Response(toBinary(SyncResponseSchema, responsePb), {
      headers: {
        'Content-Type': 'application/actual-sync',
        'X-ACTUAL-SYNC-METHOD': 'simple',
      },
    });
  }

  // ---------------------------------------------------------------------
  // Features that are switched off on this server
  // ---------------------------------------------------------------------

  private secrets(ctx: Ctx): Response {
    this.requireSession(ctx);
    if (ctx.method === 'POST' && ctx.path === '/secret') {
      return json(
        {
          status: 'error',
          reason: 'not-supported',
          details: 'Bank sync is not available on this server',
        },
        400,
      );
    }
    if ((ctx.method === 'GET' || ctx.method === 'DELETE') && ctx.path.startsWith('/secret/')) {
      return text('key not found', 404);
    }
    return notFound(ctx.request.method, ctx.path);
  }

  private bankSync(ctx: Ctx, route: string): Response {
    this.requireSession(ctx);
    if (route === '/status') {
      return json({ status: 'ok', data: { configured: false } });
    }
    return json(
      {
        status: 'error',
        reason: 'not-supported',
        details: 'Bank sync is not available on this server',
      },
      400,
    );
  }
}
