// ─────────────────────────────────────────────────────────────────────────────
// Aurora Revenue Engine — COMMERCIAL FULFILLMENT LIFECYCLE tests
//
//   PAYMENT -> ENTITLEMENT -> LICENSE -> DELIVERY
//
// These tests NEVER touch data/licenses.db (a disposable temp database is
// used), NEVER call Stripe, NEVER send a real email (the capture transport is
// the default everywhere) and never construct the resend transport.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.js';
import { normalizeEvent, VERIFICATION } from '../src/events.js';
import {
  activateEntitlement,
  ensureCustomer,
  suspendEntitlement,
  revokeEntitlement,
  expireEntitlement,
  getEntitlementForCustomerProduct,
  listEntitlements,
  isEntitlementActive,
  EntitlementError,
  CustomerError,
} from '../src/entitlements.js';
import {
  issueLicense,
  verifyLicense,
  revokeLicense,
  suspendLicense,
  expireLicense,
  reactivateLicense,
  listLicenses,
  getLicense,
  LicenseError,
} from '../src/licenses.js';
import {
  createCaptureTransport,
  createResendTransport,
  deliver,
  countSuccessfulDeliveries,
  DeliveryError,
} from '../src/delivery.js';
import { fulfillEvent, fulfillmentKeyFor, getRunByKey } from '../src/fulfillment.js';

// ── fixtures ────────────────────────────────────────────────────────────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 're-fulfillment-'));

// Fake, non-secret price configuration for the catalog's env-var references.
process.env.PRICE_SKILL_PACK_LITE = 'price_test_skill_pack_lite';
process.env.PRICE_SKILL_PACK_STD = 'price_test_skill_pack_std';
process.env.PRICE_LEGACY_PACK = 'price_test_legacy_pack';

let dbCounter = 0;
function freshDb() {
  dbCounter += 1;
  return openDb(path.join(TMP, `db-${dbCounter}.db`));
}

function makeEvent(overrides = {}) {
  return normalizeEvent({
    provider: 'stripe',
    provider_event_id: 'evt_test_001',
    event_type: 'checkout.session.completed',
    customer_email: 'buyer@example.test',
    provider_customer_id: 'cus_test_001',
    product_id: 'skill_pack_lite',
    price_reference: 'PRICE_SKILL_PACK_LITE',
    payment_reference: 'pi_test_001',
    amount: 4900,
    currency: 'usd',
    verification_status: VERIFICATION.VERIFIED,
    source_mode: 'webhook',
    payload_json: { id: 'evt_test_001' },
    ...overrides,
  });
}

function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function writeTempCatalog(products) {
  const file = path.join(TMP, `catalog-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ version: 1, currency: 'usd', products }), 'utf8');
  return file;
}

const LITE_PRODUCT = {
  product_id: 'skill_pack_lite',
  product_name: 'Skill Pack Lite',
  product_type: 'one_time',
  entitlement_type: 'skill_pack',
  license_policy: 'perpetual',
  fulfillment_type: 'license_email',
  delivery_artifact: 'license_key',
  renewal_policy: 'none',
  expiration_policy: 'never',
  price_reference: 'PRICE_SKILL_PACK_LITE',
  status: 'active',
};
// ── the happy path ──────────────────────────────────────────────────────────

test('a verified event produces exactly one entitlement, one licence and one captured delivery', async () => {
  const db = freshDb();
  const transport = createCaptureTransport();
  const event = makeEvent();

  const result = await fulfillEvent(db, { event, transport });

  assert.equal(result.status, 'completed');
  assert.ok(result.entitlement, 'entitlement created');
  assert.ok(result.license, 'licence created');
  assert.ok(result.delivery, 'delivery created');
  assert.equal(result.fulfillment_run.stage, 'complete');
  assert.equal(result.fulfillment_run.status, 'completed');

  assert.equal(count(db, 'entitlements'), 1);
  assert.equal(count(db, 'licenses'), 1);
  assert.equal(count(db, 'deliveries'), 1);
  assert.equal(result.delivery.status, 'captured');

  // The capture transport recorded the message; nothing was sent.
  assert.equal(transport.messages.length, 1);
  assert.equal(transport.messages[0].message.to, 'buyer@example.test');
  assert.equal(transport.messages[0].message.licenseKey, result.license.license_key);

  // The licence carries entitlement, event and timestamps.
  assert.equal(result.license.entitlement_id, result.entitlement.id);
  assert.equal(result.license.event_id, event.event_id);
  assert.ok(result.license.issued_at);
  assert.ok(result.license.expires_at === null || typeof result.license.expires_at === 'string');
  assert.match(result.license.license_key, /^CCPI-[A-Z0-9]+-[0-9A-F-]{36}-[0-9A-F]{8}$/);

  // Every stage left evidence.
  const kinds = db
    .prepare(`SELECT kind FROM evidence WHERE subject_id = ?`)
    .all(result.fulfillment_run.id)
    .map((r) => r.kind);
  for (const stage of ['started', 'entitlement', 'license', 'delivery', 'complete']) {
    assert.ok(kinds.includes(`fulfillment.stage.${stage}`), `evidence for ${stage}`);
  }
});

test('the SAME verified event processed twice creates nothing new', async () => {
  const db = freshDb();
  const transport = createCaptureTransport();
  const event = makeEvent();

  const first = await fulfillEvent(db, { event, transport });
  assert.equal(first.status, 'completed');

  const before = {
    entitlements: count(db, 'entitlements'),
    licenses: count(db, 'licenses'),
    deliveries: count(db, 'deliveries'),
    runs: count(db, 'fulfillment_runs'),
  };
  assert.deepEqual(before, { entitlements: 1, licenses: 1, deliveries: 1, runs: 1 });

  const second = await fulfillEvent(db, { event, transport });

  const after = {
    entitlements: count(db, 'entitlements'),
    licenses: count(db, 'licenses'),
    deliveries: count(db, 'deliveries'),
    runs: count(db, 'fulfillment_runs'),
  };
  assert.deepEqual(after, before, 'row counts are identical after the second run');
  assert.equal(second.status, 'already_fulfilled');
  assert.equal(second.entitlement.id, first.entitlement.id);
  assert.equal(second.license.id, first.license.id);
  assert.equal(transport.messages.length, 1, 'only one message was ever handed to the transport');
});

// ── refusals ────────────────────────────────────────────────────────────────

test('an UNVERIFIED event is refused and creates nothing', async () => {
  const db = freshDb();
  const transport = createCaptureTransport();
  const event = makeEvent({ verification_status: VERIFICATION.UNVERIFIED });

  const result = await fulfillEvent(db, { event, transport });

  assert.equal(result.status, 'refused');
  assert.equal(result.code, 'fulfillment.event_not_verified');
  assert.equal(result.entitlement, null);
  assert.equal(result.license, null);
  assert.equal(count(db, 'entitlements'), 0);
  assert.equal(count(db, 'licenses'), 0);
  assert.equal(count(db, 'deliveries'), 0);
  assert.equal(transport.messages.length, 0);
  assert.equal(result.fulfillment_run.stage, 'refused');
});

test('an unknown price / unknown product is refused and creates nothing', async () => {
  const db = freshDb();
  const transport = createCaptureTransport();

  const unknownProduct = await fulfillEvent(db, {
    event: makeEvent({ product_id: 'no_such_product' }),
    transport,
  });
  assert.equal(unknownProduct.status, 'refused');
  assert.equal(unknownProduct.code, 'fulfillment.unknown_product');

  const unknownPrice = await fulfillEvent(db, {
    event: makeEvent({
      product_id: null,
      price_reference: 'PRICE_DOES_NOT_EXIST',
      provider_event_id: 'evt_test_price_unknown',
    }),
    transport,
  });
  assert.equal(unknownPrice.status, 'refused');
  assert.equal(unknownPrice.code, 'fulfillment.unknown_product');

  assert.equal(count(db, 'entitlements'), 0);
  assert.equal(count(db, 'licenses'), 0);
  assert.equal(count(db, 'deliveries'), 0);
  assert.equal(transport.messages.length, 0);
});

test('a DISABLED product is refused and creates nothing', async () => {
  const db = freshDb();
  const transport = createCaptureTransport();

  const catalogFile = writeTempCatalog([
    {
      product_id: 'legacy_pack',
      product_name: 'Legacy Pack',
      product_type: 'one_time',
      price_reference: 'PRICE_LEGACY_PACK',
      entitlement_type: 'skill_pack',
      license_policy: 'perpetual',
      fulfillment_type: 'license_email',
      delivery_artifact: 'license_key',
      renewal_policy: 'none',
      expiration_policy: 'never',
      status: 'disabled',
    },
  ]);

  const result = await fulfillEvent(db, {
    event: makeEvent({ product_id: 'legacy_pack', provider_event_id: 'evt_test_disabled' }),
    transport,
    catalogOptions: { filePath: catalogFile, env: { PRICE_LEGACY_PACK: 'price_test_legacy_pack' } },
  });

  assert.equal(result.status, 'refused');
  assert.equal(result.code, 'catalog.product_disabled');
  assert.equal(count(db, 'entitlements'), 0);
  assert.equal(count(db, 'licenses'), 0);
  assert.equal(count(db, 'deliveries'), 0);
  assert.equal(transport.messages.length, 0);
});

// ── licence lifecycle ───────────────────────────────────────────────────────

async function issueOne(db, overrides = {}) {
  const transport = createCaptureTransport();
  const event = makeEvent(overrides);
  const result = await fulfillEvent(db, { event, transport });
  return { result, transport, event };
}

test('licence lifecycle: issued -> active -> suspended -> expired -> revoked', async () => {
  const db = freshDb();
  const { result } = await issueOne(db);
  const licenseId = result.license.id;
  const key = result.license.license_key;

  assert.equal(result.license.status, 'active', 'the licence becomes active once delivered');
  assert.ok(verifyLicense(db, key), 'an active licence verifies');

  suspendLicense(db, licenseId, 'chargeback');
  assert.equal(getLicense(db, licenseId).status, 'suspended');
  assert.equal(verifyLicense(db, key), null, 'a suspended licence is NOT usable');

  reactivateLicense(db, licenseId);
  assert.equal(getLicense(db, licenseId).status, 'active');
  assert.ok(verifyLicense(db, key));

  expireLicense(db, licenseId);
  assert.equal(getLicense(db, licenseId).status, 'expired');
  assert.equal(verifyLicense(db, key), null, 'an expired licence is NOT usable');

  revokeLicense(db, licenseId, 'refunded');
  assert.equal(getLicense(db, licenseId).status, 'revoked');
  assert.equal(verifyLicense(db, key), null, 'a revoked licence is NOT usable');
});

test('a licence whose entitlement is suspended or revoked is NOT usable', async () => {
  const db = freshDb();
  const { result } = await issueOne(db);
  const key = result.license.license_key;

  suspendEntitlement(db, result.entitlement.id, 'payment dispute');
  assert.equal(verifyLicense(db, key), null, 'the licence follows its entitlement');

  // A licence must never be more permissive than its entitlement.
  assert.throws(
    () => reactivateLicense(db, result.license.id),
    (err) => err instanceof LicenseError && err.code === 'license.entitlement_not_active',
  );
  assert.equal(verifyLicense(db, key), null, 'a licence cannot outlive a suspended entitlement');

  revokeEntitlement(db, result.entitlement.id, 'fraud');
  assert.equal(verifyLicense(db, key), null);
});

test('a licence issued to customer A is not usable by customer B', async () => {
  const db = freshDb();
  const { result } = await issueOne(db);
  const key = result.license.license_key;
  const customerA = result.entitlement.customer_id;

  const customerB = ensureCustomer(db, {
    email: 'other@example.test',
    provider: 'stripe',
    providerCustomerId: 'cus_test_002',
  });
  assert.notEqual(customerA, customerB.id);

  assert.ok(verifyLicense(db, key, { customerId: customerA }));
  assert.equal(verifyLicense(db, key, { customerId: customerB.id }), null, 'cross-customer use must fail');
  assert.equal(listLicenses(db, customerB.id).length, 0, 'customer B owns no licences');
  assert.equal(listLicenses(db, customerA).length, 1);
});

test('a licence for product X does not grant product Y', async () => {
  const db = freshDb();
  const { result } = await issueOne(db);
  const key = result.license.license_key;

  assert.ok(verifyLicense(db, key, { productId: 'skill_pack_lite' }));
  assert.equal(
    verifyLicense(db, key, { productId: 'skill_pack_std' }),
    null,
    'the licence does not grant another product',
  );
});

test('issuing a licence twice for the same entitlement returns the SAME licence', () => {
  const db = freshDb();
  const event = makeEvent();
  const customer = ensureCustomer(db, {
    email: 'buyer@example.test',
    provider: 'stripe',
    providerCustomerId: 'cus_test_001',
  });
  const entitlement = activateEntitlement(db, { event, product: LITE_PRODUCT, customer });

  const first = issueLicense(db, { entitlement, customer, product: LITE_PRODUCT, event });
  const second = issueLicense(db, { entitlement, customer, product: LITE_PRODUCT, event });

  assert.equal(first.id, second.id);
  assert.equal(first.license_key, second.license_key);
  assert.equal(count(db, 'licenses'), 1, 'only one licence row exists');

  const ledger = db.prepare(`SELECT scope FROM idempotency_keys WHERE key = ?`).get(entitlement.id);
  assert.equal(ledger.scope, 'license.issue');
});

test('a customer holds ONE entitlement per product — re-activation UPDATES', () => {
  const db = freshDb();
  const customer = ensureCustomer(db, {
    email: 'buyer@example.test',
    provider: 'stripe',
    providerCustomerId: 'cus_test_001',
  });
  const event1 = makeEvent({ provider_event_id: 'evt_a' });
  const event2 = makeEvent({ provider_event_id: 'evt_b' });

  const first = activateEntitlement(db, { event: event1, product: LITE_PRODUCT, customer });
  const second = activateEntitlement(db, { event: event2, product: LITE_PRODUCT, customer });

  assert.equal(first.id, second.id, 'the same entitlement row is reused');
  assert.equal(count(db, 'entitlements'), 1);
  assert.equal(getEntitlementForCustomerProduct(db, customer.id, 'skill_pack_lite').id, first.id);
  assert.equal(listEntitlements(db, customer.id).length, 1);
});

test('entitlement status transitions and expiry are honoured', () => {
  const db = freshDb();
  const customer = ensureCustomer(db, {
    email: 'buyer@example.test',
    provider: 'stripe',
    providerCustomerId: 'cus_test_001',
  });
  const entitlement = activateEntitlement(db, { event: makeEvent(), product: LITE_PRODUCT, customer });

  assert.equal(isEntitlementActive(entitlement), true);
  suspendEntitlement(db, entitlement.id, 'manual');
  assert.equal(isEntitlementActive(getEntitlementForCustomerProduct(db, customer.id, 'skill_pack_lite')), false);
  expireEntitlement(db, entitlement.id);
  assert.equal(isEntitlementActive(getEntitlementForCustomerProduct(db, customer.id, 'skill_pack_lite')), false);
  revokeEntitlement(db, entitlement.id, 'fraud');
  const revoked = getEntitlementForCustomerProduct(db, customer.id, 'skill_pack_lite');
  assert.equal(revoked.status, 'revoked');
  assert.equal(isEntitlementActive(revoked), false);
});

test('an unverified event cannot activate an entitlement', () => {
  const db = freshDb();
  const customer = ensureCustomer(db, {
    email: 'buyer@example.test',
    provider: 'stripe',
    providerCustomerId: 'cus_test_001',
  });
  const event = makeEvent({ verification_status: VERIFICATION.UNVERIFIED });

  assert.throws(
    () => activateEntitlement(db, { event, product: LITE_PRODUCT, customer }),
    (err) => err instanceof EntitlementError && err.code === 'entitlement.event_not_verified',
  );
  assert.equal(count(db, 'entitlements'), 0);
});

test('customer identity refuses to merge two provider customers sharing an email', () => {
  const db = freshDb();
  const a = ensureCustomer(db, { email: 'same@example.test', provider: 'stripe', providerCustomerId: 'cus_A' });
  const again = ensureCustomer(db, { email: 'same@example.test', provider: 'stripe', providerCustomerId: 'cus_A' });
  assert.equal(a.id, again.id, 'the same provider id is idempotent');

  assert.throws(
    () => ensureCustomer(db, { email: 'same@example.test', provider: 'stripe', providerCustomerId: 'cus_B' }),
    (err) => err instanceof CustomerError && err.code === 'customer.provider_id_conflicts_with_email',
  );
});

// ── delivery failure and retry ──────────────────────────────────────────────

test('a delivery failure is recorded as failed and a retry yields exactly ONE successful delivery', async () => {
  const db = freshDb();
  const event = makeEvent();

  const failing = {
    name: 'failing',
    async send() {
      throw new Error('smtp unavailable');
    },
  };

  const first = await fulfillEvent(db, { event, transport: failing });
  assert.equal(first.status, 'failed');
  assert.equal(first.delivery.status, 'failed');
  assert.match(first.delivery.error, /smtp unavailable/);
  assert.ok(first.license, 'the licence survives a delivery failure');
  assert.equal(first.fulfillment_run.stage, 'license', 'the run is left retryable at the licence stage');

  // The licence was issued but not delivered -> it is not yet 'active'.
  assert.equal(getLicense(db, first.license.id).status, 'issued');
  assert.equal(count(db, 'licenses'), 1);
  assert.equal(count(db, 'entitlements'), 1);

  // Retry with a working (capture) transport.
  const transport = createCaptureTransport();
  const second = await fulfillEvent(db, { event, transport });

  assert.equal(second.status, 'completed');
  assert.equal(second.license.id, first.license.id, 'the SAME licence is reused on retry');
  assert.equal(second.entitlement.id, first.entitlement.id, 'the SAME entitlement is reused on retry');
  assert.equal(countSuccessfulDeliveries(db, first.entitlement.id), 1, 'exactly one successful delivery');
  assert.equal(count(db, 'licenses'), 1, 'no second licence');
  assert.equal(count(db, 'entitlements'), 1, 'no second entitlement');
  assert.equal(transport.messages.length, 1, 'the message was sent exactly once');
});

test('deliver() itself is idempotent for the same entitlement and channel', async () => {
  const db = freshDb();
  const transport = createCaptureTransport();
  const event = makeEvent();
  const customer = ensureCustomer(db, {
    email: 'buyer@example.test',
    provider: 'stripe',
    providerCustomerId: 'cus_test_001',
  });
  const entitlement = activateEntitlement(db, { event, product: LITE_PRODUCT, customer });
  const license = issueLicense(db, { entitlement, customer, product: LITE_PRODUCT, event });

  const a = await deliver(db, { entitlement, license, customer, transport });
  const b = await deliver(db, { entitlement, license, customer, transport });

  assert.equal(a.id, b.id);
  assert.equal(count(db, 'deliveries'), 1);
  assert.equal(transport.messages.length, 1);
});

// ── restart safety ──────────────────────────────────────────────────────────

test('restart safety: a run left at the licence stage resumes and completes with ONE licence and ONE delivery', async () => {
  const db = freshDb();
  const event = makeEvent();
  const transport = createCaptureTransport();

  // First pass: create the entitlement and licence, then die before delivery.
  const failing = {
    name: 'failing',
    async send() {
      throw new Error('process died before delivery');
    },
  };
  const first = await fulfillEvent(db, { event, transport: failing });
  assert.equal(first.status, 'failed');
  assert.equal(count(db, 'licenses'), 1);
  assert.equal(count(db, 'deliveries'), 1);
  assert.equal(countSuccessfulDeliveries(db, first.entitlement.id), 0);

  // Simulate the restart: the run row is left at stage 'license'.
  db.prepare(`UPDATE fulfillment_runs SET stage = 'license', status = 'failed' WHERE id = ?`).run(
    first.fulfillment_run.id,
  );
  const staged = getRunByKey(db, fulfillmentKeyFor(event));
  assert.equal(staged.stage, 'license');

  // Resume.
  const second = await fulfillEvent(db, { event, transport });

  assert.equal(second.status, 'completed');
  assert.equal(second.fulfillment_run.stage, 'complete');
  assert.equal(count(db, 'entitlements'), 1, 'still exactly one entitlement');
  assert.equal(count(db, 'licenses'), 1, 'still exactly ONE licence');
  assert.equal(countSuccessfulDeliveries(db, second.entitlement.id), 1, 'exactly ONE successful delivery');
  assert.equal(second.license.id, first.license.id);
  assert.equal(second.entitlement.id, first.entitlement.id);
});

test('restart safety: a run row inserted at stage license resumes without duplicating anything', async () => {
  const db = freshDb();
  const event = makeEvent();
  const transport = createCaptureTransport();

  // Build the entitlement and licence exactly as the pipeline would.
  const result = await fulfillEvent(db, { event, transport });
  assert.equal(result.status, 'completed');

  // Wipe the run row back to the licence stage and delete the delivery, as if
  // the process had died right after issuing the licence.
  db.prepare(`DELETE FROM deliveries`).run();
  db.prepare(`DELETE FROM fulfillment_runs WHERE id = ?`).run(result.fulfillment_run.id);
  db.prepare(
    `INSERT INTO fulfillment_runs (id, idempotency_key, event_id, customer_id, entitlement_id, license_id, stage, status, attempts, last_error, created_at, updated_at)
     VALUES ('ful_restart_demo', ?, ?, ?, ?, ?, 'license', 'failed', 1, 'interrupted', datetime('now'), datetime('now'))`,
  ).run(
    fulfillmentKeyFor(event),
    event.event_id,
    result.entitlement.customer_id,
    result.entitlement.id,
    result.license.id,
  );

  const resumed = await fulfillEvent(db, { event, transport });

  assert.equal(resumed.status, 'completed');
  assert.equal(count(db, 'entitlements'), 1);
  assert.equal(count(db, 'licenses'), 1);
  assert.equal(countSuccessfulDeliveries(db, result.entitlement.id), 1);
  assert.equal(resumed.license.id, result.license.id, 'the existing licence is reused');
});

// ── idempotency keys ────────────────────────────────────────────────────────

test('idempotency keys are stable across calls and derived only from provider event identity', async () => {
  const db = freshDb();
  const event = makeEvent();

  const k1 = fulfillmentKeyFor(event);
  const k2 = fulfillmentKeyFor(makeEvent());
  const k3 = fulfillmentKeyFor(makeEvent({ amount: 999, payload_json: { different: true } }));

  assert.equal(k1, k2, 'the same provider event always maps to the same key');
  assert.equal(k1, k3, 'the key does not depend on the payload body');
  assert.match(k1, /^ful_[0-9a-f]{64}$/);
  assert.notEqual(k1, fulfillmentKeyFor(makeEvent({ provider_event_id: 'evt_other' })));

  // The run row is keyed by that same value.
  await fulfillEvent(db, { event, transport: createCaptureTransport() });
  const run = getRunByKey(db, k1);
  assert.ok(run, 'the run row is stored under the stable key');
  assert.equal(run.idempotency_key, k1);

  // The ledger agrees.
  const ledger = db.prepare(`SELECT scope FROM idempotency_keys WHERE key = ?`).get(k1);
  assert.equal(ledger.scope, 'fulfillment.run');
});

// ── no real email, no network ───────────────────────────────────────────────

test('the capture transport recorded the message and the resend transport was never constructed', async () => {
  const db = freshDb();
  const transport = createCaptureTransport();
  await fulfillEvent(db, { event: makeEvent(), transport });

  assert.equal(transport.name, 'capture');
  assert.equal(transport.messages.length, 1);
  assert.equal(transport.messages[0].message.to, 'buyer@example.test');

  // A resend transport CANNOT be constructed without a key.
  assert.throws(
    () => createResendTransport('', 'noreply@example.test'),
    (err) => err instanceof DeliveryError && err.code === 'delivery.transport_api_key_missing',
  );
  assert.throws(
    () => createResendTransport(undefined, undefined),
    (err) => err instanceof DeliveryError,
  );
});

test('no secret value is written to the database', async () => {
  const db = freshDb();
  const transport = createCaptureTransport();
  await fulfillEvent(db, { event: makeEvent(), transport });

  const rows = db.prepare(`SELECT * FROM licenses`).all();
  for (const row of rows) {
    const text = JSON.stringify(row);
    assert.ok(
      !/sk_live|sk_test|re_[A-Za-z0-9]{20,}|whsec_/i.test(text),
      'no secret-shaped value in the licence row',
    );
  }
});


// ── REGRESSION: the demonstration must be REPEATABLE ───────────────────────
// Defect found by the lead: the demo reused its own scratch database, so a
// second run inherited the first run's events, licences and reconciliation
// findings and the demo then reported FAIL. The demo now resets its own
// database, so running it twice gives the identical result.
test("the demonstration is repeatable: two runs give the identical result", async () => {
  const { runDemo } = await import("../src/demo.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-demo-repeat-"));
  try {
    const first = await runDemo({ outDir: dir, json: true });
    const second = await runDemo({ outDir: dir, json: true });
    assert.equal(first.result.DEMO_RESULT, "PASS");
    assert.equal(second.result.DEMO_RESULT, "PASS");
    assert.equal(first.result.RECONCILIATION_VERDICT, second.result.RECONCILIATION_VERDICT);
    assert.equal(first.result.EVIDENCE_BUNDLES, second.result.EVIDENCE_BUNDLES);
    assert.equal(first.result.COUNTS.licenses, second.result.COUNTS.licenses);
    assert.equal(second.result.COUNTS.licenses, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});