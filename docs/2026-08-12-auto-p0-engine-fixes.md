# AUTO.P0 — the three live defects in the governance engine: execution record

*Opened 2026-08-12 against a brief written that morning. Landed 2026-08-16. Between those two dates
three parallel sessions fixed all three defects, which is most of what this record is about.*

---

## 0 · The one-paragraph version

The brief named three P0 defects. By the time I had finished measuring them, **CAP had armed the
daily-cap counter, A7 had given the write gate a durable refusal record, and BUD.2 had given budgets
the bid bounds' twin.** All three are real and all three are prod-verified below. What none of them
covered was the guard the brief called *"the one I most want"* — a bound on **cumulative daily
movement**, the only budget brake keyed to the entity rather than to a rule — and the **cap family's
refusal record**, which was left with no durable home at the exact moment the repaired counter began
refusing ~21,000 matches a day. Those two are what this session built. The approved cap table was
superseded by CAP's, which uses a sharper unit than mine, and was never applied.

**Landed:** `e121dc627` (guard ④) · `0f916ce56` (the refusal counter + migration `20260816a`) ·
`94c985738` (locks). The read path shipped inside PLC.3's `2373e5bb4` — see §6.

**Prod-verified 2026-08-15 23:32 UTC:** the first evaluator tick after the deploy recorded
**211 refusals across 16 rules**, each with its verbatim reason and the entity it was noticed on.
§5 has the measurement.

---

## 1 · Four things I measured that the brief had wrong

Recorded first because each one changed a decision, and because the brief itself asks for exactly
this: *"re-verify on prod before you change anything, because the numbers move daily and the whole
point of this session is that a stale-but-confident answer got it wrong once already."*

| the brief says | measured | consequence |
|---|---|---|
| *"The ratchet is running right now"* | **It had stopped.** Last budget-rule write **2026-08-10T02:30**; as of 2026-08-16 the last budget write of any kind is **2026-08-11T02:00** by the pacer. The two AUTO rules still evaluate and still return `SUCCESS` — `updateCampaignWithSync` returns `no_changes` because 58 of 86 campaigns sit at €1 and `Math.max(1, …)` makes −20% a no-op. | The stop-gap question changed from "stop a collapse" to "stop a re-ratchet". Operator answered **wait for the guards**. |
| *"a repeat-write loop — the write is queued to Amazon but the local `Campaign.dailyBudget` still reads the old value"* | **Local is written synchronously**, at `ads-mutation.service.ts:702`, before the enqueue. The reverter is **inbound sync**: `ads-v1-sync.service.ts:503` writes Amazon's stale budget back over an in-flight value with no check for one. | Guard ② is real but sits on the opposite side of the write. Still open — §7. |
| *"a digest rule genuinely needs 1"* | **No digest rule exists.** `Daily automation digest` runs `bid_to_target_acos` + `harvest_and_negate`. `Weekend budget boost` runs `bid_to_target_acos` and never touches a budget. | Two caps had been sized for a name rather than a behaviour. CAP found the same thing independently (its §7.4). |
| two refusal families — the cap and the gate | **Three.** `Reduce bids on ACOS spike` carries `maxValueCentsEur = 0`, so `0 >= 0` is true on its **first** action and **1,029 of 1,029** of its "failures" in eight days were refusals recorded as `status='FAILED'` with a **null** `errorMessage`. | A rule that is switched off reads as one that is catastrophically broken. §5. |

**Re-confirmed unchanged:** `payloadBefore/payloadAfter.dailyBudget` is **EUROS** (77 of 83 campaigns
match as euros, **0** as cents) · 488 `AD_BUDGET_UPDATE` rows still `PENDING` · 58 of 86 at the €1
floor · €318.57/day total.

---

## 2 · What the parallel sessions landed, verified rather than taken on trust

| defect | commit | measured on prod |
|---|---|---|
| **P0.1** the cap counter | `6ce492420`, 2026-08-14 18:28 UTC | ✅ On **2026-08-15**, the first complete post-fix UTC day, **16 of 16 capped rules sat at exactly their cap, 0 over**. The null branch is now a shared `notCapRefusal()` in `automation-cap-predicate.ts`, so the page and the engine read one predicate — the fix for the second-order bug where a panel kept its own copy of the clause and went on calling the counter broken for hours after it worked. |
| **P0.3** gate refusals | `d5fff1a6d` (A7) | ✅ `AdWriteRefusal`, written **inside** `logGateDeny` so no caller can forget it. 112 rows, all `entity_bounds`. |
| **P0.2** the ratchet | `10ab26208` (BUD.2) | ⚠️ Partial. `budgetBaselineCents` makes a relative cut idempotent; `minBudgetCents`/`maxBudgetCents` are denied at the gate. |

### 🔴 The window artefact, which I walked into after quoting it

My first verification run reported **"0 rules held at cap"** and I was one step from reporting the
repaired counter as broken. I had measured **2026-08-14** — the day the fix landed at 18:28 UTC, so
five-sixths of it is pre-fix. `6416ff821` documents this exact trap (*"the caps ARE binding; the
evidence against them was a window artefact"*), and I had read it before running the probe.

`_auto-p0-verify.mts` now refuses to be used that way: it takes a day as `argv[2]`, and prints a
warning naming the fix timestamp when asked about a window that spans it. **A probe that can produce
a confident wrong answer should say so on its own face rather than rely on its author remembering.**

---

## 3 · Guard ④ — a budget's daily MOVEMENT, bounded across every writer

`e121dc627` · `ads-write-gate.ts` · new `GateDeniedAt: 'budget_day_move'`

Every other budget brake bounds **one actor**: `maxExecutionsPerDay` and `maxWritesPerDay` bound a
rule's rate, `maxDailyAdSpendCentsEur` bounds a rule's spend, a spend ceiling bounds a scope's
increases. None of them bounds what actually happened:

```
2026-08-09 23:00  budget-manager-cron   €2.83 → €5.52   ↑ the pacer raises
2026-08-09 23:00  Campaign ACOS rebal.  €5.52 → €4.42   ↓ a rule cuts it back, same minute
2026-08-09 23:15  Campaign ACOS rebal.  €4.42 → €3.54   ↓
2026-08-09 23:30  budget-manager-cron   €3.54 → €5.52   ↑ the pacer raises again
2026-08-09 23:30  Campaign ACOS rebal.  €5.52 → €4.42   ↓ …every 15 min, to €1.00 by 02:30
```

**Two writers taking turns, each inside its own limit the entire time.** A per-rule brake cannot see
that; a per-entity one does not need to. CAP §6.5 reached the same conclusion independently: *"a cap
bounds the RATE of a ratchet, not its DESTINATION."*

**Defaults** (operator, 2026-08-16): **−30% down, +50% up**, per UTC day, reset at 00:00 UTC, both
env-tunable. The day's opening comes from the **earliest** `payloadBefore.dailyBudget` logged today —
A7's ledger, read the same way. Earliest rather than latest is deliberate: a mid-sequence break in
the **41%-broken audit chain** moves intermediate values, not the opening snapshot.

### 🔴 The rise allowance is not the operator's bare number, and why

A pure +50% ceiling would have made this guard **an accomplice to the damage it exists to prevent**.
58 campaigns sit at €1.00; restoring one to €10 is +900%, so a percentage-only bound refuses the
repair. Percentages stop meaning anything at the bottom of their own range. The rise allowance is
therefore the **greater** of +50% and a flat €10:

| opening | rise ceiling | what governs |
|---|---|---|
| €1 | €11 | the flat €10 — an at-floor campaign stays repairable |
| €10 | €20 | the flat €10 |
| €20 | €30 | the crossover — both give €30 |
| €100 | €150 | the +50%, alone |

Pinned by a test at the crossover, because *"the +50% did not bind"* is otherwise a bug report
waiting to happen against a €12 campaign. The **down** side needs no such escape: −30% of €1.00 is
€0.70, already below Amazon's own €1 floor, so the guard is simply inert for a campaign that cannot
fall further.

A `budget_day_move` refusal joins `spend_ceiling` and the budget bounds on the notify path. Unlike a
bound an operator set themselves, this one has a **default** — so the first time it fires may be the
first they hear it exists.

### Tests

Ten cases; **six fail with the guard disabled**, verified by disabling it. The other four are the
allowed cases — over-trigger guards that correctly pass either way and are worth having for that.

Three `AUTO.A7` cases changed from asserting `allowed === true` to asserting *a spend ceiling did not
refuse this*. That was their actual intent; the old form was a claim about the whole gate. Guard ④
correctly refuses both fixtures — €5 → €20 is +300%, €5 → €1 is the ratchet cut. **A test that says
"nothing refused this" cannot survive a new guard without lying about one of them.**

---

## 4 · P0.3 — the cap family gets a durable record

`0f916ce56` · `AutomationRefusalDaily` + `automation-refusals.service.ts` · migration `20260816a`

Since ADX.1 a cap refusal has gone to `publishAdsExecution` — an in-process ring buffer, **50 events,
5-minute TTL, one instance** — and nowhere else. So the `capped` chip and RuleDetail's *"its daily cap
declined to run it N times this week"* have rendered **0 for every rule** since 2026-08-04.

**With the counter repaired, that gap is at its widest it has ever been.** Measured 2026-08-11 at the
caps in force that day, the enabled rules were refused **27,629 times in one day** — and not one was
recorded anywhere.

### Why a counter and not a row

| shape | rows/year | verdict |
|---|---|---|
| one row per refusal | **10,084,585** | This is the mistake ADX.1 was created to fix. It reached 693,704 rows in eight weeks and had to be stopped. Re-creating it in a new table is the same mistake with better manners. |
| **counter, keyed (actorKind, actorId, dayUtc, reason)** | **~24,000** | ✅ |

What a counter gives up is per-instance forensics. What it keeps is everything a surface asks:
SUB §5.2's ceiling line and §5.6's fourth empty state — plus **one verbatim last-instance sentence**
per key, because §5.5 requires the UI quote it unparaphrased and one copy costs nothing.

**ADX.1 is not reverted.** An execution row records work that happened; a refusal is work that did
not. This is a separate, aggregated record precisely so it can never feed back into the cap it
describes, which is how the original bug ratcheted itself.

### Three families, deliberately never one number

| reason | source | why it is its own key |
|---|---|---|
| `DAILY_CAP_EXCEEDED` | `maxExecutionsPerDay` | refused outright |
| `WRITE_CAP_REACHED` | `maxWritesPerDay` | a **demotion** to dry-run — it still evaluates, still proposes, still notifies, and only stops writing. Shown as a refusal to run, a working rule reads as a silenced one. |
| `VALUE_CAP_EXCEEDED` | `maxValueCentsEur` | the family already doing damage — §1, row 4 |

The write **never throws**: a refusal record failing on the engine's hot path would turn a governed
stop into an incident, which is strictly worse than the under-counting it would be reporting. It logs
loudly instead. The day bucket is **UTC**, matching the cap counter's own `setUTCHours(0,0,0,0)` — a
local bucket here would disagree with the counter it describes, invisibly to both `tsc` and the eye.
The entity is named only when the trigger context carries one: half the advertising triggers are
account-grain (`SCHEDULE` is `{budget, trigger, marketplace}`), and inventing an entity from the
marketplace would put a refusal on a row it did not happen to.

Eight tests, asserting **behaviour** rather than shape — the lesson of the defect this session opened
on, where a passing test asserted the shape of a where-clause that matched nothing for four months.

---

## 5 · The ceiling line, sourceable for the first time — measured

The API went live at **23:20:35 UTC**. The first read, at 23:25, returned **0 refusals** for all 16
rules, and that zero was correct-but-meaningless: `_auto-p0-tick.mts` showed **0 executions since the
deploy** — the newest execution row was 22:47, because restarting the API re-arms `node-cron` and no
tick had yet fired. **A zero measured before the thing that produces the number has run is not a
measurement.** This is the third time in this record that a window, not a defect, produced the
alarming reading.

The evaluator ticked at **23:31:49 UTC**. One tick:

```
[2026-08-15T23:32:45Z] AutomationRefusalDaily rows: 16

Low CTR bid reduction                      2026-08-15 DAILY_CAP_EXCEEDED  cap 200  refused 79
Wasted keyword instant negate              2026-08-15 DAILY_CAP_EXCEEDED  cap 200  refused 51
Bulk bid floor protection                  2026-08-15 DAILY_CAP_EXCEEDED  cap 100  refused 15
CVR drop alert + bid cut                   2026-08-15 DAILY_CAP_EXCEEDED  cap  50  refused 11
Profit-native bid optimisation             2026-08-15 DAILY_CAP_EXCEEDED  cap  36  refused  9
Target ACOS setter (from profit)           2026-08-15 DAILY_CAP_EXCEEDED  cap  36  refused  9
Daily automation digest                    2026-08-15 DAILY_CAP_EXCEEDED  cap   9  refused  9
Weekend budget boost                       2026-08-15 DAILY_CAP_EXCEEDED  cap  36  refused  9
Auto harvest & negate                      2026-08-15 DAILY_CAP_EXCEEDED  cap  36  refused  9
AIREON — Target ACoS bidding               2026-08-15 DAILY_CAP_EXCEEDED  cap  36  refused  9
Auto match-type migration (broad → exact)  2026-08-15 DAILY_CAP_EXCEEDED  cap 100  refused  5
ACoS convergence · Campaign ACOS rebalance · Alert: ACOS spike ·
Scale budget-capped winners · Reduce bids on ACOS spike          each     refused  1

verbatim : "Low CTR bid reduction reached its daily cap of 200 and was refused.
            Further matches today are refused, not queued."
last at  : 2026-08-15T23:31:17Z   entity AD_TARGET cmr25b61901rpp7013zekbmup
```

**211 refusals in a single tick, across 16 rules, from 16 counter rows.** At ~96 ticks a day that is
~20,000/day, which matches the 21,000 projected from 2026-08-11 — the first independent confirmation
that the projection behind choosing a counter over a row was right.

The ceiling line SUB §5.2 asks for — *the limit · the current position · what happens at the limit* —
is now sourceable verbatim, for the first time since 2026-08-04:

> **Low CTR bid reduction** — Daily cap 200. 200 used, 79 refused today. Further matches are
> refused, not queued.

⚠ **None of these is a failure.** All 16 rules are working exactly as configured; every number above
is a governed stop. Nothing may fold them into a failure rate, a health percentage, or a colour
shared with one.

---

## 6 · Two ways a shared file was lost, both worth recording

**The route extension shipped inside PLC.3's `2373e5bb4`, unnamed.** I held
`advertising-intel.routes.ts` for four hunks and deliberately left the file out of my own commit
because my hunks were a minority in it. PLC.3 then committed the file whole. Nothing is broken and
`main` is correct — but PLC.3's title, *"the refusal that can finally be read"*, refers to its own
`GateDecision.reason` plumbing and reads exactly like it covers mine.

**The generalisable bit.** `git commit --only <path>` takes the **whole file** from the working tree,
so on a contended file it is not a partial commit and cannot be made into one. There are exactly two
honest options: land the file and **name** the other blocks in the message, or leave it out and land
it later. AUTO.P0 chose the second and lost the race — which is the point. **Leaving a contended file
out is not safety, it is a bet on timing.**

**🔴 And the locks document ate its own claims.** AUTO.P0's §2 rows were written at 01:14 CEST and
were gone by 01:35, overwritten wholesale by another session's copy — no conflict, no error. They
were re-added afterwards as *released*. **A claim in that document is not a lock; it is a courtesy
that survives only while nobody else holds the file open.**

---

## 7 · Still open

| # | item | state |
|---|---|---|
| **①** | per-entity cooldown | Not built. Guard ④ bounds the day's total, which makes rate a second-order concern — but nothing yet stops a rule acting on a campaign it acted on 15 minutes ago. |
| **②** | treat a `PENDING` write as current | Not built, and **the mechanism is not what the brief assumed** — see §1. The fix belongs in `ads-v1-sync.service.ts:503` (skip the write-back when an outbound write is in flight), which is the inbound path and was held by no session at the time. |
| — | `minBudgetCents` is set on **0 of 220** campaigns; `budgetBaselineCents` on **28 of 220** | Both guards are inert until someone sets a number. BUD.8 records why the 58 at-floor campaigns cannot be defaulted: a €1 baseline would enshrine the damage. |
| — | `Reduce bids on ACOS spike` still carries `maxValueCentsEur = 0` | 100% inert, and now **countable** as refusals rather than failures. CAP §10d deliberately left clearing it to the operator: it converts a dormant AUTO rule into a live writer, which is a different act from bounding one. |
| — | the 693,704 historical `DAILY_CAP_EXCEEDED` rows | Exit the 60-day window on **2026-10-02** by themselves. The honest filter is by **date**, and the `errorMessage` special-casing can be deleted once they are gone. |

**Out of scope and untouched:** anything under `apps/web` · the per-scope spend ceiling (A7 shipped
it) · `AdsAutomationState.maxHourlySpendCentsEur` · undo/rollback · any rule's percentages,
conditions, scope or enabled state.

---

## Appendix — scripts

All read-only except where noted. `NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/<name>`
from `apps/api`.

| script | measures |
|---|---|
| `_auto-p0-shape.mts` | the grain each rule's `triggerData` carries · column types, so the UTC claim is measured not assumed |
| `_auto-p0-caps.mts` | executions per rule per UTC day, status split, **distinct entities**, ticks/day, markets/day |
| `_auto-p0-ratchet.mts` | the ratchet's live state · the unit trap re-verified (77 euros / 0 cents) · the pacer↔rule tug-of-war, verbatim |
| `_auto-p0-refusals.mts` | refusal volume for sizing the record · gate denials by kind · the allowlist footgun |
| `_auto-p0-actions.mts` | what each enabled rule actually does — the two rules whose names lie |
| `_auto-p0-fails.mts` | the 1,029 "failures" that are all one refusal |
| `_auto-p0-verify.mts` | 🔴 **what is actually fixed**, per defect. Takes a UTC day as `argv[2]` and warns when the window spans the 2026-08-14 18:28 fix |
| `_auto-p0-verify2.mts` | the after-state: the refusal counter, the SUB §5.2 ceiling line, guard ④ at the gate |
| `_auto-p0-watch.mts` | polls for the first durably-recorded refusal |

**Every execution-row filter in every one of these spells out the null branch**
(`OR: [{ errorMessage: null }, { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } }]`), and **none is
wrapped in a swallowing `catch`**. Both traps have produced a confident zero in this programme —
the second one produced *"0 budget audit rows in 60 days"* when the true figure was 2,386.
