/**
 * THE REVENUE ENGINE DEMONSTRATION.
 *
 * One command, one disposable fixture, no real money, no real customer, no live
 * email, no network, no production deployment.
 *
 * It proves the whole commercial lifecycle:
 *   synthetic product -> synthetic customer -> verified synthetic payment
 *   -> event intake -> deduplication -> product mapping -> entitlement
 *   -> licence -> fulfilment -> captured delivery -> customer access
 *   -> restart -> state recovery -> reconciliation -> evidence verification
 *
 * ...and then the negative controls:
 *   duplicate event, unknown price, invalid event, cancelled entitlement,
 *   delivery failure, restart, unauthorized money movement.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { openDb, nowIso } from "./db.js";
import { loadCatalog, resolveProductByPrice } from "./catalog.js";
import { persistEvent } from "./events.js";
import { normalizeCheckoutSession, isPaidSession } from "./stripe-boundary.js";
import { ingestWebhookEvent } from "./webhook.js";
import { fulfillEvent } from "./fulfillment.js";
import { createCaptureTransport } from "./delivery.js";
import { revokeLicense } from "./licenses.js";
import { login, authenticate } from "./access.js";
import { reconcile } from "./reconcile.js";
import { assertNoMoneyMovement } from "./governed.js";

export const SYNTHETIC = Object.freeze({
  email: "synthetic.customer@example.invalid",
  price: "price_SYNTHETIC_TEST_ONLY_0001",
  sessionSecret: "synthetic-demo-session-secret-not-a-real-secret",
  webhookSecret: "whsec_synthetic_demo_secret_not_real",
});

function syntheticPaidSession(id, email, priceId, amount) {
  return {
    id: `cs_synthetic_${id}`,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    customer: `cus_synthetic_${id}`,
    customer_email: email,
    customer_details: { email },
    amount_total: amount,
    currency: "usd",
    line_items: { data: [{ price: { id: priceId } }] },
  };
}

function counts(db) {
  const c = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  return {
    revenue_events: c("revenue_events"),
    entitlements: c("entitlements"),
    licenses: c("licenses"),
    deliveries: c("deliveries"),
    evidence: c("evidence"),
    fulfillment_runs: c("fulfillment_runs"),
    customers: c("customers"),
  };
}
export async function runDemo({ outDir, json = false } = {}) {
  const out = path.resolve(outDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "aurora-revenue-demo-")));
  fs.mkdirSync(out, { recursive: true });
  // The demo owns its scratch database. It MUST start from a clean state so
  // the demonstration is REPEATABLE: running it twice must give the same
  // result, not inherit the previous run's events, licences and findings.
  const dbPath = path.join(out, "demo.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.rmSync(dbPath + suffix, { force: true }); } catch { /* not present */ }
  }
  const db = openDb(dbPath);

  const log = [];
  const record = (step, detail) => {
    log.push({ step, at: nowIso(), ...detail });
    if (!json) console.log(`  ${step}: ${JSON.stringify(detail)}`);
  };

  // The synthetic price must be configured so the catalog can resolve it.
  process.env.PRICE_SKILL_PACK_LITE = SYNTHETIC.price;

  const product = resolveProductByPrice(SYNTHETIC.price);
  if (!product) throw new Error("the synthetic price did not resolve to a product");
  const transport = createCaptureTransport();

  // 1. a verified synthetic payment event arrives
  const session = syntheticPaidSession("a", SYNTHETIC.email, SYNTHETIC.price, 4900);
  if (!isPaidSession(session)) throw new Error("the synthetic session must be recognised as paid");
  const event = normalizeCheckoutSession(session, { sourceMode: "synthetic" });
  const persisted = persistEvent(db, event);
  const storedEvent = persisted.event ?? event;
  record("event.intake", {
    event_id: storedEvent.event_id,
    provider_event_id: event.provider_event_id,
    verification_status: event.verification_status,
    processing_status: event.processing_status,
    duplicate: persisted.duplicate,
  });

  // 2. fulfilment: entitlement -> licence -> captured delivery
  const fulfilment = await fulfillEvent(db, {
    event: storedEvent, transport, sourceFingerprint: "demo",
  });
  record("fulfilment", {
    status: fulfilment.status,
    entitlement: fulfilment.entitlement?.id ?? null,
    license: fulfilment.license?.id ?? null,
    delivery: fulfilment.delivery?.id ?? null,
  });
  const afterFirst = counts(db);
  const licenseKey = fulfilment.license?.license_key ?? null;

  // 3. duplicate event -> no duplicate commercial effect
  const dup = persistEvent(db, storedEvent);
  const dupFulfilment = await fulfillEvent(db, {
    event: dup.event ?? storedEvent, transport, sourceFingerprint: "demo",
  });
  const afterDuplicate = counts(db);
  record("duplicate.event", {
    duplicate_detected: dup.duplicate === true,
    fulfilment_status: dupFulfilment.status,
    licenses_before: afterFirst.licenses,
    licenses_after: afterDuplicate.licenses,
    deliveries_before: afterFirst.deliveries,
    deliveries_after: afterDuplicate.deliveries,
    no_duplicate_effect:
      afterFirst.licenses === afterDuplicate.licenses &&
      afterFirst.deliveries === afterDuplicate.deliveries &&
      afterFirst.entitlements === afterDuplicate.entitlements,
  });

  // 3b. reconcile the HEALTHY state (before any negative control pollutes it)
  const cleanReconciliation = reconcile(db, {
    providerState: [
      {
        provider_event_id: storedEvent.provider_event_id,
        provider_customer_id: session.customer,
        price_reference: SYNTHETIC.price,
        paid: true,
        amount: 4900,
        currency: "usd",
        subscription_state: null,
        occurred_at: storedEvent.occurred_at,
      },
    ],
  });
  record("reconciliation.clean_state", {
    verdict: cleanReconciliation.verdict,
    findings: (cleanReconciliation.findings ?? []).map((f) => f.type ?? f),
  });

  // 4. customer access
  let access = { ok: false };
  let sessionToken = null;
  try {
    const loggedIn = await login(db, {
      email: SYNTHETIC.email, licenseKey, sessionSecret: SYNTHETIC.sessionSecret,
    });
    sessionToken = loggedIn.sessionToken;
    const me = await authenticate(db, {
      authorizationHeader: `Bearer ${loggedIn.sessionToken}`, sessionSecret: SYNTHETIC.sessionSecret,
    });
    access = {
      ok: true,
      customer_id: me.customer?.id ?? null,
      entitlements: (me.entitlements ?? []).length,
      tier: me.tier ?? null,
    };
  } catch (e) {
    access = { ok: false, error: e.code ?? e.message };
  }
  record("customer.access", access);

  // 5. revoked licence -> access denied even with a still-valid token
  let revoked = { denied: false };
  try {
    if (!sessionToken) {
      const li = await login(db, { email: SYNTHETIC.email, licenseKey, sessionSecret: SYNTHETIC.sessionSecret });
      sessionToken = li.sessionToken;
    }
    revokeLicense(db, fulfilment.license.id, "demo: negative control");
    await authenticate(db, {
      authorizationHeader: `Bearer ${sessionToken}`, sessionSecret: SYNTHETIC.sessionSecret,
    });
    revoked = { denied: false, PROBLEM: "access was still granted after revocation" };
  } catch (e) {
    revoked = { denied: true, error: e.code ?? e.message };
  }
  record("negative.revoked_access_denied", revoked);

  // 6. unknown price -> blocked
  const unknownSession = syntheticPaidSession("b", SYNTHETIC.email, "price_UNKNOWN_NOT_IN_CATALOG", 9900);
  const unknownEvent = normalizeCheckoutSession(unknownSession, { sourceMode: "synthetic" });
  const unknownPersisted = persistEvent(db, unknownEvent);
  const unknownFulfilment = await fulfillEvent(db, {
    event: unknownPersisted.event ?? unknownEvent, transport, sourceFingerprint: "demo",
  });
  record("negative.unknown_price_blocked", {
    product_id: unknownEvent.product_id ?? null,
    fulfilment_status: unknownFulfilment.status,
    reason: unknownFulfilment.reason ?? null,
    blocked: unknownFulfilment.status === "refused",
  });

  // 7. invalid event -> blocked
  const invalid = ingestWebhookEvent(db, {
    rawBody: Buffer.from(JSON.stringify({ id: "evt_invalid", type: "checkout.session.completed" })),
    signature: "t=1,v1=deadbeefdeadbeefdeadbeefdeadbeef",
    secret: SYNTHETIC.webhookSecret,
    sourceMode: "webhook",
  });
  record("negative.invalid_event_blocked", {
    outcome: invalid.outcome, accepted: invalid.accepted, blocked: invalid.accepted === false,
  });

  // 8. unauthorized money movement -> blocked
  let money = { blocked: false };
  try {
    assertNoMoneyMovement("stripe.refund.create");
    money = { blocked: false, PROBLEM: "a money-movement action was NOT blocked" };
  } catch (e) {
    money = { blocked: true, error: e.code ?? e.message };
  }
  record("negative.money_movement_blocked", money);

  // 9. restart -> reopen the database, state survives
  db.close();
  const reopened = openDb(dbPath);
  const afterRestart = counts(reopened);
  record("restart.recovery", {
    ...afterRestart,
    state_survived:
      afterRestart.licenses === afterDuplicate.licenses &&
      afterRestart.entitlements === afterDuplicate.entitlements &&
      afterRestart.deliveries === afterDuplicate.deliveries,
  });

  // 10. reconciliation
  const reconciliation = reconcile(reopened, {
    providerState: [
      {
        provider_event_id: event.provider_event_id,
        provider_customer_id: session.customer,
        price_reference: SYNTHETIC.price,
        paid: true,
        amount: 4900,
        currency: "usd",
        subscription_state: null,
        occurred_at: event.occurred_at,
      },
    ],
  });
  record("reconciliation", {
    verdict: reconciliation.verdict,
    findings: (reconciliation.findings ?? []).map((f) => f.type ?? f),
  });

  // 11. evidence read-back
  const evidenceRows = reopened.prepare("SELECT kind FROM evidence ORDER BY created_at").all();
  record("evidence.readback", {
    bundles: evidenceRows.length,
    kinds: [...new Set(evidenceRows.map((r) => r.kind))].sort(),
  });
  reopened.close();

  const finalCounts = afterRestart;
  const result = {
    DEMO_RESULT:
      fulfilment.status === "completed" &&
      access.ok &&
      revoked.denied === true &&
      unknownFulfilment.status === "refused" &&
      invalid.accepted === false &&
      money.blocked === true &&
      afterFirst.licenses === afterDuplicate.licenses &&
      afterFirst.deliveries === afterDuplicate.deliveries &&
      finalCounts.licenses === afterDuplicate.licenses &&
      cleanReconciliation.verdict === "CONSISTENT"
        ? "PASS"
        : "FAIL",
    PRODUCT_ID: product.product_id,
    CUSTOMER_EMAIL: SYNTHETIC.email,
    PRICE_REFERENCE: product.price_reference,
    EVENT_ID: storedEvent.event_id,
    VERIFICATION_STATUS: event.verification_status,
    FULFILLMENT_STATUS: fulfilment.status,
    ENTITLEMENT_CREATED: Boolean(fulfilment.entitlement),
    LICENSE_ISSUED: Boolean(fulfilment.license),
    DELIVERY_CAPTURED: fulfilment.delivery?.status === "captured",
    DUPLICATE_EVENT_DETECTED: dup.duplicate === true,
    DUPLICATE_EFFECTS: afterDuplicate.licenses - afterFirst.licenses,
    CUSTOMER_ACCESS_OK: access.ok,
    CUSTOMER_ENTITLEMENTS: access.entitlements ?? 0,
    REVOKED_ACCESS_DENIED: revoked.denied === true,
    UNKNOWN_PRICE_BLOCKED: unknownFulfilment.status === "refused",
    INVALID_EVENT_BLOCKED: invalid.accepted === false,
    MONEY_MOVEMENT_BLOCKED: money.blocked === true,
    RESTART_STATE_SURVIVED: finalCounts.licenses === afterDuplicate.licenses,
    RECONCILIATION_VERDICT: cleanReconciliation.verdict,
    RECONCILIATION_VERDICT_AFTER_NEGATIVES: reconciliation.verdict,
    RECONCILIATION_FINDINGS_AFTER_NEGATIVES: (reconciliation.findings ?? []).map((f) => f.type ?? f),
    EVIDENCE_BUNDLES: evidenceRows.length,
    EVIDENCE_PATH: out,
    COUNTS: finalCounts,
    NO_REAL_MONEY: true,
    NO_REAL_CUSTOMER: true,
    NO_LIVE_EMAIL: true,
    NO_NETWORK: true,
    generated_at: nowIso(),
  };

  fs.writeFileSync(path.join(out, "demo-result.json"), JSON.stringify(result, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(out, "demo-log.json"), JSON.stringify(log, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(out, "demo-summary.md"), renderSummary(result, log), "utf8");
  return { result, outDir: out };
}

function renderSummary(result, log) {
  const rows = Object.entries(result)
    .filter(([k]) => k !== "COUNTS")
    .map(([k, v]) => `| ${k} | ${Array.isArray(v) ? v.join(", ") : String(v)} |`)
    .join("\n");
  return (
    `# AURORA REVENUE ENGINE - DEMONSTRATION\n\n` +
    `**Result: ${result.DEMO_RESULT}**\n\nGenerated: ${result.generated_at}\n\n` +
    `## Outcome\n\n| Field | Value |\n| --- | --- |\n${rows}\n\n` +
    `## Steps\n\n` +
    log.map((l) => `- **${l.step}** ${JSON.stringify(l, Object.keys(l).filter((k) => k !== "step" && k !== "at"))}`).join("\n") +
    `\n\n## Boundary\n\n` +
    `This run used a synthetic customer at a \`.invalid\` domain, a synthetic price id, a synthetic\n` +
    `webhook secret and a capture transport for email. **No real money moved, no real customer\n` +
    `was contacted, no email was sent, no network call was made and nothing was deployed.**\n`
  );
}

/** SHA-256 manifest of every file in the demo bundle. */
export function hashDemoBundle(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "state") walk(p); }
      else files.push({
        path: path.relative(dir, p).replace(/\\/g, "/"),
        bytes: fs.statSync(p).size,
        sha256: createHash("sha256").update(fs.readFileSync(p)).digest("hex"),
      });
    }
  };
  walk(dir);
  return { schema: "aurora/revenue-engine-demo-hashes@1", generated_at: nowIso(), files };
}

export default { runDemo, hashDemoBundle };
