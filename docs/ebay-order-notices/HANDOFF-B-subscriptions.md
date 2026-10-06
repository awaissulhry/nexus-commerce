# Handoff — PR B: each eBay account subscribes to ORDER_CONFIRMATION with its own sign-in (2026-10-06)

GAP2 phase 2 (plan: `GAP2-ebay-order-notifications-plan.md` §4 "Phase 2"; repo plan
`docs/channel-connections/PLAN-EBAY-NOTIFICATIONS.md` §4.3 "S3", which this builds).

- Branch `feat/ebay-order-notice-subscriptions`, worktree `/private/tmp/feat-ebay-order-notice-subscriptions`,
  base `origin/main` 1d207cf19. Main has moved since (one Etsy commit) and touches none of these files.
- **Not pushed, no PR.** Nothing is switched on: with today's variables this PR makes no new eBay call.
- The review (`GAP2-PR-B-review.md`) found no blocker. Its two SHOULD-FIX items (S1, S2) and notes N1/N2 are
  built (commits f15463dac, adfa9a205); N3/N4 are steps or PR A's, listed below.

## What it does

| Part | File (under `apps/api/src`) | Behaviour |
|---|---|---|
| Gate | `services/cx/connectors/ebay/notifications.ts` | `ORDER_CONFIRMATION` is ready (no longer `handlerMissing`). The gate accepts a per-seller (USER) topic **only when named** in `NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS`, still with `NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP=1`. A portal topic or a lower-case name arms nothing. New helpers: `armedApplicationTopics`, `armedSellerTopics`. |
| App-level setup | same file | Application topics keep the app token. A USER topic is never sent with the app token. The destination is created when only `ORDER_CONFIRMATION` is armed. The result carries `sellerTopics` (eBay's catalogue entry). A per-seller topic that is missing from eBay's catalogue goes into `notOffered`, and setup then does not succeed. |
| Choke point | same file, `notificationApi` | It now takes a caller: `'app'` or `{ connectionId }`. A seller call goes through `ebayTransport(connectionId)` with **no Authorization header**, so the gateway uses that account's token. A seller write needs a per-seller topic in the armed list. It is refused before any transport or token. |
| Seller reconcile | `services/cx/connectors/ebay/seller-subscriptions.ts` (new) | `reconcileEbaySellerSubscriptions(connectionId)` makes these checks in this order. **1. Arming.** Unarmed → `not_armed`: no account read, no token, no call. **2. The account (database only).** Inactive, `needs_reauth`, `revoked` or `disconnected` → `reconnect_needed`, no call. The same result when `grantedScopes` lacks `commerce.notification.subscription` or has no `sell.fulfillment` scope. **3. eBay's catalogue.** The topic is missing → `not_offered`. It is not a USER topic, or it has no JSON/HTTPS payload → `failed`. The topic's own `authorizationScopes` are not granted → `reconnect_needed`. **4. Our destination.** None, or not ENABLED → `failed`. **5. The seller's subscriptions,** read with the seller's token: enabled on our destination → `subscribed` (no write); disabled → enable → `enabled`; missing → POST with the schema version from the topic → `created`. **6. eBay's answer.** A gateway "needs sign-in" hold → `reconnect_needed`. **errorId 195011 → `failed`** ("eBay refused this topic for the app/account — not a sign-in problem"): it can only come after step 2 found the scopes recorded, so Reconnect would not fix it, and the nightly run must turn red (review S1). **409 / errorId 195012 "Subscription already exists"** → the seller's list is read again: on our destination → `subscribed` (or enabled when disabled); on another destination → `failed`, naming that destination (review S2). Any other answer → `failed(reason)`. The function never throws. |
| Nightly job | `jobs/ebay-notification-reconcile.job.ts` | It runs after the app-level setup (03:55 UTC, platform cron). It visits **every active business** and each business's own active eBay accounts. An account another business shares in is left to its owner. **Reconnect needed:** reported as a count, and the run still succeeds. **The run fails when:** a seller result is `failed` or `not_offered`; a business's accounts cannot be listed (the other businesses still run); or two accounts report the same subscription id. |
| Admin setup | `routes/ebay-notification.routes.ts` `POST /api/admin/setup-ebay-notifications` | It runs the same seller step for the accounts of **the business the request runs in**. The response gains `sellers.accounts[]`: connection id, sign-in name, status, reason. The audit row gains `perSeller`. |
| Per-seller test notice | `seller-subscriptions.ts` `sendEbaySellerTestNotice(connectionId, env)`; `POST /api/admin/ebay-notification-test?topicId=ORDER_CONFIRMATION&connectionId=<id>` | Review N2. Checks in order: arming (unarmed → refused, no account read, no call); the account is one of **this business's own** active eBay accounts (else 400, no call); the sign-in (Reconnect → refused, no call); our ENABLED destination and **this seller's ENABLED** `ORDER_CONFIRMATION` subscription on it (none → plain refusal, no test requested). Then `POST /subscription/{id}/test` with the seller's own token; eBay answers **202**. The app token only reads the topic catalogue and our destination. Without `connectionId` the route answers 400 for a per-seller topic. Audited (`connectionId`, outcome). |
| Status | `GET /api/admin/ebay-notification-status` | The new `sellers` block lists each account of this business as `subscribed` / `not_subscribed` / `disabled` / `reconnect_needed` / `not_armed` / `not_offered` / `failed`. The database checks run first, so accounts that need **Reconnect show before arming, with no eBay call**. The seller token is used only while `ORDER_CONFIRMATION` is armed. The block carries no eBay user ids. |

The receiver, the ingress files and the processing switch are not touched. PR A (routing) and PR C (the "process
now" kick) own those.

## Commits

| Commit | What |
|---|---|
| 4ffe87224 | feat: gate + choke point + `seller-subscriptions.ts` + job + setup/status routes |
| 52bdcce3d | test: the new seller-subscription suite |
| bbc10e949 | test: readiness, activation, contract, reconcile, setup-gate and status tests updated (ORDER_CONFIRMATION armed by name) |
| 84278e089 | fix: a business whose accounts cannot be listed does not stop the others; `.env.example` names the topic |
| 552a53445 | fix: two accounts reported with one subscription id → `failed`, never `subscribed` |
| 78892ba0e | docs: this handoff (first version) |
| f15463dac | fix (review): 195011 → `failed`; 409/195012 re-reads the list; `sendEbaySellerTestNotice` + the admin test route's `connectionId` |
| adfa9a205 | test (review): the S1, S2 and test-notice cases |
| (this update) | docs: review fixes, exact Owner steps, the test-notice call, the subscription-id comparison |

## Checks (local; CI is off)

| Type of check | Command | Result |
|---|---|---|
| Typecheck api | `npx tsc --noEmit -p apps/api/tsconfig.json` | pass |
| Tests, profiles OFF | `cd apps/api && DATABASE_URL='postgresql://nexus:nexus@127.0.0.1:5432/nexus_development' REDIS_URL='redis://127.0.0.1:1' npx vitest run src/services/cx/connectors/ebay/ src/jobs/ebay-notification-reconcile.vitest.test.ts src/jobs/ebay-notification-activation.vitest.test.ts src/routes/ebay-notification.p23.vitest.test.ts src/routes/ebay-notification-status.cx.vitest.test.ts src/routes/ebay-notification-setup-gate.vitest.test.ts src/services/cx/ingress/ebay-topics.p23.vitest.test.ts src/routes/sync-logs-ebay-replay.vitest.test.ts src/jobs/inbound-retry-trust.vitest.test.ts src/services/write-account-guard.p07.vitest.test.ts src/lib/crypto-kms-production-formats.vitest.test.ts` | pass: 18 files, 382 tests (after the review fixes) |
| Tests, profiles ON | the same with `NEXUS_WORKSPACES_ENABLED=1` | pass: 18 files, 382 tests |
| Mutation checks | 17 guards broken one at a time (below) | each caught by at least one failing test |
| Channel-gateway ratchet | `cd apps/api && npx tsx scripts/channel-gateway-ratchet.mts --check` | pass (EBAY 0 outside the gateway) |
| Cron guard | `node scripts/check-cron-clustered.mjs` | pass |
| Route-Prisma ratchet | `node scripts/check-route-prisma-ratchet.mjs` | pass (no Prisma in the route) |
| Inbound-ledger guard | `node scripts/check-inbound-ledger.mjs` | pass |
| Real-Postgres suites | `node scripts/run-real-postgres-tests.mjs` | not run. This PR writes nothing to the database. The business visit reads `Workspace` the same way `ebay-erasure-review.ts` does. `ebay-erasure-review-postgres` is skipped without the runner. |
| RBAC coverage / browser | — | not run: no new route (both admin routes fall under `/api/admin`), and no screen change |

Mutations, each caught:
1. Without the arming check in the reconcile, 6 tests fail.
2. Without the per-seller check in the choke point, 1 test fails.
3. With seller calls sent as app-level with the app token, 7 tests fail.
4. Without the subscribe-scope check, 2 tests fail.
5. With 195011 treated as an ordinary failure, 3 tests fail.
6. When the reconcile creates even though an enabled subscription exists, 4 tests fail.
7. With shared-in accounts included, 2 tests fail.
8. With the per-seller topic armed without its name, 7 tests fail.
9. When setup sends every armed topic with the app token, 5 tests fail.
10. With the gate refusing USER topics again, 43 tests fail.
11. Without the shared-subscription guard, 1 test fails.
12. With 195011 mapped back to `reconnect_needed`, 3 tests fail.
13. Without the re-read on 409/195012, 4 tests fail.
14. With the test notice skipping the own-account check, 3 tests fail.
15. With the test notice skipping the ENABLED check, 1 test fails.
16. With the test notice skipping the arming check, 2 tests fail.
17. With the route letting a per-seller test through without `connectionId`, 2 tests fail.

## Owner steps, in order (Claude may not set variables)

**Before merging B (Claude, read only — review N3):** read `NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS` on the API and
the scheduler. It must **not** name `ORDER_CONFIRMATION` yet. Before this PR a list naming it armed nothing; after
it, that list arms the seller subscriptions at the next deploy.

**Release order: merge PR A (routing) → it is live → merge PR B → arm.** Armed before PR A is live, notices are
stored and quarantined (`subject_or_topic_unresolved`): acknowledged and not lost, and the poll covers them.

**1. The Owner, in Railway, after PR B is live:**

| Service | Variable | Value |
|---|---|---|
| API + scheduler (prerequisites, plan §4 Phase 3) | `EBAY_NOTIFICATION_VERIFICATION_TOKEN` | a **new** value, `openssl rand -hex 32` (eBay refused the old one, 195019) |
| API + scheduler | `EBAY_NOTIFICATION_ALERT_EMAIL` | the alert address |
| API + scheduler | `EBAY_NOTIFICATION_ENDPOINT_URL` | exactly `https://<api host>/api/webhooks/ebay-notification`, no trailing slash |
| **API + scheduler** | `NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP` | `1` |
| **API + scheduler** | `NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS` | `AUTHORIZATION_REVOCATION,ORDER_CONFIRMATION`, or `ORDER_CONFIRMATION` alone if revocation should wait |
| API + worker (processing, PR A, not this PR) | `NEXUS_ENABLE_EBAY_INBOUND_PROCESSING`, `NEXUS_ENABLE_EBAY_ORDER_NOTICES` | `1` |

The worker needs none of this PR's variables. The scheduler checks the gate when it starts; a variable change
redeploys it on Railway, so the 03:55 UTC job is scheduled after the change.

**2. Claude, after the deploy (read-only checks plus one setup call and one test call per business):**
1. `GET /api/admin/ebay-notification-status` in each business. `configured.verificationTokenValid` is `true`,
   `setupGate.armed` is `true`, and `sellers.accounts[]` lists each account. Any `reconnect_needed` → the Owner
   presses **Reconnect** on that account first (Settings → Channels).
2. `POST /api/admin/setup-ebay-notifications` **once in each business** (the route covers the business the request
   runs in). Expect `ok:true`, the destination, and `sellers.accounts[].status` = `created` (or `subscribed`).
3. **Compare the subscription ids before calling it live (review N1).** Write down
   `sellers.accounts[].subscriptionId` from each business's call. The two ids **must differ**. The same id in both
   → stop: a seller token may be listing another seller's subscription; do not switch processing on, and report it.
   The 03:55 UTC run, which sees every business in one pass, also fails on a shared id.
4. The test notice, once per account:
   `POST /api/admin/ebay-notification-test?topicId=ORDER_CONFIRMATION&connectionId=<that business's eBay account id>`
   (the id is the `connectionId` the status lists). Expect `{ ok: true, subscriptionId }` (eBay answered 202), and
   then a stored `ORDER_CONFIRMATION` notice with a valid signature. eBay's test notice may name a test user, so
   it may sit in quarantine: that is fine.
5. The real proof stays the next real IT sale (plan §4 Phase 3 step 3).

**Undo:**
- Remove `ORDER_CONFIRMATION` from the list. No new seller subscription is made, and the status route stops using
  seller tokens.
- Subscriptions that already exist stay at eBay. Disabling them needs a separate yes.
- Notices stay stored and held unless the processing switches are on. The 5-minute poll is unchanged.

## Open points

1. **An assumption, guarded but not proven (review N1).** eBay's subscription records name no seller, so "ours"
   assumes a seller token's `GET /subscription` lists only that seller's subscriptions. Guards: two accounts with
   one id in one run → `failed` and a red run; and Owner step 2.3 compares the ids across the two businesses.
   The status route does not compare across accounts.
2. **195011 is now a red failure, not "reconnect".** Reconnect stays only for what the account itself shows (a held
   sign-in, a missing recorded scope). If 195011 appears, eBay is refusing the topic to the app or account: check
   the eBay application's access to `ORDER_CONFIRMATION`.
3. **A subscription on another destination** (an old endpoint URL) is `failed`, naming that destination.
   Disabling or deleting it at eBay needs a separate yes; this PR never deletes.
4. **Scopes come from `grantedScopes`.** An eBay connection records the scopes it asked for at connect, because
   eBay echoes none back. A sign-in made before the notification scope joined the Connect list reads as
   `reconnect_needed`, and no call is made.
5. **PR A's file (review N4):** the `cx/ingress/ebay-order-processing.ts` header still says the subscription stays
   `handlerMissing`. PR A removes "DORMANT" and should fix that sentence; this PR does not edit `cx/ingress/*`.
6. **Sibling overlap in `routes/ebay-notification.routes.ts`.** This PR changes the audit helper's type, the setup
   route, the test-notice route and the status route. PR C changes only the receiver POST. The hunks are separate.
7. **The status field `wanted[].subscribed` stays `false` for `ORDER_CONFIRMATION`.** The app token cannot see
   per-seller subscriptions, so `sellers` is the per-account view.
8. **One plan doc is out of date.** §4.3 of `docs/channel-connections/PLAN-EBAY-NOTIFICATIONS.md` still says S3 is
   deferred. It was left alone to keep the PR small, and this handoff replaces it for S3.
