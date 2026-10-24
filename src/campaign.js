// Lead campaign engine: staged drip sequence for subscribers.
// Stages: welcome (day 0, sent by /v1/subscribe), value (day 3), offer (day 5).
// n8n triggers POST /v1/campaign/run daily; this file does the rest.
import Database from "better-sqlite3";
import { sendMail } from "./mailer.js";

const db = new Database("data/licenses.db");
db.exec(`CREATE TABLE IF NOT EXISTS campaign_sent (
  email TEXT NOT NULL, stage TEXT NOT NULL, sent_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (email, stage)
)`);

const SITE = process.env.SITE_URL || "https://21leahcimhtiek-oss.github.io/aurora-rayes-store/";
const BRAND = "Aurora Rayes LLC";

const STAGES = [
  {
    id: "value", days: 3,
    subject: `The 10-minute automation that pays for itself (${BRAND})`,
    text: `Quick one — since you grabbed the Aurora OS Starter Pack.\n\nHere's the highest-leverage thing most businesses miss: the tasks you repeat weekly (invoicing, follow-ups, posting, reporting) are exactly what AI agents do best.\n\nOur skill packs give your AI coding agent production-grade skills in git, cloud, diagrams and docs — buy once, use forever:\n${SITE}\n\nAnd if you'd rather we build it for you, we do that too: automation audits ($149, 48h) and done-for-you n8n workflows ($299).\n\n— Aurora Rayes LLC`,
  },
  {
    id: "offer", days: 5,
    subject: `25% off everything at ${BRAND} (code inside)`,
    text: `Your LAUNCH25 code is active — 25% off any skill pack, today.\n\nUse code LAUNCH25 at checkout: ${SITE}\n\nMost people start with the $29 Diagrams Pack (docs that draw themselves) or the $49 Git Workflow Pack (your agent finally commits properly).\n\nRunning a business instead of a codebase? Reply to this email — we build complete autonomous revenue stacks for clients.\n\n— Aurora Rayes LLC`,
  },
];

export function recordStage(email, stage) {
  db.prepare(`INSERT OR IGNORE INTO campaign_sent (email, stage) VALUES (?, ?)`).run(email, stage);
}

export async function runCampaign() {
  const subs = db.prepare(`SELECT email, created_at FROM subscribers WHERE status = 'active'`).all();
  const sent = { skipped: 0, mailed: [] };
  for (const s of subs) {
    const ageDays = Math.floor((Date.now() - new Date(s.created_at + "Z").getTime()) / 86400000);
    for (const st of STAGES) {
      const already = db.prepare(`SELECT 1 FROM campaign_sent WHERE email = ? AND stage = ?`).get(s.email, st.id);
      if (already) { sent.skipped++; continue; }
      if (ageDays < st.days) continue;
      try {
        await sendMail(s.email, st.subject, st.text);
        recordStage(s.email, st.id);
        sent.mailed.push(`${s.email} -> ${st.id}`);
      } catch (e) {
        console.error(`[campaign] ${s.email}/${st.id}:`, e.message);
      }
    }
  }
  return { ok: true, subscribers: subs.length, mailed: sent.mailed, skipped: sent.skipped };
}
