// ─────────────────────────────────────────────────────────────────────────────
// Aurora Revenue Engine — CUSTOMER ACCESS
//
// PRINCIPLE: the session token is a claim, not a proof. Every use of a session
// RE-VALIDATES the current licence + entitlement state, so a licence revoked
// five minutes ago stops granting access IMMEDIATELY, not in seven days.
//
//   * The token carries a NON-SECRET customer reference and a session id.
//     It NEVER carries a licence key, an email, or any secret value.
//   * The email is NEVER returned to the customer surface.
//   * Every output is scoped to the AUTHENTICATED customer. Knowing another
//     customer's id, email or licence key grants nothing.
//
// No secret value is ever logged, printed or written to the database.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { recordEvidence } from './events.js';
import { getCustomer, listEntitlements, isEntitlementActive } from './entitlements.js';
import * as licensesModule from './licenses.js';

/** Session lifetime. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;

/** Licence statuses that are usable. Anything else denies access. */
export const USABLE_LICENSE_STATUSES = Object.freeze(['active', 'issued']);

/** Typed error for every access refusal. */
export class AccessError extends Error {
  constructor(code, message, status = 401, details = {}) {
    super(message || code);
    this.name = 'AccessError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

function nowMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  return Date.now();
}

function secretKey(secret) {
  const s = String(secret ?? '');
  if (!s) {
    throw new AccessError(
      'access.session_secret_missing',
      'a session secret is required; there is no default',
      500,
    );
  }
  return new TextEncoder().encode(s);
}

/**
 * Fetch the licence row for a key.
 * Prefers the fulfilment lane's accessor; falls back to a direct read so the
 * access lane never depends on a lane's export list being final.
 */
export function findLicenseByKey(db, licenseKey) {
  const key = String(licenseKey ?? '').trim();
  if (!key) return null;
  if (typeof licensesModule.getLicenseByKey === 'function') {
    return licensesModule.getLicenseByKey(db, key);
  }
  const row = db.prepare(`SELECT * FROM licenses WHERE license_key = ? LIMIT 1`).get(key);
  return row ? { ...row } : null;
}

/** Fetch a licence row by id. */
export function findLicenseById(db, licenseId) {
  if (!licenseId) return null;
  if (typeof licensesModule.getLicense === 'function') {
    return licensesModule.getLicense(db, licenseId);
  }
  const row = db.prepare(`SELECT * FROM licenses WHERE id = ? LIMIT 1`).get(licenseId);
  return row ? { ...row } : null;
}

/** The entitlement that backs a licence (via its entitlement_id). */
export function entitlementForLicense(db, license) {
  if (!license?.entitlement_id) return null;
  const row = db.prepare(`SELECT * FROM entitlements WHERE id = ? LIMIT 1`).get(license.entitlement_id);
  return row ? { ...row } : null;
}

/** Is this licence row still usable (status + term)? */
export function isLicenseUsable(license, at = Date.now()) {
  if (!license) return false;
  const status = String(license.status ?? '').trim().toLowerCase();
  if (!USABLE_LICENSE_STATUSES.includes(status)) return false;
  if (license.expires_at) {
    const exp = Date.parse(license.expires_at);
    if (Number.isNaN(exp)) return false;
    if (exp <= at) return false;
  }
  return true;
}

/** Mask a licence key for display — the full key is never returned. */
export function maskLicenseKey(key) {
  const k = String(key ?? '');
  if (!k) return null;
  if (k.length <= 4) return '*'.repeat(k.length);
  return `${'*'.repeat(Math.max(0, k.length - 4))}${k.slice(-4)}`;
}

function safeEvidence(db, kind, subjectId, payload) {
  if (!db) return null;
  try {
    return recordEvidence(db, kind, subjectId ?? null, payload, null);
  } catch {
    return null; // evidence must never break the access path
  }
}

/**
 * Authenticate a customer with email + licence key.
 *
 * @returns {Promise<{sessionToken:string, expiresAt:string, customer:object, tier:string, entitlements:object[]}>}
 * @throws {AccessError}
 */
export async function login(db, { email, licenseKey, sessionSecret, now } = {}) {
  if (!db) throw new AccessError('access.db_missing', 'a database handle is required', 500);
  // A missing secret is a hard refusal — never fall back to a default.
  const key = secretKey(sessionSecret);

  const normalizedEmail = normalizeEmail(email);
  const trimmedKey = String(licenseKey ?? '').trim();
  if (!normalizedEmail || !trimmedKey) {
    throw new AccessError('access.invalid_credentials', 'email and licence key are required');
  }

  const license = findLicenseByKey(db, trimmedKey);
  if (!license) {
    safeEvidence(db, 'access.login', null, {
      decision: 'denied',
      reason: 'license_not_found',
      at: new Date(nowMs(now)).toISOString(),
    });
    throw new AccessError('access.invalid_credentials', 'invalid email or licence key');
  }

  // The licence email MUST match the presented email.
  if (normalizeEmail(license.email) !== normalizedEmail) {
    safeEvidence(db, 'access.login', license.id, {
      decision: 'denied',
      reason: 'email_mismatch',
      license_id: license.id,
      at: new Date(nowMs(now)).toISOString(),
    });
    throw new AccessError('access.invalid_credentials', 'invalid email or licence key');
  }

  const entitlement = entitlementForLicense(db, license);
  if (!entitlement) {
    safeEvidence(db, 'access.login', license.id, {
      decision: 'denied',
      reason: 'entitlement_missing',
      license_id: license.id,
      at: new Date(nowMs(now)).toISOString(),
    });
    throw new AccessError('access.license_not_usable', 'this licence has no active entitlement');
  }

  if (!isLicenseUsable(license, nowMs(now))) {
    safeEvidence(db, 'access.login', license.id, {
      decision: 'denied',
      reason: 'license_not_usable',
      license_id: license.id,
      license_status: license.status ?? null,
      at: new Date(nowMs(now)).toISOString(),
    });
    throw new AccessError('access.license_not_usable', 'this licence is not usable');
  }

  if (!isEntitlementActive(entitlement, new Date(nowMs(now)).toISOString())) {
    safeEvidence(db, 'access.login', license.id, {
      decision: 'denied',
      reason: 'entitlement_not_active',
      license_id: license.id,
      entitlement_id: entitlement.id,
      entitlement_status: entitlement.status ?? null,
      at: new Date(nowMs(now)).toISOString(),
    });
    throw new AccessError('access.entitlement_not_active', 'this entitlement is not active');
  }

  const customer = getCustomer(db, entitlement.customer_id);
  if (!customer) {
    safeEvidence(db, 'access.login', license.id, {
      decision: 'denied',
      reason: 'customer_missing',
      license_id: license.id,
      at: new Date(nowMs(now)).toISOString(),
    });
    throw new AccessError('access.customer_missing', 'no customer for this licence');
  }

  const issuedAt = nowMs(now);
  const expiresAtMs = issuedAt + SESSION_TTL_MS;
  const sessionId = `ses_${crypto.randomUUID()}`;

  // The payload is a NON-SECRET reference only: customer id, session id,
  // licence id and tier. No email, no licence key, no secret.
  const sessionToken = await new SignJWT({
    cid: customer.id,
    sid: sessionId,
    lid: license.id,
    tier: license.tier ?? null,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(customer.id)
    .setIssuedAt(Math.floor(issuedAt / 1000))
    .setExpirationTime(Math.floor(expiresAtMs / 1000))
    .sign(key);

  const entitlements = listEntitlements(db, customer.id).map((e) => ({
    id: e.id,
    product_id: e.product_id,
    status: e.status,
    active: isEntitlementActive(e, new Date(issuedAt).toISOString()),
    starts_at: e.starts_at ?? null,
    expires_at: e.expires_at ?? null,
  }));

  safeEvidence(db, 'access.login', customer.id, {
    decision: 'allowed',
    session_id: sessionId,
    license_id: license.id,
    entitlement_id: entitlement.id,
    tier: license.tier ?? null,
    at: new Date(issuedAt).toISOString(),
  });

  return {
    sessionToken,
    expiresAt: new Date(expiresAtMs).toISOString(),
    customer: publicCustomer(customer),
    tier: license.tier ?? null,
    entitlements,
  };
}

/** The customer shape the customer surface may see (no email, no provider ids). */
export function publicCustomer(customer) {
  if (!customer) return null;
  return {
    id: customer.id,
    display_name: customer.display_name ?? null,
    created_at: customer.created_at ?? null,
  };
}

/**
 * Authenticate an existing session.
 *
 * Re-validates the CURRENT licence + entitlement state. A revoked, suspended
 * or expired licence stops the session working IMMEDIATELY.
 *
 * @returns {Promise<{customer:object, session:object, entitlements:object[]}>}
 * @throws {AccessError}
 */
export async function authenticate(db, { authorizationHeader, sessionSecret, now } = {}) {
  if (!db) throw new AccessError('access.db_missing', 'a database handle is required', 500);
  const key = secretKey(sessionSecret);

  const header = String(authorizationHeader ?? '').trim();
  const token = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : header || null;
  if (!token) {
    throw new AccessError('access.missing_token', 'a bearer session token is required');
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(token, key, { algorithms: ['HS256'] }));
  } catch {
    safeEvidence(db, 'access.session', null, {
      decision: 'denied',
      reason: 'invalid_or_expired_token',
      at: new Date(nowMs(now)).toISOString(),
    });
    throw new AccessError('access.invalid_token', 'invalid or expired session token');
  }

  const customerId = payload.cid ?? payload.sub ?? null;
  const licenseId = payload.lid ?? null;
  const sessionId = payload.sid ?? null;

  if (!customerId || !licenseId) {
    safeEvidence(db, 'access.session', customerId ?? null, {
      decision: 'denied',
      reason: 'incomplete_session',
      session_id: sessionId ?? null,
      at: new Date(nowMs(now)).toISOString(),
    });
    throw new AccessError('access.invalid_token', 'invalid or expired session token');
  }

  const customer = getCustomer(db, customerId);
  if (!customer) {
    safeEvidence(db, 'access.session', customerId, {
      decision: 'denied',
      reason: 'customer_missing',
      session_id: sessionId ?? null,
      at: new Date(nowMs(now)).toISOString(),
    });
    throw new AccessError('access.customer_missing', 'no customer for this session');
  }

  const license = findLicenseById(db, licenseId);
  if (!license) {
    safeEvidence(db, 'access.session', customerId, {
      decision: 'denied',
      reason: 'license_missing',
      session_id: sessionId ?? null,
      license_id: licenseId,
      at: new Date(nowMs(now)).toISOString(),
    });
    throw new AccessError('access.license_not_usable', 'this licence is not usable');
  }

  // The licence must still belong to THIS customer.
  const entitlement = entitlementForLicense(db, license);
  if (!entitlement || entitlement.customer_id !== customer.id) {
    safeEvidence(db, 'access.session', customer.id, {
      decision: 'denied',
      reason: 'license_customer_mismatch',
      session_id: sessionId ?? null,
      license_id: licenseId,
      at: new Date(nowMs(now)).toISOString(),
    });
    throw new AccessError('access.license_not_usable', 'this licence is not usable');
  }

  if (!isLicenseUsable(license, nowMs(now))) {
    safeEvidence(db, 'access.session', customer.id, {
      decision: 'denied',
      reason: 'license_not_usable',
      session_id: sessionId ?? null,
      license_id: licenseId,
      license_status: license.status ?? null,
      at: new Date(nowMs(now)).toISOString(),
    });
    throw new AccessError('access.license_not_usable', 'this licence is not usable');
  }

  if (!isEntitlementActive(entitlement, new Date(nowMs(now)).toISOString())) {
    safeEvidence(db, 'access.session', customer.id, {
      decision: 'denied',
      reason: 'entitlement_not_active',
      session_id: sessionId ?? null,
      license_id: licenseId,
      entitlement_id: entitlement.id,
      entitlement_status: entitlement.status ?? null,
      at: new Date(nowMs(now)).toISOString(),
    });
    throw new AccessError('access.entitlement_not_active', 'this entitlement is not active');
  }

  const entitlements = listEntitlements(db, customer.id).map((e) => ({
    id: e.id,
    product_id: e.product_id,
    status: e.status,
    active: isEntitlementActive(e, new Date(nowMs(now)).toISOString()),
    starts_at: e.starts_at ?? null,
    expires_at: e.expires_at ?? null,
  }));

  safeEvidence(db, 'access.session', customer.id, {
    decision: 'allowed',
    session_id: sessionId ?? null,
    license_id: licenseId,
    entitlement_id: entitlement.id,
    at: new Date(nowMs(now)).toISOString(),
  });

  return {
    customer: publicCustomer(customer),
    session: {
      id: sessionId ?? null,
      expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
      tier: payload.tier ?? null,
    },
    entitlements,
  };
}

/**
 * The customer profile with their entitlements and licences.
 * NEVER returns another customer's data: everything is derived from
 * customerId and nothing else.
 */
export function describeCustomer(db, customerId) {
  if (!db) throw new AccessError('access.db_missing', 'a database handle is required', 500);
  if (!customerId) throw new AccessError('access.customer_missing', 'a customer id is required', 404);

  const customer = getCustomer(db, customerId);
  if (!customer) {
    throw new AccessError('access.customer_missing', 'no such customer', 404);
  }

  const entitlements = listEntitlements(db, customer.id).map((e) => ({
    id: e.id,
    product_id: e.product_id,
    status: e.status,
    active: isEntitlementActive(e),
    starts_at: e.starts_at ?? null,
    expires_at: e.expires_at ?? null,
  }));

  const licenseRows = db
    .prepare(
      `SELECT * FROM licenses
        WHERE entitlement_id IN (SELECT id FROM entitlements WHERE customer_id = ?)
        ORDER BY created_at DESC`,
    )
    .all(customer.id);

  const licences = licenseRows.map((l) => ({
    id: l.id,
    tier: l.tier ?? null,
    status: l.status ?? null,
    usable: isLicenseUsable(l),
    issued_at: l.issued_at ?? l.created_at ?? null,
    expires_at: l.expires_at ?? null,
    license_key_masked: maskLicenseKey(l.license_key),
    entitlement_id: l.entitlement_id ?? null,
  }));

  return {
    customer: publicCustomer(customer),
    entitlements,
    licences,
  };
}

// ── express handlers (the lead mounts these) ────────────────────────────────

/** POST /v1/login */
export function loginHandler(deps = {}) {
  const { db, sessionSecret } = deps;
  return async (req, res) => {
    try {
      const body = req.body ?? {};
      const result = await login(db, {
        email: body.email,
        licenseKey: body.licenseKey ?? body.license_key,
        sessionSecret: sessionSecret ?? process.env.CCPI_SESSION_JWT_SECRET,
      });
      res.json({
        sessionToken: result.sessionToken,
        expiresAt: result.expiresAt,
        customer: result.customer,
        tier: result.tier,
        entitlements: result.entitlements,
      });
    } catch (err) {
      const status = err instanceof AccessError ? err.status : 401;
      res.status(status).json({ error: err.code ?? 'access_denied' });
    }
  };
}

/** GET /v1/me — always re-validates the session against current state. */
export function meHandler(deps = {}) {
  const { db, sessionSecret } = deps;
  return async (req, res) => {
    try {
      const result = await authenticate(db, {
        authorizationHeader: req.headers?.authorization,
        sessionSecret: sessionSecret ?? process.env.CCPI_SESSION_JWT_SECRET,
      });
      res.json({
        customer: result.customer,
        session: result.session,
        entitlements: result.entitlements,
      });
    } catch (err) {
      const status = err instanceof AccessError ? err.status : 401;
      res.status(status).json({ error: err.code ?? 'access_denied' });
    }
  };
}

export default {
  SESSION_TTL_MS,
  SESSION_TTL_SECONDS,
  USABLE_LICENSE_STATUSES,
  AccessError,
  login,
  authenticate,
  describeCustomer,
  publicCustomer,
  findLicenseByKey,
  findLicenseById,
  entitlementForLicense,
  isLicenseUsable,
  maskLicenseKey,
  loginHandler,
  meHandler,
};
