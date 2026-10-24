/**
 * REGRESSION: `scoreLeads()` in src/analytics.js was truncated.
 *
 * THE DEFECT. The function body ran three queries and then closed with no
 * `return`, so it yielded `undefined`. Because the file is syntactically valid,
 * nothing failed loudly. Consequences:
 *
 *   - `GET /analytics/leads` (src/server.js) responded with an empty body;
 *   - `generateRecommendations(null, revenue, undefined)` silently skipped its
 *     per-source win-rate block, so those recommendations never fired;
 *   - `runFullAnalytics()` stored `leads: undefined` in analytics_snapshots.
 *
 * These tests fail against the truncated implementation and pass after the
 * smallest root-cause repair: restoring the return of the values the function
 * had already computed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// Never construct a live Stripe client during tests. analytics.js builds one from
// any `sk_` key at import time.
process.env.STRIPE_SECRET_KEY = "";

const mod = await import("../src/analytics.js");

test("REGRESSION: scoreLeads() returns an object, not undefined", () => {
  const r = mod.scoreLeads();
  assert.notEqual(r, undefined, "scoreLeads() returned undefined (truncated body)");
  assert.equal(typeof r, "object");
});

test("scoreLeads() exposes the values it computes", () => {
  const r = mod.scoreLeads();
  assert.ok(Array.isArray(r.bySource), "bySource must be an array");
  assert.ok(Array.isArray(r.intentBySource), "intentBySource must be an array");
  assert.ok(r.leadRevenue && typeof r.leadRevenue === "object", "leadRevenue must be an object");
  assert.ok("invoiced_leads" in r.leadRevenue);
  assert.ok("total_revenue_cents" in r.leadRevenue);
});

test("ATTACK: SUM() over no invoices is NULL, never a fabricated $0", () => {
  const r = mod.scoreLeads();
  for (const row of r.bySource) {
    assert.equal(typeof row.source, "string");
    assert.equal(typeof row.total, "number");
    assert.equal(typeof row.won, "number");
    assert.equal(typeof row.win_rate, "number");
  }
  if (r.leadRevenue.invoiced_leads === 0) {
    assert.equal(
      r.leadRevenue.total_revenue_cents,
      null,
      "an empty invoice set must report NULL revenue, not 0",
    );
  }
});

test("REGRESSION: the consumer contract is satisfied — lead recommendations fire", () => {
  const leadData = {
    bySource: [
      { source: "reddit", total: 10, won: 0, win_rate: 0 },
      { source: "hn", total: 10, won: 5, win_rate: 50 },
    ],
  };
  return mod.generateRecommendations(null, { error: "stripe_not_configured" }, leadData).then((recs) => {
    assert.ok(
      recs.recommendations.some((x) => x.includes("reddit") && x.includes("deprioritizing")),
      "a 0% win-rate source must be flagged for deprioritising",
    );
    assert.ok(
      recs.recommendations.some((x) => x.includes("hn") && x.includes("increase allocation")),
      "a 50% win-rate source must be flagged for more allocation",
    );
  });
});

test("ATTACK: with no lead data the engine says so rather than inventing advice", () => {
  return mod.generateRecommendations(null, { error: "stripe_not_configured" }, undefined).then((recs) => {
    assert.ok(recs.recommendations.every((x) => !x.includes("win rate")));
  });
});
