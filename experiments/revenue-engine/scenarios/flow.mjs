/**
 * Aurora Revenue Engine — EXPERIMENT SCENARIOS (commercial flow lane).
 *
 * Scenarios 1-20 of the required set. Every scenario owns a disposable
 * database, drives the PRODUCT modules directly (never the demo module), and
 * reports its own outcome — including the ones that fail.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeCheckoutSession } from '../../../src/stripe-boundary.js';
import { persistEvent, normalizeEvent, VERIFICATION, PROCESSING } from '../../../src/events.js';
import { ingestWebhookEvent } from '../../../src/webhook.js';
import { fulfillEvent, fulfillmentKeyFor } from '../../../src/fulfillment.js';
import { createCaptureTransport } from '../../../src/delivery.js';
import { issueLicense, verifyLicense, revokeLicense, expireLicense } from '../../../src/licenses.js';
import { ensureCustomer } from '../../../src/entitlements.js';
import { getProduct } from '../../../src/catalog.js';
import { login, authenticate } from '../../../src/access.js';
import { sha256 } from '../../../src/db.js';
import { freshDb, counts, paidSession, check, SYNTHETIC, ENV_NAMES } from '../lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const WEBHOOK_SECRET = 'whsec_synthetic_experiment_not_real';
const SESSION_SECRET = 'synthetic-experiment-session-secret-not-real';

/** Offline Stripe-style signature (t=<ts>,v1=<hmac>). No network, no SDK. */
export function signStripe(body, secret = WEBHOOK_SECRET) {
  const ts = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', secret).update(`${ts}.${body}`, 'utf8').digest('hex');
  return `t=${ts},v1=${v1}`;
}

/** Normalise + persist + fulfil ONE genuinely paid synthetic session. */
export async function purchase(db, { id, email, priceId = SYNTHETIC.priceLite, transport, channel = 'email' }) {
  const session = paidSession(id, email, priceId);
  const event = normalizeCheckoutSession(session, { sourceMode: 'synthetic' });
  const persisted = persistEvent(db, event);
  const result = await fulfillEvent(db, { event: persisted.event, transport, channel });
  return { session, event: persisted.event, persisted, result };
}

const E = { presented: 0, verified: 0, rejected: 0, duplicates: 0 };

export const flowScenarios = [
  {
    id: 'verified_purchase',
    title: 'a genuinely paid synthetic session yields entitlement + licence + captured delivery',
    expected_outcome: 'completed: one entitlement, one licence, one captured delivery',
    async run() {
      const { db } = freshDb('s01');
      const transport = createCaptureTransport();
      const { event, result } = await purchase(db, { id: 's01', email: SYNTHETIC.emailA, transport });
      return {
        db,
        actual_outcome: `status=${result.status} delivery=${result.delivery?.status ?? 'none'}`,
        detail: {
          event_id: event.event_id,
          verification_status: event.verification_status,
          product_id: result.entitlement?.product_id ?? null,
          license_status: result.license?.status ?? null,
          captured_messages: transport.messages.length,
        },
        checks: [
          check('event verified', event.verification_status === VERIFICATION.VERIFIED, 'verified', event.verification_status),
          check('fulfilment completed', result.status === 'completed', 'completed', result.status),
          check('entitlement created', Boolean(result.entitlement?.id), 'an entitlement', result.entitlement?.id ?? null),
          check('licence issued', Boolean(result.license?.license_key), 'a licence key', result.license ? 'issued' : null),
          check('delivery captured', result.delivery?.status === 'captured', 'captured', result.delivery?.status ?? null),
          check('exactly one captured message', transport.messages.length === 1, 1, transport.messages.length),
        ],
        expectations: { entitlements: 1, licenses: 1, deliveries: 1 },
        events: { ...E, presented: 1, verified: 1 },
        fulfilment: { attempted: 1, completed: 1, failed: 0 },
        flags: {},
      };
    },
  },

  {
    id: 'duplicate_event',
    title: 'the SAME provider event delivered twice produces exactly one effect',
    expected_outcome: 'second delivery is a duplicate: one licence, one entitlement, one delivery',
    async run() {
      const { db } = freshDb('s02');
      const transport = createCaptureTransport();
      const session = paidSession('s02', SYNTHETIC.emailA, SYNTHETIC.priceLite);
      const event = normalizeCheckoutSession(session, { sourceMode: 'synthetic' });
      const first = persistEvent(db, event);
      const second = persistEvent(db, event);
      const r1 = await fulfillEvent(db, { event: first.event, transport });
      const afterFirst = counts(db);
      const r2 = await fulfillEvent(db, { event: first.event, transport });
      const afterSecond = counts(db);
      const duplicateEffects = afterSecond.licenses - afterFirst.licenses;
      return {
        db,
        actual_outcome: `first=${r1.status} second=${r2.status} duplicate_effects=${duplicateEffects}`,
        detail: {
          duplicate_detected: second.duplicate === true,
          revenue_event_rows: afterSecond.revenue_events,
          licenses_after_first: afterFirst.licenses,
          licenses_after_second: afterSecond.licenses,
          duplicate_effects: duplicateEffects,
        },
        checks: [
          check('first persist is not a duplicate', first.duplicate === false, false, first.duplicate),
          check('second persist is a duplicate', second.duplicate === true, true, second.duplicate),
          check('second fulfilment is a no-op', r2.status === 'already_fulfilled', 'already_fulfilled', r2.status),
          check('one revenue event row', afterSecond.revenue_events === 1, 1, afterSecond.revenue_events),
          check('no duplicate licence', duplicateEffects === 0, 0, duplicateEffects),
        ],
        expectations: { entitlements: 1, licenses: 1, deliveries: 1 },
        events: { ...E, presented: 2, verified: 1, duplicates: 1 },
        fulfilment: { attempted: 2, completed: 2, failed: 0 },
        flags: { duplicate_effects: duplicateEffects },
      };
    },
  },

  {
    id: 'duplicate_webhook',
    title: 'the same event through the webhook intake path twice produces one effect',
    expected_outcome: 'second webhook delivery is a duplicate: one event row, no second effect',
    async run() {
      const { db } = freshDb('s03');
      const body = JSON.stringify({
        id: 'evt_synthetic_dup_1',
        type: 'checkout.session.completed',
        data: { object: paidSession('s03', SYNTHETIC.emailA, SYNTHETIC.priceLite) },
      });
      const signature = signStripe(body);
      const first = ingestWebhookEvent(db, { rawBody: body, signature, secret: WEBHOOK_SECRET });
      const second = ingestWebhookEvent(db, { rawBody: body, signature, secret: WEBHOOK_SECRET });
      const c = counts(db);
      return {
        db,
        actual_outcome: `first=${first.outcome} second=${second.outcome}`,
        detail: {
          first_verified: first.verified,
          second_duplicate: second.duplicate,
          revenue_event_rows: c.revenue_events,
        },
        checks: [
          check('first webhook accepted', first.outcome === 'accepted', 'accepted', first.outcome),
          check('first webhook verified', first.verified === true, true, first.verified),
          check('second webhook is a duplicate', second.outcome === 'duplicate', 'duplicate', second.outcome),
          check('exactly one event row', c.revenue_events === 1, 1, c.revenue_events),
        ],
        expectations: { entitlements: 0, licenses: 0, deliveries: 0 },
        events: { ...E, presented: 2, verified: 1, duplicates: 1 },
        fulfilment: { attempted: 0, completed: 0, failed: 0 },
        flags: { duplicate_effects: 0 },
      };
    },
  },

  {
    id: 'unpaid_session',
    title: 'a session whose payment_status is not "paid" is refused',
    expected_outcome: 'refused: no entitlement, no licence, no delivery',
    async run() {
      const { db } = freshDb('s04');
      const transport = createCaptureTransport();
      const session = paidSession('s04', SYNTHETIC.emailA, SYNTHETIC.priceLite, {
        payment_status: 'unpaid',
      });
      const event = normalizeCheckoutSession(session, { sourceMode: 'synthetic' });
      const persisted = persistEvent(db, event);
      const result = await fulfillEvent(db, { event: persisted.event, transport });
      const c = counts(db);
      return {
        db,
        actual_outcome: `verification=${event.verification_status} fulfilment=${result.status} code=${result.code ?? 'none'}`,
        detail: { verification_status: event.verification_status, code: result.code ?? null, counts: c },
        checks: [
          check('event is not verified', event.verification_status !== VERIFICATION.VERIFIED, 'not verified', event.verification_status),
          check('fulfilment refused', result.status === 'refused', 'refused', result.status),
          check('no entitlement', c.entitlements === 0, 0, c.entitlements),
          check('no licence', c.licenses === 0, 0, c.licenses),
          check('no delivery', c.deliveries === 0, 0, c.deliveries),
        ],
        expectations: { entitlements: 0, licenses: 0, deliveries: 0 },
        events: { ...E, presented: 1, rejected: 1 },
        fulfilment: { attempted: 0, completed: 0, failed: 0 },
        flags: {},
      };
    },
  },

  {
    id: 'complete_but_unpaid',
    title: 'status "complete" with payment_status "unpaid" is refused (baseline defect)',
    expected_outcome: 'refused: "complete" alone is never proof of payment',
    async run() {
      const { db } = freshDb('s05');
      const transport = createCaptureTransport();
      const session = paidSession('s05', SYNTHETIC.emailA, SYNTHETIC.priceLite, {
        status: 'complete',
        payment_status: 'unpaid',
      });
      const event = normalizeCheckoutSession(session, { sourceMode: 'synthetic' });
      persistEvent(db, event);
      const result = await fulfillEvent(db, { event, transport });
      const c = counts(db);
      return {
        db,
        actual_outcome: `session_status=${session.status} payment_status=${session.payment_status} fulfilment=${result.status}`,
        detail: { verification_status: event.verification_status, code: result.code ?? null, counts: c },
        checks: [
          check('event is not verified', event.verification_status !== VERIFICATION.VERIFIED, 'not verified', event.verification_status),
          check('fulfilment refused', result.status === 'refused', 'refused', result.status),
          check('no entitlement', c.entitlements === 0, 0, c.entitlements),
          check('no licence', c.licenses === 0, 0, c.licenses),
          check('no delivery', c.deliveries === 0, 0, c.deliveries),
        ],
        expectations: { entitlements: 0, licenses: 0, deliveries: 0 },
        events: { ...E, presented: 1, rejected: 1 },
        fulfilment: { attempted: 0, completed: 0, failed: 0 },
        flags: {},
      };
    },
  },

  {
    id: 'unknown_price',
    title: 'a paid session whose price is not in the catalog is refused',
    expected_outcome: 'refused with unknown_product_mapping, nothing created',
    async run() {
      const { db } = freshDb('s06');
      const transport = createCaptureTransport();
      const session = paidSession('s06', SYNTHETIC.emailA, SYNTHETIC.priceUnknown);
      const event = normalizeCheckoutSession(session, { sourceMode: 'synthetic' });
      persistEvent(db, event);
      const result = await fulfillEvent(db, { event, transport });
      const c = counts(db);
      return {
        db,
        actual_outcome: `product_id=${event.product_id} fulfilment=${result.status} code=${result.code ?? 'none'}`,
        detail: { price_reference: event.price_reference, code: result.code ?? null, counts: c },
        checks: [
          check('no product resolved', event.product_id === null, null, event.product_id),
          check('fulfilment refused', result.status === 'refused', 'refused', result.status),
          check('refusal names the unknown product', result.code === 'fulfillment.unknown_product', 'fulfillment.unknown_product', result.code ?? null),
          check('no entitlement', c.entitlements === 0, 0, c.entitlements),
          check('no licence', c.licenses === 0, 0, c.licenses),
        ],
        expectations: { entitlements: 0, licenses: 0, deliveries: 0 },
        events: { ...E, presented: 1, rejected: 1 },
        fulfilment: { attempted: 0, completed: 0, failed: 0 },
        flags: { unknown_products_blocked: 1 },
      };
    },
  },

  {
    id: 'disabled_product',
    title: 'a paid session for a DISABLED catalog product is refused',
    expected_outcome: 'refused with catalog.product_disabled, nothing created',
    async run() {
      const { db } = freshDb('s07');
      const transport = createCaptureTransport();
      const fixtureDir = path.join(HERE, '..', 'raw', 'fixtures');
      fs.mkdirSync(fixtureDir, { recursive: true });
      const filePath = path.join(fixtureDir, 'catalog-disabled.json');
      fs.writeFileSync(
        filePath,
        JSON.stringify(
          {
            version: 1,
            currency: 'usd',
            description: 'Disposable experiment fixture: a disabled product.',
            products: [
              {
                product_id: 'experiment_disabled_product',
                product_name: 'Experiment Disabled Product',
                product_type: 'one_time',
                price_reference: ENV_NAMES.disabled,
                entitlement_type: 'experiment_disabled',
                license_policy: 'perpetual',
                fulfillment_type: 'license_email',
                delivery_artifact: 'license_key',
                renewal_policy: 'none',
                expiration_policy: 'never',
                status: 'disabled',
              },
            ],
          },
          null,
          2,
        ),
        'utf8',
      );
      const event = normalizeEvent({
        provider: 'stripe',
        provider_event_id: 'evt_synthetic_disabled_1',
        event_type: 'checkout.session.completed',
        customer_email: SYNTHETIC.emailA,
        provider_customer_id: 'cus_synthetic_s07',
        product_id: 'experiment_disabled_product',
        price_reference: ENV_NAMES.disabled,
        amount: 4900,
        currency: 'usd',
        occurred_at: new Date().toISOString(),
        received_at: new Date().toISOString(),
        verification_status: VERIFICATION.VERIFIED,
        processing_status: PROCESSING.PENDING,
        source_mode: 'synthetic',
        raw_payload_hash: sha256('synthetic-disabled-fixture'),
        payload_json: JSON.stringify({ note: 'synthetic disabled-product fixture' }),
      });
      persistEvent(db, event);
      const result = await fulfillEvent(db, {
        event,
        transport,
        catalogOptions: { filePath },
      });
      const c = counts(db);
      return {
        db,
        actual_outcome: `fulfilment=${result.status} code=${result.code ?? 'none'}`,
        detail: { code: result.code ?? null, reason: result.reason ?? null, counts: c },
        checks: [
          check('fulfilment refused', result.status === 'refused', 'refused', result.status),
          check('refusal names the disabled product', result.code === 'catalog.product_disabled', 'catalog.product_disabled', result.code ?? null),
          check('no entitlement', c.entitlements === 0, 0, c.entitlements),
          check('no licence', c.licenses === 0, 0, c.licenses),
          check('no delivery', c.deliveries === 0, 0, c.deliveries),
        ],
        expectations: { entitlements: 0, licenses: 0, deliveries: 0 },
        events: { ...E, presented: 1, rejected: 1 },
        fulfilment: { attempted: 0, completed: 0, failed: 0 },
        flags: { unknown_products_blocked: 1 },
      };
    },
  },

  {
    id: 'invalid_event',
    title: 'a malformed payload is rejected',
    expected_outcome: 'rejected as malformed_payload, never fulfilled',
    async run() {
      const { db } = freshDb('s08');
      const body = '{"this is not json';
      const signature = signStripe(body);
      const result = ingestWebhookEvent(db, { rawBody: body, signature, secret: WEBHOOK_SECRET });
      const c = counts(db);
      return {
        db,
        actual_outcome: `outcome=${result.outcome} accepted=${result.accepted}`,
        detail: { outcome: result.outcome, reason: result.reason ?? null, counts: c },
        checks: [
          check('rejected', result.accepted === false, false, result.accepted),
          check('named malformed_payload', result.outcome === 'malformed_payload', 'malformed_payload', result.outcome),
          check('never verified', result.verified === false, false, result.verified),
          check('no entitlement', c.entitlements === 0, 0, c.entitlements),
          check('no licence', c.licenses === 0, 0, c.licenses),
        ],
        expectations: { entitlements: 0, licenses: 0, deliveries: 0 },
        events: { ...E, presented: 1, rejected: 1 },
        fulfilment: { attempted: 0, completed: 0, failed: 0 },
        flags: { invalid_events_blocked: 1 },
      };
    },
  },

  {
    id: 'invalid_signature',
    title: 'a bad signature is rejected',
    expected_outcome: 'rejected as invalid_signature, never fulfilled',
    async run() {
      const { db } = freshDb('s09');
      const body = JSON.stringify({
        id: 'evt_synthetic_badsig_1',
        type: 'checkout.session.completed',
        data: { object: paidSession('s09', SYNTHETIC.emailA, SYNTHETIC.priceLite) },
      });
      const bad = `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`;
      const result = ingestWebhookEvent(db, { rawBody: body, signature: bad, secret: WEBHOOK_SECRET });
      const c = counts(db);
      return {
        db,
        actual_outcome: `outcome=${result.outcome} accepted=${result.accepted}`,
        detail: { outcome: result.outcome, reason: result.reason ?? null, counts: c },
        checks: [
          check('rejected', result.accepted === false, false, result.accepted),
          check('named invalid_signature', result.outcome === 'invalid_signature', 'invalid_signature', result.outcome),
          check('never verified', result.verified === false, false, result.verified),
          check('no revenue event row', c.revenue_events === 0, 0, c.revenue_events),
          check('no licence', c.licenses === 0, 0, c.licenses),
        ],
        expectations: { entitlements: 0, licenses: 0, deliveries: 0 },
        events: { ...E, presented: 1, rejected: 1 },
        fulfilment: { attempted: 0, completed: 0, failed: 0 },
        flags: { invalid_events_blocked: 1 },
      };
    },
  },

  {
    id: 'missing_secret',
    title: 'a webhook with no configured secret is refused (fail closed)',
    expected_outcome: 'refused as no_secret, never fulfilled',
    async run() {
      const { db } = freshDb('s10');
      const body = JSON.stringify({
        id: 'evt_synthetic_nosecret_1',
        type: 'checkout.session.completed',
        data: { object: paidSession('s10', SYNTHETIC.emailA, SYNTHETIC.priceLite) },
      });
      const result = ingestWebhookEvent(db, { rawBody: body, signature: signStripe(body), secret: '' });
      const c = counts(db);
      return {
        db,
        actual_outcome: `outcome=${result.outcome} accepted=${result.accepted}`,
        detail: { outcome: result.outcome, reason: result.reason ?? null, counts: c },
        checks: [
          check('refused', result.accepted === false, false, result.accepted),
          check('named no_secret', result.outcome === 'no_secret', 'no_secret', result.outcome),
          check('no revenue event row', c.revenue_events === 0, 0, c.revenue_events),
          check('no licence', c.licenses === 0, 0, c.licenses),
        ],
        expectations: { entitlements: 0, licenses: 0, deliveries: 0 },
        events: { ...E, presented: 1, rejected: 1 },
        fulfilment: { attempted: 0, completed: 0, failed: 0 },
        flags: { invalid_events_blocked: 1 },
      };
    },
  },

  {
    id: 'duplicate_license_attempt',
    title: 'issuing a licence twice for the same entitlement still yields ONE licence',
    expected_outcome: 'one licence row, same licence id and key',
    async run() {
      const { db } = freshDb('s11');
      const transport = createCaptureTransport();
      const { event, result } = await purchase(db, { id: 's11', email: SYNTHETIC.emailA, transport });
      const entitlement = result.entitlement;
      const product = getProduct('skill_pack_lite');
      const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(entitlement.customer_id);
      const again = issueLicense(db, { entitlement, customer, product, event });
      const c = counts(db);
      return {
        db,
        actual_outcome: `licences=${c.licenses} same_id=${again.id === result.license.id}`,
        detail: { original_license_id: result.license.id, second_license_id: again.id, same_key: again.license_key === result.license.license_key },
        checks: [
          check('still one licence row', c.licenses === 1, 1, c.licenses),
          check('same licence id', again.id === result.license.id, result.license.id, again.id),
          check('same licence key', again.license_key === result.license.license_key, 'unchanged', 'changed'),
        ],
        expectations: { entitlements: 1, licenses: 1, deliveries: 1 },
        events: { ...E, presented: 1, verified: 1 },
        fulfilment: { attempted: 1, completed: 1, failed: 0 },
        flags: {},
      };
    },
  },

  {
    id: 'cross_customer_use',
    title: 'customer B presenting customer A licence key is denied',
    expected_outcome: 'denied: licence verification fails and login is refused',
    async run() {
      const { db } = freshDb('s12');
      const transport = createCaptureTransport();
      const { result } = await purchase(db, { id: 's12', email: SYNTHETIC.emailA, transport });
      const key = result.license.license_key;
      const other = ensureCustomer(db, {
        email: SYNTHETIC.emailB,
        provider: 'stripe',
        providerCustomerId: 'cus_synthetic_other',
      });
      const verified = verifyLicense(db, key, { customerId: other.id });
      let loginError = null;
      try {
        await login(db, { email: SYNTHETIC.emailB, licenseKey: key, sessionSecret: SESSION_SECRET });
      } catch (err) {
        loginError = err.code ?? err.message;
      }
      return {
        db,
        actual_outcome: `verify=${verified === null ? 'denied' : 'ALLOWED'} login=${loginError ?? 'ALLOWED'}`,
        detail: { verify_result: verified === null ? 'null' : 'licence', login_error: loginError },
        checks: [
          check('licence verification denied for the other customer', verified === null, null, verified),
          check('login refused', loginError !== null, 'an access error', loginError ?? 'allowed'),
        ],
        expectations: { entitlements: 1, licenses: 1, deliveries: 1 },
        events: { ...E, presented: 1, verified: 1 },
        fulfilment: { attempted: 1, completed: 1, failed: 0 },
        flags: { cross_customer_attempts: 1, cross_customer_blocked: 1 },
      };
    },
  },

  {
    id: 'wrong_product',
    title: 'a licence for product X used to claim product Y is denied',
    expected_outcome: 'denied: the licence grants a different product',
    async run() {
      const { db } = freshDb('s13');
      const transport = createCaptureTransport();
      const { result } = await purchase(db, { id: 's13', email: SYNTHETIC.emailA, transport });
      const key = result.license.license_key;
      const wrong = verifyLicense(db, key, { productId: 'skill_pack_std' });
      const right = verifyLicense(db, key, { productId: 'skill_pack_lite' });
      return {
        db,
        actual_outcome: `wrong_product=${wrong === null ? 'denied' : 'ALLOWED'} own_product=${right === null ? 'denied' : 'allowed'}`,
        detail: { licence_product: result.entitlement.product_id },
        checks: [
          check('wrong product denied', wrong === null, null, wrong),
          check('own product allowed', right !== null, 'a licence', right ? 'allowed' : null),
        ],
        expectations: { entitlements: 1, licenses: 1, deliveries: 1 },
        events: { ...E, presented: 1, verified: 1 },
        fulfilment: { attempted: 1, completed: 1, failed: 0 },
        flags: { cross_customer_attempts: 1, cross_customer_blocked: 1 },
      };
    },
  },

  {
    id: 'revoked_license',
    title: 'a revoked licence is not usable',
    expected_outcome: 'denied after revocation',
    async run() {
      const { db } = freshDb('s14');
      const transport = createCaptureTransport();
      const { result } = await purchase(db, { id: 's14', email: SYNTHETIC.emailA, transport });
      revokeLicense(db, result.license.id, 'synthetic experiment revocation');
      const verified = verifyLicense(db, result.license.license_key);
      return {
        db,
        actual_outcome: `verify=${verified === null ? 'denied' : 'ALLOWED'}`,
        detail: { license_status: 'revoked' },
        checks: [check('revoked licence denied', verified === null, null, verified)],
        expectations: { entitlements: 1, licenses: 1, deliveries: 1 },
        events: { ...E, presented: 1, verified: 1 },
        fulfilment: { attempted: 1, completed: 1, failed: 0 },
        flags: {},
      };
    },
  },

  {
    id: 'expired_license',
    title: 'an expired licence is not usable',
    expected_outcome: 'denied after expiry',
    async run() {
      const { db } = freshDb('s15');
      const transport = createCaptureTransport();
      const { result } = await purchase(db, { id: 's15', email: SYNTHETIC.emailA, transport });
      expireLicense(db, result.license.id, 'synthetic experiment expiry');
      const verified = verifyLicense(db, result.license.license_key);
      return {
        db,
        actual_outcome: `verify=${verified === null ? 'denied' : 'ALLOWED'}`,
        detail: { license_status: 'expired' },
        checks: [check('expired licence denied', verified === null, null, verified)],
        expectations: { entitlements: 1, licenses: 1, deliveries: 1 },
        events: { ...E, presented: 1, verified: 1 },
        fulfilment: { attempted: 1, completed: 1, failed: 0 },
        flags: {},
      };
    },
  },

  {
    id: 'revocation_invalidates_session',
    title: 'a still-unexpired session token stops working the moment the licence is revoked',
    expected_outcome: 'access DENIED on the reused token',
    async run() {
      const { db } = freshDb('s16');
      const transport = createCaptureTransport();
      const { result } = await purchase(db, { id: 's16', email: SYNTHETIC.emailA, transport });
      const session = await login(db, {
        email: SYNTHETIC.emailA,
        licenseKey: result.license.license_key,
        sessionSecret: SESSION_SECRET,
      });
      const before = await authenticate(db, {
        authorizationHeader: `Bearer ${session.sessionToken}`,
        sessionSecret: SESSION_SECRET,
      });
      revokeLicense(db, result.license.id, 'synthetic experiment revocation');
      let afterError = null;
      try {
        await authenticate(db, {
          authorizationHeader: `Bearer ${session.sessionToken}`,
          sessionSecret: SESSION_SECRET,
        });
      } catch (err) {
        afterError = err.code ?? err.message;
      }
      return {
        db,
        actual_outcome: `before_revocation=${before ? 'allowed' : 'DENIED'} after_revocation=${afterError ?? 'ALLOWED'}`,
        detail: { token_reused: true, error_after_revocation: afterError },
        checks: [
          check('session valid before revocation', Boolean(before), 'a session', before ? 'ok' : null),
          check('session denied after revocation', afterError !== null, 'an access error', afterError ?? 'allowed'),
        ],
        expectations: { entitlements: 1, licenses: 1, deliveries: 1 },
        events: { ...E, presented: 1, verified: 1 },
        fulfilment: { attempted: 1, completed: 1, failed: 0 },
        flags: { session_revocation_attempts: 1, session_revocation_blocked: afterError ? 1 : 0 },
      };
    },
  },

  {
    id: 'restart_before_license',
    title: 'a run left at stage "entitlement" is re-run and completes with ONE licence and ONE delivery',
    expected_outcome: 'resumed: one licence, one delivery, no duplicate',
    async run() {
      const { db } = freshDb('s17');
      const transport = createCaptureTransport();
      const { event, result } = await purchase(db, { id: 's17', email: SYNTHETIC.emailA, transport });
      // Simulate the process dying immediately after the entitlement stage.
      db.prepare('DELETE FROM deliveries').run();
      db.prepare('DELETE FROM licenses').run();
      db.prepare(
        `UPDATE fulfillment_runs SET stage = 'entitlement', status = 'running', license_id = NULL
          WHERE event_id = ?`,
      ).run(event.event_id);
      const resumed = await fulfillEvent(db, { event, transport });
      const c = counts(db);
      return {
        db,
        actual_outcome: `resumed=${resumed.status} licences=${c.licenses} deliveries=${c.successful_deliveries}`,
        detail: { stage_after_resume: resumed.fulfillment_run?.stage ?? null },
        checks: [
          check('resumed run completed', resumed.status === 'completed', 'completed', resumed.status),
          check('exactly one licence', c.licenses === 1, 1, c.licenses),
          check('exactly one successful delivery', c.successful_deliveries === 1, 1, c.successful_deliveries),
          check('run stage is complete', resumed.fulfillment_run?.stage === 'complete', 'complete', resumed.fulfillment_run?.stage ?? null),
        ],
        expectations: { entitlements: 1, licenses: 1, deliveries: 1 },
        events: { ...E, presented: 1, verified: 1 },
        fulfilment: { attempted: 2, completed: 2, failed: 0 },
        flags: { restart_scenarios: 1, restart_recovered: 1 },
      };
    },
  },

  {
    id: 'restart_after_license',
    title: 'a run left at stage "license" is re-run and completes with ONE licence and ONE delivery',
    expected_outcome: 'resumed: no second licence, exactly one delivery',
    async run() {
      const { db } = freshDb('s18');
      const transport = createCaptureTransport();
      const { event, result } = await purchase(db, { id: 's18', email: SYNTHETIC.emailA, transport });
      // Simulate the process dying after the licence was issued.
      db.prepare('DELETE FROM deliveries').run();
      db.prepare(
        `UPDATE fulfillment_runs SET stage = 'license', status = 'running'
          WHERE event_id = ?`,
      ).run(event.event_id);
      const resumed = await fulfillEvent(db, { event, transport });
      const c = counts(db);
      return {
        db,
        actual_outcome: `resumed=${resumed.status} licences=${c.licenses} deliveries=${c.successful_deliveries}`,
        detail: {
          licence_id_before: result.license.id,
          licence_id_after: resumed.license?.id ?? null,
          stage_after_resume: resumed.fulfillment_run?.stage ?? null,
        },
        checks: [
          check('resumed run completed', resumed.status === 'completed', 'completed', resumed.status),
          check('still exactly one licence', c.licenses === 1, 1, c.licenses),
          check('the SAME licence was reused', resumed.license?.id === result.license.id, result.license.id, resumed.license?.id ?? null),
          check('exactly one successful delivery', c.successful_deliveries === 1, 1, c.successful_deliveries),
        ],
        expectations: { entitlements: 1, licenses: 1, deliveries: 1 },
        events: { ...E, presented: 1, verified: 1 },
        fulfilment: { attempted: 2, completed: 2, failed: 0 },
        flags: { restart_scenarios: 1, restart_recovered: 1 },
      };
    },
  },

  {
    id: 'restart_before_commit',
    title: 'a run row inserted with NO entitlement is recovered without duplicating',
    expected_outcome: 'recovered: one entitlement, one licence, one delivery',
    async run() {
      const { db } = freshDb('s19');
      const transport = createCaptureTransport();
      const session = paidSession('s19', SYNTHETIC.emailA, SYNTHETIC.priceLite);
      const event = normalizeCheckoutSession(session, { sourceMode: 'synthetic' });
      const persisted = persistEvent(db, event);
      // Simulate the run row having been written but nothing committed yet.
      const idemKey = fulfillmentKeyFor(persisted.event);
      const ts = new Date().toISOString();
      db.prepare(
        `INSERT INTO fulfillment_runs
           (id, idempotency_key, event_id, customer_id, entitlement_id, license_id,
            stage, status, attempts, last_error, created_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, NULL, 'started', 'running', 0, NULL, ?, ?)`,
      ).run('ful_synthetic_s19', idemKey, persisted.event.event_id, ts, ts);
      const recovered = await fulfillEvent(db, { event: persisted.event, transport });
      const c = counts(db);
      return {
        db,
        actual_outcome: `recovered=${recovered.status} entitlements=${c.entitlements} licences=${c.licenses} deliveries=${c.successful_deliveries}`,
        detail: { run_rows: c.fulfillment_runs, stage: recovered.fulfillment_run?.stage ?? null },
        checks: [
          check('recovered run completed', recovered.status === 'completed', 'completed', recovered.status),
          check('exactly one run row', c.fulfillment_runs === 1, 1, c.fulfillment_runs),
          check('exactly one entitlement', c.entitlements === 1, 1, c.entitlements),
          check('exactly one licence', c.licenses === 1, 1, c.licenses),
          check('exactly one successful delivery', c.successful_deliveries === 1, 1, c.successful_deliveries),
        ],
        expectations: { entitlements: 1, licenses: 1, deliveries: 1 },
        events: { ...E, presented: 1, verified: 1 },
        fulfilment: { attempted: 1, completed: 1, failed: 0 },
        flags: { restart_scenarios: 1, restart_recovered: 1 },
      };
    },
  },

  {
    id: 'delivery_failure_then_retry',
    title: 'a transport that throws once: delivery fails, the retry succeeds, exactly ONE successful delivery',
    expected_outcome: 'failed then captured, exactly one successful delivery',
    async run() {
      const { db } = freshDb('s20');
      let calls = 0;
      const flaky = {
        name: 'synthetic-flaky',
        async send(message) {
          calls += 1;
          if (calls === 1) throw new Error('synthetic transport failure');
          return { messageId: 'capture_synthetic_flaky_1', status: 'captured', message };
        },
      };
      const session = paidSession('s20', SYNTHETIC.emailA, SYNTHETIC.priceLite);
      const event = normalizeCheckoutSession(session, { sourceMode: 'synthetic' });
      const persisted = persistEvent(db, event);
      const first = await fulfillEvent(db, { event: persisted.event, transport: flaky });
      const mid = counts(db);
      const second = await fulfillEvent(db, { event: persisted.event, transport: flaky });
      const c = counts(db);
      return {
        db,
        actual_outcome: `first=${first.status} second=${second.status} successful_deliveries=${c.successful_deliveries}`,
        detail: {
          transport_calls: calls,
          failed_delivery_rows_after_first_attempt: mid.failed_deliveries,
          delivery_rows: c.deliveries,
          successful_deliveries: c.successful_deliveries,
        },
        checks: [
          check('first attempt failed', first.status === 'failed', 'failed', first.status),
          check('failure recorded as a failed delivery', mid.failed_deliveries === 1, 1, mid.failed_deliveries),
          check('retry completed', second.status === 'completed', 'completed', second.status),
          check('exactly one successful delivery', c.successful_deliveries === 1, 1, c.successful_deliveries),
          check('exactly one licence', c.licenses === 1, 1, c.licenses),
        ],
        expectations: { entitlements: 1, licenses: 1, deliveries: 1 },
        events: { ...E, presented: 1, verified: 1 },
        fulfilment: { attempted: 2, completed: 1, failed: 1 },
        flags: {},
      };
    },
  },
];


