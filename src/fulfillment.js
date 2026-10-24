// ─────────────────────────────────────────────────────────────────────────────
// Aurora Revenue Engine — FULFILLMENT PIPELINE
//
//   PAYMENT (revenue_events)  ->  ENTITLEMENT  ->  LICENSE  ->  DELIVERY
//
// The pipeline is the heart of the product. It turns ONE verified provider
// event into exactly one entitlement, exactly one licence and exactly one
// delivery — no matter how many times it is run.
//
// STAGES: started -> entitlement -> license -> delivery -> complete | failed
//
// REFUSALS (no entitlement is created):
//   * the event is not VERIFIED
//   * the product is unknown (unknown price id / unknown product id)
//   * the product is disabled
//
// IDEMPOTENCY
//   The run is driven by fulfillment_runs.idempotency_key, derived ONLY from
//   the provider event identity (provider + provider_event_id). Re-running the
//   same event resumes the existing run and creates nothing new.
//
// RESTART SAFETY
//   If a run is left at an intermediate stage (the process died), a later call
//   with the same event reads the existing run and CONTINUES from its stage.
//   Every stage is individually idempotent, so resuming can never duplicate a
//   licence or a delivery.
// ─────────────────────────────────────────────────────────────────────────────

import { nowIso, newId, sha256 } from './db.js';
import { recordEvidence, VERIFICATION } from './events.js';
import { getProduct, resolveProductByPrice, assertProductEnabled, CatalogError } from './catalog.js';
import { activateEntitlement, ensureCustomer, getEntitlement } from './entitlements.js';
import { issueLicense, getLicense, findLicenseByEntitlement } from './licenses.js';
import { deliver, getDelivery, listDeliveries, createCaptureTransport } from './delivery.js';

/** Canonical pipeline stage vocabulary. */
export const STAGES = Object.freeze([
  'started',
  'entitlement',
  'license',
  'delivery',
  'complete',
  'failed',
  'refused',
]);

/** Idempotency scope for a fulfilment run. */
export const FULFILLMENT_SCOPE = 'fulfillment.run';

/** Typed error for pipeline refusals. */
export class FulfillmentError extends Error {
  constructor(code, message, details = {}) {
    super(message || code);
    this.name = 'FulfillmentError';
    this.code = code;
    this.details = details;
  }
}

/**
 * The STABLE idempotency key of a fulfilment run.
 *
 * Derived ONLY from the provider event identity — never from a payload body,
 * never from a timestamp, never from a secret. Two deliveries of the same
 * provider event therefore always map to the same run.
 */
export function fulfillmentKeyFor(event) {
  const provider = String(event?.provider ?? '').trim();
  const providerEventId = String(event?.provider_event_id ?? '').trim();
  if (!provider || !providerEventId) {
    throw new FulfillmentError(
      'fulfillment.event_identity_missing',
      'a fulfilment run requires provider and provider_event_id',
    );
  }
  return `ful_${sha256(`${provider}|${providerEventId}`)}`;
}

/**
 * Resolve the product an event refers to.
 * Fails closed: an unknown price id or unknown product id resolves to null.
 */
export function resolveProductForEvent(event, catalogOptions = {}) {
  if (!event) return null;
  if (event.product_id) {
    const product = getProduct(event.product_id, catalogOptions);
    if (product) return product;
    return null;
  }
  const reference = event.price_reference ? String(event.price_reference).trim() : '';
  if (!reference) return null;
  // price_reference is normally an ENVIRONMENT VARIABLE NAME; the literal
  // price id is resolved from the environment. A direct price id also works.
  const env = catalogOptions.env ?? process.env;
  const configured = env[reference];
  if (configured) {
    const byEnv = resolveProductByPrice(configured, catalogOptions);
    if (byEnv) return byEnv;
  }
  return resolveProductByPrice(reference, catalogOptions);
}

function rowToRun(row) {
  return row ? { ...row } : null;
}

/** Read the existing run for an idempotency key. */
export function getRunByKey(db, idempotencyKey) {
  if (!idempotencyKey) return null;
  return rowToRun(db.prepare(`SELECT * FROM fulfillment_runs WHERE idempotency_key = ?`).get(idempotencyKey));
}

/** Read the existing run for an event id. */
export function getRunByEvent(db, eventId) {
  if (!eventId) return null;
  return rowToRun(
    db.prepare(`SELECT * FROM fulfillment_runs WHERE event_id = ? ORDER BY created_at DESC LIMIT 1`).get(eventId),
  );
}

/** All runs for an event. */
export function listRuns(db, eventId) {
  if (!eventId) return [];
  return db.prepare(`SELECT * FROM fulfillment_runs WHERE event_id = ? ORDER BY created_at ASC`).all(eventId).map(rowToRun);
}

/**
 * Record a stage transition on the run row and write the matching evidence.
 * Every stage transition MUST leave evidence.
 */
function advanceStage(db, run, stage, patch = {}) {
  const ts = nowIso();
  db.prepare(
    `UPDATE fulfillment_runs
        SET stage = ?, status = ?, entitlement_id = ?, license_id = ?,
            attempts = attempts + 1, last_error = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    stage,
    patch.status ?? run.status ?? 'running',
    patch.entitlement_id ?? run.entitlement_id ?? null,
    patch.license_id ?? run.license_id ?? null,
    patch.last_error ?? null,
    ts,
    run.id,
  );
  const updated = rowToRun(db.prepare(`SELECT * FROM fulfillment_runs WHERE id = ?`).get(run.id));
  recordEvidence(
    db,
    `fulfillment.stage.${stage}`,
    run.id,
    {
      stage,
      status: updated.status,
      event_id: updated.event_id,
      entitlement_id: updated.entitlement_id,
      license_id: updated.license_id,
      idempotency_key: updated.idempotency_key,
      last_error: updated.last_error ?? null,
    },
    patch.sourceFingerprint ?? null,
  );
  return updated;
}

/**
 * Find or create the run row for an idempotency key.
 * This is what makes the pipeline RESUMABLE: the run row is the memory of
 * where the pipeline got to.
 */
function ensureRun(db, { idemKey, eventId }) {
  const existing = getRunByKey(db, idemKey);
  if (existing) return existing;
  const id = newId('ful');
  const ts = nowIso();
  db.prepare(
    `INSERT INTO fulfillment_runs
       (id, idempotency_key, event_id, customer_id, entitlement_id, license_id,
        stage, status, attempts, last_error, created_at, updated_at)
     VALUES (?, ?, ?, NULL, NULL, NULL, 'started', 'running', 0, NULL, ?, ?)`,
  ).run(id, idemKey, eventId ?? null, ts, ts);
  db.prepare(
    `INSERT OR IGNORE INTO idempotency_keys (key, scope, result_ref) VALUES (?, ?, ?)`,
  ).run(idemKey, FULFILLMENT_SCOPE, id);
  const created = rowToRun(db.prepare(`SELECT * FROM fulfillment_runs WHERE id = ?`).get(id));
  recordEvidence(
    db,
    'fulfillment.stage.started',
    created.id,
    { stage: 'started', status: created.status, event_id: created.event_id, idempotency_key: idemKey },
    null,
  );
  return created;
}

/**
 * Run the full fulfilment pipeline for ONE provider event.
 *
 * @param {object} db
 * @param {object} opts
 * @param {object} opts.event       the normalised revenue event
 * @param {object} [opts.transport] the delivery transport (default: capture)
 * @param {string} [opts.sourceFingerprint] evidence fingerprint (no secrets)
 * @param {string} [opts.channel]   delivery channel (default 'email')
 * @param {object} [opts.catalogOptions] catalog overrides (filePath/env)
 * @returns {Promise<{status:string, entitlement:object|null, license:object|null,
 *   delivery:object|null, fulfillment_run:object, reason?:string, code?:string}>}
 */
export async function fulfillEvent(
  db,
  { event, transport, sourceFingerprint, channel = 'email', customer, catalogOptions = {} } = {},
) {
  if (!db) throw new TypeError('fulfillEvent(db, ...) requires a db handle');
  if (!event) throw new FulfillmentError('fulfillment.event_missing', 'an event is required');

  const transportToUse = transport ?? createCaptureTransport();
  const idemKey = fulfillmentKeyFor(event);
  const eventId = event.event_id ?? null;

  const refuse = (reason, code) => {
    const run = ensureRun(db, { idemKey, eventId });
    const updated = advanceStage(db, run, 'refused', {
      status: 'refused',
      last_error: reason,
      sourceFingerprint,
    });
    return {
      status: 'refused',
      reason,
      code,
      entitlement: null,
      license: null,
      delivery: null,
      fulfillment_run: updated,
    };
  };

  // ── resolve the product (fail closed) ────────────────────────────────────
  const product = resolveProductForEvent(event, catalogOptions);
  if (!product) {
    return refuse('unknown product or price', 'fulfillment.unknown_product');
  }

  try {
    assertProductEnabled(product, catalogOptions);
  } catch (err) {
    if (err instanceof CatalogError) {
      return refuse(err.message, err.code);
    }
    throw err;
  }

  const verification = String(event.verification_status ?? '').trim();
  if (verification !== VERIFICATION.VERIFIED) {
    return refuse(
      `event verification_status is "${verification || 'unknown'}", not "${VERIFICATION.VERIFIED}"`,
      'fulfillment.event_not_verified',
    );
  }

// ── the run row (created once, then resumed) ─────────────────────────────
  let run = ensureRun(db, { idemKey, eventId });
  if (run.stage === 'complete' && run.status === 'completed') {
    // Already fulfilled — nothing new is created.
    const entitlement = run.entitlement_id ? getEntitlement(db, run.entitlement_id) : null;
    const license = run.license_id ? getLicense(db, run.license_id) : null;
    const successful = entitlement
      ? (listDeliveries(db, entitlement.id).find((d) => d.status === 'sent' || d.status === 'captured') ?? null)
      : null;
    return {
      status: 'already_fulfilled',
      entitlement,
      license,
      delivery: successful,
      fulfillment_run: run,
    };
  }

  // ── customer ─────────────────────────────────────────────────────────────
  let customerRow;
  try {
    customerRow = customer
      ? customer
      : ensureCustomer(db, {
          email: event.customer_email,
          provider: event.provider,
          providerCustomerId: event.provider_customer_id,
        });
  } catch (err) {
    run = advanceStage(db, run, 'failed', {
      status: 'failed',
      last_error: err.message,
      sourceFingerprint,
    });
    return {
      status: 'failed',
      reason: err.message,
      code: err.code ?? 'fulfillment.customer_identity_failed',
      entitlement: null,
      license: null,
      delivery: null,
      fulfillment_run: run,
    };
  }

  db.prepare(`UPDATE fulfillment_runs SET customer_id = ?, updated_at = ? WHERE id = ?`).run(
    customerRow.id,
    nowIso(),
    run.id,
  );
  run = { ...run, customer_id: customerRow.id };

  // ── stage: entitlement ───────────────────────────────────────────────────
  let entitlement = run.entitlement_id ? getEntitlement(db, run.entitlement_id) : null;
  if (!entitlement) {
    entitlement = activateEntitlement(db, { event, product, customer: customerRow });
  }
  run = advanceStage(db, run, 'entitlement', {
    status: 'running',
    entitlement_id: entitlement.id,
    sourceFingerprint,
  });

  // ── stage: licence ───────────────────────────────────────────────────────
  let license = run.license_id ? getLicense(db, run.license_id) : null;
  if (!license) license = findLicenseByEntitlement(db, entitlement.id);
  if (!license) {
    license = issueLicense(db, { entitlement, customer: customerRow, product, event });
  }
  run = advanceStage(db, run, 'license', {
    status: 'running',
    entitlement_id: entitlement.id,
    license_id: license.id,
    sourceFingerprint,
  });

  // ── stage: delivery ──────────────────────────────────────────────────────
  let delivery;
  try {
    delivery = await deliver(db, {
      entitlement,
      license,
      customer: customerRow,
      transport: transportToUse,
      artifact: { license_key: license.license_key, ref: license.license_key },
      channel,
      message: { to: customerRow.email },
    });
  } catch (err) {
    run = advanceStage(db, run, 'license', {
      status: 'failed',
      last_error: err.message,
      sourceFingerprint,
    });
    return {
      status: 'failed',
      reason: err.message,
      code: err.code ?? 'fulfillment.delivery_failed',
      entitlement,
      license,
      delivery: null,
      fulfillment_run: run,
    };
  }

  if (!delivery || delivery.status === 'failed') {
    // The licence stays intact; the run is retryable.
    recordEvidence(
      db,
      'fulfillment.delivery.failed',
      run.id,
      {
        entitlement_id: entitlement.id,
        license_id: license.id,
        channel,
        error: delivery?.error ?? 'delivery failed',
      },
      sourceFingerprint ?? null,
    );
    run = advanceStage(db, run, 'license', {
      status: 'failed',
      last_error: delivery?.error ?? 'delivery failed',
      sourceFingerprint,
    });
    return {
      status: 'failed',
      reason: delivery?.error ?? 'delivery failed',
      code: 'fulfillment.delivery_failed',
      entitlement,
      license,
      delivery: delivery ?? null,
      fulfillment_run: run,
    };
  }

  db.prepare(`UPDATE deliveries SET fulfillment_run_id = ? WHERE id = ?`).run(run.id, delivery.id);
  delivery = getDelivery(db, delivery.id);

  // The licence becomes ACTIVE once it has been delivered.
  if (license.status === 'issued') {
    db.prepare(`UPDATE licenses SET status = 'active' WHERE id = ?`).run(license.id);
    license = getLicense(db, license.id);
  }

  run = advanceStage(db, run, 'delivery', {
    status: 'running',
    entitlement_id: entitlement.id,
    license_id: license.id,
    sourceFingerprint,
  });

  run = advanceStage(db, run, 'complete', {
    status: 'completed',
    entitlement_id: entitlement.id,
    license_id: license.id,
    sourceFingerprint,
  });

  return {
    status: 'completed',
    entitlement,
    license,
    delivery,
    fulfillment_run: run,
  };
}

export default {
  STAGES,
  FULFILLMENT_SCOPE,
  FulfillmentError,
  fulfillmentKeyFor,
  resolveProductForEvent,
  fulfillEvent,
  getRunByKey,
  getRunByEvent,
  listRuns,
};
