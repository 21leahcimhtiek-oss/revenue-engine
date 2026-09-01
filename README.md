# Revenue Engine — Webhook → License → ccpi Login Flow

Stripe checkout webhooks issue license keys, store them, and grant access to ccpi.

## Flow

1. Customer completes Stripe Checkout (`checkout.session.completed`).
2. Webhook handler verifies signature (`STRIPE_WEBHOOK_SECRET`), maps `price` → product tier.
3. Handler generates license key: `CCPI-<TIER>-<UUID>-<CHECKSUM>` and stores record
   (SQLite via `better-sqlite3` in `data/licenses.db` — swap for Postgres later).
4. License key + magic login link emailed to customer (see EMAIL_CAPTURE_SPEC.md).
5. Customer hits `POST /v1/login` with email + license key → server issues a signed
   session JWT (`CCPI_SESSION_JWT_SECRET`, 7-day expiry, refresh on activity).
6. `GET /v1/me` returns tier + entitlements; ccpi client gates features on `tier`.

## Environment (read from C:\Users\keith\master.env — key NAMES only)

| Key | Purpose |
|---|---|
| STRIPE_SECRET_KEY | Stripe API (live key) |
| STRIPE_WEBHOOK_SECRET | Webhook signature verification (whsec_...) |
| PRICE_SKILL_PACK_LITE / _STD / _ELITE | price_xxx for $29 / $49 / $79 |
| PRICE_PRO_ANNUAL | price_xxx for $199/yr |
| PRICE_MCP_SUITE | price_xxx for $499 one-time |
| PRICE_STARTER | price_xxx for $0 (or $1 verified) |
| CCPI_SESSION_JWT_SECRET | random 32+ byte secret for session JWTs |
| RESEND_API_KEY (recommended) | transactional email, free tier 100/day |

## Run

```
npm install
npm run dev        # stripe listen --forward-to localhost:8787/webhook
npm start
```

## Endpoints

- `POST /webhook` — Stripe events (checkout.session.completed, customer.subscription.deleted, invoice.payment_failed)
- `POST /v1/login` — { email, licenseKey } → { sessionToken }
- `GET  /v1/me` — Bearer token → tier + entitlements
