// Revenue Engine — webhook + license + ccpi login server (scaffold)
import dotenv from "dotenv";
dotenv.config({ path: "C:/Users/keith/master.env" });
import express from "express";
import Stripe from "stripe";
import Database from "better-sqlite3";
import { SignJWT, jwtVerify } from "jose";
import { randomUUID, createHash } from "node:crypto";
import { sendLicenseEmail } from "./email.js";

const db = new Database("data/licenses.db");
db.exec(`CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, license_key TEXT UNIQUE NOT NULL,
  price_id TEXT, tier TEXT, status TEXT DEFAULT 'active',
  stripe_customer_id TEXT, created_at TEXT DEFAULT (datetime('now'))
)`);

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
// idempotently (session id stored in licenses.id). Runs every 60s and on demand.
let stripe = null;
try {
  if (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.startsWith("sk_")) {
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
  }
} catch { /* no valid key yet — sync disabled until key is set */ }

async function fulfillSession(session) {
  const email = (session.customer_details?.email || session.customer_email || "").toLowerCase().trim();
  if (!email) return { skipped: session.id, reason: "no email" };
  let pid;
  try {
    const full = await stripe.checkout.sessions.retrieve(session.id, { expand: ["line_items"] });
    pid = full.line_items?.data?.[0]?.price?.id;
  } catch { pid = null; }
  const tier = TIER_BY_PRICE[pid] || "unknown";
  if (db.prepare(`SELECT id FROM licenses WHERE id = ?`).get(session.id)) {
    return { already: session.id };
  }
  const key = makeLicenseKey(tier);
  db.prepare(`INSERT OR IGNORE INTO licenses (id, email, license_key, price_id, tier, stripe_customer_id)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(session.id, email, key, pid, tier, session.customer || null);
  await sendLicenseEmail(email, key, tier);
  console.log(`[sync] license minted: ${email} -> ${tier}`);
  return { minted: session.id, email, tier };
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

setInterval(() => syncCheckoutSessions().catch(e => console.error("[sync]", e.message)), 60_000);

const app = express();

app.get("/admin/sync", async (_req, res) => {
  try { res.json(await syncCheckoutSessions()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/health", (_req, res) => res.json({
  ok: true, stripe: !!stripe, priceIds: Object.keys(TIER_BY_PRICE).filter(Boolean).length,
}));

app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const email = session.customer_details?.email || session.customer_email;
      const priceId = session.line_items?.data?.[0]?.price?.id;
      // line_items requires expansion; fetch if not expanded:
      const full = priceId ? session : await stripe.checkout.sessions.retrieve(session.id, {
        expand: ["line_items"],
      });
      const pid = priceId || full.line_items.data[0].price.id;
      const tier = TIER_BY_PRICE[pid] || "unknown";
      const key = makeLicenseKey(tier);
      db.prepare(`INSERT INTO licenses (id, email, license_key, price_id, tier, stripe_customer_id)
                  VALUES (?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), email, key, pid, tier, session.customer);
      await sendLicenseEmail(email, key, tier);
      break;
    }
    case "customer.subscription.deleted":
    case "invoice.payment_failed": {
      const custId = event.data.object.customer;
      db.prepare(`UPDATE licenses SET status = 'revoked' WHERE stripe_customer_id = ? AND status = 'active'`)
        .run(custId);
      break;
    }
  }
  res.json({ received: true });
});

app.use(express.json());

app.post("/v1/login", async (req, res) => {
  const { email, licenseKey } = req.body || {};
  const lic = db.prepare(
    `SELECT * FROM licenses WHERE email = ? AND license_key = ? AND status = 'active'`
  ).get(email?.toLowerCase()?.trim(), licenseKey?.trim());
  if (!lic) return res.status(401).json({ error: "invalid_license" });

  const token = await new SignJWT({ tier: lic.tier, licenseId: lic.id })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(lic.email)
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(new TextEncoder().encode(process.env.CCPI_SESSION_JWT_SECRET));
  res.json({ sessionToken: token, tier: lic.tier });
});

app.get("/v1/me", async (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing_token" });
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(process.env.CCPI_SESSION_JWT_SECRET));
    res.json({ email: payload.sub, tier: payload.tier, licenseId: payload.licenseId, expiresAt: payload.exp });
  } catch {
    res.status(401).json({ error: "invalid_or_expired_token" });
  }
});

// ─── ADMIN DASHBOARD (Stripe financial platform, phase 1) ───
// GET /admin/dashboard — revenue + license metrics in one JSON payload.
app.get("/admin/dashboard", async (_req, res) => {
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

app.listen(8787, () => console.log("revenue-engine on :8787"));
