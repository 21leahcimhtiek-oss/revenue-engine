// Revenue Engine — webhook + license + ccpi login server (scaffold)
import dotenv from "dotenv";
dotenv.config({ path: "C:/Users/keith/master.env" });
import express from "express";
import Stripe from "stripe";
import Database from "better-sqlite3";
import { SignJWT, jwtVerify } from "jose";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sendLicenseEmail } from "./email.js";
import { sendStarterPackEmail } from "./starterpack.js";
import { runCampaign, recordStage } from "./campaign.js";
import { ingestLeads, listLeads } from "./leads.js";
import { logMemory, queryMemory, getMemory, updateMemory, getLastRows, db as memoryDb } from "./memory.js";
import { validateEmail, validateAmount, validateStatus, validateEnv, bodyValidator } from "./validation.js";
import { enqueuePost, processQueue, getQueueStats, getDeadLetter, clearDeadLetter, validateManifest } from "./publisher.js";
import { calculateEngagement, analyzeRevenue, scoreLeads, generateRecommendations, runFullAnalytics } from "./analytics.js";
import { checkHealth, autoRepair, ensurePriceIds, rotateLogs } from "./watchdog.js";
import { openDb, migrate } from "./db.js";
import { listProducts, resolveProductByPrice } from "./catalog.js";
import { persistEvent, VERIFICATION, PROCESSING } from "./events.js";
import { normalizeCheckoutSession, isPaidSession, extractPriceId } from "./stripe-boundary.js";
import { ingestWebhookEvent } from "./webhook.js";
import { fulfillEvent } from "./fulfillment.js";
import { createCaptureTransport } from "./delivery.js";
import { loginHandler, meHandler } from "./access.js";
import { healthHandler, syncHandler, reconcileHandler, customerHandler, entitlementHandler, licenseHandler, evidenceHandler, requireAdmin } from "./admin.js";
import { assertNoMoneyMovement } from "./governed.js";
import { reconcile } from "./reconcile.js";

// The database location is configurable so a test, a demo or a smoke run uses a
// DISPOSABLE database and never the live one.
const DB_FILE = process.env.REVENUE_DB_PATH ?? "data/licenses.db";
const db = new Database(DB_FILE);
// Apply the additive migrations so the commercial tables (customers,
// revenue_events, entitlements, fulfillment_runs, deliveries, evidence,
// idempotency_keys) exist. The migration is idempotent and preserves data.
migrate(db);
db.exec(`CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, license_key TEXT UNIQUE NOT NULL,
  price_id TEXT, tier TEXT, status TEXT DEFAULT 'active',
  stripe_customer_id TEXT, created_at TEXT DEFAULT (datetime('now'))
)`);
db.exec(`CREATE TABLE IF NOT EXISTS subscribers (
  email TEXT PRIMARY KEY, source TEXT, status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now'))
)`);

// ─── INVOICE TRACKING ───
// Tracks Stripe invoices locally for syncing, reminders, and fulfillment.
db.exec(`CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  stripe_invoice_id TEXT UNIQUE,
  stripe_customer_id TEXT,
  lead_id TEXT,
  email TEXT NOT NULL,
  amount INTEGER,
  currency TEXT DEFAULT 'usd',
  status TEXT DEFAULT 'draft',
  description TEXT,
  invoice_url TEXT,
  due_date TEXT,
  paid_at TEXT,
  reminder_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  last_synced TEXT DEFAULT (datetime('now'))
)`);

// Migrations for existing DBs (add email + stripe_customer_id to leads if missing)
try { db.exec(`ALTER TABLE leads ADD COLUMN email TEXT`); } catch {}
try { db.exec(`ALTER TABLE leads ADD COLUMN stripe_customer_id TEXT`); } catch {}

const TIER_BY_PRICE = {
  [process.env.PRICE_SKILL_PACK_LITE]: "skill_pack_lite",   // $29
  [process.env.PRICE_SKILL_PACK_STD]:  "skill_pack_std",    // $49
  [process.env.PRICE_SKILL_PACK_ELITE]: "skill_pack_elite", // $79
  [process.env.PRICE_PRO_ANNUAL]:      "pro_annual",        // $199/yr
  [process.env.PRICE_MCP_SUITE]:       "mcp_suite",         // $499
  [process.env.PRICE_STARTER]:         "starter",           // free / $1 verified
};

function makeLicenseKey(tier) {
  const core = `CCPI-${tier.toUpperCase().slice(0, 8)}-${randomUUID().toUpperCase()}`;
  const sum = createHash("sha256").update(core).digest("hex").slice(0, 4).toUpperCase();
  return `${core}-${sum}`;
}

// ─── SELF-FETCHING FULFILLMENT (no webhook required) ───
// Polls Stripe for recent completed checkout sessions and mints licenses
// idempotently (session id stored in licenses.id). Runs every 60s and on demand.// ---------------------------------------------------------------------------
// STRIPE CLIENT - fail closed on LIVE credentials.
//
// The previous code constructed a Stripe client from ANY `sk_` key, including a
// LIVE key, and the 60-second poller then talked to the live API. That means
// simply starting the server could reach production.
//
// Now: a LIVE key is only used when the operator explicitly opts in with
// REVENUE_ALLOW_LIVE_STRIPE=true. A test key (`sk_test_`) is always safe.
// With no key, the client is null and every provider operation is disabled.
// ---------------------------------------------------------------------------
const LIVE_STRIPE_OPT_IN = "REVENUE_ALLOW_LIVE_STRIPE";
const stripeKey = process.env.STRIPE_SECRET_KEY ?? null;
const stripeKeyKind = stripeKey === null ? "none" : stripeKey.startsWith("sk_live_") ? "live" : stripeKey.startsWith("sk_test_") ? "test" : "unknown";
const liveStripeAllowed = process.env[LIVE_STRIPE_OPT_IN] === "true";

let stripe = null;
let stripeDisabledReason = null;
if (stripeKeyKind === "test") {
  try { stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20" }); }
  catch { stripeDisabledReason = "stripe_client_construction_failed"; }
} else if (stripeKeyKind === "live" && liveStripeAllowed) {
  try { stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20" }); }
  catch { stripeDisabledReason = "stripe_client_construction_failed"; }
} else if (stripeKeyKind === "live") {
  stripeDisabledReason = `live_stripe_requires_${LIVE_STRIPE_OPT_IN}=true`;
} else if (stripeKeyKind === "unknown") {
  stripeDisabledReason = "stripe_key_not_recognised";
} else {
  stripeDisabledReason = "stripe_key_missing";
}
if (stripeDisabledReason) {
  console.warn(`[startup] Stripe disabled: ${stripeDisabledReason}`);
}
// ---------------------------------------------------------------------------
// FULFILMENT - fail closed.
//
// The previous implementation minted a licence for ANY completed checkout
// session, without checking `payment_status`, and mapped an unknown price to
// the tier string "unknown" - so an UNPAID or UNMAPPED purchase still granted
// a licence. That was a fail-open and it is gone.
//
// Now: normalise -> persist (deduplicated) -> verify payment -> resolve the
// product -> only then fulfil. Every step is idempotent and evidence-backed.
// ---------------------------------------------------------------------------
async function fulfillSession(session, { sourceMode = "poll" } = {}) {
  const email = (session.customer_details?.email || session.customer_email || "").toLowerCase().trim();
  if (!email) return { skipped: session.id, reason: "no email" };

  let pid = extractPriceId(session);
  if (!pid && stripe) {
    try {
      const full = await stripe.checkout.sessions.retrieve(session.id, { expand: ["line_items"] });
      pid = extractPriceId(full) ?? null;
    } catch { pid = null; }
  }

  // 1. The event must be a genuine payment. "complete" is not "paid".
  if (!isPaidSession({ ...session, line_items: pid ? { data: [{ price: { id: pid } }] } : session.line_items })) {
    return { refused: session.id, reason: "payment not verified" };
  }

  // 2. The price must map to a known, enabled product. Unknown => BLOCKED.
  const product = pid ? resolveProductByPrice(pid) : null;
  if (!product) {
    return { refused: session.id, reason: "unknown product or price", price_id: pid ?? null };
  }

  // 3. Normalise, persist (deduplicated) and fulfil through the governed pipeline.
  const event = normalizeCheckoutSession(session, { sourceMode });
  const persisted = persistEvent(db, event);
  const result = await fulfillEvent(db, {
    event: persisted.event ?? event,
    transport: createCaptureTransport(),
    sourceFingerprint: "stripe-sync",
  });

  if (result.status === "completed") {
    console.log(`[sync] licence minted: ${email} -> ${product.product_id}`);
    return {
      minted: session.id, email, tier: product.product_id, product_id: product.product_id,
      license_id: result.license?.id ?? null, entitlement_id: result.entitlement?.id ?? null,
    };
  }
  if (result.status === "already_fulfilled") return { already: session.id };
  return { refused: session.id, reason: result.reason ?? result.status, status: result.status };
}
async function syncCheckoutSessions() {
  if (!stripe) return { disabled: true, reason: "STRIPE_SECRET_KEY missing or expired" };
  const since = Date.now() - 1000 * 60 * 60 * 24 * 7; // look back 7 days
  const results = [];
  for await (const session of stripe.checkout.sessions.list({
    created: { gte: Math.floor(since / 1000) },
    status: "complete",
    limit: 50,
  })) {
    if (session.payment_status === "paid" || session.payment_status === "no_payment_required") {
      results.push(await fulfillSession(session));
    }
  }
  return { ok: true, processed: results.length, results };
}

// The poller only runs when a Stripe client exists (i.e. a TEST key, or an
// explicitly opted-in LIVE key). With no client there is nothing to poll and
// no provider traffic at all.
if (stripe) {
  setInterval(() => syncCheckoutSessions().catch(e => console.error("[sync]", e.message)), 60_000);
}

// ─── STRIPE INVOICING AUTOMATION ───
// Service offerings for automated invoicing of consulting services.
const SERVICE_PRICES = {
  automation_audit: {
    name: "Automation Audit (48h)",
    amount: 14900,  // $149.00
    description: "48-hour automation audit — find and fix your biggest time-sink",
  },
  done_for_you_workflow: {
    name: "Done-for-you n8n Workflow",
    amount: 29900,  // $299.00
    description: "Custom n8n automation workflow built for your business",
  },
};

// Create or retrieve a Stripe customer by email
async function findOrCreateCustomer(email, name) {
  const existing = await stripe.customers.list({ email, limit: 1 });
  if (existing.data[0]) return existing.data[0];
  return await stripe.customers.create({ email, name: name || undefined });
}

// Sync a single invoice's status from Stripe
async function syncInvoiceStatus(stripeInvoiceId) {
  const inv = await stripe.invoices.retrieve(stripeInvoiceId);
  const paidAt = inv.status === "paid" && inv.status_transitions?.paid_at
    ? new Date(inv.status_transitions.paid_at * 1000).toISOString()
    : null;
  db.prepare(`UPDATE invoices SET status = ?, paid_at = ?, last_synced = datetime('now')
    WHERE stripe_invoice_id = ?`).run(inv.status, paidAt, stripeInvoiceId);
  return inv;
}

// Sync all tracked invoices from Stripe (idempotent)
async function syncAllInvoices() {
  if (!stripe) return { disabled: true, reason: "STRIPE_SECRET_KEY missing" };
  const results = { processed: 0, updated: [], paid: 0 };
  for await (const inv of stripe.invoices.list({ status: "all", limit: 100 })) {
    const local = db.prepare(`SELECT status FROM invoices WHERE stripe_invoice_id = ?`).get(inv.id);
    if (!local) { results.processed++; continue; }  // invoice not tracked locally
    if (local.status !== inv.status) {
      await syncInvoiceStatus(inv.id);
      results.updated.push({ invoice_id: inv.id, from: local.status, to: inv.status });
      if (inv.status === "paid") results.paid++;
    }
    results.processed++;
  }
  return results;
}

// Poll invoice statuses every 5 minutes (like checkout sync)
if (stripe) {
  setInterval(() => syncAllInvoices().catch(e => console.error("[invoice-sync]", e.message)), 300_000);
}

// Create a Stripe invoice, track it locally, return the sent invoice object
async function createInvoice({ email, name, leadId, amount, description, daysUntilDue = 7 }) {
  const customer = await findOrCreateCustomer(email, name);

  await stripe.invoiceItems.create({
    customer: customer.id,
    amount,
    currency: "usd",
    description,
  });

  const draft = await stripe.invoices.create({
    customer: customer.id,
    days_until_due: daysUntilDue,
    auto_advance: true,
  });

  const sent = await stripe.invoices.sendInvoice(draft.id);

  db.prepare(`INSERT OR REPLACE INTO invoices
    (id, stripe_invoice_id, stripe_customer_id, lead_id, email, amount, currency,
     status, description, invoice_url, due_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    sent.id,
    customer.id,
    leadId || null,
    email,
    amount,
    "usd",
    sent.status,
    description,
    sent.hosted_invoice?.url || sent.invoice_pdf,
    sent.due_date ? new Date(sent.due_date * 1000).toISOString() : null,
  );

  // Update lead with customer/email if leadId given
  if (leadId) {
    db.prepare(`UPDATE leads SET stripe_customer_id = ?, email = COALESCE(email, ?) WHERE id = ?`)
      .run(customer.id, email, leadId);
  }

  return { invoiceId: sent.id, invoiceUrl: sent.hosted_invoice?.url || sent.invoice_pdf,
    customerId: customer.id, status: sent.status };
}

const app = express();

// ---------------------------------------------------------------------------
// ADMIN SURFACE - AUTHORISED.
//
// These routes were previously ANONYMOUS: anyone who could reach the port
// could trigger a Stripe sync, read the dashboard, list subscribers and list
// leads. Every one of them now goes through `requireAdmin`, which FAILS CLOSED
// when REVENUE_ADMIN_TOKEN is not configured.
// ---------------------------------------------------------------------------
// `requireAdmin` is a THROWING guard designed to be called inside the lane's
// own `guard()` wrapper. Used directly as express middleware it would return
// `true` without ever calling next(), so the request would hang forever.
// This wrapper turns it into proper express middleware: it RESPONDS 401 rather
// than throwing, and it calls next() when authorised.
function adminGuard(req, res, next) {
  try {
    requireAdmin(req);
    next();
  } catch (err) {
    res.status(err?.status ?? 401).json({ error: err?.code ?? "admin_unauthorized" });
  }
}

const adminDeps = { db, sync: () => syncCheckoutSessions(), reconcile: () => reconcile(db, {}) };

app.get("/admin/sync", adminGuard, syncHandler(adminDeps));
app.get("/admin/health", adminGuard, healthHandler({ db }));
app.get("/admin/reconcile", adminGuard, reconcileHandler(adminDeps));
app.get("/admin/customers/:id", adminGuard, customerHandler({ db }));
app.get("/admin/entitlements", adminGuard, entitlementHandler({ db }));
app.get("/admin/licenses", adminGuard, licenseHandler({ db }));
app.get("/admin/evidence", adminGuard, evidenceHandler({ db }));
// Stripe listen (bridge) rotates its signing secret per session; the current
// one is extracted from the bridge's PM2 log (last whsec_ match). Env wins if set.
function getWebhookSecret() {
  if (process.env.STRIPE_WEBHOOK_SECRET) return process.env.STRIPE_WEBHOOK_SECRET;
  const logPaths = [
    path.join(process.env.USERPROFILE || "", ".pm2", "logs", "stripe-bridge-out.log"),
    "data/stripe-whsec.txt",
  ];
  for (const p of logPaths) {
    try {
      const content = fs.readFileSync(p, "utf8");
      const matches = content.match(/whsec_[a-f0-9]+/g);
      if (matches?.length) return matches[matches.length - 1];
    } catch { /* next source */ }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// WEBHOOK INTAKE - verify, normalise, deduplicate, persist.
//
// The previous handler called `fulfillSession` directly on the raw Stripe
// object. That path did not check `payment_status`, so an UNPAID session
// could still mint a licence. Now the event goes through the boundary:
// signature verification -> normalisation -> deduplicated persistence ->
// fulfilment only when the payment is VERIFIED.
//
// An HTTP 200 means "the event was durably recorded", NOT "the customer was
// fulfilled". Fulfilment state is in the evidence table and in `fulfillment_runs`.
// ---------------------------------------------------------------------------
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const secret = getWebhookSecret();
  const outcome = ingestWebhookEvent(db, {
    rawBody: req.body,
    signature: req.headers["stripe-signature"],
    secret,
    sourceMode: "webhook",
    stripeClient: stripe ?? undefined,
  });

  if (outcome.outcome === "no_secret") {
    return res.status(503).json({ error: "webhook_secret_not_provisioned", accepted: false });
  }
  if (outcome.outcome === "invalid_signature") {
    return res.status(400).json({ error: "invalid_signature", accepted: false });
  }
  if (outcome.outcome === "malformed_payload") {
    return res.status(400).json({ error: "malformed_payload", accepted: false });
  }
  if (outcome.outcome === "unsupported_event") {
    // Recorded, but deliberately not fulfilled.
    return res.status(200).json({ accepted: false, outcome: "unsupported_event", event_id: outcome.event?.event_id ?? null });
  }
  if (outcome.outcome === "duplicate") {
    // Already recorded and already processed. A retry must not re-fulfil.
    return res.status(200).json({ accepted: true, duplicate: true, event_id: outcome.event?.event_id ?? null });
  }

  const event = outcome.event;
  if (!event) return res.status(400).json({ error: "event_not_parsed", accepted: false });

  // Only a VERIFIED payment is fulfilled. An unpaid or unmapped event stays
  // recorded as pending and can be promoted later when a poll confirms payment.
  if (event.verification_status === VERIFICATION.VERIFIED) {
    const result = await fulfillEvent(db, {
      event,
      transport: createCaptureTransport(),
      sourceFingerprint: "stripe-webhook",
    });
    console.log(`[webhook] ${event.event_type}: ${result.status}`);
    if (process.env.N8N_SALE_WEBHOOK_URL && result.status === "completed") {
      fetch(process.env.N8N_SALE_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: event.event_type, result, amount: event.amount }),
      }).catch((e) => console.error("[webhook] n8n forward failed:", e.message));
    }
    return res.status(200).json({ accepted: true, duplicate: false, event_id: event.event_id, fulfilment_status: result.status });
  }

  console.log(`[webhook] ${event.event_type} recorded but NOT verified -> no fulfilment`);
  return res.status(200).json({ accepted: true, duplicate: false, event_id: event.event_id, fulfilment_status: "not_verified" });
});
app.use(express.json());

// ---------------------------------------------------------------------------
// CUSTOMER ACCESS - re-validated on EVERY use.
//
// The previous implementation trusted the JWT payload: a licence revoked after
// login kept granting access for up to 7 days, and the payload leaked the
// email. Now the session is re-checked against CURRENT licence and
// entitlement state on every request, and the response is scoped to the
// authenticated customer.
// ---------------------------------------------------------------------------
app.post("/v1/login", loginHandler({ db, sessionSecret: process.env.CCPI_SESSION_JWT_SECRET }));

app.get("/v1/me", meHandler({ db, sessionSecret: process.env.CCPI_SESSION_JWT_SECRET }));
app.get("/admin/dashboard", adminGuard, async (_req, res) => {
  try {
    // License stats (SQLite — source of truth for fulfilled orders)
    const byTier = db.prepare(
      `SELECT tier, COUNT(*) AS count FROM licenses WHERE status = 'active' GROUP BY tier`
    ).all();
    const totalLicenses = db.prepare(`SELECT COUNT(*) AS c FROM licenses`).get().c;
    const activeLicenses = db.prepare(
      `SELECT COUNT(*) AS c FROM licenses WHERE status = 'active'`
    ).get().c;
    const revoked = db.prepare(
      `SELECT COUNT(*) AS c FROM licenses WHERE status = 'revoked'`
    ).get().c;
    const last7d = db.prepare(
      `SELECT COUNT(*) AS c FROM licenses WHERE created_at >= datetime('now', '-7 days')`
    ).get().c;

    // Revenue (Stripe — last 30 days of completed checkouts)
    let revenue30d = 0, orders30d = 0, revenueByTier = {}, mrrEstimate = 0;
    const TIERS_USD = {
      starter: 1, skill_pack_lite: 29, skill_pack_std: 49,
      skill_pack_elite: 79, pro_annual: 199, mcp_suite: 499,
    };
    if (stripe) {
      const since = Math.floor((Date.now() - 1000 * 60 * 60 * 24 * 30) / 1000);
      for await (const session of stripe.checkout.sessions.list({
        created: { gte: since }, status: "complete", limit: 100,
      })) {
        if (session.payment_status !== "paid") continue;
        orders30d++;
        let pid = null;
        try {
          const full = await stripe.checkout.sessions.retrieve(session.id, { expand: ["line_items"] });
          pid = full.line_items?.data?.[0]?.price?.id;
        } catch { /* keep null */ }
        const tier = TIER_BY_PRICE[pid] || "unknown";
        const usd = (session.amount_total || 0) / 100;
        revenue30d += usd;
        revenueByTier[tier] = (revenueByTier[tier] || 0) + usd;
        if (tier === "pro_annual") mrrEstimate += usd / 12;
      }
    }
    res.json({
      generatedAt: new Date().toISOString(),
      licenses: { total: totalLicenses, active: activeLicenses, revoked, last7d, byTier },
      revenue: { last30dUsd: Math.round(revenue30d * 100) / 100, orders30d, revenueByTier, mrrEstimateUsd: Math.round(mrrEstimate * 100) / 100 },
      stripeConnected: !!stripe,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── EMAIL CAPTURE / LEAD MAGNET (per EMAIL_CAPTURE_SPEC.md) ───
// POST /v1/subscribe { email, source } → store + deliver Aurora Starter Pack.
app.post("/v1/subscribe", async (req, res) => {
  const { email, source } = req.body || {};
  const clean = email?.toLowerCase()?.trim();
  if (!clean || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) {
    return res.status(400).json({ error: "invalid_email" });
  }
  db.prepare(`INSERT OR IGNORE INTO subscribers (email, source) VALUES (?, ?)`)
    .run(clean, source || "unknown");
  recordStage(clean, "welcome"); // day-0 stage: the starter pack email IS the welcome
  try { await sendStarterPackEmail(clean); }
  catch (e) { console.error("[subscribe] email failed:", e.message); }
  res.json({ ok: true, message: "check your inbox for the Aurora OS Starter Pack" });
});

app.get("/admin/subscribers", adminGuard, (_req, res) => {
  const rows = db.prepare(`SELECT email, source, created_at FROM subscribers WHERE status = 'active' ORDER BY created_at DESC`).all();
  res.json({ count: rows.length, subscribers: rows });
});

// ─── DRIP CAMPAIGN (n8n cron → POST here daily) ───
app.post("/v1/campaign/run", async (_req, res) => {
  try { res.json(await runCampaign()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── LEAD PIPELINE (n8n ingests public signals; Keith reviews & contacts) ───
app.post("/v1/leads/ingest", express.json(), (req, res) => {
  try { res.json(ingestLeads(req.body?.candidates || [])); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/admin/leads", adminGuard, (_req, res) => res.json(listLeads()));
app.post("/admin/leads/status", adminGuard, express.json(), async (req, res) => {
  const { id, status, email, invoicePriceType, invoiceAmount, invoiceDescription, daysUntilDue } = req.body || {};
  if (!id || !["new", "contacted", "won", "dead"].includes(status)) {
    return res.status(400).json({ error: "bad_request" });
  }
  // Update lead status + store email if provided
  db.prepare(`UPDATE leads SET status = ?, email = COALESCE(?, email), converted_at = ?
    WHERE id = ?`).run(status, email || null, status === "won" ? new Date().toISOString() : null, id);

  // Auto-invoice when marking as "won" (if Stripe configured + email + amount provided)
  let invoice = null;
  if (status === "won" && stripe && email) {
    let amount, desc;
    if (invoicePriceType && SERVICE_PRICES[invoicePriceType]) {
      amount = SERVICE_PRICES[invoicePriceType].amount;
      desc = invoiceDescription || SERVICE_PRICES[invoicePriceType].description;
    } else {
      amount = invoiceAmount ? (typeof invoiceAmount === "string" ? parseInt(invoiceAmount) : invoiceAmount) : null;
      desc = invoiceDescription || "Service fee";
    }
    if (amount) {
      try {
        invoice = await createInvoice({ email, name: null, leadId: id, amount, description: desc, daysUntilDue: daysUntilDue || 7 });
        logMemory("invoices", {
          stripe_invoice_id: invoice.invoiceId,
          stripe_customer_id: invoice.customerId,
          lead_id: id,
          email,
          amount,
          description: desc,
          status: "draft",
          source: "auto-won",
        });
      } catch (e) {
        console.error("[invoice-auto] failed:", e.message);
        invoice = { error: e.message };
      }
    }
  }
  res.json({ ok: true, statusChanged: status, invoice });
});

// ─── STRIPE INVOICING ROUTES ───

// POST /v1/invoices/create — create a Stripe invoice (public-facing, no auth needed for B2B)
app.post("/v1/invoices/create", express.json(), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "stripe_not_configured" });
  const { email, name, priceType, amount, description, daysUntilDue = 7 } = req.body || {};
  if (!email) return res.status(400).json({ error: "email_required" });

  let invoiceAmount, invoiceDesc;
  if (priceType && SERVICE_PRICES[priceType]) {
    const svc = SERVICE_PRICES[priceType];
    invoiceAmount = svc.amount;
    invoiceDesc = description || svc.description;
  } else {
    if (!amount) return res.status(400).json({ error: "amount_or_priceType_required" });
    invoiceAmount = typeof amount === "string" ? parseInt(amount) : amount;
    invoiceDesc = description || "Service fee";
  }

  try {
    const result = await createInvoice({ email, name, amount: invoiceAmount, description: invoiceDesc, daysUntilDue });
    logMemory("invoices", {
      stripe_invoice_id: result.invoiceId,
      stripe_customer_id: result.customerId,
      email, amount: invoiceAmount, description: invoiceDesc,
      status: result.status, source: "public-create",
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/invoices — list invoices (filter: ?status=open|paid|uncollectible|void)
app.get("/admin/invoices", adminGuard, (_req, res) => {
  try {
    const status = _req.query.status;
    const rows = status
      ? db.prepare(`SELECT * FROM invoices WHERE status = ? ORDER BY created_at DESC`).all(status)
      : db.prepare(`SELECT * FROM invoices ORDER BY created_at DESC`).all();
    res.json({ count: rows.length, invoices: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/invoices/stats — invoice metrics
app.get("/admin/invoices/stats", adminGuard, (_req, res) => {
  try {
    const stats = {
      open: db.prepare(`SELECT COUNT(*) AS c, SUM(amount) AS total FROM invoices WHERE status = 'open'`).get(),
      paid: db.prepare(`SELECT COUNT(*) AS c, SUM(amount) AS total FROM invoices WHERE status = 'paid'`).get(),
      uncollectible: db.prepare(`SELECT COUNT(*) AS c FROM invoices WHERE status = 'uncollectible'`).get(),
      void: db.prepare(`SELECT COUNT(*) AS c FROM invoices WHERE status = 'void'`).get(),
      draft: db.prepare(`SELECT COUNT(*) AS c FROM invoices WHERE status = 'draft'`).get(),
    };
    res.json({ ok: true, ...stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/invoices/:id — get single invoice details
app.get("/admin/invoices/:id", adminGuard, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "stripe_not_configured" });
  try {
    const local = db.prepare(`SELECT * FROM invoices WHERE stripe_invoice_id = ?`).get(req.params.id);
    if (!local) return res.status(404).json({ error: "invoice_not_found" });
    const stripeInvoice = await stripe.invoices.retrieve(req.params.id);
    res.json({ local, stripe: stripeInvoice });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /admin/invoices/sync — sync all invoice statuses from Stripe
app.post("/admin/invoices/sync", adminGuard, async (_req, res) => {
  try {
    const result = await syncAllInvoices();
    logMemory("channel_metrics", {
      campaign_run_id: null,
      channel: "stripe-sync",
      metric_type: "invoice_sync",
      value: result.processed,
      metadata: JSON.stringify(result),
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /admin/invoices/reminder/:id — send reminder email for a single invoice
app.post("/admin/invoices/reminder/:id", adminGuard, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "stripe_not_configured" });
  try {
    const inv = db.prepare(`SELECT * FROM invoices WHERE stripe_invoice_id = ?`).get(req.params.id);
    if (!inv) return res.status(404).json({ error: "invoice_not_found" });
    await stripe.invoices.retrieve(req.params.id);

    const { sendMail } = await import("./mailer.js");
    const daysOverdue = inv.due_date ? Math.floor((Date.now() - new Date(inv.due_date).getTime()) / 86400000) : 0;
    const subject = `Invoice reminder — ${inv.description} — ${daysOverdue} days overdue`;
    const text = `Hi ${inv.email},\n\nFriendly reminder: your invoice for ${inv.description} (${Math.round(inv.amount / 100)} USD) is ${daysOverdue} days overdue.\n\nPay: ${inv.invoice_url}\n\n— Aurora Rayes LLC`;
    await sendMail(inv.email, subject, text);
    db.prepare(`UPDATE invoices SET reminder_count = reminder_count + 1 WHERE stripe_invoice_id = ?`).run(req.params.id);
    logMemory("channel_metrics", {
      campaign_run_id: null, channel: "email", metric_type: "invoice_reminder",
      value: 1, metadata: JSON.stringify({ invoice_id: req.params.id, email: inv.email }),
    });
    res.json({ ok: true, email: inv.email, daysOverdue });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /admin/invoices/reminders — batch-send reminders for unpaid invoices
app.post("/admin/invoices/reminders", adminGuard, async (_req, res) => {
  if (!stripe) return res.status(503).json({ error: "stripe_not_configured" });
  const { daysOverdue = 7, maxReminders = 3 } = _req.body || {};
  try {
    await syncAllInvoices();
    const open = db.prepare(`SELECT * FROM invoices WHERE status = 'open' ORDER BY due_date ASC`).all();
    const now = Date.now();
    const overdue = open.filter(inv => {
      const due = inv.due_date ? new Date(inv.due_date).getTime() : 0;
      return due && (now - due) > daysOverdue * 86400000 && inv.reminder_count < maxReminders;
    });
    const { sendMail } = await import("./mailer.js");
    const reminded = [];
    for (const inv of overdue) {
      try {
        const daysOvd = Math.floor((now - new Date(inv.due_date).getTime()) / 86400000);
        const subject = `Invoice reminder — ${inv.description} — ${daysOvd} days overdue`;
        const text = `Hi ${inv.email},\n\nFriendly reminder: your invoice for ${inv.description} (${Math.round(inv.amount / 100)} USD) is ${daysOvd} days overdue.\n\nPay: ${inv.invoice_url}\n\n— Aurora Rayes LLC`;
        await sendMail(inv.email, subject, text);
        db.prepare(`UPDATE invoices SET reminder_count = reminder_count + 1 WHERE stripe_invoice_id = ?`).run(inv.stripe_invoice_id);
        reminded.push({ invoice_id: inv.stripe_invoice_id, email: inv.email });
      } catch (emailErr) {
        console.error(`[reminders] ${inv.email}:`, emailErr.message);
      }
        }
    res.json({ ok: true, totalOverdue: overdue.length, reminded: reminded.length, invoices: reminded });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── MEMORY VAULT ENDPOINTS ───
const MEMORY_TABLES = ["campaigns", "campaign_runs", "channel_metrics", "analytics_snapshots", "invoices", "leads"];

// /v1/memory/health must come BEFORE /v1/memory/:table (Express route ordering)
app.get("/v1/memory/health", (_req, res) => {
  try {
    const counts = {};
    for (const t of MEMORY_TABLES) { counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c; }
    res.json({ ok: true, tables: counts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/v1/memory/:table", (_req, res) => {
  try {
    const table = _req.params.table;
    if (!MEMORY_TABLES.includes(table)) return res.status(400).json({ error: "invalid_table" });
    const where = {};
    const { status, leadId, campaignId, limit } = _req.query;
    if (status) where.status = status;
    if (leadId) where.lead_id = leadId;
    if (campaignId) where.campaign_id = campaignId;
    const rows = queryMemory(table, where, "created_at DESC", parseInt(limit) || 100);
    res.json({ count: rows.length, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/v1/memory/:table/latest", (_req, res) => {
  try {
    const table = _req.params.table;
    if (!MEMORY_TABLES.includes(table)) return res.status(400).json({ error: "invalid_table" });
    const rows = getLastRows(table, parseInt(_req.query.limit) || 10);
    res.json({ count: rows.length, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/v1/memory/:table", express.json(), (_req, res) => {
  try {
    const table = _req.params.table;
    if (!MEMORY_TABLES.includes(table)) return res.status(400).json({ error: "invalid_table" });
    const result = logMemory(table, _req.body || {});
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── CAMPAIGN CONTENT ENDPOINT (for n8n campaign distribution workflow) ───
app.get("/v1/campaign/content", (_req, res) => {
  try {
    const campaigns = db.prepare(`SELECT * FROM campaigns WHERE active = 1`).all();
    if (campaigns.length === 0) {
      res.json({
        ok: true, source: "seed",
        content: {
          email: { channel: "email", to: "all", subject: "New Aurora skill pack drop + 25% off",
            body: "Hey — just dropped 3 new AI coding agent skills. Grab yours at the store. Code LAUNCH25 for 25% off." },
          sms: { channel: "sms", to: "subscribers",
            body: "New Aurora skill drop! 25% off with code LAUNCH25: https://21leahcimhtiek-oss.github.io/aurora-rayes-store/" },
          blog: { channel: "blog", title: "3 New AI Agent Skills That Will Change How You Work", slug: "3-new-ai-agent-skills",
            markdown: "# 3 New AI Agent Skills\n\n1. Git Workflow Mastery\n2. Diagram-as-Code\n3. One-Prompt Cloud Deploy\n\n[Shop now](https://21leahcimhtiek-oss.github.io/aurora-rayes-store/)" },
          reddit: { channel: "reddit", subreddit: "automation", title: "New AI agent skills for git, diagrams, cloud",
            body: "We released 3 new AI coding agent skill packs. Feedback welcome: https://21leahcimhtiek-oss.github.io/aurora-rayes-store/" },
          twitter: { channel: "twitter",
            text: "3 new AI coding agent skills:\n1. Git workflow\n2. Diagram-as-code\n3. Cloud deploy\n\n25% off: https://21leahcimhtiek-oss.github.io/aurora-rayes-store/" },
          linkedin: { channel: "linkedin", title: "Building AI Agent Skills for Real Business Tasks",
            text: "We packaged our automation learnings into 3 concrete skill packs for AI coding agents.\n\n1. Git Workflow Pack\n2. Diagram-as-Code Pack\n3. Cloud Deployment Pack\n\nLet's talk if you're running a business.\n\n#AI #Automation #DevOps #SaaS" },
          discord: { channel: "discord",
            content: "🚀 New skill packs dropped! Git workflow, diagram-as-code, cloud deploy. 25% off: https://21leahcimhtiek-oss.github.io/aurora-rayes-store/" },
          slack: { channel: "slack",
            text: ":rocket: New Aurora skill packs: Git workflow, diagrams, cloud deploy. 25% off: <https://21leahcimhtiek-oss.github.io/aurora-rayes-store/>" },
          web_banner: { channel: "web_banner", title: "New Skill Packs Available", cta_text: "Shop Now",
            cta_url: "https://21leahcimhtiek-oss.github.io/aurora-rayes-store/", image_url: "https://21leahcimhtiek-oss.github.io/aurora-rayes-store/banner-skills.png" },
        },
      });
    }
    const campaign = campaigns[0];
    res.json({ ok: true, source: "campaign", campaign: campaign.name,
      content: JSON.parse(campaign.content_template) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PUBLISHER AGENT SERVICE ROUTES ───
app.post("/v1/publish", express.json(), (req, res) => {
  try {
    const result = enqueuePost(req.body);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Direct publish to specific channel
app.post("/v1/publish/:channel", express.json(), async (req, res) => {
  try {
    const { channel } = req.params;
    const manifest = { channel, content: req.body, campaignRunId: req.body?.campaignRunId };
    const validation = validateManifest(manifest);
    if (!validation.valid) return res.status(400).json({ error: "invalid_manifest", errors: validation.errors });
    const result = await enqueuePost(manifest);
    if (!result.ok) return res.status(400).json(result);
    const processResult = await processQueue(result.id);
    const posted = processResult.posted[0];
    if (posted) logMemory("channel_metrics", {
      campaign_run_id: manifest.campaignRunId || null, channel, metric_type: "posted", value: 1,
      metadata: JSON.stringify(posted.result),
    });
    res.json(posted ? { ok: true, result: posted.result } : { ok: false, errors: processResult.failed, skipped: processResult.skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/v1/publish/queue", (_req, res) => res.json(getQueueStats()));
app.get("/v1/publish/dead-letter", (_req, res) => res.json(getDeadLetter()));
app.post("/v1/publish/dead-letter/clear", (_req, res) => res.json(clearDeadLetter()));

// ─── ANALYTICS ENDPOINTS ───
app.post("/v1/analytics/run", async (_req, res) => {
  try {
    const result = await runFullAnalytics();
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/v1/analytics/engagement", async (_req, res) => {
  try {
    const campaignSent = db.prepare(`SELECT COUNT(*) AS c FROM campaign_sent`).get().c;
    res.json({ engagement: calculateEngagement({ sent: campaignSent, delivered: campaignSent, opened: 0, clicked: 0 }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/v1/analytics/revenue", async (_req, res) => {
  try { res.json(await analyzeRevenue()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/v1/analytics/leads", (_req, res) => {
  try { res.json(scoreLeads()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/v1/analytics/recommendations", async (_req, res) => {
  try {
    const revenue = await analyzeRevenue();
    const leads = scoreLeads();
    res.json(await generateRecommendations(null, revenue, leads));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/v1/analytics/snapshots", (_req, res) => {
  try {
    const snapshots = db.prepare(`SELECT * FROM analytics_snapshots ORDER BY created_at DESC LIMIT 20`).all();
    res.json({ count: snapshots.length, snapshots });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── WATCHDOG ENDPOINTS ───
app.get("/v1/watchdog/health", async (_req, res) => {
  try { res.json(await checkHealth()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/v1/watchdog/repair", async (_req, res) => {
  try {
    const health = await checkHealth();
    const repairs = await autoRepair(health.issues);
    res.json({ repairs, remainingIssues: health.issues });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/v1/watchdog/issues", async (_req, res) => {
  try {
    const health = await checkHealth();
    res.json({ issues: health.issues, healthy: health.healthy });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/v1/watchdog/rotate-logs", async (_req, res) => {
  try { res.json(await rotateLogs()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/v1/watchdog/price-ids", (_req, res) => {
  try { res.json(ensurePriceIds()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Validate environment on startup
const envCheck = validateEnv();
if (!envCheck.ok) {
  console.error("[startup] Missing required env vars:", envCheck.missing.join(", "));
}
if (envCheck.warnings.length) {
  console.warn("[startup] Warnings:", envCheck.warnings.join("; "));
}

const PORT = Number(process.env.PORT ?? 8787);
app.listen(PORT, () => console.log(`revenue-engine on :${PORT}`));
