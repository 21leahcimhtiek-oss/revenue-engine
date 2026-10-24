# AURORA REVENUE ENGINE — EXPERIMENT HARNESS RESULTS

Generated: 2026-10-24T03:18:55.700Z

- Contract: `aurora.revenue-engine.experiments@1`
- Product revision (sha256 of the exercised src files): `2f3b8dbda53ec4493f37af1ce28d4872058c436b07d781cff1e72b86af604f34`
- Source fingerprint (product revision + harness files): `36f54324cdd4ec323c3ba4ba16ec1a454278660b1f03a4d492bf2a833ce583ab`
- Scenarios: **35/35 passed**

## Boundary

- Network calls: 0
- Real emails sent: 0
- Live Stripe used: false
- Resend transport constructed: false
- Secret values read, printed or stored: false
- Source database opened for writing: false
- Source database `data/licenses.db` sha256 before: `b0884518348b1f2c3d47e3df4f5d7d2cc667551f47764a4fbf347c633e95aa14`
- Source database sha256 after: `b0884518348b1f2c3d47e3df4f5d7d2cc667551f47764a4fbf347c633e95aa14` (unmodified: true)

## Metrics

```
PAYMENT_EVENTS_TOTAL=25
PAYMENT_EVENTS_VERIFIED=16
PAYMENT_EVENTS_REJECTED=7
DUPLICATE_EVENTS=2
DUPLICATE_EFFECTS=0
FULFILLMENTS_ATTEMPTED=21
FULFILLMENTS_COMPLETED=18
FULFILLMENTS_FAILED=3
LICENSES_EXPECTED=14
LICENSES_ISSUED=14
DUPLICATE_LICENSES=0
ENTITLEMENTS_EXPECTED=14
ENTITLEMENTS_CORRECT=14
DELIVERIES_EXPECTED=14
DELIVERIES_CAPTURED=14
RECONCILIATION_SCENARIOS=6
RECONCILIATION_CORRECT=6
RESTART_SCENARIOS=3
RESTART_RECOVERED=3
INVALID_EVENTS_BLOCKED=3
UNKNOWN_PRODUCTS_BLOCKED=2
UNAUTHORIZED_MONEY_ACTIONS=3
UNAUTHORIZED_MONEY_ACTIONS_BLOCKED=3
CROSS_CUSTOMER_ACCESS_ATTEMPTS=2
CROSS_CUSTOMER_ACCESS_BLOCKED=2
EVIDENCE_BUNDLES_CREATED=109
EVIDENCE_BUNDLES_VALID=109
SCENARIOS_TOTAL=35
SCENARIOS_PASSED=35
```

## Metric definitions

- **PAYMENT_EVENTS_TOTAL** — the number of synthetic provider payment-event presentations handed to the engine across every scenario (each delivery of the same event counts again).
- **PAYMENT_EVENTS_VERIFIED** — of those presentations, the ones the engine accepted as genuine payment evidence (verification_status = verified).
- **PAYMENT_EVENTS_REJECTED** — of those presentations, the ones the engine refused or rejected (unpaid session, unknown price, disabled product, malformed payload, bad signature, missing secret).
- **DUPLICATE_EVENTS** — presentations of a provider event that the engine recognised as already recorded (idempotency hit).
- **DUPLICATE_EFFECTS** — the number of EXTRA licences/entitlements/deliveries produced by a duplicate delivery (the number that must be zero).
- **FULFILLMENTS_ATTEMPTED** — calls to the fulfilment pipeline that were not refused at the door (a refusal creates a run row but no work).
- **FULFILLMENTS_COMPLETED** — fulfilment runs that reached a completed state (including an already-fulfilled no-op).
- **FULFILLMENTS_FAILED** — fulfilment runs that ended in a failed state (delivery failure), which stay retryable.
- **LICENSES_EXPECTED** — the number of licences the scenarios expect to exist at the end of their scenario.
- **LICENSES_ISSUED** — the number of licence rows that actually exist at the end of the scenarios.
- **DUPLICATE_LICENSES** — licence rows in excess of the expectation (a second licence for one entitlement or one customer+product).
- **ENTITLEMENTS_EXPECTED** — the number of entitlements the scenarios expect to exist at the end of their scenario.
- **ENTITLEMENTS_CORRECT** — the number of expected entitlements whose scenario ended with exactly the expected entitlement count.
- **DELIVERIES_EXPECTED** — the number of SUCCESSFUL deliveries the scenarios expect.
- **DELIVERIES_CAPTURED** — the number of successful (sent/captured) delivery rows that actually exist.
- **RECONCILIATION_SCENARIOS** — the number of reconciliation scenarios driven with injected provider facts.
- **RECONCILIATION_CORRECT** — the number of reconciliation scenarios where the expected named finding was reported.
- **RESTART_SCENARIOS** — the number of interrupted-fulfilment scenarios (entitlement stage, licence stage, run row only).
- **RESTART_RECOVERED** — the number of interrupted-fulfilment scenarios that resumed to exactly one licence and one delivery.
- **INVALID_EVENTS_BLOCKED** — the number of malformed / badly signed / secret-less events that were blocked.
- **UNKNOWN_PRODUCTS_BLOCKED** — the number of payments blocked because the price mapped to no sellable product (unknown price or disabled product).
- **UNAUTHORIZED_MONEY_ACTIONS** — the number of money-movement actions offered to the governed layer (refund, charge, payout).
- **UNAUTHORIZED_MONEY_ACTIONS_BLOCKED** — the number of those money-movement actions the governed layer refused.
- **CROSS_CUSTOMER_ACCESS_ATTEMPTS** — the number of attempts to use a licence outside its owner or outside the product it grants.
- **CROSS_CUSTOMER_ACCESS_BLOCKED** — the number of those attempts that were denied.
- **EVIDENCE_BUNDLES_CREATED** — the number of evidence rows written across the scenario databases.
- **EVIDENCE_BUNDLES_VALID** — the number of those evidence rows that carry a kind and a parseable JSON payload.
- **SCENARIOS_TOTAL** — the number of scenarios the harness drove.
- **SCENARIOS_PASSED** — the number of scenarios whose every check passed.

## Scenario table

| # | scenario | expected outcome | actual outcome | pass |
| --- | --- | --- | --- | --- |
| 1 | `verified_purchase` | completed: one entitlement, one licence, one captured delivery | status=completed delivery=captured | PASS |
| 2 | `duplicate_event` | second delivery is a duplicate: one licence, one entitlement, one delivery | first=completed second=already_fulfilled duplicate_effects=0 | PASS |
| 3 | `duplicate_webhook` | second webhook delivery is a duplicate: one event row, no second effect | first=accepted second=duplicate | PASS |
| 4 | `unpaid_session` | refused: no entitlement, no licence, no delivery | verification=unverified fulfilment=refused code=fulfillment.event_not_verified | PASS |
| 5 | `complete_but_unpaid` | refused: "complete" alone is never proof of payment | session_status=complete payment_status=unpaid fulfilment=refused | PASS |
| 6 | `unknown_price` | refused with unknown_product_mapping, nothing created | product_id=null fulfilment=refused code=fulfillment.unknown_product | PASS |
| 7 | `disabled_product` | refused with catalog.product_disabled, nothing created | fulfilment=refused code=catalog.product_disabled | PASS |
| 8 | `invalid_event` | rejected as malformed_payload, never fulfilled | outcome=malformed_payload accepted=false | PASS |
| 9 | `invalid_signature` | rejected as invalid_signature, never fulfilled | outcome=invalid_signature accepted=false | PASS |
| 10 | `missing_secret` | refused as no_secret, never fulfilled | outcome=no_secret accepted=false | PASS |
| 11 | `duplicate_license_attempt` | one licence row, same licence id and key | licences=1 same_id=true | PASS |
| 12 | `cross_customer_use` | denied: licence verification fails and login is refused | verify=denied login=access.invalid_credentials | PASS |
| 13 | `wrong_product` | denied: the licence grants a different product | wrong_product=denied own_product=allowed | PASS |
| 14 | `revoked_license` | denied after revocation | verify=denied | PASS |
| 15 | `expired_license` | denied after expiry | verify=denied | PASS |
| 16 | `revocation_invalidates_session` | access DENIED on the reused token | before_revocation=allowed after_revocation=access.license_not_usable | PASS |
| 17 | `restart_before_license` | resumed: one licence, one delivery, no duplicate | resumed=completed licences=1 deliveries=1 | PASS |
| 18 | `restart_after_license` | resumed: no second licence, exactly one delivery | resumed=completed licences=1 deliveries=1 | PASS |
| 19 | `restart_before_commit` | recovered: one entitlement, one licence, one delivery | recovered=completed entitlements=1 licences=1 deliveries=1 | PASS |
| 20 | `delivery_failure_then_retry` | failed then captured, exactly one successful delivery | first=failed second=completed successful_deliveries=1 | PASS |
| 21 | `subscription_cancelled_but_entitlement_active` | finding: subscription_cancelled_but_entitlement_active | verdict=REPAIRABLE findings=subscription_cancelled_but_entitlement_active | PASS |
| 22 | `payment_exists_but_fulfillment_missing` | finding: payment_exists_but_fulfillment_missing | verdict=REPAIRABLE findings=payment_exists_but_fulfillment_missing | PASS |
| 23 | `fulfillment_without_verified_payment` | finding: fulfillment_without_verified_payment | verdict=BLOCKED findings=fulfillment_without_verified_payment,unknown_product_mapping | PASS |
| 24 | `duplicate_license` | finding: duplicate_license | verdict=BLOCKED findings=duplicate_license | PASS |
| 25 | `orphan_entitlement` | finding: orphan_entitlement | verdict=BLOCKED findings=orphan_entitlement | PASS |
| 26 | `unknown_product_mapping` | finding: unknown_product_mapping | verdict=BLOCKED findings=unknown_product_mapping | PASS |
| 27 | `admin_without_token` | denied: admin.missing_token | code=admin.missing_token | PASS |
| 28 | `admin_with_wrong_token` | denied: admin.invalid_token | code=admin.invalid_token | PASS |
| 29 | `admin_token_unset` | denied: admin.not_configured | code=admin.not_configured | PASS |
| 30 | `money_movement_refund` | refused: governed.money_movement_requires_authorisation for "refund" | blocked=true code=governed.money_movement_requires_authorisation | PASS |
| 31 | `money_movement_charge` | refused: governed.money_movement_requires_authorisation for "charge" | blocked=true code=governed.money_movement_requires_authorisation | PASS |
| 32 | `money_movement_payout` | refused: governed.money_movement_requires_authorisation for "payout" | blocked=true code=governed.money_movement_requires_authorisation | PASS |
| 33 | `email_provider_unavailable` | failed delivery recorded, no crash, retry succeeds with one successful delivery | crashed=no first=failed second=failed third=completed | PASS |
| 34 | `event_received_twice_out_of_order` | both processed, one entitlement, one licence, one successful delivery, no crash | crashed=no second_first=completed first_second=completed entitlements=1 licences=1 | PASS |
| 35 | `idempotency_key_stability` | stable keys for one event, distinct keys for distinct events | event_key_stable=true event_key_distinct=true run_key_stable=true run_key_distinct=true | PASS |

## Failing scenarios

None. Every scenario met its expected outcome.
## Internal consistency checks

| check | expected | actual | ok |
| --- | --- | --- | --- |
| PAYMENT_EVENTS_TOTAL = VERIFIED + REJECTED + DUPLICATE_EVENTS | 25 | 25 | ok |
| FULFILLMENTS_ATTEMPTED = COMPLETED + FAILED | 21 | 21 | ok |
| DUPLICATE_EFFECTS = 0 | 0 | 0 | ok |
| DUPLICATE_LICENSES = 0 | 0 | 0 | ok |
| LICENSES_ISSUED <= LICENSES_EXPECTED | <= 14 | 14 | ok |
| ENTITLEMENTS_CORRECT <= ENTITLEMENTS_EXPECTED | <= 14 | 14 | ok |
| DELIVERIES_CAPTURED <= DELIVERIES_EXPECTED | <= 14 | 14 | ok |
| RECONCILIATION_CORRECT <= RECONCILIATION_SCENARIOS | <= 6 | 6 | ok |
| RESTART_RECOVERED <= RESTART_SCENARIOS | <= 3 | 3 | ok |
| INVALID_EVENTS_BLOCKED <= PAYMENT_EVENTS_REJECTED | <= 7 | 3 | ok |
| UNKNOWN_PRODUCTS_BLOCKED <= PAYMENT_EVENTS_REJECTED | <= 7 | 2 | ok |
| UNAUTHORIZED_MONEY_ACTIONS_BLOCKED <= UNAUTHORIZED_MONEY_ACTIONS | <= 3 | 3 | ok |
| CROSS_CUSTOMER_ACCESS_BLOCKED <= CROSS_CUSTOMER_ACCESS_ATTEMPTS | <= 2 | 2 | ok |
| EVIDENCE_BUNDLES_VALID <= EVIDENCE_BUNDLES_CREATED | <= 109 | 109 | ok |
| SCENARIOS_PASSED <= SCENARIOS_TOTAL | <= 35 | 35 | ok |
| every required scenario ran | all ran | 0 | ok |

## Limitations

- No Stripe network call was made: every provider payload is a synthetic fixture, and signature verification used the offline HMAC path.
- No email was sent: the only transport ever constructed was createCaptureTransport(); createResendTransport() was never called.
- The resend/nodemailer SDKs were never imported at runtime, so no vendor client was ever constructed.
- The source database (data/licenses.db) was hashed before and after the run and never opened in write mode; every scenario used its own disposable database under the OS temp directory.
- Reconciliation was driven with INJECTED provider facts (providerState) because the module is deliberately offline; the facts are synthetic and not a live billing-provider read.
- The admin scenarios exercise the requireAdmin() guard directly rather than over HTTP, so they do not measure the Express routing layer.
- The disabled-product scenario uses a disposable catalog fixture (raw/fixtures/catalog-disabled.json) because the shipped catalog has no disabled product.
- Scenario 34 uses two distinct provider events for the SAME customer and product, so "no duplicate" is measured as one entitlement / one licence / one successful delivery.
- Metric denominators are the ACTUAL counts observed by the harness. A scenario that could not be driven would be reported as "not run" rather than as a zero.

## Raw artefacts

One JSON file per scenario under `raw/`, each holding the expected and actual outcome, every check, the scenario detail and a read-only snapshot of the scenario database (events, entitlements, masked licences, deliveries, fulfilment runs, evidence).
