// One-shot webhook test: posts a properly signed fake checkout.session.completed
// to the engine, then removes the test license row. Run: node webhook-test.cjs
const crypto = require("crypto");
const fs = require("fs");

const secret = fs.readFileSync("data/stripe-whsec.txt", "utf8").trim();
const payload = JSON.stringify({
  id: "evt_test_1",
  type: "checkout.session.completed",
  data: { object: { id: "cs_test_webhooktest_001", object: "checkout.session",
    customer: null, customer_details: { email: "keithmargosian06@gmail.com" },
    amount_total: 4900 } },
});
const t = Math.floor(Date.now() / 1000);
const sig = crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");

fetch("http://localhost:8787/webhook", {
  method: "POST",
  headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${sig}` },
  body: payload,
}).then(async r => {
  console.log("HTTP", r.status, await r.text());
  const Database = (await import("better-sqlite3")).default;
  const db = new Database("data/licenses.db");
  const row = db.prepare("SELECT email, tier, license_key FROM licenses WHERE id = 'cs_test_webhooktest_001'").get();
  console.log("minted:", JSON.stringify(row));
  if (row) db.prepare("DELETE FROM licenses WHERE id = 'cs_test_webhooktest_001'").run();
  console.log("test license cleaned up");
}).catch(e => { console.error("FAILED:", e.message); process.exit(1); });
