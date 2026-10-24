// ─── ANALYTICS + OPTIMIZATION AGENTS ───
import { logMemory } from "./memory.js";
import Database from "better-sqlite3";
import Stripe from "stripe";

const db = new Database("data/licenses.db");
const stripe = process.env.STRIPE_SECRET_KEY?.startsWith("sk_")
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" })
  : null;

// ─── ENGAGEMENT ANALYST ───
export function calculateEngagement(emailMetrics) {
  const { sent = 0, delivered = 0, opened = 0, clicked = 0 } = emailMetrics;
  const openRate = sent > 0 ? Number(((opened / sent) * 100).toFixed(1)) : 0;
  const clickRate = opened > 0 ? Number(((clicked / opened) * 100).toFixed(1)) : 0;
  const ctr = sent > 0 ? Number(((clicked / sent) * 100).toFixed(1)) : 0;
    return { openRate, clickRate, ctr, sent, delivered, opened, clicked };
}

// ─── REVENUE OPTIMIZER ───
export async function analyzeRevenue() {
  if (!stripe) return { error: "stripe_not_configured" };
  const since = Math.floor((Date.now() - 1000 * 60 * 60 * 24 * 90) / 1000);
  let totalRevenue = 0, totalOrders = 0, refunds = 0;
  const byTier = {};

  for await (const session of stripe.checkout.sessions.list({
    created: { gte: since }, status: "complete", limit: 100,
  })) {
    if (session.payment_status !== "paid") continue;
    totalOrders++;
    totalRevenue += (session.amount_total || 0) / 100;
    // Map tier by price ID
    const TIER_BY_PRICE = {
      [process.env.PRICE_SKILL_PACK_LITE]: "skill_pack_lite", [process.env.PRICE_SKILL_PACK_STD]: "skill_pack_std",
      [process.env.PRICE_SKILL_PACK_ELITE]: "skill_pack_elite", [process.env.PRICE_PRO_ANNUAL]: "pro_annual",
      [process.env.PRICE_MCP_SUITE]: "mcp_suite", [process.env.PRICE_STARTER]: "starter",
    };
    // Best-effort tier lookup from session
    let pid = null;
    try { const full = await stripe.checkout.sessions.retrieve(session.id, { expand: ["line_items"] }); pid = full.line_items?.data?.[0]?.price?.id; } catch {}
    const tier = TIER_BY_PRICE[pid] || "unknown";
    byTier[tier] = (byTier[tier] || 0) + (session.amount_total || 0) / 100;
  }

  let activeSubs = 0, mrr = 0;
  for await (const sub of stripe.subscriptions.list({ status: "all", limit: 100 })) {
    if (sub.status === "active" || sub.status === "trialing") {
      activeSubs++;
      mrr += (sub.items?.data?.[0]?.price?.unit_amount || 0) / 100;
    }
  }

  for await (const refund of stripe.refunds.list({ limit: 50 })) {
    refunds += (refund.amount || 0) / 100;
  }

  const arpu = totalOrders > 0 ? Number((totalRevenue / totalOrders).toFixed(2)) : 0;
  return {
    period: "90d", revenue: Number(totalRevenue.toFixed(2)), orders: totalOrders,
    refunds: Number(refunds.toFixed(2)), arpu, mrr: Number(mrr.toFixed(2)),
    activeSubs, byTier, churnRate: null,
  };
}

// ─── LEAD QUALITY SCORER ───
export function scoreLeads() {
  const bySource = db.prepare(`
    SELECT source, COUNT(*) AS total,
      SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) AS won,
      SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) * 1.0 / COUNT(*) * 100 AS win_rate
    FROM leads GROUP BY source ORDER BY win_rate DESC
  `).all();

  const intentBySource = db.prepare(`
    SELECT source, AVG(intent_score) AS avg_intent, COUNT(*) AS total
    FROM leads GROUP BY source ORDER BY avg_intent DESC
  `).all();

  const leadRevenue = db.prepare(`
    SELECT COUNT(*) AS invoiced_leads, SUM(amount) AS total_revenue_cents
    FROM invoices WHERE lead_id IS NOT NULL
  `).get();

    }

// ─── RECOMMENDATION ENGINE ───
export async function generateRecommendations(campaignData, revenueData, leadData) {
  const recommendations = [];

  if (revenueData && !revenueData.error) {
    if (revenueData.mrr > 0 && revenueData.mrr < 500) {
      recommendations.push("MRR below $500 — promote Pro Annual ($199/yr) to convert more leads to recurring");
    }
    if (revenueData.arpu < 50) {
      recommendations.push(`ARPU is $${revenueData.arpu} — upsell from $29 starter packs to $49+ tiers`);
    }
    if (revenueData.refunds > revenueData.revenue * 0.05) {
      recommendations.push("Refund rate above 5% — investigate checkout flow or product-market fit");
    }
  }

  if (leadData && leadData.bySource) {
    for (const src of leadData.bySource) {
      if (src.win_rate < 5 && src.total > 5) {
        recommendations.push(`Source "${src.source}" has ${src.win_rate.toFixed(1)}% win rate — consider deprioritizing`);
      }
      if (src.win_rate > 20 && src.total > 3) {
        recommendations.push(`Source "${src.source}" has ${src.win_rate.toFixed(1)}% win rate — increase allocation`);
      }
    }
  }

  const channelStats = db.prepare(`
    SELECT channel,
      SUM(CASE WHEN metric_type = 'posted' THEN value ELSE 0 END) AS posted,
      SUM(CASE WHEN metric_type = 'post_failed' THEN value ELSE 0 END) AS failed
    FROM channel_metrics GROUP BY channel
  `).all();
  for (const ch of channelStats) {
    if (ch.failed > ch.posted) {
      recommendations.push(`Channel "${ch.channel}" has ${ch.failed} failures vs ${ch.posted} successes — check credentials`);
    }
  }

  if (recommendations.length === 0) {
    recommendations.push("No data yet — let campaigns run for 7+ days to build baselines");
    recommendations.push("Seed a campaign template to start distribution");
    recommendations.push("Configure platform API tokens (Twitter, LinkedIn, Reddit, Discord, Slack)");
  }

  return { recommendations, timestamp: new Date().toISOString() };
}

// ─── RUN FULL ANALYTICS + SNAPSHOT ───
export async function runFullAnalytics() {
  const engagement = calculateEngagement({ sent: 0, delivered: 0, opened: 0, clicked: 0 });
  const revenue = await analyzeRevenue();
  const leads = scoreLeads();
  const recommendations = await generateRecommendations(null, revenue, leads);

  logMemory("analytics_snapshots", {
    period: "weekly",
    engagement: JSON.stringify(engagement),
    revenue: JSON.stringify(revenue),
    leads: JSON.stringify(leads),
    recommendations: JSON.stringify(recommendations.recommendations),
  });

  return { engagement, revenue, leads, recommendations };
}

export default { calculateEngagement, analyzeRevenue, scoreLeads, generateRecommendations, runFullAnalytics };