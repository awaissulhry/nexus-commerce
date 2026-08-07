# NAF.FX — Fleet Experience: making the Agent Fleet legible to a beginner

**Status: PROPOSAL — awaiting operator approval. No code.**
Trigger: operator review of the shipped fleet page (2026-08-06): "the decision
timeline is hard to read… how do I know what each worker is going through?…
best in class… even a beginner can understand what's happening."

The diagnosis in one sentence: **the page shows the fleet's DATA but not its
STORY** — it was built as an engineer's console (IDs, JSON, jargon, dense
paragraphs), and every fix below is a variation on translating machine truth
into operator language without losing the machine truth underneath.

---

## 1 · Honest defect inventory (what's wrong today, panel by panel)

Verified against the live page and the code that renders it.

**Decision timeline (the acute pain)**
- D1. Items read `#1 create-negative-keyword — finding cmshk7pbx0010pc01kzpaxw0d`.
  A finding ID means nothing to anyone; even to an engineer it's a DB lookup.
- D2. Campaigns appear as external IDs (`218394170642485`), never names.
- D3. The director's narrative is one unbroken ~200-word paragraph; the critic
  summary is another. Nobody reads walls of text in a console.
- D4. Critic checks surface by their internal keys (`no_double_counting`,
  `blast_radius_ok`) with no explanation of what the check protects against.
- D5. The blast radius — the thing that actually blocked plan #1 — is stored
  as JSON and never rendered at all.
- D6. The header promises "finding → plan → critic → approval" but the UI is
  a flat expandable row, not a flow. A beginner cannot see WHERE in the
  pipeline a plan is, or what happens next.
- D7. Args render as raw JSON (`{"scope":"CAMPAIGN","matchType":...}`).

**Workers (the second acute pain)**
- W1. A worker's entire identity is one description sentence in a drawer.
  Nothing answers: what do you read? what steps do you run? what do you
  produce? what are you not allowed to do? how good are you?
- W2. The step trace reads `observation:negative-candidates (89ms)` —
  engineer speak; and there's no way to see the evidence the agent actually
  read or the output it actually wrote.
- W3. Scorecards (E1) and shadow grades (B) are computed nightly and stored —
  and surfaced NOWHERE. The report card exists; the UI never shows it.
- W4. The charter (the agent's job description — its system prompt, versioned)
  is the single most explanatory artifact in the system and is invisible.
- W5. No per-worker findings feed ("what has this agent found lately").

**Everything else**
- G1. Zero tooltips. OBSERVE/PROPOSE/AUTO, "degraded", severity, confidence,
  dedupe, "critiqued", shadow agreement — all unexplained jargon.
- G2. The map is static: no last-run status, no "next sweep in 6h 12m", no
  running pulse, no artifact counts on edges, and the self-test's "43 open"
  counts internal health findings with the same weight as ad findings.
- G3. Inbox previews fall back to raw JSON; no link back to the evidence; no
  "what will actually happen if I click approve"; no "why am I being asked".
- G4. Cost ledger is a bare table; no trend vs the $2 ceiling; grades absent.
- G5. No loading skeletons, no auto-refresh, no teaching empty states, no
  onboarding, minimal a11y, untested narrow-viewport behavior.
- G6. **API gap underlying most of the above:** the fleet endpoints return raw
  rows — IDs not names, no run-trace endpoint (evidence + model output), no
  scorecards endpoint, no schedule/next-run endpoint. Beginner-legible copy
  cannot be built client-side from IDs.

---

## 2 · Research notes (what best-in-class does)

- **Trace-as-story, three depths.** The strongest agent-observability UIs
  (LangSmith, Langfuse) render a run as a step-by-step graph — plan, tool
  call, model call, retry, output — with progressive disclosure from a
  one-line summary down to raw payloads. Depth 1: a sentence. Depth 2: a
  card. Depth 3: the JSON. Never JSON first.
- **Approval UX is its own discipline.** The human-in-the-loop literature is
  unambiguous: reviewers must see *cost, visibility, permanence, and affected
  systems in plain language*; the button must name the actual effect (never a
  vague "Approve"); and the UI must explain *why approval is required now* —
  which rule or threshold paused it — or review degrades into rubber-stamping.
  Annotation-queue layouts (scan → compare → decide without holding state in
  memory) outperform generic lists.
- **We already speak the right wire format.** AgentStep carries OpenTelemetry
  GenAI-shaped attributes (model, tokens, operation) — the substrate for a
  proper trace view exists; it's purely a rendering gap.
- **Glossary as a system, not scattered strings.** Best-in-class consoles
  centralize term definitions and render them via one hover/tap primitive, so
  a term is defined once and explained identically everywhere.

Sources: [Latitude — observability tools 2026](https://latitude.so/blog/best-ai-agent-observability-tools-2026-comparison) ·
[Confident AI comparison](https://www.confident-ai.com/knowledge-base/compare/best-ai-agent-observability-tools-2026) ·
[MLflow — top agent observability tools](https://mlflow.org/top-5-agent-observability-tools/) ·
[AufaitUX — human-in-the-loop UX](https://www.aufaitux.com/blog/human-in-the-loop-ux/) ·
[StackAI — approval workflow design](https://www.stackai.com/insights/human-in-the-loop-ai-agents-how-to-design-approval-workflows-for-safe-and-scalable-automation) ·
[Edilec — what reviewers must see](https://edilec.com/blog/ai-11018/approval-screens-high-risk-agent-actions/) ·
[Agentic Design — UI/UX patterns](https://agentic-design.ai/patterns/ui-ux-patterns)

---

## 3 · The design contract (rules every FX phase obeys)

1. **Sentence → card → JSON.** Every artifact renders as a plain-English
   sentence first; a card with named entities second; raw data third, behind
   an explicit "raw" disclosure. JSON never appears at depth 1 or 2.
2. **Names, never IDs.** If the UI shows `cmshk…` or `218394…`, that's a bug.
   Resolution happens server-side (FX.1), not by hand in components.
3. **Every term teaches itself.** Any word a beginner wouldn't know carries a
   `<Term>` tooltip fed from one glossary registry. Adding jargon without a
   glossary entry fails review.
4. **Buttons name their effect.** "Add this negative keyword", "Reject all 9
   from the Director" — never bare "Approve"/"Confirm".
5. **Honesty survives the translation.** Plain language never rounds a block
   into a warning or an unknown into a zero. The existing money/verdict
   honesty rules stay law.
6. **The machine truth stays reachable.** Every pretty view links to the raw
   row (run id, step trace, JSON) for the day the operator becomes the
   engineer.

---

## 4 · Phases

Ordered so each phase is independently shippable and visibly better; FX.1 is
the foundation the rest stand on.

### FX.1 — Names, not IDs (API foundation) — apps/api
- Extend the fleet read endpoints to resolve entities server-side:
  plans/approvals/findings gain `entityLabel`s (campaign NAME + marketplace,
  keyword text, product title) alongside the ids.
- New `GET /agent/fleet/runs/:id/trace` — the full story of one run: steps
  with plain labels, the observation payload it read (truncated + sampled),
  the validated output it wrote, tokens/cost per step (the OTel attributes).
- New `GET /agent/fleet/scorecards?charterKey=` — E1's nightly rows, plus the
  current grade and what it means.
- New `GET /agent/fleet/schedule` — next sweep / next council fire times
  (parsed from the cron registry), last CronRun result per job.
- Acceptance: no fleet UI surface needs a client-side ID→name join; tests per
  endpoint; RBAC check green.

### FX.2 — The decision timeline becomes a story — apps/web
- Each plan renders as a **pipeline stepper**: `Analysts found 17 things →
  Director chose 15 → Critic said BLOCK → Nothing queued` — four stages, the
  current stage highlighted, each stage expandable.
- Per-item **action cards**: "Add negative keyword **'homologué'** to
  **XAVIA DE Broad (DE)** — stops €80 of clicks that never bought" with a
  verdict chip (queued / blocked: already exists / blocked by critic) and the
  reason in words. Grouped by verdict so the eye finds the blocks first.
- The critic's 12 checks render as a **checklist** — pass/fail/n-a icons, each
  with a one-line plain-language template (e.g. *no_double_counting → "Is
  anything here already done? 9 items already exist in the account"*) and the
  offending items linked.
- Blast radius rendered as a sentence: "This plan touches 6 campaigns and
  proposes 4 bid changes — within limits except: 2 conflicts (limit 0)."
- Director narrative auto-split into its priorities; dropped items shown as
  "set aside, and why".
- Acceptance: a person who has never seen the system can answer, for plan #1:
  what was proposed, why was it blocked, what would have to change — in under
  a minute, from the UI alone. (We test this literally: the operator's read.)

### FX.3 — Worker profile pages — apps/web (+small api)
- Route per agent: `/marketing/ads/rules-automation/fleet/worker/[key]`
  (children of the fleet page — the nav stays one entry).
- Sections: **Who I am** (mission in plain words, tier, autonomy dial with
  the cap explained); **My pipeline** (the agent's actual step sequence
  rendered as a diagram: *read evidence → think → check my work → write
  findings* — driven by real AgentStep data from the last run, with timings);
  **What I read** (its observations, with a peek at the actual evidence);
  **What I produce** (its findings feed, named entities, severity explained);
  **My limits** (budget, token cap, findings cap, the contracts — as
  sentences: "I stop myself at $0.10/day"); **My report card** (FX.1
  scorecards: grade, shadow agreement, acceptance — each with "what this
  measures" tooltips); **My charter** (the versioned system prompt, shown as
  the job description it is); **Run history** (each run expandable into the
  FX.1 trace view: what I read → what I thought → what I wrote → what it cost).
- Acceptance: the operator's question — "what is each worker going through,
  what process does it follow?" — is answered on one page per worker, and
  every run is replayable as a story.

### FX.4 — The teaching layer — apps/web
- `<Term>` tooltip primitive + a glossary registry (~30 entries: OBSERVE,
  PROPOSE, AUTO, finding, plan, critic, blast radius, shadow grade,
  calibration, dedupe, charter, sweep, council, degraded, severity,
  confidence, exemplar, demotion…). One definition, used everywhere.
- A **"How the fleet works"** explainer reachable from the page header: the
  five-tier picture, the trust ladder (OFF→OBSERVE→PROPOSE→AUTO and what each
  rung requires), "nothing touches Amazon without you", the weekly rhythm
  (nightly sweep, Monday council).
- Teaching empty states: every panel's empty state says what will appear,
  when, and what has to be true first ("Approvals appear here when a plan
  passes the critic — the next council is Monday 05:15").
- Dismissable first-visit walkthrough (hand-rolled, no new dependency).
- Acceptance: zero unexplained jargon on any fleet surface (checked by a
  greppable rule: every term chip renders via `<Term>`).

### FX.5 — The map comes alive — apps/web
- Nodes gain: last-run status dot + "ran 2h ago · 7 findings", next-run
  countdown, a running pulse while a run is in flight (poll the runs
  endpoint), and the self-test's internal findings de-emphasized from the
  headline count.
- Edges gain artifact counts ("34 findings this week" / "1 plan").
- A schedule strip above the map: "Next sweep in 6h 12m · Next council Mon
  05:15 · Fleet ceiling $2.00 — spent $0.38 today".
- Clicking a node goes to its FX.3 worker page (drawer retired).
- Acceptance: during a supervised run the map visibly shows who is working.

### FX.6 — The inbox becomes decision cards — apps/web
- One card per pending approval, built to the HITL research checklist:
  **What happens** ("Amazon stops showing your ad for 'homologué' in the
  XAVIA DE Broad campaign"), **Why I'm asking** (which rule/threshold routed
  it here), **The evidence** (links: finding → plan item → critic's line),
  **Expected effect** (the director's estimate, labelled an estimate),
  **Reversible?** (yes/how), **Cost of being wrong** in plain words.
- Buttons name effects; reject keeps its mandatory reason (it feeds the
  exemplar store — say so on the card: "your reason teaches the fleet").
- Scan layout: group by worker, sort by risk, keyboard next/approve/reject.
- Acceptance: a decision can be made confidently WITHOUT leaving the card;
  every card answers the five questions above.

### FX.7 — Money and report cards — apps/web
- Cost panel: recharts (already a dependency, RPT idiom) daily-spend bars vs
  the $2 ceiling line, 30 days; per-worker split; "what a run costs" in
  human terms ("tonight's sweep ≈ 7 cents").
- Report cards surfaced on the fleet page: per worker — grade with its
  meaning, the promotion track ("14 days of OBSERVE + grade B unlocks
  PROPOSE — 3 days in"), demotion events called out loudly.
- The auditor's nightly brief becomes the page's headline card once the
  auditor is enabled (it already lands as a finding — render it).
- Acceptance: ledger reconciles to AgentRun sums (existing rule), the grade
  column is never shown without its explanation.

### FX.8 — Best-in-class polish gate — apps/web
- Loading skeletons everywhere; auto-refresh with a visible "updated 30s ago";
  error states with retry; focus states + aria labels + keyboard paths;
  narrow-viewport pass; spacing/typography audit against the room's rhythm.
- Full-page live verification on prod (geometry, not element presence),
  screenshots of every panel in every state (empty, loading, populated,
  error), and the beginner read-through test on the real data.
- Acceptance: the house zero-defect bar, verified on prod in the browser.

---

## 5 · Sizing & order

FX.1 must come first (everything readable depends on it). FX.2 and FX.3 are
the two acute pains and come next, in that order (the timeline is the shared
surface; workers build on the FX.1 trace endpoint). FX.4's glossary lands
before FX.5–7 sprinkle more surfaces. FX.8 gates the series.

Rough effort: FX.1 and FX.3 are the big ones; FX.4 and FX.7 are small;
FX.2, FX.5, FX.6 medium. The series is 8 commits minimum, each shippable.

## 6 · Decisions needed from you

1. **Word choice: "worker" vs "agent"** across the UI. You said worker; the
   spec says agent. Default: **worker** in UI copy, agent stays in code/API.
2. **Worker pages as sub-routes** of the fleet page (my recommendation, keeps
   the nav at one entry) — confirm.
3. **Scope of FX.6 previews:** the preview text is generated by the tool
   handlers today; FX.6 upgrades them to full plain-language effect
   statements — that touches `ads-propose.tools.ts` (API). Confirm that's in
   scope (it's where the sentence should live, not duplicated client-side).
4. **Approve the phase set and order**, or reorder/cut.

---

## Execution record (2026-08-07, same session — all eight phases SHIPPED)

FX.1 fc67c6060 (labels/trace/scorecards/schedule APIs, 20 new tests) ·
FX.2 c520ab612 (PlanStory: stepper, action cards, explained checks) ·
FX.3 f6d640782 (worker profile pages) · FX.4 1834569cf (glossary + Term
tooltips + How-it-works + intro) · FX.5 18d0f8af4 (live map, schedule
strip, drawer retired into worker pages) · FX.6 4ccb1fc2f (decision
cards; the tool previews were already plain-language server-side, so no
API change was needed there — recorded deviation) · FX.7 b544585c7
(spend chart vs ceiling, grades in the worker table, auditor brief as
headline; no demotion panel — no demotion table exists to feed one) ·
FX.8 da01998ce (skeletons, 60s quiet refresh with freshness stamp,
retry, overflow guards).

Gate: 4,102 api tests green, both builds, full pre-push; deployed and
verified live in the browser. The beginner read-through on the real
blocked plan passes: stepper → "why the critic said no" → plain-English
action cards with real campaign names ("Stop showing ads for any search
containing 'homologué' in FR_Exact_8_Keywords (FR)"), each blocked item
carrying its reason. Deferred from FX.6: explicit keyboard shortcuts
(tab-order works; shortcut keys can ride a later polish pass).

## FX.9 / FX.10 — visual rebuild + the entity graph (2026-08-07)

- **FX.9 / FX.9b** — the map was rebuilt (first dark, then LIGHT on the
  operator's revision): premium cards, animated flow edges, findings
  drill-down on the canvas, and an elevation pass on the light page
  scoped to `.acr-fleet` so the Control Room is untouched. The fleet
  surface is light; do not re-propose dark.
- **FX.10** — Phase H's 5,900 derived edges became explorable.
  `GET /agent/fleet/entity-graph` serves two shapes: the campaign↔campaign
  OVERVIEW (96 edges / 37 campaigns) and a focused NEIGHBOURHOOD via the
  frontier CTE. Nodes are named server-side; unresolved ids show as
  themselves; capped views say so.
- Three layout defects were caught on prod and fixed before hand-off,
  each recorded as its own commit: **10b** one ring of 37 nodes was a
  hairball → connected-component clusters (the families ARE the
  insight); **10c** fitView shrank labels past reading → compact
  overview cards + zoom controls; **10d** a focused campaign put 98
  products on a ring → relation LANES, one hop, eight per lane with an
  honest "+N more not shown"; **10e** a campaign appearing in two lanes
  shared a node id and blanked the cannibalizes lane → lane-scoped ids.
- Verified live: focusing `IT-AIREON-SP-Category-Exact` shows
  cannibalizes · 7, competes with · 7, shares stock · 3 (its DE
  siblings), advertises · 24 with real product names and stock.
