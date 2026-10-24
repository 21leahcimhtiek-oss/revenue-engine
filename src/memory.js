// ─── MEMORY VAULT (long-term brain) ───
// SQLite-backed persistent store for all subsystems: campaigns, runs, metrics, analytics.
import Database from "better-sqlite3";

const db = new Database("data/licenses.db");

// ─── TABLE DEFINITIONS ───

// Campaign templates (the "what to post" blueprints)
db.exec(`CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  channels TEXT NOT NULL,        -- JSON array of target channels
  content_template TEXT NOT NULL,  -- JSON template with placeholders
  service_type TEXT,             -- automation_audit | done_for_you_workflow | custom
  price_type TEXT,               -- SERVICE_PRICES key for auto-invoicing
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
)`);

// Individual campaign run instances (each time a campaign fires)
db.exec(`CREATE TABLE IF NOT EXISTS campaign_runs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  channels TEXT NOT NULL,         -- JSON array of channels attempted
  results TEXT NOT NULL,          -- JSON { channel: { ok: bool, error?: str, postId?: str } }
  status TEXT DEFAULT 'running',   -- running | completed | failed
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)`);

// Per-channel engagement metrics (for analytics)
db.exec(`CREATE TABLE IF NOT EXISTS channel_metrics (
  id TEXT PRIMARY KEY,
  campaign_run_id TEXT,
  channel TEXT NOT NULL,          -- email | sms | blog | reddit | twitter | linkedin | discord | slack | web_banner
  metric_type TEXT NOT NULL,      -- sent | delivered | opened | clicked | failed | posted
  value INTEGER DEFAULT 0,
  metadata TEXT,                  -- JSON with extra context (post_id, error, etc.)
  recorded_at TEXT DEFAULT (datetime('now'))
)`);

// Analytics snapshots (weekly runs)
db.exec(`CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id TEXT PRIMARY KEY,
  period TEXT NOT NULL,           -- week | month
  engagement TEXT NOT NULL,         -- JSON { openRate, clickRate, ctr }
  revenue TEXT NOT NULL,            -- JSON { mrr, churn, orders, arpu, byTier }
  leads TEXT NOT NULL,              -- JSON { bySource, winRate, scored }
  recommendations TEXT NOT NULL,    -- JSON array of recommendation strings
  created_at TEXT DEFAULT (datetime('now'))
)`);

// ─── MIGRATIONS for existing tables (idempotent — ALTER ignores if column exists)
try { db.exec(`ALTER TABLE leads ADD COLUMN email TEXT`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN stripe_customer_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN converted_at TEXT`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN revenue_amount INTEGER`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN campaign_source TEXT`); } catch {}
try { db.exec(`ALTER TABLE channel_metrics ADD COLUMN created_at TEXT`); } catch {}

// ─── TABLE WHITELIST ───
const TABLE_WHITELIST = new Set([
  "campaigns", "campaign_runs", "channel_metrics", "analytics_snapshots",
  "invoices", "leads", "licenses", "subscribers",
]);

// ─── CORE FUNCTIONS ───

// Log a record to any whitelisted table. Auto-generates id + created_at.
export function logMemory(table, data) {
  if (!TABLE_WHITELIST.has(table)) {
    throw new Error(`table "${table}" not in whitelist`);
  }
  const id = data.id || `${table}-${crypto.randomUUID()}`;
  const filtered = { ...data };
  delete filtered.id;
  const cols = Object.keys(filtered);
  const vals = Object.values(filtered);
  const colList = cols.map(c => `"${c}"`).join(", ");
  const placeholders = cols.map(() => "?").join(", ");
  db.prepare(
    `INSERT INTO ${table} (${colList}, "id", "created_at") VALUES (${placeholders}, ?, datetime('now'))`
  ).run(...vals, id);
  return { id, inserted: true };
}

// Query records from a table (optionally filtered)
export function queryMemory(table, where = {}, orderBy = "created_at DESC", limit = 100) {
  if (!TABLE_WHITELIST.has(table)) {
    throw new Error(`table "${table}" not in whitelist`);
  }
  const conditions = Object.entries(where);
  const params = conditions.map(([, v]) => v);
  const whereClause = conditions.length
    ? "WHERE " + conditions.map(([k]) => `"${k}" = ?`).join(" AND ")
    : "";
  return db.prepare(
    `SELECT * FROM ${table} ${whereClause} ORDER BY ${orderBy} LIMIT ?`
  ).all(...params, limit);
}

// Get a single record by id
export function getMemory(table, id) {
  if (!TABLE_WHITELIST.has(table)) {
    throw new Error(`table "${table}" not in whitelist`);
  }
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
}

// Update a record by id
export function updateMemory(table, id, data) {
  if (!TABLE_WHITELIST.has(table)) {
    throw new Error(`table "${table}" not in whitelist`);
  }
  const cols = Object.keys(data);
  const vals = Object.values(data);
  if (!cols.length) return { changed: 0 };
  const setClause = cols.map(c => `"${c}" = ?`).join(", ");
  return db.prepare(
    `UPDATE ${table} SET ${setClause} WHERE id = ?`
  ).run(...vals, id);
}

// Get last N rows from a table
export function getLast(table, n = 10, where = {}) {
  if (!TABLE_WHITELIST.has(table)) {
    throw new Error(`table "${table}" not in whitelist`);
  }
  const conditions = Object.entries(where);
  const params = conditions.map(([, v]) => v);
  const whereClause = conditions.length
    ? "WHERE " + conditions.map(([k]) => `"${k}" = ?`).join(" AND ")
    : "";
  return db.prepare(
    `SELECT * FROM ${table} ${whereClause} ORDER BY created_at DESC LIMIT ?`
  ).all(...params, n);
}

// Convenience alias
export const log = logMemory;
export const query = queryMemory;
export const get = getMemory;
export const update = updateMemory;
export const getLastRows = getLast;

// Export db for other modules that need direct access
export { db };