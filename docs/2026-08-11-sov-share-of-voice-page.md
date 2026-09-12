# SOV — Share of Voice as its own page

*Page 2 of 11 in the Rules & Automation conversion. Sibling: [Keyword Tracker](2026-08-11-kt-keyword-tracker-study.md).
Predecessor for this tab: [the tab study](2026-08-11-sov-share-of-voice-study.md).*

**Read-only study. Nothing was changed. No application code was written. No commits.**

Measured on production 2026-08-11 with `apps/api/scripts/_sov-page-{a,b,c,d}.mts` — all read-only,
all re-runnable. Where a fact comes from an earlier study it is cited, not re-measured. Four facts
from earlier studies I actively doubted are re-measured here and **two of them are wrong**; both
corrections are in §2.6 and §2.7.

---

## 0 · The one-paragraph version

The column labelled *Share of Voice* divides a query's impressions by a number that is neither the
market's impressions nor even all of ours: it is **28.2%** of our ad impressions, because Amazon's
search-term report only returns queries that were **clicked**, and product-page placements can
never appear in it at all. So the metric is not "share of voice" mislabelled — it is a **mix of a
click-filtered search slice**, and no rename rescues it. Meanwhile the real figure is one join
away, the feed that produces it is **not stopped** (it has run daily for at least 40 consecutive
days) but is **structurally 17 days behind by configuration** and covers **13% of the ASINs we
advertise**, and the rule trigger that would spend money on all this hands a rule a field literally
named `impressionSharePct` containing the wrong number — alongside spend and ACoS guards that are
**vacuously true**, because all 2,129 keyword targets carry `spendCents = 0`.

---

## 1 · What exists — every wire

```
/marketing/ads/rules-automation?tab=share-of-voice
└── RulesAutomationClient.tsx:333          tab === 'share-of-voice'
    └── RulesAutomationClient.tsx:337       <SovTrackerTab kind="sov" />
        └── tabs/SovTrackerTab.tsx:33       segmented [ Rules | Report ], default = Rules
            ├── Rules  → tabs/RuleListTab.tsx   liveType="sov"      ← dead string, §2.5
            └── Report → tabs/TrackerTab.tsx    kind="sov"
                         └── fetch `${getBackendUrl()}/api/advertising/share-of-voice?limit=300`
                             TrackerTab.tsx:51 — no marketplace, no windowDays
                             └── advertising.routes.ts:7284
                                 Cache-Control: private, max-age=120
                                 └── services/advertising/ads-impression-share.service.ts:47
                                     analyzeShareOfVoice({ windowDays=30, limit=200 })
                                     └── prisma.amazonAdsSearchTerm.findMany({ date: { gte } })

Grid          campaigns/_grid/AdsDataGrid (shared)
Columns       Impressions · Clicks · Share of Voice · Top Campaign Share · Campaigns
First column  labelled "Keyword" (TrackerTab.tsx:136) — the values are search *queries*
Rule path     trigger SOV_BID
              └── advertising-rule-evaluator.job.ts:923 buildSovBidContexts()
                  registered at :1048, :1092, :1194
Builder       /marketing/ads/rules-automation/builder/sov  (slug from SovTrackerTab CONFIG.sov)
Tables read   AmazonAdsSearchTerm  — no SOV table exists; the figure is computed per request
Tables ignored SearchQueryPerformance (schema.prisma:3257) — the real share, 15,075 rows
```

**Nothing stores SOV.** Computing it live is the right call — there is nothing to keep in sync, and
the two-minute cache is adequate. The problem is entirely in *what* is computed.

### Adjacent wires that matter to this page

| wire | file:line | why it matters here |
|---|---|---|
| `sqpImpressionShareForAsins()` | `sqp.service.ts:191` | the real impression share; **no recency guard** |
| the rank engine consumes it | `ad-rank-defend.job.ts:564` | reads a 17-day-old number as if current |
| SQP ingest cron | `sqp-ingest.job.ts:67` — `45 3 * * *` | daily, opt-out via `NEXUS_DISABLE_SQP_INGEST_CRON` |
| per-ASIN report request | `sqp.service.ts:242` — `args.limit ?? 10` | **10 ASINs per market per run**, no rotation |
| the lookback | `sqp.service.ts:25` — `NEXUS_SQP_LOOKBACK` default **2** | why the newest week is always ~2 weeks old |
| curated keyword set | `KeywordCoverageSet` / `Term` (schema.prisma:3061) | already carries `targetSharePct`, `isControl`, `leadAsin` |
| brand terms | `AdKeywordProtection` — 10 WHITELIST/CONTAINS rows | the branded/non-branded filter's source |
| console import substrate | `ads-console-import.service.ts` | the route for a console-only report, if we want one |

---

## 2 · How it works — every number, and where it misleads

### 2.1 The derivation, line by line

`ads-impression-share.service.ts` aggregates `AmazonAdsSearchTerm` rows from the last 30 days into
a map keyed by **`query` alone**, accumulating `impressions`, `clicks`, `cost` (micros ÷ 10,000 →
cents), `orders7d`, and a per-campaign impression sub-map. Then, per query:

| rendered column | derivation | honest? |
|---|---|---|
| **Impressions** | `Σ impressions` over the window, all markets | ⚠ merged across markets; click-filtered — §2.2 |
| **Clicks** | `Σ clicks` | ✅ |
| **Share of Voice** | `:107` `a.impr / totalImpressions` | 🔴 wrong quantity **and** wrong denominator |
| **Top Campaign Share** | `:92` `max(byCampaign) / a.impr` | ✅ (merges markets on 7 queries) |
| **Campaigns** | `:93` `byCampaign.size` | ✅ (same caveat) |

Two more fields are computed, returned by the API, and **rendered in no column at all**:

| field | rule | measured today |
|---|---|---|
| `flag: 'outbid'` | `:96` `cpc > 1.25 × medianCpc && impressions < mean` | **637 queries** |
| `flag: 'weak-relevance'` | `:98` `impressions ≥ 50 && ctr < 0.5 × medianCtr` | **118 queries** |
| `cannibalized` | `:94` `campaignCount ≥ 2` | 168 queries |

*(The earlier study measured 596 / 108 / 157 on 2026-08-10; the 30-day window has slid one day. Same
finding, different day.)*

### 2.2 🔴 The denominator is 28% of our ad impressions

This is the finding that decides §3, and it is new.

`totalImpressions` is described in the service header as *"all tracked impressions"*. Measured over
the identical 30-day window:

| source | impressions | clicks |
|---|---|---|
| `AmazonAdsSearchTerm` — **the SOV denominator** | **498,606** | 4,534 |
| `AmazonAdsDailyPerformance`, `entityType = CAMPAIGN` | 1,765,323 | 5,668 |
| `AmazonAdsPlacementReport` (SP only) | 1,690,969 | 5,319 |

> **498,606 ÷ 1,765,323 = 28.24%.**

Two independent reasons, both structural:

**One — the report is click-filtered.** Of 10,826 `AmazonAdsSearchTerm` rows all-time, **3** have
`clicks = 0`. Our ingest does not filter (`ads-reports.service.ts:634` skips only rows missing a
date, campaign or query), so this is Amazon's report shape, and Amazon documents it: the Sponsored
Products search-term report *"shows every customer search query that triggered your ad and resulted
in at least one click… If a term generated impressions but no clicks, it won't appear here."*
Impression-only terms live in the Search Term Impression Share report, which
[study 1 established is console-only](2026-08-11-kt-keyword-tracker-study.md#L97).

**Two — product pages are not search.** The placement split over the same window:

| placement | impressions | clicks |
|---|---|---|
| Detail Page on-Amazon | 1,280,682 | 1,215 |
| Other on-Amazon (rest of search) | 364,944 | 2,313 |
| Top of Search on-Amazon | 45,343 | 1,791 |

76% of our impressions are on **product detail pages**, which no search-term report can contain.
Clicks reconcile far better — 4,534 of 5,319 = 85.2% — exactly as you would expect from a
click-driven, search-only report.

**Why this is decisive.** "Share of our own ad traffic" was the charitable reading of the column,
and the reading a rename would preserve. It does not survive measurement. The real quantity is
*"this query's share of our clicked, search-placement ad impressions over 30 days"* — a sentence no
column header can carry and no operator would want.

### 2.3 It sums to ~98% because the tail is cut, not because it is a share

Measured: **1,992** distinct queries in the window; the tab renders **300** (15.1%); those 300 hold
**489,680 of 498,606 impressions = 98.21%**. The full set sums to exactly 100% by construction.
This confirms the earlier study's point and supplies the missing *why*.

### 2.4 The two flags, examined

Neither is unreasonable, and both are honestly labelled inside the service. But:

- **The `outbid` impression bar is the mean, not the median.** Mean = 250, median = **4**. **1,925
  of 1,992** queries (96.6%) sit below the mean, so the second half of the test excludes almost
  nobody — `outbid` is effectively "CPC above 1.25× median", firing on **637 of 1,992 = 32%** of
  queries. A third of the account being flagged is not a shortlist.
- **`flag` is single-valued** and `outbid` wins. 52 rows flagged `outbid` also clear
  weak-relevance's ≥50-impression gate; whatever else is true of them is invisible.
- **1,822 of 1,992 queries have under 50 impressions** and are structurally ineligible for
  `weak-relevance`.
- I expected zero-click queries to be structurally unflaggable and they are — but there are
  **none**, for the reason in §2.2. Stated so the next reader does not re-derive it.

The flags are still the most actionable content on the tab. They need a threshold that is a
shortlist, and a column.

### 2.5 The Rules segment cannot render a row — and it is the default view

`SovTrackerTab.tsx:34` opens on `view = 'rules'`. `RuleListTab` filters with
`ruleBelongsToTab(actions, 'sov')`; `RULE_TAB_ACTION_TYPES` (`_shared/tabs.tsx:83`) has five keys
and `sov` is not one, so the lookup returns `undefined` and the guard returns `false` for every
rule. **The first thing this tab shows, on an account with 51 rules, is "create your first rule".**
Same defect as Keyword Tracker; already reported in study 1, cited here because it is the tab's
default view rather than a secondary one.

### 2.6 ✅ Correction — the SQP feed is not stopped

Studies 1 and 2 state the SQP feed *"stopped on 2026-07-26"* and that *"no `CronRun` row named
`sqp-ingest` exists at all"*; [study 5 §156](2026-08-11-rd-rank-dayparting-study.md) inherits it as
*"the stalled SQP cron"*. I doubted this because `NEXUS_SQP_LOOKBACK` defaults to 2. Measured:

```
periodWindow('WEEK', 2026-08-11, lookback=2) → 2026-07-26 … 2026-08-01
newest stored week                            → 2026-07-26
```

**The same week.** The newest week the cron *can* write is the newest week in the table. And the
runs are recorded — 40 rows retrieved, back to 2026-07-02, unbroken daily:

```
2026-08-11 03:45  SUCCESS  210m  markets=9 ok=4 failed=5 rows=0    ERR:stale (auto-swept after 2.3h)
2026-08-10 03:45  SUCCESS   51m  markets=9 ok=4 failed=5 rows=83
2026-08-09 03:45  SUCCESS  114m  markets=9 ok=4 failed=5 rows=76
2026-08-08 03:45  SUCCESS   45m  markets=9 ok=4 failed=5 rows=250
…
2026-07-07 03:45  SUCCESS   46m  markets=9 ok=4 failed=5 rows=914
```

So the honest diagnosis is four separate things, none of them "stopped":

1. **The staleness is a config default.** `NEXUS_SQP_LOOKBACK` is unset → 2 → the newest week is
   always ~14–20 days old. Setting it to 1 halves that at a stroke. (Whether Amazon has finalised
   the just-completed week is the reason the default is 2; that is worth testing, not assuming.)
2. **`failed=5` on every run is 5 markets we do not sell on.** `runSqpIngestOnce` iterates active
   `AmazonAdsConnection` rows — DE · ES · FR · IE · IT · NL · PL · SE · UK. IE, NL, PL, SE and UK
   return **0 ASINs** from `ourAsinsForMarketplace`, so `ingestSqp` throws `no Amazon ASINs`. Every
   day, forever. Harmless, and it makes the run summary unreadable as a health signal.
3. **Row volume has collapsed** — ~600–900/run in early July, 250 in early August, 76 and 83 on the
   9th and 10th, **0** on the 11th. The 07-26 week holds 85 rows against a ~2,000 norm because of
   this, not because the feed halted.
4. **Runs hang.** 6 of the 40 recorded runs ran 135–210 minutes and were swept as stale; a normal
   run is 40–50 minutes. The most recent run is one of them and wrote nothing.

Points 3 and 4 need their own diagnosis and it is not a UI change. **Point 1 is a one-line env
change** and is the single cheapest improvement available to this page.

### 2.7 ✅ Correction — SQP covers 13% of what we advertise

`ingestSqp` requests **10 ASINs per market per run** (`args.limit ?? 10`), and
`ourAsinsForMarketplace` sorts by listing status with no rotation — **the same ten every day**. The
cron's comment claims *"the cron cycles coverage over days"*. It does not.

| market | ASINs we advertise (ENABLED ads) | distinct ASINs ever in SQP | covered |
|---|---|---|---|
| IT | 250 | 32 | **12.8%** |
| DE | 57 | 13 | 22.8% |
| ES | 30 | 15 | 50.0% |
| FR | 91 | 4 | **4.4%** |

Any market-share number this page renders describes those ASINs and no others. That belongs on the
page as a stated coverage figure, not as a footnote.

### 2.8 🔴 The rule path is armed with the wrong number and vacuous guards

`buildSovBidContexts()` (`advertising-rule-evaluator.job.ts:923`) is not idle for lack of data. It
would emit **1,202 contexts** today — 1,202 of 2,129 positive keyword targets match a SOV query by
lowercased text. It is idle for lack of rules (0 on `SOV_BID`, confirmed). Three problems, all
live the moment a rule is created:

**One — the mislabel is baked into the context.** Line 945:

```ts
// sovPct / topSharePct are fractions (0..1); our within-account SOV IS impression share.
sovPct: s.sovPct, topSharePct: s.topCampaignSharePct, impressionSharePct: s.sovPct,
```

The comment asserts the equivalence §2.2 disproves. A rule written against `impressionSharePct`
reads a click-filtered traffic mix. This is the mislabel escaping the UI and reaching the write
path.

**Two — the spend and ACoS guards are vacuously true.** The context carries
`spendCents`, `salesCents`, `orders` and `acos` from `AdTarget`. Measured:

| `AdTarget` where `kind='KEYWORD'`, `isNegative=false` | count |
|---|---|
| total | **2,129** |
| `spendCents > 0` | **0** |
| `salesCents > 0` | **0** |
| `ordersCount > 0` | **0** |
| `impressions > 0` | **0** |

Every one is zero, so `acos` is `0` for every context. A rule guarded with *"only if ACoS < 40%"*
fires on everything; *"only if spend > €50"* fires on nothing. This confirms the known trap and
pins it to this specific rule path. Keyword metrics live in `AmazonAdsDailyPerformance`
(`entityType = AD_TARGET`), which this builder does not read.

**Three — the market join is loose.** `sovByQuery` is keyed by query text alone and
`analyzeShareOfVoice` is called with no `marketplace`, so a query's SOV is the sum across markets.
13 of the 1,202 contexts attach a number from a market the target is not in. Small, but it is 13
bids that would move on another country's data.

### 2.9 Smaller defects, all specific to this tab

| defect | evidence |
|---|---|
| **The market selector is inert.** `RulesAutomationClient.tsx:93` holds `market` and passes it to `AdsPageHeader`, but `visible` (line 131) filters only the Apply Rules campaign grid. `SovTrackerTab` receives nothing, and `TrackerTab.tsx:51` sends no `marketplace`. Changing the market does nothing on this tab. | code |
| **"Remove" is a lie.** `TrackerTab.tsx:127` filters rows out of local state and calls no API. SOV rows are computed per request; reload and they are back. | code |
| **Markets are merged into one row.** 7 query strings span ≥2 markets, 2.17% of impressions. `veste moto homme` renders as one row of 9,474 impressions (FR 9,470 + DE 4). | measured |
| **643 of 5,383 "queries" are ASIN strings** (`b0clfwynw7`, …), rendered in a column labelled "Keyword". | measured |
| **No window control at all.** `windowDays` is a service default; the client never sends it and the header hides the date range (`showDateRange={false}`). The tab is permanently 30 days. | code |
| **`limit=300` is hard-coded** in the fetch; the service default is 200. Neither is visible or adjustable. | code |

---

## 3 · Rename or replace

**Replace the headline. Carry two numbers, and neither of them is today's column.**

Argued from the operator's job, which on this page is one decision: *where do I push spend to gain
visibility, and am I gaining it?* That decomposes into two questions, and they want different
metrics:

**"How much of this market do I hold?"** — nothing in the application answers this. The rank engine
consumes it invisibly and no surface shows it. This is the page's reason to exist, and it must be
the headline column: **`impressionShare` from SQP, labelled "Market impression share", with the
week it came from.** It brings the funnel with it — click, cart-add and purchase share — which no
competitor in §4 can offer, because they infer from a scrape and we read it from Amazon.

**"Where is my money going?"** — a real allocation question, and the one today's column gestures at.
But §2.2 kills the impression-mix answer: the denominator is 28% of our traffic, click-filtered and
search-only. **Renaming it preserves a number computed over a denominator nobody asked for.** The
same question has a correct answer already in the API response — `costCents` — so carry
**"Share of ad spend"** instead: this query's cost ÷ total cost across the window, per market.
Spend share is what a budget-allocation question actually means, and it is exactly as cheap.

So: **both, each named for what it is, and the existing `sovPct` is deleted rather than renamed.**

| today | becomes | why |
|---|---|---|
| `sovPct` "Share of Voice" | **removed** | §2.2 — no name is true of it |
| — | **Market impression share** (SQP, per market, per week) | the question the page exists for |
| — | **Share of ad spend** (cost ÷ window cost, per market) | the allocation question, correctly derived |
| Impressions | Impressions *(clicked search terms, 30d)* | keep, with the qualifier in the column tooltip |
| `flag` | **Signal** column — outbid / weak-relevance | already computed, rendered nowhere |

One consequence worth stating plainly: the two numbers will *disagree loudly*, and that is the
point. `motorrad jacke` is 15.19% of our ad traffic and
[0.32% of its market](2026-08-11-sov-share-of-voice-study.md); `giacca estiva moto uomo` is 0.95%
of our traffic and 1.45% of its market. The page's job is to make that inversion visible, not to
resolve it.

---

## 4 · Industry research — features *and* interface

The [tab study §6](2026-08-11-sov-share-of-voice-study.md) established the definitional split and
the vendor landscape. This section does not repeat it. It adds: **screen-level interface detail,
pricing, and a steal/avoid for each**, plus two vendors it did not cover.

### 4.1 The three definitions, and where ours sits

| | **impression SOV** | **slot / shelf SOV** | **ours (SQP)** |
|---|---|---|---|
| formula | your ad impressions ÷ total market ad impressions | your page-1 appearances ÷ all brands' appearances | your impressions ÷ Amazon's recorded impressions for the query |
| source | ads API | scraping page 1 on a cadence | Amazon Brand Analytics |
| covers | paid only | paid **and** organic | paid **and** organic |
| names competitors | no | **yes** | **no** |
| used by | Pacvue, Perpetua | Intentwise, Helium 10, DataHawk | nobody else has it |

Pacvue states it as `SOV = (Your Brand's Ad Impressions ÷ Total Market Ad Impressions) × 100`, with
a worked example of 1,000 ÷ 10,000 = 10%, and separates **Share of Voice** (paid) from **Share of
Shelf** (paid + organic). Intentwise states it as
`(your brand's total appearances ÷ total appearances by all brands on page 1) × 100`.

**A calibration number worth keeping.** Pacvue's own guide reports that on Amazon, *84 brands
compete for the top 10 keywords, with none exceeding 10% paid SOV* — against Walmart, where two
brands compete and one holds over 90%. Our 0.32%–1.52% measured shares read as catastrophic against
an intuitive "we should have 20%". Against a category where the ceiling is ~10%, they read as low
but not absurd. **The page should carry a category-realistic scale, not a 0–100% bar.**

### 4.2 The screen, vendor by vendor

**Intentwise — the most fully specified, and the right target shape.** Six tabs:

| tab | what it shows |
|---|---|
| **Overview** | brand-level summary: organic + paid placement, top keywords, trend snapshots, competitor benchmarking across all tracked keywords |
| **Brands** | SOV evolution over time per brand, side-by-side comparison, metrics across keywords |
| **Keywords** | per keyword, which brands win placement prominence, with brand ownership, ratings, reviews |
| **Products** | ASIN-level total / organic / ad SOV, top keywords per ASIN, positions, reviews, ratings, average display price |
| **Daily Tracker** | time series at daily / weekly / monthly granularity across keywords, brands or products |
| **Raw Data** | on request only |

Specifics, verbatim: competitor pinning **"10 competitors"**; history **"previous 13 months"**;
collection **"four times daily"**; default filter **"non-branded keywords (default)"**; **"Color
scale helps you visually scan for changes"**; export **"CSV/Excel"**. Pricing: **100 keywords
included per account**, charged beyond; paused/archived keywords are not billed; rate varies with
tracking frequency.

- **Steal:** the Daily Tracker's colour-scaled grid, and the row/tab split by *unit of analysis*
  (brand · keyword · product) rather than by metric. Also the honesty of a "Raw Data" tab.
- **Avoid:** six tabs for a 97-term list is furniture. Two of those tabs are a filter.

**Pacvue — automation, not charts.** Paid + organic SOV across Amazon and 100+ retail media
networks; SOV integrated with demand and pricing signals; **automated SOV dashboards and alerts**;
rules that fire on *organic* share of voice alongside stock level, Buy Box and sales velocity;
**Bid Explorer** forecasts performance at different bid levels; placement locks hold a position on
high-value keywords. Pricing is unpublished and quoted on ad spend, retailer count and team size;
the common guidance is that under ~$50K/month of retail media spend it is oversized.

- **Steal:** *SOV is a rule input, not a report.* This is the single most important idea in the
  category and `SOV_BID` already exists to receive it.
- **Avoid:** the 100-retailer breadth is priced in. We have one retailer and four markets.

**Skai + Profitero — "Shelf Intelligent Media".** Profitero's digital-shelf and competitive data
surfaced **inside the campaign-management UI** so shelf signals drive bidding; Brand Insights tracks
SOV for your brand and competitors, keyword-based, "load the keywords and our AI does the rest".
Profitero covers 1,400+ retailers in 70 countries with daily shelf intelligence.

- **Steal:** the insight lives *inside* the tool that acts on it — no separate analytics product.
  That is exactly the shape of putting SOV on a Rules & Automation page rather than in Reporting.
- **Avoid:** the two-vendor seam. Buying an "intelligence layer" that is a different company's
  product is a data-freshness and support boundary you inherit.

**CommerceIQ** — real-time shelf signals across 1,450+ retailers, ML diagnostics that go past
surfacing an issue to automating the fix; frames SOV as an outcome to improve, not a chart to read.
Pricing is quote-only; published figures are unreliable.
- **Steal:** the framing. **Avoid:** enterprise-only; there is no self-serve tier to grow into.

**Stackline (Beacon)** — AI catalogue monitoring with **organic traffic forecasting up to 52 weeks
ahead**; SOV as a leading indicator. Pricing starts around **$5,000/month**, Atlas typically
$5–10K/month.
- **Steal:** forecast the share, don't just plot it. **Avoid:** the price for a 279-SKU catalogue.

**Helium 10 Market Tracker 360** — build a "market" from **up to 15 keywords + unlimited ASINs**,
11 marketplaces, near-real-time SOV and market dominance, top-performing and fastest-growing
competitors, historical trend. **~$500/month** as an add-on, aimed at larger brands and agencies.
- **Steal:** *a market is a named, saved object* — a keyword set plus an ASIN set you return to,
  not an ad-hoc filter. We already have `KeywordCoverageSet` and never surfaced it.
- **Avoid:** 15 keywords per market is a low ceiling; our curated set is 97.

**DataHawk** — blends organic rank tracking with ad data into one SOV metric. Pricing is
unpublished: an annual platform fee scaled to Amazon sales volume, plus a credits fee scaled to what
you track.
- **Steal:** one blended number with the components exposed beneath it.
- **Avoid:** a blended number is only as good as its weighting, and the weighting is theirs.

**Perpetua** — paid SOV from the ads API; strong automation, blind to organic. **$695/month**
Essentials; Growth $695 + a percentage of ad spend up to $100K; monthly billing only.
- **Steal:** the flat entry price for automation. **Avoid:** paid-only SOV is the metric we already
  have a defective version of.

**Similarweb Shopper Intelligence** *(not in the earlier study)* — Amazon traffic sources, category
and brand sales estimates, shopper-journey data; compares brand sales performance, **search share of
voice and "keyword battlegrounds"** against direct competitors; benchmarks against **up to four**
competitors; measures share of search and organic-vs-paid click trends. Enterprise pricing reported
at **$75K–$200K+/year**.
- **Steal:** "keyword battlegrounds" as a view — the terms where share is actively changing hands,
  rather than the terms where it is highest. That is a shortlist, and shortlists are what this page
  is short of.
- **Avoid:** the price, by two orders of magnitude, and estimates where we have Amazon's own counts.

### 4.3 The 2026 bar, and where we would sit

| the bar | us, after Tier 1 |
|---|---|
| paid and organic SOV separately, plus their sum | ⚠ SQP is paid+organic **combined** and cannot be split; paid alone is derivable from ad data |
| competitor brands named and comparable | ❌ today · ⚠ **top 3 per term is free from Amazon** — §6 |
| a curated keyword set per market | ✅ `KeywordCoverageSet`, 97 terms, exists and is unused (`enabled=false`) |
| branded excluded by default | **not applicable here** — measured, §4.4 |
| trend before level (colour-scaled grid) | ⚠ buildable; needs the SQP week cadence fixed first |
| alerts on movement | ✅ substrate exists (`notify` actions, the digest) |
| SOV drives bids | ✅ `SOV_BID` end-to-end; needs a correct number and non-vacuous guards |
| the funnel beneath the share | ✅ **nobody else has this** — click / cart-add / purchase share, from Amazon |

### 4.4 One industry default that does not earn its place here

Every vendor defaults to **non-branded**, because your own brand terms flatter every number.
Measured against `AdKeywordProtection`'s 10 WHITELIST/CONTAINS terms (`xavia`, `gale`, `moss`,
`aireon`, `misano`, `airmesh`, `air mesh`, `x-tuta`, `ventra`, `regal`):

- **20 of 5,383** paid queries contain a protected term — **0.37%**
- **25 of 7,799** SQP queries — **0.32%**

Xavia is not a brand people search for. A branded/non-branded toggle should exist because it costs
nothing, but **it must not be the default filter**, because defaulting it on would hide 0.3% of rows
while implying the page is showing you a filtered view of something. Ship it off, and say why.

---

## 5 · How it should be

> **One question: on the terms that matter, how much of the market do we hold — and is it moving?**

### 5.1 What belongs here, and what belongs on Keyword Tracker

The two pages share a dataset and must not share a job.

| | **Share of Voice** | **Keyword Tracker** |
|---|---|---|
| the unit | a **market** (query × marketplace) | a **keyword we chose** to watch |
| the question | how much of it do we hold | where are we, and is it moving |
| the population | everything SQP can see — 7,799 queries | a curated watchlist — the 97 |
| the time axis | week over week, share Δ | observation over observation, position Δ |
| the action | raise the bid to gain share; buy demand we don't hold | alert; investigate; defend |
| owns the unbid view | **yes** — §5.4 | no |
| owns the watchlist editor | no | **yes** |

The line: **Share of Voice is a market view; Keyword Tracker is a watchlist view.** A term appears
on Share of Voice because a market exists; it appears on Keyword Tracker because a human put it
there. Both read the same `SearchQueryPerformance` rows through the same server-side derivation —
see §7, requirement 3, because two pages independently computing "share" is exactly how they drift.

### 5.2 The four views, and the URL contract

Everything below `?` is this page's own; `market` is shared and is a requirement, not a design.

```
/marketing/ads/rules-automation/share-of-voice
  ?market   = IT | DE | ES | FR | all          shared — §7.1
  &view     = share | mix | unbid | signals    the four views below; default `share`
  &weeks    = 4 | 8 | 13                       SQP weeks on the market side; default 8
  &adWindow = 7d | 14d | 30d                   the ad side; default 30d (today's implicit value)
  &set      = <coverageSetId> | all            curated keyword set; default `all`
  &branded  = include | exclude                default `include` — §4.4
  &kind     = keyword | asin | all             643 of 5,383 "queries" are ASIN strings — §2.9
  &signal   = outbid | weak | cannibalized     filter, not a view
  &q        = <text>
  &sort     = <column>:<asc|desc>
  &page     = <n>
  &row      = <query>@<market>                 the inspected row; opens the detail drawer
```

Two rules this contract has to hold to:

- **Every one of those params round-trips.** A view is a link. Today the page has exactly one URL
  and a hard-coded `limit=300`.
- **`weeks` and `adWindow` are separate controls on purpose.** They are different periods over
  different feeds with different ages (2 days vs 17). Collapsing them into one "date range" is how
  you get an operator comparing a 30-day ad total to a one-week market total — the mistake the tab
  study warned about and that a single date picker would institutionalise.

### 5.3 Rendering three states that are not the same

This is the hardest requirement on the page, and today the data layer actively defeats it:
`share()` (`sqp.service.ts:75`) returns `0` when the total is `0`, so *"Amazon reported no market
total"* and *"we hold none of this market"* arrive at the UI as the same `0`. Measured on the
latest stored week: 0 rows with `impressionsTotal = 0`, **2** rows with a real total and zero share.
The state is rare today. It must still be distinguishable, because the rare case is the interesting
one.

| state | condition | renders as |
|---|---|---|
| **no data** | no SQP row for this query × market × week | `—`, muted. Never `0%`. |
| **stale** | a row exists, its week is older than the freshness threshold | the value, plus an age chip: `0.32% · wk 26 Jul · 17d` |
| **we hold none** | row exists, `impressionsTotal > 0`, `impressionsBrand = 0` | `0%` in the "we're absent" treatment, with market volume beside it — this is a *finding*, not a blank |
| **not covered** | the query's ASIN is outside the 10-per-market SQP set | `—`, with "outside SQP coverage" on hover — §2.7 |

Plus **one page-level banner**, because the page mixes two feeds of very different ages:

> *Ad data through 10 Aug (2 days). Market data through the week of 26 Jul (17 days) — 13% of
> advertised ASINs. [why](#)*

### 5.4 The 5,805 unbid queries: yes, a view on this page

Re-measured: **5,383** distinct queries we have ever paid on, **7,799** SQP knows, **1,994** both,
**5,805** in SQP and never advertised on. *(The earlier study's 5,294 / 5,820 were the same
quantities a day earlier.)*

**One correction to how that number is framed.** SQP only sees queries **our own ingested ASINs
appeared in** — and §2.7 shows that is 10 ASINs per market. So these 5,805 are not "the market's
query universe minus ours". They are **demand we already appear in organically, on the handful of
ASINs Amazon reports on, and do not buy.** That is a *better* list than a market-wide one — every
row is a query Amazon has already decided we are relevant to — and the page should say so.

The top of it, by market search volume:

| query | mkt | market volume | our impressions | market impressions | our share | week |
|---|---|---|---|---|---|---|
| gilet refrigerante | IT | 6,005 | 12 | 185,774 | 0.01% | 12 Jul |
| chaqueta hombre | ES | 3,068 | 0 | 91,469 | 0.00% | 17 May |
| chaqueta | ES | 2,883 | 0 | 72,032 | 0.00% | 17 May |
| blouson moto homme | FR | 2,849 | 0 | 77,857 | 0.00% | 17 May |
| chubasquero hombre | ES | 2,555 | 0 | 80,182 | 0.00% | 17 May |
| motorradschuhe herren | DE | 2,517 | 1 | 66,262 | 0.00% | 19 Jul |
| motorrad hoodie mit protektoren | DE | 2,127 | 10 | 49,154 | 0.02% | 14 Jun |
| gilet rinfrescante moto | IT | 1,139 | 66 | 27,941 | 0.24% | 21 Jun |
| motorrad protektoren | DE | 777 | 17 | 18,055 | 0.09% | 21 Jun |

Note the weeks: several are from May. The view **must** carry the week per row — a union across all
history is otherwise a list of things that may no longer be true. Note also that some are plainly
not ours (`hugo boss uomo`, `north face`, `harley davidson`, and a query that is the single letter
`l`) — the view needs a dismiss action that persists, or it will be ignored after one read.

**Why here and not on Keyword Harvest:** harvest promotes terms we already paid on and that already
converted. This is demand we have never touched. Different population, different decision, and
Harvest is another session's page — flagged in §9 rather than assumed.

### 5.5 The shape of the page

Flat grid, filters, minimal teaching text — per the standing preference. Concretely:

- **One row per query × market.** Never merged (§2.9). Market is a column and a filter, not a
  hidden aggregation.
- **The columns**, left to right: Query · Market · Market volume · **Market impression share** ·
  Δ vs prior week · Click share · Purchase share · Our impressions (30d ads) · **Share of ad spend**
  · Spend · CPC · **Signal** · Campaigns · Top campaign share.
- **Signal is a shortlist, not a third of the account.** Re-cut `outbid` against the median rather
  than the mean (§2.4) and state the count in the filter chip so the operator can see it is a
  shortlist before clicking.
- **The share column is colour-scaled** against a category-realistic ceiling (§4.1), not 0–100%.
- **A detail drawer per row** (`&row=`): the weekly share series, which of our ASINs holds the term
  and at what share, the campaigns bidding on it, the spend, and — after §6 — the three ASINs
  taking the clicks.
- **No "Remove" action.** These rows are computed. A "hide" that persists to a saved view is a
  different thing and is worth building; a filter that vanishes on reload is not.
- **Anything that spends money explains itself in a full sentence.** The one write this page
  should offer is *"raise the bid on this keyword to gain share"*, and it must state, in the
  confirmation: which target, from what bid to what bid, in which market, against which week's
  share, and which spend ceiling it consumed.

### 5.6 The rules side

`SOV_BID` should be armed from this page, and only after §2.8 is fixed — all three parts. Until
`impressionSharePct` carries the real share and the guard fields are populated from
`AmazonAdsDailyPerformance`, a rule created here is a rule that reads the wrong number through
guards that cannot stop it.

When it is armed: the write is a bid raise, scoped, capped, and refused at the ceiling with a
reason on the page. Notifications per the standing decision — daily digest, immediate on refusals
and on anything large, and a live change log on the page itself.

---

## 6 · Competitor brands, costed

**A correction to the premise first: this is partly available from an Amazon API, free.**

The brief states competitor naming *"cannot come from any Amazon API"*. That is true of SQP, and
true of every Ads API endpoint. It is **not** true of the Brand Analytics family SQP belongs to.
`GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT` returns, per search term: the search frequency rank and
**the top three clicked ASINs, each with its click share and conversion share.** ASINs are not brand
names, but `getCatalogItem` returns the brand attribute per ASIN, also free, and we already call
SP-API catalogue endpoints.

⚠ **Unproven, and cheap to prove.** We know Brand Analytics *access* is granted, because SQP
returns data. We do not know this specific report type is entitled on this account. The
`probeSqpAccess()` pattern (`sqp.service.ts:213`) exists precisely for this and is a half-day.

### The options

| # | option | what it names | cost | effort | verdict |
|---|---|---|---|---|---|
| **1** | **Brand Analytics Search Terms report** + Catalog Items for brand | **top 3 ASINs per term**, with click and conversion share | **€0** | ~2 days: probe, report type, parser, table, join | **Do this first.** Amazon-authoritative, no ToS question, and it answers "who is taking the clicks I'm not" for every term we already track |
| 2 | **Helium 10 Market Tracker 360** | full page-1 shelf, all brands, named | **~$500/mo** (~€460) | days of integration, or none if read in their UI | The cheapest complete answer. 15 keywords/market × 4 = 60; our set is 97 |
| 3 | **SERP data API** (DataForSEO ~**$0.60/1,000**; Rainforest from ~$66/mo) | full page 1, parsed to JSON, positions + sponsored flags | 97 terms × 4 markets × 1/day ≈ 11,640 req/mo ≈ **$7/mo**; 4×/day ≈ **$28/mo** | ~1 week: client, schedule, brand extraction, store | **Buying parsed pages, not operating a scraper.** `KeywordRank.source` was designed for exactly this. Cheapest at our volume by a wide margin |
| 4 | **Intentwise SOV module** | full shelf, 10 pinned competitors, 13 months, 4×/day | 100 keywords **included**, charged beyond — but requires being an Intentwise customer | high — a platform relationship | Excellent product; wrong shape. We are not moving our ads platform to get one metric |
| 5 | **Similarweb Shopper Intelligence** | brand share, keyword battlegrounds, 4 competitors | **$75K–$200K+/yr** | — | No |
| 6 | Build a scraper | — | — | — | **Not proposed.** Explicitly out of scope, and options 1–3 dominate it |

### Recommendation

**Option 1, then re-ask.** It is free, it is Amazon's own data, it needs no vendor and no legal
review, and it answers the operator's actual question — *who is taking the clicks on my terms* —
for the price of a report type and a parser. It does **not** give the full shelf, organic-vs-paid
split, or positions 4 and below.

If, after seeing three named competitors per term, the operator wants the whole shelf: **option 3
at $7–28/month** is the honest next step, and option 2 at ~€460/month is the same answer with a UI
attached and no engineering. The €5,500/year gap between them is the price of not writing a week of
code — worth it only if nobody has that week.

---

## 7 · Requirements on the shared layer

Constraints, not designs. A twelfth pass reconciles these across all eleven pages.

1. **Market must be a URL-borne, navigation-surviving selection.** Today `market` is `useState` in
   `RulesAutomationClient.tsx:93`, is never passed to this tab's component, and is lost on
   navigation. This page cannot function without it: every number it renders is per market, and
   `veste moto homme` in FR is a different row from `veste moto homme` in DE. The page must be able
   to *read* the current market and to *change* it, and the change must be linkable.

2. **The shell must express more than one data age.** This page renders a 2-day-old ad feed and a
   17-day-old market feed side by side. A single "last synced" indicator would be wrong whichever
   feed it named. The page needs to state per-source freshness, and the shell must not contradict
   it with a single global timestamp.

3. **One server-side derivation of "share", consumed by every page that shows one.** At minimum
   Share of Voice, Keyword Tracker and Rank & Dayparting read `SearchQueryPerformance`. Today the
   rank engine has its own reader (`sqpImpressionShareForAsins`) with no recency guard. If each page
   writes its own aggregation, three surfaces will disagree about our share within a quarter. The
   contract must include: the week the value came from, its age, and an explicit "not covered"
   distinct from zero (§5.3).

4. **A freshness/staleness contract, not a per-page convention.** The three states in §5.3 are not
   cosmetic — *no data*, *stale*, *we hold none* and *not covered* need to be representable end to
   end, from the query layer to the cell. A layer that coerces all four to `0` (as `share()` does
   today) makes the distinction unbuildable above it.

5. **The grid must not require row actions.** `AdsDataGrid`'s selection actions are used here to
   render a "Remove" that mutates local state and lies (§2.9). Computed rows have no per-row
   mutations. Selection should be able to mean "export these" or "act on these targets" or nothing.

6. **The Rules segment needs a real mapping or no segment.** `ruleBelongsToTab('sov')` returns
   `false` for every rule in the account, and Rules is the tab's *default* view. Either
   `RULE_TAB_ACTION_TYPES` gains an entry for whatever action a SOV rule performs, or the page shows
   no rules list. A tab that says "create your first rule" on an account with 51 is worse than no
   tab.

7. **The curated keyword set must be shared state with a change signal.** `KeywordCoverageSet` (97
   terms, `enabled=false`, one set, GALE IT) is the natural population for both this page and
   Keyword Tracker. If one page edits it, the other must see the edit. It already carries
   `targetSharePct` (0 populated), `isControl` (0), `leadAsin` (97) and `maxCpcCents` — a per-term
   share target and a held-out control group are already schema, waiting for a surface.

8. **Spend ceilings must be enforced below the page, per scope.** The one write this page offers is
   a bid raise to gain share. Per the standing decision, the ceiling is per market · product line ·
   portfolio · campaign, never global; at the cap the write is refused and reported. This page must
   be able to *ask* whether a write fits and to *render the refusal* — it must not implement the
   ceiling.

9. **Export must be first-class.** Every vendor in §4 ships CSV/Excel. The SOV endpoint already
   powers a CSV per its service header; the page needs the shared toolbar affordance.

10. **Sort, page, filter and the inspected row must all live in the URL.** §5.2. Today the page has
    one URL and a hard-coded `limit=300`.

11. **Cross-page navigation targets.** Every row wants to link out: to the campaigns bidding on the
    term, to the product, and to the keyword's row on Keyword Tracker. Those are three other pages'
    URL contracts, and they need to be stable and linkable.

---

## 8 · Tiered plan

### Tier 0 — stop lying, no new data *(hours)*

| # | change | why |
|---|---|---|
| 0.1 | **Remove the "Share of Voice" column.** Do not rename it — §2.2 | it is 28% of a click-filtered slice; no name is true |
| 0.2 | **Add "Share of ad spend"** from `costCents`, already in the response | the allocation question, correctly answered |
| 0.3 | **Render the `Signal` column** (outbid · weak-relevance · cannibalized) | 637 + 118 + 168 rows of already-computed judgement, shown nowhere |
| 0.4 | **Re-cut `outbid` against the median**, not the mean | 32% of the account is not a shortlist |
| 0.5 | **Group by `query × marketplace`** in the service; add a Market column | 7 merged rows, and it unblocks every per-market view later |
| 0.6 | **Pass the market through**, or drop the selector on this tab | it is inert today |
| 0.7 | **Delete the fake "Remove"** | it mutates local state and reloads away |
| 0.8 | **Label the first column "Search query"**, and filter ASIN-shaped queries | 643 of 5,383 are ASINs in a column called "Keyword" |
| 0.9 | **Fix or remove the Rules segment** (`liveType="sov"`) | the tab's default view is a false empty state |

**Costs:** one service change and one component. **Unlocks:** the page stops asserting something
untrue, and the flags become usable. **Does not need:** SQP, a vendor, or a decision.

### Tier 1 — the real number *(days)*

| # | change | why |
|---|---|---|
| 1.1 | **Join `SearchQueryPerformance`** → market impression share, click share, cart-add share, purchase share, market volume, market rank | the reason the page exists |
| 1.2 | **Week-over-week share Δ** | trend before level (§4.3) |
| 1.3 | **The four-state renderer** (§5.3) and the two-feed freshness banner | a `0` that means four things is worse than a blank |
| 1.4 | **The unbid view** (§5.4) with per-row week and a persistent dismiss | 5,805 rows of demand we already appear in |
| 1.5 | **The full URL contract** (§5.2) | every view linkable |
| 1.6 | **Surface `KeywordCoverageSet`** as the `&set=` filter | 97 curated terms, all with SQP rows, `enabled=false` |
| 1.7 | **Colour-scaled share column** against a category ceiling | §4.1 |

**Costs:** a new endpoint or an extension of the existing one; a grid with more columns; the
staleness contract from §7.4. **Unlocks:** the page answers its question. **Blocked by:** nothing —
the data is in the database today, however stale.

### Tier 2 — make the feed worth trusting *(days; two of these are one-liners)*

| # | change | why | note |
|---|---|---|---|
| 2.1 | **`NEXUS_SQP_LOOKBACK=1`** | halves the structural staleness at a stroke | test that Amazon has finalised the just-completed week before committing |
| 2.2 | **Skip markets with no ASINs** in `runSqpIngestOnce` | `failed=5` every run for markets we do not sell on makes the summary useless as health |
| 2.3 | **Rotate the ASIN set** beyond the fixed top 10 | coverage is 12.8% (IT) and 4.4% (FR); the cron's comment already claims it rotates |
| 2.4 | **Diagnose the row-volume collapse and the 2.3h hangs** | 914/run → 0; 6 of 40 runs swept as stale | its own investigation, not a UI task |
| 2.5 | 🔴 **Recency guard on `sqpImpressionShareForAsins`** | **cross-stream** — this is [study 5's §262](2026-08-11-rd-rank-dayparting-study.md) too; the rank engine reads a 17-day-old share as current | one fix, two pages; sequence it with whoever owns Rank & Dayparting |
| 2.6 | **Probe + ingest `GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT`** | top-3 competitor ASINs per term, free (§6) | |
| 2.7 | **Fix `buildSovBidContexts`** — real share in `impressionSharePct`, guards from `AmazonAdsDailyPerformance`, market-scoped join | §2.8; a `SOV_BID` rule is unsafe to arm until this lands | |

**Unlocks:** the number is current enough to act on, and competitors are named. **2.5 and 2.7 are
prerequisites for Tier 3, not optional polish.**

### Tier 3 — a decision *(yours)*

1. **Arm `SOV_BID`.** Once 2.7 lands this is a rule definition, not a build: *raise the bid where
   market share is below target on a curated term, within the market's spend ceiling*. It is what
   Pacvue charges for, and `targetSharePct` is already a column on `KeywordCoverageTerm`.
2. **Buy the full shelf, or don't.** §6 option 3 at $7–28/month, or option 2 at ~€460/month. Only
   worth deciding after option 1's free top-3 has been seen.
3. **Organic vs paid split.** SQP cannot separate them. Only page-one collection can. Same vendor
   decision as [study 1's Tier 2](2026-08-11-kt-keyword-tracker-study.md) — one decision across both
   pages, not two.

---

## 9 · Open questions

1. **`NEXUS_SQP_LOOKBACK=1` — shall I test it?** It is the cheapest fix in this document and the
   only one that improves the number on three pages at once. It is a Railway variable change, and
   testing it is a read: request the just-completed week for one ASIN and see whether Amazon returns
   data or a FATAL. *(Not done here — this session is read-only and does not touch env.)*

2. **Who owns the SQP row-volume collapse?** 914 rows/run in early July → 0 on 11 August, plus six
   runs hung past 2.3 hours. It degrades Share of Voice, Keyword Tracker and Rank & Dayparting
   equally. It is not a page.

3. **Does this account have the Brand Analytics Search Terms report?** SQP works, so the role is
   granted; the specific report type is unproven. Half a day to find out, and it is the difference
   between "we can name three competitors per term for free" and "we buy shelf data".

4. **The unbid view: this page, or Keyword Harvest?** I have argued this page (§5.4) — harvest
   promotes terms we already paid on; these are terms we never touched. Harvest is another session's
   page, so this is a boundary to agree, not to assume.

5. **Which keyword population?** The 97 in `KeywordCoverageSet` (all have SQP rows; 84 we pay on),
   the 10 protected terms, everything SQP sees, or your own list. This is the same question study 1
   asked and it has one answer for both pages. Note that the set is `enabled=false` and 0 of its 97
   terms carry a `targetSharePct` — the column a share-driven rule would read.

6. **A category-realistic scale needs a number.** §4.1 gives ~10% as the paid-SOV ceiling in a
   crowded Amazon category. Is that the right top of our colour scale, or do you have a target?

7. **`SOV_BID` is unsafe to arm today** and the builder will happily emit 1,202 contexts. Do you
   want a guard that refuses to save a rule on this trigger until 2.7 lands, or is "don't create
   one" sufficient?

---

## Appendix A — scripts

All read-only, all re-runnable, all run from `apps/api` with
`NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/<name>`.

| script | what it measures |
|---|---|
| `_sov-page-a.mts` | cross-market merging; market composition of the 300 rendered rows; flag distributions and their structural exclusions; `AdTarget` metric population; the SOV_BID contexts the evaluator would emit and their market join; currency |
| `_sov-page-b.mts` | whether the search-term feed is click-filtered; `periodWindow` vs the newest stored week; SQP ASIN coverage vs advertised ASINs; what `sqpImpressionShareForAsins` returns today and from when; the three zero-states; unbid demand; branded share; ASIN-shaped queries; `KeywordCoverageSet` |
| `_sov-page-c.mts` | the SOV denominator against `AmazonAdsPlacementReport` and `AmazonAdsDailyPerformance` over an identical window; placement split; per-source freshness |
| `_sov-page-d.mts` | full `CronRun` history for `sqp-ingest`; which 5 of 9 markets throw and why; the fixed 10-ASIN request set per market |

`_sov-study.mts` (the tab study's script) was read, not modified.

## Appendix B — sources

- [Ultimate Guide to Share of Voice in Retail Media — Pacvue](https://pacvue.com/blog/ultimate-guide-to-share-of-voice-in-retail-media/) ·
  [Market & Competitive Intelligence — Pacvue](https://pacvue.com/platform/market-competitive-insights/) ·
  [Pacvue pricing guide — Atom11](https://www.atom11.co/blog/pacvue-pricing-guide)
- [How to Use Share of Voice to Track Brand Visibility on Amazon — Intentwise](https://help.intentwise.com/shareofvoice) ·
  [How to Set Up Share of Voice — Intentwise](https://help.intentwise.com/getting-started-with-share-of-voice)
- [Shelf Intelligent Media — Skai](https://skai.io/capabilities/profitero-shelf-intelligent-media/) ·
  [Brand Insights with Share-of-Voice Intelligence — Skai](https://skai.io/blog/share-of-voice-intelligence-brand-insights/) ·
  [Best digital shelf analytics software 2026 — Inriver](https://www.inriver.com/resources/best-digital-shelf-analytics-software/)
- [Market Tracker 360 — Helium 10](https://www.helium10.com/enterprise/solutions/research-amazon-products/) ·
  [Market Tracker vs 360 — Helium 10](https://www.helium10.com/blog/market-tracker-and-market-tracker-360-comparison/) ·
  [Market Tracker 360 review — AMZ Toolset](https://amztoolset.com/helium-10-market-tracker-360/)
- [Stackline pricing — G2](https://www.g2.com/products/stackline/pricing) ·
  [Perpetua pricing](https://perpetua.io/pricing/) ·
  [DataHawk pricing — RevenueGeeks](https://revenuegeeks.com/datahawk-pricing/)
- [Amazon Keyword Research Tool — Similarweb](https://www.similarweb.com/corp/retail/amazon-keyword-tool/) ·
  [Amazon Seller Tools — Similarweb](https://www.similarweb.com/corp/retail/amazon-seller-tool/) ·
  [Best Amazon Market Intelligence Tools 2026 — Marketplace Ad Pros](https://marketplaceadpros.com/guides/best-amazon-market-intelligence-data-tools-2026/)
- [Unlocking the Amazon Advertising Search Term Report — SmartScout](https://www.smartscout.com/blog/unlocking-the-power-of-amazons-advertising-search-term-report) *(the click-only constraint)* ·
  [Search Term Impression Share report — Amazon Ads](https://advertising.amazon.com/help/G7AQQUSFVZPAAXEU)
- [Amazon Brand Analytics deep dive — SellerApp](https://www.sellerapp.com/blog/amazon-brand-analytics/) ·
  [Search Terms report — ZonGuru](https://www.zonguru.com/blog/amazon-search-terms-report) ·
  [GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT — amzn/selling-partner-api-models #3684](https://github.com/amzn/selling-partner-api-models/discussions/3684)
- [DataForSEO API pricing guide 2026 — NextGrowth](https://nextgrowth.ai/dataforseo-api-guide/) ·
  [Top Amazon scraper APIs — Traject Data](https://trajectdata.com/top-5-amazon-scraper-apis/)
