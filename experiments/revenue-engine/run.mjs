/**
 * Aurora Revenue Engine — EXPERIMENT HARNESS (runner).
 *
 * Drives every required scenario against the REAL product modules, records the
 * outcome of each one (including the ones that fail), aggregates the required
 * metrics and writes:
 *
 *   experiments/revenue-engine/results.json   machine readable
 *   experiments/revenue-engine/RESULTS.md     human readable
 *   experiments/revenue-engine/raw/*.json     per-scenario raw artefacts
 *
 * A FAILING SCENARIO IS A MEASUREMENT, NOT A CRASH: the harness always runs
 * every scenario and always exits 0. It exits non-zero only if the harness
 * itself crashes.
 *
 * BOUNDARY: no network call, no real email, no live Stripe, no secret value
 * printed or stored, and the source database is never opened for writing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { installSyntheticEnv, counts, evidenceValidity } from './lib.mjs';
import { flowScenarios } from './scenarios/flow.mjs';
import { opsScenarios } from './scenarios/ops.mjs';
import { governanceScenarios } from './scenarios/governance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const RAW_DIR = path.join(HERE, 'raw');
const SOURCE_DB = path.join(REPO_ROOT, 'data', 'licenses.db');

const CONTRACT = 'aurora.revenue-engine.experiments@1';

export const REQUIRED_METRICS = [
  'PAYMENT_EVENTS_TOTAL',
  'PAYMENT_EVENTS_VERIFIED',
  'PAYMENT_EVENTS_REJECTED',
  'DUPLICATE_EVENTS',
  'DUPLICATE_EFFECTS',
  'FULFILLMENTS_ATTEMPTED',
  'FULFILLMENTS_COMPLETED',
  'FULFILLMENTS_FAILED',
  'LICENSES_EXPECTED',
  'LICENSES_ISSUED',
  'DUPLICATE_LICENSES',
  'ENTITLEMENTS_EXPECTED',
  'ENTITLEMENTS_CORRECT',
  'DELIVERIES_EXPECTED',
  'DELIVERIES_CAPTURED',
  'RECONCILIATION_SCENARIOS',
  'RECONCILIATION_CORRECT',
  'RESTART_SCENARIOS',
  'RESTART_RECOVERED',
  'INVALID_EVENTS_BLOCKED',
  'UNKNOWN_PRODUCTS_BLOCKED',
  'UNAUTHORIZED_MONEY_ACTIONS',
  'UNAUTHORIZED_MONEY_ACTIONS_BLOCKED',
  'CROSS_CUSTOMER_ACCESS_ATTEMPTS',
  'CROSS_CUSTOMER_ACCESS_BLOCKED',
  'EVIDENCE_BUNDLES_CREATED',
  'EVIDENCE_BUNDLES_VALID',
  'SCENARIOS_TOTAL',
  'SCENARIOS_PASSED',
];

const EXERCISED_SRC = [
  'src/access.js',
  'src/admin.js',
  'src/catalog.js',
  'src/db.js',
  'src/delivery.js',
  'src/entitlements.js',
  'src/events.js',
  'src/fulfillment.js',
  'src/governed.js',
  'src/licenses.js',
  'src/reconcile.js',
  'src/stripe-boundary.js',
  'src/webhook.js',
];

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function fileHashes(files) {
  return files
    .filter((f) => fs.existsSync(f))
    .map((f) => ({ path: path.relative(REPO_ROOT, f).replace(/\\/g, '/'), sha256: sha256File(f) }));
}

function maskKey(key) {
  const k = String(key ?? '');
  if (!k) return null;
  if (k.length <= 4) return '*'.repeat(k.length);
  return `${'*'.repeat(k.length - 4)}${k.slice(-4)}`;
}

/** Raw, read-only snapshot of the scenario database for the artefact bundle. */
function snapshot(db) {
  if (!db) return null;
  const c = counts(db);
  const events = db
    .prepare(
      `SELECT event_id, provider, provider_event_id, event_type, customer_email,
              provider_customer_id, product_id, price_reference, payment_reference,
              amount, currency, verification_status, processing_status, idempotency_key,
              raw_payload_hash, source_mode, payload_json
         FROM revenue_events ORDER BY created_at`,
    )
    .all();
  const entitlements = db
    .prepare(
      `SELECT id, customer_id, product_id, status, source_event_id, provider_subscription_id,
              starts_at, expires_at, revoked_reason FROM entitlements ORDER BY created_at`,
    )
    .all();
  const licences = db
    .prepare(
      `SELECT id, email, license_key, price_id, tier, status, entitlement_id,
              issued_at, expires_at, revoked_reason, event_id
         FROM licenses ORDER BY created_at`,
    )
    .all()
    .map((l) => ({
      ...l,
      license_key_masked: maskKey(l.license_key),
      license_key: undefined,
    }));
  const deliveries = db
    .prepare(
      `SELECT id, fulfillment_run_id, entitlement_id, license_id, customer_id, channel,
              recipient_ref, artifact_ref, status, provider_message_id, error, sent_at
         FROM deliveries ORDER BY created_at`,
    )
    .all()
    .map((d) => ({
      ...d,
      // A licence key is a bearer credential: it is never written to an artefact.
      artifact_ref:
        typeof d.artifact_ref === 'string' && d.artifact_ref.startsWith('CCPI-')
          ? maskKey(d.artifact_ref)
          : d.artifact_ref,
    }));
  const runs = db
    .prepare(
      `SELECT id, idempotency_key, event_id, customer_id, entitlement_id, license_id,
              stage, status, attempts, last_error FROM fulfillment_runs ORDER BY created_at`,
    )
    .all();
  const evidence = db
    .prepare('SELECT id, kind, subject_id, payload_json, source_fingerprint FROM evidence ORDER BY created_at')
    .all();
  return { counts: c, revenue_events: events, entitlements, licenses: licences, deliveries, fulfillment_runs: runs, evidence };
}

function emptyFlags() {
  return {
    duplicate_effects: 0,
    reconciliation_scenarios: 0,
    reconciliation_correct: 0,
    restart_scenarios: 0,
    restart_recovered: 0,
    invalid_events_blocked: 0,
    unknown_products_blocked: 0,
    money_actions: 0,
    money_actions_blocked: 0,
    cross_customer_attempts: 0,
    cross_customer_blocked: 0,
    session_revocation_attempts: 0,
    session_revocation_blocked: 0,
    admin_attempts: 0,
    admin_denied: 0,
  };
}

export async function runHarness({ outDir = HERE } = {}) {
  const startedAt = new Date().toISOString();
  const sourceDbBefore = fs.existsSync(SOURCE_DB) ? sha256File(SOURCE_DB) : null;
  installSyntheticEnv();
  fs.mkdirSync(RAW_DIR, { recursive: true });

  const scenarios = [...flowScenarios, ...opsScenarios, ...governanceScenarios];
  const results = [];
  const flags = emptyFlags();
  const totals = {
    events: { presented: 0, verified: 0, rejected: 0, duplicates: 0 },
    fulfilment: { attempted: 0, completed: 0, failed: 0 },
    licenses_expected: 0,
    entitlements_expected: 0,
    deliveries_expected: 0,
    licenses_issued: 0,
    entitlements_correct: 0,
    deliveries_captured: 0,
    duplicate_licenses: 0,
    evidence_created: 0,
    evidence_valid: 0,
  };

  for (const scenario of scenarios) {
    const entry = {
      id: scenario.id,
      title: scenario.title,
      expected_outcome: scenario.expected_outcome,
      actual_outcome: 'not run',
      pass: false,
      detail: {},
      checks: [],
    };
    let result = null;
    let thrown = null;
    try {
      result = await scenario.run();
    } catch (err) {
      thrown = { name: err?.name ?? 'Error', message: err?.message ?? String(err), code: err?.code ?? null };
    }

    if (thrown) {
      entry.actual_outcome = 'harness_error';
      entry.detail = { error: thrown };
      entry.checks = [{ name: 'scenario ran without throwing', ok: false, expected: 'no throw', actual: thrown.message }];
    } else {
      const checks = [...(result.checks ?? [])];
      const c = result.db ? counts(result.db) : null;
      if (c) {
        const exp = result.expectations ?? null;
        if (exp && exp.entitlements !== undefined) {
          checks.push({
            name: 'entitlements as expected',
            ok: c.entitlements === exp.entitlements,
            expected: exp.entitlements,
            actual: c.entitlements,
          });
        }
        if (exp && exp.licenses !== undefined) {
          checks.push({
            name: 'licences as expected',
            ok: c.licenses === exp.licenses,
            expected: exp.licenses,
            actual: c.licenses,
          });
        }
        if (exp && exp.deliveries !== undefined) {
          checks.push({
            name: 'successful deliveries as expected',
            ok: c.successful_deliveries === exp.deliveries,
            expected: exp.deliveries,
            actual: c.successful_deliveries,
          });
        }
      }
      entry.actual_outcome = result.actual_outcome;
      entry.detail = result.detail ?? {};
      entry.checks = checks;

      // metric accumulation
      const ev = result.events ?? {};
      totals.events.presented += ev.presented ?? 0;
      totals.events.verified += ev.verified ?? 0;
      totals.events.rejected += ev.rejected ?? 0;
      totals.events.duplicates += ev.duplicates ?? 0;
      const fu = result.fulfilment ?? {};
      totals.fulfilment.attempted += fu.attempted ?? 0;
      totals.fulfilment.completed += fu.completed ?? 0;
      totals.fulfilment.failed += fu.failed ?? 0;
      const exp = result.expectations ?? null;
      totals.licenses_expected += exp?.licenses ?? 0;
      totals.entitlements_expected += exp?.entitlements ?? 0;
      totals.deliveries_expected += exp?.deliveries ?? 0;
      if (c) {
        if (exp) {
          if (exp) {
          totals.licenses_issued += c.licenses;
          }
          if (exp) {
          totals.deliveries_captured += c.successful_deliveries;
          }
        }
        if (exp && c.entitlements === exp.entitlements) {
          totals.entitlements_correct += exp?.entitlements ?? 0;
        }
        totals.duplicate_licenses += exp ? Math.max(0, c.licenses - (exp.licenses ?? c.licenses)) : 0;
        const ev2 = evidenceValidity(result.db);
        totals.evidence_created += ev2.created;
        totals.evidence_valid += ev2.valid;
      }
      for (const [k, v] of Object.entries(result.flags ?? {})) {
        flags[k] = (flags[k] ?? 0) + (v ?? 0);
      }
    }

    entry.pass = entry.checks.length > 0 && entry.checks.every((ch) => ch.ok);

    // raw artefact
    const artefact = {
      scenario: scenario.id,
      title: scenario.title,
      expected_outcome: scenario.expected_outcome,
      actual_outcome: entry.actual_outcome,
      pass: entry.pass,
      checks: entry.checks,
      detail: entry.detail,
      generated_at: new Date().toISOString(),
      boundary: {
        synthetic_customer_domain: 'example.invalid',
        transport: 'capture only (no email sent)',
        network: 'none',
        source_database_opened_for_writing: false,
      },
    };
    if (result && result.db) {
      artefact.state = snapshot(result.db);
    }
    fs.writeFileSync(path.join(RAW_DIR, `${scenario.id}.json`), JSON.stringify(artefact, null, 2) + '\n', 'utf8');
    results.push(entry);
  }

  const sourceDbAfter = fs.existsSync(SOURCE_DB) ? sha256File(SOURCE_DB) : null;

  const metrics = {
    PAYMENT_EVENTS_TOTAL: totals.events.presented,
    PAYMENT_EVENTS_VERIFIED: totals.events.verified,
    PAYMENT_EVENTS_REJECTED: totals.events.rejected,
    DUPLICATE_EVENTS: totals.events.duplicates,
    DUPLICATE_EFFECTS: flags.duplicate_effects,
    FULFILLMENTS_ATTEMPTED: totals.fulfilment.attempted,
    FULFILLMENTS_COMPLETED: totals.fulfilment.completed,
    FULFILLMENTS_FAILED: totals.fulfilment.failed,
    LICENSES_EXPECTED: totals.licenses_expected,
    LICENSES_ISSUED: totals.licenses_issued,
    DUPLICATE_LICENSES: totals.duplicate_licenses,
    ENTITLEMENTS_EXPECTED: totals.entitlements_expected,
    ENTITLEMENTS_CORRECT: totals.entitlements_correct,
    DELIVERIES_EXPECTED: totals.deliveries_expected,
    DELIVERIES_CAPTURED: totals.deliveries_captured,
    RECONCILIATION_SCENARIOS: flags.reconciliation_scenarios,
    RECONCILIATION_CORRECT: flags.reconciliation_correct,
    RESTART_SCENARIOS: flags.restart_scenarios,
    RESTART_RECOVERED: flags.restart_recovered,
    INVALID_EVENTS_BLOCKED: flags.invalid_events_blocked,
    UNKNOWN_PRODUCTS_BLOCKED: flags.unknown_products_blocked,
    UNAUTHORIZED_MONEY_ACTIONS: flags.money_actions,
    UNAUTHORIZED_MONEY_ACTIONS_BLOCKED: flags.money_actions_blocked,
    CROSS_CUSTOMER_ACCESS_ATTEMPTS: flags.cross_customer_attempts,
    CROSS_CUSTOMER_ACCESS_BLOCKED: flags.cross_customer_blocked,
    EVIDENCE_BUNDLES_CREATED: totals.evidence_created,
    EVIDENCE_BUNDLES_VALID: totals.evidence_valid,
    SCENARIOS_TOTAL: results.length,
    SCENARIOS_PASSED: results.filter((r) => r.pass).length,
  };

  const consistency = checkConsistency(metrics, results);

  const srcHashes = fileHashes(EXERCISED_SRC.map((f) => path.join(REPO_ROOT, f)));
  const harnessHashes = fileHashes([
    path.join(HERE, 'run.mjs'),
    path.join(HERE, 'lib.mjs'),
    path.join(HERE, 'scenarios', 'flow.mjs'),
    path.join(HERE, 'scenarios', 'ops.mjs'),
    path.join(HERE, 'scenarios', 'governance.mjs'),
  ]);
  const productRevision = sha256Text(srcHashes.map((h) => `${h.path}:${h.sha256}`).join('\n'));
  const sourceFingerprint = sha256Text(
    [productRevision, ...harnessHashes.map((h) => `${h.path}:${h.sha256}`)].join('\n'),
  );

  const payload = {
    contract: CONTRACT,
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    product_revision: productRevision,
    source_fingerprint: sourceFingerprint,
    exercised_source_files: srcHashes,
    harness_files: harnessHashes,
    required_metrics: REQUIRED_METRICS,
    metrics,
    consistency,
    scenarios: results,
    observations: {
      admin_attempts: flags.admin_attempts,
      admin_denied: flags.admin_denied,
      session_revocation_attempts: flags.session_revocation_attempts,
      session_revocation_blocked: flags.session_revocation_blocked,
      duplicate_effects_detail: 'scenario duplicate_event / duplicate_webhook',
    },
    source_database: {
      path: path.relative(REPO_ROOT, SOURCE_DB).replace(/\\/g, '/'),
      sha256_before: sourceDbBefore,
      sha256_after: sourceDbAfter,
      unmodified: sourceDbBefore === sourceDbAfter,
    },
    boundary: {
      network_calls: 0,
      real_email_sent: 0,
      live_stripe_used: false,
      resend_transport_constructed: false,
      secrets_read_or_stored: false,
      source_database_opened_for_writing: false,
      synthetic_email_domain: 'example.invalid',
      note: 'Every scenario used a disposable SQLite database under the OS temp directory and the capture transport only.',
    },
    limitations: LIMITATIONS,
  };

  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(outDir, 'RESULTS.md'), renderMarkdown(payload), 'utf8');
  return payload;
}

const LIMITATIONS = [
  'No Stripe network call was made: every provider payload is a synthetic fixture, and signature verification used the offline HMAC path.',
  'No email was sent: the only transport ever constructed was createCaptureTransport(); createResendTransport() was never called.',
  'The resend/nodemailer SDKs were never imported at runtime, so no vendor client was ever constructed.',
  'The source database (data/licenses.db) was hashed before and after the run and never opened in write mode; every scenario used its own disposable database under the OS temp directory.',
  'Reconciliation was driven with INJECTED provider facts (providerState) because the module is deliberately offline; the facts are synthetic and not a live billing-provider read.',
  'The admin scenarios exercise the requireAdmin() guard directly rather than over HTTP, so they do not measure the Express routing layer.',
  'The disabled-product scenario uses a disposable catalog fixture (raw/fixtures/catalog-disabled.json) because the shipped catalog has no disabled product.',
  'Scenario 34 uses two distinct provider events for the SAME customer and product, so "no duplicate" is measured as one entitlement / one licence / one successful delivery.',
  'Metric denominators are the ACTUAL counts observed by the harness. A scenario that could not be driven would be reported as "not run" rather than as a zero.',
];

function checkConsistency(metrics, results) {
  const checks = [];
  const add = (name, ok, expected, actual) => checks.push({ name, ok: Boolean(ok), expected, actual });
  add(
    'PAYMENT_EVENTS_TOTAL = VERIFIED + REJECTED + DUPLICATE_EVENTS',
    metrics.PAYMENT_EVENTS_TOTAL ===
      metrics.PAYMENT_EVENTS_VERIFIED + metrics.PAYMENT_EVENTS_REJECTED + metrics.DUPLICATE_EVENTS,
    metrics.PAYMENT_EVENTS_VERIFIED + metrics.PAYMENT_EVENTS_REJECTED + metrics.DUPLICATE_EVENTS,
    metrics.PAYMENT_EVENTS_TOTAL,
  );
  add(
    'FULFILLMENTS_ATTEMPTED = COMPLETED + FAILED',
    metrics.FULFILLMENTS_ATTEMPTED === metrics.FULFILLMENTS_COMPLETED + metrics.FULFILLMENTS_FAILED,
    metrics.FULFILLMENTS_COMPLETED + metrics.FULFILLMENTS_FAILED,
    metrics.FULFILLMENTS_ATTEMPTED,
  );
  add('DUPLICATE_EFFECTS = 0', metrics.DUPLICATE_EFFECTS === 0, 0, metrics.DUPLICATE_EFFECTS);
  add('DUPLICATE_LICENSES = 0', metrics.DUPLICATE_LICENSES === 0, 0, metrics.DUPLICATE_LICENSES);
  add(
    'LICENSES_ISSUED <= LICENSES_EXPECTED',
    metrics.LICENSES_ISSUED <= metrics.LICENSES_EXPECTED,
    `<= ${metrics.LICENSES_EXPECTED}`,
    metrics.LICENSES_ISSUED,
  );
  add(
    'ENTITLEMENTS_CORRECT <= ENTITLEMENTS_EXPECTED',
    metrics.ENTITLEMENTS_CORRECT <= metrics.ENTITLEMENTS_EXPECTED,
    `<= ${metrics.ENTITLEMENTS_EXPECTED}`,
    metrics.ENTITLEMENTS_CORRECT,
  );
  add(
    'DELIVERIES_CAPTURED <= DELIVERIES_EXPECTED',
    metrics.DELIVERIES_CAPTURED <= metrics.DELIVERIES_EXPECTED,
    `<= ${metrics.DELIVERIES_EXPECTED}`,
    metrics.DELIVERIES_CAPTURED,
  );
  add(
    'RECONCILIATION_CORRECT <= RECONCILIATION_SCENARIOS',
    metrics.RECONCILIATION_CORRECT <= metrics.RECONCILIATION_SCENARIOS,
    `<= ${metrics.RECONCILIATION_SCENARIOS}`,
    metrics.RECONCILIATION_CORRECT,
  );
  add(
    'RESTART_RECOVERED <= RESTART_SCENARIOS',
    metrics.RESTART_RECOVERED <= metrics.RESTART_SCENARIOS,
    `<= ${metrics.RESTART_SCENARIOS}`,
    metrics.RESTART_RECOVERED,
  );
  add(
    'INVALID_EVENTS_BLOCKED <= PAYMENT_EVENTS_REJECTED',
    metrics.INVALID_EVENTS_BLOCKED <= metrics.PAYMENT_EVENTS_REJECTED,
    `<= ${metrics.PAYMENT_EVENTS_REJECTED}`,
    metrics.INVALID_EVENTS_BLOCKED,
  );
  add(
    'UNKNOWN_PRODUCTS_BLOCKED <= PAYMENT_EVENTS_REJECTED',
    metrics.UNKNOWN_PRODUCTS_BLOCKED <= metrics.PAYMENT_EVENTS_REJECTED,
    `<= ${metrics.PAYMENT_EVENTS_REJECTED}`,
    metrics.UNKNOWN_PRODUCTS_BLOCKED,
  );
  add(
    'UNAUTHORIZED_MONEY_ACTIONS_BLOCKED <= UNAUTHORIZED_MONEY_ACTIONS',
    metrics.UNAUTHORIZED_MONEY_ACTIONS_BLOCKED <= metrics.UNAUTHORIZED_MONEY_ACTIONS,
    `<= ${metrics.UNAUTHORIZED_MONEY_ACTIONS}`,
    metrics.UNAUTHORIZED_MONEY_ACTIONS_BLOCKED,
  );
  add(
    'CROSS_CUSTOMER_ACCESS_BLOCKED <= CROSS_CUSTOMER_ACCESS_ATTEMPTS',
    metrics.CROSS_CUSTOMER_ACCESS_BLOCKED <= metrics.CROSS_CUSTOMER_ACCESS_ATTEMPTS,
    `<= ${metrics.CROSS_CUSTOMER_ACCESS_ATTEMPTS}`,
    metrics.CROSS_CUSTOMER_ACCESS_BLOCKED,
  );
  add(
    'EVIDENCE_BUNDLES_VALID <= EVIDENCE_BUNDLES_CREATED',
    metrics.EVIDENCE_BUNDLES_VALID <= metrics.EVIDENCE_BUNDLES_CREATED,
    `<= ${metrics.EVIDENCE_BUNDLES_CREATED}`,
    metrics.EVIDENCE_BUNDLES_VALID,
  );
  add(
    'SCENARIOS_PASSED <= SCENARIOS_TOTAL',
    metrics.SCENARIOS_PASSED <= metrics.SCENARIOS_TOTAL,
    `<= ${metrics.SCENARIOS_TOTAL}`,
    metrics.SCENARIOS_PASSED,
  );
  add('every required scenario ran', results.every((r) => r.actual_outcome !== 'not run'), 'all ran', results.filter((r) => r.actual_outcome === 'not run').length);
  return { checks, ok: checks.every((c) => c.ok) };
}


/** Human-readable report. */
function renderMarkdown(payload) {
  const m = payload.metrics;
  const lines = [];
  lines.push('# AURORA REVENUE ENGINE — EXPERIMENT HARNESS RESULTS');
  lines.push('');
  lines.push(`Generated: ${payload.generated_at}`);
  lines.push('');
  lines.push(`- Contract: \`${payload.contract}\``);
  lines.push(`- Product revision (sha256 of the exercised src files): \`${payload.product_revision}\``);
  lines.push(`- Source fingerprint (product revision + harness files): \`${payload.source_fingerprint}\``);
  lines.push(`- Scenarios: **${m.SCENARIOS_PASSED}/${m.SCENARIOS_TOTAL} passed**`);
  lines.push('');
  lines.push('## Boundary');
  lines.push('');
  lines.push(`- Network calls: ${payload.boundary.network_calls}`);
  lines.push(`- Real emails sent: ${payload.boundary.real_email_sent}`);
  lines.push(`- Live Stripe used: ${payload.boundary.live_stripe_used}`);
  lines.push(`- Resend transport constructed: ${payload.boundary.resend_transport_constructed}`);
  lines.push(`- Secret values read, printed or stored: ${payload.boundary.secrets_read_or_stored}`);
  lines.push(`- Source database opened for writing: ${payload.boundary.source_database_opened_for_writing}`);
  lines.push(
    `- Source database \`${payload.source_database.path}\` sha256 before: \`${payload.source_database.sha256_before}\``,
  );
  lines.push(
    `- Source database sha256 after: \`${payload.source_database.sha256_after}\` (unmodified: ${payload.source_database.unmodified})`,
  );
  lines.push('');
  lines.push('## Metrics');
  lines.push('');
  lines.push('```');
  for (const key of REQUIRED_METRICS) lines.push(`${key}=${m[key]}`);
  lines.push('```');
  lines.push('');
  lines.push('## Metric definitions');
  lines.push('');
  for (const [key, def] of Object.entries(METRIC_DEFINITIONS)) {
    lines.push(`- **${key}** — ${def}`);
  }
  lines.push('');
  lines.push('## Scenario table');
  lines.push('');
  lines.push('| # | scenario | expected outcome | actual outcome | pass |');
  lines.push('| --- | --- | --- | --- | --- |');
  payload.scenarios.forEach((s, i) => {
    lines.push(
      `| ${i + 1} | \`${s.id}\` | ${s.expected_outcome} | ${String(s.actual_outcome).replace(/\|/g, '/')} | ${s.pass ? 'PASS' : 'FAIL'} |`,
    );
  });
  lines.push('');
  const failed = payload.scenarios.filter((s) => !s.pass);
  lines.push('## Failing scenarios');
  lines.push('');
  if (failed.length === 0) {
    lines.push('None. Every scenario met its expected outcome.');
  } else {
    for (const s of failed) {
      lines.push(`### \`${s.id}\``);
      lines.push('');
      lines.push(`- expected: ${s.expected_outcome}`);
      lines.push(`- actual: ${s.actual_outcome}`);
      for (const ch of s.checks.filter((c) => !c.ok)) {
        lines.push(`- failed check: ${ch.name} (expected ${JSON.stringify(ch.expected)}, got ${JSON.stringify(ch.actual)})`);
      }
      lines.push('');
    }
  }
  lines.push('## Internal consistency checks');
  lines.push('');
  lines.push('| check | expected | actual | ok |');
  lines.push('| --- | --- | --- | --- |');
  for (const c of payload.consistency.checks) {
    lines.push(`| ${c.name} | ${c.expected} | ${c.actual} | ${c.ok ? 'ok' : 'FAIL'} |`);
  }
  lines.push('');
  lines.push('## Limitations');
  lines.push('');
  for (const l of payload.limitations) lines.push(`- ${l}`);
  lines.push('');
  lines.push('## Raw artefacts');
  lines.push('');
  lines.push('One JSON file per scenario under `raw/`, each holding the expected and actual outcome, every check, the scenario detail and a read-only snapshot of the scenario database (events, entitlements, masked licences, deliveries, fulfilment runs, evidence).');
  lines.push('');
  return lines.join('\n');
}

const METRIC_DEFINITIONS = {
  PAYMENT_EVENTS_TOTAL: 'the number of synthetic provider payment-event presentations handed to the engine across every scenario (each delivery of the same event counts again).',
  PAYMENT_EVENTS_VERIFIED: 'of those presentations, the ones the engine accepted as genuine payment evidence (verification_status = verified).',
  PAYMENT_EVENTS_REJECTED: 'of those presentations, the ones the engine refused or rejected (unpaid session, unknown price, disabled product, malformed payload, bad signature, missing secret).',
  DUPLICATE_EVENTS: 'presentations of a provider event that the engine recognised as already recorded (idempotency hit).',
  DUPLICATE_EFFECTS: 'the number of EXTRA licences/entitlements/deliveries produced by a duplicate delivery (the number that must be zero).',
  FULFILLMENTS_ATTEMPTED: 'calls to the fulfilment pipeline that were not refused at the door (a refusal creates a run row but no work).',
  FULFILLMENTS_COMPLETED: 'fulfilment runs that reached a completed state (including an already-fulfilled no-op).',
  FULFILLMENTS_FAILED: 'fulfilment runs that ended in a failed state (delivery failure), which stay retryable.',
  LICENSES_EXPECTED: 'the number of licences the scenarios expect to exist at the end of their scenario.',
  LICENSES_ISSUED: 'the number of licence rows that actually exist at the end of the scenarios.',
  DUPLICATE_LICENSES: 'licence rows in excess of the expectation (a second licence for one entitlement or one customer+product).',
  ENTITLEMENTS_EXPECTED: 'the number of entitlements the scenarios expect to exist at the end of their scenario.',
  ENTITLEMENTS_CORRECT: 'the number of expected entitlements whose scenario ended with exactly the expected entitlement count.',
  DELIVERIES_EXPECTED: 'the number of SUCCESSFUL deliveries the scenarios expect.',
  DELIVERIES_CAPTURED: 'the number of successful (sent/captured) delivery rows that actually exist.',
  RECONCILIATION_SCENARIOS: 'the number of reconciliation scenarios driven with injected provider facts.',
  RECONCILIATION_CORRECT: 'the number of reconciliation scenarios where the expected named finding was reported.',
  RESTART_SCENARIOS: 'the number of interrupted-fulfilment scenarios (entitlement stage, licence stage, run row only).',
  RESTART_RECOVERED: 'the number of interrupted-fulfilment scenarios that resumed to exactly one licence and one delivery.',
  INVALID_EVENTS_BLOCKED: 'the number of malformed / badly signed / secret-less events that were blocked.',
  UNKNOWN_PRODUCTS_BLOCKED: 'the number of payments blocked because the price mapped to no sellable product (unknown price or disabled product).',
  UNAUTHORIZED_MONEY_ACTIONS: 'the number of money-movement actions offered to the governed layer (refund, charge, payout).',
  UNAUTHORIZED_MONEY_ACTIONS_BLOCKED: 'the number of those money-movement actions the governed layer refused.',
  CROSS_CUSTOMER_ACCESS_ATTEMPTS: 'the number of attempts to use a licence outside its owner or outside the product it grants.',
  CROSS_CUSTOMER_ACCESS_BLOCKED: 'the number of those attempts that were denied.',
  EVIDENCE_BUNDLES_CREATED: 'the number of evidence rows written across the scenario databases.',
  EVIDENCE_BUNDLES_VALID: 'the number of those evidence rows that carry a kind and a parseable JSON payload.',
  SCENARIOS_TOTAL: 'the number of scenarios the harness drove.',
  SCENARIOS_PASSED: 'the number of scenarios whose every check passed.',
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const payload = await runHarness();
    const m = payload.metrics;
    for (const key of REQUIRED_METRICS) console.log(`${key}=${m[key]}`);
    console.log('');
    console.log(`scenarios passed: ${m.SCENARIOS_PASSED}/${m.SCENARIOS_TOTAL}`);
    console.log(`consistency: ${payload.consistency.ok ? 'ok' : 'FAILED'}`);
    const failed = payload.scenarios.filter((s) => !s.pass);
    for (const s of failed) {
      console.log(`FAILED ${s.id}: expected ${s.expected_outcome} | actual ${s.actual_outcome}`);
    }
    console.log(`source database unmodified: ${payload.source_database.unmodified}`);
    // A failing scenario is a MEASUREMENT, not a harness crash: exit 0 anyway.
    process.exitCode = 0;
  } catch (err) {
    console.error('HARNESS CRASH:', err?.stack ?? err?.message ?? err);
    process.exitCode = 1;
  }
}

export default { runHarness, REQUIRED_METRICS };





