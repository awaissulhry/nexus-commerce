# Handoff — PR B: each eBay account subscribes to ORDER_CONFIRMATION with its own sign-in (2026-10-06)

GAP2 phase 2 (plan: `GAP2-ebay-order-notifications-plan.md` §4 "Phase 2"; repo plan
`docs/channel-connections/PLAN-EBAY-NOTIFICATIONS.md` §4.3 "S3", which this builds).

- Branch `feat/ebay-order-notice-subscriptions`, worktree `/private/tmp/feat-ebay-order-notice-subscriptions`,
  base `origin/main` 1d207cf19. Main has moved since (one Etsy commit) and touches none of these files.
- **Not pushed, no PR.** Nothing is switched on: with today's variables this PR makes no new eBay call.

## What it does

| Part | File (under `apps/api/src`) | Behaviour |
|---|---|---|
| Gate | `services/cx/connectors/ebay/notifications.ts` | `ORDER_CONFIRMATION` is ready (no longer `handlerMissing`). The gate accepts a per-seller (USER) topic **only when named** in `NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS`, still with `NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP=1`. A portal topic or a lower-case name arms nothing. New helpers: `armedApplicationTopics`, `armedSellerTopics`. |
| App-level setup | same file | Application topics keep the app token. A USER topic is never sent with the app token. The destination is created when only `ORDER_CONFIRMATION` is armed. The result carries `sellerTopics` (eBay's catalogue entry). A per-seller topic that is missing from eBay's catalogue goes into `notOffered`, and setup then does not succeed. |
| Choke point | same file, `notificationApi` | It now takes a caller: `'app'` or `{ connectionId }`. A seller call goes through `ebayTransport(connectionId)` with **no Authorization header**, so the gateway uses that account's token. A seller write needs a per-seller topic in the armed list. It is refused before any transport or token. |
| Seller reconcile | `services/cx/connectors/ebay/seller-subscriptions.ts` (new) | `reconcileEbaySellerSubscriptions(connectionId)` makes these checks in this order. **1. Arming.** Unarmed → `not_armed`: no account read, no token, no call. **2. The account (database only).** Inactive, `needs_reauth`, `revoked` or `disconnected` → `reconnect_needed`, no call. The same result when `grantedScopes` lacks `commerce.notification.subscription` or has no `sell.fulfillment` scope. **3. eBay's catalogue.** The topic is missing → `not_offered`. It is not a USER topic, or it has no JSON/HTTPS payload → `failed`. The topic's own `authorizationScopes` are not granted → `reconnect_needed`. **4. Our destination.** None, or not ENABLED → `failed`. **5. The seller's subscriptions,** read with the seller's token: enabled on our destination → `subscribed` (no write); disabled → enable → `enabled`; missing → POST with the schema version from the topic → `created`. **6. eBay's answer.** errorId 195011, or a gateway "needs sign-in" hold → `reconnect_needed`. Any other answer → `failed(reason)`. The function never throws. |
| Nightly job | `jobs/ebay-notification-reconcile.job.ts` | It runs after the app-level setup (03:55 UTC, platform cron). It visits **every active business** and each business's own active eBay accounts. An account another business shares in is left to its owner. **Reconnect needed:** reported as a count, and the run still succeeds. **The run fails when:** a seller result is `failed` or `not_offered`; a business's accounts cannot be listed (the other businesses still run); or two accounts report the same subscription id. |
| Admin setup | `routes/ebay-notification.routes.ts` `POST /api/admin/setup-ebay-notifications` | It runs the same seller step for the accounts of **the business the request runs in**. The response gains `sellers.accounts[]`: connection id, sign-in name, status, reason. The audit row gains `perSeller`. |
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
| (this file) | docs: this handoff |

## Checks (local; CI is off)

| Type of check | Command | Result |
|---|---|---|
| Typecheck api | `npx tsc --noEmit -p apps/api/tsconfig.json` | pass |
| Tests, profiles OFF | `cd apps/api && DATABASE_URL='postgresql://nexus:nexus@127.0.0.1:5432/nexus_development' REDIS_URL='redis://127.0.0.1:1' npx vitest run src/services/cx/connectors/ebay/ src/jobs/ebay-notification-reconcile.vitest.test.ts src/jobs/ebay-notification-activation.vitest.test.ts src/routes/ebay-notification.p23.vitest.test.ts src/routes/ebay-notification-status.cx.vitest.test.ts src/routes/ebay-notification-setup-gate.vitest.test.ts src/services/cx/ingress/ebay-topics.p23.vitest.test.ts src/routes/sync-logs-ebay-replay.vitest.test.ts src/jobs/inbound-retry-trust.vitest.test.ts src/services/write-account-guard.p07.vitest.test.ts src/lib/crypto-kms-production-formats.vitest.test.ts` | pass: 18 files, 364 tests |
| Tests, profiles ON | the same with `NEXUS_WORKSPACES_ENABLED=1` | pass: 18 files, 364 tests |
| Mutation checks | 11 guards broken one at a time (below) | each caught by at least one failing test |
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

## What the Owner sets in Railway (only after PR A is live; Claude may not set variables)

| Service | Variable | Value |
|---|---|---|
| **API + scheduler** | `NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP` | `1` |
| **API + scheduler** | `NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS` | `AUTHORIZATION_REVOCATION,ORDER_CONFIRMATION`, or `ORDER_CONFIRMATION` alone if revocation should wait |
| API + scheduler (prerequisites, plan §4 Phase 3) | `EBAY_NOTIFICATION_VERIFICATION_TOKEN` | a **new** value, `openssl rand -hex 32` (eBay refused the old one, 195019) |
| API + scheduler | `EBAY_NOTIFICATION_ALERT_EMAIL` | the alert address |
| API + scheduler | `EBAY_NOTIFICATION_ENDPOINT_URL` | exactly `https://<api host>/api/webhooks/ebay-notification` |
| API + worker (processing, PR A, not this PR) | `NEXUS_ENABLE_EBAY_INBOUND_PROCESSING`, `NEXUS_ENABLE_EBAY_ORDER_NOTICES` | `1` |

The worker needs none of this PR's variables. The scheduler checks the gate when it starts. A variable change
redeploys the service on Railway, and the 03:55 UTC job is scheduled only after that.

**Then (Claude, read-only checks plus one setup call each, as in plan §4 Phase 3):**
- Read `GET /api/admin/ebay-notification-status`. `sellers.accounts[]` lists any account that needs **Reconnect**.
- Call `POST /api/admin/setup-ebay-notifications` once **in each business** (the route covers the business it
  runs in), or wait for the 03:55 UTC run, which covers every business. Expect:
  - `ok:true`;
  - `sellers.accounts[].status` = `created`, with a **different** `subscriptionId` for each account;
  - the next nightly run reports `subscribed`.

**Undo:**
- Remove `ORDER_CONFIRMATION` from the list. No new seller subscription is made, and the status route stops using
  seller tokens.
- Subscriptions that already exist stay at eBay. Disabling them needs a separate yes.
- Notices stay stored and held unless the processing switches are on. The 5-minute poll is unchanged.

## Open points

1. **Not built: a per-seller test notice (plan Phase 3 step 2).** `POST /api/admin/ebay-notification-test?topicId=ORDER_CONFIRMATION`
   answers `ok:false` ("subscribed per seller") and makes no call. A follow-up would be small: the seller transport,
   then `POST /subscription/{id}/test`. The real proof stays the first real IT sale.
2. **An assumption, guarded but not proven.** eBay's subscription records name no seller. So "ours" assumes that a
   seller token's `GET /subscription` lists only that seller's subscriptions.
   - If two accounts in one run report the same id, the later one is `failed` and the run fails.
   - At the first armed setup, check that each account has its own `subscriptionId`.
   - The status route does not make this check across accounts.
3. **Only errorId 195011 means "reconnect".** Per eBay's Notification API spec (cited in the plan), 195011 is a
   missing scope. Any other 401 or 403 is reported as `failed`, with eBay's text (redacted).
4. **Scopes come from `grantedScopes`.** An eBay connection records the scopes it asked for at connect, because
   eBay echoes none back. A sign-in made before the notification scope joined the Connect list reads as
   `reconnect_needed`, and no call is made.
5. **Order of release:** merge A, then B, then arm.
   - If `ORDER_CONFIRMATION` is armed before PR A is live, notices are stored and quarantined
     (`subject_or_topic_unresolved`). They are acknowledged and not lost, and the poll covers them.
6. **Sibling overlap in `routes/ebay-notification.routes.ts`.** This PR changes the audit helper's type, the setup
   route and the status route. PR C changes only the receiver POST. The hunks are separate.
7. **The status field `wanted[].subscribed` stays `false` for `ORDER_CONFIRMATION`.** The app token cannot see
   per-seller subscriptions, so `sellers` is the per-account view.
8. **One plan doc is out of date.** §4.3 of `docs/channel-connections/PLAN-EBAY-NOTIFICATIONS.md` still says S3 is
   deferred. It was left alone to keep the PR small, and this handoff replaces it for S3.
