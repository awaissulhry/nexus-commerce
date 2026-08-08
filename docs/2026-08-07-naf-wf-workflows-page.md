# NAF.WF — the Workflows page (`/fleet/workflows`)

**Status: AWAITING APPROVAL** (research + proposed section map, 2026-08-07).

| | |
|---|---|
| **Page** | `/fleet/workflows` — Build group, position 2 of 4 |
| **Master study** | `docs/2026-08-07-naf-sb-fleet-pages.md` §6 (this engagement is SB.8, pulled forward by operator direction 2026-08-07) |
| **Session seam** | This session owns `apps/web/src/app/fleet/workflows/**`, this doc, and new backend files only (`agent-fleet-workflows.routes.ts`, `workflow-*.service.ts`). A parallel session owns Workers. Shared files (`schema.prisma`, `fleet-pages.css`, `app-nav.ts`, the master SB doc) are touched only with notice. |
| **Operator ask** | #3 — "a worker collects information from several other workers, compiles it, sends it to another worker, then other workers take a specific action without losing any context." Plus the composition half of #4 ("change workflows"). |

The method, per the operator: define the sections and their purposes first (this
doc), then a focused study per section before each is built, then build section
by section. Nothing here is code yet.

---

## PART 1 — What the industry does (four archetypes, 20 products)

Full agent reports are condensed here to what binds our design. Sources at foot.

### 1A · Automation canvases — n8n 2.0, Make, Zapier

- **n8n 2.0's draft/publish contract is the state of the art.** `Save` is
  autosave of a draft that never touches production; `Publish` locks the live
  version, and the confirmation explains publishing as three plain-language
  consequences ("Schedules will run at the times you've defined…"). Make still
  has *no* draft state (save = production, the only gate is an ON/OFF toggle) —
  and years of n8n incidents before 2.0 prove edit-the-live-thing is the trap.
- **Zapier stamps every run with the version that ran** (number + human title +
  publisher, searchable by "v3"); rollback is "Edit from this version" spawning
  a new draft. Versions are immutable, rename-only.
- **Make renders past executions on the diagram itself** — green titles for
  steps that ran, dimmed for skipped, count bubbles that open per-step
  input/output — and its `Review changes` diff is *categorized* (Modules /
  Flows / Error handlers, red/green side-by-side).
- **n8n's per-workflow tab triad** — Editor | Executions | Evaluations — is the
  cleanest IA of the three. Executions filter by `Failed / Running / Success /
  Waiting`; failed runs get "Debug in editor" (load that run's real data,
  pinned, fix against reality); retry offers "with original workflow" vs "with
  currently saved workflow" — an honest fork nobody else names.
- **Zapier's Human-in-the-loop is a complete state machine**: Request Approval /
  Collect Data steps; the reviewer can approve, decline, **or edit the data**;
  timeout in plain units with declared continue-vs-stop behaviour; a dedicated
  `Needs review` run status; the decision emitted as a field downstream.
- **Pitfalls, all three**: live-by-default testing (Zapier's `Test step`
  actually performs the action; a repeatedly documented beginner shock);
  scheduling split away from the canvas (Make's clock toggle — scenarios that
  never ran because the toggle stayed OFF); and their worst reviews are about
  *unclear errors and opaque metering*, not canvas mechanics.

### 1B · Agent-workflow builders — Copilot Studio, AgentKit, LangGraph, Dify, Flowise, CrewAI, Vellum, Relevance AI

- **Approval as a property of the connection**: Relevance AI sets every
  agent→tool and agent→agent edge to *Auto run / Approval required / Let agent
  decide*, with pending items in one Task View showing the proposed action
  **and its reasoning**. Dify's Human Input node gives each decision button its
  own outgoing branch and has an explicit **timeout branch**.
- **Typed edges, declared state**: AgentKit made every connection "a typed
  edge" with click-to-inspect contracts; Flowise requires state keys to be
  *declared at Start* — nodes may update, never invent, keys. Copilot Studio's
  default of passing full conversation history between agents is the documented
  anti-pattern (Microsoft's own guidance is nine rules of damage control).
- **The cautionary tale**: OpenAI deprecated Agent Builder ~13 months after
  launch; LangGraph deliberately never made Studio an editor — it renders the
  code-defined graph and concentrates value in run/debug surfaces. The lesson
  is not "no editor"; it is **render the graph from config, edit through
  structure, invest in the run surfaces** — not a free-drag canvas.
- **Preflight over faith**: Dify's Checklist blocks publish on unconfigured or
  disconnected nodes; Vellum's Release Tags add reviewer-approval gates on
  protected releases; LangSmith's trace rolls cost up per parent and breaks it
  down per child run.

### 1C · Orchestrators — Temporal, Airflow 3, Dagster, Prefect, UiPath

- **One list row answers past + future in the same glance** (Airflow): Schedule
  · Next Run · Latest Run · recent-runs strip · pause toggle. Prefect
  materializes *future* runs as inspectable rows ("Upcoming").
- **The run stamps the definition version it executed** — Airflow 3's Dag
  version column + Code-tab diff, Dagster's per-run snapshot, UiPath's pinned
  package version with one-click upgrade/rollback and documented mid-flight
  semantics.
- **The trigger deserves its own audit trail**: Dagster's tick timeline records
  every evaluation *including ones that launched nothing* — which is exactly
  what answers a beginner's "why didn't it run?". Temporal pauses require a
  written note; UiPath auto-disables a trigger after 10 consecutive failures.
- **Dagster's "Preview tick result" is the only true in-UI dry run** among the
  five — pick a mock evaluation time, see exactly what would happen.
- **Pitfalls**: scheduling semantics that need a lecture (Airflow's logical
  date is the most-documented beginner trap in orchestration); noun sprawl
  (Dagster's "a lot of nouns before your first production run"; Prefect's
  flow-vs-deployment split); health signals derived from infrastructure
  plumbing that false-alarm (Prefect's Ready/Not Ready), and pause states
  scattered across levels with no single effective status.

### 1D · Beginner-first + approvals — Power Automate, Retool, Windmill, Pipedream, ServiceNow, Camunda

- **The winning shape is a sentence**: "When an item is created → Start and
  wait for an approval → Condition → Send an email." Vertical, trigger first,
  verbs in step names, branches forking the layout under labelled answers.
  ServiceNow renders flows *in natural language* for non-technical users.
- **A stuck run always says who it's waiting for and until when**; a failed run
  says *what happened / how do I fix / resubmit* — and resumes **from the
  failed step** (Camunda incidents, Windmill restart-from-step, Pipedream
  replay), never from scratch.
- **BPMN's verdict is settled: barrier, not help.** Borrow its concepts in
  plain words — user task ("wait for a person"), timer boundary ("if no answer
  in 3 days, escalate"), token ("you-are-here marker on a live run") — never
  the notation.
- **The moment the primary view shows an expression instead of a sentence,
  beginners are out** (Retool's `{{ }}` conditions, Camunda's FEEL, Windmill's
  `results.step_name`).

### What the research binds us to (the ten commitments)

1. Two nouns only: **workflow** and **run**. No "deployment", no "process", no
   intermediate object, whatever the schema does internally.
2. **Draft ≠ live.** Editing never mutates what production executes; publish is
   explicit, and the publish confirmation enumerates its consequences in plain
   sentences.
3. **Every run stamps the version that ran**; every version is immutable, with
   a mandatory note, a categorized diff, and a rollback that spawns a draft.
4. **One honest effective status per workflow** (definition on/off ⊕ trigger
   gate ⊕ fleet halt ⊕ charters state), computed server-side — never three
   scattered toggles the operator must AND together in their head.
5. **The trigger reads as a sentence on the list row** ("Nightly at 04:45 UTC ·
   next in 6h") and keeps its own history — including the times it fired and
   launched nothing, with the reason.
6. **The edge is a typed artifact, never a transcript.** The UI shows what
   crossed each handoff and links to the evidence behind it (law L7 rendered).
7. **Gates live on the graph**: every step/edge shows *acts on its own* vs
   *asks you first*; pending gates land in the one Approvals inbox, and a
   waiting run names who it waits for and its expiry.
8. **A true dry-run lane** — "what would this workflow do", spending only model
   calls, writing nothing — plus loud labelling anywhere a test is live.
9. **Errors in sentences** (what happened / how to fix / retry from the failed
   step). Cost/tokens visible per run and per step — trust comes from legible
   errors and legible spend, not canvas polish.
10. **Nobody starts from a blank canvas**: built-ins seed the page as working
    examples; creation (later) starts from a template or a duplicate.

---

## PART 2 — The verified truth about our code

From full recon of the orchestrator, executor, charters, approval gate, web
shell and schema (paths cited so the build phases can go straight there).

1. **Only three of the "six run modes" exist.** `sweep`, `council`, `ask` have
   real code paths (`fleet-sweep.job.ts`, `fleet-council.service.ts`,
   `agent-fleet.routes.ts:760`). `tick`, `summit`, `incident` are strings in a
   type union (`agent-executor.ts:45`) and a label map — **zero call sites**,
   and no strategist charter exists. The master doc's "seed the six modes as
   built-in workflows" honestly means **three**.
2. **`runFleet` accepts only `'sweep' | 'council'`** (`orchestrator.ts:55`) and
   walks the code-declared `FLEET_GRAPH` (7 nodes, 4 edges, artifact types
   `finding | plan | strategy` — `fleet-graph.ts:31-47`) by topological levels
   with per-node re-checked gates (kill switch, fleet halt, budgets). Executing
   a *stored* graph is new orchestrator work.
3. **The versioning precedent is already built and proven** —
   `AgentCharterRevision` + `charter-revisions.service.ts`: immutable
   revisions, mandatory note ("the change log IS the audit"), activation moves
   a pointer, **revert-to-code can never fail**, hand-rolled LCS diff, A/B by
   run parity. `AgentWorkflow`/`AgentWorkflowRevision` mirrors this shape and
   the law: **code default ⊕ active revision**.
4. **A per-step gate policy would be the first place the charter dial's
   PROPOSE-vs-AUTO distinction actually bites.** Today fleet-side enforcement
   is only OFF-vs-not (`agent-executor.ts:221`); act-vs-ask is carried entirely
   by tool policy (`requiresApproval` / the immutable `alwaysAsk` floor,
   `tool-policy.service.ts:4-10`). A workflow gate may *tighten* (force ask on
   a step) and never loosen below tool floors — refuse, not clamp, mirroring
   `PATCH /charters/:key`.
5. **No workflow-like model exists.** No `AgentWorkflow`, `AgentRoutine`,
   `AgentTrigger` in the schema. The existing `Workflow*` models
   (`ProductWorkflow`, `WorkflowStage`…) are an unrelated PIM domain — the
   `Agent*` prefix avoids the collision. `AgentRun` already carries
   `orchestrationId`, so a "workflow run" is an orchestration group, not a new
   noun — `AgentRun` gains nullable `workflowKey`/`workflowRevisionId` columns
   (additive migration, convention `20260808a_naf_wf_workflows`).
6. **Freebies**: routes under `/api/agent/fleet/workflows*` inherit
   `ai.view`/`ai.run` RBAC with zero manifest changes; `nextCronFire()`
   (`fleet-schedule.service.ts:41`) is pure and exported — "next run in 6h" is
   cheap; `GET /agent/fleet/schedule` already returns per-job
   last-run/next-fire; the trace viewer (`fleet-trace.service.ts`) already
   serves per-run step narratives.
7. **Web conventions are settled**: `fleet-pages.css` with the `acr-pg-*`
   prefix (the SB seam — third stylesheet, parallel-session-safe), light-only
   surface pinned by `fleet/layout.tsx`, `FleetPageShell`, the Workers/Controls
   client patterns (parallel no-store fetches, only the spine fetch fatal,
   client-side join in `useMemo`, `Term` glossary tooltips with the
   no-entry-renders-plain rule, teaching empty states, asymmetric confirmation
   — reducing risk applies at once, increasing risk asks first). A "How this
   works" drawer is **owed** on every SB page (condition of done, FX.4).
8. **xyflow `^12.11.1` is installed with read-only prior art** —
   `FleetMapCanvas.tsx`: hand-computed tier-column layout, custom `WorkerNode`,
   autonomy-tinted cards, animated artifact edges, `draggable:false,
   connectable:false`. Six canvases exist app-wide with **no shared helpers**.
9. **`AGENT_FLEET.md` has no composition section.** "Workflow" appears 4 times
   in 1002 lines, none load-bearing. §3.3 declares the graph static in code and
   rejects LangGraph/Temporal/CrewAI/Mastra; the laws that bind this page are
   **L2** (zero new write paths), **L3** (no agent spawns an agent; the
   orchestrator is the only thing that starts agents), **L4** (schema-validated
   artifacts), **L7** (blackboard, not mailbox — "every handoff is a condensed
   artifact"). A stored workflow definition becomes control #21, next of kin to
   #16 (charter versioning). The capability/composition split (master doc Part
   4) is what keeps a UI-edited workflow inside those laws.
10. **The data reality**: the fleet is dark (all charters OFF), no sweep has
    ever run, 2 council runs exist, 43 of 45 runs were `ask`. A page built
    canvas-first over that would be ten empty screens. WF.1 below is read-only
    over what exists precisely because of this.

---

## PART 3 — What this page is NOT (boundaries, so nothing is built twice)

| Neighbour | Owns | Workflows page relationship |
|---|---|---|
| **Fleet map** (`/fleet/map`) | The whole fleet as it is *now* — live pulses, overlays | A workflow detail shows **one named routine's definition**. Airflow's cluster view vs one DAG. If they drift together, merge them (master doc risk #3). |
| **Activity** (`/fleet/activity`) | Fleet-wide decisions + runs stream, the trace viewer | The Runs tab here is the **same run rows scoped to one workflow** — same components, same trace drawer, reused not rebuilt. |
| **Approvals** (`/fleet/approvals`) | The one blocking queue | A gated workflow step **sends** items there and **links** there ("waiting on your approval since Tue"). No second inbox here, ever. |
| **Workers** (`/fleet/workers`, sibling session) | The registry; one worker's charter, prompt revisions, scorecard | Workflows wire **between** workers. Charter revisions version a worker's *prompt*; workflow revisions version the *wiring*. Same interaction language (revision list, mandatory note, diff, activate), different objects — deliberate consistency, zero shared surface. |
| **Assignments** (`/fleet/assignments`, future) | Point a worker at a named entity, queue semantics | An assignment arriving is a future workflow *trigger type*; the assignment object itself never lives here. |
| **Controls** (`/fleet/controls`) | Fleet-wide levers: halt, dials, budgets, audit | Per-step gates here are scoped to one workflow and always bounded by Controls' fleet-wide floors. |

---

## PART 4 — The proposed sections

Seven sections. Each gets its own focused study before build (the DT method).

### WF-S1 · The routine list — the page itself

**Purpose:** one row answers *what it is · whether it's on · when it last ran ·
how that went · when it runs next · where humans sit* — without a click.

Contents: stat strip (routines, enabled, runs + spend this week) · one row per
workflow: name + one-sentence purpose ("Every analyst reports; findings are
graded") · **effective status** as a single honest badge with the reason when
off ("Off — fleet cron disabled") · the trigger sentence ("Nightly at 04:45 UTC
· next in 6h", via `nextCronFire`) · last run (outcome, when, cost) · recent
outcomes strip · gate summary ("2 steps ask you first") · version chip (v3 ·
Built-in) · a **Built-in** badge on the three seeded routines. Teaching empty
state; no create button until WF.3 (creation starts from duplicate/template,
never blank).

### WF-S2 · The routine's story — detail overview

**Purpose:** a beginner opens "Weekly council" and understands in one screen
who does what, in what order, and where a human sits.

Contents: the definition graph, read-only xyflow (worker cards with autonomy
tint, edges labelled with the artifact type that crosses — `FleetMapCanvas`
conventions) · beneath it, **the same routine as one plain sentence** ("Three
analysts gather findings → the director compiles one plan → the critic checks
it → anything that survives waits for you in Approvals") · the trigger sentence
+ next fire · health strip (last run, success over last N, avg duration, avg
cost) · gate badges on steps (*acts on its own* / *asks you first*) · a
you-are-here token on the graph when a run is live or waiting.

### WF-S3 · Runs — per-routine history

**Purpose:** "what happened when this routine ran", linked both ways with the
definition (the Airflow rule).

Contents: one row per orchestration: when · provenance (schedule / manual, by
whom) · outcome **including skipped-with-reason** (halted: kill switch, budget,
stale evidence) · duration · tokens + cost · what it produced (N findings, a
plan, M approvals queued) · **version stamp** · waiting states surfaced as
sentences ("waiting on your approval since Tue 14:02, expires in 20h" →
Approvals). Row click → the existing step trace. Reuses Activity's row + trace
components.

### WF-S4 · Versions

**Purpose:** a behaviour change readable as a change; a rollback that cannot
fail.

Contents: revision list (note **mandatory**, author, when, active pointer) ·
categorized structural diff (Steps / Connections / Gates / Trigger — Make's
grouping, our data) · restore = new draft from an old revision (Zapier's "edit
from vX") · **revert to built-in** one click, mirroring revert-to-code · runs
stamp their revision · publish confirmation enumerates consequences ("From the
next nightly sweep, the negative-miner will no longer run; nothing already
queued changes").

### WF-S5 · The editor — composition only

**Purpose:** asks #3/#4, strictly Layer 2. Charter types, tools, write paths
stay in code (L2/L3); the operator edits *wiring, gates, trigger, scope*.

Contents: **structured panels + always-live canvas** — click a step or edge to
edit it in a side panel; connections are made by picker ("compiles findings
from: ☑ negative-miner ☑ harvester"), which the canvas renders; no free-drag
wiring (the Agent Builder lesson; recommendation D1 below). Add step = pick
from registered charter keys only — a worker absent from `FLEET_CHARTERS` does
not exist. Per-edge handoff contract shown (artifact type + evidence refs
travel with it). Per-step gate: *ask first* / *may act* — tightening always
allowed, loosening refused below tool floors, server-refused not clamped.
Trigger: schedule (cron with live plain-sentence preview) or manual; event /
assignment-arrival listed as future. Save-time validation: acyclic
(`topoLevels` throws), artifact types accepted by the target tier, gates ≥
floors, known keys. Draft autosaves; **publish is the only thing that touches
production**.

### WF-S6 · Test run

**Purpose:** answer "what would this do" before publishing or enabling,
spending only model calls.

Contents: run the **draft** in preview mode (the AC precedent: real evidence,
real model, `mode='preview'`, writes nothing) · per-step: what it read, what it
produced, what it *would have queued* · total cost of the test itself, stated
up front · loud labelling that model spend is real while writes are not ·
later: replay a past run's evidence through the edited draft (n8n's
debug-in-editor, blackboard-flavoured).

### WF-S7 · The teaching layer — condition of done, not a phase

"How this works" drawer on the page header · glossary `Term` entries for every
new noun this page mints (workflow/routine, trigger, gate, handoff, draft,
publish, version, test run) — the FX rule: new jargon requires a glossary entry
· teaching empty states everywhere · every button names its effect · run states
are sentences, never jargon (`Waiting — on your approval, expires Friday`).

---

## PART 5 — The model (sketch for review, not implementation)

**Two-layer law applied** (master doc Part 4): Layer 1 in code — charter types,
tools, write paths, artifact schemas, the executor. Layer 2 as data — this:

- **`AgentWorkflow`** — `key` (unique), `name`, `description`, `kind`
  (`builtin | custom`), `enabled`, timestamps, `createdBy`. Built-ins' truth
  is code (`FLEET_GRAPH` + the two cron jobs); the row is presence + toggle.
- **`AgentWorkflowRevision`** — `workflowKey`, `revision` (monotonic),
  `definition Json` (steps `{charterKey, gate: 'ask'|'act'|'inherit'}`, edges
  `{from, to, artifact}`, trigger `{type:'schedule', cron} | {type:'manual'}`),
  `note` (mandatory), `author`, `createdAt`, `activatedAt`, `supersededAt`,
  `@@unique([workflowKey, revision])` — byte-for-byte the charter-revision
  contract: immutable, activation moves a pointer, **no/unreadable active
  revision ⇒ the code definition runs**, so revert-to-built-in can never fail.
  A custom workflow's floor is *disabled*, not a code fallback.
- **`AgentRun`** gains nullable `workflowKey`, `workflowRevisionId` (additive).
  The run list groups by `orchestrationId` — no new run noun.
- **Orchestrator**: `runWorkflow(definition, opts)` generalizing `runFleet` —
  same `topoLevels`, same per-node re-checked gates, same "an agent failure is
  that agent's failure, never the fleet's". Gate `'ask'` on a step forces the
  approval path regardless of tool default (tightening only).
- **Routes** (new file `agent-fleet-workflows.routes.ts`, RBAC-covered):
  list/detail/runs/revisions/activate/revert/preview, mirroring the charter
  route grammar including refuse-not-clamp and the 409-on-worse-eval pattern
  where it applies.

---

## PART 6 — Operator decisions requested

1. **D1 — Editing surface.** Recommend **structured panels + always-live
   canvas** (click-to-edit, picker-driven connections, no free-drag wiring).
   The alternative — full drag-and-drop authoring — is what OpenAI shipped and
   killed in 13 months, and every beginner study says expressions and free
   canvases are where novices fall off. The canvas stays; only the *editing
   idiom* is structured.
2. **D2 — Seeded built-ins.** Recommend seeding **three** (Nightly sweep ·
   Weekly council · On-demand check), because only those exist in code.
   `tick`/`summit`/`incident` appear in the guide as future modes, not as rows
   pretending to be runnable.
3. **D3 — Build order (Part 7).** Recommend read-only first over live data,
   editor after the model settles — confirm or reorder.

---

## PART 7 — Suggested order (each phase independently shippable)

| Phase | What | Why here |
|---|---|---|
| **WF.1** | Read-only: routine list (S1) + detail story (S2) + runs tab (S3) over the **code truth** — `FLEET_GRAPH`, `/schedule`, `/runs`, the trace route. No schema changes. | Ships real value now; honest about the dark fleet; establishes the Map boundary and the plain-sentence idiom everything else reuses |
| **WF.2** | `AgentWorkflow` + `AgentWorkflowRevision`, seed built-ins, Versions tab (S4) with diff + revert-to-built-in. **Schema touch — coordinated with the Workers session before migrating.** | Layer 2 settles here, which the master doc says must precede the editor |
| **WF.3** | The editor (S5): draft/publish, structured editing, save-time validation. | Wants WF.2's model; still executes nothing new |
| **WF.4** | Stored-graph execution: `runWorkflow`, run stamping, per-step gate enforcement at the approval path. | The first behavioural change; smallest possible diff once WF.2/3 exist |
| **WF.5** | Test run (S6): preview lane over the draft. | Wants WF.4's executor; the AC preview precedent makes it mostly assembly |
| **WF.6** | Deferred, with reasons: event + assignment triggers (wants the Assignments page); duplicate-as-custom + template gallery (wants ≥1 custom workflow to exist); workflow-level evaluations (n8n's third tab — wants real run volume); per-workflow spend budgets (Controls owns fleet budgets today). | Not lost, just honest |

S7 (teaching) is a condition of done on every phase. Each phase begins with its
focused section study appended to this doc, DT-style, and ends verified on prod.

---

## PART 8 — Section studies and execution record

### WF.1 / S1 — the routine list (study, 2026-08-07)

**What one row must answer** (commitments 1, 4, 5): what this routine is · one
honest status · when it runs, as a sentence · how the last run went and what it
cost · the recent record · what it may touch. No click required for any of it.

**Verified data truths this section stands on:**

- `GET /agent/fleet/runs` returns **full `AgentRun` rows** (the route has no
  `select`), so `costUSD` (Decimal → **string** over JSON, `Number()` it),
  `findingCount`, `orchestrationId`, `haltedReason`, `trigger` are all already
  available. Filterable by `mode`, capped at 100 — at 47 lifetime fleet runs
  that is full coverage today; the per-routine aggregate endpoint stays owed
  (same caveat the Workers roster records).
- `GET /agent/fleet/schedule` returns the two cron jobs with `enabled` (the
  `NEXUS_ENABLE_FLEET_SWEEP_CRON` env gate), `nextFireAt` (**null when the gate
  is off** — the UI must say "not scheduled", never "next: —"), and `lastRun`
  from `CronRun`.
- **A routine run is an `orchestrationId` group** of `AgentRun` rows (sweep,
  council); an `ask` run stands alone (`orchestrationId` null → group of one).
  Group outcome: any `haltedReason` → halted; else any `!ok` → failed; else ok.
  Cost = sum, findings = sum, startedAt = earliest.
- **Effective status, one per routine, computed in one place** (the
  anti-Prefect commitment). Precedence: fleet halted (from `/state`, with the
  stored reason — a halt blocks manual runs too, `executeCharter` gates them) →
  cron gate off ("the fleet clock is off") → sweep: zero analysts on ("the
  clock ticks but every worker is off" = Idle) / council: director or critic
  off (Idle — a council without both produces nothing) → On, with the worker
  count. On-demand check is Ready unless halted (`ignoreEnabled` bypasses the
  dial, not the gates).
- Trigger sentences are derived from the cron the API reports (env override
  respected), not hardcoded: `45 4 * * *` → "Nightly at 04:45 UTC · next in
  6h", `15 5 * * 1` → "Mondays at 05:15 UTC".

**Decisions:** table over cards — three rows today is honest, not thin, and the
shape scales when custom workflows exist. Rows are **not links yet** — the
detail page arrives in S2, and a dead link is worse than none. Glossary mints
two entries (`workflow`, `trigger`) under the locks-doc protocol (re-read
immediately before edit, never redefine). The "How this works" drawer ships
with S2 (the detail page is its natural home); S1 teaches through the intro
line, the Terms, and status sentences that carry their reasons.

**Cross-session alignment** (`docs/2026-08-07-naf-sb-session-locks.md`, read
mid-build): page styles live in a page-local `workflows.css` — `fleet-pages.css`
is frozen to shared primitives (locks decision 4, adopted). Real-time is the
**settled shared decision #1**: visibility-gated polling, ~10s while the tab is
visible, an "as of" stamp, no silent re-sort — the shared hook is extracted
*early* by this stream (the locks doc allows it) at
`apps/web/src/app/fleet/_shared/use-visibility-poll.ts`, and Workers re-points
at it in W.6. One open convergence recorded rather than hidden: SB.W's Study 0
chose the DS DataGrid substrate for the Workers roster (after pinning DS tokens
on `.fleet-surface`); S1 ships on the fleet's current `acr-pg-tbl` convention —
three fixed rows need no grid machinery, and adopting DataGrid before the token
pinning lands would render broken. When SB.W's substrate lands, the workflows
list converges onto it.

### WF.1 / S2 — the routine's story (study, 2026-08-07)

**Purpose:** open "Weekly council" and understand, in one screen, who does what
in what order and where you sit. Route: `/fleet/workflows/[key]`; S1's rows
become links the moment it exists.

**The honest pipeline truth, from code — with one wrinkle.** `runFleet(mode)`
walks the SAME `topoLevels(FLEET_GRAPH)` for both sweep and council; the modes
differ in what surrounds the walk. So:

- **Nightly sweep** = reclaim stuck runs → the level walk (all non-standalone
  workers — which *includes the director and critic if they are on*, see
  wrinkle) → findings shadow-graded → report cards → entity graph re-derived →
  demotion check → the auditor's brief (standalone, run explicitly after
  scorecards, `fleet-sweep.job.ts:71`).
- **Weekly council** = approval maintenance (the single expiry clock) → the
  level walk → the director's plan read back → the critic's verdict → code
  pre-checks whose forced blocks override a passing critic → survivors queue
  as approvals with the 20-second undo window.
- **On-demand check** = one worker, `executeCharter` with `ignoreEnabled`,
  gates still applied; result readable via the existing trace route.

**Wrinkle, stated rather than papered over:** because the sweep's walk covers
the whole graph, an *enabled* director would also run nightly and mint plans no
council processes. Today it is OFF so the story is unaffected; the S2 story
graph shows the director/critic inside the council story only, and the study
flags this as a question for WF.4 (stored execution should scope the walk per
workflow, which resolves it structurally).

**Design:**

- **Story graph per routine, declared web-side** (extends `routines.ts`):
  worker steps (by charter key, joined live with `/agent/fleet/graph` for
  autonomy tint + degraded), deterministic **code steps** (grading, report
  cards, entity graph — visually neutral: they are math, not judgment), and
  the **approval gate step** rendered as where-you-sit. Edges carry artifact
  labels (findings, plan, approvals).
- **Canvas:** xyflow read-only, `FleetMapCanvas` conventions (hand-computed
  layout, `draggable:false`), plus the same routine as **one plain sentence**
  beneath — the beginner shape from Part 1D riding under the graph.
- **You-are-here:** any `status==='running'` run of this routine's mode marks
  its worker's node live (10s poll makes it near-live); a `Waiting` state on
  approvals links into `/fleet/approvals`.
- **Health strip:** last run · success over the recorded groups · average
  duration (`endedAt−createdAt`) · average cost — from S1's `groupRuns`,
  extracted to a page-local `lib.ts` both surfaces import.
- **"How this works" drawer** ships here — page-local component following the
  Overview drawer's interaction pattern, content specific to workflows
  (routine vs map, trigger, gate, what a version will be).

### WF.1 / S3 — runs on the routine's page (study, 2026-08-07)

**Purpose:** "what happened when this routine ran", one row per orchestration,
linked both ways with the definition.

**Reuse verdict:** the step-trace UI lives *inside* `WorkerClient.tsx`
(fetching `/runs/:id/trace` into local state) — not a standalone component,
and the file belongs to another stream. So S3 does **not** rebuild or extract
a trace viewer: a group expands into its per-worker runs, each carrying a
plain-sentence outcome from `run-health.classifyFailure` (the shared taxonomy)
and a link to that worker's page, where the full step story already renders.
The full trace drawer remains the Activity page's to own; when it exists as a
shared component, this section re-points at it.

**A latent bug fixed here, found via SB.W's W.2 note:** an `AgentRun` is
created `ok:false` and flips true only on finish — so `groupRuns` was counting
an in-flight orchestration as *failed*. Groups now derive their outcome from
**finished runs only** and carry `running`; the list's dots and last-run cells
gain an honest "running now…" state. (`classifyFailure` already guards the
same trap per-run.)

**Shape:** a "Runs" card on the detail page between the pipeline and the
teaching card. Latest 12 orchestrations (honest "latest 12 of N" line when
capped by the 100-run fetch): when · started by (the clock / by hand) ·
outcome in words ("finished clean" / "2 of 4 workers failed" / "stopped at a
limit" / "running now…") · workers · findings · cost · duration · expand.
Expanded: one row per worker-run — name, outcome sentence, findings, cost,
duration, link to the worker's page. No version column until versions exist
(WF.2): an always-empty column teaches nothing.

### WF.2 / S4 — versions (study + interim, 2026-08-07)

**The protocol gate, honored:** the stored model is the locks doc's §4
coupling — "neither session designs this alone; whoever reaches it first
writes the proposal and the other reviews before any code." The full proposal
(Half A worker instances · Half B `AgentWorkflow`/`AgentWorkflowRevision`,
meeting only at `resolveCharter`; migration `20260807c_naf_wf_workflows`) now
sits in `docs/2026-08-07-naf-sb-session-locks.md` §4, **awaiting Workers
review**. No migration runs until that section says REVIEWED.

**Shipped meanwhile (schema-free):** a Versions card on the detail page
stating today's truth — one version, `v1 · Built-in — defined in code ·
active` — and the contract every future revision will honor (mandatory note,
categorized diff, revert that cannot fail, runs stamp their revision, publish
is the only thing that changes production). The card becomes the revision
list the moment the model lands; its promise text is the acceptance criteria
for full S4.

**EXECUTED 2026-08-07 (`fa25a559e`), verified on prod.** §4 REVIEWED same day
("Half B is clear to build", with the enumeration caveat recorded as Workers'
half and the instance-not-in-built-in-sweep caveat routed to their create
flow). Landed: the two models in the marked schema block + two nullable
`AgentRun` stamp columns; migration `20260807c` applied clean on the Railway
deploy; built-ins **derived from `FLEET_GRAPH` + cron envs at read time** so
code truth cannot drift; `validateDefinition` resolves steps via the async
`resolveCharter` (a sync truthiness check would have always passed — caught
before commit) and proves acyclicity with the orchestrator's own
`topoLevels`; routes in `agent-fleet-workflows.routes.ts` with a one-line
`index.ts` registration; seed run via `railway run` — three rows,
`source=code · revisions=0 · seeded=true`. Web verified live: the revisions
fetch returns 200 and the card renders from it (its static fallback covered
the deploy window, so no lying interval existed). Two `strict:false` traps
hit and encoded: union narrowing (optional-`error` member per the fleet
convention) and literal widening on `Object.freeze` (annotate the definition
closures). The sibling's W.6 note proved true here too:
`document.visibilityState` is `hidden` in an automated tab, so polls pause in
automation — mount loads still fire, which is what the verification used.

### WF.3 / S5 — the editor (study, 2026-08-07)

**What the editor is:** the first surface where the operator *authors*
composition — strictly Layer 2. It edits a routine's **wiring** (which
workers, what each hands to which), and its **gates**. It edits nothing in
Layer 1: no prompts (Charter Studio owns those), no tools, no write paths,
no new workers. D1 stands: structured panels beside an always-live canvas;
connections made by pickers; no free-drag wiring.

**What it stands on (all live as of WF.2):** `POST /:key/revisions` with
server-side `validateDefinition` (sentence errors, async `resolveCharter`,
`topoLevels` acyclicity) · `POST …/activate` with its honest caveat ·
`POST …/revert-to-builtin` · `GET …/revisions` returning `effective`,
`source`, `code` and the revision list · the immutable-revision grammar.
The server is the validation truth; the editor's checklist is a convenience
mirror, never the authority.

**Four scoping decisions, with reasons:**

1. **The trigger is read-only in WF.3.** The schedule truth today is the env
   cron read by `getFleetSchedule` and the registered node-cron jobs — a
   published revision changing the cron would render "When it runs" as a lie
   the fleet does not honor. Trigger editing unlocks in WF.4, where stored
   execution starts honoring the stored definition. The trigger panel says
   exactly this.
2. **Built-ins only.** The create/duplicate flow for custom workflows stays
   in WF.6 — the server already refuses revisions for unknown keys, and a
   "create" button with no instance story (Workers' W.8) would promise more
   than the fleet can run. Editing the three built-ins' wiring is the honest
   full scope of WF.3.
3. **A draft is an unactivated revision — client state until saved.** No new
   storage: "Save as draft" creates an unactivated revision (note mandatory);
   "Publish…" creates *and* activates in one flow behind a confirmation that
   shows the categorized diff (Steps / Connections / Gates — Make's grouping)
   and enumerates consequences in plain sentences (the n8n pattern), plus the
   recorded-not-live caveat until WF.4. Edit state also mirrors to
   localStorage so a lost tab loses nothing. Known and accepted: immutability
   means unactivated drafts accumulate rather than delete; the Versions list
   labels them honestly.
4. **The editor edits the definition graph only** — charter steps and their
   edges. The story's code furniture (grading, report cards, the board, the
   approval gate) is context, not data: rendered as read-only ghosts in read
   mode, absent in edit mode. Edge artifacts are derived from the source
   worker's tier (analyst→finding, director→plan, strategist→strategy),
   shown rather than asked.

**The honesty prerequisite found by this study (WF.3a, build first):** the
detail page's read mode renders the hand-authored *story*. The moment a
revision can alter wiring, that becomes a lie — an active revision's wiring
must be what the canvas shows. So before any edit UI: a
`definitionToStory()` adapter (definition + live charter names → the canvas
shape), read mode rendering the **effective** definition whenever
`source='revision'`, and the story presentation reserved for the pure-code
state. This also gives the editor its canvas for free — the edit-mode canvas
is the same adapter over the draft.

**The edit idiom, per panel:** each step is a card — worker name, what it
reads (from its charter, read-only), its **gate** as three plain choices
(*inherit — today's behaviour · ask first — every proposal from this step
waits for you · may act — the tool's own policy decides*, tighten-only with
the floor named when it binds), and its **hands-to** picker ("hands findings
to: ☑ Director") which IS the edge editor. Add step = picker over resolvable,
not-already-present charters. Remove step = removes its edges, says so.
Drafts are inert, so edits apply instantly with no confirms; **Publish is the
one consequential act** and carries the whole ceremony (diff + consequences +
caveat). A Dify-style problems list (client mirror of the server rules)
blocks Publish with sentences; the server re-checks regardless.

**WF.3 build order, each shippable:** **a** — adapter + effective-definition
read mode (honesty first). **b** — edit mode: step cards, add/remove,
gates, hands-to pickers, checklist, Save-as-draft / Publish, Versions rows
gain Activate-with-diff and a real Revert-to-built-in. **c** — teaching:
glossary `+draft` `+publish` `+gate` (locks protocol), edit-mode empty
states, and the How-drawer paragraph updated from future to present tense.

**EXECUTED 2026-08-07 (`a13406323` + `88efd6c27`), round-trip verified on
prod.** The full cycle ran live on the Weekly council: Edit the wiring →
step cards rendered the code truth exactly (three analysts hand findings to
the director — checked; the director "HANDS PLAN TO" — artifact derived from
tier; the self-test hands to no one) → Bid tuner's gate to *Ask first*, the
draft canvas updating live → Publish… showed `gate: amazon-bid-tuner —
inherit → ask`, refused until the note was written → published with **author
attribution from the session** (`awaissulhry@gmail.com`) → read mode
switched to "showing the ACTIVE REVISION's wiring" with the amber
recorded-not-live banner → **Revert to built-in** restored the code story
one click later, rev 1 left `superseded` in the permanent history. The
machinery's first real revision exists, and every honesty seam held.
One gate proved itself mid-flight: the first push was **rejected by the
fleet DS-conformance manifest** (SB.W's substrate) for a raw `<select>` —
fixed with the DS `Menu` and the four DS stylesheets imported in the
Workers page's order (`88efd6c27`). A ratchet that catches its sibling
stream within the hour is a ratchet working.

### WF.4 — stored execution (study, 2026-08-07)

**What WF.4 is:** the moment Layer 2 becomes real. The orchestrator walks the
stored definition instead of the frozen code graph; every run stamps the
workflow and revision that served it; per-step gates bind at the approval
gate; the clock honors the stored cron. All of it ships dark-safe: every
charter is OFF, and a parity test proves an unrevised built-in walks
byte-identically to today.

**Verified truths this study stands on (read in code, 2026-08-07):**

1. **`runFleet` generalizes surgically.** Verified shape
   (`orchestrator.ts:55-110`): orchestrationId → `topoLevels(FLEET_GRAPH)` →
   per-node re-checked gates (kill switch → halt → budget) → `executeCharter`
   → per-agent failure isolation. The only structural change WF.4a makes is
   *where the levels come from* — a stored definition's steps/edges instead
   of the constant — plus two stamp fields threaded through.
2. **A council "survivor" cannot reach the inbox today — structurally.**
   Verified at `approval-gate.service.ts:67-69`: a tool without `execute()`
   returns `mode:'preview'` and creates **no** `AgentApproval`; the council
   counts only `mode==='queued'`, so every item of a passing plan lands
   `blocked` and the plan stays `critiqued`. The fleet's three tools are
   deliberately preview-only (Phase C). "Survivors wait for your approval"
   is design intent that becomes mechanics only when tools gain `execute`
   (Phase F). **Consequence:** WF.4b's gate enforcement is proven by tests,
   never by watching an inbox that structurally cannot fill — recorded so
   nobody burns an afternoon "verifying" it the wrong way.
3. **The auditor ordering trap (found by this study).** The WF.2-derived
   sweep definition includes `fleet-auditor` as a step; a stored walk would
   run it at level 0 (it has no incoming edges) — but the job deliberately
   runs it AFTER scorecards. Fix in WF.4a: **the auditor leaves the derived
   definition** — it is job furniture like grading, and the S2 story keeps
   showing it as presentation. Editor consequence, stated honestly: the
   sweep's auditor is not gateable or removable, because its ordering is
   code.
4. **The S2 wrinkle becomes operator-fixable, not silently fixed.** The
   derived sweep definition mirrors today's walk (all non-standalone nodes,
   director and critic included), so parity holds for unrevised built-ins.
   Once WF.4a lands, an operator can publish a sweep revision *without*
   director/critic — the scoped walk honors it, and the nightly-plans
   wrinkle dies by an edit, with a diff, on the record.
5. **Schedule honoring needs re-registration, not wishes.** node-cron tasks
   are registered at boot from env; a stored cron read at fire time cannot
   change *when* the task fires. The API process hosts the crons, so the
   activate/revert routes can call a rescheduler directly. WF.4c: boot reads
   the effective cron (env as fallback), activation and revert re-register,
   `fleet-schedule.service` reports the effective cron's next fire, and the
   editor's trigger panel unlocks.

**Design decisions:**

- **D-WF4.1 — which gate governs a plan item?** Items carry `findingId`;
  findings carry `charterKey` — the origin analyst is traceable. An item is
  gated by **its origin step's gate** (the analyst whose finding it enacts),
  falling back to the director step's gate, then `inherit`. This is what an
  operator means by "the bid tuner asks first": bid-tuner-derived actions
  ask. Enforcement: `runOrQueueTool` gains an optional `forceAsk` —
  **tighten-only by construction** (it can force the approval branch, never
  skip it), so the `alwaysAsk` floor and L2 survive untouched.
- **D-WF4.2 — the workflow row's `enabled` becomes real.** A disabled
  workflow's job fires, writes a CronRun with "disabled by the operator" and
  runs nothing. (UI toggle follows on the list page — the column exists.)
- **D-WF4.3 — stamping.** `executeCharter` opts gain
  `workflowKey`/`workflowRevisionId`, written at run creation. Manual `ask`
  runs stay null (they are not a workflow's doing). The S3 runs table then
  gains its version chip — the column the study deferred until it could be
  non-empty.

**Sub-phases, each shippable and dark-safe:** **4a** — `runWorkflow(def)` +
jobs resolve `getEffectiveDefinition` at fire time + stamping + `enabled` +
auditor derivation fix + **parity vitest** (unrevised defs walk ≡ today's
`topoLevels(FLEET_GRAPH)` minus standalone). **4b** — `forceAsk` + origin-
gate resolution + tighten-only tests. **4c** — cron re-registration +
effective next-fire + trigger panel unlock.

**Claims:** WF.4 touches `orchestrator.ts`, `agent-executor.ts` (two-field
passthrough), `fleet-sweep.job.ts`, `fleet-council.service.ts`,
`fleet-schedule.service.ts` — none currently in the locks doc's shared
table; claim rows added before build.

**WF.4a EXECUTED 2026-08-07 (`6fb2962a8`), proven inert on prod.** The pure
definition layer extracted to `workflow-defs.ts` (no database imports) so
the parity vitest exists: **7 tests green** — unrevised built-ins walk
byte-identically to `topoLevels(FLEET_GRAPH)`, the auditor asserted absent
from the stored sweep, derivation adds no policy (every gate born
`inherit`). `runFleet` resolves the stored definition at fire time
(revision → code → unreadable-falls-to-`FLEET_GRAPH`), honors the row's
`enabled`, and stamps `workflowKey`/`workflowRevisionId` on every run
including gate-trip rows; the Runs UI shows "wiring rev N" on stamped
orchestrations. **Prod probe** (`_wf-probe-walk.mts` via `railway run`):
`effective sweep: source=code steps=6 revisionId=null` → `started=6
skipped=6 halted=no` → `AgentRun rows created: 0`. The stored walk ran
against production data, the dark ship held, nothing spent. Jobs and the
council service needed zero edits — `runFleet`'s signature is unchanged, so
4a's blast surface was exactly three fleet files. Remaining: 4b gates, 4c
schedule.

**WF.4b+4c EXECUTED 2026-08-07 (`c6ed9a5ab` + test fix `63d285ee1`),
round-trip proven on the DEPLOYED process.** 4b: `forceAsk` on
`runOrQueueTool` (tighten-only — it can force the approval branch, never
skip it); the council gates each item by its ORIGIN analyst's step via
`finding.charterKey`, director fallback; 11 parity tests green, plus the
council test now asserts `forceAsk: false` on an unrevised walk — after the
Workers stream caught that `c6ed9a5ab` broke that very expectation (pre-push
runs only the security suite; the full vitest gap is now a known hole). 4c:
`nextCronFire` extracted to pure `cron-eval.ts` (a cycle otherwise);
clocks arm from the effective definition and **re-arm on activate/revert**;
the schedule feed reports the same truth. **Live proof, one round trip:**
trigger panel → cron `20 5 * * 1` → Publish (diff: `trigger changed`) →
page NEXT RUN moved to Mondays 05:20 UTC → deployed-process log
`19:06:27 [fleet-council] weekly council scheduled (20 5 * * 1)` → Revert →
page back to 05:15 → log `19:07:53 … scheduled (15 5 * * 1)`. The page and
the firing read the same truth, and changing it is one publish and one
revert, both on the record (rev 2 supersedes rev 1 in the history).
Milestone note: the sibling's W.8 landed the §4 Half A (instances,
`templateKey`, migration `20260807d`) — instances are already wireable into
workflows through `resolveCharter` with zero change on this side, exactly
as the contract intended. WF.4 is COMPLETE; WF.5 (test-run lane) remains.

### WF.5 — the test-run lane (study, 2026-08-07)

**What WF.5 is:** the answer to "what would this draft do?" before publish —
real evidence, real model, **nothing written**. The AC preview precedent
carries almost all of it: `executeCharter(key, { preview: true })` reads the
board, calls the model, validates, and closes the run with
`output: { preview: true, data }` and `findingCount` **persisted on the run
row** (verified, executor `:529-548`) while writing zero findings. WF.5 is
that, walked over a draft definition.

**Verified truths and the decisions they force:**

1. **Hand-offs are not simulated in v1 — and the UI says so.** Law L7 makes
   steps communicate through *persisted* artifacts; preview persists nothing,
   so a previewed director reads the board as it is, not what the previewed
   analysts just produced. Chaining would need an ephemeral evidence overlay
   injected into the executor's observation gathering — real surgery,
   deferred to the WF.6 list (with replay-a-past-run, which wants the same
   machinery). v1 is honest per-step preview: *"each worker tested against
   today's board — hand-offs are not simulated yet."* Dagster's preview-tick
   holds the same line.
2. **The walk is async, serial, and polled.** The council's director alone
   took 168s supervised; six steps can pass five minutes — no synchronous
   HTTP. `POST /workflows/:key/test { definition }` validates (the same
   `validateDefinition`), refuses on the kill switch, fires a serial walk
   (concurrency 1 — cost legibility over speed), and returns
   `{ testId, steps, estimatedCostUSD }` where `testId` is a
   `test_…` orchestrationId. `GET /workflows/:key/test/:testId` assembles
   per-step status from the run rows (`orchestrationId` + `mode='preview'`):
   pending · running · done (N would-be findings, cost) · failed (the
   run-health sentence) · stopped (haltedReason). The client polls ~3s while
   a test is live.
3. **Budgets still bind a test — by construction.** The executor's kill
   switch / halt / budget gates run before preview; a test cannot pierce the
   daily ceiling, and a budget-stopped step is an honest result row. **One
   wart found and fixed with this phase:** the executor's gate-trip row
   ignores the preview flag (`mode: opts.mode`, `:255`), so a tripped test
   step would land in the real runs table under `ask`. One line —
   `mode: opts.preview ? 'preview' : opts.mode` — keeps every test artifact
   in preview mode, which is also what keeps the Runs section clean (the
   client groups by `mode === routine.mode`, so preview rows are invisible
   there by construction).
4. **Cost is stated before, not discovered after.** The estimate is the mean
   cost of each step's recent runs (fallback $0.05/step), summed and shown in
   the confirm dialog: *"≈ $0.14 — model spend is real; nothing is
   written."* The results panel shows the actual per-step and total cost
   beside it.
5. **The editor owns the button.** "Test this draft…" lives beside Publish,
   disabled while the checklist has problems; the ACTIVE wiring is tested by
   the real clock, so read mode gets no test button. The manual routine
   (empty steps) has nothing to walk and hides it.
6. **Accepted and noted:** preview rows consume the shared 100-row runs
   fetch cap (the runs route is sibling-owned; a `mode != preview` server
   filter is a one-line ask recorded for later, not a blocker).

**Build order:** **5a** — API: the serial walk + status route + the one-line
gate-trip fix + the estimate; a pure `assembleTestStatus(rows, steps)`
reducer with vitest. **5b** — UI: confirm dialog with the estimate and the
writes-nothing sentence, live per-step progress, results with would-be
findings and costs, and the teaching footer ("these findings were NOT
written"). Claims: `agent-executor.ts` one line re-claimed for 5a;
everything else in already-owned files.

**EXECUTED 2026-08-07 (`39dfd091a`), full live test on prod.** The sweep
draft tested end to end on the deployed stack: confirm dialog with the
history-derived estimate (**$0.3083**) and the writes-nothing contract →
serial walk watched live (bid tuner → harvester → miner → self-test →
director → critic, each flipping *waiting → working now… → would have
reported N findings*) → **finished · $0.2773 actually spent · 26 would-be
findings** — estimate within 10%. The director's plan artifact cost
$0.1924 of it; each analyst cents. The Runs section stayed at "No runs
yet." throughout — preview rows are invisible to real history by
construction, gate-trip fix included. Zero writes to the board, zero
proposals queued; the model spend was the only real thing the test did,
exactly as the footer promises. 28 fleet tests green. One automation note
for the record: clicking React buttons by accessibility ref fails when the
10s poll re-renders under it (detached node) — coordinate clicks are the
reliable path, the visible-tab poll pause documented by SB.W's W.6 note
applies here too.

**With WF.5 closed, every buildable section of the Part-4 map is live and
prod-verified: S1 list · S2 story · S3 runs · S4 versions · S5 editor ·
S6 test run · S7 teaching throughout — plus stored execution, origin-step
gates and the self-re-arming clock beneath them. What remains is the WF.6
deferred list, each item waiting on its named prerequisite.**

### WF.6a — custom workflows (study, 2026-08-07)

**What a custom workflow honestly is, now that instances exist:** a named,
operator-composed routine over any workers `resolveCharter` can resolve —
code charters and W.8 instances alike — with its own trigger and its own
run history, producing findings and plans on the shared board. **What it is
not:** a second path to Amazon. The queue step (plan → critic → pre-checks
→ approvals) remains the built-in council's code; a custom workflow that
includes the director produces a *plan* on the board, and the UI says whose
job queueing is. Laws L2/L3 hold exactly as before.

**Verified gaps between here and there:**

1. **The revisions route refuses custom keys** (deliberate WF.3 scoping) —
   unlock: a `POST /agent/fleet/workflows` create route (name → slug key,
   kind `custom`, born with no active revision = disabled, "floor is
   nothing"), and the revisions route accepting any existing workflow row.
   `validateDefinition` already handles everything else, instances included.
2. **No walk for arbitrary keys.** WF.4a folded the stored walk into
   `runFleet(mode)`. Extract `runStoredWorkflow(key, trigger)` — same
   levels, same per-node re-checked gates, same stamps — with `runFleet`
   becoming its mode-keyed caller. A custom run needs an honest
   `AgentRun.mode`: **add `'custom'` to the union** (executor type, schema
   comment, and the timeline's `sourcePhrase` label — a one-line touch on
   the DT-owned timeline service, noted in the locks doc).
3. **The web pages are static-first.** `BUILTIN_ROUTINES` is the list's and
   detail's registry; custom keys 404. Refactor to API-first: the list
   merges `GET /workflows` rows (customs included, with their honest
   `source`/`enabled` states); the detail page accepts any known key —
   builtins keep their hand-authored story, customs render
   `definitionToStory` always. **Run history for customs falls out of WF.4a
   stamping**: filter runs by `workflowKey === key` instead of mode — two
   customs never blur together.
4. **Run-now and clocks.** Manual: `POST /workflows/:key/run` walks the
   effective definition for real (writes findings — the fleet's gates and
   the charters' own OFF dials still decide what actually executes), behind
   a confirm reusing WF.5's cost estimate. Scheduled: `resyncFleetSchedules`
   extends to enabled customs with schedule triggers — same re-arm on
   activate/revert, same one clock of truth.

**Phases, each shippable:** **6a** — create + unlock revisions + API-first
web (a custom is composable, publishable, visible; inert until run). **6b**
— `runStoredWorkflow` + `'custom'` mode + Run-now + per-workflow run
history. **6c** — clocks for customs. The editor, versions, test lane and
teaching layer need zero changes — they were built key-generic on purpose.

**6a EXECUTED 2026-08-07 (`dc971a9c6`), full loop verified on prod.** The
fleet's first custom workflow exists: *Morning negatives pass*
(`morning-negatives-pass`, slugged by the API from the dialog's name).
Watched live end to end: create dialog with the honest contract → the new
page opened with every truthful empty state (Off — "no published wiring
yet"; "Nothing composed yet"; Versions: "until you publish, it is honestly
nothing"; Next run: "its own clock arrives later") → the editor opened from
the EMPTY baseline (manual trigger, no steps) → two workers added through
the DS Menu (the picker correctly shrinking as steps land) → Publish showed
`+ step: amazon-negative-miner · + step: amazon-keyword-harvester` → rev 1
recorded → the page flipped to **Recorded** with the adapter rendering
exactly the composed wiring under the ACTIVE-REVISION legend → the list
reads **4 routines · 3 built-in · 1 custom** with the CUSTOM badge and
rev 1 chip. The editor, versions and test lane served a custom with zero
changes, as designed. Remaining: **6b Run-now** (the step that makes it
breathe) and **6c clocks**.

**6b EXECUTED 2026-08-07 (`1aecbaaf1`), Run-now verified live.** The custom
routine ran for real on prod: the confirm stated the real-run contract with
the two analysts' history estimate ($0.0414 if every worker runs) → the
stored walk resolved rev 1 and executed → both OFF workers skipped inside
the executor → the banner told the dark truth verbatim: *"Every worker in
this routine is OFF, so nothing ran (2 skipped). The dials on the Workers
page decide what actually executes."* Zero cost, zero writes, and the
system pointed the operator at the exact lever. 303 fleet tests green;
`runFleet` and `runStoredWorkflow` now share one `executeWalk`. Remaining
in 6: **6c clocks for customs** — a natural first unit for a new session.

**6c EXECUTED 2026-08-07 (`419e6351d` tip; deploy `aa304adc`), the full
arm/disarm round trip verified on prod.** A custom workflow's clock is now
real: `resyncFleetSchedules()` arms every ENABLED custom whose effective
trigger is a schedule (a `customTasks` map, stop-all-then-re-arm, failure
isolated so a bad custom cron can never take the built-ins down), fires
through `recordCronRun('workflow:'+key)` so the run is a first-class
CronRun row, and the schedule feed reports the same rows — one truth from
definition to feed to node-cron. Watched live on *Morning negatives pass*:
published rev 2 (`30 5 * * 1`, mandatory note) → the page flipped to **On**
("Its clock is armed — and you can still run it by hand"), NEXT RUN
**in 2d 8h · Mondays at 05:30 UTC** → the deployed process logged
`[fleet-workflow] morning-negatives-pass scheduled (30 5 * * 1)` at
21:13:12Z, seconds after the publish click — the activate route's resync,
no restart → published rev 3 (Manual) → the page returned to **Ready**
("Runs the moment you start it"), NEXT RUN "when you start it". The disarm
is deliberately silent in logs (resync stops all and re-arms only what
qualifies; no error line and no new `scheduled` line IS the evidence, plus
the feed). Versions carries the whole trip: rev 1 first wiring → rev 2 arm
→ rev 3 disarm (active), every note attributed. Boot-time arming shares the
same resync function; the route path was the leg exercised live. 313 fleet
tests green (siblings added ten). **WF.6 is complete — the Workflows page's
build-out (S1–S6 + teaching layer, WF.1–WF.6) is DONE**; what remains lives
in new sessions (WF.7 dynamics, deferred contracts below).

**Post-verification copy sweep (same day):** the WF.3-era caveat — "until
stored execution ships, a published revision is recorded, not live" —
survived in four places after WF.4 made it false: the editor banner, the
publish dialog (which also promised "revert-to-built-in" on CUSTOM
routines), the Versions warn banner, and the activate route's `caveat`
string (returned, never displayed). All four now tell the WF.4 truth:
publishing IS live, the clock re-arms on publish, every run stamps its
revision; the Versions note only appears on built-ins whose default is set
aside. Lesson recorded: when a phase flips a system-wide fact, grep the
old fact's phrasing across the page the same day it flips.

**6d EXECUTED 2026-08-07 — the custom off switch, closing the last deferred
nicety in this stream's files.** `POST /agent/fleet/workflows/:key/enabled`
(customs only — a built-in rides the fleet clock and the workers' dials, and
refusing it keeps this from becoming a second, phantom kill switch; body must
be a boolean; idempotent, resync only on change). The backend truth was
already whole — `isWorkflowEnabled` refuses in `runStoredWorkflow`
(`workflow_disabled`), resync arms only enabled customs, `customStatus`
already said "Off — switched off by the operator" — so the unit is the
route, the Turn off…/Turn on… control (confirm in BOTH directions, each
stating exactly what changes and that OFF workers still cannot spend), the
result banner, and the NEXT RUN cell's honest "switched off / turn it back
on to run it" (it used to claim "publish a first revision" at a
published-but-disabled custom). The same pass caught the copy-sweep's tail:
grepping the SHORT fragment ("stored execution") found THREE more stale
sites the first sweep missed because JSX wraps phrases mid-line — the
Activate dialog and two paragraphs of the teaching card, whose "What comes
next" list was entirely shipped features; it now teaches the test lane,
Run-now, custom clocks and the off switch instead. Seven stale sites total,
zero remaining. 336 fleet tests green.

**6d PROD-VERIFIED 2026-08-08 (deploy `e70147f6`, `bb8afd919`), full round
trip watched live on *Morning negatives pass*:** Turn off… → confirm stated
the contract verbatim → **Off** ("Switched off by the operator"), the
banner named both consequences, Run now… left the action row, NEXT RUN
read "switched off · turn it back on to run it". Turn on… → confirm stated
the ceiling ("nothing can spend while [the dials] are off") → **Ready**,
Run now… back, "when you start it". The routine rests exactly where the
engagement leaves it: Ready, Manual, enabled, three revisions, no runs.

### WF.7 — dynamic capabilities (RESEARCH MANDATE, opened 2026-08-07 — new session)

**Operator direction, verbatim intent:** the workflow system lacks *dynamic*
capabilities; research thoroughly how the industry does them and how to
integrate them here the best way possible — best-in-industry is the bar.

**What "dynamic" means against our deliberately-static contract v1**
(steps + edges + one trigger, no data flow): the axis the Part-1 research
already mapped but v1 scoped out — **conditionals/branching** (Dify's
buttons-as-branches, Power Automate's Condition cards), **per-item fan-out**
(Vellum's Map node, n8n's item streams), **waits and timers** (Windmill
suspend, BPMN timer boundaries in plain words), **event triggers**
(Prefect automations incl. absence-of-event), **error/retry policies as
authored branches** (Make's incomplete executions, Pipedream retry-from-
failed-step), **sub-workflows** (Make subscenarios with typed inputs),
**expressions/data mapping** (the thing every beginner study warns about —
sentences, never `{{ }}`), and **evidence chaining between steps** (the
ephemeral-overlay build WF.5 deferred — the prerequisite for simulated
hand-offs AND for true artifact-passing dynamics under law L7).

**Boundaries any design must keep:** L2/L3/L7 intact; tighten-only gates;
the blackboard, never a mailbox; sentences over expressions; every dynamic
construct diffable in Versions and walkable by the parity-tested executor.

**Process (operator direction 2026-08-07): section-specific UI studies and
builds now start in NEW sessions.** This mandate is the first such session's
charter; the locks doc governs any shared-file work it needs.

---

## PART 9 — NAF.WF-S1R · Section 1 restudied: the routine list as a *design*

A separate operator engagement, opened 2026-08-08. WF.1–WF.6d settled the
**model** — stored revisions, editor, test lane, custom routines, clocks, off
switch, all shipped and prod-verified. What was never studied is the **UI**.
The operator's judgement: the current list is odd and imperfect. This part
audits it without defending it, researches how the industry presents a list of
routines, and proposes the rebuild. Section 1 only: the list page. The detail
page, editor, runs, versions and test lane are later sections; anything this
design implies for them is recorded in §9.9 as a follow-up, not built.

### 9.1 · PHASE 0 — the audit, measured on prod

Method: `https://nexus-commerce-three.vercel.app/fleet/workflows`, Chrome,
viewport **1728 × 962 CSS px**, 2026-08-08. Every number below is a
`getBoundingClientRect()` / `getComputedStyle()` reading taken in the page, not
an impression. Content column: `x=90 → 1704`, width **1614**, gutters 24 / 24 —
**symmetric, and the one thing that measures correctly.**

#### D1 · The chrome above the list is bigger than the list

| Band | y | height | % of viewport |
|---|---|---|---|
| Header (h1 + shell sub) | 20 → 73.5 | 53.5 | 5.6% |
| Second intro paragraph | 91.5 → 151.9 | 60.4 | 6.3% |
| Stat strip | 179.9 → 266.8 | 86.8 | 9.0% |
| Toolbar | 294.8 → 329.5 | 34.8 | 3.6% |
| **Everything before the first routine** | **0 → 355.5** | **355.5** | **36.9%** |
| The four routines | 355.5 → 693.5 | 337.9 | 35.1% |
| Teaching card | 723.5 → 808.2 | 84.8 | 8.8% |
| **Unused viewport below the content** | 808.2 → 962 | **153.8** | **16.0%** |

`document.documentElement.scrollHeight === 962 === innerHeight` — the page does
not scroll, so that 153.8 px is not "below the fold", it is empty. The subject
of the page occupies 35.1% of the screen while its own furniture occupies 36.9%.

#### D2 · Two intros say the same thing, and the second one is 39.6% wide

The shell renders `sub` = "The fleet's named routines — who gathers, who
compiles, who decides, and where you sit." Directly under it `.acr-pg-intro`
opens "A **workflow** is a named routine — which workers run, in what order…".
Both define the noun. The second is 60.4 px tall and renders at **639.7 px in a
1614 px column (39.6%)**, so 974 px of the line box is blank on all three of its
lines. It also carries the only two glossary `<Term>` links on the page, so it
cannot simply be deleted.

#### D3 · Column widths are allocated by accident, not by importance

`table-layout: auto` sizes columns by their widest unbreakable content:

| Column | width | % of table | longest cell (chars) | shortest cell |
|---|---|---|---|---|
| Routine | 360.9 | 22.4% | 274 | 85 |
| Status | 243.6 | 15.1% | 68 | 34 |
| When it runs | 213.8 | 13.2% | 53 | 33 |
| **Last run** | **398.3** | **24.7%** | 79 | **9** ("never run") |
| Recent | 111.5 | 6.9% | 17 | **1** ("—") |
| What it may touch | 285.8 | 17.7% | 85 | 40 |

The **widest column on the page is "Last run"**, wider than the identity column,
because one row's incidental sentence — *"clock last fired 17h ago and launched
nothing — every worker was off"* — is in `.wf-sub`, which is the only prose
class on the page **with no `max-width`**. One sentence in one row therefore
sets the width of that column for all four rows, permanently.

Inside the cells the opposite happens — the prose classes are capped, so the
capped text never fills the column it was given:

| Cell | column width | rendered text width | dead width |
|---|---|---|---|
| `.wf-purpose` (40ch) | 360.9 | 290.2 | **70.7** |
| `.wf-statecell .why` (30ch) | 243.6 | 212.9 | **30.7** |
| `.wf-touch` (34ch) | 285.8 | 237.0 | **48.8** |

**≈150 px of dead width inside cells, while "Last run" holds 398.3 px for
9 characters.**

#### D4 · Nothing lines up vertically — a 19.8 px ragged edge per row

`vertical-align: middle` centres each cell's content block independently, so the
first line of each column starts at a different height. Offsets of the content
box from the row top:

| Row | Routine | Status | When | Last run | Recent | Touch | **spread** |
|---|---|---|---|---|---|---|---|
| Nightly sweep | 9.5 | 14.5 | 20.0 | 20.0 | 29.3 | 28.3 | **19.8** |
| Weekly council | 12.8 | 9.5 | 23.3 | 23.3 | 27.3 | 22.3 | **17.8** |
| Morning negatives | 12.8 | 9.5 | 23.3 | 32.5 | 32.5 | 22.3 | **23.0** |

In a 74.3 px row, six columns start at six different heights. There is no
horizontal line for the eye to track — this is the largest single contributor to
"the layout feels odd", and it is structural, not stylistic.

Row heights are also a function of incidental wrapping: 74.3 / 80.8 / 74.3 /
80.8 at full width (6.5 px spread), degrading to **80.8 / 97.5 / 91.5 / 114.2 at
a 1000 px table (33.4 px spread, 41%)**. No horizontal overflow at any width
tested (1614 → 1000), so this is rhythm, not breakage.

#### D5 · Seven of twelve text roles fail WCAG AA — and every one of them is an honesty sentence

Contrast measured in-page against the resolved background:

| Role | size | colour | contrast | AA (4.5:1) | what it carries |
|---|---|---|---|---|---|
| `.wf-purpose` | 11.5px | `#8d97a6` | **2.73** | ✗ | what the routine does |
| `.wf-sub` | 11px | `#8d97a6` | **2.73** | ✗ | next fire, cost, findings, tick-vs-run |
| `.wf-statecell .why` | 11.5px | `#6b7a8d` | **4.05** | ✗ | **the reason for the status** |
| `.wf-asof` | 11.5px | `#8d97a6` | **2.73** | ✗ | the freshness stamp |
| `.acr-pg-stat .k` | 10.5px/700 | `#8d97a6` | 2.95 | ✗ | stat labels ⁽ˢʰᵃʳᵉᵈ⁾ |
| `.acr-pg-stat .sub` | 11.5px | `#8d97a6` | 2.95 | ✗ | stat qualifiers ⁽ˢʰᵃʳᵉᵈ⁾ |
| `.acr-pg-tbl th` | 10.5px/700 | `#8d97a6` | 2.73 | ✗ | column headers ⁽ˢʰᵃʳᵉᵈ⁾ |
| `.wf-touch` | 12px | `#5a6675` | 5.40 | ✓ | reach |
| `.wf-when` | 12.5px | `#34404f` | 9.74 | ✓ | trigger sentence |
| `.acr-pg-intro` | 13px | `#5a6675` | 5.40 | ✓ | intro |

This is the finding that matters most. Six phases of work went into making this
page tell the truth — *the clock ticks but every worker is off*, *clock fired and
launched nothing*, *no published wiring yet* — and the design renders **every one
of those sentences in the least legible type on the screen**, below the
accessibility floor, while the one-word status chip that carries the least
information is the loudest thing in its cell. It directly contradicts the
operator's standing rule, *visibility over minimalism*.

Three of the seven live in the **frozen shared `fleet-pages.css`**, so all ten
fleet pages inherit them (§9.9 records the note for siblings; this section
overrides page-locally rather than claiming the shared file).

#### D6 · Nine type sizes and five weights — 14 combinations in one client subtree

Rendered sizes in `.acr-fleet`: **19, 13.5, 13, 12.5, 12, 11.5, 11, 10.5, 10** —
nine sizes inside a 9 px band, six of them inside a 3.5 px band, with half-pixel
steps (11 vs 11.5 vs 12 vs 12.5) that cannot read as hierarchy at any viewing
distance. Weights **400 / 550 / 600 / 650 / 700**; `12.5px` alone appears at
*five* different weights. 14 distinct size/weight pairs render one list of four
things. Separately, the biggest number on the page (stat value, **19px**/700) is
1 px smaller than the page title (**20px**/650), so the strip competes with the
`h1` for first read.

#### D7 · 82% of the row is dead to the pointer

The only interactive target in a row is the name link: **290.2 px of a 1614 px
row = 18.0%**. `tr` has no click handler, `cursor: auto`, and the hover state is
a 2%-luminance background tint (`#f7f9fc`) with no chevron, no affordance, no
change of cursor. A first-time operator has no signal that a routine has a page.

#### D8 · The create action has no button

Both toolbar controls are bare `.acr-btn`, whose base is
`background: transparent; border: 1px solid transparent` — no fill, no outline,
12.5px/550. So **"New workflow…" and "Refresh" are visually identical**, and
neither reads as a button. The fleet already has a primary variant —
`.acr-btn.go`, filled `#1a9d6a` — and the sibling Workers page uses it for
"Create a worker". This page diverges from the fleet's own convention on the one
control that creates something.

The toolbar is also 65% void: `as of…` at x=90 (w=290), then a **1056.6 px
empty spacer**, then the two controls at the far right.

#### D9 · Four identical avatars, carrying zero information

Every row renders the same 28×28 `lucide-workflow` glyph in the same grey tile.
It costs 38 px of the identity column (icon + gap) per row and distinguishes
nothing. Meanwhile the fact that *would* be worth a glyph — scheduled vs
run-by-hand — is buried in prose in a column 600 px to the right.

#### D10 · The strip spends 8.8% of the viewport on four numbers

`repeat(auto-fit, minmax(150px, 1fr))` with four children spreads them to
**396 px each** — 34,373 px² per card to render "4", "in 6h 26m", "44",
"$0.3787". Four bordered cards, 137,492 px² total.

#### D11 · Small, specific untruths and omissions

- **"43 runs on record" beside 8 dots.** The dot strip caps at 8; the count says
  43. The cap is stated only in an `aria-label`. S3 already solved this on the
  detail page with a visible "latest 12 of 43" line; the list did not adopt it.
- **`rev N` appears on one row of four.** Built-ins running the code default
  have `activeRevision: null`, so three rows show no version at all — the S1
  spec asked for a version chip on every row ("v3 · Built-in").
- **"Recent" is "—" in 2 of 4 rows**, in a 111.5 px column. Never-run is rendered
  as an absence rather than as a state.
- **An 8 px dot is the entire run-history vocabulary.** Outcome only; duration,
  scale and recency are not encoded at all.

---

### 9.2 · PHASE 1 — how the industry presents a *list of routines*

Part 1 of this document researched twenty products for the **model**. This pass
is narrower and different: only the **list page**, and only the question *what
does one row show, and how does it say it*.

**Sourcing honesty.** Vendor documentation is thin here — most products document
the editor and the run view and never describe their list page, because a list
page is assumed obvious. Where a fact below is documented, it is cited in
Sources. Where it is product knowledge that the docs do not state, it is marked
*(unverified)* and no design decision rests on it alone.

| Product | What a row shows | Status vocabulary | Last / next run | History at a glance | Row actions | Create |
|---|---|---|---|---|---|---|
| **Airflow 3** (DAGs) | DAG ID, schedule (cron / timetable / asset-triggered), next run, latest run + date, tags | run states colour-coded; run *type* as icons — play = manual, back-arrow = backfill, asset icon = asset-triggered | **both, on the row** | **vertical bars: colour = outcome, height = duration** | pause/unpause, trigger, favourite ★, delete | — |
| **Trigger.dev** (schedules) | type (**declarative = code-managed** vs **imperative = dashboard-created**), cron, external id, **next run**, **last run**, enabled/disabled | enabled / disabled | both | — | enable/disable, edit, delete — **imperative only; declarative rows are read-only by design** | — |
| **UiPath Orchestrator** (processes) | process, then a **count vector**: running / pending / suspended / resumed / successful / stopped / faulted, + avg duration, + avg pending time | colour blocks with *persistence*: green if it ever succeeded, red if all fail, blue running, orange waiting, **grey = never executed** | aggregate, not per-run | count vector + timeline widgets | click block → process view; hover → detail | — |
| **Make** (scenarios) | #, name, **used packages (app icons)**, status | Active / Inactive / Deleted | on the History tab, not the list | — | folders + nested subfolders | — |
| **Power Automate** (my flows) | name, modified, type, status, owner | Turn on / Turn off | **detail page only** — "28 day run history" | — | **⋮ menu**: turn off/on, edit, delete, details | New flow → pick type, or Copilot from a sentence |
| **n8n** (overview) | name, active toggle, tags; default sort = last updated | Active / Inactive | last updated (not last *run*) | — | ⋮ | + |
| **Zapier** (Zaps) | name, app icons, status toggle, folder; ★ favourites pin to the left nav | On / Off | last edited | — | ⋮, folders, favourites | + |
| **Temporal** (schedules) | schedule id; frequency, start/end, **recent *and upcoming* runs** on the detail | — *(list columns undocumented)* | detail | — | — *(undocumented)* | — |
| **Dagster** | Automation view merges schedules + sensors, grouped by code location, filterable by name/status/type/tag | running / stopped; **tick ≠ run** — a tick that requested nothing is a first-class recorded outcome | ticks + runs | tick history | start/stop | — |
| **Prefect / Windmill / Dify / Vellum** | *(list UI not documented; excluded from the conclusions rather than guessed at)* | | | | | |

**The six things this teaches, ranked by what they change for us:**

1. **Airflow — the density reference — ships a *card* view as the default and
   keeps the table as the escape hatch "for environments with many DAGs".** The
   product with the strongest claim to information density has decided that at
   human N a card carries more than a row. Our N is 4, heading to 10–20. This is
   the single most load-bearing research finding.
2. **Airflow's bars encode two dimensions in the ink we currently spend on one.**
   Colour = outcome, **height = duration**. Our 8 px dot spends the same pixels
   and says only "ok". We already compute `durationMs` per group in `lib.ts` and
   throw it away on this page.
3. **Trigger.dev puts "this one is code-managed and you cannot edit it here" on
   the row, as a *capability* statement, not a decoration.** That is exactly our
   built-in vs custom split. Today `BUILT-IN` is a grey chip that reads as a
   category label; it should read as *what you can and cannot do to this*.
4. **UiPath makes "never executed" a colour, not an absence.** Grey is a state.
   Our `—` is a shrug. And UiPath's persistence rule (green survives if it ever
   succeeded, red only if *all* fail) is the same instinct as our
   running-is-not-failed rule, expressed in the palette.
5. **Most products keep run history *off* the list** (Zapier, Make, n8n, Power
   Automate) and treat the list as a switchboard: identity + on/off + go. Only
   Airflow and UiPath put history on the row — and both are operator-monitoring
   tools, which is what we are. So carrying history is a defensible choice, but
   it must be *earned*: it has to say more than a dot.
6. **Every one of them has a visually distinct primary create control, and every
   one of them has an explicit row-action affordance** (⋮ menu or hover buttons).
   We have neither (D7, D8).

**Where we should deliberately diverge, with the reason:**

- **No ⋮ row menu.** Every researched product has one; we should not, because
  there is no honest list-level action. A built-in cannot be toggled here — its
  on/off is the fleet clock plus the workers' dials, which live on two other
  pages. Run-now for a custom already exists behind a confirm that states the
  real-run contract and a cost estimate (WF.6b), and the custom off switch is
  WF.6d — both on the detail page, both correct there. Rendering a menu whose
  items are mostly disabled would break the series' own rule, written verbatim in
  `observations/scope-filter.ts:6-7`: *"a control that is not enforced must not
  be rendered."* (§9.6 records the one candidate exception for the operator.)
- **No sort, no filter, no search, no folders, no favourites, no tags.** All of
  it is furniture at N=4. §9.10 names the number at which each becomes real.

---

### 9.3 · What this page actually is — and therefore what shape it takes

Three candidate identities, and only one survives contact with our data:

- **A switchboard** (Zapier / n8n / Make): rows exist to be toggled. **Fails** —
  nothing on this list can be toggled from this list.
- **A monitoring dashboard** (UiPath): rows are count vectors. **Fails** —
  `/fleet/activity` owns cross-fleet monitoring by settled decision 5, and at 44
  runs in 7 days a count vector is mostly zeroes.
- **A teaching-and-triage surface**: four named routines, each of which must
  explain *what it is*, state *one honest status with its reason*, and answer
  *when did it last run / when does it run next*, well enough that a beginner who
  has never seen the fleet can act. **This is what six phases of honesty work
  built**, and it is what the operator's bar demands.

A teaching surface's primary content is **prose** — the reason, the purpose, the
reach. Four of the six current columns are sentences. Prose in a table cell is
what produced D3, D4 and the 41% row-height variance: a table is a device for
comparing *values down a column*, and nobody compares "Findings only — it never
touches Amazon." against "Anything that survives the critic queues for your
approval." The comparison a table promises is one this data cannot deliver.

**Therefore: a list of routine cards, not a table.** One card per routine, full
content width, stacked — and inside each card a *fixed lane grid*, so the lanes
align across cards by construction (killing D4 structurally rather than
patching it) while each lane is free to hold prose.

### 9.4 · DataGrid vs. cards — the explicit decision the operator asked for

The standing rule is **tables use the shared DataGrid** (`feedback_tables_use_datagrid`),
and the DS light pin landed on `.fleet-surface` at SB.W's W.1, so DS components
render correctly on fleet pages. The convergence has been owed by this stream
since the WF.1 study. Deciding it, on the record:

**The claim: this list is not a table, so the table component does not apply.**
Four arguments, all checked in code rather than asserted:

1. **`DataGrid` cannot model this list's primary interaction.** Its full prop
   surface is `columns · rows · rowKey · selectable · selected ·
   onSelectedChange · rowSelectable · rowSelectableHint · selectAllHint ·
   selectRowHint · showTotals · emptyState · initialSort · maxHeight ·
   className` (`design-system/components/DataGrid.tsx:22-45`). There is **no
   `onRowClick`, no row href, no row-expand, no row-detail slot** — the only
   `onClick` in the whole 230-line file is the sort button. Under DataGrid the
   navigation target stays the 18%-of-row text link that is defect D7. Closing
   D7 would mean extending a component shared by ~50 pages, which needs a claim
   and lands everywhere.
2. **The DataGrid substrate is hostile to prose, and the proof is on prod.**
   `.h10-ds-grid` is `table-layout: auto` with `white-space: nowrap` on every
   cell. The Workers page had to defeat that page-locally — `table-layout:
   fixed`, `overflow: hidden`, and a per-class `white-space: normal` allow-list
   for its four prose cells (`workers.css:151-178`, with a 12-line comment
   explaining the trap) — **and its autonomy ladder is still clipped in the live
   screenshot**. Adopting DataGrid here means adopting a default that must be
   overridden for four of six fields, to end up somewhere a card grid reaches
   directly.
3. **Everything DataGrid buys is inapplicable at this N.** Sorting four rows is
   a control nobody uses that costs a caret and a hit target on every header.
   There is no numeric column to total. There is no bulk action on a routine —
   you cannot switch a built-in off at all, and the custom off switch is
   per-routine and lives on its own page. Selection, select-all, totals, column
   visibility: zero of them apply.
4. **The rule's own purpose is served better by not using it.** The rule exists
   so tabular data everywhere behaves identically. Rendering non-tabular data
   through a table component to satisfy the letter of the rule produces the
   ragged, mis-weighted, unreadable surface measured in §9.1 — which is what the
   rule was written to prevent.

**The falsifier, written down so this stays re-openable.** The moment the list
needs to be *sorted, filtered or bulk-acted* — in practice around **25 routines**
— it becomes a table and converges onto DataGrid. §9.10 makes that an explicit
trigger with a number, not a vibe. Until then the fleet's DS conformance is kept
where it is real: DS components for every control (Menu, Select, Button — the
manifest rejects raw form elements), all four DS stylesheets in the Workers-page
import order, no raw `<select>`, and the DS ratchet green including comments.

### 9.5 · THE PROPOSAL

#### 9.5.1 · Page skeleton

```
h1 Workflows                                          ← shell, unchanged
sub  The fleet's named routines — who gathers, …      ← shell, unchanged
one-line intro carrying the two <Term> links          ← D2: one line, ≤92ch
─────────────────────────────────────────────────────────────────────────
fact bar  ·  next scheduled run · runs 7d · spent 7d  ← D10: one card, 4 facts
─────────────────────────────────────────────────────────────────────────
4 routines · 3 built-in · 1 custom        [+ New routine] [Refresh] as of …
─────────────────────────────────────────────────────────────────────────
┌ routine card ────────────────────────────────────────────────────────┐
└──────────────────────────────────────────────────────────────────────┘   ×4
─────────────────────────────────────────────────────────────────────────
How workflows work                                             [Read it]
```

- **The second intro (D2)** keeps its `<Term>` links, drops to one sentence, and
  widens to `max-width: 92ch` so it stops being a 39.6%-wide block.
- **The strip becomes one fact bar (D10)**: a single card, `display:flex`, four
  facts each `flex: 1 1 0` separated by 1 px `#edf1f5` dividers, padding
  `12px 20px`, ≈64 px tall (was 86.8). The "Routines" tile is deleted — its count
  moves to the list header where it is a caption for what is directly below it.
  Value type drops **19px → 17px** so the page title wins the first read (D6).
- **The toolbar becomes the list header (D8)**: the 1056.6 px void is filled with
  the count sentence on the left; `+ New routine` becomes `.acr-btn.go` (filled,
  the fleet's own primary, matching Workers' "Create a worker"); `Refresh` stays
  ghost; the `as of …` stamp trails Refresh exactly as Workers places it.

#### 9.5.2 · The routine card

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ ⏱  Nightly sweep   BUILT-IN   rev —                                          → │
│                                                                                │
│  Every switched-on worker reads    ┌ Idle ┐              ▁ ▃ ▂ █ ▁ ▂ ▃ ▁       │
│  fresh evidence and reports        The clock ticks, but   no runs yet          │
│  findings; report cards            every worker is off.   clock last fired     │
│  recompute afterwards.                                    17h ago and launched │
│                                    Touches findings only  nothing              │
│  selftest→miner→harvester→tuner    — it never reaches     ─────────────────    │
│  →grading→cards→auditor            Amazon.                Nightly 04:45 UTC    │
│                                                           next in 6h 26m       │
└────────────────────────────────────────────────────────────────────────────────┘
```

**Geometry.** Card: full content width (1614 at 1728 vw), `#fff`, `1px solid
#e0e6ee`, radius 12, padding `16px 18px`, **14 px between cards**. Body grid:

```
grid-template-columns: minmax(340px, 1.5fr) minmax(240px, 1fr) 216px;
column-gap: 28px;
```

At 1614: fixed 216 + 2×28 gap + 36 padding = 308, leaving 1306 → **784 / 522 /
216**. At a 1200 content width: 892 → 535 / 357 / 216, both flexible lanes above
their minimums. Below **1080** the third lane wraps under the first two; below
**760** all lanes stack. The **216 px lane is fixed on purpose**: it holds the
bars and the numerals, and a fixed lane cannot be resized by a sibling card's
content — which is what makes the rhythm column align down the whole list and
what structurally prevents D3 from recurring.

**Lane 1 — what it is.** Name **15px/650**; kind badge; version chip. Purpose
sentence **12.5px/400 `#5a6675` (5.40:1)**, `max-width: 52ch`. Then the **step
chain**: the routine's steps as small pills (11px/600, `#eef2f7`, 4px radius)
joined by `→`, wrapping freely. A worker whose charter is OFF renders its pill
muted with an "off" dot — so *"the clock ticks, but every worker is off"* is
**shown as well as said**, and the sentence and the picture cannot disagree.
This is the element the current list lacks entirely and the one that teaches a
beginner what a routine *is* without a click.

**Lane 2 — where it stands.** The status chip, then the reason at
**12.5px `#5a6675`** — promoted from 11.5px at 2.73–4.05:1 (D5). Below it, the
reach sentence prefixed "Touches", same size and colour. The two prose facts
share a lane; nothing numeric enters it.

**Lane 3 — its rhythm.** Top: the **run bars** (§9.5.4). Middle: the last-run
line — `26h ago · ok` with the outcome word at 12.5px/650 in its outcome colour,
then `$0.2126 · 0 findings · 2 workers` at 11px tabular. Bottom, under a hairline
rule: the trigger sentence and next fire. Numerals are `font-variant-numeric:
tabular-nums` and right-aligned within the lane so they form a column down the
list.

**Alignment (D4 closed structurally).** Every lane is a grid child with
`align-self: start`; the three lanes begin at the same `y` in every card, and the
same lane begins at the same `x` in every card. The measured 19.8 px ragged edge
becomes **0 px by construction**, not by tuning.

**The card is the link (D7 closed).** The whole card is a `next/link`, cursor
pointer, hover raises the border to `#c8d3e2` plus a 1 px shadow lift, and a `→`
sits at the right of the header line. Target goes from **18% → 100%** of the
card. There are no interactive children inside the card, so a plain wrapping
`Link` is safe and stays safe as long as §9.6 holds.

**The avatar earns its pixels (D9).** The 30 px tile's glyph becomes the
**trigger type** — a clock for a scheduled routine, a hand/play for a
run-by-hand one — tinted by the status kind. Four identical glyphs become a
scannable "two on a clock, two by hand", which is Trigger.dev's clock-marks-
scheduled convention.

#### 9.5.3 · Status treatment

The chip stays exactly the five kinds `lib.ts` already computes (`on · ready ·
idle · off · halted`) with their existing labels and `why` strings — **no status
logic changes anywhere in this section**. What changes is the weighting: the
chip is the *index*, the reason is the *content*, so the reason gets the legible
type and the chip gets quieter (11px/700, unchanged palette, 24 px pill).

The kind badge is rewritten from a category label into a capability statement,
following Trigger.dev's declarative/imperative split:

- **`BUILT-IN`** → tooltip: *"Ships with the fleet. Its wiring comes from code;
  publish a revision to change it, and revert-to-built-in can never fail."*
- **`CUSTOM`** → tooltip: *"You created this one. It runs only what you
  published, and it can be switched off from its own page."*

Version chip on **every** card (D11): `rev N` for a published revision, and for a
built-in on the code default an explicit `built-in wiring` chip rather than
nothing — three of four cards currently say nothing at all about their version.

#### 9.5.4 · Run history — Airflow's bars, adapted honestly

Replaces the 8 px dots. Up to **12 bars**, 6 px wide, 3 px gap, in a 24 px band:

- **colour = outcome**, reusing the existing palette exactly — `#2f9e6e` ok,
  `#d4574e` failed, `#e0a63f` stopped early, `#4a7ab8` running now;
- **height = duration**, normalised within that routine (min 5 px so a fast run
  is never invisible), from `RunGroup.durationMs`, which `lib.ts` already
  computes and this page currently discards;
- **a group still running has no duration** → it renders full-height in the
  running colour with a caption, never as a failure (the shipped in-flight rule);
- **never run** renders **12 empty grey slots** plus the words `never run` —
  UiPath's "grey is a state, not an absence" (D11);
- **truncation is stated on screen**, adopting S3's shipped sentence: `latest 12
  of 43`, not an `aria-label` only (D11);
- each bar keeps its existing `title` (timestamp + outcome sentence).

#### 9.5.5 · Type scale and colour, as a system

Nine sizes × five weights → **five sizes, three weights**:

| Role | size / weight | colour | contrast |
|---|---|---|---|
| page title | 20 / 650 | `#26313f` | shell |
| routine name | 15 / 650 | `#26313f` | 12.6:1 |
| body prose — purpose, reason, reach | 12.5 / 400 | `#5a6675` | **5.40:1** |
| emphasis inside body — outcome words | 12.5 / 650 | outcome colour | ≥ 4.5:1 |
| metadata — cost, counts, next fire, chips, pills, `as of` | 11 / 600 | *(pinned at build, ≥ 4.5:1)* | ≥ 4.5:1 |

**The rule, not the hex:** no text role on this page renders below **4.5:1**, and
the build verifies it with the same in-page contrast probe used for §9.1 — the
post-build measurements go in the execution record. The three failing roles that
live in the frozen `fleet-pages.css` (`stat .k`, `stat .sub`, `tbl th`) are
overridden **page-locally under a new `.wf-page` root class**, never by editing
the shared file.

> **Build trap to honour:** `.acr-fleet` is used by the Workers page too, and a
> page-local stylesheet can persist across a client-side route change. Every new
> rule in `workflows.css` is scoped to `.wf-page` — a class this page adds to its
> own client root — so nothing can leak onto a sibling's surface.

#### 9.5.6 · Spacing, verified numerically

One 4 px base unit, no odd values: card padding `16/18`, lane gap 28, card gap
14, section gap 20, fact-bar padding `12/20`. Vertical rhythm above the list
becomes header **53.5** → intro **~24** → fact bar **~64** → list header **~32**
→ cards; every gap a multiple of 4, symmetric left/right by the 24 px page
gutter that already measures correctly.

**Dead space (D1).** Four cards at ≈150 px + 3×14 gap ≈ **642 px** of list,
against 337.9 today. With the intro and strip reductions, projected content
bottom ≈ **985 px** at 1728×962 — the page fills the viewport and begins to
scroll naturally at four routines, which is the correct behaviour, not stretched
padding. §9.10 turns this into a pass/fail measurement rather than a hope.

### 9.6 · What is deliberately absent, and why

| Absent | Why | When it arrives |
|---|---|---|
| ⋮ row menu | No honest list-level action exists (§9.2). A control that is not enforced must not be rendered. | If S1.e is approved |
| Sort / filter / search | Furniture at N=4 | ≥ 12 routines (search), ≥ 25 (sort + filter → DataGrid) |
| Folders, tags, favourites | Organisation without a quantity to organise | ≥ 25 routines |
| Bulk selection | There is no bulk action on a routine | If one is ever built |
| Run-now on the card | Exists on the detail page behind a confirm stating the real-run contract and a cost estimate (WF.6b) | S1.e — operator's call, see below |
| Enable/disable on the card | A built-in has no switch here at all; the custom switch is WF.6d on its own page | Not planned |

**The one open question for the operator (S1.e).** Every product researched puts
at least one verb on the row. The only candidate here is **Run now for a
published custom routine**. In favour: it is the single action a routine list
should plausibly offer, and it is already implemented. Against: it would be the
second place that flow exists, its confirm dialog is where the cost estimate and
the OFF-workers warning live, and duplicating it risks the two drifting. **My
recommendation is no** — keep the list read-only and let the card be the door.
Recorded as a phase so it is your decision, not my omission.

### 9.7 · The shipped honesty rules — preserved, and where each one lands

Nothing in this section changes status logic, run grouping, poll behaviour or any
API contract except the one named in S1.c. Explicitly:

| Rule (shipped WF.1–WF.6d) | Preserved how |
|---|---|
| One honest status per routine **with its reason** | `routineStatus` / `customStatus` untouched; the reason is *promoted* to legible type (D5) |
| Tick vs run — "clock fired, launched nothing" | Same string, same precedence, now at 12.5px/5.40:1 in lane 3 instead of 11px/2.73:1 |
| No status claims from unread or failed feeds | Load-failure path, `!loaded` state and the "reading the fleet…" copy unchanged; the fact bar still refuses to claim a clock before the feeds are read |
| A running orchestration is never counted as failed | `groupRuns` untouched; bars render `running` full-height in the running colour |
| Preview runs never shown | `groupRuns`'s `mode !== 'preview'` filter untouched |
| Degraded-charter fail-safe banner | Unchanged, above the list |
| 10 s visibility-gated poll + "as of" stamp | `useVisibilityPoll` untouched; the stamp moves next to Refresh and becomes legible |
| Self-test findings split, never hidden | Fact bar keeps the split sentence verbatim |
| Beginner comprehensibility / tooltips | Extended: kind badges gain capability tooltips, chain pills gain per-step tooltips, glossary `<Term>` coverage re-audited in S1.d |

### 9.8 · Build phases — each independently shippable

| Phase | What | Touches | Risk |
|---|---|---|---|
| **S1.a** | **The substrate.** Table → routine cards with the fixed lane grid; whole-card link; trigger-type avatar; type scale collapsed to 5×3; every text role to ≥ 4.5:1 under `.wf-page`; fact bar replaces the 4-tile strip; toolbar becomes the list header with `.acr-btn.go` create; intro to one line. **No data, status, poll or API change — every honesty string moves verbatim.** | `WorkflowsClient.tsx`, `workflows.css` | Low — presentation only |
| **S1.b** | **The rhythm lane.** Airflow bars (colour = outcome, height = duration from the existing `RunGroup.durationMs`); never-run as grey slots; on-screen `latest 12 of 43`; version chip on every card. | `WorkflowsClient.tsx`, `workflows.css` | Low — data already fetched |
| **S1.c** | **The step chain.** Chain pills on every card with live worker on/off tint. **Needs the one named contract change:** `GET /api/agent/fleet/workflows` returns a compact ordered `chain` (step key + label) per row so a custom's wiring is visible without N extra fetches. Additive, response-only, in this stream's own `agent-fleet-workflows.routes.ts`; built-ins derive from `routines.ts` and need nothing new. | that route + `WorkflowsClient.tsx` | Low — additive field, no behaviour change |
| **S1.d** | **The teaching pass.** Glossary `<Term>` entries for any noun the cards mint (locks-doc protocol: re-read `glossary.tsx` immediately before append, claim it, one term per commit); capability tooltips on the kind badges; first-run and no-custom states; a tooltip-coverage audit against the beginner bar. | `WorkflowsClient.tsx`, `glossary.tsx` *(claimed)* | Low |
| **S1.e** | *(operator's call — recommended **no**)* Run-now on a published custom's card. | `WorkflowsClient.tsx` | Medium — duplicates a confirmed spend path |

Each phase ends: `tsc -p` web **and** api from the repo root with absolute paths
→ `npx vitest run src/services/agent-fleet` → `git commit --only` → push
(bounded retry; siblings race) → wait out Vercel → **verify on prod with
screenshots and a geometry probe** → update this record, the locks-doc row and
memory.

### 9.9 · Recorded, not built — follow-ups this design implies elsewhere

1. **The detail page (`/fleet/workflows/[key]`) inherits the same D5 contrast
   failures** — `.wf-sub`, `.wf-purpose` and the S3 runs table all use the same
   classes. Fixing them page-locally in S1.a fixes both surfaces at once *only*
   if the override is scoped to `.wf-page`; if the detail page does not carry
   that root class it keeps the failing colours. **Decide at S1.a: either apply
   `.wf-page` to both roots, or accept a one-section gap and close it in the S2
   restudy.** Flagged so it cannot be discovered later as a defect.
2. **Three failing text roles are in the frozen shared `fleet-pages.css`**
   (`.acr-pg-stat .k` 2.95, `.acr-pg-stat .sub` 2.95, `.acr-pg-tbl th` 2.73).
   All ten fleet pages inherit them. This section overrides page-locally and does
   **not** claim the shared file; the finding goes to the locks doc so whichever
   stream wants to fix it centrally can, with the measurements already done.
3. **The Workers roster's autonomy ladder is clipped on prod** — visible in the
   1728 px screenshot as `A…`. Sibling-owned; noted in the locks doc, no action
   taken here.
4. **The card's lane grid is a candidate `_shared/` primitive** if Assignments or
   Activity want the same "prose lanes that align across cards" shape. Not
   extracted on one consumer — the AS.1 precedent (`outcomeOf` deliberately not
   extracted until a second consumer exists) is the right rule.
5. **`RoutineStory` already holds the chain for built-ins**; if the S2 restudy
   moves the story into the stored definition for built-ins too, S1.c's `chain`
   field becomes the single source for both surfaces.

### 9.10 · Acceptance — measured on prod, not eyeballed

Each phase is *done* only when these read true in a browser probe on the
deployed page at **1728 × 962**, with the numbers pasted into the execution
record:

1. **Alignment.** For every card, the three lanes' content boxes start at the
   same `y` (spread **≤ 2 px**, vs 19.8 today), and lane *k* starts at the same
   `x` in every card (spread **0 px**).
2. **Contrast.** Every text role in `.wf-page` measures **≥ 4.5:1**. Zero
   exceptions, reported as a table.
3. **Type.** At most **5** distinct `font-size` values and **3** weights render
   inside `.wf-page` (vs 9 × 5 today).
4. **Dead space.** Rendered content bottom ≥ **92% of viewport height (≥ 885 px)**
   *or* the document scrolls. No horizontal overflow at any width from 1614 down
   to 1000.
5. **Target size.** The navigation target per routine is **≥ 95% of the card's
   area** (vs 18.0% of the row today).
6. **Symmetry.** Page gutters equal left and right (24/24, already true) and
   every card's internal padding equal on both sides, verified from the rects.
7. **Row rhythm.** Card-height spread across the four routines **≤ 12 px** at
   1614 and **≤ 24 px** at 1000 (vs 6.5 and 33.4 today).
8. **Honesty regression.** Every string in the §9.7 table still renders, verbatim,
   in the same conditions — checked against the live page, not the source.

**Re-open triggers, so this decision does not calcify:** ≥ **12** routines →
add search; ≥ **25** routines → the list becomes a table and converges onto
`DataGrid`, and §9.4's argument is void.

---

### 9.11 · S1.a SHIPPED + PROD-VERIFIED 2026-08-08

Approved by the operator; **S1.e declined** per the recommendation in §9.6, so
the list stays read-only and the card is the door. Landed in three commits —
the first cut, then two rounds of defects that only the deployed page could
show, which is the point of verifying on prod rather than in a screenshot of
an intention.

| Commit | What |
|---|---|
| `53e62a5cd` | The substrate: cards, fact bar, list header, palette, `.wf-page` on both roots |
| `b03ba5960` | Four lanes not three; chips are pills again; reserved rhythm height |
| `6b2cd6d33` | Lanes fold instead of spanning; grid floor lowered for headroom |

**The two defects prod caught, both invisible to `tsc` and to intention:**

1. **A column flex container stretches its children across the cross axis**, so
   every status chip rendered as a **518.4px bar**, not a pill. Fixed with
   `align-self: flex-start` on the chip.
2. **Three lanes recreated the very defect this section exists to remove.** On
   a 1614px card the flexible lanes measured **777.6px and 518.4px while their
   prose rendered at 441.6px and 315.4px** — 336px and 203px of dead width
   *inside* the lanes. The lesson is general and worth keeping: **prose has a
   reading measure and will not stretch to fill a lane, so the lane must be cut
   to the prose, never the other way round.** Splitting "what it may touch" into
   its own lane made all four lanes the width of the sentence they carry. The
   same error reappeared one breakpoint down, where the reach lane spanned two
   columns and came out 970px holding 490px of prose — hence the rule now
   written into the stylesheet: **lanes fold into rows, they never span.**

**Acceptance, measured on the deployed page at 1728 × 962** (§9.10's tests, in
order):

| # | Test | Before | After |
|---|---|---|---|
| 1 | Lane start alignment (x spread / y spread) | 19.8px ragged edge | **0 / 0** |
| 2 | Text roles below AA 4.5:1 | **7**, all honesty sentences | **0 that this section owns** (1 shared, below) |
| 3 | Type scale | 9 sizes × 5 weights (14 pairs) | **5 sizes × 3 weights** owned (+1 size, +1 weight from shared components) |
| 4 | Dead space | 153.8px unused, page did not scroll | content **1331px in a 962px scroller**, fill ratio **1.38**, scrolls |
| 5 | Navigation target | 290.2px of a 1614px row = **18.0%** | the card is an `<a>`, cursor pointer = **100%** |
| 6 | Symmetry | gutters 24/24 | gutters 24/24, card padding **18/18** |
| 7 | Card/row height spread | 6.5px @1614, **33.4px** @1000 | **0px** @1614, **19.8px** @1000 |
| 8 | Honesty regression | — | **0 of 7 checked strings missing** |
| — | Horizontal overflow, 1614 → 700 | 0 | **0** |

Responsive, measured per breakpoint by simulating each rule against the live
page (the element-width probe alone never fires a viewport media query — worth
knowing, it silently reported 458px of overflow that does not exist):

| viewport | height spread | lane-x spread | prose fill | overflow |
|---|---|---|---|---|
| 1614 | 0 | 0 | 100 / 100 / 100 | 0 |
| 1300 | 0.4 | 0 | 97 / 100 / 97 | 0 |
| 1140 | 0.4 | 0 | 100 / 100 / 100 | 0 |
| 1000 | 19.8 | 0 | 100 / 100 / 100 | 0 |
| 980 | 19.4 | 0 | 75 / 75 / 75 | 0 |
| 800 | 19.4 | 0 | 100 / 100 / 100 | 0 |

The 75% fill at 980 is the 62ch measure binding inside a 650px lane — correct
typography, not dead layout. A line of prose should not grow past its measure
just because the lane can.

**The one contrast failure left, and why it was not fixed here.**
`.acr-btn.go` is white on `#1a9d6a` and measures **3.46:1**. It is the fleet's
shared primary in `control-room.css`, used by the Workers page for "Create a
worker". Forking the green on one page would trade an accessibility defect for
an inconsistency defect, and the file is not this stream's. Measured, and
reported to its owner in the locks doc **with a tested passing value —
`#15804f`, which measures 4.96:1 against white** — so the fix is one hex away
for whoever owns it. The same treatment as the three frozen `fleet-pages.css`
roles: measure it, publish the number, do not fork the file.

**Two more sizes and one more weight render than this section's scale allows,
and all three come from components other streams own** — the glossary `Term`
tooltip (12px) and `.acr-btn` (12.5px / 550). Noted, not forked.

**Also delivered beyond the §9.5 spec, because the audit found them:** a fourth
fact ("Workers switched on — 0 of 7 in the fleet, the dials decide") replacing
the deleted "Routines" tile, which answers the *why* behind two of the four
Idle statuses directly under the numbers; and the built-in version chip reads
**"as shipped"** rather than "built-in wiring", because the latter sat beside a
"Built-in" badge and read as a stutter.

### 9.12 · S1.b / S1.c / S1.d SHIPPED + PROD-VERIFIED 2026-08-08 — WF-S1R COMPLETE

| Commit | Phase | What |
|---|---|---|
| `bbb5bb00b` + `a3d1a115f` | **S1.b** | Twelve run bars — colour = outcome, height = duration — replacing eight outcome-only dots |
| `b046cd0c1` | **S1.c** | The step chain on every card, over one additive API field |
| `e7a4e8cf5` | **S1.d** | Two glossary terms, the card-reading paragraph, and one a11y defect S1.a introduced |
| `d5fa162d7` | **S1.b fix** | The newest run belongs at the right edge |

**S1.b — the strip earns its ink.** Twelve bars, oldest left, colour for how a
run ended and **height for how long it took**, scaled against the longest run
drawn — `durationMs` has been computed per orchestration in `lib.ts` since S2
and was discarded on this page. Every shipped honesty rule needed its own
branch: a run in flight has no duration, so it draws full height in the running
colour and is **never** shown as a failure; a group whose duration was never
recorded draws at a neutral mid height (not zero, which reads as instant; not
full, which reads as slowest) and says *"duration not recorded"* on hover; the
cap is on screen as `latest 12 of 43`; and the strip carries its own encoding
in a tooltip, because **a tall red bar must not be readable as "very bad" when
height means "slow"**. Never-run is twelve grey slots — UiPath's rule that
never-executed is a colour, not an absence.

Two defects prod caught, neither visible in a screenshot:

- **The rhythm lane reserved 124px and the sweep's lane measured 137.3**,
  because its tick-vs-run sentence wraps to two lines — one card stood 13.3px
  taller than its neighbours and its strip sat 13.2px lower. The general form
  is worth keeping: **when a layout reserves space, reserve for the tallest
  honest sentence**, or the honest sentence becomes the thing that breaks the
  rhythm.
- **The strip filled from the left**, so the council — one run on record — drew
  its bar at the far left with eleven blanks after it, i.e. *"one run happened,
  eleven are coming"*. The blanks are the past that never happened. Empty slots
  first, newest hard against the right edge, adjacent to the last-run line above
  it. Found by measuring which index held the non-empty bar, not by looking: at
  6px wide and one bar deep the error is invisible until there are enough runs
  for the habit of misreading it to have set.

**S1.c — the chain, and which chain is honest.** The list now draws the routine
as an ordered sequence of steps, and **a worker that is switched off renders
struck through**. That is the point: the status reason has said *"the clock
ticks, but every worker is off"* since WF.1 with nothing to point at, and the
sentence and the picture now read the same charter feed and cannot drift.

Choosing the source is where this could have become the stale-constant class in
a new place, so it is explicit in `chainFor()`:

| Row | Chain source | Why |
|---|---|---|
| Built-in on the code default | `routines.ts` | **Richer than the definition** — grading, report cards and the approval gate are job-code ordering and deliberately are not in any definition (the furniture caveat `getEffectiveWiring` carries for the Fleet map) |
| Built-in on a published revision | the API's `chain` | The code story is no longer what runs |
| Custom | the API's `chain` | Same |
| Custom with no published wiring | none — the card says *"No wiring published yet — nothing would run."* | An empty chain would imply an empty routine |

**The one API change, exactly as the study named it.** `listWorkflows()` gains
`chain: string[] | null` — the effective definition's steps in execution order,
response-only, additive, in this stream's own files. `chainOf()` is pure and
lives in `workflow-defs.ts` (the prisma-free layer, which is what makes it
testable) and is **deliberately forgiving where the executor is deliberately
strict**: a definition `topoLevels` refuses to walk still has real steps worth
naming, so it falls back to declaration order instead of throwing. Four vitests
pin it, including one asserting `topoLevels` *still throws* on the same input —
the picture and the plan must not be confused.

**S1.d — the teaching pass, and an a11y defect S1.a introduced.** Two glossary
terms appended as one block: **`step`** and **`revision`**. Neither is new
jargon — `gate` and the editor have said "step" since WF.3, `draft` and
`publish` have said "revision" since WF.2, and neither word had a definition.
The rebuilt list put both on screen literally, so the gap stopped being
theoretical. The "How workflows work" card gains the paragraph that reads a
card: the chain, the struck-through worker and who decides it, the bars' two
dimensions, and what twelve empty slots mean.

And the defect: **`<Term>` renders `tabIndex={0}`**, so the Term wrapped around
the routine name became a second focus stop *inside* the link the whole card had
just become — whose Enter key activates the link anyway. Removed; the purpose
sentence directly beneath and the chain beside it carry that meaning better than
a tooltip did. That left `BuiltinRoutine.termKey` with zero readers, so it went
too. Recorded in the locks doc for any stream nesting a Term in a link.

**Final acceptance, measured on the deployed page:**

| Test | Result |
|---|---|
| Run strip order (council · on-demand · never-run) | `...........#` · `############` · `............` |
| Card height spread | **0** |
| Lane x spread across cards | **0** |
| Horizontal overflow | **0** |
| Viewport fill | **1.60×**, scrolls |
| Text roles below AA | **0** owned (`.acr-btn.go` 3.46:1 remains, shared, reported) |
| Type scale | 5 sizes × 3 weights owned (+12px, +550 from shared components) |
| `<Term>` focus stops inside a link | **0** |
| Step pills rendered | 20 across 4 cards, every off-worker struck through |
| Custom's chain from the API | `Keyword harvester → Negative miner`, live from Railway |

**WF-S1R is complete.** S1.e stays declined; the list is read-only and the card
is the door. Follow-ups from §9.9 that remain open are recorded there, and the
detail page inherited the contrast fixes via `.wf-page` on both roots as §9.9
item 1 required.

---

## PART 10 — NAF.WF-S2R · Section 2 restudied: the routine's story

Opened 2026-08-08, immediately after WF-S1R. Scope is **everything on
`/fleet/workflows/[key]` above the Runs section**: the header and action row,
the status sentence, the five-cell health strip, and the read-only pipeline
canvas. Runs (S3), Versions (S4), the editor (S5) and the test lane (S6) are
later sections; §10.7 records what this design implies for them without
building any of it.

Two inheritances bind this study. The **model** is settled — no status logic,
no execution, no clock, no contract changes. The **visual language** is settled
too: WF-S1R gave the list a five-size type scale, four greys, a card idiom, a
bar encoding and a chain treatment, and this zone must read as the same product
rather than a second one.

### 10.1 · PHASE 0 — the audit, measured on prod

Method as S1R: Chrome, **1728 × 906 CSS px**, 2026-08-08, every number a
`getBoundingClientRect()` / `getComputedStyle()` reading. Three routines cover
the three shapes the page serves — `fleet-sweep` (built-in, code default, never
run), `fleet-council` (built-in, one run on record), `morning-negatives-pass`
(custom, published revision, never run). The Off state was exercised live and
restored; the 404 was visited; the remaining branches were read from code.

#### D1 · The pipeline canvas is 79–95% empty, and its text can render at 5px

The canvas is a fixed `320px` box, `fitView` with `padding: 0.18, maxZoom: 1`.

| Routine | nodes | zoom | node ink | dead left | dead right | dead width |
|---|---|---|---|---|---|---|
| `fleet-sweep` | 7 | 0.724 | **9.4%** | 437.1 | 437.1 | **55.6%** |
| `fleet-council` *(load A)* | 8 | 0.455 | **4.5%** | 587.3 | 431.9 | **64.8%** |
| `fleet-council` *(loads B–D)* | 8 | 1.0 | 21.8% | 1.0 | 355.0 | 22.6% |
| `morning-negatives-pass` | 2 | 1.0 | **5.0%** | 682.0 | 682.0 | **86.8%** |

At the sweep's 0.724 and the council's 0.455 the *declared* type is scaled with
everything else:

| Element | declared | at 0.724 | at 0.455 |
|---|---|---|---|
| Node label | 12.5px | 9.05px | **5.68px** |
| Node sub | 11px | 7.96px | **5.00px** |
| Edge label | 10px | 7.24px | **4.55px** |
| Autonomy pill | 10.5px | 7.60px | **4.77px** |

**The centrepiece of the page rendered its text at five pixels** on a 1728px
desktop, while leaving 65% of its own width empty. That is the defect class S1R
was opened to remove, in its purest form.

**And the zoom is not a function of the graph and the viewport.** The same URL
at the same viewport measured **0.455 once and 1.0 on three later loads**.
`fitView` runs once at mount and there is no re-fit; the canvas mounts
conditionally on `loaded && displayStory`, and anything that changes the
container between first paint and data arrival — a banner appearing, a font
settling — is frozen into the zoom for the life of the page. Stated as observed
rather than as a proven mechanism: the 0.455 reading is real and was not
reproducible on demand, and no code path re-fits.

#### D2 · The health strip is an em-dash wall on two of the three routines

Five cells, each **314.8 × 86.8 = 27,325 px²**.

| Routine | cells reading `—` | what the *sub* line says underneath |
|---|---|---|
| `fleet-sweep` | **4 of 5** | "clock fired 21h ago, launched nothing" · "no runs yet" |
| `morning-negatives-pass` | **4 of 5** | "never run" · "no runs yet" |
| `fleet-council` | 0 of 5 | — |

**109,301 px² of viewport spent rendering four em-dashes**, while the sentence
that actually answers the question sits underneath in the quiet slot. This is
S1R's D5 inversion in a new place: the loud element carries nothing and the
quiet one carries everything.

#### D3 · The action row is 47.6% void, and the money action looks like Refresh

`.wf-backrow` children at 1614px wide:

| child | width |
|---|---|
| "All workflows" | 99.9 |
| "as of …" | 290.0 |
| **spacer** | **767.7** |
| Run now… | 90.7 |
| Edit the wiring | 113.8 |
| Turn off… | 86.4 |
| Refresh | 93.5 |

All four buttons are bare `.acr-btn` — `background: transparent`, `border: 1px
solid transparent`. **"Run now…", the only control on the page that spends
money, is visually identical to "Refresh".** S1R fixed exactly this on the list
by adopting the fleet's own filled `.acr-btn.go`; this page never got it.

#### D4 · The type scale did not come along — but the contrast fix did

Overview zone only (Runs and Versions excluded):

| | list, after S1R | detail, today |
|---|---|---|
| Sizes | **5** — 17 / 15 / 12.5 / 11.5 / 10.5 | **7** — 19 / 15 / 13 / 12.5 / 12 / 11.5 / 10.5 |
| Weights | 3 owned | **5** — 400 / 550 / 600 / 650 / 700 |
| Text roles below AA | 0 | **0** ✅ |

Three concrete divergences: the strip value is **19px** where the list's fact
bar is 17px; the story paragraph is **13px** where the list's prose is 12.5px;
`.wf-back` is weight **600** where the list uses 650.

**The contrast result is the good news and it is worth recording as a closed
loop:** §9.9 item 1 asked whether putting `.wf-page` on both client roots would
carry S1.a's palette to the detail page. It did — **0 text roles below 4.5:1 on
this page**, with no work in this section.

#### D5 · The legend describes furniture the picture does not draw

On `morning-negatives-pass` the caption reads *"showing the ACTIVE REVISION's
wiring — code steps and your approval still wrap it"* while the canvas renders
**2 nodes, 0 edges, no code step and no gate**. The sentence is true about the
system and false about the image directly beneath it.

#### D6 · Nine edge-label / node collisions on the council graph

Measured overlap rectangles: `findings` × 5 (8 px² each) and `survivors` × 4
(22, 21, 2, 2 px²). Labels are placed at edge midpoints with no avoidance, so
a short edge puts its label inside the node it points at.

#### D7 · The canvas is blind to what actually happened

It draws the definition plus a live autonomy tint. It does not draw the last
run: which steps ran, which were skipped, what each produced, what each cost.
**Measured consequence:** the custom routine was switched **Off** live and the
canvas rendered identically — same nodes, same tints, same everything. A
picture that does not change when the routine stops is not reporting on the
routine.

#### D8 · The story block wastes 58% of its width

`.wf-sentence` is 1614 wide; its paragraph renders at **611.6**. After the chip
and padding, ~940px of the block is empty. S1R's rule applies unchanged: prose
has a reading measure and will not stretch, so the container must be cut to the
prose.

#### D9 · The overview zone consumes 83.9% of the viewport before Runs

| Block | height |
|---|---|
| Action row | 34.8 |
| Status sentence | 68.0 |
| Health strip | 86.8 |
| **Pipeline card** | **392.5** |
| **Zone total** | **760.3** of a 906px viewport |

The pipeline card is **51.6% of the zone** and is 79–95% empty inside.

#### D10 · The 404 leaves 81% of the viewport empty

Content ends at ~168px in a 906px viewport. The copy is honest and correct;
the page is a strip of text with nothing under it.

#### D11 · The header does not say what kind of routine you are looking at

The list card carries `Built-in` / `Custom` and `rev N` / `as shipped` /
`not composed yet`. The detail header carries the title and one sentence — so
the page that should know the most about a routine says less about its identity
than the row you clicked to reach it. (Versions, below, has the revision; that
is S4's surface, not an answer at a glance.)

---

### 10.2 · PHASE 1 — how the industry builds a workflow's detail page

The S1R research (Part 9.2) covered list pages; this pass asks only about the
**one-object page**. Same sourcing honesty: documented facts are cited in
Sources, and nothing below rests on an undocumented claim.

| Product | Header carries | Metrics at a glance | Graph ↔ run reality | Actions | Structure |
|---|---|---|---|---|---|
| **Airflow 3** (one DAG) | title + action buttons top-right: **Trigger**, favourite ★, reparse, delete | minimal in the header; recent runs + asset events on an Overview tab | **The graph is annotated with a selected run's task states.** Grid columns are runs, squares are task instances, **height = duration, colour = outcome**; picking a run's bar re-draws the graph *for that run*. Toggle grid↔graph with `g` | top-right of the header | grid/graph pane + tabs |
| **Dagster** (job) | job identity | per-tab | **The graph IS the Overview tab** — the job page's primary object | **Launchpad** is its own tab: a config editor that launches | 4 tabs — Overview · Launchpad · Runs · Partitions |
| **Temporal** (one execution) | Start / Close / **Duration**, Run ID, Type, Task Queue, parent, SDK, state transitions, billable actions | the header metadata *is* the metric strip | **No diagram at all** — a Relationships *tree* instead; history is the object | — | History in **four views**: Timeline · All · Compact · JSON |
| **Inngest** (one function) | — | **7 charts**: status breakdown, throughput, steps throughput, backlog, failure frequency — all with a time-range filter | — | — | charts + runs |
| **GitHub Actions** (one workflow) | workflow name | — | — | **"Run workflow" appears only if the workflow declares `workflow_dispatch`** | runs list |
| **n8n / Zapier / Make** | the canvas is the page; chrome is thin | on separate history/insights views | the canvas is the *editor*, not a run report | edit / activate | canvas-first |

**The five things this settles for us:**

1. **A graph earns its area by being a view of a RUN, not a diagram of a
   definition.** Airflow's whole design is the grid and the graph being the
   same object seen twice — pick a run, the graph re-colours to that run. Ours
   is a static diagram with an autonomy tint, which is why it can be 95% empty
   and *still* not be missing anything: there is almost nothing per pixel to
   miss. D7 is not a small gap; it is the reason D1 exists.
2. **Airflow's run encoding is the one S1R already adopted** — height for
   duration, colour for outcome. The detail page should not invent a third
   vocabulary; the bars on the list and any run marks here must be the same
   language.
3. **Temporal ships a detail page with no diagram at all** and nobody considers
   it impoverished, because the header metadata carries duration/timing and the
   history carries the truth. That is the licence to shrink or replace a canvas
   that is not paying for itself.
4. **GitHub gates the action on the capability**: no `workflow_dispatch`, no
   Run button. That is our rule (`observations/scope-filter.ts:6-7`, *"a control
   that is not enforced must not be rendered"*) arrived at independently — and
   this page already does it right, hiding Run-now on built-ins and on an Off
   custom.
5. **Actions live top-right of the header, next to the title** — Airflow,
   Dagster, GitHub all do this. Ours are in a separate row below the title with
   767.7px of nothing to their left (D3).

**Judged for our N.** This fleet has 7 workers; the graphs are **2 to 8 nodes**
across **1 to 5 levels**; runs are measured in dozens, not thousands. Airflow's
canvas exists because a DAG can have 200 tasks and a scroll/zoom viewport is
the only way to hold them. At 2 nodes, a zoomable viewport is pure cost: it
buys pan and zoom nobody needs, and it charges 320px of fixed height, a frozen
zoom, and 5px text.

### 10.3 · The decision the canvas forces

**Recommendation: replace the xyflow canvas in this zone with a deterministic
DOM pipeline that carries the last run's reality.** Argued, with the
alternative stated fairly.

| | **A · Deterministic DOM pipeline** (recommended) | **B · Keep xyflow, fix it** |
|---|---|---|
| Dead area | 0 by construction — it is a grid that fills its container | Unfixable at 2 nodes: a viewport shows what the graph occupies |
| Text size | always 12.5px | must pin `maxZoom`/`minZoom` to 1 and accept clipping instead |
| Zoom determinism | no zoom exists | needs a `ResizeObserver` re-fit; D1's non-determinism is a `fitView`-at-mount property |
| Run reality (D7) | each step row carries its own last-run outcome, duration, cost | must be built either way |
| Edge labels (D6) | artifact named once between level groups, no overlap possible | needs label-placement work xyflow does not do for us |
| Height | content-driven | fixed, or content-driven with more work |
| Cost | one new component | four fixes plus the same run overlay |

**What tips it is not effort, it is honesty.** Option B ends with a viewport
containing two cards and a lot of dotted background, and no amount of sizing
work changes that — the picture genuinely has two things in it. Option A
renders the same two things as two full-width rows that each say what the step
is, whether it will run, and what it did last time. The area is earned rather
than filled.

**`RoutineCanvas.tsx` is NOT deleted and NOT modified.** It is imported by
`RoutineEditor.tsx` (`:486`), which is **S5's surface** — a live canvas while
you wire a draft is a different job from a run report, and that decision is
S5's to revisit. This section builds a new, S2-owned component beside it and
records the convergence question in §10.7.

### 10.4 · THE PROPOSAL — the overview zone

#### 10.4.1 · Skeleton

```
┌ header band ────────────────────────────────────────────────────────────┐
│ ← All workflows                                                          │
│ Weekly council   BUILT-IN   as shipped        [Run now…] [Edit] [⋯] [⟳]  │
│ Workers report, the director compiles one ranked plan…                   │
└──────────────────────────────────────────────────────────────────────────┘
┌ status band ─────────────────────────────────────────────────────────────┐
│ ⏱ Idle · Needs the director and the critic switched on. · Mondays 05:15  │
└──────────────────────────────────────────────────────────────────────────┘
┌ fact bar (the S1R .wf-factbar token) ────────────────────────────────────┐
│ LAST RUN │ RECORD │ TYPICAL DURATION │ COST PER RUN │ NEXT RUN           │
└──────────────────────────────────────────────────────────────────────────┘
┌ the pipeline — levels left→right, one row per step, last run overlaid ───┐
└──────────────────────────────────────────────────────────────────────────┘
```

#### 10.4.2 · Header band (closes D3, D11)

The action row folds into the header. Title line: **name · kind chip · version
chip** (the S1R chips, same components, same words — `Built-in` / `Custom`,
`rev N` / `as shipped` / `not composed yet`), then a spacer, then the actions
**right-aligned beside the title**, which is where Airflow, Dagster and GitHub
all put them. `Run now…` becomes `.acr-btn.go` — the fleet's own filled
primary, already used by the list's "New workflow…" and by Workers' "Create a
worker". `Edit the wiring` stays a ghost button; `Turn off…`/`Turn on…` and
`Refresh` stay ghost. The `as of …` stamp trails `Refresh`, exactly as the list
places it. The 767.7px spacer disappears because the row now has content on
both sides.

**No `⋯` overflow menu**, despite every researched product having one: with at
most four actions and no destructive one, a menu would hide affordances to save
space this row has in surplus.

#### 10.4.3 · Status band (closes D8, unifies status + next run)

One line, not a card with 940px of empty: the status chip, its reason at
12.5px, and the trigger sentence with next fire. Today the reason lives in the
sentence block and the next fire lives in a strip cell four hundred pixels
away; they answer one question and belong together. The routine's own
one-sentence story moves up into the header band as the page's `sub`, which is
where a description belongs and where the shell already renders one.

Every shipped branch is preserved verbatim — halted, off, idle-with-reason,
ready, on, and the unread-feed case that says *"its status is unknown, not
off."*

#### 10.4.4 · The fact bar (closes D2, closes D4's 19px)

Adopt the list's `.wf-factbar` token: one card, five facts, dividers, value at
**17px**, label 10.5px, sub 11.5px. Two changes beyond the reskin:

- **No cell renders a bare `—` when there is a sentence that answers it.** The
  value slot takes the sentence's headline and the sub carries the detail:

| Cell | today (never-run) | proposed |
|---|---|---|
| Last run | `—` / "clock fired 21h ago, launched nothing" | **"never run"** / "the clock fired 21h ago and launched nothing — every worker was off" |
| Record | `—` / "no runs yet" | **"no runs yet"** / "this will read *N of M finished clean*" |
| Typical duration | `—` / "average across recorded runs" | **"not yet known"** / "averages appear after the first run" |
| Cost per run | `—` / "average model spend" | **"not yet known"** / "averages appear after the first run" |
| Next run | (already speaks) | unchanged |

  A cell that cannot know something says what would fill it — the teaching
  empty-state rule this engagement already applies everywhere else.
- **The run bars from S1.b appear in the Record cell** when there is history,
  using the identical encoding (colour = outcome, height = duration, newest at
  the right, twelve slots). One vocabulary across both pages.

#### 10.4.5 · The pipeline (closes D1, D5, D6, D7, D9)

A CSS grid of **levels**, left to right, each level a labelled group, each step
a full-width row inside it. Between levels, the artifact that crosses, named
once — which removes the possibility of a label overlapping a node (D6).

Each **step row** carries, in fixed lanes that align down the whole block:

| Lane | Content |
|---|---|
| Identity | step name · autonomy pill (worker) / `code` / `you decide` |
| What it does | the one-line sub already in `routines.ts` |
| Will it run | **switched off → struck through, exactly as the S1R chain does** · degraded → "settings unreadable, fail-safe posture" |
| Last time | what this step did on the routine's most recent run: ok / failed / stopped early / **skipped** · duration · cost · findings |

**The last-run overlay needs no API change.** `groupRuns()` already returns
each orchestration's member `rows`, and every `AgentRun` carries `agentKey`,
`ok`, `status`, `haltedReason`, `costUSD`, `findingCount`, `createdAt`,
`endedAt`. Joining the newest group's rows to the step list by `charterKey` is
a client-side `Map`. Two honesty rules fall straight out and both are stated on
screen:

- **A code step has no run row** — grading, report cards and the approval gate
  are job-code ordering, not `AgentRun`s. They render "always runs · not
  separately timed", never a fabricated outcome.
- **A worker with no row in that group did not run**, and the reason is already
  known: it was off. That renders as **"skipped — it was switched off"**, which
  is the same fact the status reason states and the chain draws, from the same
  feed, so all three cannot disagree.

At **2 steps** the block is two full-width rows, ~120px total, carrying more
information than the 320px canvas did. At **8 steps** it is five level groups
and eight rows, ~340px, with no zoom and 12.5px type throughout. Dead area is
zero at both ends because a grid fills its container and the lanes are cut to
their content (S1R's rule).

**The legend stops lying (D5):** it describes what is drawn. When the wiring
comes from a revision, the job furniture that wraps it is *drawn as its own
level group*, marked as code, rather than claimed in a caption.

#### 10.4.6 · Type, spacing and colour — inherited, not re-chosen

Five sizes (17 / 15 / 12.5 / 11.5 / 10.5), three owned weights (400 / 650 /
700), the four greys, `.wf-page` scoping, 4px spacing base, and the S1.b bar
palette. The three D4 divergences are corrected to the list's values. No new
token is minted by this section.

### 10.5 · Every state, and what it says

| State | Reachable | Behaviour |
|---|---|---|
| Built-in, code default, never run | `fleet-sweep` ✅ verified | facts speak; pipeline shows the code story with all workers struck through |
| Built-in, with runs | `fleet-council` ✅ verified | last-run overlay populated; Record cell shows bars |
| Built-in on a published revision | not live today | pipeline draws the revision's wiring **plus** the code furniture as its own group |
| Custom, published, Ready | `morning-negatives-pass` ✅ verified | Run-now primary; overlay empty with "never run" |
| Custom, switched Off | ✅ **exercised live and restored** | banner + chip + "switched off"; **pipeline gains the off treatment** — today it renders identically, which is D7 |
| Custom, no wiring | from code | pipeline says "No wiring published yet — nothing would run", the same sentence the list card uses |
| Halted | from code (`state.halted`) | chip Halted + stored reason; the pipeline states that nothing runs, scheduled or manual |
| Feed unreadable | from code | *"its status is unknown, not off"* preserved verbatim; no cell invents a value |
| 404 | ✅ verified | copy correct; **D10** — the page is 81% empty and should offer the routine list inline rather than a single link |

### 10.6 · Build phases, with measurable exit criteria

| Phase | What | Exit criteria (measured on prod) |
|---|---|---|
| **S2.a** | Header band + action row + status band. Identity chips, `.acr-btn.go` primary, status and next-run unified, story to the header sub, type scale converged. | Action-row void **0px** · sizes ≤ 5, weights ≤ 3 owned · prose block dead width **< 5%** · 0 roles below 4.5:1 · every status branch renders its shipped string verbatim |
| **S2.b** | The fact bar: `.wf-factbar` reused, em-dash cells replaced with honest sentences, S1.b bars in Record. | **0 cells rendering a bare `—`** on all three routines · bar encoding byte-identical to the list's · strip height ≤ 72px (from 86.8) |
| **S2.c** | The pipeline: new S2-owned component, levels + step rows + last-run overlay. `RoutineCanvas.tsx` untouched. | Dead area inside the block **< 10%** at 2, 7 and 8 steps · **no text below 12.5px** · no element overlaps another · block height content-driven · off/degraded/skipped states render · zone height ≤ 60% of viewport |
| **S2.d** | States + teaching: 404 fills, no-wiring/halted/feed-error verified, `<Term>` audit, "How workflows work" gains a read-this-page paragraph. | Every row of §10.5 screenshotted or code-verified · 404 content ≥ 60% of viewport · 0 `<Term>` inside a link |

### 10.7 · Recorded, not built

1. **S3 (Runs) should drive the pipeline overlay.** Airflow's grid↔graph link is
   the whole idea: pick a run, the picture re-colours. This section defaults the
   overlay to the newest run; making a Runs row select the overlaid run is S3's
   to build, and the component should take the group as a prop from day one so
   S3 needs no refactor.
2. **S5 (editor) still imports `RoutineCanvas`.** If the DOM pipeline proves
   itself here, the editor may converge onto it — but an editing canvas has a
   different job, and that call is S5's.
3. **`.acr-btn.go` is still 3.46:1** on committed `main` (verified 2026-08-08:
   `control-room.css:53` unchanged at `#1a9d6a`). S1R published the tested
   `#15804f` (4.96:1). This section adopts `.acr-btn.go` for its primary and
   inherits the defect rather than forking the fleet's green — same call, same
   reason.
4. **`approval-inbox.vitest.test.ts` is still red** on `main` (verified
   2026-08-08: 1 failed of 19). Unmoved since S1R reported it; still Approvals'
   judgement to make.
5. **The 19px strip value survives on other fleet pages** — `.acr-pg-stat .v`
   is a shared `fleet-pages.css` primitive. This section moves *its* strip onto
   the page-local `.wf-factbar` rather than touching the frozen file.

---

### 10.8 · S2.a–S2.d SHIPPED + PROD-VERIFIED 2026-08-08 — WF-S2R COMPLETE

| Commit | Phase | What |
|---|---|---|
| `2792044f2` | **S2.a** | Actions beside the title; identity chips; status + next-run unified into one band |
| `789061d3f` | **S2.b** | The fact bar; no cell may render a bare em-dash; `RunBars` extracted |
| `f56e2065d` → `2463cfc5a` → `be9a25b69` | **S2.c** | The pipeline, plus two layout defects prod found |
| `4095128a7` | **S2.d** | The not-found page earns its viewport; the read-this-page paragraph |

**Acceptance, measured on the deployed page at 1728 × 906:**

| Test | Before | After |
|---|---|---|
| Smallest text in the pipeline | **5.00px** (council, zoom 0.455) | **10.5px** — and no zoom exists |
| Node ink / dead width | 9.4% sweep · 5.0% custom (682px dead each side) | **every card fills its stage — 0 dead width**, verified per level on all three routines |
| Element overlaps in the picture | **9** label/node collisions | **0** |
| Fact-bar cells reading a bare `—` | **4 of 5** on two of three routines | **0** on all three |
| Action-row void | 767.7px (47.6%) | **0** — the row has content on both sides |
| Contrast failures in the zone | 0 | **0** |
| Type scale (owned) | 7 sizes / 5 weights | **5 sizes / 3 weights** |
| `<Term>` inside a link | — | **0** |
| Horizontal overflow | 0 | **0** |
| Not-found page | 168px of content, 1 recovery link | **312.8px, 4 recovery targets** |

**The last-run overlay, verified live on the council:** four workers read
*"skipped — it was switched off"*, the director *"ok · 2m 47s · $0.1944 ·
0 findings"*, the critic *"ok · 22s · $0.0182 · 0 findings"*, and both code
steps *"always runs · not separately timed"*. The picture now changes when the
routine does — which is the whole point of D7, and it needed no API change.

**Three defects prod found that a screenshot of an intention would not have.**
Each is the same lesson landing in a new place:

1. **The artifact gutters were grid children**, so `grid-auto-columns:
   minmax(0,1fr)` gave each of the four an equal share — **698px of 1572 spent
   on four arrows and four one-word labels**, squeezing every card to 174.7px.
   A layout written to remove dead width had invented some. The artifact rides
   the stage label now, which also makes a label-on-card collision impossible.
2. **A solo stage gives each card ~780px, and stacked contents used 22.9%.**
   The dead width had moved from around the card to inside it. Wide cards lay
   their facts out in lanes, exactly as the list card does; narrow ones stay
   stacked, because at 300px lanes would be the wrong instrument.
3. **The back link inside the title block made the actions align to it**, not
   to the title, and pushed the row to `y=20` where the app shell's own
   top-right chrome sits. Its own row fixes both.

**Two exit criteria from §10.6 were not met, and both were mis-specified by
me rather than missed.** Recording the numbers and the reasoning rather than
quietly dropping them:

- **"Zone height ≤ 60% of viewport"** — measured **89.8%** (sweep) and
  **94.3%** (council). The criterion assumed that replacing an empty canvas
  would *shrink* the zone. It does the opposite: the old 392.5px canvas was
  ~90% empty, and a pipeline that is 100% used is taller, not shorter. The
  zone grew ~53px and its informative content went from almost none to all of
  it. The right criterion was never height — it was **dead area**, which is
  now zero and is measured above.
- **"404 content ≥ 60% of viewport"** — measured **34.5%**. A dead end has
  only so much to honestly say, and filling 543px more would mean inventing
  content. What actually improved is measurable and was the point: content
  168px → **312.8px**, recovery targets 1 → **4**, each naming a routine and
  what it does.

**One measurement that stays imperfect and is stated rather than hidden:** on
the two-worker custom, the solo cards fill **41.3% / 44.2%** by text-width.
The three lanes are ratio-sized and its sentences are short; once that routine
runs, the last lane grows from "never run" to a full outcome line and the fill
rises with it. A per-step run strip would close the rest, but that needs
per-worker history and belongs with S3's run selection (§10.7 item 1).

**One self-declared miss, found by discharging a criterion instead of assuming
it, and closed (`2ee74c9f6`).** §10.5 promised the pipeline would gain an off
treatment. Turning the custom off *on the rebuilt page* — rather than trusting
the audit run against the old one — showed it still rendered identically: the
exact indictment written against the canvas, surviving one layer down. A worker
being off is already on its card; the ROUTINE being off is a fact no card can
carry, so it now goes on the block as a sentence with the steps at 62% opacity,
still legible because they remain the truth about the wiring. Verified live:
*"This routine is switched off — none of these steps will run until you turn it
back on."*, `is-blocked` set, opacity 0.62 — then restored to Ready, blocked
line gone, opacity 1, Run-now back. **Prod left exactly as found.**

**Every row of the §10.5 state table is now discharged** — sweep, council,
custom Ready, custom Off and the 404 verified on the rebuilt page; built-in-on-
revision, no-wiring, halted and feed-unreadable verified in code.

**`RoutineCanvas.tsx` was not touched**, as promised — `RoutineEditor.tsx:486`
still imports it, and the editor's canvas is S5's decision.

---

## Sources

**Part 10 (WF-S2R, detail-page research, 2026-08-08)** — Astronomer [intro to the Airflow UI](https://www.astronomer.io/docs/learn/airflow-ui) (single-DAG page: header actions top-right; grid columns = runs, squares = task instances, height = duration, colour = outcome; **the graph is annotated with a selected run's task states**; `g` toggles grid↔graph) · Temporal [Web UI](https://docs.temporal.io/web-ui) (execution page: Start/Close/Duration + Run ID + Type + Task Queue in the header; History in Timeline / All / Compact / JSON; **no workflow diagram** — a Relationships tree instead) · Dagster [webserver & UI](https://docs.dagster.io/guides/operate/webserver) (job page tabs: **Overview = the graph** · Launchpad · Runs · Partitions) · Inngest [observability & metrics](https://www.inngest.com/docs/platform/monitor/observability-metrics) (per-function charts: status breakdown, throughput, steps throughput, backlog, failure frequency, all time-range filtered) · GitHub Actions [manually running a workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow) (**"Run workflow" renders only when the workflow declares `workflow_dispatch`**)

**Part 9 (WF-S1R, list-page research, 2026-08-08)** — Airflow 3 [UI overview](https://airflow.apache.org/docs/apache-airflow/stable/ui.html) · Astronomer [intro to the Airflow UI](https://www.astronomer.io/docs/learn/airflow-ui) (card view default, bars = duration × status, run-type icons, ⌘K, list view for many DAGs) · Trigger.dev [scheduled tasks](https://trigger.dev/docs/tasks/scheduled) (declarative vs imperative rows, next/last run, dashboard-editable only for imperative) · UiPath Orchestrator [monitoring processes](https://docs.uipath.com/orchestrator/automation-cloud/latest/user-guide/monitoring-processes) (count-vector columns, colour persistence, grey = never executed) · Make [scenario list & history](https://help.make.com/scenario-history) · Power Automate [create & manage a cloud flow](https://learn.microsoft.com/en-us/power-automate/get-started-logic-flow) (⋮ menu, 28-day history on the detail) · Temporal [Web UI](https://docs.temporal.io/web-ui) · n8n [workflow tags](https://docs.n8n.io/workflows/tags/) · Zapier [product updates, Feb 2026](https://zapier.com/blog/february-2026-product-updates/) (favourites across asset listings)

- n8n [save & publish](https://docs.n8n.io/build/understand-workflows/save-and-publish-workflows.md) · [executions](https://docs.n8n.io/build/understand-workflows/understand-executions/view-executions-for-a-single-workflow.md) · [debug in editor](https://docs.n8n.io/build/understand-workflows/understand-executions/debug-executions.md) · [history](https://docs.n8n.io/build/manage-workflows/view-change-history.md) · [HITL tools](https://docs.n8n.io/advanced-ai/human-in-the-loop-tools/)
- Zapier [drafts & versions](https://help.zapier.com/hc/en-us/articles/9693520498445) · [Human in the Loop](https://help.zapier.com/hc/en-us/articles/38838619533069) · [run statuses](https://help.zapier.com/hc/en-us/articles/20505304170637) · Make [execution view](https://experienceleague.adobe.com/en/docs/workfront-fusion/using/manage-scenarios/view-a-specific-scenario-execution) · [version diff](https://experienceleague.adobe.com/en/docs/workfront-fusion/using/manage-scenarios/restore-a-scenario-version)
- Temporal [schedules](https://docs.temporal.io/schedule) · Airflow [UI](https://airflow.apache.org/docs/apache-airflow/stable/ui.html) · [DAG versioning](https://www.astronomer.io/docs/learn/airflow-dag-versioning) · Dagster [testing schedules](https://docs.dagster.io/guides/automate/schedules/testing-schedules) · [webserver](https://docs.dagster.io/guides/operate/webserver) · Prefect [deployments](https://docs.prefect.io/v3/concepts/deployments) · UiPath [processes](https://docs.uipath.com/orchestrator/automation-cloud/latest/user-guide/managing-processes) · [triggers](https://docs.uipath.com/orchestrator/automation-cloud/latest/user-guide/about-triggers)
- Power Automate [approvals](https://learn.microsoft.com/en-us/power-automate/modern-approvals) · [fix failures](https://learn.microsoft.com/en-us/power-automate/fix-flow-failures) · [test flows](https://learn.microsoft.com/en-us/power-automate/guidance/coding-guidelines/test-cloud-flows) · Windmill [suspend/approval](https://www.windmill.dev/docs/flows/flow_approval) · ServiceNow [Flow Designer](https://www.servicenow.com/products/platform-flow-designer.html) · Camunda [incidents](https://docs.camunda.io/docs/components/operate/userguide/resolve-incidents-update-variables/) · [Play](https://docs.camunda.io/docs/components/modeler/web-modeler/play-your-process/)
- Copilot Studio [multistage approvals](https://learn.microsoft.com/en-us/microsoft-copilot-studio/flows-advanced-approvals) · [multi-agent patterns](https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/multi-agent-patterns) · OpenAI [node reference](https://developers.openai.com/api/docs/guides/node-reference) · [Agent Builder deprecation](https://community.openai.com/t/deprecation-notice-agent-builder/1382650) · LangGraph [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) · LangSmith [cost tracking](https://docs.langchain.com/langsmith/cost-tracking) · Dify [Human Input](https://dify.ai/blog/the-human-input-node-bringing-human-judgment-into-automated-workflows) · [version control](https://docs.dify.ai/en/guides/management/version-control) · Vellum [release tags](https://docs.vellum.ai/product/deployments/release-tags) · Relevance AI [approvals](https://relevanceai.com/docs/build/workforces/workforce-features/approvals-and-escalations) · CrewAI [HITL](https://docs.crewai.com/en/learn/human-in-the-loop)
