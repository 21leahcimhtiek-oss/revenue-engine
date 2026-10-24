// Aurora Revenue Engine — CUSTOMER ACCESS + ADMIN SURFACE + GOVERNED EXECUTION
//
// Every test uses a DISPOSABLE database in a temp directory. `data/licenses.db`
// is NEVER opened.
//
// Covered:
//   * login: valid, wrong email, wrong key, unknown key
//   * login: suspended / expired / revoked licence
//   * a session created BEFORE a revocation stops working afterwards
//   * /v1/me equivalent returns ONLY the authenticated customer's entitlements
//   * cross-customer access attempts are denied
//   * malformed / tampered / expired tokens are rejected
//   * a missing sessionSecret throws (no empty-secret fallback)
//   * admin: no token / wrong token / correct token
//   * admin: REVENUE_ADMIN_TOKEN unset => 401 (fail closed)
//   * admin: money-movement action => typed error, nothing performed
//   * isGovernedAvailable() returns a boolean without throwing
//   * evidence is written for access decisions and for a refused admin action

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, newId, nowIso } from '../src/db.js';
import { login, authenticate, describeCustomer, AccessError } from '../src/access.js';
import {
  requireAdmin,
  AdminAuthError,
  healthHandler,
  syncHandler,
  reconcileHandler,
  customerHandler,
  entitlementHandler,
  licenseHandler,
  evidenceHandler,
  actionHandler,
} from '../src/admin.js';
import {
  isGovernedAvailable,
  governedActions,
  assertNoMoneyMovement,
  GovernedError,
  loadGoverned,
  governedStatus,
} from '../src/governed.js';

const SESSION_SECRET = 'test-session-secret-not-a-real-secret';

// ── fixtures ────────────────────────────────────────────────────────────────

function tempDbPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-access-'));
  return path.join(dir, name);
}

function makeDb() {
  return openDb(tempDbPath('access.db'));
}

/**
 * Create a customer + active entitlement + licence.
 * Returns { db, customer, entitlement, license, email, licenseKey }.
 */
function makeLicensedCustomer(db, opts = {}) {
  const email = (opts.email ?? `customer+${newId('t').slice(-8)}@example.test`).toLowerCase();
  const customerId = newId('cus');
  const ts = nowIso();
  db.prepare(
    `INSERT INTO customers (id, email, email_normalized, display_name, provider,
        provider_customer_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'stripe', ?, ?, ?)`,
  ).run(customerId, email, email, opts.displayName ?? null, newId('pcus'), ts, ts);

  const entitlementId = newId('ent');
  db.prepare(
    `INSERT INTO entitlements (id, customer_id, product_id, status, source_event_id,
        provider_subscription_id, starts_at, expires_at, revoked_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?)`,
  ).run(
    entitlementId,
    customerId,
    opts.productId ?? 'skill_pack_lite',
    opts.entitlementStatus ?? 'active',
    ts,
    opts.expiresAt ?? null,
    ts,
    ts,
  );

  const licenseId = newId('lic');
  const licenseKey = `CCPI-TEST-${newId('k').toUpperCase()}`;
  db.prepare(
    `INSERT INTO licenses (id, email, license_key, price_id, tier, status,
        stripe_customer_id, created_at, entitlement_id, issued_at, expires_at,
        revoked_reason, subscription_id, event_id)
     VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL)`,
  ).run(
    licenseId,
    email,
    licenseKey,
    opts.tier ?? 'skill_pack',
    opts.licenseStatus ?? 'active',
    ts,
    entitlementId,
    ts,
    opts.expiresAt ?? null,
  );

  return { db, customerId, customer: { id: customerId, email }, entitlementId, licenseId, email, licenseKey };
}

function setLicenseStatus(db, licenseId, status) {
  db.prepare(`UPDATE licenses SET status = ? WHERE id = ?`).run(status, licenseId);
}

function setEntitlementStatus(db, entitlementId, status) {
  db.prepare(`UPDATE entitlements SET status = ? WHERE id = ?`).run(status, entitlementId);
}

/** Minimal express-like req/res doubles. */
function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

function evidenceRows(db, kind) {
  return db
    .prepare(`SELECT kind, subject_id, payload_json FROM evidence WHERE kind = ? ORDER BY created_at`)
    .all(kind)
    .map((r) => ({ ...r, payload: JSON.parse(r.payload_json) }));
}

// ── login ───────────────────────────────────────────────────────────────────

test('login: valid email + usable licence returns a session token', async () => {
  const db = makeDb();
  const fx = makeLicensedCustomer(db);

  const result = await login(db, {
    email: fx.email,
    licenseKey: fx.licenseKey,
    sessionSecret: SESSION_SECRET,
  });

  assert.ok(result.sessionToken, 'a session token is returned');
  assert.equal(typeof result.sessionToken, 'string');
  assert.equal(result.customer.id, fx.customerId);
  assert.ok(result.expiresAt);
  assert.equal(result.entitlements.length, 1);
  assert.equal(result.entitlements[0].id, fx.entitlementId);

  // The token payload must NOT carry the email or the licence key.
  const payload = JSON.parse(
    Buffer.from(result.sessionToken.split('.')[1], 'base64url').toString('utf8'),
  );
  assert.equal(payload.email, undefined);
  assert.equal(payload.licenseKey, undefined);
  assert.equal(payload.lid, fx.licenseId);
  assert.equal(payload.cid, fx.customerId);

  // The email is never returned to the customer surface.
  assert.equal(result.customer.email, undefined);
  assert.equal(JSON.stringify(result).includes(fx.email), false);
});

test('login: email casing is normalised; matching still works', async () => {
  const db = makeDb();
  const fx = makeLicensedCustomer(db, { email: 'Mixed.Case@Example.Test' });
  const result = await login(db, {
    email: 'MIXED.CASE@example.test',
    licenseKey: fx.licenseKey,
    sessionSecret: SESSION_SECRET,
  });
  assert.equal(result.customer.id, fx.customerId);
});

test('login: wrong email is rejected', async () => {
  const db = makeDb();
  const fx = makeLicensedCustomer(db);
  await assert.rejects(
    () => login(db, { email: 'someone.else@example.test', licenseKey: fx.licenseKey, sessionSecret: SESSION_SECRET }),
    (err) => err instanceof AccessError && err.code === 'access.invalid_credentials',
  );
});

test('login: wrong licence key is rejected', async () => {
  const db = makeDb();
  const fx = makeLicensedCustomer(db);
  await assert.rejects(
    () => login(db, { email: fx.email, licenseKey: 'CCPI-WRONG-KEY', sessionSecret: SESSION_SECRET }),
    (err) => err instanceof AccessError && err.code === 'access.invalid_credentials',
  );
});

test('login: unknown licence is rejected', async () => {
  const db = makeDb();
  makeLicensedCustomer(db);
  await assert.rejects(
    () => login(db, { email: 'nobody@example.test', licenseKey: 'CCPI-NOPE', sessionSecret: SESSION_SECRET }),
    (err) => err instanceof AccessError && err.code === 'access.invalid_credentials',
  );
});

test('login: suspended licence is rejected', async () => {
  const db = makeDb();
  const fx = makeLicensedCustomer(db);
  setLicenseStatus(db, fx.licenseId, 'suspended');
  await assert.rejects(
    () => login(db, { email: fx.email, licenseKey: fx.licenseKey, sessionSecret: SESSION_SECRET }),
    (err) => err instanceof AccessError && err.code === 'access.license_not_usable',
  );
});

test('login: revoked licence is rejected', async () => {
  const db = makeDb();
  const fx = makeLicensedCustomer(db);
  setLicenseStatus(db, fx.licenseId, 'revoked');
  await assert.rejects(
    () => login(db, { email: fx.email, licenseKey: fx.licenseKey, sessionSecret: SESSION_SECRET }),
    (err) => err instanceof AccessError && err.code === 'access.license_not_usable',
  );
});

test('login: expired licence is rejected', async () => {
  const db = makeDb();
  const fx = makeLicensedCustomer(db, { expiresAt: new Date(Date.now() - 60000).toISOString() });
  await assert.rejects(
    () => login(db, { email: fx.email, licenseKey: fx.licenseKey, sessionSecret: SESSION_SECRET }),
    (err) => err instanceof AccessError && err.code === 'access.license_not_usable',
  );
});

test('login: inactive entitlement is rejected even with a usable licence', async () => {
  const db = makeDb();
  const fx = makeLicensedCustomer(db);
  setEntitlementStatus(db, fx.entitlementId, 'suspended');
  await assert.rejects(
    () => login(db, { email: fx.email, licenseKey: fx.licenseKey, sessionSecret: SESSION_SECRET }),
    (err) => err instanceof AccessError && err.code === 'access.entitlement_not_active',
  );
});

test('login: a missing sessionSecret throws instead of using an empty secret', async () => {
  const db = makeDb();
  const fx = makeLicensedCustomer(db);
  await assert.rejects(
    () => login(db, { email: fx.email, licenseKey: fx.licenseKey, sessionSecret: '' }),
    (err) => err instanceof AccessError && err.code === 'access.session_secret_missing',
  );
  await assert.rejects(
    () => login(db, { email: fx.email, licenseKey: fx.licenseKey }),
    (err) => err instanceof AccessError && err.code === 'access.session_secret_missing',
  );
});

test('login: evidence is written for the access decision', async () => {
  const db = makeDb();
  const fx = makeLicensedCustomer(db);
  await login(db, { email: fx.email, licenseKey: fx.licenseKey, sessionSecret: SESSION_SECRET });
  const allowed = evidenceRows(db, 'access.login');
  assert.ok(allowed.length >= 1);
  assert.equal(allowed.at(-1).payload.decision, 'allowed');
  assert.equal(allowed.at(-1).subject_id, fx.customerId);
});

// ── authenticate / session re-validation ────────────────────────────────────

test('authenticate: a live session returns the customer and their entitlements', async () => {
  const db = makeDb();
  const fx = makeLicensedCustomer(db);
  const { sessionToken } = await login(db, {
    email: fx.email,
    licenseKey: fx.licenseKey,
    sessionSecret: SESSION_SECRET,
  });

  const result = await authenticate(db, {
    authorizationHeader: `Bearer ${sessionToken}`,
    sessionSecret: SESSION_SECRET,
  });
  assert.equal(result.customer.id, fx.customerId);
  assert.equal(result.entitlements.length, 1);
  assert.equal(result.entitlements[0].id, fx.entitlementId);
  assert.equal(result.customer.email, undefined, 'no email is returned');
});

test('authenticate: a session created BEFORE revocation STOPS working', async () => {
  const db = makeDb();
  const fx = makeLicensedCustomer(db);
  const { sessionToken, expiresAt } = await login(db, {
    email: fx.email,
    licenseKey: fx.licenseKey,
    sessionSecret: SESSION_SECRET,
  });
  // The token is still unexpired (7 day TTL).
  assert.ok(new Date(expiresAt).getTime() > Date.now());

  // Revoke the licence AFTER the session was issued.
  setLicenseStatus(db, fx.licenseId, 'revoked');

  await assert.rejects(
    () => authenticate(db, { authorizationHeader: `Bearer ${sessionToken}`, sessionSecret: SESSION_SECRET }),
    (err) => err instanceof AccessError && err.code === 'access.license_not_usable',
  );

  // And the denial is on the record.
  const rows = evidenceRows(db, 'access.session');
  const denied = rows.filter((r) => r.payload.decision === 'denied');
  assert.ok(denied.length >= 1);
  assert.equal(denied.at(-1).payload.reason, 'license_not_usable');
});

test('authenticate: a session stops working when the entitlement is revoked', async () => {
  const db = makeDb();
  const fx = makeLicensedCustomer(db);
  const { sessionToken } = await login(db, {
    email: fx.email,
    licenseKey: fx.licenseKey,
    sessionSecret: SESSION_SECRET,
  });
  setEntitlementStatus(db, fx.entitlementId, 'revoked');
  await assert.rejects(
    () => authenticate(db, { authorizationHeader: `Bearer ${sessionToken}`, sessionSecret: SESSION_SECRET }),
    (err) => err instanceof AccessError && err.code === 'access.entitlement_not_active',
  );
});

test('authenticate: a missing token is rejected', async () => {
  const db = makeDb();
  await assert.rejects(
    () => authenticate(db, { authorizationHeader: '', sessionSecret: SESSION_SECRET }),
    (err) => err instanceof AccessError && err.code === 'access.missing_token',
  );
});

test('authenticate: a malformed token is rejected', async () => {
  const db = makeDb();
  await assert.rejects(
    () => authenticate(db, { authorizationHeader: 'Bearer not-a-jwt', sessionSecret: SESSION_SECRET }),
    (err) => err instanceof AccessError && err.code === 'access.invalid_token',
  );
});

test('authenticate: a tampered token is rejected', async () => {
  const db = makeDb();
  const fx = makeLicensedCustomer(db);
  const { sessionToken } = await login(db, {
    email: fx.email,
    licenseKey: fx.licenseKey,
    sessionSecret: SESSION_SECRET,
  });
  const parts = sessionToken.split('.');
  const forgedPayload = Buffer.from(
    JSON.stringify({ cid: 'cus_someone_else', lid: 'lic_other', sid: 'ses_forged', exp: 9999999999 }),
  ).toString('base64url');
  const tampered = `${parts[0]}.${forgedPayload}.${parts[2]}`;
  await assert.rejects(
    () => authenticate(db, { authorizationHeader: `Bearer ${tampered}`, sessionSecret: SESSION_SECRET }),
    (err) => err instanceof AccessError && err.code === 'access.invalid_token',
  );
});

test('authenticate: an expired token is rejected', async () => {
  const db = makeDb();
  const fx = makeLicensedCustomer(db);
  const { sessionToken } = await login(db, {
    email: fx.email,
    licenseKey: fx.licenseKey,
    sessionSecret: SESSION_SECRET,
    now: Date.now() - 30 * 24 * 60 * 60 * 1000, // issued 30 days ago => long expired
  });
  await assert.rejects(
    () => authenticate(db, { authorizationHeader: `Bearer ${sessionToken}`, sessionSecret: SESSION_SECRET }),
    (err) => err instanceof AccessError && err.code === 'access.invalid_token',
  );
});

test('authenticate: a token signed with a different secret is rejected', async () => {
  const db = makeDb();
  const fx = makeLicensedCustomer(db);
  const { sessionToken } = await login(db, {
    email: fx.email,
    licenseKey: fx.licenseKey,
    sessionSecret: SESSION_SECRET,
  });
  await assert.rejects(
    () => authenticate(db, { authorizationHeader: `Bearer ${sessionToken}`, sessionSecret: 'a-different-secret' }),
    (err) => err instanceof AccessError && err.code === 'access.invalid_token',
  );
});

// ── scoping ─────────────────────────────────────────────────────────────────

test('scoping: the me-equivalent returns ONLY the authenticated customer entitlements', async () => {
  const db = makeDb();
  const a = makeLicensedCustomer(db, { productId: 'skill_pack_lite' });
  const b = makeLicensedCustomer(db, { productId: 'pro_annual' });

  const { sessionToken } = await login(db, {
    email: a.email,
    licenseKey: a.licenseKey,
    sessionSecret: SESSION_SECRET,
  });
  const me = await authenticate(db, {
    authorizationHeader: `Bearer ${sessionToken}`,
    sessionSecret: SESSION_SECRET,
  });

  assert.equal(me.entitlements.length, 1);
  assert.equal(me.entitlements[0].id, a.entitlementId);
  assert.equal(me.entitlements.some((e) => e.id === b.entitlementId), false);
  assert.equal(JSON.stringify(me).includes(b.entitlementId), false);
  assert.equal(JSON.stringify(me).includes(b.email), false);
});

test('scoping: customer B cannot use customer A licence key with B email', async () => {
  const db = makeDb();
  const a = makeLicensedCustomer(db);
  const b = makeLicensedCustomer(db);
  await assert.rejects(
    () => login(db, { email: b.email, licenseKey: a.licenseKey, sessionSecret: SESSION_SECRET }),
    (err) => err instanceof AccessError && err.code === 'access.invalid_credentials',
  );
});

test('scoping: describeCustomer returns only that customer', async () => {
  const db = makeDb();
  const a = makeLicensedCustomer(db);
  const b = makeLicensedCustomer(db);
  const detail = describeCustomer(db, a.customerId);
  assert.equal(detail.customer.id, a.customerId);
  assert.equal(detail.entitlements.length, 1);
  assert.equal(detail.entitlements[0].id, a.entitlementId);
  assert.equal(detail.licences.length, 1);
  assert.equal(detail.licences[0].id, a.licenseId);
  const serialised = JSON.stringify(detail);
  assert.equal(serialised.includes(b.entitlementId), false);
  assert.equal(serialised.includes(b.licenseId), false);
  assert.equal(serialised.includes(b.email), false);
});

test('scoping: the licence key is never returned in full', async () => {
  const db = makeDb();
  const a = makeLicensedCustomer(db);
  const detail = describeCustomer(db, a.customerId);
  assert.equal(JSON.stringify(detail).includes(a.licenseKey), false);
});

// ── admin authorisation ─────────────────────────────────────────────────────

const ADMIN_TOKEN = 'admin-token-for-tests';

function withAdminToken(value, fn) {
  const previous = process.env.REVENUE_ADMIN_TOKEN;
  if (value === undefined) delete process.env.REVENUE_ADMIN_TOKEN;
  else process.env.REVENUE_ADMIN_TOKEN = value;
  return Promise.resolve(fn()).finally(() => {
    if (previous === undefined) delete process.env.REVENUE_ADMIN_TOKEN;
    else process.env.REVENUE_ADMIN_TOKEN = previous;
  });
}

function adminReq(token) {
  return {
    method: 'GET',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    query: {},
    body: {},
    params: {},
  };
}

const ALL_ADMIN_HANDLERS = [
  ['health', healthHandler],
  ['sync', syncHandler],
  ['reconcile', reconcileHandler],
  ['customer', customerHandler],
  ['entitlement', entitlementHandler],
  ['license', licenseHandler],
  ['evidence', evidenceHandler],
  ['action', actionHandler],
];

test('admin: every handler denies with NO token (401)', async () => {
  const db = makeDb();
  await withAdminToken(ADMIN_TOKEN, async () => {
    for (const [name, factory] of ALL_ADMIN_HANDLERS) {
      const res = makeRes();
      await factory({ db, sync: async () => ({}), reconcile: async () => ({}) })(adminReq(null), res);
      assert.equal(res.statusCode, 401, `${name} must be 401 without a token`);
    }
  });
});

test('admin: every handler denies with a WRONG token (401)', async () => {
  const db = makeDb();
  await withAdminToken(ADMIN_TOKEN, async () => {
    for (const [name, factory] of ALL_ADMIN_HANDLERS) {
      const res = makeRes();
      await factory({ db, sync: async () => ({}), reconcile: async () => ({}) })(
        adminReq('definitely-not-the-token'),
        res,
      );
      assert.equal(res.statusCode, 401, `${name} must be 401 with a wrong token`);
    }
  });
});

test('admin: every handler is ALLOWED with the correct token (200)', async () => {
  const db = makeDb();
  const fx = makeLicensedCustomer(db);
  await withAdminToken(ADMIN_TOKEN, async () => {
    for (const [name, factory] of ALL_ADMIN_HANDLERS) {
      const res = makeRes();
      const req = adminReq(ADMIN_TOKEN);
      if (name === 'customer') req.params = { id: fx.customerId };
      if (name === 'action') {
        req.method = 'POST';
        req.body = { action: 'customer.access.update', taskId: 'task_admin_ok' };
      }
      await factory({
        db,
        sync: async () => ({ synced: 1 }),
        reconcile: async () => ({ report: { checked: 1 }, verdict: { ok: true } }),
      })(req, res);
      assert.equal(res.statusCode, 200, `${name} must be 200 with the correct token`);
      assert.equal(res.body.error, undefined);
    }
  });
});

test('admin: FAIL CLOSED when REVENUE_ADMIN_TOKEN is not configured (401)', async () => {
  const db = makeDb();
  await withAdminToken(undefined, async () => {
    for (const [name, factory] of ALL_ADMIN_HANDLERS) {
      const res = makeRes();
      // Even WITH a token presented, no configured token means no access.
      await factory({ db, sync: async () => ({}), reconcile: async () => ({}) })(
        adminReq(ADMIN_TOKEN),
        res,
      );
      assert.equal(res.statusCode, 401, `${name} must be 401 when the token env var is unset`);
      assert.equal(res.body.error, 'admin.not_configured');
    }
  });
});

test('admin: requireAdmin throws AdminAuthError when not configured', async () => {
  await withAdminToken(undefined, () => {
    assert.throws(() => requireAdmin(adminReq(ADMIN_TOKEN)), (err) => err instanceof AdminAuthError);
  });
});

test('admin: health reports configuration facts, never secret values', async () => {
  const db = makeDb();
  await withAdminToken(ADMIN_TOKEN, async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_should_never_be_echoed';
    try {
      const res = makeRes();
      await healthHandler({ db })(adminReq(ADMIN_TOKEN), res);
      assert.equal(res.body.stripeConfigured, true);
      assert.equal(typeof res.body.priceIdsConfigured, 'number');
      assert.equal(res.body.ok, true);
      assert.ok(typeof res.body.uptime === 'number');
      assert.ok(res.body.database);
      assert.equal(JSON.stringify(res.body).includes('sk_test_should_never_be_echoed'), false);
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
    }
  });
});

// ── money movement refusal ──────────────────────────────────────────────────

test('admin: a money-movement action is refused with the typed error and nothing is performed', async () => {
  const db = makeDb();
  const fx = makeLicensedCustomer(db);

  await withAdminToken(ADMIN_TOKEN, async () => {
    for (const action of ['refund.create', 'charge.create', 'payout.create', 'subscription.cancel']) {
      const res = makeRes();
      const req = adminReq(ADMIN_TOKEN);
      req.method = 'POST';
      req.body = { action, taskId: `task_${action}` };
      await actionHandler({ db })(req, res);

      assert.equal(res.statusCode, 403, `${action} must be refused`);
      assert.equal(res.body.error, 'governed.money_movement_requires_authorisation');
      assert.equal(res.body.performed, false);
    }

    // Nothing was performed: the licence is untouched and no governed run happened.
    const license = db.prepare(`SELECT status FROM licenses WHERE id = ?`).get(fx.licenseId);
    assert.equal(license.status, 'active');

    // The refusal is on the record with `performed: false`.
    const refusals = evidenceRows(db, 'admin.action.refused');
    assert.ok(refusals.length >= 4);
    const last = refusals.at(-1);
    assert.equal(last.payload.code, 'governed.money_movement_requires_authorisation');
    assert.equal(last.payload.performed, false);
  });
});

test('governed: assertNoMoneyMovement throws the typed error for money actions', () => {
  assert.throws(
    () => assertNoMoneyMovement('refund.create'),
    (err) => err instanceof GovernedError && err.code === 'governed.money_movement_requires_authorisation',
  );
  assert.throws(
    () => assertNoMoneyMovement('payout.send'),
    (err) => err.code === 'governed.money_movement_requires_authorisation',
  );
  // A governed, non-money action passes.
  assert.equal(assertNoMoneyMovement('license.issue'), true);
  assert.equal(assertNoMoneyMovement('customer.access.update'), true);
});

test('governed: the modelled action list is the documented allowlist', () => {
  const actions = governedActions();
  assert.deepEqual([...actions].sort(), [
    'customer.access.update',
    'entitlement.activate',
    'entitlement.suspend',
    'fulfillment.execute',
    'license.issue',
    'license.revoke',
  ]);
});

test('governed: isGovernedAvailable returns a boolean without throwing when the package is absent', async () => {
  const before = process.env.GOVERNED_EXECUTION_PATH;
  process.env.GOVERNED_EXECUTION_PATH = path.join(os.tmpdir(), 'definitely-not-here-governed');
  try {
    const { resetGovernedLoadState } = await import('../src/governed.js');
    resetGovernedLoadState();
    const available = isGovernedAvailable();
    assert.equal(typeof available, 'boolean');
    // Exercise the load path too — it must degrade, not throw.
    const state = await loadGoverned();
    assert.equal(state.available, false);
    assert.equal(state.mode, 'contract-only');
    assert.ok(state.reason);
    assert.equal(typeof isGovernedAvailable(), 'boolean');
  } finally {
    if (before === undefined) delete process.env.GOVERNED_EXECUTION_PATH;
    else process.env.GOVERNED_EXECUTION_PATH = before;
  }
});

test('governed: a contract-only action is clearly labelled and recorded with governed:false', async () => {
  const db = makeDb();
  const before = process.env.GOVERNED_EXECUTION_PATH;
  process.env.GOVERNED_EXECUTION_PATH = path.join(os.tmpdir(), 'definitely-not-here-governed');
  try {
    const { runGovernedAction, resetGovernedLoadState } = await import('../src/governed.js');
    resetGovernedLoadState();
    const result = await runGovernedAction('customer.access.update', {
      taskId: 'task_test_1',
      resource: 'customers/cus_1',
      db,
    });
    assert.equal(result.governed, false);
    assert.equal(result.performed, false);
    assert.equal(result.mode, 'contract-only');
    assert.ok(result.reason);

    const rows = evidenceRows(db, 'governed.action.unavailable');
    assert.ok(rows.length >= 1);
    assert.equal(rows.at(-1).payload.governed, false);
    assert.ok(rows.at(-1).payload.reason);
  } finally {
    if (before === undefined) delete process.env.GOVERNED_EXECUTION_PATH;
    else process.env.GOVERNED_EXECUTION_PATH = before;
  }
});

test('governed: an action outside the allowlist is refused', async () => {
  const { runGovernedAction } = await import('../src/governed.js');
  await assert.rejects(
    () => runGovernedAction('customer.delete', { taskId: 't', resource: 'r' }),
    (err) => err instanceof GovernedError && err.code === 'governed.action_not_allowed',
  );
});

test('admin: the license handler can revoke a licence and the revocation is recorded', async () => {
  const db = makeDb();
  const fx = makeLicensedCustomer(db);
  await withAdminToken(ADMIN_TOKEN, async () => {
    const res = makeRes();
    const req = adminReq(ADMIN_TOKEN);
    req.method = 'POST';
    req.body = { licenseId: fx.licenseId, action: 'revoke', reason: 'operator revoked' };
    await licenseHandler({ db })(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.license.status, 'revoked');
    assert.equal(JSON.stringify(res.body).includes(fx.licenseKey), false);

    // The session that was issued before the revocation now fails.
    setLicenseStatus(db, fx.licenseId, 'active');
    const { sessionToken } = await login(db, {
      email: fx.email,
      licenseKey: fx.licenseKey,
      sessionSecret: SESSION_SECRET,
    });
    await authenticate(db, { authorizationHeader: `Bearer ${sessionToken}`, sessionSecret: SESSION_SECRET });
    setLicenseStatus(db, fx.licenseId, 'revoked');
    await assert.rejects(
      () => authenticate(db, { authorizationHeader: `Bearer ${sessionToken}`, sessionSecret: SESSION_SECRET }),
      (err) => err.code === 'access.license_not_usable',
    );
  });
});

test('admin: the evidence handler lists evidence records', async () => {
  const db = makeDb();
  await withAdminToken(ADMIN_TOKEN, async () => {
    await login(db, { email: 'x@example.test', licenseKey: 'nope', sessionSecret: SESSION_SECRET }).catch(() => {});
    const res = makeRes();
    await evidenceHandler({ db })(adminReq(ADMIN_TOKEN), res);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.count >= 1);
    assert.ok(res.body.evidence.every((e) => typeof e.kind === 'string'));
  });
});

test('admin: the evidence handler never exposes a secret value', async () => {
  const db = makeDb();
  const fx = makeLicensedCustomer(db);
  await withAdminToken(ADMIN_TOKEN, async () => {
    await login(db, { email: fx.email, licenseKey: fx.licenseKey, sessionSecret: SESSION_SECRET });
    const res = makeRes();
    await evidenceHandler({ db })(adminReq(ADMIN_TOKEN), res);
    const serialised = JSON.stringify(res.body);
    assert.equal(serialised.includes(fx.licenseKey), false);
    assert.equal(serialised.includes(SESSION_SECRET), false);
  });
});

test('governed: with the real frozen package present, the adapter loads and reports its mode', async () => {
  const { loadGoverned: load, resetGovernedLoadState: reset, runGovernedAction: run } =
    await import('../src/governed.js');
  reset();
  const state = await load();
  assert.equal(typeof state.available, 'boolean');
  assert.ok(['runtime', 'contract-only'].includes(state.mode));
  if (state.available) {
    assert.ok(state.entry, 'the loaded entry is reported');
    assert.ok(state.source, 'the entry source is reported');
  } else {
    assert.ok(state.reason, 'a reason is reported when unavailable');
  }

  // Whatever the mode, a governed action returns a labelled result and never
  // pretends to have been governed when it was not.
  const result = await run('customer.access.update', {
    taskId: 'task_mode_probe',
    resource: 'customers/probe',
  });
  assert.equal(typeof result.governed, 'boolean');
  assert.ok(['runtime', 'contract-only'].includes(result.mode));
  if (!result.governed) assert.ok(result.reason || result.refusal);
});

// ── REGRESSION: money movement must be blocked (defect found by independent
//    acceptance probe) ───────────────────────────────────────────────────────
// The pattern list originally omitted `subscription.create`, so a LIVE
// subscription creation - which the operator explicitly gates - was NOT
// refused. The independent probe caught it; this test locks the fix.
test("every money-movement action is refused, including subscription.create", () => {
  const actions = [
    "stripe.refund.create",
    "stripe.charge.create",
    "stripe.payout.create",
    "stripe.transfer.create",
    "stripe.payment.create",
    "stripe.subscription.create",
    "stripe.subscription.cancel",
    "stripe.subscription.update",
    "stripe.subscription.delete",
    "stripe.invoice.create",
    "stripe.invoice.send",
    "stripe.invoice.pay",
    "stripe.invoice.finalize",
    "stripe.invoice.void",
    "stripe.price.update",
    "stripe.price.set",
    "stripe.product.create",
    "stripe.product.update",
    "stripe.checkout.session.create",
  ];
  for (const action of actions) {
    assert.throws(
      () => assertNoMoneyMovement(action),
      (err) => err.code === "governed.money_movement_requires_authorisation",
      `expected "${action}" to be refused as money movement`,
    );
  }
});

test("a routine non-money action is NOT refused", () => {
  assert.equal(assertNoMoneyMovement("license.issue"), true);
  assert.equal(assertNoMoneyMovement("entitlement.activate"), true);
  assert.equal(assertNoMoneyMovement("fulfillment.execute"), true);
  assert.equal(assertNoMoneyMovement("customer.access.update"), true);
});