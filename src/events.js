// Aurora Revenue Engine — payment event boundary: normalized revenue event model + persistence.
//
// PRINCIPLE: status is not evidence. A string saying "paid" is not proof of payment.
// This module owns the canonical shape of a revenue event and its persistence rules.
import { nowIso, newId, sha256 } from "./db.js";

export const VERIFICATION = Object.freeze({
  VERIFIED: "verified",
  REJECTED: "rejected",
  UNVERIFIED: "unverified",
});

export const PROCESSING = Object.freeze({
  PENDING: "pending",
  PROCESSED: "processed",
  REJECTED: "rejected",
  FAILED: "failed",
});

export const SOURCE_MODES = Object.freeze(["webhook", "poll", "manual", "synthetic"]);

export const EVENT_FIELDS = Object.freeze([
  "event_id",
  "provider",
  "provider_event_id",
  "event_type",
  "customer_id",
  "customer_email",
  "provider_customer_id",
  "product_id",
  "price_reference",
  "payment_reference",
  "subscription_reference",
  "amount",
  "currency",
  "occurred_at",
  "received_at",
  "verification_status",
  "processing_status",
  "idempotency_key",
  "source_mode",
  "raw_payload_hash",
  "payload_json",
]);

export function sha256Hex(value) {
  return sha256(value);
}

export function nowIsoString() {
  return nowIso();
}

export function newIdString(prefix) {
  return newId(prefix);
}

/** Loads the sibling schema module (owned by another lane) without hard-failing. */
export async function loadDbModule() {
  try {
    return await import("./db.js");
  } catch {
    return null;
  }
}

/**
 * STABLE idempotency key derived ONLY from provider + provider_event_id.
 * Never derived from a secret, a timestamp, or a payload body.
 */
export function idempotencyKeyFor(event) {
  const provider = String(event?.provider ?? "").trim();
  const providerEventId = String(event?.provider_event_id ?? "").trim();
  if (!provider || !providerEventId) {
    throw new Error("idempotencyKeyFor requires provider and provider_event_id");
  }
  return `re_evt_${sha256Hex(`${provider}|${providerEventId}`)}`;
}

/** Normalizes any provider payload into the canonical revenue event shape. */
export function normalizeEvent(input = {}) {
  const provider = String(input.provider ?? "unknown").trim() || "unknown";
  const providerEventId = String(input.provider_event_id ?? "").trim();
  if (!providerEventId) throw new Error("normalizeEvent requires provider_event_id");

  const sourceMode = SOURCE_MODES.includes(input.source_mode) ? input.source_mode : "manual";
  const amountRaw = input.amount;
  const amount =
    amountRaw === undefined || amountRaw === null || amountRaw === ""
      ? null
      : Math.round(Number(amountRaw));

  const payloadJson =
    typeof input.payload_json === "string"
      ? input.payload_json
      : JSON.stringify(input.payload_json ?? null);

  return {
    event_id: input.event_id ?? null,
    provider,
    provider_event_id: providerEventId,
    event_type: input.event_type ?? null,
    customer_id: input.customer_id ?? null,
    customer_email: input.customer_email ?? null,
    provider_customer_id: input.provider_customer_id ?? null,
    product_id: input.product_id ?? null,
    price_reference: input.price_reference ?? null,
    payment_reference: input.payment_reference ?? null,
    subscription_reference: input.subscription_reference ?? null,
    amount,
    currency: input.currency ?? null,
    occurred_at: input.occurred_at ?? nowIsoString(),
    received_at: input.received_at ?? nowIsoString(),
    verification_status: input.verification_status ?? VERIFICATION.UNVERIFIED,
    processing_status: input.processing_status ?? PROCESSING.PENDING,
    idempotency_key: input.idempotency_key ?? idempotencyKeyFor({ provider, provider_event_id: providerEventId }),
    source_mode: sourceMode,
    raw_payload_hash: input.raw_payload_hash ?? null,
    payload_json: payloadJson,
  };
}
/** Columns of the `revenue_events` row, in schema order. */
const EVENT_COLUMNS = [
  "event_id",
  "provider",
  "provider_event_id",
  "event_type",
  "customer_id",
  "customer_email",
  "provider_customer_id",
  "product_id",
  "price_reference",
  "payment_reference",
  "subscription_reference",
  "amount",
  "currency",
  "occurred_at",
  "received_at",
  "verification_status",
  "processing_status",
  "idempotency_key",
  "source_mode",
  "raw_payload_hash",
  "payload_json",
];

/** Map a DB row back to the canonical event object shape. */
export function eventFromRow(row) {
  if (!row) return null;
  const event = {};
  for (const col of EVENT_COLUMNS) {
    event[col] = row[col] === undefined ? null : row[col];
  }
  return event;
}

/**
 * Persist a normalized revenue event, enforcing idempotency.
 *
 * A second insert of the same provider event (same provider + provider_event_id,
 * or the same derived idempotency key) MUST be reported as `duplicate: true`,
 * MUST NOT create a second row, and MUST NOT trigger a second downstream effect.
 */
export function persistEvent(db, event) {
  if (!db) throw new TypeError("persistEvent(db, event) requires a db handle");
  if (!event) throw new TypeError("persistEvent(db, event) requires an event");

  const normalized = {
    ...event,
    idempotency_key: event.idempotency_key || idempotencyKeyFor(event),
    event_id: event.event_id || newIdString("evt"),
  };

  const findExisting = db.prepare(
    `SELECT * FROM revenue_events
      WHERE idempotency_key = ?
         OR (provider = ? AND provider_event_id = ?)`,
  );

  const existing = findExisting.get(
    normalized.idempotency_key,
    normalized.provider,
    normalized.provider_event_id,
  );
  if (existing) {
    return { event: eventFromRow(existing), duplicate: true };
  }

  const values = EVENT_COLUMNS.map((c) => normalized[c] ?? null);
  const placeholders = EVENT_COLUMNS.map(() => "?").join(", ");
  try {
    db.prepare(
      `INSERT INTO revenue_events (${EVENT_COLUMNS.join(", ")})
       VALUES (${placeholders})`,
    ).run(...values);
  } catch (err) {
    // Lost a race against a concurrent insert: the row exists, so it is a duplicate.
    const raced = findExisting.get(
      normalized.idempotency_key,
      normalized.provider,
      normalized.provider_event_id,
    );
    if (raced) return { event: eventFromRow(raced), duplicate: true };
    throw err;
  }

  const inserted = db
    .prepare(`SELECT * FROM revenue_events WHERE event_id = ?`)
    .get(normalized.event_id);

  // Durable idempotency ledger (secondary guard; the UNIQUE index is primary).
  try {
    db.prepare(
      `INSERT OR IGNORE INTO idempotency_keys (key, scope, result_ref)
       VALUES (?, ?, ?)`,
    ).run(normalized.idempotency_key, "revenue_event", normalized.event_id);
  } catch {
    /* ledger table is advisory only — never fail the event write because of it */
  }

  return { event: eventFromRow(inserted) || normalized, duplicate: false };
}

/**
 * Record evidence (the link between a provider fact and a local effect).
 * The payload is stored as JSON; secrets must never be passed in.
 */
export function recordEvidence(db, kind, subjectId, payload, sourceFingerprint) {
  if (!db) throw new TypeError("recordEvidence(db, ...) requires a db handle");
  if (!kind) throw new TypeError("recordEvidence requires a kind");
  const id = newIdString("evd");
  const payloadJson = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
  db.prepare(
    `INSERT INTO evidence (id, kind, subject_id, payload_json, source_fingerprint)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, kind, subjectId ?? null, payloadJson, sourceFingerprint ?? null);
  return { id, kind, subject_id: subjectId ?? null, payload_json: payloadJson, source_fingerprint: sourceFingerprint ?? null };
}

