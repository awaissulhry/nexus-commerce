# KT — Keyword Tracker: study 1 of 11

*Rules & Automation, tab-by-tab. Right to left; this is the rightmost tab.*
**Read-only study. Nothing was changed. No code was written.**

Measured on production 2026-08-11 with `apps/api/scripts/_kt-study{,2,3,4}.mts` — all read-only,
all re-runnable.

---

## 0 · The one-sentence version

The Keyword Tracker reads a table with **0 rows** and has never shown anything; meanwhile
**15,075 rows of Brand Analytics search-query data**, already ingested and already load-bearing for
the rank engine, sit one join away and can fill two of the tab's four columns today — and the feed
that produces them **stopped 16 days ago**.

---

## 1 · What the tab is, and every wire behind it

```
?tab=keyword-tracker
└── RulesAutomationClient.tsx:338      <SovTrackerTab kind="tracker" />
    └── tabs/SovTrackerTab.tsx          segmented control [ Rules | Report ]
        ├── Rules  → tabs/RuleListTab.tsx   liveType="keyword-tracker"
        │             └── GET /advertising/automation-rules   → filtered by ruleBelongsToTab()
        └── Report → tabs/TrackerTab.tsx    kind="tracker"
                      ├── GET  /advertising/keyword-ranks?limit=500
                      └── POST /advertising/keyword-ranks      ("Add Keywords to Track" dialog)

Builder   builder/keyword-tracker → _shared/RuleBuilder.tsx (slug 'keyword-tracker')
Rule path trigger KEYWORD_RANK_BID
          └── advertising-rule-evaluator.job.ts:956 buildKeywordRankBidContexts()
Table     KeywordRank  (schema.prisma:12899)
```

**The data contract.** `KeywordRank` is an append-only time-series: one row per observation of
`(keyword, marketplace)`, carrying `organicRank`, `sponsoredRank`, `searchVolume`, `capturedAt`
and a `source` string. The GET collapses it to *latest + prior* per key and derives
`rankDelta = prior.organicRank − latest.organicRank` (positive = improved). The schema comment is
admirably honest about its own premise:

> *"Amazon's SP-API does NOT expose organic rank, so rows arrive via ingestion (manual / import /
> a future collector)."*

**That future collector was never built.** Nothing writes to `KeywordRank` except the manual
paste-a-list dialog in the UI, and the POST route it calls.

### The rule path is real, and completely unused

`buildKeywordRankBidContexts()` joins the latest rank snapshot to every positive `KEYWORD`
`AdTarget` by lowercased text + marketplace, and hands a rule this context:

| field | meaning |
|---|---|
| `organicRank` · `sponsoredRank` · `searchVolume` | from the latest snapshot |
| `rankDelta` | improvement vs the prior snapshot |
| `spendCents` · `acos` | from the target itself |

It short-circuits on line 962: `if (!ranks.length) return []`. With 0 rank rows it returns an empty
array on every tick, forever.

---

## 2 · What it shows today, and the two defects behind it

| measurement | value |
|---|---|
| `KeywordRank` rows | **0** |
| Rules on trigger `KEYWORD_RANK_BID` | **0** |
| Positive `KEYWORD` targets that *could* be tracked | **297** distinct |
| Negative `KEYWORD` targets | 2,056 |

**Defect 1 — the Rules segment cannot ever show a row.** `SovTrackerTab` passes
`liveType="keyword-tracker"` into `RuleListTab`, which filters with
`ruleBelongsToTab(actions, liveType)`. That function looks the string up in
`RULE_TAB_ACTION_TYPES` (`_shared/tabs.tsx:83`), whose five keys are `bid`, `budget`, `placement`,
`keyword-harvest`, `negative-targeting`. `keyword-tracker` is not one of them, so the lookup returns
`undefined`, the guard returns `false`, and **every rule in the account is filtered out**. The
segment renders "create your first rule" on an account with 51 rules. Share of Voice has the
identical bug with `liveType="sov"`.

**Defect 2 — the Report is empty because nothing has ever filled it.** Not a bug; an unbuilt
ingestion. But the empty state says *"No rank data yet — add keywords to track (or ingest ranks via
POST /advertising/keyword-ranks)"*, which tells the operator to paste ranks in by hand. That is not
a workflow anybody will run twice.

---

## 3 · The four columns, against what Amazon actually gives you

| column | can Amazon supply it? | verdict |
|---|---|---|
| **Search Volume** | ✅ Brand Analytics SQP `searchQueryVolume` — **already ingested** | **available today** |
| **Organic Rank** | ❌ No SP-API or Ads API endpoint returns organic SERP position. | needs a SERP collector or a data vendor |
| **Sponsored Rank** | ⚠️ *Search Term Impression Rank* (STIR) exists — but requesting `searchTermImpressionRank` via the Ads API returns **"Unsupported field for campaign report"**. It is **console-only**. `topOfSearchImpressionShare` *is* API-available, and we already ingest it as `topOfSearchIS` — but per **campaign**, not per keyword. | console import, or accept a campaign-grain proxy |
| **Rank Δ** | follows Organic Rank | but a **share Δ** is computable today |

This is the crux of the whole tab: **three of its four columns describe a thing Amazon does not
sell you.** Every competitor that shows organic rank collects it from the search results page
themselves.

---

## 4 · What this account already holds that bears on "where do we rank"

| source | rows | grain | what it tells you |
|---|---|---|---|
| **`SearchQueryPerformance`** (Brand Analytics SQP) | **15,075** · 7,799 distinct queries | **query × ASIN × market × week** | market search volume, market popularity rank, and **our impression / click / cart-add / purchase share** |
| `AmazonAdsPlacementReport.topOfSearchIS` | 760 campaign-days | campaign × day | Amazon's own top-of-search impression share |
| `AmazonAdsSearchTerm` | 10,628 · 5,294 distinct queries | query × campaign × day | which queries our ads served on (no ASIN column) |
| `KeywordCoverageSet` / `Term` | 1 set · **97 terms** | a curated list | a keyword list somebody already curated |
| `AdKeywordProtection` | 10 | term | the brand terms that must never be negated |
| `KeywordRank` | **0** | — | the tab's only source |

### SQP is the buried treasure, and it is already trusted elsewhere

Every one of the 15,075 SQP rows is **ASIN-scoped** (15,075 of 15,075). That makes it the only
source in the account that answers *"for this query, how did **this product** of ours do"* — which
is both the grain the Keyword Tracker promises **and** the grain the page-one/cannibalisation
question needs.

It is not speculative: `ad-rank-defend.job.ts:563` already calls `sqpImpressionShareForAsins()` to
supply the **rest-of-search impression-share lane** for the rank engine. The rank engine trusts this
data today. The Keyword Tracker does not read it at all.

**What it can already answer** — latest week, 2026-07-26:

```
"chaqueta moto hombre" [ES] · market volume 3,082 · market rank #3 · 3 of our ASINs
  ASIN         our impr   imprShare   clicks   clickShare   purchases
  B0BMSH19GY        251      0.36%         1       0.08%            0
  B0BMSWM15B          2      0.00%         1       0.08%            0
  B0D8SFVSGP          2      0.00%         1       0.08%            0
```

Two things fall straight out of that table:

1. **This is the cannibalisation measurement.** In my earlier page-one work I said per-ASIN-per-query
   coverage was not measurable — that was true of `AmazonAdsSearchTerm`, which has no ASIN column.
   It is measurable from SQP. **9 of 74 query×market pairs (12.2%) in the latest week carry more
   than one of our ASINs.**
2. **The shares are brutal.** On a 3,082-volume query where we hold the #3 market-popularity slot,
   our best ASIN has **0.36% impression share**. Three products are splitting a rounding error.
   "Three jackets competing for one keyword" is not the problem here — **not being on the page at
   all** is.

---

## 5 · 🔴 The SQP feed has stopped

| week | IT | DE | ES | FR | total |
|---|---|---|---|---|---|
| 2026-07-26 | 8 | 5 | 71 | 1 | **85** |
| 2026-07-19 | 655 | 364 | 193 | 4 | 1,216 |
| 2026-07-12 | 1,066 | 675 | 443 | 42 | **2,226** |
| 2026-07-05 | 989 | 438 | 354 | 44 | 1,825 |
| 2026-06-21 | 1,042 | 729 | 544 | 85 | 2,400 |

- **Nothing after 2026-07-26** — 16 days stale as of today.
- The final week holds **85 rows against a ~2,000 norm** — a partial run, not a quiet week.
- **No `CronRun` row named `sqp-ingest` exists at all**, while 26 sibling ads crons record theirs
  (`ads-v1-export-ingest` last ran 2026-08-11 00:02).
- The cron is scheduled in code (`index.ts:1495`, `45 3 * * *`) and is **not** disabled —
  `startSqpIngestCron` gates on `NEXUS_DISABLE_SQP_INGEST_CRON`, which is unset.
- ⚠️ Railway carries `NEXUS_ENABLE_SQP_INGEST_CRON=1`, which **no code reads any more**. The job
  flipped from opt-in to opt-out and the variable was left behind. It is a decoy: it looks like the
  feed is deliberately on.
- Consequence: **week-over-week share movement is currently uncomputable** — 0 comparable
  ASIN×query rows between the last two stored weeks.

**This needs its own diagnosis.** It is the single highest-value fix on this tab and it is not a UI
change.

---

## 6 · How the industry actually does this

The existing competitor research (`docs/2026-08-04-ads-market-research.md`,
`docs/2026-08-04-competitor-deep-dives.md`) covers ads platforms but barely touches rank tracking —
it names DataHawk / SellerSonar / SellerSprite as "Share-of-Voice / rank tracking specialists" and
records that M19 ships a Keyword Tracker. This section fills that gap; it does not redo the rest.

### The mechanism, stated plainly

Every tool that shows organic rank **collects the search results page itself**. There is no API.
The differentiators are cadence, accuracy and what they do with the number.

| tool | cadence | notable |
|---|---|---|
| **Helium 10** Keyword Tracker | daily, **hourly via "Boost"** | broadest ecosystem; Boost is the launch/Prime-Day mode |
| **Jungle Scout** Rank Tracker | daily | independently tested at **100% position accuracy within ±1** of manual verification |
| **SellerSprite** | daily | strongest multi-marketplace coverage — relevant to IT/DE/FR/ES |
| **AMZ Tracker** | daily | long-running dedicated tracker |
| **Ad Badger** | daily | **acts on rank** — adjusts bids, harvests winners from rank movement |
| **DataHawk / SellerSonar** | daily | SOV-first framing rather than position-first |

### The 2026 feature bar

1. **Organic *and* sponsored position on one row** — showing one without the other is the most
   common complaint; a falling organic rank means fix the listing, a falling ad rank means raise
   the bid, and they are different jobs.
2. **Flexible alert cadence** (daily / weekly / monthly), not a fixed schedule.
3. **Hourly for launches, daily for steady state** — hourly everywhere is cost with no signal.
4. **Competitor ASINs tracked on the same keyword**, side by side with yours.
5. **Multi-marketplace**, with the same keyword tracked independently per market.
6. **Rank → action**, not rank → chart. Ad Badger's positioning is the honest one: the number is
   only worth collecting if something changes because of it.

**Where we already beat them:** none of these has your Brand Analytics share data joined to your
ad spend and your PIM catalogue. H10 can tell you you are #14; only this system can tell you you are
#14, it costs €593 in ad spend, and three of your own ASINs are splitting 0.36% of the impressions.

---

## 7 · What we could implement, cheapest first

### Tier 0 — no new data source, no new backend *(hours)*
- **Fix the `liveType` bug.** One string. Restores the Rules segment on this tab *and* Share of
  Voice.
- **Feed the Report from SQP instead of the empty `KeywordRank`.** Delivers **Search Volume**
  (7,799 queries), **market popularity rank**, and **our impression / click / purchase share per
  ASIN** — real columns with real data, in place of four permanently-empty ones.
- **Add week-over-week share Δ** — the honest version of "Rank Δ" until true rank exists.
- **Say what the tab is measuring.** Share is not position. A column called "Organic Rank" that
  holds an impression share would be the exact defect class this programme keeps removing.

### Tier 1 — recover and extend what exists *(days)*
- **Diagnose and restart the SQP cron** (§5). Everything above depends on it.
- **Import the console-only Search Term Impression Share report** for a true sponsored rank. The
  repo already has `AdsConsoleImport` / `AdsConsoleRow` for exactly this pattern — an operator
  downloads the report, the system parses it. No scraping, no vendor, no ToS question.
- **Track a curated list, not everything.** `KeywordCoverageSet` already holds **97 terms** and
  `AdKeywordProtection` holds your 10 brand terms. A tracker over 100 chosen keywords is a product;
  a tracker over 5,294 is a bill.

### Tier 2 — true organic rank *(a decision, not a task)*
Only two honest routes, and I would **not** build a scraper:
- **Buy the data.** Helium 10, DataHawk, SellerSprite and Keepa all sell rank feeds; SERP APIs
  (Rainforest, ScrapingBee and similar) return a parsed results page as JSON including position and
  sponsored-slot flags. `KeywordRank.source` was designed for exactly this — a vendor id per row.
  Cost is per-keyword-per-market-per-day, which is why Tier 1's curated list comes first.
- **Do without it.** Impression share from SQP plus top-of-search share from the placement report
  already answer "are we visible on this term and gaining or losing", which is the decision rank is
  usually a proxy for.

### Tier 3 — rank drives bids *(after Tier 1 or 2)*
`KEYWORD_RANK_BID` already exists end-to-end and has **zero rules**. Once any rank-like signal is
flowing, this is a rule definition, not a build. It is the Ad Badger move, and the substrate is done.

---

## 8 · How this tab is *supposed* to be

> **One question: for the keywords I care about, am I on the page — and is it getting better or
> worse?**

- A **curated watchlist**, per market, seeded from the 97 coverage terms and the 10 protected terms.
- One row per **keyword × market**, carrying: market volume · market popularity rank · **our best
  ASIN's share** · which of our ASINs are competing · ad spend on that term · Δ vs last week.
- **Named honestly.** Where we have share, it says share. Where we have position, it says position.
  Never one wearing the other's label.
- **Every row links somewhere** — to the campaigns bidding on that term, and to the products.
- **Rank movement can arm a rule** through the trigger that already exists.

---

## 9 · What I need from you

1. **Is true organic rank worth paying for?** It is the only column that cannot come from data you
   already own. If yes, Tier 2 becomes a vendor decision; if no, the tab becomes a share tracker and
   should be renamed as one.
2. **Should this tab merge into Share of Voice?** They are the same question — visibility on a
   query — and they are already the same component. You reversed the merge yesterday; I am not
   re-proposing it, only noting that this study points the same way.
3. **Do you want the SQP cron diagnosed now?** It is the only finding here that is actively
   costing you data every day, and it is independent of any UI decision.
4. **Which keywords actually matter?** The 97 in the coverage set, the 10 protected terms, the 297
   we bid on, or a list you keep elsewhere?

---

## Appendix — scripts

| script | what it measures |
|---|---|
| `_kt-study.mts` | `KeywordRank`, `KEYWORD_RANK_BID` rules, target universe, every rank proxy |
| `_kt-study2.mts` | SQP at ASIN grain: self-overlap per query, share, week-over-week movement |
| `_kt-study3.mts` | SQP ingest health per week per market |
| `_kt-study4.mts` | whether the SQP cron has ever recorded a run |

All read-only. All run with
`NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/<name>` from `apps/api`.

### Sources

- [Helium 10 Keyword Tracker](https://www.helium10.com/tools/keyword-research/keyword-tracker/) ·
  [Helium 10 vs Jungle Scout](https://www.helium10.com/blog/helium10-vs-jungle-scout-tools-and-features-analytics/)
- [How to Track Keyword Ranking on Amazon — Jungle Scout](https://www.junglescout.com/resources/articles/how-to-track-keyword-ranking-on-amazon/)
- [8 Amazon rank trackers tested for accuracy — Keywords.am](https://keywords.am/blog/amazon-keyword-rank-tracker-tools/)
- [9 Best Amazon Keyword Rank Trackers — Trellis](https://gotrellis.com/resources/blog/9-best-amazon-keyword-rank-trackers/)
- [Best Keyword Tracker 2026 — Ad Badger](https://www.adbadger.com/blog/best-keyword-tracker-2026-top-tools-for-ppc-amazon/)
- [Search Term Impression Share report for Sponsored Products — Amazon Ads](https://advertising.amazon.com/resources/whats-new/search-term-impression-report-sponsored-products) ·
  [SIS report help](https://advertising.amazon.com/help/G7AQQUSFVZPAAXEU)
- [`searchTermImpressionRank` unsupported in the API — amzn/ads-advanced-tools-docs #244](https://github.com/amzn/ads-advanced-tools-docs/discussions/244)
- [Search Term Impression Share data source — Intentwise](https://www.intentwise.com/foundation/data-store/amazon-ads/sponsored-products-search-term-impression-share-report)
- [Amazon keyword rank tracking with an API — EasyParser](https://easyparser.com/blog/amazon-keyword-rank-tracking-api-guide)
