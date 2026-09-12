# AUTO — Automations: study 10 of 11

*Rules & Automation, tab-by-tab, right to left.
[1 · Keyword Tracker](2026-08-11-kt-keyword-tracker-study.md) · [2 · Share of Voice](2026-08-11-sov-share-of-voice-study.md) · [3 · Placement](2026-08-11-plc-placement-study.md) · [4 · Budget Schedules](2026-08-11-bs-budget-schedules-study.md) · [5 · Rank & Dayparting](2026-08-11-rd-rank-dayparting-study.md) · [6 · Budget](2026-08-11-bud-budget-study.md) · [7 · Negative Targeting](2026-08-11-neg-negative-targeting-study.md) · [8 · Keyword Harvest](2026-08-11-hv-keyword-harvest-study.md) · [9 · Bid](2026-08-11-bid-study.md).*
**Read-only study. Nothing was changed. No code was written.** *(This page is another session's
claim — read, never edited.)*

Measured on production 2026-08-11 with `apps/api/scripts/_auto-study.mts`.

---

## 0 · The one-sentence version

This is the best-built page in the section — a real autonomy model, four grains of scope, a
graduation board, a conflict detector — and it governs **0.2%** of what actually happens: of
**42,885 writes to Amazon in 60 days, 95 came from a rule execution.**

---

## 1 · What the page is, and every wire behind it

```
/marketing/ads/rules-automation/automations           (routed)
└── automations/AutomationsClient.tsx
    ├── ModeNotches.tsx     OFF · OBSERVE · PROPOSE · AUTO, with a per-rule ceiling
    ├── ScopeForm.tsx       market · portfolio · product line · campaign (RA.GRAIN)
    ├── RuleDetail.tsx      the drawer: readiness, history, caps
    └── ruleText.ts         plain-English when/if/then + detectConflicts()  (+ vitest)

Reads   GET /advertising/autonomy/rules       census · category · ceiling · week counts
        GET /advertising/autonomy/graduation  the readiness board
        GET /advertising/scope-options        ~220 campaigns + 13 product lines, one read
Writes  PATCH /advertising/autonomy/rules/:id        the mode dial
        PATCH /advertising/autonomy/rules/:id/scope  the four grains, ANDed
Model   ads-autonomy.ts  resolveAutonomy / levelActs
        ads-graduation.ts  graduationCeiling — reversible → AUTO, structural → PROPOSE
        ads-graduation-readiness.service.ts  verdicts, 3 clean weeks required
```

### The autonomy model is genuinely good

| level | meaning |
|---|---|
| **OFF** | does not evaluate |
| **OBSERVE** | evaluates and records what it would do — no proposal, no write |
| **PROPOSE** | queues a suggestion; nothing reaches Amazon until accepted |
| **AUTO** | acts, inside its daily cap and the write gate's bounds |

Its own header explains why it exists: *"`rule.dryRun` is a binary, and a binary is the reason 21
rules sat stuck asking permission… Pacvue's governance model has four legs — thresholds, approvals,
an intensity dial, and audit — and their own research names the dial as the underrated one."*
Nexus had three; this added the fourth. And it refuses a percentage knob on principle, because
*"named levels say what they do."*

The **ceiling** is equally well reasoned: reversible actions may reach AUTO; **structural actions —
create a keyword, create a negative, archive, pause — may not, because *"each needs a retirement
path designed alongside it, and none has one yet."*** Study 7 confirmed that path is still missing.

---

## 2 · The census

| | |
|---|---|
| **OFF 29 · OBSERVE 0 · PROPOSE 13 · AUTO 9** |
| on AUTO **and** able to write | **8** |
| on AUTO but notify-only | 1 |
| families | Bids 13 · Placement 11 · Protection 9 · Negation 8 · Budget 6 · Alerts 4 |
| ceilings | AUTO 37 · **PROPOSE 14** — fourteen rules the model will never let run unattended |

🔴 **OBSERVE = 0.** The mode built specifically so an operator could move a rule one notch and watch
it for a week is used by **nobody**. Every rule is either dark or already proposing. The
incremental-trust ladder exists and has never had a foot on its second rung.

### Scope — better than the plan doc says, still barely used

**8 of 51 rules carry a scope.** All eight bind `marketplace = IT`; the rank and dayparting rules.

*(The plan doc's "all 51 are account-scoped" is now stale — I am correcting it here.)*

But: **zero rules use portfolio, campaign or product-line scope.** RA.GRAIN shipped the product
grain on 2026-08-10 — `scopeProductId`, the evaluator resolution, the picker, the reach maths — and
**not one rule uses it.** The remaining 43 rules act on all 220 campaigns in all four markets.

---

## 3 · 🔴 The conflict detector finds nothing, and misses everything

Run against the 22 live rules using **the page's own algorithm, copied verbatim**:

> **rules flagged: 0**

Now the conflicts nine studies actually measured:

| real conflict | why it is missed |
|---|---|
| **The budget ratchet pair** (study 6) — two AUTO rules cutting the same campaigns 15–20% every tick | triggers differ: `CAMPAIGN_PERFORMANCE_BUDGET` vs `CAC_SPIKE`. The detector's first line is `if (a.trigger !== b.trigger) continue`. **Never compared.** |
| **Six overlapping `bid_to_target_acos` rules** (study 9), three on AUTO, all unscoped | five share `SCHEDULE`, so they *are* compared — but two rules doing the *same* thing are not in `OPPOSED`, and their JSON differs, so nothing fires. **Same-action overlap is not a conflict class.** |
| **Two identically-named "Trim budget on weak ACOS"** | one is OFF, and the detector filters to live rules — *"an OFF rule is a plan, not a participant."* Defensible, but it means a dormant duplicate is invisible until someone arms it. |

*(My script's duplicate check compared the rule to itself, since both rows share a name and
`find()` returns the first. That row of output is meaningless and I have discounted it — the
reasoning above stands on the code, not on that test.)*

**Two structural limits explain all of it:**

1. **`a.trigger !== b.trigger → continue`.** Conflicts are defined as same-trigger only. But rules
   collide over an **entity**, not over a trigger. Two rules that both cut the budget of campaign X
   are in conflict whether one fires on a schedule and the other on a spike.
2. **`OPPOSED` lists only eight opposite pairs** — `bid_up`/`bid_down`, pause/resume, and so on.
   **Two rules doing the same thing to the same entity is the more common failure**, and it is not
   modelled at all.

The detector answers *"do these two rules disagree?"* The question the account needed was
***"how many things can move this campaign's budget today?"*** — which is five (study 4), and no
screen says so.

---

## 4 · 🔴 The number that reframes the whole series

Writes to Amazon in 60 days:

| | writes |
|---|---|
| bids | 23,705 |
| placements | 15,256 |
| budgets | 2,387 |
| negatives | 850 |
| keywords | 687 |
| **total** | **42,885** |
| **attributed to a rule execution** | **95 — 0.2%** |

**The other 99.8% come from engines and operators**: `ad-rank-defend` (bids + placements),
`budget-manager-cron` (budgets), `auto-harvest` (keywords + negatives), and `user:anonymous`.

**This page governs rules. Rules are not what is changing the account.**

Every study in this series found the same shape from a different angle:

| study | the tab lists | the writes come from |
|---|---|---|
| 3 · Placement | 8 disabled rules | `ad-rank-defend` — 15,185 writes |
| 6 · Budget | 6 rules, 2 live | `budget-manager-cron` 1,164 + 2 rules 1,216 |
| 7 · Negative Targeting | 7 rules, 0 writes | operators 818 + `auto-harvest` 22 |
| 8 · Keyword Harvest | 5 rules, 0 writes | operators 548 + `auto-harvest` 138 |
| 9 · Bid | 18 rules | `ad-rank-defend` — top ten writers, all of it |

**`ad-rank-defend` is the account's optimiser.** It has no row on this page, no mode dial, no
ceiling, no scope form, and no conflict entry. The one control plane cannot see the thing in
control.

---

## 5 · 🔴 693,704 cap refusals

`DAILY_CAP_EXCEEDED` in 60 days, across **25 rules**:

| rule | refusals |
|---|---|
| New-to-brand optimizer | **116,769** |
| Auto-maintain dayparting — XAVIA MOSS | 33,460 |
| Weekend budget boost | 33,453 |
| Auto-maintain dayparting — XAVIA GALE | 33,453 |
| Daily automation digest | 33,448 |
| Target ACOS setter (from profit) | 33,438 |
| …19 more | |

`ads-weekly-digest.service.ts:25` already names this figure — *"693,704 DAILY_CAP_EXCEEDED rows in
eight weeks"* — as a fixed engine bug. **It is not fixed; it is the current sixty-day count.**

Each blocked (rule × context) evaluation writes an execution row. "New-to-brand optimizer" has a
cap of 10/day and produces ~1,950 refusal rows a day. **The execution table is 99% refusals**, which
is why every health figure in this system has to special-case them and why three separate services
carry a comment explaining the null-branch trap.

**The cap is the real policy** — study 6 said this of budgets, and it is true account-wide. An
operator reading "10 executions/day" does not learn that the rule wanted to act two thousand times.

---

## 6 · How the industry does this

### 6.1 2026 is the year this became the product

| platform | governance model |
|---|---|
| **Pacvue Agent** *(launched 14 Apr 2026)* | moves commerce media *"from analysis and explanation to recommendation and **governed execution** within a single workflow"*; natural-language→AMC-SQL; **built-in approvals**; *"every action goes through guardrails, so teams can move fast and still account for every change"*. Its stated principle: **"autonomous where it matters, control where it counts."** |
| **CommerceIQ** | **role-specific AI agents** alongside automated bid and budget pacing |
| **Skai** | Automated Actions + Budget Navigator across 100+ publishers |
| **Scale Insights** | 12 stackable algorithms, ASIN-level, operator owns the logic |

The industry framing for 2026: *"agentic AI systems capable of taking autonomous, multi-step actions
are shifting from theory to reality, and governance will require entirely new approaches."*

**Nexus is already on the right side of that line.** The four-leg model — thresholds, approvals,
intensity dial, audit — is exactly Pacvue's, and this page implements all four. The `ads-graduation`
ceiling (structural actions may never self-arm) is a stronger safety property than anything in the
research.

### 6.2 The four things the field does that we do not

1. **Govern the executors, not just the rules.** Pacvue Agent governs *actions*, whatever produced
   them. Ours governs rule rows — and 99.8% of actions do not come from one.
2. **Conflicts by entity, not by trigger.** "What else can touch this campaign today" is the
   question; ours asks "which rules share a trigger".
3. **Approvals that are actually worked.** 225 pending suggestions, 1 ever applied (study 8). A
   queue nobody empties is not an approval workflow.
4. **A change ledger as the primary view.** Every enterprise tool leads with *what changed*; we lead
   with *what is configured*. The 42,885 writes exist, are attributed, and are rendered nowhere.

### 6.3 What we have that they do not

- **A per-rule ceiling grounded in reversibility.** Pacvue gates on approval; we gate on whether the
  action can be undone at all. That is a better primitive and I found no competitor with it.
- **Plain-English when/if/then generated from the rule body**, with a vitest suite pinning it.
- **A graduation board** requiring three clean weeks before offering a promotion, with named
  verdicts (`ready` / `unreviewed` / `unseen` / `building` / `failing` / `capped`) and a comment
  insisting *"the UI must never infer readiness from the verdict string."*

### 6.4 The UI shape the field converges on

- **An activity ledger first** — every change, actor, reason, undo — with configuration second.
- **One row per actor**, rule or engine, with the same dial and the same ceiling.
- **Conflicts stated per entity**: "3 rules and 1 engine can change this campaign's budget."
- **An approval inbox with age, bulk actions and expiry.**
- **Refusals as their own class**, not failures.

---

## 7 · What could be implemented, cheapest first

### Tier 0 — tell the truth about who acts *(hours)*
- **Show the engines on this page.** `ad-rank-defend`, `budget-manager-cron`, `auto-harvest` are
  actors with the same properties as rules — they need a row, a mode and a scope, even if read-only
  at first.
- **Separate refusals from failures** everywhere. 693,704 rows are currently indistinguishable from
  breakage.
- **Surface the write attribution**: "rules made 95 of 42,885 changes" belongs on this page.

### Tier 1 — make the conflict detector answer the real question *(days)*
- **Drop the same-trigger requirement.** Compare rules by the **entity** they can reach — which
  `ruleMatchesScope` already computes.
- **Add same-action overlap** as a conflict class: N rules writing the same field to the same entity.
- **Add a cadence check**: a 7-day evidence window read every 15 minutes is the study-6 defect, and
  it is detectable from the rule row alone.

### Tier 2 — use the scope that shipped
Zero rules use product-line, portfolio or campaign scope. Binding the 43 unscoped rules is the
cheapest risk reduction available: a rule that can only touch the GALE line cannot ratchet the
account.

### Tier 3 — the queue
225 pending, 1 applied. Bulk approve, expire, group by kind — or stop generating.

---

## 8 · How this page is *supposed* to be

> **One question: what can change my account, under what limits, and what did it change today?**

- **Every actor on one list** — rules *and* engines — with one dial, one ceiling, one scope form.
- **The ledger first**: 42,885 changes, attributed, filterable, undoable.
- **Conflicts by entity**, answering "what else can touch this".
- **Refusals counted separately** from failures, with the cap shown as the policy it is.
- **OBSERVE actually usable** — the ladder's second rung should be the default first move.
- **Scope bound by default**, not left account-wide because binding is optional.

---

## 9 · What I need from you

1. **Should the engines get rows on this page?** They make 99.8% of the writes. This is the single
   biggest gap in the section and it is a design decision, not a bug fix.
2. **Fix the conflict detector's trigger requirement?** As written it could not have caught the
   budget ratchet, and that is the one thing it existed to prevent.
3. **693,704 refusal rows.** Suppress them, aggregate them, or raise the caps so rules stop being
   refused two thousand times a day?
4. **Should I bind the 43 unscoped rules?** Product-line scope shipped yesterday and nothing uses
   it.
5. **OBSERVE has never been used.** Would you use it if the page suggested it — "this rule is
   ready to observe for a week" — or is the ladder itself unwanted?

---

## Appendix — script

`_auto-study.mts` — the census by level, family and ceiling · scope coverage · **the page's own
conflict detector run verbatim against the live rules** · write attribution across all five action
types · cap refusals by rule.

Read-only. `NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_auto-study.mts` from
`apps/api`.

### Sources

- [Pacvue launches Pacvue Agent, advancing AI-powered commerce media execution](https://pacvue.com/newsroom/pacvue-launches-pacvue-agent-advancing-ai-powered-commerce-media-execution/) ·
  [Pacvue Agent — AI for retail media & commerce execution](https://pacvue.com/platform/artificial-intelligence/) ·
  [The AI-powered commerce media platform — Pacvue](https://pacvue.com/platform/)
- [The 2026 commerce outlook: AI, DSP & retail media performance — Pacvue](https://pacvue.com/blog/the-2026-commerce-outlook-how-ai-dsp-and-commerce-platforms-drive-performance/)
- [Retail media automation 2026: platform comparison — Osmos](https://www.osmos.ai/blog/automation-auctions-the-science-of-scalable-retail-media)
- [AI agents, data governance and workforce shifts redefine retail in 2026 — BizTech](https://biztechmagazine.com/article/2025/12/ai-agents-data-governance-and-workforce-shifts-redefine-retail-2026)
- [Five outlooks for the future of AI governance in retail — dunnhumby](https://www.dunnhumby.com/articles/five-outlooks-for-the-future-of-ai-governance-in-retail/)
