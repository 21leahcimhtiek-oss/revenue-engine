// ─────────────────────────────────────────────────────────────────────────────
// Aurora Revenue Engine — ADMIN SURFACE
//
// PRINCIPLE: an admin route is NEVER anonymous.
//
// The guard is a bearer token compared, in CONSTANT TIME, against
// `process.env.REVENUE_ADMIN_TOKEN`.
//
//   FAIL CLOSED: if the env var is not configured, EVERY admin route is
//   unusable (401). There is no default token, no fallback, no bypass.
//
//   The comparison uses crypto.timingSafeEqual over EQUAL-LENGTH buffers.
//   To compare two arbitrary-length strings without leaking their length via
//   an early return, both sides are first hashed with SHA-256 (fixed 32-byte
//   digest) and the digests are compared in constant time.
//
// No secret value is ever printed, logged, or returned. Only whether a secret
// is CONFIGURED is ever reported.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { recordEvidence } from './events.js';
import { describeCustomer } from './access.js';
import { assertNoMoneyMovement, runGovernedAction, governedStatus, governedActions } from './governed.js';

/** The env var holding the admin bearer token. */
export const ADMIN_TOKEN_ENV = 'REVENUE_ADMIN_TOKEN';

/** Typed error for an admin authorisation failure. */
export class AdminAuthError extends Error {
  constructor(code, message, status = 401, details = {}) {
    super(message || code);
    this.name = 'AdminAuthError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Constant-time comparison of two strings.
 * Both are hashed to a fixed-length digest first so the buffers are always
 * the same length (timingSafeEqual requires equal lengths).
 */
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Authorisation guard for every admin route.
 *
 * @throws {AdminAuthError} 401 when the token is missing, wrong, malformed, or
 *   when `REVENUE_ADMIN_TOKEN` is not configured at all (fail closed).
 * @returns {true} when authorised.
 */
export function requireAdmin(req) {
  const configured = process.env[ADMIN_TOKEN_ENV];
  if (!configured || !String(configured).trim()) {
    // FAIL CLOSED: no configured token => no admin access, ever.
    throw new AdminAuthError('admin.not_configured', 'admin access is not configured', 401);
  }

  const header = String(req?.headers?.authorization ?? req?.headers?.Authorization ?? '').trim();
  if (!header) {
    throw new AdminAuthError('admin.missing_token', 'an admin bearer token is required', 401);
  }

  const presented = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : null;
  if (!presented) {
    throw new AdminAuthError('admin.missing_token', 'an admin bearer token is required', 401);
  }

  if (!safeEqual(presented, String(configured).trim())) {
    throw new AdminAuthError('admin.invalid_token', 'invalid admin token', 401);
  }

  return true;
}

function adminEvidence(db, kind, payload) {
  if (!db) return null;
  try {
    return recordEvidence(db, kind, payload?.subject_id ?? null, payload, null);
  } catch {
    return null;
  }
}

/** Wrap an async express handler so thrown AdminAuthError becomes a 401. */
function guard(handler) {
  return async (req, res) => {
    try {
      requireAdmin(req);
    } catch (err) {
      const status = err instanceof AdminAuthError ? err.status : 401;
      res.status(status).json({ error: err.code ?? 'admin_unauthorized' });
      return;
    }
    try {
      await handler(req, res);
    } catch (err) {
      const status = err?.status ?? 500;
      res.status(status).json({ error: err.code ?? err.message ?? 'admin_error' });
    }
  };
}

function summarise(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  return Object.keys(value).slice(0, 20);
}

// ── handler factories ───────────────────────────────────────────────────────

/**
 * GET /admin/health — configuration facts only. NO secret values.
 */
export function healthHandler(deps = {}) {
  const { db } = deps;
  return guard(async (_req, res) => {
    const priceIdsConfigured = countConfiguredPriceIds();
    let database = { ok: false, path: null, counts: null };
    if (db) {
      try {
        const counts = {
          customers: db.prepare(`SELECT COUNT(*) AS c FROM customers`).get().c,
          entitlements: db.prepare(`SELECT COUNT(*) AS c FROM entitlements`).get().c,
          licenses: db.prepare(`SELECT COUNT(*) AS c FROM licenses`).get().c,
          evidence: db.prepare(`SELECT COUNT(*) AS c FROM evidence`).get().c,
        };
        database = { ok: true, path: db.name ? String(db.name) : null, counts };
      } catch (err) {
        database = { ok: false, path: null, error: err?.message ?? 'database_unavailable' };
      }
    }
    res.json({
      ok: true,
      stripeConfigured: !!process.env.STRIPE_SECRET_KEY,
      priceIdsConfigured,
      database,
      uptime: Math.round(process.uptime()),
      scheduler: {
        configured: !!(process.env.REVENUE_SCHEDULER_ENABLED || process.env.SCHEDULER_ENABLED),
        enabled:
          String(process.env.REVENUE_SCHEDULER_ENABLED ?? process.env.SCHEDULER_ENABLED ?? '')
            .toLowerCase() === 'true',
      },
      governed: { ...governedStatus(), actions: governedActions() },
    });
  });
}

function countConfiguredPriceIds() {
  const names = [
    'PRICE_STARTER',
    'PRICE_SKILL_PACK_LITE',
    'PRICE_SKILL_PACK_STD',
    'PRICE_SKILL_PACK_ELITE',
    'PRICE_PRO_ANNUAL',
    'PRICE_MCP_SUITE',
  ];
  return names.filter((n) => !!process.env[n]).length;
}

/** POST /admin/sync — trigger a provider sync. */
export function syncHandler(deps = {}) {
  const { db, sync } = deps;
  return guard(async (_req, res) => {
    if (typeof sync !== 'function') {
      res.status(501).json({ error: 'admin.sync_unavailable' });
      return;
    }
    const result = await sync();
    adminEvidence(db, 'admin.sync', {
      subject_id: null,
      decision: 'completed',
      result_summary: summarise(result),
      at: new Date().toISOString(),
    });
    res.json({ ok: true, result });
  });
}

/** POST /admin/reconcile — trigger reconciliation; returns report + verdict. */
export function reconcileHandler(deps = {}) {
  const { db, reconcile } = deps;
  return guard(async (_req, res) => {
    if (typeof reconcile !== 'function') {
      res.status(501).json({ error: 'admin.reconcile_unavailable' });
      return;
    }
    const result = await reconcile();
    const report = result?.report ?? result ?? null;
    const verdict = result?.verdict ?? result?.summary ?? null;
    adminEvidence(db, 'admin.reconcile', {
      subject_id: null,
      decision: 'completed',
      verdict: summarise(verdict),
      at: new Date().toISOString(),
    });
    res.json({ ok: true, report, verdict });
  });
}

/** GET /admin/customers/:id — a customer and their commercial state. */
export function customerHandler(deps = {}) {
  const { db } = deps;
  return guard(async (req, res) => {
    const id = req.params?.id ?? req.query?.customerId ?? req.body?.customerId;
    if (!id) {
      res.status(400).json({ error: 'admin.customer_id_required' });
      return;
    }
    const detail = describeCustomer(db, id);
    adminEvidence(db, 'admin.customer.view', {
      subject_id: id,
      decision: 'allowed',
      at: new Date().toISOString(),
    });
    res.json({ ok: true, ...detail });
  });
}

/** GET /admin/entitlements — list entitlements (optionally by customer). */
export function entitlementHandler(deps = {}) {
  const { db } = deps;
  return guard(async (req, res) => {
    const customerId = req.query?.customerId ?? req.body?.customerId ?? null;
    const rows = customerId
      ? db
          .prepare(`SELECT * FROM entitlements WHERE customer_id = ? ORDER BY created_at DESC`)
          .all(customerId)
      : db.prepare(`SELECT * FROM entitlements ORDER BY created_at DESC LIMIT 200`).all();
    const status = req.query?.status ?? req.body?.status ?? null;
    const filtered = status ? rows.filter((r) => r.status === status) : rows;
    res.json({ ok: true, count: filtered.length, entitlements: filtered });
  });
}

function maskKey(key) {
  const k = String(key ?? '');
  if (!k) return null;
  if (k.length <= 4) return '*'.repeat(k.length);
  return `${'*'.repeat(Math.max(0, k.length - 4))}${k.slice(-4)}`;
}

/** GET /admin/licenses — list licences. POST — revoke / suspend / reactivate. */
export function licenseHandler(deps = {}) {
  const { db } = deps;
  return guard(async (req, res) => {
    if (req.method === 'GET') {
      const customerId = req.query?.customerId ?? null;
      const rows = customerId
        ? db
            .prepare(
              `SELECT l.* FROM licenses l
                 JOIN entitlements e ON e.id = l.entitlement_id
                WHERE e.customer_id = ?
                ORDER BY l.created_at DESC`,
            )
            .all(customerId)
        : db.prepare(`SELECT * FROM licenses ORDER BY created_at DESC LIMIT 200`).all();
      res.json({
        ok: true,
        count: rows.length,
        licenses: rows.map((l) => ({
          id: l.id,
          email: l.email,
          tier: l.tier ?? null,
          status: l.status ?? null,
          entitlement_id: l.entitlement_id ?? null,
          issued_at: l.issued_at ?? l.created_at ?? null,
          expires_at: l.expires_at ?? null,
          license_key_masked: maskKey(l.license_key),
        })),
      });
      return;
    }

    const body = req.body ?? {};
    const licenseId = body.licenseId ?? body.id ?? null;
    const action = String(body.action ?? 'revoke').toLowerCase();
    if (!licenseId) {
      res.status(400).json({ error: 'admin.license_id_required' });
      return;
    }
    if (!['revoke', 'suspend', 'reactivate'].includes(action)) {
      res.status(400).json({ error: 'admin.unsupported_license_action' });
      return;
    }

    const row = db.prepare(`SELECT * FROM licenses WHERE id = ? LIMIT 1`).get(licenseId);
    if (!row) {
      res.status(404).json({ error: 'admin.license_not_found' });
      return;
    }

    const nextStatus =
      action === 'revoke' ? 'revoked' : action === 'suspend' ? 'suspended' : 'active';
    db.prepare(`UPDATE licenses SET status = ?, revoked_reason = ? WHERE id = ?`).run(
      nextStatus,
      action === 'reactivate' ? null : body.reason ?? action,
      licenseId,
    );

    adminEvidence(db, 'admin.license.status', {
      subject_id: licenseId,
      decision: 'applied',
      action,
      status: nextStatus,
      reason: body.reason ?? null,
      at: new Date().toISOString(),
    });

    const updated = db.prepare(`SELECT * FROM licenses WHERE id = ? LIMIT 1`).get(licenseId);
    res.json({
      ok: true,
      license: {
        id: updated.id,
        tier: updated.tier ?? null,
        status: updated.status ?? null,
        entitlement_id: updated.entitlement_id ?? null,
        license_key_masked: maskKey(updated.license_key),
      },
    });
  });
}

/** GET /admin/evidence — list evidence records. */
export function evidenceHandler(deps = {}) {
  const { db } = deps;
  return guard(async (req, res) => {
    const kind = req.query?.kind ?? null;
    const subjectId = req.query?.subjectId ?? null;
    const limit = Math.min(Number(req.query?.limit ?? 100) || 100, 500);
    let sql = `SELECT id, kind, subject_id, payload_json, source_fingerprint, created_at FROM evidence`;
    const where = [];
    const params = [];
    if (kind) {
      where.push('kind = ?');
      params.push(kind);
    }
    if (subjectId) {
      where.push('subject_id = ?');
      params.push(subjectId);
    }
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);
    const rows = db.prepare(sql).all(...params).map((r) => ({
      id: r.id,
      kind: r.kind,
      subject_id: r.subject_id,
      payload: safeParse(r.payload_json),
      source_fingerprint: r.source_fingerprint ?? null,
      created_at: r.created_at,
    }));
    res.json({ ok: true, count: rows.length, evidence: rows });
  });
}

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * POST /admin/action — run a GOVERNED action.
 *
 * MONEY MOVEMENT IS REFUSED HERE even though the admin token was accepted:
 * `assertNoMoneyMovement` runs FIRST and throws
 * `governed.money_movement_requires_authorisation`. Nothing is performed and
 * the refusal is recorded in evidence.
 */
export function actionHandler(deps = {}) {
  const { db } = deps;
  return guard(async (req, res) => {
    const body = req.body ?? {};
    const action = String(body.action ?? '').trim();

    try {
      // Guard FIRST: money movement is refused regardless of authorisation.
      assertNoMoneyMovement(action);
    } catch (err) {
      adminEvidence(db, 'admin.action.refused', {
        subject_id: body.taskId ?? null,
        decision: 'refused',
        action: action || null,
        code: err?.code ?? 'governed.refused',
        reason: err?.message ?? 'refused',
        performed: false,
        at: new Date().toISOString(),
      });
      res.status(err?.status ?? 403).json({
        error: err?.code ?? 'governed.refused',
        performed: false,
      });
      return;
    }

    const result = await runGovernedAction(action, {
      taskId: body.taskId ?? null,
      resource: body.resource ?? null,
      objective: body.objective ?? null,
      params: body.params ?? {},
      db,
    });

    adminEvidence(db, 'admin.action', {
      subject_id: body.taskId ?? null,
      decision: result.governed ? 'governed' : 'not_governed',
      action,
      governed: result.governed,
      mode: result.mode,
      performed: result.performed === true,
      at: new Date().toISOString(),
    });

    res.json({ ok: true, ...result });
  });
}

export default {
  ADMIN_TOKEN_ENV,
  AdminAuthError,
  requireAdmin,
  safeEqual,
  healthHandler,
  syncHandler,
  reconcileHandler,
  customerHandler,
  entitlementHandler,
  licenseHandler,
  evidenceHandler,
  actionHandler,
};
