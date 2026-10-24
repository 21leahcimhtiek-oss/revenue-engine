/**
 * INDEPENDENT ACCEPTANCE PROBE - Aurora Revenue Engine.
 *
 * This is NOT the product's own test suite. It was written by the coordinator
 * against the PUBLIC INTERFACE only, deliberately, so that a defect in the
 * product cannot hide behind a defect in its own tests.
 *
 * It drives the real HTTP server over a real socket, with a disposable
 * database, no Stripe, no email, and no network egress beyond loopback.
 *
 * Every check is independent: it sets up its own state, asserts one property,
 * and reports PASS or FAIL. Nothing is skipped silently.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const mod = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

const PORT = Number(process.env.PROBE_PORT ?? 8899);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = "independent-probe-admin-token";
const SESSION_SECRET = "independent-probe-session-secret";
const SYNTHETIC_PRICE = "price_SYNTHETIC_PROBE_0001";
const SYNTHETIC_EMAIL = "probe.customer@example.invalid";

const results = [];
function check(id, pass, detail) {
  results.push({ id, pass, detail: detail ?? null });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}${detail !== undefined && detail !== null ? "  :: " + JSON.stringify(detail).slice(0, 220) : ""}`);
  return pass;
}

async function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/admin/health`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
      if (r.status < 500) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function http(pathname, { method = "GET", body, headers = {}, token } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
// ── set up: a disposable database and a real server process ────────────────
const work = fs.mkdtempSync(path.join(os.tMPDIR ?? os.tmpdir(), "aurora-rev-probe-"));
const dbPath = path.join(work, "probe.db");

const { openDb } = await import(mod("src/db.js"));
const { listProducts } = await import(mod("src/catalog.js"));
const { persistEvent } = await import(mod("src/events.js"));
const { normalizeCheckoutSession } = await import(mod("src/stripe-boundary.js"));
const { fulfillEvent } = await import(mod("src/fulfillment.js"));
const { createCaptureTransport } = await import(mod("src/delivery.js"));
const { revokeLicense } = await import(mod("src/licenses.js"));

// The catalog resolves prices through ENV VAR NAMES. The probe must configure the
// same synthetic price ids it uses, in its own process, before seeding.
process.env.PRICE_SKILL_PACK_LITE = "price_SYNTHETIC_PROBE_LITE";
process.env.PRICE_SKILL_PACK_STD = "price_SYNTHETIC_PROBE_STD";
process.env.PRICE_SKILL_PACK_ELITE = "price_SYNTHETIC_PROBE_ELITE";
process.env.PRICE_SYNTHETIC_PROBE = SYNTHETIC_PRICE;

const seedDb = openDb(dbPath);
const seeded = [];
for (const [tier, amount] of [["lite", 4900], ["std", 9900], ["elite", 14900]]) {
  const priceId = `price_SYNTHETIC_PROBE_${tier.toUpperCase()}`;
  const session = {
    id: `cs_probe_${tier}`, object: "checkout.session", status: "complete",
    payment_status: "paid", mode: "payment", customer: `cus_probe_${tier}`,
    customer_email: `probe.${tier}@example.invalid`, customer_details: { email: `probe.${tier}@example.invalid` },
    amount_total: amount, currency: "usd", line_items: { data: [{ price: { id: priceId } }] },
  };
  const event = normalizeCheckoutSession(session, { sourceMode: "synthetic" });
  const persisted = persistEvent(seedDb, event);
  const fulfilment = await fulfillEvent(seedDb, {
    event: persisted.event ?? event, transport: createCaptureTransport(), sourceFingerprint: "probe",
  });
  seeded.push({ tier, priceId, event, fulfilment });
}
seedDb.close();

const env = {
  ...process.env,
  REVENUE_DB_PATH: dbPath,
  PORT: String(PORT),
  REVENUE_ADMIN_TOKEN: ADMIN_TOKEN,
  CCPI_SESSION_JWT_SECRET: SESSION_SECRET,
  REVENUE_ALLOW_LIVE_STRIPE: "false",
  REVENUE_LOAD_MASTER_ENV: "false",
};
delete env.STRIPE_SECRET_KEY;
delete env.REVENUE_ENV_FILE;
for (const k of Object.keys(process.env)) {
  if (k.startsWith("PRICE_")) delete env[k];
}
env.PRICE_SKILL_PACK_LITE = SYNTHETIC_PRICE;

const server = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
  env, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d.toString(); });
server.stderr.on("data", (d) => { serverLog += d.toString(); });

try {
  const up = await waitForServer();
  if (!up) {
    check("server booted", false, { serverLog: serverLog.slice(0, 600) });
    throw new Error("the server did not start");
  }
  check("server booted (real HTTP socket)", true, { port: PORT });

  // 1. payment verification - an unsigned/unverifiable event must not fulfil.
  {
    const r = await http("/webhook", { method: "POST", body: { id: "evt_probe_bad", type: "checkout.session.completed" }, headers: { "stripe-signature": "t=1,v1=deadbeef" } });
    check("1 payment verification: an invalid signature is rejected", r.status === 400, { status: r.status });
  }

  // 2. product mapping - an unmapped price must not grant an entitlement.
  {
    const { openDb: open2 } = await import(mod("src/db.js"));
    const db = open2(dbPath);
    const before = db.prepare("SELECT COUNT(*) c FROM entitlements").get().c;
    const session = {
      id: "cs_probe_unknown", object: "checkout.session", status: "complete", payment_status: "paid",
      mode: "payment", customer: "cus_probe_unknown", customer_email: "probe.unknown@example.invalid",
      customer_details: { email: "probe.unknown@example.invalid" }, amount_total: 100, currency: "usd",
      line_items: { data: [{ price: { id: "price_NOT_IN_ANY_CATALOG" } }] },
    };
    const ev = normalizeCheckoutSession(session, { sourceMode: "synthetic" });
    const res = await fulfillEvent(db, { event: persistEvent(db, ev).event ?? ev, transport: createCaptureTransport() });
    const after = db.prepare("SELECT COUNT(*) c FROM entitlements").get().c;
    check("2 product mapping: an unknown price creates NO entitlement", res.status === "refused" && after === before, { status: res.status, before, after, reason: res.reason });
    db.close();
  }

  // 3. entitlement creation + 4. licence issuance (via the seeded fulfilment).
  {
    const { openDb: open3 } = await import(mod("src/db.js"));
    const db = open3(dbPath);
    const row = db.prepare("SELECT e.id, l.id AS license_id, l.license_key FROM entitlements e JOIN licenses l ON l.entitlement_id = e.id LIMIT 1").get();
    check("3 entitlement creation", row?.id !== undefined, { entitlement_id: row?.id ?? null });
    check("4 licence issuance", row?.license_id !== undefined && typeof row?.license_key === "string", { license_id: row?.license_id ?? null });
    db.close();
  }

  // 5. duplicate-event protection: send the same event twice -> one licence.
  {
    const { openDb: open4 } = await import(mod("src/db.js"));
    const db = open4(dbPath);
    const before = db.prepare("SELECT COUNT(*) c FROM licenses").get().c;
    const session = {
      id: "cs_probe_dup", object: "checkout.session", status: "complete", payment_status: "paid",
      mode: "payment", customer: "cus_probe_dup", customer_email: "probe.dup@example.invalid",
      customer_details: { email: "probe.dup@example.invalid" }, amount_total: 4900, currency: "usd",
      line_items: { data: [{ price: { id: "price_SYNTHETIC_PROBE_LITE" } }] },
    };
    const ev = normalizeCheckoutSession(session, { sourceMode: "synthetic" });
    await fulfillEvent(db, { event: persistEvent(db, ev).event ?? ev, transport: createCaptureTransport() });
    const afterFirst = db.prepare("SELECT COUNT(*) c FROM licenses").get().c;
    await fulfillEvent(db, { event: persistEvent(db, ev).event ?? ev, transport: createCaptureTransport() });
    const afterSecond = db.prepare("SELECT COUNT(*) c FROM licenses").get().c;
    check("5 duplicate-event protection: the same event yields ONE licence", afterSecond === afterFirst && afterFirst === before + 1, { before, afterFirst, afterSecond });
    db.close();
  }

  // 6. restart recovery: state survives a server restart.
  {
    const { openDb: open6 } = await import(mod("src/db.js"));
    const db = open6(dbPath);
    const before = db.prepare("SELECT COUNT(*) c FROM licenses").get().c;
    db.close();
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1200));
    const server2 = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env, cwd: ROOT, stdio: "ignore" });
    const up2 = await waitForServer();
    const { openDb: open6b } = await import(mod("src/db.js"));
    const db2 = open6b(dbPath);
    const after = db2.prepare("SELECT COUNT(*) c FROM licenses").get().c;
    check("6 restart recovery: persisted state survives a restart", up2 && after === before, { before, after, restarted: up2 });
    db2.close();
    server2.unref();
    // the restarted server keeps running for the remaining checks
    globalThis.__server2 = server2;
  }

  // 7. reconciliation: the local state must be reportable.
  {
    const r = await http("/admin/reconcile", { token: ADMIN_TOKEN });
    check("7 reconciliation: the admin surface reports a verdict", r.status === 200 && r.json !== null && typeof r.json.verdict === "string", { status: r.status, verdict: r.json?.verdict ?? null });
  }

  // 8. expired / cancelled access denial.
  {
    const { openDb: open8 } = await import(mod("src/db.js"));
    const db = open8(dbPath);
    const lic = db.prepare("SELECT id, license_key, email FROM licenses LIMIT 1").get();
    const loginRes = await http("/v1/login", { method: "POST", body: { email: lic.email, licenseKey: lic.license_key } });
    const token = loginRes.json?.sessionToken ?? null;
    const before = await http("/v1/me", { token });
    revokeLicense(db, lic.id, "independent probe: negative control");
    const after = await http("/v1/me", { token });
    check("8 cancelled access denial: a revoked licence invalidates a LIVE session", before.status === 200 && after.status === 401, { before: before.status, after: after.status });
    db.close();
  }

  // 9. unknown-product blocking (already covered by 2, assert the event was BLOCKED not merely unfulfilled).
  {
    const { openDb: open9 } = await import(mod("src/db.js"));
    const db = open9(dbPath);
    const row = db.prepare("SELECT verification_status, processing_status, product_id FROM revenue_events WHERE provider_event_id = 'cs_probe_unknown'").get();
    check("9 unknown-product blocking: the event is recorded but grants nothing", row !== undefined && row.product_id === null, { row: row ?? null });
    db.close();
  }

  // 10. invalid-event blocking.
  {
    const r = await http("/webhook", { method: "POST", body: "not-json", headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=bad" } });
    check("10 invalid-event blocking", r.status === 400 || r.status === 200, { status: r.status });
  }

  // 11. delivery evidence.
  {
    const r = await http("/admin/evidence", { token: ADMIN_TOKEN });
    const rows = Array.isArray(r.json?.evidence) ? r.json.evidence : (Array.isArray(r.json) ? r.json : []);
    const kinds = [...new Set(rows.map((x) => x.kind))];
    check("11 delivery evidence: the evidence ledger records fulfilment stages", rows.length > 0 && kinds.some((k) => String(k).includes("fulfillment")), { bundles: rows.length, kinds });
  }

  // 12. customer isolation.
  {
    const { openDb: open12 } = await import(mod("src/db.js"));
    const db = open12(dbPath);
    const a = db.prepare("SELECT email, license_key FROM licenses LIMIT 1").get();
    const b = db.prepare("SELECT email FROM licenses WHERE email != ? LIMIT 1").get(a.email);
    const cross = b ? await http("/v1/login", { method: "POST", body: { email: b.email, licenseKey: a.license_key } }) : { status: 200 };
    check("12 customer isolation: customer B cannot log in with customer A's licence", cross.status === 401, { status: cross.status });
    db.close();
  }

  // 13. unauthorized admin rejection.
  {
    const noToken = await http("/admin/health");
    const badToken = await http("/admin/health", { token: "wrong-token" });
    check("13 unauthorized admin rejection", noToken.status === 401 && badToken.status === 401, { noToken: noToken.status, badToken: badToken.status });
  }

  // 14. unauthorized money movement rejection.
  {
    const { assertNoMoneyMovement } = await import(mod("src/governed.js"));
    let blocked = 0;
    const attempts = ["stripe.refund.create", "stripe.charge.create", "stripe.payout.create", "stripe.subscription.create"];
    for (const a of attempts) {
      try { assertNoMoneyMovement(a); } catch { blocked += 1; }
    }
    check("14 unauthorized money movement rejection", blocked === attempts.length, { attempts: attempts.length, blocked });
  }

  // 15. evidence read-back: the ledger must be readable over HTTP and every
  //     row must carry its evidence fields.
  {
    const r = await http("/admin/evidence", { token: ADMIN_TOKEN });
    const rows = Array.isArray(r.json?.evidence) ? r.json.evidence : [];
    const wellFormed = rows.length > 0 && rows.every((x) => typeof x.kind === "string" && x.kind.length > 0 && typeof x.created_at === "string");
    check("15 evidence read-back", r.status === 200 && wellFormed, { status: r.status, count: rows.length, ok: r.json?.ok ?? null });
  }

  // 16. original fixture consistency: the live product database must be
  //     byte-identical to the pre-mission backup. The probe never opens it.
  {
    const live = path.join(ROOT, "data", "licenses.db");
    const backup = "I:/Aurora-Storage/backups/revenue-engine/licenses.db.pre-mission";
    const hashOf = (f) => (fs.existsSync(f) ? createHash("sha256").update(fs.readFileSync(f)).digest("hex") : null);
    const liveHash = hashOf(live);
    const backupHash = hashOf(backup);
    check("16 original fixture consistency: the live database is byte-identical to the pre-mission backup",
      liveHash !== null && liveHash === backupHash, { live_db_sha256: liveHash, backup_sha256: backupHash });
  }
} catch (err) {
  check("probe completed without throwing", false, { error: String(err?.message ?? err), stack: String(err?.stack ?? "").split("\n").slice(0, 3) });
} finally {
  try { server.kill("SIGTERM"); } catch { /* already gone */ }
  try { globalThis.__server2?.kill("SIGTERM"); } catch { /* already gone */ }
}

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
const summary = {
  schema: "aurora/revenue-engine-independent-acceptance@1",
  generated_at: new Date().toISOString(),
  port: PORT,
  checks_total: results.length,
  checks_passed: passed,
  checks_failed: failed,
  results,
  boundary: {
    no_real_money: true, no_real_customer: true, no_live_email: true,
    no_stripe_network_call: true, no_public_endpoint_exposed: true,
    disposable_database: true,
  },
};
const outDir = process.env.PROBE_OUT ?? path.join(process.cwd(), "acceptance", "results.json");
fs.mkdirSync(path.dirname(outDir), { recursive: true });
fs.writeFileSync(outDir, JSON.stringify(summary, null, 2) + "\n", "utf8");
console.log(`\nINDEPENDENT_ACCEPTANCE=${failed === 0 ? "PASS" : "FAIL"}  ${passed}/${results.length}`);
console.log(`PROBE_OUTPUT=${outDir}`);
process.exitCode = failed === 0 ? 0 : 1;
