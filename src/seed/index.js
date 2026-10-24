// ─────────────────────────────────────────────────────────────────────────────
// Aurora Revenue Engine — DISPOSABLE SEED / FIXTURE HELPERS
//
// Everything here is for TESTS and local experiments only.
// It NEVER touches data/licenses.db unless explicitly pointed at a copy.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, newId, nowIso, sha256 } from '../db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');

/** A unique disposable directory under the OS temp dir. */
export function makeTempDir(prefix = 'aurora-rev-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A path inside a fresh disposable directory (the file is NOT created). */
export function makeTempDbPath(name = 'test.db') {
  return path.join(makeTempDir(), name);
}

/**
 * Copy a database file (plus any WAL sidecars) to a temp path.
 * The SOURCE is opened read-only; the copy is what gets mutated.
 */
export function copyDatabaseToTemp(sourcePath, name = 'copy.db') {
  const dest = path.join(makeTempDir(), name);
  fs.copyFileSync(sourcePath, dest);
  for (const suffix of ['-wal', '-shm']) {
    const side = `${sourcePath}${suffix}`;
    if (fs.existsSync(side)) fs.copyFileSync(side, `${dest}${suffix}`);
  }
  return dest;
}

/** Open a disposable, fully migrated database. */
export function openTempDb(dbPath = makeTempDbPath()) {
  return openDb(dbPath);
}

// ── row fixtures ────────────────────────────────────────────────────────────

export function seedCustomer(db, overrides = {}) {
  const email = overrides.email || `customer+${newId('t').slice(-8)}@example.test`;
  const row = {
    id: overrides.id || newId('cus'),
    email,
    email_normalized: (overrides.email_normalized || email).trim().toLowerCase(),
    display_name: overrides.display_name ?? null,
    provider: overrides.provider ?? 'stripe',
    provider_customer_id: overrides.provider_customer_id ?? newId('pcus'),
    created_at: overrides.created_at || nowIso(),
    updated_at: overrides.updated_at || nowIso(),
  };
  db.prepare(
    `INSERT INTO customers (id, email, email_normalized, display_name, provider,
      provider_customer_id, created_at, updated_at)
     VALUES (@id, @email, @email_normalized, @display_name, @provider,
      @provider_customer_id, @created_at, @updated_at)`,
  ).run(row);
  return row;
}

export function seedRevenueEvent(db, overrides = {}) {
  const payload = overrides.payload_json || '{}';
  const row = {
    event_id: overrides.event_id || newId('evt'),
    provider: overrides.provider || 'stripe',
    provider_event_id: overrides.provider_event_id || newId('pevt'),
    event_type: overrides.event_type || 'checkout.session.completed',
    customer_id: overrides.customer_id ?? null,
    customer_email: overrides.customer_email ?? null,
    provider_customer_id: overrides.provider_customer_id ?? null,
    product_id: overrides.product_id ?? 'skill_pack_lite',
    price_reference: overrides.price_reference ?? 'PRICE_SKILL_PACK_LITE',
    payment_reference: overrides.payment_reference ?? null,
    subscription_reference: overrides.subscription_reference ?? null,
    amount: overrides.amount ?? 1900,
    currency: overrides.currency ?? 'usd',
    occurred_at: overrides.occurred_at || nowIso(),
    received_at: overrides.received_at || nowIso(),
    verification_status: overrides.verification_status || 'verified',
    processing_status: overrides.processing_status || 'pending',
    idempotency_key: overrides.idempotency_key || newId('idem'),
    source_mode: overrides.source_mode || 'webhook',
    raw_payload_hash: overrides.raw_payload_hash || sha256(payload),
    payload_json: payload,
    created_at: overrides.created_at || nowIso(),
  };
  db.prepare(
    `INSERT INTO revenue_events (
      event_id, provider, provider_event_id, event_type, customer_id, customer_email,
      provider_customer_id, product_id, price_reference, payment_reference,
      subscription_reference, amount, currency, occurred_at, received_at,
      verification_status, processing_status, idempotency_key, source_mode,
      raw_payload_hash, payload_json, created_at)
     VALUES (
      @event_id, @provider, @provider_event_id, @event_type, @customer_id, @customer_email,
      @provider_customer_id, @product_id, @price_reference, @payment_reference,
      @subscription_reference, @amount, @currency, @occurred_at, @received_at,
      @verification_status, @processing_status, @idempotency_key, @source_mode,
      @raw_payload_hash, @payload_json, @created_at)`,
  ).run(row);
  return row;
}

export function seedEntitlement(db, overrides = {}) {
  const row = {
    id: overrides.id || newId('ent'),
    customer_id: overrides.customer_id || newId('cus'),
    product_id: overrides.product_id || 'skill_pack_lite',
    status: overrides.status || 'active',
    source_event_id: overrides.source_event_id ?? null,
    provider_subscription_id: overrides.provider_subscription_id ?? null,
    starts_at: overrides.starts_at || nowIso(),
    expires_at: overrides.expires_at ?? null,
    revoked_reason: overrides.revoked_reason ?? null,
    created_at: overrides.created_at || nowIso(),
    updated_at: overrides.updated_at || nowIso(),
  };
  db.prepare(
    `INSERT INTO entitlements (
      id, customer_id, product_id, status, source_event_id, provider_subscription_id,
      starts_at, expires_at, revoked_reason, created_at, updated_at)
     VALUES (
      @id, @customer_id, @product_id, @status, @source_event_id, @provider_subscription_id,
      @starts_at, @expires_at, @revoked_reason, @created_at, @updated_at)`,
  ).run(row);
  return row;
}

/**
 * Insert a legacy-style licence row (the pre-migration `licenses` shape).
 * Used to prove migrations preserve pre-existing rows.
 */
export function seedLegacyLicense(db, overrides = {}) {
  const row = {
    id: overrides.id || newId('lic'),
    email: overrides.email || 'legacy@example.test',
    license_key: overrides.license_key || `KEY-${newId('k')}`,
    price_id: overrides.price_id ?? null,
    tier: overrides.tier || 'lite',
    status: overrides.status || 'active',
    stripe_customer_id: overrides.stripe_customer_id ?? null,
    created_at: overrides.created_at || nowIso(),
  };
  db.prepare(
    `INSERT INTO licenses (id, email, license_key, price_id, tier, status, stripe_customer_id, created_at)
     VALUES (@id, @email, @license_key, @price_id, @tier, @status, @stripe_customer_id, @created_at)`,
  ).run(row);
  return row;
}

/** Snapshot every table's row count. */
export function tableCounts(db) {
  const names = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all()
    .map((r) => r.name);
  const out = {};
  for (const n of names) out[n] = db.prepare(`SELECT COUNT(*) AS c FROM "${n}"`).get().c;
  return out;
}

export default {
  makeTempDir,
  makeTempDbPath,
  copyDatabaseToTemp,
  openTempDb,
  seedCustomer,
  seedRevenueEvent,
  seedEntitlement,
  seedLegacyLicense,
  tableCounts,
};
