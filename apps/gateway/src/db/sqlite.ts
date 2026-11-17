import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Forward-only migrations. Each entry runs once inside a transaction and is
 * recorded in schema_migrations, so deploys can apply them on boot safely.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE siwe_nonces (
    nonce TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    chain_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_expires ON sessions(expires_at);
  CREATE TABLE accounts (
    address TEXT PRIMARY KEY,
    balance REAL NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE agents (
    account TEXT NOT NULL,
    agent TEXT NOT NULL,
    valid_until INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account, agent)
  );
  -- Replay protection: one row per (signer, nonce). request_hash lets an
  -- identical resubmission be answered idempotently instead of rejected.
  CREATE TABLE used_nonces (
    signer TEXT NOT NULL,
    nonce TEXT NOT NULL,
    kind TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    ref TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (signer, nonce)
  );
  CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    account TEXT NOT NULL,
    signer TEXT NOT NULL,
    cloid TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    type TEXT NOT NULL,
    price REAL NOT NULL,
    size REAL NOT NULL,
    filled_size REAL NOT NULL DEFAULT 0,
    avg_fill_price REAL,
    reduce_only INTEGER NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (account, cloid)
  );
  CREATE INDEX orders_account ON orders(account, created_at DESC);
  CREATE INDEX orders_working ON orders(status) WHERE status IN ('open', 'partially_filled');
  CREATE TABLE fills (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    account TEXT NOT NULL,
    cloid TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    price REAL NOT NULL,
    size REAL NOT NULL,
    fee REAL NOT NULL,
    liquidity TEXT NOT NULL,
    realized_pnl REAL NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX fills_account ON fills(account, ts DESC);
  CREATE TABLE positions (
    account TEXT NOT NULL,
    symbol TEXT NOT NULL,
    size REAL NOT NULL,
    entry_price REAL NOT NULL,
    realized_pnl REAL NOT NULL,
    PRIMARY KEY (account, symbol)
  );
  `,
];

export type Database = DatabaseSync;

export function openDatabase(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
    v: number | null;
  };
  const current = row.v ?? 0;
  for (let version = current + 1; version <= MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version - 1]!);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        version,
        Date.now(),
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
