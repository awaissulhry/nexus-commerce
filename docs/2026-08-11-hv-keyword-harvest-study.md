# HV — Keyword Harvest: study 8 of 11

*Rules & Automation, tab-by-tab, right to left.
[1 · Keyword Tracker](2026-08-11-kt-keyword-tracker-study.md) · [2 · Share of Voice](2026-08-11-sov-share-of-voice-study.md) · [3 · Placement](2026-08-11-plc-placement-study.md) · [4 · Budget Schedules](2026-08-11-bs-budget-schedules-study.md) · [5 · Rank & Dayparting](2026-08-11-rd-rank-dayparting-study.md) · [6 · Budget](2026-08-11-bud-budget-study.md) · [7 · Negative Targeting](2026-08-11-neg-negative-targeting-study.md).*
**Read-only study. Nothing was changed. No code was written.**

Measured on production 2026-08-11 with `apps/api/scripts/_hv-study{,2,3}.mts`.

---

## 0 · The one-sentence version

The tab shows **nothing** (a key/prop mismatch), its five rules have created **zero** keywords, and
its harvest engine reports **nothing left to harvest** — because the default threshold of **2 orders
in 60 days** is met by only 16 terms in the entire account, while **57 converting terms with no
exact keyword** sit just below it.

---

## 1 · What the tab is, and every wire behind it

```
?tab=keyword-harvest
└── RulesAutomationClient.tsx:387  <RuleListTab liveType="keyword-harvesting" />
    badge  ← RULE_TAB_ACTION_TYPES['keyword-harvest'] = ['promote_to_exact','harvest_and_negate']
    grid   ← ruleBelongsToTab(actions, 'keyword-harvesting')  ← NOT A KEY OF THAT MAP

Builder   builder/keyword-harvesting → _shared/RuleBuilder.tsx
Service   ads-harvest.service.ts — previewHarvest() / applyHarvest()
Handlers  automation-action-handlers.ts:840  harvest_and_negate
                                      :1031  promote_to_exact  → createKeywordLocal()
Engine    ads-auto-harvest cron — 71 runs, last 2026-08-10 06:30
Sibling   _shared/HarvestRules.tsx · ads-coverage-engine (5 runs)
```

🔴 **The badge says 5. The grid shows 0.** `ruleBelongsToTab` looks up `'keyword-harvesting'` in a
map whose key is `'keyword-harvest'`, gets `undefined`, and filters every rule out. **This tab has
displayed an empty grid under a non-zero count for its entire life.** *(Same bug class as Share of
Voice's `liveType="sov"`, study 2.)*

### The harvest logic

`previewHarvest()` reads `AmazonAdsSearchTerm` over a window and splits it two ways:

| candidate | rule | default |
|---|---|---|
| **negative** | spent ≥ `minSpendCents` with **0 orders** | €15 |
| **graduate** | **orders ≥ `minOrders`** | **2** |
| window | | 60 days |

ASIN-shaped queries (`/^b0[a-z0-9]{8}$/`) are routed to PRODUCT targets rather than keywords — a
thoughtful detail.

---

## 2 · The five rules — all proposing, none creating

| rule | on | level | trigger | executions |
|---|---|---|---|---|
| Auto match-type migration (broad → exact) | ✓ | PROPOSE | SEARCH_TERM_CONVERTING | 5,917 |
| Auto harvest & negate | ✓ | PROPOSE | SCHEDULE | 4,908 |
| Daily automation digest | ✓ | PROPOSE | SCHEDULE | 4,833 |
| Harvest & negate search terms | ✗ | PROPOSE | SCHEDULE | 128 |
| Exact match discovery engine | ✗ | PROPOSE | SCHEDULE | 85 |

**696 `create_keyword` writes in 60 days — none from a rule execution:**

| writer | writes |
|---|---|
| `user:anonymous` | **548** |
| `automation:auto-harvest` | 138 |
| `htest` | 10 |
| **from a rule execution** | **0** |

Same shape as study 7: the tab proposes, the engine and the operator act.

---

## 3 · 🔴 The threshold is the whole story

At the service's own default the harvest is finished:

| min orders (60d) | converting terms | already EXACT | **unharvested** | unharvested sales |
|---|---|---|---|---|
| ≥ 5 | 3 | 3 | **0** | — |
| ≥ 3 | 7 | 7 | **0** | — |
| **≥ 2** *(the default)* | **16** | **16** | **0** | — |
| **≥ 1** | **81** | 24 | **57** | **€4,901.46** |

**Only 16 terms in the whole account reach 2 orders in 60 days.** All 16 are already exact keywords —
so the engine correctly reports nothing to do, and an operator reading the tab would conclude
harvesting is complete.

**One order down, there are 57 terms with no exact keyword at all**, on €150.32 of spend:

| term | sales | spend | ACoS | CPC |
|---|---|---|---|---|
| giacca moto estiva traforata uomo | €105.74 | €1.83 | **2%** | €0.37 |
| chaqueta moto verano hombre protección c2 | €105.00 | €0.25 | **0%** | €0.25 |
| chaqueta moto verano protección nivel 2 | €105.00 | €0.47 | **0%** | €0.47 |
| chaqueta moto hombre verano 4xl | €105.00 | €3.04 | 3% | €0.61 |
| motorrad kleidung herren | €91.09 | €0.50 | 1% | €0.50 |
| motorradjacke mit rückenprotektor nach en… | €91.09 | €0.46 | 1% | €0.46 |
| …51 more | | | | |

### ⚠️ Read that €4,901 carefully

It is the sum of **57 single-order attributions**, and several are identical (€91.09 recurs a dozen
times, €105.00 four times) — consistent with one product at one price converting once per term.
Amazon attributes the whole order value to the clicked term, so a €0.46 click that preceded a €91
jacket sale shows a 0.5% ACoS. **That is a real signal of intent, not a bankable €4,901.**

What survives the caveat: **57 terms converted at least once, cost almost nothing, and have no exact
keyword** — and the configured threshold makes every one of them invisible.

**For an account that produces 16 double-order terms in two months, a 2-order threshold is not a
filter; it is an off switch.**

---

## 4 · 🔴 256 phantom keywords

47 groups of duplicate positive keywords — **same text, same ad group** — totalling **256 redundant
rows**:

| keyword | rows | rows carrying an Amazon id |
|---|---|---|
| `giacca moto` | 26 | **1** |
| `motorrad jacke herren` | 26 | **1** |
| `b0bmswm15b` | 25 | **0** |
| `giubbotto moto uomo` | 25 | **1** |
| `motorradjacke herren` | 24 | **1** |
| `b0bms6zz4h` | 17 | **0** |

`promote_to_exact` calls `createKeywordLocal()` with **no existence check**. Every run that decides a
term should be exact writes another row; one reaches Amazon and the rest are local ghosts. They
inflate every keyword count in the system and cost nothing on Amazon because they never got there.

**Two ASIN groups have zero Amazon ids at all** — `b0bmswm15b` ×25, `b0bms6zz4h` ×17. The harvest
service routes ASIN-shaped queries to PRODUCT targets, but these were written as KEYWORDs, 42 rows,
none synced. Something upstream of that guard is still treating an ASIN as a keyword.

---

## 5 · Two corrections to my own measurements

**(a) "688 new keywords, 0 impressions, 0 sales" — that was an artefact, not a finding.**

My second pass reported that none of the 688 keywords created in 60 days had taken an impression.
The third pass shows why:

| cohort | with impressions | with an Amazon id | ever synced |
|---|---|---|---|
| older than 60 days (1,441) | **0%** | 95% | 99% |
| created in 60 days (688) | **0%** | 81% | 89% |

**All 2,129 positive keywords show 0 impressions — old and new alike.** The
`AdTarget.impressions / clicks / spendCents / salesCents` columns are **not populated for anything**.
Keyword metrics live in `AmazonAdsDailyPerformance` (`entityType = AD_TARGET`, 7,683 rows in 60 days).

So harvested keywords may be performing perfectly well; **this table cannot tell you, and neither can
any surface reading it.** That is its own defect — four dead columns on the object the whole section
revolves around — but it is not a harvest failure.

**(b) The 81% / 89% figures also correct the phantom story:** most newly created keywords *do* reach
Amazon. The duplicates are the 256, not the 688.

*Third time in this series a measurement has flipped on verification. Recording it because the
un-verified version was the more dramatic one.*

---

## 6 · Three smaller traps in the promote path

1. **A hard-coded bid.** `promote_to_exact` uses `bidEur = action.bidEur ?? 0.5` — **every promoted
   keyword is bid at €0.50** regardless of what the term actually costs. Of the 57 unharvested
   converters, the CPCs run €0.25–€0.61. A flat €0.50 overpays on the cheap half and may not win on
   the expensive half.
2. **Promotion into the originating ad group.** The standalone action promotes into
   `context.searchTerm.externalAdGroupId` — the ad group the term came from. The wizard path carries
   a destination map; the rule path does not. Promoting an exact keyword back into the auto/broad ad
   group that discovered it is not the auto→manual funnel, it is a loop.
3. **The proposal queue is filling up.** `AdsRuleSuggestion`: **225 pending, 1 ever applied** — it
   was 185 when this programme started nine days ago. Every harvest rule proposes; nothing consumes.

---

## 7 · How the industry does this

| platform | harvesting approach |
|---|---|
| **Scale Insights** | *"automatically identifies high-performing and underperforming search terms, then moves or negates them based on your rules, so you don't have to manually review search term reports"* — built by sellers who scaled to eight figures; rules for "just about any scenario" |
| **Perpetua** | keyword harvesting as part of goal-based automation — *"automatically adds high-potential keywords and ASIN targets based on performance data"*; you set target ROAS, it handles execution |
| **Pacvue** | enterprise automation across large, complex account structures; harvesting inside the same rule engine as negation and bidding |
| **Ad Badger** | harvests winners from the same n-gram pass that finds waste |

### What they do that we do not

1. **Harvest and negate are one transaction.** Every mature tool promotes the term *and* negates it
   in the source ad group in the same action, so the exact keyword actually gets the traffic. Our
   `harvest_and_negate` does this; the standalone `promote_to_exact` **does not negate the source**,
   and `Auto match-type migration` pairs them only because someone listed both actions on the rule.
2. **A destination structure.** SKAG / match-type-funnel conventions send the graduate to a *manual
   exact* campaign, not back to its source. We model destinations in the wizard and drop them in the
   rule path.
3. **Bid inherited from evidence.** The promoted keyword starts at the term's own CPC or a multiple
   of it, never a constant.
4. **Idempotence.** Nothing in the field would write a 26th copy of `giacca moto` into one ad group.
5. **A threshold tuned to the account.** With 16 double-order terms in 60 days, the industry default
   of "2+ orders" is wrong here — the tools that let you set it per account expect you to.

### What we have that they do not

**A preview that is genuinely read-only.** `previewHarvest()` returns candidates without side
effects, and `harvest_and_negate` in dry-run reports `wouldNegate` / `wouldGraduate` counts plus the
top five of each. That is the "simulate before committing" property Scale Insights markets — and
ours is wired into every rule by default because every rule is on PROPOSE.

### The UI shape they converge on

- **A candidates table**, one row per term: impressions · clicks · spend · orders · ACoS · the ad
  group it came from · the destination it would go to · the bid it would get — with **approve** and
  **reject** per row and in bulk.
- **The threshold as a visible control**, with the candidate count updating live as you move it.
- **Harvest and negate shown as one paired action**, not two.
- **A history of what was harvested and how it then performed** — the only honest measure of whether
  harvesting works.

---

## 8 · What could be implemented, cheapest first

### Tier 0 — make the tab exist *(hours)*
- **Fix `liveType="keyword-harvesting"` → `'keyword-harvest'`.** One string; the tab starts showing
  its five rules. *(Same fix as study 2's `'sov'`.)*
- **Show the candidate list.** `previewHarvest()` already returns it and nothing renders it.
- **Expose the threshold**, defaulted to something this account can actually meet.

### Tier 1 — fix the promote path *(days)*
- **Dedupe before create.** 256 redundant rows, and the check is one query.
- **Stop ASINs being written as keywords** — 42 rows across two groups say the guard is bypassed
  somewhere.
- **Inherit the bid** from the term's own CPC instead of €0.50.
- **Always pair promotion with a source negative**, or say plainly that it does not.
- **Populate or delete the four dead `AdTarget` metric columns** — they read as data and are not.

### Tier 2 — the queue
225 pending suggestions and 1 ever applied is not a queue, it is a compost heap. Either make it
workable (bulk approve, expiry, grouping) or stop generating into it. This is the same finding as
the graduation board in the Automations work.

### Tier 3 — close the loop
Track each harvested keyword's performance after promotion, from `AmazonAdsDailyPerformance`. Nobody
can currently answer "does harvesting work here", and it is the only question that matters.

---

## 9 · How this tab is *supposed* to be

> **One question: which search terms have earned their own keyword — and did the last batch work?**

- **A candidates table you can act on**, with the threshold as a visible dial rather than a constant
  buried in a service.
- **One paired action**: promote to exact *and* negate at source, shown as one decision.
- **A bid derived from the term's own CPC.**
- **A destination you can see** — which campaign and ad group the graduate lands in.
- **A "harvested" history** with post-promotion performance, so the threshold can be tuned by
  evidence.
- **No phantom rows.** A keyword either exists on Amazon or is not written.

---

## 10 · What I need from you

1. **What should the harvest threshold be?** At 2 orders it finds nothing; at 1 order it finds 57
   terms at 0–3% ACoS. Given the account's conversion volume I would set it to 1 order **plus** a
   minimum spend or click floor, so it is intent-based rather than noise-based.
2. **Should promotion always negate the source?** Today only the combined action does.
3. **The 256 phantom rows — clean them up?** They are local-only and harmless to Amazon, but they
   inflate every count you read.
4. **`b0bmswm15b` ×25 as a keyword.** Do you know what wrote ASINs in as keywords? The harvest
   service explicitly routes those to product targets.
5. **The suggestion queue: 225 pending, 1 applied.** Work it, expire it, or stop filling it?

---

## Appendix — scripts

| script | measures |
|---|---|
| `_hv-study.mts` | the 5 rules · `create_keyword` writers · the harvest opportunity at the default threshold · the €0.50 bid vs real CPCs · the suggestion queue · the engines |
| `_hv-study2.mts` | the opportunity at thresholds 1/2/3/5 · single-order converters · duplicate groups · post-creation performance |
| `_hv-study3.mts` | whether `AdTarget` metrics are populated at all *(this is what corrected the "0 impressions" finding)* · which duplicate rows ever reached Amazon |

Read-only. `NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/<name>` from `apps/api`.

### Sources

- [Best Amazon PPC automation tools 2026 — SalesDuo](https://salesduo.com/blog/amazon-ppc-automation-tools/) ·
  [Best Amazon PPC tools: 15 platforms compared — SalesDuo](https://salesduo.com/blog/best-amazon-ppc-tools-comparison/)
- [18 best Amazon PPC software & tools for brands — Eva](https://eva.guru/blog/best-amazon-ppc-tools/)
- [24 best Amazon PPC software solutions — The Retail Exec](https://theretailexec.com/tools/best-amazon-ppc-software/)
- [Karooya vs Perpetua vs Pacvue](https://www.karooya.com/blog/karooya-vs-perpetua-vs-pacvue-amazon-ppc-optimization/)
- [Pacvue vs Perpetua — Atom11](https://www.atom11.co/blog/pacvue-vs-perpetua) ·
  [Best Amazon PPC software: an honest buyer's guide — SellerForge](https://www.sellerforge.ai/blog/best-amazon-ppc-software)
