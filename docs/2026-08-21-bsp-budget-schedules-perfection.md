# BSP-P — Budget Schedules perfection (study, 2026-08-21)

Target: the **Budget Schedules** tab of `/marketing/ads/rules-automation` **and its builder**
(`/builder/budget-schedule` → `_schedule/ScheduleBuilder.tsx`, `slug='budget-schedule'`).
Study 8 of the eleven-page Rules & Automation perfection programme, after BP (Bid), HP (Harvest),
NEG-P (Negatives) and BUD-P (Budget rules, shipping in a parallel session today).

**Phase 0 is read-only. Nothing was built, no prod state was touched.** The phase table at §6
awaits the operator's approval, one phase at a time.

Probes: `apps/api/scripts/_bsp-p0-{census,writers,hourly,market,delivery,delivery2,gate}.mts`.
Prod click-through: `nexus-commerce-three.vercel.app`, 2026-08-21 ~20:40 UTC.

---

## 1. What this tab actually is today

`page.tsx` → `BudgetSchedulesTabClient` → `SchedulesSection` — and **nothing else**. U8 (2026-08-18)
reduced the tab to Helium 10's §3.7 shape: one card in two parts (Hourly Campaign Performance +
the schedules grid).

Eleven of the twenty files in `budget-schedules/` are **PARKED — dead code with no importer**:

```
LIVE    page.tsx → BudgetSchedulesTabClient.tsx → SchedulesSection.tsx
                     └─ HourlyPerformanceCard.tsx · SectionShell.tsx (SectionEmpty only)
PARKED  BudgetSchedulesClient · PacingBand · PlanEditor · CalendarEditor · EnforcementPreview
        InspectorRail · BindingSection · CampaignBindingRail · CampaignLimitsModal
        usePlanWrites · scopeReach · planMath(+test) · urlState(+test) · slot-contract
```

Verified by grep for importers: `BudgetSchedulesClient.tsx` has **none**. The two vitest files on
this tab (`planMath`, `urlState`) therefore test **parked code only** — the live surface has
**zero tests**.

⚠ The parked files are a roadmap (`docs/2026-08-16-ra-parked-sections.md` sends them to Budget
Manager / Control Room). **This study does not propose reviving any of them** — that would be a
different page's decision. See §7.

### The three schedule worlds, and where they meet

The Phase 0 brief asked what a budget-schedule builder rule translates to in
`ads-rule-adapter.service.ts`. **Answer: nothing, and correctly so.**

| world | store | authored by | executed by | cadence |
|---|---|---|---|---|
| **Budget schedule (ours)** | `BudgetSchedule` (kind `BUDGET`) | `ScheduleBuilder` budget branch → `POST /advertising/budget-schedules` | `ad-budget-schedule.job.ts` | `*/15 * * * *` |
| Dayparting schedule | `AutomationRule` `actions[0].type='dayparting-schedule'`, trigger `SCHEDULE` | `RankGoalBuilder` (or `ScheduleBuilder` via `?style=classic`) | evaluator → `dayparting_apply` | evaluator ticks |
| Rank/dayparting bids | `AdSchedule` | Rank & Dayparting page | `ad-dayparting.job.ts` | own cron |

So a budget schedule **never becomes an `AutomationRule`**, never reaches the evaluator, and needs
no adapter branch. `ads-rule-adapter.service.ts` has no `budget-schedule` case — that is right, not
a gap. The BP.P2 schedule due-gate (`ads-rule-schedule.ts`) governs the *other* two worlds only.

🔴 One dead artefact: `RuleBuilder.tsx`'s `TRIGGER_BY_SLUG` carries `'budget-schedule': 'SCHEDULE'`,
but `builder/[type]/page.tsx` dispatches `budget-schedule` to `ScheduleBuilder`, never `RuleBuilder`.
The entry is unreachable. Cosmetic; `RuleBuilder.tsx` belongs to the BUD-P session — **not ours to
touch** (§7).

---

## 2. Census — prod, 2026-08-21

| fact | number | probe |
|---|---|---|
| **`BudgetSchedule` rows (all kinds)** | **0** | `_bsp-p0-census` |
| `ad-budget-schedule` cron runs | green, `evaluated=0 changed=0` on **every** tick | `_bsp-p0-census` |
| `AdSpendCeiling` rows | 0 (mechanism shipped, never used) | `_bsp-p0-census` |
| `AdBudgetPlan` rows for 2026-08 | 4 — IT €2,220 · DE €1,445 · ES €210 · FR €125 = **€4,000/mo = €129.03/day**, all `autoPacing=ON stopOverSpend=ON` | `_bsp-p0-census` |
| ENABLED campaigns | **70** (65 IT · 4 DE · 1 FR) | `_bsp-p0-delivery` |
| …at the €1 floor | **35** | `_bsp-p0-delivery` |
| …with a captured `budgetBaselineCents` | **21 of 70** | `_bsp-p0-gate` |
| …on the live-write allowlist | 67 of 70 | `_bsp-p0-gate` |
| `AD_BUDGET_UPDATE` rows, 7d | **398** — 395 by `automation:budget-manager-cron`, 3 by one rule | `_bsp-p0-delivery` |
| **…that actually reached Amazon** | **100 SUCCESS · 298 SKIPPED** (`campaign_allowlist` 238 · `budget_day_move` 60) | `_bsp-p0-delivery` |
| Busiest campaign, budget writes in 24h | **44** (`MOSS-Competitor-SP-KW-TM`) — one every ~33 min | `_bsp-p0-delivery` |
| `Campaign.deliveryStatus = NOT_DELIVERING` right now | **9 of 70**, e.g. `GALE PHRASE IT` → `["CAMPAIGN_OUT_OF_BUDGET"]` | `_bsp-p0-delivery2` |

### The hourly feed — the 2026-08-11 study's blocker is GONE

`AmazonAdsHourlyPerformance`: **2026-05-21 → 2026-08-21, 90 distinct days, 29,425 rows**, ~1,000
rows/day, 57–65 campaigns/day, unbroken for the last 14 days.

The BS page study of 2026-08-11 said the feed was dead 07-03 → 08-02, that eight complete days gave
**1.14 samples per weekday**, and that **"a 7×24 grid is not yet supportable; late September at the
earliest."** That is now **stale**: 60 days gives ~8.6 samples per weekday. **Do not carry the old
caveat forward.**

Its hour-of-day shape is also stale. Over the honest 60-day window the spend is broad, not
evening-only, and peaks at **h22 €192.10** (Rome):

```
h09 €103  h10 €96   h11 €132  h12 €167  h13 €124  h14 €156  h15 €161
h16 €170  h17 €169  h18 €151  h19 €169  h20 €154  h21 €168  h22 €192  h23 €131
```

**And the four markets disagree about when to spend** (`_bsp-p0-market`):

| market | 60d spend | top three hours (Rome) |
|---|---|---|
| IT | €1,808 | **h22 €142** · h12 €128 · h17 €124 |
| DE | €562 | **h18 €53** · h21 €46 · h19 €43 |
| ES | €132 | **h15 €13** · h14 €12 · h16 €11 |
| FR | €77 | **h19 €8** · h12 €5 · h00 €5 |

---

## 3. 🔴 The headline: three ways this page states something that is not true

### 3.1 The chart draws "no sales at all" as "0% ACoS" — the account's worst hours look like its best

`GET /advertising/budget-schedules/hourly-performance` returns `acos: sales > 0 ? … : null`.
`HourlyPerformanceCard` types it `acos: number` and reads `Number(p[k2]) || 0`, so **`null`
becomes `0`**. Metric 2 defaults to **ACoS**, so this is the tab's default view.

Measured on prod by SVG geometry (not by reading source), 2026-08-21:

```
baseline y (value 0) = 168
ACoS points sitting exactly on it: hours 3, 6, 7
their tooltips: "3AM · Spend €11 · ACoS 0%"
                "6AM · Spend €29 · ACoS 0%"
                "7AM · Spend €61 · ACoS 0%"
```

Those three hours have **zero attributed sales in 60 days**. €61 spent at 7AM returning nothing is
drawn as the flattest, most efficient point on the chart — the exact opposite of the truth, on the
one screen whose purpose is deciding which hours deserve budget.
Same class as `reference_sov_zero_vs_rounding`: a null is not a zero.

### 3.2 The builder's "Period" is a hard-coded date range that does not overlap reality

`ScheduleBuilder.tsx:~420`:
```tsx
<span className="h10-sb-date wide"><Calendar/><input value="04/18/2026 - 06/16/2026" readOnly aria-label="Period" /></span>
```
with an ⓘ reading *"The window of hourly performance data shown in the chart."*

The chart actually fetches `windowDays: '60'` → **2026-06-22 → 2026-08-21**. Read off the live DOM:

```
statedWindow  : "04/18/2026 - 06/16/2026"   readOnly: true
realWindow    : 2026-06-22 → 2026-08-21
overlap       : ZERO days
```

A control that states a fact, is unchangeable, and is wrong by more than its own width.
It renders in **both** builder branches — see §7 for how the phase is scoped.

### 3.3 The market selector governs nothing on this tab

`BudgetSchedulesTabClient` renders `AdsPageHeader` with `markets={['IT','DE','ES','FR']}` and writes
`?market=`. Neither `SchedulesSection` nor `HourlyPerformanceCard` reads it; neither fetch carries a
marketplace param; `GET /advertising/budget-schedules` has no market filter and
`hourly-performance` **destructures `q.marketplace` and never uses it** (a defect shape already
named in `advertising-intel.routes.ts:2522`).

Proved on prod: with the header reading **"🇩🇪 Germany"**, the chart footer is byte-identical
(`Spend €192 peak · ACoS 396% peak`) and the first four tooltips are unchanged — €192 at 10PM is
**IT's** shape; DE peaks at 6PM with €53. The operator selects Germany, the header confirms
Germany, and the chart shows a curve true of no market.

---

## 4. 🔴 The wire question — what the builder stores vs what any engine reads

`ad-budget-schedule.job.ts` is the **only** reader of a `BudgetSchedule` row.

| field the builder writes | read by the executor? |
|---|---|
| `name` | no (display only — fine) |
| `type` (`campaign-budget` / `budget-multiplier`) | ✅ `computeBudget` |
| `campaigns[]` | ✅ (`id`, and `dailyBudget` as base fallback) |
| `windows[] {day,start,end,adj,value}` | ✅ `activeWindow` + `computeBudget` |
| `startDate` / `endDate` / `neverExpire` / `excludeDates[]` | ✅ `dateActive` |
| `chartPrefs {metric1,metric2,groupBy,daysFilter}` | display pref; re-read only by the builder |
| **`timezone`** | ✅ read by the executor — but **the budget branch never sends it**; the route defaults `'Europe/Rome'`. No timezone control renders for budget (H10 §4.5 has none either), so this is a defaulted value, not an unread control. Honest, but undisclosed on screen. |
| **`autoRefill`** | ❌ **zero readers anywhere.** The column accepts it, the route accepts it, the builder never sends it, nothing reads it. BSP.2 removed the grid column deliberately. **Refusal upheld** (§7). |

So the tab is *not* the usual "the builder collects the whole form, the engine honours a fraction".
The signature defect appears here in **two inverted forms** instead:

### 4.1 The engine can do something the builder cannot say

`activeWindow` supports an **all-day window** — `if (!w.start || !w.end) return wDay === day` —
which is exactly what H10's second radio promises: *"Budget Multiplier — Set up a **daily** schedule
to adjust your campaign's budget multiplier."*

But `winComplete` requires `w.start && w.end`, and clicking **Budget Multiplier** on prod leaves the
row controls **byte-identical** (`Start time="Select time" · End time="Select time" · Adjustment
type`). Measured live. So the daily branch is **unreachable from the only authoring surface**, and
the radio's own description is a promise the form cannot keep.

### 4.2 A recorded "applied" is not a landed write — and the memo makes it permanent

The executor's guard order (`:131`–`:132`):

```js
if (live === target)              { nextLast[c.id] = {budget: target}; continue }   // reality
if (last[c.id]?.budget === target){ nextLast[c.id] = {budget: target}; continue }   // the memo
```

Consequence, on this account: the boost is written **once**; `budget-manager-cron` overwrites the
campaign within ~33 minutes (44 writes/day on the busiest); on the next tick `live !== target` but
`memo === target`, so the schedule **skips — and keeps skipping for the rest of the window**.
`nextLast` carries the target forward, so it never recovers until the window's target changes.

The code says this is deliberate ("whether this schedule should re-fight them is the §3 precedence
decision, which is the operator's"). **The decision being open is fine. The screen asserting the
opposite is not** — the Status pill's tooltip reads *"In its date range — the weekly windows decide
each campaign's budget right now."*

Two more layers under the same word "applied":

- **`updateCampaignWithSync` fails by RETURN VALUE, not by throwing** (`ok:false, error:'not_found'`
  — [[reference_mutation_outcome_returned_not_thrown]], landed today). The executor (`:134`) and
  `bsRestoreBase` (`advertising.routes.ts`) both `await` it bare, under `as never`. Here the job
  pre-checks the campaign with `findUnique`, so `not_found` is currently unreachable — this is a
  **latent** defect, not a live one, and this study will not overstate it. It is still the wrong
  shape and one refactor away from silence.
- **Even `ok:true` only means "written locally and queued".** The gate runs later, in the worker.
  Prod, 7d: **298 of 398 budget writes were SKIPPED** — never reached Amazon — while
  `Campaign.dailyBudget` and `lastApplied` recorded them as done. A budget schedule's whole purpose
  is a large intraday jump, and `budget_day_move` denies exactly that: −30% / +50%-or-€10 per UTC
  day on **total movement across every writer**. Worked example on today's data: a 18:00 "double the
  budget" window on `IT-AIREON-SP-Auto` (€6.17) lands (ceiling €16.17); the same window on
  `GALE PHRASE DE` (€80.00) is **denied** (ceiling €120, intent €160) — and the schedule memoises it
  as applied and never retries.

### 4.3 A budget schedule is an anonymous job in the Change Log

The executor writes actor `automation:budget-schedule-<id>`. `parseActor` (`ads-changes.service.ts`)
knows `rank-defend-` → `schedule`, `rank-plan-` → `plan`, `rule-`/bare-cuid → `rule`, and everything
else falls to **`kind:'job'`, `id: null`, `name: "budget schedule cx…"`**. Because the id is
dropped, `originId` filtering can never target a budget schedule, so **a schedule cannot be linked
to its own changes** — while the dayparting world is a first-class origin. Same defect class SG.0
fixed for rules.

The tab's own CRUD audit rows (`budget_schedule_create/update/delete`, written since BSP.2) have
**no reader anywhere** in api or web.

---

## 5. Gap matrix

Legend — **K** keep · **F** fix · **B** build · **R** refuse.

| # | | item | evidence |
|---|---|---|---|
| K1 | **K** | H10 §3.7 two-part shape, grid columns, `Start Date ⇅ desc` default | matches the frame study |
| K2 | **K** | `Status` column (toggle + Scheduled/Active/Completed/Off) — beyond H10, honest | W4 |
| K3 | **K** | DELETE/disable restore base budgets; confirm-before-delete; failed delete keeps the row | W4, route read |
| K4 | **K** | Exclude ranges: real `[{start,end}]`, end-day inclusive, boolean-era rows ignored | W4 + `dateActive` test |
| K5 | **K** | Midnight-wrap windows (`23:00 → 00:00` reaches hour 23) | BSP.2 §2.1 |
| K6 | **K** | Base precedence: captured baseline ▸ creation snapshot ▸ live | BSP.2 §2.5 |
| K7 | **K** | `_schedule/CampaignSection` — shared, with H10's All/Enabled/Paused status filter | verified on prod |
| K8 | **K** | Builder chart is real, campaign-scoped, Group By re-buckets (24 bars → 7: Mon…Sun) | measured on prod |
| K9 | **K** | `broke` vs empty states are distinguished; a failed fetch says so | BSP.0 |
| F1 | **F** | **ACoS null rendered as 0%** — 3 of 24 hours; €61/h at 7AM with zero sales drawn as the best hour | §3.1, SVG geometry |
| F2 | **F** | **Period control hard-coded** `04/18/2026 - 06/16/2026`, zero overlap with the real 60-day window | §3.2, live DOM |
| F3 | **F** | **Market selector inert** on both the grid and the chart; the chart merges four markets whose peaks differ by up to 4 hours | §3.3, measured |
| F4 | **F** | **Budget Multiplier's "daily schedule" is unreachable** — the executor supports an all-day window, `winComplete` forbids it | §4.1, measured |
| F5 | **F** | **The memo laundering** — one competing write defeats the schedule for the rest of the window, silently, while the pill says the opposite | §4.2 |
| F6 | **F** | **`.ok` unread** on both `updateCampaignWithSync` call sites (latent, `as never`) | §4.2 |
| F7 | **F** | Budget schedules are anonymous in the Change Log (`id: null`); their CRUD audit rows have no reader | §4.3 |
| F8 | **F** | `todayIso` for the Status pill is **UTC**; between 00:00 and 02:00 Rome a schedule that ended yesterday still reads **Active** | `SchedulesSection:121`, `reference_day_grouping_utc_local_trap` |
| F9 | **F** | The grid shows only the **first** blackout range; the route returns `excludeRanges` (a count) and the client drops it — partial truth shown as whole | route + client |
| F10 | **F** | Empty state says *"Hourly data is not available for this marketplace"* when the real cause is "these campaigns have no hourly rows" | builder + card |
| B1 | **B** | **Delivery truth per schedule**: did the window's write reach Amazon? Reuse `listChanges` (`delivery.state/attempts/lastError`) + deep-link, do not build a second feed | 298/398 SKIPPED |
| B2 | **B** | **Out-of-budget now**: `Campaign.deliveryStatus=NOT_DELIVERING` + `deliveryReasons=["CAMPAIGN_OUT_OF_BUDGET"]` is already synced, 9 of 70 live, and this page owns "out-of-budget hours" — currently shown nowhere | `_bsp-p0-delivery2` |
| B3 | **B** | **7×24 weekday heatmap on the tab**, now that 90 days exist — coloured by **spend or clicks, never ACoS/CVR** (60 orders over 168 cells). Closes competitor adopt-item #5 (weekday-aware budget) | §2 |
| B4 | **B** | **Precedence** — H10: *"Settings for the most recently created schedule apply if there are any time or state conflicts."* Ours has none: `findMany` with no `orderBy`, last-in-loop wins by accident | §4, H10 §5.2 |
| B5 | **B** | **Starters + census strip**, the idiom every other tab gained (`.h10-hv-cohort`-class strip: live numbers + links, absent-not-fabricated on a failed fetch) | BP/HP/NEG/BUD-P |
| B6 | **B** | Tests for the live surface: `activeWindow` (unexported, untested — the wrap logic), status derivation, the ACoS-null contract | §1 |
| R1 | **R** | Auto Refill column | `autoRefill` has zero readers; a column permanently "Off" that would mean nothing "On" |
| R2 | **R** | Amazon-native budget rules | increase-only, SP-only, **hours-of-day geo-blocked in DE/ES/FR/IT** |
| R3 | **R** | Dayparting anything | RD's page and builder tree are off-limits by operator order |
| R4 | **R** | Reviving PacingBand / PlanEditor / ceilings / the monthly plan | parked deliberately, headed for Budget Manager & Control Room |
| R5 | **R** | Rule-shaped criteria on this tab | a budget schedule is a `BudgetSchedule`, not an `AutomationRule`; BUD owns permission-to-act |
| R6 | **R** | Recovering the 35 floored campaigns here | that is a monthly-plan decision (BUD.8 handed it to this page) and the restore envelope is brutal — see §7 |

---

## 6. Proposed phases — **awaiting approval, one at a time**

| phase | size | what it does | files (all clean as of this study) |
|---|---|---|---|
| **P1 — the chart stops lying** | **S** | ACoS `null` stays null: not plotted, gap in the line, tooltip "no sales". Real Period range on the builder (F2). Empty-state copy says which cause (F10). Y-axis units. | `HourlyPerformanceCard.tsx`, `ScheduleBuilder.tsx` (budget-gated, see §7), route `acos` typing |
| **P2 — the market selector binds** | **S/M** | `marketplace` threaded to both fetches; `hourly-performance` uses the param it already destructures; the grid filters on `campaigns[].marketplace`; the card names the market it drew. | `SchedulesSection`, `HourlyPerformanceCard`, `advertising.routes.ts` (budget-schedule block only) |
| **P3 — one truth about "applied"** | **M** | Read `.ok` on both call sites (F6). Separate *written* from *delivered*: a per-schedule delivery reading from `listChanges`, and `automation:budget-schedule-<id>` becomes a first-class Change-Log origin (F7 — **needs coordination**, §7). Status pill stops claiming the windows are in force when the last write did not land (F5). | `ad-budget-schedule.job.ts`, `advertising.routes.ts`, `ads-changes.service.ts` ⚠, `SchedulesSection` |
| **P4 — the form can say what the engine can do** | **M** | Budget Multiplier gets its daily (all-day) grain (F4). Blackout ranges: show all, or say how many (F9). Status day key becomes local (F8). Precedence made explicit and deterministic — most-recently-created wins, stated on screen (B4). | `ScheduleBuilder.tsx` (budget branch), `SchedulesSection`, `ad-budget-schedule.job.ts` |
| **P5 — the two things the data now supports** | **M/L** | 7×24 weekday heatmap on the tab, spend/clicks only (B3). "Out of budget now" reading from `deliveryStatus` (B2). Census strip + starter schedules built from *this* account's measured hours (B5). Tests (B6). | `budget-schedules/*` (new components → DS if reusable), one new service file |
| **P6 — arming** | **S** | Present one starter schedule sized against the day-move gate, on an allowlisted campaign with a captured baseline. **Creating it is the operator's click, not mine.** | — |

Sequencing rationale: P1–P2 remove false statements (cheapest, highest honesty return, zero engine
risk). P3 is the programme's signature and must precede anything that *creates* a schedule. P4 closes
the authoring gaps. P5 builds. P6 only after the delivery truth is visible — arming a schedule while
298 of 398 budget writes vanish would manufacture exactly the kind of silent failure this programme
exists to end.

---

## 7. Refusals, boundaries and coordination

**Shared files.** `_schedule/ScheduleBuilder.tsx` is shared with the Dayparting builder
(`?style=classic`), and RD is off-limits. Every P1/P4 edit is gated to the `!isDayparting` branch —
**except F2 (the Period control)**, which renders in both and is false in both. I will not "slip it
into a phase": it is presented here as its **own decision**, three options —
(a) fix it for budget only and leave dayparting stating a false window;
(b) fix it in the shared control (identical correction, touches the dayparting render path);
(c) leave both. **My recommendation is (b)** — it is a correction of a false statement, not a design
change, and (a) leaves a known lie standing.

**`ads-changes.service.ts` (P3/F7)** is on the concurrent-sessions dirty list. The fix is two
additive lines (`['budget-schedule-', 'schedule']` in `typed[]`, plus a `budgetSchedule` lookup in
`resolveOrigins`). I will `ListAgents` + `SendMessage` the owning session before touching it, and
will design P3 to work without it if they say no.

**Not mine, confirmed:** `RuleBuilder.tsx` / `TRIGGER_BY_SLUG` (BUD-P), `PerformanceCriteria.tsx`,
`ads-rule-adapter.service.ts`, `advertising-rule-evaluator.job.ts`, `ads-rule-window.ts`,
`automation-action-handlers.ts` (SG), `AdsDataGrid.tsx`, `rules-automation.css` shared moves.
None of my phases requires an edit in any of them.

**R6 — the 35 floored campaigns.** BUD.8 handed the recovery here as a monthly-plan decision. The
plans total **€129.03/day of envelope** against 70 enabled campaigns; the pacer floored 56 of 58 in
one hour once already; and `budget_day_move` caps a same-day recovery at +€10 or +50%. A schedule is
the wrong instrument for it and this study **refuses to attempt it** — it belongs to the parked
Budget Manager work, with the operator's envelope decision first.

**R2 restated for this page.** Native budget rules cannot decrease, cannot touch SB/SD, and their
hours-of-day flavour is available only in US/CA/UK/IN/JP — **not one of IT/DE/ES/FR**. Everything
this tab does must stay in our own engine.

---

## 8. Corrections to earlier documents

- `docs/2026-08-11-bs-budget-schedules-page.md` §3: *"a 7×24 grid is not yet supportable; late
  September at the earliest"* — **superseded.** 90 days / 29,425 rows now exist (§2).
- Same doc's evening-heavy shape (19:00–23:00 = 33.7% of spend) was measured across the dead month;
  the honest 60-day window is broad from 09:00 with a single peak at **h22** (§2).
- Same doc's live-defect list: the 23:00 hole, midnight-crossing windows, the boolean `excludeDates`
  and the memoised-failure are all **fixed** (BSP.2 + W4). `autoRefill`'s zero readers and the
  creation-time base snapshot **stand** — the latter now bounded by the captured baseline, which
  **21 of 70** campaigns have.
- The tab was described as ~20 files of sections; **11 of them are parked dead code** (§1).

---

# BUILD RECORD — P1–P5 built and locally verified, 2026-08-21

Approved by the operator as a set ("go ahead") after the study above. **P6 (arming) is NOT done —
creating a schedule is the operator's click.** Nothing is committed; nothing on prod was changed.

## What shipped, by phase

| phase | change | file |
|---|---|---|
| **P1** | ACoS `null` is `null` end to end: the line BREAKS at an unmeasurable bucket, an isolated point becomes a dot, tooltips say "no sales", the footer counts them | `HourlyPerformanceCard.tsx`, route |
| P1 | Both value axes labelled (left = Metric 1, right = Metric 2). The chart had three unlabelled gridlines and no magnitude | `HourlyPerformanceCard.tsx`, css |
| P1 | Full-height transparent hover target per bucket, so a bucket with no bar still answers a hover | `HourlyPerformanceCard.tsx` |
| **P1** | The builder's **Period** is derived from `CHART_WINDOW_DAYS`, the same constant the fetch uses | `scheduleConfig.ts`, `ScheduleBuilder.tsx` |
| P1 | Empty states name the real cause ("None of the N selected campaigns reported hourly performance in the last 60 days" / "No hourly performance for DE between X and Y") | both |
| **P2** | `marketplace` threaded to both fetches; `hourly-performance` uses the param it already destructured; the list filters on `campaigns[].marketplace`; a `Markets` column; the empty label says what a market filter hid | `SchedulesSection.tsx`, `HourlyPerformanceCard.tsx`, `BudgetSchedulesTabClient.tsx`, routes |
| **P3** | Both `updateCampaignWithSync` call sites READ `.ok`; the two `as never` casts are gone | `ad-budget-schedule.job.ts`, `advertising.routes.ts` |
| **P3** | `lastApplied` gains `state` (`applied`/`held`/`yielded`/`refused`/`failed`) + `live` + `actionLogId` + `outboundQueueId`. **Additive — no migration**; `budget` stays the churn key every existing reader uses | job |
| **P3** | A **Delivery column** reading `OutboundSyncQueue`, in ONE query for the whole page. "applied" (local + queued) and "at Amazon" are now different words | route `bsDelivery`, `SchedulesSection.tsx` |
| **P3** | The Status pill can say **"Active · not in force"**. It used to assert unconditionally that "the weekly windows decide each campaign's budget right now" | `scheduleState.ts` |
| **P3** | `automation:budget-schedule-<id>` is a first-class Change-Log origin (`kind:'schedule'`, id preserved), so `originId` can target a schedule | `ads-changes.service.ts` |
| P3 | The cron summary carries `yielded=` and `refused=`; PATCH/DELETE return what the restore actually did | job, route |
| **P4** | **Budget Multiplier is authorable as the daily schedule its own radio promises** — all-day chip instead of hour selects, `winComplete` relaxed, and stale hours dropped on the type switch | `ScheduleBuilder.tsx` |
| **P4** | Deterministic schedule precedence — `orderBy: createdAt asc`, so the newest schedule writes last and wins, which is H10's stated law | job |
| P4 | Status pill uses a **local** day key; the Exclude column shows `+N` when there are more blackout ranges | `scheduleState.ts`, `SchedulesSection.tsx` |
| **P5** | **Day-of-Week grouping on the tab** (`groupBy=weekday`, plus a `cell` grain for a future 7×24 view) — closes competitor adopt-item #5 | route, card, `SchedulesSection.tsx` |
| **P5** | **The census strip**: enabled · at-floor · with-baseline · **out of budget right now** (Amazon's own `CAMPAIGN_OUT_OF_BUDGET`) · budget writes 24h vs delivered vs blocked · **the day-move ceiling**. Absent-not-fabricated | `ScheduleContextStrip.tsx`, route `/context` |
| **P5** | Tests: `activeWindow` exported + 6 cases (wrap, post-midnight weekday, degenerate, all-day, overlap order, empty); `scheduleState` 19 cases; `chartWindowLabel` 4 cases | 3 test files |

## Verification

- `tsc` clean in **both** trees.
- **api vitest 5,052 passed / 391 files.** **web vitest 945 passed**; the 8 failing FILES are the
  known Playwright-under-vitest baseline (`tests/*.spec.ts`), none in this target.
- Ratchets all at baseline: button-vocabulary **286**, silent-disabled **27**, help-cursor **0**,
  ds-conformance-guard pass, p3-token-sweep **0**.
- **Local rig** (`_bsp-verify-stub.mts`, :8097 + dev :3007): `hourly-performance` and `/context` run
  the REAL SQL against prod Neon; the schedule list is fixtures because prod has 0 rows.

Measured on that rig, not inferred from the diff:

- **The ACoS gap is real geometry**: 3 line subpaths, hours **3, 6, 7** absent from every subpath,
  tooltips `"7AM · Spend €61 · ACoS no sales"`. Footer: *"3 of 24 hours had no attributed sales, so
  ACoS is undefined there and is left as a gap — not plotted as zero."*
- **The market selector binds**: switching to Germany changed the strip to "4 enabled campaigns in
  DE · 1 at the €1 floor · 3 with a captured baseline · 0 out of budget", the chart peak from €194
  to **€53 at 6PM** (DE's real shape, vs IT's 10PM), the footer to "DE", the gap count to **12 of
  24**, and the grid to "Viewing 1-3 of 3 Schedules". Two isolated dots rendered, proving the
  single-point branch.
- **Period** reads `06/22/2026 - 08/21/2026` — the real window, `aria-readonly`, titled "Fixed at
  the last 60 days".
- **Budget Multiplier**: picking 9:00 AM–5:00 PM under Campaign Budget and *then* switching type
  produced a payload of `{day:1, start:"", end:"", adj:"mult", value:1.5}` — the stale hours were
  dropped, and `activeWindow` (now tested) reads that as all-day.
- **Day of Week**: 7 bars Sun–Sat, DE peak **€115 on Monday**.
- Contrast, measured against each element's OWN background: delivery pills **5.95 / 9.18 / 5.31**,
  status pills **5.76 / 5.96 / 4.78**, `unknown` **5.31**, `+2` **5.88**, strip link **5.43**
  (opacity 1, `display:inline` — the `.h10-hv-cohortline .h10-nt-open` pair, not the bare class).
  🔴 Two new dimmed labels first measured **3.72** and were darkened `#7c8595 → #626c7c`.
- `cursor:help` count **0**. No horizontal body scroll.

## 🔴 Commit hazard to hand forward — TWO shared files, not one

Both are uncommitted work from other live sessions sitting in the same file as mine. Neither is
broken; both must be **blob-split** at push time (`git show HEAD:<file>` + only-my-edits, verified
with `git diff --no-index -a`) or the push ships someone else's unfinished work.

| file | mine | NOT mine |
|---|---|---|
| `rules-automation.css` | BSP-P1 ~5451–5467 · BSP-P4 ~5481–5484 · BSP-P3 ~5486–5500 | **BUD-PP** `.h10-rb-prev .ptable.budp …` ~5469–5479 (Budget session) |
| `advertising.routes.ts` | the budget-schedules block, ~8917–9316 | **SG.9** mute/unmute — an import near line 70 and routes/batch-verbs ~6848–6957 (Suggestions session) |

`ads-changes.service.ts` (4 hunks) and every other file in the change set are **entirely mine** —
checked hunk by hunk, not assumed. The Suggestions session has confirmed it has nothing pending in
any file I touched; the SG.9 hunks belong to a third session.
See `reference_git_shared_tree_commit_safely` + `reference_shared_index_phantom_reversal`.

## Late correction (2026-08-22) — `.ok` is a three-way answer

Checked against the source after a peer session raised it, and it changed two lines of my own code.
`updateCampaignWithSync` (:591–:749) has exactly three returns: `{ok:false,'not_found'}` (:618),
**`{ok:TRUE,'no_changes'}`** (:679), and `{ok:true,null}` (:749). So:

- **`.ok` does not mean "something changed".** A no-op diff is `ok:true` and enqueues nothing, so
  `outboundQueueId` is null. My executor would have recorded that as `applied`, and `bsDelivery`
  maps an `applied` row with no queue handle to `unknown` — parking it at **"in flight" forever**,
  waiting on a queue entry that will never exist. Now branched explicitly to `held`. Reachable only
  by a race against the loop's own `live === target` check, but "rare" is exactly how the memo
  laundering got in. `bsRestoreBase` got the matching branch so its `restored` count cannot
  overstate what it gave back.
- **`entity_orphaned` is not in this helper** — it is `updateAdGroupWithSync` (:787). The service
  family has 12 `ok:false` sites across all helpers; per-helper contracts differ.
- The gate-denial point in §4.2 stands and is the important one: `WRITE_GATE_DENIED` appears only in
  `workers/ads-sync.worker.ts`, so a denial is invisible to the helper and `ok:true` means queued.

`reference_mutation_outcome_returned_not_thrown` (written by another session) asserted that a
refused write and a no-op both return `ok:false`. Both halves are wrong and the file has been
corrected in place, because as written it taught that checking `.ok` covers a gate denial — the one
belief that would let someone "fix" a caller and still ship a lie.

---

# BSP.6 — THE PRECEDENCE RULE, decided and built (2026-08-22)

Operator's decision, after weighing "copy Helium 10" against the recommendation below.

## What H10 does, and why it does not reach this

H10 publishes two precedence rules (§5.2), and only one of them applies here:

| H10's rule | scope | our answer |
|---|---|---|
| *"Settings for the most recently created schedule will apply if there are any time or state conflicts."* | schedule vs schedule | **Adopted** — `orderBy: createdAt asc` (P4), newest writes last and wins |
| *"…same direction → a greater change… not in the same direction → no suggestion will be made or automatically applied."* (release note 2024-06-20) | criteria vs criteria **inside one rule** | **Refused for this case** |

🔴 **H10 has no pacer.** There is no monthly-envelope engine in their product, so schedule-vs-pacer
is a conflict that cannot arise there — copying rule 2 means applying a criteria-conflict rule to an
engine conflict it was never written for. And it fails on the numbers: the pacer **raised 18 and cut
18** campaigns in the last 24h (`_bsp6-precedence.mts`), so "opposite direction → do nothing" would
decide an evening lift's fate on a coin flip unrelated to its merits.

## The rule, as built

> **A schedule owns a campaign only while its own window is open. It writes ONCE per window entry.
> When the window closes it gives the budget back exactly once, then leaves the campaign alone. If
> another writer moves a budget mid-window, the schedule stands down for the rest of that entry and
> RECORDS WHO.**

Why yield rather than re-fight — two independent reasons:
- **Authority.** `AdBudgetPlan` (€4,000/month) decides how much money exists; a schedule is a shape
  within it. An instrument overriding its own authority is incoherent.
- **Mechanics.** `budget_day_move` caps *cumulative* daily movement across every writer at
  −30%/+50%-or-€10. An oscillation spends that allowance in a few ticks and then blocks **both**
  engines for the rest of the day. 41% of the audit chain is already broken from exactly this.

Measured context (`_bsp6-precedence.mts`): envelope €4,000 · spent €2,128.97 by day 21 vs €2,709.68
expected → **under pace**, €170.09/day remaining against ~€100/day actual. So the pacer is not
defending a breached budget; it is shaping toward a target it is currently beating.

## Three behaviour changes, each deliberate

1. **`windowKey` replaces the value memo.** `<entryDate>#<windowFingerprint>` while open,
   `<thatKey>#restore` for the give-back. The old `last.budget === target` guard behaved like
   "once per window" only because the end-of-window restore reset it — **any day that restore was
   blocked, the next day's window silently did nothing.** Behaviour that is accidentally correct
   stops being correct without anyone noticing.
2. 🔴 **Outside a window with nothing owed, the schedule does not write at all.** It used to assert
   `base` every tick, which moved budgets *before a new schedule's first window had ever opened* and
   re-fought the pacer forever over campaigns it was not even boosting. The give-back still happens
   — once, keyed to the entry it is giving back. `bsRestoreBase` (delete/disable) is a separate
   mechanism and is untouched.
3. **A yield is attributed.** `AdvertisingActionLog.userId` identified the last writer for **36 of
   36** campaigns touched in 24h, resolved in ONE batched query per schedule plus one rule-name
   lookup. `classifyOverride` → `pacer` / `rule` (by name) / `operator` / `schedule` / `job`.

## Delicacy notes — the things that would have gone wrong quietly

- **The entry date is the SCHEDULE's timezone**, from `nowInTz`, never UTC or server-local.
- **A wrapping window is ONE entry across midnight.** `23:00 → 02:00` on Friday keeps Friday's
  `entryDate` at 01:30 on Saturday; keying on "today" would have made midnight a second entry and
  written twice for one window. `prevDate` does plain calendar arithmetic, so a 23-hour
  spring-forward day cannot shift it.
- **The fingerprint is content, not index** — adding an unrelated row does not re-trigger a window;
  editing the window itself does.
- **A refused or failed write does NOT commit the entry key**, so it retries; a `no_changes` does,
  because the entry is satisfied.
- **A stale `overriddenBy` is never carried forward** — it is stripped before re-resolution, so a
  yield we cannot attribute this tick shows as unattributed rather than blaming last tick's writer.
- **`lastApplied` on `AdSchedule` is a different field with a different type** (`'PAUSED'`/`'ENABLED'`
  strings, dayparting/RD). Audited: `BudgetSchedule.lastApplied` has exactly three readers, all in
  this target. Nothing in RD's tree was touched.
- **Punctuation, caught on the rendered screen**: the Status tooltip read *"…rather than
  re-fighting.. See the Delivery column."* `describeYields` now returns a clause with no trailing
  period and every caller punctuates; a test asserts no tooltip contains `..`, a double space, a
  dangling separator, or `undefined`.

## Verification

- api vitest **5,072 / 392 files** · web vitest **954** (8 Playwright spec files = known baseline).
- **+20 api tests**: entry-key stability across ticks · the wrap staying one entry · next-day
  re-arm · edit-changes-key · unrelated-row-does-not · all-day daily key · tz-not-UTC ·
  `classifyOverride` × 6.
- **+9 web tests**: attribution prose, the all-operator "held by you" word, status/delivery telling
  the same story, and the punctuation guard.
- Ratchets at baseline (286 / 27 / **0** / pass / 0). Contrast on the rig, own-background:
  delivery pills 5.31–9.18, status pills 4.78–9.18, no clipping, no horizontal scroll,
  `cursor:help` **0**.
- All nine schedule states rendered together on the rig: `4 yielded` (3 to the pacer, 1 to a named
  rule) · `2 not at Amazon` · `2 at Amazon` · `in flight` · `1 refused` · `—` · `nothing to do`
  (Completed and Off) · **`2 held by you`**.

## Deliberately NOT built

Item 3 of the recommendation — a per-schedule `reassertOnce` for the under-pace case — was offered
as optional and is **not built**. It is the only remaining lever if the operator later finds
schedules losing too often, and it should be armed on evidence, not in advance.

## Still open after P1–P5

- **P6 arming** — the operator's click. The rig shows what a schedule will look like; prod still has
  **0 `BudgetSchedule` rows**.
- **The precedence question itself is still the operator's.** P3 makes a `yielded` stand-down
  visible; it does not decide whether a schedule should re-fight the pacer. That is BSP.6.
- The `cell` (7×24) grain is served but no heatmap view is mounted on the tab yet; `DaypartingHeatmap`
  is ready to take it unchanged.
- `TRIGGER_BY_SLUG['budget-schedule']` is still a dead entry in `RuleBuilder.tsx` — BUD-P's file.
