# Aurora Revenue Engine

Turns a **verified** payment into a customer entitlement, a licence, a fulfilment and a
captured delivery - automatically, idempotently, and with evidence.

## The governing principle: STATUS IS NOT EVIDENCE

A checkout success page is not proof of payment. A string saying `PAID` is not proof of
payment. A licence row in SQLite is not proof that a payment occurred. An AI statement is
not proof of payment.

Every commercial effect in this product is traceable to a verified payment event, and every
transition is recorded as evidence. The payment, the entitlement, the licence and the
delivery are four related but **distinct** things, and the system models them separately.

## The commercial lifecycle

```
provider event -> signature/payment verification -> normalised revenue event
  -> deduplicated persistence -> product mapping -> entitlement -> licence
  -> fulfilment -> captured delivery -> customer access -> reconciliation -> evidence
```

Any stage may refuse. An unknown price, an unverified payment, a disabled product, a
missing approval or an invalid signature all produce a **recorded refusal** and no effect.

## Layout

| Path | What it is |
| --- | --- |
| `src/db.js` | schema + additive, idempotent migrations |
| `src/catalog.js` | the authoritative product/price catalog (`catalog/products.json`) |
| `src/events.js` | the normalised revenue event and its idempotency identity |
| `src/stripe-boundary.js` | every Stripe-specific detail, isolated at the boundary |
| `src/webhook.js` | webhook intake: verify, normalise, deduplicate, persist |
| `src/reconcile.js` | provider-vs-local reconciliation and safe repair |
| `src/entitlements.js` | customer identity and entitlement lifecycle |
| `src/licenses.js` | licence lifecycle |
| `src/delivery.js` | idempotent delivery (capture transport by default) |
| `src/fulfillment.js` | the restart-safe fulfilment pipeline |
| `src/access.js` | login, session, and per-request re-validation |
| `src/admin.js` | the authorised admin surface |
| `src/governed.js` | Aurora Governed Execution adapter + the money-movement refusal |
| `src/demo.js` | the one-command synthetic demonstration |
| `bin/aurora-revenue.mjs` | the operator CLI |
| `experiments/revenue-engine/` | the measurement harness and its raw evidence |
| `acceptance/probe.mjs` | the independent acceptance probe |

## Operator CLI

```
node bin/aurora-revenue.mjs health          # is it healthy and configured? (no secret values)
node bin/aurora-revenue.mjs reconcile       # provider state vs local state
node bin/aurora-revenue.mjs customer <id>   # a customer's commercial state
node bin/aurora-revenue.mjs entitlement <id>
node bin/aurora-revenue.mjs license <key>
node bin/aurora-revenue.mjs evidence
node bin/aurora-revenue.mjs demo --out <dir>
```

Admin commands require `REVENUE_ADMIN_TOKEN` and **fail closed** when it is not set.

## Configuration

Env var NAMES only. Values live in the operator's env file; the product never prints one.

| Variable | Meaning |
| --- | --- |
| `REVENUE_ENV_FILE` | path to an env file to load (nothing is loaded by default) |
| `REVENUE_LOAD_MASTER_ENV` | `true` to load the operator master env explicitly |
| `REVENUE_ALLOW_LIVE_STRIPE` | `true` to allow a **live** Stripe key; a test key always works |
| `REVENUE_DB_PATH` | the database file (default `data/licenses.db`) |
| `REVENUE_ADMIN_TOKEN` | bearer token for every admin route; absent = no admin access |
| `CCPI_SESSION_JWT_SECRET` | session signing secret; required for login |
| `STRIPE_SECRET_KEY` | Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | webhook signature secret |
| `PRICE_*` | price id per product; see `catalog/products.json` for the names |
| `RESEND_API_KEY` | transactional email (never used in tests) |

**Nothing is implicit.** No env file is loaded unless you ask. A live Stripe key is
refused unless you opt in. Money movement is refused always, without operator authorisation.

## Gates

```
npm run typecheck       # parse + import + undefined-identifier check
npm test                # the package suite
npm run test:experiments # the 35-scenario measurement harness
npm run acceptance      # the independent probe, over a real HTTP socket
npm run demo            # the one-command synthetic demonstration
```

## Data model

`customers`, `revenue_events`, `entitlements`, `fulfillment_runs`, `deliveries`, `evidence`,
`idempotency_keys`, plus the original `licenses`, `subscribers`, `invoices`, `leads`,
`campaigns`, `campaign_runs`, `campaign_sent`, `channel_metrics`, `analytics_snapshots`.

Migrations are additive and idempotent; an existing database is upgraded in place with no
data loss.

## Safety boundary

Autonomous: verify, entitle, license, fulfil, deliver (via a capture transport in tests),
reconcile, repair deterministically-safe drift, and record evidence.

Refused without explicit operator authorisation: any live charge, refund, payout, transfer,
subscription create/cancel, invoice send/pay, price or product change, live email to a real
customer, DNS, deployment, and Git push.

## Limitations

The measurement corpus is synthetic. Stripe and email have been exercised only through
synthetic fixtures and a capture transport. The Governed Execution integration is
contract-only. No attack-success-rate measurement exists. **No commercial revenue has been
earned.**