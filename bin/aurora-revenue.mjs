#!/usr/bin/env node
/**
 * aurora-revenue - the operator CLI for Aurora Revenue Engine.
 *
 *   aurora-revenue health              is the system healthy and configured?
 *   aurora-revenue sync                trigger a provider sync
 *   aurora-revenue reconcile           compare provider state to local state
 *   aurora-revenue customer <id>       a customer's commercial state
 *   aurora-revenue entitlement <id>    an entitlement
 *   aurora-revenue license <key>       a licence
 *   aurora-revenue evidence            the evidence ledger
 *   aurora-revenue demo                run the synthetic demonstration
 *
 * It reads the SAME configuration the server reads, and it NEVER prints a
 * secret value. Admin commands require REVENUE_ADMIN_TOKEN.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
// On Windows a bare absolute path is not a valid ESM specifier - it must be a file:// URL.
const mod = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

const USAGE = `aurora-revenue - Aurora Revenue Engine operator CLI

USAGE
  aurora-revenue <command> [args]

COMMANDS
  health              system health and configuration status (no secret values)
  sync                trigger a provider sync
  reconcile           compare provider state against local state
  customer <id>       a customer and their commercial state
  entitlement <id>    an entitlement
  license <key>       a licence
  evidence            the evidence ledger
  demo [--out <dir>]  run the synthetic end-to-end demonstration

OPTIONS
  --json              print machine-readable JSON
  --out <dir>         output directory (demo only)

Admin commands require REVENUE_ADMIN_TOKEN. Env var NAMES only are ever shown.
`;

function parseArgs(argv) {
  const opts = { json: false, out: null, _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--out") { opts.out = argv[++i] ?? null; }
    else if (a === "--help" || a === "-h") opts.help = true;
    else opts._.push(a);
  }
  return opts;
}

function emit(opts, payload, human) {
  if (opts.json) { process.stdout.write(JSON.stringify(payload, null, 2) + "\n"); }
  else { process.stdout.write(human + "\n"); }
}

function requireAdminToken() {
  const t = process.env.REVENUE_ADMIN_TOKEN;
  if (!t || !t.trim()) {
    process.stderr.write("admin access is not configured (REVENUE_ADMIN_TOKEN is not set) - refusing\n");
    process.exit(2);
  }
  return t.trim();
}

async function main(argv) {
  const opts = parseArgs(argv);
  const cmd = opts._[0];

  if (!cmd || opts.help) { process.stdout.write(USAGE); return cmd ? 0 : 1; }

  if (cmd === "demo") {
    const { runDemo, hashDemoBundle } = await import(mod("src/demo.js"));
    const out = opts.out ?? path.join(process.env.TEMP ?? ".", "aurora-revenue-demo");
    const { result } = await runDemo({ outDir: out, json: true });
    const hashes = hashDemoBundle(out);
    fs.writeFileSync(path.join(out, "hashes.json"), JSON.stringify(hashes, null, 2) + "\n", "utf8");
    emit(opts, result, Object.entries(result)
      .filter(([k]) => k !== "COUNTS")
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`)
      .join("\n"));
    return result.DEMO_RESULT === "PASS" ? 0 : 1;
  }

  // Everything else needs the database.
  const { openDb } = await import(mod("src/db.js"));
  const { listProducts, resolveProductByPrice } = await import(mod("src/catalog.js"));
  const dbPath = process.env.REVENUE_DB_PATH ?? path.join(ROOT, "data", "licenses.db");
  const db = openDb(dbPath);

  try {
    if (cmd === "health") {
      const { isGovernedAvailable, governedActions } = await import(mod("src/governed.js"));
      const counts = {
        customers: db.prepare("SELECT COUNT(*) c FROM customers").get().c,
        revenue_events: db.prepare("SELECT COUNT(*) c FROM revenue_events").get().c,
        entitlements: db.prepare("SELECT COUNT(*) c FROM entitlements").get().c,
        licenses: db.prepare("SELECT COUNT(*) c FROM licenses").get().c,
        deliveries: db.prepare("SELECT COUNT(*) c FROM deliveries").get().c,
        evidence: db.prepare("SELECT COUNT(*) c FROM evidence").get().c,
      };
      const products = listProducts();
      const configured = products.filter((p) => Boolean(process.env[p.price_reference])).length;
      const payload = {
        ok: true,
        database: { ok: true, path: dbPath, counts },
        stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY),
        liveStripeEnabled: process.env.REVENUE_ALLOW_LIVE_STRIPE === "true",
        products: { total: products.length, priceConfigured: configured },
        adminConfigured: Boolean(process.env.REVENUE_ADMIN_TOKEN),
        sessionSecretConfigured: Boolean(process.env.CCPI_SESSION_JWT_SECRET),
        governed: { available: isGovernedAvailable(), actions: governedActions() },
      };
      emit(opts, payload, [
        `ok=${payload.ok}`,
        `database=${payload.database.path}`,
        `licenses=${counts.licenses} entitlements=${counts.entitlements} events=${counts.revenue_events} evidence=${counts.evidence}`,
        `products=${products.length} priceConfigured=${configured}`,
        `stripeConfigured=${payload.stripeConfigured} liveStripeEnabled=${payload.liveStripeEnabled}`,
        `adminConfigured=${payload.adminConfigured}`,
        `governed=${payload.governed.available}`,
      ].join("\n"));
      return 0;
    }

    // The remaining commands are admin operations.
    requireAdminToken();

    if (cmd === "reconcile") {
      const { reconcile } = await import(mod("src/reconcile.js"));
      const report = reconcile(db, {});
      emit(opts, report, `verdict=${report.verdict}\nfindings=${(report.findings ?? []).map((f) => f.type).join(",")}`);
      return report.verdict === "CONSISTENT" ? 0 : 2;
    }

    if (cmd === "customer") {
      const { describeCustomer } = await import(mod("src/access.js"));
      const id = opts._[1];
      if (!id) { process.stderr.write("customer id required\n"); return 1; }
      const detail = describeCustomer(db, id);
      emit(opts, detail, JSON.stringify(detail, null, 2));
      return detail ? 0 : 2;
    }

    if (cmd === "entitlement") {
      const id = opts._[1];
      if (!id) { process.stderr.write("entitlement id required\n"); return 1; }
      const row = db.prepare("SELECT * FROM entitlements WHERE id = ?").get(id);
      emit(opts, row ?? null, row ? JSON.stringify(row, null, 2) : "not found");
      return row ? 0 : 2;
    }

    if (cmd === "license") {
      const key = opts._[1];
      if (!key) { process.stderr.write("license key required\n"); return 1; }
      const { getLicenseByKey } = await import(mod("src/licenses.js"));
      const row = getLicenseByKey(db, key);
      emit(opts, row ?? null, row ? JSON.stringify(row, null, 2) : "not found");
      return row ? 0 : 2;
    }

    if (cmd === "evidence") {
      const rows = db.prepare("SELECT id, kind, subject_id, created_at FROM evidence ORDER BY created_at DESC LIMIT 200").all();
      emit(opts, rows, rows.map((r) => `${r.created_at} ${r.kind} ${r.subject_id ?? ""}`).join("\n"));
      return 0;
    }

    if (cmd === "sync") {
      process.stderr.write("sync requires a running server (the poller is in-process). Use the server's /admin/sync endpoint.\n");
      return 2;
    }

    process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
    return 1;
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

const code = await main(process.argv.slice(2));
process.exitCode = code;