# Keith — Manual Stripe Setup (run with YOUR live key; values live in master.env, never in git)

1. Create `C:\Users\keith\master.env` with at minimum:
   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, CCPI_SESSION_JWT_SECRET,
   PRICE_SKILL_PACK_LITE, PRICE_SKILL_PACK_STD, PRICE_SKILL_PACK_ELITE,
   PRICE_PRO_ANNUAL, PRICE_MCP_SUITE, PRICE_STARTER, RESEND_API_KEY, EMAIL_FROM

2. Create products/prices (Stripe CLI: `stripe login` first, or run the same via dashboard):

   stripe products create --name "Skill Pack Lite"   # then
   stripe prices create --product=<prod_id> --unit-amount=2900 --currency=usd      # $29 one-time
   stripe prices create --product=<prod_id> --unit-amount=4900 --currency=usd      # $49
   stripe prices create --product=<prod_id> --unit-amount=7900 --currency=usd      # $79
   stripe products create --name "Tons of Skills Pro"
   stripe prices create --product=<prod_id> --unit-amount=19900 --currency=usd --recurring='{"interval":"year"}'  # $199/yr
   stripe products create --name "MCP Infrastructure Suite"
   stripe prices create --product=<prod_id> --unit-amount=49900 --currency=usd     # $499 one-time
   stripe products create --name "Starter Pack"
   stripe prices create --product=<prod_id> --unit-amount=100 --currency=usd       # $1 email-verified (or unit-amount=0)

3. Record each `price_xxx` into master.env under the PRICE_* names above.

4. Webhook:
   stripe listen --forward-to localhost:8787/webhook     # dev — copy whsec_ into STRIPE_WEBHOOK_SECRET
   Stripe Dashboard → Developers → Webhooks → add endpoint https://yourdomain.com/webhook
   Events: checkout.session.completed, customer.subscription.deleted, invoice.payment_failed

5. Then: cd revenue-engine && npm install && npm start
