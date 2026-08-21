# SG — the Suggestions queue, rebuilt (2026-08-21)

Build record for `/marketing/ads/suggestions`. Shipped in `954ffd0e5` (SG.0–SG.5 + SG.7) and the
SG.6 commit that follows it. Plan: `~/.claude/plans/memoized-leaping-frost.md`. Video study:
`docs/2026-08-21-sg-video-study.md`. Consistency handoff: `docs/2026-08-21-sg7-view-consistency-handoff.md`.

## Why

The manual review queue is where every rule on Manual control parks its proposed action. It was
measured **dead**: 293 pending · **1 applied ever** · 0 dismissed · oldest pending row 50+ days ·
and three different surfaces (this page, Automations › Queue, the parked HvQueue) rendering the
same endpoint with three different mental models.

Four wiring defects explain most of the death, and each is fixed here:

1. **A refused apply was marked `applied`.** The route wrote `status:'applied'` on handler
   `ok === false`, so a gate-denied write looked successful and left the queue. An operator who
   approved something and saw nothing happen had no way to learn why.
2. **An apply returns at ENQUEUE, not at Amazon.** Bid/budget/status writes land locally and are
   queued; the write gate runs later in `ads-sync.worker`. `SKIPPED / WRITE_GATE_DENIED` arrived
   minutes afterwards, in a place the page never looked. `appliedResult.ok` is not delivery.
3. **Negative applies defaulted to CAMPAIGN scope** — measured **0 of 20 ever landed**, against
   99% at ad-group scope.
4. **Change-log attribution:** writes carry actor `automation:<ruleId>` but `parseActor` expected
   `automation:rule-<id>`, so operator-approved applies rendered as anonymous "job" rows.

## What shipped

### SG.0 — server truth
`ads-suggestions.service.ts` · `advertising.routes.ts` · `automation-action-handlers.ts` ·
`ads-changes.service.ts` · `ads-proposal-pricing.service.ts` · `ads-cursors.service.ts`

- **Honest apply**: a refusal keeps the row `pending` and returns the gate's own sentence.
- **`POST /suggestions/bulk`** with an `ops[{id,kind,value?,resultBidCents?,resultBudgetEur?}]`
  grammar — per-row outcomes, halt-checked, concurrency 3.
- **`GET /suggestions/cursor`** — a **membership** fingerprint (ids + per-status counts), never a
  payload hash: the upsert refreshes `proposedAction` on every evaluator tick, so a payload hash
  would be a metronome (see `reference_cursor_fields_are_metronomes`).
- **Lifecycle**: additive `lastSeenAt`, stamped on every upsert (create *and* refresh);
  `sweepSuggestionLifecycle()` rides the evaluator tick — pending rows the engine stops
  re-proposing expire (3d engine / 2× schedule for builder rules); expired rows re-propose
  immediately, operator-dismissed rows after 7 days. `createdAt` stays the FIRST sighting.
- **ONE family map** (`familyOf`/`familyOfRow`), exported and used by both the list and the count,
  so the tabs and the grid can never disagree.
- Negatives default **AD_GROUP** and fail closed when no ad group is resolvable; `parseActor`
  learns the bare-cuid rule actor (read-side only — the written actor string is unchanged because
  write-cap counting keys on it).

### SG.1 / SG.2 — the page
H10's page-level tab bar (DS `Tabs` gained `count`/`badge`/`icon`/`size:'lg'`, additively), **one**
filter bar with scope resolved server-side, per-family column sets to the operator's own lists, and
the **staging buffer** taken from the reference: ✓ stages an accept and fills an editable value
(↺ revert, amber when edited), ✕ stages a removal — *"Remove suggestion until a new one is
generated"* — and one **[Apply N Changes]** commits the batch. Pending rows carry **no checkbox
column**: the verbs are the selection. `AdsDataGrid` gained `freezeRight` so the decision verbs stay
reachable however wide the metric set gets.

Evidence on every row: 30-day metrics (`EXCLUDE_AMS_DAILY`), live current bid/budget, the rule's own
criteria in words, its lookback window from the engine's own table, search volume where Brand
Analytics covers the term. **Null is never 0** — an unmeasured cell dashes and says why.

### SG.3 — the Applied tab tells the truth
`attachDeliveryData()` joins each applied row to `OutboundSyncQueue` (or a create's own receipt) and
renders **delivered · pending · refused · failed**, with `unknown` for legacy rows rather than a
confident success. Refusals appear in the gate's own words. Undo is keyed on the
`AdvertisingActionLog` id — never the change feed's `h:`/`a:` display ids — is two-step, warns when
a change set reverses grouped rows together, and **declines with the rollback service's own reason**
when the change is outside its window. Where no log row exists the column says *"No undo is offered
for this row here"*, which is a different claim from "this cannot be undone".

`conditionsTextOf` learned the builder's nested condition shape on the way: the first
builder-authored rule to reach the queue printed **"? ? undefined"** as its Reason on every row.

### SG.4 / SG.7 — A.I. Bids and Recommendations
The A.I. tab reads `AutopilotDecision` PROPOSED (excluding the `rule-setting` mirrors, which are the
same rule rows). It is **read-only by design** — no decision approve/dismiss route exists, so the
grid says so instead of rendering verbs that cannot act. The Recommendations feed folds in as the
7th tab; `/marketing/ads/recommendations` redirects, its nav row is gone, `RecommendationsClient` is
parked. SG.7 put both views on the family anatomy (tabs → filter bar → grid) after the operator
found them inconsistent; the four top strips were removed by operator decision and
`AccountPlanPanel` was parked.

### SG.5 — Bid Settings
A shared `AdsBidSettingsModal`, mapped to **real** enforcement rather than a settings store:
market bid limits (`AdBidPolicy` — the write gate refuses out-of-band writes and names the policy),
an **enforce-maximum** sweep that clamps pending bid suggestions above their market ceiling, and a
**default ACoS target** (`AdsAutomationState.defaultTargetAcosPct`, INTEGER percent) whose copy
names its ONE reader: `bid_apply`'s target-ACoS ops, as fallback when the rule carries no target.

### SG.6 — one inbox
Automations › Queue keeps its count and links out; `QueueView` is ⛔ PARKED
(`docs/2026-08-16-ra-parked-sections.md`). The same endpoint rendered twice, with only one of the
two able to explain what happened after an approval, was the third mental model this rebuild exists
to retire.

## Two shared-path defects found on the way

- **The family grids never received their filter DEFINITIONS.** `AdsFilterBar` holds state;
  `AdsDataGrid` needs `filters` to act on it (`if (!filters?.length) return rows`). Since the
  filter-bar merge, the Rule select and every metric range on these views had silently filtered
  **nothing**. `BidClient` is the reference wiring: the bar *and* the grid get the definitions.
- **A range filter let NaN rows pass.** NaN compares false both ways, so an unmeasured row slipped
  through a set range while every consumer's tip promised exclusion. Fixed in the shared grid,
  toward the contract those tips already stated.

## Verification

Local-first throughout (operator's instruction): every unit built and clicked against real prod data
on `localhost:3000` before the single batch commit. `tsc` both apps and the ratchets
(button-vocabulary 286, silent-disabled 27, help-cursor 0, DS-conformance, tokens) green at every
step; 83 API tests across the suggestion suites, including new lifecycle, delivery and
conditions-text suites.

Migrations `20260821b` (lastSeenAt) and `20260821c` (defaultTargetAcosPct) are additive and were
applied to prod ahead of the deploy via `prisma db execute` + `migrate resolve --applied` — never
`migrate deploy`, which would have dragged in another session's gated migration.

## Deliberately not done

- Arming any engine. Harvest stays disarmed; `NEXUS_BID_OPTIMIZER_SOURCE` stays unset.
- The bid-algorithm picker's executor (⛔ KEEP placeholder — the operator is building the backing
  field).
- Approve/dismiss verbs on A.I. Bids, until an autopilot decision route exists to honour them.
