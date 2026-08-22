# SOV-P — Share of Voice perfection · Phase 0 study (read-only)

**Date:** 2026-08-22 · **Target:** the Share of Voice tab of `/marketing/ads/rules-automation`
**and** its rule builder (`/builder/sov`) · **Status:** study complete, phases await approval.
Nothing was written. No rule was created. Prod carried 3 advertising rules before this study and
carries the same 3 after it (verified, `_sovp-p0-nochange.mts`).

Probes (all read-only, direct Prisma against prod): `apps/api/scripts/_sovp-p0-census.mts` ·
`_sovp-p0-wire.mts` · `_sovp-p0-correlate.mts` · `_sovp-p0-sources.mts` · `_sovp-p0-preview.mts` ·
`_sovp-p0-autoproof.mts` · `_sovp-p0-nochange.mts`. Prod click-through on
`nexus-commerce-three.vercel.app`, 2026-08-22.

---

## 0. The headline, measured

> **The SOV rule builder's headline metric, "Share of Voice", is not a share of voice. It is each
> keyword's share of *our own account's* total ad impressions — and against Amazon's own market
> share it is not merely mis-scaled, it is _negatively rank-correlated_ (Spearman ρ = −0.24 pooled,
> negative in all four markets). A rule that raises bids where "Share of Voice" is low raises them
> hardest on the queries where we already hold the most market.**

> ⚠️ **Correction, 2026-08-22 (P1).** The Phase 0 draft of this document reported ρ = −0.4453 and
> overstatement factors of 5.3×–73×. Those came from a probe that **summed** `impressionsTotal`
> across a query's ASIN rows. The market total is one number *repeated* on each ASIN row, so the
> correct aggregation is `max` — which is what `share-of-voice.service.ts:666` has always done, and
> what `_sovp-p1-recorrelate.mts` re-verified (135 multi-ASIN query-weeks, **0** disagreeing about
> `impressionsTotal`). Every ρ and every ratio below is the corrected figure. The direction of the
> finding is unchanged and the structural findings never depended on SQP at all; the magnitude was
> overstated and is now right.

The brief expected the finding to be *"one name, two sources; the rule silently uses the deprecated
one."* That is true but it understates it. The page that held the honest number is now parked
(U3, 2026-08-18), so today the operator sees **no** share number on this tab at all — only the
builder's metric, which is the wrong one, unexplained and uncontested.

Three sub-findings, each measured:

1. **The denominator is the account, not the market.** `analyzeShareOfVoice()` computes
   `sovPct = this query's impressions ÷ the sum of impressions over ALL queries` — 544,886
   impressions across 2,379 queries and **all four marketplaces at once** (no marketplace filter is
   passed). Median `sovPct` = **0.0026 %**.
2. **Therefore no threshold an operator would type does anything.** `Share of Voice < 50 %` matches
   **1000 of 1000** rows; `< 20 %` → 999; `< 10 %` → 997; `< 5 %` → 995; `< 1 %` → 986. The
   condition is a no-op filter wearing a threshold's clothes.
3. **And it points backwards.** Against `SearchQueryPerformance` (Amazon Brand Analytics'
   `Σ impressionsBrand ÷ max impressionsTotal`), over 607 overlapping *market × query* pairs from
   the three latest SQP weeks: **ρ = −0.2445** pooled; DE −0.3454 (n=210) · ES −0.3516 (n=80) ·
   IT −0.1735 (n=308) · FR −0.5667 (n=9). Negative in every market.

The mechanism is not subtle once stated: a head query has many impressions (**high** account share)
and an enormous market (**low** real share); a long-tail query is the reverse. The metric measures
how big a query is *for us*, and calls it share of voice.

### The two numbers, side by side (top 8 queries by impressions)

| Query | Market | Builder's "Share of Voice" | Amazon's real market share | Ratio |
|---|---|---|---|---|
| motorrad jacke | DE | 23.61 % | 3.69 % (1,566 / 42,429) | 6.4× over |
| giacca moto uomo | IT | 14.92 % | 4.86 % (2,196 / 45,171) | 3.1× over |
| giacca moto estiva uomo | IT | 12.49 % | 4.83 % (3,972 / 82,221) | 2.6× over |
| giubbotto moto uomo | IT | 6.38 % | 4.34 % (408 / 9,401) | 1.5× over |
| chaqueta moto hombre invierno | ES | 6.06 % | 2.29 % (80 / 3,487) | 2.6× over |
| motorrad jacke herren | DE | 4.17 % | 1.85 % (2,051 / 110,632) | 2.2× over |
| giacca moto | IT | 3.09 % | 5.74 % (1,216 / 21,199) | 0.5× — **under** |
| giacca moto estiva | IT | 2.56 % | 2.92 % (446 / 15,298) | 0.9× — under |

On the head queries the two numbers are within an order of magnitude and the error changes sign,
which is exactly why a scale correction would not fix this. The damage is in the **tail**, where the
rule would actually act:

| Our TRUE strongest positions (real market share) | Real | What a SOV rule sees |
|---|---|---|
| IT "giubbotto moto uomo nero" | 15.11 % | **0.0040 %** |
| IT "giacca da moto impermeabile uomo" | 14.91 % | 0.0035 % |
| IT "giacca da moto uomo 5 xl" | 13.11 % | 0.0007 % |
| IT "giacca estiva con protezioni moto" | 10.53 % | 0.0002 % |
| DE "motorradjacke herren sommer belüftet wasserdicht größe s" | 10.00 % | 0.0007 % |

Every one of the five positions we hold most of reads as effectively zero to a SOV rule — so
`Share of Voice < 5 % → raise the bid` bids *up* on all five.

---

## 1. Census — every number measured

### 1.1 Rules landscape (post-W7 clean slate)

| Fact | Value |
|---|---|
| Advertising rules on prod | **3** |
| SOV rules | **0** |
| The three | "Stop wasted spend — GALE IT" (SEARCH_TERM_WASTING, negative-targeting) · "Reclaim idle budget — DE" (CAMPAIGN_PERFORMANCE_BUDGET, budget) · "Harvest proven winners — GALE DE" (SEARCH_TERM_CONVERTING, keyword-harvesting) |
| All three | `enabled:true`, `PROPOSE`, created 2026-08-21 — the harvest and negative pilots. Left alone. |

A third rule (the BUD-P budget pilot) has joined the two the brief named. No SOV rule has ever
existed on this account, so every finding below is latent — which is precisely why it survived.

### 1.2 The SOV signal, exactly as the engine builds it

`buildSovBidContexts()` calls `analyzeShareOfVoice({ windowDays: 30, limit: 1000 })`.

| Fact | Value |
|---|---|
| `totalImpressions` (the denominator) | **544,886** — the whole account, all four markets |
| Queries aggregated | 2,379 |
| Rows returned (after `limit: 1000`) | 1,000 — **1,379 queries (58 %) get no signal at all** |
| `sovPct` max / p50 / p90 / min | 23.6090 % / 0.0026 % / 0.0011 % / 0.0009 % |
| Rows ≥ 1 % / ≥ 5 % / ≥ 20 % / ≥ 50 % | 14 / 5 / 1 / **0** |
| Sum of returned `sovPct` | 99.40 % (it is a partition of our own impressions) |
| `topCampaignSharePct` non-null | 1000 / 1000 — but **769 are exactly 1.0** (single campaign) |
| Cannibalised (≥ 2 campaigns) | 232 of 1,000 |
| Denominator spans | IT 295,996 · DE 174,230 · ES 41,882 · FR 32,778 impressions — **one number over four markets** |
| Queries present in > 1 marketplace | 8 of 2,379 |

### 1.3 The join to real targets

| Fact | Value |
|---|---|
| Positive `KEYWORD` targets in DB | 2,130 (emitter's `take: 3000` fetches all of them) |
| Matched with the engine's `limit: 1000` | **1,178 (55.31 %)** |
| Matched with no limit | 1,280 (60.09 %) |
| 🔴 Dropped by `limit: 1000` alone | **102 targets** (18 distinct keywords, e.g. "tuta da moto", "moto giacca") |
| Targets with no search-term row at all | 850 |
| Matched-target status | ENABLED 953 · PAUSED 42 · **ARCHIVED 183** |
| Matched targets already at a suppression bid (≤ 3 ¢) | **357** |
| Matched targets whose number mixes another market's impressions | 69 of 1,178 |

### 1.4 Freshness, and a sentence that is false

`AmazonAdsSearchTerm` runs 2026-05-20 → **2026-08-20** (D-1 relative to the probe's UTC day).

`analyzeShareOfVoice` builds `date: { gte: Date.now() − 30 d }` with **no upper bound** and never
calls `ruleWindowBounds`. So the SOV half of every context **includes** 2026-08-20 (19,536
impressions) and 2026-08-19 (21,455) — the two days Amazon is still attributing.

The builder's on-screen sentence, verified on prod, says the opposite:

> "Measured over the last 30 days — this trigger's fixed window. **The most recent 2 days are still
> settling and are excluded.**"

It is true of the *perf* half (`targetPerfMap` → `ruleWindowBounds`) and false of the *SOV* half.
`TRIGGER_WINDOW.SOV_BID` is declared `settled: true`, which is the same half-truth in the map.

### 1.5 What real signals exist (the fix's raw material)

| Source | Grain | Coverage on prod |
|---|---|---|
| `SearchQueryPerformance` (Amazon Brand Analytics: `impressionsBrand / impressionsTotal`) | **market × query × ASIN × week** | 16,253 rows, **100 % carry a real market total**; latest week **2026-08-09** (IT 405 · DE 257 · ES 65) |
| `AmazonAdsPlacementReport.topOfSearchIS` (Amazon's *true* TOS impression share) | campaign × day | 1,297 of 6,156 rows (21.07 %) |
| `AmazonAdsDailyPerformance.topOfSearchIS` | campaign × day | 3,437 of 5,802 campaign rows (59.2 %) |
| `KeywordRank` (H10's actual SOV vocabulary is position-based) | keyword × market | **0 rows** |

**Re-sourcing test** — join positive keyword targets → SQP on `(marketplace, lowercased query)`:

| Weeks unioned | Targets matched | With a real market total |
|---|---|---|
| 1 (2026-08-09) | 946 / 2,130 (**44.41 %**) | 946 (44.41 %) |
| 2 | 1,023 (48.03 %) | 1,023 |
| 4 | 1,119 (52.54 %) | 1,119 |
| 8 | 1,305 (61.27 %) | 1,305 |

For comparison, **today's wrong source covers 1,178 / 2,130 (55.31 %)**. So an honest number costs
roughly 11 points of coverage at one week, and *breaks even at four weeks* — while being true.

### 1.6 The Preview, and the prod click that broke it

The `isBidLike` preview (shared by Bid · SOV · Keyword Tracker) is a **client-side
re-implementation**: it fetches `/api/advertising/targets?limit=1500`, filters by selected
campaign id, applies `groups[0]`'s THEN op and the guardrail clamp, and renders.

| Fact | Value |
|---|---|
| Positive `AdTarget` rows the endpoint lists | 3,155 (KEYWORD 2,130 · PRODUCT 761 · AUTO 183 · PRODUCT_CATEGORY 32 · PRODUCT_AUDIENCE 28 · AUDIENCE 14 · PRODUCT_CATEGORY_AUDIENCE 7) |
| 🔴 Endpoint has **no `orderBy`** and the builder asks `limit=1500` | **1,655 rows (52.5 %) are unreachable by the preview**, chosen arbitrarily by Postgres |
| 🔴 Kinds the SOV engine can *ever* select (`kind:'KEYWORD'`) | 2,130 of 3,155 = **67.5 %**; the other 32.5 % are previewed and unactable |
| 🔴 Campaigns with previewable targets but **zero** keyword targets | **71 of 217** (e.g. "Regal Product Trageting" — 36 rows previewed, 0 actionable) |
| 🔴 The preview applies the rule's IF conditions | **It does not.** No condition filter of any kind |
| 🔴 Multi-block rules | Only `groups[0]` is read — blocks 2..n are ignored by the preview |
| Status | PAUSED and ARCHIVED targets are listed as if they would receive a new bid |

**Clicked on prod, 2026-08-22.** Builder `/builder/sov`, added the first campaign (`DE_Auto_Close`),
set `IF Share of Voice < 5 %` → `THEN Set Bid to €0.75`, pressed Preview. The panel — headed
*"Read-only: the new bid each keyword/target in your selected campaigns would get when this rule
fires"* — showed **four rows**:

| Keyword / Target | Current | New Bid |
|---|---|---|
| SEARCH_CLOSE_MATCH | €0.49 | €0.75 |
| SEARCH_LOOSE_MATCH | €0.40 | €0.75 |
| PRODUCT_COMPLEMENTS | €0.40 | €0.75 |
| PRODUCT_SUBSTITUTES | €0.40 | €0.75 |

All four are `kind: 'AUTO'`. `buildSovBidContexts` selects `where: { kind: 'KEYWORD',
isNegative: false }`, so **a SOV rule can never touch any of them** — three are also PAUSED. The
campaign's two real KEYWORD targets ("motorradjacke 4xl", "motorrad jacke herren") were **not
shown**, because they fell outside the arbitrary 1,500 the endpoint returned. Both defects fired at
once: 100 % of what the preview promised is impossible, and 0 % of what is possible was displayed.

### 1.7 The tab, measured on screen

Renders the H10 shape correctly: header · tab bar · one `RulesGrid` · empty state
"Create a rule to generate campaign suggestions". Columns: SOV Rule · Lookback · Criteria ·
Frequency · Automation · Activity · Actions.

| Probe | Value |
|---|---|
| `cursor: help` elements | **0** ✅ (ratchet holds) |
| Census strip (`.h10-hv-cohortline`) | **absent** — Negative Targeting, Harvest and Budget all have one |
| Dead space below the page block | **280 px** at a 962 px viewport |
| Anything on the tab stating what a SOV rule would see | **nothing** |

### 1.8 Mount status of the parked report

`ShareOfVoiceClient.tsx` (1,274 lines), `SovRowDrawer.tsx`, `SovSavedViews.tsx`, `sovExport.ts` are
**parked, not dual-mounted** — verified: the only reference to `ShareOfVoiceClient` anywhere in
`apps/web/src` outside its own file is a *comment* in `page.tsx`. `docs/2026-08-16-ra-parked-sections.md`
§U3 names their destination (Analytics › Coverage; export → Reporting). Out of SOV-P's scope.

---

## 2. The wire audit — what the SOV builder stores vs what the engine reads

| Stored on the rule | Rendered for SOV? | Read by the engine? | Verdict |
|---|---|---|---|
| `campaigns[]` (CampaignSection picker) | ✅ | ✅ `builderCampaignIds(a0)` → `bid_apply.campaignIds` | **whole** |
| `conditions[]` blocks, per-block THEN | ✅ | ✅ per-block translation (shared with `bid`, BP.P4b) | **whole** |
| `bidFloor` / `bidCeiling` | ✅ Advanced → Bid Guardrails | ✅ `minEur` / `maxEur` | **whole** |
| `schedule{frequency,time,timezone,…}` | ✅ | ✅ `ads-rule-schedule.ts` due-gate | **whole** |
| `control` (Manual / Automate) | ✅ | ✅ → `PATCH /autonomy/rules/:id`; `bid_apply` is reversible so AUTO is reachable, `pauseTarget` ceilings at PROPOSE | **whole** |
| `maxDailyAdSpendCentsEur` / `maxWritesPerDay` / `maxExecutionsPerDay` / `scopeMarketplace` | ✅ | ✅ stored & consulted (cap *semantics* are a known cross-page defect — not SOV's) | **whole** |
| **metric "Share of Voice"** | ✅ default condition | ✅ reads `adTarget.sovPct` — **which is the wrong quantity** | 🔴 **reads a real field holding a false number** |
| **metric "Impression Share"** | ✅ | ✅ reads `adTarget.impressionSharePct` — set to **`s.sovPct`**, byte-identical to Share of Voice | 🔴 **two metrics, one value** |
| **metric "Top Campaign Share"** | ✅ | ✅ reads `adTarget.topSharePct` — real, but it is *our own campaigns'* concentration on a query, not a market share; 769/1000 are exactly 100 % | ⚠️ **real value, misleading name** |
| `windowDays` (own lookback) | ❌ not offered | n/a — SOV has no `ACTION_WINDOW` entry, trigger's 30 d binds | consistent (a capability gap, not a lie) |
| "Measurement window" sentence | ✅ | — | 🔴 **claims 2 settling days excluded; the SOV half includes them** |
| `dedupe`, `negateInSource`, `bid{mode,value}`, `filters{brandExclude,competitorOnly}`, `searchTerms`, `mappings` | ❌ never rendered for SOV | ❌ | dead payload keys — noise, not a lie |
| **Preview** | ✅ | — | 🔴 **promises bids on target kinds the engine cannot select; ignores every IF condition** |
| `STARTER_TEMPLATES['sov']` | — | — | ❌ **absent** (bid · budget · harvest · negative all have starters) |

**The programme's signature find is present, in a new form.** On Harvest, Negative and Budget it was
*"the builder collects the whole form; the engine honours a fraction."* Here the wire is
structurally whole — every rendered control has a reader — and the defect moved one layer down:
**the field the engine faithfully reads contains a number that is not what its label says.** An
honesty audit that only chases unread controls would have passed this tab.

---

## 3. Gap matrix

### KEEP — verified correct, do not touch
| Item | Evidence |
|---|---|
| The H10 tab shape (header · tabs · one grid · H10's own empty-state string) | prod screenshot; study §3.9/§7.4 |
| D4: no "SOV Reports" column | no report object exists; decided by measurement, re-affirmed |
| Tab wiring (`RULE_TAB_ACTION_TYPES['share-of-voice']` derives slug `sov`) | a rule built at `/builder/sov` lists on this tab |
| Multi-block translation, campaign allowlist, guardrails, schedule gate, arming | shared with `bid`; §2 audit |
| Help-cursor ratchet | measured 0 on both surfaces |
| `topCampaignSharePct` as a *computation* | correct as cannibalisation; 232 queries have ≥2 of our campaigns |

### FIX — a real defect with evidence
| # | Defect | Evidence |
|---|---|---|
| F1 | "Share of Voice" is the account's impression mix, not a market share; negatively rank-correlated with the real thing | ρ = −0.2445 (607 pairs), negative in all 4 markets; the 5 strongest real positions all read ≈0 |
| F2 | Any operator threshold matches ~everything | `< 50 %` → 1000/1000; `< 1 %` → 986/1000 |
| F3 | "Impression Share" is byte-identical to "Share of Voice" | `impressionSharePct: s.sovPct` |
| F4 | One denominator spans four marketplaces | IT+DE+ES+FR summed; 69 of 1,178 joins contaminated |
| F5 | `limit: 1000` silently drops 102 targets (58 % of queries get no signal) | §1.3 |
| F6 | The "2 settling days are excluded" sentence is false for the SOV half; `TRIGGER_WINDOW.SOV_BID.settled` says the same | no `until` bound; 2026-08-20 included |
| F7 | Preview promises bids on `AUTO`/`PRODUCT` targets the engine can never select | prod click: 4 of 4 rows unactable |
| F8 | Preview ignores every IF condition and every block after the first | code + §1.6 |
| F9 | Preview reaches only an arbitrary 1,500 of 3,155 targets | no `orderBy` on the endpoint |
| F10 | The tab states nothing about what a rule would see | no census strip; 280 px dead space |
| F11 | No starter templates for `sov` | `STARTER_TEMPLATES` has 4 slugs, not `sov` |

### BUILD — new, and justified
| # | Item | Why |
|---|---|---|
| B1 | An SQP-sourced per-keyword market share for the SOV context, through the shared `chooseViewPeriod` gate | the only honest per-keyword share we hold; 44–52 % coverage, 100 % with a real denominator |
| B2 | A server-side SOV preview that RUNS the engine | `reference_preview_must_run_the_engine`; BUD-PP and PLC-P2 both did this |
| B3 | A census strip on the tab | the NEG/HP/BUD idiom; answers "what will a rule see?" before one is written |

### REFUSE — with evidence
| # | Refusal | Why |
|---|---|---|
| R1 | **Competitive** share of voice (who else is on the page) | every vendor scrapes Amazon SERPs; competitor study §5.3 puts the *selling account* at risk. Option C (B1) now; option B (buy a feed) is an operator purchase decision, not an engineering default |
| R2 | H10's SOV criteria vocabulary (Avg Position · Avg Organic/Paid Position · Page 1 Frequency % · Top 3 Frequency %) | it is rank data. `KeywordRank` = **0 rows**. Offering it would ship exactly the compare-against-`undefined` bug this programme removes |
| R3 | H10's SOV Report object + "SOV Reports" column | D4, unchanged: no such object; the column would restate the rule's scope on every row |
| R4 | Re-mounting the parked market-share report | headed for Analytics › Coverage; out of scope, and no endpoint was retired |
| R5 | Fixing `maxExecutionsPerDay` / `maxWritesPerDay` semantics | inherited, cross-page; SOV must not fork the fix |
| R6 | `summariseRule` reading only `conditions[0]` | shared `RulesGrid`, affects every tab; belongs to whoever owns that file |
| R7 | Offering campaign-grain `topOfSearchIS` as a keyword-grain "Impression Share" | a campaign number gating a keyword action is a different metric wearing the same name — the exact class F3 is |

---

## 4. Proposed phases — one approval each, nothing built before approval

### SOV-P1 (M) — the metric tells the truth
Re-source the SOV_BID context's share from `SearchQueryPerformance` per
`(marketplace, lowercased query)`, reusing `chooseViewPeriod` / `SQP_COMPLETENESS_RATIO` from
`keyword-tracker.service.ts` (never forked) so the engine reads the same week Keyword Tracker and
the future Coverage page would. Concretely: **F1 · F2 · F4 · F5 · F6** close together, and:
- **"Share of Voice"** keeps its name because the name becomes *true*.
- **"Impression Share"** is **removed** (F3, R7) — a duplicate today, and the only real one is
  campaign-grain.
- **"Top Campaign Share"** is relabelled to say what it measures (our own campaigns' concentration
  on a query) with an honest hover; the computation is untouched.
- The window sentence becomes what SQP actually is: a settled weekly period, dated, with its age
  stated. `TRIGGER_WINDOW.SOV_BID` is corrected in the same commit so map and screen agree.
- Targets with no SQP row emit **no context** rather than a fabricated zero
  (`reference_sov_zero_vs_rounding` — a rounded 0.00 % is not a zero).

*Operator call inside this phase:* one week (44 %, freshest) vs four weeks unioned (53 %, up to
~5 weeks old). Recommendation: the gate's chosen week, with the coverage stated on the tab (B3).

### SOV-P2 (M) — the builder cannot promise what the engine cannot do
Replace the client-side bid-like preview *for the `sov` slug* with a server preview that runs the
real translation and the real context builder (BUD-PP / PLC-P2 pattern), returning the same census
those two return: selected · measurable · in-scope · matched · no-change. Closes **F7 · F8 · F9**.
⚠️ `RuleBuilder.tsx` is dirty from the BUD-P session — this phase touches it last and minimally, and
the shared `isBidLike` path for `bid`/`keyword-tracker` is left exactly as it is unless the operator
extends the scope.

### SOV-P3 (S) — the tab states its own basis
The one-line census strip (`.h10-hv-cohortline`, copied from `NegativeRulesClient` with the scoped
override from `6e13e3614`): keyword targets carrying a real share signal, the SQP week and its age,
per-market coverage — absent, never fabricated, on a failed fetch. Closes **F10** and the 280 px of
dead space.

### SOV-P4 (S) — parity with the tabs that shipped
`STARTER_TEMPLATES['sov']` built on the corrected metric (**F11**), and — if the operator wants it —
a lookback/period select, which only becomes meaningful once P1 makes the period real.

### SOV-P5 (S) — verification and record
`@nexus/shared` rebuild → tsc both apps → api vitest → web vitest → the five ratchets → Playwright
smoke on the local stub rig; new unit tests for the re-sourced context builder and the adapter map;
register + memory updated. Prod click-through after the operator commands a push.

**Recommended order:** P1 → P2 → P3 → P4 → P5. P1 first because every later phase describes the
number it produces: a census strip or a starter template built on today's metric would ship a
confident, well-designed lie.

---

## 5. Parallel-session notes

Files this target would eventually touch that other sessions hold dirty right now:
`_shared/RuleBuilder.tsx` and `_shared/PerformanceCriteria.tsx` (BUD-P, PLC-P),
`ads-rule-adapter.service.ts` (BUD-P), `advertising-rule-evaluator.job.ts` (BUD-P, SG),
`packages/shared/ads-rule-window.ts`. Phases are ordered so the SOV-only files
(`ads-impression-share.service.ts`, the SOV context builder, `SovRulesClient.tsx`) carry the weight,
and the shared ones are touched last, minimally, with `grep -a` diffs and `--only` commits.

**KT-P coordination (2026-08-22):** the Keyword Tracker session found `RANK_METRIC` offering
`'Share of Voice' → adTarget.sovPct` while `buildKeywordRankBidContexts` never emits it — a
compare-against-`undefined` that can never match. Confirmed to them with this study's numbers, and
agreed: they remove it from `RANK_METRIC` + `METRICS_RANK`; SOV-P does not touch either. Their
removal and SOV-P1 are disjoint edits.

---

## 6. What was BUILT — SOV-P1 · P2 · P3 · P4

Operator approved the plan 2026-08-22 ("go ahead with your recommendation" — the P1→P5 order, and
the gate's chosen week inside P1), then "commit and push".

🔴 **P1, P3 and P4 SHIPPED. P2 is HELD, uncommitted, and the reason is not a defect in it.**
`runDraftPreview` and `previewPlacementRule` do not exist at HEAD — they are PLC-P's *uncommitted*
work — and the `suppressed` row field my preview renders is KT-P's, also uncommitted. My P2
therefore cannot compile against HEAD, and committing it would mean sweeping two live sessions'
half-finished work into my commit: the exact failure that put Railway red on `ba4cad608`
([[reference_concurrent_session_commit_only_trap]]). P2 stays in the working tree, fully built and
verified, and lands the moment PLC-P and KT-P commit theirs. See §7.

### P1 — the metric tells the truth ✅
- **New** `apps/api/src/services/advertising/ads-sov-keyword-share.service.ts` — Amazon's own
  per-query market share (`Σ impressionsBrand ÷ MAX impressionsTotal`) per marketplace, on the week
  the shared `chooseViewPeriod` gate picks. `SQP_COMPLETENESS_RATIO` imported, never lowered.
  **One deliberate departure from the page:** a market whose newest week is *truncated* contributes
  **no contexts at all** — a page that explains a partial week is better than an empty one; an
  engine that bids on a half-written denominator is not.
- `buildSovBidContexts` re-sourced. `impressionSharePct` **deleted** (it was `s.sovPct`).
  `topSharePct` kept, computed **per market** and with **no `limit`** — the two corrections that
  close F4 and F5.
- `SOV_METRIC`: `'Impression Share'` **removed** (refuses by name, never silently drops);
  `'Top Campaign Share'` → **`'Campaign Concentration'`**. Mirrored in `METRICS_SOV`,
  `PC_METRIC_UNIT`, `rule-conditions-text.ts` and the adapter's own conformance test.
- `TRIGGER_WINDOW.SOV_BID` moved `W(30)` → **`snapshot`**, and the builder's window sentence
  rewritten — the old "the most recent 2 days are excluded" was false for the share half.

**Measured after (prod data, `_sovp-p1-verify.mts`):** 793 contexts · every offered metric defined
on 793/793 · `impressionSharePct` gone · **0** fabricated zeros · **0** shares > 1 · **0**
cross-market contamination (was 69) · `< 1 %` now matches **26.7 %** of rows (was 98.6 %).

### P2 — the builder cannot promise what the engine cannot do ✅
- `runDraftPreview` **exported and given two optional hooks** (`buildContexts`, `entityId`), both
  defaulting to today's campaign behaviour — SOV needed the same five stages at the ad-target grain
  through `bid_apply`, and that is two parameters, not a second pipeline.
- **New** `ads-sov-preview.service.ts` + a `slug === 'sov'` branch on the existing preview route.
- The builder's `sov` slug now calls it; the client-side `isBidLike` path is **untouched** for
  `bid` and `keyword-tracker`.
- 🔴 **A narrowing the honest preview forced:** with status finally on screen the panel was offering
  a bid on `motorradjacke herren [EXACT] ARCHIVED`. `buildSovBidContexts` now filters
  `status: 'ENABLED'`, matching `buildUnderperformContexts`, the account's existing convention.
  183 ARCHIVED + 42 PAUSED targets leave the population; contexts 972 → **793**.
- 🔴 **A second one the screen forced:** every current bid in the first real preview was €0.02 — the
  account's suppression convention — with no warning. The SOV preview now carries KT-P2's
  suppression truth verbatim (`KT6_SUPPRESSION_CENTS` imported, flag and ≤3¢ counted separately).

**Verified on the local rig, on the same campaign that exposed the defect on prod.** `DE_Auto_Close`
+ `IF Share of Voice < 5% → Set Bid €0.75` used to show four `AUTO` rows getting €0.75. It now reads:
> "None of the 6 targets in your selected campaigns is an enabled keyword, and a Share of Voice rule
> can only act on those. This is not a problem with your criteria."

And on two real keyword campaigns: 9 rows with the deciding share as a column, "63 targets selected ·
11 enabled keywords (52 paused or archived, which this rule skips) · 9 carry a market share · 9 in
scope · **9 match**", the amber suppression warning, and every market's SQP week with its age.

### P3 — the tab states its own basis ✅
`GET /advertising/sov/strip` + the `.h10-hv-cohortline` strip (no links, so no hover-pill override
needed). Screen-verified: one line, no overflow, wraps to 4 lines at 420 px, contrast **5.91** /
bold **14.3**, cursor `auto`, 0 help cursors, aligned to the page gutter.
🔴 **Caught by driving the market selector:** the counts were account-wide beside one market's week
("793 of 1,777 … Amazon's week: DE"). They are now per market — DE reads **111 of 275, median 0.74 %**.

### P4 — starter templates ✅
`STARTER_TEMPLATES.sov` — three, with thresholds taken from the measured distribution (median
2.40 %, 178 under 1 %) and a spend floor on each. They could not have existed before P1: on the old
metric every bar matched ~100 % of rows.

### P5 — verification ✅
`@nexus/shared` rebuilt · tsc clean both apps · **api 396 files / 5,148 tests pass** · **web 985 pass**
(the 8 Playwright spec files fail under bare vitest — documented baseline) · all five ratchets exit 0
(button-vocabulary 283/283 · silent-disabled 27/27 · help-cursor 0/0 · DS guard · token sweep) ·
new `ads-sov-keyword-share.vitest.test.ts` pins **Σ brand ÷ MAX total** and the null-vs-zero rule.

### 🔴 Open — NOT done, and why
- **Commit strategy.** My lines sit *inside* PLC-P's and KT-P's hunks in `ads-rule-preview.service.ts`,
  `advertising-intel.routes.ts` and `RuleBuilder.tsx`, so `--only` cannot separate them at hunk
  granularity — it needs line-level blob surgery. Nothing is committed; this is the operator's call.
- The shared client-side `isBidLike` preview still serves **`bid`** with the same defects
  (no IF conditions, `groups[0]` only, kinds the engine cannot select, an arbitrary 1,500 of 3,155
  targets). Out of SOV-P's scope — it belongs to whoever owns Bid, and it is worth its own unit.

---

## 7. What shipped, and what is held — the commit boundary

**Shipped (this commit):** P1 (the metric tells the truth) · P3 (the tab's census strip) ·
P4 (starter templates) · the new share service + its tests + this document.

**Held in the working tree, NOT committed:** P2 — `ads-sov-preview.service.ts`, the `slug === 'sov'`
branch on the preview route, and the builder's `isSov` preview branch with its census rendering.

Why, measured rather than assumed:

| Symbol my P2 needs | Exists at HEAD? | Owner |
|---|---|---|
| `runDraftPreview` | **no** (0 occurrences) | PLC-P, uncommitted |
| `previewPlacementRule` | **no** | PLC-P, uncommitted |
| `preview.terms[].suppressed` | **no** | KT-P, uncommitted |

So P2 is not independently committable, and forcing it would have meant committing PLC-P's and
KT-P's in-flight work under my message. It is finished and verified — it simply has to land after
theirs.

🔴 **A warning for whoever commits `RuleBuilder.tsx` or `advertising-intel.routes.ts` next.** Their
working-tree copies still contain my P2 wiring. A `git commit --only` on either file will sweep it
in — and my P2 wiring calls `ads-sov-preview.service.ts`, which this commit does **not** contain.
That combination compiles in the working tree and fails on Railway, which is precisely how
`ba4cad608` went red. If you take those files, take `ads-sov-preview.service.ts` with them.

**How this commit was built.** Every shared file was reconstructed as `git show HEAD:<file>` plus
only my own edits, then diffed back against HEAD and checked for foreign markers before staging —
`git commit --only` could not have been used, because my lines sit *inside* PLC-P's and KT-P's
hunks. Two of KT-P's lines were caught being swept in by a too-wide block lift and removed; the
check that caught them was `git diff --no-index` + a grep for other programmes' markers, and it is
worth running on every reconstruction rather than trusting the boundaries.


---

## 8. A starter PULLED the same night — the null comparator

`0e7e59996` shipped three SOV starters. The third, **"Stop bidding against yourself"**
(`Campaign Concentration < 60% AND Spend ≥ €5`), was removed hours later.

KT-P pointed out that a spend guard cannot exclude a *null* metric, and asked whether `sovPct` could
be null in the re-sourced context. Measured (`_sovp-p4-nullcheck.mts`), on the 793 live contexts:

| | |
|---|---|
| `sovPct` null | **0 of 793** — starters 1 and 2 are safe by construction: a context exists only where a real share does |
| `topSharePct` null | **86 of 793** — null wherever we ran no ads on that query in the window |
| null AND spend ≥ €5 (the starter's exposure) | **4 targets**, incl. two ES targets carrying €119.75 and €123.93 |
| engine comparator: `null lt 0.6` | **true** |
| engine comparator: `0.5 lt 0.6` / `0.9 lt 0.6` | true / false |

So the starter matched four targets with real spend whose concentration is *not measurable*, and cut
their bids on the stated reasoning that several of our campaigns compete for the term — the opposite
of what a null means there.

**The metric stays offered.** An operator choosing `Campaign Concentration` deliberately is a
different thing from a one-click starter that mis-fires silently. The real fix is cross-cutting —
**a not-measurable value must fail every operator, not just `gte`** — and it moves every rule in the
account, so it belongs to that unit (KT-P is taking it to the operator with PLC-P's budget
comparator finding) rather than to this list.

Worth generalising: **an AND-guard only protects against a null if the guard is structurally tied to
the same absence.** `CTR ≤ x AND Impressions ≥ 500` is safe because `ctr` is null exactly when
impressions are 0. `Campaign Concentration < x AND Spend ≥ y` is not, because spend and
concentration come from different sources and one can exist without the other.
