/**
 * Aurora Revenue Engine — EXPERIMENT SCENARIOS (governance + ordering lane).
 *
 * Scenarios 30-35 of the required set.
 */
import { normalizeCheckoutSession } from '../../../src/stripe-boundary.js';
import { persistEvent, idempotencyKeyFor } from '../../../src/events.js';
import { fulfillEvent, fulfillmentKeyFor } from '../../../src/fulfillment.js';
import { createCaptureTransport } from '../../../src/delivery.js';
import { assertNoMoneyMovement } from '../../../src/governed.js';
import { freshDb, counts, check, SYNTHETIC } from '../lib.mjs';

const E = { presented: 0, verified: 0, rejected: 0, duplicates: 0 };

function moneyScenario(id, action) {
  return {
    id,
    title: `money movement "${action}" is blocked by assertNoMoneyMovement`,
    expected_outcome: `refused: governed.money_movement_requires_authorisation for "${action}"`,
    async run() {
      let code = null;
      let blocked = false;
      try {
        assertNoMoneyMovement(action);
      } catch (err) {
        blocked = true;
        code = err.code ?? err.message;
      }
      return {
        db: null,
        actual_outcome: `blocked=${blocked} code=${code ?? 'ALLOWED'}`,
        detail: { action, error_code: code },
        checks: [
          check('refused', blocked === true, true, blocked),
          check('named governed.money_movement_requires_authorisation', code === 'governed.money_movement_requires_authorisation', 'governed.money_movement_requires_authorisation', code),
        ],
        expectations: { entitlements: 0, licenses: 0, deliveries: 0 },
        events: { ...E },
        fulfilment: { attempted: 0, completed: 0, failed: 0 },
        flags: { money_actions: 1, money_actions_blocked: blocked ? 1 : 0 },
      };
    },
  };
}

export const governanceScenarios = [
  moneyScenario('money_movement_refund', 'refund'),
  moneyScenario('money_movement_charge', 'charge'),
  moneyScenario('money_movement_payout', 'payout'),

  {
    id: 'email_provider_unavailable',
    title: 'a transport that always throws: delivery fails, nothing crashes, the run stays retryable',
    expected_outcome: 'failed delivery recorded, no crash, retry succeeds with one successful delivery',
    async run() {
      const { db } = freshDb('s33');
      const dead = {
        name: 'synthetic-unavailable',
        async send() {
          throw new Error('synthetic email provider unavailable');
        },
      };
      const session = normalizeCheckoutSession(
        {
          id: 'cs_synthetic_s33',
          object: 'checkout.session',
          status: 'complete',
          payment_status: 'paid',
          mode: 'payment',
          customer: 'cus_synthetic_s33',
          customer_email: SYNTHETIC.emailA,
          customer_details: { email: SYNTHETIC.emailA },
          amount_total: 4900,
          currency: 'usd',
          line_items: { data: [{ price: { id: SYNTHETIC.priceLite } }] },
          created: 1767225600,
        },
        { sourceMode: 'synthetic' },
      );
      const persisted = persistEvent(db, session);
      let crashed = null;
      let first = null;
      try {
        first = await fulfillEvent(db, { event: persisted.event, transport: dead });
      } catch (err) {
        crashed = err.message;
      }
      const mid = counts(db);
      let second = null;
      try {
        second = await fulfillEvent(db, { event: persisted.event, transport: dead });
      } catch (err) {
        crashed = crashed ?? err.message;
      }
      const capture = createCaptureTransport();
      const third = await fulfillEvent(db, { event: persisted.event, transport: capture });
      const c = counts(db);
      return {
        db,
        actual_outcome: `crashed=${crashed ? 'YES' : 'no'} first=${first?.status ?? 'n/a'} second=${second?.status ?? 'n/a'} third=${third.status}`,
        detail: {
          crashed,
          failed_delivery_rows: mid.failed_deliveries,
          failed_deliveries_after_retries: c.failed_deliveries,
          successful_deliveries: c.successful_deliveries,
          run_stage: third.fulfillment_run?.stage ?? null,
        },
        checks: [
          check('no crash escaped', crashed === null, null, crashed),
          check('failure recorded', mid.failed_deliveries === 1, 1, mid.failed_deliveries),
          check('run reports failure', first?.status === 'failed', 'failed', first?.status ?? null),
          check('run is retryable', second?.status === 'failed', 'failed (retryable)', second?.status ?? null),
          check('retry with a working transport completes', third.status === 'completed', 'completed', third.status),
          check('exactly one successful delivery', c.successful_deliveries === 1, 1, c.successful_deliveries),
        ],
        expectations: { entitlements: 1, licenses: 1, deliveries: 1 },
        events: { ...E, presented: 1, verified: 1 },
        fulfilment: { attempted: 3, completed: 1, failed: 2 },
        flags: {},
      };
    },
  },

  {
    id: 'event_received_twice_out_of_order',
    title: 'two distinct provider events delivered in reverse order: no duplicate, no crash',
    expected_outcome: 'both processed, one entitlement, one licence, one successful delivery, no crash',
    async run() {
      const { db } = freshDb('s34');
      const transport = createCaptureTransport();
      const makeSession = (id, priceId) => ({
        id: `cs_synthetic_${id}`,
        object: 'checkout.session',
        status: 'complete',
        payment_status: 'paid',
        mode: 'payment',
        customer: 'cus_synthetic_s34',
        customer_email: SYNTHETIC.emailA,
        customer_details: { email: SYNTHETIC.emailA },
        amount_total: 4900,
        currency: 'usd',
        line_items: { data: [{ price: { id: priceId } }] },
        created: 1767225600,
      });
      const first = normalizeCheckoutSession(makeSession('s34_a', SYNTHETIC.priceLite), { sourceMode: 'synthetic' });
      const second = normalizeCheckoutSession(makeSession('s34_b', SYNTHETIC.priceLite), { sourceMode: 'synthetic' });
      const p1 = persistEvent(db, first);
      const p2 = persistEvent(db, second);
      let crashed = null;
      let r2 = null;
      let r1 = null;
      try {
        r2 = await fulfillEvent(db, { event: p2.event, transport });
        r1 = await fulfillEvent(db, { event: p1.event, transport });
      } catch (err) {
        crashed = err.message;
      }
      const c = counts(db);
      return {
        db,
        actual_outcome: `crashed=${crashed ? 'YES' : 'no'} second_first=${r2?.status ?? 'n/a'} first_second=${r1?.status ?? 'n/a'} entitlements=${c.entitlements} licences=${c.licenses}`,
        detail: {
          crashed,
          revenue_events: c.revenue_events,
          entitlements: c.entitlements,
          licenses: c.licenses,
          successful_deliveries: c.successful_deliveries,
          delivery_rows: c.deliveries,
        },
        checks: [
          check('no crash', crashed === null, null, crashed),
          check('both events fulfilled', r2?.status === 'completed' && r1?.status === 'completed', 'both completed', `${r2?.status ?? 'n/a'}/${r1?.status ?? 'n/a'}`),
          check('two distinct event rows', c.revenue_events === 2, 2, c.revenue_events),
          check('one entitlement', c.entitlements === 1, 1, c.entitlements),
          check('one licence', c.licenses === 1, 1, c.licenses),
          check('exactly one successful delivery', c.successful_deliveries === 1, 1, c.successful_deliveries),
        ],
        expectations: { entitlements: 1, licenses: 1, deliveries: 1 },
        events: { ...E, presented: 2, verified: 2 },
        fulfilment: { attempted: 2, completed: 2, failed: 0 },
        flags: {},
      };
    },
  },

  {
    id: 'idempotency_key_stability',
    title: 'the same provider event always yields the same idempotency key; different events differ',
    expected_outcome: 'stable keys for one event, distinct keys for distinct events',
    async run() {
      const a = { provider: 'stripe', provider_event_id: 'evt_synthetic_key_a' };
      const b = { provider: 'stripe', provider_event_id: 'evt_synthetic_key_b' };
      const k1 = idempotencyKeyFor(a);
      const k2 = idempotencyKeyFor(a);
      const k3 = idempotencyKeyFor(b);
      const f1 = fulfillmentKeyFor(a);
      const f2 = fulfillmentKeyFor(a);
      const f3 = fulfillmentKeyFor(b);
      return {
        db: null,
        actual_outcome: `event_key_stable=${k1 === k2} event_key_distinct=${k1 !== k3} run_key_stable=${f1 === f2} run_key_distinct=${f1 !== f3}`,
        detail: { event_key_prefix: k1.slice(0, 8), run_key_prefix: f1.slice(0, 4) },
        checks: [
          check('same event -> same event key', k1 === k2, k1, k2),
          check('different event -> different event key', k1 !== k3, 'different', k1 === k3 ? 'same' : 'different'),
          check('same event -> same fulfilment key', f1 === f2, f1, f2),
          check('different event -> different fulfilment key', f1 !== f3, 'different', f1 === f3 ? 'same' : 'different'),
        ],
        expectations: { entitlements: 0, licenses: 0, deliveries: 0 },
        events: { ...E },
        fulfilment: { attempted: 0, completed: 0, failed: 0 },
        flags: {},
      };
    },
  },
];
