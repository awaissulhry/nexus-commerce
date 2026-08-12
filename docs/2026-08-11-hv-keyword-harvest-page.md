# HV — Keyword Harvest as its own page

**Read-only study. No application code was changed. Nothing was committed.**
Session slug `hv`; parallel-session protocol observed — every file created here is `_hv-page-*`.

Measured on production 2026-08-11 with `apps/api/scripts/_hv-page-wiring.mts`,
`_hv-page-forensics.mts`, `_hv-page-engine.mts`, `_hv-page-cohort.mts` and `_hv-page-gate.mts`
(all read-only, all re-runnable).

Builds on `docs/2026-08-11-hv-keyword-harvest-study.md`. **§3 corrects three of its findings, one
of which reverses its headline.**

---

## 0 · The one-sentence version

The tab is empty for **three** independent reasons, not one — and behind it the `ads-auto-harvest`
engine is **not** idle as the earlier study concluded: it runs on **AUTO** every night at 06:30,
applies **14 graduations and 8 negations live**, and has written **218 keywords of which 209 never
reached Amazon** — while the rule layer performing the identical actions is held at PROPOSE by a
ceiling whose own comment says these actions "may not run unattended."

---

## 1 · What exists — every wire

```
/marketing/ads/rules-automation?tab=keyword-harvest          ← the 8th tab, NOT routed
└── RulesAutomationClient.tsx:387   <RuleListTab liveType="keyword-harvesting" />
    ├── badge  ← _shared/tabs.tsx:126  ruleBelongsToTab(r.actions, 'keyword-harvest')  → 5
    └── grid   ← tabs/RuleListTab.tsx:62 ruleBelongsToTab(r.actions,'keyword-harvesting') → 0
                 GET /advertising/automation-rules

Builder   /builder/keyword-harvesting → _shared/RuleBuilder.tsx (slug 'keyword-harvesting')
          TRIGGER_BY_SLUG['keyword-harvesting'] = 'SEARCH_TERM_CONVERTING'   RuleBuilder.tsx:76
          actions: [{ type: slug, … }]                                      RuleBuilder.tsx:499
          metrics offered: Sales·ACOS·ROAS·Clicks·Impressions·CVR·CTR·CPC·PPC Orders·Spend·Orders
                                                          PerformanceCriteria.tsx METRICS_BASE
          Preview pane → GET /advertising/harvest/preview  RuleBuilder.tsx:424

Adapter   services/advertising/ads-rule-adapter.service.ts:181
          'keyword-harvesting' → promote_to_exact (bidEur 0.75 unless "fixed")
                               + add_negative_exact when negateInSource === true

TWO ENGINES, and they do not agree:
  A  SCHEDULE → harvest_and_negate      automation-action-handlers.ts:840
       → previewHarvest / applyHarvest  ads-harvest.service.ts
       60 days · ALL match types · minOrders 2 · minSpend €10 (handler) vs €15 (service)
  B  SEARCH_TERM_CONVERTING → promote_to_exact   automation-action-handlers.ts:1031
       → advertising-rule-evaluator.job.ts:675 buildSearchTermConvertingContexts()
       30 days minus the provisional tail · matchType IN (BROAD,PHRASE) OR NULL · having >= 2 · cap 300

Cron      ads-auto-harvest  cron-registry.ts:307 → ads-auto-harvest.service.ts
          gated ONLY by getAutomationState() — a global switch on another page
Sibling   ads-coverage-engine (6 runs, sets=0) · ads-console/automation/HarvestTab.tsx
Orphan    /marketing/advertising/funnel — the destination + cross-match negation, already built
Storage   AdTarget (positive) + AdTarget (isNegative) · AdsRuleSuggestion · AdvertisingActionLog
```

### 1.1 The measured state

| measurement | value |
|---|---|
| advertising `AutomationRule` rows | 51 |
| rules the **badge** counts (`promote_to_exact` ∪ `harvest_and_negate`) | **5** |
| rules the **grid** shows | **0** |
| rules carrying the builder's action type `keyword-harvesting` | **0** |
| action-type census | `harvest_and_negate` 4 · `promote_to_exact` 1 |
| `AmazonAdsSearchTerm` | 10,826 rows · 2026-05-20 → **2026-08-10 (1 day old)** |
| positive `KEYWORD` `AdTarget` | 2,129 · ENABLED 1,982 · PAUSED 119 · ARCHIVED 28 |
| positive keywords with **no Amazon id** | **210 (10%)** |
| negative `KEYWORD` `AdTarget` | 2,056 · AD_GROUP 2,034 · CAMPAIGN 22 |
| ad groups by match role in the name | EXACT 72 · PHRASE 61 · BROAD 58 · AUTO 40 · unnamed 58 |
| campaigns | AUTO 39 · MANUAL 161 |
| `AdsRuleSuggestion` | **225 pending · 1 applied**; 23 of them from a harvest action |
| `AdTarget` rows with any non-zero impressions/clicks/spend/sales/orders | **0 of 5,213** |

**The one thing this tab has that no other tab in the section has: its data is one day old.**
Share of Voice and Keyword Tracker read SQP at 17 days (KT page study §4.1). Harvest reads
`AmazonAdsSearchTerm`, refreshed by `ads-v1-export-ingest` every five minutes. Whatever this page
shows, it can show it about *today*.

---

## 2 · How it works, and the six defects on the wires

### D1 — the grid can never render a row, and the fix is two changes, not one

`RulesAutomationClient.tsx:391` passes `liveType="keyword-harvesting"`. `ruleBelongsToTab` looks
that up in `RULE_TAB_ACTION_TYPES`, whose key is `'keyword-harvest'`, gets `undefined`, and returns
`false` for all 51 rules. The badge on the same screen uses the correct key and says **5**.

The earlier study called this "one string." It is not, and the reason matters:

1. `RulesAutomationClient.tsx:391` must send `'keyword-harvest'` — the tab key.
2. **`RULE_TAB_ACTION_TYPES['keyword-harvest']` must also gain `'keyword-harvesting'`**, because
   `RuleBuilder.tsx:499` writes `actions: [{ type: slug }]` and the slug is `keyword-harvesting`.
   Today that is latent — **zero** rules carry it — but it means the *first rule an operator creates
   in the builder is invisible on the tab it was created from*, even after fix (1).

The mapping already exists and is unused: `ruleTypes.ts` carries
`{ slug: 'keyword-harvesting', tab: 'keyword-harvest' }`. `_shared/tabs.tsx` is shared substrate —
**stated as a requirement in §7, not designed here.** (Sessions 1 and 2 need the same shape for
`'keyword-tracker'` and `'sov'`.)

### D2 — the builder's Preview reads the wrong keys off its own endpoint

`RuleBuilder.tsx:425`:

```ts
const raw = (j.candidates ?? j.terms ?? j.items ?? (Array.isArray(j) ? j : [])) as Array<…>
```

`previewHarvest()` returns `{ negatives, graduations, productNegatives, productGraduations,
windowDays }` — not `candidates`, not `terms`, not `items`, and not an array. So `raw` is `[]` on
every call. **The Preview button on the Keyword Harvesting builder has never been able to show a
candidate**, on an endpoint that returns 14 of them right now.

### D3 — the only "Apply harvest" button in the app applies nothing

`ads-console/automation/HarvestTab.tsx:38` posts `{ windowDays }` to `/advertising/harvest/apply`.
`applyHarvest` reads `args.negatives ?? []` and `args.graduations ?? []` — both absent. It loops
over nothing, returns `{negativesAdded: 0, keywordsGraduated: 0, …}`, and the UI renders
`r.promoted ?? r.graduated ?? 0` — **fields that do not exist in the response** — so the message is
always *"Applied · 0 promoted, 0 negated"* after a confirm dialog that promised to promote N terms.
That surface is on the retiring console and is another session's to remove, but it is the only
manual harvest control that exists today and it is inert.

### D4 — every write control on the Rules grid is decoration

`RuleListTab.tsx` contains exactly three `fetch` calls (load rules, load executions, roll back an
execution). `toggleAutomation` (:73), `editMode.onApply` (:97) and `applyBulk` (:120) all call
`setRows(…)` and nothing else. So Automation, Criteria, Frequency and **Delete** mutate local React
state and vanish on reload — and the Delete modal says *"This cannot be undone."* Shared with four
other rule-type tabs; §7 R6.

### D5 — 🔴 the adapter silently drops six of the eleven metrics the builder offers

The harvest builder offers `Sales · ACOS · ROAS · Clicks · Impressions · CVR · CTR · CPC ·
PPC Orders · Spend · Orders`. `ads-rule-adapter.service.ts`'s `SEARCHTERM_METRIC` map contains
**five**: `Orders`, `PPC Orders`, `Clicks`, `Spend`, `Sales`. `translateConditions` logs a warning
and **`continue`s** on anything else.

Dropping an AND-condition does not make the rule stricter. It makes it **looser**. A rule written as

> *IF PPC Orders ≥ 2 AND ACoS ≤ 25% THEN promote to exact*

executes as *"IF PPC Orders ≥ 2"*. The ACoS ceiling — the one condition standing between harvesting
and buying unprofitable traffic — is discarded at evaluation time, in a `logger.warn` nobody reads.
`ACOS`, `ROAS`, `Impressions`, `CVR`, `CTR` and `CPC` are all reachable from the UI today.

The same pass drops the builder's **lookback/exclude windows** (`translateConditions` reads only
`g.conditions`), its **ad-group mapping matrix** (`a0.mappings`), `dedupe`, `filters.brandExclude`,
`filters.competitorOnly` and `searchTerms`. Of everything the Keyword Harvesting builder collects,
what survives into execution is: the five mapped metrics, `negateInSource`, and `bid.mode/value`.

### D6 — 🔴 the auto-targeting blind spot: the funnel cannot see the funnel's source

`buildSearchTermConvertingContexts` filters `matchType IN ('BROAD','PHRASE') OR matchType IS NULL`,
with a comment explaining the null branch as *"auto-targeting, no match type"*.

**Not one row in this account has `matchType = NULL.`** Measured, 60 days:

| campaign `targetingType` | `matchType` | rows | orders | visible to `promote_to_exact`? |
|---|---|---|---|---|
| MANUAL | PHRASE | 3,090 | 55 | ✅ |
| **AUTO** | **`TARGETING_EXPRESSION_PREDEFINED`** | **2,644** | **19** | 🔴 **no** |
| MANUAL | EXACT | 984 | 45 | ✅ correctly excluded |
| MANUAL | BROAD | 746 | 16 | ✅ |
| **MANUAL** | **`TARGETING_EXPRESSION`** | **210** | **7** | 🔴 **no** |

Auto campaigns carry `TARGETING_EXPRESSION_PREDEFINED`; product-targeting expressions carry
`TARGETING_EXPRESSION`. Neither is in the filter. **2,854 search-term rows and 26 orders of
auto-discovered demand — the entire auto→manual harvest funnel — are structurally invisible to the
promote path.** What `promote_to_exact` can actually see is broad and phrase only, which is exactly
what its one live rule is named: *"Auto match-type migration (broad → exact)"*. The rule is honest;
the tab's promise is not.

### 2.1 The two engines do not agree on anything

| | **A** `harvest_and_negate` (SCHEDULE) | **B** `promote_to_exact` (SEARCH_TERM_CONVERTING) |
|---|---|---|
| window | 60 days | 30 days, provisional tail excluded |
| latency skip | **none** | yes (`ruleWindowBounds`) |
| match types | **all** | BROAD, PHRASE, NULL *(→ D6)* |
| threshold | `action.minOrders`, default 2 | `CONVERTING_MIN_ORDERS` env, default **2**, as a `having` clause |
| can a rule loosen it? | yes | **no** — the context builder filters first; a rule condition can only tighten |
| cap | none | 300 contexts |
| negates the source? | only when a `destinations` map is present (H.3) | only when the rule also lists `add_negative_exact` |
| bid | `graduationBidEur ?? 0.50` | `action.bidEur ?? 0.50`; adapter sends 0.75, template sends 0.60 |

Measured on the same day:

| minOrders | A — `previewHarvest(60d, all)` | B — `SEARCH_TERM_CONVERTING(30d)` |
|---|---|---|
| ≥ 1 | 94 | 29 |
| **≥ 2** *(both defaults)* | **17** | **3** |
| ≥ 3 | 8 | 1 |

**14 of the 17 candidates the harvest engine acts on can never be seen by the promote rule.**
Two tabs' worth of surface describe one concept implemented twice, with different windows, different
match-type filters, different latency handling and five different bid constants.

### 2.2 Five bid constants for one decision

`promote_to_exact` 0.50 · `harvest_and_negate` 0.50 · adapter "suggested" **0.75** ·
template `promote_to_exact` 0.60 · template `graduationBidEur` 0.65.

`applyHarvest` **already implements CPC inheritance** —
`bidEur ?? (clicks > 0 ? max(0.05, costCents/clicks/100) : 0.5)` — and the rule path defeats it by
always passing a value. Against the account's own evidence (92 converting terms, 60 days):

| | min | p25 | median | p75 | p90 | max |
|---|---|---|---|---|---|---|
| observed CPC | €0.17 | €0.38 | **€0.46** | €0.54 | €0.61 | €1.69 |

| constant | overpays on |
|---|---|
| €0.50 | 55 of 92 (60%) |
| €0.60 | 82 of 92 (89%) |
| €0.65 | 85 of 92 (92%) |
| €0.75 | 86 of 92 (93%) |

**"Inherit the bid" is not a build. It is deleting an argument** on two call sites
(`automation-action-handlers.ts:904/906` and `:1034`).

⚠️ One caveat worth carrying: `Campaign.maxBidCents` is set at IT €0.80 · DE €1.90 · ES €0.90, and
`minBidCents` is **unset on all 11 campaigns the candidates live in** (consistent with the BID
study §6, measured here on this population). Two of the 14 nightly graduations have observed CPCs of
€1.26 and €1.69 — above the IT ceiling. A CPC-inherited bid must expect to be clamped and say so.

---

## 3 · 🔴 Three corrections to the 2026-08-11 study

**I am recording all three because in each case the earlier version was the more plausible reading
of the data alone.**

### 3.1 The engine is not idle. It is on AUTO, and it writes.

The study's §0 concluded the harvest engine *"reports nothing left to harvest."* Measured:

```
getAutomationState() → { autonomy: "AUTO", halted: false, effectivelyStopped: false }

ads-auto-harvest — 72 runs, nightly 06:30
  2026-08-11T06:30 SUCCESS  neg=8/8 grad=14/14 dryRun=false
  2026-08-10T06:30 SUCCESS  neg=9/9 grad=14/14 dryRun=false
  2026-08-09T06:30 SUCCESS  neg=8/8 grad=14/14 dryRun=false
  …six more, identical
```

`runAutoHarvestOnce` skips only when the **global** automation state is halted, and dry-runs only
when it is `SUGGEST`. It is `AUTO`. So `applyHarvest` runs for real every night — 14 graduations and
8–9 campaign-scoped negations, unattended.

**Now put that beside `ads-graduation.ts:57`,** which lists `promote_to_exact` and
`harvest_and_negate` among the STRUCTURAL actions, with the comment:

> *"Actions that CREATE or DESTROY something. Each needs a retirement path designed alongside it,
> and none has one yet, so none may run unattended."*

Every **rule** carrying those actions is therefore capped at PROPOSE — correctly, and study 7
confirmed the retirement path is still missing. **The engine doing the identical thing has no
ceiling, no mode dial, no scope, and no row on the Automations page.** This is the AUTO study's
question 1 ("should the engines get rows?") with a live, dated, structural answer.

It has not been *harmful* only because of an accident: **0 of the 14 nightly graduations are
genuinely new.** All 14 already exist as EXACT keywords in their source ad group, so `H.1` returns
the existing row and nothing is written — and because `createKeywordLocal` returns early, **it does
not even write an audit row.** The engine's daily activity leaves no trace anywhere except the
`CronRun` summary line.

The 8 negations are a different matter. They are campaign-scoped, applied live, and unreviewable —
and four of the terms it graduates (`motorrad jacke herren`, `motorradjacke herren`,
`giubbotto moto uomo`, `giacca moto`) are **simultaneously on its negate list from a different
campaign**. That is correct funnel behaviour; nothing on any screen says so.

### 3.2 The phantoms are frozen legacy, not an ongoing bug

The study said `promote_to_exact` calls `createKeywordLocal()` *"with no existence check. Every run
that decides a term should be exact writes another row."* **`ads-create.service.ts:206` is an
existence check** — H.1, shipped 2026-06-23 in commit `a105edcd9` alongside H.2 (destinations) and
H.5 (ASIN routing).

Measured with the strict key (same ad group · same match type · same text, case-insensitive):

| | |
|---|---|
| duplicate groups | **14** *(not 47)* |
| redundant rows | **206** *(not 256)* |
| created **before** 2026-06-23 | **208** |
| created **after** 2026-06-23 | **0** |
| span | 2026-05-30 → 2026-06-23, and nothing since |

Positive keywords by creation month: **2026-05 = 1,361 · 06 = 215 · 07 = 550 · 08 = 3.**
**550 keywords were created in July and produced not one duplicate.** The guard holds.

Same for the ASINs. 54 positive KEYWORD rows carry ASIN text (`b0bmswm15b` ×25, `b0bms6zz4h` ×17,
`b0dvzs4t8g` ×12), each confined to one ad group, all created 2026-06-01 → 2026-06-23, **all 54
written by `automation:auto-harvest`** per the audit log — before H.5 routed ASIN queries to product
targets. None has an Amazon id. And the engine's `applyHarvest` call passes no `plan`, so
`graduateProduct !== true` and today's 3 product-graduation candidates are skipped entirely.

**That answers the study's open question 4.** The remediation is a one-time cleanup of 206 + 54
rows, not a code fix.

### 3.3 The real defect is the opposite of a phantom: a graduation that reports success and never reaches Amazon

`createKeywordLocal` pushes to Amazon only when the ad group, campaign and marketplace all carry
external ids, `resolveCtx` resolves, **and** the write gate allows. On any failure it still writes
the local row, still writes the audit row, and returns `externalTargetId: null`. `applyHarvest`
increments `keywordsGraduated++` regardless. The cron logs `grad=14/14`.

| `automation:auto-harvest` | |
|---|---|
| `create_keyword` audit rows, all time | **218** |
| carrying an Amazon id | **9** |
| **carrying none** | **209** |
| `lastSyncStatus` | SKIPPED 116 · never attempted 93 · SUCCESS 9 |
| recorded error | `local-only: no_external_id` |
| all three external ids present on the ad group/campaign | **209 of 209** |
| write gate **today** | `allowed: true, mode: live` in IT, DE, ES, FR |

**209 graduations reported success and do not exist on Amazon** — and they are essentially the
entire local-only population: 210 of the account's 2,129 positive keywords carry no Amazon id, and
209 of those 210 are the engine's. The gate is open now, so this is recoverable; the defect is that
nothing distinguished a write that landed from one that did not.

---

## 4 · What the account actually holds

### 4.1 The candidate set, today, in full

`previewHarvest({})` — the engine's own call, verbatim: **8 negatives · 14 graduations ·
2 product-negatives · 3 product-graduations**, over 60 days.

| query | orders | clicks | spend | CPC | already EXACT in source? | source |
|---|---|---|---|---|---|---|
| motorrad jacke herren | 14 | 433 | €543.71 | €1.26 | yes, €0.49 | GALE EXACT DE |
| motorrad jacke | 9 | 216 | €171.63 | €0.79 | yes, €0.78 | GALE BROAD DE |
| motorradjacke herren | 8 | 137 | €231.84 | €1.69 | yes, €0.50 | GALE EXACT DE |
| chaqueta moto hombre invierno | 4 | 130 | €77.81 | €0.60 | yes, €0.61 | ES_Phrase_3_Keywords |
| giacca moto estiva uomo | 3 | 210 | €115.39 | €0.55 | yes, €0.42 | GALE \| IT \| Exact \| Category |
| …9 more | | | | | **all yes** | |

**Genuinely new: 0 of 14.** Three of the 14 matches are local-only rows — the tab would be proposing
to create a keyword that already exists but never reached Amazon.

Negatives, same run: 8 terms, **€200.01** of wasted spend, 20–76 clicks each. The industry bar for
negating is *15–20 clicks with zero conversions*; all 8 clear it — but by accident. The threshold is
**spend ≥ €15**, and at this account's €1.69 max CPC that is nine clicks. A spend-only rule negates
expensive terms on statistically empty evidence; it happens not to today.

### 4.2 What one order down actually looks like

`previewHarvest({ minOrders: 1 })`: **88 graduations, of which 69 have no EXACT keyword in their
source ad group.**

| | |
|---|---|
| sales attributed | €6,044.11 |
| spend | €291.06 |
| blended ACoS | **5%** |

⚠️ **The earlier study's caveat applies unchanged and I am not restating the analysis: those are
single-order attributions and the values repeat** (€122.91 ×3, €105.00 ×3, €91.09 ×3 in my own top
ten) — one product at one price converting once per term. **That is intent, not a bankable €6,044.**
My figure differs from the study's 57 / €4,901 only because my denominator is *"no EXACT keyword in
the source ad group"* rather than *"no EXACT keyword anywhere"*.

What survives: **69 terms converted at least once, at 5% blended ACoS, and have no keyword where the
traffic came from.** Three of the top ten come from AUTO campaigns — the ones D6 makes invisible.
The first of them is **`xavia`**, our own brand term, 1 order, €0.17 spend — which study 7 measured
as negated in **16 ad groups** including Brand-Phrase and Brand-Broad. Harvest wants to promote it;
negation has already blocked it. Neither tab can see the other.

### 4.3 Did harvesting work? — the join exists, and here is the answer

`AdTarget.impressions/clicks/spendCents/salesCents/ordersCount` are **0 on all 5,213 rows** —
confirming the study's own §5 correction. The data is in `AmazonAdsDailyPerformance`
(`entityType='AD_TARGET'`, 8,000 rows, 2026-07-05 → 2026-08-10), joined by `localEntityId`.

**The join works: 6,356 of 8,000 rows (79%) resolve to a positive keyword; 443 distinct keywords
have a performance row.** So the "did the last batch work" view the industry does not ship is
buildable on today's data. Run against the whole population (all 2,129 keywords post-date the
2026-05-20 rebuild):

| | |
|---|---|
| took any impression after creation | **439 (21%)** |
| cohort spend / sales | €2,837.28 / €8,806.39 |
| cohort ACoS | **32%** |
| reached Amazon | 1,919 of 2,129 |

And the engine's own 218, isolated:

| | |
|---|---|
| reached Amazon | **9** |
| of those, took impressions | 6 |
| those 6 | **135,007 impressions · €167.00 spend · €913.06 sales · 11 orders → ACoS 18%** |

**Harvesting works in this account when the keyword actually gets there — 18% ACoS against a 32%
cohort average.** Nine keywords is thin evidence and I am not claiming more than it carries. But it
reframes the tab completely: the problem was never that harvesting does not pay. It is that 209 of
218 attempts never left the building, and nothing said so.

*(Caveat: performance rows begin 2026-07-05, so keywords created before that have no measurable
"after". The 9 that landed are within the window.)*

### 4.4 The queue: 225 pending is not 225 decisions

| | |
|---|---|
| `AdsRuleSuggestion` | 225 pending · **1 applied ever** |
| by action | bid_down 120 · lower_bid_to_floor 65 · **harvest_and_negate 18** · adjust_ad_budget 11 · **promote_to_exact 5** · add_negative_exact 5 · budget_apply 2 |
| pending age | min 0d · median 5d · **max 51d** |

The 23 harvest suggestions split cleanly by defect:

- **`promote_to_exact` — 5 rows, 5 distinct queries. Correct.** The dedupe key
  `(ruleId, entityId, proposedKey)` collapses 300 executions into one card per term.
- 🔴 **`harvest_and_negate` — 18 rows: 9 identical cards from `🌾 Auto harvest & negate` and 9
  identical cards from `📣 Daily automation digest`, all created the same day, all proposing the
  same account-wide sweep.** `proposedKey` is the bare action type, so the only thing separating them
  is `entityId` — and a sweep action has no entity. **The dedupe key cannot collapse an action whose
  scope is the whole account.**

Meanwhile `Auto match-type migration` produced **300 executions in 21 hours proposing 4 distinct
queries** — `chaqueta moto hombre invierno` ×83, `motorradjacke herren sommer` ×83,
`motorradjacke herren mit protektoren` ×83, `saponette moto` ×51. The suggestion table deduped them
correctly; the execution table absorbed 300 rows for 4 decisions. Its all-time record is
**6,101 DRY_RUN + 6,821 FAILED**; `Auto harvest & negate` is **5,322 DRY_RUN + 33,366 FAILED**, every
failure `DAILY_CAP_EXCEEDED` — the AUTO study's 693,704 refusals, seen from this tab.

### 4.5 The destination already exists, and it is orphaned

`ads-keyword-funnel.service.ts` (AME.15–17) implements exactly the SKAG/match-type funnel the
earlier study says we lack: `launchProductFunnel` builds Auto + Manual(Exact/Phrase/Broad),
`crossMatchNegations` makes every Exact keyword a negative-exact in Phrase/Broad/Auto, and
`getFunnelState` returns each keyword's journey across match types with a `negatedIn` count. Three
routes are live (`/advertising/funnel/{state,cross-match,launch}`), and there is a UI at
`/marketing/advertising/funnel`.

**It requires you to paste a raw product id, it is in another section, and nothing on the harvest
path links to it.** The structure to promote into exists too: 72 EXACT ad groups, 61 PHRASE, 58
BROAD, 40 AUTO across 161 manual and 39 auto campaigns. `applyHarvest` accepts a `destinations` map
and honours it (H.2) — and **only the wizard ever populates it**; the standalone rule and the cron
both pass `undefined`, which falls back to the source ad group *and* disables the H.3 isolation
negative, because isolation fires only when `destinations` moved the keyword elsewhere.

**Promoting into the source ad group and not negating the source are the same defect, not two.**

---

## 5 · Industry research — harvesting specifically

The existing competitor work (`2026-08-04-ads-market-research.md`, `-competitor-deep-dives.md`) and
the earlier HV study §7 cover the vendor landscape. This section covers **how a harvest rule is
actually configured and what the screens look like**, and extends rather than repeats.

### 5.1 The mechanism, stated once

Every tool in this category does the same three things: read the search-term report on a cadence,
apply thresholds, and write a keyword into a **destination you chose** while negating the term at
source. The differentiators are where the rule is anchored, how the bid is derived, and whether the
tool refuses to create something that already exists.

### 5.2 Scale Insights — the "Import Rule"

The closest published analogue to what this tab should be, and the one to steal from.

- The rule is attached to a **destination ad**, not to an account. You pick the destination, then
  declare a **Search Term Source**: `Sponsored Products` · `Sponsored Brands` · `Campaign` ·
  `Ad Group` · `Custom Group` (tagged ad groups). Choosing *Sponsored Products* resolves the
  destination's ASIN and harvests from every ad on that ASIN.
- **Bid = a percentage of the term's own average CPC.** Not a constant.
- Window: **"60 days of search term stats, skipping the past 2 days to account for data latency"**,
  configurable to 90.
- **Stacking**: several import rules with different parameters can point at one destination.
- And, added as a shipped feature: **"exclude a search term from being imported as a new keyword in
  an ad group if it already exists."**

**Steal:** *rule anchored to a destination*, *bid as a % of observed CPC*, and *the exists-check as
a first-class setting*. All three are the exact defects measured in §2–§4, and the third is
literally the fix for §4.1's "genuinely new: 0 of 14".
**Steal also:** the **2-day latency skip**. Our two engines disagree about this — B excludes the
provisional tail, A does not.
**Avoid:** five source modes on one control. This account has one ASIN family per campaign group;
Campaign and Ad Group cover it.

### 5.3 SellerApp — the "Keyword Harvester" rule

The most fully documented harvest form, and near-identical to the builder this repo already has:

> Name Your Workflow · Select Products · Manual/Automatic Targeting · Choose Advertised Campaigns
> *(requires 30 days performance data)* · **Mark Negative in Source** · conditions on
> **Orders · ACOS · Sales · ROAS · CPC** · destination restricted to *manual campaigns with keyword
> targeting* · Exact / Phrase / Broad · *Optional: Adjust Bids* · an exclusion field for words or
> phrases · timeframe 7 / 14 / 30 days · frequency Daily / Weekly / Bi-Weekly · **Review & Launch**.

**We already have every one of those fields.** `negateInSource`, `brandExclude`, the match-type
matrix, the frequency block, the campaign picker — all collected by `RuleBuilder.tsx` and all
present in the stored rule. **D5 is the finding: six of the eleven metrics and most of the rest are
discarded by the adapter on the way to execution.** The gap is not the form. It is the wire.

**Steal:** *the destination restricted to manual keyword-targeted campaigns.* A destination picker
that cannot offer an auto campaign makes the funnel loop structurally impossible.
**Avoid:** *7 days* as a timeframe option. The account produces 17 double-order terms in **sixty**
days; a 7-day harvest window here is a random-number generator.

### 5.4 Teikametrics · BidX · Adtomic · Perpetua

- **Teikametrics** — *Automated Keyword Actions*: parameters for **when a new keyword should be
  added, based on conversion volume, click volume, ACOS, or a combination**, behind one toggle
  ("Add New Keywords Automatically"). Harvest and negation are configured together.
- **BidX** — rule-based, popular with European sellers, harvesting and negation as a paired feature.
- **Helium 10 Adtomic** ($199/mo add-on) — surfaces converting search terms and moves them into
  sponsored-product campaigns; bulk actions across bids, budgets, negatives and targets from one
  selection.
- **Perpetua** — harvesting folded into goal-based optimisation; you declare target ROAS.

**Steal:** *one toggle over a named parameter set.* Teikametrics exposes three thresholds and one
switch. We expose eleven metrics, five of which work.
**Avoid:** Perpetua's fully-implicit model. This operator has consistently asked for control over
everything; a harvest that happens invisibly inside a ROAS goal is the opposite of the ask.

### 5.5 The practitioner consensus on thresholds

| decision | published bar | ours |
|---|---|---|
| graduate | **2+ orders, ACoS ≤ target, over 30 days**; stricter sources say 3+ orders and 5+ weekly searches | 2 orders / 60 days, **no ACoS condition survives** (D5) |
| negate | **15–20 clicks with zero conversions** | **spend ≥ €15** with zero orders — a proxy that varies 8× with CPC |
| cadence | weekly once a campaign is stable | every 15 minutes, bounded only by a daily cap |
| observation | *"a search term with 2 clicks in 7 days tells you nothing… you need at least 30 days, ideally 60"* | 60 (A) / 30 (B) |

**The 2-order bar is the industry's, and it is right for an account with volume.** This one produces
**17** double-order terms in sixty days, all already harvested. The published rule assumes you will
tune it; the tools that ship it expect a per-account value. Ours is a constant in a service file with
no UI.

### 5.6 The 2026 feature bar, and where we stand

| # | bar | us |
|---|---|---|
| 1 | A candidate table you can act on, row by row and in bulk | ❌ exists only on the retiring console, with an inert Apply (D3) |
| 2 | Threshold as a visible control, count updating as you move it | ❌ constant in `ads-harvest.service.ts` |
| 3 | Never propose a keyword that already exists | ❌ **0 of 14 are new** — and Scale Insights ships this |
| 4 | Bid derived from the term's own CPC | ⚠️ implemented in `applyHarvest`, overridden by every caller |
| 5 | A chosen destination, not the source ad group | ⚠️ implemented (H.2), populated only by the wizard |
| 6 | Promote and negate as one paired decision | ⚠️ coupled to (5) — no destination ⇒ no isolation negative |
| 7 | Harvest from auto campaigns | 🔴 **structurally impossible on the promote path** (D6) |
| 8 | Post-graduation performance | ❌ nobody ships it — **and we can, today** (§4.3) |
| 9 | Approvals that get worked | ❌ 225 pending, 1 applied, 9 duplicate cards per sweep |
| 10 | Export | ❌ on this tab (the console has one) |

**Where we would beat all of them:** none of these vendors can tell you what a harvested keyword did
*after* you harvested it, because none owns the write path and the performance table and the audit
log. We own all three. §4.3 is a query, not a feature.

---

## 6 · How this page should be

> **One question: which search terms have earned their own keyword — and did the last batch work?**

### 6.1 Boundaries with the overlapping sessions

`harvest_and_negate` genuinely belongs to two tabs. The split I want, stated so the pages cannot
drift:

| | **Keyword Harvest (8)** | **Negative Targeting (7)** |
|---|---|---|
| the unit | **a converting search term with no keyword** | **a term we are blocking** |
| owns | the candidate list, the graduation threshold, the destination, the promoted-keyword cohort | the negatives inventory, the whitelist audit, conflict detection, the retirement path |
| the paired action | shows promote **+ negate-at-source as one row**, and writes both | shows the same negative in its inventory the moment it exists |
| must **not** own | any negative not created by a promotion | any promotion |

**The seam:** a promotion's isolation negative is created here and **listed there**. If session 7's
retirement path removes it, this page's cohort row must say the keyword lost its isolation. That is
one shared fact — *"negative X exists because promotion Y happened"* — and neither page can hold it
alone. Today `applyHarvest` records no such link; §7 R4 states it as a requirement.

**Session 9 (Bid)** owns what a keyword bids *after* it exists. This page owns only the **opening**
bid, and its position is: derive it from the term's own CPC, show the number before writing, and
hand the keyword to Bid the moment it is created. **Session 10 (Automations)** owns the mode dial and
the ceiling; this page must not invent a second one — but §3.1 is a finding it needs, and I would
not build the harvest page's write path until `ads-auto-harvest` has a row there.

### 6.2 The page

**One flat grid, one row per candidate term.** No sub-tabs. Above it, one sentence and two numbers:

> **14 terms meet the threshold (2+ orders, 60 days). 0 are new** — all 14 already have an exact
> keyword where they came from. At **1+ order**, 69 terms have no keyword: €291 spent, 5% ACoS.
> Search-term data through **10 Aug (1 day old)**.

Columns, every one backed by data measured in §4:

| column | source | note |
|---|---|---|
| Search term | `AmazonAdsSearchTerm.query` | |
| Market · Source campaign › ad group | joined `Campaign`/`AdGroup` | with the campaign's `targetingType` |
| Impressions · Clicks · Spend · Orders · Sales · ACoS | 60-day rollup | |
| **Observed CPC** | `costCents / clicks` | the bid this term earns |
| **Status** | join to `AdTarget` | `new` · `already exact here` · `exact elsewhere` · **`local-only — never reached Amazon`** |
| **Destination** | chosen, defaulting to the manual EXACT ad group of the same product group | never the source |
| **Proposed bid** | observed CPC, clamped by `Campaign.min/maxBidCents`, shown clamped | |
| **Negate at source** | per row, defaulting on | promote and negate as one decision |
| Approve · Reject | per row and in bulk | |

Six laws:

1. **Never propose what already exists.** The single highest-value line of code on this page: join
   the candidate to `AdTarget` before rendering. It takes 14 rows to 0 and makes the count mean
   something.
2. **`local-only` is a status, not an absence.** 210 keywords exist here and not on Amazon. A row
   that says "already exact" when the keyword never reached Amazon is the same lie as an empty grid
   under a badge of 5.
3. **The threshold is a control, and the count moves when you move it.** 2 → 17 → 0 new; 1 → 88 →
   69 new. That is the whole argument for the page, and it must be legible in one drag.
4. **Promote and negate are one row.** They are one transaction in every mature tool and one
   `if (promotedElsewhere)` in our own service.
5. **The bid is derived and shown before it is written**, with its clamp visible.
6. **Nothing writes without a full sentence.** "Create 3 exact keywords in *DE_Exact_3_Keywords* at
   €0.46–€0.54, and add 3 negative-exacts in their source ad groups. Reversible from this page."

### 6.3 The second view: did the last batch work?

A cohort table, one row per harvested keyword, from `AmazonAdsDailyPerformance` (§4.3): harvested on
· destination · opening bid · current bid · impressions · clicks · spend · sales · orders · ACoS ·
**reached Amazon?**. Two summary numbers: *how many of the last N harvests took an impression*, and
*their blended ACoS against the account*. Today that reads **6 of 9 · 18% vs 32%** — and the row
that matters most is the 209 that say **no**.

**This is the thing no competitor ships, we can build it from a join we already have, and it is the
only honest way to choose the threshold in §6.2.**

### 6.4 Day one, with the data that exists this morning

- **14 candidate rows at the default threshold, all correctly marked "already exact here"** — the
  page's first act is to explain why its own count is zero. That is more useful than the empty grid.
- **69 rows at 1+ order**, with the single-order caveat printed on the view, not buried.
- **3 product-target candidates and 2 product-negatives** shown as their own kind — the ASIN path
  the engine currently skips.
- **8 negative candidates, €200.01**, with click counts beside spend so the 15–20-click bar is
  checkable.
- **The cohort view renders from 2026-07-05 onward** and says so; earlier keywords show
  `not measurable`.
- **Organic/rank columns do not appear.** Different tab, different session.

### 6.5 The URL contract (this page's own params only)

```
/marketing/ads/rules-automation/keyword-harvest
  ?view=candidates|harvested        default candidates
  &minOrders=<n>                    the graduation threshold          (default 2)
  &minSpend=<eur>                   the negation threshold            (default 15)
  &window=30|60|90                  lookback                          (default 60)
  &kind=graduate|negate|product     which candidate class             (default graduate)
  &status=all|new|exists|local-only default all
  &src=<externalAdGroupId>          restrict to one source ad group
  &q=<text>&sort=<column>&dir=asc|desc&page=<n>
  &term=<query>                     opens the per-term detail panel
```

`?minOrders=` is the one that matters: the whole finding of this study is that the threshold decides
whether the tab has content, so **a link must be able to carry it**. Absent params mean the default,
never a stored preference.

---

## 7 · Requirements on the shared layer

**Constraints, not solutions.** A twelfth pass reconciles all eleven pages.

**R1 · `_shared/tabs.tsx` needs a slug-aware `RULE_TAB_ACTION_TYPES`, and the fix is not cosmetic.**
Three tabs filter every rule out of themselves. For this page specifically:
`RulesAutomationClient.tsx:391` must send `'keyword-harvest'`, **and** the map's entry must include
`'keyword-harvesting'` because the builder writes the slug as the action type (§2 D1). Sessions 1 and
2 need `'keyword-tracker'` and `'sov'` on the identical reasoning — the KT page study records the
same requirement. `ruleTypes.ts` already holds slug→tab; the reconciliation should derive the map
from it rather than maintain a second copy. **I have not touched that file.**

**R2 · The badge and the grid must read from one expression.** They are two call sites of
`ruleBelongsToTab` with different arguments, on the same screen, disagreeing 5 vs 0. Whatever the
shared layer does, a tab's count and a tab's contents must be computed once.

**R3 · Market must survive navigation between the eleven pages, and must be linkable.** Restating
the KT page study's R1/R2 because this page needs it identically: `AdsMarketplaceProvider` already
exists and is mounted in `marketing/ads/layout.tsx`; `RulesAutomationClient.tsx:93` ignores it in
favour of local `useState`. **This page's additional constraint:** its candidates are naturally
market-scoped (IT 114 · DE 95 of the engine's own writes), and `previewHarvest` has **no marketplace
filter at all** — it groups `AmazonAdsSearchTerm` across every market. A market control on this page
must reach the query, not just the grid.

**R4 · A write made on one page must be visible on the others without a reload — and must carry its
provenance.** Concretely: a promotion here creates a keyword (Bid, session 9, must see it) *and* an
isolation negative (Negative Targeting, session 7, must list it, and its retirement path must be able
to remove it). `applyHarvest` records no link between the two. **The constraint on whatever
mechanism is chosen: a harvest write must be attributable to (rule or engine) × (candidate term) ×
(destination) × (paired negative), because session 7's retirement path cannot safely remove a
negative it cannot recognise as an isolation negative.** I am not proposing the mechanism.

**R5 · The shared layer must expose the engines as actors, not just the rules.** This page's headline
finding is that `ads-auto-harvest` runs on AUTO nightly with no ceiling, no scope and no row, while
the rules doing the same thing are held at PROPOSE. **This page cannot be honest without a way to
render the engine beside the rules**, and inventing a per-page engine list would be the eleventh
copy of it. This is the AUTO study's §7 Tier 0; recording it here as a hard dependency, not a
preference.

**R6 · The rule-list write controls must be wired or removed, section-wide.** Automation, Criteria,
Frequency and Delete are local-state-only on all five rule-type tabs (§2 D4), and the Delete modal
claims permanence. Not this page's call alone.

**R7 · A page-level "what will this do" confirm.** Every write on this page is structural — it
creates a keyword and a negative. The section already has the vocabulary (`ads-graduation`'s
reversible/structural split); this page needs the confirm surface to state which one it is, in the
same shape as every other write in the section.

**R8 · Grid capabilities needed from `AdsDataGrid`** (believed present; listed for confirmation):
per-column sort with explicit `sortValue`, client search, row selection with a selection bar,
`toolbarLeft`/`toolbarRight` slots, per-row action buttons, and **CSV export** — which the retiring
console offers on this exact data and this tab does not.

---

## 8 · Tiered plan

### Tier 0 — make the tab tell the truth · **hours, no new data, no new backend**

| # | change | unlocks |
|---|---|---|
| 0.1 | **Fix the `liveType` + map** (§2 D1, R1) | the 5 rules appear under their own badge |
| 0.2 | **Render the candidate list** from `previewHarvest` | 14 + 8 + 5 real rows where there is an empty grid |
| 0.3 | 🔴 **Join every candidate to `AdTarget` and label it** `new` / `already exact here` / `local-only` | the count stops being a lie; 0 of 14 is the finding |
| 0.4 | **Expose the threshold as a control** with a live count | 2 → 0 new, 1 → 69 new, in one drag |
| 0.5 | **Fix the builder Preview's response keys** (§2 D2) | the Preview button starts working |
| 0.6 | **Show click counts beside spend** on negative candidates | the 15–20-click bar becomes checkable |
| 0.7 | **Surface the engine**: "`ads-auto-harvest` ran 06:30, applied 14 graduations and 8 negations, live" | §3.1 stops being invisible |

### Tier 1 — fix the promote path · **days**

| # | change | why |
|---|---|---|
| 1.1 | 🔴 **Add `TARGETING_EXPRESSION` and `TARGETING_EXPRESSION_PREDEFINED`** to `buildSearchTermConvertingContexts` (§2 D6) | 2,854 rows and 26 orders of auto-campaign demand become harvestable. One array literal |
| 1.2 | 🔴 **Stop the adapter dropping conditions** (§2 D5) — map ACOS/ROAS/CVR/CTR/CPC/Impressions, or refuse the rule at save time | today an ACoS ceiling on a harvest rule is silently discarded |
| 1.3 | **Delete the `bidEur` overrides** at `automation-action-handlers.ts:904/906/1034` | CPC inheritance already exists; the constants defeat it. Overpays on 60–93% |
| 1.4 | **Give the standalone rule a `destinations` map** — and with it, the H.3 isolation negative | promoting into the source is a loop, and it is the same defect as not negating |
| 1.5 | **Record whether a write reached Amazon** — `createKeywordLocal` must not report success for a local-only row (§3.3) | 209 graduations reported success and do not exist |
| 1.6 | **Give `harvest_and_negate` a real `proposedKey`** (§4.4) | 18 duplicate cards collapse to 2 |
| 1.7 | **Reconcile the two engines' windows and latency skip** (§2.1) | one concept, two answers, five constants |
| 1.8 | **CSV export** | the console has it on this exact data |

### Tier 2 — the cohort view · **days, and it is the differentiator**

Build §4.3 / §6.3 from `AmazonAdsDailyPerformance`. The join is measured and works (79% resolution,
443 keywords). It answers *"does harvesting work here"* — today, **6 of 9 landed keywords took
impressions at 18% ACoS against a 32% cohort** — and it is the only defensible basis for choosing
the threshold. **No competitor ships this.**

### Tier 3 — one-time cleanup, once Tier 1.5 exists

206 duplicate rows and 54 ASIN-as-keyword rows, all created 2026-05-30 → 2026-06-23, all pre-guard,
all local-only (§3.2). Additionally: 209 engine graduations with no Amazon id, on campaigns whose
write gate is now open — **decide per row whether to push or delete**, which needs 1.5's
reached-Amazon flag first. Cleanup before that flag exists would delete rows nobody can distinguish
from real ones.

### Not this page's build, but blocking it

- **`ads-auto-harvest` needs a row, a mode and a ceiling on the Automations page** (R5). Until then
  the section's control plane cannot see the only harvest actor that writes.
- **A negatives retirement path** (study 7 Tier 1). This page creates negatives; without a way back,
  every promotion is a permanent decision.

---

## 9 · Open questions

1. 🔴 **`ads-auto-harvest` is on AUTO and applies 14 graduations + 8 negations nightly, unattended,
   while every rule with those actions is capped at PROPOSE because "none has a retirement path."**
   Do you want it stopped, moved to PROPOSE, or given a proper row on Automations and left running?
   I would move it to PROPOSE until the candidate list and the retirement path exist. **This is the
   one question in this study I would not proceed without.**
2. 🔴 **The threshold.** At 2 orders / 60 days: 17 candidates, **0 new**. At 1 order: 88 candidates,
   **69 new**, €291 spend, 5% blended ACoS on single-order attributions. I would set it to
   **1 order AND ≥ 10 clicks AND ACoS ≤ your target** — intent-based, not noise-based — and make it a
   visible control rather than a service constant. Your call on the ACoS number.
3. **Should the auto-campaign fix (1.1) land before or after the threshold decision?** It adds 2,854
   rows and 26 orders of previously-invisible demand to the promote path, which changes every count
   in question 2. I would land it first and re-measure.
4. **The 209 local-only graduations.** The write gate is open now. Push them to Amazon, or delete
   them as never-intended? They include the 54 ASIN rows, which should be deleted either way.
5. **Does the isolation negative belong to this page or to session 7's inventory?** My proposal is
   *created here, listed there, removable there* — which needs the provenance link in R4. Confirm
   that split before either page builds.
6. **`xavia` is the top 1-order harvest candidate and is negated in 16 ad groups (study 7).** Does
   this page surface that conflict, or refuse to propose a term the negation base already blocks? The
   two produce different pages, and it is the clearest case of sessions 7 and 8 needing one answer.

---

## Appendix A — scripts

| script | measures |
|---|---|
| `_hv-page-wiring.mts` | the three rule populations · every action type in the account · the two engines at thresholds 1/2/3 · match-type composition · candidate↔existing-keyword overlap · the destination structure · the suggestion queue by action and age · harvest-rule execution outputs · observed CPC vs the five constants · signal freshness |
| `_hv-page-forensics.mts` | duplicate groups dated against the H.1 guard · positive keywords by creation month · ASIN-as-keyword rows and their writers · EXACT-vs-negated overlap · `CronRun` records · **matchType × campaign targetingType** · what `promote_to_exact` proposed across 300 executions · tick cadence and all-time execution status |
| `_hv-page-engine.mts` | `getAutomationState()` · `previewHarvest({})` run verbatim with every candidate resolved against existing keywords · the minOrders=1 opportunity · the 23 harvest suggestions in full · write-gate bounds on the candidates' campaigns |
| `_hv-page-cohort.mts` | the `AmazonAdsDailyPerformance` ↔ `AdTarget` join and its resolution rate · the post-creation cohort · the engine's own cohort · the four dead `AdTarget` metric columns |
| `_hv-page-gate.mts` | why 209 of 218 engine graduations carry no Amazon id — which of the three gates closed, per campaign and marketplace, with the live write-gate verdict |

All read-only. Run from `apps/api` with
`NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/<name>`.

**Cited rather than re-measured:** the 51-rule census, the autonomy model and its ceiling, the
693,704 cap refusals and the 0.2% write attribution (`2026-08-11-auto-automations-study.md`); the
2,059 negatives, the whitelist contradictions and the missing retirement path
(`2026-08-11-neg-negative-targeting-study.md`); the bid distribution and the empty `minBidCents`
(`2026-08-11-bid-study.md`); SQP staleness and the unbid query universe
(`2026-08-11-kt-keyword-tracker-page.md`, `-sov-share-of-voice-study.md`); the single-order
attribution caveat (`2026-08-11-hv-keyword-harvest-study.md` §3).

**Re-measured because I doubted them:** the engine's idleness (§3.1 — reversed), the missing
existence check (§3.2 — the guard exists and holds), and the duplicate/ASIN counts (§3.2 — 14 groups
/ 206 rows, all pre-guard).

## Appendix B — sources

- [Scale Insights — What is the import rule?](https://docs.scaleinsights.com/docs/what-is-the-import-rule) ·
  [How to transit to automation](https://docs.scaleinsights.com/docs/how-to-transit-to-automation) ·
  [Features](https://scaleinsights.com/features)
- [SellerApp — Keyword Harvester Rule: a step-by-step guide](https://www.sellerapp.com/help/article/keyword-harvester-guide-to-discover-high-impact-search-terms/)
- [Pilothouse — Amazon keyword harvesting: the complete guide to search term graduation](https://www.pilothouse.co/post/amazon-keyword-harvesting-the-complete-guide-to-search-term-graduation)
- [SellerStack — Keyword harvesting in Amazon PPC: how it works](https://www.sellerstack.ai/glossary/keyword-harvesting) ·
  [SellerView — What is keyword harvesting?](https://sellerview.ai/blog/what-is-keyword-harvesting-amazon-sellers)
- [Teikametrics — Automated keyword actions](https://www.teikametrics.com/blog/automated-keyword-actions-with-teikametrics/) *(404 at time of writing; content via search summary)* ·
  [AiHello — 18 best Amazon PPC software and tools 2026](https://www.aihello.com/resources/blog/amazon-ppc-software-tools/) (BidX, Teikametrics harvesting/negation)
- [Helium 10 Adtomic review 2026 — RevenueGeeks](https://revenuegeeks.com/helium10-adtomic/) ·
  [Adtomic — Profit Hawk](https://www.profithawk.io/software-tools/adtomic-by-helium-10/)
- [Marketplaice — Amazon keyword harvesting: the complete guide 2026](https://marketplaice.io/en/blog/amazon-keyword-harvesting-anleitung) ·
  [SellerSprite — How to use Amazon PPC in 2026](https://www.sellersprite.com/en/blog/amazon-ppc-guide-2026-AI-automation)
- [Adbrew — How to use the Amazon search terms report](https://adbrew.io/blog/amazon-search-terms-report) ·
  [Feedvisor — Amazon search terms report 2026](https://feedvisor.com/university/creating-amazon-search-terms-report/)

---

# HV.0 — armed down

**Landed `42af69317`, 2026-08-12.** `apps/api` only, revertable without touching the page.

## What changed

`ads-auto-harvest.service.ts` — four lines plus a header comment. `forceDry` now starts from an
env flag:

```diff
-  const forceDry = state.autonomy === 'SUGGEST'
+  const armed = envEnabled(ARMED_FLAG)
+  const forceDry = !armed || state.autonomy === 'SUGGEST'
```

**The flag is `NEXUS_ADS_AUTO_HARVEST_ARMED`.** Unset (the default, and its current state in
Railway) = propose-only. It is named into the existing `NEXUS_ADS_AUTO_HARVEST_*` family —
`…_SCHEDULE` is read by `ads-sync.job.ts:719` and `ads-foresight.service.ts:108` — and it has
exactly one reader, `envEnabled(ARMED_FLAG)`, on one greppable line. That check was deliberate:
`NEXUS_ENABLE_SQP_INGEST_CRON` still sits in Railway with **no code reading it**, where it reads as
proof that feed is deliberately on. A flag nobody reads is worse than no flag.

Deliberately **not** touched: `getAutomationState()`, the global `autonomy` value (`ad-rank-defend`,
`budget-manager-cron` and every other engine read it), and the cron registration. The job keeps
running and keeps reporting what it *would* do — that output is what HV.1 renders and what HV.7
turns into a queue.

## The evidence

```
getAutomationState() → { autonomy: "AUTO", halted: false, effectivelyStopped: false }

ads-auto-harvest — 72 runs, nightly 06:30, cron-registry.ts:307
  2026-08-11T06:30 SUCCESS  neg=8/8 grad=14/14 dryRun=false
  2026-08-10T06:30 SUCCESS  neg=9/9 grad=14/14 dryRun=false
  …six more, identical
```

Its only gate was the **global** automation state — a switch on another page. It is `AUTO`, so
`applyHarvest()` ran for real every night with no per-actor ceiling, no scope, no proposal, no
approval and no row on any surface in the product.

Beside that, `ads-graduation.ts:47-67` lists **both** actions this engine performs among
`STRUCTURAL_ACTIONS`:

> *"Actions that CREATE or DESTROY something. Each needs a retirement path designed alongside it,
> and none has one yet, so none may run unattended."*

Every **rule** carrying those actions is capped at PROPOSE. The engine doing the identical thing
was capped at nothing. **That asymmetry is the change.**

## 🔴 A fourth correction to the study — the 8 negations are not live writes either

§3.1 says: *"The 8 negations are real, live, campaign-scoped writes with no proposal, no approval,
and no retirement path."* **The first three words are wrong.** The negation path is as much a no-op
as the graduation path, and for the same reason.

| measured 2026-08-12 (`_hv-1-candidates.mts` §6) | |
|---|---|
| `AdvertisingActionLog` rows written by `automation:auto-harvest`, all time | 240 |
| written in the **last 30 days** | **6**, across 5 days |
| nights in that period reporting `neg=8/8 grad=14/14` | ~12 |
| the 8 negative candidates that **already** carry a campaign-scope negative | **8 of 8** |

`createNegative` is idempotent, so `negativesAdded++` counts a no-op as an add — exactly as
`keywordsGraduated++` does for the graduations. **`neg=8/8 grad=14/14` is a count of candidates
processed, not of writes made,** and the cron line has been overstating this engine's activity by
roughly two orders of magnitude.

**The wrong version, recorded because it was the more plausible reading:** the study inferred live
writes from `dryRun=false` plus a non-zero `negativesAdded`, which is what the result object
appears to mean. What survives the correction is the shape rather than the volume — an unattended
structural write path with no ceiling that fires whenever a genuinely new term crosses the
threshold, about one or two rows a week, leaving no trace except a `CronRun` line that overstates
it. HV.0 is still right; its urgency was lower than the study thought and its justification is
structural rather than volumetric.

## The consequence, stated

**An engine on PROPOSE cannot queue a suggestion.** `AdsRuleSuggestion` requires a `ruleId` and
`ads-auto-harvest` has none, so propose-only means **notify-only** until HV.7 gives engines a queue
row. In practice automatic harvesting stops. That is intended and accepted: the graduations were
all no-ops, and the negations are the write path we are deliberately pausing. **HV.7 is what ends
this state**, and its stub records that dependency.

## Flagged, not fixed

The `forceDry` branch's `notifyAutomation` links to `/marketing/trading-desk/automation`, a legacy
path. Another session owns that surface. The branch's *body* was updated, because two different
reasons now reach it and they are not the same fact: a notification saying "SUGGEST mode" while the
account is on AUTO would send the reader to the wrong control.

## Verification

`_hv-page-engine.mts` after the next 06:30 run: the cron line must read **`dryRun=true`**, and
`AdvertisingActionLog` must gain **no** new `automation:auto-harvest` rows. The 2026-08-12 06:30
run is the first one that can show it.

---

# HV.1 — built

**Landed `b32262393` (API) + `46cba4968` (web), 2026-08-12.** Split into two commits deliberately:
a commit is two independent deploys, and the UI must ship after the route. Verified with the
401-vs-404 trick before the web commit — unauthenticated `GET /api/advertising/keyword-harvest`
returned **401**, not 404.

## What shipped

- `…/rules-automation/keyword-harvest/` — `page.tsx`, `KeywordHarvestClient.tsx`,
  `HarvestScopeBar.tsx`, `slot-contract.ts`, and seven stub sections each returning `null`.
- `GET /advertising/keyword-harvest` in **`advertising-intel.routes.ts`** (not the 600 KB file),
  backed by a new `keyword-harvest.service.ts`. `ads-harvest.service.ts` is neither called nor
  modified — it has five live callers including the nightly cron.
- `_shared/tabs.tsx`: `keyword-harvest` → `routed: true` + subtitle, and the D1 map fix.
- `RulesAutomationClient.tsx`: the `keyword-harvest` branch dropped.
- `next.config.js`: the `?tab=keyword-harvest` redirect.
- `rules-automation.css`: `h10-hv-*`, appended at EOF.

## The endpoint's response shape

```
{ scope:      { market, boundBy, line|portfolio|campaign|adGroup: {id,name}|null,
                resolved: { campaigns, campaignsInMarket, campaignsWithTerms, adGroups },
                adGroupOptions: [{ id, name, campaignName, terms }] },
  window:     { days, since, until },
  thresholds: { minOrders, minSpendEur },
  freshness:  { newestTermDate, ageDays, newestRowWrittenAt, rows },
  census:     { candidates, byKind, newByKind, new, alreadyExactHere, exactElsewhere, localOnly,
                negatedAlready, exactMatchedOnly,
                atOneOrder: { candidates, withoutKeywordInSource, noExactMatch, spendCents,
                              salesCents, acosPct, singleOrder, repeatedValues[] },
                negativeCandidates: { count, spendCents },
                productCandidates: { graduations, negatives } },
  facets:     { status[], kind[], market[], targetingType[], matchedVia[] },
  rows: HarvestRow[], total, truncated }

HarvestRow = { id, term, termKey, market, kind,
  campaign: { id, name, externalId, targetingType, status }, adGroup: { id, name, externalId },
  metrics: { impressions, clicks, spendCents, orders, salesCents,
             acosPct: number|null, cpcCents: number|null },
  matchedVia: [{ matchType, orders }], exactMatchedOnly,
  status, existing: { rows, atAmazon, bidCents, adGroups } | null,
  negatedIn: { rows, blocking, campaignLevel } }
```

`acosPct` and `cpcCents` are `number | null` in the contract rather than `number`, deliberately:
**a blank is not a zero**, and a section that defaults the null to 0 has invented a measurement.
The null also sorts below every real value rather than as a zero — otherwise "not measured" would
rank as the best ACoS on the page.

## The four candidate states

Resolved in one order that cannot lie. `local-only` is decided **before** `already-exact-here`,
because the two are the same row set distinguished only by `externalTargetId`.

| status | meaning | at the default threshold |
|---|---|---|
| `new` | no positive keyword for this text anywhere | **1** (a product target) |
| `already-exact-here` | an EXACT `AdTarget` exists in the **source** ad group and reached Amazon | **15** |
| `exact-elsewhere` | exists as EXACT in a different ad group | **0** |
| `local-only` | a row exists in the source ad group and **none** reached Amazon | **1** |

Verified partitioning the set: 1 + 15 + 0 + 1 = 17 = `candidates`.

`negatedIn` is counted server-side from `AdTarget` where **`isNegative = true`** — never
`expressionType`, which is positive-sounding on 1,068 negatives and is being rewritten by an
ingest. It carries `rows`, `blocking` (target ENABLED ∧ campaign ENABLED ∧ confirmed at Amazon)
and `campaignLevel`.

## The four repairs

1. **The auto-targeting blind spot.** This read filters on **no match type at all**. Re-measured:
   `TARGETING_EXPRESSION_PREDEFINED` 2,588 rows / 19 orders, `TARGETING_EXPRESSION` 210 / 7 —
   2,798 rows and 26 orders invisible to the rule path. **`matchType = NULL`: zero rows**, so the
   branch `advertising-rule-evaluator.job.ts:685` explains as "auto-targeting, no match type"
   matches nothing at all. The rule-path fix is HV.8.1.
2. **The existence join** — the four states above.
3. **A marketplace filter.** `AmazonAdsSearchTerm.marketplace` is populated on all 10,826 rows
   (IT 6,171 · DE 2,681 · ES 1,143 · FR 831), so scope reaches the query.
4. **The scope filter** — resolved server-side into the **external** ids the search-term table
   holds. Verified: `market=DE` with an IT campaign returns **0 rows** rather than overriding the
   market picker.

## What the seven stubs own

| file | owns | must not own |
|---|---|---|
| `HvThresholds` | HV.2 — the three thresholds as live controls; per-scope values in `AdsHarvestPolicy` (D3) | the mode dial or any ceiling (§11 C1–C3) |
| `HvDestination` | HV.3 — the destination resolver + picker; the match-type matrix | the write itself |
| `HvPromote` | HV.4 — promote **and** negate-at-source as one transaction; the five bid constants; the visible clamp | the negatives inventory or retirement path |
| `HvCohort` | HV.5 — post-graduation performance from `AmazonAdsDailyPerformance` | the five dead `AdTarget` metric columns |
| `HvActors` | HV.6 — the 5 rules + `ads-auto-harvest` + you, as one actor list | the mode dial, ceiling, conflict detector |
| `HvQueue` | HV.7 — harvest rows filtered out of the section's **one** inbox (§11 C10) | its own inbox |
| `HvRepairs` | HV.8 — a marker, not a UI section: seven backend repairs on files HV.1 was forbidden to touch | anything that renders |

The write-action seam (`HvWriteActions` / `NO_WRITE_ACTIONS`) is declared on day one and passed
`null`, so HV.4 and HV.7 ship without reopening the client. There is deliberately no "approve"
separate from "promote": a promotion writes a keyword **and** its isolation negative, and a
contract offering them separately would let a later session ship half a funnel.

## 🔴 Corrections to the study found while building

### C1 · "0 of 14 are new" is about one third tautology

`previewHarvest` has **no match-type filter** — repair 1 keeps that deliberately — but it has a
consequence nobody had measured: **a term that matched an EXACT keyword is offered as a candidate
to create that same EXACT keyword.** Measured with `_hv-1-matchtype.mts`:

| at the default threshold | |
|---|---|
| every order came from an EXACT match | **5 of 14** — "already exact here" is the INPUT, not a finding |
| at least one EXACT-matched order | 6 of 14 |
| **no EXACT match at all** | **8 of 14** — PHRASE 5 · BROAD 2 · auto 1. Genuine discoveries |

At 1+ order it is **66 of the 69** with no keyword in source. So the discovery set is far larger
than the candidate count suggests, and the page carries a **Matched via** column — one more than
the brief's column list — because without it the census reads as a finding about the account when
for some rows it is the definition of the input.

### C2 · The count is 17, not 14

`previewHarvest` returns `graduations` and `productGraduations` as two lists; this grid shows one
**Kind** column, so `candidates` is their sum: **14 keyword + 3 product**. And the single `new`
candidate is a **product target**, which makes *"0 of 14 are new"* true of the search terms and
false of the grid. The census carries `byKind` and `newByKind` so the sentence can state both; a
census reporting only one of those numbers would be wrong whichever it picked.

### C3 · The signal is 2 days old, not 1 — and the age must be computed

`AmazonAdsSearchTerm` max date is still **2026-08-10** on 2026-08-12; the newest row was *written*
at 2026-08-11T01:52, and `ads-v1-export-ingest` has returned `ingested=0 rows=0` on every run
since. The study's "1 day old" was true for one morning. The page computes `ageDays` and never
states a constant. (The claim that this is still the freshest signal in the section holds — SQP is
16+ days behind.)

### C4 · `_hv-page-wiring.mts` §8 crashes

`prisma.cronRun.findMany({ where: { name } })` — the field is `jobName`, and `result`/`durationMs`
do not exist on the model. The script exits 1 before printing the engine records. Sections 1–7 run
and are unaffected; §8's content is covered by `_hv-page-forensics.mts` §4. Recorded rather than
fixed — it is the previous session's script.

### C5 · Numbers that drifted between 2026-08-11 and 2026-08-12

All in the same direction and none changing a conclusion: negative candidates **€197.28**
(was €200.01) · at 1+ order **86** candidates / **69** without a keyword in source / **€292.42**
spend (was 88 / 69 / €291.06). The duplicate-group forensics now split 208 before / **12** after
the H.1 guard rather than 208 / 0, with the latest still **2026-06-23** — a boundary effect on the
guard's own ship date, not new duplicates. 3 ASIN-as-keyword rows now date after H.5 (was 0), same
boundary.

## What was measured

`_hv-1-endpoint.mts` calls `getKeywordHarvest()` exactly as the route does and prints every value
the page renders, asserts the four states partition the candidate set, asserts every null-CPC row
has zero clicks and every null-ACoS row has zero sales, and walks the scope through all four
markets plus campaign and ad-group grains. **That is the script for every number on this page.**

`_hv-1-candidates.mts` measures freshness, the scope join (all 64 external campaign ids and all 64
ad-group ids in the window resolve to local rows), the four states at thresholds 1/2/3, the
`negatedIn` flag per candidate, the blind spot, and the engine's claimed-vs-written record.
`_hv-1-matchtype.mts` measures C1.

**The threshold, which is the argument for the page:**

| | candidates | new | already-exact-here | exact-elsewhere | local-only |
|---|---|---|---|---|---|
| minOrders 1 | 92 | 58 | 20 | 12 | 2 |
| **minOrders 2** *(default)* | **17** | **1** | **15** | **0** | **1** |
| minOrders 3 | 8 | 0 | 8 | 0 | 0 |
| window 30d | 9 | 1 | | | |
| window 90d | 25 | 2 | | | |

**D5, on the rows:** 9 of 17 candidates are already negated somewhere — `giacca moto` in **72 rows,
16 of them live and confirmed at Amazon**. The engine graduates terms its own negatives block.
Stated as a read-only flag; refusing to propose them is HV.4.

**The attribution caveat, as measured numbers rather than restated analysis:** 68 of the 69 are
single-order attributions and the sale values repeat — **€86.07 across 18 terms, €83.19 across 17,
€91.09 across 12**. One product at one price converting once per term. The view says so.

## Reach, stated honestly

The scope sentence says *"64 of 220 campaigns have search-term data in the last 60d"*, not
"220 campaigns". Most campaigns have no search-term data at all in the window, and a scope claiming
220 over a grid built from 64 is the denominator bug this section has already shipped twice
(§11 C5: *a guard must share the denominator of the value it guards*).

## The D1 fix, which is what kept this tab empty for its entire life

Two changes, not one:

1. `RulesAutomationClient.tsx` passed `liveType="keyword-harvesting"` — an action type, looked up
   in a map keyed by tab. `undefined` → `false` for all 51 rules → **0 rows**, under a badge on the
   same screen that said **5**. The interim `RuleListTab` on the new page is passed
   `liveType="keyword-harvest"`, the tab key.
2. `RULE_TAB_ACTION_TYPES` now also matches each tab's **builder slug**, because
   `RuleBuilder.tsx:499` writes `actions: [{ type: slug }]`. Zero rules carry a builder slug today
   — which is exactly why it would have survived: nothing on screen is wrong until someone uses the
   builder, and then the first rule they create is invisible on the tab they created it from.

Derived from `ruleTypes.ts` (which already held `slug → tab` and which nothing read) rather than
hand-adding a string. **Scoped to tabs that already have an entry** — `keyword-tracker`,
`share-of-voice`, `dayparting` and `budget-schedules` have none, and giving them one changes what
those tabs count, which belongs to their sessions.

## 🔴 An incident, recorded because it is the locks doc's §5 trap firing outward

`6d50a6783` (KT.2) was pushed carrying **this page's import line** for
`keyword-harvest.service.js` while the service file itself was still untracked. So `origin/main`
imported a module that did not exist, and the API build from `origin/main` could not have
succeeded. The pre-push hook builds the working **tree**, where the file existed, so it passed.

Repaired by `b32262393`, which is the commit that adds the service — nothing had to be reverted,
the import simply arrived one commit early. Two sessions were editing `advertising-intel.routes.ts`
concurrently with both claims live; the co-claim was recorded in the locks doc §4 before either
commit, and the check that would have caught it — `git diff` the shared file and confirm every hunk
is yours — is already written there. **It needs to run on `git add` as well as on `git commit
--only`.**

## Open, and deliberately not built here

The URL contract carries `?sort=`/`?dir=`, and `AdsDataGrid` **reads them and never writes them
back** — KT's open defect, shared by nine pages. The page therefore does not claim sorting is
linkable and the grid was not touched. `?minOrders=`, `?minSpend=` and `?window=` are read and
carried but have no controls until HV.2.

---

# HV.1c — HV.0 verified at runtime

**Measured 2026-08-12 09:55 UTC with `apps/api/scripts/_hv-1c-verify.mts`.** Read-only.

## The cron line

```
2026-08-12T06:30  SUCCESS  neg=0/8 grad=0/14 dryRun=true      ← first run after HV.0
2026-08-11T06:30  SUCCESS  neg=8/8 grad=14/14 dryRun=false
2026-08-10T06:30  SUCCESS  neg=9/9 grad=14/14 dryRun=false
…six more, identical
```

**`dryRun=true`, and the applied counts fell to `0/8` and `0/14`** — it still finds 8 negative and
14 graduation candidates and now applies none of them. Exactly the intended shape: the engine keeps
reporting what it *would* do, which is what HV.1 renders and what HV.7 will turn into a queue.

## The half that actually matters

| | |
|---|---|
| `AdvertisingActionLog` rows by `automation:auto-harvest`, all time | 240 |
| **created since the HV.0 deploy boundary (2026-08-12T01:00Z)** | **0** |
| `AdTarget` rows created since that boundary — negative / positive | **0 / 0** |
| `NEXUS_ADS_AUTO_HARVEST_ARMED` | **(unset)** → `envEnabled(…)` = `false` |
| `previewHarvest({})` | negatives 8 · graduations 14 · productNegatives 2 · productGraduations 3 — unchanged |

The audit log is the only place a write is visible, because the cron summary counts candidates
processed rather than writes made (the HV.0 correction). It shows nothing. **The engine is disarmed
and still fully sighted.**

## The script that was crashing

`_hv-page-wiring.mts` §8 is fixed: `CronRun` has **`jobName`**, not `name`, and carries
**`outputSummary`** (a string) rather than `result`/`durationMs`, neither of which exists on the
model. The script exited 1 before printing anything in §8; sections 1–7 were unaffected, and
`_hv-page-forensics.mts` §4 always had it right — which is why the data was reachable and nobody
noticed this block had never once run.

The job list in that block was also wrong in a way that outlived the crash — see HV.2a.

---

# HV.2a — the ingest is not stalled, and HV.1 named the wrong job

**Measured 2026-08-12 with `apps/api/scripts/_hv-2a-ingest.mts`.** Read-only. **No fix applied, and
none is needed.**

## 🔴 Correction 5 — this one is HV.1's own, not the study's

HV.1 recorded, in three places, that *"`ads-v1-export-ingest` has returned `ingested=0 rows=0` on
every run since 2026-08-11T01:52"* and offered it as the explanation for `AmazonAdsSearchTerm` being
two days old. **Both halves are wrong.**

1. **That job does not carry search terms.** `ads-v1-export-ingest` (`ads-sync.job.ts:604`) drains
   `AmazonAdsExportJob` — the v1 unified export of **structure** data: campaigns, ad groups,
   targets, ads. The search-term chain is a different pipeline:
   **`ads-report-create-st` → `ads-report-poll` → `ads-report-ingest`.**
2. **`rows=0` there means "caught up", not "broken".** Jobs matching that cron's own `WHERE`
   (COMPLETED · url present · `rowsIngested=0` · `fileSize ≥ 100` · url unexpired): **0**. There was
   nothing to ingest. It also reported `ingested=4 rows=428` at 08:22 the same morning, so it was
   not even continuously zero.

**The wrong version, kept:** the reasoning was "the freshest ads feed is stale and the only ads
ingest cron I can see is returning zero, so that cron is the cause." Both observations were true;
the join between them was invented. The lesson is the one this programme keeps relearning —
*grep for the reader.* I matched a job by its plausible name instead of by what it writes.

## There is no stall. The lag is a metronome.

Per calendar date, when its rows were **first** written (`MIN(createdAt) − date`), over 27 dates:

| | |
|---|---|
| min | **1.1 d** |
| median | **1.1 d** |
| p90 | **1.1 d** |
| max | **1.1 d** |

Zero variance. `ads-report-create-st` runs at 01:30 UTC and requests `yesterday()`; the rows land at
01:52–02:22 UTC. Every date, every day.

**HV.1's "2 days old" was the trough of a daily sawtooth, not a stall.** HV.1 measured at ~00:20 UTC
on 2026-08-12 — before that morning's 01:52 delivery — so `MAX(date)` was 2026-08-10 and the floored
age read 2. Ninety minutes later it was 1. All three ads feeds are currently at `MAX(date) =
2026-08-11`, one day old:

| feed | rows | MAX(date) | newest row written |
|---|---|---|---|
| `AmazonAdsSearchTerm` | 11,026 | 2026-08-11 | 2026-08-12T01:52 |
| `AmazonAdsDailyPerformance` | 42,597 | 2026-08-11 | 2026-08-12T02:23 |
| `AmazonAdsPlacementReport` | 4,699 | 2026-08-11 | 2026-08-12T02:07 |

**Consequence for the page:** the age line is already computed rather than constant, so it was right
on the day and is right now. What it must not do is call the number a problem. One day is this
feed's floor and it hits it every single day.

## 🔴 But there IS a real defect here, and it is bigger than the one HV.1 imagined

`ads-report-create-st` requests **`yesterday()` only, once, and never re-requests a date.**
`orders7d` and `sales7dCents` are **seven-day attribution windows** — and we snapshot them after
about **one** day, then freeze them forever.

Conversion rate by how old the data is when we look at it:

| data age | days | clicks | orders | CVR |
|---|---|---|---|---|
| **0–2 days** | 2 | 479 | **1** | **0.21%** |
| 3–7 days | 5 | 1,065 | 14 | 1.31% |
| 8–14 days | 7 | 752 | 19 | **2.53%** |
| 15–30 days | 13 | 2,077 | 35 | 1.69% |

2026-08-11 carries **236 clicks and 0 orders**. That is not what happened; it is what Amazon could
attribute within a day. **The freshest days are under-counted by roughly an order of magnitude, and
because the date is never re-requested the number is never corrected.**

This is a genuine data-loss defect and it is **not mine to fix** — it lives in
`runSearchTermReportCycle` / `ads-report-create-st`, which §5 of this session's brief puts
off-limits, and any repair costs Amazon report quota on a feed four pages depend on.

**The smallest change that would fix it, for you to decide, not for me to apply:** have
`ads-report-create-st` request a trailing window (`yesterday() − 7d … yesterday()`) instead of a
single day, and let the existing upsert overwrite the stale rows. That is one call-site change to
the `{ startDate, endDate }` it already accepts, and it multiplies the daily report volume by ~7 for
this one report type. **I have not touched it.**

*(Unrelated but visible in the same registry, and pointed at whoever owns SQP: `AmazonReportRun`
holds **118 FATAL** Brand-Analytics SQP runs in the last 7 days and 15 reports requested >6 h ago
that never completed. That is the 16-day-stale feed Keyword Tracker and Share of Voice read. Not
this page's, recorded only so it is not lost.)*

## What this changes for HV.2

- **Do not add a latency skip.** Measured: skipping 0/1/2/3 days leaves candidates at
  **17/17/17/17** (at 2+ orders) and **92/92/92/91** (at 1+). It changes nothing, because the
  freshest days are exactly the ones under-attribution keeps out of the candidate set anyway. It
  would cost real data and buy no measurable accuracy. **This contradicts the session brief's
  expectation that "a latency skip is probably right".**
- The window default stays **60 days**, and the reconciliation of the two engines' windows stays
  HV.8's.
