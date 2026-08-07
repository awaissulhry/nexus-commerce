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

---

## Sources

- n8n [save & publish](https://docs.n8n.io/build/understand-workflows/save-and-publish-workflows.md) · [executions](https://docs.n8n.io/build/understand-workflows/understand-executions/view-executions-for-a-single-workflow.md) · [debug in editor](https://docs.n8n.io/build/understand-workflows/understand-executions/debug-executions.md) · [history](https://docs.n8n.io/build/manage-workflows/view-change-history.md) · [HITL tools](https://docs.n8n.io/advanced-ai/human-in-the-loop-tools/)
- Zapier [drafts & versions](https://help.zapier.com/hc/en-us/articles/9693520498445) · [Human in the Loop](https://help.zapier.com/hc/en-us/articles/38838619533069) · [run statuses](https://help.zapier.com/hc/en-us/articles/20505304170637) · Make [execution view](https://experienceleague.adobe.com/en/docs/workfront-fusion/using/manage-scenarios/view-a-specific-scenario-execution) · [version diff](https://experienceleague.adobe.com/en/docs/workfront-fusion/using/manage-scenarios/restore-a-scenario-version)
- Temporal [schedules](https://docs.temporal.io/schedule) · Airflow [UI](https://airflow.apache.org/docs/apache-airflow/stable/ui.html) · [DAG versioning](https://www.astronomer.io/docs/learn/airflow-dag-versioning) · Dagster [testing schedules](https://docs.dagster.io/guides/automate/schedules/testing-schedules) · [webserver](https://docs.dagster.io/guides/operate/webserver) · Prefect [deployments](https://docs.prefect.io/v3/concepts/deployments) · UiPath [processes](https://docs.uipath.com/orchestrator/automation-cloud/latest/user-guide/managing-processes) · [triggers](https://docs.uipath.com/orchestrator/automation-cloud/latest/user-guide/about-triggers)
- Power Automate [approvals](https://learn.microsoft.com/en-us/power-automate/modern-approvals) · [fix failures](https://learn.microsoft.com/en-us/power-automate/fix-flow-failures) · [test flows](https://learn.microsoft.com/en-us/power-automate/guidance/coding-guidelines/test-cloud-flows) · Windmill [suspend/approval](https://www.windmill.dev/docs/flows/flow_approval) · ServiceNow [Flow Designer](https://www.servicenow.com/products/platform-flow-designer.html) · Camunda [incidents](https://docs.camunda.io/docs/components/operate/userguide/resolve-incidents-update-variables/) · [Play](https://docs.camunda.io/docs/components/modeler/web-modeler/play-your-process/)
- Copilot Studio [multistage approvals](https://learn.microsoft.com/en-us/microsoft-copilot-studio/flows-advanced-approvals) · [multi-agent patterns](https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/multi-agent-patterns) · OpenAI [node reference](https://developers.openai.com/api/docs/guides/node-reference) · [Agent Builder deprecation](https://community.openai.com/t/deprecation-notice-agent-builder/1382650) · LangGraph [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) · LangSmith [cost tracking](https://docs.langchain.com/langsmith/cost-tracking) · Dify [Human Input](https://dify.ai/blog/the-human-input-node-bringing-human-judgment-into-automated-workflows) · [version control](https://docs.dify.ai/en/guides/management/version-control) · Vellum [release tags](https://docs.vellum.ai/product/deployments/release-tags) · Relevance AI [approvals](https://relevanceai.com/docs/build/workforces/workforce-features/approvals-and-escalations) · CrewAI [HITL](https://docs.crewai.com/en/learn/human-in-the-loop)
