// Cloudflare entry point.
//
// Requests for the web app are served straight from static assets (see
// "assets" in wrangler.jsonc). API requests are passed to a single Durable
// Object, which keeps the login, the budget-file list and the sync history
// in its built-in SQLite database. Budget files themselves live in R2.

import { DurableObject } from 'cloudflare:workers';

import { isApiPath, SPA_PATHS } from './routes';
import { ActualServer } from './server';
import { migrate, type ServerConfig, type Sql } from './storage';
import { WEB_VERSION } from './version';

export interface Env {
  ACTUAL: DurableObjectNamespace<ActualStore>;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  /** "never" (default) or the number of minutes a login stays valid. */
  TOKEN_EXPIRATION?: string;
  /** Largest upload or sync request in MB. Defaults to 50. */
  UPLOAD_LIMIT_MB?: string;
  /** Secret that enables POST /account/reset-password. Set it with `wrangler secret put`. */
  ADMIN_RESET_TOKEN?: string;
  /**
   * Optional secret (`wrangler secret put SETUP_PASSWORD`). If no password exists yet, the
   * server starts with this one, so nobody can claim a fresh deploy first. It is ignored once
   * a password exists, so changing the password in the app is never overridden.
   */
  SETUP_PASSWORD?: string;
}

function configFrom(env: Env): ServerConfig {
  const expiration = (env.TOKEN_EXPIRATION || 'never').trim();
  const minutes = Number(expiration);
  return {
    tokenExpiration:
      expiration !== 'never' && Number.isFinite(minutes) && minutes > 0 ? minutes : 'never',
    uploadLimitMB: Number(env.UPLOAD_LIMIT_MB) > 0 ? Number(env.UPLOAD_LIMIT_MB) : 50,
    version: WEB_VERSION,
    resetToken: env.ADMIN_RESET_TOKEN || undefined,
    setupPassword: env.SETUP_PASSWORD || undefined,
  };
}

class DurableSql implements Sql {
  constructor(private storage: DurableObjectStorage) {}

  all<T>(query: string, ...bindings: unknown[]): T[] {
    return this.storage.sql.exec(query, ...bindings).toArray() as T[];
  }

  first<T>(query: string, ...bindings: unknown[]): T | null {
    return (this.all<T>(query, ...bindings)[0] ?? null) as T | null;
  }

  run(query: string, ...bindings: unknown[]): void {
    this.storage.sql.exec(query, ...bindings).toArray();
  }

  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
}

export class ActualStore extends DurableObject<Env> {
  private server: ActualServer;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = new DurableSql(ctx.storage);
    this.server = new ActualServer(sql, env.FILES, configFrom(env));
    ctx.blockConcurrencyWhile(async () => {
      migrate(sql);
      await this.server.bootstrapFromSecret();
    });
  }

  async fetch(request: Request): Promise<Response> {
    return this.server.handle(request);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    // Answer health checks without waking the Durable Object.
    if (pathname === '/health' && request.method === 'GET') {
      return Response.json({ status: 'UP' }, { headers: { 'Access-Control-Allow-Origin': '*' } });
    }

    // Page reloads on these app routes need index.html, not the API.
    if (request.method === 'GET' && SPA_PATHS.has(pathname)) {
      return env.ASSETS.fetch(request);
    }

    if (isApiPath(pathname)) {
      // One instance holds everything, which keeps sync strictly ordered.
      const store = env.ACTUAL.get(env.ACTUAL.idFromName('main'));
      return store.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
