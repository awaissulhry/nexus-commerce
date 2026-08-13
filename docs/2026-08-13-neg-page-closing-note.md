# Negative Targeting — the page is complete

*Eight sections, 2026-08-12 → 2026-08-13. `/marketing/ads/rules-automation/negative-targeting`.*

---

## What the page knows now that it did not on 2026-08-11

On 11 August this account had **2,059 negative keywords** and no screen anywhere in the product
listed a single one. Two per-campaign grids existed, reachable only by already knowing which
campaign to open. Today the page answers eight questions that had no answer:

| | |
|---|---|
| **What am I blocking?** | 2,057 negatives, five scope grains, two grains of object. **942 are actually blocking** — an intersection, not a status |
| **What is one term costing me?** | every place it is blocked and what it earns, from one owner both later sections consume |
| **How does a block end?** | retirement, proven against Amazon, with three outcome classes and evidence on the record |
| **What is wrong right now?** | 0 blocking conflicts · 3 suppressed earners · 40 never confirmed at Amazon |
| **What can never be negated?** | the 10 protections — and the **132 contradictions** nobody had ever compared them against |
| **Which words waste money?** | 43 safe to negate, 7 blocked by a safety rail, 9 size tokens that are a catalogue gap |
| **What can act here, and how much would it touch?** | 7 rules, all account-wide, one with a **74-campaign** blast radius |
| **What changed, and what was refused?** | 861 changes, and **60 refusals of terms that were earning** |

**The single most valuable thing the page found:** `protectConverting` — a switch that existed, was
ON by default, and was **read by nothing** — now refuses negations of earning terms in production.
Five terms, €1,045.40 between them, including two ASIN targets nobody predicted. That fix was NEG.0,
and NEG.8 is where it becomes visible.

## The two conditions still open, and where each is done

Study §4.4 named six preconditions for arming these rules. **Four are closed by this page's work.**
Both remaining ones are yours, not engineering's:

1. **Bind a scope to the negation rules** — 0 of 7 carry any grain, so each executes across all 220
   campaigns. Done in **Automations**, one rule at a time.
2. **Triage the 132 whitelist contradictions** — 0 reviewed. Done in **this page's own audit**
   (Protected terms → "What already contradicts them"), which is live and unused.

Until both close, the graduation ceiling stays shut and every rule stays on PROPOSE. Nothing on this
page arms anything, and that was deliberate in all eight sections.

## Deliberately reported, not fixed

Each lives in a file another surface owns, and fixing it here would have been the wrong session:

| | where |
|---|---|
| `alert_operator` alerts nobody — `logger.warn`, never `notifyAutomation` | `automation-action-handlers.ts:1224` |
| The daily-cap counter cannot see a success — a NULL-unsafe `NOT`, 236,931-row blind spot | `automation-rule.service.ts:573` |
| Gate denials are not persisted — no table, so no surface can count them | `ads-write-gate.ts:358` |
| `add_negative_phrase` is offered, categorised and ceilinged, and has no handler | `automation-action-handlers.ts` |
| Pause-vs-archive for a negative is undefined — Amazon **accepts** `paused`, but no documentation says whether a paused negative still excludes. `NegativeTargetsTab.tsx:90` ships a Pause button that may be a lie | campaign detail pages |
| `Account-wide negative sync` has never worked — 0 of 388 attempts reached its write, failing `"keyword + marketplace required"`. It is **misconfigured, not safe**: repairing the config hands it 74 campaign-level negatives per execution | Automations |
| Two `GALE BROAD DE` negatives carry post-negation traffic a **month** later — `motorrad jacke herren` and `motorradjacke herren`, negated 20 May, impressions through 22 and 27 June | worth one person's afternoon |

## What it cost to be honest

Eight sections, eight classes of defect that a green pre-push, clean `tsc`, passing suites and the
DS ratchet all missed — every one found by loading the page and looking at it:

1. a hard crash that blanked the page, and a census cell whose own filter returned a different number
2. an empty state that could never render
3. delivery reported at enqueue rather than at delivery
4. a confirm dialog that silently never opened (`window.location.search` is not reactive)
5. "0 of 0 blocking negatives are in conflict" — a zero denominator dressed as a clean bill of health
6. a delete control rendering as an empty box, its icon collapsed to width 0 by its own padding
7. one `opacity: 0.82` putting **78 text nodes** below AA at once, every colour individually fine
8. a true sentence printed on a row where it was false, and a column that was an em-dash on every
   row because the reader looked for `marketplace` where the data says `markets`

And three times a **probe manufactured its own failure** — a regex demanding a colon where the code
used ES6 shorthand, a `vi.fn()` mock read as a call site, a contrast check walking to the parent for
a background. A verification script that invents failures is worse than none, because a real failure
gets investigated and a false one gets "fixed".

## The number that moved most

**132.** The study said 132 whitelist contradictions. It is right — as a count of
(negation × protected term) **pairs**. The number of negatives an operator would have to remove is
**128**, and four `xavia gale` rows contradict two protections each. Both are on screen, because an
audit grouped by protected term has groups that sum to 132, and a headline of 128 over groups
summing to 132 reads as a bug.

That pattern — a real number, in the wrong unit, believed for months — is what this page was
actually built to stop. It recurred three more times after NEG.5 found it: `NgramRow.terms`
overstating a 2-gram's reach 4.7×, four marketplaces summed for a handler that only ever touches
one, and 62 rules counted where 51 were meant.
