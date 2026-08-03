# HX — Ads history & audit: what exists, what's broken, and the one spine that fixes it

**Status:** PROPOSAL AWAITING GATE · 2026-08-03
**Surface:** `/marketing/ads` (the live console)
**Related:** `docs/2026-08-02-rank-dayparting-excellence-rdx.md` (RDX A1–C1, built locally, unpushed)

**Working rules unchanged:** nothing implemented without a gate · everything stays local until you say push · the builder's "Your rank goal & schedule" section is untouchable.

> **Read §3 first if you read nothing else.** Auditing this turned up nine defects, and three of them mean the RDX/A2 + A4 work I already built is partly **blind** — it can report a schedule as healthy while its main action is failing. That has to be corrected as part of this, not after it.

---

## Part 1 — Every "what changed" surface that exists today

| # | Surface | Route / component | Reads | State |
|---|---|---|---|---|
| 1 | **Change Log (Amazon)** | `/marketing/ads/changelog` | — | **STUB.** Renders "This screen is being rebuilt to match Adtomic." |
| 2 | **Change Log (eBay)** | `/marketing/ads/ebay/change-log` | eBay `/actions` | **Complete** (ER3.4): filter by change type *and* source, deep links, cursor pagination |
| 3 | **Events** | `/marketing/advertising/events` | `AdvertisingActionLog` via `listEvents` | Real — but on the **legacy** tree H1 plans to delete |
| 4 | **Activity** | `/marketing/ads-console/activity` | `AutomationRuleExecution` + SSE | Real — also on a **legacy** tree |
| 5 | **Rule execution history** | `RuleListTab` → `HistoryDrawer` | `/automation-rule-executions?ruleId=` | Real, current console, per-rule only |
| 6 | **Campaign history** | `GET /advertising/campaigns/:id/history` | `CampaignBidHistory` | Endpoint only — **no web consumer** |
| 7 | **Bid history (raw)** | `GET /advertising/bid-history` | `CampaignBidHistory` | Consumed only by **legacy** pages |
| 8 | **Schedule activity** | RDX/A4 drawer | `CampaignBidHistory` ⨝ `AdMutation` | Built locally, unpushed — **and blind, see §3** |
| 9 | **Budget pool history** | `GET /advertising/budget-pools/:id/history` | pool-specific | Real, narrow |
| 10 | **Replicate history** | `campaign-builder/replicate/HistoryPanel` | blueprint applications | Real, narrow |

**The shape of the problem:** the current Amazon console has **no account-wide "what changed" view at all**. The two that work (#3, #4) live on legacy trees scheduled for deletion, and the slot meant to replace them (#1) is a stub. eBay — the smaller channel — has the better audit surface.

---

## Part 2 — How writes are actually recorded

Four tables, written by different paths, with no unified read:

| Table | Grain | Written by |
|---|---|---|
| `AdvertisingActionLog` | one operation, before/after JSON, rollback anchor | `writeAdvertisingActionLog` (mutation path) **and** the local `audit()` helper in `ads-create.service.ts:30` |
| `CampaignBidHistory` | one field change (old → new), actor, reason | `writeBidHistory`, `ads-mutation.service.ts:485` |
| `AdMutation` | one intended field change + **delivery state** (PENDING/IN_FLIGHT/APPLIED/FAILED, attempts, lastError) | `ads-mutation.service.ts:197` |
| `AutomationRuleExecution` | one rule firing | the rule evaluator |

### 2.1 What rank-defend does, and where each action lands

This is the crux. `decideAndMaybeApply` has six write paths:

| Action | Call site | `CampaignBidHistory` | `AdMutation` | `AdvertisingActionLog` | Actor recorded |
|---|---|---|---|---|---|
| **Placement bias** — *the main one* | `ad-rank-defend.job.ts:281` → `setSearchPlacement` → `updatePlacementBidding` | ❌ | ❌ | ✅ | ❌ **null** |
| Bid suppression | `:215` `suppressCampaignBids({actor})` | ✅ | ✅ | ✅ | ✅ |
| Bid restore | `:223` `restoreCampaignBids({actor})` | ✅ | ✅ | ✅ | ✅ |
| Campaign resume | `:227` `updateCampaignWithSync({actor})` | ✅ | ✅ | ✅ | ✅ |
| Base bid absolute | `:186` `updateAdGroupWithSync({actor})` | ✅ | ✅ | ✅ | ✅ |
| Base bid delta | `:191` `applyBaseBidDelta({actor})` | ✅ | ✅ | ✅ | ✅ |

Five of six go through the mutation spine and are fully recorded. **The sixth — placement bias, which is what "hold a rank" physically means — bypasses it entirely.** `updatePlacementBidding` (`ads-create.service.ts:642`) pushes to Amazon **inline** rather than through the queued worker, so no `AdMutation` row is created, no `CampaignBidHistory` row is written, and its own comment acknowledges the consequence: *"placement writes go inline (not via the queued+stamped worker path), so a failed push to Amazon was previously invisible AND unrecoverable."*

---

## Part 3 — Defects found

### Correctness of the audit trail

**HX-D1 — Placement writes bypass the audit spine.** No `CampaignBidHistory`, no `AdMutation`. The dominant action of the entire rank system is absent from both tables every other surface reads.
*Evidence:* `ads-create.service.ts:642-679`.

**HX-D2 — Placement writes record no actor.** `setSearchPlacement(campaignId, placement, percentage)` takes no `userId` and forwards none, so `updatePlacementBidding` calls `audit(..., input.userId /* undefined */, ...)` and the row stores `userId: null`. **You cannot attribute a placement change to a schedule, a family plan, or a human.**
*Evidence:* `ads-top-of-search.service.ts:134-140`; `ads-create.service.ts:30-34`.

**HX-D3 — Placement writes are always logged SUCCESS.** The `audit()` helper hardcodes `amazonResponseStatus: 'SUCCESS'`. `updatePlacementBidding` separately computes `syncStamp.lastSyncStatus = 'FAILED'` on a failed push — and logs SUCCESS anyway.
*Evidence:* `ads-create.service.ts:32` vs `:668-672`.

**HX-D4 — Automation is labelled "Operator" in the events log.** `listEvents` derives `source: r.executionId ? 'Automation' : r.userId ? 'Operator' : 'System'`, but `writeAdvertisingActionLog` deliberately stores the actor string in `userId` ("to unify human + automation writes under one column"). So every automation write — `automation:rank-defend-…`, `automation:rank-plan-…` — reads as a **human action**.
*Evidence:* `ads-events.service.ts` `listEvents`; `ads-mutation.service.ts:86-100`.

### Consequences for RDX (already built, unpushed)

**HX-D5 — The A4 activity drawer is blind to the main action.** It filters `CampaignBidHistory` by `changedBy IN (automation:rank-defend-<AdSchedule.id>)`. Placement moves never write that table (D1), so the drawer shows only suppression / restore / base-bid events. A schedule that is doing its job perfectly renders as **"No changes recorded yet."**

**HX-D6 — A2 `failedWrites` is structurally zero for placement pushes.** It counts `AdMutation` rows with `state: 'FAILED'`. Placement writes create no `AdMutation` rows (D1), so a schedule whose every placement push is failing reports `failedWrites: 0` → **Health renders "OK"**. That is the exact false-green A3 was built to eliminate, reintroduced one layer down.

**HX-D7 — A2 `lastApplied` is honest but incomplete.** A1's receipts are correct (they record what the loop *resolved*), but "resolved own-top" is not evidence that Amazon *took* the change. Without D1/D3 fixed, "Now holding" is an intention, not an outcome — and nothing on the page distinguishes the two.

### Product gaps

**HX-D8 — The Amazon Change Log is a stub while eBay's is complete**, and the sidebar maps `changelog → ebay/change-log`. The smaller channel has the better audit surface.

**HX-D9 — Undo is decorative.** `/advertising/campaigns/:id/history` returns `undoable` and `isUndo` per row, computed carefully (AD_TARGET bid, within 24h, old value present). **There is no undo endpoint and no web consumer.** The only rollback routes are `blueprint-applications/:id/rollback` and `bulk/import/:id/rollback`.

---

## Part 4 — The design: one spine, one read model, four views

The failure mode here is four tables and ten surfaces, each picking a different subset. The fix is not an eleventh surface.

### 4.1 One write spine

Every ads write records the same five facts: **who** (actor), **what** (entity + field), **before → after**, **delivery** (queued / applied / failed + error), **why** (reason).

Five of six rank-defend paths already do this. The work is bringing placement writes onto it:

- `setSearchPlacement` gains an `actor` + `reason` and forwards them.
- `updatePlacementBidding` writes `CampaignBidHistory` (field `placementBidding`, old → new as the compact adjustment set) and records the **real** outcome rather than an unconditional SUCCESS.
- Because placement pushes are inline, delivery state comes from the push result itself, not `AdMutation` — so the read model must treat "inline write with a recorded outcome" as a first-class delivery source alongside the queued path.

No schema migration: `CampaignBidHistory` already has `entityType/entityId/field/oldValue/newValue/changedBy/reason`, and `AdvertisingActionLog` already has `amazonResponseStatus`.

### 4.2 One read model

A single endpoint — `GET /advertising/changes` — unifying `AdvertisingActionLog` ⨝ `CampaignBidHistory` ⨝ `AdMutation`, returning one row shape:

```
{ id, at, actor, source: 'automation'|'operator'|'system', origin: {kind:'schedule'|'plan'|'rule'|'manual'|'import', id, name},
  entity: {type, id, name}, field, oldValue, newValue, reason,
  delivery: {state, attempts, lastError} | null, undoable }
```

with filters for entity, source, origin, field, date range and delivery state. `source` is derived from the **actor string prefix**, not from which column happens to be populated — that is D4's root cause.

`origin` is what makes this worth building: it resolves `automation:rank-defend-<AdSchedule.id>` back to the schedule's **name**, so a change reads *"IT AIREON raised Top-of-Search bias 100% → 115%"* rather than an opaque cuid.

### 4.3 Four views, one component

| View | Scope | Fills |
|---|---|---|
| **Account Change Log** | everything, filterable | the stub at `/marketing/ads/changelog` (D8) — and replaces the legacy Events + Activity pages, unblocking H1 |
| **Campaign History tab** | one campaign | the orphaned endpoint (#6) |
| **Schedule Activity drawer** | one rank schedule | RDX/A4, re-pointed at the unified read (fixes D5) |
| **Rule execution history** | one rule | existing drawer, aligned to the same row shape |

All four render the same row component with different pre-set filters, so a change means one thing everywhere — matching how eBay's change log already works, and how B3 reuses the builder's grid model rather than copying it.

---

## Part 5 — Phases

> **HX.1 · HX.2 · HX.3 — BUILT LOCALLY 2026-08-03, not committed, not pushed.** Gated decision: folded into the RDX stack as corrections, so RDX/A2 + A4 are no longer blind before anything ships. Scope grew by one deliberate step — see §5.1.

### 5.1 What actually landed

| File | Change |
|---|---|
| `ads-create.service.ts` | `audit()` takes a real `status` (was hardcoded `SUCCESS`) · `PlacementBiddingInput` gains `actor` + `reason` · `updatePlacementBidding` writes `CampaignBidHistory` **one row per changed placement**, records the true outcome, and returns `ok:false` on a failed push |
| `ads-top-of-search.service.ts` | `setSearchPlacement` / `applyPlacementBias` / `applyTopOfSearch` take and forward `{actor, reason}`; the auto-apply sweep attributes itself `automation:tos-optimizer` |
| `ad-rank-defend.job.ts` | both placement write paths (blended + legacy single) pass `ctx.actor` and a reason; the blend reason is computed **before** the write so the audit row carries it |
| `ads-write-reconcile.service.ts` | re-pushes attributed `automation:ads-write-reconcile` |
| `rollback.service.ts` | reversals attributed to the operator, reason prefixed `Undo:` — the marker `/campaigns/:id/history` already uses |
| `automation-action-handlers.ts` | both rule placement actions attributed `automation:rule-<ruleId>` |
| `autopilot/apply.ts` | attributed `automation:autopilot` |
| `advertising.routes.ts` | A2 `failedWrites` counts **both** delivery paths · A4 activity joins inline outcomes so placement rows show a real state |
| `ScheduleActivityDrawer.tsx` | labels + `%` formatting for the `PLACEMENT_*` fields it now receives |

**Scope grew on purpose.** The phase as written said "rank-defend passes its actor through". But six other call sites also wrote placement bias unattributed — reconcile, rollback, two rule actions, autopilot, the TOS optimizer. Fixing only rank-defend would have left the change log full of anonymous rows and defeated the point, so all of them now carry an actor. **Zero unattributed placement writes remain in the codebase.**

**One behavioural change worth knowing:** `updatePlacementBidding` used to return `ok: true` unconditionally. It now returns `ok: false` when the Amazon push failed — so `ads-write-reconcile` stops counting failed re-pushes as successes, `rollback` correctly reports a failed restore, and rule actions report `ok:false`. Strictly a correctness fix, but it changes what those three report.

**Verified:** `tsc` clean both apps · **3378 API tests pass (263 files)** · 532 web tests pass. (8 web *files* fail to collect under an unfiltered `vitest run` — they are Playwright specs, pre-existing and unrelated.)

**Not verified:** the end-to-end trail on live data. Nothing can be, until this deploys and the cron ticks — the whole point is that the rows don't exist yet.

### 5.2 The full phase list

Each separately gated, built locally, committed only on your word.

| # | Phase | What lands | Risk |
|---|---|---|---|
| **HX.1** | **Actor + truthful outcome on placement writes** | `setSearchPlacement`/`updatePlacementBidding` take an actor and reason; `audit()` stops hardcoding SUCCESS; rank-defend passes its actor through. Fixes **D2, D3**. No schema change. | low, touches the live write path |
| **HX.2** | **Placement writes join the audit spine** | `updatePlacementBidding` writes `CampaignBidHistory` with before/after. Fixes **D1** — and with it **D5** (the drawer starts showing the main action). | low |
| **HX.3** | **Health reads real delivery** | A2's `failedWrites` counts inline placement failures (via the recorded outcome) as well as `AdMutation` FAILED. Fixes **D6/D7**: "Now holding" gains an *applied vs intended* distinction. | low |
| **HX.4** | **`GET /advertising/changes`** | The unified read model + `origin` resolution. Fixes **D4** (source from the actor prefix). | medium |
| **HX.5** | **Account Change Log page** | Fills the `/marketing/ads/changelog` stub on `AdsDataGrid`, filters matching eBay's (type + source + date + status). Fixes **D8**. | medium |
| **HX.6** | **Re-point the three existing views** | Schedule drawer, campaign History tab, rule history → one row component. Retires `bid-history` as a UI source. | medium |
| **HX.7** | **Undo, for real** | An undo endpoint behind the `undoable` flag the API already computes, scoped to what is safely invertible (AD_TARGET bid within 24h) + a confirm. Fixes **D9**. **Writes to Amazon — own hard gate.** | **high** |

**Recommended order:** HX.1 → HX.2 → HX.3 → HX.4 → HX.5 → HX.6, then HX.7 as a separate decision.

Rationale: HX.1–HX.3 are small, they correct defects in work that is *already built but not pushed*, and they must land before RDX/A2–A4 go to prod — otherwise the page ships a Health column that reads OK while placement writes fail. HX.4–HX.6 are the product. HX.7 writes to Amazon and deserves its own conversation.

### Relationship to RDX

RDX/A2 and A4 should **not be pushed as they stand.** They are correct in structure and wrong in coverage: they read tables the main action never writes to. HX.1–HX.3 make them true. Everything else already built — A1 receipts, A3 columns, B1 market, B2 row actions, B3 week shape, C1 coverage — is unaffected.

---

## Part 6 — Open questions

1. **Scope.** Fold HX.1–HX.3 into the RDX stack as corrections before pushing, or run HX as its own engagement?
2. **HX.7 undo.** Worth building, or leave the `undoable` flag unused and remove it from the payload?
3. **Legacy retirement.** HX.5 is the precondition for H1 (deleting the legacy trees) — that is the only place the working Amazon events UI lives today. Confirm that sequencing.
4. **eBay parity.** Should the account Change Log show **both** channels behind a filter, or stay Amazon-only alongside the existing eBay page?
