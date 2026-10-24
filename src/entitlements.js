// ─────────────────────────────────────────────────────────────────────────────
// Aurora Revenue Engine — ENTITLEMENTS + CUSTOMER IDENTITY
//
// PRINCIPLE: a payment is not an entitlement, and an entitlement is not a
// licence and not a delivery. This module owns the middle layer: the right to
// use a product, justified by a VERIFIED payment event.
//
// STATUS IS NOT EVIDENCE.
//   An entitlement may ONLY be created from an event whose
//   verification_status === VERIFICATION.VERIFIED. Anything else is refused
//   with a typed error and NOTHING is written.
//
// CUSTOMER IDENTITY
//   Identity is NOT just an email address. When a provider customer id is
//   present it is authoritative and idempotent. Two different provider
//   customers that happen to share an email are NEVER merged — that is a
//   refusal, not a silent link.
//
//   No secret value is ever used as an identifier, and no secret value is
//   ever written to the database.
// ─────────────────────────────────────────────────────────────────────────────

import { nowIso, newId } from './db.js';
import { VERIFICATION } from './events.js';
import { getProduct, assertProductEnabled, CatalogError } from './catalog.js';

/** Canonical entitlement status vocabulary. */
export const ENTITLEMENT_STATUSES = Object.freeze(['active', 'suspended', 'expired', 'revoked']);

/** Typed error for every refusal in this lane. */
export class EntitlementError extends Error {
  constructor(code, message, details = {}) {
    super(message || code);
    this.name = 'EntitlementError';
    this.code = code;
    this.details = details;
  }
}

/** Typed error for customer identity conflicts. */
export class CustomerError extends Error {
  constructor(code, message, details = {}) {
    super(message || code);
    this.name = 'CustomerError';
    this.code = code;
    this.details = details;
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

function addDays(iso, days) {
  const base = Date.parse(iso);
  if (Number.isNaN(base)) return null;
  return new Date(base + days * 86400000).toISOString();
}

/**
 * Compute the entitlement expiry from the product policy.
 * 'never' and 'provider_managed' are unbounded here — the provider owns the
 * term for managed subscriptions.
 */
export function computeExpiresAt(product, startsAt) {
  const policy = product?.expiration_policy ?? 'never';
  if (policy === 'term_days') {
    const days = Number(product.term_days ?? product.term ?? 30);
    if (!Number.isFinite(days) || days <= 0) return null;
    return addDays(startsAt, days);
  }
  return null;
}

function rowToEntitlement(row) {
  return row ? { ...row } : null;
}

// ── customer identity ───────────────────────────────────────────────────────

/**
 * Resolve (or create) the internal customer for a payment event.
 *
 * Idempotency rules:
 *  * provider + providerCustomerId present -> that pair is the identity.
 *    A second call with the same pair returns the SAME customer id.
 *  * no provider id -> identity falls back to the normalized email.
 *  * a provider id that points at a DIFFERENT email -> REFUSED.
 *  * an email that already belongs to a DIFFERENT provider id -> REFUSED
 *    (two provider customers sharing an email are never merged).
 */
export function ensureCustomer(db, { email, provider, providerCustomerId, displayName } = {}) {
  if (!db) throw new TypeError('ensureCustomer(db, ...) requires a db handle');
  const emailNormalized = normalizeEmail(email);
  const providerId = providerCustomerId ? String(providerCustomerId).trim() : null;
  const providerName = provider ? String(provider).trim() : null;
  if (!emailNormalized && !providerId) {
    throw new CustomerError('customer.identity_missing', 'a customer needs an email or a provider customer id');
  }

  const byProvider = providerId
    ? db
        .prepare(`SELECT * FROM customers WHERE provider = ? AND provider_customer_id = ?`)
        .get(providerName, providerId)
    : null;

  if (byProvider) {
    if (emailNormalized && byProvider.email_normalized !== emailNormalized) {
      throw new CustomerError(
        'customer.email_conflict_for_provider_id',
        `provider customer "${providerId}" is already bound to a different email`,
        { provider: providerName, provider_customer_id: providerId },
      );
    }
    if (displayName && !byProvider.display_name) {
      db.prepare(`UPDATE customers SET display_name = ?, updated_at = ? WHERE id = ?`).run(
        displayName,
        nowIso(),
        byProvider.id,
      );
      return { ...byProvider, display_name: displayName };
    }
    return { ...byProvider };
  }

  const byEmail = emailNormalized
    ? db.prepare(`SELECT * FROM customers WHERE email_normalized = ?`).get(emailNormalized)
    : null;

  if (byEmail) {
    if (providerId) {
      // The email already belongs to another provider customer — refuse rather
      // than silently attaching a second provider identity to one customer.
      throw new CustomerError(
        'customer.provider_id_conflicts_with_email',
        `email "${emailNormalized}" already belongs to a different provider customer`,
        { provider: providerName, provider_customer_id: providerId, customer_id: byEmail.id },
      );
    }
    if (displayName && !byEmail.display_name) {
      db.prepare(`UPDATE customers SET display_name = ?, updated_at = ? WHERE id = ?`).run(
        displayName,
        nowIso(),
        byEmail.id,
      );
    }
    return { ...byEmail };
  }

  const id = newId('cus');
  const ts = nowIso();
  db.prepare(
    `INSERT INTO customers (id, email, email_normalized, display_name, provider, provider_customer_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, emailNormalized, emailNormalized, displayName ?? null, providerName, providerId, ts, ts);
  const created = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(id);
  return { ...created };
}

/** Look up a customer by internal id. */
export function getCustomer(db, customerId) {
  if (!customerId) return null;
  const row = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(customerId);
  return row ? { ...row } : null;
}

/** Look up a customer by provider identity. */
export function getCustomerByProviderId(db, provider, providerCustomerId) {
  if (!provider || !providerCustomerId) return null;
  const row = db
    .prepare(`SELECT * FROM customers WHERE provider = ? AND provider_customer_id = ?`)
    .get(provider, providerCustomerId);
  return row ? { ...row } : null;
}

// ── entitlement lifecycle ───────────────────────────────────────────────────

/**
 * Activate (or re-activate) the entitlement for (customer, product).
 *
 * A customer holds at most ONE entitlement per (customer, product) — enforced
 * by the unique index — so re-activation UPDATES the existing row, it never
 * inserts a duplicate.
 *
 * @throws {EntitlementError} when the event is not verified, the product is
 *   unknown, or the product is disabled.
 */
export function activateEntitlement(db, { event, product, customer } = {}) {
  if (!db) throw new TypeError('activateEntitlement(db, ...) requires a db handle');
  if (!event) throw new EntitlementError('entitlement.event_missing', 'an event is required');
  if (!product || typeof product !== 'object' || !product.product_id) {
    throw new EntitlementError('entitlement.unknown_product', 'a known product is required');
  }

  const verification = String(event.verification_status ?? '').trim();
  if (verification !== VERIFICATION.VERIFIED) {
    throw new EntitlementError(
      'entitlement.event_not_verified',
      `refusing to activate an entitlement from an event with verification_status "${verification || 'unknown'}"`,
      { event_id: event.event_id ?? null, verification_status: verification || null },
    );
  }

  try {
    assertProductEnabled(product);
  } catch (err) {
    if (err instanceof CatalogError) {
      throw new EntitlementError(err.code, err.message, err.details ?? {});
    }
    throw err;
  }

  let customerId = customer?.id ?? customer?.customer_id ?? null;
  if (!customerId) {
    const ensured = ensureCustomer(db, {
      email: event.customer_email ?? customer?.email,
      provider: event.provider ?? customer?.provider,
      providerCustomerId: event.provider_customer_id ?? customer?.provider_customer_id,
      displayName: customer?.display_name ?? customer?.displayName,
    });
    customerId = ensured.id;
  }

  const startsAt = event.occurred_at || nowIso();
  const expiresAt = computeExpiresAt(product, startsAt);
  const ts = nowIso();
  const existing = getEntitlementForCustomerProduct(db, customerId, product.product_id);

  if (existing) {
    db.prepare(
      `UPDATE entitlements
          SET status = 'active', source_event_id = ?, provider_subscription_id = ?,
              starts_at = ?, expires_at = ?, revoked_reason = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(
      event.event_id ?? null,
      event.subscription_reference ?? null,
      startsAt,
      expiresAt,
      ts,
      existing.id,
    );
    return getEntitlement(db, existing.id);
  }

  const id = newId('ent');
  db.prepare(
    `INSERT INTO entitlements
       (id, customer_id, product_id, status, source_event_id, provider_subscription_id, starts_at, expires_at, revoked_reason, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    id,
    customerId,
    product.product_id,
    event.event_id ?? null,
    event.subscription_reference ?? null,
    startsAt,
    expiresAt,
    ts,
    ts,
  );
  return getEntitlement(db, id);
}

/** Fetch one entitlement by id. */
export function getEntitlement(db, entitlementId) {
  if (!entitlementId) return null;
  const row = db.prepare(`SELECT * FROM entitlements WHERE id = ?`).get(entitlementId);
  return rowToEntitlement(row);
}

/** Fetch the (single) entitlement a customer holds for a product. */
export function getEntitlementForCustomerProduct(db, customerId, productId) {
  if (!customerId || !productId) return null;
  const row = db
    .prepare(`SELECT * FROM entitlements WHERE customer_id = ? AND product_id = ?`)
    .get(customerId, productId);
  return rowToEntitlement(row);
}

/** All entitlements for a customer, newest first. */
export function listEntitlements(db, customerId) {
  if (!customerId) return [];
  return db
    .prepare(`SELECT * FROM entitlements WHERE customer_id = ? ORDER BY created_at DESC`)
    .all(customerId)
    .map(rowToEntitlement);
}

function setEntitlementStatus(db, entitlementId, status, reason) {
  if (!entitlementId) throw new EntitlementError('entitlement.id_missing', 'an entitlement id is required');
  const existing = getEntitlement(db, entitlementId);
  if (!existing) {
    throw new EntitlementError('entitlement.not_found', `no entitlement "${entitlementId}"`, { id: entitlementId });
  }
  db.prepare(`UPDATE entitlements SET status = ?, revoked_reason = ?, updated_at = ? WHERE id = ?`).run(
    status,
    reason ?? null,
    nowIso(),
    entitlementId,
  );
  return getEntitlement(db, entitlementId);
}

/** Suspend an entitlement (temporarily removes the right to use). */
export function suspendEntitlement(db, entitlementId, reason) {
  return setEntitlementStatus(db, entitlementId, 'suspended', reason ?? 'suspended');
}

/** Revoke an entitlement permanently. */
export function revokeEntitlement(db, entitlementId, reason) {
  return setEntitlementStatus(db, entitlementId, 'revoked', reason ?? 'revoked');
}

/** Expire an entitlement (the term has ended). */
export function expireEntitlement(db, entitlementId) {
  return setEntitlementStatus(db, entitlementId, 'expired', 'expired');
}

/**
 * Is this entitlement currently usable?
 * Honours `expires_at` — an expired-by-time entitlement is NOT active even if
 * its status column still says 'active'.
 */
export function isEntitlementActive(entitlement, at = nowIso()) {
  if (!entitlement) return false;
  if (entitlement.status !== 'active') return false;
  if (entitlement.expires_at) {
    const exp = Date.parse(entitlement.expires_at);
    const now = Date.parse(at);
    if (Number.isNaN(exp)) return false;
    if (!Number.isNaN(now) && exp <= now) return false;
  }
  return true;
}

/** Resolve a product object for an event, without throwing. */
export function resolveProduct(event, explicitProduct) {
  if (explicitProduct && explicitProduct.product_id) return explicitProduct;
  if (event?.product_id) {
    const byId = getProduct(event.product_id);
    if (byId) return byId;
  }
  return null;
}

export default {
  ENTITLEMENT_STATUSES,
  EntitlementError,
  CustomerError,
  ensureCustomer,
  getCustomer,
  getCustomerByProviderId,
  activateEntitlement,
  getEntitlement,
  getEntitlementForCustomerProduct,
  listEntitlements,
  suspendEntitlement,
  revokeEntitlement,
  expireEntitlement,
  isEntitlementActive,
  computeExpiresAt,
  resolveProduct,
};
