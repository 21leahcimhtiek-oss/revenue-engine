// ─── SELF-HEALING + AUTONOMY LOOPS ───
// Watchdog: health checks, auto-repair, environment validation, log rotation.
import { logMemory } from "./memory.js";

export async function checkHealth() {
  const issues = [];
  const services = {};
  const now = new Date().toISOString();

  // 1. Check pm2 processes
  try {
    const { execSync } = await import("node:child_process");
    const pm2Out = execSync("pm2 jlist", { encoding: "utf8", shell: true });
    const procs = JSON.parse(pm2Out.trim().split("\n").pop() || "[]");
    for (const p of procs) {
      const name = p.name;
      const status = p.pm2_env?.status || "unknown";
      services[name] = status;
      if (status !== "online") issues.push(`pm2 process "${name}" status: ${status}`);
    }
  } catch (e) {
    issues.push(`pm2 check failed: ${e.message}`);
    services.pm2 = "error";
  }

  // 2. Check Docker containers
  try {
    const { execSync } = await import("node:child_process");
    const dockerOut = execSync("docker ps --format \"{{.Names}}|{{.Status}}\"", { encoding: "utf8", shell: true });
    for (const line of dockerOut.trim().split("\n").filter(Boolean)) {
      const [name, status] = line.split("|");
      services[`docker-${name}`] = status;
      if (status === "Exited" || status.includes("unhealthy")) {
        issues.push(`docker container "${name}" status: ${status}`);
      }
    }
  } catch (e) {
    issues.push(`docker check failed: ${e.message}`);
    services.docker = "error";
  }

  // 3. Check Stripe connectivity
  try {
    const Stripe = (await import("stripe")).default;
    if (process.env.STRIPE_SECRET_KEY?.startsWith("sk_")) {
      const s = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
      await s.accounts.retrieve();
      services.stripe = "ok";
    } else {
      services.stripe = "missing_key";
      issues.push("STRIPE_SECRET_KEY missing or invalid");
    }
  } catch (e) {
    services.stripe = "error";
    issues.push(`stripe check failed: ${e.message}`);
  }

  // 4. Check price IDs
  const priceIds = [
    "PRICE_STARTER", "PRICE_SKILL_PACK_LITE", "PRICE_SKILL_PACK_STD",
    "PRICE_SKILL_PACK_ELITE", "PRICE_PRO_ANNUAL", "PRICE_MCP_SUITE",
  ];
  for (const pid of priceIds) {
    if (!process.env[pid]) {
      issues.push(`missing env var: ${pid}`);
    }
  }
  services.priceIds = priceIds.filter(p => process.env[p]).length;

  // 5. Check n8n workflows
  try {
    const { execSync } = await import("node:child_process");
    const wfOut = execSync("docker exec n8n n8n list:workflow --raw --active=true 2>&1", { encoding: "utf8", shell: true });
    services.n8nWorkflows = wfOut.trim().split("\n").filter(Boolean).length;
  } catch (e) {
    issues.push("n8n workflow check failed");
    services.n8nWorkflows = "error";
  }

  // 6. Check critical env vars
  const criticalEnvs = ["CCPI_SESSION_JWT_SECRET", "SMTP_HOST", "SMTP_USER", "SITE_URL"];
  for (const env of criticalEnvs) {
    if (!process.env[env]) issues.push(`missing env var: ${env}`);
  }

  const healthy = issues.length === 0;
  logMemory("channel_metrics", {
    channel: "watchdog", metric_type: "health_check",
    value: healthy ? 1 : 0,
    metadata: JSON.stringify({ issues, services, healthy, checkedAt: now }),
  });

  return { healthy, issues, services, checkedAt: now };
}

export async function autoRepair(issues) {
  const repairs = [];
  const { execSync } = await import("node:child_process");

  for (const issue of issues) {
    // Restart crashed pm2 processes
    const pm2Match = issue.match(/pm2 process "(.*?)" status/);
    if (pm2Match) {
      const procName = pm2Match[1];
      try {
        execSync(`pm2 restart ${procName} --update-env`);
        repairs.push(`restarted pm2 process: ${procName}`);
      } catch (e) {
        repairs.push(`failed to restart ${procName}: ${e.message}`);
      }
    }

    // Restart exited Docker containers
    if (issue.includes("docker container") && issue.includes("Exited")) {
      const dockerMatch = issue.match(/docker container "(.*?)"/);
      if (dockerMatch) {
        const container = dockerMatch[1];
        try {
          execSync(`docker restart ${container}`);
          repairs.push(`restarted docker container: ${container}`);
        } catch (e) {
          repairs.push(`failed to restart ${container}: ${e.message}`);
        }
      }
    }
  }

  return { repairs, remainingIssues: issues.length - repairs.length };
}

export function ensurePriceIds() {
  const required = ["PRICE_STARTER", "PRICE_SKILL_PACK_LITE", "PRICE_SKILL_PACK_STD",
    "PRICE_SKILL_PACK_ELITE", "PRICE_PRO_ANNUAL", "PRICE_MCP_SUITE"];
  const missing = required.filter(p => !process.env[p]);
  return { allPresent: missing.length === 0, missing };
}

export function ensureWorkflowsActive() {
  return { status: "checked", note: "run from n8n health-check workflow hourly" };
}

export async function rotateLogs() {
       const fs = await import("node:fs");
  const path = await import("node:path");
  const logDir = path.join(process.env.USERPROFILE || "", ".pm2", "logs");
  let rotated = [];
  try {
    const files = fs.readdirSync(logDir).filter(f => f.endsWith(".log") && fs.statSync(path.join(logDir, f)).size > 5 * 1024 * 1024);
    for (const f of files) {
      fs.renameSync(path.join(logDir, f), path.join(logDir, `${f}.${new Date().toISOString().slice(0, 10).replace(/:/g, "-")}.bak`));
      rotated.push(f);
    }
  } catch (e) {
    return { rotated: 0, error: e.message };
  }
  return { rotated: rotated.length, files: rotated };
}