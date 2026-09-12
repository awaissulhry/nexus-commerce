# SOV — Share of Voice: study 2 of 11

*Rules & Automation, tab-by-tab, right to left. Study 1 was [Keyword Tracker](2026-08-11-kt-keyword-tracker-study.md).*
**Read-only study. Nothing was changed. No code was written.**

Measured on production 2026-08-11 with `apps/api/scripts/_sov-study.mts` — read-only, re-runnable.

---

## 0 · The one-sentence version

The column labelled **"Share of Voice" is not a share of voice** — it is each query's share of *our
own* ad impressions, it sums to 100% across the tab, and on the account's biggest keyword it reads
**15.19%** where the real market share is **0.32%**; the genuine figure is already in the database,
in the same table this tab's sibling ignores.

---

## 1 · What the tab is, and every wire behind it

```
?tab=share-of-voice
└── RulesAutomationClient.tsx:337     <SovTrackerTab kind="sov" />
    └── tabs/SovTrackerTab.tsx         segmented [ Rules | Report ]
        ├── Rules  → RuleListTab liveType="sov"   ← same dead-string bug as Keyword Tracker
        └── Report → tabs/TrackerTab.tsx kind="sov"
                      └── GET /advertising/share-of-voice?limit=300
                          └── advertising.routes.ts:7284
                              └── services/advertising/ads-impression-share.service.ts
                                  └── reads AmazonAdsSearchTerm (our own ad search-term report)

Rule path  trigger SOV_BID → advertising-rule-evaluator.job.ts buildSovBidContexts()
Columns    Impressions · Clicks · Share of Voice · Top Campaign Share · Campaigns
```

**No table stores SOV.** It is computed live, per request, from `AmazonAdsSearchTerm` over a 30-day
window. That is a good design — nothing to keep in sync — and it is the only tab of the two studied
so far that renders real numbers.

---

## 2 · 🔴 The headline column measures the wrong thing

`ads-impression-share.service.ts:107`:

```ts
sovPct: totalImpressions > 0 ? a.impr / totalImpressions : 0
```

where `totalImpressions` is **every impression we tracked across every query**. So:

> **the tab's "Share of Voice" = this query's share of OUR OWN ad traffic.**
> **the industry's share of voice = our impressions ÷ the MARKET's impressions for that query.**

The service header says so plainly — *"Within-account Share of Voice: each query's impressions as a
share of all tracked impressions"*. The service is honest; **the column label is not.**

### Proof, three ways

**One — it sums to 100%.** Across the 300 rows the tab renders, the "Share of Voice" column
totals **98.29%**. A real share of voice does not sum to anything; a composition sums to 1.

**Two — the top row is a market minnow.** Measured, 30-day window, top 10 by impressions:

| query | our impressions | tab "SOV" | top campaign share | campaigns |
|---|---|---|---|---|
| motorrad jacke | 71,758 | **15.19%** | 100.00% | 1 |
| giacca moto uomo | 66,914 | 14.17% | 52.23% | 9 |
| giacca moto estiva uomo | 58,050 | 12.29% | 68.98% | 6 |
| chaqueta moto hombre invierno | 41,233 | 8.73% | 100.00% | 1 |
| motorrad jacke herren | 30,097 | 6.37% | 76.39% | 4 |

**Three — against the real figure.** 223 of the 300 rows also exist in Brand Analytics SQP, which
carries `impressionsBrand / impressionsTotal` — the actual share:

| query | mkt | tab "SOV" | **real market share** | market impressions (1 wk) | overstated |
|---|---|---|---|---|---|
| motorrad jacke | DE | 15.19% | **0.32%** | 53,660 | **47×** |
| giacca moto estiva uomo | IT | 12.29% | **0.70%** | 110,506 | **18×** |
| chaqueta moto hombre invierno | ES | 8.73% | **0.69%** | 3,459 | 13× |
| giacca moto uomo | IT | 14.17% | **1.52%** | 41,103 | 9× |
| motorrad jacke herren | DE | 6.37% | **0.78%** | 148,930 | 8× |
| giubbotto moto uomo | IT | 5.60% | **0.94%** | 14,200 | 6× |
| giacca moto | IT | 3.04% | **1.17%** | 30,286 | 3× |
| giacca estiva moto uomo | IT | 0.95% | **1.45%** | 12,512 | ~1× |

⚠️ **Read the raw counts with care, and do not compare them to each other.** Our impressions are a
**30-day** ad total; the market impressions are **one SQP week**. Only the two *share* columns are
comparable — and they are not the same quantity, so there is no meaningful single "overstatement
factor" for the tab as a whole. The point is that they are **uncorrelated**: the tab ranks
`motorrad jacke` first at 15.19% while we hold three-tenths of one percent of it, and ranks
`giacca estiva moto uomo` 15th at 0.95% while we hold more of that market than of any other row
above it.

**Why this matters operationally.** An operator reading this tab to decide where to push spend is
reading a map of where they already spend, not of where they are winning or losing. The two lists
are close to inverted.

---

## 3 · What on this tab *is* honest

Three columns are computed correctly and are genuinely useful, and the service labels its
guesswork as guesswork:

| signal | measured | what it means |
|---|---|---|
| `campaignCount` | 157 queries have ≥2 of our campaigns | self-competition, at campaign grain |
| `topCampaignSharePct` | 100% on 3 of the top 10 | one campaign owns the query outright |
| `outbid` flag | **596 queries** | above-median CPC, below-average impressions → probably losing the auction |
| `weak-relevance` flag | 108 queries | ≥50 impressions, CTR under half the median → we show but don't get clicked |

The service header calls these *"Lost-IS proxies (clearly labelled, not Amazon's metric)"*. That is
exactly the right posture, and it is the model the SOV column itself should have followed.

**596 outbid queries is the most actionable number on the tab and it is not surfaced anywhere** —
the flag exists in the API response and the grid renders no column for it.

---

## 4 · The rule path exists and is empty

`SOV_BID` is a live trigger with a context builder in the evaluator. **Zero rules use it.** Same
shape as `KEYWORD_RANK_BID` in study 1: the automation substrate was built, the surface was built,
and nothing was ever armed.

---

## 5 · The real share of voice is already in the database

`SearchQueryPerformance` — 15,075 rows, 7,799 distinct queries, IT/DE/ES/FR, ASIN-level, weekly —
carries `impressionShare`, `clickShare`, `cartAddShare` and `purchaseShare` against **market
totals**. That is share of voice by the standard definition, plus the funnel underneath it.

It is already trusted elsewhere: `ad-rank-defend.job.ts:563` uses `sqpImpressionShareForAsins()` as
the rest-of-search feedback signal. **The rank engine reads the real number; the Share of Voice tab
does not.**

### And it shows what we are not bidding on

| | queries |
|---|---|
| we paid on (ad search-term report) | 5,294 |
| the market data knows (SQP) | 7,799 |
| both | 1,979 |
| **in SQP, never advertised on** | **5,820** |

🔴 **Same caveat as study 1: the SQP feed stopped on 2026-07-26** and is 16 days stale. Everything
in this section degrades until that is fixed.

---

## 6 · How the industry does this

### 6.1 There are two competing definitions, and the difference is not cosmetic

| | **impression SOV** | **slot / shelf SOV** |
|---|---|---|
| formula | your ad impressions ÷ total market ad impressions | your appearances on page 1 ÷ all brands' appearances on page 1 |
| used by | **Pacvue**, Perpetua — pulled from the ads API impression-share data | **Intentwise**, Helium 10, DataHawk — collected from the results page |
| covers | paid only | **paid *and* organic** |
| how obtained | API | scraping page 1, on a cadence |

Pacvue states it as `SOV = (Your Brand's Ad Impressions ÷ Total Market Ad Impressions) × 100`, and
separates **Share of Voice** (paid only) from **Share of Shelf** (paid + organic) — advising brands
to track both, because the gap between them is whether paid spend is converting into organic rank.

Intentwise states it as `SOV = (your brand's total appearances ÷ total appearances by all brands on
page 1) × 100`, and **scrapes page one four times a day**, separating organic listings, sponsored
products and brand ads.

**Our SQP-based figure is a third thing again** — share of *impressions Amazon recorded for the
query*, from Amazon's own Brand Analytics, covering paid and organic together. It is arguably the
most authoritative of the three and it needs its own label rather than being squeezed into
someone else's.

### 6.2 The enterprise tier

| platform | how SOV works | notable |
|---|---|---|
| **Pacvue** | paid + organic SOV across Amazon, Walmart, Target, Instacart, Chewy; **AMC data integrated** into self-service dashboards with real-time refresh | **automated SOV dashboards and alerts**; rules can fire on *organic share of voice* alongside stock level, Buy Box and sales velocity; **Bid Explorer** forecasts performance at different bid levels; **placement locks** hold a position on high-value keywords |
| **Skai** (+ **Profitero**) | *Shelf Intelligent Media* — Profitero's digital-shelf and competitive data surfaced **inside the campaign-management UI** so shelf signals drive bidding | the tightest "insight → media action" loop of the group; Profitero covers 1,400+ retailers in 70 countries with **daily** shelf intelligence and connects it to **actual retailer sales and category share** |
| **CommerceIQ** | real-time shelf signals across **1,450+ retailers**; ML diagnostics that go past surfacing an issue to **automating the fix** | explicitly frames SOV as an outcome to be improved, not a chart to be read |
| **Stackline** (Beacon) | AI monitoring of the whole catalogue; **organic traffic forecasting up to 52 weeks ahead** | forecasting is the differentiator — SOV as a leading indicator rather than a lagging one |

### 6.3 The mid-market / specialist tier

| platform | how SOV works |
|---|---|
| **Helium 10 Market Tracker 360** | build a "market" from **up to 15 keywords + unlimited ASINs**; near-real-time SOV and market dominance; top-performing and fastest-growing competitors; 11 marketplaces; historical trend |
| **Intentwise** | setup = brand names + keyword list + tracking frequency; six-tab UI (below) |
| **DataHawk** | **blends organic rank tracking with ad data into one SOV metric** — closest to the "one honest number" position |
| **Perpetua** | paid SOV from the ads API; strong on automation, blind to organic |

### 6.4 The UI, concretely

Intentwise's is the most fully specified and is a good target shape:

- **Overview** — brand-level summary, top keywords, trend snapshots
- **Brands** — time-series, **pin/unpin up to 10 competitors** to compare side by side
- **Keywords** — per keyword, the products ranking on it, with brand ownership, star ratings, reviews
- **Products** — ASIN-level, **best and average position**, reviews, ratings, average display price
- **Daily Tracker** — daily / weekly / monthly, **colour-scaled so you scan for change rather than read numbers**
- Saved filters, row pinning, quicklinks, CSV/Excel export, **13 months** of history

Metrics reported: **Total SOV** (organic + paid), **Organic SOV**, **Ad SOV**, average organic
position, average ad position, product and keyword counts. Filters: branded vs non-branded
(non-branded is the *default* — a deliberate choice, since your own brand terms flatter every
number), keyword category, position range.

### 6.5 The 2026 feature bar

1. **Paid and organic SOV separately, and their sum** — the gap between them is the actual insight.
2. **Competitor brands named and comparable**, not just "us vs everyone".
3. **A curated keyword set per market**, not everything you happened to bid on.
4. **Branded excluded by default.**
5. **Trend before level** — a colour-scaled daily grid beats a precise number for one day.
6. **Alerts on movement**, so you find out in a day, not at the month-end review.
7. **SOV drives bids** — Pacvue's rules read organic SOV; CommerceIQ automates the fix. A chart
   nobody acts on is the failure mode every one of these vendors markets against.

**Where we would beat all of them:** none has Brand Analytics share, ad spend, PIM catalogue and
the write path in one system. Pacvue must *infer* which of your ASINs holds a term; SQP tells us
directly, per ASIN, from Amazon.

---

## 7 · What we could implement, cheapest first

### Tier 0 — rename, reveal, no new data *(hours)*
- **Stop calling it Share of Voice.** The column is *"% of our ad impressions"* — a real,
  useful mix metric. Label it as one. This is the cheapest and most important fix on the tab.
- **Surface the `outbid` flag as a column.** 596 queries where we are probably losing the auction,
  already computed, already in the API response, rendered nowhere.
- **Fix the `liveType="sov"` string** so the Rules segment can show a row.

### Tier 1 — add the real number *(days)*
- **Join SQP and add a true `impressionShare` column** beside the mix column, clearly distinguished.
  Adds the funnel too — click share, cart-add share, purchase share — which is more than any
  competitor shows, because it comes from Amazon rather than from a scrape.
- **Restart the SQP cron** (study 1, §5). Everything here depends on it.
- **Add the 5,820 unbid queries as an opportunity view.** Demand we can see and are not buying.

### Tier 2 — the parts we genuinely lack *(a decision)*
- **Organic SOV** needs page-one collection — same decision as study 1's Tier 2, same answer:
  buy it, don't build a scraper.
- **Competitor brands** likewise. SQP tells us our share, never who holds the rest.

### Tier 3 — SOV drives bids
`SOV_BID` exists end-to-end with zero rules. Once the share column is real, this is a rule
definition, not a build — and it is exactly what Pacvue charges for.

---

## 8 · How this tab is *supposed* to be

> **One question: on the terms that matter, how much of the market do we hold — and is it moving?**

- A **curated keyword set per market**, branded excluded by default.
- One row per keyword × market: market volume · **our real impression share** · click and purchase
  share · which of our ASINs holds it · what we spend on it · Δ vs last week.
- **Both numbers, both named** — market share *and* our own traffic mix. They answer different
  questions and neither should wear the other's label.
- **Trend-first**: a colour-scaled weekly grid, not a single-day precision figure.
- The `outbid` and `weak-relevance` flags promoted to first-class, because they say what to *do*.
- Movement can arm a rule through the trigger that already exists.

---

## 9 · What I need from you

1. **Rename or repair?** Do you want the existing mix metric kept (renamed) alongside the real
   share, or replaced by it entirely?
2. **Is organic SOV worth buying?** Same question as study 1 — and the same vendor would supply
   both, so it is really one decision across the two tabs.
3. **Do you want competitor brands named?** That is the biggest single gap versus Pacvue/Helium 10
   and it cannot come from Amazon's APIs at all.
4. **Same keyword-set question as study 1** — the 97 coverage terms, the 10 protected terms, the
   297 we bid on, or your own list?

---

## Appendix — script

`apps/api/scripts/_sov-study.mts` — read-only. Runs the real `analyzeShareOfVoice()` service,
compares every row against SQP, counts the flags and the rule path, and measures paid-vs-market
query coverage. Run with
`NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_sov-study.mts` from `apps/api`.

### Sources

- [Ultimate Guide to Share of Voice in Retail Media — Pacvue](https://pacvue.com/blog/ultimate-guide-to-share-of-voice-in-retail-media/) ·
  [Market & Competitive Intelligence — Pacvue](https://pacvue.com/platform/market-competitive-insights/) ·
  [Dayparting with SOV data — Pacvue](https://pacvue.com/blog/how-to-adjust-your-amazon-ppc-dayparting-during-shopping-events-using-share-of-voice-data/)
- [Shelf Intelligent Media — Skai](https://skai.io/capabilities/profitero/) ·
  [Digital Shelf Optimization — Skai](https://skai.io/digital-shelf-optimization/)
- [Best digital shelf analytics software 2026 — Inriver](https://www.inriver.com/resources/best-digital-shelf-analytics-software/) (CommerceIQ, Profitero, Stackline coverage)
- [How to Use Share of Voice to Track Brand Visibility on Amazon — Intentwise](https://help.intentwise.com/shareofvoice) ·
  [How Share of Voice metrics build a competitive edge — Intentwise](https://www.intentwise.com/blog/how-share-of-voice-metrics-build-a-competitive-edge)
- [Amazon Share of Voice (SOV): What It Is and How To Track It — DataHawk](https://datahawk.co/blog/retail-analytics/share-of-voice/)
- [Market Tracker 360 — Helium 10](https://www.helium10.com/tools/analytics/market-tracker/) ·
  [Market Tracker vs 360 comparison](https://www.helium10.com/blog/market-tracker-and-market-tracker-360-comparison/)
