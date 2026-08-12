# SOV.1 — Share of Voice: the market-share grid

*Section 1 of 7 on top of [SOV.0's basis](2026-08-12-sov-page-sov0-basis.md). Session slug `sov1`,
2026-08-12.* Route: `/marketing/ads/rules-automation/share-of-voice` ·
Endpoint: `GET /advertising/share-of-voice-page` (extended, not replaced).

Measured with `_sov1-verify.mts` (new, read-only, 10 sections) and by re-running the brief's own
`_sov-page-f.mts` / `_sov-page-g.mts` rather than trusting their summary.

---

## 0 · A note on the brief

**This prompt arrived corrupted** — roughly a third of its prose was truncated mid-sentence,
including most of §1's table, all of §2's eight items, §5's build detail, and §7–§9 throughout.
The section headers, the §4 measurement tables and §6's do-not-build list survived intact, which
fixed the scope; §4 itself said to re-run the probes rather than trust the summary, so **every
number below was re-derived rather than read**. Where a gap could have changed the work it is
called out in §6. Nothing was guessed silently.

---

## 1 · What was built

```
GET /advertising/share-of-voice-page
└── share-of-voice.service.ts
    ├── choosePriorPeriod()          NEW, exported, pure — the Δ's baseline
    ├── SovDeltaState                NEW — 'delta-measured' | 'delta-no-prior' | 'delta-not-applicable'
    ├── row: + marketClicks, ourClicks, clickShare, priorShare, deltaPt, deltaState,
    │        lowConfidence, lowConfidenceClicks
    └── payload: + period.prior, period.excludedPeriods, scopeDelta, shareSummary,
                 funnelCoverage, confidenceFloor, confidenceFloorClicks, 4 census counts
advertising-intel.routes.ts          + 'clickShare' and 'delta' in the sort allow-list

ShareOfVoiceClient.tsx
    ├── two columns: Δ vs prior week · Click share
    ├── the summary strip: weighted share · median query share · scope Δ
    ├── the funnel-coverage line, and the excluded-period line
    ├── shareBand() — the colour scale · deltaPt() — the second formatter guard
    └── the stated sort floor in the toolbar
rules-automation.css                 + 51 lines at EOF, h10-sov-* only
next.config.js                       + 4 routed-tab redirects; 1 legacy destination corrected
```

Three commits: the service + probe (`2f620b8ef`, carrying the route hunk), the client +
`next.config.js` (`f4bc68eb7`), the CSS (`858a21ae6`).

---

## 2 · The Δ, as two objects

### 2.1 Why one object was not enough

A per-row Δ needs the same query measured in two comparable weeks. Measured:

| market | chosen (`weeks=8`) | prior | gap | **rows with a prior** |
|---|---|---|---|---|
| IT | 2026-07-19 | 2026-07-12 | 7d | **136 of 480 — 28.3%** |
| DE | 2026-07-19 | 2026-07-12 | 7d | **55 of 276 — 19.9%** |
| ES | 2026-07-12 | 2026-07-05 | 7d | **57 of 316 — 18.0%** |
| FR | 2026-07-12 | 2026-07-05 | 7d | **7 of 37 — 18.9%** |
| ES | `weeks=4` → 2026-07-26 | 2026-07-12 | **14d** | 11 of 61 — 18.0% |
| FR | `weeks=4` → 2026-07-26 | 2026-07-12 | **14d** | **0 of 1 — 0.0%** |

Four rows in five have no Δ, and one view has none at all. That is not a defect: SQP reports on a
fixed ten ASINs per market and the query set those ASINs surface genuinely changes week to week.

So the Δ ships as **two objects**: a scope-level figure that is always computable and always honest,
and a per-row figure wherever the data supports one.

### 2.2 The scope-level Δ — over the intersection, and it says so

Rendered in the summary strip:

> **Δ vs the week of 12 Jul** · `−0.06pt` · *0.90% → 0.84% on 136 queries in both*

Measured, IT default view: **0.8988% → 0.8373% = −0.0615pt across 136 queries**, with **344**
measured queries stated as having no prior row and excluded from *both* sides.

**An intersection is not a filter.** Only queries measured in both weeks *within the current scope*
enter either side. Comparing this week's total share against last week's over two different query
populations is KT.1b's population-mixing defect at aggregate level — it produces a headline that
moves when nothing changed. Proof the scope binds it, not the market:

| view | intersection | prior → now | Δ |
|---|---|---|---|
| IT · market | 136 | 0.8988% → 0.8373% | −0.0615pt |
| IT · portfolio `255127157311072` | **131** | 0.9110% → 0.8124% | **−0.0986pt** |

Different population, different number. Aggregated `brand = Σ`, `total = max` per query, then both
summed and divided **once** — never an average of per-row percentages.

### 2.3 The per-row Δ, and `delta-no-prior`

`delta-no-prior` is **the fifth state SOV.0's contract asks for**, declared explicitly — but on its
**own axis**, not as a fifth member of `SovRowState`. 🔴 **This is a deliberate deviation from the
brief's literal shape**, and the reason is structural: a row is `measured` for impression share and
`delta-no-prior` for its Δ *simultaneously*. One enum cannot carry both without the Δ silently
overwriting the share column's state. The brief's own wording — *"measured this period; the
comparable prior week has no row for this query"* — describes exactly that pairing. The token it
names is kept verbatim.

Named rows, IT vs 2026-07-12 (gap 7d):

| query | prior | now | Δ |
|---|---|---|---|
| `accessori moto` | 0.0933% | 0.0659% | **−0.03pt** |
| `moto` | 0.0232% | 0.0674% | **+0.04pt** |
| `giacca moto estiva uomo` | 1.9165% | 1.8804% | **−0.04pt** |
| `motorrad jacke herren` (DE) | 1.6933% | 2.1950% | **+0.50pt** |
| `hugo boss uomo` | — | 0.0021% | **no prior week** |

Expressed in **percentage points**, never a percentage of a percentage. The column is labelled
**Δ vs prior week** and the strip names the date, because 🔴 **the gap is not always 7 days** — at
`?market=ES&weeks=4` it is 14.

### 2.4 🔴 The all-zero exclusion is computed, and it is worth what it costs

Fourteen periods across the four markets carry `impressionsBrand = 0` on **100%** of their rows:

| market | all-zero periods (rows) |
|---|---|
| IT | 2026-06-07 (462) · 05-31 (158) · 05-24 (376) · 05-17 (1) |
| DE | 2026-06-07 (234) · 05-31 (84) |
| ES | 2026-06-07 (290) · 05-31 (433) · 05-24 (569) · 05-17 (124) |
| FR | 2026-06-07 (61) · 05-31 (135) · 05-24 (177) · 05-17 (183) |

That is the pre-`ACR.0.2` parser defect `sqp.service.ts`'s own header documents, in weeks never
re-ingested. **What it would have cost, measured:**

| market | queries in both | prior share | now | the Δ that would have been reported |
|---|---|---|---|---|
| IT | 100 | 0.0000% | 1.0608% | **+1.0608pt out of nothing** (real market total 1,301,269) |
| DE | 34 | 0.0000% | 1.1786% | **+1.1786pt** (680,243) |
| ES | 58 | 0.0000% | 1.3448% | **+1.3448pt** (88,271) |
| FR | 5 | 0.0000% | 0.3197% | **+0.3197pt** (90,696) |

**It is derived every read, never a date list** — a hard-coded list rots the day a week is
re-ingested, and a stale exclusion that silently stops matching is worse than none. Independent
corroboration that this is a defect and not a fact: `clicksBrand > 0` is **0 rows** in every one of
those weeks and near-100% in every later one. Two counts cannot both collapse and recover together.

🔴 **The exclusion does not fire on today's data, and that is stated rather than implied.** Walking
back from each market's chosen period, a comparable week is always found before the corrupted range
is reached — the service skipped **0** all-zero periods in all four markets. It is a guard against a
stalled feed, not an active filter. Proven to work by calling `choosePriorPeriod` directly with a
hypothetical chosen period of 2026-06-14:

```
IT: prior NONE  reason=all-older-excluded
    skipped 4: 2026-06-07 (462 rows, all-zero) · 05-31 (158) · 05-24 (376) · 05-17 (1)
DE: skipped 2 · ES: skipped 4 · FR: skipped 4 — all `all-older-excluded`
```

When it does fire, the page says so in a sentence naming the week and the reason.

---

## 3 · Click share — and the two columns that are a sentence instead

Ships as one column: `clicksBrand / clicksTotal`, same `Σ brand / max total` rule, same null-vs-zero
discipline, `no market clicks` where the denominator is zero.

**Cart-add and purchase share do NOT ship as columns.** Our-side coverage in the default views:

| market | queries | impressions | **clicks** | cart-adds | purchases |
|---|---|---|---|---|---|
| IT | 482 | 482 | **475 (98.5%)** | **14 (2.9%)** | **1 (0.2%)** |
| DE | 276 | 276 | **270 (97.8%)** | 14 (5.1%) | 1 (0.4%) |
| ES | 316 | 316 | **315 (99.7%)** | 4 (1.3%) | **0** |
| FR | 37 | 37 | **37 (100%)** | **0** | **0** |

Two columns that are `—` on 97%+ of rows are two promises the data cannot keep. They render as one
line under the band — *"Click data covers 473 of 480 measured queries here. Cart-add data exists on
14 and purchase data on 1, so neither is a column"* — and belong in SOV.5's drawer.

This is **not** the parser defect: clicks parse fine in the same rows. Cart-adds and purchases are
genuinely sparse at query × ASIN × week grain.

### 🔴 A second confidence floor, found by measuring rather than reading

Filtering the click column by `lowConfidence` — an **impressions** test — still surfaced
`giacca moto 3xl` at **"25.00% click share"**, which is **1 of 4 market clicks**, on a row whose
5,364 market impressions clear the impression floor comfortably. **One flag cannot police two
denominators**, and the click denominator is two orders of magnitude smaller: the median is
**17 clicks** against **370 impressions** in IT.

`lowConfidenceClicks` is its own test on `marketClicks`. With it, the disagreements the column exists
to surface are real:

| query | impression share | click share | clicks |
|---|---|---|---|
| `revit eclipse 2 uomo` (IT) | 2.14% | **17.65%** | 3 of 17 |
| `felpa protezioni moto estiva` (IT) | 4.23% | **15.38%** | 4 of 26 |
| `motorcycle jacket with level 2 armour` (DE) | 5.66% | **17.65%** | 3 of 17 |
| `chaqueta moto rejilla` (ES) | 2.56% | **12.50%** | 5 of 40 |

Being chosen far more often than being seen is a bidding opportunity; the reverse is a creative or
price problem. That sentence is the column's tooltip.

---

## 4 · The colour scale and the sort discipline

### 4.1 What a naive share-descending sort puts on screen

| | AFTER (what the page renders) | BEFORE (naive share-desc) |
|---|---|---|
| 1 | 8.37% · 609 market impressions · `giacca moto livello 2 estiva` | **50.00% · 4 impressions** · `sappnetta knee spider nero` |
| 2 | 6.43% · 762 · `giacca scooter` | 15.79% · 19 · `giacca leggera moto estiva uomo con protezioni 4xl` |
| 3 | 5.50% · 600 · `giubbotto moto uomo con protezioni` | 10.67% · 75 · `giacca moto axpro` |
| … | 5.02% · **3,307** · `giubbino moto` | 9.52% · 84 · `giubotto oer la mkto` *(a typo)* |

**All ten of the naive top rows are low-confidence.** The arithmetic that settles it: the 5 IT
queries above 10% share carry **221 of 1,671,561 market impressions — 0.01% of the demand**, while
the 313 above 1% carry **29.18%**.

**Nothing is hidden.** Rows below the period's median denominator sink beneath confident ones when
sorting by share, click share or Δ, are muted regardless of value, and say why on hover. The floor
is **stated in the toolbar** — *"below 370 impressions: ranked last"* — and returned in the payload.

The floor is **derived from the period's own distribution** (its median market impressions), not a
magic number, so it adapts per market and per week: IT 370 · DE 290 · ES 176 · FR 313. Against a
median of just **85** among the top 20 by share — that gap is the whole argument.

### 4.2 The scale

| market | n | p10 | p50 | p90 | max | >10% |
|---|---|---|---|---|---|---|
| IT | 480 | 0.18% | **1.80%** | 4.76% | 50.00% | 5 |
| DE | 276 | 0.13% | **1.34%** | 4.76% | 10.00% | 0 |
| ES | 316 | 0.46% | **2.35%** | 4.92% | 10.53% | 1 |
| FR | 37 | 0.22% | **0.54%** | 4.44% | 9.09% | 0 |

So the bands put their resolution between 0 and 5% (`b1` <0.5% · `b2` 0.5–2% · `b3` 2–5% · `b4`
5–10% · `b5` ≥10%), with one distinct treatment above 10%. A linear 0–100% scale renders this page
one flat colour. Pacvue's *"84 brands compete for the top 10 keywords, none exceeding 10% paid SOV"*
is **corroborated** as a ceiling — it just cannot be the whole scale. `.thin` is declared last so it
beats every band on source order.

---

## 5 · The band's pair of numbers

> **Our share of all measured demand 0.77%** · *12,887 of 1,671,401* — **Median query share 1.80%**
> · *across 480 queries*

| market | weighted | median query | ratio |
|---|---|---|---|
| IT | **0.77%** | 1.80% | 2.33× |
| DE | **0.74%** | 1.33% | 1.81× |
| ES | **0.62%** | 2.34% | **3.78×** |
| FR | **0.34%** | 0.54% | 1.59× |

The gap is the finding: **we hold a couple of percent of hundreds of tiny queries and almost nothing
of the big ones.** Neither ships alone — the median alone flatters the account, the weighted figure
alone hides where we actually win.

---

## 6 · Where this brief was wrong

### 6.1 🔴 The weighted/median gap is ~2.3×, not ~8×

§5.4 states the weighted figure is *"~8× smaller than the median of the per-row percentages"*.
Measured, it is **2.33× in IT**, 1.81× DE, 3.78× ES, 1.59× FR — the largest gap in the account is
under 4×. The finding survives (the two numbers disagree materially and both must be shown); the
magnitude does not. The page states both figures rather than the ratio, so nothing renders the wrong
number — but a reader of the brief would expect a bigger gap than exists.

### 6.2 The fifth Δ state cannot live in `SovRowState`

§5.1(b) presents `'delta-no-prior'` as a fifth member of the row-state union. It is implemented as a
separate `deltaState` field carrying that exact token, because a row holds a share state and a Δ
state at the same time. Detailed in §2.3.

### 6.3 The all-zero exclusion is real but currently unreachable

§5.1's prior-period rules imply the exclusion is doing work today. It is not — a comparable week is
always found first, and the service skips **0** all-zero periods in all four markets. It is still
correct to build (a stalled feed reaches the corrupted range, and the false Δ would be over a
percentage point), and it is proven by direct call rather than by observation. §2.4.

### 6.4 The impression-based confidence flag does not protect the click column

§5.3 specifies one confidence rule off `marketImpressions`. Applied to click share it leaves
"25.00% of 4 clicks" looking authoritative, because the two denominators differ by two orders of
magnitude. A second floor was added. §3.

### 6.5 §7.2's "both entries" was four

The brief names `share-of-voice` and `keyword-tracker` as the two broken `?tab=` redirects. Measured
on prod immediately before the fix, **four** routed tabs returned 200 and rendered Apply Rules:
`automations`, `dayparting`, `share-of-voice`, `keyword-tracker`. All four are fixed — see §7.

---

## 7 · The fold-ins

### 7.1 `?page=` — still open, and the reason is precise

`AdsDataGrid` keeps its page in local `useState` and exposes **no `onPageChange`** (re-verified
2026-08-12; BID.S0's `313828494` added `onSortChange` and `onFilterChange` only). So a pager click
cannot reach the URL without a shared-grid change, and the brief forbids forking the grid.

**The fix is one additive prop of exactly BID.S0's shape**: `onPageChange?: (page: number) => void`
fired from the three `setPage` call sites, plus an inbound re-sync keyed on a `page` **number
primitive** (never an object — every consumer passes inline literals), the whole behaviour gated on
the callback so the twenty-odd existing grids are provably untouched. One change, one file, nine
pages. It is not a Share-of-Voice type and SOV.1 does not hold that file.

Until then the page requests one large page (2,000; the biggest market is 480 rows) and the grid
pages locally. `?page=` is honoured server-side (`limit`/`offset`, verified: 50+50 rows, 0 overlap,
stable total) so a hand-typed link works.

### 7.2 `?tab=` — closed, for all ten routed tabs

Measured on prod before the change by reading each status: `bid`, `keyword-harvest`,
`negative-targeting`, `budget-schedules`, `placement` → 308 ✅; **`automations`, `dayparting`,
`share-of-voice`, `keyword-tracker` → 200, rendering Apply Rules** 🔴.

All four added. Two are this brief's; **the other two are not**, and were taken because the locks doc
hands `?tab=dayparting` to *"whoever takes it — it is one line inside the rule you are already
writing"*, every prior claim on `next.config.js` was released and the file was verified clean, and
leaving a known wrong-page bug inside the exact array being edited is worse than the scope it widens.

Also corrected: `/marketing/advertising/share-of-voice` pointed at `?tab=share-of-voice`, which then
needed a second hop. It now points at the route.

⚠ Still the literal form — now **ten** copies of one rule. The derived version
(`RULES_TABS.filter(t => t.routed)`) remains right and remains blocked on lifting the routed-key list
out of `'use client'` `_shared/tabs.tsx` into a `.mjs` this CommonJS config can require. What changed
is that the list is now **complete** rather than three-quarters complete, so the twelfth pass can do
the lift against a correct list.

---

## 8 · Known gaps

- **`?page=`** — §7.1, with the exact shared-layer fix named.
- **The all-zero exclusion is untriggered on today's data** — §2.4. Verified by direct call, not by
  observation, and stated on the page only when it fires.
- **`?adWindow=`, `?view=`, `?signal=`, `?row=`** — still declared and unbuilt (SOV.2–SOV.5).
- **No real zero is reachable on this page** — SOV.0's finding, unchanged: 0 rows with a real market
  total and zero impressions of ours in any rendered period at any scope.
- **`reportPeriod` is unguarded** — all rows are `WEEK` today, so the period gate cannot yet be
  fooled by a `MONTH` row entering the candidate set. Inherited from KT and still true.
- **The summary strip's numbers follow `?q=`** — they describe the current *view*, including a text
  search, rather than the scope alone. Deliberate: a headline that disagreed with the visible rows
  would be worse. Worth revisiting if SOV.3's filters make the view very narrow.

---

## 9 · Corrections to SOV.0 §7's map

| section | SOV.0 said | corrected |
|---|---|---|
| **SOV.1** | Δ · click / cart-add / purchase share · colour scale | Δ · click share · colour scale **+ sort discipline**. Cart-add and purchase share are **not columns** — 2.9% and 0.2% coverage (§3) |
| **SOV.5** | the row drawer | **+ the weekly series, cart-add and purchase share**, which have no other home |

Unchanged: SOV.2 owns the ad-side columns and `?adWindow=`; SOV.3 the `Signal` column re-cut against
the median; SOV.4 the unbid view; SOV.6 export; SOV.7 `SOV_BID`, still blocked on
`buildSovBidContexts`.

---

## Appendix — scripts

Read-only, re-runnable, from `apps/api` with
`NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/<name>`.

| script | what it measures |
|---|---|
| `_sov1-verify.mts` | **new** — the prior period per market per `?weeks=` with the gap; the quantified false collapse the exclusion prevents; the no-comparable-prior case; named rows with a real Δ and with none; click share where it disagrees; share-desc top 10 before and after the confidence rule; the distribution and the band pair; the smallest non-zero share, click share and Δ in the data; scope-bound intersections; and the exclusion firing under a hypothetical chosen period |
| `_sov-page-f.mts` | *(re-run, not modified)* every period per market with its all-zero flag; the comparable prior per `?weeks=`; funnel coverage; the share distribution |
| `_sov-page-g.mts` | *(re-run, not modified)* top-by-share vs top-by-market-impressions, and the median denominators |
| `_sov0-*.mts` | SOV.0's six probes, unchanged |
