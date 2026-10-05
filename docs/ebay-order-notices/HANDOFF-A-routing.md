# eBay order notices — PR A: routing (Phase 1)

Branch `feat/ebay-order-notice-routing`, based on `origin/main` 1d207cf19. Not pushed. **Nothing is switched on.**
Plan: `~/nexus-archive/2026-10-06-stock-realtime/GAP2-ebay-order-notifications-plan.md` (Phase 1).

## What it does

An eBay `ORDER_CONFIRMATION` notice is now routed like `AUTHORIZATION_REVOCATION`: to the business that owns the seller
id, and onto that seller's account. Until now it always went to quarantine (`subject_or_topic_unresolved`).

All changes are in `apps/api/src/services/cx/ingress/`, plus the suite list in `scripts/run-real-postgres-tests.mjs`.

| File | Change |
|---|---|
| `ebay-revocation-notice.ts` | `readEbayNoticeIdentity` reads the seller from `data.user.userId` for `ORDER_CONFIRMATION`, as eBay documents it. The account topics keep the flat `data.userId`. There is no fallback between the two shapes, and the username is never used. |
| `ebay-admission.ts` | `routeable` and `ownerFor` accept `ORDER_CONFIRMATION` (`ROUTED_TOPICS`). The owner lookup (`ChannelAccountOwnership`) and `accountFor` are unchanged. An unknown seller, an inactive business or a missing seller id goes to encrypted quarantine. Nothing is guessed. |
| `ebay-order-notice.ts` | The parser returns the seller id and requires it (`seller_missing`). |
| `ebay-order-processing.ts` | Refuses a notice whose seller is not the account's seller (`seller_mismatch`). It is dead-lettered with the plain reason "This eBay order notice is for a different eBay seller than its account. Nothing was changed." The check runs twice: before the order is read, and again in the commit transaction, where the account row is locked. The commit also re-checks the reloaded receipt's seller. The "DORMANT" header is gone. |
| `handlers.ts` | `ORDER_CONFIRMATION` is registered for replay through the same `processEbayInbound`. |
| `ebay-claims.ts` | `queueEbayReplay` refuses (`processing_held`) a manual replay of an order notice while `NEXUS_ENABLE_EBAY_ORDER_NOTICES` is not `1`. The row stays exactly as stored. |
| `__fixtures__/ebay-order-confirmation.json` | The contract fixture. All its ids are fake. eBay's topic page has no sample body for this topic (`"sample": []`), so the fixture follows eBay's AsyncAPI schema field for field (`/develop/api/spec/events/ORDER_CONFIRMATION.yaml`). |

The hold is unchanged. Unless `NEXUS_ENABLE_EBAY_ORDER_NOTICES=1` (in `ebay-processing-policy.ts`), a stored order
notice is never claimed, never dead-lettered and never reset.

## Commits

| Commit | What |
|---|---|
| `9f729ab79` feat(ebay) | The routing, the seller checks, the replay registration and hold, the contract fixture, and the unit tests. |
| `0db5cdf55` test(ebay) | Admission and executor cases on real PostgreSQL, the notice-vs-poll race suite, and the runner suite list. |
| `a7a904265` test(ebay) | If a stored notice's seller changes during the read, nothing is written. |
| (this file) docs(ebay) | This handoff. |

## Tests added

- **Admission** (`ebay-admission-postgres`, +4 tests):
  - A signed order notice for seller X lands in X's business, on X's account, whatever the caller's profile. A retry
    from eBay is the same receipt.
  - An unknown seller goes to quarantine as `owner_unknown`. It is encrypted, and an account named like the username is
    not chosen.
  - An inactive business goes to quarantine as `workspace_inactive`.
  - A notice with only a flat `data.userId` goes to quarantine as `subject_or_topic_unresolved`.
- **Executor** (`ebay-order-processing-postgres`, +4 tests, 1 rewritten):
  - The topic is registered for replay but held. A manual replay changes nothing while it is held.
  - A notice for the wrong seller is dead-lettered with no read.
  - If the account is reconnected to another seller during the read, nothing is written.
  - If the stored seller changes during the read, nothing is written.
  - A notice with no seller id is dead-lettered with no read.
- **Race** (`ebay-order-notice-race-postgres`, new file, 5 tests):
  - The notice runs its whole path: signed admission, routing, claim, read, writer. The poll runs `ingestEbayOrder`.
  - The race is forced. A holder locks the Product rows, and both writers are seen waiting before it lets go.
  - It covers own stock and borrowed pool stock, each with the notice first and with the poll first. A last case runs
    two notices (eBay sends one per line) and two polls at once on a mixed order.
  - Every case ends with one order, each line once and one taking movement per unit. The movement's `actor` shows
    which path won.
- **Unit tests**: the contract fixture parses. Each topic reads its seller only from its own field. Missing or invalid
  seller ids are refused. The `seller_mismatch` reason is checked.

### Mutation checks

Each new guard was reverted on its own and the matching tests run. Every one was caught, and the files were restored.

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
| Control: the writer's seen-line dedupe removed (`ebay-order-writer.ts`, temporary) | race (all 5 tests) |

## Checks (local, 2026-10-06)

| Check | Command | Result |
|---|---|---|
| Typecheck api | `npx tsc --noEmit -p apps/api/tsconfig.json` | pass |
| Gateway ratchet | `cd apps/api && npx tsx scripts/channel-gateway-ratchet.mts --check` | pass (EBAY 0) |
| Ingress directory, profiles OFF | `cd apps/api && DATABASE_URL=…/nexus_development REDIS_URL=redis://127.0.0.1:1 npx vitest run src/services/cx/ingress` | pass: 268 passed. The 16 real-PostgreSQL files skip here and run below. |
| Ingress directory, profiles ON | the same with `NEXUS_WORKSPACES_ENABLED=1` | pass: 268 passed |
| Neighbouring eBay notice/replay tests, OFF and ON | `npx vitest run` on `inbound-retry-{trust,ebay,deferred}`, `sync-logs-ebay-replay`, `ebay-notification-{setup-gate,status.cx}`, `ebay-notification-activation`, `notification-{contract,readiness}` | pass: 139 passed each time |
| Real PostgreSQL: every ingress suite, plus the revocation, identity, eBay writer and pool suites (21 suites) | `node scripts/run-real-postgres-tests.mjs --suites '<those 21>'` | 20 of 21 pass, including admission 36, executor 17 and race 5. **`ebay-order-writer-postgres` ✗: it has 35 tests but the runner expects 32.** That count was not updated when #340 added 3 tests. This branch does not touch that file. |
| Runner split self-test | `node scripts/run-real-postgres-tests.mjs --self-test` | pass |
| Merge with the newer `origin/main` (f263e1c59) | `git merge-tree --write-tree HEAD origin/main` | clean |

## Open points

1. **Nothing is live.** A notice arrives only after PR B (per-seller subscription) and the Owner's Railway variables
   (Phase 3). Until `NEXUS_ENABLE_EBAY_ORDER_NOTICES=1`, a routed order notice is stored and held.
2. **First real sale.** It must confirm that eBay's `data.user.userId` equals our stored `externalAccountId` (the
   Identity API `userId`). If it does not, notices go to quarantine as `owner_unknown`, and the poll still records the
   order. eBay publishes no sample body for this topic, so this cannot be checked any earlier.
3. **eBay sends one ORDER_CONFIRMATION per line item**, and another one after a failed payment is paid. A 3-line order
   therefore means 3 order reads, not 1, which revises the plan's §5 cost line. It is still far below the limits.
   The writer records each line once (race test, last case).
4. **Lock order.** The notice's commit holds the account row `FOR UPDATE` (through `lockOwnedEbayAccount`, as for
   revocation). A poll write on the same account therefore waits for it, and the reverse also holds. Notice and poll
   are serialized per account. The forced races found no deadlock.
5. **No owner adoption for order notices.** Owner adoption of quarantined notices (`listOwnEbayQuarantine` /
   `adoptEbayQuarantine`) stays revocation-only, so a quarantined order notice is not offered. The poll records that
   order.
6. **Pre-existing, not fixed here.** `scripts/run-real-postgres-tests.mjs` expects 32 for `ebay-order-writer-postgres`
   but the file has 35 tests. A full runner pass reports that suite ✗ until someone updates the number.
7. **Merge order with the sibling PRs.** PR B and PR C may also edit the suite list in
   `scripts/run-real-postgres-tests.mjs`, so whoever merges second rebases those lines.
8. **Old quarantine rows.** Quarantine rows for `ORDER_CONFIRMATION` now carry a subject hash. A row quarantined
   before this change and re-delivered after it would be refused as `identity_conflict`. There is none, because this
   topic has never been subscribed.
