# eBay notifications, end to end: plan (2026-09-26)

Status: this is a plan only. Nothing has been built, switched on or called. It is based on main as of 2026-09-26 (after #48).
The eBay notification code has not changed since #32. Every "today" fact below was read in code on main.

## 1. Goal, and what "working" means

eBay should tell Nexus within minutes, with a signed notice, when a buyer completes checkout with one of our sellers, when a
seller withdraws our access, and when an eBay user asks for their account to be deleted. Nexus stores each verified notice,
acts on it once, and never records an order twice when the 15-minute poll also reads it.
**Working** means each of the three is proven in production by a real eBay-signed delivery, and a query reads the result back:
- **Deletion:** eBay's portal test notice is stored with a valid signature, then reviewed.
- **Revocation:** eBay's subscription test notice is stored. The next real revocation marks the account revoked and pauses its writes.
- **Order:** the next real eBay sale gives one `ORDER_CONFIRMATION` receipt `done`, one order with each line's stock taken
  once, and no change from the next poll.

## 2. Current state vs target

| Piece | Today (main) | Target |
|---|---|---|
| Verification challenge (GET) | Built. It returns `SHA-256(challengeCode + token + endpoint)` as JSON. One accessor feeds both the challenge and destination creation. On 2026-09-22 it answered 200 with the correct hash. | Unchanged. Only the token is replaced. |
| Receiver (POST) | Built. It checks the `X-EBAY-SIGNATURE` ECDSA signature using `getPublicKey` with the app token. The notice is stored durably before the 200. Otherwise it answers 412 (bad signature), 503 (retry) or 400. | Unchanged. |
| Notification API config (alert email) | Never read or set. eBay's spec lists 195003 "configuration required" for both createDestination and createSubscription. | The reconcile reads `/config` and sets it only if it is missing. |
| Destination | None exists at eBay (measured 0 on 2026-09-22). The reconcile refuses before making any call, because every topic is flagged `handlerMissing`. | One destination, created and checked nightly. |
| App-level topics | The `AUTHORIZATION_REVOCATION` handler is built (claimed receipt, grant fence, revoke plus alert, real-PG tests) but is still flagged missing. `MARKETPLACE_ACCOUNT_DELETION` is in the API wish list, yet eBay documents that it is set up in the developer portal. `ITEM_PRICE_REVISION` and `ITEM_AVAILABILITY` are buy-side item topics that a seller has no use for. | Subscribe to revocation only. Deletion stays in the portal. Drop the two item topics. |
| User-level topics | `ORDER_CONFIRMATION` needs a subscription made with each seller's own user token (authorization-code grant, `commerce.notification.subscription` and `sell.fulfillment` scopes). Every setup call today uses the app token. Nothing is built. The Connect flow already asks for the scope, and `grantedScopes` records it. Older grants may lack it. | A per-seller subscription reconcile and a per-seller status. |
| Admission of order notices | Only `AUTHORIZATION_REVOCATION` is routed to an account. `readEbayNoticeIdentity` reads `data.userId`, so an order notice is quarantined as `subject_or_topic_unresolved`. | Order notices are routed to the seller's account the same way. An unroutable notice is still quarantined and still gets its 200. |
| Processing | Built and dormant: claims and leases, and an order executor. It reads the order back with the receipt's own account and writes it with the shared writer in one transaction. Two switches hold it. An order read that returns 404 retries until it is dead-lettered. | Unchanged, plus a clear "order not found" outcome. |
| Dedupe with polling | The shared writer takes a per-order advisory lock and a row lock, and the database has a unique `(workspace, channel, channelOrderId)` key. A real-PG test runs 5 concurrent writers. No test runs the poll and the notice entry points together. | Add one real-PG race test through both entry points. |
| Privacy review | Built in B+C; its switch is OFF. The Option A erasure executor is not built, so a match only raises an alert. | Switch it on after the first stored deletion notice. The executor stays a separate lane. |

## 3. Why eBay rejected the token, and the fix

**Evidence.**
- On 2026-09-21 and 2026-09-22, the 03:55 reconcile called createDestination. eBay answered HTTP 400, errorId **195019**: "Invalid or missing verification token for this endpoint."
- On the same day the challenge GET answered with the correct hash, both variables were set, and the request body
  `deliveryConfig {endpoint, verificationToken}` matched eBay's contract (the later wire fixes did not change it).

**eBay's spec:**
- 195019 means the token fails eBay's format rule: 32–80 characters, and only `[A-Za-z0-9_-]`.
- A failed challenge has a different error, 195020.
- The code sent the variable byte for byte, with no trimming. The format preflight (`ebayVerificationTokenError`) was only added on 2026-09-22 at 17:57, after both failures.

**Most likely cause:** the production value breaks the format rule. It is either the wrong length or contains a character outside the allowed set, such as `.`, `=`, `+`, `/`, a space or a trailing newline.
- To confirm without reading the secret: `GET /api/admin/ebay-notification-status` returns `configured.verificationTokenValid` as a boolean only. Read it once before the fix (expect `false`) and once after (expect `true`).
- Ruled out: variable-name drift (fixed in P2.3), the endpoint hash (the challenge was correct) and the body shape.

**Fix:** no code change is needed. The Owner sets a new token (A1) and puts the same value in the portal (A2). The guard already refuses a malformed token before any call.
**Next blockers the spec predicts:** 195003, a missing alert-email config (slice S1 handles it); and 195020, if the scheduler
and the API hold different tokens while the change is in progress (set the token before the setup switch).

## 4. Work slices

Each slice ships as its own PR with every switch OFF. Tests are written red-first; typecheck and the area tests must pass; each PR gets an independent review. No slice is expected to need a migration; each PR confirms that.

**S1: an app-level setup that eBay accepts (S).**
- **Files:** `services/cx/connectors/ebay/notifications.ts`, `routes/ebay-notification.routes.ts`, `jobs/ebay-notification-reconcile.job.ts`, `services/cx/ingress/ebay-topics.ts`, and `runtime/scheduler.ts` (its "opt out via `=0`" comment is wrong: the code needs exactly `1`).
- **Changes:**
  - Read `GET /config`. If it is missing, set `alertEmail` from `EBAY_NOTIFICATION_ALERT_EMAIL`. If that is unset too, refuse with a plain message before createDestination.
  - Subscribe only topics whose catalogue `scope` is `APPLICATION`. Never send a `USER` topic with the app token.
  - Mark deletion as portal-only: reported in the status, never subscribed.
  - Drop the two item topics.
  - Flip `AUTHORIZATION_REVOCATION` to ready, but only after a written check against the C8 list in `build/CX-COMPLETION.md` (claimed receipts, persisted ownership, grant fence, replay).
  - Name 195003, 195019, 195020 and 195021 in the status output.
  - Refuse the admin POST setup unless `NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP=1`.
  - Add an admin action that asks eBay to send its test notice for a subscription.
- **Tests** (stub transport, in `notification-{preflight,contract,readiness}` and `ebay-notification-activation`): config
  missing → set it, then create the destination; config missing and no email → zero writes; a `USER` topic → no call;
  revocation created once, a second run makes only GETs; each error id gives its own message and no secret appears in the
  output; switch off → the route answers 403 and makes no call.
- **Risk:** eBay checks the challenge against the API service at the moment the destination is created, so both services must already hold the same token.

**S2: order notices reach the right seller (M).**
- **Files:** `ingress/ebay-revocation-notice.ts` (topic-aware subject), `ebay-admission.ts` (routeable topics), `ebay-order-notice.ts` (seller check), `ebay-order-processing.ts` (`not_found`) and `handlers.ts` (replay entry; `processEbayInbound` keeps its hold).
- **Changes:**
  - Read the seller's immutable user id from the field that eBay's schema for `ORDER_CONFIRMATION` names. Take the field name from `getTopic` or the first test notice. Never guess it (P6.7).
  - Route through `ChannelAccountOwnership` exactly as revocation does.
  - An unknown or ambiguous seller goes to quarantine and still gets its 200. The poll records the order anyway, so order notices have no adoption path.
  - Processing requires the notice's seller to equal the receipt's account.
  - A 404 on the order read gets a bounded retry, then a dead letter: "order not readable (test notice?); the poll records real orders".
- **Tests** (real PG through `test-support/concurrent-database.ts`, never PGlite): a known seller → one held receipt on that
  account; a seller in another business → only that business; an unknown seller → quarantine; a repeated delivery → one
  receipt; `ingestEbayOrder` (the poll) and the notice executor writing one order at the same time → one order, each line
  once, each stock movement once, no unique-key error; switch off → the receipt stays held and no attempt is spent.
- **Risk:** eBay may name the seller only by username. If so, stop and re-plan. Never fall back to "the only account".

**S3: per-seller subscriptions (M).**
- **Files:** new `services/cx/connectors/ebay/seller-notifications.ts`, the shared helpers in `notifications.ts`, the reconcile job and the status route.
- **Changes:**
  - After the app-level step, loop over every active OAuth eBay account in every business, each in its own workspace context (a platform tick).
  - If `grantedScopes` lacks `commerce.notification.subscription`, mark the account "reconnect needed" and make no call.
  - Otherwise, with that account's own token through the gateway, list its subscriptions. Then create or enable `ORDER_CONFIRMATION` on our destination, using the catalogue's schema version.
  - An eBay 195011 records one "reconnect needed" `ConnectionEvent` and is not retried in a loop.
  - The status shows each account as subscribed, disabled or reconnect needed.
  - Mark `ORDER_CONFIRMATION` as ready.
- **Tests:** each account is only ever called with its own token, never the app's or another seller's; revoked and
  inactive accounts are skipped; a second run makes only GETs; 195011 records one event; account selection across
  businesses is checked with real PG.
- **Risk:** per-user rate limits are low, so accounts run one at a time.

## 5. Owner actions and decisions

- **A1 (Railway, API):** set a new `EBAY_NOTIFICATION_VERIFICATION_TOKEN`: 64 letters and digits, for example `openssl rand -hex 32`.
  - Check that the worker and the scheduler read it by reference.
  - Check that `EBAY_NOTIFICATION_ENDPOINT_URL` is the public https address of `/api/webhooks/ebay-notification` on the API origin, with no trailing slash and no query.
- **A2 (eBay developer portal):** Application Keys (production) → Alerts & Notifications → Marketplace account deletion.
  Confirm the app is not marked "not persisting eBay data" (exempted). Enter the alert email, set the endpoint to exactly
  A1's URL and the token to exactly A1's token, and Save (eBay checks the challenge live). Then send the test notification.
- **A3:** give the alert email for the Notification API config (`EBAY_NOTIFICATION_ALERT_EMAIL`, on the scheduler and the API).
- **A4:** reconnect each account that the S3 status lists as "reconnect needed".
- **A5:** say yes to each switch in §6, one at a time.

**D1: which topics go into v1?** Recommended: `AUTHORIZATION_REVOCATION` (app level) and `ORDER_CONFIRMATION` (per
seller). Deletion stays in the portal; drop the two item topics; shipping, returns and messages come later.

**D2: should the 15-minute eBay order poll stay unchanged after notices go live?** Recommended: yes. eBay can drop a
notice after its retries, and the shared writer makes a double read harmless. Review after 30 clean days.

## 6. Rollout

Every step waits for the Owner's yes. Queries run in a `READ ONLY` transaction, return aggregates only and carry a positive control.

| Step | Switch or action | Proof | Switch off |
|---|---|---|---|
| 0 | Merge S1–S3 with every switch OFF | The serving build equals the merge. `ebay-notification-reconcile` has no new `CronRun`. The EBAY `WebhookEvent` count is unchanged. | Revert the PR |
| 1 | A1, then A2 | P1: `SELECT topic,"signatureOk",reason,count(*) FROM "EbayNoticeQuarantine" WHERE "receivedAt">now()-interval '1 hour' GROUP BY 1,2,3` shows `MARKETPLACE_ACCOUNT_DELETION / true`. The status reports `verificationTokenValid=true`. | Nothing to switch off: notices stay stored |
| 2 | `NEXUS_ENABLE_EBAY_PRIVACY_REVIEW=1` (worker, scheduler) | `SELECT "reviewOutcome",count(*) FROM "EbayNoticeQuarantine" WHERE topic='MARKETPLACE_ACCOUNT_DELETION' GROUP BY 1`: the test notice has an outcome; `ebay-deletion-review` `CronRun` rows exist. | Remove it |
| 3 | A3, then `NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP=1` (scheduler, API). One admin run, then eBay's revocation test notice. | `CronRun` SUCCESS with `topics=AUTHORIZATION_REVOCATION:created`. The status shows the destination `ENABLED`. P1 shows a verified `AUTHORIZATION_REVOCATION` row. | Remove the switch. The destination and subscription stay at eBay; disabling them needs a separate yes. |
| 4 | `NEXUS_ENABLE_EBAY_INBOUND_PROCESSING=1` (API, worker) | `SELECT "eventType",status,count(*) FROM "WebhookEvent" WHERE channel='EBAY' AND "verifiedBy"='ebay_ecdsa' GROUP BY 1,2` shows no stuck pending rows. Real proof: the next revocation sets `authStatus='revoked'`. | Remove it. Receipts stay held. |
| 5 | S3 runs under switch 3; A4 | The status shows every active account subscribed. The next sale gives an `ORDER_CONFIRMATION` receipt that is `pending`, with 0 attempts (held). | Remove switch 3 |
| 6 | `NEXUS_ENABLE_EBAY_ORDER_NOTICES=1` (API, worker) | Receipts reach `done`. `getOrder` rows with `triggeredBy='webhook'` and `success` appear in `OutboundApiCallLog`. `SELECT m."orderId" FROM "StockMovement" m JOIN "Order" o ON o.id=m."orderId" WHERE o.channel='EBAY' AND m.reason='ORDER_PLACED' AND m."createdAt">now()-interval '1 day' GROUP BY 1 HAVING count(*)>(SELECT count(*) FROM "OrderItem" i WHERE i."orderId"=m."orderId")` returns 0 rows; control: eBay orders that day > 0. | Remove it on both services. Held notices wait; the poll carries on. |

## 7. Estimate

| Slice | Build + test | Review + fixes | Total |
|---|---|---|---|
| S1 app-level setup | 0.5 day | 0.5 day | ~1 day |
| S2 order routing + race test | 1.5 days | 0.5 day | ~2 days |
| S3 per-seller subscriptions | 1.5 days | 0.5 day | ~2 days |
| Owner A1–A4 | about 1 hour (plus reconnects) | — | — |
| Rollout 1–6 | about 1 week of calendar time; step 6 needs a real sale | — | — |

Not in scope: the Option A erasure executor (privacy lane); shipping, return and message topics (after D1); an eBay
sandbox proof (the receiver verifies with production keys only).
