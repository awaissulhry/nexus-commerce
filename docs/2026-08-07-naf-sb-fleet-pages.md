# NAF.SB — What pages the Agent Fleet needs

**Status: AWAITING APPROVAL.** Research + proposed information architecture. No
code beyond SB.1 (`0f1efc256`, the rail section) has been written against this.

Operator asks that drive this, in their words:

1. Assign a worker to a **specific entity** — "if we have a campaign, I want to
   assign that worker… and take action on that single campaign."
2. Upload **files from my computer** — Excel templates for agents to use or fill.
3. Make **connections** — "a worker collects information from several other
   workers, compiles it, sends it to another worker, then other workers take a
   specific action **without losing any context**."
4. **Create new workers** and change workflows.
5. A **bigger fleet map** page.
6. Manage everything, keep control of everything, but **most of it automated —
   taking control should be optional**.
7. A beginner must understand every screen. Tooltips everywhere.

---

## PART 1 — What the industry actually does

I read five archetypes. Each contributes something different; none of them is
the whole answer for us.

### A. Workflow canvas — n8n, Zapier, Gumloop, Workato

IA: **Overview → Workflows · Executions · Credentials · Templates · Variables ·
Data tables · Insights · Settings**. Inside one workflow: **Editor / Executions /
Evaluations / History**.

What to steal:

- **The canvas is the artifact.** You edit the graph directly; there is no
  "configure your pipeline" form. This is what makes connections feel authorable
  rather than requested.
- **Executions are a separate page from the editor**, with per-node input/output
  inspection and replay. Nobody serious merges "what should happen" with "what
  did happen".
- **Version history per workflow** — restore a previous version.
- **Data tables** (n8n 2.0) — lightweight persistent storage workflows read and
  write. This is the closest existing product answer to ask #2.
- Credentials live apart from workflows. Secrets are never inline.

### B. Agent control plane — Microsoft Agent 365, ServiceNow AI Control Tower, LangSmith Deployment, CrewAI AMP, AWS Bedrock AgentCore

IA: **Registry/Inventory → Agent detail → Deployments → Observability → Evals →
Policy/Governance → Cost & Value**.

What to steal:

- **The registry is the spine.** Agent 365 keeps one row per agent with owner,
  permissions, data access and lifecycle state, and makes *publish or reject* a
  single workflow. Everything else hangs off that row.
- **ServiceNow's Value dashboard** consolidates ROI, cost avoidance and *adoption
  blockers* (policy holds, latency, access gaps) — not just spend. Cost alone is
  not decision-grade; cost **per accepted action** is.
- **AgentCore** splits the runtime into named capabilities — Runtime, Gateway,
  Memory, Identity, Observability, Code Interpreter, Browser. The lesson is that
  *memory and identity are first-class surfaces*, not properties buried in a
  config blob.
- **Agentforce moved Testing Center out of Setup and into the Studio as a tab**,
  next to Builder and Observability, explicitly because a separate surface got
  ignored. Strong evidence for: keep testing beside the thing being tested.

### C. RPA orchestrator — UiPath Orchestrator + Action Center

IA: **Processes · Jobs · Queues · Triggers · Assets · Robots · Action Center ·
Audit**, all scoped by Folders.

This is the archetype for ask #1, and it is the one the master brief never
considered:

- **Queues and queue items.** Work is *data*, not code. You put items in a queue;
  a **queue trigger** starts a job when items arrive; a job is one worker
  processing items. Items carry states — New / InProgress / Successful / Failed /
  Retried / Abandoned. "Assign that worker to this campaign" is literally a queue
  item.
- **Triggers separate *when* from *what*.** Time triggers and queue triggers are
  managed on their own page, independent of the process.
- **Action Center** turns human decisions into assignable work with owners,
  forms, and due dates — an approval is a *task*, not a notification.
- **Assets** — shared, scoped configuration values that any process can read.

### D. Data orchestration — Airflow, Dagster, Prefect, Temporal

IA: **DAGs/Assets · Runs · Schedules · Backfills · Catalog & lineage · Workers ·
Alerts**.

- **The graph page and the runs page are always separate.** The graph is the
  definition; a run is an instance. Every mature orchestrator has both, and
  conflating them is a known novice mistake.
- **Backfill is a named, first-class operation** — "re-run over this historical
  range" with a preview of what it would touch.
- **Dagster's asset catalog** — what data exists, who produced it, how fresh it
  is. Our blackboard (Observations / Findings / Plans) is exactly an asset graph.
- **Temporal's worker health** — is capacity actually there and polling? A
  scheduled job that silently has no worker is the classic failure.

### E. Evals and observability — LangSmith, Langfuse, Braintrust, Vellum, Arize

IA: **Traces · Datasets · Experiments · Prompts (versioned) · Dashboards ·
Annotation queues**.

- **The annotation queue is the flywheel.** Humans label outputs; labels become
  the eval set. Our approve/reject decisions already mint `AgentExemplar` rows —
  we have the flywheel and no surface showing it.
- **Prompt versioning is its own surface** with diff and rollback. We have
  `AgentCharter.version`, `charter-revisions.service`, and AC.8 A/B between
  revisions — again, more backend than UI.

### F. Human-in-the-loop UX — LangChain Agent Inbox

An inbox-style UI over interrupted agent runs, with exactly four responses:
**accept · edit · reject · respond**. The *edit* action is the one we are missing
— today an operator can approve or reject a proposed action, but not amend it
before it runs.

---

## PART 2 — Verdict on the six sections we have today

The current page (`/marketing/ads/fleet`) is one scroll with six sections. Here is
what happens to each.

| # | Section today | Verdict | Where it goes |
|---|---|---|---|
| 1 | **Fleet map** | **Own page** — full viewport, and upgraded from picture to instrument | `/fleet/map`; a small live thumbnail stays on Overview |
| 2 | **Decision timeline** | **Own page** — this is the Executions/Traces page every archetype has | `/fleet/activity`, with **Decisions / Runs** tabs |
| 3 | **Approval inbox** | **Own page** + a count badge in the rail | `/fleet/approvals` |
| 4 | **What it costs** | **Own page**, reframed as **Cost & value** | `/fleet/cost`; a one-line spend strip stays on Overview |
| 5 | **Brief** | **Not its own page** — it *is* the Overview | body of `/fleet` |
| 6 | **How it works** | **Not a nav item** — it becomes the teaching layer on every page | "How this works" drawer everywhere + one `/fleet/guide` linked from its footer |

Rationale for the two "no": the Brief is a daily narrative — that is precisely
what a home page is for, and giving it a separate route leaves the Overview an
empty shell. "How it works" as a nav item competes with operational pages for
attention and gets read once; as a drawer available from every header it gets
read whenever someone is confused, which is the moment that matters.

---

## PART 3 — The proposed page map

Ten pages in three groups. The grouping is the point: a beginner should be able
to tell, from the rail alone, which pages *watch*, which pages *build*, and which
pages *restrain*.

```
Agent Fleet                                          /marketing/ads/fleet
│
├── OPERATE  ─ what is happening
│   ├─ Overview        the brief, today's numbers, what needs you    /fleet
│   ├─ Approvals       the blocking queue  ● badge                   /fleet/approvals
│   ├─ Activity        decisions · runs · traces                     /fleet/activity
│   └─ Fleet map       the live canvas, full viewport                /fleet/map
│
├── BUILD  ─ what should happen
│   ├─ Workers         the registry · create · one page per worker   /fleet/workers
│   ├─ Workflows       named routines, canvas editor, versions       /fleet/workflows
│   ├─ Assignments     give a worker a job on a specific thing       /fleet/assignments
│   └─ Files & data    upload, templates, what workers produced      /fleet/files
│
└── GOVERN  ─ what may happen
    ├─ Cost & value    spend, cost per accepted action, ROI          /fleet/cost
    └─ Controls        the 20 controls, trust ladder, audit          /fleet/controls
```

### 1 · Overview — `/fleet`

**Purpose:** the one screen an operator opens each morning and closes two minutes
later, having learned whether anything needs them.

Contents: the Auditor's brief in plain sentences · what needs you (approval count,
expiring approvals, blocked plans) · today's numbers (runs, findings, spend
against ceiling) · a live mini fleet map · last five activity events · next sweep
and next council.

Backend: exists (`/agent/fleet/state`, `/schedule`, timeline routes). Mostly
assembly.

### 2 · Approvals — `/fleet/approvals`

**Purpose:** the blocking queue. Nothing reaches Amazon without passing through
here, so it earns a permanent badge in the rail.

Contents: per-item cards with the dry-run diff, expected effect, critic notes and
blast radius · **accept / edit / reject / ask** (the Agent Inbox four — *edit* is
new) · bulk actions with a server-built blast-radius sentence · the 20-second
parked window and inline undo (AP.4, already shipped) · expiry clocks (AP.5) ·
reject-all-from-worker-X · who decided, and when.

Backend: largely exists after AP.1–AP.5. **Edit-before-approve is new** and is the
single highest-value gap versus the industry.

### 3 · Activity — `/fleet/activity`

**Purpose:** "what has this thing been doing, and why." Two tabs, because
business decisions and technical executions are different questions:

- **Decisions** — the DT.1–DT.3 event stream, grouped by day and episode.
  Filters (worker, kind, outcome, date), export, permalink per event.
- **Runs** — one row per `AgentRun`: mode, worker, duration, tokens, cost, and
  **failure reason**. The DT session found 21 runs failed with `fetch failed` —
  47% of all fleet runs never reached Anthropic. That number has no home today.

Click either into the full step trace (`fleet-trace.service` exists): what it
read → what it thought → what it wrote → what it cost.

Backend: DT.4 (trace) and DT.5 (filters/export) are already scoped and open.

### 4 · Fleet map — `/fleet/map`

**Purpose:** the "how does this all fit together" instrument, and ask #5.

Upgrade from today's read-only picture: full viewport with a collapsible
inspector rail · live run pulses · edge labels carrying artifact volume · **three
overlays** — autonomy (who may act), health (who is failing), cost (who is
expensive) · filter by tier/marketplace/status · click a node → worker page,
click an edge → the artifacts that crossed it · the entity-graph view (already
built) as a second mode.

Boundary against Workflows, stated once: **the map is the whole fleet as it is
now; Workflows are named routines you author.** Airflow's cluster view versus one
DAG.

Backend: `/agent/fleet/graph` exists; overlays need per-node aggregates.

### 5 · Workers — `/fleet/workers` and `/fleet/workers/[key]`

**Purpose:** the registry — the spine every control plane in Part 1B is built on.
We have worker *detail* pages and no roster.

List: one row per worker — tier, autonomy, scope, grade, last run, open findings,
7-day cost, next run. Sort, filter, and **bulk** autonomy/scope changes. This is
the table view of what the map shows as a graph; at 25+ workers the graph stops
being the way to manage them.

Detail (mostly exists from FX.3): who I am · my pipeline · what I read · what I
produce · my limits · report card · charter (with diff and revision A/B from
AC.8) · run history.

**Create a worker** lives here — see Part 4 for what "create" can honestly mean.

Backend: `/agent/fleet/charters`, `/scorecards`, per-worker routes exist. The
roster aggregate is new.

### 6 · Workflows — `/fleet/workflows`

**Purpose:** ask #3 — worker A gathers from B, C and D, compiles, hands to E, and
E acts.

List of named routines, each with: a canvas editor (xyflow, already installed) ·
an explicit **handoff contract** per edge (which artifact type passes, and which
evidence references travel with it) · a trigger (schedule · event · manual · an
assignment arriving) · a **gate policy** per step (auto, or stop and ask) ·
version history with diff and rollback · a "test run" that executes in dry-run
and shows what *would* have happened.

The six run modes that exist in code today (`tick`, `sweep`, `council`, `summit`,
`incident`, `ask`) become the seeded built-in workflows, so the page opens with
working examples rather than a blank canvas.

Backend: **the largest new build.** Needs a stored, versioned workflow definition
and an orchestrator that can execute a stored graph rather than only the
code-declared `FLEET_GRAPH`.

### 7 · Assignments — `/fleet/assignments`

**Purpose:** ask #1, and the thing no existing page can do — point a named worker
at a named thing.

Create an assignment: pick a worker → pick a target (campaign, portfolio, ad
group, ASIN, keyword set, marketplace) → optionally attach a file → set what you
want back ("find wasted spend", "propose bids", "audit structure") → set a
deadline and whether it may act or must propose.

Then watch it move: **New → Running → Produced N findings → Awaiting your
approval → Done** (UiPath's queue-item states, in plain words). Recurring
assignments become triggers. Bulk-create from a selection or an uploaded sheet.

This also gives the existing `ask` run mode a home — **43 of the 45 runs the fleet
has ever done were `ask`**, driven from scripts, with no UI.

Backend: new `AgentAssignment` model + queue semantics. Executor and scoping
already exist.

### 8 · Files & data — `/fleet/files`

**Purpose:** ask #2.

Two directions, and the distinction matters:

- **In** — upload a spreadsheet a worker reads as a constraint or an input: a
  keyword blocklist, target ACoS per portfolio, a product-priority list, a
  competitor ASIN set. Parsed, previewed, column-mapped, versioned, and
  attachable to a worker, a workflow or an assignment.
- **Out** — a worker fills a template and hands back a download; every export the
  fleet has produced, with the run that produced it.

Plus a small **reference tables** area (n8n's Data tables): durable key/value and
tabular facts the fleet may read — the operator's own numbers, not scraped ones.

**Hard boundary:** this is not a second path into Amazon. `/marketing/ads/bulk`
owns bulksheets. A file here constrains reasoning or seeds an assignment; any
resulting change still goes plan → critic → approval → write gate. See Part 5.

Backend: new. File storage, a parser, and a typed reference-data model.

### 9 · Cost & value — `/fleet/cost`

**Purpose:** ServiceNow's lesson — spend alone does not support a decision.

Contents: spend by worker, tier and model · burn-down against the daily ceiling ·
**cost per accepted action** and **cost per euro moved** · which workers pay for
themselves · outcome attribution from the Auditor · and, borrowed from the Value
dashboard, **adoption blockers** — what is stopping a worker being promoted
(insufficient days, grade below B, an open rollback).

Backend: cost per step is already on `AgentStep` via the OTel attributes.
Attribution needs the Auditor to have actually run — it never has.

### 10 · Controls — `/fleet/controls`

**Purpose:** ask #6, in one place. Part 7 of the master brief enumerates 20
controls; they are currently spread across env vars, code constants, the Control
Room and per-worker pages.

Contents: the kill switch and fleet halt · autonomy dials with their caps
explained · scope editors · budgets and token caps · tool policy · the `alwaysAsk`
floor · authority pins · protected terms · the promotion ladder rendered as a
ladder, with each worker's position and what it still owes · demotion history ·
and the **control audit feed** (AC.7's `AgentControlAudit`) — who changed what,
when, and why.

**Boundary against the Control Room:** the Control Room governs deterministic
engines and rules. This page governs agents only. Neither one lists the other's
objects.

Backend: `control-audit.service` and `promotion.service` exist. Assembly plus
some writes.

---

## PART 4 — The tension this creates, and how it resolves

`docs/AGENT_FLEET.md` §3.3 declares the fleet graph **statically declared in
code** and explicitly rejects LangGraph, Temporal, CrewAI and Mastra. Asks #3 and
#4 — edit connections, create workers — appear to contradict that. They do not,
if we split the model in two. This is the same split UiPath makes between
Processes (code) and Jobs/Queues/Triggers (data), and Copilot Studio makes
between connectors (code) and topics (data).

**Layer 1 — capability. Stays in code, never editable from the UI.**
Charter *types*, tool grants, write paths, the observation builders. This is what
keeps law L2 ("agents get zero new write paths") and L3 ("no agent may spawn an
agent") true. A genuinely new *capability* remains an engineering change.

**Layer 2 — composition. Becomes data the operator edits.**
Which workers run, in what order, what artifact crosses each edge, on what
trigger, behind which gate, over what scope, with what budget. Stored, versioned,
and validated against Layer 1 on save — the editor cannot draw an edge whose
artifact type the target worker does not accept, and cannot grant a tool the
charter type does not hold.

So **"create a new worker" honestly means**: instantiate an existing charter type
with a new name, scope, budget, cadence and prompt overlay — for example a
*negative miner scoped to DE only, on a €0.30/day budget, running at 06:00*. That
is a real and useful act of authorship. It is not "invent a worker that can touch
something nothing can touch today", and the UI should say so where a beginner will
read it.

**On "without losing any context":** the brief's law L7 is *the blackboard, not
the mailbox*, and the 15× token multiplier is why. Passing full transcripts
between workers is exactly what makes multi-agent systems both expensive and
worse. What we do instead: each handoff carries a typed artifact **plus resolved
references to the evidence behind it**, and the UI renders the whole chain so a
human can walk backwards from any conclusion to the raw observation. Nothing is
lost that anyone can point to — but it is retrieved on demand, not carried along.
That is a design decision worth making explicitly rather than discovering later
via the bill.

---

## PART 5 — Four things I would get wrong if I did not say them now

1. **The fleet is dark, and mostly untested.** All charters are OFF, **no sweep
   has ever run**, 43 of 45 runs were `ask`, `fleet-auditor` exists but has never
   run, and 47% of runs failed to reach the provider. Ten pages over that produces
   ten empty pages. Phasing below is ordered by *what has data*, not by what is
   most interesting to build.

2. **Files must not become a second write path.** An uploaded sheet that silently
   changed bids would bypass the critic, the blast-radius guard, the approval
   gate and the write gate in one step. Files constrain reasoning and seed
   assignments; they never execute.

3. **Two canvases will confuse a beginner unless the boundary is enforced.** Map =
   the live fleet. Workflows = routines you author. If they drift toward each
   other, merge them rather than shipping two things that look identical and
   behave differently.

4. **Ten rail children is at the top of what stays scannable.** The three-group
   split is what makes it work. If we add an eleventh, something merges first.

---

## PART 6 — Suggested order

Each phase is independently shippable and visibly better.

| Phase | What | Why here |
|---|---|---|
| **SB.0** | Light the fleet: diagnose the 47% `fetch failed`, one charter to OBSERVE, one real sweep | Operator decision 2026-08-07. Every page below is designed against what this produces |
| **SB.2** | Physical route move; components leave `rules-automation/` | Already scoped; blocked only on the parallel session |
| **SB.3** | Split the existing page: Overview · Approvals · Activity · Fleet map | Pure re-housing of shipped, data-backed sections. Immediate clarity, no new backend |
| **SB.4** | Workers registry + create-from-template | The registry is the spine everything else references |
| **SB.5** | Assignments | Ask #1; gives `ask` runs a home; highest operator value per unit of work |
| **SB.6** | Controls | Ask #6; consolidation, mostly assembly |
| **SB.7** | Files & data | Ask #2; new storage, contained blast radius |
| **SB.8** | Workflows canvas + stored graph execution | Ask #3/#4; the largest build, and it wants Layer 2 settled first |
| **SB.9** | Cost & value | Needs the Auditor to have actually run |
| **SB.10** | Evidence/findings browser, evals & report cards | Promote out of worker detail once volume justifies it |

Teaching layer (tooltips, `<Term>`, "How this works" drawer, teaching empty
states) is **not a phase** — it is a condition of done on every page, per FX.4.

---

## PART 7 — Operator decisions (settled 2026-08-07)

1. **Ten pages in three groups — APPROVED.** Operate / Build / Govern as drawn in
   Part 3. Ten is the ceiling; an eleventh page means something merges first.
2. **Light the fleet before building — APPROVED.** One charter on, one real sweep,
   and the 47% `fetch failed` rate diagnosed, *before* SB.3 splits the page. Pages
   built over empty tables lie to us about what they need. This becomes **SB.0**
   and moves to the front of the order in Part 6.
3. **"Create a worker" = a new instance of an existing charter type — APPROVED.**
   New name, scope, budget, cadence and prompt overlay on top of a code-owned
   charter type. No hand-written charters, so no eval gate is required to leave
   OBSERVE. Full prompt authoring is deferred until report cards and charter A/B
   (AC.8) have real data behind them — revisit then, not before.
4. **Naming** — Workers / Workflows / Assignments / Activity / Controls stands
   unless contradicted in build.

---

## Sources

- [n8n interface and 2.0 sidebar](https://docs.n8n.io/) · [n8n features](https://n8n.io/features/)
- [LangSmith platform](https://www.langchain.com/langsmith-platform) · [LangGraph Platform GA](https://www.langchain.com/blog/langgraph-platform-ga) · [Observability in Studio](https://docs.langchain.com/langsmith/observability-studio)
- [LangChain Agent Inbox](https://github.com/langchain-ai/agent-inbox) · [Human-in-the-loop](https://docs.langchain.com/oss/python/langchain/human-in-the-loop)
- [UiPath Orchestrator — Jobs](https://docs.uipath.com/orchestrator/standalone/2023.4/user-guide/jobs-classic-folders) · [Triggers](https://docs.uipath.com/orchestrator/automation-cloud/latest/user-guide/queue-triggers) · [Managing Actions](https://docs.uipath.com/orchestrator/standalone/2020.10/user-guide/managing-actions)
- [Microsoft Agent 365 GA](https://www.microsoft.com/en-us/security/blog/2026/05/01/microsoft-agent-365-now-generally-available-expands-capabilities-and-integrations/) · [Agent registry for Copilot Studio](https://learn.microsoft.com/en-us/microsoft-agent-365/builder/agent-registry)
- [ServiceNow AI Control Tower](https://www.servicenow.com/products/ai-control-tower.html) · [expansion announcement](https://newsroom.servicenow.com/press-releases/details/2026/ServiceNow-expands-AI-Control-Tower-to-discover-observe-govern-secure-and-measure-AI-deployed-across-any-system-in-the-enterprise/default.aspx)
- [Agentforce Testing Center](https://www.salesforce.com/blog/agentforce-testing-center/) · [Spring 2026 release](https://www.salesforce.com/news/stories/spring-2026-product-release-announcement/)
- [Amazon Bedrock AgentCore](https://aws.amazon.com/blogs/aws/introducing-amazon-bedrock-agentcore-securely-deploy-and-operate-ai-agents-at-any-scale/) · [AgentCore observability](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-configure.html)
- [CrewAI traces](https://docs.crewai.com/en/enterprise/features/traces) · [Relevance AI](https://relevanceai.com/docs/get-started/introduction)
- [21 agent orchestration tools (CIO)](https://www.cio.com/article/4138739/21-agent-orchestration-tools-for-managing-your-ai-fleet.html)
