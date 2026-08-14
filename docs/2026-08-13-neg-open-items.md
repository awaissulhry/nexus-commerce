# Negative Targeting — open items, with an owner and a recommendation

*Written 2026-08-13 at the close of NEG.9. Everything the eight sections deliberately deferred, in
one place. Nothing here is a bug report without a recommendation.*

Companion documents: [the close-out](2026-08-13-neg-page-closing-note.md) ·
[NEG.9's record](2026-08-13-neg-9-built.md).

---

## Operator decisions — the two that gate AUTO

| # | item | where it is done | state | recommendation |
|---|---|---|---|---|
| 1 | **Bind a scope to the 7 negation rules** | Automations (tab 10) | 🔴 **0 of 7** carry any grain | Bind each to a marketplace at minimum. Until then every negation rule reaches all 220 campaigns, and `sync_negatives_across_campaigns` would write **74 campaign-level negatives per execution in IT** |
| 2 | **Triage the 132 whitelist contradictions** | this page → Protected terms | 🔴 **0 of 132 reviewed** | Start with the **54 own-line brand** rows — a campaign named for a brand negating that brand leaves the traffic nowhere to go. The 33 non-brand ones are standard funnel and can be marked in bulk once you agree |

These are §4.4's two remaining preconditions. Conditions 1–4 are closed by this page's work. Until
both close, the graduation ceiling stays shut and every rule stays on PROPOSE — correctly.

## 3 · ✅ `Account-wide negative sync` — **DISABLED 2026-08-14**, not deleted

**Closed.** The operator chose disable over delete on 2026-08-14, on the evidence below plus one
fact discovered while preparing it: **`AutomationRuleExecution.rule` is declared `onDelete: Cascade`**,
so deleting the rule would have destroyed the **16,399 execution rows** that are the evidence it
never worked — rows NEG.8's ledger and the weekly digest both read.

`enabled` is now `false`. The full row was snapshotted first. `KEYWORD_WASTED_SPEND` still routes to
`Wasted keyword instant negate` (enabled, PROPOSE), and the execution history is intact. Reversible
in one click if it is ever wanted back.

The original case, kept because it is the argument for never re-enabling it:

### ~~The case for deletion~~ — the case for keeping it off

**The measurement that decides it.** The rule has failed **600 of 600** recent executions with
`keyword + marketplace required`, and has never once reached its own selection query.

The brief's diagnosis was that its config "carries neither" keyword nor marketplace. **Measured, the
marketplace IS supplied** — `triggerData` carries `{ trigger, adTarget: { id, clicks, orders,
spendCents }, marketplace }` on all 5,000 sampled executions. Only the **keyword** is missing, and
it is missing because the trigger's `adTarget` projection has no `expressionValue`. The handler
reads `context.adTarget?.expressionValue`, which is undefined.

So a repair is a one-field change to the trigger's projection, not to the rule. **Do not make it.**

**What it would have done over 60 days, reconstructed from its own trigger history:**

```
distinct adTargets its trigger selected      26
of those, terms that CONVERTED in 60 days    12     🔴 including:
    motorrad jacke herren     16 orders  €1,391.39   (DE — would be negated in all 8 enabled DE campaigns)
    giacca moto estiva uomo    5 orders    €457.35
    giubbotto moto uomo        3 orders    €258.21
    giacca moto                3 orders    €253.29
    b0cxpp5dbk                 3 orders    €243.45   ← an ASIN, negated as a keyword phrase
```

Seven of the 26 are AUTO targets whose `expressionValue` is the **empty string**, and two are
PRODUCT targets. So even with the projection fixed, roughly a third of what it selects is not a
keyword at all.

**It duplicates an existing rule, on the same trigger, more dangerously.** `Wasted keyword instant
negate` fires on the same `KEYWORD_WASTED_SPEND` trigger, under *stricter* conditions
(spend ≥ €5 **and** clicks ≥ 5, versus spend ≥ €10 alone), and already writes a CAMPAIGN-scoped
negative via `add_negative_exact`, whose default scope is CAMPAIGN. The sync rule is the same intent
with a blast radius of every enabled campaign in the marketplace instead of one.

**Recommendation: delete `Account-wide negative sync`.** It is currently inert only by accident —
ON, enabled, failing. A partial repair is the dangerous state, and `protectConverting` would catch
only some of the 12 (it uses a 30-day window; several of these converted earlier in the 60).

Owner: **operator**, in Automations. Nothing in this session changed it.

## 4 · 🔴 The two GALE BROAD DE negatives — **cause 1 confirmed; nothing to fix**

`motorrad jacke herren` and `motorradjacke herren`, both in `GALE BROAD DE › BROAD ONLY`, both with
`createdAt = 2026-05-20` and impressions through 22 and 27 June — a month after being "negated".
NEG.4 flagged this as possibly an Amazon delivery gap.

**It is not. `AdTarget.createdAt` is an ingest stamp, and this is provable:**

```
negatives sharing createdAt = 2026-05-20        1,155
those 1,155 rows span                              4 distinct MINUTES
```

A human did not create 1,155 negatives in four minutes. That date is when the v1 sync first mirrored
the row, not when Amazon created the negative — and these rows are in the 59.6% that have no create
log, so we have no independent record of when they were made.

**We therefore do not know when those two negatives were created at Amazon**, and cannot conclude a
delivery gap from traffic that postdates an ingest date. The five largest cohorts are all bulk
ingests: 2026-05-20 (1,155) · 07-31 (408) · 07-28 (204) · 07-01 (198) · 05-30 (62).

**Recommendation: close this as "not a defect, and not answerable from our data".** If it matters,
the only source of truth is Amazon's own change history for those keyword ids — a support question,
not an engineering one. Cause 2 (delivery gap) and cause 3 (ad-group id collision) are not ruled
out, but cause 1 fully explains the observation and is free.

## Engineering items — all in shared files another surface owns

| # | item | file | consequence | recommendation |
|---|---|---|---|---|
| 5 | 🔴 **The daily-cap counter — FIXED, PROVEN, DELIBERATELY NOT SHIPPED (2026-08-14)** | `automation-rule.service.ts:573` | `NOT: { errorMessage: 'DAILY_CAP_EXCEEDED' }` is NULL — not true — for the **240,684** rows where `errorMessage IS NULL`. It matches **0** of them, against 693,704 cap refusals in 934,388 executions | The one-line fix works — old clause matches **0** of 954,999 executions, null-safe matches **261,295**. **But enabling it caps 18 of 21 enabled rules today, 8 on AUTO.** 🔴 The caps are in a different unit from the counter: `Target ACOS setter` is cap **1/day** against **533** rows, one per marketplace per tick from ONE entity. Fixing the counter enforces a limit nobody chose. **Sizing the caps is the prior decision.** Reverted; see `2026-08-14-wh-writeback.md` §2 |
| 6 | ✅ **`alert_operator` alerts the operator — SHIPPED 2026-08-14** (`9b7c3be0c`) | `automation-action-handlers.ts` | Calls `logger.warn` and never `notifyAutomation`, so the action named "alert operator" reaches neither the bell, the feed nor the inbox. Five advertising rules use it | Done. `notified` is on the output so a run reaching nobody reads as 0; a failed notification does not fail the rule and does not report as delivered. **Volume measured and approved before shipping: ~2,508 notification rows/day** at current uncapped rates |
| 7 | **`add_negative_phrase` — REPORTED, not removed (2026-08-14)** | `ACTION_HANDLERS` | Offered on this tab, categorised in `rule-category.ts`, ceilinged in `ads-graduation.ts` — and absent from the handler map. A rule using it fails every execution with "Unknown action type". **0 rules use it today** | 🔴 It is in **five** maps, not three (incl. HV.6's `harvest-actors.service.ts`), and **no UI can create a rule using it** — `RuleBuilder` emits rule-type SLUGS, not action types. The maps are right; the handler is missing. Removing touches two other sessions' files to close a hole nothing can fall into, and NEG.X proved phrase negation is valuable. **Implement the handler when a rule needs it** |
| 8 | **Gate refusals are not persisted** | `ads-write-gate.ts:358` (`logGateDeny`) | Writes to the application log and nowhere else. No table exists, so no surface can count refusals by the write gate — this page renders an em-dash and says so rather than inventing a number | **A concrete `AdWriteRefusal` shape is proposed** in `2026-08-14-wh-writeback.md` §5 — written INSIDE `logGateDeny` so no caller can forget it, and never `.catch(() => {})`'d, because a refusal record that fails to write is worse than none. Not built: it is substrate |
| 9 | **`pause` semantics for a negative are undefined** | Amazon's docs | Amazon **accepts** `PAUSED` on a negative keyword — NEG.3b proved it with a reversible probe. No documentation anywhere states whether a paused negative still excludes the term. `campaigns/[id]/tabs/NegativeTargetsTab.tsx:90` already ships a Pause button that may therefore be a lie | Ask Amazon support. If pause **does** stop the exclusion, retirement becomes reversible — which is exactly what the graduation ceiling cares about, and would materially change §4.4 |
| 10 | **Daily vs weekly digest** | `ads-weekly-digest.service.ts` | The operator asked for a daily digest; the existing one is weekly. It is a **cadence change on one builder**, not a second service | Change the cadence on that builder if wanted. Do not build a second digest — that is how two summaries start disagreeing about the same account |
| 11 | ✅ **`protezioni` — DONE in the top 3 campaigns, 2026-08-14** | this page → Wasteful words | 42 grams remain actionable. `protezioni` was €135.52 across 193 terms and 27 ad groups; the top 3 campaigns carried 43% of it | **Negated as a NEGATIVE_PHRASE in GALE PHRASE IT · IT_Auto_Substitute · GALE \| IT \| Phrase \| Category** — 3 ad groups, €58.07 of the €135.52, confirmed at Amazon (ids 91839220931410 · 207775861905975 · 29730889640359), orphaned 0, each attributed to a real user with evidence. The remaining 24 campaigns are deliberately left as a live control. **The attempt found three defects in NEG.6's own write path, all now fixed** (`cd8fe4ff5`, `512e6d711`, `c2b10465e`): the write left no local record; the scope bound the preview but not the write; and a successful create returned a null id that was believed |

## What changed in NEG.9

Only three things: the third detector (read-only), this register, and the two study docs moving from
untracked to tracked. **No negation was created, retired or modified. No rule was touched.**
