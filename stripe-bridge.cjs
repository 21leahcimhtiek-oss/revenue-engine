// Stripe webhook bridge (node wrapper).
// Runs `stripe listen` (logged-in live context) and captures the per-session
// signing secret to data/stripe-whsec.txt so the engine can verify signatures
// even after bridge restarts. Never prints the secret.
// NOTE: stdin MUST be ignored — the Stripe CLI stalls when stdin is a pipe.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const SEC_FILE = path.join(__dirname, "data", "stripe-whsec.txt");
if (!fs.existsSync(path.dirname(SEC_FILE))) fs.mkdirSync(path.dirname(SEC_FILE), { recursive: true });

const STRIPE_SHIM = path.join(process.env.APPDATA || "", "npm", "node_modules", "@stripe", "cli", "bin", "shim.js");

function start() {
  const p = spawn(process.execPath, [STRIPE_SHIM, "listen", "--forward-to", "localhost:8787/webhook"],
    { stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => {
    process.stdout.write(d);
    const m = d.toString().match(/whsec_[a-f0-9]+/);
    if (m) fs.writeFileSync(SEC_FILE, m[0]);
  });
  p.stderr.on("data", (d) => process.stderr.write(d));
  p.on("exit", () => { console.log("[bridge] exited — restarting in 5s"); setTimeout(start, 5000); });
}
start();
