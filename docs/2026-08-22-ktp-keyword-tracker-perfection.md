# KT-P — Keyword Tracker perfection · Phase 0 study (read-only)

**Session:** nexus-commerce-30 · 2026-08-22 · last target of the RA perfection programme
**Target:** `/marketing/ads/rules-automation/keyword-tracker` + `/builder/keyword-tracker`
**Status:** Phase 0 complete. **Nothing implemented. No writes, no commits, no prod state changed.**

---

## 0. The headline

> **The Keyword Tracker rule gates on a table with zero rows, and every surface presents it as a
> live reading.**

`KeywordRank` holds **0 rows on production**. Its only writer is a manual `POST /advertising/keyword-ranks`
route that nothing calls — no cron, no collector, no ingest. So `buildKeywordRankBidContexts()` hits
`if (!ranks.length) return []` on **every tick, always**, and the `KEYWORD_RANK_BID` trigger has
produced **0 contexts and 0 executions in the account's history**.

Meanwhile the builder opens on `IF [Organic Rank] [Greater than >] [___]` and prints, in prose:

> *"Rank is the latest snapshot; spend and ACOS cover the last 30 days. The most recent 2 days are
> still settling and are excluded."*

That sentence describes a measurement regime for a quantity that has never once been measured. It is
the cardinal sin of this programme — a stored-but-unread control rendered as fact — stated more
confidently than any other instance the programme has found, because it names a settling window on a
number that does not exist.

**Second-order:** this is not a wiring bug that can be fixed by pointing at the right table. Amazon
publishes no organic-SERP-position API. `docs/2026-08-04-competitor-deep-dives.md` §5.3 already put
this to the operator as an explicit decision — **A. scrape (ToS violation, the selling account is the
asset at risk) · B. buy a feed · C. approximate** — and recorded the answer: *"C now, B if C proves
insufficient, and A not at all."* `KeywordRank` is the empty vessel that was left for whichever
source lands. Nobody wired a rule builder to it and told the operator.

**Third-order, and the recoverable part:** a real, in-policy, already-ingested per-keyword signal
*does* exist — Amazon Brand Analytics SQP — and it covers **946 of 2,130** positive keyword targets
on the latest week alone. The tab can be honest *and* useful; it just cannot be honest about
*organic rank*.

---

## 1. Census — every number measured today, none inferred

Probes: `apps/api/scripts/_ktp-p0-census.mts` · `_ktp-p0-sources.mts` · `_ktp-p0-exposure.mts` ·
`_ktp-p0-gate.mts` (direct Prisma against prod Neon; all read-only).

### 1.1 The rank feed — empty

| quantity | measured |
|---|---|
| `KeywordRank` rows | **0** |
| its writers in the codebase | **1** — `advertising.routes.ts:8338`, a manual `createMany` behind `POST /advertising/keyword-ranks` |
| crons / collectors writing it | **0** |
| `GET /advertising/keyword-ranks?limit=2000` on prod (called by the builder preview) | `{count: 0, items: []}` |
| `KEYWORD_RANK_BID` rules ever created | **0** |
| `AutomationRuleExecution` rows for that trigger | **0** |

`buildKeywordRankBidContexts` (`advertising-rule-evaluator.job.ts:1181`) returns `[]` at line 1184
before reaching any of its logic. **Every downstream defect below is therefore latent, not live** —
which is exactly why they have survived: no rule has ever run to expose them.

### 1.2 What a rank rule would act on, if it could

| market | positive keyword targets | at ≤3¢ (suppressed by convention) |
|---|---|---|
| IT | 1,551 | 545 |
| DE | 398 | 11 |
| FR | 148 | 0 |
| ES | 33 | 0 |
| **total** | **2,130** | **556** |

`buildKeywordRankBidContexts` takes `3000` targets — no truncation today (2,130 < 3,000), and
`.slice(0, 1000)` after the rank join would bind first if the feed were ever populated.

### 1.3 Data sources that *are* real (the alternatives)

| source | populated? | what it actually says |
|---|---|---|
| `SearchQueryPerformance` (Brand Analytics) | **16,253 rows**, `searchQueryRank` set on **16,253/16,253**, `searchQueryVolume` on **16,253/16,253**; newest period **2026-08-09** (FR 2026-08-02) | the query's **market volume**, its **popularity rank in the marketplace**, and **our share of it** (`impressionsBrand/impressionsTotal`) |
| `AmazonAdsDailyPerformance.topOfSearchIS` | 2,057 of 31,410 rows in 45d — but **0 of 10,918 `AD_TARGET` rows** | campaign-grain paid prominence only; nothing per keyword |
| `AmazonAdsBrandMetric` | **0 rows** | — |
| `RankTarget` / `ProductRankPlan` | populated | placement-bias **goals** (Top-of-Search IS setpoints), not SERP observations |
| `KeywordRank` | **0 rows** | the only true organic/paid SERP position model — empty |

**SQP → keyword-target joinability**, on `(marketplace, lower(trim(text)))`:

| | targets | covered by latest SQP week (2026-08-09) |
|---|---|---|
| IT | 1,551 | **732** |
| DE | 398 | **191** |
| ES | 33 | **23** |
| FR | 148 | **0** |
| **total** | **2,130** | **946** (1,023 over two weeks) |

FR's zero is the known listing-sync problem (`project_kt_keyword_tracker_page`, KT.8) — the gate
working, not a new defect.

*Independently confirmed:* the SOV-P session measured **946 / 1,023** from its own probes today,
byte-identical to mine, and confirmed `KeywordRank` at 0 rows.

### 1.4 The suppression exposure on the shared bid handler

`bid_apply` — the handler **Bid, SOV and Keyword Tracker all translate to** — clamps to
`[max(0.05, minEur), maxEur]`. It therefore **can never write ≤3¢**, so any op it performs on a
suppressed target *un-suppresses it*. It checks `campaignIds` and the clamp. It checks nothing else.

Of the **1,004** positive keyword targets sitting in the **82 of 220** campaigns the write gate
(`liveBidWritesEnabled`) actually lets through:

| | count | share of reachable |
|---|---|---|
| suppressed by flag or by ≤3¢ convention | **561** | **56%** |
| …of which carry **no flag at all** (≤3¢ only) | **141** | 14% |
| sitting in a campaign that is `bidsSuppressedAt` **right now** | **420** | 42% |

33 of 220 campaigns are bid-suppressed at this instant. A write into one of them is overwritten by
the next resume, with the engine's actor on the row — `reference_ads_suppression_state_machine`.

This is a **live exposure on the Bid and SOV tabs today**; KT is merely the third tab sharing it.

### 1.5 Rules landscape

3 advertising rules exist account-wide — the programme's three armed pilots
(`SEARCH_TERM_WASTING` · `SEARCH_TERM_CONVERTING` · `CAMPAIGN_PERFORMANCE_BUDGET`). **0 Keyword
Tracker rules**, as W7's clean slate predicts. `KeywordBidProposal` still holds **2** rows (KT.7's
true history); watchlists **4 lists / 173 terms**.

---

## 2. What the tab is today

`page.tsx` mounts **only** `KeywordTrackerRulesClient` (67 lines): `AdsPageHeader` · `RulesTabs` ·
one `_shared/RulesGrid`. Clicked on prod: *"Showing 0 Keyword Tracker Rules"*, columns
**Keyword Tracker Rule · Lookback · Criteria · Frequency · Automation · Activity · Actions**, H10's
verbatim empty state.

🔴 **`KeywordTrackerClient` and its five children have ZERO importers.** Grepped both ways: the only
occurrence of the name outside its own file is a *comment* in `page.tsx`. So **2,453 lines** —
`KeywordTrackerClient` (977) · `TermDrawer` (269) · `BidAction` (446) · `ChangeLog` (249) ·
`TermChart` (201) · `WatchlistPanel` (311) — are unreachable from any route. This is U4's deliberate
parking (`docs/2026-08-16-ra-parked-sections.md`), correctly executed, and **not** a defect. It is
recorded here because judging the tab requires knowing it: **the tab is 67 lines, not 3,000.**

🔴 **And the two halves never shared a data source.** The parked report reads `/advertising/keyword-tracker`
(SQP share), `/keyword-watchlists`, `/keyword-actions` — it **never touches `KeywordRank`**. So one
tab named "Keyword Tracker" has always held two unrelated things: an SQP share report, and a rule
engine keyed to a SERP-position table nothing fills.

---

## 3. The three recon leads — all three confirmed, one reframed

### ① H10 forces a "no rank" decision; we make it silently — **CONFIRMED, and now moot-then-critical**

H10's KT criteria row carries a **required** radio (study §4.1, frame-verified):

> **If Your Product Has No Rank** — ◉ *"Count it as position 306 (Organic Rank) or 96 (Sponsored
> Rank) — Data points with no rank are treated as the lowest position in the Calculation"* /
> ○ *"Ignore them — Only data points where your product had a rank are used in the calculation"*

Ours hard-codes the second branch: `if (!e) return null // no rank snapshot for this keyword → skip`
(line 1205). The behaviour is the safe one and I would keep it as the **default** — but it is never
stated, and it silently inverts operator intent: a rule reading *"Organic Rank > 50"* is most
naturally meant to *find the keywords we rank badly for*, and the unranked ones are exactly those.

**Reframed by the census:** today this branch skips **100%** of targets, because `latest` is empty.
So the control is not the first thing to build — the disclosure is. Build the radio only if/when a
rank feed exists (Phase KT-P4/B).

🔴 **One correction to the brief.** The recon said *"KT's rank criteria have no lookback in H10."*
They do. §4.1's `lookback | none` column means *no card-level Lookback control* — because H10 puts
it **inline in the criteria row**: `[Organic Rank] [Average Position | Median Position |
Consecutive Checks] in the Last [3|5|7|10] Days`. H10 has **an aggregation selector and a lookback**
we do not have. Ours reads a bare latest snapshot.

### ② `rankDelta` fabricates a zero — **CONFIRMED, in two places**

```ts
rankDelta: prior?.organicRank != null && cur.organicRank != null ? prior.organicRank - cur.organicRank : 0
```
`advertising-rule-evaluator.job.ts:1216`, and again in `GET /advertising/keyword-ranks`
(`advertising.routes.ts:8315`). No prior snapshot, or a null rank, yields **`0` = "rank did not
change"**, which satisfies every `lte` / `gte` / `eq` 0 condition an operator would write. Every
other context builder in that file emits `null` when a quantity is not measurable
(`EMPTY_TARGET_PERF` sets `acos/roas/ctr/cvr/cpcCents` to `null`), so this is a lone exception to a
rule the file already keeps.

🔴 **Two further defects in the same collapse, found while confirming it, both worse than the zero:**

1. **`prior` can be a different ASIN's row.** `KeywordRank` has an `asin` column, but the collapse
   key is `(keyword, marketplace)` only. With two ASINs tracked for one keyword, `latest` and
   `prior` are the two newest rows *across ASINs* — so `rankDelta` becomes *ASIN A's rank minus
   ASIN B's rank*, which is not a rank change at all.
2. **`take: 8000` truncates alphabetically.** `orderBy: [keyword asc, marketplace asc, capturedAt desc]`
   with a `take` means that once the table exceeds 8,000 rows, keywords late in the alphabet are
   silently dropped from every evaluation — a coverage cliff with no symptom.

Both are unobservable today (0 rows) and both would bite on day one of any real feed.

### ③ A metric comparing against `undefined` — **CONFIRMED, and it is worse than inert**

`RANK_METRIC` maps `'Share of Voice' → adTarget.sovPct`. `buildKeywordRankBidContexts` emits
`organicRank · sponsoredRank · searchVolume · rankDelta` + `targetPerfMap`'s ten fields. **It never
emits `sovPct`.** The adapter's own header forbids precisely this:

> *"🔴 Every entry here must name a field its context builder actually emits — an entry pointing at
> a missing field makes the condition compare against undefined and silently never match."*

**Coordinated with SOV-P (session `nexus-commerce-7c`), who answered with measurements and cleared
the edit.** Their reading is stronger than "wrong denominator":

- `analyzeShareOfVoice()`'s `sovPct` = this query's impressions ÷ **our own account's total
  impressions across all queries and all four marketplaces** (544,886 over 30d). A mix share, not a
  share of any market. Median **0.0026%**; `"Share of Voice < 1%"` matches **986 of 1,000** rows.
- Against Amazon's own per-query market share, **Spearman ρ = −0.2445** pooled and negative in every
  market (DE −0.3454 n=210 · ES −0.3516 n=80 · IT −0.1735 n=308 · FR −0.5667 n=9).
  *(SOV-P revised this from an initial −0.4453 after correcting the aggregation — see §3③a.)*
  **The damage is in the tail, which is exactly where a rank rule lives:** our five strongest real
  positions — IT *"giubbotto moto uomo nero"* **15.11%**, *"giacca da moto impermeabile uomo"*
  **14.91%**, *"giacca da moto uomo 5 xl"* **13.11%** — all read as **0.000x%** on `sovPct`.

So the metric is not merely unbound: **once bound it would point the wrong way.** Remove it.
SOV-P has confirmed they will not touch `RANK_METRIC` or `METRICS_RANK`, so the two lines are mine.

**How strong is this evidence?** (raised by BSP-P: *a field can be absent, present-and-null, or
present-and-stale, and the first two look alike in a grep*.) Not a grep — the context object is a
**closed literal**. `advertising-rule-evaluator.job.ts:1207-1219` has no computed keys and exactly one
spread, `...(perfByTarget.get(t.id) ?? EMPTY_TARGET_PERF)`, whose key set is itself a closed literal
at line 1150. So the emitted key set is fully enumerable and finite:

```
{ id, organicRank, sponsoredRank, searchVolume, rankDelta }
∪ { spendCents, salesCents, orders, clicks, impressions, acos, roas, ctr, cvr, cpcCents }
```

`sovPct` ∉ that set — **absent**, not null. ⚠ **A runtime assertion is not obtainable in Phase 0**:
the builder returns `[]` before constructing any object, so observing the shape requires inserting a
`KeywordRank` row — a write, refused here. **Carry this into KT-P3 as a vitest fixture** that seeds a
rank row and asserts the key set, so the claim is measured rather than read.

#### §3③a — the aggregation trap, if KT ever joins SQP

SOV-P's first probe summed `impressionsTotal` across a query's ASIN rows. It should not: the market
total is **one number repeated on every ASIN row**, so the correct aggregation is
**Σ `impressionsBrand` ÷ MAX(`impressionsTotal`)**, never `SUM(total)`.
`share-of-voice.service.ts:666` has always done it that way; re-verified on prod (135 multi-ASIN
query-weeks, 0 disagreeing about `impressionsTotal`, 0 where Σbrand > max(total)).

🔴 **And there are TWO defensible aggregations, so a KT surface must choose deliberately rather than
copy.** KT's own service reads its **best ASIN's** share rather than the summed one
(`share-of-voice.service.ts` header, point 2) — deliberately, because KT's question is *"the term I
am defending"*, not *"the family's total"*. Carry this into KT-P4/B1: pick one, and say which on
screen. Related: the family sum is an **upper bound**, never a total (two of our ASINs can share one
impression) — `project_kt_keyword_tracker_page`.

### ④ The ASIN picker (recon's fourth item) — **judged: keep the campaign picker, and say so**

H10's KT Setup is an ASIN picker (§4.3); ours is the shared `_schedule/CampaignSection`. Our rule
acts on **keyword targets inside campaigns**, and `bid_apply`'s allowlist is campaign-grained, so the
campaign picker is the shape that matches what the rule can actually do. D9 already recorded
*"the operator said the builder is right as it is, so the default is leave."* **KEEP — but the Setup
step should say why**, rather than differing from the reference by omission.

---

## 4. 🔴 The find this session adds: the preview is fiction, and it is on screen

**Clicked on prod, 2026-08-22.** Rule: `IF Organic Rank > 50 THEN Set Bid to €0.80`, 70 campaigns
added via Add All. Pressed **Preview**:

> **Bid Preview — current → proposed**
> *Read-only: each keyword's current organic / paid rank and the new bid it would get when this rule fires.*
>
> | Keyword / Target | Organic | Sponsored | Current | New Bid |
> |---|---|---|---|---|
> | SEARCH_CLOSE_MATCH | — | — | €0.49 | **€0.80** |
> | SEARCH_LOOSE_MATCH | — | — | €0.40 | **€0.80** |
> | PRODUCT_COMPLEMENTS | — | — | €0.40 | **€0.80** |
> | PRODUCT_SUBSTITUTES | — | — | €0.40 | **€0.80** |
> | motorradjacke | — | — | **€0.02** | **€0.80** |
> | motorradjacke herren | — | — | **€0.02** | **€0.80** |
> | … 100 rows, every one green **€0.80** … | | | | |
> | B0DJ44CDWP · B0D8SFVSGP · B0D8RN4KDL … | — | — | €0.29 | **€0.80** |

The true answer is **zero keywords**. Four separate falsehoods in one panel:

1. **The criteria are never applied.** `RuleBuilder.tsx:720-755` fetches every target in the selected
   campaigns and computes `clamp(apply(cur))` on *all* of them. It filters by campaign and nothing
   else. The rank columns it prints are decoration beside a number derived without them.
2. **90 of the 100 rows are entity kinds the rule cannot touch.** Measured live against the same
   endpoint the page calls: of the first 100 rows, **KEYWORD 10 · PRODUCT 65 · AUTO 15 ·
   PRODUCT_CATEGORY 3 · PRODUCT_AUDIENCE 4 · PRODUCT_CATEGORY_AUDIENCE 2 · AUDIENCE 1.**
   `buildKeywordRankBidContexts` selects `kind: 'KEYWORD', isNegative: false`. Auto-targeting
   expressions and ASIN product targets can never be acted on by a Keyword Tracker rule.
3. **Suppressed targets are shown being raised, with no warning and no count.** Four €0.02 rows in
   the first screenful alone. Account-wide, **561 of the 1,004 reachable targets (56%)** are
   suppressed, **141 of them unflagged**. Raising them switches delivery back on for traffic
   somebody deliberately switched off.
4. **The feed is silently truncated.** `/advertising/targets?limit=1500` returns exactly 1,500 of
   **5,218** `AdTarget` rows, and its `count` field returns the page size, not the total — so
   nothing downstream can even detect the truncation.

This is `reference_preview_must_run_the_engine` for the third time. BUD-PP fixed Budget by making the
preview run the engine; Placement calls a real `/preview` endpoint and surfaces `untranslatable`.
**Bid, SOV and Keyword Tracker still re-implement it client-side** — and KT is where the
re-implementation is most visibly wrong, because the rank columns render "—" on every row while the
bid column stays confident.

---

## 5. 🔴 The second find: the tab bypasses its own hardened write path

Keyword Tracker already **owns** the most carefully guarded bid-write path in the account — KT.6/KT.7
built it, and it was clicked on prod (a real €0.50→€0.52 write, then undone).

| | KT.6/KT.7 path (`kt6-bid-action.ts` + `kt7-apply.service.ts`) | KT/Bid/SOV **rule** path (`bid_apply`) |
|---|---|---|
| suppression by flag | **refused** (`suppressed_flag`) | ✗ |
| suppression by ≤3¢ convention | **refused** (`suppressed_by_bid`, `KT6_SUPPRESSION_CENTS = 3`), counted **separately** | ✗ |
| campaign `bidsSuppressedAt` | **refused** (`campaign_suppressed`) | ✗ |
| spend ceiling vs a nexus-side ledger | **checked at apply time** | ✗ |
| target set unchanged since proposal | **refuses the whole apply** | ✗ |
| blast radius recomputed server-side | **yes** | ✗ |
| `changeSetId` + rollback | **yes** | partial (per-change undo only) |
| campaign allowlist | yes | **yes** |
| bid clamp | yes | **yes** |

Both end at the same `updateAdTargetWithSync` → `OutboundSyncQueue` → `checkAdsWriteGate`. The gate
enforces `liveBidWritesEnabled` and bid bounds — **it does not check suppression**. So the rule path
is strictly weaker than the path the same tab already ships, and it is the one an operator can arm.

**Scope note:** the fix belongs in the shared handler and therefore affects Bid and SOV as well as
KT. It is sized below as its own phase and needs its own approval — it is not KT's to take unilaterally.

---

## 6. Wire audit — what the KT builder stores vs what the engine reads

| builder control | stored as | honoured? | evidence |
|---|---|---|---|
| Rule Name | `name` | ✅ | — |
| Campaigns (shared `CampaignSection`, incl. Portfolios + Products tabs) | `actions[0].campaigns[{id}]` | ✅ | `builderCampaignIds` → `bid_apply` `campaignIds` allowlist |
| Criteria metric — **Organic Rank** | `adTarget.organicRank` | ⚠️ **mapped, never populated** | `KeywordRank` = 0 rows |
| Criteria metric — **Sponsored Rank** | `adTarget.sponsoredRank` | ⚠️ same | same |
| Criteria metric — **Rank Change** | `adTarget.rankDelta` | ⚠️ same, **plus a fabricated 0** | §3② |
| Criteria metric — **Search Volume** | `adTarget.searchVolume` | ⚠️ same — **though a real source exists** (SQP `searchQueryVolume`) | §1.3 |
| Criteria metric — **Share of Voice** | `adTarget.sovPct` | 🔴 **never emitted; compares against `undefined`** | §3③ |
| Criteria metric — ACOS / Spend | `adTarget.acos` / `.spendCents` | ✅ *mapped correctly* — but unreachable, the context returns `[]` first | `targetPerfMap` |
| Operator (`>`, `>=`, …) | engine `op` | ✅ | `translateConditions` |
| **+ AND** (extra conditions in a block) | leaves in one block | ✅ | |
| **+ Criteria** (multi-block) | `blocks[]`, first match acts | ✅ | BP.P4b, inherited |
| THEN Set / Increase / Decrease Bid | `bid_apply` `op` + `value` | ✅ | |
| THEN Pause / Unpause Target | `pause_target` / `enable_target` | ✅ | C2 |
| Bid Guardrails Min / Max | `bidFloor` / `bidCeiling` → `minEur` / `maxEur` | ✅ | |
| Frequency + time + timezone | `schedule` | ✅ | `ads-rule-schedule.ts` due-gate |
| Max daily ad spend / write cap / exec cap | `maxDailyAdSpendCentsEur` etc. | ✅ | |
| Marketplace | `scopeMarketplace` | ✅ | |
| Control (Manual / Automate) | `autonomyLevel` via the one autonomy route | ✅ | BP.P1, inherited |
| Apply Template | modal | ✅ *honest* — says "No saved templates yet", and there genuinely are none |
| **Lookback / aggregation** (H10 has both, inline) | — | ❌ **absent** | §3① |
| **"If Your Product Has No Rank"** (H10: required) | — | ❌ **absent**, hard-coded to "ignore" | §3① |
| Starter templates (`STARTER_TEMPLATES[slug]`) | — | ❌ **no `keyword-tracker` key** (nor `sov`, nor `placement`) | |
| One-line census strip (`.h10-hv-cohortline`) | — | ❌ absent; BP/HP/NEG-P all have one | |

**Everything structural is right.** Tab attribution, arming, scheduling, multi-block, guardrails,
campaign allowlist, the shared picker — all correct and all inherited, and I found no defect in any
of them. The failure is entirely in the **signal layer**: five of seven metrics have no reading
behind them, and nothing on screen says so.

---

## 7. Gap matrix

### KEEP (verified correct — do not touch)

| item | evidence |
|---|---|
| `page.tsx` → `KeywordTrackerRulesClient`, one rules grid | H10 §3.10 exactly; clicked on prod |
| The KT.1–KT.10 report **parked, not deleted** | U4 operator decision; 0 importers verified both ways |
| `RULE_TAB_ACTION_TYPES['keyword-tracker'] = []` + slug derivation | correct and well-documented; no cross-tab bleed with Bid/SOV despite all three emitting `bid_apply` |
| Campaign picker instead of H10's ASIN picker | D9; matches what `bid_apply` can allowlist — **but state it on the Setup step** |
| `if (!e) return null` (skip unranked) as the **default** | the conservative branch; H10's own second option |
| Apply Template empty-state copy | honest and accurate |
| Arming · schedule due-gate · multi-block · guardrails · caps · scope | BP/HP/NEG-P inheritance, all verified honoured |
| `KeywordCoverageSet.enabled` left untouched | it is an arming switch for another engine |

### FIX

| # | gap | evidence | size |
|---|---|---|---|
| F1 | Nothing on the tab or the builder says the rank feed is empty; the "Measurement window" note asserts a settling window on a metric with 0 readings | §0, §1.1 | M |
| F2 | Preview applies no criteria, includes 90% ineligible entity kinds, shows suppressed targets being raised, truncates at 1,500 silently | §4 | M |
| F3 | `'Share of Voice'` in `RANK_METRIC` + `METRICS_RANK` compares against `undefined`; anti-correlated if bound | §3③ | S |
| F4 | `rankDelta` fabricates `0`; `prior` can cross ASINs; `take: 8000` truncates alphabetically | §3② | S |
| F5 | `bid_apply` has no suppression guard — 561 of 1,004 reachable targets (56%), 141 unflagged, 420 in bid-suppressed campaigns | §1.4, §5 | M (cross-tab) |
| F6 | No lookback / aggregation control (H10 has `Average \| Median \| Consecutive` × `3\|5\|7\|10` days) | §3① | M |
| F7 | No "If Your Product Has No Rank" control | §3① | S |
| F8 | No starter templates, no census strip — the only programme tab without either | §6 | S |

### BUILD (operator's call — the substantive question)

| # | option | what it buys | size |
|---|---|---|---|
| B1 | **Re-source KT criteria from Brand Analytics SQP** — Query Market Share (`impressionsBrand/impressionsTotal`, Amazon's own), Search Volume, Query Popularity Rank — with per-market coverage stated on screen | a Keyword Tracker rule that **actually fires**, on 946 of 2,130 targets, using data we already ingest and are licensed to use | L |
| B2 | Buy a rank feed (option **B** from the competitor study) and fill `KeywordRank` | true organic/paid SERP position; unlocks F6/F7 and H10 parity | L + € |
| B3 | Retire the rule type (H10 itself ships a `hideKeywordTrackerRule` flag) | nothing false on screen, at the cost of the capability | S |

### REFUSE (with evidence)

| refusal | why |
|---|---|
| **Do not build a SERP collector** | Amazon ToS prohibits automated scraping; the selling account is the asset at risk. Already an explicit operator-level decision — competitor study §5.3, *"A not at all."* |
| **Do not adopt `sovPct` into the rank context** | ρ = −0.2445 against Amazon's real per-query share, negative in all four markets; median 0.0026% (`"< 50%"` matches 1000/1000 rows); our five strongest real positions all read 0.000x%. A rescale would NOT fix it — the error's sign flips across the head. Measured by SOV-P today. |
| **Do not un-park the KT.1–KT.10 report onto this tab** | U4 was a deliberate operator decision; its home is Analytics › Coverage. Reversing it is a different ask. |
| **Do not touch `chooseViewPeriod` / `periodCoverageByMarket`** | SOV-P is live in that function; `share-of-voice.service.ts` is its other caller. |
| **Do not make the rank metrics "work" by defaulting a missing rank to 306/96 without a feed** | it would manufacture a reading. H10's 306/96 option is a *treatment of a measured gap*, not a substitute for measurement. |
| **Do not ship anything that emails** | `NEXUS_ENABLE_OUTBOUND_EMAILS` is already TRUE on prod. |
| **Do not seed starter templates before the signal is real** | a starter is a promise the rule will do something; today every KT starter would be inert. F8 follows B1/B2, never precedes them. |

---

## 8. Proposed phase plan

Ordered so that **every phase before the operator's B-decision is honest-by-subtraction** — nothing
built on a signal that does not exist.

| phase | what | size | depends on |
|---|---|---|---|
| **KT-P1** | **Tell the truth.** Tab + builder state that no rank data has ever been ingested. The five unbacked metrics are disabled with the reason attached (`aria-disabled` + `held` + the click is answered — `reference_disabled_control_cannot_explain`). Save refused on a rank-only criterion, naming why. The "Measurement window" sentence stops describing a reading that has never existed. One-line census strip with live numbers. | **M** | — |
| **KT-P2** | **The preview runs the engine.** Filter to `KEYWORD`/non-negative, apply the criteria, exclude suppressed targets by **both** tests and count them separately, state "N of M would change" and what was excluded and why. Reuse `kt6-bid-action`'s exclusion vocabulary rather than a second one. | **M** | P1 |
| **KT-P3** | **Wire truth.** Drop `'Share of Voice'` from `RANK_METRIC` + `METRICS_RANK` (SOV-P cleared it). `rankDelta` → `null` when not measurable, in **both** producers. Key the latest/prior collapse on `(keyword, marketplace, asin)`. Replace `take: 8000` with a bounded per-keyword query. | **S** | — |
| **KT-P4** | 🔴 **OPERATOR DECISION — B1 / B2 / B3.** My recommendation: **B1**. It is the only option that makes the tab work this week, it uses data we already have and are licensed to use, and it is exactly option "C" from the competitor study's own recommendation, sourced correctly (from SQP, *not* from `analyzeShareOfVoice`). | **L** | decision |
| **KT-P5** | If B1: the criteria row gains H10's shape over the new signal — metric × aggregation × lookback — plus the "no data for this keyword" treatment. Starter templates + Save Template parity. | **M** | P4 |
| **KT-P6** | 🔴 **Separate approval — cross-tab.** `bid_apply` gains the suppression guard (flag · ≤3¢ · `bidsSuppressedAt`), reusing KT.6's exclusions. Affects **Bid and SOV as well as KT**, and closes a 56%-of-reachable exposure that is live today. | **M** | own approval |

**P1 + P3 alone remove every false statement from the tab**, and P3 is a three-line change. If the
operator wants the minimum, that is the minimum.

---

## 9. Verification plan (for the build phases)

Per the BP-proven protocol: `@nexus/shared` rebuild if touched → `tsc` both apps → api vitest
(~5,009+) → web vitest (922) → five ratchets (`check-button-vocabulary` 286 ·
`check-silent-disabled` 27 · `check-help-cursor` **0** · `ds-conformance-guard` · `p3-token-sweep`)
→ Playwright smoke on the `_bp-verify-stub` rig (`:8099`) + dev `:3001` → prod click-through after
push. `grep -a` on every ads file.

**KT's own history is the reason the click-through is not optional:** KT.6 shipped four defects that
tsc, review and 30 tests all passed; KT.7 shipped six more; KT.8's worst — a cliff sentence naming
the very week it was already on — survived eleven tests. Every one was found by reading the rendered
screen. The preview defect in §4 is the same class and was found the same way.

## 10. Coordination

- **SOV-P (`nexus-commerce-7c`)** — asked and answered today. Cleared `RANK_METRIC` +
  `METRICS_RANK` as mine; they will not touch either. They may change `SOV_METRIC` /
  `analyzeShareOfVoice`; I will not enter those.
- **BUD-P** holds `ads-rule-adapter.service.ts`, `PerformanceCriteria.tsx`, `RuleBuilder.tsx`,
  `advertising-rule-evaluator.job.ts` dirty — every one on my edit path. Phases are ordered so my
  edits there are minimal, late, and line-scoped; commits go through the temp-index plumbing recipe
  with a blob-split against `HEAD` and `git diff --no-index -a` proof.
- Probes are `_ktp-` prefixed; `_kt-page-*.mts` belong to the older session and are untracked.

## 11. Artefacts

`apps/api/scripts/_ktp-p0-census.mts` · `_ktp-p0-sources.mts` · `_ktp-p0-exposure.mts` ·
`_ktp-p0-gate.mts` (all read-only). Prod preview screenshot captured 2026-08-22.

---

# BUILT — KT-P1 · KT-P2 · KT-P3 (2026-08-22, local; not committed, not deployed)

Operator approved the phase plan ("go ahead"). Built the three phases that needed no further
decision. **P4 (the B1/B2/B3 choice) and P6 (the cross-tab `bid_apply` guard) are NOT built** — both
were flagged as needing their own decision, and they still do.

## The find that changed a phase mid-build

🔴 **`null` is byte-identical to `0` for this engine, so the approved P3 fix was a no-op.**

The plan said "`rankDelta` null-not-0". `applyOperator` (`automation-rule.service.ts:87`) coerces
with `Number()`, and **`Number(null)` is `0`** while `Number(undefined)` is `NaN`. Measured:

| `adTarget.rankDelta` | `<= 0` | `>= 0` | `= 0` | `< 5` | `> 5` |
|---|---|---|---|---|---|
| `0` (the original defect) | true | true | true | true | false |
| `null` (the approved fix) | **true** | **true** | **true** | **true** | false |
| **key absent** | false | false | false | false | false |

Nulling it would have compiled, reviewed and diffed clean, and changed nothing. Only **omitting the
key** refuses. Fixed with a `measured()` helper that strips null/undefined from the emitted context.

⚠ **The same trap is live one layer out and was NOT touched.** `EMPTY_TARGET_PERF` / `targetPerfMap`
set `acos/roas/ctr/cvr/cpcCents` to `null`, so a target with spend and **zero sales satisfies
`ACOS <= 20%`** and would have its bid RAISED as a 0%-ACoS winner. That map is shared with **Bid and
SOV**, where rules can actually fire. Raised for decision alongside KT-P6 — not changed unilaterally.

## What shipped

**KT-P3 — wire truth**
- `'Share of Voice'` removed from `RANK_METRIC` + `METRICS_RANK`. It now **refuses** a draft
  (`untranslatable`) instead of silently never matching. Cleared with SOV-P, who will not touch
  either line.
- `rankDelta` **omitted** when not measurable (see above), in the evaluator; `null` on the wire in
  `GET /advertising/keyword-ranks`, where `null` is correct and renders as `—`.
- The latest/prior collapse now keys on **`(keyword, marketplace, asin)`**, so a delta is never
  *ASIN A's rank minus ASIN B's*. The rule's lookup stays per (keyword, marketplace); the ASIN whose
  latest observation is newest represents the pair and brings its own prior.
- `take: 8000` reordered to **`capturedAt desc`**: truncation now drops the oldest observations
  instead of every keyword late in the alphabet, and logs when it binds.
- `buildKeywordRankBidContexts` exported, so the preview reads **the engine's own producer**.

**KT-P1 — tell the truth**
- `GET /advertising/keyword-tracker/feed-health` (new; `advertising-intel.routes.ts`, no route
  collision — verified against the two existing `/keyword-tracker*` statics).
- Tab: a live one-line census strip. When the feed is empty it says so with real numbers; when the
  fetch has not landed **it renders nothing at all** — silence and zero must not look alike.
- Builder: an amber banner stating the feed's true state, and **Create Rule `held`** — `aria-disabled`,
  not `disabled`, still focusable, pointer cursor — answering the click with a note.
- `PcWindowNote` no longer asserts a settling window over a metric with zero readings, and now states
  what happens to a keyword with no observation (H10's "no rank" default, disclosed).

**KT-P2 — the preview runs the engine**
- `previewKeywordTrackerRule` reuses `runDraftPreview` (SOV-P2's shared five stages) with its
  `buildContexts` / `entityId` hooks. **No fork.**
- Reports the **feed** (so "nothing matched" and "nothing was measured" are distinguishable) and
  **suppression counted in two** — flag and ≤3¢, never merged.
- The dead `isRank` branch inside `isBidLike` was **removed, not left inert**.
  ⚠ Bid and SOV still carry the client-side preview and its defects; theirs to fix.

**Verified against prod, read-only:** the same draft that rendered **100 rows of green €0.80**
(`IF Organic Rank > 50 THEN Set Bid €0.80`, 70 campaigns) now returns
`selected 70 · measurable 0 · inScope 0 · matched 0 · rows 0 · feed.rows 0`.

## Four defects found by reading the screen, none visible in the diff

1. 🔴 **The refusal was invisible.** Clicking the top Create Rule set the note at `y=2491` in a 962px
   viewport and scrolled 41px — the button greyed and *nothing appeared to happen*. `scrollIntoView`
   ran before React rendered the note. Fixed with a ref + an effect keyed on the flag.
2. 🔴 **`behavior: 'smooth'` is a silent no-op in `.h10-rb-body`.** Measured on that exact node:
   smooth left `scrollTop` at 0 across 1.2s; the default behaviour moved it to 1735.5 instantly.
   `prefers-reduced-motion` is off and `scroll-behavior` computes to `auto`. A refusal that depends
   on an animation which declines to run is a control that appears to do nothing.
3. **The refusal broke the controls it explained.** Rendered inside `.h10-rb-foot`
   (`display:flex; align-items:center`) the note consumed the row and wrapped both buttons onto two
   lines each — "Save / Template", "Create / Rule". Lifted above the footer.
4. **Copy, read as rendered:** `that<i>does</i>` printed as **"thatdoes"** (fixed with `{' '}`);
   *"1 of those **carry** no suppression flag"* → *carries*; *"1 of them already **bid** this"* → *bids*.
   Plus the preview's keyword column clipped at 128px in a 640px modal ("motorradjacke he…") — the
   rank table is 7 columns where budget is 5, so it now gets its own 900px width and the keyword
   wraps rather than clips.

Contrast, both themes, alpha composited over the painted ancestor: strip **6.14–15.51**, banner
**9.84–10.66**, held note **9.17**; banner icon raised from 3.73 → ~5.3. No body h-scroll.

## Rendering that prod data cannot reach

The rank table, Δ column, per-row suppression tags and the census warning **cannot render against
production** — the feed is empty and the honest answer is always "0 matched". Rather than ship
pixels nobody has looked at (how KT.6, KT.7 and KT.8 each shipped their worst defect), the rig stub
carries a `?ktpFixture=1` mode that serves one synthetic result **in the real result shape**. All four
copy/layout defects above were found that way. **No fixture code exists in the repo's web source** —
verified by grep; it lives only in `_ktp-verify-stub.mts`.

## Gates

`tsc` api **0** · `tsc` web **0** · api vitest **398 files / 5,169 tests, 0 FAIL** · web vitest
**985 pass** (the 8 Playwright `.spec.ts` files vitest cannot run — the documented baseline) ·
ratchets **button-vocabulary 283 at baseline · silent-disabled 27 at baseline · help-cursor 0 ·
ds-conformance · p3-token-sweep** — all pass.

⚠ **api vitest exits non-zero on a flaky harness race**, not a test failure:
`EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`, landing on a different
unrelated file each run (`pim-mapping-simulate`, then `stock-import-controls`). Zero `FAIL` lines.
⚠ `check-help-cursor` greps this repo **as text**, so a code comment naming the banned cursor fails
it. Mine did, once. Do not name it in prose either.

**New tests:** `keyword-rank-context.vitest.test.ts` (17) — including the 0/null/undefined operator
table that would have failed against both the original code *and* the approved "fix" —
and `ads-kt-preview.vitest.test.ts` (7).

## Still open

| | |
|---|---|
| **KT-P4** | the B1/B2/B3 decision — re-source from SQP (recommended) / buy a feed / retire |
| **KT-P6** | `bid_apply`'s missing suppression guard — **561 of 1,004 (56%)** reachable targets, live on Bid and SOV today |
| **NEW** | `EMPTY_TARGET_PERF`'s `null` ACoS — a zero-sales target reads as a 0%-ACoS winner. Same shared map, same two tabs |
| Bid / SOV | still preview client-side, with the criteria-ignored and ineligible-kind defects |
| `.h10-rb-heldnote` | has no dark-theme variant (PLC-P's element; readable at 9.17, but a light box in dark mode) |

---

## Addendum — the comparator hole, measured on the ARMED rules (2026-08-22, after the build)

PLC-P hit the same `Number(null) === 0` hole from the Placement side and measured it on Budget.
Verified independently here, on the contexts `buildCampaignBudgetContexts(7)` actually builds:

**38 of 46 budget contexts carry `acos: null`, and all 38 satisfy `acos ≤ 0.25`.** Confirmed.
No other budget-context field is ever null: `roas · ctr · cvr · cpcCents · budgetUtilization` = 0 of 46.

### Exposure to the four rules armed on prod right now: ZERO — for three different reasons

| armed rule | risky leaf | exposed? | why |
|---|---|---|---|
| Reclaim idle budget — DE | `campaign.budgetUtilization lte 0.1` | **no** | that field is null on **0 of 46**. Leaf alone matches 10; whole rule matches 1 |
| Harvest proven winners — GALE DE | `searchTerm.acos lte 0.3` | **no, today** | ANDed with `orders ≥ 2`; terms with ≥2 orders and zero sales = **0 of 3,980**. Data-dependent, not structural |
| Stop wasted spend — GALE IT | — | n/a | `eq 0` / `gte` only |
| Trim Top of Search — GALE BROAD IT | — | n/a | `eq 0` / `gte` only |

### The starter library: 8 risky leaves, all AND-guarded — but by two different kinds of guard

| guard | example | holds because |
|---|---|---|
| **structural** | `CTR ≤ x AND Impressions ≥ 500` (placement) | `ctr` is null *exactly* when impressions are 0, so the guard removes the null set by construction |
| **data-dependent** | `ACOS ≤ x AND Orders ≥ 2` (bid · budget · placement · harvest) | holds only while nothing has orders without attributed sales — true today (0 of 3,980), not guaranteed |
| **no protection** | `Share of Voice < x AND Spend ≥ y` (both SOV starters) | a spend guard does not exclude a null share — a campaign can have spend and no share |

So the library is safe today largely by a convention (noise guards) rather than by design — PLC-P's
phrase, "luck earned by a convention", is the accurate description.

### The fix is not "make null fail `lte`"

`Number(undefined)` is `NaN` and every comparison against `NaN` is false, so an **absent** value fails
`gt` and `gte` too. That is correct for "not measurable" and is a different statement from "null
should fail `lte`". Scoping it as the latter gets the fix wrong. It moves every rule in the account,
so it is its own unit and its own decision — not KT's, and not taken here.

## Addendum 2 — a convention question raised by SOV-P, measured and NOT taken

`buildKeywordRankBidContexts` applies **no status filter** (`buildUnderperformContexts` and, since
SOV-P1, `buildSovBidContexts` both filter `status: 'ENABLED'`). Measured over the 2,130 positive
keyword targets it walks:

| | targets |
|---|---|
| target ENABLED / ARCHIVED / PAUSED | **1,777 / 234 / 119** |
| in a PAUSED campaign | **1,228** |
| in an ENABLED campaign | 901 |

So an unfiltered rank rule would compute bids for ~353 dead targets and 1,228 targets inside paused
campaigns. **Not changed:** it is a convention difference, not a defect, and it changes which
population a future rule acts on — which is the operator's call, not a wire fix. Costs nothing today
(0 contexts), which is exactly why it is the cheap moment to decide it.

## Addendum 3 — commit preconditions (recorded before any commit is attempted)

🔴 `RuleBuilder.tsx` and `advertising-intel.routes.ts` carry SOV-P's **uncommitted** SOV-P2 wiring,
which calls **untracked** `ads-sov-preview.service.ts`. A `git commit --only` on either path takes
the working-tree copy and would commit callers without the callee — a Railway build failure
(`ba4cad608`'s mode). When authorised: blob-split from `git show HEAD:<path>`, take only the KT-P
lines (`isRank` · `rankFeed` · `rankBlocked` · `rankHeldNote` · `rankNoteRef`; and in the routes
file, the `slug === 'keyword-tracker'` branch + the `/keyword-tracker/feed-health` route), prove with
`git diff --no-index -a`, and coordinate ordering with SOV-P.


---

# CORRECTION + steps 2–4 shipped (2026-08-22)

## 🔴 A figure I gave the operator was wrong, and the corrected rule is sharper

I reported **197 of 435 keyword targets with spend and zero sales, 196 write-enabled, €713.47** as
Bid-tab exposure to the null-ACoS hole. **The population is real; the exposure is not.**
`KEYWORD_HIGH_ACOS`'s own emitter filters `orders > 0 && sales > 0`, so `adTarget.acos` is always
defined in that context and those targets never become contexts at all. No builder Bid rule could
have read them as 0%-ACoS winners. Caught by SOV-P; verified in the emitter's `.filter` before
accepting.

**The corrected, more useful rule: a trigger's own floor can make a whole class of nulls
UNREACHABLE — read the emitter's `where`/`filter` before believing a null hazard.** It says which
emitters to audit instead of implying all of them. What stands unchanged is the budget instance
(**38 of 46**) and the SOV concentration instance (**86 of 793**) — precisely the emitters that do
NOT filter. The case for fixing it at the producers is unchanged and arguably strengthened: the
emitters that already filter are doing the right thing, and the fix makes the others match.

## Shipped

| commit | what |
|---|---|
| `76d112b2a` | KT-P1/P2/P3 — API + tab |
| `d4ead4a38` | KT-P1/P2 — the builder half |
| `1cf7869ca` | **C1** — eight context builders omit an unmeasurable metric instead of nulling it |
| `cba86dc11` | **P6** — `bid_apply` never un-suppresses; the preview reports refusals as rows |
| `a01d0fa03` | **C2** — the KT context asks only for ENABLED targets |

**P6's sharpest measurement:** re-read at commit time, the account showed **flagged: 0** and
**in-a-suppressed-campaign: 0**, while **low-and-unflagged held at 141**. `suppressedFromBidCents`
was 420 earlier the same day. **A guard on the flag alone would have protected nothing at that
instant; the ≤3¢ convention is what protects the 141.** That is the strongest possible argument for
counting the two separately rather than merging them.

**P6 forced a copy change, and that is the point.** Before the guard the honest warning was "this
rule WOULD raise them and switch delivery back on". After it, that wording promises an action the
engine no longer takes — the same class of falsehood pointing the other way. A surface that
describes engine behaviour has to change when the engine does.

## Still open

| | |
|---|---|
| **KT-P4** | the data decision — recommended: defer (B1 would duplicate SOV, which is now SQP-sourced) |
| Campaign-status filter | **1,228 of 2,130** KT targets sit in a PAUSED campaign; no sibling builder filters on campaign status, so it is a convention change, not a fix |
| `bid_up` / `raise_bids_for_rank_defense` | share the un-suppression hole in principle; their percentage math cannot lift a 2¢ bid past 3¢, so the risk is far lower — not changed |
| Bid tab's preview | the last tab still computing client-side |
