// Aurora Revenue Engine — RECONCILIATION.
//
// Compares injected provider-side facts against local state and reports named
// findings. Nothing here talks to a network: `providerState` is injected, so the
// whole module is testable offline.
//
// VERDICT LOGIC
//   CONSISTENT  - no findings.
//   REPAIRABLE  - findings exist and every one of them has a deterministic,
//                 safe correction (no money movement, no product mapping).
//   BLOCKED     - at least one finding needs a human or an authorisation
//                 decision (unknown product mapping, fulfilment without
//                 verified payment, duplicate licence, orphaned entitlement).
//   UNKNOWN     - provider state was unavailable, so no comparison could be
//                 made. Never reported as CONSISTENT.
import { VERIFICATION, PROCESSING, recordEvidence, newIdString, nowIsoString } from "./events.js";
import { resolveProductByPrice as defaultResolveProductByPrice } from "./catalog.js";

export const FINDING_TYPES = Object.freeze([
  "payment_exists_but_fulfillment_missing",
  "fulfillment_without_verified_payment",
  "subscription_cancelled_but_entitlement_active",
  "subscription_active_but_entitlement_absent",
  "duplicate_license",
  "missing_delivery",
  "failed_email",
  "unknown_product_mapping",
  "orphan_customer",
  "orphan_entitlement",
  "stale_state",
]);

export const VERDICTS = Object.freeze({
  CONSISTENT: "CONSISTENT",
  REPAIRABLE: "REPAIRABLE",
  BLOCKED: "BLOCKED",
  UNKNOWN: "UNKNOWN",
});

/** Findings that can never be auto-repaired: a human must decide. */
const BLOCKED_FINDINGS = new Set([
  "fulfillment_without_verified_payment",
  "duplicate_license",
  "unknown_product_mapping",
  "orphan_entitlement",
]);

const ACTIVE_ENTITLEMENT_STATES = new Set(["active", "issued"]);
const CANCELLED_SUB_STATES = new Set(["canceled", "cancelled"]);
const ACTIVE_SUB_STATES = new Set(["active", "trialing"]);
const FULFILLED_RUN_STATES = new Set(["completed", "succeeded", "success", "fulfilled"]);

function safeRows(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

function safeRow(db, sql, params = []) {
  try {
    return db.prepare(sql).get(...params) ?? null;
  } catch {
    return null;
  }
}

function tableExists(db, table) {
  const row = safeRow(db, `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [table]);
  return Boolean(row);
}

/** Resolve a provider price id to a catalog product. Unknown -> null (fail closed). */
function resolveProduct(priceReference, options) {
  const resolver = options.resolveProductByPrice || defaultResolveProductByPrice;
  if (!priceReference) return null;
  try {
    const product = resolver(priceReference, options.env ? { env: options.env } : {});
    if (!product || !product.product_id) return null;
    return product;
  } catch {
    return null;
  }
}

function finding(type, message, extra = {}) {
  return {
    type,
    message,
    repairable: !BLOCKED_FINDINGS.has(type),
    ...extra,
  };
}

/**
 * Reconcile local state against injected provider state.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} options
 * @param {Array|null|undefined} options.providerState  provider-side facts
 * @returns {object} report { verdict, findings, checked, providerStateAvailable }
 */
export function reconcile(db, options = {}) {
  const providerState = options.providerState;
  const providerStateAvailable = Array.isArray(providerState);
  const checkedAt = nowIsoString();

  if (!providerStateAvailable) {
    return {
      verdict: VERDICTS.UNKNOWN,
      findings: [
        finding("provider_state_unavailable", "provider state was unavailable — no comparison made", {
          repairable: false,
          type: "provider_state_unavailable",
        }),
      ],
      checked_at: checkedAt,
      provider_state_available: false,
      counts: {},
    };
  }

  const findings = [];
  const events = safeRows(db, `SELECT * FROM revenue_events`);
  const entitlements = tableExists(db, "entitlements")
    ? safeRows(db, `SELECT * FROM entitlements`)
    : [];
  const runs = tableExists(db, "fulfillment_runs") ? safeRows(db, `SELECT * FROM fulfillment_runs`) : [];
  const deliveries = tableExists(db, "deliveries") ? safeRows(db, `SELECT * FROM deliveries`) : [];
  const customers = tableExists(db, "customers") ? safeRows(db, `SELECT * FROM customers`) : [];
  const licenses = tableExists(db, "licenses") ? safeRows(db, `SELECT * FROM licenses`) : [];

  const eventByProviderId = new Map();
  for (const ev of events) {
    if (!eventByProviderId.has(ev.provider_event_id)) eventByProviderId.set(ev.provider_event_id, ev);
  }

  // ── 1. provider says paid, but there is no fulfilment for it ──────────────
  for (const fact of providerState) {
    if (!fact || fact.paid !== true) continue;
    const ev = eventByProviderId.get(fact.provider_event_id);
    const hasRun = ev ? runs.some((r) => r.event_id === ev.event_id) : false;
    const hasEntitlement = ev
      ? entitlements.some((e) => e.source_event_id === ev.event_id)
      : false;
    if (!hasRun && !hasEntitlement) {
      findings.push(
        finding(
          "payment_exists_but_fulfillment_missing",
          `provider reports a paid event ${fact.provider_event_id} with no fulfilment`,
          { provider_event_id: fact.provider_event_id, event_id: ev?.event_id ?? null },
        ),
      );
    }
  }

  // ── 2. fulfilment exists but the payment was never verified ────────────────
  for (const run of runs) {
    const ev = run.event_id ? events.find((e) => e.event_id === run.event_id) : null;
    if (ev && ev.verification_status !== VERIFICATION.VERIFIED) {
      findings.push(
        finding(
          "fulfillment_without_verified_payment",
          `fulfillment run ${run.id} exists for event ${ev.event_id} whose verification_status is ${ev.verification_status}`,
          { event_id: ev.event_id, fulfillment_run_id: run.id },
        ),
      );
    }
  }

  // ── 3/4. subscription state vs entitlement state ───────────────────────────
  const customerIdByProviderId = new Map();
  for (const c of customers) {
    if (c.provider_customer_id) customerIdByProviderId.set(c.provider_customer_id, c.id);
  }
  for (const fact of providerState) {
    if (!fact || !fact.provider_customer_id) continue;
    const state = String(fact.subscription_state ?? "").toLowerCase();
    const localCustomerId = customerIdByProviderId.get(fact.provider_customer_id) ?? null;
    const localEntitlements = entitlements.filter(
      (e) =>
        (fact.subscription_reference &&
          e.provider_subscription_id === fact.subscription_reference) ||
        (localCustomerId && e.customer_id === localCustomerId),
    );
    const active = localEntitlements.filter((e) => ACTIVE_ENTITLEMENT_STATES.has(String(e.status)));
    if (CANCELLED_SUB_STATES.has(state) && active.length > 0) {
      findings.push(
        finding(
          "subscription_cancelled_but_entitlement_active",
          `subscription ${fact.subscription_reference ?? fact.provider_customer_id} is cancelled but ${active.length} entitlement(s) are still active`,
          {
            provider_customer_id: fact.provider_customer_id,
            entitlement_ids: active.map((e) => e.id),
          },
        ),
      );
    }
    if (ACTIVE_SUB_STATES.has(state) && localEntitlements.length === 0) {
      findings.push(
        finding(
          "subscription_active_but_entitlement_absent",
          `subscription ${fact.subscription_reference ?? fact.provider_customer_id} is active but no entitlement exists locally`,
          { provider_customer_id: fact.provider_customer_id },
        ),
      );
    }
  }

  // ── 5. duplicate licences (legacy table + entitlement collisions) ──────────
  const licenseGroups = new Map();
  for (const lic of licenses) {
    if (String(lic.status ?? "active").toLowerCase() === "revoked") continue;
    const key = `${String(lic.email ?? "").toLowerCase()}|${lic.price_id ?? ""}`;
    if (!licenseGroups.has(key)) licenseGroups.set(key, []);
    licenseGroups.get(key).push(lic);
  }
  for (const [key, group] of licenseGroups) {
    if (group.length > 1) {
      findings.push(
        finding(
          "duplicate_license",
          `${group.length} active licences exist for ${key.replace("|", " / ")}`,
          { license_ids: group.map((l) => l.id), email: group[0].email ?? null },
        ),
      );
    }
  }
  const entitlementGroups = new Map();
  for (const e of entitlements) {
    if (!ACTIVE_ENTITLEMENT_STATES.has(String(e.status))) continue;
    const key = `${e.customer_id}|${e.product_id}`;
    if (!entitlementGroups.has(key)) entitlementGroups.set(key, []);
    entitlementGroups.get(key).push(e);
  }
  for (const [key, group] of entitlementGroups) {
    if (group.length > 1) {
      findings.push(
        finding(
          "duplicate_license",
          `${group.length} active entitlements exist for customer/product ${key}`,
          { entitlement_ids: group.map((e) => e.id) },
        ),
      );
    }
  }

  // ── 6. fulfilment without a delivery ──────────────────────────────────────
  for (const run of runs) {
    if (!FULFILLED_RUN_STATES.has(String(run.status).toLowerCase())) continue;
    const hasDelivery = deliveries.some((d) => d.fulfillment_run_id === run.id);
    if (!hasDelivery) {
      findings.push(
        finding(
          "missing_delivery",
          `fulfillment run ${run.id} completed but produced no delivery`,
          { fulfillment_run_id: run.id },
        ),
      );
    }
  }

  // ── 7. failed email delivery ──────────────────────────────────────────────
  for (const d of deliveries) {
    const status = String(d.status ?? "").toLowerCase();
    if (status !== "failed" && status !== "error") continue;
    if (!String(d.channel ?? "").toLowerCase().includes("email")) continue;
    findings.push(
      finding("failed_email", `email delivery ${d.id} failed: ${d.error ?? "unknown error"}`, {
        delivery_id: d.id,
        fulfillment_run_id: d.fulfillment_run_id ?? null,
      }),
    );
  }

  // ── 8. unknown product mapping ────────────────────────────────────────────
  // A price that resolves to nothing (or to a product the local records do not
  // know) is a mapping decision for a human — never a silent "unknown" tier.
  for (const ev of events) {
    if (!ev.price_reference) continue;
    if (ev.product_id) continue;
    findings.push(
      finding(
        "unknown_product_mapping",
        `event ${ev.event_id} references price ${ev.price_reference} which maps to no known product`,
        { event_id: ev.event_id, price_reference: ev.price_reference },
      ),
    );
  }
  for (const fact of providerState) {
    if (!fact || !fact.price_reference) continue;
    if (resolveProduct(fact.price_reference, options)) continue;
    if (findings.some((f) => f.type === "unknown_product_mapping" && f.price_reference === fact.price_reference)) {
      continue;
    }
    findings.push(
      finding(
        "unknown_product_mapping",
        `provider price ${fact.price_reference} maps to no known product`,
        { price_reference: fact.price_reference, provider_event_id: fact.provider_event_id ?? null },
      ),
    );
  }

  // ── 9. orphan customer ────────────────────────────────────────────────────
  const knownCustomerIds = new Set(customers.map((c) => c.id));
  const knownProviderCustomerIds = new Set(customers.map((c) => c.provider_customer_id).filter(Boolean));
  for (const ev of events) {
    if (ev.customer_id && !knownCustomerIds.has(ev.customer_id)) {
      findings.push(
        finding(
          "orphan_customer",
          `event ${ev.event_id} references customer ${ev.customer_id} which does not exist`,
          { event_id: ev.event_id, customer_id: ev.customer_id },
        ),
      );
    }
    if (
      ev.provider_customer_id &&
      knownProviderCustomerIds.size > 0 &&
      !knownProviderCustomerIds.has(ev.provider_customer_id)
    ) {
      findings.push(
        finding(
          "orphan_customer",
          `event ${ev.event_id} references provider customer ${ev.provider_customer_id} which is not tracked locally`,
          { event_id: ev.event_id, provider_customer_id: ev.provider_customer_id },
        ),
      );
    }
  }

  // ── 10. orphan entitlement (no backing revenue event) ─────────────────────
  const eventIds = new Set(events.map((e) => e.event_id));
  for (const ent of entitlements) {
    if (ent.source_event_id && !eventIds.has(ent.source_event_id)) {
      findings.push(
        finding(
          "orphan_entitlement",
          `entitlement ${ent.id} references revenue event ${ent.source_event_id} which does not exist`,
          { entitlement_id: ent.id, source_event_id: ent.source_event_id },
        ),
      );
    }
    if (ent.customer_id && knownCustomerIds.size > 0 && !knownCustomerIds.has(ent.customer_id)) {
      findings.push(
        finding(
          "orphan_entitlement",
          `entitlement ${ent.id} references customer ${ent.customer_id} which does not exist`,
          { entitlement_id: ent.id, customer_id: ent.customer_id },
        ),
      );
    }
  }

  // ── 11. stale state ───────────────────────────────────────────────────────
  const staleAfterMs = options.staleAfterMs ?? 3600 * 1000;
  const now = Date.now();
  for (const ev of events) {
    if (ev.processing_status === PROCESSING.PENDING) {
      const received = Date.parse(ev.received_at ?? "");
      if (Number.isFinite(received) && now - received > staleAfterMs) {
        findings.push(
          finding(
            "stale_state",
            `event ${ev.event_id} has been pending since ${ev.received_at}`,
            { event_id: ev.event_id },
          ),
        );
      }
    }
  }
  for (const ent of entitlements) {
    if (!ACTIVE_ENTITLEMENT_STATES.has(String(ent.status))) continue;
    const expires = Date.parse(ent.expires_at ?? "");
    if (Number.isFinite(expires) && expires < now) {
      findings.push(
        finding(
          "stale_state",
          `entitlement ${ent.id} expired at ${ent.expires_at} but is still ${ent.status}`,
          { entitlement_id: ent.id },
        ),
      );
    }
  }

  // ── verdict ───────────────────────────────────────────────────────────────
  const blocked = findings.filter((f) => !f.repairable);
  let verdict;
  if (findings.length === 0) verdict = VERDICTS.CONSISTENT;
  else if (blocked.length > 0) verdict = VERDICTS.BLOCKED;
  else verdict = VERDICTS.REPAIRABLE;

  const counts = {};
  for (const f of findings) counts[f.type] = (counts[f.type] ?? 0) + 1;

  return {
    verdict,
    findings,
    counts,
    checked_at: checkedAt,
    provider_state_available: true,
  };
}

/** Find a local revenue event by provider event id. */
function findEventByProviderId(db, providerEventId) {
  return safeRow(db, `SELECT * FROM revenue_events WHERE provider_event_id = ? LIMIT 1`, [
    providerEventId,
  ]);
}

/**
 * Apply ONLY the deterministic, safe corrections.
 *
 * Never: moves money, decides a product mapping, or deletes any row.
 */
export function repairReconcilable(db, report) {
  const applied = [];
  const skipped = [];
  if (!report || !Array.isArray(report.findings)) {
    return { applied, skipped, reason: "no report" };
  }

  for (const f of report.findings) {
    if (!f.repairable) {
      skipped.push({ type: f.type, reason: "requires a human or authorisation decision" });
      continue;
    }

    try {
      switch (f.type) {
        case "payment_exists_but_fulfillment_missing": {
          const ev =
            (f.event_id
              ? safeRow(db, `SELECT * FROM revenue_events WHERE event_id = ?`, [f.event_id])
              : null) ?? findEventByProviderId(db, f.provider_event_id);
          if (!ev) {
            skipped.push({ type: f.type, reason: "no local revenue event to attach a run to" });
            break;
          }
          if (ev.verification_status !== VERIFICATION.VERIFIED) {
            skipped.push({ type: f.type, reason: "payment is not verified — not safe to fulfil" });
            break;
          }
          const id = newIdString("run");
          const key = `repair_${ev.event_id}`;
          const already = safeRow(db, `SELECT id FROM fulfillment_runs WHERE idempotency_key = ?`, [
            key,
          ]);
          if (already) {
            skipped.push({ type: f.type, reason: "a repair run already exists" });
            break;
          }
          db.prepare(
            `INSERT INTO fulfillment_runs (id, idempotency_key, event_id, customer_id, stage, status, attempts)
             VALUES (?, ?, ?, ?, ?, ?, 0)`,
          ).run(id, key, ev.event_id, ev.customer_id, "reconcile_repair", "pending");
          recordEvidence(db, "reconcile.repaired", ev.event_id, {
            finding: f.type,
            fulfillment_run_id: id,
          });
          applied.push({ type: f.type, fulfillment_run_id: id, event_id: ev.event_id });
          break;
        }

        case "missing_delivery": {
          const run = safeRow(db, `SELECT * FROM fulfillment_runs WHERE id = ?`, [
            f.fulfillment_run_id,
          ]);
          if (!run) {
            skipped.push({ type: f.type, reason: "fulfillment run not found" });
            break;
          }
          const exists = safeRow(db, `SELECT id FROM deliveries WHERE fulfillment_run_id = ?`, [run.id]);
          if (exists) {
            skipped.push({ type: f.type, reason: "a delivery already exists" });
            break;
          }
          const customer = run.customer_id
            ? safeRow(db, `SELECT email FROM customers WHERE id = ?`, [run.customer_id])
            : null;
          const recipient = customer?.email ?? "unknown";
          const id = newIdString("dlv");
          db.prepare(
            `INSERT INTO deliveries (id, fulfillment_run_id, customer_id, channel, recipient_ref, status)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(id, run.id, run.customer_id ?? null, "email", recipient, "pending");
          recordEvidence(db, "reconcile.repaired", run.id, { finding: f.type, delivery_id: id });
          applied.push({ type: f.type, delivery_id: id, fulfillment_run_id: run.id });
          break;
        }

        case "failed_email": {
          const delivery = safeRow(db, `SELECT * FROM deliveries WHERE id = ?`, [f.delivery_id]);
          if (!delivery) {
            skipped.push({ type: f.type, reason: "delivery not found" });
            break;
          }
          db.prepare(`UPDATE deliveries SET status = ?, error = ? WHERE id = ?`).run(
            "pending",
            null,
            delivery.id,
          );
          recordEvidence(db, "reconcile.repaired", delivery.id, { finding: f.type });
          applied.push({ type: f.type, delivery_id: delivery.id });
          break;
        }

        case "subscription_cancelled_but_entitlement_active": {
          const ids = Array.isArray(f.entitlement_ids) ? f.entitlement_ids : [];
          let n = 0;
          for (const id of ids) {
            const ent = safeRow(db, `SELECT * FROM entitlements WHERE id = ?`, [id]);
            if (!ent) continue;
            if (!ACTIVE_ENTITLEMENT_STATES.has(String(ent.status))) continue;
            db.prepare(
              `UPDATE entitlements SET status = 'revoked', revoked_reason = ?, updated_at = ? WHERE id = ?`,
            ).run("provider subscription cancelled", nowIsoString(), id);
            recordEvidence(db, "reconcile.repaired", id, { finding: f.type });
            n += 1;
          }
          if (n === 0) skipped.push({ type: f.type, reason: "no active entitlement to revoke" });
          else applied.push({ type: f.type, revoked: n });
          break;
        }

        case "orphan_customer": {
          if (!f.event_id) {
            skipped.push({ type: f.type, reason: "no event to derive a customer from" });
            break;
          }
          const ev = safeRow(db, `SELECT * FROM revenue_events WHERE event_id = ?`, [f.event_id]);
          if (!ev || !ev.customer_email) {
            skipped.push({ type: f.type, reason: "no customer email to build the customer record" });
            break;
          }
          const emailNormalized = String(ev.customer_email).trim().toLowerCase();
          const existing = safeRow(
            db,
            `SELECT id FROM customers WHERE email_normalized = ? OR (provider = ? AND provider_customer_id = ?)`,
            [emailNormalized, ev.provider, ev.provider_customer_id],
          );
          if (existing) {
            skipped.push({ type: f.type, reason: "customer already exists" });
            break;
          }
          const id = newIdString("cus");
          db.prepare(
            `INSERT INTO customers (id, email, email_normalized, provider, provider_customer_id)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(
            id,
            ev.customer_email,
            emailNormalized,
            ev.provider ?? null,
            ev.provider_customer_id ?? null,
          );
          recordEvidence(db, "reconcile.repaired", id, { finding: f.type, event_id: f.event_id });
          applied.push({ type: f.type, customer_id: id });
          break;
        }

        case "stale_state": {
          if (f.entitlement_id) {
            const ent = safeRow(db, `SELECT * FROM entitlements WHERE id = ?`, [f.entitlement_id]);
            if (!ent) {
              skipped.push({ type: f.type, reason: "entitlement not found" });
              break;
            }
            db.prepare(`UPDATE entitlements SET status = 'expired', updated_at = ? WHERE id = ?`).run(
              nowIsoString(),
              ent.id,
            );
            recordEvidence(db, "reconcile.repaired", ent.id, { finding: f.type });
            applied.push({ type: f.type, entitlement_id: ent.id });
            break;
          }
          if (f.event_id) {
            db.prepare(
              `UPDATE revenue_events SET processing_status = ?, received_at = ? WHERE event_id = ?`,
            ).run(PROCESSING.PENDING, nowIsoString(), f.event_id);
            recordEvidence(db, "reconcile.repaired", f.event_id, { finding: f.type });
            applied.push({ type: f.type, event_id: f.event_id });
            break;
          }
          skipped.push({ type: f.type, reason: "nothing safe to update" });
          break;
        }

        default:
          skipped.push({ type: f.type, reason: "no deterministic correction defined" });
      }
    } catch (err) {
      skipped.push({ type: f.type, reason: `repair failed: ${err.message}` });
    }
  }

  return { applied, skipped };
}

export default {
  reconcile,
  repairReconcilable,
  FINDING_TYPES,
  VERDICTS,
};

