// ─── INPUT VALIDATION UTILITIES ───
// Shared validators for all routes. Fail fast with clear error messages.

const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function validateEmail(email) {
  if (!email || typeof email !== "string") return { valid: false, error: "email is required" };
  const clean = email.toLowerCase().trim();
  if (!EMAIL_REGEX.test(clean)) return { valid: false, error: "invalid email format" };
  return { valid: true, value: clean };
}

export function validateAmount(amount) {
  const n = typeof amount === "string" ? parseInt(amount) : amount;
  if (typeof n !== "number" || isNaN(n) || n < 1) return { valid: false, error: "amount must be a positive integer (cents)" };
  return { valid: true, value: n };
}

export function validateURL(url) {
  if (!url || typeof url !== "string") return { valid: false, error: "url is required" };
  try { new URL(url); return { valid: true, value: url }; }
  catch { return { valid: false, error: "invalid URL" }; }
}

export function validateStatus(status, allowed = ["new", "contacted", "won", "dead"]) {
  if (!status) return { valid: false, error: "status is required" };
  if (!allowed.includes(status)) return { valid: false, error: `status must be one of: ${allowed.join(", ")}` };
  return { valid: true, value: status };
}

export function validateLeadId(id) {
  if (!id || typeof id !== "string") return { valid: false, error: "id is required" };
  return { valid: true, value: id };
}

export function validateInvoiceId(id) {
  if (!id || !id.startsWith("in_")) return { valid: false, error: "invalid invoice id format" };
  return { valid: true, value: id };
}

// Express middleware factory — validates a set of fields on req.body
export function bodyValidator(validators) {
  return (req, res, next) => {
    const errors = [];
    for (const [field, validator] of Object.entries(validators)) {
      if (field.endsWith("?")) continue; // optional, skip if not present
      const result = validator(req.body?.[field]);
      if (!result.valid) errors.push(`${field}: ${result.error}`);
    }
    if (errors.length) return res.status(400).json({ error: "validation_failed", details: errors });
    next();
  };
}

// Ensure critical env vars are present at startup
export function validateEnv() {
  const required = ["STRIPE_SECRET_KEY", "CCPI_SESSION_JWT_SECRET", "SITE_URL"];
  const missing = required.filter(k => !process.env[k]);
  const warnings = [];
  if (!process.env.SMTP_HOST && !process.env.RESEND_API_KEY) {
    warnings.push("No email provider configured (SMTP_HOST or RESEND_API_KEY missing) — emails will dry-run");
  }
  return { ok: missing.length === 0, missing, warnings };
}

export default { validateEmail, validateAmount, validateURL, validateStatus, validateLeadId, validateInvoiceId, bodyValidator, validateEnv };