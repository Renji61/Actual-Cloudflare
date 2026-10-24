// Small storage interfaces so the server logic can run inside a Durable
// Object in production and against plain Node SQLite in the test suite.

export type SqlValue = string | number | null | ArrayBuffer;
export type Row = Record<string, SqlValue>;

export interface Sql {
  /** Run a statement and return every result row. */
  all<T extends Row = Row>(query: string, ...bindings: unknown[]): T[];
  /** Run a statement and return the first row, or null. */
  first<T extends Row = Row>(query: string, ...bindings: unknown[]): T | null;
  /** Run a statement that returns nothing. */
  run(query: string, ...bindings: unknown[]): void;
  /** Run `fn` atomically. */
  transaction<T>(fn: () => T): T;
}

/** The subset of the R2 bucket API the server uses. */
export interface BlobStore {
  put(key: string, value: ArrayBuffer): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream | null; size: number } | null>;
  delete(key: string): Promise<void>;
}

export interface ServerConfig {
  /** "never", or a number of minutes a login stays valid. */
  tokenExpiration: 'never' | number;
  /** Largest accepted upload or sync request, in megabytes. */
  uploadLimitMB: number;
  /** Version reported by /info. */
  version: string;
  /** Secret that allows POST /account/reset-password. The endpoint is off when unset. */
  resetToken?: string;
  /** Password to set at start-up, only while no password exists yet. */
  setupPassword?: string;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS auth (
  method TEXT PRIMARY KEY,
  display_name TEXT,
  extra_data TEXT,
  active INTEGER
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  user_name TEXT,
  display_name TEXT,
  role TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  owner INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  expires_at INTEGER,
  user_id TEXT,
  auth_method TEXT
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  group_id TEXT,
  sync_version INTEGER,
  encrypt_meta TEXT,
  encrypt_keyid TEXT,
  encrypt_salt TEXT,
  encrypt_test TEXT,
  deleted INTEGER DEFAULT 0,
  name TEXT,
  owner TEXT
);

CREATE TABLE IF NOT EXISTS server_prefs (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS messages_binary (
  group_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  is_encrypted INTEGER,
  content BLOB,
  PRIMARY KEY (group_id, timestamp)
);

CREATE TABLE IF NOT EXISTS messages_merkles (
  group_id TEXT PRIMARY KEY,
  merkle TEXT
);

CREATE TABLE IF NOT EXISTS auth_failures (
  client TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
`;

export function migrate(sql: Sql) {
  for (const statement of SCHEMA.split(';')) {
    if (statement.trim()) {
      sql.run(statement);
    }
  }
}
