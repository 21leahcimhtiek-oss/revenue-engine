// Aurora Revenue Engine — WEBHOOK INTAKE.
//
// The intake's job ends at: "event recorded, normalised, deduplicated, verified or
// rejected". It does NOT fulfil anything, mint anything, or email anyone.
//
// FAIL-CLOSED CONTRACT
//   * No secret configured            -> REFUSED (`no_secret`). Never accepted.
//   * Bad / missing signature         -> REJECTED (`invalid_signature`).
//   * Unparseable body                -> REJECTED and RECORDED (`malformed_payload`).
//   * Unsupported event type          -> REJECTED and RECORDED (`unsupported_event`).
//   * Repeat of a known provider event-> `duplicate`: no second row, no effect.
//   * Payment evidence missing        -> recorded `unverified`, NEVER fulfilled.
import crypto from "node:crypto";
import {
  VERIFICATION,
  PROCESSING,
  normalizeEvent,
  persistEvent,
  recordEvidence,
  sha256Hex,
  nowIsoString,
} from "./events.js";
import { normalizeStripeEvent, STRIPE_PROVIDER } from "./stripe-boundary.js";

/** Typed error for signature verification problems. */
export class WebhookSignatureError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "WebhookSignatureError";
    this.code = code;
  }
}

/** Event types this engine understands. Everything else is unsupported. */
export const SUPPORTED_EVENT_TYPES = Object.freeze([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "invoice.paid",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Verify a Stripe signature header.
 *
 * Uses the Stripe SDK's `stripe.webhooks.constructEvent` when a Stripe instance
 * is supplied via `options.stripeClient`. When no instance is supplied it falls
 * back to a local, offline HMAC-SHA256 verification of the Stripe signature
 * scheme (`t=<ts>,v1=<hmac>`), so the function is fully testable with NO Stripe
 * key and NO network access.
 *
 * @throws {WebhookSignatureError} code 'no_secret' when no secret is configured.
 * @returns {boolean} true only when the signature is valid.
 */
export function verifyStripeSignature(rawBody, signatureHeader, secret, options = {}) {
  if (!secret || typeof secret !== "string" || !secret.trim()) {
    throw new WebhookSignatureError("no_secret", "no webhook secret configured");
  }
  if (typeof rawBody !== "string" && !Buffer.isBuffer(rawBody)) {
    throw new WebhookSignatureError("invalid_signature", "raw body must be a string or Buffer");
  }
  if (!signatureHeader || typeof signatureHeader !== "string") return false;

  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;

  // Preferred path: an injected Stripe client (never constructed by this module).
  const client = options.stripeClient;
  if (client && client.webhooks && typeof client.webhooks.constructEvent === "function") {
    try {
      client.webhooks.constructEvent(payload, signatureHeader, secret);
      return true;
    } catch {
      return false;
    }
  }

  // Offline fallback: Stripe signature scheme.
  const parts = signatureHeader.split(",").map((p) => p.trim());
  const timestamp = parts.find((p) => p.startsWith("t="))?.slice(2);
  const signatures = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!timestamp || signatures.length === 0) return false;

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (tolerance > 0) {
    const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
    if (!Number.isFinite(age) || age > tolerance) return false;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`, "utf8")
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "utf8");
  for (const sig of signatures) {
    const candidate = Buffer.from(sig, "utf8");
    if (candidate.length === expectedBuf.length && crypto.timingSafeEqual(candidate, expectedBuf)) {
      return true;
    }
  }
  return false;
}

/** Does this raw Stripe event assert a genuine payment (invoice.paid)? */
function isPaidInvoice(object) {
  if (!object || typeof object !== "object") return false;
  if (typeof object.amount_paid === "number" && object.amount_paid > 0) return true;
  if (object.status === "paid" && typeof object.amount_due === "number" && object.amount_due > 0) {
    return true;
  }
  return false;
}

/**
 * Record a rejected event (malformed payload or unsupported type).
 * Rejected events are still persisted so the attempt is auditable.
 */
function recordRejected(db, { providerEventId, eventType, sourceMode, rawBody, reason, verificationStatus }) {
  const event = normalizeEvent({
    provider: STRIPE_PROVIDER,
    provider_event_id: providerEventId,
    event_type: eventType,
    occurred_at: nowIsoString(),
    received_at: nowIsoString(),
    verification_status: verificationStatus,
    processing_status: PROCESSING.REJECTED,
    source_mode: sourceMode,
    raw_payload_hash: sha256Hex(rawBody ?? ""),
    payload_json: JSON.stringify({ rejected: true, reason }),
  });
  const result = persistEvent(db, event);
  if (!result.duplicate) {
    recordEvidence(db, "webhook.rejected", result.event.event_id, { reason, event_type: eventType }, event.raw_payload_hash);
  }
  return result;
}

/**
 * Ingest a Stripe webhook event.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} options
 * @param {string|Buffer} options.rawBody   the EXACT bytes Stripe signed
 * @param {string} options.signature        the `stripe-signature` header value
 * @param {string} options.secret           the webhook signing secret
 * @param {string} [options.sourceMode]     'webhook' | 'poll' | 'manual' | 'synthetic'
 * @returns {object} { outcome, event, duplicate, verified, reason }
 *          outcome ∈ no_secret | invalid_signature | malformed_payload |
 *                    unsupported_event | duplicate | accepted
 */
export function ingestWebhookEvent(db, options = {}) {
  const { rawBody, signature, secret } = options;
  const sourceMode = options.sourceMode || "webhook";

  if (!secret || typeof secret !== "string" || !secret.trim()) {
    return {
      outcome: "no_secret",
      accepted: false,
      duplicate: false,
      verified: false,
      event: null,
      reason: "no webhook secret configured — refusing to accept the event",
    };
  }

  let valid = false;
  try {
    valid = verifyStripeSignature(rawBody, signature, secret, {
      stripeClient: options.stripeClient,
      toleranceSeconds: options.toleranceSeconds,
    });
  } catch (err) {
    if (err instanceof WebhookSignatureError && err.code === "no_secret") {
      return {
        outcome: "no_secret",
        accepted: false,
        duplicate: false,
        verified: false,
        event: null,
        reason: err.message,
      };
    }
    valid = false;
  }
  if (!valid) {
    return {
      outcome: "invalid_signature",
      accepted: false,
      duplicate: false,
      verified: false,
      event: null,
      reason: "signature verification failed",
    };
  }

  const bodyText = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody ?? "");
  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch (err) {
    parseError = err.message;
  }

  if (parseError || !parsed || typeof parsed !== "object" || typeof parsed.id !== "string" || !parsed.id) {
    const rejected = recordRejected(db, {
      providerEventId: `malformed_${sha256Hex(bodyText).slice(0, 32)}`,
      eventType: "unknown",
      sourceMode,
      rawBody: bodyText,
      reason: "malformed_payload",
      verificationStatus: VERIFICATION.REJECTED,
    });
    return {
      outcome: "malformed_payload",
      accepted: false,
      duplicate: rejected.duplicate,
      verified: false,
      event: rejected.event,
      reason: parseError || "payload is not a usable provider event",
    };
  }

  const eventType = String(parsed.type ?? "unknown");
  if (!SUPPORTED_EVENT_TYPES.includes(eventType)) {
    const rejected = recordRejected(db, {
      providerEventId: parsed.id,
      eventType,
      sourceMode,
      rawBody: bodyText,
      reason: "unsupported_event",
      verificationStatus: VERIFICATION.REJECTED,
    });
    return {
      outcome: "unsupported_event",
      accepted: false,
      duplicate: rejected.duplicate,
      verified: false,
      event: rejected.event,
      reason: `event type ${eventType} is not supported`,
    };
  }

  let event;
  try {
    event = normalizeStripeEvent(parsed, { sourceMode, rawBody: bodyText });
  } catch (err) {
    const rejected = recordRejected(db, {
      providerEventId: parsed.id,
      eventType,
      sourceMode,
      rawBody: bodyText,
      reason: "malformed_payload",
      verificationStatus: VERIFICATION.REJECTED,
    });
    return {
      outcome: "malformed_payload",
      accepted: false,
      duplicate: rejected.duplicate,
      verified: false,
      event: rejected.event,
      reason: err.message,
    };
  }

  // An invoice.paid event carries its own payment assertion.
  if (eventType === "invoice.paid") {
    const object = parsed.data?.object ?? parsed.object ?? null;
    if (isPaidInvoice(object)) {
      event.verification_status = VERIFICATION.VERIFIED;
      event.amount = typeof object.amount_paid === "number" ? object.amount_paid : event.amount;
      event.currency = object.currency ?? event.currency;
      event.payment_reference = object.payment_intent ?? object.id ?? event.payment_reference;
    }
  }

  const persisted = persistEvent(db, event);
  if (persisted.duplicate) {
    recordEvidence(
      db,
      "webhook.duplicate",
      persisted.event.event_id,
      { provider_event_id: persisted.event.provider_event_id },
      persisted.event.raw_payload_hash,
    );
    return {
      outcome: "duplicate",
      accepted: true,
      duplicate: true,
      verified: persisted.event.verification_status === VERIFICATION.VERIFIED,
      event: persisted.event,
      reason: "provider event already recorded — no downstream effect",
    };
  }

  recordEvidence(
    db,
    "webhook.accepted",
    persisted.event.event_id,
    {
      provider_event_id: persisted.event.provider_event_id,
      event_type: persisted.event.event_type,
      verification_status: persisted.event.verification_status,
    },
    persisted.event.raw_payload_hash,
  );

  return {
    outcome: "accepted",
    accepted: true,
    duplicate: false,
    verified: persisted.event.verification_status === VERIFICATION.VERIFIED,
    event: persisted.event,
    reason: null,
  };
}

/**
 * Promote a previously recorded UNVERIFIED event to VERIFIED, e.g. when a later
 * poll confirms the payment. This is a legitimate, evidence-backed transition.
 */
export function promoteEventToVerified(db, providerEventId, evidence) {
  if (!db) throw new TypeError("promoteEventToVerified requires a db handle");
  if (!providerEventId) throw new TypeError("promoteEventToVerified requires providerEventId");

  const row = db
    .prepare(`SELECT * FROM revenue_events WHERE provider_event_id = ? ORDER BY rowid DESC LIMIT 1`)
    .get(providerEventId);
  if (!row) return { promoted: false, event: null, reason: "event not found" };
  if (row.verification_status === VERIFICATION.VERIFIED) {
    return { promoted: false, event: row, reason: "already verified" };
  }

  db.prepare(
    `UPDATE revenue_events SET verification_status = ?, processing_status = ? WHERE event_id = ?`,
  ).run(VERIFICATION.VERIFIED, PROCESSING.PENDING, row.event_id);

  recordEvidence(
    db,
    "event.promoted_verified",
    row.event_id,
    evidence ?? { reason: "confirmed by provider poll" },
    row.raw_payload_hash,
  );

  const updated = db.prepare(`SELECT * FROM revenue_events WHERE event_id = ?`).get(row.event_id);
  return { promoted: true, event: updated, reason: null };
}

export default {
  ingestWebhookEvent,
  verifyStripeSignature,
  promoteEventToVerified,
  WebhookSignatureError,
  SUPPORTED_EVENT_TYPES,
};

