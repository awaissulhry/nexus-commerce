# WH — a write that did not happen must never report success

*2026-08-14. Generalises the defect class the Negative Targeting page found, and closes the six
items its register left. Two fixes shipped, two proven-then-withheld on the operator's decision, two
reported. The page itself is unchanged and was used as the regression suite.*

| commit | |
|---|---|
| `9b7c3be0c` | `alert_operator` now alerts the operator |
| `0450c112e` | a rule going quiet read as a rule that started working |

---

## 1 · The id-parser audit — clean, and the reason is worth keeping

§3.1 asked for an audit of every `success[0]?.<id>` read against the DTOs. **Result: the client was
never wrong.**

Ten structural creates in `ads-api-client.ts` each read the one spelling Amazon documents for that
entity — `campaignId`, `adGroupId`, `keywordId`, `adId`, `targetId`, `portfolioId`. Only negative
keywords have a documented pair, and line 1843 **already** reads `negativeKeywordId ?? keywordId`
with a comment saying why.

🔴 **The defect was a duplicate parse, not a missing one.** `ads-negative-kw.service.ts` implemented
its own copy of the same parse and read only `keywordId`. The lesson generalises better than "check
your id spellings": *a second implementation of a parse the client already owns is where the drift
lives*. Fixed in NEG.X (`c2b10465e`).

## 2 · 🔴 The cap counter — fixed, proven, and deliberately not shipped

The fix is one clause and it works:

```
executions in 60d                                        954,999
  DAILY_CAP_EXCEEDED                                     693,704   (72.6% of the table)
  errorMessage IS NULL                                   261,295
OLD  NOT(errorMessage = 'DAILY_CAP_EXCEEDED')      →           0
NEW  OR[ errorMessage: null, not 'DAILY_CAP_EXCEEDED' ] → 261,295
```

`NOT(x = 'X')` is NULL — not true — when `x IS NULL`, and a successful execution carries a null
`errorMessage`. So the clause meant to count today's work matched **none of it**.

**Then the impact was measured, and that changed the answer.** Enabling it caps **18 of 21** enabled
rules today, **8 of them on AUTO** — real Amazon writes stopping, including `Retail guard` and
`Profit-native bid optimisation`.

🔴 **Because the caps and the counter are in different units.** `Target ACOS setter (from profit)`
carries a cap of **1/day** against **533 execution rows today** — and those rows are one per
*marketplace per tick* from a SCHEDULE trigger (DE, PL, FR, UK, ES…), all `SUCCESS`,
`dryRun=false`, from **one** entity. `Low CTR bid reduction`: 4,620 against a cap of 100.

The caps read as though written to mean *"run this once a day"*. The counter counts execution rows.
Fixing the counter would not restore an intended limit — it would enforce a limit nobody chose, in a
unit nobody picked.

**Operator decision: report, do not ship.** The edit was reverted; `automation-rule.service.ts` is
untouched. **Sizing the caps is the prior decision**, and it belongs to whoever owns the engine.

This is the same units failure the page found six times — pairs vs negations, ad groups vs rows,
token-terms vs contiguous-terms, summed markets vs one market, an ingest stamp read as a creation
time — one level up, between a limit and its counter.

## 3 · ✅ `alert_operator` now alerts

It called `logger.warn` and stopped, so five advertising rules have raised alerts nobody has ever
seen. One import, one call, the same `notifyAutomation` its working sibling uses.

Three things kept deliberate: `notified` is on the output so a run reaching nobody reads as **0**
rather than as silence; a failed notification logs without failing the rule *and* without reporting
as delivered; severity is narrowed to the four values the notice type accepts.

**Shipped with its volume measured and approved:** 1,254 alert executions today × 2 user profiles ≈
**2,508 notification rows a day**, into a table holding 385,013. That figure is the *uncapped* one —
if the cap is ever fixed, the same three rules drop to ~101 executions and ~200 notifications.

## 4 · `add_negative_phrase` — reported, not removed

The brief leaned toward removing it from three maps. **It is in five** — `_shared/tabs.tsx:183`,
`rule-category.ts:35`, `ads-graduation.ts:60,108`, `negatives-rules.service.ts:42`, and
`harvest-actors.service.ts:71` (HV.6's) — and **no UI can create a rule that uses it**:
`RuleBuilder` writes `actions: [{ type: slug }]` where slug is a rule-type slug, never an action
type. The only web references are a display-label map and the tab *filter*.

So the maps are not wrong — they describe an action correctly; the **handler** is missing. Removing
it would touch two other sessions' files to close a hole nothing can fall into, and would foreclose
a capability the account demonstrably wants: **NEG.X negated `protezioni` as a `NEGATIVE_PHRASE`
three days ago.** Phrase negation is real and working — just not yet as a rule action.

**Recommendation: implement the handler when a rule needs it; do not delete the vocabulary.**
Claim withdrawn, nothing edited. NEG.7's panel already reports it on screen as a known gap.

## 5 · Gate-refusal persistence — a proposed shape, not a table

`logGateDeny` (`ads-write-gate.ts:358`) writes to the application log and nowhere else, so no
surface can count refusals by the write gate. §5 forbids building it unilaterally, correctly — it is
substrate that bids, budgets and placements need as much as negatives.

**Proposed shape**, for whoever owns the gate:

```
AdWriteRefusal {
  id            String   @id @default(cuid())
  deniedAt      String   // the GateDeniedAt enum, already exists
  reason        String
  marketplace   String?
  campaignId    String?
  entityType    String?  // 'AD_TARGET' | 'CAMPAIGN' | …
  entityId      String?
  payloadValueCents Int
  queueId       String?
  createdAt     DateTime @default(now())
  @@index([deniedAt, createdAt])
  @@index([campaignId, createdAt])
}
```

Two constraints from this programme's experience: it must be written **inside** `logGateDeny` so no
caller can forget it, and it must never be `.catch(() => {})`'d into silence the way `audit()` is —
a refusal record that fails to write is worse than none, because the surface then reports zero.

## 6 · `pause` semantics and the digest cadence — both need a person

**`pause`.** Amazon accepts `PAUSED` on a negative (NEG.3b proved it); no documentation anywhere
says whether a paused negative still excludes the term. The only reliable answer is a live
experiment — pause one negative on a term with real traffic, watch for impressions, restore. §5
forbids that without explicit word and **it was not run.** It matters more than it looks: if pause
*does* stop the exclusion, retirement becomes reversible, which is exactly what the graduation
ceiling is waiting for.

**The digest.** The operator asked for daily; `ads-weekly-digest.service.ts` builds weekly and feeds
two consumers. It is a **cadence change on that builder**, never a second service — that is how two
summaries start disagreeing about the same account. Not made; it is a preference, not a defect.

## 7 · 🔴 The page caught a defect I introduced by acting elsewhere

§7 named the Negative Targeting suites as the regression suite for this work. They earned it.

After NEG.X disabled `Account-wide negative sync`, `_neg7-rules.mts` went red on *"the widest-radius
rule has never reached its own selection query"*. The rule had not changed — **its position in a
shared sample had.**

`observed` queried executions with one `take: 1400` across all seven rules, newest-first. Once the
sync rule went quiet it fell out of that page entirely, `attempts` became 0, and `neverReaches`
(`attempts > 0 && reached === 0`) flipped to **false**. Its 16,399 failed attempts were unchanged;
the panel simply stopped saying so.

**Going quiet is not the same as starting to work.** Now sampled per rule (7 × 200, bounded), and
`noAttempts` is a distinct field with its own sentence, because collapsing it into
`neverReaches: false` is what allowed the lie.

## 8 · The page is unchanged

| | before | after |
|---|---|---|
| negatives | 2,062 | 2,062 |
| orphaned | 0 | **0** |
| no create log | 1,227 (59.5%) | 1,227 |
| Detector A / B / split-brain | 0 / 3 / 40 | 0 / 3 / 40 |
| rules on the tab | 7 | 7 |

`_neg9-inbound.mts` and `_neg7-rules.mts` both green.

## 9 · Scripts

| script | |
|---|---|
| `_wh-capcounter.mts` | both clauses proven against 954,999 executions |
| `_wh-capimpact.mts` | 🔴 what the working cap would stop — 18 of 21 rules, 8 on AUTO |
| `_wh-execmeaning.mts` | what an execution row counts: one per marketplace per tick, one entity |
| `_wh-alertvol.mts` | the notification volume before shipping the alert fix |
