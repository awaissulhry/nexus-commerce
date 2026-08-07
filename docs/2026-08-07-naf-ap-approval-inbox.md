# NAF.AP — the Approval Inbox

**Status: PROPOSAL — awaiting operator approval. No code.**
Section 2 of 4 in the fleet-page upgrade (1 Decision Timeline **shipped**;
then 3 What it costs, 4 The Brief). Same bar as section 1: a beginner
understands everything, tooltips throughout, and the operator keeps control
of every part.

---

## 0 · Coordination

**The parallel NAF.AC session has finished** — all eight Agent Control phases
shipped, execution record committed (`5f59752cf`), working tree clean. The
seam held: it never touched a file DT owned, DT never touched one of its.

Two things AC left behind that AP should use rather than reinvent:

- **`AgentControlAudit` is live** (table created, migration applied, 0 rows).
  It is the natural home for "who decided what, when, and why" — AP does not
  need a new table.
- **The worker page now owns policy and charter editing.** AP stays on the
  fleet page and links out; it must not grow a second place to change how a
  worker behaves.

With AC done, `apps/api/src/routes/agent-fleet.routes.ts` and the agent-fleet
services are no longer hot. AP can edit them directly — but the DT precedent
still applies where it is cheap: **new UI components in their own files, new
styles in `fleet-sections.css`**.

---

## 1 · What the panel shows today vs. what is true

Verified against the production database, 2026-08-07 (`_dtl-approvals.mts`),
and against the code paths that write it.

**On screen right now:** *"Nothing is waiting for you."* That is true, and it
is the whole panel. Behind it:

| | Truth |
|---|---|
| Approvals ever created | **18** — every one from June 2026 ACP test runs. **Zero from the fleet.** |
| Pending | **0** — so the inbox is empty, permanently, until a worker reaches PROPOSE |
| Decided | **18** (15 rejected, 3 executed) — **all invisible**; the panel only ever queries `status=pending` |
| Who decided | **`decidedBy` is null on all 18** |
| Median decision latency | **0.0 minutes** — these were scripted, not considered |
| Risk tier | present on every row (12 medium, 6 high) — **rendered nowhere in the inbox** |
| Reject reasons | 15 of 15 present — and unreadable, because the history is not shown |
| Exemplars minted | **0** |

### Seven defects, each verified in code

1. **No decision is attributable to a person.** `decideApproval` accepts a
   `decidedBy`, and the fleet route passes the **literal string
   `'operator'`** — not the signed-in user, though `req.authUser` is right
   there on the request. So even future decisions record nobody. For a system
   whose stated posture is EU AI Act auditability, this is the hole.

2. **The inbox has no memory.** It queries pending only. Eighteen decisions
   with fifteen written reasons exist and cannot be read anywhere in the UI.
   "What did I reject last month, and why" is unanswerable.

3. **Expiry is two clocks, and the real one is dead.** Every approval gets an
   `expiresAt` at creation — and **nothing anywhere reads it**. The only
   sweep lives inside `fleet-council.service.ts`, keyed on `requestedAt`
   against a *different* TTL constant, restricted to fleet tool names, and it
   runs only when a council runs. The council has run **twice, ever**. So a
   non-fleet approval never expires, and a fleet one expires on a weekly
   accident.

4. **The precedent promise is unfulfilled.** The decision card tells the
   operator twice that their decision "becomes precedent the workers read on
   their next run". `AgentExemplar` has **0 rows**. The minting call exists on
   the fleet decide path, but no fleet approval has ever been decided, so the
   claim has never once been true.

5. **The card's vocabulary is inverted.** `TOOL_CARDS` explains reversibility
   and the cost of being wrong for exactly three tools — the fleet's
   `create-negative-keyword`, `graduate-keyword`, `set-target-bid` — which
   have produced **zero** approvals. The four tools behind all 18 real
   approvals (`apply-content`, `set-price`, `send-customer-message`,
   `publish-listing`) fall through to **"Unknown for this action type"** on
   both questions. The two most decision-relevant facts are blank precisely
   where there is history.

6. **Raw keys on screen.** The group header renders `{charterKey}` verbatim —
   and where a run cannot be resolved, literally the word **"unknown"**. The
   house rule since FX.1 is names, not IDs.

7. **No brake.** "Reject all (N)" exists; there is no bulk approve, no undo,
   and approve executes **immediately** and irreversibly on click. A misclick
   reaches Amazon.

### One latent bug

Legacy previews are `{ note, action, changes }`; the card reads
`preview.effect`. The fleet's own propose-tools *do* emit `effect`, so this is
harmless today — but any non-fleet approval reaching the inbox would render
**raw JSON** at the operator as its "what happens" line.

---

## 2 · What the industry does (research, 2026)

**What a reviewer must see.** The consensus content contract for an agent
approval screen: *the exact action, the changed state, the authority under
which it acts, the evidence, the uncertainty, the alternatives, and the limits
on reversal.* The first view should carry identity, action, delta, top
evidence, risk, and the commands — with the dollar exposure named. Our card
already does much of this well; what it lacks is risk, authority, exposure,
and — for the tools that actually occur — reversibility.

**Match review depth to consequence.** The recurring rule: *low-risk,
reversible actions get a compact review; high-impact or irreversible ones get
richer evidence, stronger authentication, sometimes two independent
decisions.* A uniform card for everything is itself a defect: **"forcing human
approval on a summary is theater, and it trains reviewers to rubber-stamp,
which is worse than no review."**

**Approval fatigue is predictable, not a user failing.** An agent can emit
dozens of changes an hour, each one a prompt; volume overwhelms judgment. The
counters are bulk actions with a contextual toolbar, staged decisions, a
recommended path, and *keeping state so "later" does not become "never"*. For
destructive actions the pattern is an **obvious undo with a 10–30 second grace
period** and a toast.

**An approval is scoped to a world state.** The specification everyone
converges on: an approval names the actor, agent, operation, destination,
material payload, policy version, expiration and idempotency key — and *"if
the content, price, recipient, or destination changes, the approval should no
longer apply."* We have no such re-validation.

**Workflow mechanics** from enterprise approval systems: per-category SLAs in
hours or days; progressive escalation through primary → backup → manager;
formal delegation for absence; and a dashboard showing current stage, time
elapsed, and who holds the queue. Most of that is over-built for a
single-operator shop — the parts that transfer are **a visible deadline**,
**what happens when it passes**, and **never a silent bottleneck**.

**EU AI Act Article 14** is the reason the anti-rubber-stamp work is not
optional polish. High-risk systems must let a person *understand the system's
capacities and limits, interpret the output correctly, detect anomalies, and
decide not to use it* — and must specifically counter **automation bias**,
"the tendency to over-rely on the output". The failure mode the regulation
names is exactly ours-in-waiting: *"a theoretical human-in-the-loop where the
operator rubber-stamps whatever the machine proposes."* Enforcement checks
that operators have the interface and authority to override.

Sources:
[Edilec — AI agent approval UX: what reviewers must see](https://edilec.com/blog/ai-11018/approval-screens-high-risk-agent-actions/) ·
[aipatternbook — approval fatigue](https://aipatternbook.com/approval-fatigue) ·
[Eucalipse — the approval queue pattern](https://eucalipse.com/articles/ai-agent-approval-queue-human-in-the-loop) ·
[Agentic Patterns — human-in-the-loop approval framework](https://www.agentic-patterns.com/patterns/human-in-loop-approval-framework/) ·
[StackAI — designing approval workflows](https://www.stackai.com/insights/human-in-the-loop-ai-agents-how-to-design-approval-workflows-for-safe-and-scalable-automation) ·
[Arthur — human-in-the-loop governance](https://www.arthur.ai/column/human-in-the-loop-governance-for-ai-agents) ·
[Velt — why AI agents need an approval layer](https://velt.dev/blog/why-ai-agents-need-approval-layer) ·
[EU AI Act Article 14 — human oversight](https://artificialintelligenceact.eu/article/14/) ·
[IAPP — the AI Act shines light on human oversight needs](https://iapp.org/news/a/eu-ai-act-shines-light-on-human-oversight-needs) ·
[Eleken — bulk action UX guidelines](https://www.eleken.co/blog-posts/bulk-actions-ux) ·
[Sirion — auto-escalation for stalled approvals](https://www.sirion.ai/library/contract-insights/auto-escalation-stalled-approvals/) ·
[Velt — modern approval workflow components](https://velt.dev/blog/approval-workflow-components)

**Where we already lead.** Worth stating so we copy selectively: our approvals
sit behind an adversarial critic with code-computed blocks it cannot waive, a
trust ladder with automatic demotion, and preview-only tools that structurally
cannot reach Amazon. The gap is not the gate. It is **memory, attribution,
triage and the brake.**

---

## 3 · The gap, named

1. No decision names a person.
2. No history — the inbox forgets everything the moment you decide.
3. Expiry is decorative; two clocks, neither reliable.
4. Precedent is promised and has never been produced.
5. Reversibility and cost-of-being-wrong are blank for every tool that has
   ever actually asked.
6. Risk tier is stored and never shown; every card looks equally urgent.
7. No bulk approve, no undo, no grace period — approve is instant and final.
8. Raw charter keys, and the word "unknown", on screen.
9. Nothing re-checks that the world still matches what was approved.
10. Nothing anywhere tells you an approval is waiting.
11. No automation-bias countermeasure — nothing makes a considered yes easier
    than a reflexive one.

---

## 4 · Proposed phases (AP series)

Carried rules: sentence → card → JSON; names not IDs; every new term gets a
glossary entry; a control that is not enforced is not rendered; a column with
no data is not a column. One new rule for this series, straight from the
research: **review depth must scale with consequence** — an identical card for
a reversible bid nudge and an irreversible customer message is a defect, not
consistency.

### AP.1 — Attribution: every decision names a person
- Pass `req.authUser` through the decide routes instead of the literal
  `'operator'`; record it on `decidedBy`.
- Write every decision to **`AgentControlAudit`** (AC.7's table, already
  live): who, what, from→to, when, why.
- Acceptance: a decision taken today is attributable tomorrow from the UI
  alone, and the audit row exists whether the decision came from the card or
  from bulk.

### AP.2 — Memory: the inbox gets a past
- Three views: **Waiting · Decided · Expired**, counts on each.
- Decided shows what was asked, what you chose, when, and your reason —
  including the 18 that have been invisible since June.
- Acceptance: "what did I reject last month and why" is two clicks.

### AP.3 — Triage: risk-shaped cards, names not keys
- Group headers use worker names; no raw key, no "unknown", ever.
- Risk tier and reversibility on the face of every card; ordering is
  risk-first, then oldest.
- **Compact review** for low-risk reversible actions; the **full card** for
  high-risk or irreversible ones. Fill in `TOOL_CARDS` for the four tools that
  actually occur, and make the generic fallback honest rather than "Unknown".
- Acceptance: no two different consequences look the same, and nothing on
  screen is an id.

### AP.4 — Bulk, with a brake
- Select-many with a contextual toolbar: approve selected, reject selected
  (reason required, as today), and "approve all like this one" scoped to a
  single worker + tool.
- Before firing, a bulk action states its blast radius in a sentence: *"This
  approves 7 bid changes across 3 campaigns, €12.40 of daily spend."*
- **Undo**: approving schedules execution ~20 seconds out with a toast and an
  Undo. Nothing reaches Amazon inside the window.
- Acceptance: no bulk action fires without naming what it will do, and every
  approve is retractable for 20 seconds.

### AP.5 — Expiry, made real
- **One clock.** `expiresAt` becomes the truth; the council's private
  `requestedAt` sweep is retired.
- A scheduled sweep expires stale approvals — every tool, not just fleet
  ones — instead of waiting for a council that runs twice a year.
- Each card shows time remaining and says what happens when it runs out.
- Acceptance: a pending approval always shows a deadline, and expiry happens
  without a council.

### AP.6 — Staleness: an approval that no longer applies must not execute
- Re-validate at approve time: has the target entity, bid, price or content
  changed since the request was made? If it has, refuse and explain what
  moved, rather than acting on a world that no longer exists.
- Acceptance: approving a request whose underlying facts changed fails
  loudly, with the diff — a test proves it.

### AP.7 — Precedent, actually delivered
- Prove minting end-to-end (0 exemplars exist today), then **show it**: after
  a reject, the card confirms what precedent was created and which workers
  will read it.
- Acceptance: the claim the card makes becomes verifiable on screen, or the
  claim comes off the card.

### AP.8 — Against the rubber stamp (Article 14), and the teaching gate
- Automation-bias countermeasures: show the worker's confidence **and its
  recent track record on this action type** next to the ask; never
  pre-select or default-focus the approve button; for **high-risk** actions,
  require the evidence to be opened before approve enables.
- Plus the DT.8 gate applied here: glossary tooltip on every term, keyboard
  operation end to end, 200% zoom, no colour-only signals.
- Acceptance: a high-risk action cannot be approved without its evidence
  having been seen, and the whole panel is operable from the keyboard.

---

## 5 · Sequencing

**AP.1 → AP.2 → AP.3** is the spine — attribution, memory, then triage — and
it can ship as one visible change. AP.4 and AP.5 are the safety pair and
should go together. AP.6 is the deepest and can follow. AP.7 is small but
should not be skipped, because the card currently makes a false promise.
AP.8 gates the series.

Note the honest constraint: **with the fleet dark, AP.1, AP.4, AP.6 and AP.7
cannot be exercised on live data** — no worker will queue an approval until
one reaches PROPOSE. They will be proven by tests plus a seeded pending
approval, and re-verified the first time a worker actually asks.

## 6 · Decisions — settled by the operator, 2026-08-07

1. **Approve gets a ~20-second undo window.** Execution is scheduled, not
   immediate; a toast offers Undo, and nothing reaches Amazon inside the
   window. Every ads action we queue is cheap to defer by 20 seconds.
2. **The 18 legacy ACP approvals appear in Decided, labelled pre-fleet.**
   Hiding them would make the inbox and the decision timeline disagree about
   the same history.
3. **The Article 14 gate applies to high-risk actions only** — evidence must
   be opened before approve enables. Medium and low stay one click, because
   blanket friction trains people to click through it, which is the failure
   the gate exists to prevent.
4. **Notification is deferred to section 4 (The Brief)**, where a daily
   summary belongs. Named here so it is not lost; not built in AP.
5. **Phase set:** awaiting go.

---

## 6b · Execution record — AP.1–AP.3 built 2026-08-07

| File | What |
|---|---|
| `apps/api/src/services/agent-fleet/approval-inbox.service.ts` | **new** — actor resolution, the three views with counts, and decide/reject-all with audit |
| `apps/api/src/services/agent-fleet/approval-inbox.vitest.test.ts` | **new** — 18 tests |
| `apps/api/src/services/agent-fleet/control-audit.service.ts` | +2 actions (`approve_action`, `reject_action`) |
| `apps/api/src/routes/agent-fleet.routes.ts` | routes made thin; `view=` + counts; the real user replaces `'operator'` |
| `apps/web/.../fleet/ApprovalInbox.tsx` | **new** — tabs, grouping by worker name, the decided history |
| `apps/web/.../fleet/DecisionCard.tsx` | rebuilt: 7 tools, risk-shaped depth, no raw JSON |
| `apps/web/.../fleet/fleet-sections.css` | the `ap-*` family |
| `apps/web/.../fleet/FleetTab.tsx` | panel swapped for `<ApprovalInbox>` |

**What changed for an operator.** The panel used to be one sentence —
"Nothing is waiting for you" — and nothing else. It now has three views;
**Decided shows all 18 approvals that have been invisible since June**, each
with its outcome, age, risk tier, a pre-fleet label, and the reason that was
given. Waiting groups by **worker name** instead of raw charter key. Cards
are shaped by consequence: a low-risk reversible bid change is compact with
its detail one click away, while high-risk, irreversible, or
unknown-consequence actions open fully with a line saying why.

**Verified.** 18 new unit tests; full agent-fleet suite **241 passing across
32 files**. In a browser against the real database: tabs read *Waiting 4 ·
Decided 18 · Expired 0*, group headers read "Bid tuner" / "Negative miner",
the four card shapes render correctly (low→compact, medium-unknown→heavy,
high→heavy, irreversible→heavy with "cannot be undone"), no raw JSON
anywhere, tabs carry `role="tablist"` + `aria-selected`, and there is no
horizontal overflow at 200% zoom.

Because the fleet is dark the waiting view is genuinely empty, so the four
card shapes were rendered from **synthetic rows invented inside the
read-only stub** — nothing was written to the database to make this
screenshot possible. The decided history is real data.

**Two defects found and fixed during the build:**
1. `decideFleetApproval` awaited `recordControlChange` without a `.catch()`.
   That module swallows its own errors by contract, but the decision has
   already committed — a side record must never be able to fail it. Caught
   by a test that mocked the audit to reject.
2. The history chip read **"You said no"** on rows whose `decidedBy` is null,
   claiming a decider the record does not have. Outcomes are now impersonal
   ("Rejected", "Approved — and it ran"); who decided is the meta line's job,
   where it can honestly say "nobody recorded".

**Gates:** DS ratchet clean · RBAC 0 unmapped · `tsc --noEmit` clean on both
apps.

**Not built yet:** AP.4 (bulk + 20s undo), AP.5 (expiry on one clock), AP.6
(staleness), AP.7 (precedent delivered), AP.8 (Article 14 gate + teaching
gate).

---

## 7 · Open items carried out of this proposal

- **`preview.effect` mismatch** — legacy previews are `{note, action,
  changes}`; the card reads `.effect` and would render raw JSON. Harmless
  while only fleet tools queue approvals. Fixed as part of AP.3.
- **The council's private expiry sweep is retired in AP.5.** Whoever touches
  `fleet-council.service.ts` next should not reintroduce a second clock.
- **AP.1, AP.4, AP.6 and AP.7 cannot be verified on live data** while the
  fleet is dark. They ship proven by tests plus a seeded pending approval,
  and must be re-verified the first time a worker actually asks for
  something.
