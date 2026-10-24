// ─────────────────────────────────────────────────────────────────────────────
// Aurora Revenue Engine — LICENCES
//
// A licence is the ARTEFACT that proves a right to use a product. It is NOT
// the payment, and it is NOT the entitlement.
//
// A licence MUST map to:
//   * a customer   (via licenses.entitlement_id -> entitlements.customer_id)
//   * a product    (via licenses.entitlement_id -> entitlements.product_id)
//   * an entitlement (licenses.entitlement_id)
//   * the source payment evidence (licenses.event_id)
//   * a creation time (licenses.issued_at) and a term (licenses.expires_at)
//   * a status (issued | active | suspended | expired | revoked)
//
// IDEMPOTENCY
//   Issuing a licence for the same entitlement twice MUST NOT create two
//   licences. The durable guard is the idempotency_keys ledger
//   (scope 'license.issue', key = entitlement id) plus a lookup of the
//   existing licence for that entitlement.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { nowIso, newId, sha256 } from './db.js';
import { isEntitlementActive } from './entitlements.js';

/** Canonical licence status vocabulary. */
export const LICENSE_STATUSES = Object.freeze(['issued', 'active', 'suspended', 'expired', 'revoked']);

/** Idempotency scope used for licence issuance. */
export const LICENSE_ISSUE_SCOPE = 'license.issue';

/** Typed error for licence refusals. */
export class LicenseError extends Error {
  constructor(code, message, details = {}) {
    super(message || code);
    this.name = 'LicenseError';
    this.code = code;
    this.details = details;
  }
}

function rowToLicense(row) {
  return row ? { ...row } : null;
}

/**
 * Build a licence key of the historical shape:
 *   CCPI-<TIER>-<UUID>-<CHECKSUM>
 * The checksum binds the key to its entitlement and customer, so a key
 * cannot be silently moved between customers or entitlements.
 */
export function generateLicenseKey({ tier, entitlementId, customerId }) {
  const safeTier = String(tier ?? 'GENERAL')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8) || 'GENERAL';
  const uuid = crypto.randomUUID().toUpperCase();
  const checksum = sha256(`${uuid}|${entitlementId ?? ''}|${customerId ?? ''}`).slice(0, 8).toUpperCase();
  return `CCPI-${safeTier}-${uuid}-${checksum}`;
}

function tierForProduct(product) {
  return product?.entitlement_type ?? product?.product_id ?? 'GENERAL';
}

/**
 * Ensure the one-licence-per-entitlement invariant at the database level.
 * Guarded: a legacy database may already contain rows that violate it, in
 * which case the index is simply not created and the application-level
 * guards still hold.
 */
function ensureEntitlementUniqueIndex(db) {
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_entitlement_unique ON licenses(entitlement_id)`);
  } catch {
    /* legacy duplicates — the application-level guards still prevent doubles */
  }
}

/** Find an existing licence for an entitlement (the idempotency read). */
export function findLicenseByEntitlement(db, entitlementId) {
  if (!entitlementId) return null;
  const row = db.prepare(`SELECT * FROM licenses WHERE entitlement_id = ? LIMIT 1`).get(entitlementId);
  return rowToLicense(row);
}

/**
 * Issue a licence for an entitlement.
 *
 * Idempotent: a second call for the same entitlement returns the EXISTING
 * licence row (same licence id, same licence key) and creates nothing new.
 */
export function issueLicense(db, { entitlement, customer, product, event } = {}) {
  if (!db) throw new TypeError('issueLicense(db, ...) requires a db handle');
  if (!entitlement || !entitlement.id) {
    throw new LicenseError('license.entitlement_missing', 'an entitlement is required to issue a licence');
  }

  ensureEntitlementUniqueIndex(db);

  const existing = findLicenseByEntitlement(db, entitlement.id);
  if (existing) return existing;

  const entitlementId = entitlement.id;
  const customerId = customer?.id ?? customer?.customer_id ?? entitlement.customer_id ?? null;
  const email = String(customer?.email ?? entitlement.customer_email ?? '').trim().toLowerCase();
  if (!email) {
    throw new LicenseError('license.customer_email_missing', 'a licence needs a customer email');
  }

  // Durable idempotency ledger: the entitlement id is the stable key.
  const keyRow = db
    .prepare(`SELECT result_ref FROM idempotency_keys WHERE key = ? AND scope = ?`)
    .get(entitlementId, LICENSE_ISSUE_SCOPE);
  if (keyRow?.result_ref) {
    const prior = db.prepare(`SELECT * FROM licenses WHERE id = ?`).get(keyRow.result_ref);
    if (prior) return rowToLicense(prior);
  }

  const issuedAt = nowIso();
  const expiresAt = entitlement.expires_at ?? null;
  const id = newId('lic');
  const licenseKey = generateLicenseKey({
    tier: tierForProduct(product),
    entitlementId,
    customerId,
  });

  const priceId = product?.price_reference && process.env[product.price_reference]
    ? process.env[product.price_reference]
    : null;

  db.prepare(
    `INSERT INTO licenses (
       id, email, license_key, price_id, tier, status, stripe_customer_id, created_at,
       entitlement_id, issued_at, expires_at, revoked_reason, subscription_id, event_id
     ) VALUES (?, ?, ?, ?, ?, 'issued', ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    id,
    email,
    licenseKey,
    priceId,
    tierForProduct(product),
    customer?.provider_customer_id ?? customer?.stripe_customer_id ?? null,
    issuedAt,
    entitlementId,
    issuedAt,
    expiresAt,
    event?.subscription_reference ?? entitlement.provider_subscription_id ?? null,
    event?.event_id ?? entitlement.source_event_id ?? null,
  );

  db.prepare(
    `INSERT OR IGNORE INTO idempotency_keys (key, scope, result_ref) VALUES (?, ?, ?)`,
  ).run(entitlementId, LICENSE_ISSUE_SCOPE, id);

  return rowToLicense(db.prepare(`SELECT * FROM licenses WHERE id = ?`).get(id));
}

/** Fetch a licence row by id. */
export function getLicense(db, licenseId) {
  if (!licenseId) return null;
  return rowToLicense(db.prepare(`SELECT * FROM licenses WHERE id = ?`).get(licenseId));
}

/** Fetch a licence row by key. */
export function getLicenseByKey(db, licenseKey) {
  if (!licenseKey) return null;
  return rowToLicense(db.prepare(`SELECT * FROM licenses WHERE license_key = ?`).get(licenseKey));
}

/**
 * The entitlement that backs a licence. A licence without a live entitlement
 * is not usable — the entitlement is the proof of the right.
 */
export function getLicenseEntitlement(db, license) {
  if (!license?.entitlement_id) return null;
  const row = db.prepare(`SELECT * FROM entitlements WHERE id = ?`).get(license.entitlement_id);
  return row ? { ...row } : null;
}

/** The customer that owns a licence (via its entitlement). */
export function getLicenseCustomer(db, license) {
  const entitlement = getLicenseEntitlement(db, license);
  if (!entitlement?.customer_id) return null;
  const row = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(entitlement.customer_id);
  return row ? { ...row } : null;
}

/** The product a licence grants (via its entitlement). */
export function getLicenseProductId(db, license) {
  const entitlement = getLicenseEntitlement(db, license);
  return entitlement?.product_id ?? null;
}

/**
 * Is this licence usable RIGHT NOW?
 *
 * Usable means: status is 'issued' or 'active', the term has not elapsed,
 * and the backing entitlement is still active. A licence whose entitlement
 * was suspended, expired or revoked is NOT usable, even if the licence row
 * itself still says 'active'.
 */
export function isLicenseUsable(db, license, at = nowIso()) {
  if (!license) return false;
  if (!LICENSE_STATUSES.includes(license.status)) return false;
  if (license.status !== 'issued' && license.status !== 'active') return false;
  if (license.expires_at) {
    const exp = Date.parse(license.expires_at);
    const now = Date.parse(at);
    if (Number.isNaN(exp)) return false;
    if (!Number.isNaN(now) && exp <= now) return false;
  }
  const entitlement = getLicenseEntitlement(db, license);
  if (!entitlement) return false;
  return isEntitlementActive(entitlement, at);
}

/**
 * Verify a licence key.
 *
 * @param {string} licenseKey
 * @param {{customerId?:string, productId?:string}} [context]
 *   When supplied, the licence must ALSO belong to that customer and grant
 *   that product. A cross-customer or cross-product check returns null.
 * @returns {object|null} the licence row when usable, otherwise null
 */
export function verifyLicense(db, licenseKey, context = {}) {
  const license = getLicenseByKey(db, licenseKey);
  if (!license) return null;
  if (!isLicenseUsable(db, license)) return null;
  if (context.customerId) {
    const entitlement = getLicenseEntitlement(db, license);
    if (!entitlement || entitlement.customer_id !== context.customerId) return null;
  }
  if (context.productId) {
    const entitlement = getLicenseEntitlement(db, license);
    if (!entitlement || entitlement.product_id !== context.productId) return null;
  }
  return license;
}

function setLicenseStatus(db, licenseId, status, reason) {
  if (!LICENSE_STATUSES.includes(status)) {
    throw new LicenseError('license.invalid_status', `invalid licence status "${status}"`);
  }
  const existing = getLicense(db, licenseId);
  if (!existing) {
    throw new LicenseError('license.not_found', `no licence "${licenseId}"`, { id: licenseId });
  }
  db.prepare(`UPDATE licenses SET status = ?, revoked_reason = ? WHERE id = ?`).run(
    status,
    status === 'revoked' || status === 'suspended' ? (reason ?? null) : null,
    licenseId,
  );
  return getLicense(db, licenseId);
}

/** Revoke a licence permanently. */
export function revokeLicense(db, licenseId, reason) {
  return setLicenseStatus(db, licenseId, 'revoked', reason ?? 'revoked');
}

/** Suspend a licence (temporarily unusable). */
export function suspendLicense(db, licenseId, reason) {
  return setLicenseStatus(db, licenseId, 'suspended', reason ?? 'suspended');
}

/** Mark a licence as expired. */
export function expireLicense(db, licenseId, reason) {
  return setLicenseStatus(db, licenseId, 'expired', reason ?? 'expired');
}

/**
 * Reactivate a licence.
 *
 * Refuses when the backing entitlement is not active — a licence must never
 * be more permissive than the entitlement it carries.
 */
export function reactivateLicense(db, licenseId) {
  const license = getLicense(db, licenseId);
  if (!license) throw new LicenseError('license.not_found', `no licence "${licenseId}"`, { id: licenseId });
  const entitlement = getLicenseEntitlement(db, license);
  if (!entitlement || !isEntitlementActive(entitlement)) {
    throw new LicenseError(
      'license.entitlement_not_active',
      'cannot reactivate a licence whose entitlement is not active',
      { id: licenseId },
    );
  }
  return setLicenseStatus(db, licenseId, 'active', null);
}

/** All licences belonging to a customer (resolved through entitlements). */
export function listLicenses(db, customerId) {
  if (!customerId) return [];
  return db
    .prepare(
      `SELECT l.* FROM licenses l
         JOIN entitlements e ON e.id = l.entitlement_id
        WHERE e.customer_id = ?
        ORDER BY l.created_at DESC`,
    )
    .all(customerId)
    .map(rowToLicense);
}

export default {
  LICENSE_STATUSES,
  LICENSE_ISSUE_SCOPE,
  LicenseError,
  generateLicenseKey,
  issueLicense,
  getLicense,
  getLicenseByKey,
  getLicenseEntitlement,
  getLicenseCustomer,
  getLicenseProductId,
  findLicenseByEntitlement,
  isLicenseUsable,
  verifyLicense,
  revokeLicense,
  suspendLicense,
  expireLicense,
  reactivateLicense,
  listLicenses,
};
