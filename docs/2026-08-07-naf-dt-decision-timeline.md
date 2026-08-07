# NAF.DT — the Decision Timeline

**Status: PROPOSAL — awaiting operator approval. No code written.**
Section 1 of 4 in the fleet-page upgrade (then: Approval Inbox, What it
costs, The Brief). Trigger: operator, 2026-08-07 — *"a decision timeline …
super easy to understand, no complexities at all, but I must have proper
control over each and every thing … a beginner seeing this for the first
time understands everything."*

---

## 0 · Working alongside the parallel session (NAF.AC)

A second session is building **Agent Control** (`docs/2026-08-07-naf-ac-agent-control.md`),
actively writing as of 03:15 today. Verified state of its work:

| Its territory | Files | Status |
|---|---|---|
| Charter revisions, preview mode | `apps/api/src/services/agent-fleet/{agent-executor,charter-registry,charter-types,charter-revisions.service}.ts` | **HOT — written minutes ago** |
| Schema + migration | `packages/database/prisma/schema.prisma`, `migrations/20260807a_nafac_agent_control/` | **HOT — uncommitted, unapplied** |
| Charter Studio UI | `fleet/worker/[key]/WorkerClient.tsx` | cold now, **will be hot** (AC.1) |
| Fleet routes | `apps/api/src/routes/agent-fleet.routes.ts` | cold now, **will be hot** (AC.1/.2/.6) |

**My territory** (all cold, none of it theirs):
`fleet/FleetTab.tsx` and new sibling components; a **new** route file; a
**new** stylesheet.

### The four seam rules

1. **Never touch `schema.prisma`.** DT needs no new table. Where DT wants an
   audit record, it reads AC.7's `AgentControlAudit` *once that lands*, and
   derives from existing rows until then.
2. **New route file, not theirs.** DT's endpoints go in
   `apps/api/src/routes/agent-fleet-timeline.routes.ts`, registered
   alongside. Zero merge surface on `agent-fleet.routes.ts`.
3. **New stylesheet, not theirs.** `fleet/fleet-sections.css`, imported by
   `fleet/page.tsx`. `control-room.css` stays untouched so the Studio can
   have it.
4. **Worker page is theirs, fleet page is mine.** DT links *to* the worker
   page; it never edits it.

### One live hazard, right now

Their regenerated Prisma client has columns the database does not
(`AgentCharter.pausedUntil` et al. — migration written 03:04, not applied).
Any full-model select on `AgentCharter` currently throws **P2022** locally.
This already broke one of my probes. It affects the local API dev server
too. It resolves itself the moment they apply the migration — no action
needed from me beyond using explicit `select`.

---

## 1 · What the page shows today vs. what is actually true

Verified against the production database, 2026-08-07 (`_dtl-state*.mts`).

| Panel | What an operator sees | What is actually there |
|---|---|---|
| "This morning's brief" hero | **never renders** | it keys on charter `fleet-auditor`, which **does not exist in the database**. Dead code path. |
| Decision timeline | one collapsed row | exactly **1 plan, ever** — `critiqued` / **blocked**, 15 items, 2 dropped, 0 approvals queued, a 1,611-character narrative nobody reads |
| Approval inbox | "Nothing is waiting for you" | **0 pending — and 18 decided** (3 executed, 15 rejected), every one invisible. `decidedBy` is **null on all 18**. The reasons are test strings (`acp3b-verify`), from June, not from the fleet. |
| What it costs | a table where every Grade is "—" | **0 scorecards exist.** Grade, "agrees with engines" and Trust are three dead columns. Lifetime spend across all 45 runs: **$0.3787**. |
| Brief | "No sweeps recorded yet" | **0 sweep runs, ever.** Of 45 fleet runs, 43 are `mode='ask'` and 2 are `council`. The nightly sweep has never produced a run. |
| — nowhere — | — | **25 of 45 runs failed (56%)**: 21× `fetch failed`, 3× Anthropic 400, 1× schema-validation. Invisible on this page. |

So: four of six panels are structurally empty, one is dead code, and the
single most alarming fact about the fleet — that more than half its runs
fail — is not rendered anywhere.

**The reframe this forces.** The page is empty because it looks for *plans*,
and there is one plan. But the fleet has lived a real life: 45 runs, 64 open
findings, 18 approval decisions, 2 councils, 25 failures. Roughly **150 real
events**, scattered across five tables, rendered nowhere. A decision
timeline that shows *events* instead of *plans* is full on day one — with
the truth, not with filler.

---

## 2 · What the industry does (research, 2026)

**Agent observability — Salesforce Agentforce.** Session tracing records
every step of the reasoning chain: user input, LLM calls, tool invocations,
guardrail checks, response timing — stored queryably, surfaced as **trace
trees**, and paired with an analytics layer scoring quality and escalation.
The stated purpose is to answer *why the agent behaved that way*, not merely
*what it did*.

**Trace UIs — LangSmith, Langfuse.** The settled shape is a **waterfall of
nested spans**: a top-level trace with every LLM generation, tool call, and
sub-agent underneath, each carrying its own **latency, token count and
dollar cost** — so you can find the step that blew the budget. LangSmith
adds **state inspection at every node**, **trace replay with a different
model or prompt**, and **annotations**. Langfuse added **agent graphs** that
infer execution structure from span nesting.

**Audit-trail UX.** The pattern is explicit about content: actor (human *or*
agent), timestamp, model/skill version, inputs, tools invoked, output and
side effects, and **human approvals or overrides**. Its named anti-patterns
are exactly our current risks: *logging only model text while omitting tool
calls or identity*; *an audit interface built solely for engineers*;
*claiming immutability while permitting edits*. And the audience split
matters — end users get a **lightweight activity history**, compliance gets
a **deeper, exportable log**.

**Timeline UX.** Anatomy: axis, event marker, event content (description +
actor + metadata), time label, and grouping/filters. Ours is the **activity
timeline** variant — many short operational events. Required: filter by
**time range, actor, action, object**; **export**; **progressive
disclosure**; **stable ordering**; **pagination or windowing**; loading and
empty states designed up front; full keyboard operation; readable at 200%
zoom; and never color alone for state. The named anti-pattern is *choosing a
layout before understanding the question the user is asking*.

**Compliance framing.** The recurring 2026 requirement: make the trail
**queryable by a non-engineer** — "compliance shouldn't need a SQL prompt" —
and **separate read, reversible-write and consequential-write actions
explicitly**. We already have `riskTier` on every approval; we render it
nowhere.

Sources:
[Salesforce — Agentforce session tracing](https://help.salesforce.com/s/articleView?id=ai.generative_ai_session_trace_about.htm&language=en_US&type=5) ·
[Salesforce Developers — agent platform tracing, trace trees](https://developer.salesforce.com/blogs/2026/05/agent-platform-tracing-debug-agentforce-with-trace-trees-soql-and-slack) ·
[Salesforce — Agentforce 360 observability](https://www.salesforce.com/news/stories/agentforce-studio-observability-tools-announcement/) ·
[VentureBeat — watching agents think in near-real time](https://venturebeat.com/ai/salesforce-agentforce-observability-lets-you-watch-your-ai-agents-think-in) ·
[LangSmith — observability](https://www.langchain.com/langsmith/observability) ·
[Langfuse — agent observability & tracing](https://langfuse.com/blog/2024-07-ai-agent-observability-with-langfuse) ·
[Laminar — Langfuse vs LangSmith 2026](https://laminar.sh/blog/2026-01-29-laminar-vs-langfuse-vs-langsmith-llm-observability-compared) ·
[AI UX Playground — audit trail pattern](https://aiuxplayground.com/pattern/audit-trail/) ·
[UX Patterns for Developers — timeline](https://uxpatterns.dev/patterns/data-display/timeline) ·
[miniOrange — enterprise AI agent audit trails 2026](https://www.miniorange.com/blog/ai-agent-audit-trail/) ·
[Fast.io — AI agent audit trail guide](https://fast.io/resources/ai-agent-audit-trail/) ·
[Eleken — timeline UI design patterns](https://www.eleken.co/blog-posts/timeline-ui-design)

**What we already have that they don't.** `fleet-trace.service.ts` (FX.1)
already assembles a run into labelled steps with per-step latency, cost and
tokens — the waterfall data source exists and is used on the worker page. We
do not need to build tracing; we need to bring it to the fleet page and put
a timeline around it.

---

## 3 · The gap, named

1. **It is not a timeline.** It is a list of plans, capped at five, and only
   one plan exists.
2. **No events.** Runs, failures, findings, councils, approvals, decisions,
   halts and dial moves never appear on any timeline.
3. **No actor.** Nothing says who — which worker, or which human.
4. **No failure surface.** A 56% run-failure rate is not rendered.
5. **No filters, no search, no date range, no export.**
6. **No permalink.** You cannot link a colleague to one decision.
7. **No cost per step** on this page, though the data exists.
8. **No control from the timeline** — you can read, never act.
9. **No annotation** — you cannot mark a decision as wrong, so nothing learns.
10. **Risk tier invisible**, though every approval carries one.
11. **Silent cap** — `.slice(0, 5)` drops plans with no notice.
12. **Only one depth of disclosure**, then a raw JSON dump.

---

## 4 · Proposed phases (DT series)

Design rules carried from FX: sentence → card → JSON; names not IDs; every
new term gets a glossary entry; honesty over polish. Two rules added for
this series, both from the research:

- **Every event answers five questions in its one line**: who, what, when,
  what came of it, and where it came from (cron, human, API).
- **A control that is not enforced must not be rendered** (inherited from
  AC) — and its twin: *a column with no data is not a column*.

### DT.1 — The event spine (API only, invisible)
- New file `agent-fleet-timeline.routes.ts` + `fleet-timeline.service.ts`.
- One endpoint returning a normalized `FleetEvent[]`, unioned server-side
  from `AgentRun`, `AgentFinding`, `AgentPlan`, `AgentApproval`, fleet
  state changes, and — when AC.7 lands — `AgentControlAudit`.
- Every event carries: `at`, `kind`, `actor` (worker key *or* human *or*
  `system`), `title` (a plain sentence, built server-side so every client
  speaks one vocabulary), `outcome`, `riskTier?`, `costUSD?`, `entityRef?`,
  `episodeId` (the `orchestrationId`, or the plan/run it belongs to), and a
  `href` for the detail.
- Cursor-paginated, filterable by range/actor/kind/outcome, and it reports
  its own totals so nothing is ever silently capped.
- Acceptance: the endpoint returns ~150 real events today, and unit tests
  assert one event per source table with the right actor and sentence.

### DT.2 — The stream
- The panel becomes a reverse-chronological stream grouped by day, with a
  sticky day header and a marker per event kind (shape **and** color, never
  color alone).
- One line per event, readable cold: *"Negative-miner found 5 wasted search
  terms · 04:52 · from the nightly sweep"*, *"A run failed — could not reach
  Anthropic · 21 times today"*.
- Repeated identical failures **roll up** into one line with a count, so the
  stream stays scannable.
- Loading skeleton, empty state, error state, all designed here, not later.
- Acceptance: a first-time reader can say what the fleet did yesterday
  without opening anything.

### DT.3 — Episodes: the story, kept whole
- Events sharing an `episodeId` collapse into one card — *"Monday's council:
  4 workers found 15 things → the director planned 15 → the critic blocked
  it"* — expandable into its steps.
- Today's `PlanStory` becomes the plan step's detail, unchanged; it is good
  and it stays.
- Acceptance: the one real plan we have renders as a complete episode from
  first finding to critic verdict, with nothing lost from today's view.

### DT.4 — Depth: the trace, and what each step cost
- Any run event opens a **waterfall** — the steps `fleet-trace.service.ts`
  already produces, with per-step latency, tokens and cost, and the evidence
  preview it already returns.
- The expensive step is marked as such, in words.
- Acceptance: you can point at the step that spent the money, on the fleet
  page, without leaving for the worker page.

### DT.5 — Filters, search, permalink, export
- Range (today / 7d / 30d / all), actor, event kind, outcome, and a text
  search over the sentences. Filters live in the URL, so a filtered view is
  a link.
- Every event has a permalink; opening one scrolls to and highlights it.
- Export the filtered trail as CSV — the compliance half of the audience
  split, without giving the everyday view a spreadsheet's density.
- Acceptance: "show me every high-risk action a human rejected in July" is
  four clicks and a shareable URL.

### DT.6 — Control, from the timeline
- Act where you read: approve or reject an approval event inline; re-run a
  failed run; open the worker; pause the worker; halt the fleet.
- Each control states its consequence before it fires, and read /
  reversible-write / consequential-write are visually distinct (this is what
  `riskTier` is for).
- **Depends on AC.6** for run-now/cancel/pause endpoints. Until those exist,
  DT.6 ships only the controls that are already enforced — per the rule, an
  unenforced control is not rendered.
- Acceptance: every action reachable from this timeline changes real
  behaviour, and says what it will do before it does it.

### DT.7 — Annotation and precedent
- Any event takes an operator note ("this finding was wrong, the data was
  stale"). Notes are visible in the stream and feed the exemplar store the
  workers already read.
- Acceptance: a correction written here changes what the next run sees.

### DT.8 — The teaching gate
Not a phase you skip. Before DT is called done: every term has a glossary
tooltip; every icon has a text label; a legend explains every marker; the
first-visit walkthrough covers the stream; keyboard-only operation works
end to end; the page is readable at 200% zoom; and no state is signalled by
color alone.

---

## 5 · Sequencing

DT.1 → DT.2 → DT.3 is the spine and can ship as one visible change. DT.4
and DT.5 widen it. DT.6 waits on AC.6. DT.7 is small. DT.8 gates the lot.

Nothing here blocks the parallel session, and nothing it is building blocks
DT.1–DT.5.

## 6 · Decisions — settled by the operator, 2026-08-07

1. **Scope of the stream: fleet only.** Runs, findings, plans, critic
   verdicts, approvals, decisions, halts and dial moves. The deterministic
   ads engines stay out — mixing two systems into one timeline before either
   is legible is how it becomes complex again.
2. **The dead panels: strip now.** The `fleet-auditor` hero path and the
   three empty columns in "What it costs" come out as part of DT, and get
   rebuilt properly in sections 3 and 4. A visible lie is worse than a
   visible gap.
3. **The 56% failure rate: surface, don't chase.** DT.2 renders the failures
   honestly with the verbatim error. Diagnosing the 21× `fetch failed` is
   separate work — an infrastructure bug, not a timeline feature. **Logged
   as an open item; it must not be forgotten because it is now visible.**
4. **Retention: all of it.** There are ~150 events, not 150 million.
5. **Phase set:** awaiting go on DT.1–DT.3 as the first shippable unit.

---

## 6b · Execution record — DT.1–DT.3 built 2026-08-07

**Shipped.** New files only, plus two edits to files the parallel session
does not hold:

| File | What |
|---|---|
| `apps/api/src/services/agent-fleet/fleet-timeline.service.ts` | the spine: five tables → one `FleetEvent[]`, sentences built server-side |
| `apps/api/src/routes/agent-fleet-timeline.routes.ts` | `GET /api/agent/fleet/timeline` — separate file, zero merge surface |
| `apps/api/src/services/agent-fleet/fleet-timeline.vitest.test.ts` | 19 tests |
| `apps/web/.../fleet/TimelineStream.tsx` | the stream, rollups, episode cards |
| `apps/web/.../fleet/fleet-sections.css` | new stylesheet — `control-room.css` untouched |
| `apps/web/.../fleet/FleetTab.tsx` | panel swapped; dead hero removed; report-card columns made conditional |
| `apps/api/src/index.ts` | two lines registering the new route |

**Verified against the real database, not fixtures.** The spine returns
**148 events** where the panel used to show one plan. Paging walks the whole
history in 6 pages with **no gaps and no repeats** (asserted by a script, not
by eye). 19 unit tests pass; the full agent-fleet suite is **223 passing
across 31 files**, including the parallel session's own new tests.

**Verified in a browser**, against a read-only stub serving the real service
— the local API was deliberately *not* booted, because it starts always-on
crons against production Neon. Confirmed on screen: day grouping, episode
cards, the council episode expanding to its four steps with `PlanStory`
intact, verbatim failure text, "Showing 40 of 148" → "Showing 80 of 148" on
Show older, every control keyboard-reachable with `aria-expanded`, and no
horizontal overflow at 200% zoom.

**Five defects found and fixed during verification** — each one a case of the
page saying something untrue:
1. A critic "ran and found nothing" — a critic *reviews*; sentences are now
   role-aware by charter tier.
2. Eighteen approvals showed as "A worker" because their runs predate the
   fleet; they are now looked up by id and named.
3. The actor filter leaked the critic's ruling into the director's view —
   the filter is now enforced centrally, so "actor" means one thing.
4. "a plan of a plan of 15 actions" from a bad string replace.
5. The critic's full reasoning rendered twice in the same card; the row now
   carries its first sentence only.

Also fixed: "from someone asked for it" (source phrases are now all nouns,
since they always follow the word "from"), the episode icon described its
first child rather than the episode, and the sticky day header was
translucent enough for card titles to bleed through it.

**Gates run:** DS-conformance ratchet clean · RBAC coverage 0 unmapped
(`/api/agent/` → `ai.view`, so the endpoint is gated, not public) ·
`tsc --noEmit` clean on both apps.

**Not built yet:** DT.4 (trace waterfall), DT.5 (filters/search/permalink/
export), DT.6 (control — waits on AC.6), DT.7 (annotation), DT.8 (the
teaching gate).

---

## 7 · Open items carried out of this proposal

- **`fetch failed` × 21** — 47% of all fleet runs never reached Anthropic.
  Cause unknown. Surfaced by DT.2, to be diagnosed on its own.
- **No sweep has ever run.** The fleet map advertises "next sweep in …" for
  a job with zero runs to its name. Belongs to section 4 (The Brief).
- **`decidedBy` is null on all 18 decisions.** Nothing records who approved
  or rejected. Belongs to section 2 (Approval Inbox).
- **`fleet-auditor` charter does not exist**, though three places in the UI
  assume it does. Belongs to section 4 (The Brief).
