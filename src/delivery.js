// ─────────────────────────────────────────────────────────────────────────────
// Aurora Revenue Engine — DELIVERY
//
// Delivery is the LAST stage of the commercial lifecycle: it puts the licence
// in front of the customer. A delivery is only as trustworthy as the licence
// it carries, so it always records entitlement_id + license_id + recipient.
//
// TRANSPORTS
//   A Transport is `{ name, async send(message) -> { messageId, status } }`.
//   * createCaptureTransport()  — RECORDS the message instead of sending it.
//     This is the default everywhere, including every test. No network.
//   * createResendTransport()   — the only real transport. It REQUIRES an api
//     key and MUST NOT be constructed unless a key is configured.
//
// IDEMPOTENCY
//   Delivering twice for the same entitlement + channel MUST NOT produce a
//   second real delivery. The durable guard is the idempotency_keys ledger
//   (scope 'delivery.send', key = entitlement id + channel). A FAILED
//   delivery is recorded and may be retried; a SUCCESSFUL delivery is never
//   repeated.
// ─────────────────────────────────────────────────────────────────────────────

import { nowIso, newId } from './db.js';

/** Canonical delivery status vocabulary. */
export const DELIVERY_STATUSES = Object.freeze(['scheduled', 'sent', 'captured', 'failed']);

/** Idempotency scope used for delivery sends. */
export const DELIVERY_SEND_SCOPE = 'delivery.send';

/** Typed error for delivery refusals. */
export class DeliveryError extends Error {
  constructor(code, message, details = {}) {
    super(message || code);
    this.name = 'DeliveryError';
    this.code = code;
    this.details = details;
  }
}

/** The idempotency key for a delivery: entitlement id + channel. */
export function deliveryIdempotencyKey(entitlementId, channel) {
  return `${entitlementId}::${channel}`;
}

/**
 * A transport that RECORDS messages instead of sending them.
 * Nothing leaves the process. This is the default transport.
 */
export function createCaptureTransport(options = {}) {
  const messages = [];
  const transport = {
    name: options.name ?? 'capture',
    messages,
    async send(message) {
      const messageId = `capture_${newId('msg').split('_').pop()}`;
      messages.push({ messageId, message });
      return { messageId, status: 'captured' };
    },
  };
  return transport;
}

/**
 * The real email transport.
 *
 * THROWS when the api key is absent — a transport without a key must never
 * exist, because "no key" would otherwise silently degrade into "pretend it
 * worked". The api key is never logged or stored.
 */
export function createResendTransport(apiKey, from) {
  if (!apiKey || !String(apiKey).trim()) {
    throw new DeliveryError(
      'delivery.transport_api_key_missing',
      'a resend transport requires an api key; refusing to construct one without it',
    );
  }
  if (!from || !String(from).trim()) {
    throw new DeliveryError(
      'delivery.transport_from_missing',
      'a resend transport requires a from address',
    );
  }
  // The `resend` package is imported lazily so that merely importing this
  // module never touches the network or the vendor SDK.
  let clientPromise = null;
  const getClient = async () => {
    if (!clientPromise) {
      clientPromise = import('resend').then((mod) => {
        const Resend = mod.Resend ?? mod.default;
        return new Resend(String(apiKey).trim());
      });
    }
    return clientPromise;
  };
  return {
    name: 'resend',
    async send(message) {
      const client = await getClient();
      const result = await client.emails.send({
        from: String(from).trim(),
        to: message?.to,
        subject: message?.subject,
        text: message?.text,
        html: message?.html,
      });
      if (result?.error) {
        throw new DeliveryError('delivery.provider_error', 'the mail provider rejected the message');
      }
      const messageId = result?.data?.id ?? newId('msg');
      return { messageId, status: 'sent' };
    },
  };
}

function rowToDelivery(row) {
  return row ? { ...row } : null;
}

/** All delivery rows for an entitlement. */
export function listDeliveries(db, entitlementId) {
  if (!entitlementId) return [];
  return db
    .prepare(`SELECT * FROM deliveries WHERE entitlement_id = ? ORDER BY created_at DESC`)
    .all(entitlementId)
    .map(rowToDelivery);
}
/**
 * Deliver the licence to the customer.
 *
 * IDEMPOTENT for (entitlement, channel): a second call returns the existing
 * successful delivery row without sending again.
 *
 * On a transport failure the delivery row is recorded as 'failed' with the
 * error, and the caller may retry later. The retry creates a NEW row (the
 * failed attempt stays as history) but there is never more than ONE
 * SUCCESSFUL delivery for the entitlement + channel.
 */
export async function deliver(
  db,
  { entitlement, license, customer, transport, artifact, channel = 'email', message } = {},
) {
  if (!db) throw new TypeError('deliver(db, ...) requires a db handle');
  if (!entitlement || !entitlement.id) {
    throw new DeliveryError('delivery.entitlement_missing', 'an entitlement is required to deliver');
  }
  if (!transport || typeof transport.send !== 'function') {
    throw new DeliveryError('delivery.transport_missing', 'a transport with a send() method is required');
  }
  const channelName = String(channel || 'email');
  const idemKey = deliveryIdempotencyKey(entitlement.id, channelName);

  // Already delivered successfully -> return the existing row, send nothing.
  const prior = db
    .prepare(
      `SELECT * FROM deliveries WHERE entitlement_id = ? AND channel = ? AND status IN ('sent','captured')
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(entitlement.id, channelName);
  if (prior) return rowToDelivery(prior);

  // The durable ledger is the second guard against a double real delivery.
  const ledger = db
    .prepare(`SELECT result_ref FROM idempotency_keys WHERE key = ? AND scope = ?`)
    .get(idemKey, DELIVERY_SEND_SCOPE);
  if (ledger?.result_ref) {
    const existing = getDelivery(db, ledger.result_ref);
    if (existing && (existing.status === 'sent' || existing.status === 'captured')) return existing;
  }

  const recipient = message?.to ?? customer?.email ?? entitlement.customer_email ?? null;
  if (!recipient) {
    throw new DeliveryError('delivery.recipient_missing', 'a delivery needs a recipient');
  }

  const deliveryId = newId('dlv');
  const ts = nowIso();
  const artifactRef = artifact?.ref ?? artifact?.license_key ?? license?.license_key ?? license?.id ?? null;

  // A previously FAILED attempt for the same entitlement + channel is REUSED,
  // so there is never more than one delivery row per entitlement + channel.
  // The failure history is preserved in the evidence log.
  const failed = db
    .prepare(
      `SELECT * FROM deliveries WHERE entitlement_id = ? AND channel = ? AND status = 'failed'
        ORDER BY created_at ASC LIMIT 1`,
    )
    .get(entitlement.id, channelName);
  const rowId = failed?.id ?? deliveryId;

  if (failed) {
    db.prepare(
      `UPDATE deliveries SET license_id = ?, customer_id = ?, recipient_ref = ?, artifact_ref = ?, status = 'scheduled', error = NULL WHERE id = ?`,
    ).run(
      license?.id ?? null,
      entitlement.customer_id ?? customer?.id ?? null,
      String(recipient),
      artifactRef ? String(artifactRef) : null,
      rowId,
    );
  } else {
    db.prepare(
      `INSERT INTO deliveries (
         id, fulfillment_run_id, entitlement_id, license_id, customer_id, channel,
         recipient_ref, artifact_ref, status, provider_message_id, error, created_at, sent_at
       ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'scheduled', NULL, NULL, ?, NULL)`,
    ).run(
      rowId,
      entitlement.id,
      license?.id ?? null,
      entitlement.customer_id ?? customer?.id ?? null,
      channelName,
      String(recipient),
      artifactRef ? String(artifactRef) : null,
      ts,
    );
  }

  const payload = {
    to: String(recipient),
    subject: message?.subject ?? `Your ${license?.tier ?? 'Aurora'} licence`,
    text:
      message?.text ??
      [
        'Thank you for your purchase.',
        '',
        `Licence key: ${license?.license_key ?? '(pending)'}`,
        `Product: ${entitlement.product_id ?? 'unknown'}`,
        artifact?.download_url ? `Download: ${artifact.download_url}` : null,
      ]
        .filter((line) => line !== null)
        .join('\n'),
    html: message?.html,
    licenseKey: license?.license_key ?? null,
    entitlementId: entitlement.id,
  };

  try {
    const result = await transport.send(payload);
    const status = DELIVERY_STATUSES.includes(result?.status) ? result.status : 'sent';
    db.prepare(
      `UPDATE deliveries SET status = ?, provider_message_id = ?, error = NULL, sent_at = ? WHERE id = ?`,
    ).run(status, result?.messageId ?? null, nowIso(), rowId);

    db.prepare(
      `INSERT OR IGNORE INTO idempotency_keys (key, scope, result_ref) VALUES (?, ?, ?)`,
    ).run(idemKey, DELIVERY_SEND_SCOPE, rowId);

    return getDelivery(db, rowId);
  } catch (err) {
    const messageText = err?.message ? String(err.message) : 'delivery failed';
    db.prepare(`UPDATE deliveries SET status = 'failed', error = ?, sent_at = NULL WHERE id = ?`).run(
      messageText,
      rowId,
    );
    const failedRow = getDelivery(db, rowId);
    failedRow.error = messageText;
    return failedRow;
  }
}

/** Count the SUCCESSFUL deliveries for an entitlement + channel. */
export function countSuccessfulDeliveries(db, entitlementId, channel = 'email') {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM deliveries
        WHERE entitlement_id = ? AND channel = ? AND status IN ('sent','captured')`,
    )
    .get(entitlementId, String(channel));
  return row?.n ?? 0;
}

export default {
  DELIVERY_STATUSES,
  DELIVERY_SEND_SCOPE,
  DeliveryError,
  deliveryIdempotencyKey,
  createCaptureTransport,
  createResendTransport,
  deliver,
  getDelivery,
  listDeliveries,
  countSuccessfulDeliveries,
};


/** One delivery row by id. */
export function getDelivery(db, deliveryId) {
  if (!deliveryId) return null;
  return rowToDelivery(db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(deliveryId));
}
