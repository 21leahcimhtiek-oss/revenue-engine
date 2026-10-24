// ─── PUBLISHER AGENT SERVICE ───
// Manifest-based payload validation, rate-limit aware posting, queue + retry + DLQ.
import { logMemory } from "./memory.js";

const RATE_LIMITS = {
  twitter: { max: 300, windowMs: 15 * 60 * 1000 },
  linkedin: { max: 200, windowMs: 24 * 60 * 60 * 1000 },
  reddit: { max: 60, windowMs: 60 * 1000 },
  blog: { max: Infinity, windowMs: 0 },
  discord: { max: 50, windowMs: 60 * 1000 },
  slack: { max: 100, windowMs: 60 * 1000 },
};

const queue = [];
const deadLetter = [];
const rateWindows = {};

function checkRateLimit(channel) {
  const limit = RATE_LIMITS[channel];
  if (!limit || limit.max === Infinity) return { allowed: true };
  const now = Date.now();
  const window = rateWindows[channel] || { count: 0, start: now };
  if (now - window.start > limit.windowMs) { window.count = 0; window.start = now; }
  if (window.count >= limit.max) return { allowed: false, resetIn: limit.windowMs - (now - window.start) };
  window.count++;
  rateWindows[channel] = window;
    return { allowed: true };
}

// ─── MANIFEST VALIDATION ───
export function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object") return { valid: false, errors: ["manifest is required"] };
  const { channel, content } = manifest;
  if (!channel) errors.push("channel is required");
  if (!content) errors.push("content is required");
  if (channel && !RATE_LIMITS[channel]) errors.push(`unknown channel: ${channel}`);
  const requiredByChannel = {
    twitter: ["text"], linkedin: ["text"],
    reddit: ["subreddit", "title", "body"],
    blog: ["title", "markdown"],
    discord: ["content"], slack: ["text"],
  };
  const req = channel && requiredByChannel[channel];
  if (req) {
    for (const field of req) {
      if (!content[field]) errors.push(`content.${field} is required for channel ${channel}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

// ─── PLATFORM PUBLISHERS ───
async function postToTwitter(content) {
  if (!process.env.TWITTER_BEARER_TOKEN) throw new Error("TWITTER_BEARER_TOKEN not set");
  const res = await fetch("https://api.twitter.com/2/tweets", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.TWITTER_BEARER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: content.text }),
  });
  if (!res.ok) throw new Error(`Twitter API error: ${res.status}`);
  const data = await res.json();
  return { postId: data.data?.id, url: `https://twitter.com/user/status/${data.data?.id}` };
}

async function postToLinkedIn(content) {
  if (!process.env.LINKEDIN_ACCESS_TOKEN) throw new Error("LINKEDIN_ACCESS_TOKEN not set");
  const body = {
    author: process.env.LINKEDIN_URN,
    lifecycleState: "PUBLISHED",
    specificContent: { "com.linkedin.ugc.ShareContent": { shareCommentary: { text: content.text } } },
    visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
  };
  const res = await fetch("https://api.linkedin.com/v2/ugcPosts", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.LINKEDIN_ACCESS_TOKEN}`, "Content-Type": "application/json", "X-Restli-Protocol-Version": "2.0.0" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LinkedIn API error: ${res.status}`);
  const data = await res.json();
  return { postId: data.id, url: `https://www.linkedin.com/feed/update/${data.id}` };
}

async function postToReddit(content) {
  if (!process.env.REDDIT_CLIENT_ID || !process.env.REDDIT_CLIENT_SECRET || !process.env.REDDIT_USERNAME) {
    throw new Error("REDDIT creds not set");
  }
  const auth = Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString("base64");
  const tokenRes = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: { "Authorization": `Basic ${auth}`, "User-Agent": "aurora-rayes/1.0" },
    body: new URLSearchParams({ grant_type: "password", username: process.env.REDDIT_USERNAME, password: process.env.REDDIT_PASSWORD || "" }),
  });
  const tokenData = await tokenRes.json();
  const postRes = await fetch("https://oauth.reddit.com/api/submit", {
    method: "POST",
    headers: { "Authorization": `Bearer ${tokenData.access_token}`, "User-Agent": "aurora-rayes/1.0", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      api_type: "json", kind: "link", sr: content.subreddit,
      title: content.title, url: content.url || "https://21leahcimhtiek-oss.github.io/aurora-rayes-store/", text: content.body,
    }),
  });
  if (!postRes.ok) throw new Error(`Reddit API error: ${postRes.status}`);
  return { postId: content.subreddit, subreddit: content.subreddit };
}

async function postToBlog(content) {
  if (!process.env.BLOG_POSTS_DIR) throw new Error("BLOG_POSTS_DIR not set");
  const fs = (await import("node:fs"));
  const path = (await import("node:path"));
  const date = new Date().toISOString().slice(0, 10);
  const filename = `${date}-${content.slug || content.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
  const filepath = path.join(process.env.BLOG_POSTS_DIR, filename);
  const frontmatter = `---\ntitle: "${content.title}"\ndate: ${date}\nslug: ${content.slug || filename.replace(".md", "")}\n---\n\n`;
  fs.writeFileSync(filepath, frontmatter + content.markdown);
  return { postId: filename, path: filepath };
}

async function postToDiscord(content) {
  if (!process.env.DISCORD_WEBHOOK_URL) throw new Error("DISCORD_WEBHOOK_URL not set");
  const res = await fetch(process.env.DISCORD_WEBHOOK_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: content.content, username: "Aurora Bot" }),
  });
  if (!res.ok) throw new Error(`Discord webhook error: ${res.status}`);
  return { postId: "discord", ok: true };
}

async function postToSlack(content) {
  if (!process.env.SLACK_WEBHOOK_URL) throw new Error("SLACK_WEBHOOK_URL not set");
  const res = await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: content.text }),
  });
  if (!res.ok) throw new Error(`Slack webhook error: ${res.status}`);
  return { postId: "slack", ok: true };
}

export const PUBLISHERS = {
  twitter: postToTwitter, linkedin: postToLinkedIn, reddit: postToReddit,
  blog: postToBlog, discord: postToDiscord, slack: postToSlack,
};

// ─── QUEUE MANAGEMENT ───
export function enqueuePost(manifest) {
  const validation = validateManifest(manifest);
  if (!validation.valid) return { ok: false, errors: validation.errors };
  const entry = { id: `post-${crypto.randomUUID()}`, manifest, attempts: 0, maxAttempts: 3, status: "queued", enqueuedAt: new Date().toISOString() };
  queue.push(entry);
  return { ok: true, id: entry.id, position: queue.length };
}

export async function processQueue(itemId = null) {
  const items = itemId ? queue.filter(q => q.id === itemId) : queue.filter(q => q.status === "queued" || q.status === "retry");
  const results = { posted: [], failed: [], skipped: [], retried: 0 };
  for (const item of items) {
    const rl = checkRateLimit(item.manifest.channel);
    if (!rl.allowed) {
      item.status = "rate_limited";
      results.skipped.push({ id: item.id, channel: item.manifest.channel, reason: `rate_limited (${Math.round(rl.resetIn / 1000)}s)` });
      continue;
    }
    const publisher = PUBLISHERS[item.manifest.channel];
    if (!publisher) {
      item.status = "failed";
      deadLetter.push({ ...item, error: "no_publisher", failedAt: new Date().toISOString() });
      results.failed.push({ id: item.id, channel: item.manifest.channel, error: "no_publisher" });
      continue;
    }
    try {
      const result = await publisher(item.manifest.content);
      item.status = "posted";
      item.postResult = result;
      results.posted.push({ id: item.id, channel: item.manifest.channel, result });
      logMemory("channel_metrics", {
        campaign_run_id: item.manifest.campaignRunId || null,
        channel: item.manifest.channel, metric_type: "posted", value: 1,
        metadata: JSON.stringify(result),
      });
    } catch (e) {
      item.attempts++;
      if (item.attempts >= item.maxAttempts) {
        item.status = "failed";
        deadLetter.push({ ...item, error: e.message, failedAt: new Date().toISOString() });
        results.failed.push({ id: item.id, channel: item.manifest.channel, error: e.message });
        logMemory("channel_metrics", {
          campaign_run_id: item.manifest.campaignRunId || null,
          channel: item.manifest.channel, metric_type: "post_failed", value: 1,
          metadata: JSON.stringify({ error: e.message, attempts: item.attempts }),
        });
      } else {
        item.status = "retry";
        results.retried++;
      }
    }
  }
  return results;
}

export function getQueueStats() {
  return {
    queued: queue.filter(q => q.status === "queued").length,
    retry: queue.filter(q => q.status === "retry").length,
    posted: queue.filter(q => q.status === "posted").length,
    failed: queue.filter(q => q.status === "failed").length,
    rate_limited: queue.filter(q => q.status === "rate_limited").length,
    total: queue.length, deadLetter: deadLetter.length,
  };
}

export function getDeadLetter() { return deadLetter; }
export function clearDeadLetter() { const count = deadLetter.length; deadLetter.length = 0; return { cleared: count }; }