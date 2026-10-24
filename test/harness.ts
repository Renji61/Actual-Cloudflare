// Runs the server against Node's built-in SQLite and an in-memory file store,
// standing in for the Durable Object's SQLite and R2.

import { DatabaseSync } from 'node:sqlite';

import { ActualServer } from '../src/server.ts';
import { migrate, type BlobStore, type ServerConfig, type Sql } from '../src/storage.ts';

function toNode(value: unknown) {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

function fromNode(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    // Durable Object SQLite returns BLOB columns as ArrayBuffer.
    out[key] =
      value instanceof Uint8Array
        ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
        : value;
  }
  return out;
}

export class NodeSql implements Sql {
  db = new DatabaseSync(':memory:');
  private depth = 0;

  all<T>(query: string, ...bindings: unknown[]): T[] {
    return this.db
      .prepare(query)
      .all(...(bindings.map(toNode) as any[]))
      .map(r => fromNode(r as Record<string, unknown>)) as T[];
  }

  first<T>(query: string, ...bindings: unknown[]): T | null {
    return (this.all<T>(query, ...bindings)[0] ?? null) as T | null;
  }

  run(query: string, ...bindings: unknown[]): void {
    if (bindings.length === 0 && /^\s*CREATE/i.test(query)) {
      this.db.exec(query);
      return;
    }
    this.db.prepare(query).run(...(bindings.map(toNode) as any[]));
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) throw new Error('nested transactions are not supported');
    this.depth++;
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth--;
    }
  }
}

export class MemoryBlobs implements BlobStore {
  files = new Map<string, Uint8Array>();

  async put(key: string, value: ArrayBuffer) {
    this.files.set(key, new Uint8Array(value.slice(0)));
  }

  async get(key: string) {
    const data = this.files.get(key);
    if (!data) return null;
    return { body: new Response(data).body, size: data.byteLength };
  }

  async delete(key: string) {
    this.files.delete(key);
  }
}

export function makeServer(config: Partial<ServerConfig> = {}) {
  const sql = new NodeSql();
  migrate(sql);
  const blobs = new MemoryBlobs();
  const server = new ActualServer(sql, blobs, {
    tokenExpiration: 'never',
    uploadLimitMB: 50,
    version: '26.10.0',
    ...config,
  });

  const BASE = 'https://budget.example.com';

  async function call(
    method: string,
    path: string,
    { json, body, headers = {}, ip = '203.0.113.1' }: {
      json?: unknown;
      body?: BodyInit;
      headers?: Record<string, string>;
      ip?: string;
    } = {},
  ) {
    const init: RequestInit = {
      method,
      headers: { 'cf-connecting-ip': ip, ...headers },
    };
    if (json !== undefined) {
      init.body = JSON.stringify(json);
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
    } else if (body !== undefined) {
      init.body = body;
    }
    // workers-types types json() as unknown; the tests read untyped JSON bodies.
    return (await server.handle(new Request(BASE + path, init))) as Omit<Response, 'json'> & {
      json(): Promise<any>;
    };
  }

  return { server, sql, blobs, call };
}
