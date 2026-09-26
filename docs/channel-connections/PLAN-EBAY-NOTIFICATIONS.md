# eBay notifications: plan, review changes and the S1 runbook (2026-09-26)

Status: the plan was written on 2026-09-26 against main after #48, then independently reviewed the same day. The
review changed the scope and the safety rules; this file records both. **Slice S1 is built** on branch
`feat/ebay-notification-setup-s1`. Nothing has been switched on, and nothing called eBay, Railway or production
while it was built. The Owner decides each merge and each switch.

## 0. Review changes (2026-09-26)

| # | Change | Where it lands |
|---|---|---|
| R1 | **v1 = account revocation by subscription, plus account deletion in eBay's developer portal.** Order-confirmation notices (S2, S3) are **deferred**. | §1, §4 |
| R2 | **Why orders are deferred:** the eBay orders poll runs every 5 minutes by default (`startEbayOrdersCron`, `apps/api/src/jobs/ebay-orders-sync.job.ts` ~L186, `*/5 * * * *`), and stock is taken when the order is recorded. A notice would only shrink a window of at most 5 minutes, for two slices of work and a per-seller reconnect. | §1 |
| R3 | **Stop condition for the token theory:** if the status route reports `configured.verificationTokenValid: true` BEFORE any change, the format theory is wrong. Stop and re-plan; do not replace the token. | §3, runbook step 1 |
| R4 | **Safe on deploy, whatever the environment holds.** The setup switch became opt-in on 2026-09-22 (`571371bfc`), but a scheduler that still held `NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP=1` from before would, once S1 makes revocation ready, create the destination and subscription at the first 03:55 run. S1 adds a second, new switch; see §4.2. The admin setup route, which ignored the old switch, obeys the same gate. The misleading "opt out via `=0`" comment in `runtime/scheduler.ts` is fixed. | §4.2 |
| R5 | **Token placement:** the API and the scheduler need `EBAY_NOTIFICATION_VERIFICATION_TOKEN`; the worker does not. | §5, runbook step 2 |
| R6 | **Alert email (else 195003):** code sets eBay's Notification API config; the Owner supplies the address. | §4.1, runbook step 5 |

## 1. Goal, and what "working" means (v1)

eBay tells Nexus, with a signed notice, when a seller withdraws our access and when an eBay user asks for their account
to be deleted. Nexus stores each verified notice and acts on it once.

**Working** means both are proven in production by a real eBay-signed delivery, and a query reads the result back:
- **Deletion:** eBay's portal test notice is stored with a valid signature, then reviewed.
- **Revocation:** eBay's subscription test notice is stored. The next real revocation marks the account revoked and
  pauses its writes (after the separate processing switch).

**Deferred (R1, R2):** `ORDER_CONFIRMATION`. The 5-minute poll already records every eBay order and takes its stock.
S2 (order routing) and S3 (per-seller subscriptions) stay described in §4.3 for a later decision.

## 2. Current state vs target

| Piece | Before S1 (main) | After S1 |
|---|---|---|
| Verification challenge (GET) | Built. Returns `SHA-256(challengeCode + token + endpoint)`. Answered 200 with the correct hash on 2026-09-22. | Unchanged. Only the token is replaced (Owner, A1). |
| Receiver (POST) | Built: ECDSA signature check, durable storage before the 200. | Unchanged. |
| Notification API config (alert email) | Never read or set. | Read during an armed setup; set from `EBAY_NOTIFICATION_ALERT_EMAIL` only if eBay has none; refused before any write if the variable is missing. |
| Destination | None at eBay (measured 0 on 2026-09-22). | Created by the first armed setup; checked nightly while armed. |
| Topics | Five wishes, all flagged `handlerMissing`. | `AUTHORIZATION_REVOCATION` ready (application). `MARKETPLACE_ACCOUNT_DELETION` portal-only. `ORDER_CONFIRMATION` per-seller and unready. The two buy-side item topics are dropped. |
| Arming | Cron needed `NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP=1`; the admin route needed nothing. | Every write to eBay's Notification API needs the old switch AND `NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS` (§4.2). |
| Error text | Raw eBay body. | 195003, 195019, 195020 and 195021 named with what to do; the token, the app token and the alert address are removed from every message. |
| Processing | Built and held behind `NEXUS_ENABLE_EBAY_INBOUND_PROCESSING`. | Unchanged, still held. |

## 3. Why eBay rejected the token, and the stop condition

**Evidence.** On 2026-09-21 and 2026-09-22 the 03:55 reconcile called createDestination and eBay answered HTTP 400,
errorId **195019**: "Invalid or missing verification token for this endpoint." The challenge GET answered with the
correct hash the same day, both variables were set, and the request body matched eBay's contract.

**eBay's rule:** 195019 means the token breaks eBay's format: 32–80 characters, only `[A-Za-z0-9_-]`. A failed
challenge is a different error, 195020. The preflight `ebayVerificationTokenError` (`notifications.ts` ~L58-63) was
added on 2026-09-22 at 17:57, after both failures.

**Most likely cause:** the production value is the wrong length or contains a character outside the set (`.`, `=`,
`+`, `/`, a space or a trailing newline).

**Check without reading the secret:** `GET /api/admin/ebay-notification-status` returns
`configured.verificationTokenValid` as a boolean. S1 also returns it when eBay cannot be read.

**🔴 Stop condition (R3):** read it once BEFORE any change. Expect `false`. If it is `true`, the format theory is
wrong: stop, change nothing, and re-plan.

## 4. Slices

### 4.1 S1: an application-level setup eBay accepts (built)

Files: `services/cx/connectors/ebay/notifications.ts`, `routes/ebay-notification.routes.ts`,
`jobs/ebay-notification-reconcile.job.ts`, `services/cx/ingress/ebay-topics.ts`, `runtime/scheduler.ts` (comment
only), all under `apps/api/src`. No migration and no schema change.

- The armed setup reads `GET /config`. If eBay has no alert email it sets one from `EBAY_NOTIFICATION_ALERT_EMAIL`
  (`PUT /config`). If the variable is unset or malformed, it refuses with a plain message before createDestination,
  after reads only. An address already at eBay is never overwritten.
- Only topics whose Nexus delivery is `application` AND whose eBay catalogue `scope` is `APPLICATION` are sent. A
  `USER` topic is never sent with the app token.
- `MARKETPLACE_ACCOUNT_DELETION` is `portal`: reported in the status (`wanted[].delivery`), never subscribed.
- `ITEM_PRICE_REVISION` and `ITEM_AVAILABILITY` are gone from the wishes and from the topic router.
- `AUTHORIZATION_REVOCATION` is ready, after the written C8 check in §4.4.
- 195003, 195019, 195020 and 195021 are named in the setup output (CronRun detail and admin response). eBay's
  public spec documents 195021 as "Destination exists for this endpoint" (HTTP 409). The setup treats it as "already
  exists": it re-reads the destinations and reuses the one whose endpoint matches exactly, if it is `ENABLED`, so the
  nightly run does not fail. With no exact match, or a match that is not `ENABLED`, it still fails. It never guesses.
- `POST /api/admin/setup-ebay-notifications` answers 403 unless armed, before any call.
- New: `POST /api/admin/ebay-notification-test?topicId=AUTHORIZATION_REVOCATION` asks eBay to send its test notice for
  OUR subscription (`POST /subscription/{id}/test`). It is 403 unless armed and 400 for a topic that is not armed.
  RBAC: `admin.repair`, like the setup route.
- Both admin routes write one `AuditLog` row per request, refusals included:
  - `entityType` is `EbayNotificationSetup`, and the action is `ebay.notification.setup` or `ebay.notification.test`;
  - the metadata records the actor, the armed topics, the outcome, and each topic's status or the subscription id;
  - the error text is redacted before it is written.
- `apps/api/.env.example` lists every `EBAY_NOTIFICATION_*` variable and both switches with placeholder values. Its
  token placeholder is deliberately invalid, so setup refuses it.

### 4.2 The arming mechanism (R4)

**Mechanism:** a new, clearly named switch, `NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS`, whose value names each topic the
Owner arms (v1: `AUTHORIZATION_REVOCATION`). Setup is armed only when **both** hold:
`NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP` is exactly `1` AND every entry in the new list is a ready application-level
topic. One bad entry arms nothing.

The gate (`ebayNotificationSetupGate`) is enforced in four places, each proved by a mutation test:
- the cron start: an unarmed scheduler schedules nothing, so no CronRun appears;
- the setup service;
- the admin setup and test-notice routes: 403 before any call;
- `notificationApi`, the one function every Notification API request goes through: no POST or PUT is sent, and no
  app token is fetched, unless armed. A test proves the PUT case separately, because an independent review found that
  a gate refusing only POST passed every earlier test. Reads (the status route) are unaffected.

**Why this and not an Owner-armed database marker:** it is the smallest mechanism that is safe whatever the environment
holds:
- No release before S1 read this variable, so no stale value can arm it. The old switch alone, the stale case the
  review found, arms nothing.
- It needs no migration, no new model to classify, no row-level-security policy and no new admin write path. Railway's
  deployment history shows the variable change. Every nightly run writes a `CronRun`, and every admin setup or
  test-notice request writes an `AuditLog` row with the actor, the topics and the outcome.
- It names topics instead of being a boolean. A later release that makes another topic ready (S2 may do so for
  `ORDER_CONFIRMATION`) does not arm it. The Owner must add it to the list, and the gate refuses a `USER` or portal
  topic even when its handler is ready.

A database marker would have added a table, a migration, RLS classification and an audit writer to get the same
"fresh and explicit" property.

### 4.3 Deferred: S2 (order routing) and S3 (per-seller subscriptions)

Unchanged from the original plan, and not scheduled (R1, R2):
- **S2** routes `ORDER_CONFIRMATION` notices to the seller's account through `ChannelAccountOwnership` and adds a real-PG
  race test for the poll and the notice writing together.
- **S3** subscribes each seller with its own token (`commerce.notification.subscription` scope) and reports "reconnect
  needed" for older grants.

Revisit S2 and S3 only if a 5-minute order latency becomes a problem.

### 4.4 Written C8 check for `AUTHORIZATION_REVOCATION`

This checks the C8 list in `build/CX-COMPLETION.md` (Slice C8). Paths are under `apps/api/src/services/cx/`.

| C8 item | Verdict | Evidence |
|---|---|---|
| Durable, claimed receipts | Met | The receipt is stored before the 2xx (`ingress/ebay-admission.ts` `writeOwned`, ~L100-110). eBay leases are handled in `ingress/ebay-claims.ts` (`claimEbayInbound`, `renew…`, `finish…`, `commit…`). Test: `ebay-claims-postgres` "gives two simultaneous claimants one stored payload, one owner and one attempt". |
| Persisted account ownership | Met | `ownerFor` / `accountFor` look up `ChannelAccountOwnership` by the immutable `notification.data.userId` and environment. An unknown owner goes to encrypted quarantine; there is no username or sole-account fallback. Test: `ebay-admission-postgres` "does not fall back to usernames or unrelated sole accounts". |
| Replay after route removal | Partly met | `ingress/handlers.ts` maps the topic to `processEbayInbound`, and processing uses the stored `connectionId`, not the route. No test removes a route and then replays. An inactive-but-not-revoked account retries until the notice is dead-lettered. |
| New-grant fence for delayed revocation | Partly met | The fence compares `grantVersion` and asks eBay whether the current refresh grant is active (`account-lifecycle.service.ts` ~L132-136). A late notice never revokes a new grant. Instead of completing as superseded, it retries 5 times, is dead-lettered and raises one owner warning. |
| Effects | Met | `revokeGrantInTx` sets `authStatus='revoked'`, deactivates the account and raises a "Writes are paused" alert, all in one transaction. |

**Decision:** subscribing is safe. A stored revocation notice stays **held** (`queueForRetry:false`; processing returns
`held` while `NEXUS_ENABLE_EBAY_INBOUND_PROCESSING` is off), so the subscription only stores signed notices. The two
partial items produce dead-letter noise, not a wrong revocation. Review them before the processing switch (runbook
step 7), not before S1.

## 5. Owner actions

- **A1 (Railway):** set a new `EBAY_NOTIFICATION_VERIFICATION_TOKEN` on the **API and the scheduler**, as 64 hex
  characters (`openssl rand -hex 32`). The worker does not need it (R5). On both, check that
  `EBAY_NOTIFICATION_ENDPOINT_URL` is exactly the public `https://…/api/webhooks/ebay-notification` on the API origin,
  with no trailing slash and no query.
- **A2 (eBay developer portal):** Application Keys (production) → Alerts & Notifications → Marketplace account deletion.
  1. Confirm the app is not marked exempt ("not persisting eBay data").
  2. Enter the alert email, set the endpoint to exactly A1's URL and the token to exactly A1's token.
  3. Save. eBay checks the challenge live against the API.
  4. Send the test notification.
- **A3 (Railway):** set `EBAY_NOTIFICATION_ALERT_EMAIL` on the **API and the scheduler**. The code writes it to eBay's
  Notification API config during the first armed setup, and only if eBay has none (R6).
- **A4 (arming):** on the **API and the scheduler**, set `NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP=1` and
  `NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS=AUTHORIZATION_REVOCATION`. Do this only after A1 has deployed on both services.
  eBay challenges the API when the destination is created; if the API holds another token, eBay answers 195020.

## 6. Runbook (each step waits for the Owner's yes)

Queries run in a `READ ONLY` transaction, return aggregates only and carry a positive control.

| Step | Action | Proof | Undo |
|---|---|---|---|
| 0 | Merge S1; it deploys the API and the scheduler. Confirm `NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS` is absent on every service. | The serving build equals the merge. The scheduler logs `ebay-notification-reconcile cron not armed`. `ebay-notification-reconcile` has no new `CronRun`. The EBAY `WebhookEvent` count is unchanged. | Revert the PR |
| 1 | Read `GET /api/admin/ebay-notification-status` once. | `setupGate.armed=false`. 🔴 **If `configured.verificationTokenValid` is `true`, STOP and re-plan (§3).** Expect `false`. | Nothing changed |
| 2 | A1 (API + scheduler), then A2. | The status reports `verificationTokenValid=true`. `SELECT topic,"signatureOk",reason,count(*) FROM "EbayNoticeQuarantine" WHERE "receivedAt">now()-interval '1 hour' GROUP BY 1,2,3` shows `MARKETPLACE_ACCOUNT_DELETION / true`. | Nothing to switch off: notices stay stored |
| 3 | `NEXUS_ENABLE_EBAY_PRIVACY_REVIEW=1` (worker, scheduler). | `SELECT "reviewOutcome",count(*) FROM "EbayNoticeQuarantine" WHERE topic='MARKETPLACE_ACCOUNT_DELETION' GROUP BY 1`: the test notice has an outcome. | Remove it |
| 4 | A3 on the API and the scheduler. | The status reports `configured.hasAlertEmail=true`. | Remove it |
| 5 | A4, then one `POST /api/admin/setup-ebay-notifications`. | The response is `ok:true`, with `AUTHORIZATION_REVOCATION:created` and `alertEmail` `set` or `present`. The status shows the destination `ENABLED`, and the next 03:55 `CronRun` is SUCCESS with `already_exists`. | Remove `NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS`: nothing more is written. The destination and subscription stay at eBay; disabling them needs a separate yes. |
| 6 | `POST /api/admin/ebay-notification-test?topicId=AUTHORIZATION_REVOCATION` | `ok:true`. The step-2 query shows `AUTHORIZATION_REVOCATION / true`. The test user is unknown, so the notice is quarantined and still acknowledged. | Nothing to undo |
| 7 | Separate decision: `NEXUS_ENABLE_EBAY_INBOUND_PROCESSING=1` (API, worker), after reviewing §4.4's partial items. | `SELECT "eventType",status,count(*) FROM "WebhookEvent" WHERE channel='EBAY' AND "verifiedBy"='ebay_ecdsa' GROUP BY 1,2` shows no stuck pending rows. Real proof: the next revocation sets `authStatus='revoked'`. | Remove it; receipts stay held |

**If the setup reports an eBay error id:**
- **195019:** the token format. Redo A1.
- **195020:** eBay's challenge failed. Check that the API and the scheduler hold the same token and endpoint and that
  the API has redeployed, then rerun step 5.
- **195003:** the alert email. Check A3.
- **195021** ("Destination exists for this endpoint", HTTP 409): the setup reuses the destination whose endpoint matches
  exactly. If it still fails, compare `EBAY_NOTIFICATION_ENDPOINT_URL` with `destinationEndpoints` in the status (a
  trailing slash, http/https or another host).
- **Any other `getConfig` status:** the setup stops before writing and prints eBay's text. Report it.

## 7. Estimate

| Work | Effort |
|---|---|
| S1 build + tests | done |
| S1 review + fixes | ~0.5 day |
| Owner steps 0–6 | about 1 hour of actions, spread over a few days for the proofs |
| S2 + S3 | deferred (R1) |

Not in scope: the Option A erasure executor (privacy lane), order, shipping, return and message topics, and an eBay
sandbox proof (the receiver verifies with production keys only).
