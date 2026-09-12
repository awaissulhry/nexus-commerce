# PLC — Placement as its own page

*Page 3 of 11, Rules & Automation. Follows [the Placement tab study](2026-08-11-plc-placement-study.md).*
**Read-only study. No application code was changed, nothing was committed.**

Measured on production 2026-08-11 with `apps/api/scripts/_plc-page-state.mts`,
`_plc-page-attribution.mts`, `_plc-page-failures.mts`. Facts established by the eleven tab
studies are cited, not re-measured. Where I re-measured something they already said, it is
because I doubted it — and in three cases they were wrong.

---

## 0 · The one-sentence version

The placement lever is held by **one engine that does not do what every document says it does**:
`ad-rank-defend` is not a closed loop chasing an impression-share goal — `maxBiasPct` is **null on
all five rank targets**, which collapses the controller's ceiling onto its floor and makes
`targetISPct` and `acosCapPct` **unreachable code** on 4 of 5 targets; and of the **167 campaigns
carrying a placement multiplier, only 23 are governed by anything at all** — the other 144 are
residue nobody is steering, 40 of them live with the write gate open.

---

## 1 · Three corrections before anything else

I re-measured what I doubted. Three earlier claims — two of them mine — do not survive.

### 1.1 🔴 The engine does not chase. It pins.

Study 5 (Rank & Dayparting) concluded that the engine *"sees 0.15% against a 10% goal on every
tick, concludes it is massively short, and pushes placement bias upward — bounded only by the 30%
ACoS cap and the €0.80 CPC ceiling"*, and that the stalled SQP feed is therefore
*"the feedback loop of the only optimisation engine this account actually runs."*

That is not what the code does. `rank-controller.ts:87`:

```ts
export function biasBand(target) {
  const floor   = clamp(target.biasPct ?? 0, 0, 900)
  const ceiling = target.allOut ? (target.maxBiasPct ?? 900) : (target.maxBiasPct ?? floor)
  return { floor, ceiling: Math.max(floor, ceiling) }
}
```

`maxBiasPct` null and `allOut` false ⇒ **ceiling = floor** ⇒ `canChase` false
(`rank-controller.ts:186`) ⇒ `computeStep` returns at branch 2 (`:201`):

```ts
if (!canChase) {
  if (cur > floor) return toFloorDown('above Placement')
  return { action: 'hold', nextPct: cur, reason: `holding ${floor}% Placement` }
}
```

**`targetISPct` is read at line 217. `acosCapPct` at 183/222. Neither line is reachable.**

Measured — the entire goal library:

| key | placement | bias | **maxBias** | IS% | ACoS cap | maxCpc | allOut | lanes | chases? |
|---|---|---|---|---|---|---|---|---|---|
| own-top | Top | 150 | **null** | 70 | 45 | 150¢ | no | 0 | **NO** |
| defend-top | Top | 75 | **null** | 35 | 35 | 120¢ | no | 0 | **NO** |
| rest-of-search | Rest | 45 | **null** | 10 | 30 | 80¢ | no | 0 | **NO** |
| pause | Top | 0 | null | — | — | — | no | 0 | NO |
| own-top-allout | Top | 300 | null | 90 | *(ignored)* | 200¢ | **yes** | 0 | **YES** (→900) |

Four of five targets are **set-and-hold pins**. Their impression-share targets and ACoS caps are
decoration. The single exception, `own-top-allout`, ignores ACoS by design (`:183`).

The one place a ceiling *is* raised is per-scope overrides — **9 of 20 override entries**, all on
four `GALE | IT | …` schedules (`own-top` → 200, `own-top-allout` → 300) plus one at 900. So **4 of
33 live schedules can chase; 29 pin.**

**The consequence for study 5's headline:** every chase that exists is on the **Top** lane, whose
signal is `topOfSearchIS` — which is **fresh** (811 rows in 60 days, latest 2026-08-10). No target
chases on the **Rest** lane. `sqpImpressionShareForAsins` is computed every tick
(`ad-rank-defend.job.ts:556-566`), handed to the controller (`:317`, `:350`), and then **discarded
before it is read**. The dead SQP feed changes **zero placement decisions today.**

The recency guard study 5 recommends is still worth having — it protects a loop that would matter
the moment a ceiling is raised. But it is not currently load-bearing for placement, and the reason
the goals do nothing is not the feed. **It is that nobody set a ceiling.**

### 1.2 `pinPlacement` has a UI, and it has been used

My own study said *"`pinPlacement` as a real control (0 campaigns use it, and there is no UI
anywhere)"*. Wrong on both halves of the parenthesis:

- `PATCH /advertising/campaigns/:id/pins` exists (`advertising.routes.ts:10860`), fully audited.
- `control-room/GuardrailGrid.tsx:186` calls it, with a bulk path at `:321`.
- **9 `set_campaign_authority_pins` audit rows exist.** Someone has set pins and cleared them again.

What is true: **0 campaigns carry a pin today**, and the control lives on the Control Room, not
anywhere a placement decision is made.

### 1.3 The scary number is not scary

The 8 rules on this tab have **133,959 `AutomationRuleExecution` rows, of which 128,862 are
`FAILED`**. Every single one carries the error `DAILY_CAP_EXCEEDED` — one distinct message, no null
branch, no other error. Per the standing rule, that is excluded from health.

**Excluded, these rules have 0 real failures and 0 successes.** Their entire lifetime output is
5,097 dry-run proposals. All execution stopped on **2026-08-03**.

Also revised from my earlier study, with the definition stated: counting a campaign as "carrying a
multiplier" if **any** of the three lanes is > 0 gives **167 of 220**, not 145; **69** campaigns sit
at Top ≥ 100%, not 61; and **11** of those are ENABLED with the gate open, not one.

---

## 2 · (a) What exists — every wire

```
?tab=placement                                     ← NOT routed (tabs.tsx:52)
└── RulesAutomationClient.tsx:355
    └── <RuleListTab noun="Placement Rule" liveType="placement"
                     editHref={id => …/builder/placement?ruleId=id} />
        ├── GET /api/advertising/automation-rules            RuleListTab.tsx:52
        └── filtered by ruleBelongsToTab(actions,'placement')  tabs.tsx:92
            RULE_TAB_ACTION_TYPES.placement                    tabs.tsx:86
              = ['set_placement_multiplier', 'defend_top_of_search']
        Columns  Automation · Criteria · Frequency   — all three write LOCAL STATE ONLY
                 (toggleAutomation :78 · patch :77 · editMode.onApply :99)
        Bulk     Automation · Criteria · Frequency · Delete
                 applyBulk :121 →  setRows(rs => rs.filter(…))   ← the row leaves the screen;
                                                                    the rule survives on the server
```

**The lever**

```
Campaign.dynamicBidding.placementBidding = [{ placement, percentage }]   0–900%
  PLACEMENT_TOP · PLACEMENT_REST_OF_SEARCH · PLACEMENT_PRODUCT_PAGE      ads-placement-math.ts:17
```

**The write path, end to end**

```
ad-rank-defend.job.ts:437  runRankDefendOnce()        cron */15  (:725, gated NEXUS_ENABLE_RANK_DEFEND)
  ├─ plans first (ProductRankPlan) — governed set wins over schedules   :583
  ├─ schedules (AdSchedule, goal mode)                                  :664
  └─ decideAndMaybeApply()                                             :225
       ├─ pause target      → suppressCampaignBids / refloor (2¢ floor) :240
       ├─ BLENDED path      → buildBlendedAdjustments(…lanes)           :309  ← never taken (§4.3)
       └─ single-placement  → setSearchPlacement(…)                     :346
            └─ zeroes the OTHER search lane, Top↔Rest mutually exclusive :366-370
                 ads-top-of-search.service.ts:120  buildSearchPlacementAdjustments
  ↓
ads-create.service.ts:817  updatePlacementBidding()
  ├─ clamp 0..900                                                       :822
  ├─ checkAdsWriteGate({ dimension: 'placement', campaignId })           :857
  │    └─ ads-write-gate.ts:255 → ads-authority-pins.ts:128 pinDenial   (pinPlacement)
  ├─ REFUSED → audit FAILED, return, LOCAL STATE UNCHANGED               :873  (ACR.0.7b)
  ├─ ALLOWED → updateCampaign(ctx, …) → Amazon                           :862
  ├─ Campaign.dynamicBidding updated + lastSyncStatus stamped            :885
  ├─ CampaignBidHistory: ONE ROW PER CHANGED LANE, old→new, actor, reason :905
  └─ AdvertisingActionLog 'update_placement_bidding' + evidence.targetKey :932
```

**The second engine**

```
ads-tos-defense.job.ts:32   runTosDefenseOnce()  → defendTopOfSearch()  ads-top-of-search.service.ts:191
  triple-gated: NEXUS_ENABLE_TOS_DEFENSE_CRON (:59) · liveBidWritesEnabled · the write gate
  rule action ACTION_HANDLERS.defend_top_of_search                                        :228
```

**Routes that already exist**

| route | file:line | note |
|---|---|---|
| `GET /advertising/campaigns/:id/placements` | `advertising.routes.ts:564` | per-campaign; joins report labels→enums (`:586`); **no date filter on the main groupBy — lifetime totals**; optional `?windowDays` trend |
| `PATCH /advertising/campaigns/:id/placements` | `:635` | the manual write. **Forwards no `actor`, `userId` or `reason`** → lands as `changedBy:'system'`, `reason:null` |
| `PATCH /advertising/campaigns/:id/cpc-ceiling` | `:648` | `dynamicBidding.cpcCeiling` |
| `PATCH /advertising/campaigns/:id/pins` | `:10860` | `pinPlacement` |
| `GET /advertising/campaigns/:id/self-competition` | `:664` | same ASIN, same market, other campaigns |

**UI that already exists elsewhere**

| surface | file | what it is |
|---|---|---|
| `RankPlacementCockpit.tsx` | `ads-console/automation/` | **1,189 lines** — campaign-first rank ladder, drag onto a slot, TimeRankGrid, DemandHeatmap. The console being retired |
| `RankBlendEditor.tsx` | `rules-automation/_rank/` | the **three-lane blend editor**, mounted at `_rank/RankTargetEditor.tsx:456`. Complete. Used by nothing (§4.3) |
| `GuardrailGrid.tsx` | `rules-automation/control-room/` | bounds + the three authority pins |
| `CampaignsGrid.tsx:631` / `[id]/tabs/DetailsTab.tsx:164` | `ads/campaigns/` | the "Bid Multiplier" modal → `PATCH /placements` |

---

## 3 · (b) How a multiplier is actually decided

### 3.1 The chain, in order

1. **Which plan governs.** `ProductRankPlan` beats `AdSchedule` (`ad-rank-defend.job.ts:665`
   skips plan-governed campaigns). **0 plans are enabled** — 2 rows, both off. So today the
   schedules own everything.
2. **Which target, this hour.** `resolveActiveTargetKey(windows, defaultTargetKey, day, hour)`
   (`rank-controller.ts:77`) — the first window covering (day, hour) that names a `targetKey`
   wins, else the baseline. `endHour` is exclusive. The clock is **Postgres `now()`**, not the
   container clock (`ad-rank-defend.job.ts:32`, deliberate — Railway clock skew).
3. **Dated events override the weekly plan** — `RankScheduleEvent`, `pickActiveEvents` (`:120`),
   latest-started wins. **0 rows exist.**
4. **Per-scope overrides merge onto the target** — plan map, then campaign map, later wins
   (`applyTargetOverrides`, `:64`).
5. **Family guards** transform the spec — OOS/lost-buybox → pause; family over ACoS → drop
   all-out (`effectiveSpec`, `:385`). Plan-only, so inert today.
6. **The controller decides** — `computeStep` (`rank-controller.ts:170`). With ceiling = floor
   this is: below the floor → snap up; above → snap down; else hold.
7. **The CPC ceiling binds last** — `cpcCapPct` (`:129`), applied after everything
   (`ad-rank-defend.job.ts:361`), expressed as the highest placement % that still respects
   `maxCpcCents` given the campaign's **highest** live base bid and the bidding strategy's
   headroom.
8. **Out-of-budget and family-over-budget suppress raises only** (`:304`, `:320`, `:353`).
9. **The other search lane is zeroed** — Top and Rest are mutually exclusive on the
   single-placement path (`:366-370`).

### 3.2 What actually bounds it

| bound | where | binding today? |
|---|---|---|
| 0–900 clamp | `ads-placement-math.ts:6`, `ads-create.service.ts:822` | always |
| `maxCpcCents` → placement cap | `rank-controller.ts:129`, job `:293/:323/:361` | **yes** — the only working economic guardrail |
| `STRATEGY_HEADROOM` (up-and-down = ÷2) | `rank-controller.ts:119` | yes, but **only inside the CPC cap** |
| `acosCapPct` | `rank-controller.ts:183` | **no** — unreachable on 4/5 targets; ignored by design on the 5th |
| `targetISPct` | `rank-controller.ts:217` | **no**, same reason |
| `pinPlacement` | `ads-authority-pins.ts:128` | enforced, **set on 0 campaigns** |
| `liveBidWritesEnabled` | gate + `:211` | 82 of 220 |
| `maxCampaigns` blast radius | job `:467` | plan-only, inert |

**The one that matters and reads backwards:** `strategyHeadroom` knows that up-and-down bidding
doubles the top-of-search bid — but it is consulted **only when `maxCpcCents` is set**. A campaign
with no rank target and a hand-set +300% on `AUTO_FOR_SALES` passes through nothing at all.

### 3.3 How `ad-rank-defend` blends lanes — and what a lane's signal is

`ad-rank-defend.job.ts:309`. When `spec.lanes` is non-empty each lane is expanded into its own
single-placement spec (`laneToSpec`, `:162`), stepped independently, capped by the shared CPC
ceiling, and written **in one combined `updatePlacementBidding`** built by
`buildBlendedAdjustments` (`ads-placement-math.ts:30`) — which owns the whole profile: a lane you
stop declaring is actively set to 0, and non-managed placements are preserved.

| lane | feedback signal | grain | fresh? |
|---|---|---|---|
| `PLACEMENT_TOP` | Amazon `topOfSearchIS` | campaign-day, TOP report row only | **yes** — 811 rows/60d, 65 campaigns, latest 2026-08-10 |
| `PLACEMENT_REST_OF_SEARCH` | `sqpImpressionShareForAsins` (Brand Analytics) | ASIN-week | **no** — 16 days stale, 85 rows (study 5 §3) |
| `PLACEMENT_PRODUCT_PAGE` | none — open-loop | — | n/a |

The blend also carries a **base-bid directive** (`hold` / `absolute` / `suppress` / `deltaPct`,
`:195`) — the number the multipliers stack on. `deltaPct` scales from a remembered baseline so it
cannot compound (`ads-placement-math.ts:13`).

`samePlacements` (`:181`) compares profiles as maps so the blend never churns a no-op write.
**The single-placement path has no such guard** — see §4.5.

---

## 4 · What is measurably true, 2026-08-11

### 4.1 🔴 Ownership — 144 campaigns nobody is steering

| | |
|---|---|
| campaigns | 220 |
| **carrying a non-zero multiplier on any lane** | **167** |
| bound by an ENABLED goal-mode `AdSchedule` | 33 |
| named in an ENABLED `ProductRankPlan` | **0** (2 plans, both disabled) |
| carrying a multiplier **and** governed | **23** |
| carrying a multiplier, **governed by nothing** | **144** |
| governed but carrying nothing | 10 |

Of the 144: **103 PAUSED · 40 ENABLED · 1 ARCHIVED**, and **all 40 live ones have the write gate
open.** By Top multiplier: 18 at 0 · 51 at 1–49 · 14 at 50–99 · **52 at 100–199 · 9 at 200+**.

This is the fact the current tab hides most completely. The 15,366 writes are real, but they land
on **33 campaigns**. The other 144 carry numbers that were set once — by the 99-action "Rank
control" batch rule, by a launch wizard, or by hand in Seller Central — and **no engine will ever
revisit them.** An operator reading "the engine manages placement" is right about 14% of the
account.

### 4.2 The writes, and who makes them

**`CampaignBidHistory`, placement fields, 60 days: 11,652 rows.**

| | |
|---|---|
| by lane | Top **6,131** · Rest **5,521** · **Product 0** |
| distinct campaigns | **33** |
| actor | **`automation:rank-defend-*` — 100%** |
| rows with no reason | **0** |
| active days | **9** — 2026-08-03 → 08-11 only |
| rows that wrote 0 over an **absent** lane | **3,553 (30%)** |
| rows recording a real value move | 8,099 |

**`AdvertisingActionLog` `update_placement_bidding`, 60 days: 15,366 rows.**

| | |
|---|---|
| status | **SUCCESS 15,366 · FAILED 0 · blocked 0** |
| push mode | live 15,342 · local 24 |
| distinct campaigns | 57 |
| `evidence.targetKey` populated | **0** |
| unattributed (`null`/`system`) | **9,207 (60%)** — but **all before 2026-08-03; 0 in the last 7 days** |

Two things follow.

**The attribution hole is closed.** The audit log shows a clean cutover on 2026-08-03: every write
before it unattributed, every write after it carrying `automation:rank-defend-<scheduleId>` and a
readable reason. `CampaignBidHistory` placement rows begin on the same date. The ADX A2 note's
concern is resolved — **but the attribution substrate is only 9 days deep**, which bounds what a
history view can show at launch.

**`targetKey` is never populated, which proves the blend has never run.** `targetKey` is passed
only on the blended path (`ad-rank-defend.job.ts:337`); `setSearchPlacement` does not forward it.
0 of 15,366 rows carry one. Combined with `lanes = 0` on every target and every override, and
`Product = 0` history rows: **no blended multi-lane write has ever been made in this account.**

### 4.3 🔴 The page-one mechanism is built, wired, tested — and has never been used

| piece | state |
|---|---|
| `RankTarget.lanes` schema + per-lane semantics | shipped (`schema.prisma:14654`) |
| blended controller path | shipped (`ad-rank-defend.job.ts:309`) |
| `buildBlendedAdjustments` + unit tests | shipped (`ads-placement-math.ts:30`) |
| per-lane signal routing (Top-IS / SQP / open-loop) | shipped (`:317`) |
| per-scope blend override (`o.lanes`) | shipped (`:87`) |
| **the editor** — three lanes, bias, ceiling, target IS, ACoS cap, effective-bid preview | shipped (`_rank/RankBlendEditor.tsx`), mounted (`_rank/RankTargetEditor.tsx:456`) |
| **targets using it** | **0** |
| **overrides using it** | **0** |
| **writes it has produced** | **0** |

### 4.4 The lever's state, and the inversion

Account-wide, 60 days, by lane (report labels mapped to enums):

| lane | impressions | %impr | spend | %spend | sales | **ROAS** | CPC | CVR |
|---|---|---|---|---|---|---|---|---|
| Top of Search | 59,630 | 2.3% | €1,681.68 | **45.2%** | €3,022.33 | **1.80** | €0.72 | 1.7% |
| Rest of Search | 556,787 | 21.9% | €1,325.33 | 35.6% | €4,116.78 | **3.11** | €0.40 | 1.4% |
| Product Pages | 1,926,999 | 75.8% | €716.44 | 19.2% | €1,710.80 | 2.39 | €0.45 | 1.2% |

**Top of Search takes 45% of the spend for 2.3% of the impressions and returns the worst ROAS.**
Study 3's per-market breakdown (Rest beating Top in all four markets) stands.

**Per campaign** — restricting to campaigns with at least two lanes carrying ≥20 clicks and a
non-zero multiplier, so a ROAS is allowed to decide something:

> **18 campaigns are measurable. 8 of them pay their highest multiplier into a worse-returning lane.**

| campaign | mkt | paying most into | ROAS there | best lane | its multiplier | ROAS there |
|---|---|---|---|---|---|---|
| GALE \| IT \| Exact \| Category | IT | Top 3% | 0.89 | Product | 0% | **3.61** |
| IT-AIREON-SP-Auto | IT | **Rest 45%** | **0.00** | Top | 0% | **4.17** |
| GALE PHRASE DE | DE | Top 30% | 2.32 | Rest | 0% | **11.31** |
| IT-AIREON-SP-Category-Phrase | IT | **Rest 45%** | **0.00** | Product | 0% | **8.03** |
| GALE EXACT DE | DE | Top 19% | 1.56 | Rest | 0% | **6.87** |
| DE_Phrase_3_Keywords | DE | Top 30% | 2.74 | Product | 0% | 5.22 |
| FR_Phrase_8_Keywords | FR | Top 30% | 0.00 | Product | 0% | 3.03 |
| ES_Phrase_3_Keywords | ES | Top 35% | 0.00 | Product | 0% | 4.03 |

Two of these are the engine's own doing: `IT-AIREON-SP-*` sit at **Rest 45%** because that is
`rest-of-search.biasPct`, pinned there every 15 minutes — while their Top lane, at 0%, returns
4.17× and 8.03×. **The inversion is not only legacy drift. The engine is actively maintaining
two of the eight.**

### 4.5 Churn

| | |
|---|---|
| audit rows (one per write) | 15,366 |
| history rows (one per **changed** lane) | 11,652 |
| campaigns in the audit log that **never** produced a history row | **24** |
| history rows writing 0 over an already-absent lane | **3,553 (30%)** |

24 campaigns — `GALE EXACT IT`, `GALE BROAD IT`, `IT_BMM_Gale_V1`, `Auto_Close_Moss` and others —
received placement writes for 60 days that changed **no lane value at all**. The blended path is
protected from this by `samePlacements` (`:181`); the single-placement path is not — it pushes
whenever `otherCur > 0` (`:371`), and re-writes a 0 over an absent lane every tick.

### 4.6 Compounding — still safe, still unguarded

| strategy | 0 | 1–49 | 50–99 | 100–199 | 200–299 | 300+ |
|---|---|---|---|---|---|---|
| LEGACY_FOR_SALES (down-only) | 72 | 51 | 10 | 59 | 7 | 1 |
| MANUAL (fixed) | 4 | 2 | 2 | 0 | 1 | 0 |
| **AUTO_FOR_SALES (up-and-down)** | 5 | 3 | 2 | 1 | 0 | 0 |

**0 campaigns pair up-and-down bidding with a Top modifier over 100%.** ✅

**69 campaigns sit at Top ≥ 100%; 11 are ENABLED, all with the gate open, all in IT** — and 8 of
those 11 are at exactly 150% *because `own-top.biasPct` = 150 and the engine is holding them
there*. The genuinely unowned live ones are three:

| campaign | Top | strategy | governed |
|---|---|---|---|
| **GALE EXACT IT** | **+300%** | fixed | **unmanaged** |
| Normal slider exact only | +151% | fixed | unmanaged |
| normal slider broad only | +150% | fixed | unmanaged |

### 4.7 The data feeds behind the grid

| feed | state |
|---|---|
| `AmazonAdsPlacementReport` | **healthy** — latest 2026-08-10 (2 days old), ~165 rows/day, one gap (2026-07-29) |
| distinct `placement` values | exactly three: `Top of Search on-Amazon` · `Other on-Amazon` · `Detail Page on-Amazon` |
| `topOfSearchIS` | **TOP report row only**, 811 rows / 60d, **65 campaigns** |
| report → local join | 74 report campaigns, **74 joinable, 0 orphans** ✅ |
| campaigns carrying a multiplier with **no report row in 60d** | **113** — mostly the 103 paused ones |

The grid's evidence column will be blank for two thirds of the rows, and that is honest: a paused
campaign has no placement performance. The design must say "no delivery in window", not "0".

### 4.8 The tab's own rules

8 rules · **102 `set_placement_multiplier` + 4 `defend_top_of_search` action instances** · all
disabled · all PROPOSE · **0 SUCCESS ever** · last activity 2026-08-03. `automation:tos-optimizer`
has written **0** placement history rows all-time. `top-of-search-defense` has **no `CronRun` rows
at all** — against `ad-rank-defend` 6,307 and `ad-dayparting` 6,911.

---

## 5 · (c) Should this page be a view of the engine, or a list of rules?

**A view of the engine — but the argument is not the one my first study made, and the honest
version is stronger.**

The weak argument is arithmetic: 8 dead rules vs 15,366 writes, so render the writes. That would
justify a log, not a page.

The real argument is that **the rule list and the lever are not the same object, and the rule list
cannot be made into one.**

- A rule's scope is single-valued. That is why one rule carries **99 of the 102**
  `set_placement_multiplier` actions with the campaign count in its *name* — the model has no
  other way to say "these 99 campaigns". It cannot be partially disabled, partially scoped, or
  partially audited.
- The lever is a **campaign × lane** field with three values, a bidding-strategy interaction, a
  0–900 range, and an hourly plan behind it. A list of rules has no place to put any of that.
- The thing an operator needs to know — *what is my Top multiplier right now, who set it, and is
  it earning* — is answerable from `Campaign.dynamicBidding` + `AmazonAdsPlacementReport` +
  `CampaignBidHistory` **without consulting a rule at all**.

**But "a view of `ad-rank-defend`" is also wrong**, and this is what the measurement changed. The
engine governs **23 of 167** campaigns carrying the lever. A page that shows only what the engine
does would hide 86% of the account — the exact inverse of today's defect, with the same shape.

> **The page is a view of the LEVER. The engine is one of the columns.**

Every campaign appears. Each row states which lane carries what, what that lane earned, and **who
owns it** — a schedule, a plan, or *nobody*. "Nobody" is the most important value that column can
take, and it is currently the most common.

Where do the 8 rules go? They are already listed on **Apply Rules**, which lists every rule
regardless of type (`tabs.tsx:78-81`). They do not need a second home. If any survives the
automations cull, it belongs there.

---

## 6 · (f) The industry — features *and* interface

### 6.1 The mechanic everyone is automating

Amazon exposes bid modifiers per placement, **0–900%, additive and one-directional — you cannot
bid a placement *down***, only raise the others or zero this one. Amazon's own console puts them
on a **"Bid adjustments" tab inside the campaign**, listing four placements: Top of Search, Rest
of Search, Product Pages, and **Amazon Business**. The Placement report breaks impressions,
clicks, spend, sales, CVR, CPC, ACoS and ROAS out by placement.

Two consequences for us:

- **We model three lanes; Amazon has four.** `MANAGED_PLACEMENTS` (`ads-placement-math.ts:21`)
  omits Amazon Business. Amazon B2B is entitlement-blocked for this account (tracked separately),
  so the omission is correct today — but it should be a *stated* omission on the page rather than
  a silent one, since the lane exists in Amazon's own console.
- **"Fix the inversion" cannot mean "lower Top."** It can only mean *raise Rest* or *zero Top*.
  The engine's Top↔Rest mutual exclusion already does the second — which is why
  `IT-AIREON-SP-Auto` sits at Rest 45 / Top 0.

### 6.2 The platforms

| platform | how placement is exposed | price point |
|---|---|---|
| **Pacvue** | **Placement locks** — hold a position on high-value keywords. Rules keyed on campaign-avg ROAS, profile-avg ROAS, custom target ROAS or a hard € amount, in AND/OR combinations, gated by min/max click, spend and impression thresholds. Explicit **downbid** rules as well as upbid. **Bid Explorer** forecasts performance at different bid levels *before* committing. Results verified by grouping the Advertising tab **by placement** and a dashboard **Placement Performance module** | ~$500+/mo |
| **Perpetua** | `Goal > Advanced Settings > Campaign Management > Adjust Bids by Placement`, four fields (ToS / RoS / PP / Amazon Business %). **Bid Adjustments** can be fixed or a multiplier and **expire after a duration you choose**; "Always On" = never expires. Live experiments are managed on a dedicated **Experiments tab** where you change the bid, adjust the duration, or stop it | mid |
| **Skai + Profitero** | Shelf Intelligent Media — Profitero's digital-shelf signals surfaced *inside* Skai's campaign management, so placement pressure responds to shelf position | enterprise |
| **CommerceIQ** | placement as one actuator among many, across 1,450+ retailers; bid/budget pacing off 50+ shelf-aware signals | ~$100k/yr |
| **Quartile** | hourly, patented ML; AI **and** rule automation | $895+/mo |
| **Teikametrics** | ML bidding, Amazon + Walmart | $179/mo → $1,430/mo → custom |
| **Scale Insights** | an explicit **Placement Rule** adjusting Top-of-Search and Product-Page multipliers, with three exposed time knobs: **Days to Analyze · Days of Recent Data to Ignore · Days to Observe**. States its precedence: *"the placement algorithm executes before the bidding algorithm, ensuring that changes in the TOS multiplier are incorporated into the final bid calculation."* Applied per campaign or in bulk via strategic objectives | low |
| **Ad Badger** | rules hourly; **does not** auto-optimise placement — teaches manual +20–30% on campaigns under target ACoS | spend-tiered |
| **SellerMetrics** | automates placement-level adjustments across all three lanes plus dayparting; buckets hours into peak / neutral / off-peak at ±20% of the daily average CVR, on a **14-day minimum** hourly window | $159/mo at $10k spend |
| **Zon.Tools · Xmars** | bid, budget **and placement multipliers by hour or day** | low–mid |

### 6.3 What the screen looks like — the shape they converge on

1. **A flat grid whose rows are campaign × placement**, with the multiplier in the same row as that
   placement's impressions, clicks, spend, CVR, CPC and ROAS. Pacvue's is literally the
   Advertising tab *grouped by placement*. Nobody makes you open a campaign to see this.
2. **Inline edit on the number**, with bulk apply across selected rows.
3. **A recommendation column beside the observation** — what the system would do, before it does
   it. Pacvue's Bid Explorer is the strong form: a forecast at several bid levels.
4. **Time knobs exposed, not hidden** — Scale Insights puts "days to analyze / ignore / observe" in
   the rule UI, so an operator can see the evidence window a change is based on.
5. **A duration on an override** — Perpetua's expiring bid adjustments plus an Experiments tab that
   lists every temporary change with its clock running.
6. **A stated precedence** — Scale Insights says out loud which algorithm runs first.

### 6.4 The disagreement worth quoting to yourself

Pacvue publishes *"Three Reasons Winning Top of Search Doesn't Matter"*: ToS *"can easily be 2–3×
more expensive than RoS placements for the same keyword"*, while *"conversion behavior does not
vary significantly depending on whether that shopper landed on your detail page via ToS vs RoS"* —
and recommends optimising for **the search placement with the lowest CPC and highest CVR**.

Ad Badger teaches the opposite: top-of-search converts far better, so raise it 20–30% wherever ACoS
is under target.

**Our own numbers side with Pacvue, hard**: Top costs €0.72 CPC against Rest's €0.40 (1.8×, inside
their 2–3× claim) and converts at 1.7% against 1.4% — a 0.3pp CVR edge nowhere near paying for an
80% CPC premium plus an +87% median multiplier on top.

### 6.5 One thing worth stealing, one worth avoiding

**Steal: Perpetua's scale-back.** Perpetua documents its multiplier chain explicitly —
`engine bid → bid multiplier → placement multiplier → stream schedule multiplier`, applied
**sequentially, compounding**. On Classic Goals it then *"scales bids back to account for placement
multipliers… to avoid excessive over-multiplication of bids"*, scaling by **the maximum
multiplier**, and exposes that as a **toggle** the operator can turn off.

That is strictly better than the refusal I proposed in the first study. A refusal makes the
operator solve the arithmetic. A scale-back keeps the *intent* (hold Top) and removes the
*accident* (paying 4× for it), and naming it as a toggle makes the choice explicit. We already own
the ingredient: `strategyHeadroom` (`rank-controller.ts:119`) knows up-and-down doubles, and
`cpcCapPct` already converts a € ceiling into a placement %. Today both fire only when
`maxCpcCents` is set.

**Avoid: Pacvue's placement locks, as a promise.** "Hold this position" is a claim Amazon's API
cannot honour — there is no rank to set or read, only impression share after the fact, daily, and
**only for Top** (Rest and Product have no Amazon impression-share metric at all). Our own
`RankPlacementCockpit` header already says this plainly: *"it targets/defends a position; it can't
pin one."* Selling the operator a lock we can only approximate — on a lane where we have no
measurement — is how a surface starts lying. Say "hold ~N% of the first row, measured daily" and
show the measurement's age.

---

## 7 · (d) How the page should be

> **One question: for every campaign, where are my ads showing, what is each lane worth, who put
> it there — and is anything about to spend money I did not choose?**

### 7.1 The grid — campaign × lane, flat, filtered

One row per campaign per lane (or one row per campaign with three lane groups — a layout call, not
a design call). Columns:

| column | source | note |
|---|---|---|
| campaign · market · status · ad product | `Campaign` | |
| **lane** | Top / Rest / Product | the three enums |
| **multiplier %** | `dynamicBidding.placementBidding` | inline-editable, bulk-editable |
| **effective bid** | multiplier × campaign max base bid × strategy headroom | the number that actually spends |
| impressions · clicks · spend · sales · ROAS · CPC · CVR | `AmazonAdsPlacementReport`, labels mapped via `REPORT_TO_BID_KEY` | **"no delivery in window"** where absent, never 0 |
| **top-of-search IS** | `topOfSearchIS`, TOP row only | 65 campaigns have it; blank elsewhere, stated as "Amazon publishes none for this lane" |
| **owner** | schedule / plan / **nobody** | §4.1 — the most important column on the page |
| **held target** | `AdSchedule.lastApplied` + the resolved `RankTarget` | "own-top → pins Top at 150%" |
| **last change** | `CampaignBidHistory` (field ∈ lanes) | old→new, actor, reason, timestamp |
| **pin** | `Campaign.pinPlacement` | a real toggle, `PATCH /pins` exists |
| **flags** | derived | inversion · compounding · unmanaged · churning · at-ceiling |

Filters: market, ad product, status, owner (**engine / nobody**), lane, has-multiplier,
flagged-only. Sort by spend by default — the money, not the alphabet.

### 7.2 The five flags, each with a measured population today

| flag | rule | today |
|---|---|---|
| 🔴 **inverted** | highest multiplier on a lane whose ROAS is beaten by another lane with ≥20 clicks | **8 campaigns** |
| 🟠 **unmanaged** | non-zero multiplier, no enabled schedule or plan governs it | **144** (40 live, gate open) |
| 🟠 **compounding risk** | Top > 100% on `AUTO_FOR_SALES` | **0** — add it while it is free |
| 🟡 **churning** | receiving writes that change no value | **24 campaigns**, 3,553 rows |
| 🟡 **decorative goal** | target names a `targetISPct`/`acosCapPct` the ceiling makes unreachable | **29 of 33** live schedules |

The last one is a screen that tells the truth about itself. A row that says *"target: hold 10% of
rest-of-search"* next to a controller that cannot read the number is the defect this whole
programme keeps finding; naming it on the row is the cheapest possible fix.

### 7.3 Attribution and undo

`CampaignBidHistory` already holds exactly what is needed — one row per changed lane, `oldValue`,
`newValue`, `changedBy`, `reason`, `changedAt` — and since 2026-08-03 it is **100% attributed with
100% reason coverage**. A lane cell expands to its change history; each entry restores.

Two gaps to close before this is honest:

- **`PATCH /advertising/campaigns/:id/placements` forwards no actor or reason**
  (`advertising.routes.ts:640`). Every manual change made from this page would land as
  `changedBy: 'system'`, indistinguishable from a pre-August legacy row. The one path a *human*
  uses is the one path that cannot say who they were.
- **The history is 9 days deep.** The page should say so rather than imply the account began on
  2026-08-03.

### 7.4 Spend ceilings and the refusal

The operator's standing decision: ceilings per scope (market · product line · portfolio ·
campaign), never one global number; at the cap, **refuse the write and say so**.

Placement is a multiplier, not an amount, so its ceiling is naturally expressed as **effective CPC**
— which the system already computes (`cpcCapPct`). The scope grains map onto the existing scope
substrate. The refusal must render on this page in the operator's words, in a full sentence,
carrying the scope that refused, exactly as `pinDenial` (`ads-authority-pins.ts:143`) already
writes them.

### 7.5 The URL contract

```
/marketing/ads/rules-automation/placement
  ?market=IT                     market filter
  &lane=top|rest|product         lane filter
  &owner=engine|none|all         the ownership column as a filter
  &flag=inverted|unmanaged|compounding|churning|decorative
  &campaign=<id>                 opens the detail rail for one campaign
  &window=30|60|90               the evidence window, stated
  &sort=spend&dir=desc
```

Every view linkable; every flag a shareable URL; `?campaign=` deep-links the rail so a change log
entry elsewhere can point straight at the row that caused it.

---

## 8 · The page-one story

> *"I want several of my ASINs on the same results page at once, balanced between top-of-search
> and rest-of-search, with me choosing the balance, held automatically."*

### 8.1 What makes it possible

**The raw material already exists in abundance.** Of 180 (ASIN × market) pairs advertised by an
enabled campaign, **179 are advertised by more than one campaign** — commonly 8, 10, 11, and in 15
cases **24 campaigns on one ASIN in one market**. IT alone advertises 126 distinct ASINs.

**The mechanism is built and unused.** `RankTarget.lanes` drives Top + Rest + Product in one write,
each with its own bias, ceiling, target and signal (§4.3). The editor is shipped. Nothing uses it.

### 8.2 The three things standing in the way

**1. The single-placement path forbids it.** `buildSearchPlacementAdjustments`
(`ads-top-of-search.service.ts:120`) treats Top and Rest as mutually exclusive — driving one
**zeroes** the other, on every tick, even on a hold (`ad-rank-defend.job.ts:366`). A campaign under
a lane-less target can occupy exactly one search lane. Every live target is lane-less. **Balance is
currently impossible by construction**; only the blend can express it.

**2. Self-competition demotes exactly the thing page-one requires.** `detectSelfCompetition`
(`rank-self-competition.ts:31`) finds two family campaigns sharing an EXACT/PHRASE keyword, ranks
them by ACoS, and **demotes the loser to the plan baseline** so we stop outbidding ourselves. That
is right when both are chasing the *same slot* and wrong when they are holding *different lanes of
the same page* — which is the goal. The detector needs one exemption: **a contest between
campaigns aimed at different lanes is not a contest.**

**3. There is no term-grain evidence.** `AmazonAdsPlacementReport` is campaign × day × lane. It can
never answer "are my three ASINs on page one for *this term*". That question is only reachable via
SQP (ASIN × week — currently 16 days stale) or the search-term report. **The page must not imply a
measurement it does not have.**

### 8.3 The design

A **page-one plan** is a small object over things that already exist:

```
scope        market + a set of ASINs (or a product family)
allocation   an ordered lane assignment across the campaigns serving that scope:
               campaign A → Top    bias N%, ceiling M%,  target IS x%   (signal: Amazon Top-IS, daily)
               campaign B → Rest   bias P%, ceiling Q%,  target SQP y%  (signal: SQP, weekly, age shown)
               campaign C → Product bias R%                            (open-loop, set-and-hold)
balance      the operator's split — a single control, "how much of my page-one budget goes to the
             first row vs the rest of the page"
guards       family ACoS cap · family daily spend cap · per-scope effective-CPC ceiling
```

Actuated entirely through `RankTarget.lanes` + `targetOverrides` — **no new write path, no new
engine, no migration beyond the plan row itself.**

The screen is three bands:

1. **The allocation** — the campaigns serving this scope, one lane each, as a stacked bar showing
   the intended balance next to the achieved one.
2. **The evidence** — per lane: impressions, spend, ROAS, and the impression share with **its age
   and row count on the same line**. Top says "19.9%, from yesterday". Rest says "0.20%, from data
   16 days old, 85 rows" — or "no signal", for the 10 AIRMESH campaigns study 5 found.
3. **The contests** — every keyword two of these campaigns share, marked *coordinated* (different
   lanes — fine) or *competing* (same lane — one of you should move), reusing
   `GET /advertising/campaigns/:id/self-competition` and `detectSelfCompetition`.

And the sentence the page must be willing to print, because it is true and Pacvue's competitors
will not print it:

> **Amazon runs a blind auction. We cannot pin a rank. We can hold an impression share, measured
> daily for Top of Search and approximated weekly for Rest of Search, and this is how old that
> measurement is.**

---

## 9 · (e) `top-of-search-defense`: arm or delete?

**Delete the cron and the rule action. Keep `analyzeTopOfSearch`.**

The evidence:

| | |
|---|---|
| `CronRun` rows | **none — the job name does not appear at all** |
| placement history rows by `automation:tos-optimizer` | **0, all time** |
| `defend_top_of_search` action instances on the tab | 4, across disabled rules, 0 successes |
| `NEXUS_ENABLE_TOS_DEFENSE_CRON` | unset |

And the design reasons, which matter more than the counters:

1. **It is a worse copy of an engine we already run.** It drives one lane by ±15%/run toward a
   single global `targetIS`/`targetAcos` read from environment variables
   (`ads-tos-defense.job.ts:34-35`). `ad-rank-defend` drives the same field with per-campaign
   targets, per-scope overrides, an hourly plan, a CPC ceiling, an out-of-budget guard, a loss
   proxy and a blend path.
2. **It has no scope.** `defendTopOfSearch` acts on every campaign in the placement report, filtered
   only by the allowlist. There is no market, family, portfolio or campaign scope — which
   contradicts the standing "all four scope grains matter equally" decision.
3. **Two engines writing one field with no precedence is a known defect in this account.** Study 9
   named it for bids: six `bid_to_target_acos` rules plus a rank engine, and "whichever ran last
   wins". Arming this would reproduce it for placement, deliberately.
4. **Arming it would fight the fix.** It only ever pushes `PLACEMENT_TOP` — the lane our own data
   says is over-funded by 45% of spend for 1.80× ROAS.

What to keep: `analyzeTopOfSearch` (`ads-top-of-search.service.ts:38`) is `ad-rank-defend`'s signal
source (`ad-rank-defend.job.ts:501`) and must not be touched. `applyPlacementBias` /
`setSearchPlacement` are the actuators. Only `runTosDefenseCron`, `startTosDefenseCron`,
`defendTopOfSearch` and `ACTION_HANDLERS.defend_top_of_search` go — plus the 4 rule actions and the
env flag.

A permanently dark engine described in its own header as *"the autonomous 'always stay on top of
search' loop"* is worse than no engine: it is a promise in the codebase that an operator, a future
session, or I will eventually believe.

---

## 10 · (g) Requirements on the shared layer

Stated as constraints. A twelfth pass reconciles these with the other ten sets.

**Shared with Rank & Dayparting (session 5) and Bid (session 9) — the same engine**

1. `ad-rank-defend` writes **placement, base bids, bid suppression and campaign status**. Three
   pages describe one engine. **There must be exactly one name, one identity and one link target
   for it**, and one place that answers "which loop owns this campaign this hour". If Placement
   invents `automation:rank-defend-<id> → schedule name` resolution and Bid invents another, the
   two pages will disagree about who changed something.
2. **"What is this campaign holding right now" is one fact with one resolver.** It is
   `resolveActiveTargetKey(windows, defaultTargetKey, day, hour)` over a Postgres clock, plus
   event overrides, plus per-scope override merge. Three pages need the answer; there must not be
   three implementations. A second copy is free to drift from the engine, which is precisely what
   `resolveActiveWindow` was extracted to prevent (`rank-controller.ts:54-60`).
3. **The current value is a snapshot of something that changes by the hour.** Live schedules carry
   2,739 window target-keys across five targets; at 12:00Z all 33 held `own-top`, at 00:45 study 5
   measured all 33 holding `pause`. Any page showing "current multiplier" needs the shared ability
   to show **the plan behind the number**, not just the number, or it will read as instability.

**Attribution and change feed**

4. Every dimension needs **last-change attribution** — actor, reason, old→new, timestamp — resolved
   from `CampaignBidHistory` with `automation:*` prefixes mapped back to human names. Placement,
   Bid and Budget all need the identical component and the identical resolver.
5. **A change made on one page must appear on the others without a reload.** A placement write from
   Placement changes what Rank & Dayparting's schedule row is holding and what Bid's effective-CPC
   column computes.
6. **Writes originating in the UI must carry an actor and a reason to the audit spine.** At least
   one existing route (`PATCH /campaigns/:id/placements`) does not. Whatever the shared write
   client is, it must make omitting attribution impossible rather than merely discouraged.

**Signal honesty**

7. A **signal-freshness primitive**: age, row count and coverage of the feed behind any number, on
   the same line as the number. Placement needs it for `topOfSearchIS` (fresh) and SQP (16 days
   stale, 10 campaigns with no signal at all). Rank & Dayparting needs the identical thing. Two
   implementations will disagree about what "stale" means.
8. A shared way to render **"no data" distinctly from "zero"**. 113 of 167 campaigns carrying a
   multiplier have no placement report row in 60 days.

**Scope, refusal and guardrails**

9. The page must inherit **the selected market and scope across navigation from any other page** —
   all four grains (market · product line · portfolio · campaign), which the scope bar already
   models.
10. **A refusal must render identically wherever a write is refused** — the pin denial, the bounds
    denial, the account halt, the per-scope spend ceiling. One sentence, naming the scope that
    refused and how to clear it. `pinDenial` already writes them
    (`ads-authority-pins.ts:143`); the page must display, not paraphrase.
11. Placement needs the **authority pin** (`pinPlacement`) as a row-level control. It exists, it is
    enforced at the gate, and its only UI is on another page. Whoever owns the pin control must
    decide whether it lives once (Control Room) or on every dimension's page; **it must not be
    forked.**

**Authoring**

12. **The lane/blend editor already exists** in the Rank & Dayparting builder
    (`_rank/RankBlendEditor.tsx`, mounted `_rank/RankTargetEditor.tsx:456`). Placement must **link
    to it, never fork it.** A second three-lane editor is a second definition of what a lane means.
13. Placement becomes a routed page (`routed: true` in `RULES_TABS`, `tabs.tsx:52`) — one additive
    line in a file ten other sessions also need. **Sequencing, not design.**

**Design system**

14. `AdsDataGrid` + `GridToolbar` + `FilterBar` + all four DS stylesheets; the shared frozen-column
    and dropdown-clipping behaviour; the shared empty state.

---

## 11 · (h) Tiered plan

### Tier 0 — show the lever *(hours; no new tables, no new engine, no writes)*

| | unlocks | cost |
|---|---|---|
| The campaign × lane grid, read-only, with lane economics from `AmazonAdsPlacementReport` | the question the tab is named after becomes answerable | the join already exists at `advertising.routes.ts:586`; needs a **list** endpoint (today's is per-campaign and lifetime-scoped) |
| The **owner** column — schedule / plan / nobody | surfaces the **144 unmanaged campaigns**, the single largest hidden fact | `AdSchedule` + `isGoalMode`, in memory |
| **Last change** per lane — actor, reason, old→new | 9 days of fully-attributed history rendered for the first time | `CampaignBidHistory`, indexed |
| The **inversion flag** | **8 campaigns**, today, with the evidence beside them | pure derivation |
| The **decorative-goal** note on rows whose ceiling makes the target unreachable | stops the screen repeating a claim the controller cannot honour | reads `RankTarget` + overrides |
| Signal freshness beside `topOfSearchIS` and SQP | the operator sees which numbers are yesterday's and which are a fortnight old | |

**Risk: none.** Read-only over four tables, all healthy, all joinable.

### Tier 1 — make it a control *(days)*

| | unlocks | cost / risk |
|---|---|---|
| Inline + bulk multiplier edit through the existing `PATCH /placements` | the 3 unmanaged live campaigns at ≥150%, and the inversion, become fixable in one screen | **must first add actor/reason to that route** (`:640`) or every human change lands as `system` |
| `pinPlacement` as a row toggle | "hands off this campaign's placement" where the decision is made; route exists, audited | reuse, do not fork, the Control Room control |
| **The scale-back guard** (Perpetua's) — when a Top multiplier and up-and-down bidding compound, scale back by the maximum multiplier; expose it as a toggle; refuse only above a stated ceiling | closes the class of overspend while **0 campaigns violate it** — the cheapest guardrail this account will ever add | `strategyHeadroom` and `cpcCapPct` already exist; today they fire only when `maxCpcCents` is set |
| Fix the churn: `samePlacements` on the single-placement path | **24 campaigns**, 3,553 no-op rows, 15,342 live pushes/60d against a rate-limited API | 2 lines; the blend path already does it |
| Fix the shared `RuleListTab` lies — local-state edits, the delete that deletes nothing | **five tabs**, not just this one | shared file — needs a claim |

### Tier 2 — make the engine legible and steerable *(a decision)*

- **The plan behind the number**: each row expands to the 7×24 painting that decides its
  multiplier, hour by hour, linking to Rank & Dayparting rather than duplicating it.
- **Decide what the goals mean.** Either raise ceilings above the floors — at which point
  `targetISPct` and `acosCapPct` become live and the 30%/45% caps start binding — or delete the
  fields and rename the objects. Right now the schema comment on `maxBiasPct` still says
  *"null = 900"* (`schema.prisma:14635`), which the MP v2 controller changed to *"null = floor"*.
  **The stalest documentation in this system is inside the system.**
- **Expiring overrides** (Perpetua's primitive, `RankScheduleEvent`'s stated purpose, **0 rows**) —
  a placement push with an end date that reverts itself.
- **Delete `top-of-search-defense`** (§9).

### Tier 3 — the two things only we can build *(a decision)*

- **Page-one plans** (§8): lane allocation across the campaigns that share an ASIN, actuated
  through `RankTarget.lanes`, with the self-competition exemption. The engine, the schema and the
  editor are all shipped; what is missing is the plan object and the screen.
- **Placement dayparting** — hourly multipliers over the 17,963-row hourly table (study 1), which
  is what SellerMetrics, Zon.Tools and Xmars sell. Adopt SellerMetrics' stated discipline: a
  **14-day minimum** window, and Pacvue's **exclude the two most recent days** for attribution
  settling.

---

## 12 · Open questions

1. **The ceilings.** `maxBiasPct` is null on all five targets, so four of them cannot chase and
   their IS targets and ACoS caps are unreachable. Was set-and-hold the intent — in which case the
   goal fields should go — or did the MP v2 change silently convert five closed loops into five
   pins? Four `GALE | IT` schedules have ceilings set, so someone knew.
2. **The 144 unmanaged campaigns**, 40 live with the gate open. Bring them under the engine, or
   zero the residue and let the 23 governed ones be the whole story?
3. **The inversion — act or study?** Eight campaigns are measurably inverted and two of them are
   inverted *by the engine* (`IT-AIREON-SP-*` pinned at Rest 45% while Top returns 4.17×). The fix
   can only be "raise Rest / zero Top", never "lower Top".
4. **`GALE EXACT IT` at +300%, live, gate open, governed by nothing.** Deliberate or drift? (My
   earlier study called this the only live one; there are 11, but the other 8 are the engine
   holding 150% on purpose.)
5. **`top-of-search-defense`: I recommend deleting it** (§9). Confirm, and I will scope it as a
   removal rather than a build.
6. **Page one — is §8.3 the right shape?** It needs one new object and one exemption in the
   self-competition detector, and no new write path. Before I design it further I want to know
   whether "balance" is one control (a Top/Rest split) or per-lane numbers.
7. **The 9-day history.** Attribution began 2026-08-03. Fine to launch a change log that starts
   there and says so?

---

## Appendix — scripts

| script | measures |
|---|---|
| `_plc-page-state.mts` | the goal library and whether any target can chase · per-scope ceiling/lane overrides · ownership (governed vs residue) · `CampaignBidHistory` placement rows by lane/actor/direction · `AdvertisingActionLog` status, mode, actor, targetKey · placement-report freshness, label vocabulary, `topOfSearchIS` coverage, join integrity · strategy × Top-multiplier grid · pins · ASIN/campaign overlap per market |
| `_plc-page-attribution.mts` | the unattributed writes by day and campaign · audit-vs-history gap and no-op churn · per-campaign inversion against each campaign's own lane returns · what the 33 live schedules hold · the tab's rules and whether `defend_top_of_search` ever actuated · account-wide lane economics |
| `_plc-page-failures.mts` | the 133,959 rule executions by rule and status · the error distribution (one message, no null branch) · whether it is ongoing · account-wide context |

Read-only. `NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/<name>` from `apps/api`.
Earlier passes `_plc-study.mts` and `_plc-study2.mts` are unchanged.

### Sources

- [Using Bid Placement Modifier Rules to Succeed on Amazon — Pacvue](https://pacvue.com/blog/using-bid-placement-modifier-rules-to-succeed-on-amazon/) ·
  [Three Reasons Winning Top of Search Doesn't Matter — Pacvue](https://pacvue.com/blog/three-reasons-why-winning-top-of-search-doesnt-matter/) ·
  [Real-Time Automation & Optimization — Pacvue](https://pacvue.com/platform/real-time-automation-and-optimization/) ·
  [Pacvue pricing guide — Atom11](https://www.atom11.co/blog/pacvue-pricing-guide)
- [Multipliers and Interactions in Perpetua](https://help.perpetua.io/en/articles/9204011-multipliers-and-interactions-in-perpetua) ·
  [Placement Multiplier Behaviour in Perpetua](https://help.perpetua.io/en/articles/9230743-placement-multiplier-behaviour-in-perpetua) ·
  [Bid Adjustments — Perpetua](https://help.perpetua.io/en/articles/3634171-bid-adjustments) ·
  [Bid Adjustment vs Keyword Boost — Perpetua](https://help.perpetua.io/en/articles/9456605-bid-adjustment-vs-keyword-boost)
- [Scale Insights placement algorithm docs](https://docs.scaleinsights.com/docs/january-2024-release-notes) ·
  [Scale Insights Placement Rule Automation Setup Guide](https://www.youtube.com/watch?v=nQSQN2Pun18)
- [How to Calculate Bid Adjustment by Placement — Ad Badger](https://www.adbadger.com/blog/how-to-calculate-bid-adjustment-by-placement/) ·
  [Combining "Adjust Bids by Placement" and your keyword bid — Ad Badger](https://www.adbadger.com/blog/placement-bid-adjustment-with-keyword-bid-campaign-settings-amazon-ppc/)
- [Micro-Dayparting on Amazon — SellerMetrics](https://sellermetrics.app/micro-dayparting-on-amazon/) ·
  [25 Best Amazon PPC Software Tools 2026 — SellerMetrics](https://sellermetrics.app/amazon-ppc-software-review/) ·
  [SellerMetrics review 2026 — The Price Geek](https://www.thepricegeek.com/ppc-tools/sellermetrics-review/)
- [Rest of Search Bid Adjustment for Sponsored Products — Amazon Ads](https://advertising.amazon.com/resources/whats-new/improve-campaign-performance) ·
  [Amazon Placement Multipliers 101 — SellerApp](https://www.sellerapp.com/help/article/amazon-placement-multipliers-101/) ·
  [Amazon Placement Report: purpose and how to use them — ClearAds](https://clearadsagency.com/amazon-reports/amazon-placement-report-purpose-and-how-to-use-them/)
- [Shelf Intelligent Media — Skai](https://skai.io/capabilities/profitero-shelf-intelligent-media/) ·
  [Smarter Bidding with Shelf Intelligent Media — Profitero](https://www.profitero.com/product/shelf-intelligent-media)
- [Teikametrics pricing 2026 — Xneeti](https://xneeti.com/blog/teikametrics-pricing) ·
  [Top 12 Quartile Alternatives — AiHello](https://www.aihello.com/resources/blog/quartile-alternatives/) ·
  [10 Best Teikametrics Competitors 2026 — Atom11](https://www.atom11.co/blog/teikametrics-alternatives)
