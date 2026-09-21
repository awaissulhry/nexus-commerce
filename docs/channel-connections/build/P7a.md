# P7a — the clean-up deletions, measured

**Package:** P7a. **State:** MEASURED. **Deletions performed: none, and that is the finding.**

Plan row (FINAL-PLAN §6, P7): *"Remove: the ghost engines, WooCommerce, the old eBay routes,
`oauth-state.ts`, the old Ads fallback."* The handover's instruction was **"measure each one has
no caller first"** — the method P1.6 used to delete 26 files safely.

Doing that produced the opposite answer. **Every remaining target is either already deleted or
alive.**

## 1. 🔴🔴 First, the instrument is broken — and it is the one P1.6 relied on

Railway's `http-requests` tool **ignores `filterPath` and `startDate`.** Measured, with controls:

| query | `filterPath` | total |
|---|---|---|
| no filter | — | **758** |
| a real, busy path | `/api/health` | **759** |
| a route under test | `/api/inbound/sync-catalog` | **762** |
| 🔴 **a path that cannot exist** | `/api/this-path-cannot-possibly-exist-xyzzy` | **757** |

All four are the same number: the full service total for the last hour. Every call also reported
`"window":{"hoursBack":1}` whatever `startDate` was set to.

**So this session cannot answer "does this route have traffic", and no `0` from that tool means
anything.** Had only the first query been run, `/api/inbound/sync-catalog` would have read as a
route serving 762 requests an hour. Had the numbers come back zero, every route in the repo would
have read as dead.

The impossible path is what settled it — the banked rule in the most literal form: *a control must
target the LAYER and the BRANCH, and an unwitnessed zero neither passes nor convicts.*

⚠️ **This does not convict P1.6.** Its record quotes a service total of 125,844 **and** per-path
zeroes in the same window, which this tool cannot produce, so it either worked then or used
something else. But **its traffic evidence cannot be reproduced today**, and any future session
re-deriving a delete list must find another instrument. `get-logs`'s `filter` **does** work
(verified: `ads` returns real ads activity, `ADS-LIVE` returns nothing, on the same deployment).

## 2. The census — code only, since traffic cannot be measured

### Already gone (P1.6, 2026-09-20). Nothing to do.

| target | evidence |
|---|---|
| `lib/auth/oauth-state.ts` | no file in `src`; only stale `dist/` artefacts remain |
| E1 `unified-sync-orchestrator.ts`, E2 `product-sync.service.ts`, E3 `sync/index.ts` | no files |
| WooCommerce **implementation** (5 files + cron line + tracking branch + 2 tests) | no files. The `WOOCOMMERCE` **enum value** stays — that is P7b and needs its own yes |

### 🔴 Alive. Every one is registered or on a live import chain.

| # | target | measured state |
|---|---|---|
| E6 | `services/inbound-sync.service.ts` | `routes/inbound.routes.ts` imports `syncAmazonEUCatalog`, and **`index.ts:715` registers that router** (`POST /api/inbound/sync-catalog`, `GET /api/inbound/sync-status`) |
| E13 | `services/outbound-sync-phase9.service.ts` | imported by E14, which is imported by `workers/bullmq-sync.worker.ts`. **A live chain**, not an orphan |
| E14 | `services/variation-sync-processor.service.ts` | `workers/bullmq-sync.worker.ts:16` imports `variationSyncProcessor` |
| E16 | `workers/channel-sync.worker.ts` | **`index.ts:487` starts it**, and `routes/catalog.routes.ts:1925` **enqueues to it** (`channelSyncQueue.add('channel-sync', …)`). Producer *and* consumer, both live |
| E17 | `routes/channel-publish.routes.ts` + `services/channel-publish.service.ts` | **`index.ts:776` registers it** at `/api` — six routes. The service has exactly one importer: that router |
| — | the eBay route files | **all 11 non-test files are referenced in `index.ts`.** None is an "old, unregistered" route |

🔴 **Deleting E16 would be worse than leaving it.** Its producer is a live catalog route. Removing
the worker alone leaves jobs accumulating in Redis with nothing to drain them — the banked rule
*producer and consumer land together*, in the direction people forget.

### 🟡 One genuine candidate, and it is not being taken unilaterally

**The old Ads fallback** — `resolveCredentials` in `services/advertising/ads-api-client.ts:469`,
which reads `AmazonAdsConnection.credentialsEncrypted`.

Two independent signals say it is not reached in production:

1. **Code**: `liveCall` (line 580) branches on `process.env.NEXUS_WORKSPACES_ENABLED === '1'`. The
   `if` uses the connection resolver and the token service; **`resolveCredentials` is only in the
   `else`**. FINAL-PLAN §14.4 records production as `NEXUS_WORKSPACES_ENABLED=1`.
2. **Logs**: `[ADS-LIVE] credential source` — which *every* path through `resolveCredentials`
   emits, either `'core'` or `'row'` — returns **0 lines** on the running deployment, while the
   control filter `ads` returns live ads writes on the same deployment (822 keyword writes applied).

**It is still not deleted here.** The hole is named rather than papered over: **Railway variable
reads are refused for this session**, so `NEXUS_WORKSPACES_ENABLED=1` is a **2026-09-19 reading
that its own record says to re-read**. "Unreachable under a configuration I cannot read" is not
"has no caller", and this path is the credential source for the **live money path**. The log
evidence is also weak on its own: `logCredentialSource` fires **once per source per process**, so
absence over one deployment's life is a much smaller claim than it looks.

**What closes it:** one read of `NEXUS_WORKSPACES_ENABLED` on the production deploy. If it is `1`,
the `else` branch is dead and can go with its test.

## 3. 🔴 `RESEARCH.md` A5 §1.1 is stale, and it is the document P7a is written from

The plan's phrase "the ghost engines" points at that list. Every claim in it was checked:

| RESEARCH says | measured today |
|---|---|
| E1, E2, E3 "dead" | **true, and already deleted** |
| E6 "broken" | **registered and reachable** |
| E13 "mostly dead" | **on a live import chain** |
| E14 "has no producer" | **has one**: `workers/bullmq-sync.worker.ts` |
| E16 "harmful: its `noop` guard never matches, so it writes IN_SYNC/SUCCESS" | 🟢 **already fixed** — `channel-sync.worker.ts:202` now carries the opposite rule and a comment naming the silent bug it replaced |
| E17 "sandbox-only; the live branch returns 'not yet wired'" | registered at `/api`; the behaviour was not re-checked, because it is registered either way |
| E7 "catalog status endpoint: always 404" | **no such symbol in the tree** |

Banked, and earned again: *a doc can describe code that never shipped* — and its mirror, **a doc
can describe code that has since been fixed**. A delete list derived from A5 §1.1 without
re-measuring would have removed a registered router, a started worker with a live producer, and an
engine whose named defect no longer exists.

## 4. Verdict

**P7a, as the plan words it, is already complete.** P1.6 did the half that was safe, and the named
remainder is alive. The honest deliverable is this measurement, not a deletion.

Three things follow, none of which this session should decide alone:

1. 🟡 **The Ads fallback** — one variable read closes it (§2). The smallest real win available.
2. 🔴 **E16 `channel-sync` deserves its own look, as a defect and not as clean-up.** It is live, it
   has a live producer in a catalog route, and `channel-sync.worker.ts:124` still builds
   `` `${targetChannel}_US` `` with the comment *"Default to US region"* — the `_US` half of
   RESEARCH's complaint, on a worker that writes `ChannelListing` rows. That is a **P4-shaped**
   question (does a fake `_US` coordinate still get created?), not a P7 one.
3. 🔴 **`RESEARCH.md` A5 §1.1 should be marked stale** where it is wrong, so the next session
   reading "the ghost engines" does not start from the same wrong map.

**Nothing in P7b changes.** Every destructive DROP still needs its own yes after a green week, and
`AmazonAdsConnection` is still the live money path with 25+ readers — the note in §0 of PROGRESS
stands, and CX.3c is still the package that would make that drop a candidate.
