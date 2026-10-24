// Lead harvester intake: public buying-intent signals (HN, Reddit, etc.)
// n8n fetches public sources daily and POSTs candidates here. Nothing is
// contacted automatically — Keith reviews via GET /admin/leads.
import Database from "better-sqlite3";

const db = new Database("data/licenses.db");
db.exec(`CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT, url TEXT UNIQUE,
  author TEXT, snippet TEXT, intent_score INTEGER DEFAULT 0, status TEXT DEFAULT 'new',
  created_at TEXT DEFAULT (datetime('now'))
)`);

const INTENT_WORDS = ["automate", "automation", "workflow", "n8n", "ai agent", "agent",
  "stripe", "integration", "no-code", "low-code", "zapier", "make.com", "script", "bot", "hiring"];

export function scoreText(t) {
  const s = (t || "").toLowerCase();
  return INTENT_WORDS.reduce((n, w) => n + (s.includes(w) ? 2 : 0), 0);
}

export function ingestLeads(candidates) {
  const ins = db.prepare(`INSERT OR IGNORE INTO leads (id, source, title, url, author, snippet, intent_score)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  let added = 0;
  for (const c of candidates) {
    if (!c.url) continue;
    const score = c.intent_score ?? scoreText(`${c.title} ${c.snippet}`);
    if (score < 2) continue; // ignore low-signal
    const r = ins.run(c.id || crypto.randomUUID(), c.source || "unknown",
      (c.title || "").slice(0, 300), c.url, (c.author || "").slice(0, 80),
      (c.snippet || "").slice(0, 500), score);
    added += r.changes;
  }
  return { added };
}

export function listLeads(status) {
  const rows = status
    ? db.prepare(`SELECT * FROM leads WHERE status = ? ORDER BY intent_score DESC, created_at DESC`).all(status)
    : db.prepare(`SELECT * FROM leads ORDER BY intent_score DESC, created_at DESC`).all();
  return { count: rows.length, leads: rows };
}
