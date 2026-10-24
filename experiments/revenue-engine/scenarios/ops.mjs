/**
 * Aurora Revenue Engine — EXPERIMENT SCENARIOS (operations lane).
 *
 * Scenarios 21-35 of the required set: reconciliation, admin authorisation,
 * money-movement refusal, transport failure, out-of-order delivery and
 * idempotency-key stability.
 */
import { normalizeEvent, persistEvent, VERIFICATION, PROCESSING } from '../../../src/events.js';
import { reconcile } from '../../../src/reconcile.js';
import { requireAdmin } from '../../../src/admin.js';
import { assertNoMoneyMovement, governedActions } from '../../../src/governed.js';
import { ensureCustomer } from '../../../src/entitlements.js';
import { fulfillEvent } from '../../../src/fulfillment.js';
import { createCaptureTransport } from '../../../src/delivery.js';
import { sha256 } from '../../../src/db.js';
import { freshDb, counts, check, SYNTHETIC } from '../lib.mjs';

const ADMIN_TOKEN = 'synthetic-experiment-admin-token-not-real';
const E = { presented: 0, verified: 0, rejected: 0, duplicates: 0 };

const findingTypes = (report) => (report.findings ?? []).map((f) => f.type);

export const opsScenarios = [
  {
    id: 'subscription_cancelled_but_entitlement_active',
    title: 'reconciliation detects an active entitlement for a cancelled subscription',
    expected_outcome: 'finding: subscription_cancelled_but_entitlement_active',
    async run() {
      const { db } = freshDb('s21');
      const customer = ensureCustomer(db, {
        email: SYNTHETIC.emailA,
        provider: 'stripe',
        providerCustomerId: 'cus_synthetic_sub_1',
      });
      db.prepare(
        `INSERT INTO entitlements
           (id, customer_id, product_id, status, source_event_id, provider_subscription_id,
            starts_at, expires_at, revoked_reason, created_at, updated_at)
         VALUES ('ent_synthetic_s21', ?, 'skill_pack_lite', 'active', NULL, 'sub_synthetic_1',
                 ?, NULL, NULL, ?, ?)`,
      ).run(customer.id, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
      const report = reconcile(db, {
        providerState: [
          {
            provider_customer_id: 'cus_synthetic_sub_1',
            subscription_reference: 'sub_synthetic_1',
            subscription_state: 'canceled',
            paid: false,
          },
        ],
      });
      const types = findingTypes(report);
      return {
        db,
        actual_outcome: `verdict=${report.verdict} findings=${types.join(',')}`,
        detail: { verdict: report.verdict, findings: types },
        checks: [
          check('finding detected', types.includes('subscription_cancelled_but_entitlement_active'), 'subscription_cancelled_but_entitlement_active', types.join(',')),
          check('verdict is not CONSISTENT', report.verdict !== 'CONSISTENT', 'not CONSISTENT', report.verdict),
        ],
        expectations: null,
        events: { ...E },
        fulfilment: { attempted: 0, completed: 0, failed: 0 },
        flags: { reconciliation_scenarios: 1, reconciliation_correct: types.includes('subscription_cancelled_but_entitlement_active') ? 1 : 0 },
      };
    },
  },

  {
    id: 'payment_exists_but_fulfillment_missing',
    title: 'reconciliation detects a provider payment with no fulfilment',
    expected_outcome: 'finding: payment_exists_but_fulfillment_missing',
    async run() {
      const { db } = freshDb('s22');
      const report = reconcile(db, {
        providerState: [{ paid: true, provider_event_id: 'evt_synthetic_never_fulfilled' }],
      });
      const types = findingTypes(report);
      return {
        db,
        actual_outcome: `verdict=${report.verdict} findings=${types.join(',')}`,
        detail: { verdict: report.verdict, findings: types },
        checks: [
          check('finding detected', types.includes('payment_exists_but_fulfillment_missing'), 'payment_exists_but_fulfillment_missing', types.join(',')),
        ],
        expectations: null,
        events: { ...E },
        fulfilment: { attempted: 0, completed: 0, failed: 0 },
        flags: { reconciliation_scenarios: 1, reconciliation_correct: types.includes('payment_exists_but_fulfillment_missing') ? 1 : 0 },
      };
    },
  },

  {
    id: 'fulfillment_without_verified_payment',
    title: 'reconciliation detects a fulfilment run whose payment was never verified',
    expected_outcome: 'finding: fulfillment_without_verified_payment',
    async run() {
      const { db } = freshDb('s23');
      const event = normalizeEvent({
        provider: 'stripe',
        provider_event_id: 'evt_synthetic_unverified_1',
        event_type: 'checkout.session.completed',
        customer_email: SYNTHETIC.emailA,
        provider_customer_id: 'cus_synthetic_s23',
        price_reference: SYNTHETIC.priceLite,
        verification_status: VERIFICATION.UNVERIFIED,
        processing_status: PROCESSING.PENDING,
        occurred_at: new Date().toISOString(),
        received_at: new Date().toISOString(),
        raw_payload_hash: sha256('synthetic-unverified'),
        payload_json: JSON.stringify({ note: 'synthetic unverified event' }),
      });
      const persisted = persistEvent(db, event);
      db.prepare(
        `INSERT INTO fulfillment_runs
           (id, idempotency_key, event_id, customer_id, entitlement_id, license_id,
            stage, status, attempts, last_error, created_at, updated_at)
         VALUES ('ful_synthetic_s23', 'ful_synthetic_s23_key', ?, NULL, NULL, NULL,
                 'started', 'running', 0, NULL, ?, ?)`,
      ).run(persisted.event.event_id, new Date().toISOString(), new Date().toISOString());
      const report = reconcile(db, { providerState: [] });
      const types = findingTypes(report);
      return {
        db,
        actual_outcome: `verdict=${report.verdict} findings=${types.join(',')}`,
        detail: { verdict: report.verdict, findings: types },
        checks: [
          check('finding detected', types.includes('fulfillment_without_verified_payment'), 'fulfillment_without_verified_payment', types.join(',')),
        ],
        expectations: null,
        events: { ...E },
        fulfilment: { attempted: 0, completed: 0, failed: 0 },
        flags: { reconciliation_scenarios: 1, reconciliation_correct: types.includes('fulfillment_without_verified_payment') ? 1 : 0 },
      };
    },
  },

  {
    id: 'duplicate_license',
    title: 'reconciliation detects two active licences for the same email and price',
    expected_outcome: 'finding: duplicate_license',
    async run() {
      const { db } = freshDb('s24');
      const ts = new Date().toISOString();
      const insert = db.prepare(
        `INSERT INTO licenses (id, email, license_key, price_id, tier, status, created_at)
         VALUES (?, ?, ?, ?, 'skill_pack', 'active', ?)`,
      );
      insert.run('lic_synthetic_s24_a', SYNTHETIC.emailA, 'CCPI-SYNTHETIC-S24A-00000001', SYNTHETIC.priceLite, ts);
      insert.run('lic_synthetic_s24_b', SYNTHETIC.emailA, 'CCPI-SYNTHETIC-S24B-00000002', SYNTHETIC.priceLite, ts);
      const report = reconcile(db, { providerState: [] });
      const types = findingTypes(report);
      return {
        db,
        actual_outcome: `verdict=${report.verdict} findings=${types.join(',')}`,
        detail: { verdict: report.verdict, findings: types, licences: counts(db).licenses },
        checks: [
          check('finding detected', types.includes('duplicate_license'), 'duplicate_license', types.join(',')),
        ],
        expectations: null,
        events: { ...E },
        fulfilment: { attempted: 0, completed: 0, failed: 0 },
        flags: { reconciliation_scenarios: 1, reconciliation_correct: types.includes('duplicate_license') ? 1 : 0 },
      };
    },
  },

  {
    id: 'orphan_entitlement',
    title: 'reconciliation detects an entitlement with no backing revenue event',
    expected_outcome: 'finding: orphan_entitlement',
    async run() {
      const { db } = freshDb('s25');
      const customer = ensureCustomer(db, {
        email: SYNTHETIC.emailA,
        provider: 'stripe',
        providerCustomerId: 'cus_synthetic_s25',
      });
      db.prepare(
        `INSERT INTO entitlements
           (id, customer_id, product_id, status, source_event_id, provider_subscription_id,
            starts_at, expires_at, revoked_reason, created_at, updated_at)
         VALUES ('ent_synthetic_s25', ?, 'skill_pack_lite', 'active', 'evt_synthetic_absent', NULL,
                 ?, NULL, NULL, ?, ?)`,
      ).run(customer.id, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
      const report = reconcile(db, { providerState: [] });
      const types = findingTypes(report);
      return {
        db,
        actual_outcome: `verdict=${report.verdict} findings=${types.join(',')}`,
        detail: { verdict: report.verdict, findings: types },
        checks: [
          check('finding detected', types.includes('orphan_entitlement'), 'orphan_entitlement', types.join(',')),
        ],
        expectations: null,
        events: { ...E },
        fulfilment: { attempted: 0, completed: 0, failed: 0 },
        flags: { reconciliation_scenarios: 1, reconciliation_correct: types.includes('orphan_entitlement') ? 1 : 0 },
      };
    },
  },

  {
    id: 'unknown_product_mapping',
    title: 'reconciliation detects an event whose price maps to no known product',
    expected_outcome: 'finding: unknown_product_mapping',
    async run() {
      const { db } = freshDb('s26');
      const event = normalizeEvent({
        provider: 'stripe',
        provider_event_id: 'evt_synthetic_unknown_price_1',
        event_type: 'checkout.session.completed',
        customer_email: SYNTHETIC.emailA,
        provider_customer_id: 'cus_synthetic_s26',
        product_id: null,
        price_reference: SYNTHETIC.priceUnknown,
        verification_status: VERIFICATION.VERIFIED,
        processing_status: PROCESSING.PENDING,
        occurred_at: new Date().toISOString(),
        received_at: new Date().toISOString(),
        raw_payload_hash: sha256('synthetic-unknown-price'),
        payload_json: JSON.stringify({ note: 'synthetic unknown price event' }),
      });
      persistEvent(db, event);
      const report = reconcile(db, { providerState: [] });
      const types = findingTypes(report);
      return {
        db,
        actual_outcome: `verdict=${report.verdict} findings=${types.join(',')}`,
        detail: { verdict: report.verdict, findings: types },
        checks: [
          check('finding detected', types.includes('unknown_product_mapping'), 'unknown_product_mapping', types.join(',')),
        ],
        expectations: null,
        events: { ...E },
        fulfilment: { attempted: 0, completed: 0, failed: 0 },
        flags: { reconciliation_scenarios: 1, reconciliation_correct: types.includes('unknown_product_mapping') ? 1 : 0 },
      };
    },
  },

  {
    id: 'admin_without_token',
    title: 'an admin request with no token is denied',
    expected_outcome: 'denied: admin.missing_token',
    async run() {
      const previous = process.env.REVENUE_ADMIN_TOKEN;
      process.env.REVENUE_ADMIN_TOKEN = ADMIN_TOKEN;
      let code = null;
      try {
        requireAdmin({ headers: {} });
      } catch (err) {
        code = err.code ?? err.message;
      } finally {
        if (previous === undefined) delete process.env.REVENUE_ADMIN_TOKEN;
        else process.env.REVENUE_ADMIN_TOKEN = previous;
      }
      return {
        db: null,
        actual_outcome: `code=${code ?? 'ALLOWED'}`,
        detail: { error_code: code },
        checks: [
          check('denied', code !== null, 'an admin auth error', code ?? 'allowed'),
          check('named admin.missing_token', code === 'admin.missing_token', 'admin.missing_token', code),
        ],
        expectations: { entitlements: 0, licenses: 0, deliveries: 0 },
        events: { ...E },
        fulfilment: { attempted: 0, completed: 0, failed: 0 },
        flags: { admin_attempts: 1, admin_denied: code ? 1 : 0 },
      };
    },
  },

  {
    id: 'admin_with_wrong_token',
    title: 'an admin request with the wrong token is denied',
    expected_outcome: 'denied: admin.invalid_token',
    async run() {
      const previous = process.env.REVENUE_ADMIN_TOKEN;
      process.env.REVENUE_ADMIN_TOKEN = ADMIN_TOKEN;
      let code = null;
      try {
        requireAdmin({ headers: { authorization: 'Bearer synthetic-wrong-token-not-real' } });
      } catch (err) {
        code = err.code ?? err.message;
      } finally {
        if (previous === undefined) delete process.env.REVENUE_ADMIN_TOKEN;
        else process.env.REVENUE_ADMIN_TOKEN = previous;
      }
      return {
        db: null,
        actual_outcome: `code=${code ?? 'ALLOWED'}`,
        detail: { error_code: code },
        checks: [
          check('denied', code !== null, 'an admin auth error', code ?? 'allowed'),
          check('named admin.invalid_token', code === 'admin.invalid_token', 'admin.invalid_token', code),
        ],
        expectations: { entitlements: 0, licenses: 0, deliveries: 0 },
        events: { ...E },
        fulfilment: { attempted: 0, completed: 0, failed: 0 },
        flags: { admin_attempts: 1, admin_denied: code ? 1 : 0 },
      };
    },
  },

  {
    id: 'admin_token_unset',
    title: 'an admin request when REVENUE_ADMIN_TOKEN is unset is denied (fail closed)',
    expected_outcome: 'denied: admin.not_configured',
    async run() {
      const previous = process.env.REVENUE_ADMIN_TOKEN;
      delete process.env.REVENUE_ADMIN_TOKEN;
      let code = null;
      try {
        requireAdmin({ headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
      } catch (err) {
        code = err.code ?? err.message;
      } finally {
        if (previous !== undefined) process.env.REVENUE_ADMIN_TOKEN = previous;
      }
      return {
        db: null,
        actual_outcome: `code=${code ?? 'ALLOWED'}`,
        detail: { error_code: code, governed_actions: governedActions().length },
        checks: [
          check('denied', code !== null, 'an admin auth error', code ?? 'allowed'),
          check('named admin.not_configured', code === 'admin.not_configured', 'admin.not_configured', code),
        ],
        expectations: { entitlements: 0, licenses: 0, deliveries: 0 },
        events: { ...E },
        fulfilment: { attempted: 0, completed: 0, failed: 0 },
        flags: { admin_attempts: 1, admin_denied: code ? 1 : 0 },
      };
    },
  },
];

