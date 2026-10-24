// Aurora Revenue Engine — PAYMENT EVENT BOUNDARY / WEBHOOK INTAKE / RECONCILIATION tests.
//
// GUARANTEES
//   * A DISPOSABLE temp database is used. `data/licenses.db` is NEVER opened.
//   * This file NEVER imports the `stripe` package and never constructs a Stripe
//     client. Signature verification is exercised through the offline HMAC path
//     in src/webhook.js, so NO network call is even possible from this suite.
//   * No secret value is printed or stored.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

import { openDb } from "../src/db.js";
import {
  VERIFICATION,
  PROCESSING,
  normalizeEvent,
  idempotencyKeyFor,
  persistEvent,
  recordEvidence,
} from "../src/events.js";
import { isPaidSession, normalizeStripeEvent, normalizeCheckoutSession } from "../src/stripe-boundary.js";
import { ingestWebhookEvent, verifyStripeSignature, promoteEventToVerified } from "../src/webhook.js";
import { reconcile, repairReconcilable, VERDICTS } from "../src/reconcile.js";

// ── test fixtures ───────────────────────────────────────────────────────────
const TEST_SECRET = "whsec_unit_test_only_not_a_real_secret";
const KNOWN_PRICE = "price_test_skill_pack_lite";
const FREE_PRICE = "price_test_starter";

// The catalog resolves literal price ids through environment variables.
process.env.PRICE_SKILL_PACK_LITE = KNOWN_PRICE;
process.env.PRICE_STARTER = FREE_PRICE;

const tmpDirs = [];
function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aurora-boundary-"));
  tmpDirs.push(dir);
  const db = openDb(path.join(dir, "boundary-test.db"));
  // The legacy licences table is not created by the schema lane; reconciliation
  // reads it when present, so create the legacy shape in the disposable DB.
  db.exec(`CREATE TABLE IF NOT EXISTS licenses (
    id TEXT PRIMARY KEY, email TEXT NOT NULL, license_key TEXT UNIQUE NOT NULL,
    price_id TEXT, tier TEXT, status TEXT DEFAULT 'active',
    stripe_customer_id TEXT, created_at TEXT DEFAULT (datetime('now'))
  )`);
  return db;
}

function sign(body, secret = TEST_SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const hmac = crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${hmac}`;
}

function checkoutEvent(overrides = {}) {
  const session = {
    id: "cs_test_123",
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    amount_total: 4900,
    currency: "usd",
    customer: "cus_test_1",
    customer_details: { email: "buyer@example.com" },
    mode: "payment",
    client_secret: "cs_test_123_secret_abcdef",
    created: 1750000000,
    line_items: { data: [{ price: { id: KNOWN_PRICE } }] },
    ...overrides,
  };
  return { id: "evt_test_1", type: "checkout.session.completed", created: 1750000000, data: { object: session } };
}

function countEvents(db) {
  return db.prepare(`SELECT COUNT(*) AS c FROM revenue_events`).get().c;
}
function countEntitlements(db) {
  return db.prepare(`SELECT COUNT(*) AS c FROM entitlements`).get().c;
}
function countLicenses(db) {
  return db.prepare(`SELECT COUNT(*) AS c FROM licenses`).get().c;
}

// ── idempotency ─────────────────────────────────────────────────────────────
test("the same provider event twice -> duplicate detected, exactly one revenue_events row", () => {
  const db = tempDb();
  const raw = checkoutEvent();
  const body = JSON.stringify(raw);

  const first = ingestWebhookEvent(db, { rawBody: body, signature: sign(body), secret: TEST_SECRET });
  assert.equal(first.outcome, "accepted");
  assert.equal(first.duplicate, false);

  const second = ingestWebhookEvent(db, { rawBody: body, signature: sign(body), secret: TEST_SECRET });
  assert.equal(second.outcome, "duplicate");
  assert.equal(second.duplicate, true);

  assert.equal(countEvents(db), 1, "exactly one revenue_events row must exist");
  assert.equal(countEntitlements(db), 0, "no entitlement may be created by the boundary");
  assert.equal(countLicenses(db), 0, "no licence may be created by the boundary");
  db.close();
});

test("the idempotency key is stable across calls and differs for different provider events", () => {
  const a = idempotencyKeyFor({ provider: "stripe", provider_event_id: "evt_1" });
  const b = idempotencyKeyFor({ provider: "stripe", provider_event_id: "evt_1" });
  const c = idempotencyKeyFor({ provider: "stripe", provider_event_id: "evt_2" });
  const d = idempotencyKeyFor({ provider: "adyen", provider_event_id: "evt_1" });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.ok(!a.includes(TEST_SECRET), "the idempotency key must not embed a secret");
});

test("persistEvent reports duplicate for a repeated provider event id", () => {
  const db = tempDb();
  const event = normalizeEvent({
    provider: "stripe",
    provider_event_id: "evt_dup_1",
    event_type: "checkout.session.completed",
    occurred_at: new Date().toISOString(),
    received_at: new Date().toISOString(),
    verification_status: VERIFICATION.VERIFIED,
    processing_status: PROCESSING.PENDING,
    source_mode: "synthetic",
    raw_payload_hash: "abc",
    payload_json: "{}",
  });
  const first = persistEvent(db, event);
  const second = persistEvent(db, { ...event, event_id: "different_id" });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(countEvents(db), 1);
  db.close();
});

// ── payment verification (fail closed) ──────────────────────────────────────
test("a complete but UNPAID session is NOT verified and creates no entitlement", () => {
  const db = tempDb();
  const raw = checkoutEvent({ payment_status: "unpaid" });
  const body = JSON.stringify(raw);
  const res = ingestWebhookEvent(db, { rawBody: body, signature: sign(body), secret: TEST_SECRET });

  assert.equal(res.outcome, "accepted");
  assert.equal(res.verified, false);
  assert.equal(res.event.verification_status, VERIFICATION.UNVERIFIED);
  assert.equal(res.event.processing_status, PROCESSING.PENDING);
  assert.equal(countEntitlements(db), 0);
  assert.equal(countLicenses(db), 0);
  db.close();
});

test("isPaidSession only accepts payment_status === 'paid' (status 'complete' is not evidence)", () => {
  assert.equal(isPaidSession({ status: "complete", payment_status: "paid" }), true);
  assert.equal(isPaidSession({ status: "complete", payment_status: "unpaid" }), false);
  assert.equal(isPaidSession({ status: "complete" }), false);
  assert.equal(isPaidSession({ status: "open", payment_status: "no_payment_required" }), false);
  assert.equal(isPaidSession(null), false);
});

test("no_payment_required is verified only for a genuinely free product", () => {
  const free = {
    id: "cs_free",
    status: "complete",
    payment_status: "no_payment_required",
    amount_total: 0,
    line_items: { data: [{ price: { id: FREE_PRICE } }] },
  };
  assert.equal(isPaidSession(free), true, "the free starter product is zero-amount");

  const paidProductNoPaymentRequired = {
    id: "cs_notfree",
    status: "complete",
    payment_status: "no_payment_required",
    amount_total: 4900,
    line_items: { data: [{ price: { id: KNOWN_PRICE } }] },
  };
  assert.equal(isPaidSession(paidProductNoPaymentRequired), false);
});

test("a genuinely paid session -> verified", () => {
  const db = tempDb();
  const raw = checkoutEvent();
  const body = JSON.stringify(raw);
  const res = ingestWebhookEvent(db, { rawBody: body, signature: sign(body), secret: TEST_SECRET });

  assert.equal(res.outcome, "accepted");
  assert.equal(res.verified, true);
  assert.equal(res.event.verification_status, VERIFICATION.VERIFIED);
  assert.equal(res.event.product_id, "skill_pack_lite");
  assert.equal(res.event.amount, 4900);
  db.close();
});

test("an unknown price -> product_id null, reported as unknown_product_mapping, no entitlement", () => {
  const db = tempDb();
  const raw = checkoutEvent({
    line_items: { data: [{ price: { id: "price_not_in_catalog" } }] },
  });
  const body = JSON.stringify(raw);
  const res = ingestWebhookEvent(db, { rawBody: body, signature: sign(body), secret: TEST_SECRET });

  assert.equal(res.outcome, "accepted");
  assert.equal(res.event.product_id, null, "an unknown price must never become a tier");
  assert.equal(countEntitlements(db), 0);
  assert.equal(countLicenses(db), 0);

  const report = reconcile(db, {
    providerState: [
      {
        provider_event_id: "evt_test_1",
        provider_customer_id: "cus_test_1",
        price_reference: "price_not_in_catalog",
        paid: true,
        amount: 4900,
        currency: "usd",
        subscription_state: null,
        occurred_at: new Date().toISOString(),
      },
    ],
  });
  assert.ok(
    report.findings.some((f) => f.type === "unknown_product_mapping"),
    "unknown price must be reported as unknown_product_mapping",
  );
  assert.equal(report.verdict, VERDICTS.BLOCKED);
  db.close();
});

// ── signature / intake fail-closed rules ────────────────────────────────────
test("invalid signature -> rejected", () => {
  const db = tempDb();
  const body = JSON.stringify(checkoutEvent());
  const res = ingestWebhookEvent(db, {
    rawBody: body,
    signature: sign(body, "whsec_a_different_secret"),
    secret: TEST_SECRET,
  });
  assert.equal(res.outcome, "invalid_signature");
  assert.equal(res.accepted, false);
  assert.equal(countEvents(db), 0, "an unverified body must not be recorded as an event");
  db.close();
});

test("missing secret -> refused (fail closed)", () => {
  const db = tempDb();
  const body = JSON.stringify(checkoutEvent());
  const res = ingestWebhookEvent(db, { rawBody: body, signature: sign(body), secret: "" });
  assert.equal(res.outcome, "no_secret");
  assert.equal(res.accepted, false);
  assert.equal(countEvents(db), 0);

  const res2 = ingestWebhookEvent(db, { rawBody: body, signature: sign(body) });
  assert.equal(res2.outcome, "no_secret");
  assert.equal(countEvents(db), 0);
  db.close();
});

test("verifyStripeSignature throws a typed error when no secret is configured", () => {
  const body = "{}";
  assert.throws(
    () => verifyStripeSignature(body, sign(body), ""),
    (err) => err.name === "WebhookSignatureError" && err.code === "no_secret",
  );
  assert.equal(verifyStripeSignature(body, sign(body), TEST_SECRET), true);
  assert.equal(verifyStripeSignature(body, "t=1,v1=deadbeef", TEST_SECRET), false);
});

test("malformed payload -> rejected but recorded", () => {
  const db = tempDb();
  const body = "{not-json";
  const res = ingestWebhookEvent(db, { rawBody: body, signature: sign(body), secret: TEST_SECRET });
  assert.equal(res.outcome, "malformed_payload");
  assert.equal(res.accepted, false);
  assert.equal(countEvents(db), 1, "the rejected attempt is still recorded for audit");
  assert.equal(countEntitlements(db), 0);
  db.close();
});

test("unsupported event type -> rejected but recorded", () => {
  const db = tempDb();
  const body = JSON.stringify({ id: "evt_unsupported_1", type: "radar.early_fraud_warning.created", data: { object: {} } });
  const res = ingestWebhookEvent(db, { rawBody: body, signature: sign(body), secret: TEST_SECRET });
  assert.equal(res.outcome, "unsupported_event");
  assert.equal(res.accepted, false);
  assert.equal(countEvents(db), 1, "the rejected attempt is still recorded for audit");
  assert.equal(countEntitlements(db), 0);
  db.close();
});

test("the stored payload_json contains no client_secret and no secret value", () => {
  const db = tempDb();
  const raw = checkoutEvent({
    client_secret: "cs_test_123_secret_abcdef",
    metadata: { note: "harmless" },
  });
  const body = JSON.stringify(raw);
  const res = ingestWebhookEvent(db, { rawBody: body, signature: sign(body), secret: TEST_SECRET });
  assert.equal(res.outcome, "accepted");

  const row = db.prepare(`SELECT payload_json, raw_payload_hash FROM revenue_events`).get();
  assert.ok(!row.payload_json.includes("client_secret"), "payload_json must not contain client_secret");
  assert.ok(!row.payload_json.includes("cs_test_123_secret_abcdef"), "the secret value must not be stored");
  assert.ok(!row.payload_json.includes(TEST_SECRET), "no webhook secret may be stored");
  assert.ok(!JSON.stringify(row).includes("whsec_"), "no secret-looking value may be stored");
  assert.ok(row.raw_payload_hash && row.raw_payload_hash.length === 64, "a sha256 fingerprint is stored");
  db.close();
});

test("an unverified event can later be promoted to verified (poll-confirmed payment)", () => {
  const db = tempDb();
  const raw = checkoutEvent({ payment_status: "unpaid" });
  const body = JSON.stringify(raw);
  const res = ingestWebhookEvent(db, { rawBody: body, signature: sign(body), secret: TEST_SECRET });
  assert.equal(res.event.verification_status, VERIFICATION.UNVERIFIED);

  const promoted = promoteEventToVerified(db, "evt_test_1", { source: "poll" });
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.event.verification_status, VERIFICATION.VERIFIED);
  assert.equal(promoted.event.processing_status, PROCESSING.PENDING);
  db.close();
});

test("recordEvidence writes an auditable link and stores no secret", () => {
  const db = tempDb();
  const ev = recordEvidence(db, "test.kind", "subject-1", { note: "ok" }, "fingerprint");
  assert.ok(ev.id);
  const row = db.prepare(`SELECT * FROM evidence WHERE id = ?`).get(ev.id);
  assert.equal(row.kind, "test.kind");
  assert.equal(row.subject_id, "subject-1");
  assert.equal(row.source_fingerprint, "fingerprint");
  db.close();
});

// ── reconciliation ───────────────────────────────────────────────────────────
function seedVerifiedEvent(db, providerEventId = "evt_test_1", price = KNOWN_PRICE) {
  const raw = checkoutEvent({ id: "cs_test_123" });
  raw.id = providerEventId;
  raw.data.object.line_items = { data: [{ price: { id: price } }] };
  const body = JSON.stringify(raw);
  return ingestWebhookEvent(db, { rawBody: body, signature: sign(body), secret: TEST_SECRET });
}

test("reconciliation detects payment_exists_but_fulfillment_missing", () => {
  const db = tempDb();
  seedVerifiedEvent(db);
  const report = reconcile(db, {
    providerState: [
      {
        provider_event_id: "evt_test_1",
        provider_customer_id: "cus_test_1",
        price_reference: KNOWN_PRICE,
        paid: true,
        amount: 4900,
        currency: "usd",
        subscription_state: null,
        occurred_at: new Date().toISOString(),
      },
    ],
  });
  assert.ok(report.findings.some((f) => f.type === "payment_exists_but_fulfillment_missing"));
  db.close();
});

test("reconciliation detects fulfillment_without_verified_payment", () => {
  const db = tempDb();
  const raw = checkoutEvent({ payment_status: "unpaid" });
  const body = JSON.stringify(raw);
  const res = ingestWebhookEvent(db, { rawBody: body, signature: sign(body), secret: TEST_SECRET });
  db.prepare(
    `INSERT INTO fulfillment_runs (id, idempotency_key, event_id, stage, status) VALUES (?, ?, ?, ?, ?)`,
  ).run("run_1", "idem_run_1", res.event.event_id, "license_email", "completed");

  const report = reconcile(db, { providerState: [] });
  assert.ok(report.findings.some((f) => f.type === "fulfillment_without_verified_payment"));
  assert.equal(report.verdict, VERDICTS.BLOCKED, "unverified fulfilment needs a human");
  db.close();
});

test("reconciliation detects subscription_cancelled_but_entitlement_active", () => {
  const db = tempDb();
  db.prepare(
    `INSERT INTO customers (id, email, email_normalized, provider, provider_customer_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("cus_1", "sub@example.com", "sub@example.com", "stripe", "cus_sub_1");
  db.prepare(
    `INSERT INTO entitlements (id, customer_id, product_id, status, provider_subscription_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("ent_1", "cus_1", "pro_annual", "active", "sub_1");

  const report = reconcile(db, {
    providerState: [
      {
        provider_event_id: "evt_sub_1",
        provider_customer_id: "cus_sub_1",
        subscription_reference: "sub_1",
        price_reference: KNOWN_PRICE,
        paid: true,
        amount: 19900,
        currency: "usd",
        subscription_state: "cancelled",
        occurred_at: new Date().toISOString(),
      },
    ],
  });
  assert.ok(report.findings.some((f) => f.type === "subscription_cancelled_but_entitlement_active"));
  db.close();
});

test("reconciliation detects subscription_active_but_entitlement_absent", () => {
  const db = tempDb();
  const report = reconcile(db, {
    providerState: [
      {
        provider_event_id: "evt_sub_2",
        provider_customer_id: "cus_sub_2",
        subscription_reference: "sub_2",
        price_reference: KNOWN_PRICE,
        paid: true,
        amount: 19900,
        currency: "usd",
        subscription_state: "active",
        occurred_at: new Date().toISOString(),
      },
    ],
  });
  assert.ok(report.findings.some((f) => f.type === "subscription_active_but_entitlement_absent"));
  db.close();
});

test("reconciliation detects duplicate_license", () => {
  const db = tempDb();
  const ins = db.prepare(
    `INSERT INTO licenses (id, email, license_key, price_id, tier, status) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  ins.run("lic_1", "dupe@example.com", "KEY-1", KNOWN_PRICE, "skill_pack_lite", "active");
  ins.run("lic_2", "dupe@example.com", "KEY-2", KNOWN_PRICE, "skill_pack_lite", "active");

  const report = reconcile(db, { providerState: [] });
  assert.ok(report.findings.some((f) => f.type === "duplicate_license"));
  assert.equal(report.verdict, VERDICTS.BLOCKED, "which licence survives is a human decision");
  db.close();
});

test("reconciliation detects missing_delivery", () => {
  const db = tempDb();
  db.prepare(
    `INSERT INTO fulfillment_runs (id, idempotency_key, stage, status) VALUES (?, ?, ?, ?)`,
  ).run("run_2", "idem_run_2", "license_email", "completed");

  const report = reconcile(db, { providerState: [] });
  assert.ok(report.findings.some((f) => f.type === "missing_delivery"));
  assert.equal(report.verdict, VERDICTS.REPAIRABLE);
  db.close();
});

test("reconciliation detects failed_email", () => {
  const db = tempDb();
  db.prepare(
    `INSERT INTO deliveries (id, fulfillment_run_id, channel, recipient_ref, status, error)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("dlv_1", "run_3", "email", "buyer@example.com", "failed", "smtp timeout");

  const report = reconcile(db, { providerState: [] });
  assert.ok(report.findings.some((f) => f.type === "failed_email"));
  db.close();
});

test("reconciliation detects orphan_customer and orphan_entitlement", () => {
  const db = tempDb();
  const ev = normalizeEvent({
    provider: "stripe",
    provider_event_id: "evt_orphan_1",
    event_type: "checkout.session.completed",
    customer_id: "cus_does_not_exist",
    customer_email: "orphan@example.com",
    product_id: "skill_pack_lite",
    occurred_at: new Date().toISOString(),
    received_at: new Date().toISOString(),
    verification_status: VERIFICATION.VERIFIED,
    processing_status: PROCESSING.PENDING,
    source_mode: "synthetic",
    raw_payload_hash: "hash",
    payload_json: "{}",
  });
  persistEvent(db, ev);
  db.prepare(
    `INSERT INTO entitlements (id, customer_id, product_id, status, source_event_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("ent_orphan", "cus_ghost", "skill_pack_lite", "active", "evt_missing");

  const report = reconcile(db, { providerState: [] });
  assert.ok(report.findings.some((f) => f.type === "orphan_customer"));
  assert.ok(report.findings.some((f) => f.type === "orphan_entitlement"));
  db.close();
});

test("reconciliation detects stale_state", () => {
  const db = tempDb();
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const ev = normalizeEvent({
    provider: "stripe",
    provider_event_id: "evt_stale_1",
    event_type: "checkout.session.completed",
    product_id: "skill_pack_lite",
    occurred_at: old,
    received_at: old,
    verification_status: VERIFICATION.VERIFIED,
    processing_status: PROCESSING.PENDING,
    source_mode: "synthetic",
    raw_payload_hash: "hash",
    payload_json: "{}",
  });
  persistEvent(db, ev);

  const report = reconcile(db, { providerState: [], staleAfterMs: 60 * 1000 });
  assert.ok(report.findings.some((f) => f.type === "stale_state"));
  db.close();
});

// ── verdict logic ───────────────────────────────────────────────────────────
test("verdict UNKNOWN when the provider state is unavailable (never CONSISTENT)", () => {
  const db = tempDb();
  const report = reconcile(db, { providerState: null });
  assert.equal(report.verdict, VERDICTS.UNKNOWN);
  assert.equal(report.provider_state_available, false);
  assert.notEqual(report.verdict, VERDICTS.CONSISTENT);
  db.close();
});

test("verdict CONSISTENT when there is nothing to find", () => {
  const db = tempDb();
  const report = reconcile(db, { providerState: [] });
  assert.equal(report.verdict, VERDICTS.CONSISTENT);
  assert.equal(report.findings.length, 0);
  db.close();
});

test("verdict REPAIRABLE when every finding has a deterministic safe correction", () => {
  const db = tempDb();
  db.prepare(
    `INSERT INTO fulfillment_runs (id, idempotency_key, stage, status) VALUES (?, ?, ?, ?)`,
  ).run("run_r", "idem_run_r", "license_email", "completed");
  const report = reconcile(db, { providerState: [] });
  assert.ok(report.findings.length > 0);
  assert.ok(report.findings.every((f) => f.repairable));
  assert.equal(report.verdict, VERDICTS.REPAIRABLE);
  db.close();
});

test("verdict BLOCKED when a finding needs a human or an authorisation decision", () => {
  const db = tempDb();
  const ins = db.prepare(
    `INSERT INTO licenses (id, email, license_key, price_id, tier, status) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  ins.run("lic_a", "b@example.com", "KEY-A", KNOWN_PRICE, "skill_pack_lite", "active");
  ins.run("lic_b", "b@example.com", "KEY-B", KNOWN_PRICE, "skill_pack_lite", "active");
  const report = reconcile(db, { providerState: [] });
  assert.equal(report.verdict, VERDICTS.BLOCKED);
  db.close();
});

// ── repair ──────────────────────────────────────────────────────────────────
test("repairReconcilable repairs a payment_exists_but_fulfillment_missing case", () => {
  const db = tempDb();
  seedVerifiedEvent(db);
  const report = reconcile(db, {
    providerState: [
      {
        provider_event_id: "evt_test_1",
        provider_customer_id: "cus_test_1",
        price_reference: KNOWN_PRICE,
        paid: true,
        amount: 4900,
        currency: "usd",
        subscription_state: null,
        occurred_at: new Date().toISOString(),
      },
    ],
  });
  assert.ok(report.findings.some((f) => f.type === "payment_exists_but_fulfillment_missing"));

  const before = db.prepare(`SELECT COUNT(*) AS c FROM fulfillment_runs`).get().c;
  const repair = repairReconcilable(db, report);
  const after = db.prepare(`SELECT COUNT(*) AS c FROM fulfillment_runs`).get().c;

  assert.ok(
    repair.applied.some((a) => a.type === "payment_exists_but_fulfillment_missing"),
    "the missing fulfilment must be repaired",
  );
  assert.equal(after, before + 1, "exactly one repair fulfilment run is created");
  assert.equal(countEntitlements(db), 0, "a repair must not mint an entitlement itself");
  db.close();
});

test("repairReconcilable does NOT repair an unknown_product_mapping case", () => {
  const db = tempDb();
  const raw = checkoutEvent({ line_items: { data: [{ price: { id: "price_not_in_catalog" } }] } });
  const body = JSON.stringify(raw);
  ingestWebhookEvent(db, { rawBody: body, signature: sign(body), secret: TEST_SECRET });

  const report = reconcile(db, {
    providerState: [
      {
        provider_event_id: "evt_test_1",
        provider_customer_id: "cus_test_1",
        price_reference: "price_not_in_catalog",
        paid: true,
        amount: 4900,
        currency: "usd",
        subscription_state: null,
        occurred_at: new Date().toISOString(),
      },
    ],
  });
  assert.ok(report.findings.some((f) => f.type === "unknown_product_mapping"));
  assert.equal(report.verdict, VERDICTS.BLOCKED);

  const repair = repairReconcilable(db, report);
  assert.ok(
    !repair.applied.some((a) => a.type === "unknown_product_mapping"),
    "an unknown product mapping must never be auto-repaired",
  );
  assert.ok(
    repair.skipped.some((s) => s.type === "unknown_product_mapping"),
    "the unknown product mapping must be reported as skipped",
  );
  assert.equal(countEntitlements(db), 0);
  db.close();
});

test("repairReconcilable never deletes data", () => {
  const db = tempDb();
  seedVerifiedEvent(db);
  const report = reconcile(db, {
    providerState: [
      {
        provider_event_id: "evt_test_1",
        provider_customer_id: "cus_test_1",
        price_reference: KNOWN_PRICE,
        paid: true,
        amount: 4900,
        currency: "usd",
        subscription_state: null,
        occurred_at: new Date().toISOString(),
      },
    ],
  });
  const eventsBefore = countEvents(db);
  repairReconcilable(db, report);
  assert.equal(countEvents(db), eventsBefore, "no revenue event may be deleted by a repair");
  db.close();
});

// ── normalisation surface ───────────────────────────────────────────────────
test("normalizeEvent produces exactly the canonical field set", () => {
  const event = normalizeEvent({
    provider: "stripe",
    provider_event_id: "evt_fields_1",
    event_type: "checkout.session.completed",
  });
  assert.deepEqual(Object.keys(event).sort(), [
    "amount",
    "currency",
    "customer_email",
    "customer_id",
    "event_id",
    "event_type",
    "idempotency_key",
    "occurred_at",
    "payload_json",
    "payment_reference",
    "price_reference",
    "processing_status",
    "product_id",
    "provider",
    "provider_customer_id",
    "provider_event_id",
    "raw_payload_hash",
    "received_at",
    "source_mode",
    "subscription_reference",
    "verification_status",
  ]);
});

test("normalizeCheckoutSession and normalizeStripeEvent agree on the payment verdict", () => {
  const session = checkoutEvent().data.object;
  const polled = normalizeCheckoutSession(session, { sourceMode: "poll" });
  const webhook = normalizeStripeEvent(checkoutEvent(), { sourceMode: "webhook" });
  assert.equal(polled.verification_status, VERIFICATION.VERIFIED);
  assert.equal(webhook.verification_status, VERIFICATION.VERIFIED);
  assert.equal(polled.product_id, "skill_pack_lite");
  assert.equal(polled.source_mode, "poll");
  assert.equal(webhook.source_mode, "webhook");
});

test("the boundary never creates an entitlement or a licence (fulfilment is another lane)", () => {
  const db = tempDb();
  const raw = checkoutEvent();
  const body = JSON.stringify(raw);
  ingestWebhookEvent(db, { rawBody: body, signature: sign(body), secret: TEST_SECRET });
  assert.equal(countEntitlements(db), 0);
  assert.equal(countLicenses(db), 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM fulfillment_runs`).get().c, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM deliveries`).get().c, 0);
  db.close();
});
