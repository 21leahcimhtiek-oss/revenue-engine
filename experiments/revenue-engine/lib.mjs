/**
 * Aurora Revenue Engine — EXPERIMENT HARNESS (shared library)
 *
 * Every helper here is OFFLINE BY CONSTRUCTION:
 *   * no network call is ever made;
 *   * no email transport is ever constructed (capture transport only);
 *   * every scenario gets its OWN disposable SQLite database in the OS temp dir;
 *   * the source database (data/licenses.db) is NEVER opened in write mode;
 *   * no secret value is ever printed or written to an artefact.
 *
 * Synthetic identities only: `.invalid` e-mail domains and obviously fake
 * price ids. Environment variable NAMES are reported; values are not.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../../src/db.js';

export const SYNTHETIC = Object.freeze({
  emailA: 'synthetic.buyer.a@example.invalid',
  emailB: 'synthetic.buyer.b@example.invalid',
  priceLite: 'price_SYNTHETIC_EXPERIMENT_LITE',
  priceStd: 'price_SYNTHETIC_EXPERIMENT_STD',
  priceUnknown: 'price_SYNTHETIC_EXPERIMENT_UNKNOWN',
  priceDisabled: 'price_SYNTHETIC_EXPERIMENT_DISABLED',
});

/** Environment variable NAMES only — never a value. */
export const ENV_NAMES = Object.freeze({
  lite: 'PRICE_SKILL_PACK_LITE',
  std: 'PRICE_SKILL_PACK_STD',
  elite: 'PRICE_SKILL_PACK_ELITE',
  pro: 'PRICE_PRO_ANNUAL',
  mcp: 'PRICE_MCP_SUITE',
  starter: 'PRICE_STARTER',
  disabled: 'PRICE_EXPERIMENT_DISABLED',
});

/**
 * Install the synthetic price configuration for the run.
 * The values are obviously fake and are never persisted to an artefact.
 */
export function installSyntheticEnv() {
  process.env[ENV_NAMES.lite] = SYNTHETIC.priceLite;
  process.env[ENV_NAMES.std] = SYNTHETIC.priceStd;
  process.env[ENV_NAMES.elite] = 'price_SYNTHETIC_EXPERIMENT_ELITE';
  process.env[ENV_NAMES.pro] = 'price_SYNTHETIC_EXPERIMENT_PRO';
  process.env[ENV_NAMES.mcp] = 'price_SYNTHETIC_EXPERIMENT_MCP';
  process.env[ENV_NAMES.starter] = 'price_SYNTHETIC_EXPERIMENT_STARTER';
  process.env[ENV_NAMES.disabled] = SYNTHETIC.priceDisabled;
  return { env_names: ENV_NAMES };
}

/** A disposable database in the OS temp dir. Never the source database. */
export function freshDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aurora-rexp-${label}-`));
  const dbPath = path.join(dir, 'experiment.db');
  const db = openDb(dbPath);
  return { db, dbPath, dir };
}

/** Row counts of the tables the experiment cares about. */
export function counts(db) {
  const c = (sql) => db.prepare(sql).get().n;
  return {
    revenue_events: c('SELECT COUNT(*) AS n FROM revenue_events'),
    entitlements: c('SELECT COUNT(*) AS n FROM entitlements'),
    licenses: c('SELECT COUNT(*) AS n FROM licenses'),
    deliveries: c('SELECT COUNT(*) AS n FROM deliveries'),
    successful_deliveries: c(
      "SELECT COUNT(*) AS n FROM deliveries WHERE status IN ('sent','captured')",
    ),
    failed_deliveries: c("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'failed'"),
    fulfillment_runs: c('SELECT COUNT(*) AS n FROM fulfillment_runs'),
    customers: c('SELECT COUNT(*) AS n FROM customers'),
    evidence: c('SELECT COUNT(*) AS n FROM evidence'),
  };
}

/** A synthetic checkout session. `overrides` may break it on purpose. */
export function paidSession(id, email, priceId, overrides = {}) {
  return {
    id: `cs_synthetic_${id}`,
    object: 'checkout.session',
    status: 'complete',
    payment_status: 'paid',
    mode: 'payment',
    customer: `cus_synthetic_${id}`,
    customer_email: email,
    customer_details: { email },
    amount_total: 4900,
    currency: 'usd',
    line_items: { data: [{ price: { id: priceId } }] },
    created: 1767225600,
    ...overrides,
  };
}

/** One check in a scenario. */
export const check = (name, ok, expected, actual) => ({
  name,
  ok: Boolean(ok),
  expected,
  actual,
});

/** Count the evidence rows that are structurally valid (JSON payload + kind). */
export function evidenceValidity(db) {
  const rows = db.prepare('SELECT kind, payload_json FROM evidence').all();
  let valid = 0;
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.payload_json);
      if (r.kind && parsed !== null && parsed !== undefined) valid += 1;
    } catch {
      /* invalid evidence is counted as invalid, never silently dropped */
    }
  }
  return { created: rows.length, valid };
}
