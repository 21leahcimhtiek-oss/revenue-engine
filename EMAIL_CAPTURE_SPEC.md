# Email Capture Wiring Spec (provider-agnostic)

## Recommendation: Resend (free tier: 100 emails/day, 3,000/mo, no credit card)
Why: modern API, great Node SDK, SPF/DKIM easy, generous free tier. Fallback alt: Brevo (300/day free) if volume outgrows Resend.

## Wiring

1. **Domain auth**: verify sending domain in Resend → add the DKIM/SPF DNS records it gives you (Keith, manual, ~10 min).
2. **Two email streams**:
   - **Transactional** (license delivery, receipt nudges) → Resend via `src/email.js`. Triggered by Stripe webhook only. Must never be batch-marketed.
   - **Marketing/capture** (newsletter, lead magnet) → capture endpoint `POST /v1/subscribe { email, source }` → store in `subscribers` table → sync to Resend Audience. Double opt-in: send confirmation link (Resend broadcast or custom).
3. **Capture points**:
   - Checkout success page: "Get free skill updates" checkbox (pre-checked OFF for GDPR).
   - Free Starter Pack flow: email verification required before $0 license issues (link with signed token, 24h expiry).
   - Site footer / docs: simple form → `/v1/subscribe`.
4. **Suppression & hygiene**: honor webhook events for bounces/complaints (Resend webhooks → mark subscriber suppressed).
5. **Env keys (names only — values in master.env)**: `RESEND_API_KEY`, `EMAIL_FROM`.

## Free-tier cost projection
0–3,000 emails/mo → $0. Above that: Resend Pro $20/mo or Brevo $0 (300/day).
