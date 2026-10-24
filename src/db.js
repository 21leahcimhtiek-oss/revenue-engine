// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Aurora Revenue Engine â€” SHARED DATABASE MODULE
//
// Owns the SQLite schema for the whole engine.
//
// MIGRATION STRATEGY (additive only, idempotent, never drops data)
//   1. CREATE TABLE IF NOT EXISTS for every new table.
//   2. ALTER TABLE ... ADD COLUMN for the new `licenses` columns, guarded by a
//      PRAGMA table_info check AND wrapped in try/catch, so re-running is safe.
//   3. Indexes created with IF NOT EXISTS.
//   4. Legacy `licenses.status` vocabulary normalised to
//      issued | active | suspended | expired | revoked (unknown -> suspended).
//
// The pre-existing tables (licenses, subscribers, invoices, leads, campaigns,
// campaign_runs, campaign_sent, channel_metrics, analytics_snapshots) are NEVER
// dropped or recreated â€” their rows survive untouched.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

/** Default database path: <repo>/data/licenses.db (override with REVENUE_DB_PATH). */
export const DB_PATH = path.resolve(
  process.env.REVENUE_DB_PATH && process.env.REVENUE_DB_PATH.trim()
    ? process.env.REVENUE_DB_PATH.trim()
    : path.join(REPO_ROOT, 'data', 'licenses.db'),
);

/** Canonical licence status vocabulary. */
export const LICENSE_STATUSES = Object.freeze(['issued', 'active', 'suspended', 'expired', 'revoked']);

const LEGACY_STATUS_MAP = Object.freeze({
  issued: 'issued',
  active: 'active',
  suspended: 'suspended',
  expired: 'expired',
  revoked: 'revoked',
  // known legacy aliases used by earlier versions of the engine
  pending: 'issued',
  valid: 'active',
  ok: 'active',
  cancelled: 'revoked',
  canceled: 'revoked',
  refunded: 'revoked',
  deleted: 'revoked',
});

// â”€â”€ small utilities â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** ISO-8601 UTC timestamp. */
export function nowIso() {
  return new Date().toISOString();
}

/** `<prefix>_<uuid>` identifier. */
export function newId(prefix) {
  const p = prefix === undefined || prefix === null ? '' : String(prefix);
  const id = crypto.randomUUID();
  return p ? `${p}_${id}` : id;
}

/** Hex SHA-256 digest of a string. */
export function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

/**
 * Run `fn` inside a SQLite transaction. Rolls back on throw.
 *
 * Accepts either call shape so parallel lanes cannot mis-call it:
 *   withTransaction(fn)          -> uses the lazily opened default database
 *   withTransaction(fn, db)      -> uses the given database
 *   withTransaction(db, fn)      -> same thing, arguments in either order
 *
 * @param {Function|import('better-sqlite3').Database} fn  the work, or the db
 * @param {import('better-sqlite3').Database|Function} [db] the db, or the work
 */
export function withTransaction(fn, db) {
  let work = fn;
  let handle = db;
  if (typeof work !== 'function' && work && typeof work.prepare === 'function') {
    // called as withTransaction(db, fn)
    work = db;
    handle = fn;
  }
  if (typeof work !== 'function') throw new TypeError('withTransaction(fn) requires a function');
  const target = handle || getDefaultDb();
  return target.transaction(work)(target);
}

let defaultDb = null;
function getDefaultDb() {
  if (!defaultDb) defaultDb = openDb();
  return defaultDb;
}

/** Close (and forget) the lazily opened default database. */
export function closeDefaultDb() {
  if (defaultDb) {
    try { defaultDb.close(); } catch { /* already closed */ }
    defaultDb = null;
  }
}

// â”€â”€ schema â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const NEW_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    email_normalized TEXT NOT NULL,
    display_name TEXT,
    provider TEXT,
    provider_customer_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email_normalized ON customers(email_normalized)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_provider_customer ON customers(provider, provider_customer_id)`,
  `CREATE TABLE IF NOT EXISTS revenue_events (
    event_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    customer_id TEXT,
    customer_email TEXT,
    provider_customer_id TEXT,
    product_id TEXT,
    price_reference TEXT,
    payment_reference TEXT,
    subscription_reference TEXT,
    amount INTEGER,
    currency TEXT,
    occurred_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    verification_status TEXT NOT NULL,
    processing_status TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    source_mode TEXT NOT NULL,
    raw_payload_hash TEXT NOT NULL,
    payload_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_revenue_events_provider_event ON revenue_events(provider, provider_event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_revenue_events_customer ON revenue_events(customer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_revenue_events_product ON revenue_events(product_id)`,
  `CREATE TABLE IF NOT EXISTS entitlements (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    status TEXT NOT NULL,
    source_event_id TEXT,
    provider_subscription_id TEXT,
    starts_at TEXT,
    expires_at TEXT,
    revoked_reason TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlements_customer_product ON entitlements(customer_id, product_id)`,
  `CREATE TABLE IF NOT EXISTS fulfillment_runs (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    event_id TEXT,
    customer_id TEXT,
    entitlement_id TEXT,
    license_id TEXT,
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER DEFAULT 0,
    last_error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fulfillment_runs_event ON fulfillment_runs(event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_fulfillment_runs_customer ON fulfillment_runs(customer_id)`,
  `CREATE TABLE IF NOT EXISTS deliveries (
    id TEXT PRIMARY KEY,
    fulfillment_run_id TEXT,
    entitlement_id TEXT,
    license_id TEXT,
    customer_id TEXT,
    channel TEXT NOT NULL,
    recipient_ref TEXT NOT NULL,
    artifact_ref TEXT,
    status TEXT NOT NULL,
    provider_message_id TEXT,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    sent_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_deliveries_run ON deliveries(fulfillment_run_id)`,
  `CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    subject_id TEXT,
    payload_json TEXT NOT NULL,
    source_fingerprint TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_subject ON evidence(subject_id)`,
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    result_ref TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
];

/** Columns added to the pre-existing `licenses` table (additive, guarded). */
export const LICENSE_ADDED_COLUMNS = Object.freeze([
  'entitlement_id',
  'issued_at',
  'expires_at',
  'revoked_reason',
  'subscription_id',
  'event_id',
]);

/** Legacy tables that must never be dropped or recreated. */
export const LEGACY_TABLES = Object.freeze([
  'licenses',
  'subscribers',
  'invoices',
  'leads',
  'campaigns',
  'campaign_runs',
  'campaign_sent',
  'channel_metrics',
  'analytics_snapshots',
]);

export const NEW_TABLES = Object.freeze([
  'customers',
  'revenue_events',
  'entitlements',
  'fulfillment_runs',
  'deliveries',
  'evidence',
  'idempotency_keys',
]);

function tableExists(db, name) {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(name);
  return !!row;
}

function columnNames(db, table) {
  if (!tableExists(db, table)) return [];
  return db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
}

/** Add a column only when it is missing. Safe to run repeatedly. */
function addColumnIfMissing(db, table, column, decl) {
  if (!tableExists(db, table)) return false;
  const cols = columnNames(db, table);
  if (cols.includes(column)) return false;
  try {
    db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${decl}`);
    return true;
  } catch (err) {
    // A concurrent writer may have added it between the check and the ALTER.
    if (/duplicate column name/i.test(err.message)) return false;
    throw err;
  }
}

/**
 * Normalise legacy `licenses.status` values into the canonical vocabulary.
 * Unknown values fail closed to 'suspended'. Never deletes or reorders rows.
 */
export function normalizeLicenseStatuses(db) {
  if (!tableExists(db, 'licenses')) return { updated: 0 };
  const updated = db.transaction(() => {
    let n = 0;
    const rows = db.prepare(`SELECT id, status FROM licenses`).all();
    const upd = db.prepare(`UPDATE licenses SET status = ? WHERE id = ?`);
    for (const row of rows) {
      const current = row.status ?? null;
      let next;
      if (current === null || current === undefined || current === '') next = 'issued';
      else if (LEGACY_STATUS_MAP[current]) next = LEGACY_STATUS_MAP[current];
      else if (LICENSE_STATUSES.includes(current)) next = current;
      else next = 'suspended'; // unknown -> fail closed
      if (next !== current) {
        upd.run(next, row.id);
        n += 1;
      }
    }
    return n;
  })();
  return { updated };
}

/**
 * Apply every migration. Idempotent: running it twice changes nothing.
 */
export function migrate(db) {
  // 1. New tables (never touches legacy tables).
  for (const sql of NEW_TABLES_SQL) db.exec(sql);

  // 2. Additive columns on the pre-existing `licenses` table.
  // 2a. On a brand-new database the legacy `licenses` table may not exist yet.
  //     The shape matches the historical server-side definition exactly, so an
  //     existing database is never touched (IF NOT EXISTS).
  if (!tableExists(db, 'licenses')) {
    db.exec(`CREATE TABLE IF NOT EXISTS licenses (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, license_key TEXT UNIQUE NOT NULL,
      price_id TEXT, tier TEXT, status TEXT DEFAULT 'active',
      stripe_customer_id TEXT, created_at TEXT DEFAULT (datetime('now'))
    )`);
  }

  // 2b. Add the new columns (idempotent, additive).
  addColumnIfMissing(db, 'licenses', 'entitlement_id', 'TEXT');
  addColumnIfMissing(db, 'licenses', 'issued_at', 'TEXT');
  addColumnIfMissing(db, 'licenses', 'expires_at', 'TEXT');
  addColumnIfMissing(db, 'licenses', 'revoked_reason', 'TEXT');
  addColumnIfMissing(db, 'licenses', 'subscription_id', 'TEXT');
  addColumnIfMissing(db, 'licenses', 'event_id', 'TEXT');

  // 3. Indexes on the legacy table (additive only). The `licenses` table may not
  //    exist yet in a brand-new database, so guard on its presence.
  if (tableExists(db, 'licenses')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_licenses_entitlement ON licenses(entitlement_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_licenses_event ON licenses(event_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_licenses_email ON licenses(email)`);
  }

  // 4. Normalise legacy status vocabulary.
  const statusResult = normalizeLicenseStatuses(db);

  return { ok: true, statusUpdated: statusResult.updated };
}

/**
 * Open the database at `dbPath` (or REVENUE_DB_PATH, or the default path),
 * apply all migrations, and return the better-sqlite3 handle.
 */
export function openDb(dbPath) {
  const target = path.resolve(
    dbPath || process.env.REVENUE_DB_PATH || path.join(REPO_ROOT, 'data', 'licenses.db'),
  );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export default { openDb, migrate, withTransaction, nowIso, newId, sha256, DB_PATH };
