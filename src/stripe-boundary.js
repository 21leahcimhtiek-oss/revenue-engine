// Aurora Revenue Engine — STRIPE BOUNDARY.
//
// All provider-specific knowledge lives HERE. The rest of the engine must never
// parse a Stripe payload.
//
// FAIL-CLOSED CONTRACT
//   * A checkout session is PAID only when payment_status === 'paid', or when
//     payment_status === 'no_payment_required' AND the resolved price is a
//     genuinely free/zero-amount product.
//   * 'complete' status alone is NEVER proof of payment.
//   * An unknown price NEVER resolves to a product (product_id stays null) and
//     NEVER becomes a "tier".
//   * Secrets are never stored. The raw payload is reduced to a redacted summary
//     plus a sha256 fingerprint of the canonical raw body.
import {
  VERIFICATION,
  PROCESSING,
  normalizeEvent,
  sha256Hex,
  nowIsoString,
} from "./events.js";
import { resolveProductByPrice as defaultResolveProductByPrice } from "./catalog.js";

export const STRIPE_PROVIDER = "stripe";

/** Keys that must never be persisted, at any depth. */
const FORBIDDEN_KEYS = new Set([
  "client_secret",
  "api_key",
  "apikey",
  "secret",
  "webhook_secret",
  "signing_secret",
  "password",
  "authorization",
  "access_token",
  "refresh_token",
  "card",
  "cvc",
  "number",
]);

/** Recursively strip forbidden keys from a value. */
export function redact(value, depth = 0) {
  if (depth > 6) return "[depth_limit]";
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(String(k).toLowerCase())) {
        out[k] = "[redacted]";
        continue;
      }
      out[k] = redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && /^(whsec_|sk_live_|sk_test_|rk_live_|rk_test_)/.test(value)) {
    return "[redacted]";
  }
  return value;
}

/** Canonical (stable) JSON serialisation, used for hashing. */
export function canonicalJson(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

/** Resolve a price id to a catalog product. Never throws; unknown price -> null. */
export function resolvePriceProduct(priceId, options = {}) {
  const resolver = options.resolveProductByPrice || defaultResolveProductByPrice;
  if (!priceId) return null;
  try {
    const product = resolver(priceId, options.env ? { env: options.env } : {});
    if (!product || !product.product_id) return null;
    return product;
  } catch {
    return null; // catalog problems fail closed
  }
}

/** Extract the provider price id from a checkout session (best effort). */
export function extractPriceId(session) {
  if (!session || typeof session !== "object") return null;
  if (session.price && typeof session.price === "object" && session.price.id) return session.price.id;
  if (typeof session.price_id === "string" && session.price_id) return session.price_id;
  const items = session.line_items?.data;
  if (Array.isArray(items) && items[0]?.price?.id) return items[0].price.id;
  if (session.metadata && typeof session.metadata.price_id === "string") return session.metadata.price_id;
  return null;
}

/** Is the resolved product genuinely free / zero-amount? */
export function isFreeProduct(product) {
  if (!product) return false;
  if (product.starter_pack === true) return true;
  if (product.product_type === "free" || product.product_type === "zero") return true;
  if (product.is_free === true) return true;
  for (const key of ["amount", "amount_cents", "unit_amount", "price_amount", "price_cents"]) {
    if (product[key] !== undefined && product[key] !== null) return Number(product[key]) === 0;
  }
  return false;
}

/**
 * FAIL CLOSED: is this checkout session a genuinely paid session?
 * `status === 'complete'` is NOT sufficient. `payment_status` is the evidence.
 */
export function isPaidSession(session, options = {}) {
  if (!session || typeof session !== "object") return false;
  const paymentStatus = typeof session.payment_status === "string" ? session.payment_status : null;
  if (paymentStatus === "paid") return true;
  if (paymentStatus === "no_payment_required") {
    const priceId = extractPriceId(session);
    if (!priceId) return false;
    const product = resolvePriceProduct(priceId, options);
    return isFreeProduct(product);
  }
  return false;
}

/** Redacted, compact summary of a checkout session. Never contains secrets. */
function summariseSession(session) {
  if (!session || typeof session !== "object") return { kind: "checkout_session", present: false };
  return {
    kind: "checkout_session",
    present: true,
    id: session.id ?? null,
    object: session.object ?? null,
    status: session.status ?? null,
    payment_status: session.payment_status ?? null,
    amount_total: typeof session.amount_total === "number" ? session.amount_total : null,
    currency: session.currency ?? null,
    mode: session.mode ?? null,
    customer: session.customer ?? null,
    subscription: session.subscription ?? null,
    payment_intent: session.payment_intent ?? null,
    client_reference_id: session.client_reference_id ?? null,
    customer_email: session.customer_details?.email ?? session.customer_email ?? null,
    created: typeof session.created === "number" ? session.created : null,
    line_item_price_ids: Array.isArray(session.line_items?.data)
      ? session.line_items.data.map((li) => li?.price?.id).filter(Boolean)
      : [],
  };
}

/** Build the canonical event fields shared by the webhook and poll paths. */
function buildEvent({ providerEventId, eventType, session, product, sourceMode, rawBody, rawObject, options }) {
  const priceId = extractPriceId(session);
  const paid = isPaidSession(session, options ?? {});
  const amount = typeof session?.amount_total === "number" ? session.amount_total : null;
  const occurredAt =
    typeof session?.created === "number"
      ? new Date(session.created * 1000).toISOString()
      : nowIsoString();

  const payloadJson = JSON.stringify(
    redact({
      provider_event_id: providerEventId,
      event_type: eventType,
      session: summariseSession(session),
      object: rawObject ?? null,
    }),
  );

  return normalizeEvent({
    provider: STRIPE_PROVIDER,
    provider_event_id: providerEventId,
    event_type: eventType,
    customer_id: null,
    customer_email: session?.customer_details?.email ?? session?.customer_email ?? null,
    provider_customer_id: session?.customer ?? null,
    product_id: product ? product.product_id : null,
    price_reference: priceId ?? null,
    payment_reference: session?.payment_intent ?? null,
    subscription_reference: session?.subscription ?? null,
    amount,
    currency: session?.currency ?? null,
    occurred_at: occurredAt,
    received_at: nowIsoString(),
    verification_status: paid ? VERIFICATION.VERIFIED : VERIFICATION.UNVERIFIED,
    processing_status: PROCESSING.PENDING,
    source_mode: sourceMode,
    raw_payload_hash: sha256Hex(rawBody ?? canonicalJson(session)),
    payload_json: payloadJson,
  });
}

/**
 * Normalize a raw Stripe webhook event into a revenue event.
 * Unknown/unsupported event types still normalise (verification = unverified).
 */
export function normalizeStripeEvent(rawEvent, options = {}) {
  const sourceMode = options.sourceMode || "webhook";
  if (!rawEvent || typeof rawEvent !== "object") {
    throw new TypeError("normalizeStripeEvent requires a raw event object");
  }
  const providerEventId = String(rawEvent.id ?? "").trim();
  if (!providerEventId) throw new TypeError("stripe event has no id");

  const eventType = String(rawEvent.type ?? "unknown");
  const object = rawEvent.data?.object ?? rawEvent.object ?? null;
  const isCheckout = eventType.startsWith("checkout.session");
  const session = isCheckout ? object : null;

  const priceId = extractPriceId(session);
  const product = resolvePriceProduct(priceId, options);
  const rawBody = options.rawBody ?? canonicalJson(rawEvent);

  const event = buildEvent({
    providerEventId,
    eventType,
    session: session ?? {},
    product,
    sourceMode,
    rawBody,
    rawObject: session ? null : object,
    options,
  });

  if (!session) {
    // Non-checkout events carry no payment evidence of their own.
    event.verification_status = VERIFICATION.UNVERIFIED;
    event.processing_status = PROCESSING.PENDING;
  }
  return event;
}

/** Normalize a polled checkout session (the poller path). */
export function normalizeCheckoutSession(session, options = {}) {
  const sourceMode = options.sourceMode || "poll";
  if (!session || typeof session !== "object") {
    throw new TypeError("normalizeCheckoutSession requires a session object");
  }
  const providerEventId = String(session.id ?? "").trim();
  if (!providerEventId) throw new TypeError("checkout session has no id");

  const priceId = extractPriceId(session);
  const product = resolvePriceProduct(priceId, options);

  return buildEvent({
    providerEventId,
    eventType: options.eventType || "checkout.session.completed",
    session,
    product,
    sourceMode,
    rawBody: options.rawBody ?? canonicalJson(session),
    rawObject: null,
    options,
  });
}

/** Normalised subscription state for subscription lifecycle events. */
export function extractSubscriptionState(rawEvent) {
  if (!rawEvent || typeof rawEvent !== "object") {
    throw new TypeError("extractSubscriptionState requires a raw event object");
  }
  const object = rawEvent.data?.object ?? rawEvent.object ?? null;
  if (!object || typeof object !== "object") {
    return {
      provider_event_id: rawEvent.id ?? null,
      subscription_reference: null,
      status: null,
      customer_id: null,
      price_reference: null,
      occurred_at: null,
    };
  }
  const priceId =
    object.price?.id ??
    (Array.isArray(object.items?.data) ? object.items.data[0]?.price?.id : null) ??
    null;
  const occurredAt =
    typeof object.created === "number" ? new Date(object.created * 1000).toISOString() : null;

  return {
    provider_event_id: rawEvent.id ?? null,
    subscription_reference: object.id ?? null,
    status: object.status ?? null,
    customer_id: object.customer ?? null,
    price_reference: priceId,
    occurred_at: occurredAt,
    cancel_at_period_end: object.cancel_at_period_end === true,
    canceled_at: object.canceled_at ?? null,
    current_period_end:
      typeof object.current_period_end === "number"
        ? new Date(object.current_period_end * 1000).toISOString()
        : null,
  };
}

export default {
  isPaidSession,
  isFreeProduct,
  normalizeStripeEvent,
  normalizeCheckoutSession,
  extractSubscriptionState,
  extractPriceId,
  resolvePriceProduct,
  redact,
  canonicalJson,
};

