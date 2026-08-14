# NEG.X — the rule that never worked, and the first gram negation

*Two operator decisions executed 2026-08-14, each approved individually before the write. Not a page
section; NEG.0–NEG.9 are unchanged. The register: [open items](2026-08-13-neg-open-items.md).*

| commit | |
|---|---|
| `cd8fe4ff5` | the gram write left no record — found pre-flighting |
| `512e6d711` | the write ignored its own scope, and mirrored a sandbox stub |
| `c2b10465e` | a successful create returned a NULL id, and we believed it |
| `a67f72b39` · `df882f55d` | the register |

**Both actions done. Three defects found in NEG.6's own write path, all by running it.**

---

## 1 · `Account-wide negative sync` — disabled, not deleted

Every number reproduced: **0 successes in 16,399 executions**, all `keyword + marketplace required`;
same `KEYWORD_WASTED_SPEND` trigger as `Wasted keyword instant negate`, which works and has stricter
conditions; **12 of 27** targets its trigger selected had converted, led by `motorrad jacke herren`
at 15 orders / €1,303.15; IT radius 74 campaigns.

🔴 **The deciding fact was not in the brief.** `AutomationRuleExecution.rule` is declared
`onDelete: Cascade`, so deleting the rule destroys **16,399 execution rows** — the rows that are the
evidence it never worked, and which NEG.8's ledger and the weekly digest both read.

Disabled instead, on the operator's choice. Full row snapshotted first; `KEYWORD_WASTED_SPEND` still
routes to `Wasted keyword instant negate` (enabled, PROPOSE); history intact; one click to reverse.

## 2 · `protezioni` — negated in the top 3 campaigns

| campaign | ad groups | spend | Amazon id |
|---|---|---|---|
| GALE PHRASE IT | 1 | €27.34 | 91839220931410 |
| IT_Auto_Substitute | 1 | €15.96 | 29730889640359 |
| GALE \| IT \| Phrase \| Category | 1 | €14.77 | 207775861905975 |

**€58.07 of the €135.52 — 43%.** All three read back live from `/sp/negativeKeywords/list` as
`ENABLED` `NEGATIVE_PHRASE`. Negatives 2,059 → 2,062. **Orphaned 0.** Every row carries a real user
id and evidence naming the spend, the clicks, the window and the terms blocked.

The other 24 campaigns are deliberately untouched — a live control to measure the first gram
negation against.

## 3 · 🔴 Three defects, and each was only findable by running it

NEG.6 shipped this action and deliberately never ran it. Nothing had exercised the path.

**(a) The write left no record.** `createNegative` only *reads* from the database — its four prisma
calls are all the idempotency probe. A gram negation would have existed at Amazon, arrived back days
later by sync, and landed with no create log. So NEG.8's ledger would not show our own write, and
NEG.9's third detector — whose fourth condition is "no create log" — would have classified it as
"negated outside Nexus". `applyHarvest` has always mirrored correctly; this path never did.
**Caught on the pre-flight, before the first write.**

**(b) The scope bound the preview and not the write.** `getWastefulWords` — the preview, the
confirm dialog, the pre-flight — carries a full campaign filter. The query that decides which ad
groups get written to carried `where: { date: { gte: since } }` and nothing else. **Three campaigns
were approved; twenty-six were targeted.** Caught by reading the output of my own run, not by any
check. The 26 local rows and 26 logs were deleted and the database returned to its exact baseline
before anything else happened; nothing had reached Amazon, because —

**(c) A sandbox stub was mirrored as a real create.** With `NEXUS_AMAZON_ADS_MODE` unset — the local
default — `createNegative` logs `[ADS-SANDBOX]`, calls Amazon not at all, and returns
`mode: 'sandbox'` with a null id. The mirror from (a) treated that as success and wrote local rows
with no external id: the split-brain state NEG.4 exists to count, manufactured by us. `mode` was in
the response the whole time.

**(d) And then a successful create returned a null id.** On the live re-run, all three writes
reached Amazon — and `createNegative` returned `externalNegativeKeywordId: null` for every one.
Amazon's *create* response names the id `negativeKeywordId`; its *list* response names it
`keywordId`; `NegKwDTO` has declared both since it was written, and the parser read only the second.
The three ids were backfilled from Amazon's own read-back, so **split-brain stayed at 40, not 43**.

A create with no id is now classified `failed`, not `created` — defence in depth, because even with
the parser fixed a null id means the write cannot be *confirmed*.

🔴 **That is the third time in this codebase a write that succeeded, partly succeeded, or never
happened was reported as a clean success** — after NEG.3's enqueue-is-not-delivery and HV.9b's
read-back claiming keywords it did not create. The read-back is the only thing that tells them apart.

## 4 · The page verified its own writes

- **The census moved by exactly 3**: 2,059 → 2,062.
- **Orphaned stayed 0** — the NEG.3 routing fix has not regressed.
- **Every new row carries a create log** — counts match, 850 → 853 — with a real user id and
  evidence, not `user:anonymous` and not "unattributed".
- **Detector A 0 · Detector B 3 · Detector C 0 — all unchanged**, as they must be: `protezioni` has
  zero orders, and the three new rows carry a create log so NEG.9's fourth condition excludes them.
- **Split-brain stayed 40.** It would have read 43 had the ids not been recovered — which is exactly
  how the parser defect would otherwise have surfaced: as three mysterious unconfirmed rows.

## 5 · What was deliberately not done

No other rule touched · no scope bound to any rule · no contradiction marked · no second gram · no
fix to the cap counter, `alert_operator`, `add_negative_phrase` or refusal persistence · no `pause`.

The two decisions that gate AUTO remain open and remain the operator's: **bind a scope to the seven
negation rules**, and **triage the 132 contradictions**.
