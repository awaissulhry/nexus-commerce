# CAP — what a "run" is, what each rule's limit should be, and only then the counter

*2026-08-14. §1–§9 were written as a recommendation with nothing shipped. The operator then approved
it in two steps, and §10b/§10c are the execution record: **13 caps re-sized, one rule disabled, and
the counter armed** — in that order, which is the entire point. Every number is labelled with its
unit, because the whole defect is that a limit and its counter were in different ones.*

**Status: the brake is on.** First tick under the armed counter, 18:45 UTC — one rule wrote, the one
deliberately exempted, and it wrote exactly **9 rows: one per active marketplace**. §10c.

Companion: [WH's writeback §2](2026-08-14-wh-writeback.md) — why the counter fix was withheld.
Scripts: `_cap-sizing.mts` · `_cap-anchor.mts` · `_cap-damage.mts` · `_cap-budgetpath.mts` ·
`_cap-probe.mts` · `_cap-actions.mts` · `_cap-preflight.mts` · `_cap-watch.mts` · `_cap-tick.mts` —
all read-only. `_cap-apply.mts` is the only one that writes, and only with `--apply`.

---

## 0 · The answer in six lines

| | |
|---|---|
| **What is one execution row?** | One **(rule × context) match that dispatched actions**. NO_MATCH writes nothing. |
| **What is one logical run?** | One **evaluator tick** — `*/15 * * * *`, **96 ticks/day**, measured 96 distinct buckets in 24h. |
| **Why 811 rows against a cap of 1?** | A SCHEDULE tick emits **one context per active marketplace**, and this account has **9**. One run = 9 rows. 96 × 9 = **864 rows/day for one logical run per tick**. |
| **What should the cap count?** | **Both, in two fields.** `maxExecutionsPerDay` keeps counting ROWS — re-sized as *entities × sweeps*. A new `maxWritesPerDay` counts **writes that reached Amazon**, which is where damage lives. |
| **Where is the damage?** | `GALE EXACT DE`: **€100.00 → €1.00 in 39 Amazon writes in one day**, by a rule carrying a cap of 10. |
| **What must happen first?** | Size the caps. Then arm the counter. **Never the reverse** — arming first caps 18 of 21 rules, 8 on AUTO, including `Retail guard`. |

---

## 1 · The unit — measured, not assumed

```
evaluator cron                     */15 * * * *          →  96 ticks/day
active ads connections             9 marketplaces           DE PL FR UK ES SE NL IE IT
last 24h, account-wide             27,812 execution ROWS across 96 distinct 15-min TICKS
```

**An execution row is written only when a rule matched and dispatched.** `automation-rule.service.ts:529`
returns `NO_MATCH` before any row is created; the row is created at `:675` after the action loop. So
a row is not "the engine looked at something" — it is "a rule fired".

**A row is one (rule × context).** `applyMarketplaceScope` (`advertising-rule-evaluator.job.ts:485`)
loops contexts and calls `evaluateAllRulesForTrigger` per context. The context grain is set by the
trigger's builder, and it is not the same for all of them:

| trigger | one context is | contexts per tick, measured |
|---|---|---|
| `SCHEDULE` | one **marketplace** | 9 |
| `KEYWORD_LOW_CTR` | one **AdTarget** | 79 of 85 distinct keywords |
| `CAMPAIGN_PERFORMANCE_BUDGET` | one **campaign** | 59 of 60 |
| `KEYWORD_WASTED_SPEND` | one **AdTarget** | 47 of 52 (builder truncates at `.slice(0, 400)`) |
| `CAC_SPIKE` | one **campaign** | 1 |
| `SEARCH_TERM_CONVERTING` | one **search term** | 5 |

So `rows/day ≈ entities × ticks`. **The cap conflates two different questions** — *how many things may
this rule touch* and *how many times a day may it touch them* — and stores the answer to neither.

### The evidence that settles it

`Target ACOS setter (from profit)` carries a cap of **1** and produced **811 rows**. Measured:
**8.8 rows per tick against 9 marketplaces**, across 92 ticks, from a SCHEDULE trigger. Seven
SCHEDULE rules share **one** run count (92) — they are all being driven by the same tick, not
running independently.

A cap of 1 written beside a fan-out of 9 is not a rate limit anybody chose. It is somebody writing
*"once a day"* into a field that counts rows.

🔴 **`Daily automation digest` proves it by name.** It is called *daily*, carries a cap of **1**, and
emits **811 rows**. The number that means "once a day" on this account is **9** — one row per
marketplace, once. Not 1, and not 811.

---

## 2 · What each rule's actions actually did

Before any cap is sized, one fact reframes everything: **19 of the 21 enabled rules have never
written to Amazon at all**, and four are structurally incapable of it.

```
ACTIONS THAT FAIL 100% OF THE TIME (7 days, sampled per rule)

🔴 New-to-brand optimizer          bid_up               0 ok / 38,486 failed  — No adGroup.id in context
🔴 Wasted keyword instant negate   add_negative_exact   0 ok / 25,259 failed  — No keyword/query to negate
🔴 Reduce bids on ACOS spike       bid_down             0 ok /    803 failed  — VALUE_CAP_EXCEEDED
🔴 Reduce bids on ACOS spike       notify               0 ok /    803 failed  — VALUE_CAP_EXCEEDED
🔴 AIREON — Target ACoS bidding    bid_to_target_acos   0 ok /    808 failed  — targetAcos stores 30, not 0.3
```

- **`New-to-brand optimizer`** is a **campaign**-grain trigger feeding an **ad-group**-grain action.
  It cannot ever succeed. It has produced **0 suggestions** — and **11,176 notifications a day**
  titled *"NTB campaign bid raised — high new-customer acquisition rate"*. **The notification is
  false.** No bid was raised, 38,486 times in seven days.

- 🔴 **`Wasted keyword instant negate` corrects the NEG.X record.** `2026-08-14-negx-executed.md` §1
  justified disabling `Account-wide negative sync` partly because this rule *"works and has stricter
  conditions"*. **Its negate half does not work, for exactly the same reason the disabled rule's did
  not**: `buildWastedKeywordContexts` (`advertising-rule-evaluator.job.ts:654`) projects
  `adTarget: { id, spendCents, orders, clicks }` and no `expressionValue`, so
  `add_negative_exact` reads `context.searchTerm?.query` → undefined → `No keyword/query to negate`,
  **25,259 times in seven days**. Its `lower_bid_to_floor` half does work (67 suggestions). The
  decision to disable the sync rule stands; the reason given for it was half wrong.

- **`Reduce bids on ACOS spike`** carries `maxValueCentsEur = 0`. `automation-rule.service.ts:638`
  tests `projected >= rule.maxValueCentsEur`, and `0 >= 0` is true on the **first** action, so every
  action is refused — **including the `notify` that would have told anyone.** A cap of zero is not
  "spend nothing"; it is "do nothing, silently".

- **`AIREON — Target ACoS bidding`** stores `targetAcos: 30` where the handler demands a fraction.
  808 refusals/day, no notify action, so it fails in complete silence.

**Capping any of these four changes nothing, because they already do nothing.**

---

## 3 · What the cap should count — and where I disagree with the brief

§3 proposed **option 3 (writes) for anything that writes, option 2 (logical runs) for anything that
only proposes or notifies**. The first half is right and the evidence for it is in §5. The second
half I recommend against, on two measured grounds.

**Option 2 is not implementable as stated.** Nothing records a run. `AutomationRuleExecution` has no
run id, no tick id, no batch id — a "run" exists only as a timestamp cluster. Counting runs means
either a new column written by the evaluator, or a `date_trunc` window query on every single
evaluation. Both are larger changes than the one this decision is trying to unblock.

**Option 3 alone would bind nothing.** 19 of 21 enabled rules wrote **zero** times to Amazon in 60
days. A write cap on today's account is a brake on a stationary car — and the 27,812 rows/day and
~42,000 notifications/day would stay completely ungoverned.

### 🔴 The recommendation: two fields, two units, both honest

| field | counts | governs | applies to |
|---|---|---|---|
| `maxExecutionsPerDay` *(exists)* | **execution ROWS** | churn — rows, notifications, engine load | **every** rule |
| `maxWritesPerDay` *(new, Int?)* | **rows in `AdvertisingActionLog` where `userId = 'automation:<ruleId>'` today** | damage — what reaches Amazon | rules that can write |

Two properties make this the cheap answer rather than the ambitious one:

1. **Neither field needs a new counting mechanism.** Rows are already counted. Writes are already
   recorded, already stamped with the rule's actor, already indexed on `createdAt`. The write cap is
   one `count()` in the same block that already does one.
2. **A row cap sized as `entities × sweeps` behaves exactly like a run cap**, and carries one extra
   safety property a run cap does not: it also bounds *fan-out growth*. If this account adds a tenth
   marketplace or the keyword set doubles, a run cap silently permits twice the work; a row cap does
   not.

**The sizing rule for rows: `cap ≥ 2 × measured distinct entities`.**

🔴 **Below that, a row cap is a positional filter, not a rate limit.** Contexts arrive in a stable
order, so a rule that trips its cap mid-sweep never evaluates the tail of its own entity list — the
same entities, every day, forever. `Low CTR bid reduction` carries a cap of **100** against **85
distinct keywords** and a fan-out of 79/tick: arming the counter today would leave it permanently
blind to part of its own selection while reporting nothing wrong.

### 🔴 Attribution: by actor, never by `executionId`

`AdvertisingActionLog.executionId` is documented as *"Set when the write came from a rule"* and
`automation-action-handlers.ts:748` passes `executionId: null`. Measured: **97 rows in 60 days carry
one**, against **36,219** written by an `automation:*` actor. The write cap must key on
`userId`. A `maxWritesPerDay` built on `executionId` would read **zero for every rule** and never
bind — the same shape of failure as the null clause it is meant to replace.

---

## 4 · The per-rule table

**Every column labelled.** 24h window, measured 2026-08-14 17:19 UTC. `RUNS` = distinct 15-minute
ticks the rule produced a row in. `AMZ-W` = writes that reached Amazon, by actor.

| rule | trigger | level | cap **ROWS** | **ROWS**/24h | **RUNS**/24h | rows/run | **ENTITIES** | **AMZ-W**/24h | **AMZ-W**/60d | **NOTIFS**/24h |
|---|---|---|---|---|---|---|---|---|---|---|
| Low CTR bid reduction | KEYWORD_LOW_CTR | PROPOSE | 100 | 7,369 | 93 | 79.2 | 85 | 0 | 0 | 14,738 |
| New-to-brand optimizer | CAMPAIGN_PERF_BUDGET | PROPOSE | 10 | 5,588 | 95 | 58.8 | 60 | 0 | 0 | 11,176 |
| Wasted keyword instant negate | KEYWORD_WASTED_SPEND | PROPOSE | 200 | 4,252 | 91 | 46.7 | 52 | 0 | 0 | 0 |
| Bulk bid floor protection | AD_TARGET_UNDERPERF | PROPOSE | 100 | 1,425 | 95 | 15.0 | 16 | 0 | 0 | 2,850 |
| CVR drop alert + bid cut | CVR_DROP | PROPOSE | 50 | 1,065 | 93 | 11.5 | 14 | 0 | 0 | 50 † |
| Target ACOS setter (from profit) | SCHEDULE | **AUTO** | 1 | 811 | 92 | 8.8 | 9 | 0 | 0 | 1,622 |
| Daily automation digest | SCHEDULE | PROPOSE | 1 | 811 | 92 | 8.8 | 9 | 0 | 0 | 34 † |
| Retail guard | SCHEDULE | **AUTO** | 96 | 809 | 92 | 8.8 | 9 | 0 | 0 | 1,618 |
| Weekend budget boost | SCHEDULE | **AUTO** | 1 | 809 | 92 | 8.8 | 9 | 0 | 0 | 1,618 |
| Profit-native bid optimisation | SCHEDULE | **AUTO** | 2 | 809 | 92 | 8.8 | 9 | 0 | 0 | 1,618 |
| Auto harvest & negate | SCHEDULE | PROPOSE | 3 | 808 | 92 | 8.8 | 9 | 0 | 0 | 1,616 |
| AIREON — Target ACoS bidding | SCHEDULE | PROPOSE | 4 | 808 | 92 | 8.8 | 9 | 0 | 0 | 0 |
| Auto match-type migration | SEARCH_TERM_CONVERTING | PROPOSE | 100 | 455 | 91 | 5.0 | 5 | 0 | 0 | 910 |
| ACoS convergence | CAC_SPIKE | **AUTO** | 4 | 95 | 95 | 1.0 | 1 | 0 | 0 | 190 |
| Scale budget-capped winners | CAMPAIGN_PERF_BUDGET | PROPOSE | 10 | 95 | 95 | 1.0 | 2 | 0 | 0 | 190 |
| Reduce bids on ACOS spike | CAC_SPIKE | **AUTO** | 30 | 95 | 95 | 1.0 | 1 | 0 | 0 | 0 |
| Campaign ACOS rebalance | CAC_SPIKE | **AUTO** | 5 | 95 | 95 | 1.0 | 1 | 0 | **642** | 190 |
| Alert: ACOS spike | CAC_SPIKE | **AUTO** | 50 | 95 | 95 | 1.0 | 1 | 0 | 0 | 8 † |
| Trim budget on weak ACOS | CAMPAIGN_PERF_BUDGET | **AUTO** | 10 | 0 | 0 | — | 0 | 0 | **574** | 0 |
| Boost budget on profitable campaigns | AD_TARGET_UNDERPERF | PROPOSE | 10 | 0 | 0 | — | 0 | 0 | 0 | 0 |
| Stale campaign cleanup | KEYWORD_ZERO_IMPRESSIONS | PROPOSE | 200 | 0 | 0 | — | 0 | 0 | 0 | 0 |

† **These four are artificially low and will rise.** `alert_operator` only began creating
notifications when WH shipped `9b7c3be0c` partway through this window. At steady state the four
`alert_operator` rules add ~3,850 notifications/day. Projected steady state: **~42,278/day**, not
today's 38,428. The volume problem is still getting worse, not stabilising.

---

## 5 · 🔴 The damage that already happened — the argument for a write cap

Two rules have ever reached Amazon. Both are AUTO. Both are budget rules. Both did this:

```
Trim budget on weak ACOS      [AUTO] cap = 10 ROWS/day     574 writes across 4 campaigns
  GALE EXACT DE               €100.00 → €1.00     39 writes, ALL on 2026-08-06
  GALE | IT | Exact | Category €3.31 →  €2.81    283 writes  (08-06:94  08-07:96  08-08:93)
  GALE | IT | PAT              €4.14 →  €2.47    245 writes  (08-05:53  08-06:96  08-07:96)

Campaign ACOS rebalance       [AUTO] cap = 5 ROWS/day      642 writes across 3 campaigns
  GALE EXACT IT               €5.22 →  €1.00    379 writes  (08-06:81 08-07:96 08-08:96 08-09:96 08-10:10)
  GALE | IT | Exact | Category €6.46 →  €4.61    256 writes
  IT_Auto_Substitute          €15.00 →  €6.14      7 writes
```

Read the daily counts: **96, 96, 96, 96.** That is one Amazon write **per tick, every tick, all day**,
to the same campaign, for four consecutive days. Every one returned `SUCCESS`. Every one changed the
budget. `GALE EXACT DE` went from **€100.00 to €1.00 in a single day** — a 99% cut — under a rule
whose stated limit was **10**.

Both rules then went quiet, and not because anything stopped them: they hit the **€1.00 floor**, so
`adjust_ad_budget` began returning `no_changes`. Today those rows read `ok: true` with
`error: "no_changes"` and `outboundQueueId: null` — 95 times a day, another write that did not
happen reporting as a success.

**This is the number that decides the unit.** A cap of 10 in rows did not stop 39 writes, because
the rule only ever produced ~1 matching context per tick, so its row count and its write count were
never the same number. In the **writes** unit, its own stated cap of 10 was almost exactly right and
would have stopped the €100 → €1 walk at €65.

**Anchors** (each with its unit):

| anchor | value |
|---|---|
| total Amazon-bound writes, 60 days | **47,592** |
| ├─ `ad-rank-defend`, 43 per-plan actors | **33,699 · 70.8%** — 🔴 not a rule, carries no cap of any kind |
| ├─ no actor recorded (`userId` null) | 8,761 · 18.4% |
| ├─ human / `user:*` | 2,612 · 5.5% |
| ├─ other automation crons | 1,304 · 2.7% |
| └─ **AutomationRule actors** — everything a rule cap can govern | **1,216 · 2.6%** |
| account mean daily spend, 10 days with data | **€123.32/day → €5.14/hour** |
| peak day (2026-08-03) | €186.19 → €7.76/hour |
| `AdsRuleSuggestion` rows, all time | **260** (258 open) — the entire reviewable output |
| `DAILY_AD_SPEND_CAP_EXCEEDED` refusals, 60d | **0** — the euro cap has never bound |
| `VALUE_CAP_EXCEEDED` refusals, 60d | **3,842** — the per-execution value cap is the one brake that works |

The brief cites a peak spend rate of **€20.91/hour**; I measure **€5.14/hour mean** and **€7.76/hour**
on the peak day, from `AmazonAdsDailyPerformance` CAMPAIGN rows over 14 days. Different window or
different measure — flagging the disagreement rather than reconciling it silently. Either way the
conclusion is unchanged: a rule that can walk one campaign's budget from €100 to €1 in a day is
operating far outside what the account's spend rate justifies.

---

## 6 · The sizing — every rule, with a justification

**Two columns because there are two units.** `ROWS` bounds churn and applies to every rule; `WRITES`
bounds damage and applies to rules that can reach Amazon. Row caps are set to **≥ 2 × measured
entities** so no rule is blinded to part of its own selection.

### 6.1 Rules that write — sized in WRITES

| rule | cap now (ROWS) | **proposed ROWS** | **proposed WRITES** | justification |
|---|---|---|---|---|
| **Campaign ACOS rebalance** | 5 | 10 | **6** | 3 campaigns ever touched; 2 moves/day per campaign. A budget rule needing a third move in one day is oscillating, not converging. `GALE EXACT IT` would have got 6 writes on 2026-08-06, not 81. |
| **Trim budget on weak ACOS** | 10 | 10 | **8** | 4 campaigns ever touched. Its own author's number was already close — in the wrong unit. `GALE EXACT DE` would have ended 2026-08-06 at **≈€39**, not €1. |
| **Target ACOS setter (from profit)** | 1 | 36 | **50** | `bid_to_target_acos` → `applied: 0` on all 811 rows and 0 writes in 60 days. 50 binds nothing today and bounds it the day it starts working. Rows 36 = 4 sweeps × 9 markets. |
| **Profit-native bid optimisation** | 2 | 36 | **50** | Same action, same trigger, same result. See §7.1 — three rules doing one thing. |
| **Weekend budget boost** | 1 | 36 | **50** | Same again. 🔴 Also runs all seven days; if "weekend" is meant, it needs a day-of-week condition, not a cap. |
| **ACoS convergence** | 4 | 10 | **50** | 1 entity, 1 row/tick. Rows 10 = ~hourly. |
| **Reduce bids on ACOS spike** | 30 | 10 | **30** | 🔴 **Set `maxValueCentsEur` to a real number first, or disable.** At 0 it refuses every action including `notify`; a cap on a rule that already refuses itself is decoration. |
| **Retail guard** | 96 | **EXEMPT (null)** | **20** | 🔴 Protective — see §6.3. |
| **Alert: ACOS spike** | 50 | 24 | **n/a** | Warning-only; writes nothing to Amazon. Rows 24 = hourly. Its real fix is dedupe (§8), not a cap. |

### 6.2 Rules that only propose — sized in ROWS

| rule | entities | cap now | **proposed** | justification |
|---|---|---|---|---|
| Low CTR bid reduction | 85 | 100 | **200** | 🔴 Today's 100 is **below** 2× the entity count — arming the counter as-is would blind it to part of its own keyword set. 200 = 2.35 full sweeps. |
| Wasted keyword instant negate | 52 | 200 | **200** *(unchanged)* | Already ≥ 2×. Its negate half is dead (§2) — that is a projection fix, not a cap. |
| Bulk bid floor protection | 16 | 100 | **100** *(unchanged)* | 6× headroom. |
| CVR drop alert + bid cut | 14 | 50 | **50** *(unchanged)* | 3.5× headroom. |
| Auto match-type migration | 5 | 100 | **100** *(unchanged)* | 20× headroom. |
| Scale budget-capped winners | 2 | 10 | **10** *(unchanged)* | 5× headroom. |
| Boost budget on profitable campaigns | 0 | 10 | **10** *(unchanged)* | No contexts today; leave as-is and re-measure if it starts firing. |
| Stale campaign cleanup | 0 | 200 | **200** *(unchanged)* | Same. |
| Auto harvest & negate | 9 | 3 | **36** | 🔴 A cap of 3 on a 9-marketplace fan-out means it would run in **3 of 9 markets** and never reach the rest. 36 = 4 sweeps. |
| AIREON — Target ACoS bidding | 9 | 4 | **36** | Same shape. 🔴 Fix `targetAcos: 30 → 0.3` or disable; the cap is irrelevant while every execution fails. |
| **Daily automation digest** | 9 | 1 | **9** | The rule is named *daily* and the author wrote 1. On a 9-marketplace account, "once a day" **is 9 rows**. This is the whole session in one row of a table. |
| New-to-brand optimizer | 60 | 10 | 🔴 **disable** | See §7.2. |

### 6.3 Protective rules — identified explicitly

Six of the 21 carry an action whose purpose is to **stop or warn**, not to spend:

| rule | protective action | treatment |
|---|---|---|
| **Retail guard** | `retail_guard` (pauses campaigns on stock-out / Buy Box loss) | 🔴 **Exempt from the row cap entirely.** A safety rule that goes quiet at 09:00 because it used its allowance is worse than no safety rule: stock runs out and the ads keep running, and nothing says so. Bound it in the unit that can actually hurt — **20 writes/day**, enough to protect the 86 enabled campaigns' realistic failure set, not enough to pause the account. |
| **Alert: ACOS spike** | `alert_operator` | No cap. Capping an alarm silences it. Bound by dedupe (§8). |
| **CVR drop alert + bid cut** | `alert_operator` | Row cap only, for the bid half. |
| **Daily automation digest** | `alert_operator` | Row cap 9 — that *is* its intended cadence. |
| **Bulk bid floor protection** | `lower_bid_to_floor` | Row cap. Lowering a bid is de-risking, but still a write. |
| **Wasted keyword instant negate** | `lower_bid_to_floor` | Row cap. |

**One further note on `Retail guard`, outside this decision:** its `notify` action fires
unconditionally, so it announces *"Retail guard paused campaign(s) — check execution log"* **809
times a day** while its own output reads `paused: 0`. That message is false as written. It is a
handler fix, not a cap.

### 6.4 What the sizing does

| | today (measured) | steady state | under the proposal |
|---|---|---|---|
| execution rows / day | 27,812 | 27,812 | **~1,987** (−93%) |
| notifications / day | 38,428 | ~42,278 | **~3,062** (−93%), or **~1,350** with dedupe |
| `AdsRuleSuggestion` output | 260 total | 260 | **unchanged** — every rule still sweeps its entities ≥2× |
| Amazon writes by rules / day | 0 | 0 | **0 today**; ceiling **264/day** if all of them start working |

Row and notification figures are ceilings for the rules that fire today; the three rules with zero
contexts (`Trim budget`, `Boost budget`, `Stale campaign cleanup`) would add up to a further 440
notifications/day if they ever start.

**No cap in this proposal binds anything a rule does today.** That is deliberate, and it is also the
honest test of the §4 warning about caps sized generously enough to break nothing: these are sized
against *measured* entities and *measured* writes, and the two that would have bitten —
`Campaign ACOS rebalance` at 6 writes and `Trim budget on weak ACOS` at 8 — are exactly the two that
did the damage.

### 6.5 🔴 What a daily write cap does **not** fix

A cap bounds the *rate* of a ratchet, not its *destination*. `GALE EXACT DE` fell €100 → €1 in 39
writes because each `adjust_ad_budget` cut ~11% and nothing re-examined the cumulative move. Under a
cap of 8 writes/day it ends day one at ≈€39 — and then resumes at 00:00 UTC, reaching €1 in about
five days instead of one.

**That is still a real improvement**: five days is five chances for a person to notice, where one day
was none. But it means the cap is the *brake*, not the *steering*. The thing actually missing is a
bound on cumulative change — "no campaign's budget may move more than X% in a day", or a floor below
which `adjust_ad_budget` refuses.

The engine has a field that looks like it should do this and does not. `maxDailyAdSpendCentsEur` sums
`estimatedValueCentsEur` across the day — and `adjust_ad_budget` computes it as
`Math.max(0, next − current)` (`automation-action-handlers.ts:397`). **A cut is clamped to 0.** So the
euro cap is handed 0 on every reduction, and has never bound: **0 `DAILY_AD_SPEND_CAP_EXCEEDED`
refusals in 60 days** against 3,842 `VALUE_CAP_EXCEEDED`. A euro cap that only counts increases
cannot see a rule walking a budget to zero.

The same handler carries `next = Math.max(1, …)` — the €1 floor. That floor is the only thing that
stopped these two rules, and it stopped them by arriving at the bottom, not by refusing. Reported,
not proposed here: it is a handler-semantics decision and belongs to whoever owns the engine.

---

## 7 · Rules that should be off, or fixed, rather than sized

### 7.1 Three AUTO rules are one rule

`Target ACOS setter (from profit)`, `Profit-native bid optimisation` and `Weekend budget boost` share
the **same trigger** (SCHEDULE), the **same action** (`bid_to_target_acos`), the **same autonomy**
(AUTO), and the **same result** (`applied: 0`, 0 writes in 60 days). Add `ACoS convergence`
(CAC_SPIKE, same action) and `AIREON` (PROPOSE, same action, broken config) and **five** enabled
rules are pointed at one handler that has never applied a bid.

That is one investigation — *why does `bid_to_target_acos` always apply 0?* — not five caps.
**Owner: whoever owns the engine.** Out of scope here; §7 of the brief forbids the engine change.

### 7.2 🔴 `New-to-brand optimizer` — recommend **disable**

- `bid_up` has failed **38,486 of 38,486** attempts in 7 days: `No adGroup.id in context`.
- Its trigger is campaign-grain; its action needs an ad group. It is not misconfigured, it is
  **mis-wired**, and no cap makes a mis-wired rule safer.
- It has produced **0 suggestions** in its lifetime.
- It emits **11,176 notifications a day** stating a bid was raised. **That statement is false.** It is
  the single loudest source in the account and everything it says is untrue.
- **Disable, do not delete** — `AutomationRuleExecution.rule` is `onDelete: Cascade`
  (`schema.prisma:12919`), so deleting destroys the execution history that is the evidence.

### 7.3 Two configuration fixes worth more than any cap

| rule | fix | effect |
|---|---|---|
| `AIREON — Target ACoS bidding` | `targetAcos: 30 → 0.3` | 808 failures/day → a rule that can actually evaluate |
| `Reduce bids on ACOS spike` | `maxValueCentsEur: 0 → a real ceiling` | 190 refusals/day → a rule that can act **and** can tell you |

### 7.4 Two names, one rule — a trap this document walked into

There are **two** `AutomationRule` rows named `Trim budget on weak ACOS`: one AUTO and enabled (574
writes), one PROPOSE and disabled (0 writes). My first pass at `_cap-anchor.mts` resolved rules by
name and could have attributed one rule's writes to the other. Fixed to key on actor id, and the
script now prints both rows so the collision is visible. **Worth renaming one of them.**

### 7.5 `ad-rank-defend` — reported, not touched

**33,699 of 47,592 Amazon writes in 60 days — 70.8%** — come from 43 `automation:rank-defend-*`
actors. It is not an `AutomationRule`, has no `maxExecutionsPerDay`, and nothing in this proposal
reaches it. §7 of the brief puts it out of scope (study 10, open question 1). Stating the number so
the scale is on the record: **the caps under discussion govern 2.6% of what this account writes.**

---

## 8 · The notification volume — propose only, do not ship

```
Notification, by type            LAST 24h      LAST 7d     ALL TIME
  ads-automation-rule              41,466      273,780      387,865
  ads-auto-harvest                      2           14           84
  ads-automation-halt                   0            0            2

all notifications ever 387,971 · created in the last 7 days 273,796 (70.6%)
near-duplicate bursts (same title, same SECOND, >2 rows): ×4 "Low CTR detected — bid reduced 25%", five times in 24h
```

**70.6% of every notification this account has ever created landed in the last seven days.** The
loudest sources, measured per rule: `Low CTR bid reduction` **14,738/day**, `New-to-brand optimizer`
**11,176/day** (all false), `Bulk bid floor protection` **2,850/day**.

`notifyAutomation` (`ads-automation-notify.service.ts:20`) creates one row **per `UserProfile`** —
2 today — with no dedupe of any kind. The ×4 bursts are two executions in the same second × two users.

**Proposed, not built:**

1. **Dedupe inside `notifyAutomation`, not at the call sites** — same argument as `logGateDeny` in
   WH §5: a caller can forget. Key on `(type, title, entityId)` within a window; skip creation when
   a matching **unread** row already exists.
2. 🔴 **Exclude `severity: 'danger'`.** `notifyAutomation` also carries the circuit-breaker and the
   halt events (`ads-automation-state.service.ts:126`) and `ad-rank-defend`'s blast-radius guard
   (`ad-rank-defend.job.ts:477`). Deduping those would hide a second incident behind the first.
3. **Fix `Retail guard`'s unconditional `notify`** (§6.3) — a notification announcing an action that
   did not happen is the same defect class WH generalised, on the notification path.

🔴 **This belongs after the caps, not before.** Silencing the notifications first removes the most
visible evidence that the caps are wrong — and it is the evidence that made this session possible.

---

## 9 · Recommended order of operations

**Nothing below happens without explicit approval of the sizing in §6.**

| # | step | kind | reversible? |
|---|---|---|---|
| 1 | **Set the caps** (§6.1, §6.2) — a data change on `AutomationRule` rows, in one before/after table in the commit | data | yes, trivially |
| 2 | **Disable `New-to-brand optimizer`** (§7.2) — `enabled: false`, never delete | data | one click |
| 3 | **Fix the two configs** (§7.3) | data | yes |
| 4 | **Arm the counter** — `OR: [{ errorMessage: null }, { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } }]` at `automation-rule.service.ts:573` | code · 1 deploy | revert |
| 5 | **Watch 24 hours.** Expect: rows ≈ 1,987/day, notifications ≈ 3,062/day, suggestions unchanged at ~260 | — | — |
| 6 | **Then** add `maxWritesPerDay` (§3) and set the write caps (§6.1) | schema + code | additive |
| 7 | **Then** the notification dedupe (§8) | code | — |

🔴 **Steps 1–3 are safe precisely because step 4 has not happened.** The counter is broken, so a new
cap binds nothing until it is armed. The risky step is second, isolated, and one revert away — which
is the opposite of how this would have gone if the counter had been fixed first.

**🔴 A correction to step 5, found while writing the watch script.** I wrote above that
`DAILY_CAP_EXCEEDED` rows would start appearing. **They will not, and that is by design.** ADX.1
made a cap refusal write **no execution row** — that was the fix for the self-ratchet, where each
refusal raised the count that caused it. A refusal now emits only an ephemeral `publishAdsExecution`
event into a 50-entry, 5-minute in-process ring buffer.

**So the cap is observable only as an absence: rows-per-rule-per-day stopping at the cap.** Not as
refusals, not as failures, not as anything in the execution table. `_cap-watch.mts` measures it that
way. Anyone verifying this by looking for refusal rows will conclude the fix did not work.

That also means the 693,704 `DAILY_CAP_EXCEEDED` rows on prod are **historical residue** from before
2026-08-04, not a live condition — which is why the null branch matters so much: they are the only
thing the old clause could see, and they stopped arriving ten days ago.

---

## 10 · Verification

`apps/api/scripts/_cap-sizing.mts` — read-only, produces §4, and asserts:

| assertion | result |
|---|---|
| the null-safe clause matches all non-refusal rows and excludes exactly the cap refusals | ✓ 263,202 = 956,906 − 693,704 |
| the old clause is blind to every null-error row | ✓ matched **0** |
| rows-per-run **measured** per SCHEDULE rule, not assumed | ✓ 8.8 rows/tick vs 9 marketplaces, all 7 rules |
| every SCHEDULE rule shares one driver | ✓ 92 runs/24h, identical across all 7 |
| writes-that-reached-Amazon derived from `AdvertisingActionLog` by **actor**, not `executionId` | ✓ 36,219 by actor vs 97 with an `executionId` |
| a cap of 0 refuses every action, including `notify` | ✓ `Reduce bids on ACOS spike` |
| an assertion over an empty window would fail | ✓ |

**Sampled per rule, never across rules** — WH's `_neg7-rules.mts` went red when a shared `take:`
pushed a quiet rule out of a page. Every per-rule query here is scoped by `ruleId`.

### The Negative Targeting page — unchanged, and it is the regression suite

| | expected | measured |
|---|---|---|
| negatives | 2,062 | **2,062** |
| orphaned | 0 | **0** |
| split-brain | 40 | **40** |
| Detector A / B / C | 0 / 3 / 0 | **0 / 3 / 0** |
| `_neg9-inbound.mts` | green | ✓ all assertions passed |
| `_neg7-rules.mts` | green | ✓ all assertions passed |

**One disagreement, reported not patched:** `_neg-page-conflict.mts` throws at line 223 —
`Unknown field 'actionType' for select statement on model 'AdsRuleSuggestion'`. The field does not
exist on that model (it has `proposedAction`/`proposedKey`). The script is **untracked** (`??` in
`git status`), so it is a study-era scratch file that has been broken at its §F since
`AdsRuleSuggestion` was defined — not a regression from this session, and sections A–E still run.
Not touched: §9 of the brief says report, don't patch, and §7 forbids touching the NEG page.

---

## 10b · ✅ EXECUTED 2026-08-14 — the data changes, and two the pre-flight stopped

Operator decision, given after §1–§10 were written: **"data changes only, counter stays off"** and
**"Retail guard exempt from the row cap, bounded at 20 writes/day"**. Applied by
`_cap-apply.mts --apply`; every row snapshotted in full first, every change read back.

**13 rows changed. `automation-rule.service.ts` untouched — the counter is still unarmed, so none of
this binds anything yet.** That is the point of doing it in this order.

| rule | cap before (ROWS) | cap after | |
|---|---|---|---|
| Daily automation digest | 1 | **9** | one context per marketplace, once — what *daily* costs here |
| Target ACOS setter (from profit) | 1 | **36** | 4 sweeps × 9 markets |
| Weekend budget boost | 1 | **36** | |
| Profit-native bid optimisation | 2 | **36** | |
| Auto harvest & negate | 3 | **36** | was 3 against a 9-market fan-out — it would have run in 3 markets and never reached the rest |
| AIREON — Target ACoS bidding | 4 | **36** | |
| ACoS convergence | 4 | **10** | 1 entity, ~hourly |
| Campaign ACOS rebalance | 5 | **10** | |
| Alert: ACOS spike | 50 | **24** | hourly |
| Reduce bids on ACOS spike | 30 | **10** | |
| Low CTR bid reduction | 100 | **200** | 🔴 was **below** its own 85-entity count |
| **Retail guard** | 96 | **null — EXEMPT** | safety rule; bounded at **20 writes/day** in step 6 |
| **New-to-brand optimizer** | *(cap unchanged)* | — | 🔴 **`enabled: false`** |

`New-to-brand optimizer` was **disabled, not deleted** — it carries **167,851** execution rows and
`AutomationRuleExecution.rule` is `onDelete: Cascade`. Full row snapshotted; one click to reverse.

### 🔴 Two approved config fixes were NOT made, and both were stopped by re-reading before writing

**`AIREON — Target ACoS bidding` — my §7.3 recommendation was wrong.** `ads-bid-optimizer.service.ts:253-274`
records a **deliberate** decision by RA.AUTO not to coerce `30 → 0.3`: *"Coercing 30 → 0.3 would be a
guess about intent dressed as a fix, and a wrong guess here moves real money."* I had proposed
exactly the thing that comment exists to prevent. And it would not have worked anyway: the rule also
stores **`campaignIds` (an array of 11)** where the handler reads `campaignId`, so a **second** guard
refuses it regardless. The rule is PROPOSE and has applied 0 bids, so nothing is lost by leaving it.
**What it needs is a decision about what it was meant to do, not a coercion.**

**`Reduce bids on ACOS spike` — held until the write cap exists.** It is **AUTO, `dryRun: false`**, with
`bid_down −20%` on ad groups. Clearing `maxValueCentsEur: 0` un-blocks it — and with the counter
still broken and `maxWritesPerDay` not yet built, that creates a **new uncapped AUTO writer**. That is
materially more than "a data change", so it waits for step 6. Its row cap was still lowered to 10.

### Verification after the write

| | expected | measured |
|---|---|---|
| all 13 rows read back as intended | 13 | **13 ✓** |
| old counter clause still matches | **0** | **0** — nothing binds yet |
| `_cap-sizing.mts` | green | ✓ all assertions passed (now 20 enabled rules) |
| NEG census / orphaned / split-brain | 2,062 / 0 / 40 | **2,062 / 0 / 40** |
| Detector A / B / C | 0 / 3 / 0 | **0 / 3 / 0** |
| `_neg9-inbound.mts` · `_neg7-rules.mts` | green | ✓ · ✓ |

---

## 10c · ✅ THE COUNTER IS ARMED — 2026-08-14 18:35 UTC

Step 4, approved after §10b. `automation-rule.service.ts:590` now carries the null branch. Shipped
in `6ce492420`; live on prod as build `94de80aa` (another session's commit on top of mine — verified
with `git merge-base --is-ancestor` and the `/api/health` build sha, not by assuming).

**The first tick with a working brake fired at 18:45 UTC. Measured with `_cap-tick.mts`:**

```
rows written since 18:44 UTC — the first tick with the counter armed:
  Retail guard                                 cap= null  rows=   9  last 18:47:11

  enabled advertising rules: 20 · rules that wrote in this window: 1
  ✓ wrote and is EXEMPT: Retail guard
  ✓ no capped rule wrote a single row — the counter is holding
```

**One rule wrote. It is the one deliberately exempted, and it wrote exactly 9 rows — one per active
marketplace.** The other 19 were already past their caps on pre-arming rows and went silent, as they
must until 00:00 UTC.

That single line is three verifications at once:

1. **The counter binds.** 19 of 20 rules stopped mid-day, the first time any cap has held since
   2026-08-04. Before the deploy the same rules were writing ~430 rows per tick.
2. **The exemption works, and it was necessary.** `Retail guard` — the rule that pauses campaigns on
   stock-out — is the *only* thing still running. Under a cap of 96 it would have stopped at tick 11
   of 96 and stayed off for the rest of the day.
3. 🔴 **9 rows is the unit thesis, measured directly.** One logical run of one SCHEDULE rule costs
   exactly 9 execution rows on a 9-marketplace account. That is the whole argument of this document,
   printed by the engine itself on the first tick after the fix.

| observable | expected | measured at 18:47 |
|---|---|---|
| capped rules writing rows | 0 | **0** |
| exempt rule writing rows | 9 (one per marketplace) | **9** |
| `DAILY_CAP_EXCEEDED` rows written today | **0** — a refusal writes no row | **0** |
| notifications/hour | falling from ~1,730 | **1,378** and dropping |
| account rows, 18:35 → 18:47 | +9 | **20,994 → 21,002 (+8, +1 landing mid-read)** |

**Still open, in order:** step 5 (watch through 00:00 UTC — the first clean day) · step 6
(`maxWritesPerDay`, including Retail guard's 20 and `Reduce bids on ACOS spike`'s config) · step 7
(notification dedupe).

**What to check tomorrow:** every capped rule should sit at *exactly* its cap, not below it. A rule
resting below its cap means its trigger stopped producing contexts, which is a different condition
and must not be read as the cap working. `_cap-watch.mts` distinguishes them (`AT CAP` vs `quiet`).

---

## 11 · What was deliberately not done

**No counter armed** (`automation-rule.service.ts` is untouched) · no notification path touched · no
bid write path touched · no rule deleted · `ad-rank-defend` untouched · no engine change · no
handler change · no schema change · no new page or surface · the Negative Targeting page unchanged.

**No source file was edited at all** — the only writes were to `AutomationRule` rows — so **no lock
was claimed in §2 of the session-locks file**.

The ten scripts are committed rather than left untracked: two of them (`_cap-damage.mts`,
`_cap-budgetpath.mts`) are the argument *for* a change, `_cap-preflight.mts` is what stopped two
changes that were already approved, `_cap-apply.mts` carries the snapshot that reverses the ones that
were made, and `_cap-watch.mts` / `_cap-tick.mts` are how anyone checks tomorrow whether the brake is
still holding. None of that holds if it cannot be re-run.

---

## 12 · The unit failure, for the eleventh time

pairs vs negations · ad groups vs rows · token-terms vs contiguous-terms · summed markets vs one
market · an ingest stamp read as a creation time · a rule going quiet read as a rule starting to work
· runs vs execution rows · **and now: a cap of 1 meaning "once a day" on an account where once a day
costs 9 rows.**

The pattern has a shape worth naming. Every one of these was a **correct number read against the
wrong denominator** — and in every case the number looked plausible, which is why none of them were
caught by reading the code. They were caught by measuring the thing the number was supposed to
describe, and finding a different number.
