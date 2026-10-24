/**
 * Aurora Revenue Engine — EXPERIMENT HARNESS SELF-TEST.
 *
 * Asserts that:
 *   1. the harness ran EVERY required scenario (none "not run");
 *   2. every required metric field name is present and numeric;
 *   3. the metrics are internally consistent;
 *   4. the per-scenario raw artefacts were written and are parseable.
 *
 * Shared by `test/experiments.test.js` and `experiments/experiments.test.js`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runHarness, REQUIRED_METRICS } from './run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW_DIR = path.join(HERE, 'raw');

const REQUIRED_SCENARIOS = [
  'verified_purchase',
  'duplicate_event',
  'duplicate_webhook',
  'unpaid_session',
  'complete_but_unpaid',
  'unknown_price',
  'disabled_product',
  'invalid_event',
  'invalid_signature',
  'missing_secret',
  'duplicate_license_attempt',
  'cross_customer_use',
  'wrong_product',
  'revoked_license',
  'expired_license',
  'revocation_invalidates_session',
  'restart_before_license',
  'restart_after_license',
  'restart_before_commit',
  'delivery_failure_then_retry',
  'subscription_cancelled_but_entitlement_active',
  'payment_exists_but_fulfillment_missing',
  'fulfillment_without_verified_payment',
  'duplicate_license',
  'orphan_entitlement',
  'unknown_product_mapping',
  'admin_without_token',
  'admin_with_wrong_token',
  'admin_token_unset',
  'money_movement_refund',
  'money_movement_charge',
  'money_movement_payout',
  'email_provider_unavailable',
  'event_received_twice_out_of_order',
  'idempotency_key_stability',
];

export function defineSelfTests() {
  let payload = null;

  test('the experiment harness runs and produces a result bundle', async () => {
    payload = await runHarness();
    assert.ok(payload, 'the harness must return a result payload');
    assert.ok(payload.metrics, 'the harness must return metrics');
    assert.equal(payload.contract, 'aurora.revenue-engine.experiments@1');
  });

  test('the harness ran every required scenario', () => {
    assert.ok(payload, 'the harness must have run');
    const ids = payload.scenarios.map((s) => s.id);
    for (const required of REQUIRED_SCENARIOS) {
      assert.ok(ids.includes(required), `scenario "${required}" must be present in the results`);
    }
    assert.equal(payload.scenarios.length, REQUIRED_SCENARIOS.length);
    assert.equal(payload.metrics.SCENARIOS_TOTAL, REQUIRED_SCENARIOS.length);
    const notRun = payload.scenarios.filter((s) => s.actual_outcome === 'not run');
    assert.equal(notRun.length, 0, 'no scenario may be left un-run');
    const passed = payload.scenarios.filter((s) => s.pass).length;
    assert.equal(payload.metrics.SCENARIOS_PASSED, passed);
    for (const s of payload.scenarios) {
      assert.ok(s.checks.length > 0, `scenario "${s.id}" must record at least one check`);
      assert.equal(typeof s.expected_outcome, 'string');
      assert.equal(typeof s.actual_outcome, 'string');
    }
  });

  test('every required metric field name is present and numeric', () => {
    assert.ok(payload, 'the harness must have run');
    for (const key of REQUIRED_METRICS) {
      assert.ok(Object.prototype.hasOwnProperty.call(payload.metrics, key), `metric "${key}" must exist`);
      assert.equal(typeof payload.metrics[key], 'number', `metric "${key}" must be a number`);
      assert.ok(Number.isFinite(payload.metrics[key]), `metric "${key}" must be finite`);
      assert.ok(payload.metrics[key] >= 0, `metric "${key}" must not be negative`);
    }
    const onDisk = JSON.parse(fs.readFileSync(path.join(HERE, 'results.json'), 'utf8'));
    for (const key of REQUIRED_METRICS) {
      assert.equal(onDisk.metrics[key], payload.metrics[key], `metric "${key}" must match results.json`);
    }
  });

  test('the metrics are internally consistent', () => {
    assert.ok(payload, 'the harness must have run');
    const m = payload.metrics;
    assert.equal(
      m.PAYMENT_EVENTS_TOTAL,
      m.PAYMENT_EVENTS_VERIFIED + m.PAYMENT_EVENTS_REJECTED + m.DUPLICATE_EVENTS,
      'PAYMENT_EVENTS_TOTAL must equal VERIFIED + REJECTED + DUPLICATE_EVENTS',
    );
    assert.equal(
      m.FULFILLMENTS_ATTEMPTED,
      m.FULFILLMENTS_COMPLETED + m.FULFILLMENTS_FAILED,
      'FULFILLMENTS_ATTEMPTED must equal COMPLETED + FAILED',
    );
    assert.equal(m.DUPLICATE_EFFECTS, 0, 'a duplicate delivery must produce no extra effect');
    assert.equal(m.DUPLICATE_LICENSES, 0, 'no scenario may leave a duplicate licence');
    assert.ok(m.LICENSES_ISSUED <= m.LICENSES_EXPECTED, 'issued licences cannot exceed expected licences');
    assert.ok(m.ENTITLEMENTS_CORRECT <= m.ENTITLEMENTS_EXPECTED, 'correct entitlements cannot exceed expected entitlements');
    assert.ok(m.DELIVERIES_CAPTURED <= m.DELIVERIES_EXPECTED, 'captured deliveries cannot exceed expected deliveries');
    assert.ok(m.RECONCILIATION_CORRECT <= m.RECONCILIATION_SCENARIOS, 'reconciliation correct cannot exceed scenarios');
    assert.ok(m.RESTART_RECOVERED <= m.RESTART_SCENARIOS, 'restart recovered cannot exceed restart scenarios');
    assert.ok(m.INVALID_EVENTS_BLOCKED <= m.PAYMENT_EVENTS_REJECTED, 'blocked invalid events cannot exceed rejected events');
    assert.ok(m.UNKNOWN_PRODUCTS_BLOCKED <= m.PAYMENT_EVENTS_REJECTED, 'blocked unknown products cannot exceed rejected events');
    assert.ok(
      m.UNAUTHORIZED_MONEY_ACTIONS_BLOCKED <= m.UNAUTHORIZED_MONEY_ACTIONS,
      'blocked money actions cannot exceed the attempts',
    );
    assert.ok(
      m.CROSS_CUSTOMER_ACCESS_BLOCKED <= m.CROSS_CUSTOMER_ACCESS_ATTEMPTS,
      'blocked cross-customer attempts cannot exceed the attempts',
    );
    assert.ok(m.EVIDENCE_BUNDLES_VALID <= m.EVIDENCE_BUNDLES_CREATED, 'valid evidence cannot exceed created evidence');
    assert.ok(m.SCENARIOS_PASSED <= m.SCENARIOS_TOTAL, 'passed scenarios cannot exceed the total');
    assert.ok(payload.consistency.ok, 'the harness consistency checks must all pass');
  });

  test('the raw artefacts were written for every scenario', () => {
    assert.ok(payload, 'the harness must have run');
    for (const s of payload.scenarios) {
      const file = path.join(RAW_DIR, `${s.id}.json`);
      assert.ok(fs.existsSync(file), `raw artefact for "${s.id}" must exist`);
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(raw.scenario, s.id);
      assert.equal(typeof raw.actual_outcome, 'string');
      assert.ok(Array.isArray(raw.checks) && raw.checks.length > 0, `raw artefact for "${s.id}" must carry checks`);
    }
    assert.ok(fs.existsSync(path.join(HERE, 'RESULTS.md')), 'RESULTS.md must exist');
  });
}
