# SOV.0 — Share of Voice: the basis

*Page 2 of 11 in the Rules & Automation conversion. Session slug `sov0`, 2026-08-12.*
*Study: [the page study](2026-08-11-sov-share-of-voice-page.md) · [the tab study](2026-08-11-sov-share-of-voice-study.md).*
*Sibling: [Keyword Tracker](2026-08-11-kt-keyword-tracker-page.md) — wherever the question was the
same, the answer here is the same.*

Route: `/marketing/ads/rules-automation/share-of-voice` ·
Endpoint: `GET /advertising/share-of-voice-page` (in `advertising-intel.routes.ts`).

Measured on production with `_sov0-probe.mts`, `_sov0-states.mts`, `_sov0-zero.mts`,
`_sov0-zerowhy.mts`, `_sov0-weeks.mts` and `_sov0-never.mts` — all read-only, all re-runnable, all
in `apps/api/scripts/`.

---

## 0 · The one-paragraph version

The page exists because the column it replaces divides by a number nobody asked for. It now reads
`SearchQueryPerformance` — the whole market's impressions against ours — through one scope
resolver, one period gate and one blank-state contract, all shared with the Keyword Tracker rather
than re-derived. **One metric column**, deliberately, because the four things underneath it are what
every later column inherits. Four things in the brief did not survive measurement and are corrected
in §6: two of the four named zero fixtures are not zeros, the `?kind=` filter can never move a pixel
on this page's data, the `sort`/`dir` write-back gap was closed upstream three commits ago, and the
`?weeks=` control turns out to be load-bearing rather than decorative.

---

## 1 · What was built — every wire

```
/marketing/ads/rules-automation/share-of-voice
└── share-of-voice/page.tsx                       force-dynamic + <Suspense fallback={null}>
    └── share-of-voice/ShareOfVoiceClient.tsx     the whole page
        ├── AdsPageHeader                         market picker (showDateRange={false})
        ├── RulesTabs active="share-of-voice"
        ├── KeywordScopeBar                       ← IMPORTED from ../keyword-tracker, not copied
        └── AdsDataGrid                           7 columns, onSortChange → the URL
            └── GET /advertising/share-of-voice-page
                advertising-intel.routes.ts:611
                Cache-Control: private, max-age=60
                └── services/advertising/share-of-voice.service.ts:167  getShareOfVoice()
                    ├── resolveScope()       ← IMPORTED from keyword-tracker.service.ts
                    ├── chooseViewPeriod()   ← IMPORTED from keyword-tracker.service.ts
                    └── classifyBranded()    ← IMPORTED from keyword-watchlist.service.ts

Tab flip     _shared/tabs.tsx:97               routed: true + subtitle
Branch drop  RulesAutomationClient.tsx:33      the `share-of-voice` branch + the SovTrackerTab import
CSS          rules-automation.css:2304         `h10-sov-*`, appended at EOF
```

| file | what changed |
|---|---|
| `share-of-voice/page.tsx` | **new** — mirrors `keyword-tracker/page.tsx` exactly |
| `share-of-voice/ShareOfVoiceClient.tsx` | **new** — the page |
| `services/advertising/share-of-voice.service.ts` | **new** — the one read |
| `routes/advertising-intel.routes.ts:611` | **+1 route, +1 import.** Additive |
| `_shared/tabs.tsx:97` | `routed: true` + subtitle. Nothing else in that file |
| `RulesAutomationClient.tsx` | the `tab === 'share-of-voice'` branch removed, and its import — see §5.1 |
| `rules-automation.css:2304` | `h10-sov-*` appended at EOF |

**Nothing was forked.** `resolveScope`, `chooseViewPeriod`, `KT_LOOKBACK_DAYS`,
`SQP_COMPLETENESS_RATIO`, `SQP_BASELINE_PERIODS`, `classifyBranded` and `normTerm` are all imported.
`KeywordScopeBar` is imported from KT's directory unchanged — it is already generic (it takes
`{options, market, scope, onChange, boundBy}` and has no watchlist coupling), so an import was
enough. The moment it needs a change it gets lifted to `_shared/ScopeBar.tsx` with KT's import
updated in the same commit.

**Not touched, deliberately:** `ads-impression-share.service.ts`, `GET /advertising/share-of-voice`
(`advertising.routes.ts:7284`, still serving its CSV), `SovTrackerTab.tsx`, `TrackerTab.tsx`,
`advertising-rule-evaluator.job.ts`, `SOV_BID`, `_rank/*`, `_schedule/*`, `keyword-tracker.service.ts`.

---

## 2 · The three decisions this session had to make on its own

### 2.1 The population is the MARKET, and `?list=` filters it

> **Keyword Tracker is a watchlist view — a term is there because a human put it there.
> Share of Voice is a market view — a term is there because a market exists.**

So the rows are the queries Brand Analytics reported for **this market in the chosen period**, and
`?list=` defaults to `all`. That is the deliberate inverse of KT, which defaults to its list.

The other candidate was a six-week union of every query seen in the lookback. Measured
(`_sov0-states.mts` §6) — it is a grid of dashes:

| market | chosen-period rows | 42-day union | blank under the union |
|---|---|---|---|
| IT | 482 | 1,520 | **1,038 (68%)** |
| DE | 276 | 1,040 | 764 (73%) |
| ES | 316 | 697 | 381 (55%) |
| FR | 37 | 77 | 40 (52%) |

A market view that is two-thirds blank is not a market view. Those extra rows are a *trend* fact —
they belong to SOV.1's week-over-week Δ, where a blank means "it moved", not "no data".

### 2.2 The value SUMS our ASINs; it does not take the best one

KT reads its **best** ASIN's share, because its question is "the term I am defending". This page's
question is "how much of this market do we hold", which is every ASIN of ours on the query.

Summing is only safe if the market total is genuinely one number repeated per ASIN row. Verified on
IT 2026-07-19, 655 rows / 482 queries (`_sov0-probe.mts` §3):

| check | result |
|---|---|
| queries whose ASIN rows **disagree** about `impressionsTotal` | **0** |
| queries where Σ `impressionsBrand` > `impressionsTotal` | **0** |
| queries carrying a brand-level (`asin = null`) row that would double-count | **0** |
| rows where the stored `impressionShare` ≠ brand ÷ total by >2bp | **0 of 655** |

So: `total = max` (repeated, not additive), `brand = Σ` over the scoped ASIN rows.

### 2.3 `?weeks=` is load-bearing, not decoration

The brief calls for `?weeks=4|8|13`, default 8, moving "the SHARE columns only". With **one** period
rendered there is no trend for a window to move — so on the face of it the control fails §3.0's law
(*name the pixel that changes, or it does not go there*).

It passes, because with one period the only thing a history bound can change is **which** period —
and it does. `weeks` maps to the imported gate's `lookbackDays = weeks × 7`. Measured
(`_sov0-weeks.mts` §1):

| market | weeks=4 (28d) | weeks=8 (56d) — default | weeks=13 (91d) |
|---|---|---|---|
| IT | 2026-07-19 · complete · 480 rows | 2026-07-19 · 480 | 2026-07-19 · 480 |
| DE | 2026-07-19 · complete · 276 rows | 2026-07-19 · 276 | 2026-07-19 · 276 |
| **ES** | **2026-07-26 · TRUNCATED · 61 rows** (71 SQP rows vs a 414-row normal week) | 2026-07-12 · complete · **316** | 2026-07-12 · 316 |
| **FR** | **2026-07-26 · TRUNCATED · 1 row** (1 vs 69) | 2026-07-12 · complete · **37** | 2026-07-12 · 37 |

Two consequences worth recording:

1. The control moves every number on the ES and FR grids. It earns its place.
2. 🔴 **It makes the truncated-week banner reachable by hand.** KT.1b shipped that branch and could
   verify it only by unit test — *"the first day the feed stalls for six weeks, that sentence
   renders untested in a browser."* On this page `?market=ES&weeks=4` renders it today, and it was
   verified in a browser on prod (§4).

The default is 8 weeks = 56 days rather than KT's shipped `KT_LOOKBACK_DAYS = 42`. KT.1b measured
42 ≡ 56 in all four markets and I re-verified it on today's data, so the two sibling pages show the
same week. `ktLookbackDays` is returned in the payload so the day they diverge, the page can say
which bound it used.

---

## 3 · The four blank-states, each on a named prod row

The point of this column is that the layer below destroys the distinction: `share()`
(`sqp.service.ts:75`) returns `0` when the market total is `0`, so *"Amazon reported no market
total"* and *"we hold none of this market"* arrive at a UI identically. **This service never calls
it**, returns `null` and `0` and never coalesces them.

| state | test | renders | demonstrated on prod |
|---|---|---|---|
| **measured** | a scoped row in the chosen period | the real percentage | IT default view — **480 of 480**, e.g. `accessori moto` **0.07%** (183,479 market impressions, ours 121, volume 7,615, rank #1) |
| **not covered** | the market has this query this period; none of the scope's ASINs do | `outside coverage` pill + the market's size on hover | IT portfolio `255127157311072` — **49 of 480**, e.g. `hugo boss uomo` (48,699 market impressions, volume 1,691). And portfolio `190601227863497`: **480 of 480** — 40 ASINs, Brand Analytics reports on none |
| **no row this week** | measured before, absent from this period | `—` + **last seen DD MMM**, unbounded by the lookback | DE watchlist — **11 of 31**, e.g. `motorradjacke damen`, last seen **2026-07-12** |
| **never measured** | no SQP row for this query × market, ever | `—`, muted | IT watchlist at `?branded=1` — **9 of 107**, e.g. `air mesh`, `aireon`, `airmesh`, `gale`. DE: **10 of 31** |
| *(fifth, unnamed in the brief)* **no market total** | a row exists but `impressionsTotal = 0` | `no market total` pill — **never** `0%` | **0 rows today** in all four markets. This is the exact tie `share()` hides; the API distinguishes it whether or not it fires |

### 🔴 The one state that could not be demonstrated: "we hold none"

**There is no real zero anywhere on this page today, at any scope, in any market.** Stated plainly
rather than papered over — this is the KT.1b truncated-week situation in reverse.

Measured (`_sov0-states.mts` §1, `_sov0-zero.mts`):

- At **query grain**, in the period each market renders: **0 real zeros** in IT, DE, ES and FR.
- At **per-ASIN row grain**, inside those same periods: **0 rows** with `impressionsBrand = 0` and a
  real total. So no scope — portfolio, campaign or line — can isolate one either. Both probes swept
  every campaign and portfolio in all four markets and found none.
- The state **is real in the feed**, just not in the weeks the gate picks: IT 2026-07-12 holds
  **88 zero rows of 1,066**, 07-05 **115 of 989**, 06-21 **139 of 1,042**.
- The reason is a property of what Amazon returned, not of this code: in IT 2026-07-19 the minimum
  `impressionsBrand` across all 655 rows is **1**; in 2026-07-12 it is **0** (`_sov0-zerowhy.mts`).
  Amazon simply returned no zero-impression rows for the weeks now being rendered.

The renderer is therefore **verified by construction and by the API contract, not by eye.** The
first week Amazon returns a zero row inside the chosen period, it paints amber with the market's
size beside it.

### 🔴 A finding for SOV.1, found while looking for a zero

Four whole weeks are **100% zeros** — IT 2026-06-07 462/462, DE 234/234, ES 290/290, FR 61/61; and
2026-05-31, 05-24, 05-17 the same shape. That is **not** "we held none of the market". It is the
pre-`ACR.0.2` parser defect that `sqp.service.ts`'s own header documents (*"the 'our side' counts
were reading 0 on every one of 9,232 prod rows while the totals read 53.1M"*), and those weeks were
never re-ingested.

**SOV.1's week-over-week Δ must exclude them or it will report a catastrophic collapse that is pure
artefact.** A Δ from 2026-07-19 back to 2026-06-07 is a comparison against a parser bug.

---

## 4 · Verified on production

### 4.1 `asOf` is ONE value per view — proven, not asserted

`_sov0-weeks.mts` §2 runs the shipped service and counts the distinct `asOf` a measured row can
carry, in every market plus a portfolio, a campaign and a product line:

| view | boundBy | campaigns | ASINs (SQP this week / ever) | asOf | **distinct** | census |
|---|---|---|---|---|---|---|
| IT · market | market | 149/149 | 250 (18/32) | 2026-07-19 | **1** | 480 measured |
| DE · market | market | 38/38 | 57 (13/13) | 2026-07-19 | **1** | 276 measured |
| ES · market | market | 10/10 | 30 (14/15) | 2026-07-12 | **1** | 316 measured |
| FR · market | market | 22/22 | 91 (4/4) | 2026-07-12 | **1** | 37 measured |
| IT · portfolio `255127157311072` | portfolio | 11/149 | 18 (10/17) | 2026-07-19 | **1** | 431 measured · 49 not covered |
| IT · portfolio `190601227863497` | portfolio | 11/149 | 40 (0/2) | 2026-07-19 | — | 0 measured · **480 not covered** |
| IT · campaign "GALE \| IT \| Broad \| Brand" | campaign | 1/149 | 18 (10/17) | 2026-07-19 | **1** | 431 measured · 49 not covered |
| IT · line `1J-EYE5-Y0TW` | line | 4/149 | 5 (0/0) | 2026-07-19 | — | 0 measured · 480 not covered |

**Max distinct `asOf` across every view tested: 1.** (The two dashes are views with no measured row
at all, which is the rendered zero-coverage state, not a period spread.)

### 4.2 Scope reach, and the portfolio hole

Measured (`_sov0-probe.mts` §0): **220 campaigns · 72 with a portfolioId** — IT 150 (1 archived, so
149 live) · DE 38 · ES 10 · FR 22. In IT, **95 of the 149 live campaigns carry no portfolio id**, so
a portfolio-scoped view is blind to them and the page says so in amber above the grid rather than
looking complete.

Coverage — advertised ASINs vs ASINs Brand Analytics has ever reported on:

| market | advertised | SQP knows | both | covered |
|---|---|---|---|---|
| IT | 250 | 33 | 32 | **12.8%** |
| DE | 57 | 14 | 13 | 22.8% |
| ES | 30 | 15 | 15 | 50.0% |
| FR | 91 | 5 | 4 | **4.4%** |

Every view states this before any figure:
`IT · all campaigns · 149 of 149 IT campaigns · 32 of 250 ASINs have Brand Analytics rows`.

### 4.3 Freshness — two feeds, two ages

Identical in all four markets: **SQP newest 2026-07-26, 17 days old · ads newest 2026-08-10, 2 days
old.** The band states both separately, plus the row count against the trailing norm, because 85
rows in a fresh week is a worse fact than a two-week-old full one.

### 4.4 Paging, filters and refusals

- **Paging** — `limit=50&offset=0` vs `offset=50`: 50 + 50 rows, **overlap 0**, `total` stable.
- **`branded=1`** — 482 rows vs 480 at the default. Exactly 2 branded queries in IT.
- **`kind=all`** — 480 rows, identical to `kind=keyword`. See §6.2.
- **`?list=` from another market** — refused, `listRejected: true`, and the page says so. A nonsense
  id is *not* flagged as rejected (it is simply absent), which is the same distinction KT draws.
- **`market=all` or an unknown market** — `400 {code:'market_required'}` from the route; the page
  renders the "pick one market" panel with four one-click routes out.

### 4.5 Geometry and colour, measured on prod, not by eye

*(To be completed against the live deploy — see §7.1. The two known traps are pre-empted in code:
every block uses `margin: … 0 0` rather than the `.h10-svt-seg` 24px pattern, and the first-column
override is written at matching specificity, `.h10-am-grid td.nm .h10-sov-q .t`, at the END of the
stylesheet.)*

---

## 5 · Known gaps — every one of them

### 5.1 The `SovTrackerTab` import had to go, and the brief said to leave it

The brief says *"Leave the `tab === 'keyword-tracker'` branch and the `SovTrackerTab` import
alone."* **There is no `keyword-tracker` branch — KT.1 removed it** — so the `share-of-voice`
branch was the import's *last* caller. Leaving an unused import fails the web build on
`noUnusedLocals`, which is precisely how NEG.1 held the whole push queue on 2026-08-12.

So the **import** is removed and the **component file is not**. `SovTrackerTab.tsx`, `TrackerTab.tsx`,
`ads-impression-share.service.ts` and `GET /advertising/share-of-voice` all stay: the service is
still imported by `buildSovBidContexts` and the route still serves a CSV. Retiring them is SOV.7's
work, and it is blocked on fixing the builder.

### 5.2 `?page=` does not round-trip from the UI

`limit`/`offset` are implemented server-side and verified (§4.4), so a hand-typed `?page=` works.
But `AdsDataGrid` keeps its page in local state and exposes **no `onPageChange`**, so clicking the
pager cannot reach the URL. The page requests one large page (2,000; the biggest market is 480 rows)
and lets the grid page.

**This is the identical shared-layer gap `?sort=` had**, and BID.S0 closed that one by adding
`onSortChange` (`AdsDataGrid.tsx:172`). The fix here is the same shape — an optional
`onPageChange?: (n: number) => void` fired from the pager, plus a re-sync keyed on a `page` **number
primitive**, gated on the callback so the twenty-odd existing grids are provably untouched. It is
one change in one file for nine pages, and it is not a Share of Voice type.

### 5.3 Freshness is inline, awaiting `<FreshnessChip>`

Freshness is substrate-owned (spec §4, §6.3): one `GET /advertising/freshness`, one chip, one
definition of "stale". **Phase S has not happened** — KT and Negatives shipped page-first anyway.
The band is rendered inline from two fields on this page's own read, in the shape a chip replaces:
source · date · age · row count against the trailing norm. **No rival freshness endpoint was built.**

### 5.4 Reserved and declared, not implemented

Each is a comment in `ShareOfVoiceClient.tsx` naming the section that owns it, so the next seven
sessions do not invent a second spelling:

| param | owner | why not now |
|---|---|---|
| `?adWindow=7d\|14d\|30d` | **SOV.2** | there is no ad-side column yet for it to move |
| `?view=share\|mix\|unbid` | **SOV.4** | the unbid-demand view |
| `?signal=` | **SOV.3** | outbid / weak-relevance / cannibalised, once re-cut against the median |
| `?row=<query>@<market>` | **SOV.5** | read so a link survives the deploy that adds the drawer; opens nothing today |
| `?kind=` | honoured, no control | §6.2 — it cannot move a pixel on this page's data |

### 5.5 Smaller things, recorded

- **`reportPeriod` is unguarded**, exactly as KT records. All rows in all four markets are `WEEK`
  today (IT 6,535 · DE 3,733 · ES 3,900 · FR 907, measured), so the gate cannot yet be fooled — but
  one `MONTH` row would enter the candidate set.
- **`asinsCompeting` counts ASINs with a row**, including one whose own impressions are 0. That is
  "how many of ours Amazon reported on", not "how many won impressions". It matters the day a zero
  row appears.
- **The census counts `noMarketTotal` separately** from the four states. It is 0 today and returned
  anyway, because it is the tie the whole column exists to break.
- **`?q=` uses the page's own search box**, not the grid's. The grid's box keeps its text in local
  state with no callback out, so it could not write the URL; `searchable={false}` and one input in
  the toolbar avoids two search boxes.

---

## 6 · Where the brief and the study were wrong

Four corrections, each with the measurement.

### 6.1 🔴 Two of the four named zero fixtures are not zeros

The brief names four *"real IT zeros (`impressionsTotal > 0`, ours `0`), period 2026-07-12"*.
Measured (`_sov0-probe.mts` §5):

| fixture | brief says | measured |
|---|---|---|
| `givi` | 11,828 market impressions, ours 0 | 🔴 **not a zero.** On 07-12 it has **two** ASIN rows — `B0BMSJWW7L` brand **22** and `B0BMSWM15B` brand **46**. On 07-19, brand **99** |
| `giacca moto protezioni livello 3` | 778, ours 0 | 🔴 **not a zero.** 07-12: `B0BMSWM15B` brand **33** + `B0D8RPCJSH` brand 0. On 07-19, brand **12** |
| `africa twin` | 3,795, ours 0 | ✅ a real zero — but only in **2026-07-12**, and IT renders **2026-07-19** |
| `scorpion exo tech` | 520, ours 0 | ✅ same |

Two separate errors: the fixtures were read **per ASIN row** rather than per query (so a query with
one zero row and one non-zero row looked like a zero), and they are from **2026-07-12**, which is not
the period IT's gate chooses — it chooses 2026-07-19, the newer complete week. Consequence in §3:
the "we hold none" state cannot be demonstrated on any view today.

### 6.2 🔴 `?kind=` cannot move a pixel on this page

The brief carries *"643 of 5,383 paid 'queries' are ASIN strings"* into SOV.0's URL contract as
`&kind=keyword|asin|all default 'keyword'`. That fact is about **`AmazonAdsSearchTerm`** — the ad
side — and I reproduced it exactly: 5,383 distinct paid queries, **643 ASIN-shaped**.

`SearchQueryPerformance`, which is the only table SOV.0 reads, holds **0 ASIN-shaped queries in all
four markets, all-time** (IT 0 of 3,013 · DE 0 of 2,254 · ES 0 of 1,950 · FR 0 of 624).

So the param is **honoured and validated server-side** (a pasted link never 400s, and the filter is
correct if SQP ever gains one) and **no control is rendered**, because a control where no pixel moves
does not go on the page. It belongs with the ad-side columns in SOV.2.

### 6.3 ✅ The `sort`/`dir` write-back gap was closed upstream — three commits before this session

The brief says KT shipped `sort`/`dir` read-from-URL-but-never-written-back, that `AdsDataGrid` has
no sort callback, that I must not fork the grid, and that I should *"record the identical known
gap"*.

**It is no longer a gap.** BID.S0 added `onSortChange` and the `defaultSort` re-sync at
`313828494` (`AdsDataGrid.tsx:172`, `:373-381`, `:417`), additive and gated on the callback. This
page passes it, so a header click writes `?sort=` and `?dir=` to the URL. No fork, and one fewer
known gap than the brief expects. (KT itself does not yet pass the callback — that is KT's to take.)

### 6.4 The brief's period for the fixtures reveals a gate subtlety worth stating

IT's gate chooses **2026-07-19** (655 rows against a 655-row baseline median, threshold 328), not the
older, **larger** 07-12 (1,066 rows). That is correct behaviour — newest complete week wins, not
biggest — but it means the rendered week can hold fewer rows than the one before it, and any fixture
quoted from "the latest data" needs its period named. Every table in this document names its period.

### 6.5 One cross-page finding, not mine to fix

`classifyBranded` flags **`regalo rinfresco taxi uomo`** as a brand term, because the protection
`regal` is stored as `CONTAINS` and "regalo" is Italian for "gift". It is one of only two branded IT
queries, so at the default `branded=0` this page silently hides a genuinely non-branded query.

The classifier is KT.2's and is shared (it also seeds a **stored** flag on watchlist terms), so it is
not forked or worked around here. Recorded for whoever owns `AdKeywordProtection`: a `CONTAINS`
protection on a short word that is a prefix of a common one is a false-positive generator.

---

## 7 · What the next seven sessions own

Written so SOV.1–SOV.7 do not overlap, and so none of them re-derives what is settled here.

| section | owns | must reuse, never re-derive |
|---|---|---|
| **SOV.1** | Δ vs prior week; click / cart-add / purchase share; the colour scale against a category-realistic ceiling (~10%, not 0–100%) | the period gate; **and it MUST exclude the pre-`ACR.0.2` all-zero weeks — §3** |
| **SOV.2** | the ad-side columns (our impressions, spend, share of ad spend, CPC) and `?adWindow=` | the two-grain rule: one control may not silently move both grains. `?kind=` becomes real here |
| **SOV.3** | `Signal` — outbid / weak-relevance / cannibalised, re-cut against the **median** (the current bar is the mean; 1,925 of 1,992 queries sit below it, so it fires on 32% of the account) and `?signal=` | the census shape |
| **SOV.4** | the unbid view (`?view=`) — demand we already appear in organically and never buy | the boundary with Keyword Harvest: harvest promotes terms we already paid on; these were never touched |
| **SOV.5** | the row drawer (`?row=<query>@<market>`) — the weekly series, which ASIN holds the term, the campaigns bidding | the first-column override becomes a real link; delete the one CSS rule at `rules-automation.css` |
| **SOV.6** | export, saved views | `AdsDataGrid`'s `exportable` + `onExport`; the page supplies `onExport` |
| **SOV.7** | `SOV_BID` — **blocked.** `buildSovBidContexts` must be fixed first: `impressionSharePct` carries the wrong number (`advertising-rule-evaluator.job.ts:945`), the spend/ACoS guards are vacuously true (all 2,129 positive KEYWORD `AdTarget` rows carry `spendCents = 0`), and the market join is loose | the write gate is **Apply Rules**'; the ceiling is substrate's; this page renders a *refusal*, never a ceiling |

**Owned by other pages, and only linked to from here:** the watchlist and its editor (Keyword
Tracker) · position and organic rank (Keyword Tracker) · the 51 automations, the engine rows, the
proposal queue and the account-wide ledger (Automations) · per-scope spend ceilings
(substrate / `ads-write-gate.ts`) · promoting a converting term (Keyword Harvest) ·
top-of-search economics and placement pins (Placement) · the per-campaign write gate (Apply Rules).

---

## 8 · Coordination

**Claims held and released** (locks doc §2): `advertising-intel.routes.ts` · `_shared/tabs.tsx` ·
`RulesAutomationClient.tsx` · `rules-automation.css`. All additive; the CSS is EOF-appended under
`h10-sov-*` with no shared selector; the route path `share-of-voice-page` is disjoint from HV.1's,
KT.2's, BID.S0's, NEG.2's and PLC.0's, and from the existing `share-of-voice` in
`advertising.routes.ts` — `grep -a`ed both files.

🔴 **The API commit was staged as two hunks, not as a whole file.** A NEG.2 session had uncommitted
work in `advertising-intel.routes.ts` whose new route imports `getTermContext` from a
`negatives.service.ts` that is **not in HEAD**. `git commit --only` on that file would have swept
their work under my message *and* produced a commit that was green in the shared tree and red on its
own — the locks-doc §5 trap running in both directions at once. The two foreign hunks were filtered
out and only mine applied to the index. Isolation verified by checking out the commit into a
detached worktree and running `tsc` there: **clean**.

**Not fixed, and not mine:** `?tab=share-of-voice` now resolves to Apply Rules, because
`RulesAutomationClient.tsx` maps a *routed* `?tab=` to `'rules'`. NEG.1 established the fix — one
`has: [{type:'query', key:'tab'}]` redirect in `next.config.js` — and `?tab=keyword-tracker` has the
same live bug. `next.config.js` is claimed by **two** other sessions (HV.1 and BID.S0) with
uncommitted hunks, and the brief does not list it among this session's files, so adding a fifth entry
there was the exact `commit --only` hazard above. **It needs one line of the same shape**, and it is
recorded here and in the locks doc rather than taken.

---

## Appendix — scripts

All read-only, all re-runnable, all from `apps/api` with
`NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/<name>`.

| script | what it measures |
|---|---|
| `_sov0-probe.mts` | the account and the portfolio hole; the population window at 42d vs all-time; the gate under market / portfolio / campaign; whether `impressionsTotal` is constant across a query's ASIN rows; coverage per market; the brief's four fixtures; freshness per feed per market |
| `_sov0-states.mts` | real zeros per market in the period each renders; ASIN-shaped queries in SQP vs the ad side; branded queries via `classifyBranded`; every watchlist's three states; `not-covered` per portfolio; chosen-period vs 42-day-union population sizes |
| `_sov0-zero.mts` | the hunt for a renderable zero — per-ASIN zero rows, then every campaign and portfolio scope in four markets; then zero counts by period across history, which found the all-zero parser weeks |
| `_sov0-zerowhy.mts` | why the rendered weeks hold none: `min(impressionsBrand)` per period, and the ingest stamps |
| `_sov0-weeks.mts` | the SHIPPED service against prod — `?weeks=` at 4/8/13 in four markets; distinct `asOf` across eight views; the four states with a named row each; facets, freshness, paging |
| `_sov0-never.mts` | `never-measured` is only reachable at `?branded=1`, and the cross-market `?list=` refusal |
