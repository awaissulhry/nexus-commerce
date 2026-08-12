# KT — Keyword Tracker as its own page

**Read-only study. No application code was changed. Nothing was committed.**
Session slug `kt`; parallel-session protocol observed — every file created here is `_kt-page*`.

Measured on production 2026-08-11 with `apps/api/scripts/_kt-page.mts`,
`_kt-page-sqp-diag.mts` and `_kt-page-signals.mts` (all read-only, all re-runnable).
Builds on `docs/2026-08-11-kt-keyword-tracker-study.md`; **§3 corrects one of its findings.**

---

## 0 · The one-sentence version

The Keyword Tracker is four columns describing a thing Amazon does not sell, backed by a table with
**0 rows**, wired to a rule trigger with **0 rules** whose money fields are **0 for all 2,129
keyword targets** — while the two signals that *would* answer its question sit unread one join away:
**SQP** (15,075 rows, 17 days stale, ~10 ASINs per market) and **`topOfSearchIS`**
(811 campaign-days, **2 days fresh**, from Amazon's own API, arriving every night and shown nowhere).

---

## 1 · What exists — every wire

```
/marketing/ads/rules-automation?tab=keyword-tracker        ← the 11th (rightmost) tab
└── RulesAutomationClient.tsx:338            <SovTrackerTab kind="tracker" />
    └── tabs/SovTrackerTab.tsx               segmented [ Rules | Report ], defaults to Rules
        ├── Rules  → tabs/RuleListTab.tsx    liveType="keyword-tracker"
        │             GET /advertising/automation-rules
        │             → filtered by ruleBelongsToTab(actions, 'keyword-tracker')   ← always false
        └── Report → tabs/TrackerTab.tsx     kind="tracker"
                      GET  /advertising/keyword-ranks?limit=500   routes:7294
                      POST /advertising/keyword-ranks             routes:7322  ← the ONLY writer

Builder   /builder/keyword-tracker → _shared/RuleBuilder.tsx (slug 'keyword-tracker')
          TRIGGER_BY_SLUG['keyword-tracker'] = 'KEYWORD_RANK_BID'   RuleBuilder.tsx:85
          actions: [{ type: 'keyword-tracker', … }]                 RuleBuilder.tsx:497
          metrics offered: Organic Rank · Sponsored Rank · Rank Change · Search Volume
                           · Share of Voice · ACOS · Spend         PerformanceCriteria.tsx:36
          Preview pane joins GET /keyword-ranks per target          RuleBuilder.tsx:400

Adapter   services/advertising/ads-rule-adapter.service.ts:63  RANK_METRIC
          'Organic Rank' → adTarget.organicRank · 'Rank Change' → adTarget.rankDelta …
          → emits a single `bid_apply` action (line 147)

Engine    jobs/advertising-rule-evaluator.job.ts:959  buildKeywordRankBidContexts()
          line 962: `if (!ranks.length) return []`     ← every tick, forever
          registered at line 1093 in the KEYWORD_RANK_BID pass

Table     KeywordRank        schema.prisma:12905   (append-only observations)
Scope     services/automation-rule-scope.ts  ruleMatchesScope()
```

**Everything that touches `KeywordRank`, complete:**

| | where | direction |
|---|---|---|
| the Report grid | `tabs/TrackerTab.tsx:61` | read |
| the builder's Preview rank columns | `_shared/RuleBuilder.tsx:400` | read |
| the rule context builder | `advertising-rule-evaluator.job.ts:961` | read |
| `GET /advertising/keyword-ranks` | `advertising.routes.ts:7294` | read |
| `POST /advertising/keyword-ranks` | `advertising.routes.ts:7322` | **write — the only one** |
| a DELETE route | — | **does not exist** |

Both routes are deployed and RBAC-mapped: unauthenticated `GET` returns
`{"error":"Access denied","code":"unauthenticated","required":"ads.view"}`, not a 404.

### 1.1 The measured state

| measurement | value |
|---|---|
| `KeywordRank` rows | **0** |
| advertising `AutomationRule` rows | 51 |
| rules on trigger `KEYWORD_RANK_BID` | **0** |
| rules on trigger `SOV_BID` | **0** |
| rules carrying builder action type `keyword-tracker` | **0** |
| positive `KEYWORD` `AdTarget` rows | **2,129** (299 distinct text × market) |
| distinct bid keywords by market | IT 212 · DE 41 · FR 37 · ES 9 |
| triggers actually in use | `SCHEDULE`=23 · `CAC_SPIKE`=5 · `CAMPAIGN_PERFORMANCE_BUDGET`=5 · `AD_SPEND_PROFITABILITY_BREACH`=4 · `AD_TARGET_UNDERPERFORMING`=4 · `KEYWORD_ZERO_IMPRESSIONS`=3 · `KEYWORD_WASTED_SPEND`=2 · 5 more at 1 each |

---

## 2 · How it works, and where each column lies

### 2.1 The four columns

| column | rendered from | truth |
|---|---|---|
| **Search Volume** | `KeywordRank.searchVolume` | ✅ obtainable — Brand Analytics SQP `searchQueryVolume`, **already ingested**, but this column does not read it |
| **Organic Rank** | `KeywordRank.organicRank` | ❌ no SP-API or Ads API endpoint returns organic SERP position. Every vendor that shows it collects the page |
| **Sponsored Rank** | `KeywordRank.sponsoredRank` | ⚠️ `searchTermImpressionRank` is **console-only** — Amazon staff acknowledged the API gap on 2024-04-05 and it is still open in 2026 ([amzn/ads-advanced-tools-docs #244]). What *is* API-available at keyword grain is `topOfSearchImpressionShare`; we fetch it at **campaign** grain (§4.2) |
| **Rank Δ** | `prior.organicRank − latest.organicRank` | follows Organic Rank — but a **share Δ** is computable from SQP today (§4.1) |

`TrackerTab.tsx:115-123` renders all four as `#—` on every row because there are no rows.

### 2.2 Four defects on the wires themselves

**D1 — the Rules segment can never show a row, and the fix is not the one previously stated.**
`SovTrackerTab.tsx:48` passes `liveType="keyword-tracker"` into `RuleListTab`, which filters with
`ruleBelongsToTab(actions, liveType)`. That function looks the string up in
`RULE_TAB_ACTION_TYPES` (`_shared/tabs.tsx:83`), whose five keys are `bid`, `budget`, `placement`,
`keyword-harvest`, `negative-targeting`. The lookup returns `undefined` → the guard returns `false`
→ **every one of the 51 rules is filtered out.**

The earlier study called this "one string". It is not: adding the key needs a *value*, and the
right value is the **builder slug used as the action type** — `'keyword-tracker': ['keyword-tracker']`
— because `RuleBuilder.tsx:497` writes `actions: [{ type: slug }]`. Share of Voice needs
`'sov': ['sov']` on the same reasoning, and Keyword Harvest needs its `liveType` typo fixed
(`RulesAutomationClient.tsx:391` sends `keyword-harvesting`, the map key is `keyword-harvest` —
already recorded in the HV study). `_shared/tabs.tsx` is shared substrate: **stated as a
requirement in §8, not designed here.**

**D2 — every write control on the Rules segment is decoration.** `RuleListTab.applyBulk`
(line 120) and `toggleAutomation` (line 72) call `setRows(…)` and nothing else. There are exactly
three `fetch` calls in that file: load rules, load executions, roll back an execution. So the
Automation switch, Criteria, Frequency and **Delete** all mutate local React state and vanish on
reload — and the Delete modal says *"Delete N rules? This cannot be undone."* This is the
Dry-run/LIVE class of defect the programme keeps removing, and it is a direct D4 violation
(a control that spends or destroys must state truthfully what it does).

**D3 — the Report's "Remove" button cannot persist.** `TrackerTab.removeSelected` (line 127)
filters local rows; there is **no DELETE route** for `keyword-ranks`. Rows reappear on refresh.

**D4 — the rule context's money fields are always zero.** `buildKeywordRankBidContexts` reads
`t.spendCents` and derives `acos = spendCents / salesCents`. Measured: of **2,129** positive
`KEYWORD` `AdTarget` rows, **0 have `spendCents > 0`, 0 have `salesCents > 0`, 0 have
`impressions > 0`.** Keyword metrics live in `AmazonAdsDailyPerformance` (`entityType='AD_TARGET'`,
8,000 rows in 60 days). So a rule written as *"raise the bid where organic rank > 20 **and** ACoS <
30%"* would evaluate `acos = 0` for every target — the condition passes for the wrong reason. The
builder offers **Spend** and **ACOS** on this rule type (`PerformanceCriteria.tsx:36`), so this is
reachable from the UI today.

**D4b — the same builder offers "Share of Voice" on a Keyword Tracker rule, and the context has no
such field.** `RANK_METRIC` maps it to `adTarget.sovPct`; `buildKeywordRankBidContexts` never sets
`sovPct`. It is present only on the `SOV_BID` context.

### 2.3 🔴 Three of the four scope grains silently disable a Keyword Tracker rule

The operator's standing decision is *"All four scope grains matter to me equally."* On this trigger,
three of them **turn the rule off without saying so.**

`ruleMatchesScope()` (`automation-rule-scope.ts:57`) refuses a portfolio-, campaign- or
product-scoped rule on any context that carries no campaign identity:

```ts
if (rule.scopeCampaignId  != null && rule.scopeCampaignId  !== ctx.campaignId)  return false
if (rule.scopePortfolioId != null && rule.scopePortfolioId !== ctx.portfolioId) return false
if (rule.scopeProductIds?.length) { if (!ctx.productIds?.length) return false … }
```

And `contextIdentity()` (line 80) reads identity from `ctx.campaign.id`, `ctx.adGroup.id` or
`ctx.searchTerm.externalCampaignId`. **`buildKeywordRankBidContexts` emits none of them** — the
context is `{ trigger, marketplace, adTarget: { … } }` (job line 982). So `campaignId`, `portfolioId`
and `productIds` all resolve empty.

| grain | on a Keyword Tracker rule |
|---|---|
| Market | ✅ works — `scopeMarketplace` matches `ctx.marketplace` |
| Portfolio | ❌ rule never fires |
| Campaign | ❌ rule never fires |
| Product line | ❌ rule never fires |

`buildSovBidContexts` (job line 923) has the identical shape and the identical consequence.

Two further notes, because they interact:

- **Campaign restriction on this rule type happens somewhere else.** The builder's campaign picker
  writes `actions[0].campaigns`, which the adapter turns into `bid_apply.campaignIds`
  (`ads-rule-adapter.service.ts:161`). So "which campaigns" is enforced by the *action*, while
  "does this rule apply" is enforced by the *scope* — two mechanisms, different behaviour, and only
  one of them is visible on the Automations page.
- **The builder cannot set a market scope or a spend cap on this rule type.**
  `RuleBuilder.tsx:506` sends `scopeMarketplace` and `maxDailyAdSpendCentsEur` only when
  `isBudget`. A Keyword Tracker rule is `isBidLike`, so it is created with neither. It *does* get
  `bidFloor`/`bidCeiling` (line 503). Against the operator's decision *"spend ceilings per scope —
  market, product line, portfolio, campaign — at the cap, refuse the write and tell me"*, this rule
  type currently carries a **per-bid ceiling and no spend ceiling at all**.

---

## 3 · 🔴 Correction: the SQP cron is not dead. It is green, and its yield has collapsed to zero

The 2026-08-11 study reported: *"No `CronRun` row named `sqp-ingest` exists at all."* **That is
wrong, and I am recording it because the wrong version was entirely plausible** — the feed does look
dead from the data alone.

Measured (`_kt-page-sqp-diag.mts`):

| | |
|---|---|
| `CronRun` rows named `sqp-ingest` | **71** |
| first run | 2026-06-01 03:45 UTC |
| most recent | **2026-08-11 03:45 UTC — SUCCESS** |
| non-SUCCESS | 12 |

The last twelve runs, verbatim:

```
2026-08-11T03:45Z  SUCCESS  12608s  markets=9 ok=4 failed=5 rows=0     ← today
2026-08-10T03:45Z  SUCCESS   3074s  markets=9 ok=4 failed=5 rows=83
2026-08-09T03:45Z  SUCCESS   6817s  markets=9 ok=4 failed=5 rows=76
2026-08-08T03:45Z  SUCCESS   2677s  markets=9 ok=4 failed=5 rows=250
2026-08-07T03:45Z  SUCCESS   2602s  markets=9 ok=4 failed=5 rows=250
2026-08-06T03:45Z  FAILED    8101s  stale (auto-swept after 2.3h)
2026-08-05T03:45Z  SUCCESS   2838s  markets=9 ok=4 failed=5 rows=250
2026-08-04T03:45Z  FAILED    8101s  stale (auto-swept after 2.3h)
2026-08-03T03:45Z  SUCCESS   2430s  markets=9 ok=4 failed=5 rows=210
2026-08-02T03:45Z  SUCCESS   2732s  markets=9 ok=4 failed=5 rows=210
2026-08-01T03:45Z  SUCCESS   2578s  markets=9 ok=4 failed=5 rows=381
2026-07-31T03:45Z  SUCCESS   2660s  markets=9 ok=4 failed=5 rows=541
```

Four separate faults, all hidden behind the word SUCCESS.

**3.1 · `failed=5` is a permanent constant, so it can never signal anything.**
`runSqpIngestOnce` iterates every active `AmazonAdsConnection` — **9 markets: DE ES FR IE IT NL PL
SE UK**. Five of them (IE, NL, PL, SE, UK) have **0 `ChannelListing` rows**, so
`ourAsinsForMarketplace` returns `[]` and `ingestSqp` throws *"no Amazon ASINs"*
(`sqp.service.ts:243`). Those five are exactly the **sandbox** profiles — `MarketplaceContext.tsx:17`
records the same split independently: *"DE, ES, FR, IT are production with writes enabled, while IE,
NL, PL, SE and UK are sandbox."* The job has been reporting five failures a night since 2026-06-01
for a reason that will never change, which means a **sixth** failure would be invisible.

**3.2 · The cron requests 10 ASINs per market and never rotates.**
`ingestSqp` defaults to `ourAsinsForMarketplace(mkt, args.limit ?? 10)`, and that function is
deterministic — it sorts listings ACTIVE-first and takes the first 10. The code comment says *"the
cron cycles coverage over days"*. **It does not cycle.** Same 10 ASINs, every night, per market:

| market | distinct ASINs available | asked for nightly |
|---|---|---|
| IT | 252 | 10 |
| DE | 208 | 10 |
| ES | 121 | 10 |
| FR | 113 | 10 |

The 2,000-row weeks in the history were produced by the **manual backfill/widen scripts**
(`_acr2-sqp-backfill.mts`, `_acr24-sqp-widen.mts`), not by the cron — visible in the ingest
timestamps: week 2026-07-12 holds 2,226 rows across **17 ASINs** ingested 2026-07-26 … 2026-08-05,
while week 2026-07-26 holds 85 rows across 13 ASINs ingested 2026-08-09 … 2026-08-10 and nothing
since. The cron alone sustains a fraction of what the table looks like it contains.

**3.3 · Coverage, stated honestly:**

| market | advertised ASINs | with any SQP row ever | |
|---|---|---|---|
| IT | 250 | 32 | **13 %** |
| DE | 57 | 13 | 23 % |
| ES | 30 | 15 | 50 % |
| FR | 91 | 4 | **4 %** |

34 distinct ASINs have ever appeared in SQP. **13** appear in the latest stored week.
Any share figure quoted from this table is relative to whichever ASINs happened to be measured —
consistent with the standing note that widening the scope moves published baselines.

**3.4 · Today's run wrote nothing.** `rows=0` means zero parsed rows across 4 markets × 10 ASINs =
40 reports. The summary cannot distinguish *"40 reports failed"* from *"40 reports were empty"*
because `runSqpIngestOnce` sums only `r.upserted` and drops `asinsRequested`, `rows` and
`failedAsins` on the floor (`sqp-ingest.job.ts:36-43`). The answer is in
`sqpDebugState` (`GET /advertising/sqp/debug`, deployed and `ads.view`-gated) and in the
`[sqp] asin report failed` warnings. **I could not read either without credentials, so I am not
guessing at the cause.**

**3.5 · Runs take 40 minutes to 3.5 hours** and ~~two~~ **three** were auto-swept as stale after
2.3 h. 🔴 **Corrected (KT.1b, 2026-08-12):** the third is the 2026-08-11 run, which the §3 table
above quotes as a clean `SUCCESS` — it carries `status=SUCCESS` **and**
`errorMessage="stale (auto-swept after 2.3h)"` at the same time. A `CronRun` row can hold both, and
exactly one of the last fourteen does: the newest. All time, **13 runs carry a "stale" error message
while only 12 have a non-SUCCESS status** — that difference of one is the run this table read as
healthy. Forty
sequential Amazon report generations at ~6 minutes each is the shape of that number.

**3.6 · The decoy env var is real.** Railway carries `NEXUS_ENABLE_SQP_INGEST_CRON=1`, which no
code reads any more — the job flipped to opt-out `NEXUS_DISABLE_SQP_INGEST_CRON` (`sqp-ingest.job.ts:61`),
which is unset. Confirmed in-process: `NEXUS_ENABLE_AMAZON_ADS_CRON=1`,
`NEXUS_ENABLE_SQP_INGEST_CRON=1`, `NEXUS_DISABLE_SQP_INGEST_CRON` unset.

**What this changes.** The earlier prescription — *"diagnose and restart the cron"* — is the wrong
work. The cron is running. The work is: widen the ASIN set beyond 10, stop iterating 5 sandbox
markets, surface `failedAsins`, and find out why 40 reports produced nothing this morning.

---

## 4 · What this account actually holds about "where do we rank"

### 4.1 SQP — the deep signal, stale

15,075 rows · 7,799 distinct queries · **7,841 distinct query × market pairs** · IT/DE/ES/FR ·
weekly · **every row ASIN-scoped**. Carries market volume, market popularity rank, and our
impression / click / cart-add / purchase **share** against market totals. Already trusted by
`ad-rank-defend.job.ts:563`.

| week | DE | ES | FR | IT | total |
|---|---|---|---|---|---|
| 2026-07-26 | 5 | 71 | 1 | 8 | **85** |
| 2026-07-19 | 364 | 193 | 4 | 655 | 1,216 |
| 2026-07-12 | 675 | 443 | 42 | 1,066 | 2,226 |
| 2026-07-05 | 438 | 354 | 44 | 989 | 1,825 |

Latest period start is **2026-07-26 in all four markets — 17 days old**, and
`sqpImpressionShareForAsins` has **no recency guard** (`sqp.service.ts:200` takes `MAX(startDate)`
whatever it is), so a 17-day-old number reaches the rank engine indistinguishable from a fresh one.
*(The RD study already recommends that guard; it is not this page's build, but this page must
display the age.)*

**Week-over-week Δ is currently uncomputable at the top of the table and fine below it:**

| pair | comparable query × ASIN keys |
|---|---|
| 07-26 vs 07-19 | **6** |
| 07-19 vs 07-12 | 253 |
| 07-12 vs 07-05 | 376 |

### 4.2 `topOfSearchIS` — the shallow signal, **fresh**, and shown nowhere

This is the finding that changes what the page can be on day one.

| | |
|---|---|
| `AmazonAdsPlacementReport` rows with `topOfSearchIS` | **811** of 4,542 |
| date range | 2026-07-07 … **2026-08-09** ~~(2 days old)~~ |
| 🔴 **corrected (KT.1b, 2026-08-12)** | **the `topOfSearchIS` column lags the report it rides on by one day.** `AmazonAdsPlacementReport` holds rows dated **2026-08-10**; the newest row with a non-null `topOfSearchIS` is **2026-08-09**. So this signal is T-2 on the day this study was written and T-3 the day after — stated as a lag rather than an age, because an age rots overnight and this one did. The nightly `tos-is-ingest` run updated 300 rows without advancing the max date. |
| distinct campaigns with a reading | **65** ~~of 220~~ — 🔴 **corrected (KT.1b): of the 81 campaigns that have ANY placement row.** 139 of the 220 have none at all, so "65 of 220" charges 139 campaigns with a missing column they were never eligible for. |
| average | 25.77 % |
| by market | IT 693 days avg 25.51 % · DE 87 avg 29.62 % · FR 20 avg 26.90 % · ES 11 avg 9.24 % |
| `tos-is-ingest` cron | **daily SUCCESS**, e.g. 2026-08-11 02:30 `profiles=9 rowsFetched=466 withIS=365 rowsUpdated=300 errors=0` |

Two consequences:

1. **`ads-coverage.service.ts:47` and `:117` are stale.** They state *"`topOfSearchIS` is NULL on all
   3,552 placement rows in every market"* and gate a feature on that being true. It was fixed by
   raising the report poll ceiling to 45 minutes (`ads-tos-is-ingest.service.ts:64`) and has been
   populated since 2026-07-07. I am flagging the comment, not the code — that file belongs to
   another surface.
2. **This is Amazon's own answer to "how visible are our ads in the top slot", it is two days old,
   and the Keyword Tracker shows a permanently empty "Sponsored Rank" column instead.** It is
   campaign-grain, not keyword-grain — so it is a *lane* signal, not a *keyword* signal, and must be
   labelled as one. That is still infinitely more than `—`.

### 4.3 The rest of the inventory

| source | rows | grain | freshness |
|---|---|---|---|
| `AmazonAdsSearchTerm` | 1,999 query × market with paid traffic in 30 d | query × campaign × day | **2 days** |
| `AmazonAdsDailyPerformance` (`AD_TARGET`) | 8,000 in 60 d | target × day | **2 days** |
| `AmazonAdsPlacementReport` | 4,542 | campaign × placement × day | **2 days** |
| `SearchQueryPerformance` | 15,075 | query × ASIN × week | **17 days** |
| `KeywordCoverageSet` / `Term` | 1 set · **97 terms** (`Xavia GALE IT — coverage`, IT, `enabled=false`, 0 control terms) | curated list | — |
| `AdKeywordProtection` | 10 whitelist terms: xavia · gale · moss · aireon · misano · airmesh · air mesh · x-tuta · ventra · regal | term | — |
| `KeywordRank` | **0** | — | — |

### 4.4 Do our keywords and Amazon's queries share a vocabulary?

Of **299** distinct bid keyword × market pairs:

| | |
|---|---|
| exact match to an SQP query | **119** |
| no exact match, but the keyword appears *inside* an SQP query | 29 |
| no SQP trace at all | **151** |

And in the other direction: **1,117** query × market pairs we paid for in the last 30 days have
**no SQP row at all**. A page joining the two on exact text reaches 40 % of what we bid on. It must
say so rather than render 151 blank rows.

*(Match-type spellings on those targets: `BROAD` 249 · `EXACT` 253 · `PHRASE` 237. Negativity is
`isNegative`, not `expressionType` — the 2,056 negatives are excluded here by `isNegative: false`.)*

### 4.5 What a real row looks like today

The 97 curated coverage terms, assembled end to end — market volume and rank and share from SQP,
spend from the search-term report:

```
term                          mkt  volume  mktRank    share   ourASINs  week        spend30d
giacca moto estiva uomo       IT     4539       #1    0.700%     10     2026-07-19   €89.64
giacca moto uomo              IT     1707       #2    1.520%      9     2026-07-19  €100.95
giacca moto                   IT     1177       #3    1.170%      8     2026-07-19   €50.19
giubbotto moto uomo estivo    IT      816       #6    1.140%      6     2026-07-19   €14.72
accessori moto                IT     7615      #20    0.040%      2     2026-07-19    €1.34
gilet refrigerante            IT     3052      #52    0.000%      1     2026-07-19    €0.00
dainese                       IT     1192      #47    0.390%      4     2026-07-19    €6.34
```

- **All 97 have SQP history. Zero have an SQP row less than 14 days old. 65 have paid spend.**
- **Ten of our ASINs compete on `giacca moto estiva uomo`** — the #1 query in the Italian market,
  where our best one holds **0.7 %**. The earlier study saw 3 ASINs on a Spanish query; the Italian
  picture is more than three times worse. This is the operator's *"three similar products competing
  for one keyword"* question, and it is measurable — **from SQP only**, because
  `AmazonAdsSearchTerm` has no ASIN column.
- Across the whole latest stored week: **9 of 74** query × market pairs carry more than one of our
  ASINs.

---

## 5 · Industry research — features **and** interface

The existing competitor work (`2026-08-04-ads-market-research.md`, `2026-08-04-competitor-deep-dives.md`)
covers ads platforms; the SOV study covers share-of-voice definitions and the enterprise tier. This
section covers **rank tracking specifically, and what the screens look like**. It extends, it does
not repeat.

### 5.1 The mechanism, stated once

**There is no rank API.** Every product below that shows organic position collects the search
results page on a cadence. The differentiators are cadence, keyword allowance, what else is on the
row, and whether anything acts on the number.

### 5.2 The specialists

| tool | how it gets data | cadence | price | keywords |
|---|---|---|---|---|
| **Helium 10** Keyword Tracker | own collection | daily; **hourly for 10 days via Boost** | Platinum **$99/mo**, Diamond **$279/mo** (older tiers quoted at $79/$229 and a retired $29 Starter — the pricing pages disagree, check before buying) | 2,500 (Platinum) / 5,000 + 250 Walmart (Diamond); add-on from **$19/mo** |
| **Jungle Scout** Rank Tracker | own collection | daily | bundled in the main plan | — |
| **SellerSprite** | own collection | daily | **$39/mo** Basic | — |
| **DataHawk** | own collection | daily, **20+ marketplaces** | **no public price**; credit-based (1 tracked product *or* keyword = 1 credit), **annual only**, quote by sales volume | by credit |
| **AMZ Tracker** | own collection | daily | **$50 / $100 / $200 / $400** per month | by tier |
| **Ad Badger** | ads API + rank | daily | from **$108/mo** | — |
| **Intentwise** | scrapes page one **4×/day** | 6-hourly | **no public price**; Explore (AMC) from ~$1,000/mo, Analytics Cloud from ~$1,500/mo | — |
| **Pacvue / Skai / CommerceIQ / Perpetua** | enterprise shelf feeds | daily–real-time | enterprise, quote-only | — |

### 5.3 What the screens actually look like

**Helium 10 — Keyword Tracker.** One table, one row per tracked keyword. Columns: **Organic Rank ·
Sponsored Rank · Search Volume · CPR** (their "sales needed to reach page one" number) **· Competing
Products · Relative Rank** (your position *versus the competitor ASINs you added*). Above the table
sit **scorecards** — how many tracked keywords are in the top 10 and top 50, and their combined
search volume. Keywords carry **tags and notes**; the rank-history timeline is designed to be read
against events ("ranking moves after price changes, ad pushes, and listing edits"). Competitors are
added explicitly and compared side by side. **Alerts are rule-shaped** — the marketed example is
*"a competitor ranks 1–20 and I don't rank"*. Amazon PPC data can be shown on the same keywords.
There is a documented **Keyword-Tracker-based bid-automation rule** for Amazon Ads — the same
Tier 3 idea this repo already has substrate for.
**Steal:** the top-10/top-50 scorecard — a two-number summary above a long table is the fastest
"is this getting better" read there is, and it costs one query.
**Avoid:** CPR. A proprietary composite that nobody can audit is the opposite of this repo's
house style, and the first question it invites is "how is that calculated".

**Jungle Scout — Rank Tracker.** Sortable by **Overall / Organic / Sponsored** rank, with **Search
Volume (Exact)**, **Search Volume (Broad)** and **Last Checked** columns. Many keywords plot on
**one graph** for pattern-spotting; a per-keyword **slide-out panel** shows organic rank, sponsored
rank and search volume over a chosen window (30/60 days or custom). Graphs take **annotations**, so
a listing edit or a price change is marked on the timeline. A **heatmap** colours the keyword set by
rank intensity. Independently tested at 100 % position accuracy within ±1 of manual checks.
**Steal:** the **`Last Checked` column**. It is the cheapest possible honesty about freshness and
it belongs on any row whose source can go stale — which is every row on this page.
**Avoid:** two search-volume columns (exact + broad) with no stated definition; two numbers
labelled almost the same is how the SOV column got where it is.

**Intentwise.** Six tabs — **Overview · Brands · Keywords · Products · Daily Tracker** — with
non-branded keywords as the **default** filter, pin/unpin up to 10 competitor brands, and a
**colour-scaled daily grid** you scan for change rather than read. Saved filters, row pinning, CSV/
Excel export, 13 months of history. *(Detail carried from the SOV study, §6.4 — not re-derived.)*
**Steal:** branded excluded by default. Our 10 protected brand terms would flatter every number on
this page if mixed in.
**Avoid:** six tabs. This operator has asked for flat grids and minimal chrome; six tabs is the
information architecture of a tool that has given up on one screen.

**Pacvue.** Keyword rank, compliance and Buy Box live in the *same* platform as bid management, and
**Share of Shelf** deliberately combines paid and organic. Rules can fire on organic share of voice
alongside stock level and Buy Box. Reviewers consistently praise the clarity and criticise the lack
of granular customisation.
**Steal:** rank sitting next to the write path, so the number has somewhere to go.
**Avoid:** the dashboard-first framing. A chart nobody acts on is the failure mode every vendor in
this table markets against, including Pacvue.

**Ad Badger.** One dashboard, PPC metrics *and* organic rank position, organic sessions and click
share on the same row, with historical trend. Bid rules trigger off live keyword data.
**Steal:** organic and paid on **one row**. Showing one without the other is the most common
complaint about every tracker in this category — a falling organic rank means fix the listing, a
falling ad rank means raise the bid, and they are different jobs.
**Avoid:** the single-dashboard-for-everything shape at our data volume; it works for them because
they have one signal per keyword and we have five with three different freshnesses.

### 5.4 The 2026 feature bar, and where we stand

| # | bar | us |
|---|---|---|
| 1 | Organic **and** sponsored position on one row | ❌ neither exists |
| 2 | Freshness stated per row (`Last Checked`) | ❌ — and we need it most, with sources 2 and 17 days old on the same row |
| 3 | A curated watchlist, not everything | ⚠️ 97 terms exist, `enabled=false`, unread by this tab |
| 4 | Branded excluded by default | ⚠️ 10 protected terms exist, unused as a filter |
| 5 | Competitor ASINs/brands side by side | ❌ SQP tells us our share, never who holds the rest |
| 6 | Multi-marketplace, tracked independently | ✅ IT/DE/ES/FR present in every source |
| 7 | Hourly for launches, daily steady-state | ❌ weekly at best |
| 8 | Rank → action, not rank → chart | ⚠️ `KEYWORD_RANK_BID` is wired end-to-end with 0 rules |
| 9 | Colour-scaled trend grid over precise single values | ❌ |
| 10 | Export | ❌ on this tab |

**Where we would beat all of them:** none of these has Brand Analytics share, ad spend, the PIM
catalogue and the write path in one system. Helium 10 can tell you that you are #14. Only this
system can tell you that you are #14 on a 4,539-volume query, that **ten of your own ASINs** are
splitting 0.7 % of its impressions, and that you spent €89.64 on it last month.

---

## 6 · The organic-rank decision, costed

Organic rank is the only column that cannot come from data already owned. Four honest routes.
**Building a scraper is excluded by instruction and is not costed.**

**Working volume for every price below:** 100 curated keywords × 4 markets × 1/day
= **400 requests/day ≈ 12,000/month**. That is the Tier-1 watchlist, not the 299 we bid on and not
the 7,799 SQP knows.

### Option A — a SERP data API (buy a parsed results page)

| vendor | list price | our 12k/month | what you get |
|---|---|---|---|
| **Oxylabs** (now also owns ScrapingBee) | $0.80–$1.00 per 1,000 SERP queries; Amazon-specific ≈ $1.25–$1.35 per 1,000 | **≈ $10–16/mo** | parsed results incl. position |
| **Bright Data** | $0.75/1k Web Scraping API; Web Unlocker $1.30–$1.50/1k; SERP API $499/mo for 380k | **≈ $9–18/mo** pay-as-you-go | parsed results |
| **Rainforest API** | entry $66/mo; Production $375/mo for 150k; overage $0.0118/request, **1.5–3 credits per request** | **$66/mo entry**, or ≈ $142/mo at pure overage rate | parsed results with position **and sponsored-slot flags** |
| **ScrapingBee** | Google Search API from $49/mo | ≈ $49/mo | Google-first; Amazon via generic scraping |

**Fit:** `KeywordRank.source` was designed for exactly this — a vendor id per row, one row per
observation. The POST route already ingests the exact shape (`keyword, marketplace, asin,
organicRank, sponsoredRank, searchVolume, capturedAt, source`). **No schema change. No new table.
A scheduled job that calls a vendor and POSTs.**
**Cost:** ~$10–70/month at the Tier-1 watchlist. Scaling to all 299 bid keywords triples it; to
7,799 SQP queries it is ~$250–900/month at these rates.
**Risk:** these vendors fetch Amazon's pages on your behalf. That is a commercial-terms question for
the operator, not a technical one, and it should be answered before money moves.

### Option B — a rank-tracker subscription (buy the product, not the feed)

| vendor | price | catch |
|---|---|---|
| Helium 10 Platinum | $99/mo, 2,500 keywords | **no rank API on standard plans** — the data lives in their UI |
| SellerSprite Basic | $39/mo, covers IT/DE/FR/ES | same |
| AMZ Tracker | $50–$400/mo | same |
| DataHawk | quote-only, annual, credit-based | **does** push to BI tools (Power BI); closest to a feed |

**Fit:** cheapest way to *see* the number tomorrow; the worst way to get it *into this page*.
Everything this repo does well — joining rank to our SQP share, our spend and our catalogue, and
arming a rule on it — needs the number in our database. Only DataHawk plausibly delivers that, and
only at an unpublished annual price.
**Verdict:** a good stopgap for the operator personally; not a data source for this page.

### Option C — import the console-only Search Term Impression Share report

Fills **Sponsored** visibility, not organic. **Cost: €0** and one operator download a week.

What the report actually contains, per Perpetua and Amazon's own release notes:
**Search Term Impression Rank** (numeric rank of *your account-wide* impression share against all
other advertisers) and **Search Term Impression Share** (your account-wide % of total impressions),
alongside CPC, CVR, CTR. Rows appear **per campaign / ad group**, so a search term across several
ad groups needs summing. Downloaded from Seller Central → Reports → Advertising Reports → Create
Report → Search Term Impression Share.

⚠ **Two caveats the earlier study did not state.** The share is **account-wide, not campaign-level**
— the per-campaign rows are a breakdown of one account number, not per-campaign shares. And
"impressions" here is total *advertiser* impressions, which is a **relative** volume signal only.

**Fit:** the `AdsConsoleImport` / `AdsConsoleRow` pattern already exists — upload → PREVIEW → commit,
with a per-row error CSV (`advertising-intel.routes.ts:817-860`,
`ads-console-import.service.ts`). But `AdsConsoleRow` has **no impression-rank or impression-share
column**, and its natural key requires `campaignId`. So this is *the pattern* reused, not the table:
a new `format` plus columns, or a small sibling table.
**Verdict:** the honest sponsored-visibility number, free, manual, weekly. Worth doing, and worth
being clear that it is not organic rank.

### Option D — do without organic rank; track share instead

Impression share from SQP, plus `topOfSearchIS` from the placement report, already answer *"are we
visible on this term, and is it moving"* — which is the decision organic rank is usually a proxy
for. **Cost: €0.** It requires renaming the tab's promise, and it leaves one question genuinely
unanswered: *"we are on page 3 and the listing, not the bid, is why."*

### Recommendation

**C + D now, A when the watchlist is real.** C and D cost nothing and make the page honest and
useful this week. A becomes worth $10–70/month **only after** Tier 1 has established which 100
keywords matter — buying rank for 7,799 queries we cannot act on is the expensive version of the
same mistake this tab already made. **B is not a data source.**

---

## 7 · How this page should be

> **One question: on the keywords I chose, are we on the page — and is it moving?**

### 7.1 What belongs here, and what belongs on Share of Voice

The two tabs render from one component and ask one question at two altitudes. The operator has
decided they stay separate pages; **the merge is not re-proposed.** The boundary that keeps them
from drifting:

| | **Keyword Tracker** | **Share of Voice** |
|---|---|---|
| the unit | **a keyword I chose to watch** | **a query we already paid on** |
| the population | a curated watchlist (97 + 10 protected + additions) — bounded, edited by hand | everything with paid traffic in the window — 1,999 pairs, discovered, not chosen |
| the question | *are we on the page for this term, and is it moving* | *where is our ad money going, and where are we losing the auction* |
| the primary axis | **time** — Δ per keyword | **breadth** — rank the queries against each other |
| owns | the watchlist itself, per-keyword history, rank-vs-share labelling, alerts on movement | the `outbid` / `weak-relevance` flags, the 1,117 unbid queries, spend distribution |
| must **not** own | a "what should I bid on" discovery list | a curated watchlist, or per-keyword history |

**The one thing they must share or they will drift:** the definition and the label of every share
number. `impressionShare` (SQP, market denominator), `sovPct` (our own ad-traffic mix) and
`topOfSearchIS` (Amazon's top-slot share, campaign grain) are **three different quantities**. If one
page calls any of them "Share of Voice" and the other does not, the section is back where the SOV
study found it. This is a shared-vocabulary requirement, recorded in §8.

### 7.2 The page

**One flat grid. One row per keyword × market.** No sub-tabs, no segmented control. The
[ Rules | Report ] toggle goes: rules for this trigger belong on the Automations page, which is
where all 51 already live, and a segment that has never been able to render a row is not a
navigation aid.

Columns, in order, every one backed by data measured in §4:

| column | source | grain | age today |
|---|---|---|---|
| Keyword | watchlist | — | — |
| Market | watchlist | — | — |
| Market volume | SQP `searchQueryVolume` | query × week | 17 d |
| Market rank | SQP `searchQueryRank` | query × week | 17 d |
| **Our impression share** | SQP `impressionShare`, best ASIN | query × ASIN × week | 17 d |
| Δ share (wk/wk) | SQP, two weeks | query × ASIN | computable on 253–376 keys, **6** at the top of the table |
| Click share · Purchase share | SQP | query × ASIN × week | 17 d |
| **Our ASINs on this query** | SQP row count | query × week | 17 d |
| Top-of-search IS | `AmazonAdsPlacementReport.topOfSearchIS` | **campaign × day** | **2 d** |
| Spend 30 d · Clicks · Orders | `AmazonAdsSearchTerm` | query × day | **2 d** |
| **As of** | per-source max date | — | — |
| Organic rank · Sponsored rank | `KeywordRank` | keyword × market | **absent until §6 is decided** |

Six laws this grid follows:

1. **Where we have share, the column says share. Where we have position, it says position.**
   Never one wearing the other's label. This is the defect class the SOV study found and the one
   this tab would repeat by keeping a column called "Organic Rank" filled with an impression share.
2. **Every row states the age of what it shows.** Jungle Scout's `Last Checked`, made mandatory
   because this row mixes a 2-day source and a 17-day source. Stale is a *value*, not an absence.
3. **A blank is not a zero.** 151 of 299 bid keywords have no SQP trace at all. A row with no data
   says *"not measured"*; a row measured at zero says `0.00 %`. `—` for both is how the current tab
   reads as broken rather than empty.
4. **Every row links out** — to the campaigns bidding on the term, and to the ASINs competing on it.
   The ten-ASIN row is only actionable if you can reach the ten ASINs.
5. **Branded terms are filtered out by default**, using the 10 `AdKeywordProtection` whitelist terms,
   with a visible toggle. Our own brand flatters every share number on the page.
6. **Nothing on this page spends money without a full sentence.** Read-only columns stay dense and
   quiet; the two controls that can move money (arm a rule; change a bid from a row) explain what
   they will do, to how many campaigns, and whether it can be undone.

**Above the grid, two numbers and one sentence** — the Helium 10 scorecard idea, at our altitude:

> **Watching 97 terms in IT.** 12 with impression share above 1 % · 41 above 0 %.
> Share data from the week of **26 Jul (17 days old)**; spend and top-of-search share from **9 Aug**.

That sentence is the whole freshness contract, stated once, and it is the thing the RD study found
missing from the rank engine.

### 7.3 Day one, with `KeywordRank` empty and SQP 17 days stale

The page must be useful on the data that exists **this morning**, not after any decision in §6.

- **74** query × market pairs in the latest stored week — enough to render, not enough to be the
  page. So day one seeds the watchlist from the **97 curated terms**, all of which have SQP history
  even though none is fresher than 14 days.
- Every share column renders against the **latest week that has data per market**, with its date on
  the row. Not `MAX(startDate)` silently, the way the rank engine does it.
- **Δ share renders where it can and says why where it cannot** — 6 comparable keys against the
  latest week, 253 against the one before.
- **Top-of-search IS, spend, clicks and orders are 2 days old and render normally.** They carry the
  page while SQP is stale.
- **Organic Rank and Sponsored Rank do not appear at all** until there is a source. An empty column
  is a promise; a missing column is a decision.
- The empty state, when a watchlist term has nothing: *"Not measured — this term has no Brand
  Analytics row. 13 of our 250 advertised Italian ASINs are covered by the weekly feed."*
  Not *"ingest ranks via POST /advertising/keyword-ranks"*, which is the current text and is an
  instruction nobody will follow twice.

### 7.4 The URL contract (this page's own params only)

Every view linkable; the page owns these, the shared layer owns market and date (§8):

```
/marketing/ads/rules-automation/keyword-tracker
  ?list=<watchlistId|coverage-set-id>   which watchlist   (default: the one coverage set)
  &q=<text>                             search within the grid
  &branded=0|1                          include brand terms (default 0)
  &measured=all|yes|no                  hide terms with no share data (default all)
  &sort=<column>&dir=asc|desc
  &kw=<keyword>                         opens the per-keyword history panel
  &page=<n>
```

`?kw=` is the one that matters: a keyword's history panel must be linkable on its own, because it
is the thing an operator pastes into a message. Absent params mean the default, never a stored
preference — a link must render the same view for whoever opens it.

---

## 8 · Requirements on the shared layer

**Stated as constraints, not solutions.** The tab bar, `AdsDataGrid`, `AdsPageHeader`, the scope
form and the state/sync layer are shared by all eleven pages; a twelfth pass reconciles these.

**R1 · Market must survive navigation between the eleven pages, without a reload.**
Today it does not. `RulesAutomationClient.tsx:93` holds `const [market, setMarket] = useState('all')`
— per-page local state, seeded from whichever campaigns happened to load. Meanwhile
`AdsMarketplaceProvider` **already exists**, is mounted in `marketing/ads/layout.tsx` (so it wraps
all eleven pages), resolves from `GET /advertising/connections`, persists to
`localStorage['nexus.ads.marketplace']`, exposes `ready` so no control reads a market still being
guessed at, and distinguishes **launchable (DE/ES/FR/IT) from sandbox (IE/NL/PL/SE/UK)**. It is
consumed only by the five campaign builders. Its own header comment says it was built because
*"each analytics page kept its own local market filter … so nothing agreed with anything else."*
**This page needs that guarantee; it does not need a new mechanism.**

**R2 · Market must also be linkable.** The provider persists to `localStorage`, which is per-browser
and invisible in a URL. This page's views are meant to be pasted to a colleague. Whatever the shared
layer chooses, a link must carry its market — and `localStorage` and the URL must not be able to
disagree about which market is on screen.

**R3 · The shared layer must expose data freshness per source, not per page.** This page renders
one row from sources 2 and 17 days old. It needs, for the selected market: the latest
`SearchQueryPerformance.startDate` and its `ingestedAt`, the latest `AmazonAdsSearchTerm.date`,
and the latest `AmazonAdsPlacementReport.date` with a non-null `topOfSearchIS`. At least three other
pages need the same thing (RD needs it for the rank engine's signal age). **A per-page fetch of this
will drift; one source will not.** No recency guard exists anywhere today —
`sqpImpressionShareForAsins` takes `MAX(startDate)` with no age check, which is how a 17-day-old
number reaches a live optimisation loop looking fresh.

**R4 · A change made on one page must reach the others without a reload.** Concretely for this
page: adding a term to the watchlist here must appear on Share of Voice; arming a rule from a row
here must appear on Automations. I am **not** proposing the mechanism — URL params, a provider, SSE,
polling and a cache layer all satisfy it and the choice binds all eleven pages. The constraint this
page adds to that choice: **its data is expensive to recompute** (the day-one grid is a full scan of
`SearchQueryPerformance` joined to a 30-day `AmazonAdsSearchTerm` groupBy), so it must be able to
refresh *its own* rows on a targeted signal rather than re-fetching on every cross-page event.

**R5 · The date range must not appear on this page until it changes something.**
The standing law from the reverted scope bar — *a control earns its place only if a pixel changes
when you move it* — applies with a twist here: SQP is **weekly**, spend is **daily**. A single date
range over both is a two-vocabularies defect waiting to happen. If the shared layer puts a date
control on this page, this page needs **week granularity for the share columns and day granularity
for the spend columns**, and it must be visible which one a given control moves. Note also the
existing trap: `_shell/DateRangePicker.tsx`'s `DATE_PRESETS` and `ads-core/date-range.ts`'s
`RangePreset` are different vocabularies that share only `today` and `yesterday`.

**R6 · `_shared/tabs.tsx` needs three `RULE_TAB_ACTION_TYPES` corrections, and they are not
cosmetic.** `'keyword-tracker': ['keyword-tracker']` and `'sov': ['sov']` must be added (the
builder writes the slug as the action type — §2.2 D1), and `RulesAutomationClient.tsx:391`'s
`liveType="keyword-harvesting"` must become `'keyword-harvest'`. Three tabs currently filter every
rule out of themselves. **I have not touched that file; it is shared.**

**R7 · Rule scope must reach this page's trigger, or the scope UI must say it cannot.**
Portfolio-, campaign- and product-scoped rules on `KEYWORD_RANK_BID` and `SOV_BID` **never fire**
(§2.3) because those context builders emit no campaign identity. Either the context builders gain
`campaign: { id }` / `adGroup: { id }` — which they can, since every target already joins through
`adGroup.campaign` — or the scope form must refuse those grains for those triggers and say why.
**Silently accepting a scope that disables the rule is the worst of the three options.**

**R8 · Grid capabilities this page needs from `AdsDataGrid`** (all believed present, listed so the
reconciliation can confirm): per-column sort with an explicit `sortValue`, client search, row
selection with a selection bar, `toolbarLeft`/`toolbarRight` slots, and **CSV export** — which this
page needs and the current tracker does not offer.

---

## 9 · Tiered plan

### Tier 0 — honesty, on today's data · **hours, no new source, no new backend**

| # | change | unlocks |
|---|---|---|
| 0.1 | **Feed the Report from SQP + `topOfSearchIS` instead of the empty `KeywordRank`.** | 74 real rows today, 97 watchlist terms with history, a 2-day-old paid-visibility column |
| 0.2 | **Drop Organic Rank and Sponsored Rank** until §6 is decided; add **As-of** per row | the grid stops promising what it cannot deliver |
| 0.3 | **Rename honestly** — share is share, position is position | removes the defect class the SOV study named |
| 0.4 | **Week-over-week share Δ**, rendered where computable and explained where not | the "is it moving" half of the page's one question |
| 0.5 | **Remove the three fake write controls** (bulk Automation/Criteria/Frequency/Delete on the Rules segment; Remove on the Report) or wire them | a Delete button that says "cannot be undone" and does nothing is the top D4 violation on this surface |
| 0.6 | **Brand terms filtered out by default** using the 10 protected terms | every share number stops being flattered |

### Tier 1 — recover the feed and choose the list · **days**

| # | change | why |
|---|---|---|
| 1.1 | **Raise the SQP ASIN limit and stop iterating the 5 sandbox markets** | 10 of 252 Italian ASINs is the whole reason the table looks dead. This is `limit` and a market filter, not a rewrite |
| 1.2 | **Surface `failedAsins` / `rows` / `asinsRequested` in the cron summary** | `ok=4 failed=5` has been constant for 71 runs and can never signal anything |
| 1.3 | **Diagnose today's `rows=0`** via `sqpDebugState` and the `[sqp] asin report failed` warnings | 40 reports produced nothing this morning and nothing on screen says so |
| 1.4 | **Seed the watchlist** from the 97 coverage terms + 10 protected terms; make it editable | a tracker over 100 chosen keywords is a product; over 7,799 it is a bill |
| 1.5 | **Import the console STIR report** (§6 option C) using the `AdsConsoleImport` pattern | an honest sponsored-visibility number, €0, weekly |
| 1.6 | **Export CSV** | table stakes; every tool in §5 has it |

*Not in this page's scope but blocking its accuracy, already recommended by the RD study: a recency
guard on `sqpImpressionShareForAsins`.*

### Tier 2 — the decision · **§6**

Buy a SERP feed (~$10–70/month at the Tier-1 watchlist) and write it into `KeywordRank` through the
POST route that already exists — **no schema change** — or accept share as the answer and rename the
page. Ask the commercial-terms question before the technical one.

### Tier 3 — rank drives bids · **after Tier 1 or 2**

`KEYWORD_RANK_BID` is wired end to end with 0 rules: builder → adapter → `bid_apply` → write gate.
Once any rank-like signal flows this is a rule definition, not a build. **Three fixes must land
first or the first rule will be wrong:**

1. the context must carry real spend/ACoS (§2.2 D4) — today it reads 0 for all 2,129 targets;
2. the context must carry campaign identity, or scope must refuse the three grains it silently
   breaks (§2.3, R7);
3. the rule needs a spend ceiling at creation — today only `isBudget` rules get
   `maxDailyAdSpendCentsEur`, and the operator's decision is spend ceilings per scope with a refusal
   at the cap.

---

## 10 · Open questions

1. 🔴 **The SQP ASIN limit — raise it, and to what?** 10 per market covers 13 % of advertised
   Italian ASINs. Going to 50 costs ~25 minutes more Amazon report time per market per night on a
   job that already runs 40 min–3.5 h. This is the single highest-value change behind this page and
   it is one number.
2. 🔴 **Organic rank — buy, import, or do without?** §6. If buy: ~$10–70/month at 100 keywords ×
   4 markets, and it needs your answer on whether a third party fetching Amazon pages on our behalf
   is acceptable. If do without: the page is a **share** tracker and should be named one.
3. **Which keywords are the watchlist?** The 97 coverage terms (all have SQP history, none fresh),
   the 10 protected terms, the 299 we bid on (151 of which SQP has never seen), or a list you keep
   elsewhere?
4. **Ten of our ASINs on `giacca moto estiva uomo`** — the #1 Italian query, our best ASIN at 0.7 %.
   Is consolidating that a decision you want this page to *surface*, or one you want it to *act on*?
   The two produce different pages.
5. **The three fake write controls (§2.2 D2) — remove or wire?** They are shared with four other
   rule-type tabs, so this is a section-level call, not mine.
6. **Should this page show `topOfSearchIS` at all?** It is fresh and real, and it is **campaign**
   grain on a page whose row is a **keyword**. I think yes, clearly labelled as a lane average — but
   it is the one column on my proposed grid where I am putting a coarser number next to finer ones.

---

## Appendix A — scripts

| script | measures |
|---|---|
| `_kt-page.mts` | `KeywordRank`; rule/trigger/action-type census; `AdTarget` metric population; SQP feed state; `CronRun` evidence; env flags; the three candidate keyword universes and SQP's coverage of each; marketplace vocabulary; the day-one grid; week-over-week comparability; spend per query |
| `_kt-page-sqp-diag.mts` | rows/ASINs/queries per SQP week with ingest timestamps; the last 12 `sqp-ingest` runs verbatim; which 9 markets the cron iterates and which have listings; the exact 10 ASINs requested per market; advertised-vs-covered ASINs; signal age per market |
| `_kt-page-signals.mts` | `topOfSearchIS` population, range and per-market averages; `tos-is-ingest` runs; bid-keyword ↔ SQP-query vocabulary overlap; one fully assembled watchlist row per coverage term; freshness of every signal; the complete `KeywordRank` read/write list |

All read-only. Run from `apps/api` with
`NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/<name>`.

Prior studies cited rather than re-measured: the 51-rule census, write volumes, the autonomy
contract, and the SOV column defect (`2026-08-11-kt-keyword-tracker-study.md`,
`2026-08-11-sov-share-of-voice-study.md`, `2026-08-11-rd-rank-dayparting-study.md`,
`2026-08-11-hv-keyword-harvest-study.md`, `2026-08-10-ads-rules-automation-ra.md`).
**Re-measured because I doubted them:** the SQP cron's existence and health (§3 — the prior finding
was wrong), and `topOfSearchIS` population (§4.2 — the in-code comments were stale).

## Appendix B — sources

- [Helium 10 Keyword Tracker](https://www.helium10.com/tools/keyword-research/keyword-tracker/) ·
  [Keyword Tracker overview (KB)](https://kb.helium10.com/hc/en-us/articles/27744441024923-Keyword-Tracker-Introduction-and-Overview) ·
  [Keyword-Tracker-based bid automation rules (KB)](https://kb.helium10.com/hc/en-us/articles/49456794087323-Keyword-Tracker-Based-Bid-Automation-Rules-for-Amazon-Ads) ·
  [Boost — hourly for 10 days](https://www.helium10.com/blog/track-keyword-ranking-on-amazon-boost-keyword-tracker/) ·
  [Plans & pricing](https://www.helium10.com/pricing/) ·
  [Pricing breakdown 2026](https://revenuegeeks.com/software/helium-10/pricing)
- [Jungle Scout Rank Tracker](https://www.junglescout.com/features/rank-tracker/) ·
  [Keyword rank performance graph (help)](https://support.junglescout.com/hc/en-us/articles/29898624445335-Keyword-Rank-performance-graph) ·
  [Rank Tracker features review](https://jordiob.com/amazon-tools/product/jungle-scout-rank-tracker/)
- [SellerSprite review 2026](https://www.sellersprite.com/en/blog/sellersprite-review-2026) ·
  [Rank-tracking tools compared](https://www.sellersprite.com/en/blog/Rank-Tracking-Tools-Comparison)
- [DataHawk keyword rank tracker](https://datahawk.co/seo/keyword-ranking/) ·
  [DataHawk pricing 2026](https://hackceleration.com/labs/datahawk-pricing) ·
  [DataHawk on Amazon SOV](https://datahawk.co/blog/retail-analytics/share-of-voice/)
- [Ad Badger — best keyword trackers 2026](https://www.adbadger.com/blog/best-keyword-tracker-2026-top-tools-for-ppc-amazon/) ·
  [Ad Badger pricing review](https://scaleinsights.com/learn/ad-badger-pricing-review)
- [AMZ Tracker pricing](https://www.webretailer.com/reviews/amz-tracker/) ·
  [Intentwise pricing (G2)](https://www.g2.com/products/intentwise/pricing) ·
  [Intentwise review 2026](https://revenuegeeks.com/software/intentwise)
- [Pacvue digital shelf optimization](https://pacvue.com/platform/digital-shelf-optimization/) ·
  [Pacvue market & competitive intelligence](https://pacvue.com/platform/market-competitive-insights/)
- **Search Term Impression Share:**
  [Amazon Ads announcement](https://advertising.amazon.com/resources/whats-new/search-term-impression-report-sponsored-products) ·
  [Perpetua — how to use the report](https://perpetua.io/blog-amazon-search-term-impression-share-rank-report/) ·
  [amzn/ads-advanced-tools-docs #244 — still unsupported in the API, acknowledged 2024-04-05, open in 2026](https://github.com/amzn/ads-advanced-tools-docs/discussions/244) ·
  [Intentwise data-source page](https://www.intentwise.com/analytics-cloud/data-source/amazon-ads/sponsored-products-search-term-impression-share-report)
- **SERP data APIs:**
  [Rainforest API](https://trajectdata.com/ecommerce/rainforest-api/) ·
  [Rainforest pricing analysis](https://www.naproxy.com/blog/rainforest-api-pricing/) ·
  [Scraping API pricing compared 2026 — Bright Data vs Oxylabs vs Apify](https://scrapewise.ai/blogs/scraping-api-pricing-comparison-2026) ·
  [Best Amazon scraper APIs 2026](https://scrape.do/blog/best-amazon-scraper-api/) ·
  [Keepa pricing 2026](https://revenuegeeks.com/software/keepa/pricing)

---

## KT.1 — built

**Shipped and verified on production 2026-08-11/12.** Session slug `kt1`.
Route: `/marketing/ads/rules-automation/keyword-tracker` ·
Endpoint: `GET /advertising/keyword-tracker` (in `advertising-intel.routes.ts`).

Three commits: the endpoint (`31cba2535`), the page (`f6f526dda`), two measured UI defects
(`5a24ef3aa`). Measured with `_kt1-probe.mts`, `_kt1-period.mts`, `_kt1-endpoint.mts` — all
read-only and re-runnable.

### What is live

| | |
|---|---|
| the tab | now `routed: true` in `_shared/tabs.tsx`; the `keyword-tracker` branch is gone from `RulesAutomationClient` (the `share-of-voice` branch stays, and `SovTrackerTab`/`TrackerTab` are untouched) |
| the grid | six columns on `AdsDataGrid`: Keyword · Market · Market volume · Market rank · Our impression share · As of |
| the scope spine | market → line → portfolio → campaign, cascading, most specific wins — one pure function, ~~8~~ **7** tests (🔴 corrected, KT.1b: counted, not remembered; KT.1's suite was 7 scope + 4 period = 11) |
| the URL | `?market &line &portfolio &campaign &list &branded &measured &sort &dir &kw` — every view linkable, absent param = default |
| the sentence | states the resolved scope, the age range of the share data, and the age of the paid data that is *not* on the grid yet |
| default view (IT) | **97 rows, 97 measured, 47 terms carrying more than one of our own ASINs**, one real zero. 702 ms |

### 🔴 One thing measurement overruled: the row's period

The brief said *take the latest SQP period that has rows for that market*. Measured, that renders
an empty product. **The latest period is 2026-07-26 in all four markets, and it holds 8 rows in IT,
5 in DE, 71 in ES, 1 in FR.** Against the 107-term watchlist:

| rule | IT | DE | ES | FR |
|---|---|---|---|---|
| **A** market-latest (the brief, literally) | **2** measured / 105 blank | 0 / 107 | 0 / 107 | 0 / 107 |
| **B** term-latest inside a 56-day lookback ← **built** | **98** / 9 | 7 / 100 | 1 / 106 | 0 / 107 |
| **C** term-latest, unbounded | 98 / 9 | 8 / 99 | 3 / 104 | 3 / 104 |

The period *before* the latest (2026-07-19) holds 655 IT rows and 95 of the 97 curated terms. So
each row reads the newest period, inside a bounded lookback, that actually holds a row for **that
term** — and carries its own `asOf` + `asOfAgeDays`. This is what the row's `asOf` field and the
grid's third law ("every row states the age of what it shows") are for; the grid's toolbar states
`2 weeks in view` when rows span periods, and the sentence gives the range (`19 Jul–26 Jul,
16–23d old`).

The lookback is bounded at 56 days on purpose: unbounded, IT gains nothing and DE/ES/FR gain 6
terms whose newest row is 58–87 days old. Those are not "how are we doing" numbers.

**This corrects §7.3 of this study**, which said the grid renders "against the latest week that has
data per market" and that day one holds "74 query × market pairs". Both are true only when read
across all four markets at once — §4.1's own table already shows the 26 Jul week as IT 8 · DE 5 ·
ES 71 · FR 1, so 71 of those 85 rows are Spanish, and **scoped to one market, which is how the page
works, the latest week is nearly empty.** The 7 sample rows in §4.5 are themselves from 19 Jul.

### The rest of what was measured, and where it shows

- **The portfolio grain's hole is on screen.** 72 of 220 campaigns account-wide carry a
  `portfolioId`; in IT it is 54 of 150. A portfolio-scoped view states *"cannot see 96 of the 150 IT
  campaigns"* in amber, above the grid.
- **223 advertised products → 13 product lines** via `Product.parentId` (0 standalone). All 13 are
  offered, each with its variation count; a line with no campaign in the selected market is not
  offered at all.
- **A blank is not a zero, on real data.** IT holds exactly one measured zero
  (`gilet refrigerante`, market rank #52, 3,052 volume) — it renders `0.00%`. With `branded=1`, nine
  brand terms have no SQP row and render a `not measured` pill with `no row in window` as their date.
- **`branded=0` is the default** and excludes the 10 protected terms. None of the 97 curated terms
  *contains* a protected term, so the filter costs exactly the 10 brand rows —
  and it earns its place: `xavia` measures **5.45 % against a market volume of 3**.
- **The curated list is IT-only.** Read against DE/ES/FR the page says so in a note rather than
  implying the list was built for that market.
- **"All markets"** — the shared header offers it on every ads page and this grid cannot honestly
  render it (volume, rank and share are per-marketplace). The page says that and offers the four
  markets; the endpoint 400s with `market_required`.

### Two defects the build introduced and measurement caught

Both invisible to `tsc`, to the tests, and to a screenshot read at a glance:

1. **The page's real gutter is zero.** `.h10-hdr`, `.h10-rules-tabs` and `.h10-am-card` all sit at
   96→1698 of a 1728 px viewport (`h10-main`'s 30px padding is the gutter). A `margin: … 24px` made
   the scope bar and every note the only staggered blocks on the page. Now 0 — verified
   `alignedToCard: true`.
2. **The keyword rendered blue and is not a link.** `.h10-am-grid td.nm .t` (0,3,1) beats
   `.h10-kt-kw .t` (0,2,0), so a plain `color:` lost. Every other grid in this console makes that
   column a link; a keyword does not become one until KT.4. Overridden on specificity, not
   `!important`, so KT.4 deletes one rule.

Contrast re-measured on the live page for all 18 new text/chip styles, compositing the real
effective background and the ancestor opacity chain: **every one passes AA**, lowest 4.79.

### Deliberately left

- The `[ Rules | Report ]` segmented control does not come across (§7.2, and the Rules half has
  never been able to render a row).
- `KeywordRank`, Organic Rank and Sponsored Rank appear nowhere. A missing column is a decision.
- Δ share, spend/clicks/orders, top-of-search IS, the history drawer, the watchlist CRUD, export and
  any write path: KT.2–KT.7.
- Not touched, all recorded in §2.2/§8 and owned elsewhere: the `RULE_TAB_ACTION_TYPES` gaps (R6),
  `RuleListTab`'s fake bulk controls (D2), the missing `keyword-ranks` DELETE (D3), and
  `sqpImpressionShareForAsins`'s missing recency guard.
- **`page` is honoured by the endpoint (`limit`/`offset`, verified: no overlap, stable total) but
  the UI requests one page of 500 and lets the grid page a 107-row watchlist.** It becomes load-bearing
  in KT.2, when a watchlist can be large.
- **Naming.** Scripts and probes are `_kt1-*` per the session rule. The three product files
  (`keyword-tracker/page.tsx`, `KeywordTrackerClient.tsx`, `KeywordScopeBar.tsx`) and
  `keyword-tracker.service.ts` carry conventional names instead: they are permanent, they match
  `automations/`/`dayparting/`, and a session slug in a shipped filename outlives the session.
  Nothing they collide with existed.

### One number to re-check before KT.3 trusts it

`scope.resolved.asins` at **market** scope (250 in IT) is reported but does **not** filter the share
query — at market scope every SQP row for the market counts, which is right for
"how many of OUR ASINs are on this query" but means the ASIN count beside it is a scope size, not a
filter. Narrower scopes do filter on it. Worth one sentence of UI when a spend column arrives.

---

## KT.1b — fixed

**Shipped and verified on production 2026-08-12.** Session slug `kt1b`.
Measured with `_kt1b-period-gate.mts` (the constant space) and `_kt1b-verify.mts` (the fix and the
four corrections above) — both read-only and re-runnable.

### 🔴 The fix: one SQP period per view

KT.1's per-row rule ranked one week's population against another's. Measured on prod before the fix:

| view | periods on the grid | cross-period pairs | **inverted pairs** |
|---|---|---|---|
| IT · default | 2 (07-19 × 95, 07-26 × 2) | 190 comparable | **116** |
| IT · portfolio `IT_Gale` | 2 | 96 comparable | **81** |
| IT · campaign `Gale Jacket Yellow Only` | **5** | 921 comparable + **555 with no common week at all** | **167** |

*(An inverted pair = two terms whose displayed order is the opposite of their order on the newest
week where both actually have a row. The brief quoted 129 / 197 / 275; those are a different — and
unstated — definition, so the numbers above are mine, defined here and reproducible from the script.
The structural number is the one the fix drives to zero: **cross-period pairs**.)*

`giubbotto moto`, verbatim from the feed: **1.56 % on 07-19 → 0.01 % on 07-26, because its covered
ASIN rows went 4 → 1.** It rendered at share-rank **#92 of 97** while its rank on a week its
neighbours also have is **#11**. Nothing about that row was wrong except the week it came from.

**After:** the distinct `asOf` among measured rows is **1 in every scope and every market**, so
cross-period pairs — and therefore inversions — are **0 by construction**, not by luck.

| view | period | measured | no row this week | never measured |
|---|---|---|---|---|
| IT · default | 2026-07-19 (23d) | **97** | 0 | 0 |
| IT · portfolio `IT_Gale` | 2026-07-19 | **97** | 0 | 0 |
| IT · campaign `Gale Jacket Yellow Only` | 2026-07-19 | **25** | 45 | 27 |
| DE | 2026-07-19 | 2 | 6 | 89 |
| ES | 2026-07-12 (30d) | 0 | 3 | 94 |
| FR | 2026-07-12 | 0 | 3 | 94 |

IT's yield is **97 of 97**, not the 95–97 the brief estimated: every curated term has a 07-19 row.

### The constants, and the table they came from

`_kt1b-period-gate.mts` prints 4 ratios × 3 lookbacks × 4 markets, under two definitions of "a
normal week". **The definition mattered more than either constant:**

| | LOCAL median (over the lookback) | BASELINE median (last 12 periods) |
|---|---|---|
| ES, ratio 0.5, lookback 28d | picks **2026-07-26** — 71 rows, **17 % of a normal week** | **rejects everything** and says so |

A lookback-local median is dragged down by the very truncation it exists to catch. **BASELINE.**

| constant | chosen | why, from the table |
|---|---|---|
| `SQP_COMPLETENESS_RATIO` | **0.5** | Every ratio 0.3–0.6 rejects 2026-07-26 in all four markets (8 IT rows vs a 655 median · 5 DE vs 428 · 71 ES vs 414 · 1 FR vs 69), so the ratio is not what saves IT. What it decides is **ES 07-19 at 193 rows — 47 % of a normal week**: 0.4 accepts it, 0.5 takes the complete 07-12 week instead. Half a week of coverage is not a share. |
| `KT_LOOKBACK_DAYS` | **42** (was 56) | 42 and 56 pick the **same period in all four markets today**, so 42 is strictly tighter at zero cost, and it raises the truncated-week warning two weeks sooner if the feed keeps stalling. **28 was rejected**: it truncates ES *and* FR, both of which have a complete week 30 days back, and a complete week at 30 days beats a 17 %-complete week at 16. |
| `SQP_BASELINE_PERIODS` | **12** | A quarter of weekly history. A median over 11–12 periods absorbs one truncated week without moving (IT: 655 either way). |

**Both constants now have tests; the 56-day bound never did** — it lived in the orchestrator, not in
the period function. 19 tests: 7 scope + 3 archived-campaign + 9 for the gate, including the
local-vs-baseline divergence, both truncated branches, the no-data case, and `42 ≡ 56 today`.

🔴 **The truncated-week warning is not visible on today's data.** At the chosen constants no market
falls to that branch, so it is verified by unit test and **not by eye**. That is a gap, stated rather
than papered over: the first day the feed stalls for six weeks, that sentence renders untested in a
browser.

### The four things KT.1 shipped without saying

| # | what it now says |
|---|---|
| 3.1 | **The list is disabled.** `Xavia GALE IT — coverage` is `enabled: false`; the page names it and says no engine acts on it. Nothing filters on the flag — filtering would blank the page. |
| 3.2 | **A blank is two states.** `no row this week` (with **last seen DD MMM**, unbounded by the lookback — a date is worth stating at any age) vs `never measured`. With `branded=1`, `xavia` stops showing **5.45 % from 21 Jun** and becomes a blank that says so; that share was the defect in miniature. |
| 3.3 | **The footer carries the period, not the ingest stamp.** It printed *"Brand Analytics ingested 10 Aug"* under data from the week of 19 Jul, because `ingestedAt` is when a row was last re-upserted and the cron re-upserts old weeks nightly. `ingestedAt` stays in the payload for KT.5. |
| 3.4 | **The keyword stops behaving like a link.** KT.1 fixed the colour and missed `ads.css:695`'s `cursor: pointer` and `:696`'s hover underline. Two lines at the same specificity, deleted whole when KT.4 makes it a real link. |

### Also fixed, because each was one line and a true number

- **An ARCHIVED campaign no longer inflates the count.** The page prints **149** IT campaigns, not
  150, and the portfolio grain's "cannot reach" figure drops it too. It stays resolvable by an
  explicit `?campaign=` pick — the picker is fed by `/advertising/scope-options` (another session's
  route, unfiltered), and a pick that silently resolved to nothing is worse than one that resolves.
- **6.6 s → 1.6 s cold** (477 ms on a narrow scope). The period `groupBy` and the three freshness
  probes depend on nothing but `market`, so they joined the existing parallel batch instead of
  costing two more serial round trips.
- **The `Math.min()`-over-nothing → `Infinity`** in the client's freshness derivation is gone, not
  guarded: with one period there is one date to state, so the row-scan it lived in was deleted.

### Recorded, not fixed — and not this session's work

- 🔴 **`sort` / `dir` are read from the URL and never written back to it, and `AdsDataGrid` has no
  `useSearchParams`. So KT.1's "every view is linkable" claim is FALSE for sorting** — clicking a
  column header changes the grid and not the URL. Deep-linking a sort works; producing that link by
  clicking does not. Needs a shared-layer change (a sort callback on `AdsDataGrid`, which nine pages
  render). **The KT.1 record's claim is retracted to that extent.**
- `sort=asins` is accepted by the route and implemented in the comparator with **no matching grid
  column** — the count is a badge in the keyword cell. Harmless, and reachable only by hand-typing.
- The `lists` payload is returned and rendered nowhere; `?list=` is honoured but **unreachable from
  the UI**. → KT.2.
- **`reportPeriod` is unguarded.** All 15,075 rows are `WEEK` today (measured), so the period gate
  cannot yet be fooled — but one `MONTH` row would enter the candidate set and could win the
  newest-period pick.
- ASIN-coverage denominators, the summed-share bound, per-term ad coverage, the dated cliff banner
  and feed health → **KT.5**. Watchlist CRUD, the list picker and enablement → **KT.2**. The
  per-keyword history drawer — the right home for a term's newer-but-off-period data → **KT.4**.
- The throwaway `_kt1-*.mts` probes KT.1 committed are left in place; another session may be reading
  them. `_kt1b-period-gate.mts` and `_kt1b-verify.mts` join them.

### One coordination fact worth recording

**KT.1b's two CSS lines were committed by another session.** NEG.1's commit `1df95d678` ran
`git commit --only rules-automation.css` while my appended `h10-kt-*` block was sitting uncommitted
in the shared working tree, so their commit carries my lines under their message. Nothing was lost
and the selectors are disjoint — but this is the `commit --only` hazard the locks doc §5 names,
running in the direction it does not warn about: **not "my commit breaks", but "my change ships
inside someone else's".** Recorded in the locks doc for the next session that shares this file.

---

## KT.2 — built

**Shipped and verified on production 2026-08-12.** Session slug `kt2`.
Measured with `_kt2-engine-state.mts` (the stop conditions), `_kt2-seed-candidates.mts` (the seed
choice), `_kt2-verify.mts` (the result) — all read-only — plus `_kt2-seed-watchlists.mts`, the one
writing script, idempotent and re-run to prove it.

### 🔴 A stop condition tripped, and the answer was "build it harder"

The brief said the coverage-engine hazard was latent because the engine is *"scheduled nowhere"*.
It is scheduled. Measured:

| | |
|---|---|
| `startCoverageEngineCron()` | called from `startAllAdvertisingCrons()` at `ads-sync.job.ts:798` |
| schedule | `10 7 * * *` — daily at 07:10 |
| `CronRun` rows named `ads-coverage-engine` | **6**, most recent 2026-08-11 07:10 |
| every run's summary | `mode=observe sets=0 terms=0 up=0 down=0 applied=0` |
| `NEXUS_COVERAGE_ENGINE_MODE` | **unset** → `observe`, so nothing has been written |
| sets the engine would act on | **0** — the one set is `enabled: false` |
| decisions ever logged | **none** (no `AdvertisingActionLog` row with a coverage `actionType`) |
| terms already primed | **97 of 97** carry a `leadAsin`, the engine's precondition for acting |
| who can arm it | `PATCH /advertising/coverage-sets/:id { enabled }`, wired to a button on the **Family Cockpit** |

So the chain is: **one UI toggle** starts nightly evaluation of 97 terms, and **one env var** turns
those decisions into real bid writes through `updateAdTargetWithSync`. Not latent — armed and
observing. The operator confirmed proceeding as designed, which is the right call: an engine that
already runs nightly makes the isolation *more* necessary, not less. The other two stop conditions
hold — `ads-coverage-sets.service.ts` is still the only writer (4 write calls, one file), and no
watchlist-shaped table exists (the keyword tables are `AdKeywordProtection`, `EbayKeyword`,
`EbayNegativeKeyword`, `KeywordCoverageSet`, `KeywordCoverageTerm`, `KeywordRank`).

### The four lists, and what the wrong one was costing

Seeded per market, `bid ∩ SQP-90d` for the three markets with no curated list, IT's 97 curated terms
copied. Each list also carries the 10 protected brand terms, flagged branded and hidden by default.

| market | list | terms | source | **measured before** | **measured after** |
|---|---|---|---|---|---|
| IT | `IT — curated coverage` | 107 | the coverage set, copied | 97 of 97 | **97 of 97** |
| DE | `DE — bid keywords we can measure` | 31 | bid ∩ SQP-90d | 2 of 97 | **10 of 21** |
| ES | `ES — bid keywords we can measure` | 17 | bid ∩ SQP-90d | 0 of 97 | **6 of 7** |
| FR | `FR — bid keywords we can measure` | 18 | bid ∩ SQP-90d | 0 of 97 | **3 of 8** |

DE now opens on `motorrad jacke herren` — volume 6,028, market rank **#1**, our share 0.78 %, with
**10 of our own ASINs** on it. ES on `chaqueta moto verano hombre` (4,943, #2). FR on
`veste moto homme homologué` (1,669, #1). Those rows existed the whole time; the page was asking
Amazon about Italian terms in Spain.

**Why that seed and not a bigger one.** The candidate sources, measured per market:

| market | bid keywords (enabled) | SQP 90d | SQP vol ≥ 500 | paid 30d | **bid ∩ SQP** |
|---|---|---|---|---|---|
| IT | 212 (197) | 3,013 | 71 | 1,017 | 83 |
| DE | 41 (41) | 2,254 | 62 | 609 | 21 |
| ES | 9 (9) | 1,950 | 19 | 201 | 7 |
| FR | 37 (25) | 624 | 17 | 104 | 8 |

`bid ∩ SQP` is the intersection where a row can actually carry volume, rank and share. Every SQP
query in the market would be a **discovery** list, which §7.1 gives to Share of Voice. All bid
keywords would open FR with 29 of 37 rows permanently blank. What the chosen seed does **not** cover
is on the record: paid-but-SQP-blind queries — IT 610, DE 340, ES 62, FR 76.

### What else changed

- **`?? sets[0]` is deleted.** A market with no list resolves to nothing and says so, in amber, with
  the measured reason it is not borrowing one. A `?list=` naming a real list from **another** market
  is refused and explained (`listRejected: true`), not honoured — verified: DE + the IT list id
  returns `list: null` and 0 rows.
- **`enabled` is absent from the payload** in all four markets, and the new entity has no such
  column. `source` replaces it as the honest thing to say about a list.
- **`isBranded` is stored per term**, classified on write by a function that honours
  `AdKeywordProtection.matchType` and its nullable `marketplace`. Measured: all ten protections are
  `CONTAINS` with `marketplace = null`, so KT.1's blanket `includes()` sweep was **accidentally
  correct** — honouring the columns changes zero classifications today. Honoured anyway, and tested
  (10 tests, 3 seen to fail first), because right-by-coincidence is one `EXACT` row away from ending
  and this answer is now persisted rather than recomputed away.
- **The `lists` payload is alive**: a picker that round-trips `?list=`, rendered as a select only
  when a market has more than one list — a one-option dropdown is a control where nothing moves.
- **The editor** does add (paste, counted back), remove, copy-from-coverage-set, create, rename, set
  default and delete, with D4 sentences on both destructive paths.
- **The coverage set is untouched**: `updatedAt` still reads 2026-08-05, before this build.

### Two defects found by clicking, not by reading

1. **Delete returned 400.** The request helper set `Content-Type: application/json` on the bodyless
   DELETE, and Fastify rejects that. The confirmation text was correct; the request was malformed.
   This is the class of thing that survives tsc, review and a screenshot.
2. **A failed read was reported as an empty watchlist.** With `data` null, both the banner and the
   grid's empty state asserted "DE has no watchlist" — measured on prod during an API redeploy,
   rendering directly beneath a "Failed to fetch" banner saying the opposite. Both are now gated on
   there being no error.

Verified by click on prod: create a list (the picker appears at two), paste `motorradjacke test kt2`
+ `xavia motorradjacke` → *"Added 2 terms · 1 classified as one of our brand terms and hidden by
default"*, then delete the list from the confirmation that names it and counts its terms. The
scratch list was removed; DE is back to one list and the picker correctly disappeared.

Geometry re-measured on prod: the panel is flush with the grid card at **96→1698** of 1728, four
lanes at 304/304/1568/1568, no horizontal scroll. Contrast composited against real backgrounds found
**one failure** — the term count at `#667080` measures 4.95 on white and **4.39** on the row's
`#f8fafc` tint. Darkened to `#55606d`. Every other new style passes.

### Recorded, not fixed

- `sort` / `dir` are still never written back to the URL (needs an `AdsDataGrid` sort callback,
  shared by nine pages); `sort=asins` is still accepted with no matching column; `reportPeriod` is
  still unguarded (all 15,075 SQP rows are `WEEK`).
- 🔴 **Nothing on the Family Cockpit's coverage-set toggle says it arms a nightly bid ladder.** That
  page belongs to another programme, so this session did not touch it — logged as a request in the
  locks doc §4 instead.
- The ASIN-coverage denominator, the summed-share bound, per-term ad coverage, the staleness cliff
  and feed health → **KT.5**. Spend / clicks / top-of-search and the Δ column → **KT.3**. The
  per-keyword history drawer → **KT.4**. Any write to a bid, rule or campaign → **KT.6**.

---

## KT.5 — built

**Shipped and verified on production 2026-08-12.** Session slug `kt5`.
Re-measured with `_kt5-coverage.mts`, `_kt5-signals.mts`, `_kt5-verify.mts` — all read-only.
**Nothing in this section is inherited from the study:** KT.2 replaced three of the four watchlists
and KT.1b changed the lookback from 56 to 42 days, so every per-market number above is stale.

### Stop conditions — all four hold

| | |
|---|---|
| a new SQP period | no — newest is still **2026-07-26** in every market; most recent `ingestedAt` 2026-08-10 |
| coverage engine armed | no — `NEXUS_COVERAGE_ENGINE_MODE` unset (→ observe), **0** enabled sets |
| the 10-ASIN limit | unchanged — `sqp.service.ts:242` still `args.limit ?? 10`, and the nightly distinct-ASIN counts (IT 1–18/night) show no rotation |
| a summed bound over 100 % | **none**, in any market — the bound holds everywhere |

### 🔴 1 · The coverage denominator

The reach line printed **`250 ASINs`**. That is ASINs in *scope*. Every share on the page is bounded
by the ASINs Brand Analytics actually measures, in the week the grid reads:

| market | advertised in scope | **measured in the chosen week** | covered ever |
|---|---|---|---|
| IT | 250 | **18** | 32 |
| DE | 57 | **13** | 13 |
| ES | 30 | **14** | 15 |
| FR | 91 | **4** | 4 |

Now reads *"share measured across 18 of 250 advertised ASINs"* — replacing the old token, not
appended. The numerator is filtered to the scope's own ASINs even at market scope: the first version
counted every covered ASIN in the market (19) against advertised ones (250), so **N was not a subset
of M** — it read as a coverage ratio over a different population.

Root cause is one constant: `ourAsinsForMarketplace(mkt, args.limit ?? 10)` requests the same 10
ASINs per market every night and never rotates, while its own comment says the cron cycles coverage
over days. Raising it is the single highest-value change behind this page, and the day it moves every
number in this section is wrong — which is why the page computes the denominator rather than
storing it.

### 🔴 2 · The third blank state

"This term has no row" and "the feed has a row, but for no ASIN you are scoped to" were one string,
because the scope filter and the measurement were the same query.

| scope | measured | no row this week | never measured | **not measurable here** |
|---|---|---|---|---|
| IT market | 97 | 0 | 0 | 0 |
| DE market | 10 | 11 | 0 | 0 |
| ES market | 6 | 1 | 0 | 0 |
| FR market | 3 | 5 | 0 | 0 |
| **IT campaign `Gale Jacket Yellow Only`** | 25 | 0 | 0 | **72** |

At market scope the state has **zero instances** — which is exactly why it looked unrepresentable.
Under one campaign it is the dominant blank: **72 of 97 rows**, every one of which the page was
calling "no row this week" or "never measured". It costs one grouped read with the ASIN filter
removed, asked only when the scope restricts ASINs.

### 3 · The share is one ASIN's, and the bound is a bound

Header is now **`Our best ASIN’s share`**; where more than one of our ASINs holds the query the row
carries `≤ N%` beside it.

| market | measured terms | with >1 of our ASINs | median understatement | largest ratio |
|---|---|---|---|---|
| IT | 97 | 47 | 0.25 pp | `giubbino moto` 1.57 % → **5.01 %** (3.19×, 6 ASINs) |
| DE | 10 | 6 | 0.27 pp | `motorradjacke herren` 0.54 % → 1.62 % (3.00×) |
| ES | 6 | 3 | 0.06 pp | `chaqueta moto hombre invierno` 0.37 % → **1.50 %** (4.05×) |
| FR | 3 | 2 | 0.03 pp | `veste moto homme` 0.03 % → 0.06 % |

Checked two ways — summing the share column, and summing `impressionsBrand` over the shared
`impressionsTotal`. They agree everywhere, and **no row exceeds 100 %**. Labelled `≤` and described
as an upper bound in every tooltip; the words "total share" appear nowhere.

### 🔴 4 · The attribution hazard

| market | watched terms we bid on | fully ad-covered | 0 % ad-covered | **share from a non-advertising ASIN** |
|---|---|---|---|---|
| IT | 33 | **0** | 4 | **4** |
| DE | 21 | **0** | 12 | 1 |
| ES | 7 | **0** | 3 | 2 |
| FR | 8 | **0** | 5 | 0 |

`giacca moto 4 stagioni` renders **1.67 % attributed to B0BMSJWW7L**, which is in none of the 12 ad
groups bidding that term — those hold 30 ASINs and the feed covers **zero** of them. Folded into the
existing `N OF OURS` chip (`none advertised measured`) plus a dotted-underline mark on the share
itself, with the full sentence in the tooltip. **No new column.**

### 5 · One health line, and the cliff as a date

The page's single new permanent line: quiet when the feed is behaving, loud when it is not.

Derived from data, never from `CronRun.status` — **the 2026-08-11 and 2026-08-12 runs both carry
`status=SUCCESS` *and* `errorMessage="stale (auto-swept after 2.3h)"` *and* `rows=0`.** Across all
72 runs, **14 carry a stale error while only 12 have a non-SUCCESS status.** An absent ingest day is
a zero rather than a gap, so silent nights are counted by walking the calendar, not the `GROUP BY` —
counting zeros in the grouped result would always return 0.

🔴 **The cliff has TWO dates per market and the first is the one that matters.** The gate never
empties the grid; it falls back to a thinner week first. My own first measurement found only the
second date and reported 26 days when the answer was 19.

| market | reading | **collapses on** | falls back to | measurable then | no week at all |
|---|---|---|---|---|---|
| IT | week of 19 Jul | **2026-08-31** | 26 Jul (8 rows vs a normal 655) | **2 of 97** | 2026-09-07 |
| DE | 19 Jul | **2026-08-31** | 26 Jul (5 rows) | **0 of 21** | 2026-09-07 |
| ES | 12 Jul | **2026-08-24** | 26 Jul (71 rows) | 3 of 7 | 2026-09-07 |
| FR | 12 Jul | **2026-08-24** | 26 Jul (1 row) | **0 of 8** | 2026-09-07 |

All dates assume no further complete week lands; `projectCliff` is pure and clock-injected, with 6
tests (3 written against a deliberately-wrong version first).

Also stated in the loud form: five of the nine markets the nightly job iterates (**IE, NL, PL, SE,
UK**) have **zero** `ChannelListing` rows, so `ingestSqp` throws for them every night forever and
`failed=5` is a constant that can never signal anything. And **FR has zero `listingStatus='ACTIVE'`
listings** (of 133), so `ourAsinsForMarketplace`'s "ACTIVE first" comparator is inoperative there and
its nightly 10 are effectively alphabetical — the cleanest available explanation for FR being
measured on 4 ASINs of 91. ES is nearly as exposed: 19 ACTIVE of 141.

### §4 label corrections, applied

- **`topOfSearchIS` lags the placement report it rides on by ONE day** — report has 2026-08-11 rows,
  the IS column stops at 2026-08-10. Recorded as a lag, because an age rots overnight and the
  study's "2 days old" was true only on the day it was written.
- **Its denominator is 65 of the 81 campaigns with any placement row**, not 65 of 220. 139 have none.

### Published for KT.3 — Δ computability on the NEW watchlists

| market | measured | Δ computable | 7 d | 14 d | 21 d | 28 d | 35 d+ | no earlier row |
|---|---|---|---|---|---|---|---|---|
| IT | 97 | **78** | 69 | 3 | 0 | 2 | 4 | **19** |
| DE | 10 | 9 | 8 | 0 | 0 | 0 | 1 | 1 |
| ES | 6 | 6 | 4 | 0 | 0 | 2 | 0 | 0 |
| FR | 3 | 3 | 3 | 0 | 0 | 0 | 0 | 0 |

96 of 116 measured rows could carry a Δ; 20 could not. A blank Δ would be a **fourth** on-screen
state beside `0.00 %`, the three blanks and the coverage mark — which is the question KT.3 has to
answer before spending a column on it.

### Perf

The ad-coverage read and the SQP row read are the two ~500 ms queries and now run together; the two
feed-health reads depend on nothing and moved into the first batch. Measured locally across the
Atlantic to Neon (the API runs in-region, so these overstate): IT ~1.8 s warm, DE ~1.1 s, ES ~0.7 s,
FR ~0.5 s.

### Recorded, not fixed

`sort`/`dir` still never written to the URL (needs an `AdsDataGrid` sort callback, nine pages);
`sort=asins` accepted with no matching column; `reportPeriod` unguarded (all 15,075 rows are `WEEK`);
`sqpImpressionShareForAsins` still has no recency guard — the RD study owns that one.
