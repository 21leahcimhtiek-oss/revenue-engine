// ─────────────────────────────────────────────────────────────────────────────
// Standalone migration verification.
//
//   node src/seed/verify-migrations.mjs
//
// Copies data/licenses.db to a temp path, opens it with openDb, asserts every
// legacy table survives with its original row count, asserts the new tables and
// the new `licenses` columns exist, then opens the SAME file a SECOND time and
// asserts no error and no data loss.
//
// The real data/licenses.db is NEVER opened for writing.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { openDb, LEGACY_TABLES, NEW_TABLES, LICENSE_ADDED_COLUMNS } from '../db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SOURCE_DB = path.join(REPO_ROOT, 'data', 'licenses.db');

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

function tableNames(db) {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
}

function counts(db, names) {
  const out = {};
  for (const t of names) out[t] = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c;
  return out;
}

console.log('=== MIGRATION VERIFICATION ===');
console.log(`source db : ${SOURCE_DB}`);

if (!fs.existsSync(SOURCE_DB)) {
  console.error('FATAL: source database not found.');
  process.exit(1);
}

// 1. Copy to a temp path (the source is only ever read).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-verify-'));
const copy = path.join(tmpDir, 'licenses.db');
fs.copyFileSync(SOURCE_DB, copy);
console.log(`temp copy : ${copy}\n`);

// 2. Baseline counts from the untouched copy (read-only).
const src = new Database(copy, { readonly: true });
const before = counts(src, LEGACY_TABLES);
const beforeTables = tableNames(src);
src.close();
console.log('baseline row counts:', JSON.stringify(before), '\n');

// 3. First migration pass.
const db = openDb(copy);
check('openDb #1 succeeded', true, copy);

for (const t of LEGACY_TABLES) {
  check(`legacy table present: ${t}`, beforeTables.includes(t) || tableNames(db).includes(t));
}

const after = counts(db, LEGACY_TABLES);
for (const t of LEGACY_TABLES) {
  check(`legacy row count preserved: ${t}`, after[t] === before[t], `${before[t]} -> ${after[t]}`);
}

const now = tableNames(db);
for (const t of NEW_TABLES) check(`new table present: ${t}`, now.includes(t));

const cols = db.prepare(`PRAGMA table_info(licenses)`).all().map((c) => c.name);
for (const c of LICENSE_ADDED_COLUMNS) check(`new licenses column: ${c}`, cols.includes(c));

const legacyCols = ['id', 'email', 'license_key', 'price_id', 'tier', 'status', 'stripe_customer_id', 'created_at'];
for (const c of legacyCols) check(`legacy licenses column intact: ${c}`, cols.includes(c));

const statuses = db.prepare(`SELECT DISTINCT status FROM licenses`).all().map((r) => r.status);
const VALID = ['issued', 'active', 'suspended', 'expired', 'revoked'];
check(
  'licenses.status vocabulary normalised',
  statuses.every((s) => VALID.includes(s)),
  `distinct statuses: ${JSON.stringify(statuses)}`,
);

const afterTables = tableNames(db);
db.close();

// 4. SECOND openDb on the SAME file — idempotency proof.
let secondOk = true;
let secondErr = '';
let db2 = null;
try {
  db2 = openDb(copy);
} catch (err) {
  secondOk = false;
  secondErr = err.message;
}
check('openDb #2 on the same file succeeded (no error)', secondOk, secondErr);

if (db2) {
  const after2 = counts(db2, LEGACY_TABLES);
  for (const t of LEGACY_TABLES) {
    check(`row count unchanged after 2nd migration: ${t}`, after2[t] === before[t], `${before[t]} -> ${after2[t]}`);
  }
  const t2 = tableNames(db2);
  for (const t of NEW_TABLES) check(`new table still present after 2nd migration: ${t}`, t2.includes(t));
  const cols2 = db2.prepare(`PRAGMA table_info(licenses)`).all().map((c) => c.name);
  for (const c of LICENSE_ADDED_COLUMNS) check(`new licenses column still present after 2nd migration: ${c}`, cols2.includes(c));
  db2.close();
}

// 5. The real database must be untouched.
const realSrc = new Database(SOURCE_DB, { readonly: true });
const realCounts = counts(realSrc, LEGACY_TABLES);
realSrc.close();
let realIntact = true;
for (const t of LEGACY_TABLES) if (realCounts[t] !== before[t]) realIntact = false;
check('source data/licenses.db row counts untouched', realIntact, JSON.stringify(realCounts));

// cleanup temp copy
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
if (failed.length) {
  console.log('FAILURES:');
  for (const f of failed) console.log(` - ${f.label} ${f.detail}`);
  process.exit(1);
}
console.log('MIGRATION VERIFICATION: OK');
