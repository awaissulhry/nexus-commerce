# ADX A2 → reporting handoff

**Date:** 2026-08-04 · **For:** the reporting & analytics workstream
**Status of the write side:** built locally, not committed, migration not applied.

ADX A2 instruments the *write* side of advertising: every ads write now records who caused it and, increasingly, **why**. The *surfacing* of that belongs to reporting, so this note is the requirement rather than an implementation.

---

## 1. What now exists to read

### `AdvertisingActionLog.userId` — the actor, now complete
Carries `automation:rank-defend-<AdSchedule.id>`, `automation:tos-optimizer`, `user:<id>`, or `system`.

**What changed:** `update_placement_bidding` rows were writing a **null** actor while the sibling `CampaignBidHistory` row for the *same write* recorded `'system'` — the two fallbacks differed by two lines in one function. Measured on prod: **10,120 unattributed rows, a third of the whole advertising audit log, 2,524 of them in the last seven days.** Now consistent.

⚠️ **Historical rows keep their nulls.** Any "unattributed writes" metric must window from the fix date or it will report a permanent backlog that no longer accrues.

### `AdvertisingActionLog.evidence` — new, JSONB, nullable
Shape (`apps/api/src/services/advertising/ads-evidence.ts`):

| Field | Meaning |
|---|---|
| `targetKey` | RankTarget intent being served — `own-top`, `defend-top`, … |
| `metric` | What drove it — `topOfSearchImpressionShare`, `acos`, `placementBidding` |
| `observed` | What we saw |
| `threshold` | What we wanted |
| `windowDays` | Lookback |
| `sampleSize` + `sampleUnit` | How much data it rests on (`rows` \| `days` \| `impressions`) |
| `note` | The non-numeric part |

`packEvidence()` returns **null rather than `{}`**, so a null means "no reasoning captured" and never "reasoning captured but empty". Please preserve that distinction in any UI — they mean different things.

**Populated today:** `update_placement_bidding` (all callers), with `targetKey` supplied by `ad-rank-defend`.
**Not yet populated:** bid writes through `ads-mutation.service.ts`, harvest/negate, budget writes. Treat `evidence: null` as normal, not as an error.

---

## 2. What reporting should build on it

**① The unattributed-writes counter.** Writes with `userId IS NULL` since the fix date. Should sit at zero; anything above zero is a new code path that forgot to pass an actor. This is a regression detector, not a chart.

**② Thin-evidence flag.** `isThinEvidence()` marks decisions resting on less data than they appear to. This is not hypothetical — AMS coverage is per-campaign, and some schedules hold **1–5 days of data where the account has 56**. A bid moved on 3 days of data should not look identical to one moved on 56.

**③ "Why did this bid move?"** Given a campaign and a time, return the write, the actor resolved to a human-readable name (the `automation:rank-defend-<id>` prefix resolves to the schedule's name), and the evidence. This is the single question that started the whole ADX programme.

**④ The one number: wasted ad spend, in €.** Three independent sources converged on this — Pacvue's dollar-valued alerts board, BidX's *Wasted Ad Spend Analyzer*, and the `COMMERCE-PLATFORM-RESEARCH` study's "counted problems board, every row priced in €".

We can compute it better than any of them: `ProductProfitDaily` + real Amazon fees + COGS means the figure is **margin actually lost**, not an ACOS estimate. Suggested composition — spend on zero-sale targets, spend below the margin floor, spend on out-of-stock or Buy-Box-lost ASINs.

---

## 3. Boundary

I am deliberately **not** building: the unified change-history surface, the wasted-spend widget, or any ads reporting page. Those are yours. If you want the write side to emit something it currently doesn't, say so and I will add it at the source rather than have it derived downstream.

**Shared-tree caution:** the pre-push hook builds the *working tree*, not the commit. With both sessions editing, `git commit --only` can pass the hook while capturing the other session's half-finished edits. Worth a clean `git status` check before either of us pushes.

---

## 4. Files (all local, uncommitted)

| File | Change |
|---|---|
| `packages/database/prisma/schema.prisma` | `AdvertisingActionLog.evidence Json?`; `Campaign.minBidCents/maxBidCents/targetAcosPct`; `AdKeywordProtection` |
| `…/migrations/20260804_adx_a1_entity_bounds_and_keyword_protection/` | additive, **not applied** |
| `…/migrations/20260804b_adx_a2_action_log_evidence/` | additive, **not applied** |
| `apps/api/src/services/advertising/ads-evidence.ts` | new — the evidence shape + helpers |
| `apps/api/src/services/advertising/ads-create.service.ts` | actor fallback fixed; evidence threaded through `audit()` |
| `apps/api/src/services/advertising/ads-write-gate.ts` | entity bid bounds + keyword protection |
| `apps/api/src/services/advertising/ads-top-of-search.service.ts` | stale comment corrected |
| `apps/api/src/jobs/ad-rank-defend.job.ts` | passes `targetKey` as evidence |
| `apps/api/src/workers/ads-sync.worker.ts` | passes field + intended value to the gate |
