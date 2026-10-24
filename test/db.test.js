import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, migrate, withTransaction, nowIso, newId, sha256, DB_PATH, LEGACY_TABLES, NEW_TABLES, LICENSE_ADDED_COLUMNS } from '../src/db.js';
import DatabaseCtor from 'better-sqlite3';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY_DB = path.join(REPO_ROOT, 'data', 'licenses.db');

function tempDbPath(name = 't.db') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-dbtest-'));
  return path.join(dir, name);
}

function tables(db) {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
}

test('openDb on a temp path applies migrations and creates all new tables', () => {
  const p = tempDbPath();
  const db = openDb(p);
  const t = tables(db);
  for (const name of NEW_TABLES) assert.ok(t.includes(name), `missing table ${name}`);
  assert.ok(fs.existsSync(p));
  db.close();
});

test('migrations are idempotent when run twice on the same file', () => {
  const p = tempDbPath();
  const db1 = openDb(p);
  const before = tables(db1).sort().join(',');
  db1.close();
  const db2 = openDb(p); // second run
  const after = tables(db2).sort().join(',');
  assert.equal(before, after);
  // explicit third migrate() on an already-migrated handle
  migrate(db2);
  assert.equal(tables(db2).sort().join(','), after);
  db2.close();
});

test('legacy licenses table keeps its rows and gains the new columns', () => {
  const p = tempDbPath();
  let db = openDb(p);
  // build a pre-migration-shaped licenses table
  db.exec(`DROP TABLE licenses`);
  db.exec(`CREATE TABLE licenses (
    id TEXT PRIMARY KEY, email TEXT NOT NULL, license_key TEXT NOT NULL, price_id TEXT,
    tier TEXT, status TEXT DEFAULT 'active', stripe_customer_id TEXT,
    created_at TEXT DEFAULT (datetime('now')))`);
  db.prepare(`INSERT INTO licenses (id,email,license_key,tier,status) VALUES (?,?,?,?,?)`)
    .run('lic_1', 'a@example.test', 'KEY-1', 'lite', 'active');
  db.prepare(`INSERT INTO licenses (id,email,license_key,tier,status) VALUES (?,?,?,?,?)`)
    .run('lic_2', 'b@example.test', 'KEY-2', 'pro', 'weird_legacy');
  db.close();

  db = openDb(p);
  const cols = db.prepare(`PRAGMA table_info(licenses)`).all().map((c) => c.name);
  for (const c of LICENSE_ADDED_COLUMNS) assert.ok(cols.includes(c), `missing column ${c}`);
  const rows = db.prepare(`SELECT id,status FROM licenses ORDER BY id`).all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'active');
  assert.equal(rows[1].status, 'suspended'); // unknown legacy value fails closed
  db.close();
});

test('migrating a copy of the real data/licenses.db preserves every legacy table and row', () => {
  if (!fs.existsSync(LEGACY_DB)) return; // no live db in this environment
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-copy-'));
  const copy = path.join(dir, 'licenses.db');
  fs.copyFileSync(LEGACY_DB, copy);

  const before = (() => {
    const Database = DatabaseCtor;
    const d = new Database(copy, { readonly: true });
    const counts = {};
    for (const t of LEGACY_TABLES) {
      counts[t] = d.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c;
    }
    d.close();
    return counts;
  })();

  const db = openDb(copy);
  const after = {};
  for (const t of LEGACY_TABLES) after[t] = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c;
  assert.deepEqual(after, before);
  const t = tables(db);
  for (const name of NEW_TABLES) assert.ok(t.includes(name));
  const cols = db.prepare(`PRAGMA table_info(licenses)`).all().map((c) => c.name);
  for (const c of LICENSE_ADDED_COLUMNS) assert.ok(cols.includes(c));
  db.close();
});

test('withTransaction rolls back on throw and commits otherwise', () => {
  const p = tempDbPath();
  const db = openDb(p);
  db.exec(`CREATE TABLE t (x INTEGER)`);
  withTransaction(() => { db.prepare(`INSERT INTO t VALUES (1)`).run(); }, db);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM t`).get().c, 1);
  assert.throws(() => withTransaction(() => { db.prepare(`INSERT INTO t VALUES (2)`).run(); throw new Error('boom'); }, db));
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM t`).get().c, 1);
  // the reversed argument order is supported too
  withTransaction(db, () => { db.prepare(`INSERT INTO t VALUES (3)`).run(); });
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM t`).get().c, 2);
  db.close();
});

test('helpers behave', () => {
  assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T/);
  assert.match(newId('evt'), /^evt_[0-9a-f-]{36}$/);
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.ok(path.isAbsolute(DB_PATH));
});
