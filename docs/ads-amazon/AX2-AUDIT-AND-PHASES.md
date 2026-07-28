# Amazon Ads console — live audit + proposed phases (AX2)

> Scope: `/marketing/ads/campaigns` and the Amazon Ads sync spine behind it.
> Compiled 2026-07-28 from **read-only probes against production** (`scripts/_amz-ads-health-probe.mts`,
> `_amz-ads-deadletter-probe.mts`) plus a source audit. No writes, no Amazon calls, no code changed.

---

## 0. Verdict

The console is large and genuinely capable — 192 campaigns, 261 ad groups, 4,415 targets, 10 portfolios,
75+ ads services, 17 crons all running green. But three things are not true today:

1. **It is not real-time.** Nothing streams. The mirror is 20-minute (settings), hourly (metrics), daily (reports).
2. **It tells you a write succeeded when it has only been queued** — and 662 writes have died unnoticed.
3. **There is no way to replicate a structure onto another product.** Zero clone/duplicate capability exists.

Item 3 is the feature you asked for. Items 1–2 must be fixed first, or replication just multiplies a
delivery problem across dozens of new campaigns.

---

## 1. Bugs found, ranked by damage

### 🔴 B1 — 23 dead targets re-pushed every day for 26 days (662 failed writes)

The sharpest finding, and it is still happening.

| Fact | Value |
|---|---|
| Dead-lettered `AD_*` writes | **662** |
| syncType | **100% `AD_BID_UPDATE`** |
| Amazon errorType | **100% `entityNotFoundError`** |
| Region | **100% IT** |
| Distinct Amazon ids involved | **23** |
| Distinct local `AdTarget` rows | **23** |
| Those rows still in the DB with the stale id | **23 / 23** |
| Rate | **~23/day, every day since 2026-07-02** |

Amazon's reply is unambiguous:

```
{"errorType":"entityNotFoundError","errorValue":{"entityNotFoundError":{
  "cause":{"location":"$.keywords[0].keywordId","trigger":"207019562887495"},
  "entityId":"207019562887495","entityType":"KEYWORD",
  "message":"Could not find keyword with id …"}}}
```

**Mechanism.** 23 keywords were deleted on Amazon. Our `AdTarget` rows kept their `externalTargetId`.
`ad-rank-defend` (every 15 min) recomputes bids, sees a change, enqueues a bid write per target, the
worker gets `entityNotFoundError`, retries 3×, dead-letters. Tomorrow it does it again. `isRetryableSyncError`
correctly stops the reconcile sweep from looping on them — but **nothing reaps or re-resolves the rows**, so
the engine regenerates the same 23 writes forever.

Cost: ~69 wasted Amazon calls/day, a permanently red dead-letter count that masks real failures, and 23
targets whose bids silently never move.

### 🔴 B2 — the grid reports "saved" for writes that were only enqueued

`CampaignsGrid.tsx:44-50`:

```ts
async function patchJson(url, body): Promise<boolean> {
  const r = await fetch(url, { method: 'PATCH', … })
  const j = await r.json().catch(() => ({}))
  return r.ok && j?.ok !== false        // ← "enqueued", not "Amazon accepted"
}
```

Per the delivery model, `ok` from `updateCampaignWithSync` means the row was written locally and an
`OutboundSyncQueue` entry created. A bid reaches Amazon only if the write gate passes
(`NEXUS_AMAZON_ADS_MODE=live` + active production connection + `writesEnabledAt` + per-campaign
`liveBidWritesEnabled` + non-null `externalTargetId` + the cron running).

Grepping the whole grid for `pending-writes`, `DeliveryChip`, `lastSyncStatus`, `sandbox` returns **nothing**.
The `DeliveryChip` exists — in the rank cockpit, not in Ad Manager. So the surface operators actually use is
the one blind to delivery. In sandbox the queue row is even marked SUCCESS with no HTTP ever sent.

### 🟠 B3 — "real-time sync" is 20 minutes at best, and there is no stream

| Lane | Cadence |
|---|---|
| Campaign settings (status, budget, bidding, placements) | **every 20 min** |
| Metrics reconcile | hourly (`22 * * * *`) |
| Reports create → poll → ingest | daily create; poll 10 min; ingest 4×/hr |
| Full reconcile | daily 03:30 |
| Rank defend | 15 min |
| Queue drain | 1 min |
| **Amazon Marketing Stream** | **`NEXUS_AMS_DESTINATION_ARN` unset → not running** |

AMS is the only true real-time path (it exists at `ads-marketing-stream.service.ts`, fully written, just not
configured). Until it is subscribed there is no intraday truth, and "Today" figures are extrapolations.

Observed freshness: `lastSyncedAt` for **184 of 189 campaigns sits in the 30 min–2 h band**, with **0 under
30 minutes**, even though `ads-campaign-settings-sync` last ran 7 minutes ago. So the 20-minute job is not
stamping every campaign each pass — worth confirming whether it early-exits on "no change" or is paging out.

### 🟠 B4 — 5 of 9 marketplaces cannot write; 2 more never have

```
IT  production  writesEnabled 2026-05-31   lastWrite 2026-07-27 22:19   ✓ working
DE  production  writesEnabled 2026-06-12   lastWrite 2026-07-27 22:17   ✓ working
FR  production  writesEnabled 2026-06-24   lastWrite —                  ⚠ never written
ES  production  writesEnabled 2026-06-24   lastWrite —                  ⚠ never written
PL UK SE NL IE  sandbox      writesEnabled NULL                         ⛔ blocked
```

The console presents all of them. Only IT and DE have ever pushed. Any bulk action taken across markets
silently no-ops on seven of nine.

### 🟡 B5 — Sponsored Products only, but nothing says so

`ads-api-client.ts` implements `/sp/campaigns`, `/sp/adGroups`, `/sp/keywords`, `/sp/targets`,
`/sp/negativeKeywords`, `/sp/negativeTargets`, `/sp/productAds` — plus a single `/sd/targets`. There is **no
`campaignType` field on `Campaign`** at all. So Sponsored Brands and Sponsored Display are neither synced nor
modelled, and the UI's "Sponsored Brands / Sponsored Display" labels (`TYPE_LABEL` in the grid) can never be
populated from a real sync.

### 🟡 B6 — a second, dead target model

`CampaignTarget` has **0 rows**; `AdTarget` has **4,415**. Both carry `externalTargetId` and both are indexed.
This is the same "two-of-everything" hazard flagged in the eBay audit — a defined-but-unused twin that will
eventually get written to by one code path and read by another.

### 🟡 B7 — small integrity gaps

- **1 campaign has no `externalCampaignId`** — it can never be resolved against Amazon (and per the AF.1d rule
  we resolve by that id alone, never by name).
- **4 campaigns have `lastSyncedAt = null`**, 1 is >24 h stale.
- `ads-keyword-bid-resync` was found in state `RUNNING` — check it has an overlap lock, or a hung run blocks the next.

---

## 2. The replication gap — what you asked for

**Nothing exists.** `grep -a "clone|duplicate|replicate"` across `advertising.routes.ts` returns only comments
about de-duplicating campaigns. Creation paths that do exist — `campaign-builder/{quick,guided,single,sp-super-wizard}` —
all build *one* campaign from scratch.

Your case is exactly right: a motorcycle jacket and the next motorcycle jacket want the same portfolio shape,
the same ad-group split, the same keyword and product targeting, the same negatives, the same placement
modifiers. Today that is manual, N times over, with no guarantee the copies stay consistent.

### The one thing that must not be copied naively

**Identical targeting across similar products makes you bid against yourself.** Amazon runs a second-price
auction; two of your own jackets on the same keyword raise your own clearing price and split the same demand.
This is the same failure the eBay pool work exists to prevent, and it is *worse* here because replication is
what creates it — at scale, deliberately, in one click.

You already own the two services that solve it and neither is wired into any creation path:
`rank-self-competition.ts` and `keyword-conflicts.service.ts`. A replication feature that does not consult them
is a self-cannibalisation machine. This is the single most important thing to get right, and I would not ship
replication without it.

---

## 3. Things worth adding that you did not ask for

1. **Blueprints as first-class objects, not one-off clones.** If a clone is a snapshot, the copies drift apart
   the moment you tune one. If it is a *named blueprint* with children bound to it, you can re-apply changes to
   all products in a category and see which ones have diverged.
2. **Bulksheet round-trip as the substrate.** Amazon's bulk-upload grammar is already documented in our notes.
   Building replication on it gives export → edit → re-import, an operator escape hatch, and a diffable artifact.
3. **A naming/token convention engine.** `{brand}-{product}-{matchType}-{market}` so 40 cloned campaigns are
   still navigable, and the grid can group by structure rather than by name string.
4. **Dry-run diff before every apply.** Show exactly what will be created on Amazon — count of campaigns, ad
   groups, targets, and the projected daily budget total — before a single call fires.
5. **Negative-keyword inheritance.** Cloned campaigns should inherit the source's negatives *and* automatically
   negative-out the sibling products' branded terms — the direct antidote to self-competition.
6. **Portfolio-level budget guard.** Replicating 10 campaigns at €20/day silently commits €200/day. Cap and
   confirm at portfolio level.
7. **Rollback for a whole replication run.** `rollback.service.ts` exists; a clone run should be one revertible
   unit, not 60 orphaned entities.
8. **Post-clone read-back.** After creating on Amazon, re-read and confirm every entity exists with the intended
   bid — the AF-series lesson, applied to creation.

---

## 4. Proposed phases

Ordered so each phase is independently shippable and nothing later depends on a broken foundation.

| Phase | Title | Scope | Why here |
|---|---|---|---|
| **AX2.0** | **Stop the bleeding** | Reap/re-resolve the 23 stale `AdTarget` rows; make the rank engine skip targets whose external id 404s and mark them `ORPHANED` rather than re-enqueueing; purge the 662 dead rows; alert when the dead lane grows | It is failing every day, right now, and it hides every other failure |
| **AX2.1** | **Tell the truth about delivery** | Surface delivery state in the Ad Manager grid (live / pending / failed / sandbox), reuse the existing `DeliveryChip` + `/pending-writes`; `patchJson` stops reporting "saved" for "queued"; a sandbox banner when `NEXUS_AMAZON_ADS_MODE` ≠ live | Every later phase writes to Amazon; you must be able to see whether writes land |
| **AX2.2** | **Close the sync gaps** | Backfill the campaign with no `externalCampaignId` and the 4 never-synced; fix the settings-sync freshness gap; overlap-lock `ads-keyword-bid-resync`; retire or populate the dead `CampaignTarget` model | Replication reads this mirror — it must be trustworthy |
| **AX2.3** | **Real-time: subscribe Amazon Marketing Stream** | Configure the SQS/Firehose destination, subscribe the datasets, wire `ingestMarketingStream`, drive intraday metrics from it, and label everything else honestly as T-1 | This is what "real-time sync" actually means; the code is already written and dormant |
| **AX2.4** | **Structure Blueprints (read side)** | Extract a named blueprint from any existing portfolio/campaign: structure, targeting, negatives, placement modifiers, bids, with product-specific fields parameterised. Diff a blueprint against its children | The foundation of replication — safe, read-only, immediately useful as an audit tool |
| **AX2.5** | **Replication (write side)** | Apply a blueprint to N target products: dry-run diff → portfolio budget guard → **self-competition + keyword-conflict check (blocking)** → gated create → post-create read-back → single-unit rollback | The feature you asked for, with the guard that makes it safe |
| **AX2.6** | **Bulksheet round-trip** | Export a blueprint or a live structure as an Amazon bulksheet; re-import with a diff preview | Operator escape hatch + a diffable artifact; also the fastest path to bulk edits |
| **AX2.7** | **Multi-market truth** | Either graduate FR/ES/PL/UK/SE/NL/IE properly, or make the console state plainly which markets are read-only. Replication becomes market-aware | Prevents "I cloned to UK and nothing happened" |
| **AX2.8** | **Sponsored Brands / Sponsored Display** | Add `campaignType`, the `/sb` and `/sd` client surfaces, sync and grid support | Largest scope, lowest urgency — SP is where the spend is |

**Suggested first cut:** AX2.0 + AX2.1 together. They are small, they are both live defects, and they make
everything after them verifiable.

**The gate on AX2.5:** replication must not be able to create a structure that competes with itself. If the
conflict check cannot be made reliable, ship AX2.4 (blueprints + diff) and hold the write side.

---

## 5. What I have not verified

- Whether the settings-sync freshness gap is an early-exit or a paging bug — needs one instrumented run.
- Whether the 23 orphaned keywords were deleted on Amazon deliberately (by an operator or by Amazon) — affects
  whether the fix is "reap" or "recreate".
- SB/SD volume in the account — I can see no local model, not that the campaigns don't exist on Amazon.
- Live UI behaviour of `/marketing/ads/campaigns` — RBAC blocks anonymous reads, so this audit is source +
  database only. A browser pass would add interaction-level findings.
