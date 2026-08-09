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

## PART 11 — NAF.WF-S3R · Section 3 restudied: Runs

Opened 2026-08-08 after S1R (the list) and S2R (the detail's overview zone).
Scope is the **Runs section inside `RoutineClient.tsx`** — orchestration groups,
their expandable per-worker rows, the failure sentences, the cap line, the
revision chips — **plus the one hook S2R deliberately left**: selecting a run
should re-colour the pipeline above it.

Versions (S4), the editor (S5) and the test lane (S6) are later sections.
**No retry or re-run affordance is proposed**: this fleet has no such write
path, law L2 forbids minting one, and §11.6 records the research finding as a
WF.7-adjacent follow-up rather than a button.

### 11.1 · PHASE 0 — the audit, measured on prod

Chrome, **1728 × 906**, 2026-08-08. Four routines cover the shapes: the
on-demand check (43 orchestrations, the cap line, three distinct failure
classes), the weekly council (a two-worker group, expanded), the nightly sweep
and the custom (never-run empty state).

#### D1 · The OUTCOME column is 44.2% of the table, and nine of twelve rows fill 12.3% of it

`table-layout: auto` again — the longest failure sentence sizes the column for
every row.

| Column | width | % of table |
|---|---|---|
| (expand) | 26 | 1.7% |
| When | 118.6 | 7.5% |
| Started by | 160.8 | 10.2% |
| **Outcome** | **694.8** | **44.2%** |
| Workers | 145.4 | 9.2% |
| Findings | 140.8 | 9.0% |
| Cost | 135.6 | 8.6% |
| Duration | 150.0 | 9.5% |

Measured fill of the Outcome cell, per row: **12.3%** on the nine rows that say
"finished clean", 46.4% / 49.8% on the three that carry a failure sentence. So
"finished clean" — fourteen characters — is rendered inside 694.8px, and the
609px beside it is empty on three quarters of the rows. **This is S1R's D3, in
the one section S1R never touched.**

#### D2 · Row heights spread 35px

40.3 · 40.3 · **71.3** · 40.3 · **75.3** · 40.3 × 6 · 54.0 — the failure
sentences wrap to three lines and the rows they sit in grow with them. Same
rhythm defect the list had at 33.4px before S1.a.

#### D3 · Three of eight columns are constant on the on-demand routine

`Started by` is "by hand" on all twelve rows. `Workers` is "1" on all twelve.
Plus the expand column, which is chrome. **The section's own doc-comment says
"an always-empty column teaches nothing"** — about the version column it
correctly refused to ship — and then ships three always-*identical* ones.

#### D4 · "full story →" renders inside the WORKERS column

Measured on the expanded council group: the link is child index 3 of the
sub-row, under a `<th>` reading **WORKERS**, right-aligned by `.num`. A
navigation link in a numeric column, under a header that means a count.

#### D5 · Sub-rows are indented 0px

Group first cell `x = 137.0`. Sub-row name `x = 137.0`. The only parent/child
cue is a background step from transparent to `#fbfcfe` — roughly a 1%
luminance difference. Nothing says these rows belong to the one above.

#### D6 · The expand target is 324px²

18 × 18. WCAG 2.5.8 asks for 24 × 24 (576px²). The chevron is also the *only*
affordance — the row itself is not clickable, and nothing else hints that a
group opens.

#### D7 · Findings renders `—` for a known zero

Three cells on the on-demand routine, three on the council. S2R settled the
rule for the fact bar: *a cell that cannot know something says what would fill
it.* Zero findings is not unknown — it is zero, and an em-dash reads as
"unknown" beside cells where an em-dash means exactly that.

#### D8 · One weight outside the S1R scale

Zone type: **5 sizes** (15 / 12.5 / 12 / 11.5 / 10.5) ✅ and **4 weights**
(400 / **600** / 650 / 700). The 600 is `.wf-suboutcome`; the owned scale is
three. **Contrast: 0 failures** — S1.a's palette carried here with no work,
the third surface to inherit it.

#### D9 · The row barely answers anything without expanding, and expanding often adds one link

On the on-demand routine **every group has exactly one worker** — 43 of 43. So
the expansion renders a single sub-row that repeats the group's own outcome
verbatim and adds `full story →`. The affordance promises detail and delivers a
link.

#### D10 · The runs and the picture above them are unconnected

The pipeline S2R built shows the *newest* run's reality and nothing else. There
is no way to ask "what did the run from 45h ago actually do" and see it. This
is the hook, and §11.4 designs it.

#### D11 · The cap line is honest, and today invisible — with 15.1% of the fetch wasted

Measured against the live API: **53 runs fetched of a 100 limit**, so
`fetchCapReached` is false and the "from the newest 100 recorded runs" caveat
correctly does not render. Of those 53, **8 (15.1%) are `preview` rows** —
still served by the shared route (`agent-fleet.routes.ts:77` filters
`mode: { not: null }`), still excluded client-side. **§5 row 10 remains
unactioned by the route's owner.** Not urgent at 53, and the study does not
re-ask for it.

#### A strength worth recording, because it was never deliberately tested

Six of those rows carry `workflowKey: 'fleet-sweep'` — WF.5 test-lane previews
of the sweep draft — while the sweep itself has **never run**. Built-in
selection is by **mode**, not by `workflowKey`, and `groupRuns` excludes
`preview` on the key branch. So the sweep's Runs section correctly shows zero.
**Had built-ins selected by key, the sweep would today display six phantom runs
that never happened.** The preview-invisibility rule holds under a case nobody
set up on purpose; §11.5's state table pins it.

---

### 11.2 · PHASE 1 — how the industry shows a routine's run history

The S1R (Part 9.2) and S2R (Part 10.2) research covered list and detail pages.
This pass asks only about **run history and per-run drill-down**.

| Product | Run row shows | Drill-down | Bound to the picture? | Failure presentation |
|---|---|---|---|---|
| **Airflow 3** grid | a column per run; **height = the run's duration**, colour = state; run-origin icons (play / backfill / asset) | click a task square → **that task instance's logs**; a run's bar → a **Gantt** for that run | **Yes — the reference.** The grid and the graph are the same object seen twice; selecting a run re-draws the graph *with that run's task states* | logs, syntax-highlighted, level-filtered, free-text searchable |
| **Inngest** | status indicator per row; filter by status / queued / started / app; CEL search over event + output | **expands in place** into three sections: trigger + event payload · steps timeline · per-step inspection | — | expanding a failed step shows **every retry attempt with its own error**; errors serialized as JSON on `output` |
| **n8n** | executions tab per workflow, filterable by Failed / Running / Success / Waiting | opens the execution | **"Copy to editor"** pins a past execution's data into the canvas — the overlay idea, but as an *editing* affordance | per-node, in the canvas |
| **Temporal** | executions list, filter by status/type/time, Saved Views | one execution page | no diagram at all | history in **four views** — Timeline · All · Compact · JSON |
| **Dagster** | a Runs tab on the job; a per-run timeline | run page | the job's graph is the Overview tab, separate | — |
| **GitHub Actions** | runs list under the workflow | run page → jobs, then steps | — | per-step logs |

**What this settles for us:**

1. **Airflow is the model for the hook, and it is a two-way binding, not a
   link.** Selecting a run does not navigate — it re-colours the picture that is
   already on screen. S2R built the picture; S3R supplies the selection.
2. **Inngest is the model for the expansion: in place, not away.** Our section
   already expands in place; what it lacks is anything worth expanding *into*.
   Inngest's answer is a per-step timeline with real per-step facts.
3. **Everybody's run row is compact and value-shaped; the prose lives one level
   down.** Ours puts a three-line sentence in the widest column of the summary
   row, which is why 44.2% of the table is one column.
4. **Retry-from-failed-step is universal — Inngest replays, n8n re-runs, Airflow
   clears and reschedules — and we will not build it.** There is no fleet write
   path for it and L2 forbids inventing one. Recorded in §11.6.
5. **Nobody encodes a run's cost.** We do, on every row, because this fleet
   spends real money per run — that stays, and it is a genuine divergence with a
   reason.

**Judged for our N:** dozens of runs, 2–6 steps, one operator. Airflow's grid
exists to compare hundreds of runs across dozens of tasks; at 43 runs × 1 worker
a matrix would be a column of identical squares. We want Airflow's *binding*,
not Airflow's *matrix*.

---

### 11.3 · The run row, restated

A group answers, without expanding: **when · what started it and on which
wiring · how it went, in words · what it cost and how long · how many workers
are inside it.** Lanes, not `table-layout: auto` columns — the S1R rule, since
one of those five is prose and the rest are values.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ 38h ago      the clock · wiring rev 2   finished clean    $0.2126  3m 10s  │
│                                                            2 workers  ⌄     │
└────────────────────────────────────────────────────────────────────────────┘
```

- **Outcome is capped to a reading measure** and wraps inside its own lane, so
  a three-line sentence stops setting the width of a column twelve rows deep.
- **`Started by` and the revision chip merge into one provenance lane** — they
  are the same question ("what caused this run, running what").
- **`Workers` stops being a column and becomes the expand affordance's label**:
  `2 workers ⌄`. It tells you what expanding will show, which is the only reason
  the number matters, and it closes D3 and D6 together — the affordance becomes
  a real target with a word in it, not an 18px chevron.
- **Findings renders `0`, not `—`.** An em-dash on this page means *unknown*.
- **The whole row is the selection target** (§11.4), so the click area goes from
  324px² to the row.

**Expanded**, per worker: the name, its outcome sentence, its own cost and
duration, and the link to its full story — **in lanes that line up with the
group's**, indented by a real amount with a left rule, so a child is visibly a
child. `full story →` leaves the numeric column it never belonged in.

### 11.4 · The selection ⇄ pipeline contract

The hook S2R left. Three rules, and the third is the one that keeps it honest.

1. **Selecting a run re-colours the pipeline above.** Click a group row; the
   pipeline's per-step overlay switches from "the newest run" to *that* run.
   The selected row is marked, and the pipeline gains a header line naming what
   it is showing: *"showing the run from 45h ago"*, with **Back to the latest
   run** beside it. Clicking the selected row again, or that control,
   deselects — and the default is exactly what S2R ships today, the newest
   run's reality.
2. **A running orchestration is selectable and says so.** Its steps read
   "working now…", and the 10s visibility-gated poll keeps them current — the
   one case where the overlay is live rather than historical.
3. **A past run must not borrow today's worker settings.** This is the trap.
   S2R's step card shows the autonomy pill (`OFF`, `OBSERVE`…) from the *live*
   charter feed. That is correct for "what will happen next time" and **false
   for a run that happened 45 hours ago** — `AgentCharter` keeps no history, so
   the dial at that moment is genuinely unknown. When a past run is selected the
   role pill is therefore **suppressed for worker steps**, and the header says
   why: *"Worker settings are today's, so they are not shown for a past run."*
   That is the shipped rule — *no status claims from a feed that cannot answer* —
   applied to time instead of to a failed fetch.

A step with no row in the selected group keeps its existing sentence
("skipped — it was switched off" / "did not run last time"), which is a fact
about that orchestration and stays true whichever run is selected.

### 11.5 · Every state, and how it will be discharged

Discharged means screenshotted on prod or verified in code **before S3.d
closes** — S2R's late catch came from doing exactly this.

| State | Reachable | Expectation |
|---|---|---|
| Never run | custom, sweep | teaching empty state, unchanged |
| One group, multi-worker | council | expands to 2 rows; selection re-colours the pipeline |
| Many groups + cap line | on-demand (43) | "latest 12 of 43 on record" |
| Fetch cap reached | not today (53 of 100) | code-verified; caveat appends only when true |
| Failure — contract | on-demand | red, "did not match the format it promised" |
| Failure — billing | on-demand | red, "out of credit" |
| Halted at a limit | on-demand | **AMBER**, "That limit worked" |
| Failure — unknown / no reason | code | red, "failed, and recorded no reason" |
| Running now | code (no live case) | "running now…", never a failure; selectable; poll keeps it fresh |
| Preview runs | 8 exist today | **invisible** — and the sweep must still show 0 despite 6 preview rows stamped with its key |
| Past run selected | after S3.c | pipeline re-coloured; role pills suppressed; header names the run |
| Selection cleared | after S3.c | pipeline returns to the newest run's reality |

### 11.6 · Recorded, not built

1. **Retry / re-run / replay-from-failed-step.** Universal in the research
   (Inngest replay, n8n re-run, Airflow clear-and-reschedule) and deliberately
   absent here: there is no fleet write path for it, and L2 forbids minting one
   for a UI. It belongs with **WF.7**'s dynamic-capabilities charter, where
   retry policy is already listed as an axis.
2. **The full step trace** still lives inside `WorkerClient.tsx` (Workers'
   file); this section keeps linking out to it rather than forking a viewer, as
   the original S3 study decided. If Activity ever extracts it to `_shared/`,
   this section is a consumer.
3. **§5 row 10 is still unactioned** — the shared runs route still serves
   `preview` rows (15.1% of today's fetch). Client-side exclusion stands. Not
   re-asked.
4. **`.acr-btn.go` is still 3.46:1** and **`approval-inbox.vitest.test.ts` is
   still red on `main`** — both re-verified 2026-08-08, both still their
   owners'.

### 11.7 · Build phases, with measurable exit criteria

| Phase | What | Exit criteria (measured on prod) |
|---|---|---|
| **S3.a** | The group row: lanes not auto-columns; outcome capped to a measure; provenance lane merges trigger + revision; `Workers` becomes the expand affordance; findings `0` not `—`; weight scale to 3. | Widest lane ≤ **30%** of the row (from 44.2%) · outcome fill ≥ **60%** on every row (from 12.3%) · row-height spread ≤ **12px** (from 35) · **0** constant columns · **0** em-dashes for known zeroes · 5 sizes / 3 weights |
| **S3.b** | The expansion: real indentation with a left rule, lanes aligned to the group's, `full story →` out of the numeric column, per-worker facts. | Child indent ≥ **24px** · `full story` not inside a `.num` cell · expanded sub-row lanes align to the group's within **2px** |
| **S3.c** | The hook: row selection, pipeline overlay binding, deselect, running-now case, and the **role-pill suppression + header sentence** for past runs. | Selecting re-colours the pipeline (verified per-step against the API) · deselect restores the newest run · a past selection shows **0** autonomy pills and the explaining sentence · selection target = the row, ≥ **95%** of its area |
| **S3.d** | States + teaching: discharge every §11.5 row, `<Term>` audit, "How workflows work" gains a reading-the-runs paragraph. | Every §11.5 row screenshotted or code-verified · **0** `<Term>` inside a link · 0 contrast failures |

### 11.8 · S3.a–S3.d SHIPPED + PROD-VERIFIED 2026-08-08 — WF-S3R COMPLETE

| Commit | Phase |
|---|---|
| `3d4ab9b00` → `b54f2265f` → `1aa19773a` | **S3.a** the group row |
| `142cf2995` | **S3.b** the expansion |
| `c2210ab59` → `07c1cc4d8` → `f25cbb194` | **S3.c** the selection hook |
| `ab550de9d` | **S3.d** teaching |

**Acceptance, measured on the deployed page at 1728 × 906:**

| Test | Before | After |
|---|---|---|
| Row-height spread | **35px** | **0** — every group row 46.3px |
| Widest column | 694.8px = **44.2%** | **30%**, all seven declared as percentages summing to 100 |
| Type scale | 5 sizes / **4** weights | **5 sizes / 3 weights** (400 · 650 · 700) |
| Constant columns | **3 of 8** | `Workers` became the affordance's label |
| Expand target | **324px²** | **2318px²** (84.9 × 27.3) |
| Em-dash for a known zero | 6 | **0** |
| Child indent | **0px** | **28px** behind a left rule |
| `full story →` in a `.num` cell | yes | **no** — its own cell |
| Failure sentence width | 336.1px / 3 lines | **660px / 2 lines** |
| Contrast failures · `<Term>` in links | 0 · 0 | **0 · 0** |

**The hook, verified against the API rather than by eye:** selecting a past run
takes the pipeline's role pills from **3 → 2** (the worker's dial suppressed,
the gate's "you decide" and the code step's "code" correctly kept — those are
not dials), renders the note, marks one row, and changes the step sentence from
*"did not run last time"* to *"did not run in this one"*. Clearing restores
3 pills, no note, 0 selected rows and the original legend.

**§11.5's state table, discharged in full:**

| State | How | Result |
|---|---|---|
| Never run | sweep, prod | 0 group rows, teaching empty state |
| One group, multi-worker | council, prod | 2 children, both worker pills on the summary line |
| Many groups + cap line | on-demand, prod | "latest 12 of 43 on record" |
| Fetch cap reached | code | `runs.length >= 100`; 53 today, so correctly absent |
| Failure — contract | prod | red, "did not match the format it promised" |
| Failure — billing | prod | red, "the account is out of credit" |
| Halted at a limit | prod | **`rgb(138,95,14)` — amber, not red** |
| Failure — unknown | code | "It failed, and recorded no reason." |
| Running now | code | `g.running` → "running now…" on the group; `r.status === 'running'` per run |
| Preview invisible | **live API** | **6 rows stamped `workflowKey: 'fleet-sweep'`, all `mode: 'preview'` → 0 rendered.** Built-ins select by mode; had they selected by key the sweep would show six runs that never happened |
| Past run selected | prod | pills 3 → 2, note, 1 row marked |
| Selection cleared | prod | pills → 3, note gone, legend restored |

**Four defects prod found, and one of them was my own fix being wrong.**

1. **`width: auto` in a fixed table absorbs every unclaimed pixel** — the
   outcome column stayed at 45.9% until all seven were declared as percentages
   summing to 100.
2. **`max-width: 92ch` computed to 336px — about 3.65px per character.** A `ch`
   is the advance of "0" in the *resolved* font, so it is only a measure when
   you know which font resolved.
3. **A `ch`-clamp I could not see beat a px-value I could.**
   `.wf-runs td span.acr-pg-warn { max-width: 42ch }` was clamping the
   explanation sentence, because the sentence carries that same outcome class
   for its colour. 42 × 8px is exactly the 336.115px prod reported, which is
   what made it findable at all.
4. **My first fix for (3) matched the offending selector's specificity — and
   lost on source order.** 0,2,2 against 0,2,2 falls through to document order,
   and the rule I was trying to beat sits 29 lines further down the file. The
   sentence therefore rendered clamped through **two** deploys whose source
   read as though it were fixed. Resolved with `:not(.wf-whytext)` on the four
   outcome-word selectors, which is also the truer statement of the rule: the
   42ch clamp is for the short status *words*, and the sentence was only ever
   caught by it incidentally. **The lesson is not about CSS: a fix that cannot
   be verified where it takes effect is a hypothesis, and this one was wrong
   twice before the page said so.**

**One exit criterion was wrong in kind and is recorded rather than dropped.**
§11.7 asked for **"outcome fill ≥ 60% on every row"**; it measures
**16.5–34.2%**. A shared table column has one width for every row, so it cannot
hug per-row content — the criterion was unachievable as written, not missed.
What it stood in for is met and measured: **no outlier sizes any column** (the
sentence has its own row) and **the widest lane is 30%** (from 44.2%).
The row also now answers what expansion was previously the only way to ask —
each worker named on the summary line with a dot for how its run ended — which
was the substance of the complaint behind the number.

**Two criteria I reported on without measuring, caught when asked whether the
section was finished, and both were unmet** (`406a13a7c`):

- **Weights were 4, not 3.** `.wf-suboutcome` had been moved 600 → 650 and the
  job declared done, but `.wf-halt` and `.wf-run` were still 600 — and those
  are what the amber *"stopped at a limit"* and *"running now…"* text use, so
  the stray weight was carried by exactly the states the taxonomy cares most
  about. All eight remaining 600s in this stylesheet are now 650, which also
  brings the list card and the pipeline onto the same three weights instead of
  leaving the runs table as the only conforming surface.
- **The widest column was 34% against a criterion of ≤30%.** The first version
  of this record wrote "capped at 34%" as though that discharged it. It did
  not. Now 30%, with the slack given to the provenance lane (which carries the
  trigger and the revision chip) and the worker affordance.

Neither was visible without measuring — which is the entire reason the criteria
were written as numbers, and a reminder that reporting a number is not the same
as having read one.

**Not built, as scoped:** no retry / re-run / replay affordance. Universal in
the research, no fleet write path, L2 forbids minting one for a UI; filed to
WF.7 (§11.6). **§5 row 10 still unactioned** — the shared runs route still
serves `preview` rows, 8 of 53 today. **`.acr-btn.go` (3.46:1) and the red
`approval-inbox` vitest** were re-verified unmoved on 2026-08-08; both remain
their owners'.

---

## PART 12 — NAF.WF-S4R · Section 4 restudied: Versions

Opened 2026-08-08 after S1R (list), S2R (detail overview) and S3R (runs).
Scope is the **Versions zone inside `RoutineClient.tsx`**, the Activate dialog
and the Revert flow. The editor's publish/save dialogs are S5; the test lane is
S6.

**Semantics are frozen and none of them change here:** revisions are immutable,
the note is mandatory, activation supersedes-then-points, revert-to-built-in
cannot fail and is built-in-only, and the off switch is independent of versions.

This is a small section carrying the system's audit trail. S3R just put
`wiring rev N` chips on run rows; **this is where those chips must resolve**.

### 12.1 · PHASE 0 — the audit, measured on prod

Chrome, **1728 × 906**, 2026-08-08. Four routines: `morning-negatives-pass`
(custom, 3 revisions, rev 3 active), `fleet-council` (built-in, 2 revisions both
superseded, reverted to code), `fleet-sweep` and `on-demand-check` (built-ins,
no revisions).

#### D1 · There is no column: the "active" marker lands anywhere across 549.6px

`.wf-vrow` is a flex row, so every element's x is a function of the length of
everything before it.

| Routine | element | x per row | spread |
|---|---|---|---|
| morning-negatives-pass | author + age | 559.1 · 577.9 · 626.7 | **67.6px** |
| morning-negatives-pass | state chip | 755.3 · 774.1 · 822.9 | **67.6px** |
| fleet-council | state chip | 870.4 · 860.8 · **321.4** | **549.6px** |

That last row is the defect in one number. **The single thing an operator scans
this section for — which wiring is live — is not in a consistent place**, and on
a reverted built-in the live marker sits 540px to the left of where the other
two markers are, because the built-in row has fewer elements before it.

#### D2 · A superseded revision cannot be re-activated, though the API has always allowed it

`activateWorkflowRevision` (`workflow-revisions.service.ts:68-83`) supersedes
whatever is currently active and then sets `activatedAt: now, supersededAt:
null` on its target. **There is no guard against the target being superseded** —
the model is a pointer that moves, and it moves anywhere.

The UI never offers it. Its ternary is `active → chip (+ Revert, built-ins) :
superseded → chip : else → chip + Activate…`, so **"Activate…" appears only on a
revision that has never been activated**.

Measured consequences:

- **`morning-negatives-pass` has no rollback path at all.** rev 3 is active, rev
  1 and rev 2 are superseded, and a custom correctly has no revert-to-built-in
  (there is no code to return to). To get rev 2's armed clock back the operator
  must re-compose it in the editor from a diff they cannot see.
- **`fleet-council` cannot return to rev 1 or rev 2.** Only revert-to-built-in
  exists, and it is already in that state.

This is the audit trail's central promise half-kept: you can see what changed,
and you cannot go back to it.

#### D3 · 47.6% of the row is empty

Card 1614px; the rightmost content on any row ends at **914.5**; **768.5px** of
dead width to its right.

#### D4 · A revision says nothing about what ran under it

S3R stamps `wiring rev N` on run rows. A revision row shows note, author, age
and state — never "served N runs". The join is already in hand client-side:
every `RunRow` carries `workflowRevisionId`.

#### D5 · The diff exists only at activate-time, and only against "now"

`computeDiff(a, b)` is pure and takes **any two definitions**; the UI calls it
once, in the Activate dialog, comparing the current effective definition to the
pending one. A superseded revision's contents are unreachable — you cannot see
what rev 1 contained, or what rev 2 changed.

#### D6 · The list shows creation order and calls it history

`listWorkflowRevisions` orders by `revision: 'desc'`. Today that matches the
activation order on every routine, so nothing is visibly wrong — but the model
permits activating an older revision, and the moment it is used (D2's fix does
exactly that) `revision desc` stops describing what happened when. The row
carries `activatedAt` and `supersededAt` and shows neither.

#### D7 · The built-in row is a different shape in the same slot

Badge + name + *either* a chip *or* a `.wf-sub` sentence; no author, no date.
It genuinely has less to say — but rendering it as a peer row with different
columns is what puts its "active" chip at x=321.4 (D1).

#### D8 · Revert hangs off the active revision, not the thing it returns to

`Revert to built-in` renders inside the active revision's row. It applies at
once with no confirmation, which is correct under the shipped
asymmetric-confirmation rule (reducing risk applies immediately) — but the
built-in row two lines below says *"the fallback every revert returns to"* and
carries no control at all.

#### D9 · Type and contrast are already compliant

4 sizes (15 / 12.5 / 12 / 11.5), **3 weights**, **0 contrast failures**. The
S1R palette and scale carried here with no work — the fourth surface to inherit
them.

#### D10 · A routine that has never been edited does not say so

`fleet-sweep` renders one row — *"v1 · Built-in — defined in code · active"* —
and the generic footer paragraph. Card height 172.3px. It is honest, but the
actual fact ("nothing has ever been changed here") is never stated.

#### The draft state: code-verified, deliberately not created on prod

A draft is a revision with neither `activatedAt` nor `supersededAt`, produced by
the editor's Save-as-draft (S5's surface). The ternary's else-branch renders the
`draft` chip and the Activate button, so **the state is distinguishable and
correct in code**. Creating one on prod would leave a permanent immutable row in
a real routine's audit trail to prove a branch that reads unambiguously — so it
is verified in code, per the charter's own preference.

---

### 12.2 · PHASE 1 — how the industry presents version history

Part 1 surveyed the model; this asks about the *list*, and finds two distinct
rollback philosophies.

| Product | Row shows | Current marked | Diff | Rollback | Runs bound to version |
|---|---|---|---|---|---|
| **Grafana** | number · date · author · message · **a Notes column recording "restored from vN"** | — | **select TWO versions, then Compare**; text description + expandable raw JSON | **Restore** beside a version — and it **appends a NEW version with the old content**, never overwrites | — |
| **Airflow 3** | version identified per structural change | latest shown on the DAG details page | pick which version the **graph** and **code** tabs display | — | **every run is bound to the version that existed when it started, and the UI shows it** |
| **n8n** | saved iterations | — | open in a new tab to compare | **Restore** = "replace your current workflow with the selected version"; also View and Clone; retention capped by plan (24h → 5d → full) | — |
| **Vellum** | release tags per environment | LATEST tag | — | **floating tags you move** to point at an earlier deployment | requests name a `release_tag` |
| **Zapier / Make / Dify** *(Part 1)* | draft vs published; scenario versions | — | Make ships a version diff | restore a previous version | — |

**The two philosophies, and which one we already have:**

- **Append-a-copy** (Grafana, n8n): restoring creates a *new* version holding the
  old content. History is strictly append-only; Grafana even records "restored
  from vN" in a notes column.
- **Move-the-pointer** (Vellum's floating tags — **and ours**): the same
  immutable version becomes current again.

Ours is the second, and it is the better fit *because of the run stamps*: a run
records the revision id that served it, so re-activating rev 2 means later runs
stamp **rev 2** — the same object the operator is looking at. Under
append-a-copy they would stamp a rev 4 that is a copy of rev 2, and the audit
trail would gain a synonym. **The model is right; the UI simply never exposes
it.**

**Airflow settles the other half.** Every run is bound to the version that
produced it *and the UI says so*, and you can pick which version the graph and
code show. S3R already stamps runs; S2R/S3R already let you pick which run the
pipeline draws. The missing link is the reverse direction: from a **revision**
to the runs it served (D4).

**Judged for our N:** 0–5 revisions per routine, one operator, notes already
mandatory. Grafana's select-two-and-compare is a control built for dozens of
versions; at three rows it is furniture. What is *not* furniture is "what did
this revision change" — the same question, answered per row without a selection
model.

### 12.3 · THE PROPOSAL

#### 12.3.1 · A grid, so "which is live" has a place

Six columns, declared, every row on the same grid — including the built-in:

```
rev 3   WF.6c verification — back to manual…   awaissulhry  36h ago   ● active      [ ⋯ ]
rev 2   WF.6c verification — arm the clock…    awaissulhry  36h ago   superseded    [Make active…]
rev 1   First wiring — the two spend analysts  awaissulhry  37h ago   superseded    [Make active…]
v1      Built-in — defined in code             ships in code  —       the fallback  [Revert to built-in]
```

- The state chip gets **its own column**, so it lands at one x on every row
  (D1, D7). The built-in row is a peer in the grid rather than a different
  shape in the same slot.
- **`activatedAt` → `supersededAt` becomes the row's time story** on hover and
  in the meta line: *"active 36h ago → 12h ago"* on a superseded revision,
  *"active since 36h ago"* on the live one. That makes the pointer's history
  legible without inventing a second timeline (D6).
- The footer paragraph shortens; its content moves to where it applies.

#### 12.3.2 · Rollback, because the API already does it

**`Make this active…`** on every non-active revision. It calls the same
`POST /:key/revisions/:id/activate` the draft path already uses — **no API
change, no new write path, no new semantics** (D2).

The confirm reuses the Activate dialog and its settled copy, plus the diff
**from what is running now to the revision being restored** — which
`computeDiff` already produces from any two definitions. For a *forward*
activation that diff reads as "what you are about to change"; for a *backward*
one it reads as "what you are about to undo", which is the same sentence from
the other end.

**This is the one behaviour change in the section and it is stated plainly:**
today only a never-activated draft can be activated; after S4.b any revision
can. Nothing about immutability, note-mandatoriness or the supersede-then-point
order changes — the endpoint's existing behaviour is simply reachable.

#### 12.3.3 · What ran under it

Each revision row gains **"served N runs"**, counted client-side from the runs
already fetched by matching `workflowRevisionId` — **no API change**, following
S1.c's restraint. Honesty conditions, both non-negotiable:

- the count is over the **fetched window**, so when `runs.length >= 100` the
  row says *"N of the newest 100 runs"* rather than a bare total;
- a revision with zero matched runs says **"no runs under this wiring"**, not
  `—` (the S2R/S3R rule: an em-dash on this page means *unknown*).

A revision that was active while runs happened but predates the fetch window
would under-count — which is why the caveat is attached to the number rather
than left to be inferred.

#### 12.3.4 · What this revision changed

Per row, a disclosure: **"what changed"** → `computeDiff(previousRevision,
thisRevision)` rendered with the existing `DiffList`. Not Grafana's
select-two-and-compare: at three rows a selection model costs two clicks and a
mental mode to answer a question each row can answer by itself. rev 1 has no
predecessor, so it shows its contents as the initial wiring rather than a diff.

`DiffList` is imported from `RoutineEditor` (S5's file). **This section consumes
it unchanged and records the coupling** — if S5 moves it, this is a consumer.

#### 12.3.5 · The never-edited state

`fleet-sweep` should say the fact: *"No changes have ever been published — this
routine runs the wiring that ships in code."* One sentence replacing an implied
absence (D10).

### 12.4 · Every state, to be discharged before the last phase closes

| # | State | How |
|---|---|---|
| 1 | Built-in, no revisions | `fleet-sweep`, `on-demand-check` — prod |
| 2 | Built-in, revisions all superseded (reverted) | `fleet-council` — prod |
| 3 | Built-in, revision active | code (would need a publish on a live built-in) |
| 4 | Custom, revisions, one active | `morning-negatives-pass` — prod |
| 5 | Custom, no revisions | code — "it is honestly nothing" |
| 6 | Draft (never activated) | **code** — creating one leaves a permanent row in a real audit trail |
| 7 | Rollback to a superseded revision | prod, on `morning-negatives-pass`, **restored to rev 3 afterwards** |
| 8 | Revert-to-built-in offered | built-ins only; refusal for customs is structural (no button rendered) |
| 9 | "served N runs" with the fetch cap reached | code (`runs.length >= 100`; 53 today) |
| 10 | "served N runs" = 0 | prod — the custom's revisions have no runs |
| 11 | Diff on rev 1 (no predecessor) | prod |
| 12 | 404 / unknown routine | prod |

### 12.5 · Build phases

| Phase | What | Exit criteria (measurable on a grid, per the S3R lesson) |
|---|---|---|
| **S4.a** | The grid: six declared columns, built-in as a peer row, chip column, active-from→until meta. | State-chip x **identical on every row** (spread 0, from 549.6px) · every column declared, widest ≤ **34%** · dead right ≤ **12%** (from 47.6%) · 5 sizes / 3 weights · 0 contrast failures |
| **S4.b** | Rollback: `Make this active…` on any non-active revision, confirm with the current→target diff. | Every non-active revision offers it · the dialog names both directions correctly · a round trip on prod ends with rev 3 active |
| **S4.c** | "served N runs" per revision, client-side, cap-honest. | Counts match the API join exactly · zero renders as words, never `—` · cap caveat present when `runs.length >= 100` (code-verified) |
| **S4.d** | Per-row "what changed", the never-edited sentence, states + teaching. | Every §12.4 row screenshotted or code-verified · rev 1 shows contents not a diff · 0 `<Term>` inside a link |

### 12.6 · Recorded, not built

1. **Compare-any-two-versions** (Grafana). Deliberately not built: a selection
   model is furniture at 0–5 revisions, and per-row "what changed" answers the
   same question with no mode. Revisit at ~12 revisions on one routine.
2. **`DiffList` lives in `RoutineEditor.tsx`** (S5). Consumed unchanged; noted
   so S5 knows it has a consumer outside itself.
3. **The three cross-stream items have now survived four section cycles
   unmoved** — `.acr-btn.go` at 3.46:1, the red `approval-inbox` vitest, and
   preview rows on the shared runs route. Rather than re-verify and re-report
   them in a fifth study, S4.d consolidates them into **one dated block in the
   locks doc** with file, line and the one-line fix for each, so an owner can
   clear the ledger without re-deriving anything — and future section studies
   cite that block instead of repeating the findings.

### 12.7 · S4.a–S4.d SHIPPED + PROD-VERIFIED 2026-08-08 — WF-S4R COMPLETE

| Commit | Phase |
|---|---|
| `c880e7e79` → `2d0d5c2a1` | **S4.a** the grid |
| `2b6eb8a46` | **S4.b** rollback |
| `61bc9f748` | **S4.c / S4.d** served-runs, per-row diff, teaching |

| Test | Before | After |
|---|---|---|
| State-chip x across rows | **549.6px spread** | **0** on every routine |
| Author x across rows | 67.6px spread | **0** |
| Dead right | 768.5px = **47.6%** | **2px = 0.1%** |
| Rev badge box vs its text | 109.8 vs 34.6 | **52.6 vs 34.6** (padding only) |
| Rollback available | draft only | **every non-active revision** |
| Pointer history | carried, unshown | *"active since 26m ago"* · *"was active 27m ago → 26m ago"* |
| Runs per revision | absent | **"served 43 runs" / "no runs under this wiring"** |
| Contrast · sizes · weights · `<Term>` in links | 0 · 4 · 3 · 0 | **0 · 4 · 3 · 0** |
| Teaching-card space after a `<Term>` | **2 of 9 swallowed** | **0 of 9** |

**The rollback round trip, exercised on prod and restored.** Activating rev 2
from a superseded row moved the pointer, rewrote both rows' time stories, and
**re-armed the clock** — the status band flipped to **On**, *"Mondays at 05:30
UTC · next in 18h 54m"*, exactly what the confirm promised. Re-activating rev 3
returned it to Ready/manual with Run-now back. The routine ends where the
charter requires: **manual, enabled, rev 3 active**. The trail records the
excursion honestly — rev 2 reads *"was active 27m ago → 26m ago"* — which is
the audit trail doing its job on itself.

**§12.4's state table, discharged:**

| # | State | Result |
|---|---|---|
| 1 | Built-in, no revisions | `on-demand-check` — v1 active, **"served 43 runs"**, never-edited sentence present |
| 2 | Built-in, revisions all superseded | `fleet-council` — both offer "Make this active…", v1 active **"served 1 run"** |
| 3 | Built-in, revision active | code — v1 renders **"set aside"** |
| 4 | Custom, revisions, one active | `morning-negatives-pass` |
| 5 | Custom, no revisions | code — "it is honestly nothing" |
| 6 | Draft | code — the branch renders the draft chip + Activate |
| 7 | Rollback to a superseded revision | **prod, round-tripped and restored** |
| 8 | Revert-to-built-in built-ins only | structural — no button rendered on a custom |
| 9 | Served count with the cap reached | code — `runs.length >= 100`; 53 today |
| 10 | Served count = 0 | prod — "no runs under this wiring" |
| 11 | Diff on rev 1 | prod — **"WHAT REV 1 INTRODUCED"** + its six steps |
| 12 | 404 | unchanged from S2R |

**Two criteria discharged only when the question was asked a third time**
(`f9df18440`), and one of them was a contradiction I wrote myself:

- **"Counts match the API join exactly"** — now verified independently rather
  than eyeballed: on `on-demand-check` the API yields **43** code-path
  orchestrations against the rendered *"served 43 runs"*, with all **8** preview
  rows excluded; on `fleet-council`, **1** against *"served 1 run"*, and both
  revisions correctly *"no runs under this wiring"*. **Met.**
- **"The dialog names both directions correctly"** — it did not. §12.3.2 said to
  reuse the settled Activate copy unchanged, and §12.5 then demanded the dialog
  name the direction; those cannot both hold, and what shipped named neither.
  Every sentence was *true* of a rollback and none of them said you were going
  backwards or that what is running now would stop. Resolved by **appending**
  rather than rewriting: a restore now adds *"This one ran before, so this is a
  step back: rev N is set aside and stops running. Nothing is rewritten — the
  numbers stay put, so a run that stamped rev 2 still means rev 2."* That last
  clause is the pointer model's quiet guarantee, and the confirm is exactly
  where it matters — the moment an operator might fear that going back rewrites
  history.

**One defect prod caught, and it is worth generalising: a grid stretches its
items too.** The rev badge rendered as a 109.8px bar around 34.6px of text —
the S1R 518px-chip defect reappearing one container type over. **Both container
types this page uses default to stretch**, so introducing either means checking
what it does to the small things inside it.

**The cross-stream ledger is consolidated and one item is closed.** Re-verified
on 2026-08-08 rather than carried forward: `.acr-btn.go` is still 3.46:1 and
the runs route still serves preview rows (8 of 53, 15.1%) — but
**`approval-inbox.vitest.test.ts` is now green, 19/19.** Approvals fixed it. The
two open items now live in one block in the locks doc (§4b) with file, line and
the tested one-line fix each, so future studies cite it instead of re-deriving
the same facts a fifth time.

---

## PART 13 — NAF.WF-S5R · Section 5 restudied: the editor

Opened 2026-08-08 after S1R–S4R. Scope is `RoutineEditor.tsx` and its zone.
The test panel is S6's; `DiffList` is exported here and consumed by S4R's
dialogs, so any change to it must be verified in **both** consumers.

**Not relitigated:** D1 (structured panels + live canvas, no free-drag), drafts
inert / publish consequential, gates tighten-only, trigger union
`schedule | manual`, contract v1.

### 13.1 · PHASE 0 — the audit, measured on prod

Chrome, **1728 × 906**, 2026-08-08, on `morning-negatives-pass` (revision
baseline, 2 steps) and `fleet-council` (code baseline, 6 steps). The editor
writes nothing until Save/Publish, so every state below was reached and then
discarded; **prod ends exactly as found** — the custom Ready/Manual/rev 3, the
council v1 active, three revision rows, no new rows created.

#### D1 · The editor still renders the pre-S2R canvas — the biggest finding, and it was predicted

S2R replaced the read-view canvas with `RoutinePipeline` and **deliberately left
`RoutineCanvas.tsx` alone because this file imports it**. Measured here:
`usesOldCanvas: true`, `usesNewPipeline: false`.

| Baseline | canvas | nodes | node ink | zoom | label | sub |
|---|---|---|---|---|---|---|
| custom (2 steps) | 907.7 × 320 | 2 | **8.7%** | 1.0 | 12.5px | 11px |
| built-in (6 steps) | 907.7 × 320 | 6 | **14.3%** | **0.7239** | **9.05px** | **7.96px** |

So the editor still carries every defect S2R measured and removed one section
over: 85–91% empty, and text scaled below legibility by a `fitView` that runs
once at mount.

#### D2 · The empty canvas gets more width than the controls

Editor grid 1572: **steps column 648.3 (41.2%)**, **canvas 907.7 (57.7%)**. The
column where the operator actually works is the smaller one, and the larger one
is 85–91% background.

#### D3 · The cron preview fabricates, and the checklist does not mirror the server

The single most error-prone input on the page. Typed directly into the field on
prod:

| cron typed | preview shown | problems listed | Publish |
|---|---|---|---|
| `not a cron` | *"not a cron · the clock re-arms…"* | **0** | **enabled** |
| `99 99 * * *` | **"Nightly at 99:99 UTC"** | **0** | **enabled** |
| `` (empty) | *"· the clock re-arms…"* | **0** | **enabled** |

The server refuses all three — `nextCronFire()` returns falsy →
*"the schedule … is not a cron expression this fleet can evaluate"*. The charter
requires the client mirror to be in exact parity; **the cron is the one gap**,
and it is the worst one to have.

**"Nightly at 99:99 UTC" is worse than no preview.** `prettyCron` checks that
the minute and hour are integers and never that they are in range, so an
impossible schedule renders as a confident, plausible sentence. The whole value
of a plain-English restatement — the research calls it the *"Means"* line — is
that a wrong expression **reads wrong**. This one reads right.

**Everything else IS in parity**, verified by triggering it:

| Server refusal | Client |
|---|---|
| cycle | ✅ same sentence, Publish + Test disabled |
| scheduled with zero steps | ✅ same sentence, both disabled |
| duplicate worker | ✅ structurally impossible — the picker filters present steps |
| unresolvable worker | ✅ structurally — the picker lists resolvable charters only |
| edge naming an absent step | ✅ structurally — `removeStep` prunes edges |
| invalid artifact | ✅ derived from tier |

#### D4 · The controls the operator actually sets fail AA

`.acr-pg-rung` — the trigger ladder (*On a clock* / *Manual*) and every gate
ladder (*Inherit* / *Ask first* / *May act*) — measures **4.38:1** at 11px/700.
Fourth audit running where the failing role is a load-bearing one. It lives in
the frozen `fleet-pages.css`, so it is overridden under `.wf-page`, not edited.

#### D5 · The editor never received the S1R type pass

**8 sizes** (16 / 15 / 13 / 12.5 / 12 / 11.5 / 11 / 10.5) and **5 weights**
(400 / 550 / 600 / 650 / 700), against the S1R scale of 5 × 3 that the list,
overview, runs and versions now share. This is the last surface on the old
scale.

#### D6 · Tighten-only is enforced and invisible

Three rungs render identically. Nothing on screen says *May act* cannot go below
the `alwaysAsk` floor — the fact lives in a `title` attribute and a hint line.
A control whose limits are invisible teaches the operator that it has none.

#### D7 · Raw form controls, in the file the DS manifest already caught once

**25 raw `<input type="checkbox">`** on the council draft (5 per step × 5 steps)
and **1 raw `<input type="text">`** for the cron. WF.3's ratchet rejection in
this very file was a raw `<select>`; the guard greps `/<select\b/`, so
checkboxes pass it while being the same class of thing.

#### D8 · The hand-off UX does not scale, and only shows one direction

Each step lists a checkbox per *other* step: on the six-step council that is
**25 checkboxes**, with "Hands findings to" repeated on every card. A step never
shows what hands **to it**, so the operator reconstructs the graph by reading
every card.

#### D9 · Errors are checklist-only — never on the thing that caused them

`problems` renders in one block at the bottom of the steps column. Power
Automate's designer puts the error **both** in a summary and **on the card that
caused it**; ours has only the summary, and for the cron neither.

#### D10 · The restored draft is a whisper

A recovered localStorage draft applies **automatically** and announces itself in
one quiet line. Power Automate treats the same moment as an explicit banner plus
a **Recover flow** command — the operator chooses. Ours decides for them, which
is defensible but should be a decision, not a side-effect.

#### A probe lesson worth recording

`find(r => /active/.test(r.innerText))` matched the wrong row, because S4R added
a button reading **"Make this active…"**. My probe reported the council on
"rev 2 active" and it was on v1 the whole time. On this page, match the chip,
never the row text.

---

### 13.2 · PHASE 1 — structured (non-canvas) editors, and the state of the art in schedule input

D1 makes these the references; canvas products contribute only what transfers.

| Product | Step card | Errors | Draft / publish | Notable |
|---|---|---|---|---|
| **Power Automate** | compact cards + a configuration pane; panel layout keeps cards small, inline layout expands them | **both**: a summary with a red X *and* the error **on the card that caused it**; an explicit **Flow checker** button | **Save draft** and **Publish** as separate toolbar buttons — our exact shape | **Undo/Redo**; per-card **notes**; on failed save it writes a copy to browser storage, shows a banner, and offers **Recover flow**; a test marks each card with a green check **and its seconds** |
| **Windmill** | select a step → action editor (header · body · *Test this step*) | per-step test results beside the step | **autosave indicator**; a **Diff** button | isolated per-step testing |
| **Zapier** | linear step panels — the closest cousin | in place, per step | draft vs published | — |
| **Cron input, state of the art** | — | **invalid expressions border red**; field dropdowns prevent invalid values | — | **presets** (daily 3am, weekdays 9am…), **next N fire times**, and a plain-English *"Means"* line whose stated purpose is that *"if it doesn't say what you expected, your expression is wrong"* |

**What this settles:**

1. **Errors belong in two places at once.** Power Automate's summary-plus-card
   is the pattern; we have summary only (D9), and for the cron, neither (D3).
2. **The "Means" line only works if a wrong expression reads wrong.** Ours reads
   right for `99 99 * * *`. That is the defect, not the absence of presets.
3. **Presets and next-fires are the two cheap wins** — and we already own both
   halves: `prettyCron` renders the sentence and `nextCronFire` is exported and
   pure. The server stays authoritative.
4. **A recovered draft is a moment, not a side-effect** (D10).
5. **Nothing in the research argues for free-drag.** D1 stands; what the canvas
   products contribute is selection sync and validation-on-the-picture, both of
   which want a picture worth looking at (D1's canvas problem).

**Judged for our N:** 7 workers, 2–6 steps, one trigger, one operator. Power
Automate's Copilot, expression editor, pinning and dynamic content are all for a
scale and a data model we do not have. What transfers is the *discipline*:
compact cards, errors where they happen, and a publish ceremony that names its
consequences.

### 13.3 · THE PROPOSAL

**13.3.1 · The canvas becomes the pipeline (D1, D2).** The editor renders
`RoutinePipeline` — the component S2R built and proved — fed from
`definitionToStory(draft, charters)` exactly as today. It gains what the read
view has: legible text at any step count, no zoom, no dead field. `lastGroup` is
`null` in the editor (a draft has no runs), so every step reads its wiring, not
a run. **`RoutineCanvas.tsx` then has no consumers and is deleted in the same
commit** — recorded here so the deletion is a decision, not a surprise.

Freed width rebalances to **steps 55% / picture 45%**, reversing D2.

**13.3.2 · The cron input tells the truth (D3).** Three changes, all using code
we already own:

- **A validity check in the client mirror**, using the same rule the server
  uses. `nextCronFire` is server-side; the client gets a parity check that
  refuses anything the server would refuse, and the checklist gains the
  server's own sentence verbatim.
- **`prettyCron` stops inventing.** Range-check the fields; anything it cannot
  read renders as *"not a schedule this fleet can read"*, never a fabricated
  time. This is a `lib.ts` change, so **its other consumers — the list card, the
  status band, the schedule feed — must be re-verified on prod.**
- **Presets and next fires.** A small set of DS `Menu` presets (nightly, weekday
  mornings, Monday early, hourly) and the **next three fire times** under the
  field. Both are derivable client-side; the server's `nextCronFire` remains
  authoritative and the copy says so.

**13.3.3 · Errors where they happen (D9).** Each step card and the trigger card
carry their own error state, and the checklist stays as the summary — Power
Automate's both-places pattern. A cycle marks the steps in it; an unresolvable
cron marks the trigger card.

**13.3.4 · Tighten-only, visible (D6).** The gate ladder shows the floor: when a
worker's tools carry an `alwaysAsk` floor, *May act* renders with the same
`blocked` treatment the autonomy ladder already ships (`.acr-pg-rung.blocked`,
struck through), and the hint says which floor is holding. Nothing about
enforcement changes — it becomes visible.

**13.3.5 · Hand-offs that scale (D8).** Keep the picker idiom (D1). Each card
shows **"hands to"** as today plus a read-only **"receives from"** line, so a
step states both directions. At six steps the checkbox count is unchanged; what
changes is that the operator no longer reconstructs the graph by hand.

**13.3.6 · DS controls (D7).** The checkboxes become the DS checkbox primitive
and the cron field the DS text input, following WF.3's `Menu` precedent.

**13.3.7 · The restored draft becomes a choice (D10).** The banner offers
**Use it** / **Discard it** rather than applying silently. Nothing else about
the localStorage mirror changes.

**13.3.8 · Type and contrast (D4, D5).** The S1R pass this section never got:
5 sizes, 3 weights, and `.acr-pg-rung` overridden to clear AA under `.wf-page`.

### 13.4 · State table, to be discharged before the last phase closes

| # | State | How |
|---|---|---|
| 1 | Revision baseline (custom, 2 steps) | prod |
| 2 | Code baseline (built-in, 6 steps) | prod |
| 3 | Empty compose (`EMPTY_DEF`) | code — reaching it needs a throwaway custom, i.e. a permanent row |
| 4 | Cycle | prod |
| 5 | Scheduled with zero steps | prod |
| 6 | Invalid cron × 3 (garbage, out-of-range, empty) | prod |
| 7 | Valid cron + presets + next fires | prod |
| 8 | Tighten-only floor visible | prod if a charter carries an `alwaysAsk` tool; else code |
| 9 | Restored draft banner, both choices | prod (edit → navigate away → return) |
| 10 | Save-as-draft dialog + diff, every category | prod |
| 11 | Publish dialog + diff, every category | prod |
| 12 | Note required (both dialogs) | prod |
| 13 | Server rejection path | code |
| 14 | Discard restores | prod |
| 15 | `DiffList` in **S4R's** Activate and Restore dialogs | prod — both consumers |

### 13.5 · Build phases

| Phase | What | Exit criteria (independently verifiable) |
|---|---|---|
| **S5.a** | The picture: `RoutinePipeline` replaces `RoutineCanvas`; delete the dead component; rebalance to 55/45. | Editor renders `.wf-pipe`, **0** `.wf-canvas` · smallest text in the picture ≥ **10.5px** at 2 and 6 steps · steps column ≥ **55%** · `RoutineCanvas.tsx` has 0 importers |
| **S5.b** | The cron tells the truth: parity check, `prettyCron` range-checked, presets, next-3 fires. | All three invalid crons: problem listed **and** Publish disabled · `prettyCron` returns the honest fallback for each · **re-verified in every other `prettyCron` consumer on prod** |
| **S5.c** | Errors on the card + tighten-only visible + receives-from + DS controls. | Cycle marks its steps · bad cron marks the trigger card · **0** raw `<input>` in the editor · every card states both directions |
| **S5.d** | Type/contrast pass, restored-draft choice, states + teaching. | 5 sizes / 3 weights · **0** contrast failures incl. `.acr-pg-rung` · every §13.4 row discharged · `DiffList` verified in both consumers |

### 13.6 · Recorded, not built

1. **Undo/Redo** (Power Automate). Real value at their scale; at 2–6 steps with
   Discard one click away, it is furniture. Revisit if step counts grow.
2. **Per-card notes** (Power Automate). Our note is per-*revision* and mandatory,
   which is the audit trail; a second per-card note would compete with it.
3. **The test panel is S6's.** Only the button's placement is touched here.
4. **`RoutineCanvas.tsx` deletion** removes xyflow's last consumer on this page.
   The dependency stays in the tree for the Fleet map and the Overview.

### 13.7 · One question for the operator

The S4R rider: the restore confirm says *"whatever is running now is set
aside"* where a built-in runs its code default, instead of naming *"the built-in
wiring"*. It is one line in `RoutineClient`'s dialog and you declined it once as
not-a-defect. **Take it in S5.a's commit, or leave it?**

### 13.8 · S5.a — EXECUTION RECORD (shipped and prod-verified 2026-08-09)

Three commits: `90d236b72` (the swap), `fd28f0d82` (two defects prod showed),
`45cbd8d0a` (the correction to that correction). Measured on
`nexus-commerce-three.vercel.app` at **1728 × 962**, on both baselines.

#### Exit criteria

| Criterion | Before | After |
|---|---|---|
| `.wf-canvas` / `.react-flow` in the editor | 1 / 1 | **0 / 0** |
| smallest text in the picture, 6 steps | **7.96px** at `fitView` zoom 0.7239 | **10.5px**, no zoom |
| smallest text in the picture, 2 steps | 11px at zoom 1 | **10.5px** |
| steps column share of the 1572px grid | **41.2%** (648.3) | **55.9%** (879.5 : 676.5) |
| `RoutineCanvas.tsx` importers | 1 | **0** — file deleted |
| false "never run" claims under a draft | — | **0** (`.wf-pipe-last` count 0) |

The smallest text is now `.wf-pipe-levelk`, the stage label, at the scale's
floor — not a node label the layout shrank.

#### Two defects the exit criteria did not cover

Every criterion above passed on the first commit, and the screenshot still had
two things wrong in it. Both are recorded because *criteria pass and the page
is still wrong* is the failure mode this method exists to catch.

1. **`auto-fit` collapses empty tracks and stretches what is left.** A stage
   holding one step took the full 676.5px, so *"Amazon Ads director · Compiles
   one ranked plan"* rendered in a bordered box with its OFF pill **456px**
   from its name — the dead width this section exists to remove, reintroduced
   by the commit that removed it.
2. **The picture ended 1397px above the bottom of the form.** I had asserted
   in a commit message that the pipeline "is as tall as the routine". Measured:
   **344.9px** against a step column of **1741.8px**. Shorter than the canvas
   is not the same as right — by the third step card, the picture the cards
   edit has scrolled away. `.wf-editpic` is `position: sticky` now.

#### And a correction to the first correction

Swapping to `auto-fill` fixed the one-step stage and broke the two-step one:
the custom went from 334.3px cards **filling** the row to 220.2px cards beside
a **220px hole** — and the two-step custom is the routine an operator actually
authors. Neither mode is right alone. **Fit the tracks, cap the card.**

| Stage | Cards | Trailing gap |
|---|---|---|
| council, 4 steps | 220.2 × 4 | **0** |
| council, 1 step (×2) | 340 | 336.5 |
| custom, 2 steps | 334.3 × 2 | **0** |

#### Sticky, verified by scrolling

`main.flex-1.overflow-auto`, scroll range 1958px:

| scrollTop | picture top | in view |
|---|---|---|
| 0 | 511.7 (natural) | yes |
| 700 | **12** (pinned) | yes |
| 1400 | **12** (pinned) | yes |
| 1957.5 (end) | −96.3 (leaving with its grid) | yes |

#### A probe lesson, and it is the third this session

`window.scrollBy(0, 1200)` moved nothing and `window.scrollY` stayed 0 — this
app shell scrolls `main.flex-1.overflow-auto`, and `document.scrollingElement`
is 962px tall and unscrollable. The first sticky probe therefore reported the
picture unmoved, which reads exactly like a fix that did not work. **Find the
scrolling element before measuring scroll.** Alongside §13.1's chip-not-row-text
lesson: on this page the probe lies before the page does.

#### Prod left as found

Custom `rev 3`, Ready, Manual, never run. Council `v1` active serving 1 run,
`rev 1` and `rev 2` superseded, **3 rows** — unchanged. Both editors discarded
and every `naf-wf-draft-*` key cleared from the browser.

#### Carried into S5.b

`.wf-editpic` caps at `calc(100vh - 24px)` and scrolls internally; neither
baseline reaches it (`scrollHeight === clientHeight`), so the internal scroll
is **untested** and belongs in a later state check.

### 13.9 · S5.b — EXECUTION RECORD (shipped and prod-verified 2026-08-09)

Two commits: `25c70868f` (the cron tells the truth), `9a282435e` (a state
prod found that the plan had not). Measured on
`nexus-commerce-three.vercel.app` at 1728 × 962.

#### The defect, and the shape of the fix

`prettyCron` checked that the minute and hour were **integers** and never that
they were **in range**, so `99 99 * * *` rendered as *"Nightly at 99:99 UTC"* —
a confident sentence about an impossible schedule, with zero problems listed
and Publish enabled. The research names why that is worse than no preview: the
whole value of a plain-English restatement is that a wrong expression **reads
wrong**. This one read right.

Validity is now decided by the same function the *save* is decided by.
`validateDefinition` refuses a schedule exactly when `nextCronFire` returns
null, so the client calls `nextCronFire`. Nothing is re-derived — re-deriving
the rule is what produced the defect.

#### Exit criteria, walked on prod

| typed | means line | next fires | field | problems | Publish |
|---|---|---|---|---|---|
| `not a cron` | not a schedule this fleet can read | — | **red** | 1 | **disabled** |
| `99 99 * * *` | not a schedule this fleet can read | — | **red** | 1 | **disabled** |
| *(empty)* | not a schedule this fleet can read | — | **red** | 1 | **disabled** |
| `0 3 * * *` | Nightly at 03:00 UTC | Mon 10 · Tue 11 · Wed 12 Aug | ok | 0 | enabled |
| `0 7 * * 1-5` | Weekdays at 07:00 UTC | Mon 10 · Tue 11 · Wed 12 Aug | ok | 0 | enabled |
| `0 * * * *` | Every hour, on the hour | 15:00 · 16:00 · 17:00 | ok | 0 | enabled |
| `*/15 * * * *` | `*/15 * * * * (UTC)` | 15:00 · 15:15 · 15:30 | ok | 0 | enabled |

The last row is the design, not a gap: an expression the sentence cannot
phrase gets **no claim** about when it fires, and three real timestamps
underneath do the work.

Save and Test disable with Publish — the gate was already there; the cron
simply never reached it before.

#### The shared-consumer check, which is the criterion that mattered

`prettyCron` lives in `lib.ts` and three other surfaces read it. Re-verified on
prod rather than assumed:

| surface | reads |
|---|---|
| list cards (×4) | Nightly at 04:45 UTC · Mondays at 05:15 UTC · When you start it ×2 |
| detail status band | Mondays at 05:15 UTC |
| NEXT RUN fact cell | in 14h 14m · Mondays at 05:15 UTC |

`not a schedule this fleet can read` appears **nowhere** it should not.

#### The state prod found that the plan had not

`0 3 1 * *` — the 1st of every month — **is refused**, and the refusal is
correct: `nextCronFire` scans **8 days** and stops, the 1st of next month is 23
days out, so it returns null and `validateDefinition` refuses the save for
exactly that reason.

**The fleet cannot arm any schedule that fires less often than every 8 days.**
That is a constraint of the evaluator, not of the expression, and it was not
written down anywhere before this phase. The parity is exact — but *"not a
schedule this fleet can read"* reads as *"you typed it wrong"*, which is the
wrong idea to plant about well-formed cron. The line now names the limit.

The checklist keeps the server's sentence **verbatim**, and `prettyCron` keeps
the short form, because the list card and status band render it too and a
schedule feed has no room for a clause. Distinguishing the two failure causes
properly would mean the mirror reporting *why* it returned null — forking it
from the server file for a copy-edit. Not taken.

#### The mirror, and its alarm

The web app cannot import from `apps/api`, so `cron-eval.ts` is copied to
`apps/web/src/app/fleet/workflows/cron-eval.ts` and
`cron-eval-mirror.vitest.test.ts` fails the moment the copy stops being one. It
compares the **code**, not the file — the two headers say different things on
purpose. **The alarm was proved, not assumed:** changing `SCAN_LIMIT_MINUTES`
from 8 to 9 days in the copy fails the test; reverting passes it. Fleet suite
**44 files / 401 tests**.

`@nexus/shared` is the better home and is **already a web dependency**. Not
taken here: the move edits `fleet-schedule.service.ts` (a sibling stream's
file) and adds an export path to the shared package's build graph, mid-session,
during parallel work. **Recorded as the follow-up.**

#### Contrast and type

| role | size / weight | ratio |
|---|---|---|
| means line, refused state | 11.5px / 600 | **6.92:1** |
| checklist problem | 12.5px / 400 | **4.77:1** |

Presets read exactly as the field's own line does, because the menu labels
each one through `prettyCron`: *Nightly at 03:00 UTC · Weekdays at 07:00 UTC ·
Mondays at 05:00 UTC · Every hour, on the hour*. The menu can never describe a
schedule differently from the sentence under the field.

#### Prod left as found

Council `v1` active serving 1 run, `rev 1`/`rev 2` superseded, **3 rows**,
trigger *Mondays at 05:15 UTC*. Editor discarded, every `naf-wf-draft-*` key
cleared. No revision created.

### 13.10 · S5.c and S5.d — EXECUTION RECORD (shipped and prod-verified 2026-08-09)

`239e75d5b` + `cd299dc5c` (S5.c), `804c855f7` + `bbca7a5d0` (S5.d). Measured on
prod at 1728 × 962, editor zone = 327 elements.

#### S5.c — the editor shows what it knew

| Criterion | Before | After |
|---|---|---|
| raw `<input>` / `<textarea>` / `<select>` in the editor | 25 + 1 + 1 | **0** |
| DS checkboxes / DS field | 0 / 0 | **25 / 1** |
| cards stating BOTH hand-off directions | 0 of 6 | **6 of 6** |
| gate rungs carrying the floor lock | 0 | **6 of 6 cards** |
| a bad cron marks the trigger card | no | **yes** (card + field) |
| cycle + cron errors listed together | — | **both**, 2 in the checklist |

**A deviation from §13.3.4, taken deliberately.** The study proposed the lock
only where a worker's tools carry an `alwaysAsk` floor. `alwaysAsk` is a
per-TOOL flag on the server and `GET /agent/fleet/charters` — a **sibling
stream's route** — does not expose it, so the client cannot know which workers
are floored. The sentence is true of every worker, so it is stated for every
worker rather than guessed per worker. **The field to ask for is recorded, not
invented.**

#### The defect prod found in S5.c

Closing a real loop — director hands back to the miner that feeds it — marked
**three** cards. Two were right. The third was the terminal **Plan critic**,
which is not in the loop at all, and its card told it to *"remove one of its
hand-offs"* when it has none.

I had used the wrong set. Kahn's forward peel leaves behind the loop **and
everything the loop starves**, because a step whose only feeder is stuck never
reaches in-degree 0. That set is right for parking columns and wrong for
assigning blame. The fix peels the other way too — drop anything with no
successor still standing, until nothing moves; what survives has both a
predecessor and a successor inside the set, which is exactly the steps on a
cycle. Exercised on six graphs, not just the one prod showed:

| graph | on-loop |
|---|---|
| council + director→miner (the prod case) | director, miner — **critic freed** |
| the real council (no cycle) | — |
| 3-cycle with two innocent steps downstream | a, b, c |
| self-loop | a |
| two disjoint cycles | all four |
| empty | — |

Re-verified on prod: **2 marked, critic clean**, and undoing the edge clears
both marks and the checklist.

#### S5.d — type, contrast, and the recovered draft

| Criterion | Before | After |
|---|---|---|
| contrast failures in the editor zone | **13** (every `.acr-pg-rung`, 4.38:1) | **0** |
| unselected rung ratio | 4.38:1 | **5.50:1** |
| `.acr-pg-muted` (the tier suffix) | **16px** | **11.5px** |

**Counting the scale found a defect looking had not.** `.acr-pg-muted` carries
a colour and no size, so the tier suffix fell through to the **root 16px** and
rendered *larger than the worker's own name* beside it at 12.5px — seven of
them, on every step head, through four phases of this section.

The rung override is `.wf-page .acr-pg-rung:not(.on)`, **not** bare: the
selected rung is white on blue (5.00:1, fine) and a bare override would have
EQUAL specificity to `.acr-pg-rung.on`, which falls through to source order —
the exact trap that shipped twice in S3R reading as fixed in the source.

#### The exit criterion that was wrong

S5.d's criterion said **5 sizes / 3 weights**. Measured on prod, the **S1R list
page — the reference it points at — is 7 sizes / 4 weights**: sizes
`{17, 15, 12.5, 12, 11.5, 11, 10.5}`, weights `{700, 650, 550, 400}`. The 5×3
figure came from a narrower scope than the page. **Chasing it in the editor
would have made the editor differ from every other section rather than match
it**, so the criterion is corrected here rather than reported as met.

The editor now measures **7 sizes / 5 weights**, and the whole residue is one
component:

| role | owner | verdict |
|---|---|---|
| 15 / 12.5 / 12 / 11.5 / 11 / 10.5 · 700 / 650 / 550 / 400 | page scale | **subset of S1R's** |
| **13px / 600** | `.h10-ds-btn` — the DS `Menu` trigger, ×2 | DS primitive, mandatory |

#### The recovered draft is a choice

| moment | behaviour |
|---|---|
| arriving with a stored draft | banner shown; **the wiring on screen is the LIVE one**; stored copy untouched; Publish disabled |
| "Use that draft" | banner gone, gate flips to the stored value, Publish enabled |
| "Throw it away" | banner gone, live wiring stands, Publish disabled |
| editing while the offer is open | counts as answering — all **8** mutation sites route through one `edit()` helper |

**And prod caught the storage half.** "Throw it away" removed the key, the
mirror effect then re-ran and wrote the baseline straight back, so the button
left a stored copy behind. Harmless — a stored baseline is never offered — but
a stored draft that is not a draft is a trap for whoever changes that
condition next. **The mirror now holds a draft only while there is one.**

#### `DiffList` in BOTH consumers

| consumer | result |
|---|---|
| **S5** Publish dialog | all four categories: `rem` step, `chg` gate, `rem` connection, `chg` trigger · note gates submit · **0 raw textarea**, 1 DS |
| **S4R** Activate dialog (rev 2) | `chg` "trigger changed" · heading "Activate rev 2?" · cancelled clean |

#### §13.4 state table

| # | State | Discharged |
|---|---|---|
| 1 | Revision baseline (custom, 2 steps) | ✅ prod |
| 2 | Code baseline (built-in, 6 steps) | ✅ prod |
| 3 | Empty compose (`EMPTY_DEF`) | ⛔ needs a throwaway custom = a permanent row; **not taken** |
| 4 | Cycle | ✅ prod, twice (and it found a defect) |
| 5 | Scheduled with zero steps | ✅ code path unchanged since WF.3 |
| 6 | Invalid cron × 3 | ✅ prod |
| 7 | Valid cron + presets + next fires | ✅ prod, 4 valid shapes |
| 8 | Tighten-only floor visible | ✅ prod (unconditional — see above) |
| 9 | Restored draft, both choices | ✅ prod |
| 10 | Save-as-draft dialog + diff | ✅ prod (same `DiffList`) |
| 11 | Publish dialog + diff, every category | ✅ prod |
| 12 | Note required | ✅ prod, both dialogs |
| 13 | Server rejection path | ✅ code — the client now refuses everything the server does |
| 14 | Discard restores | ✅ prod |
| 15 | `DiffList` in S4R's dialogs | ✅ prod |

**Row 3 is the one not discharged**, and deliberately: reaching the empty-compose
state on prod requires creating a custom routine that would then exist forever
in the operator's list. Recorded rather than faked.

#### Prod left as found

Council `v1` active serving 1 run, `rev 1`/`rev 2` superseded, 3 rows, *Mondays
at 05:15 UTC*. Custom `rev 3`, Ready, manual, *When you start it*. Every
`naf-wf-draft-*` key cleared. **No revision created, nothing published.**

#### Carried out of S5R

1. **Ask the Workers stream for an `alwaysAsk` floor per charter** on
   `GET /agent/fleet/charters`, so the gate lock can be per-worker.
2. **Move `cron-eval.ts` to `@nexus/shared`** — already a web dependency;
   blocked only on editing `fleet-schedule.service.ts` mid-session.
3. `.wf-editpic`'s internal scroll at `calc(100vh - 24px)` is **untested** —
   neither baseline is tall enough to reach it.
4. The fleet **cannot arm a schedule firing less often than every 8 days**
   (§13.9). Raising `SCAN_LIMIT_MINUTES` is a server call, not this section's.

## PART 14 — NAF.WF-S6R · Section 6 restudied: the test lane

Opened 2026-08-09 after S5R. Scope is the test zone inside `RoutineEditor.tsx`,
the three test routes, `workflow-test.service.ts`, `assembleTestStatus` in the
pure layer, and `lib.ts`'s test types. **Live-spend budget: 2 walks. One spent
in this audit ($0.0415); one reserved for post-build verification.**

**Not relitigated:** preview writes nothing to the board, the walk is serial,
one active test per workflow, the estimate comes first, `assembleTestStatus` is
the reducer of truth, failure sentences come from `classifyFailure`.

### 14.1 · PHASE 0 — the audit, measured on prod

Chrome, **1728 × 962**, on `morning-negatives-pass` (2 analysts, both switched
OFF). **One real walk: estimated $0.0414, actual $0.0415, 20 would-be findings,
~43s wall clock.** The custom ends the session exactly as found.

#### First, three facts about the machine that the UI is built on

Established by reading the code and confirmed against the live API — they set
up most of what follows.

1. **A preview DOES write `AgentRun` rows.** "Nothing written" is precise about
   the *blackboard* — no findings, no proposals — and the rows are real,
   permanent, and stamped `mode: 'preview'`. My walk added two.
2. **The would-be findings' CONTENT is already persisted**, in
   `AgentRun.output = { preview: true, data }` (`agent-executor.ts`, the
   preview branch). Nothing new has to be written to show it.
3. **The registry TTL is not what expires.** `TESTS` holds only the step order
   and the walking flag for 30 minutes; `getWorkflowTestStatus` falls back to
   the rows when the entry is gone. What actually ends the results is the
   **component**: `testId` is React state.

#### D1 · The results land off-screen, and nothing says they arrived

The headline. Measured with the finished panel on screen:

| | |
|---|---|
| panel top | **1020.6px** · viewport **962px** → **58.6px below the fold** |
| page scroll at that moment | `scrollTop: 0` — it never moved |
| distance from the Test button to the results | **648px** |
| `role` / `aria-live` on the panel | **none** |

So: confirm a spend, wait 43 seconds, and the screen does not change. On the
six-step council the editor grid measured **1741.8px** (S5.a), which puts the
panel roughly **1150px** below the fold.

#### D2 · Nothing in the viewport says a test is running

The only in-viewport signal is the Test button greying out. No label change, no
spinner, no elapsed time, no "step 1 of 2", no indication that the fleet is
mid-walk.

#### D3 · The legend reports `$0.0000` while money is being spent

Frames captured 1.6s apart:

| t | legend | rows |
|---|---|---|
| 4s–16s | *testing… · **$0.0000 spent** · 0 would-be findings* | harvester "working now…", miner "waiting its turn…" |
| 18s | testing… · $0.0116 spent · 5 would-be findings | harvester done, miner "working now…" |
| ~43s | finished · $0.0415 spent · 20 would-be findings | both done |

Cost only exists when a step's row is written at completion, so the running
total reads **zero for the first 40% of the walk** — in the one ceremony whose
entire justification is spend.

#### D4 · The estimate and the actual never appear together

**Estimated $0.0414, actual $0.0415 — 0.24% off.** That is an excellent number
and the operator never sees it, because the dialog carrying the estimate is
dismissed before the total exists.

#### D5 · You can confirm a spend with no estimate on screen

`Run the test` is disabled by `busy` alone. If `/test-estimate` fails, the
`catch` leaves `testEstimate` null and the dialog reads **"estimating…"
forever** with the confirm button live. A permanent "estimating…" is not
honest, it is stuck — and it is a hole in a spend control.

#### D6 · Real money buys results that Discard destroys without warning

Verified on prod: panel present → **Discard** → panel gone, and the confirm
path says nothing about a test. Publish unmounts the editor the same way.

#### D7 · The panel's row order contradicts the editor's card order

The panel walked **Keyword harvester → Negative miner**; the step cards list
**Negative miner → Keyword harvester**. Cause: `topoLevels` sorts each level
alphabetically (`levels.push([...current].sort())`) while the cards keep
`draft.steps` order. Two orders for two steps, on one screen.

#### D8 · The picture says "at the same time"; the test walks one at a time

`RoutinePipeline` renders both analysts under **AT THE SAME TIME**;
`startWorkflowTest` is **serial by design** (concurrency 1, so cost stays
legible and the fleet ceiling is never burst). Both are correct. Nothing on
screen reconciles them.

#### D9 · 72.5% dead width

Panel **1572px** wide; row content spans x=126 → 557.6, i.e. **432px**. The
S1R/S2R dead-width defect, in the one zone no section ever audited.

#### D10 · Of the three guarantees, one is unstated — and it is the surprising one

The footer covers writes. **Nothing anywhere says a test runs workers that are
switched OFF** — and on this routine both cards carry **OFF** pills while the
test ran them both and spent $0.0415. The screen contains a visible
contradiction and no explanation. `agent-executor.ts` is explicit
(`if (effectivelyOff && !opts.ignoreEnabled && !opts.preview)`); the UI is
silent.

#### D11 · "Would-be findings" is a number with no content

Twenty findings were produced, and are sitting in `AgentRun.output.data`. The
operator sees `20`.

#### D12 · Ephemerality is unstated and mis-modelled

Nothing says how long results last or where they went. The honest model is
above (fact 3): the rows are permanent, the *view* dies with the component.

#### One cross-stream fact this section owns

Ledger §4b item 2 (preview rows on the shared runs route) is **this section's
own externality**: measured today, preview rows are **10 of 55 fetched
(18.2%)**, up from 8 of 53 (15.1%) on 2026-08-08 — **my two test rows are the
increase.** Every test walk permanently enlarges a shared, capped feed. Item 1
(`.acr-btn.go`) is **CLOSED** — Approvals fixed it to `#15804f` on 2026-08-09.

#### What is already right, and is not to be broken

- **Zero writes, re-proven on prod**: after the walk, the routine's Runs
  section still reads *"No runs yet."*
- The estimate dialog: **0 contrast failures**, 2 sizes / 3 weights, targets
  2423px² and 3468px².
- The results panel: **0 contrast failures**, 4 sizes / 2 weights, all inside
  the page scale.
- The copy that exists is careful — *"Hand-offs are not simulated yet"* and
  *"nothing was written to the board"* are both exactly true.

#### States code-verified rather than bought

| State | Verdict |
|---|---|
| estimate error | `catch` → null → "estimating…" persists, confirm stays live (**D5**) |
| second test while walking | route returns **409** with the running `testId`; the client shows the message but ignores the id |
| TTL expiry mid-view | entry swept → `walking:false`, steps fall back to row order — no crash |
| fleet kill switch | route returns **503**, surfaced as `serverErr` |
| failed / stopped step | `assembleTestStatus` maps `haltedReason` → `stopped`, `!ok` → `failed`; `testStepSentence` already routes both through `classifyFailure` |

### 14.2 · PHASE 1 — how the industry tests, and what it costs

| Product | Entry & confirm | Cost shown | Per-step progress | What of the OUTPUT | Side effects |
|---|---|---|---|---|---|
| **Zapier** | per-step "Test step" | — | per step, inline | **the actual payload** ("Data out" tab) | **testing is LIVE and may change your app** — stated plainly |
| **n8n** | Execute Workflow / Execute step (partial) | — | inline on the canvas | node output, with **data pinning** to avoid re-hitting systems | docs are **silent** on side effects |
| **Power Automate** | Test pane | — | **green check / red ×** per action, expandable to inputs+outputs | inputs, outputs, messages per step | real run |
| **Camunda Play** | Play | — | token walk-through | instance variables and path | **isolated: a temporary cluster** |
| **LangSmith** | playground | **token cost + latency per step** | per node | inputs/outputs per node | observability, not execution |
| **Windmill** | "Test this step" / test flow | — | results beside the step | step result | real run |

**Four isolation models, and ours is its own.** Zapier tests by *doing it for
real and warning you*. Camunda tests on a *throwaway cluster*. n8n lets you
*pin data* so you stop hitting the system. We run the real reads and the real
model in the real place, and refuse only the writes. **Nobody else spends real
money to guarantee nothing happened** — which is precisely why our guarantees
have to be taught rather than assumed. Zapier's users learn "a test is real";
ours must learn the opposite, against that instinct.

**What this settles:**

1. **Content, not counts** (D11). Zapier shows the payload; Power Automate
   expands to inputs and outputs; LangSmith shows per-step cost. We show a
   number. Ours is the only product where the output is *the entire point* —
   the fleet's proposals are the product — and we are the only one hiding it.
2. **Per-step state deserves a glyph and a clock** (D2, D3). Power Automate's
   check/× per action and LangSmith's per-step latency+cost are the pattern.
3. **Cost display is our differentiator to get right** (D3, D4). Only LangSmith
   shows money at all, and only after the fact. We have an estimate *and* an
   actual and show neither together.
4. **Nothing in the research argues for durable test history** — Camunda throws
   the cluster away, n8n keeps manual runs out of the production list. Our
   ephemerality is normal; it just has to be *said* (D12).

### 14.3 · THE PROPOSAL

**14.3.1 · Bring the theatre into the room (D1, D2, D9).** The test panel moves
**above** the editor grid, immediately under the action row, so it appears
where the button that started it is. It gains `role="status"` and an
`aria-live="polite"` region for the step transitions. The Test button becomes a
live control while walking — *"Testing… step 2 of 2"* — so the in-viewport
answer to "is anything happening" is yes. The panel lays its rows in the same
lane grid the rest of the page uses, cutting the 72.5% dead width.

**14.3.2 · The money is legible while it is being spent (D3, D4, D5).** The
running total counts **committed + in-flight**: a step that is mid-call shows
*"spending…"* rather than contributing `$0.0000`. When the walk finishes the
panel states **estimate vs actual** on one line — the 0.24% number is a trust
asset and should be visible. `Run the test` is **disabled until an estimate
exists**, and a failed estimate says so and offers a retry instead of
"estimating…" forever.

**14.3.3 · The three guarantees, taught where they bite (D10).** The estimate
dialog gains the missing one: **this runs workers that are switched off**, said
before the spend, because that is the fact most likely to surprise. The panel
footer keeps the writes guarantee and gains the ephemerality one (D12).

**14.3.4 · One order, and the parallelism reconciled (D7, D8).** The panel
follows the **card order**, and the walk explains itself: a stage the picture
draws as *at the same time* is tested **one at a time, on purpose** — a
sentence, once, in the panel header.

**14.3.5 · Would-be findings, with content — boundary question (a): YES.**
The evidence is decisive: the content is **already persisted** in
`AgentRun.output.data`, so showing it is a **read**, not a write, and L2 is
untouched. The payload is sized honestly: **up to 5 per step, title and
severity only**, with *"showing 5 of 15"* when truncated. One additive field on
the status contract — `sample: Array<{ title, severity }>` per step — assembled
by `assembleTestStatus`, which stays pure (it gains the row's `output`, which
it already receives rows for) and keeps its vitest. The TTL story stays
straight because the sample comes from the same rows the status already reads:
if the rows are there, so is the sample.

**14.3.6 · Ephemerality said out loud, and Discard warns (D6, D12).** The panel
says what it is: *results live with this editing session; the run rows behind
them are kept*. **Discard and Publish warn when a finished test is on screen**
— you paid for it.

**14.3.7 · A `test` glossary term.** The glossary has `draft`, `run`,
`finding`, `preview-only` — **no `test`**. One term, claimed per §3.

**Boundary question (b) — entry point: NOT BUILT, recorded.** Testing the
**active** wiring without opening the editor is a real gap and the research
supports it. It belongs to S2R's overview zone, so it is filed as a follow-up
naming the coordination, not built here.

### 14.4 · State table, to be discharged before the last phase closes

| # | State | How |
|---|---|---|
| 1 | Estimate loading | code — resolves in <120ms on prod |
| 2 | Estimate failed | code + forced client-side |
| 3 | Confirm shown with estimate | prod |
| 4 | Walking · pending step | prod (walk 2) |
| 5 | Walking · running step | prod (walk 2) |
| 6 | Walking · done step mid-walk | prod (walk 2) |
| 7 | Finished, all done | prod (walk 2) |
| 8 | Estimate-vs-actual line | prod (walk 2) |
| 9 | Failed step | code — `assembleTestStatus` vitest |
| 10 | Stopped / halted step | code — vitest |
| 11 | TTL-expired entry | code — row fallback |
| 12 | Second-test refusal (409) | code + client |
| 13 | Kill-switch refusal (503) | code |
| 14 | Would-be sample, truncated | prod (walk 2 — 15 findings truncates) |
| 15 | Discard warns with results on screen | prod |
| 16 | Zero-writes re-proven after rebuild | **prod, mandatory** |

### 14.5 · Build phases

| Phase | What | Exit criteria |
|---|---|---|
| **S6.a** | Panel above the grid; `aria-live`; live Test button; lane layout. | Panel top **in viewport** at `scrollTop:0` on both baselines · `role`/`aria-live` present · button states "step N of M" while walking · dead width **< 15%** |
| **S6.b** | Money: in-flight total, estimate vs actual, confirm gated on an estimate, estimate error + retry. | Total never reads `$0.0000` while a step runs · estimate and actual on one line at finish · confirm disabled with no estimate · forced estimate failure shows an error, not "estimating…" |
| **S6.c** | Truth: OFF-workers guarantee in the dialog, one order, serial-vs-parallel sentence, ephemerality, Discard warning. | Dialog names all three guarantees · panel order **== card order** · Discard with results warns · `test` term live |
| **S6.d** | Content: the `sample` field + its display, type/contrast pass, states + teaching. | Sample renders with truncation copy · `assembleTestStatus` pure + vitest green · **0 contrast failures** · type inside the page scale · every §14.4 row discharged · **zero-writes re-proven on prod** |

### 14.6 · Recorded, not built

1. **Test the ACTIVE wiring from the routine page** — boundary (b). Needs S2R
   coordination; the overview zone is settled.
2. **Data pinning** (n8n). The fleet's evidence is the live board; pinning
   would mean a fixture store and is WF.7-adjacent.
3. **Durable test history.** Refused by L2 as a write path, and the research
   does not ask for it.
4. **A `mode: 'preview'` filter on the shared runs route** stays Workers'
   (ledger §4b item 2) — but this section is its producer, and every walk adds
   rows. Worth their attention now that it is 18.2%.

### 14.7 · S6.a–S6.d — EXECUTION RECORD (shipped and prod-verified 2026-08-10)

Seven commits: `d2cd509a7` (theatre), `2d4bf9edc` (money + truth),
`52a4dfeac` (content), `459f77f18` (label), `e8ec0426f` + `ab3e06601`
(two layout defects the verification walk found).

**Live spend for the whole section: 2 walks, $0.0768** — $0.0415 auditing,
$0.0353 verifying. Budget respected exactly.

#### Exit criteria

| Criterion | Before | After |
|---|---|---|
| results panel top at `scrollTop:0` | **1020.6px** (58.6 below a 962px fold) | **434.7px — in viewport** |
| `role` / `aria-live` | none | **`status` / `polite`** |
| in-viewport answer to "is it running?" | button greys out | **"Testing… step 1 of 2"** |
| panel row order vs card order | **reversed** | **identical** |
| running total while spending | **"$0.0000 spent"** | **"$0.0112 so far"** + "spending…" on the card |
| estimate vs actual | never together | **"$0.0353 spent (estimated $0.0415)"** |
| spend confirmable with no estimate | **yes** | **no** — "unknown", confirm disabled, retry offered |
| OFF-workers guarantee | **stated nowhere** | named in the dialog, before the spend |
| would-be findings | a count | **content**, capped, "showing 5 of 11" |
| leaving with paid results | silent destruction | **warns, naming cost and findings** |
| **zero writes after the rebuild** | — | **re-proven: Runs still "No runs yet."** |

#### Two layout defects the verification walk found

Both are the same lesson S5.a taught, arriving from new directions.

1. **The cap was fighting the track.** `auto-fit` gave two tracks of 767px and
   the cards were capped at 420, so each left 347px of its own track empty:
   **45.5% of the panel dead.** "Fit the tracks, cap the card" was right for a
   *pipeline* card holding thirty characters; this card holds a list. The card
   now fills its track and the list obeys the page's other law — **a wide card
   lays its facts in lanes**. Measured after: **0.5% dead, cards 98.3% filled.**
2. **Three 237px lanes clipped five of eleven labels** — *"veste moto homme
   homologué"* became *"veste moto homme homo…"*, removing the part that
   identifies it. Measured across four combinations: 237px lanes clip ten
   label/kind cells, 362.5px lanes clip none, wrapping clips none at either.
   These strings come from a model, so they **wrap** rather than ellipsise —
   content-independent — with a 300px lane keeping them to one line in practice.

**A third exit criterion of mine was wrong in kind.** S6.a asked for "dead
width < 15%" measured across the *panel*. A wrapping grid with two items in
four tracks always leaves trailing space, and that is ordinary layout. What
matters is whether a **card** is much wider than what it holds — which is what
S5.a actually measured. Corrected here rather than reported as met.

#### A defect caught by reading the API instead of a screenshot

Checking the new `sample` field against the **previous** walk's rows — before
spending anything — showed what the labels really are: a `SEARCH_TERM` finding
has no `entityName`, so its id is `405139580483411:motorrad jacke herren`. In a
card that ellipsises the end, that renders fifteen useless digits and hides the
words. Now a numeric key joined to text is labelled by the text; other id
shapes pass through, pinned by two tests.

That same probe discharged **row 11 (TTL-expired)** for free: the registry entry
had been swept hours earlier, so the response came entirely from the row
fallback — `walking:false`, totals exact, sample present.

#### §14.4 state table — 16 of 16

| # | State | Discharged |
|---|---|---|
| 1 | Estimate loading | ✅ code — resolves <120ms on prod |
| 2 | Estimate failed | ✅ prod, forced client-side: "unknown", confirm disabled, retry restores |
| 3 | Confirm shown with estimate | ✅ prod |
| 4 | Walking · pending | ✅ prod — both cards "waiting its turn…" |
| 5 | Walking · running | ✅ prod — "working now…" + "spending…" |
| 6 | Walking · done mid-walk | ✅ prod — harvester finished while the miner ran |
| 7 | Finished, all done | ✅ prod |
| 8 | Estimate-vs-actual line | ✅ prod |
| 9 | Failed step | ✅ vitest |
| 10 | Stopped / halted step | ✅ vitest |
| 11 | TTL-expired entry | ✅ prod — row fallback, entry long swept |
| 12 | Second-test refusal (409) | ✅ code |
| 13 | Kill-switch refusal (503) | ✅ code |
| 14 | Sample, truncated | ✅ prod — "showing 5 of 11" |
| 15 | Discard warns | ✅ prod — names $0.0353 and 16 findings; "Stay here" preserves the panel |
| 16 | **Zero writes re-proven** | ✅ **prod — "No runs yet." after both walks** |

#### One verification limitation, stated — and then narrowed

The two layout fixes (`e8ec0426f`, `ab3e06601`) were measured by applying the
**shipped rules** to the live rendered panel, because re-creating the panel on
prod requires another walk and the budget was spent. The numbers above are from
real content at the real width.

The deployed stylesheet was then read back to confirm it serves exactly those
rules, rather than asserting it:

```
.wf-teststeps  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr))
.wf-teststep   … min-width:0; padding:9px 12px …        ← NO max-width
.wf-testfinds  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr))
.wf-findlabel  color:#34404f; min-width:0; font-weight:650  ← NO nowrap / ellipsis
```

The cap and the ellipsis — the two declarations that caused both defects — are
**absent from the served CSS**. What remains unobserved is only those rules and
that content painted together in a single prod frame, which costs a walk.

**Regression check on the S5R editor after all of it** (council, prod, no
spend): grid **879.5 / 676.5**, 7 step cards, 6 pipeline steps, **0 raw form
controls**, **0 contrast failures**, type unchanged at 7 sizes / 5 weights.

#### The service change, and what it did not do

`sampleFindings` is pure, in the prisma-free layer beside `assembleTestStatus`,
with **nine tests** — including that it never throws on nine malformed shapes,
because a poll that dies on a weird finding takes the panel with it. The service
select gained **one column**. No new write path; law L2 untouched. Fleet suite
**44 files / 410 tests**.

#### Prod left as found

Custom `rev 3`, **Ready**, manual, *"never run"*, Runs *"No runs yet."*, every
`naf-wf-draft-*` key cleared. Two preview run rows added by the walks — which is
what a test is, and why §4b item 2 is this section's own externality.

## PART 15 — NAF.WF-S7R · Section 7: the teaching layer, read as one text

Opened 2026-08-10, after all six zones were rebuilt. S7 was defined as a
*condition of done*, not a phase; this makes it real. **Zero spend** — nothing
below required a test walk.

**Not relitigated:** no tour library, no overlays; teaching stays as the
collapsible card, `<Term>` tooltips, and sentences in place; the card
summarises what a sentence in place already says rather than duplicating it.

### 15.1 · PHASE 0 — the cold-reader audit, on prod

Both pages at 1728 × 962. Prod ends as found: council `v1`, custom `rev 3`,
card closed, no revisions, no spend.

#### F1 · The page's real teaching layer is 49 tooltips nobody can reach by keyboard

| | list page | detail page |
|---|---|---|
| `title` attributes inside `.wf-page` | **49** (35 unique) | 11 (8 unique) |
| of those, on a focusable element | **0** | 3 |
| `<Term>` usages in place | **2** | **1** |

And the copy in them is *good*: *"Fleet self-test is switched OFF, so this step
is skipped and costs nothing. The Workers page decides."* · *"Grading —
deterministic code, not judgment. It always runs."* · *"Each bar is one run,
oldest on the left…"*. **The best teaching on this page lives in the one
mechanism a keyboard user cannot open, a touch user never sees, and no glossary
governs.** NN/g is explicit: *"Tooltips that appear only on mouse hover are
inaccessible for users that rely on keyboards"*, and tooltips must not carry
information vital to completing a task.

#### F2 · Two tooltip systems, one governed and one not

`<Term>` is glossary-backed, styled, `tabIndex={0}`, focus- and Escape-aware —
**23 usages page-wide**. `title` is **60 strings across both pages**, governed
by nothing, listed nowhere, and free to drift independently of the glossary
that defines the same words.

#### F3 · The card is 1,775 words and identical on both pages

| | |
|---|---|
| paragraphs | **13** |
| words | **1,775** (~8 minutes) |
| rendered height | **1,366px = 1.42 screens** |
| `<Term>` usages inside it | **14 of the page's 23** |
| paragraphs about the *other* page | **7 of 13** on the list · 4 of 13 on the detail |

Longest paragraphs: *How to read a routine* 209w, *What a test costs* 199w,
*What the editor tells you* 189w. NN/g's overlay research is the evidence
against this shape: short-term memory *"fades in about 20 seconds"*, users
dismiss text-heavy help, and hints work *"one-by-one, at the right moment"*.
An eight-minute essay behind a **Read it** button is the opposite, and it is
carrying most of the page's teaching.

#### F4 · The card's own header says "six honest paragraphs". There are thirteen.

Drift, in the file whose job is to prevent it.

#### F5 · The `workflow` glossary entry is stale

> *"…a workflow is one routine, readable on its own — **and, soon, versionable
> and editable**."*

Versioning shipped in WF.2–WF.4 and was rebuilt in S4R; editing shipped in
WF.3 and was rebuilt in S5R. "Soon" describes last month's fleet.

#### F6 · `run` means one thing in the glossary and another on this page

Glossary (Activity's term): *"**One worker** doing its job once."* This page:
*"One line per <Term k=run>run</Term> **of the whole routine**"* — the Runs
section groups by `orchestrationId`. **The tooltip contradicts the sentence
it is inside.** Cross-page term; an edit is cross-stream.

#### F7 · `draft` carries two senses on one screen

Glossary: *"A **recorded revision** that is not active."* The editor header
says *"Editing — a draft"* about an **unsaved** edit, and S5.d's banner offers
*"Use that draft"* about a **browser-stored** one. Three different things, one
word, one tooltip.

#### F8 · An OFF pill beside a line that shows what it cost

On the council: Director renders **OFF** and, on the same card,
*"ok · 2m 47s · $0.1944"*. The reconciliation — the pill is today's dial, the
line is the last run's reality — is in card paragraph 5, one click away. On
screen and on hover: **absent**.

#### F9 · The six rebuilt zones barely teach in place

`RoutineCard`, `RunsSection`, `RoutinePipeline`, `RunBars`: **zero** `<Term>`.
The whole detail page carries **one** (`approval`). Undefined and unhoverable
on screen: the artifact chips (**FINDINGS / PLAN / VERDICT / SURVIVORS**), the
stage labels (**AT THE SAME TIME**, **THEN**), the state chips
(**superseded / active / served 1 run**), the autonomy pills.

#### F10 · The S6 seam duplicates itself

*"Trying things safely"* (WF.6-era) and *"What a test costs, and what it
touches"* (S6R) are adjacent paragraphs teaching the same write-nothing
guarantee in different words. Six independent teaching passes, exactly as
predicted.

#### The scorecard

`on screen` · `hover` · `click` (the card) · **ABSENT**

| # | Question a cold reader asks | List | Detail |
|---|---|---|---|
| 1 | What is a workflow? How is it different from the map, or a worker? | **on screen** + hover | click |
| 2 | Why didn't it run? | **on screen** | **on screen** |
| 3 | What will it cost? | **on screen** | **on screen** |
| 4 | What can it touch — what protects me? | **on screen** + hover | **on screen** |
| 5 | What happens if I publish this? | — | **on screen** (dialog) |
| 6 | Can I undo it? | click | hover¹ + click |
| 7 | Did my test change anything? | — | **on screen** (S6.c) |
| 8 | Where did my test results go? | — | **on screen** (S6.c) |
| 9 | **Why is this worker crossed out?** | hover¹ + click | hover¹ |
| 10 | **What does this chip mean?** | hover¹ (kind/version) · **ABSENT** (artifact chips) | **ABSENT** |

¹ *`title` only — not keyboard-reachable, invisible on touch.*

**Two ABSENT, and every "hover" on the page is an inaccessible one.** The
questions the six rebuilds answered best — cost, refusal, consequence, test
guarantees — are the ones now answered on screen. The ones nobody owned,
because they belong to no single zone, are the ones left.

#### Three inventories

**(a) Every `<Term>`, is its copy still true?** 10 of 12 keys used are true.
`workflow` is **stale** (F5); `run` **conflicts** with this page's usage (F6);
`draft` is **ambiguous** (F7).

**(b) Orphans.** None. Every term this page minted (`workflow` `trigger` `gate`
`draft` `publish` `step` `revision` `test`) is still used.

**(c) Every claim in the card against the six records.** 13 paragraphs: 9 true,
**1 stale** (the header's "six paragraphs"), **1 duplicated** (F10), and
**2 holes** — nothing teaches S3R's *run-selection re-colours the pipeline*
where the runs are (it is in paragraph 6, on a page that also has paragraph 5
describing the pipeline), and nothing teaches S4R's *served N runs* except
inside the versions paragraph.

### 15.2 · PHASE 1 — where teaching lives, and how it stays true

| Source | What it settles |
|---|---|
| **NN/g, instructional overlays** | recall *"fades in about 20 seconds"*; successive hints make a product *"appear overly complicated"*; deliver *"one-by-one, at the right moment"*, contextually — the case against a 1,775-word card carrying the load |
| **NN/g, tooltip guidelines** | tooltips are *microcontent*; **must support mouse AND keyboard**; **never** carry information vital to task completion |
| **GitHub hovercards / Wikipedia previews** | one scoped fact per hover, on the noun itself, where it appears |
| **Stripe** | expandable explanation *beside the consequence*, at the moment of decision — which is what our publish/test dialogs already do |
| **Linear** | empty states as the teaching surface — ours already do this well (*"No runs yet. When this routine runs, every execution lands here…"*) |
| **Documentation drift (industry)** | universal; the only durable answers are a **single source of truth for copy** and **mechanical detection** — not diligence |

**Judged for our reader** — one operator, daily, who must not be condescended
to on visit fifty nor lost on visit one: the card is the *reference*, not the
teacher. The teacher is the noun on screen. That inverts today's ratio, where
14 of 23 term usages are inside the card.

### 15.3 · THE PROPOSAL

**15.3.1 · The card teaches its own page (F3, F10).** Split by page: the list
card keeps what the list shows, the detail card what the detail shows, with a
short shared preamble. Cut the S6 duplication, retire the stale header, and
bring the total down — the target is *no paragraph about a page you are not
on*, not a word count for its own sake.

**15.3.2 · Teach on the noun (F9, F1).** Wire `<Term>` into the rebuilt zones
where a load-bearing concept is on screen and undefined: the artifact chips,
the state chips, the run rows, the autonomy pills. This is the ratio inversion:
concepts get defined where they appear.

**15.3.3 · Every teaching tooltip becomes reachable (F1, F2).** A `title` that
carries teaching becomes either a `<Term>` (when it is a glossary concept) or a
DS `Tooltip` on a focusable trigger (when it is per-instance, like *"Fleet
self-test is switched OFF…"*). Per-run data tooltips on the bars stay as they
are — they are data, not teaching. **This is the one proposal that touches more
than words**, and it is an accessibility fix to the teaching layer itself.

**15.3.4 · Three glossary corrections (F5, F6, F7).** `workflow`: delete
"soon", state what shipped. `run`: **cross-stream** — it is Activity's term
and the fix is additive precision, naming both grains (one worker's run; a
routine's run is the group of them). `draft`: name the two senses. Claimed with
diffs, per §3.

**15.3.5 · The drift defence, written down and mechanical.** A vitest that
parses `fleet/workflows/**` for `<Term k="…">` and asserts every key resolves
in `GLOSSARY`, and that every term this page minted is still referenced — so a
renamed key or an orphan fails a test instead of shipping. Plus a recorded
short-fragment grep list in this doc for the phrases that must be re-checked
when behaviour changes. Diligence is not a defence; a failing test is.

### 15.4 · Build phases

| Phase | What | Exit criteria |
|---|---|---|
| **S7.a** | Card per page; kill the duplication; retire the stale header. | List card: **0** paragraphs about the detail page, and vice versa · S6 guarantee stated **once** · header comment matches the file · every claim traceable to a record |
| **S7.b** | `<Term>` on the nouns in the six zones; the missing terms minted. | Scorecard Q9/Q10 **not ABSENT** · in-place term usages **> card term usages** · 0 `<Term>` inside a link |
| **S7.c** | Teaching tooltips become keyboard-reachable. | **0** keyboard-unreachable teaching `title`s on either page · per-run data tooltips untouched |
| **S7.d** | Glossary truth + the drift test. | 3 entries corrected, cross-stream diffs stated · vitest fails on an unknown key and on an orphan · scorecard **re-run on prod: zero ABSENT** |

### 15.5 · Recorded, not built

1. **F8 needs no new mechanism** — the OFF-pill/cost collision is teachable in
   place at S7.b; if it still reads wrong after a term, it is S2R's design
   question, not a wording one.
2. **A docs link out of the product.** Nothing in the fleet has one; adding a
   destination is an engagement, not a sentence.
3. **First-run vs hundredth-run treatment.** The card is collapsed by default,
   which is the cheap version of this and is probably right at N=1 operator.

---

## Sources

**Part 15 (WF-S7R, in-product teaching research, 2026-08-10)** — NN/g [tooltip guidelines](https://www.nngroup.com/articles/tooltip-guidelines/) (tooltips are *microcontent*; **must support mouse AND keyboard** — *“tooltips that appear only on mouse hover are inaccessible for users that rely on keyboards”*; never carry information vital to task completion) · NN/g [instructional overlays and coach marks](https://www.nngroup.com/articles/mobile-instructional-overlay/) (recall *“fades in about 20 seconds”*; successive hints make a product *“appear overly complicated and daunting”*; deliver hints *“one-by-one, at the right moment”* — the evidence against a long card carrying the teaching, and for teaching on the noun) · GitHub hovercards and Wikipedia page previews (one scoped fact, on the noun, where it appears) · Stripe (expandable explanation beside the consequence — what our publish/test dialogs already do) · Linear (empty states as the teaching surface) · documentation-drift practice ([Document360](https://document360.com/blog/documentation-drift/), [UX Content Collective](https://uxcontent.com/ux-copy-single-source-truth/): the durable answers are a single source of truth for copy and **mechanical detection**, not diligence).

**Part 14 (WF-S6R, test/dry-run-lane research, 2026-08-09)** — [Zapier: Test Zap steps](https://help.zapier.com/hc/en-us/articles/18811411817741-Test-Zap-steps) (**testing is LIVE and may change your app**, stated plainly; the "Data out" tab shows the actual payload) · [n8n: types of executions](https://docs.n8n.io/build/understand-workflows/understand-executions/types-of-executions/) (manual runs display inline in the editor, production runs live in a separate Executions tab; docs are **silent** on side effects) and [data pinning](https://docs.n8n.io/build/work-with-data/pin-and-mock-data) (pin a node's output so testing stops re-hitting the system) · [Power Automate: testing flows](https://learn.microsoft.com/en-us/power-automate/desktop-flows/test-desktop-flows) (green check / red × per action, expandable to inputs, outputs and messages) · [Camunda 8 Play](https://docs.camunda.io/docs/next/components/hub/workspace/modeler/validation/play-your-process/) (**isolation by throwaway cluster** — a temporary Zeebe cluster spun up for the test) · LangSmith (per-step **token cost and latency**, unified cost view) · Windmill (test a step in isolation, results beside it). **The synthesis: four isolation models, and ours is its own** — Zapier does it for real and warns you, Camunda throws a cluster away, n8n pins the data, and we run real reads and a real model in the real place and refuse only the writes. Nobody else spends real money to guarantee nothing happened.

**Part 13 (WF-S5R, structured-editor research, 2026-08-08)** — Power Automate [cloud flows designer](https://learn.microsoft.com/en-us/power-automate/flows-designer) (compact cards + configuration pane; **the error appears in a summary AND on the card that caused it**; separate **Save draft** / **Publish**; Undo/Redo; per-card notes; on a failed save it writes to browser storage, banners it, and offers **Recover flow**; a test marks each card with a green check and its seconds) · Windmill [flow editor components](https://www.windmill.dev/docs/flows/editor_components) (select a step → action editor with header/body/**Test this step**; autosave indicator; Diff button) · cron-input state of the art, surveyed across current builders (**presets**, **next N fire times**, invalid expressions **bordered red**, field dropdowns, and a plain-English "Means" line whose stated purpose is that *if it doesn't say what you expected, your expression is wrong*)

**Part 12 (WF-S4R, version-history research, 2026-08-08)** — Grafana [dashboard version history](https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/manage-version-history/) (select TWO versions then Compare; text diff + expandable raw JSON; **Restore appends a NEW version holding the old content** and a Notes column records "restored from vN") · Astronomer [Airflow DAG versioning](https://www.astronomer.io/docs/learn/airflow-dag-versioning) (**every run is bound to the version that existed when it started and the UI shows it**; graph and code tabs let you pick a version) · n8n [view change history](https://docs.n8n.io/build/manage-workflows/view-change-history) (View / Restore / Clone per version; restore = "replace your current workflow with the selected version"; retention 24h → 5d → full by plan) · Vellum [release tags](https://docs.vellum.ai/product/deployments/release-tags) (**floating tags you move** to point at an earlier deployment — the pointer model, as ours is)

**Part 11 (WF-S3R, run-history research, 2026-08-08)** — Astronomer [Airflow UI](https://www.astronomer.io/docs/learn/airflow-ui) (grid = a column per run, **height = the run's duration**, colour = state, run-origin icons; a run's bar opens a Gantt, a task square opens that task instance's logs) · Inngest [inspecting function runs](https://www.inngest.com/docs/platform/monitor/inspecting-function-runs) (a run **expands in place** into trigger+payload, a steps timeline, and per-step inspection showing **every retry attempt with its own error**) · n8n [debug and re-run past executions](https://docs.n8n.io/workflows/executions/debug/) + [single-workflow executions](https://docs.n8n.io/build/understand-workflows/understand-executions/view-executions-for-a-single-workflow) (**"Copy to editor"** pins a past execution's data into the canvas; filter by Failed/Running/Success/Waiting) · Temporal [Web UI](https://docs.temporal.io/web-ui) (history in Timeline / All / Compact / JSON) · Dagster [webserver & UI](https://docs.dagster.io/guides/operate/webserver) (Runs tab per job) · GitHub Actions [view workflow run history](https://docs.github.com/en/actions/how-tos/monitor-workflows/view-workflow-run-history)

**Part 10 (WF-S2R, detail-page research, 2026-08-08)** — Astronomer [intro to the Airflow UI](https://www.astronomer.io/docs/learn/airflow-ui) (single-DAG page: header actions top-right; grid columns = runs, squares = task instances, height = duration, colour = outcome; **the graph is annotated with a selected run's task states**; `g` toggles grid↔graph) · Temporal [Web UI](https://docs.temporal.io/web-ui) (execution page: Start/Close/Duration + Run ID + Type + Task Queue in the header; History in Timeline / All / Compact / JSON; **no workflow diagram** — a Relationships tree instead) · Dagster [webserver & UI](https://docs.dagster.io/guides/operate/webserver) (job page tabs: **Overview = the graph** · Launchpad · Runs · Partitions) · Inngest [observability & metrics](https://www.inngest.com/docs/platform/monitor/observability-metrics) (per-function charts: status breakdown, throughput, steps throughput, backlog, failure frequency, all time-range filtered) · GitHub Actions [manually running a workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow) (**"Run workflow" renders only when the workflow declares `workflow_dispatch`**)

**Part 9 (WF-S1R, list-page research, 2026-08-08)** — Airflow 3 [UI overview](https://airflow.apache.org/docs/apache-airflow/stable/ui.html) · Astronomer [intro to the Airflow UI](https://www.astronomer.io/docs/learn/airflow-ui) (card view default, bars = duration × status, run-type icons, ⌘K, list view for many DAGs) · Trigger.dev [scheduled tasks](https://trigger.dev/docs/tasks/scheduled) (declarative vs imperative rows, next/last run, dashboard-editable only for imperative) · UiPath Orchestrator [monitoring processes](https://docs.uipath.com/orchestrator/automation-cloud/latest/user-guide/monitoring-processes) (count-vector columns, colour persistence, grey = never executed) · Make [scenario list & history](https://help.make.com/scenario-history) · Power Automate [create & manage a cloud flow](https://learn.microsoft.com/en-us/power-automate/get-started-logic-flow) (⋮ menu, 28-day history on the detail) · Temporal [Web UI](https://docs.temporal.io/web-ui) · n8n [workflow tags](https://docs.n8n.io/workflows/tags/) · Zapier [product updates, Feb 2026](https://zapier.com/blog/february-2026-product-updates/) (favourites across asset listings)

- n8n [save & publish](https://docs.n8n.io/build/understand-workflows/save-and-publish-workflows.md) · [executions](https://docs.n8n.io/build/understand-workflows/understand-executions/view-executions-for-a-single-workflow.md) · [debug in editor](https://docs.n8n.io/build/understand-workflows/understand-executions/debug-executions.md) · [history](https://docs.n8n.io/build/manage-workflows/view-change-history.md) · [HITL tools](https://docs.n8n.io/advanced-ai/human-in-the-loop-tools/)
- Zapier [drafts & versions](https://help.zapier.com/hc/en-us/articles/9693520498445) · [Human in the Loop](https://help.zapier.com/hc/en-us/articles/38838619533069) · [run statuses](https://help.zapier.com/hc/en-us/articles/20505304170637) · Make [execution view](https://experienceleague.adobe.com/en/docs/workfront-fusion/using/manage-scenarios/view-a-specific-scenario-execution) · [version diff](https://experienceleague.adobe.com/en/docs/workfront-fusion/using/manage-scenarios/restore-a-scenario-version)
- Temporal [schedules](https://docs.temporal.io/schedule) · Airflow [UI](https://airflow.apache.org/docs/apache-airflow/stable/ui.html) · [DAG versioning](https://www.astronomer.io/docs/learn/airflow-dag-versioning) · Dagster [testing schedules](https://docs.dagster.io/guides/automate/schedules/testing-schedules) · [webserver](https://docs.dagster.io/guides/operate/webserver) · Prefect [deployments](https://docs.prefect.io/v3/concepts/deployments) · UiPath [processes](https://docs.uipath.com/orchestrator/automation-cloud/latest/user-guide/managing-processes) · [triggers](https://docs.uipath.com/orchestrator/automation-cloud/latest/user-guide/about-triggers)
- Power Automate [approvals](https://learn.microsoft.com/en-us/power-automate/modern-approvals) · [fix failures](https://learn.microsoft.com/en-us/power-automate/fix-flow-failures) · [test flows](https://learn.microsoft.com/en-us/power-automate/guidance/coding-guidelines/test-cloud-flows) · Windmill [suspend/approval](https://www.windmill.dev/docs/flows/flow_approval) · ServiceNow [Flow Designer](https://www.servicenow.com/products/platform-flow-designer.html) · Camunda [incidents](https://docs.camunda.io/docs/components/operate/userguide/resolve-incidents-update-variables/) · [Play](https://docs.camunda.io/docs/components/modeler/web-modeler/play-your-process/)
- Copilot Studio [multistage approvals](https://learn.microsoft.com/en-us/microsoft-copilot-studio/flows-advanced-approvals) · [multi-agent patterns](https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/multi-agent-patterns) · OpenAI [node reference](https://developers.openai.com/api/docs/guides/node-reference) · [Agent Builder deprecation](https://community.openai.com/t/deprecation-notice-agent-builder/1382650) · LangGraph [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) · LangSmith [cost tracking](https://docs.langchain.com/langsmith/cost-tracking) · Dify [Human Input](https://dify.ai/blog/the-human-input-node-bringing-human-judgment-into-automated-workflows) · [version control](https://docs.dify.ai/en/guides/management/version-control) · Vellum [release tags](https://docs.vellum.ai/product/deployments/release-tags) · Relevance AI [approvals](https://relevanceai.com/docs/build/workforces/workforce-features/approvals-and-escalations) · CrewAI [HITL](https://docs.crewai.com/en/learn/human-in-the-loop)
