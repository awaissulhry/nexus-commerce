# NAF.SB.M — What sections the Fleet map needs

**Status: SECTION MAP APPROVED by the operator 2026-08-07 (D1, D2, D3 settled — see
Part 4). Per-section studies next. No code written.**

| | |
|---|---|
| **Page** | `/fleet/map` — the Operate group, page 4 of ten |
| **Today** | a `PlannedPage` stub. The real map lives as the top card of the fleet Overview |
| **Parent** | `docs/2026-08-07-naf-sb-fleet-pages.md` Part 3 §4 |
| **Lock** | `docs/2026-08-07-naf-sb-session-locks.md` §2, row **Fleet map (`SB.M`)** |
| **Owns** | `app/fleet/map/**`, `agent-fleet-map.routes.ts` (new), `fleet-map*.service.ts` (new), `_sbm-*.mts` |
| **Does not touch** | `rules-automation/fleet/FleetMapCanvas.tsx`, `EntityGraphCanvas.tsx`, `FleetTab.tsx` — the Overview still renders them |

---

## PART 0 — The one sentence, and the nine boundaries

> **The map is the fleet as it actually is, right now, on one canvas: who reads
> what, who hands work to whom, who is allowed to act, and what is running.**

Ten pages means the hardest design work is *refusing* things. Every section
below had to survive this table before it earned a place.

| The map does NOT own | Which page does | The map's link out |
|---|---|---|
| Managing workers — dials, bulk actions, create | **Workers** | node → `/fleet/workers/[key]` |
| Authoring wiring — draft, publish, versions, revert | **Workflows** | edge → the routine that declares it |
| Run history, traces, step-by-step | **Activity** | node → runs filtered to that worker |
| The approval queue and its decisions | **Approvals** | node badge → that worker's waiting items |
| Spend analysis, ROI, cost per accepted action | **Cost & value** | overlay legend → the full breakdown |
| The 20 controls, kill switch, trust ladder | **Controls** | halt banner → the control that caused it |
| The daily narrative and "what needs you" | **Overview** | Overview keeps a mini-map that links here |
| Pointing a worker at one campaign | **Assignments** | — |
| Uploaded files and reference tables | **Files & data** | — |

**The rule that makes this hold:** *the map shows state and ends in links; it
never edits.* Every affordance on this page either changes what you are
**looking at** (filter, overlay, focus, select) or **navigates**. Nothing on the
map writes. That is also the cheapest possible answer to the spend audit — three
control paths bypass the autonomy dial and can spend on a dark fleet, and a
read-only map inherits none of them.

---

## PART 1 — What is true today, measured

### 1.1 · Three things the current map states that are not true

These are defects, not opinions. All three are on prod right now.

1. **The edge labels are invented.** `FleetTab.tsx:430-440` labels a `finding`
   edge with *the source worker's open-findings count* and the director→critic
   `plan` edge with `plans.length` — every plan that has ever existed. The
   canvas reads "7 findings crossed here". Nothing has ever crossed: there have
   been **0 sweeps, ever**, and the director has authored one plan.
2. **"running" contradicts the graph it sits above.** The header pill is green
   and reads `running` while all seven nodes read `OFF`. It means *not halted*.
   A beginner reads it as *working*.
3. **Clicking a worker goes to a pre-move address** —
   `/marketing/ads/rules-automation/fleet/worker/[key]` (`FleetTab.tsx:628`),
   not `/fleet/workers/[key]`.

### 1.2 · The premise has moved under the map — and nobody has noticed yet

`/agent/fleet/graph` returns `FLEET_GRAPH`, the static 7-node code constant.
**Since WF.4a that is no longer what runs.** `orchestrator.ts:198-227` resolves
the *effective* definition — the active stored revision if there is one, the
code graph only as a fallback — and walks that. WF.6a then added **custom
workflows**, which can wire workers in shapes `FLEET_GRAPH` never declares.

So the page whose entire claim is *"this is the fleet as it is"* is drawing a
constant that the executor may already be ignoring. This is the single most
important finding in this study, it is a **cross-session coupling with the
Workflows stream**, and it is why §M2 below draws *effective* wiring rather than
code wiring. It is also raised as decision **D1** in Part 4.

### 1.3 · The census — what a map over this fleet would actually show

| Thing | Reality | Source |
|---|---|---|
| Nodes / edges | **7 / 4.** Three analysts → director → critic; `fleet-selftest` edge-free; `fleet-auditor` standalone and floating | `fleet-graph.ts:31-47` |
| Charters ON | **0 of 7** | operator constraint |
| Sweep runs by a worker | **0** — but ⚠ **the nightly sweep itself runs every night**, gated on `NEXUS_ENABLE_FLEET_SWEEP_CRON`, which is set on prod. It fired 2026-08-07 04:45 and recorded `started=6 ok=0 failed=0 skipped=6 … cost=$0.0000`: every charter was *skipped* because every dial is OFF. What is zero is `AgentRun` rows with `mode='sweep'`, not the job. **Corrected 2026-08-07 after the evidence pass — the first draft of this table said "0 sweeps ever", which is false and would have shipped a wrong empty state.** | `naf-sbw-spend-audit.md:41-55` |
| Runs ever | **53** — measured by the M.1a endpoint 2026-08-07. The docs said 47; the fleet has run since | `_sbm-map-check.mts` |
| Runs not-ok | **26** — 21 provider-unreachable, 3 provider-refused, 1 contract, 1 limit | `naf-sbw-section-studies.md:193-203` |
| Open findings | **64**, of which `fleet-selftest` holds **47** — ⚠ and **all 47 are past their expiry date**, which no surface currently says | measured |
| Spend, lifetime | **≈ $0.65** across the workers; $0.2773 spent today against the $2.00 ceiling | measured |
| Approvals from the fleet | **0** — and none can be created: all three propose-tools are preview-only, so `runOrQueueTool` returns `mode:'preview'` and writes no row (locks doc §5 decision 8) | `naf-ap-approval-inbox.md:43` |
| Artifacts that crossed an edge | ⚠ **15, not 0** — 7 from the negative miner, 4 from the harvester, 4 from the bid tuner, all carried into the director's plan; plus 2 dropped with written reasons and 2 conflicts. The director→critic edge carries one `block` verdict. **Corrected 2026-08-07 by measurement: the first draft asserted the edge overlay would be empty everywhere, and it is not.** | measured |
| Enabled workflows | **4** — `fleet-sweep`, `fleet-council`, `on-demand-check` (all built-in/code) and ⚠ **`morning-negatives-pass`, a CUSTOM workflow running a PUBLISHED REVISION**. So D1 was never hypothetical: wiring that `FLEET_GRAPH` does not contain is already live | measured |

**Read that column honestly and the page designs itself.** Of the three
overlays the parent doc promised:

- **Autonomy is fully populated** — real dials, real caps, real scopes, on all seven.
- **Health is populated but skewed** — 39 of 53 runs and 47 of 64 findings belong to one *diagnostic* worker, and 21 of 26 failures are one network fault, not seven broken workers.
- **Cost is small but real on six of seven nodes** — the director alone has spent $0.3867. Only `fleet-auditor` is at zero, because it has never run.
- **Edge volume is real** — 15 findings have crossed into a plan, with 2 dropped and their reasons written out. ⚠ **Both of the last two bullets said the opposite before M.1a measured them.** The design survived; the pessimism about the data did not, and it would have shipped empty states over populated overlays.

A map that paints three overlays over that and says nothing about it is a
brochure. Every section below therefore carries a designed *absence* state, and
§M1 exists specifically so the absence is the first thing you read.

### 1.4 · What the toolkit permits

- **`@xyflow/react` 12.11.1**, already installed, used by 7 canvases. `Panel`, `MiniMap` customisation, `useReactFlow`, `EdgeLabelRenderer`, `NodeToolbar`, `useStore` are all **unused in this repo** — greenfield, no house style to copy.
- **No layout library is installed** — no dagre, no elkjs, no d3-hierarchy. Every canvas here hand-computes columns and says so in its header. **Decision: keep that.** Seven nodes in four tiers do not need a 40 KB dependency, and a hand-computed layered layout is deterministic by construction, which is exactly the property the map needs (Part 3 §M2). Revisit past ~25 nodes.
- **The DS ratchet's fleet baseline is `select 0 / date 0 / fontSize 0 / hex 0`** and it scans the **working tree**, so one violation under `app/fleet` blocks *every* concurrent session's push — this already happened once (§5b of the locks doc). The trap for a canvas: the guard matches `style={{…#hex}}` in JSX. The existing `FleetMapCanvas` sets edge colours as `style: { stroke: '#1f6fde' }` inside a JS object, which does not match — but it lives in an allowlisted tree anyway. **Under `app/fleet` every canvas colour must come from a CSS class, not a JSX `style` attribute.**
- **Full viewport is unprecedented here.** Every xyflow host in the repo is a fixed pixel box (320/400/520/540/560px). Measured on prod: viewport 1728×906, rail reserve 66px, the scroll host is `main.flex-1.overflow-auto` with a 24px-padded child, and `.fleet-surface` already cancels that gutter and sets `min-height:100dvh`. So the budget is a real 100dvh on desktop — but a mobile top bar (48px) or a live DLQ banner eats into it, so the canvas must be `min-height:0` flex, never a hard `calc(100vh - …)`.
- **`a11y.css` is imported by no fleet page.** It carries the `prefers-reduced-motion` neutraliser. An animated canvas that does not handle reduced motion itself would ship without any escape.

---

## PART 2 — What the industry does, in one page

Four teardowns: live topology instruments (Datadog, Kiali, Grafana Node Graph,
X-Ray/CloudWatch, New Relic, Dynatrace, Splunk ITSI, Neo4j Bloom), agent and
workflow graphs (Airflow 3, Dagster, Temporal, Camunda Operate, n8n, LangGraph
Studio, Copilot Studio Agent Map, Kestra, Gumloop), graph-readability research
(Sugiyama layout, Misue/Eades mental-map preservation, Ghoniem/Fekete matrix-vs-
node-link, Heer & Robertson staged transitions, WCAG 1.4.1/1.4.11/2.2.2/2.3.3),
and the React Flow v12 API.

The findings that actually changed this design:

1. **One canvas, never two screens.** Airflow, Camunda, Kestra and Dagster all draw one graph and *paint* run state onto it. Two screens force the reader to re-learn the topology twice.
2. **Layout is a function of topology, never of state.** Grafana defaults to layered and reserves force-directed for 500+ nodes; Misue/Eades is the underlying result. Re-running layout on a status poll is the defect that makes live graphs unusable.
3. **Ring = health, body = identity, badge = fact.** Nobody good encodes two things in fill colour. Colour is never the only channel — WCAG 1.4.1 is a Level A failure, and Temporal's `dashed = unsettled, solid = settled` grammar survives greyscale.
4. **Grey for deliberately-off, never red** (Splunk ITSI greys disabled services and suppresses their degradation badges). **Dashed for never-reported, with a call to action** (CloudWatch and New Relic both refuse to hide the coverage gap).
5. **The edge is a first-class object with its own measurement.** X-Ray's edge histogram includes latency the node histogram excludes; Kiali switches edge labels between rate, p95 and distribution. An edge you cannot click throws away half the graph.
6. **The inspector is a docked rail, never a popover, never a route change** — Camunda explicitly *reversed* its popover because it occluded the graph the operator was reasoning about.
7. **Declared vs observed, distinguished.** Datadog's "Include Detected" toggle renders manual dependencies above auto-detected ones. This is exactly our §1.2 problem.
8. **At ~10 nodes a sortable list beats a graph for most questions.** Ghoniem/Fekete puts the crossover near 20 vertices, and only *path finding* consistently favours node-link. Grafana ships a Grid layout that throws the edges away.
9. **A status summary above the canvas, so the graph never has to be scanned to answer "is anything wrong".**
10. **Every panel ends in links**, with the filter pre-populated. A topology view that cannot hand off to the run list and the config is a poster.

And the anti-patterns worth naming because we would otherwise walk into them:
force layout on a small graph · re-centring the viewport on selection · deleting
nodes on filter instead of dimming · always-on edge animation · hover-only
legends · an undefined number on an edge · red for a thing you switched off
yourself · a spinner as the empty state when the empty state *is* the product.

---

## PART 3 — The sections

Nine. A full-viewport instrument does not have stacked cards, so "section" here
means *a region of the page with one job*. Regions M1–M4 are on screen at once;
M5–M6 are modes; M7–M9 are cross-cutting.

```
┌─ M1 · Census strip ─────────────────────────────────── M7 window · as-of ─┐
├───────────────┬───────────────────────────────────────┬───────────────────┤
│ M3 · Overlay  │                                       │ M4 · Inspector    │
│    + legend   │        M2 · The canvas                │    rail           │
│    + filters  │        (M5 · List is this pane's      │                   │
│               │         other rendering)              │                   │
├───────────────┴───────────────────────────────────────┴───────────────────┤
│ M6 · Mode: Workers ⇄ Entities      M8 · How this map works                │
└───────────────────────────────────────────────────────────────────────────┘
```

---

### M1 · Census strip — "is anything wrong, and is anything even on?"

**Purpose.** Answer the most frequent question *before* the graph is read. This
is the section that repairs defect §1.1.2: a green `running` pill above seven
`OFF` nodes.

**Contents.** One line of counted chips over the current window:
`7 workers · 0 running · 7 off · 5 never run · 2 failed last run · 0 waiting on you`
plus the fleet-halt state when halted (with *who* halted it and *why*), and a
spend-against-ceiling figure. Every chip is a **filter** that dims non-matching
nodes rather than removing them, and every chip has a tooltip defining exactly
what it counts.

**Why it is not a duplicate.** Overview owns the *narrative* ("here is your
morning"); this owns the *census of what is on the canvas*, and each number is a
lens onto the graph beside it. Neither works on the other's page.

**Needs.** `state` + per-node status from the map endpoint (§M9).
**Real-time.** Recomputed each poll; the counts change, nothing moves.

---

### M2 · The canvas — the instrument

**Purpose.** The picture that makes the fleet's shape and state legible at a
glance, and traceable by hand: what feeds what, who may act, who is failing.

**Contents, and the six rules that govern them:**

1. **Layout is derived from topology and cached on a hash of it.** Layered, left-to-right, rank = artifact-dependency depth, hand-computed. Positions are pinned. A poll that flips a worker to *running* or adds three findings **repaints in place and never re-lays-out**. Node and edge arrays are sorted by key before layout so the drawing is byte-identical every mount.
2. **Node encoding: identity in the body, status in the ring, facts in badges.** Body = name, tier, model — never re-coloured. Ring = one state from a single published enum (`off · never-run · idle · running · failed · degraded · blocked-on-approval`). Facts = small badges (open findings, cost, budget-capped, paused, waiting on you). **Status is carried by ring + glyph + the literal word, with colour as the fourth, redundant cue.**
3. **Off is grey with a pause badge. Never-run is a dashed neutral outline reading "not yet run".** Neither is red, and never-run is *not dimmed* — absence of data is not an error, and dimming it hides the coverage gap that is usually the actual finding. ⚠ **Corrected 2026-08-07:** the first draft justified this with "five of seven workers have never run", which is **false**. The measured truth is that `fleet-selftest` has 38 runs and every other worker has run between 1 and 4 times (`naf-sbw-workers-page.md:108-109`) — **only `fleet-auditor` has never run**, which the prod canvas confirms. The rule survives; its stated evidence did not, and this is exactly the kind of number that must be re-measured before M.1 rather than inherited from a design sketch.
4. **Edges are honest or they are dashed.** A declared edge that has never carried an artifact is dashed and unlabelled. A solid edge carries a count with a defined meaning, computed from `AgentPlan.items[].findingId` resolved to the producing worker — the join `scorecard.service.ts:178-190` already runs in production. **`AgentFinding.planId` exists and is indexed but is never written** (`agent-executor.ts:568-616`), so full lineage is unavailable; the plan-items join is the honest substitute and the tooltip says so. The director→critic edge gets **no volume at all** — the critic mutates the plan row in place, so there is no second artifact to count; it carries the verdict instead.
5. **Motion is earned.** A pulse only while a run is genuinely in flight (`status='running'` on a `mode NOT NULL` row). Nothing animates on an idle fleet. `prefers-reduced-motion` kills ambient motion and replaces it with a static badge, plus a persisted in-app toggle, because a perpetually flowing edge is auto-motion past 5 seconds (WCAG 2.2.2).
6. **Interaction: single-click selects (M4). Double-click zooms to that worker and its neighbours. Hover/focus highlights the whole reachable subgraph — upstream one tone, downstream another — and dims the rest to ~25%.** Arrow keys **traverse** the graph (left = upstream, right = downstream) rather than moving nodes, tab order is topological, and every node carries an aria-label naming its own topology.

**The wiring question (§1.2), resolved here:** the canvas draws the **effective**
wiring, and styles each edge by where it came from — *code default*, *published
revision*, or *custom workflow*. An edge the executor would actually walk and an
edge that exists only in `fleet-graph.ts` must not look identical. See D1.

**Needs.** §M9. Plus agreement with the Workflows stream on the wiring source.

---

### M3 · Overlay control, legend and filters — the left rail

**Purpose.** One graph, three questions, and a legend that cannot drift from the
graph because both render from the same enum.

**Contents.** *Colour by:* **Autonomy** (who may act) · **Health** (who is
failing) · **Cost** (who is expensive) — the three the parent doc named.
Always-visible legend as real DOM text, every entry carrying its glyph *and* its
word, written in operator language ("Failed — the last run ended in an error").
Filters: tier, workflow, diagnostic-or-business, and a Highlight/Hide pair.
**Filtering dims; it never re-lays-out.**

**The honesty rule this section exists to enforce:** when an overlay has no data
— Cost on a fleet that has spent $0.38 in its life — the node is **hatched with
a legend entry reading "no data — never run"**, never given the bottom colour of
the scale. Kiali documents exactly this for response-time edges; it is the
difference between "cheap" and "unmeasured".

**Why it is not a duplicate.** The *dial* lives on Workers and Controls; here
autonomy is a read-only tint. The *spend breakdown* lives on Cost & value; here
cost is a tint and one number per node.

---

### M4 · Inspector rail — what you selected, without leaving the map

**Purpose.** Camunda's lesson: dock it, never float it over the thing being
reasoned about. Three states, one rail, graph never moves.

| Selection | What the rail shows |
|---|---|
| **Nothing** (default) | The fleet roll-up: all seven workers listed with status, last run, open findings, 7-day cost — sortable. This doubles as M5's list. |
| **A worker** | Identity · autonomy + cap + why it is capped · scope · limits · last runs with outcomes · cost · open findings by severity · **who feeds me / who I feed** · and the exits |
| **An edge** | The handoff: which artifact type crosses, how many crossed and *how that is counted*, what the director **dropped and why** (`AgentPlan.droppedItems` requires a reason), conflicts, and the last artifacts that crossed |

**The edge panel is the section with no equivalent anywhere else in the ten
pages.** "The director considered 11 findings and carried 4" is a fact no roster,
timeline or cost page can express, and it comes free from a JSON column we
already write.

**Exits, always, never dead text:** open the worker · open its runs in Activity ·
open its findings · open the routine that declares this edge · open its waiting
approvals. Escape clears the selection back to the roll-up.

**Needs.** §M9 for the rollup; existing endpoints for everything behind a link.

---

### M5 · List view — the same graph as a table

**Purpose.** Two obligations discharged by one control. (a) WCAG 1.1.1: the text
alternative for a complex node-link diagram is a real table in the DOM, not an
`aria-label` on a canvas. (b) At seven nodes, ranking questions — *who failed,
who costs most* — are answered better by a sortable list than by a picture.

**Contents.** Node · tier · status · last run · open findings · 7-day cost ·
**upstream** · **downstream**. Selection and URL are shared with the map, so
`?worker=amazon-bid-tuner` selects in both.

**The duplication risk, named and resolved.** The Workers page *is* a roster
table. This is not that: this table's reason to exist is the **adjacency
columns** — the graph, spelled out — and it carries **no dials, no bulk actions,
no create**. If it ever grows a management affordance it should be deleted and
this page should link to Workers instead. Recorded here so the next session can
hold me to it.

---

### M6 · Second mode — the entity graph

**Purpose.** A different node universe: not the workers, but **the things the
workers reason about** — campaigns, products, and the relations the fleet
derived between them.

**Contents.** The existing `/agent/fleet/entity-graph` (overview and focused
neighbourhood, p95 ≈ 22 ms, ~5,900 derived edges of which the legible
campaign↔campaign layer is 96 over 37 campaigns). Same shell, same inspector,
same legend grammar.

**What it needs that it does not have.** Verified on prod: at fit-view the card
labels are **unreadable** — the whole point of the view is lost. It needs
semantic zoom (three discrete tiers, not a continuous scale), a focus/back
breadcrumb, and a stated cap when truncated.

**Why here rather than its own page.** Ten pages is the ceiling the operator set;
an eleventh means something merges. It is the same *interaction* over a
different *universe*, so it costs one segmented control and no new concepts —
but see **D2**: it is also the section I would cut first if the map is too much.

---

### M7 · Time window — what "now" means

**Purpose.** Every count on the page needs a denominator, and the map must say
what it is.

**Contents.** A window selector (24 h · 7 d · 30 d · all time) that **every**
overlay, count and edge label honours, an "as of" stamp from the last successful
read, and a minimum-window rule so a 100% failure rate is never derived from one
run (Splunk ITSI enforces exactly this and it is why).

**Explicitly deferred:** *replay a past run on the canvas*. It is the highest-
value affordance in the whole survey and it has nothing to replay — 0 sweeps, 47
runs. It goes in the backlog with the reason recorded, not into phase 1.

---

### M8 · The teaching layer — a condition of done, not a phase

**Purpose.** FX.4's rule, on a page whose whole vocabulary is new.

**Contents.** A "How this map works" drawer in the house pattern (hand-rolled
collapsible, no tour library) · a tooltip on every count that **defines what it
counts** ("artifacts this worker's findings contributed to the director's plan;
a finding the director dropped is counted separately") · `<Term>` for new
vocabulary, appended one term per commit to the shared, append-only glossary
(candidates: *overlay*, *artifact*, *handoff*, *declared vs observed*, *effective
wiring*) · and the teaching empty state as the **default** state of this page,
because a fleet that has never run is what this map will show for some time.

**One trap already found:** `<Term>`'s tooltip is a CSS-only absolutely
positioned bubble at `z-index 40`, and every canvas wrapper in this repo sets
`overflow: hidden`. A `<Term>` inside the canvas **will be clipped**. Anything
teaching *on* the canvas must be portalled or live in the rails.

---

### M9 · One map endpoint — the section with no pixels

**Purpose.** Stop deriving the map in the browser.

Today `openByKey`, `runInfoByKey`, `edgeCounts` and `findingsByKey` are
`useMemo`s over `runs?limit=60` and `findings?limit=60`, so "12 open" means
"12 within the last 60 rows fetched". `/agent/fleet/graph` returns tier +
enabled + autonomy + degraded and nothing else.

**Contents.** `GET /api/agent/fleet/map?window=7d` in a new
`agent-fleet-map.routes.ts` — fleet state, schedule, per-node autonomy / health /
findings / plans / approvals / cost / scorecard, per-edge counts with an explicit
`lineage` field naming how they were counted, and totals. One call, three
overlays.

**The coupling worth stating now:** the Workers page needs the same per-worker
rollup and deliberately did not build it — `WorkersClient.tsx:296-302` carries a
signed comment saying it belongs in the API. **This endpoint should serve both
pages**, and the failure classifier (`_shared/run-health.ts`) should move to a
shared module rather than be reimplemented server-side, or the map and the roster
will eventually disagree about what "failed" means.

---

## PART 4 — Decisions I need from you

| # | Decision | Outcome |
|---|---|---|
| **D1** | **What does the map draw — the code graph, or what the executor would actually walk?** Since WF.4a the sweep walks the stored definition, and custom workflows can wire workers `FLEET_GRAPH` never declares. | **SETTLED 2026-08-07 — effective wiring, union of enabled workflows.** Edges styled by source (code default / published revision / custom) with a per-workflow filter. Anything else means the map lies the first time a revision is published. **Still needs the Workflows stream's read path** — raised as decision 6 in the locks doc and sent to both live sessions; no code until they answer. |
| **D2** | **Does the entity graph belong on this page?** | **SETTLED 2026-08-07 — second mode on this page** (M6). Same interaction over a different universe; an eleventh page would break the ten-page ceiling. Carries the legibility fix as part of its scope. |
| **D3** | **Read-only, or does the map get a "Run once" on a never-run worker?** | **SETTLED 2026-08-07 — read-only, links out.** The map never writes. A never-run node's call to action is a link to the worker page, not a trigger. Inherits none of the spend-audit obligations. |
| **D4** | **Is the list view (M5) worth it, given Workers exists?** | **Proceeding on the recommendation: yes** — it is the accessibility text alternative and it answers ranking questions the graph answers badly. Constrained to adjacency columns and zero management affordances. Say so if you disagree; it is cheap to drop. |
| **D5** | **Fix the dead edge lineage?** One statement at `agent-executor.ts:648` would set `planId` on the findings a plan names, making the column that already exists and is already indexed actually work. | **Deferred, and proposed separately** — it is a write on the shared execution path. Until then the plan-items join is exact for what the director kept, and the tooltip says so. |

---

## PART 5 — Cross-session couplings

| With | What | Status |
|---|---|---|
| **Workflows (`SB.8`)** | D1 — the effective wiring the map draws. Also: an edge's "which routine declares this" link. | **Raised, not agreed.** Nothing is built until their stream reviews it, per the §4 protocol. |
| **Workers (`SB.W`)** | M9 — one per-worker rollup endpoint serving both pages, and moving `classifyFailure` / `deriveStatus` somewhere both can import. | To propose. Their own comment already asks for it. |
| **Overview** | The mini-map thumbnail, and the eventual move of `FleetMapCanvas.tsx` out of `rules-automation/`. **Their move, not mine** — I build a new canvas and leave theirs alone. | Declared in the lock table. |
| **Activity** | Every "open the runs for this" link lands on their filters. | Link contract only. |
| **Glossary** | New terms, appended one per commit to a shared append-only file. | Protocol already exists. |

---

## PART 6 — Suggested order

Each step is shippable and visibly better than the one before.

| Step | What | Why here |
|---|---|---|
| **M.1** | The endpoint (§M9) + the census strip (§M1) + the canvas drawing **honest** edges and honest empty states | Kills all three §1.1 defects and stops the browser-side derivation. The page is truthful before it is pretty. |
| **M.2** | Full-viewport shell, deterministic layout, node encoding, keyboard traversal, reduced motion | The instrument. |
| **M.3** | Inspector rail (§M4), all three selection states | Where the map stops being a picture. |
| **M.4** | Overlays + legend + filters (§M3) | Needs M.1's aggregates and M.2's encoding to exist first. |
| **M.5** | List view (§M5) + URL/deep-link + teaching layer (§M8) | Accessibility and shareability, together. |
| **M.6** | Entity graph mode (§M6) with the legibility fix | Independent; can slip without blocking anything. |
| **M.7** | Window selector (§M7) | Cheap; wants real data to be worth anything. |
| *later* | Replay a run · declared-vs-observed drift warnings · `planId` lineage fix (D5) | All blocked on the fleet actually running. |

---

## Sources

Repo evidence is cited inline as `file:line`. External research:

- Datadog [Service Map](https://docs.datadoghq.com/tracing/services/services_map/) · [Software Catalog dependencies](https://docs.datadoghq.com/software_catalog/)
- Kiali [graph concepts](https://kiali.io/docs/features/topology/) — find/hide, replay, edge labels, traffic animation
- Grafana [Node Graph panel](https://grafana.com/docs/grafana/latest/panels-visualizations/visualizations/node-graph/) — layered vs force, arcs, grid layout, hidden-node markers
- AWS [X-Ray service map](https://docs.aws.amazon.com/xray/latest/devguide/xray-console-servicemap.html) · [CloudWatch Application Signals](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Application-Monitoring-Sections.html)
- New Relic [service maps](https://docs.newrelic.com/docs/new-relic-solutions/new-relic-one/ui-data/service-maps/) · Dynatrace Smartscape · Splunk ITSI service topology · Neo4j Bloom
- Apache [Airflow 3 UI](https://airflow.apache.org/docs/apache-airflow/stable/ui.html) — one graph, run overlay, `STATE_COLORS` legend
- [Dagster asset lineage](https://docs.dagster.io/concepts/webserver/ui) — facets, collapsible groups · [Temporal Web UI](https://docs.temporal.io/web-ui) — dashed = unsettled · [Camunda Operate](https://docs.camunda.io/docs/components/operate/userguide/) — token badges, popover→drawer reversal
- [n8n canvas & executions](https://docs.n8n.io/) — item counts on connections, pinned data · [LangGraph Studio](https://docs.langchain.com/langsmith/observability-studio) — interrupt, edit state, fork · Microsoft Copilot Studio Agent Map — weighted connection lines
- Graph craft: Sugiyama layered layout · Misue & Eades, mental-map preservation · Ghoniem, Fekete & Castagliola, matrix vs node-link · Heer & Robertson, animated transitions · Huang, crossing angles
- WCAG [1.4.1 Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html) · [1.4.11 Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) · [2.2.2 Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html) · [2.3.3 Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html)
- [React Flow v12](https://reactflow.dev/learn) — `Panel`, contextual zoom via `useStore`, `fitView`, a11y config, layouting examples
