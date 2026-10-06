# eBay order notices — PR A: routing (Phase 1)

Branch `feat/ebay-order-notice-routing`, based on `origin/main` 1d207cf19. Not pushed. **Nothing is switched on.**
Plan: `~/nexus-archive/2026-10-06-stock-realtime/GAP2-ebay-order-notifications-plan.md` (Phase 1).
Review: `~/nexus-archive/2026-10-06-stock-realtime/GAP2-PR-A-review.md`. Findings 1, 4 and 6 are fixed here (see
"Review fixes").

## What it does

An eBay `ORDER_CONFIRMATION` notice is now routed like `AUTHORIZATION_REVOCATION`: to the business that owns the seller
id, and onto that seller's account. Until now it always went to quarantine (`subject_or_topic_unresolved`).

All changes are in `apps/api/src/services/cx/ingress/`, plus the suite list in `scripts/run-real-postgres-tests.mjs`.

| File | Change |
|---|---|
| `ebay-revocation-notice.ts` | `readEbayNoticeIdentity` reads the seller from `data.user.userId` for `ORDER_CONFIRMATION`, as eBay documents it. The account topics keep the flat `data.userId`. There is no fallback between the two shapes, and the username is never used. |
| `ebay-admission.ts` | `routeable` and `ownerFor` accept `ORDER_CONFIRMATION` (`ROUTED_TOPICS`). The owner lookup (`ChannelAccountOwnership`) and `accountFor` are unchanged. An unknown seller, an inactive business or a missing seller id goes to encrypted quarantine. Nothing is guessed. An order notice whose account needs Reconnect is also quarantined (see "Review fixes"). |
| `ebay-order-notice.ts` | The parser returns the seller id and requires it (`seller_missing`). |
| `ebay-order-processing.ts` | Refuses a notice whose seller is not the account's seller (`seller_mismatch`). It is dead-lettered with the plain reason "This eBay order notice is for a different eBay seller than its account. Nothing was changed." The check runs twice: before the order is read, and again in the commit transaction, where the account row is locked. The commit also re-checks the reloaded receipt's seller. The header now states the true state: notices come from the per-seller subscription (`cx/connectors/ebay/notifications.ts`, PR B), and processing is held by the switch. |
| `handlers.ts` | `ORDER_CONFIRMATION` is registered for replay through the same `processEbayInbound`. |
| `ebay-claims.ts` | `queueEbayReplay` refuses (`processing_held`) a manual replay of an order notice while `NEXUS_ENABLE_EBAY_ORDER_NOTICES` is not `1`. The row stays exactly as stored. |
| `__fixtures__/ebay-order-confirmation.json` | The contract fixture. All its ids are fake. eBay's topic page has no sample body for this topic (`"sample": []`), so the fixture follows eBay's AsyncAPI schema field for field (`/develop/api/spec/events/ORDER_CONFIRMATION.yaml`). |

The hold is unchanged. Unless `NEXUS_ENABLE_EBAY_ORDER_NOTICES=1` (in `ebay-processing-policy.ts`), a stored order
notice is never claimed, never dead-lettered and never reset.

## Review fixes

| Finding | Fix |
|---|---|
| 1a: a notice for an account that needs Reconnect gets stuck | **Admission** (`ebay-admission.ts`) quarantines such an order notice with reason `account_not_connected`, meaning "the eBay account is not connected; the 5-minute order check records the order after Reconnect". It applies when the account is inactive, or its `authStatus` is `needs_reauth`, `revoked` or `disconnected`. That is the same rule the gateway uses to hold a call (`gateway.ts`, step 2). Revocation routing is unchanged, because revocation is exactly the notice such an account receives. |
| 1b: a held order notice never ends | **Executor** (`ebay-order-processing.ts`): a read held for sign-in (`AUTH_REQUIRED`) is deferred as before, but only until `EBAY_ORDER_NOTICE_SIGNIN_WAIT_MS` = **6 hours** after the first receipt, measured on the database clock. After that it is dead-lettered with "The eBay account must be reconnected. Nexus stopped waiting for this order notice; after Reconnect the 5-minute eBay order check records the order." A dead letter makes no further gateway call. |
| 1c: the sweep starves new receipts | **Sweep** (`ebay-processing.ts`, `dueEbayInboundEvents`): new receipts (`nextAttemptAt` NULL) come first, then the oldest due (`nulls: 'first'`). The signature of `processEbayInbound` is unchanged. |
| 4: the last attempt still says "read again" | A retry on the last allowed attempt is recorded as a dead letter with "Nexus stopped retrying this eBay order notice. The 5-minute eBay order check still reads this order." It no longer says "It will be read again". |
| 6: wrong test count in the runner | `scripts/run-real-postgres-tests.mjs` now expects the real **35** for `ebay-order-writer-postgres`. |

## Commits

| Commit | What |
|---|---|
| `9f729ab79` feat(ebay) | The routing, the seller checks, the replay registration and hold, the contract fixture, and the unit tests. |
| `0db5cdf55` test(ebay) | Admission and executor cases on real PostgreSQL, the notice-vs-poll race suite, and the runner suite list. |
| `a7a904265` test(ebay) | If a stored notice's seller changes during the read, nothing is written. |
| `4832ee395` docs(ebay) | First version of this handoff. |
| `41589cf38` fix(ebay) | Review fixes 1a, 1b, 1c, 4 and 6. |
| `e558d25cb` test(ebay) | Tests for those review fixes. |
| `976bde560` docs(ebay) | The executor header (where notices come from, how they are held). |
| (this file) docs(ebay) | This handoff, updated. |

## Tests

- **Admission** (`ebay-admission-postgres`, 39 tests, +7 from this PR):
  - A signed order notice for seller X lands in X's business, on X's account, whatever the caller's profile. A retry
    from eBay is the same receipt.
  - An unknown seller goes to quarantine as `owner_unknown`. It is encrypted, and an account named like the username is
    not chosen.
  - An inactive business goes to quarantine as `workspace_inactive`.
  - A notice with only a flat `data.userId` goes to quarantine as `subject_or_topic_unresolved`.
  - Three cases (inactive account, `needs_reauth`, `revoked`) go to quarantine as `account_not_connected`, and eBay's
    retry stays there. The same account's revocation is still accepted.
- **Executor** (`ebay-order-processing-postgres`, 20 tests, +7 from this PR, 1 rewritten):
  - The topic is registered for replay but held. A manual replay changes nothing while it is held.
  - A notice for the wrong seller is dead-lettered with no read.
  - If the account is reconnected to another seller during the read, nothing is written.
  - If the stored seller changes during the read, nothing is written.
  - A notice with no seller id is dead-lettered with no read.
  - **Sign-in wait.** At 0 hours and at 5 hours the notice is deferred. At 7 hours it is dead-lettered with the
    Reconnect reason. There is one held call-ledger row per try, and none after the dead letter.
  - **Last attempt.** The 5th attempt ends in a dead letter whose reason does not say "again".
  - **Sweep fairness.** 24 stuck order notices are due on one account. A new revocation and a new order notice from
    another account are both picked in the next run, and both end `done`.
- **Race** (`ebay-order-notice-race-postgres`, new file, 5 tests):
  - The notice runs its whole path: signed admission, routing, claim, read, writer. The poll runs `ingestEbayOrder`.
  - The race is forced. A holder locks the Product rows, and both writers are seen waiting before it lets go.
  - It covers own stock and borrowed pool stock, each with the notice first and with the poll first. A last case runs
    two notices (eBay sends one per line) and two polls at once on a mixed order.
  - Every case ends with one order, each line once and one taking movement per unit. The movement's `actor` shows
    which path won.
  - Both writers are serialized at the account row (review finding 5), so this proves dedupe across the two paths and
    no deadlock. Two writers inside the writer at once is covered by the existing 5-writer test.
- **Unit tests**: the contract fixture parses. Each topic reads its seller only from its own field. Missing or invalid
  seller ids are refused. The `seller_mismatch` reason is checked. The sign-in wait ends exactly at 6 hours and never
  for a rate limit, and the last-attempt reason is checked.

### Mutation checks

Each guard was reverted on its own and the matching tests run. Every one was caught, and the files were restored.

| Mutation | Caught by |
|---|---|
| Identity reads `data.userId` for every topic | unit (6 tests) + admission (4 tests) |
| `routeable` back to revocation only | admission + race |
| `ownerFor` back to revocation only | admission (2 tests) |
| Parser accepts a missing seller | unit (6+ tests) |
| No seller check before the read | executor "before any read" |
| No account seller re-check under the lock | executor "reconnected during the read" |
| No reloaded-receipt seller check | executor "stored seller changed during the read" |
| `ORDER_CONFIRMATION` not registered | executor "registered but held" |
| Manual replay not held | executor "registered but held" |
| Plain reason replaced by the generic one | unit + executor (2 tests) |
| 1a: an order notice is stored on an account that needs Reconnect | admission (3 tests) |
| 1a: only `isActive` is checked | admission (`needs_reauth`, `revoked`) |
| 1a: the sign-in hold is also applied to revocation | admission (several revocation tests) |
| 1b: the sign-in hold never ends | unit + executor "sign-in wait" |
| 1b: the wait is ignored (ends at once) | unit + executor (3 tests) |
| 4: the last attempt keeps the retry text | unit + executor "last attempt" |
| 1c: the sweep goes back to NULLS LAST | executor "sweep fairness" |
| Control: the writer's seen-line dedupe removed (`ebay-order-writer.ts`, temporary) | race (all 5 tests) |

## Checks (local, 2026-10-06, after the review fixes)

| Check | Command | Result |
|---|---|---|
| Typecheck api | `npx tsc --noEmit -p apps/api/tsconfig.json` | pass |
| Gateway ratchet | `cd apps/api && npx tsx scripts/channel-gateway-ratchet.mts --check` | pass (EBAY 0) |
| Ingress directory, profiles OFF | `cd apps/api && DATABASE_URL=…/nexus_development REDIS_URL=redis://127.0.0.1:1 npx vitest run src/services/cx/ingress` | pass: 270 passed. The 16 real-PostgreSQL files skip here and run below. |
| Ingress directory, profiles ON | the same with `NEXUS_WORKSPACES_ENABLED=1` | pass: 270 passed |
| Neighbouring eBay notice/replay tests (10 files), OFF and ON | `npx vitest run` on `inbound-retry-{trust,ebay,deferred}`, `sync-logs-ebay-replay`, `ebay-notification-{setup-gate,status.cx,activation,reconcile}`, `notification-{contract,readiness}` | pass: 146 passed each time |
| Real PostgreSQL (22 suites) | `node scripts/run-real-postgres-tests.mjs --suites '<those 22>'` | pass, 22 of 22. The suites: every ingress suite, revocation, identity, `stock-pool-orders`, the eBay writer, the eBay pool, the executor and the race. Writer 35/35, admission 39/39, executor 20/20, race 5/5. |
| Runner split self-test | `node scripts/run-real-postgres-tests.mjs --self-test` | pass |
| Merge with the newer `origin/main` (f263e1c59) | `git merge-tree --write-tree HEAD origin/main` | clean |

## Open points

1. **Nothing is live.** A notice arrives only after PR B (per-seller subscription) and the Owner's Railway variables
   (Phase 3). Until `NEXUS_ENABLE_EBAY_ORDER_NOTICES=1`, a routed order notice is stored and held.
2. **First real sale.** It must confirm that eBay's `data.user.userId` equals our stored `externalAccountId` (the
   Identity API `userId`). If it does not, notices go to quarantine as `owner_unknown`, and the poll still records the
   order. eBay publishes no sample body for this topic, so this cannot be checked any earlier.
   - Older connections stored the sign-in name as `externalAccountId` (review finding 2). Their notices will always go
     to quarantine; list them in Phase 0.
3. **eBay sends one ORDER_CONFIRMATION per line item**, and another one after a failed payment is paid. A 3-line order
   therefore means 3 order reads, not 1, which revises the plan's §5 cost line. It is still far below the limits.
   The writer records each line once (race test, last case).
4. **Speed.** The minute sweep takes at most 4 eBay notices per business. A burst of many lines is therefore no faster
   than the poll until Phase 4 (process each receipt at once, PR C) ships (review finding 3).
5. **One owner warning per dead letter.** Each dead-lettered notice raises its own owner warning (one per receipt),
   including the sign-in end. An account that stays disconnected for 6 hours with several notices therefore gives
   several warnings, on top of the account's own "needs reconnecting" alert. This was kept on purpose: every dead
   letter has a warning, as on main.
6. **Revocation's retry text unchanged.** On its last attempt, a revocation still says "…must be verified again". The
   last-attempt reason fix (finding 4) covers order notices only.
7. **No owner adoption for order notices.** Owner adoption of quarantined notices (`listOwnEbayQuarantine` /
   `adoptEbayQuarantine`) stays revocation-only. An order notice quarantined as `account_not_connected` or
   `owner_unknown` is not offered, and the poll records that order after Reconnect.
8. **Merge order with the sibling PRs.** PR B and PR C may also edit the suite list in
   `scripts/run-real-postgres-tests.mjs`, so whoever merges second rebases those lines.
9. **Old quarantine rows.** Quarantine rows for `ORDER_CONFIRMATION` now carry a subject hash. A row quarantined
   before this change and re-delivered after it would be refused as `identity_conflict`. There is none, because this
   topic has never been subscribed.
