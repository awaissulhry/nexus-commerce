# NAF.SB.ACT — The Activity page: what it is for, and what is on it

**Status: APPROVED and in build.** Operator, 2026-08-07: one list with a grain
switch (not two tabs), and the self-test excluded by default. **ACT.1 has
landed and is prod-verified — Part 15.** ACT.2–ACT.7 open.

| | |
|---|---|
| **Route** | `/fleet/activity` — Operate group, between Approvals and Fleet map |
| **Today** | a `PlannedPage` stub (`apps/web/src/app/fleet/activity/page.tsx`, 46 lines) |
| **Inherits** | the open **DT.4–DT.8** phases from `docs/2026-08-07-naf-dt-decision-timeline.md` |
| **Stream tag** | `SB.ACT`, claimed in `docs/2026-08-07-naf-sb-session-locks.md` §2 |
| **Parent** | `docs/2026-08-07-naf-sb-fleet-pages.md` Part 3 §3 |

Research behind this document: five industry archetypes (43 products), four
codebase reconnaissance passes, three adversarial critiques, and a read-only
production probe. **Every number below was run against the production database
on 2026-08-07 and is reproducible** —
`apps/api/scripts/_sba-activity-truth.mts` and
`apps/api/scripts/_sba-failure-attribution.mts`.

---

## PART 0 — The one sentence

> **Everything the fleet has done, newest first — and every run that tried.**

That is the stub's own sentence, verbatim, and it is already right — S1 keeps
it unchanged. (An earlier draft of this Part paraphrased the second clause as
*"and one click to why it did it"*, which made the study quote two different
sentences as the page's one sentence. The stub's wording wins; the *why* is
S5's job, and the page should not promise it in the subtitle.) The page is
the fleet's **record**. It is the only unscoped view of the fleet's history:
every other page that shows runs shows the runs of *one* thing.

Three things follow from "record", and they decide most of the design:

1. **A record is read, not operated.** No retry, no re-run, no approve, no
   halt. Every one of those lives one click away on the page that owns it.
2. **A record must be complete.** Nothing is silently dropped, capped, or
   filtered away without the page saying so in words.
3. **A record must not editorialise.** Where the data is thin, the page says
   it is thin. It does not dress two days of history as a trend.

---

## PART 1 — Ground truth: what this page will actually render

The fleet is nearly dark. Designing against what we wish were there produces
ten empty pages, so here is what is there, verified.

### 1.1 The whole history is 155 events over three days — and 36 of them are a lie

`countFleetTimeline({})` returns **155 events**:

| Kind | Count |
|---|---|
| `finding.raised` | 64 |
| `run.ok` | 27 |
| `run.failed` | 26 |
| `approval.requested` | 18 |
| `approval.decided` | 18 |
| `plan.drafted` | 1 |
| `plan.critiqued` | 1 |
| `fleet.halted` | 0 |

Events per UTC day: **2026-08-06 → 111 · 2026-08-07 → 8 · 2026-06-17 → 36.**

That third day is the problem. **All 18 `AgentApproval` rows are from
2026-06-17, and not one of them is attached to a fleet run** — verified:
`approvals attached to a FLEET run (mode not null) = 0`. They hang off the
pre-fleet ACP runtime, agent keys `manual-action` and
`listing-quality-keeper`, neither of which is a fleet worker or has an
`AgentCharter` row. All 18 have `decidedAt` set and **`decidedBy` null**, so
`fleet-timeline.service.ts:521` prints *"Someone (not recorded)"* eighteen
times.

So 36 of 155 events — **23% of the page** — are dated fifty days before the
fleet's first run and attributed to nobody. A first-time reader would
correctly conclude the fleet has taken 18 approval decisions with no
accountability trail. Both halves of that are false.

They also pollute the filter: `page.actors` returns **nine** entries, of
which `listing-quality-keeper`, `manual-action` and `human → "Someone (not
recorded)"` are all artefacts of those rows.

**Scoping them out leaves 119 honest events and six real workers.** This is
backend edit #1 in Part 9, and it is blocking.

**⚠ One coupling, and I nearly shipped it wrong.** `ApprovalInbox.tsx` (AP.2)
deliberately shows those same pre-fleet approvals under its *Decided* view,
and its header states the reason:

> *"Waiting is fleet-only (a pre-fleet approval is not something this page can
> act on); Decided and Expired include that history, labelled, **because the
> decision timeline already shows it** and two panels must not disagree about
> the past."*

So the Approvals page is relying on this stream to carry that history. Simply
deleting it would silently falsify another page's stated reasoning — exactly
the kind of cross-page drift this whole exercise exists to prevent.

**The resolution, and it costs nothing:** Activity scopes them out of the
stream *and says where they went*, in S6 — *"18 approval decisions from June
belong to the older Copilot system, not the fleet. The Approvals page lists
them under Decided."* The history stays reachable, one click away, on the page
that can actually contextualise it; Activity stops claiming the fleet did
something it never did. **The Approvals stream needs no code change** — but it
does need to know, so this is carried to them in the session-locks file.



### 1.2 Three quarters of the fleet's life is the self-test

| | All | `fleet-selftest` | Everything else |
|---|---|---|---|
| Runs | 53 | **39** | 14 |
| Findings | 64 | **47** | 17 |

`fleet-selftest` checks that the fleet itself works. Its findings
(34 × `cron_stale`, 13 × `cron_failing`) are about our cron jobs, not about
the Amazon account. `run-health.ts` already has `isDiagnostic()` and the rule
— *excluded from totals, never concealed*.

**As of `760518a78`, `fleet-timeline.service.ts` had no notion of a diagnostic
worker** — no mention of `diagnostic` or `selftest` anywhere in it. So the
stream opened on a page three-quarters about the fleet testing itself.
**ACT.1 fixed this** (Part 9): every event now carries `diagnostic`, and the
filter drops them server-side so the headline counts and the rows can never
disagree.

### 1.3 The failure story — and the trap I nearly walked into

26 of 53 runs are not-ok. Classified through `run-health.classifyFailure()`
and attributed by worker:

| Class | Count | Whose |
|---|---|---|
| `provider-unreachable` (`fetch failed`) | 21 | **`fleet-selftest` — all 21** |
| `provider-refused` (out of credit) | 3 | **`fleet-selftest` — all 3** |
| `limit` (`budget_tokens`, *not a failure*) | 1 | `amazon-negative-miner` |
| `contract` (bad output shape) | 1 | `amazon-bid-tuner` |

**Excluding the self-test: 14 runs, 2 failures.** One is a token limit doing
exactly its job (`blame: nobody`, amber). One is a real contract break.

And: **the last 12 fleet runs contain zero failures.** The 21
`provider-unreachable` runs all fall inside a **six-minute window** on
2026-08-06 — which `docs/2026-08-07-naf-dt-decision-timeline.md` §7 already
diagnosed as the local Ollama endpoint restarting during NAF.A2 development.
Self-inflicted, historical, closed. That document ends with an explicit
instruction: ***"Do not quote '56% of runs fail' as a live number."***

This is the single most important correction in this study, and Part 6 is
about it.

### 1.4 The rest of the shape

- **Steps: 126 rows over 53 runs — min 1, median 3, max 5.** Four types only
  (`observation` 53, `model` 36, `validation` 36, `gate` 1). 10 of 126 not-ok.
  17 runs died before the model ever ran, so their entire trace is one line.
- **`spanId` / `parentSpanId` are written by no code**, so there is no
  parent/child structure to draw. There is no tree here, and there will not be
  one soon.
- **`orchestrationId` is null on 45 of 53 runs.** The only two real episodes
  are 6 runs under `test_7222c8f1…` and 2 under `orch_f21a083c…`.
- **Money: lifetime fleet spend is $0.656011.** 14 of 53 runs cost anything;
  median cost per run is **$0.000000**; the most expensive run was $0.194367.
- **Triggers: 51 manual, 2 schedule.** Modes: 43 `ask`, 8 `preview`,
  2 `council`. **No sweep has ever run.**
- **Latency: median 16.4s, max 276s** (4.6 minutes).
- `workflowKey` non-null on **6 of 53** runs, every one `fleet-sweep`.
- Fleet state: `halted: false`, `dailyCeilingUSD: 2`.
- **`AgentControlAudit` exists in production and holds 0 rows.** Its migration
  *is* applied (confirmed via `information_schema`), which makes the comment
  at `fleet-timeline.service.ts:16-19` — claiming it is not — stale.
- Empty tables: `AgentExemplar` 0, `AgentEvalRun` 0, `AgentStrategy` 0,
  `AgentMemory` 0. Populated: `AgentScorecard` 14, `AgentShadowGrade` 17.
- All 64 findings have `status: 'open'`. There is no lifecycle to render.

---

## PART 2 — What the industry puts on this exact page

Forty-three products across five archetypes. The convergences matter more
than any single design.

### A · Workflow execution history — n8n, Zapier, Make, Workato, Gumloop

`Overview → Executions` is a **top-level page, separate from the editor**, in
every one. The list is: status · workflow · started · run time · trigger,
with filters on exactly those, and a per-execution view with per-node
input/output. n8n's list is **auto-refreshing and infinite-scrolling**; Make
splits **History** from **Incomplete Executions**, its DLQ.

The lesson worth stealing is the split itself: *what should happen* and *what
did happen* are never the same page. The lesson worth **not** stealing is
Zapier's — it separates "Zap runs" from "Task usage", two lists of the same
events counted differently, and its own docs field the resulting confusion.

### B · LLM/agent observability — LangSmith, Langfuse, Braintrust, Phoenix, Weave, Datadog

The settled anatomy: a **trace list** with facets, and a **waterfall of
nested spans** carrying per-step latency, tokens and cost. Braintrust ships a
`Row type: Traces | Spans` switch; LangSmith a Threads/Traces/Runs toggle;
Datadog a spans/traces lens. **Three independent products converged on one
list with a grain control** rather than two tables.

Langfuse's Agent Graph is inferred *from span nesting* — which is exactly why
we cannot have one.

### C · Job orchestration — Airflow, Dagster, Prefect, Temporal, UiPath

Runs list → run detail → task/step logs, with **retry, re-run-from-failure,
cancel and backfill as named, confirmed operations**. Temporal surfaces
*"scheduled but no worker polling"* as a first-class state. UiPath's Jobs page
is scoped by folder and its queue items carry an explicit state machine.

Workato's fleet dashboard **default-sorts by failed count**, which is the
strongest single argument for putting failures above the list rather than in
it.

### D · Audit trails and activity feeds — GitHub Actions, Vercel, Sentry, Stripe, CloudTrail, Datadog

Rollup is universal: Sentry groups events into issues with a count and a
frequency sparkline; CloudTrail offers "compare up to 5 events". Every one
ships **permalinks, CSV/JSON export, and an explicit retention statement**.
Vercel offers **"Show New Logs"** rather than auto-scroll — a pull, not a push.

The documented anti-patterns are precisely our risks: *logging model text
while omitting tool calls or identity*; *an audit interface built only for
engineers*; *claiming immutability while permitting edits*.

### E · Agent activity for non-engineers — Copilot Studio, Agentforce, Sierra, Decagon, Intercom, Zendesk

Microsoft Copilot Studio's per-agent **Activity** page is the closest 1:1
analogue that exists, and it is **one list**; its detail view is
*Transcript + Map view*. Agentforce moved Testing Center *into* the Studio
because a separate surface got ignored. Sierra names the goal
**"one-click investigation."**

The recurring beginner-confusion finding across this group: users cannot tell
**"the agent did X"** from **"the agent proposed X"**, and they cannot tell a
**system fault** from an **agent mistake**. Both are addressable in copy, and
both are already half-solved for us — `classifyFailure()` returns a `blame`
field for exactly the second one.

---

## PART 3 — The sections

Nine sections. Priorities: **v1** = the first shippable page; **P2/P3** =
later, with a named trigger.

### The one deviation from the approved parent study

Part 3 §3 of the parent approved **two tabs — Decisions and Runs**. I am
proposing **one list with a grain switch** instead, and asking you to confirm.

The reasons, in order of weight:

1. **Runs are a strict subset of the stream** — 53 of 119 events. The Runs tab
   would be the same rows in a table.
2. **Every event belongs to a run.** `AgentFinding.runId`, `AgentPlan.runId`,
   `AgentApproval.agentRunId`. The grains are *nested*, not parallel.
3. **Naming halves by audience makes the reader classify their own question
   first.** Is *"did the bid tuner run this morning"* a business question or a
   technical one? A beginner cannot answer that, and answering wrong means
   picking the wrong tab and concluding the data is missing.
4. **Two feeds drift.** The timeline endpoint pages by cursor and takes six
   filters; `/agent/fleet/runs` caps at 100 with three. Two tabs means two
   fetch paths that will disagree.
5. Braintrust, LangSmith and Copilot Studio all landed on one list with a lens.

So: **one list, one filter state, one URL, one drawer, and a two-value switch
— "Everything" / "Runs only".** The words *Decisions* and *Runs* stop being
section names. The page is called Activity, which is already the right noun.

---

### S1 · Header and the scope line — *v1*

**On screen**

> **Activity**
> Everything the fleet has done, newest first — and every run that tried.
>
> *119 events across 53 runs, all of it from 6–7 August. The fleet is switched
> off, so nothing new is arriving.* · as of 21:04 · **Refresh**

| | |
|---|---|
| **Purpose** | Say how much history exists and whether anything is still happening — so an almost-empty page reads as *a two-day-old fleet*, not *a broken page*. |
| **Renders** | `FleetPageShell` (title + sub verbatim from the stub — already correct), then one composed sentence from `page.total`, the run count and the oldest event date, plus `halted` from `GET /agent/fleet/state`, plus the `asOf` stamp and a manual **Refresh**. |
| **Halted state** | If `state.halted`, the line is replaced by a banner: *"The whole fleet is halted — {haltReason}."* with **Controls →**. |
| **Data today** | **FULL.** 119 · 53 · oldest `2026-08-06T04:50Z` · `halted: false`. |
| **Backend** | none. `/agent/fleet/state` is live at `agent-fleet.routes.ts:142`. |
| **Boundary** | Renders **no stop button**. `/fleet/controls` owns the halt and its deliberately un-arguing confirmation. Activity is the record; Controls is the switch. |

---

### S2 · What needs a look — *v1, and see Part 6*

**On screen today** — clickable tiles, one per failure class present in scope.
With the self-test excluded, two remain:

> **What needs a look**
> **Answer didn't match its promised format — 1 run** *(red)*
> **Stopped by its own limit — 1 run** *(amber — a limit doing its job)*
>
> *The self-test also had a bad afternoon on 6 August — 24 runs failed in six
> minutes when the local model server restarted. It is fixed, and it was never
> your account.* **Show me →**

**On screen when the scope is clean** — the zero state, one green line:

> ✓ *Nothing has failed in the fleet's last 12 runs.*

| | |
|---|---|
| **Purpose** | Tell you in plain words whether anything is wrong **right now**, before you read a single row. |
| **Renders** | `.acr-pg-strip` tiles, one per `FailureClass` present, count + `classifyFailure().label`. Clicking a tile writes a removable chip into S3. `limit` is amber with no blame; everything else is red. Zero failures in scope → the green line above. |
| **Scope** | **The tiles obey the page's filters, and the self-test is excluded by default.** This is the whole correction in Part 6. |
| **Data today** | **THIN by design, and that is the honest answer**: 2 failures across 14 business runs, one of which is not a defect. Flip *Include self-test* and it becomes 26 across 53. |
| **Backend** | none. |
| **Two traps, both already shipped-and-fixed elsewhere in this repo** | **(a) Never group on `errorMessage`.** The three credit errors each carry a distinct `request_id`, so a raw string group-by renders 4 rows for 2 causes — verified in the probe output. Group through `classifyFailure().klass`. **(b) Filter `status !== 'running'` before testing `ok`.** A fleet run is created `ok: false` and only flips true when it finishes. `classifyFailure` guards it (`run-health.ts:77-82`); hand-rolled counts do not, and this bug has been shipped and re-fixed **three times** in this subtree. Activity, being the only unscoped list, will hold more in-flight rows than any other page. |
| **Boundary** | Counts **across all workers**. The same tally scoped to one worker stays on that worker's page, where it justifies that worker's status word. Both call `classifyFailure`; neither re-derives. |

---

### S3 · The controls — *v1*

| | |
|---|---|
| **Purpose** | Narrow the list to what you care about, with every active filter visible and removable. |
| **Renders** | One toolbar row: **Show: `Everything` / `Runs only`** (the grain switch) · **worker** chips · **what happened** chips · **Include self-test** toggle (off by default) · free-text search · active-filter chips each with an ✕ · **Clear** · right-aligned **Download these N rows (CSV)**. |
| **Chip sourcing** | **Never hardcoded.** Worker chips come from `page.actors`; "what happened" chips from `page.countsByKind`. Both are **already returned** by `GET /api/agent/fleet/timeline`, and **neither is read by any client today** — `TimelineStream.tsx` declares both types and uses only `page.total` (line 529, *"Showing N of M"*). This is the biggest free win on the page. Hardcoding is also unsafe: the route's `csv()` helper silently drops unknown values and falls back to *no filter*, so a typo shows everything rather than nothing (`agent-fleet-timeline.routes.ts:34-42`). |
| **Vocabulary** | `run.ok` → *Ran fine* · `run.failed` → *Run failed* · `finding.raised` → *Noticed something* · `plan.drafted` → *Drafted a plan* · `plan.critiqued` → *Plan reviewed*. `fleet.halted` never renders — zero events. |
| **The counting invariant** | Every chip's count is computed through the **same predicate** that filters the list, in `activity/views.ts` with a Vitest file beside it. That invariant has already broken twice in this subtree — a tile reading 3 above a table showing 4. |
| **URL** | Every filter lives in the query string, so a filtered view is a link. This is DT.5. |
| **Data today** | **THIN but honest** — 5 kinds, 6 workers. Every chip lights. |
| **Backend** | **Almost none.** `range`, `from`, `to`, `actor`, `kind`, `outcome`, `q`, `limit`, `cursor` all exist at `agent-fleet-timeline.routes.ts:59-85` and no client has ever sent one; `includeSelfTest` was added by ACT.1. **One real gap, found in verification:** `actor` is a **single** key, while `kind` and `outcome` are csv lists. So multi-select worker chips need `actor` to become a csv the same way — a ~5-line change in the service's `matchesFilters` plus the route's `csv()` helper. **ACT.3 either does that, or ships worker chips as single-select.** Recommend doing it: six workers today, but a single-select filter is a dead end the moment there are twenty. |
| **Boundary** | **No date-range picker** (Part 8 — and the DS ratchet would block it anyway). No query language. No saved views. |

---

### S4 · The list — *v1*

**Grain A — Everything** (default). One row per event, newest first, sticky
day headers.

```
6 August
  08:50  ✕  Fleet self-test — tried to run, and failed          [self-test]
            It could not reach the model provider. ×21, all within six minutes
  08:43  ●  Negative miner — found a search term wasting money — "moto gloves"
  04:52  ✓  Bid tuner — ran and found 3 things                  $0.0242
```

**Grain B — Runs only.** DS `DataGrid` + `GridToolbar`.

| Column | Contents |
|---|---|
| When | relative (`ago()`), absolute on hover, `sortValue` = epoch |
| Worker | display name + `Self-test` / `Test run` badges |
| What happened | the outcome word, or `classifyFailure().sentence` in full |
| Started by | *Someone asked* / *On a schedule* |
| How long | human duration |
| Found | `findingCount` |
| Cost | cents — **blank** when null or zero, never `$0.00` |

| | |
|---|---|
| **Purpose** | Show, newest first, every single thing the fleet has done — and click any of it to see why. |
| **Three empty states, all designed now** | (1) *Reading the fleet's history…* (2) *Nothing has happened yet. When a worker runs, every step it takes lands here — what it read, what it decided, what it cost.* (3) *Your filters are hiding all 119.* **Show everything.** |
| **Rollups** | Kept from DT.2 — repeats collapse to one line with a count and *show all N*. Essential: without it the 6-minute self-test outage is 21 identical rows. |
| **Badges** | `Self-test` (tooltip = `DIAGNOSTIC_HINT`) · `Test run` (mode `preview`, 8 runs) · `fleet-sweep` (the 6 runs carrying a `workflowKey`) · `ran together` (the 8 runs sharing an `orchestrationId`; clicking filters to its siblings). |
| **Arrivals** | A dismissible banner — *"7 new events since you looked — refresh to see them"* — diffed on **event ids at the head**, never counts. Rows are never inserted under the reader. |
| **Paging** | **Show older**. The word *cursor* never appears. `nextCursor` is `null` at limit 200 today, so the button will not render yet. |
| **Data today** | **FULL.** 119 events / 53 runs, over two day groups (6 Aug = 111, 7 Aug = 8). |
| **Backend** | four one-liners in one file — Part 9. |
| **Boundary** | Does **not** group into episode cards (Part 8 — `orchestrationId` is null on 45 of 53). Does **not** offer a findings status facet — all 64 are `open`; that is inventory, not chronology, and belongs to SB.10. Does **not** show per-routine or per-worker rollups. |

---

### S5 · What it did — the run detail drawer — *v1. This is DT.4 and it is the payoff.*

| | |
|---|---|
| **Purpose** | Show, step by step, what one run actually did — and why it decided what it decided. |
| **Renders, in this order** | **Why it ran** (trigger + mode sentence, workflow badge, *ran together with N others*) → **What it did** (an ordered list of ≤5 steps using the server's `stepLabel`, with duration, cost, and the verbatim error on a failed step) → **What it read** (evidence previews, collapsed, with `dataVintage` and the `truncated` notice) → **What it found** (each finding's phrase, severity, full `rationale`) → **What it cost** (tokens in/out, cost, duration) → **Copy details for support** (run id, orchestration id, model) + permalink. |
| **Plan events** | A plan row opens the same drawer showing headline, narrative, items, dropped items, conflicts, blast radius and the critic's verdict. `PlanStory` already renders this well and it stays. This is the single richest "why" in the dataset. |
| **Legacy guard** | If `trace.shape === 'legacy-json'`, say so and render raw JSON. Unreachable from the list (both feeds filter `mode: not null`) but reachable from a hand-typed permalink. **Guard every array** — an incomplete trace response has twice taken the worker page down through its error boundary. |
| **Data today** | **THIN, and appropriate.** 126 steps over 53 runs: min 1, median 3, max 5. 17 runs died before the model ran. A list is the right shape; a tree is not (Part 8). |
| **Backend** | **none.** `GET /agent/fleet/runs/:id/trace` is live and returns steps, evidence, output and up to 50 findings **with rationale**. |
| **Build note** | Build it as `app/fleet/_shared/RunDetail.tsx` so the worker page can adopt it later. Copying it creates exactly the disagreement `run-health.ts` exists to prevent. |
| **Boundary** | Renders **no controls** — no retry, no re-run, no approve/reject, no cancel. `/fleet/approvals` owns decidable items; `/fleet/workflows/[key]` owns *run this now* and its spend confirmation. |

---

### S6 · What this page doesn't show — *v1*

A small footnote block under the list. Four or five sentences, each currently
true:

- *This page starts on 6 August 2026, when the fleet took its first run.*
- *The rules engines that run your ads day to day are not here — this page is
  the AI fleet only. The Control Room has those.*
- *39 of these 53 runs are the self-test, which checks the fleet itself works.
  They're left out of the counts above and badged in the list.*
- *No person has yet approved or rejected anything the fleet proposed. When
  they do, it appears here.*
- *18 approval decisions from June belong to the older Copilot system, not the
  fleet. The Approvals page lists them under Decided.* — the pointer AP.2 is
  owed (Part 1.1).
- *(Runs grain only) From the newest 100 recorded runs.*

| | |
|---|---|
| **Purpose** | Say out loud what is missing, so a gap reads as a boundary rather than a bug. |
| **Boundary** | This **replaces the retention banner** every audited product ships. There is no retention policy, no TTL and no pruning anywhere in the fleet schema — printing one would invent a guarantee we do not offer. CloudTrail's negative-space statement is the honest substitute. |

---

### S7 · How this page works — *v1*

A collapsed card with a **Read it** / **Close** toggle, on the
`HowWorkflowsWork.tsx` shape already used by the Workflows page. Five
paragraphs: what a run is · what workers write down · why some runs fail and
whose fault each kind is · what *self-test* and *test run* mean · what this
page keeps.

Not a tour, not a modal, not a first-run overlay. Collapsed by default, so it
costs an experienced operator nothing. Uses `<Term>` inline; **exactly one new
glossary entry is needed — `run`.** Every other word (`worker`, `finding`,
`plan`, `approval`, `sweep`, `council`, `charter`, `ceiling`, `degraded`)
already exists.

---

### S8 · Who changed what — *P3, boundary claimed now*

| | |
|---|---|
| **Purpose** | Show every time a person moved a dial, paused a worker, or decided an approval. |
| **Data today** | **EMPTY, twice over.** `AgentControlAudit` exists in production and holds **0 rows**; and `controlAuditEvents()` at `fleet-timeline.service.ts:580` is a hardcoded `return []` whose comment still claims the migration is unapplied — which is now false. |
| **Backend when it lands** | delete the `return []` and query the table · add a fleet-wide read (only the per-charter `…/:key/audit` exists) · add an index on `createdAt` alone (the table is indexed `(charterKey, createdAt)`, so a chronological fleet-wide query is a sequential scan). |
| **Trigger to build** | the first time an operator moves a dial or decides an approval. **It cannot be backfilled**, so the value starts accruing the day the write path is exercised, not the day the section ships. |
| **Boundary — claimed now** | This lane is **Activity's**, not Controls'. A dial move is a fleet event with an actor, a time and an outcome, and this page's sentence is *everything the fleet has done*. `/fleet/controls` renders the **current setting** and its confirmation, never a history list. |

---

### S9 · Compare two runs — *P3*

CloudTrail's "compare up to 5 events", scoped to two. Genuinely useful,
genuinely premature: no worker has yet run enough times under enough
different conditions for a diff to say anything. **Trigger:** the same worker
has ≥10 runs across ≥2 charter revisions.

---

## PART 4 — Reading order, and why that order teaches the page

```
Activity                                        ← what page am I on
"Everything the fleet has done…"                ← what is this for
119 events across 53 runs, 6–7 August.
The fleet is off, so nothing new is arriving.   ← how much is here, is it live
as of 21:04 · [Refresh]

WHAT NEEDS A LOOK
[1 bad format] [1 hit a limit]                  ← do I need to act
  (the self-test's bad afternoon, explained)

Show: (Everything)(Runs only)  [workers ▾] [what happened ▾]
      [ ] include self-test  [search…]  ✕ couldn't reach the AI
                                    [Download these 21 rows (CSV)]   ← how do I narrow it

6 August
  08:50  ✕  Fleet self-test — tried to run, and failed  ×21        ← the answer
  08:43  ●  Negative miner — found a search term wasting money
  …

What this page doesn't show                                        ← what's missing
How this page works                                    ▸           ← teach me the words
```

Each block answers the question the block above it raises.

1. **Title → scope line.** *"Everything the fleet has done"* immediately raises
   *how much is that, and is it still happening?* The scope line answers both
   and stamps the answer with a time. Without it, a two-day-old fleet reads as
   a broken page.
2. **Scope → what needs a look.** *"119 events"* raises *do I need to do
   anything?* The band answers before a single row is read. Every product that
   opens on an undifferentiated firehose trains people to stop opening it;
   Workato default-sorts its fleet dashboard by failed count for this reason.
3. **What needs a look → controls.** A tile raises *show me those.* Clicking
   one writes a visible, removable chip — so the operator learns the filter
   grammar *by using the diagnosis*, not by studying a facet panel. Tile and
   chip are the same predicate, so they cannot disagree.
4. **Controls → list.** Now the list is an answer to a question the operator
   asked, rather than a wall they arrived at.
5. **List → drawer.** A row says *what*; the row raises *why*. The drawer is
   the only place *why* is answered, and it is one click away.
6. **List → footnote.** Having read the rows, the next question is *is that all
   of it?* Silence would imply completeness; the footnote answers honestly.
7. **Footnote → explainer.** Only now does a beginner want a glossary — and by
   now they have seen the words in context.

The order is also a difficulty gradient: one sentence, then a few numbers,
then a list, then a drawer. **Nothing on the page asks the reader to classify
their own question before they have seen data** — which is exactly what the
two-tab shape asked.

---

## PART 5 — The boundary map: Activity versus the other nine

The Workers stream already published a boundary map assigning **runs**,
**step traces** and **findings browse** to Activity. This table is the other
side of that agreement, and it is meant to be quoted in review.

| Concept | **Owned by** | On Activity it appears as |
|---|---|---|
| Every run, every event, unscoped — filter, search, export, permalink | **Activity** | the page |
| The step trace of one run | **Activity** | the drawer (S5) |
| Runs of **one routine**, grouped by orchestration | **Workflows** (`RunsSection`) | never — link out |
| Runs of **one worker**, plus its report card | **Workers** (detail) | never — link out |
| The **last five events**, as a teaser | **Overview** | never — Overview links in |
| The queue of things waiting on a decision | **Approvals** | never; a decided approval is an *event* here |
| Any aggregate over money — burn-down, cost per accepted action, ROI | **Cost & value** | one cost figure per row, one per step. No totals, no chart |
| Fleet halt, dials, budgets, tool policy, protected terms | **Controls** | a halt **banner** with a link. Never a control |
| Who moved which dial, when, and why | **Activity** (S8, P3) | claimed now, built when it has rows |
| Who feeds whom, live pulses, overlays | **Fleet map** | never |
| Findings as **inventory** — browse, status, dedupe, expiry | **SB.10** | findings appear only as *events*, at the moment they were raised |
| Named routines, edges, triggers, gates, versions | **Workflows** | a `fleet-sweep` badge on 6 rows |
| One worker, one job, one target | **Assignments** | an assignment run is an event here like any other |
| Uploaded sheets and reference tables | **Files & data** | never |
| The deterministic ads engines | **Control Room** | never — and S6 says so out loud |

Read the "never" column as a build instruction.

**The altitude rule, stated once:** a run list is scoped by whatever page you
are standing on. Workflows shows one routine's runs; Workers shows one
worker's; Overview shows the last five of everything. **Activity is the only
unscoped view, and it is the only one with filters, search, export and
permalinks.** A scoped list that starts growing a filter bar is a sign its
reader actually wanted Activity — that is the tell, and it needs no code from
any other stream. Registered as shared decision 5 in the session-locks file.

---

## PART 6 — The thing that would have bitten us

The research came back with a confident headline for this page:

> **26 of 53 runs failed — 49%. This is the page's reason to exist.**

It is arithmetically true and it would have been a serious defect on screen.

**24 of the 25 severe failures belong to `fleet-selftest`** — 21
`provider-unreachable` and 3 `provider-refused`. (`classifyFailure` marks every
class `severe: true` except `limit`, so the 25th is the one real business
failure: `amazon-bid-tuner` breaking its output contract. An earlier draft said
*"all 24"*, which contradicted this document's own Part 1.3 table.) All 21
`provider-unreachable` runs fall inside a **six-minute window** on 2026-08-06
— the local Ollama endpoint restarting during NAF.A2 development. The 3
`provider-refused` are historical credit exhaustion. Neither was ever about
the operator's Amazon account. Excluding the self-test: **14 runs, 2
failures**, one of which is a token limit working correctly. **The last 12
fleet runs contain zero failures.**

And this project has already made this exact mistake once and corrected it in
writing. `docs/2026-08-07-naf-dt-decision-timeline.md` §7 closes with:

> *"**Do not quote '56% of runs fail' as a live number** — that figure is a
> point-in-time reading of all history, and the honest current rate is 2 real
> failures in the last 12 runs."*

A headline tile reading *"21 runs couldn't reach the AI"* would send the
operator hunting an infrastructure fault that was diagnosed and closed
yesterday. That is worse than showing nothing: it spends trust on a false
alarm, and the *next* alarm is the one they will ignore.

**Three rules this fixes, and they apply to every section on the page:**

1. **S2 answers "is anything wrong *now*", not "what has ever gone wrong".**
   It obeys the page's filters and excludes the self-test by default. Today it
   correctly reads *"Nothing has failed in the fleet's last 14 runs."*
2. **The history is not hidden — it is placed.** The self-test's bad afternoon
   stays in the list, rolled up to one line with a count and a badge, and gets
   one explanatory sentence in S2's empty state with a **Show me →** that flips
   the toggle. `isDiagnostic`'s rule, verbatim: *excluded, never concealed*.
3. **No percentage-of-all-history appears anywhere on this page.** Ratios over
   53 runs across two days, three quarters of them a self-test, are not
   decision-grade. Counts and dates are.

The deeper lesson, worth carrying to the other nine pages: **an aggregate
computed over a table is not the same as a fact about the business.** This
page is the one most likely to confuse the two, because aggregating is what a
history page does.

---

## PART 7 — Defects found while researching, which are not this page's fault

1. **`fleet-timeline.service.ts` carries a second, competing failure
   taxonomy.** The server has `explainError()` / `errorSignature()`; the client
   has `classifyFailure()` in `_shared/run-health.ts`, whose own header says it
   exists so *"the roster, the Activity page and the worker's own page must not
   disagree about whether something is broken."* **They disagree today:**
   `run-health` treats a `budget_tokens` halt as *not a failure* (amber, blame
   `nobody`); the timeline service emits it as `run.failed` with outcome `bad`.
   The Fleet map stream has independently asked, in the session-locks file, for
   `classifyFailure`/`deriveStatus` to move somewhere the API can import them
   too. **Activity is the third stream to want this. It should happen, and it
   is not Activity's to do unilaterally** — `run-health.ts` is the Workers
   stream's file. Proposed in Part 11, Q6.
2. **Every `href` the spine emits is a pre-move URL.** Lines 295, 346 and 380
   still point at `/marketing/ads/rules-automation/fleet/...`. Backend edit #2.
3. **The stale comment at `fleet-timeline.service.ts:16-19`** claims
   `AgentControlAudit`'s migration is unapplied. It is applied; the table
   exists and is empty.
4. **`GET /agent/fleet/runs` caps at 100 with no cursor**, no status filter and
   no totals. Invisible at 53 runs; a silent truncation the day the fleet is
   switched on, under a page whose subtitle promises *every run that tried*.
5. **`AgentFinding` rows are upserted on `(charterKey, entityType, entityId,
   dedupeKey)` and there is no `updatedAt` column.** So `createdAt` is the
   *first* detection while the row's content is the *latest*. A chronological
   feed presenting an upserted row as an immutable historical fact is subtly
   wrong. Cheapest correct fix: surface `dataVintage` and render *"first seen 6
   Aug · based on data from 7 Aug"*. Backend edit #4.
6. **`AgentFinding.marketplace` and `AgentPlan.marketplace` are written as
   literal `null` by the executor on every row** — 100% empty. No marketplace
   facet anywhere until that changes.
7. **`getFleetTimeline` calls `countFleetTimeline` on every request**, which
   rebuilds every event at `limit: 10_000` across six sources; `episodeIndex()`
   loads all fleet runs unbounded, **twice** per request. At 155 events this is
   free. The service's own comment says *"revisit if it ever reaches five
   figures"* — that revisit is the P2 trigger, alongside defect 4.

---

## PART 8 — What I rejected from the research, and why

| Rejected | Sourced from | Why it dies against this data |
|---|---|---|
| **Two tabs named by audience** | the parent study; Zapier's runs/tasks split | Runs is a subset of the stream (53 of 119). Replaced by a grain switch. Zapier's own two-list split is a documented source of user confusion. |
| **Retry · re-run · replay · bulk replay** | Airflow Clear, Dagster re-execute, Workato Repeat, Temporal Reset | Three independent blocks: no endpoint exists; it is a **spend** action on a fleet the operator keeps deliberately off, so it needs a confirm + cost estimate; and **21 of 24 severe failures are `fetch failed`** — a retry cannot fix an unreachable provider, it only burns the attempt again. Workato publishes *"rerunning MAY CREATE DUPLICATE RECORDS"* for exactly this. |
| **Waterfall · flame graph · Gantt · span tree · agent graph** | Langfuse, Phoenix, Datadog, Weave | **126 steps over 53 runs: median 3, max 5**, four types. `spanId` / `parentSpanId` are written by **no code**, so there is no parent/child structure to draw; Langfuse infers its graph precisely from that nesting. A tree over three lines is the maze. Replaced by an ordered plain list. |
| **Episode / thread / session grouping as the page's structure** | LangSmith Threads, Langfuse Sessions, Helicone | `orchestrationId` is **null on 45 of 53 runs**. Grouping produces 45 groups of one plus a card titled with the word *test*. `parentRunId` and `strategyId` are written by no code, so there is no lineage either. Kept as a **`ran together` badge** on the 8 rows that have one — and the DT.3 episode card survives where it earns its place, on the one real council. |
| **Date-range selector · calendar · volume sparkline** | Prefect, Workato, Sentry, CloudTrail | All 53 runs sit in a **2-day window**; 7d and 30d return byte-identical sets, so a range selector is three buttons that do the same thing. Day headers stay; they are built and become correct the day the fleet runs daily. **Correction (verification pass):** an earlier draft added *"and the DS ratchet would block it anyway."* That is false — `design-system/components/DateRangePicker.tsx` and `DateField.tsx` live **outside** the guard's `apps/web/src/app` scan root, exactly like the DS `Select`, so a DS date control is legal. Only a **native** `type="date"` under `app/fleet/**` fails the push. The rejection stands on the data alone. |
| **Spend chart · cost tile · average cost per run** | Zapier Task usage, Gumloop Credit Explorer, ServiceNow | Lifetime fleet spend is **$0.656011**; median cost per run is **$0.000000**. It is already triplicated across the Overview, the routine page and the roster — and `/fleet/cost` is the rail page whose entire purpose it is. Activity keeps **one** money fact: what this run cost, on its row. Also: the spine sets `costUSD: null` on all six non-run kinds, so any sum over the stream silently undercounts. |
| **Query DSL · typed filter grammar · saved views** | Braintrust BTQL, Phoenix, LangSmith, GitHub qualifiers | There is nothing to query: 5 populated kinds (three of them single-digit), 6 workers, 1 finding status, 3 of 7 modes, 2 triggers. The whole history returns in one page with `nextCursor: null` at limit 200. |
| **Annotation queues · ratings · pins · tags · For Review** | n8n, Sentry, LangSmith, Braintrust | Every one needs storage that does not exist — no rating column, no pin, no tag table, no saved-view table. `AgentExemplar`, the nearest thing to captured judgement, has **0 rows** and is exposed by **no route at all**. Curation primitives exist to tame volume; 119 events fit on one screen. This is DT.7, and it stays deferred. |
| **Live tail · auto-scroll · streaming** | Vercel Live, Temporal, Helicone | **51 of 53 runs were a human pressing a button** and the fleet is off — live tail would be a permanently still screen. It is also expensive given defect 7. Replaced by Vercel's own better answer: a pull banner. |
| **An incomplete-executions / DLQ tab** | Make.com | Nothing resumes. No blueprint or input payload is stored at the failure point, so *Resolve* could only ever mean *start over*. |
| **A human-in-the-loop inbox / "needs action" state** | Agent Inbox, UiPath Action Center | `/fleet/approvals` owns the waiting queue, and `ApprovalInbox.tsx` already states the rule in this codebase: *"the decision timeline already shows it and two panels must not disagree about the past."* |
| **Clustering · topics · trends · an AI-written summary** | Intercom, Sierra, Copilot Studio, Decagon | 47 of 64 findings are `cron_stale`/`cron_failing` from the self-test. An AI summary of 119 events would spend a model call to say *"the self-test ran"*. |
| **A retention banner** | n8n pruning, Stripe, CloudTrail, Vercel | There **is** no retention policy, TTL or pruning anywhere in the fleet schema. Printing one would invent a guarantee. Replaced by S6's negative-space footnote. |
| **Confidence scores · quality labels · scorecard strip** | Copilot Studio, Agentforce, Intercom | `AgentEvalRun` has 0 rows. `AgentScorecard` (14) and `AgentShadowGrade` (17) exist but every `Int` counter is 0 and every nullable `Decimal` null while the fleet is off — and `/fleet/cost` owns them. |
| **A version picker / "code as it ran" tab** | Airflow Dag Version, Workato, n8n, Weave | 2 charter revisions, 3 workflow revisions, `workflowKey` non-null on **6 of 53** runs — all `fleet-sweep`. A badge, not a picker. |
| **A marketplace facet** | Workato custom columns, LangSmith metadata | Written as literal `null` on every row. 100% empty (defect 6). |
| **A kill switch on this page** | ServiceNow AI Control Tower | `/fleet/controls` owns the halt. Activity carries the **banner** with a link — one click, no duplicate control. |

---

## PART 9 — Backend work

> **Built and verified 2026-08-07 — see the ACT.1 execution record in Part 15.**
>
> **Correction from the verification pass:** an earlier draft of this section
> called these *"four one-line edits."* They are not. `FleetEvent` gained three
> **non-optional** fields, so **every** event constructor in the file had to be
> updated — `runEvents`, `findingEvents`, `planEvents`, `approvalEvents` (twice)
> and `haltEvents` — and the diagnostic seam needed a new resolver and a filter.
> The landed change is **+146 / −27**. The *scope* was right; the *size* was
> wrong, and estimating by counting the conceptual edits rather than the
> constructors they touch is how a "one-liner" becomes an afternoon.

**Five edits to one file, all blocking, all in
`apps/api/src/services/agent-fleet/fleet-timeline.service.ts`:**

1. **Scope approvals to the fleet.** In `approvalEvents()`, drop the
   `unknown`/`extra` lookup and skip any row whose `agentRunId` is not in
   `workerOfRun`. Removes 36 pre-fleet events and 3 junk actors; leaves 119
   honest events. **Part 1.1 is the whole argument.**
2. **Repoint the three stale hrefs** to `/fleet/workers/${key}` and `/fleet`.
3. **Add `workflowKey` to the run `select`** (the executor writes it on both
   paths) and surface it on `FleetEvent`. Enables the `fleet-sweep` badge.
4. **Add `dataVintage` to the finding `select`** and surface it. Defect 5 is
   the argument.
5. **Teach the spine about diagnostic workers** — `FleetEvent.diagnostic`,
   resolved from `FLEET_CHARTERS` (code truth, never a DB column) with
   `templateKey` so W.8 instances inherit it, plus a
   `FleetTimelineFilters.includeDiagnostic` enforced in `matchesFilters` and a
   `?includeSelfTest=0` route param. **This is what the operator's
   "exclude self-test" decision actually requires**: filtering client-side
   would leave `total`, `countsByKind` and `actors` counting rows the client
   had already hidden — the exact tile-disagrees-with-table bug this subtree
   has shipped twice. **Default is include**, so the Overview's existing stream
   is untouched and Activity opts out explicitly.

Plus: correct the stale comment at lines 16-19.

**No new endpoint is needed for v1.** The page's `load()` fires five existing
calls: `/agent/fleet/timeline?{filters}`, `/runs?limit=100`, `/charters`
(names + the `diagnostic` flag), `/state`, and `/plans` on first load.

**Deferred**

- **P2** — give `GET /agent/fleet/runs` a cursor, a status filter and a date
  bound (defect 4). Until then S6 prints the cap in words.
- **P2** — replace `countFleetTimeline`'s full rebuild with per-source SQL
  counts (defect 7). Trigger: five figures of events, or the fleet switching on.
- **P3** — the control-audit lane (S8).

---

## PART 10 — Proposed build order

| Phase | What | Why here |
|---|---|---|
| **ACT.1** | The four backend edits + their tests | Everything downstream renders 119 honest events instead of 155 with a 23% lie in them. Shippable and invisible. |
| **ACT.2** | The page: shell, scope line, the list in Everything grain, three empty states, rollups, day headers | The first visible page. Pure assembly over a live endpoint. |
| **ACT.3** | S3 controls — grain switch, chips from `actors`/`countsByKind`, self-test toggle, search, URL state | This is DT.5, and the backend for all of it already exists. |
| **ACT.4** | S2 "What needs a look", with Part 6's scoping rule and the counting invariant test | Wants the filters to exist first, because it writes chips into them. |
| **ACT.5** | S5 the drawer — DT.4, over the live trace endpoint | The payoff. Biggest single jump in what an operator can learn. |
| **ACT.6** | S6 footnote, S7 explainer, CSV export, permalinks, the teaching gate (DT.8) | Condition of done, not an optional polish phase. |
| **ACT.7** | Neighbour edits: Overview teaser, link repoints | Last, so nothing is removed from the Overview until Activity actually replaces it. |
| **P3** | S8 control audit · S9 compare runs · DT.7 annotation | Each has a named data trigger. |

**The teaching layer is not a phase.** Tooltips, `<Term>`, the explainer and
teaching empty states are a condition of done on every one of ACT.2–ACT.6.

---

## PART 11 — Open questions needing your decision

Nothing gets built until these are answered. My recommendation is marked in
each.

1. **The one-list deviation.** The parent study approved two tabs; I propose
   one list with an *Everything / Runs only* switch (Part 3). **Recommend:
   approve the deviation.** Say the word and I build the tabs as originally
   approved instead.
2. **The 18 pre-fleet approvals.** **Recommend: scope them out of the stream
   and point at where they live** — S6 says *"18 approval decisions from June
   belong to the older Copilot system, not the fleet. The Approvals page lists
   them under Decided."* This matters beyond Activity: `ApprovalInbox.tsx`
   currently justifies showing them *because the decision timeline already
   shows it* (Part 1.1). The pointer keeps that true. The alternative is
   keeping 36 anonymous June rows as 23% of the page.
3. **The self-test.** **Recommend: excluded from counts and tiles by default,
   shown in the list badged, with an *Include self-test* toggle.** Note what
   this means: **the honest business figure on screen is 14 runs and 17
   findings, not 53 and 64.** Confirm you want the smaller true number.
4. **Test runs (8 of 53, mode `preview`).** **Recommend: shown here with a
   `Test run` badge, excluded from headline counts** — Activity is the
   completeness page. But `/fleet/workflows` deliberately excludes them, so a
   routine page reading "4 runs" beside Activity reading "12" needs S6 to
   explain the difference. Confirm, or exclude them here too.
5. **The Overview teaser.** Activity cannot ship without shrinking the
   Overview's full timeline to a five-event teaser, or the fleet has two
   complete event streams over one endpoint. `FleetTab.tsx` is another
   session's directory (SB.2 is still open). **Who makes that ~10-line edit —
   this session with `git commit --only`, or a handoff?**
6. **One failure taxonomy, server-side.** Defect 1 — three streams now want
   `classifyFailure`/`deriveStatus` importable by the API. **Recommend: yes,
   and the Workers stream owns the move** since `run-health.ts` is theirs.
   Activity will consume whatever they publish and will not fork it. Your call
   on whether that is a separate piece of work or part of ACT.1.
7. **CSV export of model-authored text.** The export carries finding rationales
   and plan narratives. **Recommend: ship it, prefix-guarded against
   `= + - @` formula injection, with the scope stated in the button label.**
   Say so if handing that file around is not acceptable at all.
8. **Hand-rolled drawer vs the DS `Modal`.** Every shipped fleet page
   hand-rolls its dialogs, contradicting the design-system README. A DS `Modal`
   at z-60 would render *below* an open fleet confirm. **Recommend: follow the
   neighbours now**, and fix the whole subtree as its own pass rather than
   diverging one page.
9. **The 10-second poll.** House rule, and I am following it — but the fleet is
   off and each request currently pays two full history scans (defect 7).
   **Recommend: keep 10s** (155 events is nothing) and fix the scans at P2.

---

## PART 12 — Real-time behaviour

The house rule, followed exactly: `useVisibilityPoll(load, 10_000)` from
`app/fleet/_shared/use-visibility-poll.ts` — refetch ~10s while the tab is
visible, pause when hidden, catch up on return.

- **`asOf` is the last *successful* read**, never the last attempt. `load()`
  owns its error state and rethrows so the hook does not stamp a failure as
  fresh.
- **The poll refetches page 1 under the current filters**, plus `/runs` and
  `/state`. It never refetches pages already loaded with *Show older*, and a
  filter change *is* a load, so the interval resets rather than racing.
- **Skip-poll guard:** if the drawer is open, `load` throws
  `'skipped: a change is open'`, so nothing shifts under someone reading a run.
- **Arrivals are pulled, never pushed.** New events do not insert silently: the
  poll diffs **event ids at the head** — not counts, because a cost ticking up
  a hundredth of a cent is not news — and shows a dismissible
  *"7 new events since you looked"* banner.
- **The manual Refresh button stays.** Polling that removes the manual control
  leaves an operator with no way to force the question.

---

## PART 13 — Buildability constraints that fail a push

- **The DS ratchet gives `fleet` zero budget.** There is no `fleet` entry in
  `scripts/ds-conformance-baseline.json`, so the guard falls back to
  `{select: 0, date: 0, fontSize: 0, hex: 0}`. The first native `<select>`,
  `type="date"`, inline `fontSize` or inline hex under `app/fleet/**` fails the
  push — it already fired once on the Workflows stream. **It greps raw lines
  and does not strip comments**, so writing those tokens inside a JSDoc block
  fails identically. Use the DS `Menu`; the DS `Select` primitive is legal
  because it lives outside the guard's root.
- **Stylesheets, in order:** the four DS sheets, then `control-room.css`, then
  `../fleet-pages.css`, then `./activity.css`. The stub today imports
  `control-room.css` and `../fleet-pages.css` only — **both the four DS sheets
  and `activity.css` are still to be added**, and the DS sheets become
  mandatory the moment `DataGrid` renders.
- **`table-layout: fixed` is required** on the runs grid, as a plain global
  class, with `white-space: normal` on the prose cells — otherwise a failure
  sentence expands its column and overruns everything right of it. `tsc` cannot
  see this; verify with `getComputedStyle`.
- **Nothing that opens a panel goes inside the grid card** (`overflow: hidden`)
  or its wrap (`overflow: auto`). Portal to `document.body`.
- **`fleet-pages.css` stays frozen** — Activity adds `activity.css` and does not
  edit the shared sheet. Page-prefixed `sba-*` classes, raw light hex, no
  Tailwind colour utilities under `.fleet-surface`.
- **`p3-token-sweep.mjs --check`** fails on any non-`dark:`-prefixed
  `text-slate-400`, `border-slate-200` or `border-slate-100`. Use
  `text-tertiary` / `border-default` / `border-subtle`.
- **`check-link-targets.mjs` is weaker than it looks.** It inspects three
  shapes only — the JSX attribute `href="…"` / `href={'…'}`, hrefs inside a
  `breadcrumbs={[…]}` array, and template-literal `href={\`…\`}`. It does
  **not** see an object property like
  `livesToday={{ href: '/marketing/ads/fleet' }}`, which `PlannedPage` renders
  as `<Link href={livesToday.href}>` — a variable. Four fleet stubs carried
  that value (activity, approvals, map, cost) and the guard passed every time.
  **It was not a 404** — `next.config.js:151-152` permanently redirects
  `/marketing/ads/fleet` and `/marketing/ads/fleet/:path*` to `/fleet`, so the
  link worked via a 301. Repointed to `/fleet` in ACT.1 as tidy-up: it is the
  canonical URL and it saves a redirect hop. **The lesson stands even though
  the defect was smaller than it first looked: a link written as data is
  unguarded, so check its target by hand.**
- **Pre-push runs only `test:security` (`@nexus/api`)** — not the full Vitest
  suite, for either app. So the counting-invariant test and the ACT.1 service
  tests are **not push-gated**; they are run by hand. Worth knowing before
  calling any of them an enforced invariant. (This is also why a broken
  `fleet-council` test sat on `main` unnoticed for a day.)

---

## PART 14 — Parallel-session ownership

Claimed in `docs/2026-08-07-naf-sb-session-locks.md` §2 as **`SB.ACT`**.

**Owned exclusively:** `app/fleet/activity/**`,
`apps/api/src/routes/agent-fleet-timeline.routes.ts`,
`apps/api/scripts/_sba-*.mts`.

**Claimed in §3:** `fleet-timeline.service.ts` — with an explicit carve-out
that *adding a vocabulary phrase is additive and needs no claim* (the
Workflows stream's `mode === 'custom'` phrase, committed in `1aecbaaf1` as
WF.6b, stays exactly as it is), while anything structural asks first.

**Explicitly not touched:** `WorkerClient.tsx` and its trace UI (Workers'),
`agent-fleet.routes.ts` (boot-crash risk — the trace endpoint already exists
there and is consumed read-only), `TimelineStream.tsx` / `DecisionCard.tsx` /
`PlanStory.tsx` until ACT.7, `run-health.ts` (Workers'), `fleet-pages.css`.

**Asked of others: nothing.** The altitude rule in Part 5 requires no code
change from Workflows, Workers or Overview. The only cross-session edit
Activity needs is the Overview teaser at ACT.7 — question 5.

---

## PART 15 — ACT.1 execution record (2026-08-07)

**Operator decisions taken before this landed:** Q1 *approved* — one list with a
grain switch, not two tabs. Q3 *approved* — the self-test is excluded by
default. Q2 follows from ACT.1 as scoped.

**Shipped.** `+345 / −851` across the files below (the deletions are another
session's, carried in the same tree, not this change).

| File | What |
|---|---|
| `apps/api/src/services/agent-fleet/fleet-timeline.service.ts` | the five edits (+176/−27): approvals scoped to fleet runs · three stale hrefs repointed · `workflowKey` · `dataVintage` · the whole diagnostic seam |
| `apps/api/src/routes/agent-fleet-timeline.routes.ts` | `?includeSelfTest=0`, parsed so that only an explicit false-ish value excludes |
| `apps/api/src/services/agent-fleet/fleet-timeline.vitest.test.ts` | +10 tests (19 → **29**) |
| `apps/web/src/app/fleet/{activity,approvals,map,cost}/page.tsx` | the dead `/marketing/ads/fleet` link → `/fleet` |
| `apps/api/scripts/_sba-*.mts` | three read-only probes: truth, failure attribution, ACT.1 verification |

**Verified against the production database, not fixtures**
(`_sba-act1-verify.mts`):

| Claim | Result |
|---|---|
| Approvals scoped to the fleet | **155 → 119 events**; approval events 36 → **0**; `manual-action` and `listing-quality-keeper` gone from `actors`, 9 → **6 real workers** |
| Links repointed | 7 distinct hrefs, **all** start `/fleet`, **none** contains `rules-automation` |
| `workflowKey` surfaces | 6 events carry `fleet-sweep`; **zero** `undefined` |
| `dataVintage` surfaces | **64 of 64** findings carry it |
| Diagnostics excluded | 119 → **33**; `countsByKind` sums to 33; rows returned = 33; **no** diagnostic row survives |
| The honest headline | **14 business runs, 2 failures** — exactly Part 1.3 |
| Paging still whole | 119 unique events in 3 pages, **no gaps, no repeats** |

**Gates:** `tsc --noEmit` clean on `apps/api` · agent-fleet suite **313 passed
across 36 files** (including the `fleet-council` test that was red on `main`
yesterday — the Workflows stream fixed it).

**Three things found while building, each one a case of the code disagreeing
with itself:**

1. **A contract leak the tests caught.** `workflowKey: r.workflowKey` passed
   `undefined` through when a row lacked the column, and the type promised
   `string | null`. `undefined` serializes as a **missing key**, so a client
   writing `'workflowKey' in e` would silently disagree with one writing
   `e.workflowKey === null`. Fixed in the service with `?? null` rather than by
   patching the fixture — the fixture was telling the truth.
2. **An unguarded link on four shipped pages — and an overclaim of my own.**
   `livesToday.href` pointed at `/marketing/ads/fleet`, whose directory no
   longer exists, and `check-link-targets.mjs` cannot see it because its regex
   matches the JSX **attribute** `href=`, not an object property. I first wrote
   this up as *four live 404s*. It was not: `next.config.js:151` permanently
   redirects that path to `/fleet`, so the link worked. Repointed on all four
   anyway — canonical URL, one less hop — but as **tidy-up, not a defect fix**.
   The durable rule is still worth having (Part 13): **a link written as data
   is unguarded.** The lesson about me is worth having too: I asserted a
   user-visible failure from a missing directory without checking the redirect
   table, and the verification pass is the only reason it did not ship as fact.
3. **The diagnostic filter had to be server-side, and that was not obvious.**
   Filtering the self-test out in the client would have left `total`,
   `countsByKind` and `actors` counting rows the client had already hidden —
   "Showing 33 of 119" with 47 findings invisible. Enforcing it in
   `matchesFilters` makes the headline and the rows *the same derivation
   counted twice*, which is the invariant this subtree has broken twice before.

**Not built:** ACT.2–ACT.7. The page is still a `PlannedPage` stub — this phase
was deliberately invisible.

**One thing ACT.3 must decide** (found in verification, not yet actioned):
`actor` is a single key server-side while `kind` and `outcome` are csv lists,
so multi-select worker chips need `actor` to become a csv too. ~5 lines.

---

## PART 16 — ACT.2 + ACT.3 execution record (2026-08-07/08)

**ACT.2 — the page renders** (`aaca58093`). Scope line, day-grouped list,
rollups, badges, three empty states, the S6 footnote. Default view is **33
events across 14 runs**; with the self-test, **119 across 53**, which the
rollups render as **44 rows** — the 21 identical self-test failures collapse to
one line with a count of 21.

**ACT.3 — the controls** (`56fba1e3c`). Grain switch · multi-select worker and
"what happened" chips · search · Clear · URL state (DT.5) · CSV export of the
whole filtered set. Spine gained `durationMs` / `findingCount`, and
`filters.actor` became **`actors: string[]`** — the open question at the end of
Part 15, now closed. Tests 29 → **34**; agent-fleet suite **341 passing**.

**The Runs grain is the same feed, not a second one.** It filters the timeline
to the two run kinds and draws a DS `DataGrid`. The alternative —
`/agent/fleet/runs` — caps at 100, has no cursor and takes three filters; using
it behind a switch would have quietly reinstated the two-feed shape that Part 3
rejected.

**Unknown actor keys fail CLOSED.** `kind` and `outcome` are validated against
fixed vocabularies and unknown values are dropped (falling back to *no*
filter). Actor keys cannot work that way — they are data, and a W.8 instance
can appear at any time — so an unknown key returns nothing rather than
everything. Asserted by a test, because the two helpers now behave differently
on purpose and that is exactly the kind of asymmetry that gets "tidied" later.

### Six defects found in the browser. None was visible to `tsc`.

1. **"Show older" survived the end of the list** (ACT.2). The cursor was
   `string | null`, which cannot distinguish *not started* from *exhausted*, so
   `cursor ?? page1.nextCursor` fell back to page 1's still-live cursor. The
   page read "Showing 119 of 119" above a button that did nothing.
2. **Multi-select was unreachable from the UI while working perfectly in the
   API** (ACT.3). The chip vocabulary came from the *filtered* response, so
   picking one worker made every other worker's chip vanish — a second worker
   could never be added. Facets now come from a read narrowed only by the
   self-test toggle, which is how Sentry and GitHub facets behave.
3. **The `fleet-sweep` badge printed on top of the next column.** Under
   `table-layout: fixed`, an unsized column takes an equal share of what is
   left; sizing only the prose column left Worker at ~10% and the nowrap badge
   escaped its cell. **Size every column, or none.**
4. **"Filtered — this is not the whole history" showed when only the grain had
   changed** — implying a second, invisible narrowing on top of a button the
   operator could already see was pressed.
5. **"5 events across 0 runs"** — true, and nonsense. Happens the moment a
   filter excludes every run event.
6. **A bare "14" above the runs table.** `GridToolbar`'s `count` slot renders
   the number alone; it now says "14 runs · newest first".

The pattern worth keeping: **every one of these six is a page saying something
untrue or unusable, and not one of them is a type error.** The browser pass is
not polish on this page — it is the only gate that can see them.

### Verified against production, through the read-only stub

`33 → 12 → 20` events as one then two worker chips go on, chips staying
available throughout · `kind=run.ok` → 12 across 12 runs · `q="wasting money"`
→ 5 events, 1 rolled-up row · `?grain=runs` surviving a reload · the grid at
`table-layout: fixed` with **zero** cells overflowing their column and **zero**
page overflow · the export writing **33 data rows across 18 columns**, every
row the same width.

### ACT.7 — the Overview teaser (operator approved question 5, 2026-08-08)

`dffc0efa2`. The Overview's "Decision timeline" card is now **"Latest
activity"**: five events, flat, no paging, and a link out. The checkable
boundary is deliberately trivial to check — **the Overview's fetch is
`?limit=5` and it never sends a cursor or a filter.**

**The part that was not a ten-line edit.** `onOpenPlan` — the "see the plan"
button on a decided approval — scrolled to `#plan-<id>` inside the stream the
Overview no longer renders. Left alone it would have failed **silently**, which
is worse than the duplication being removed. It is now a permalink to
`/fleet/activity#e-plan.<id>`, and Activity honours it.

Making that scroll actually happen took three attempts, none of them visible to
`tsc`, and all three are the same lesson in different clothes — *something else
ran after me*:

1. **The filter-sync effect deleted the hash.** Its no-filters branch replaced
   the URL with `pathname`, dropping the permalink before anything could read
   it. The hash is now captured during the **first render** (a `useRef`
   initialiser runs before any effect), and the URL sync preserves it — a
   permalink should survive someone typing in the search box.
2. **A smooth scroll was cancelled** by the re-render arriving with the first
   fetch.
3. **An instant scroll one frame later was undone** by the router's own scroll
   reset after navigation.

It now scrolls, **checks**, and scrolls again only if something put it back.
Self-correcting beats guessing a delay that is right on this machine and wrong
on a slower one. Worth knowing for every fleet page: **the app scrolls inside
`<main class="overflow-auto">`, not the document**, so `window.scrollY` stays
`0` throughout and makes a working scroll look broken.

Verified: teaser renders five rows with no "show older" · the Overview → "see
the plan" → Activity round trip lands on the right row, highlighted, in the
viewport (`main.scrollTop` 0 → 1008) · after scrolling away, **two full 10s poll
cycles leave the scroll position exactly where the reader put it** — the jump
fires once. Suite 360 passing across 40 files.

### ACT.5 — the drawer (S5, DT.4). The payoff.

Click a row, the run opens: **why it ran** · **step by step** with per-step
time, cost and tokens (the expensive one named in words) · **what it read**,
expandable to the 4,000-character evidence preview · **what it found** ·
**what it cost** · the identifiers to quote at someone. No new backend —
`GET /agent/fleet/runs/:id/trace` has been live since FX.1.

Built as `app/fleet/_shared/RunDetail.tsx` so the worker page can render the
same drawer rather than growing a second one.

**It also repairs a link ACT.7 broke.** Plan rows pointed at
`/fleet#plan-<id>` — an anchor only `TimelineStream` ever drew. Retiring that
component for the teaser left the link pointing at nothing. Plans now open the
shipped `PlanStory` in the same drawer, **imported, never copied**. A critic
verdict opens *the plan it ruled on*, not a trace of the critic's own run —
that is the question the reader is actually asking.

**Spine:** `runId` on every event, so findings, plans, critic verdicts and
approvals all open the run behind them. The drawer is reachable from **119 rows
rather than 53**.

#### The data fact that earned a whole section

`AgentFinding` is upserted on `(charterKey, entityType, entityId, dedupeKey)`,
so a row stays attached to the run that **first** saw the thing. Measured on
production (`_sba-finding-runid.mts`):

| | |
|---|---|
| Findings whose `runId` names a fleet run | **64 of 64** |
| Distinct runs owning any finding | **10** |
| Runs reporting `findingCount > 0` that own **zero** finding rows | **15 of 25** |

So for 60% of the runs that report findings, the trace returns none. Hiding
"What it found" there would leave a row reading *"ran and found 11 things"*
above a drawer that never mentions them — **the page contradicting itself one
click apart.** It now says so instead: *"It reported 11 things, and each had
been seen before — a finding is written down once and kept up to date, so it
stays listed under the run that first spotted it."*

This is the same upsert trap as Part 7 defect 5, met from the other end. It is
worth stating as a rule: **a count stored on a parent row and the child rows
themselves are two different questions, and an upsert makes them disagree.**

Verified in a browser against production: a run owning findings renders all 7
with severities and full rationales · a run whose findings were upserted shows
the explanation · a failed run shows 5 steps and the verbatim schema error ·
evidence expands to its preview · Escape closes · and the 10s poll is **held for
two full cycles** while the drawer is open. Suite 369 across 41 files.

### ACT.4 + ACT.6 — the band, and the teaching gate. **The page is complete.**

**ACT.4** is Part 6 made real. The band answers *is anything wrong now*, not
*what has ever gone wrong*: it obeys the page's filters, excludes the self-test
by default, and today reads **two tiles** — one contract break (red) and one
token limit (amber, blame `nobody`). Tick *include the self-test* and it becomes
**four tiles totalling 26**. While the self-test is hidden the band **says** its
bad afternoon happened, with a link — *excluded, never concealed*, and no quiet
exception when there happens to be one real failure to show.

Counted through **`run-health.classifyFailure`** — the same function the roster
and the worker page call. This page refuses to be the third opinion (Part 7
defect 1), so the spine now hands over the **raw** `errorMessage` /
`haltedReason` and the canonical classifier decides. Never grouped on the error
string: the three credit errors carry distinct `request_id`s, so a group-by on
the message shows four causes where there are two.

**It has its own fetch.** Tallying the loaded rows would have been a silent cap
— with the self-test included only 50 of 119 events are on screen, so the band
would have under-reported by more than half while looking authoritative.

#### The fourth sighting of a bug this repo keeps re-fixing

`!r.ok || r.status === 'failed'` counts a **running** run as failed. An
`AgentRun` is created `ok: false` and only flips true when it *finishes*.
`classifyFailure` has guarded this since W.1, and the locks doc records it
shipped and re-fixed three times in other files — this was the fourth, in the
spine itself, latent only because nothing was in flight while the page was
built.

Runs in flight are now their own kind, **`run.running`** ("X is running now",
neutral, no failure text), with a test rather than my vigilance. And `tsc` then
proved the *client-side* guard unreachable — which is exactly the argument for
moving a check down a layer instead of copying it.

**ACT.6 — the teaching gate.** "How this page works": five paragraphs,
collapsed, last in the reading order because only after seeing rows does a
beginner want the words.

| DT.8 requirement | Result |
|---|---|
| Every control keyboard-reachable | **47 controls, 0 unreachable** |
| Every control named | **0 unnamed** (the one bare input is a checkbox named by its wrapping `<label>`) |
| State never signalled by colour alone | every marker carries screen-reader text; every tile carries a sentence |
| Toggle state exposed | `aria-pressed` on all chips and grain buttons |
| Readable at 200% zoom | **zero** horizontal overflow, nothing escaping its box |
| Every term defined once | `<Term>` throughout; `run` and `selftest` minted for this page |

Two defects found while verifying: every tile printed its count **twice**
("21 21 runs could not reach…"), and the self-test note was gated on there being
no severe failure — quietly suspending *excluded, never concealed* whenever one
real failure existed.

Suite **372 across 41 files**.

---

## PART 17 — Where the page stands

All seven phases are built: **ACT.1** the honest spine · **ACT.2** the list ·
**ACT.3** grain switch, filters, search, URL state, export · **ACT.4** the band ·
**ACT.5** the drawer · **ACT.6** the explainer and teaching gate · **ACT.7** the
Overview teaser.

**Deferred with named triggers, unchanged:** S8 the control-audit lane (build it
the first time an operator moves a dial — `AgentControlAudit` exists and holds
zero rows, and it cannot be backfilled) · S9 compare two runs (when one worker
has ≥10 runs across ≥2 charter revisions) · DT.7 annotation (needs storage that
does not exist) · the P2 backend items in Part 9.

### Prod verification, 2026-08-08 — and the seventeenth defect

Everything above was verified through a read-only stub against the production
*database*. That is not the same as the deployed thing, so the page was then
checked on **live Vercel + Railway**, with real RBAC (the API correctly 401s
without a session).

All seven phases confirmed live: list · grain switch · band · drawer ·
explainer · footnote · teaser. Multi-select against the real API behaves
identically (33 → 12 → 20). The drawer opens a real trace end to end. The
teaching gate holds on prod: **49 controls, 0 unnamed, 0 keyboard-unreachable,
`aria-pressed` throughout, and zero horizontal overflow at 200% zoom.**

**ACT.4b — the defect the live page exposed.** The `Test run` badge this study
promised had **never rendered**, and the reason was worse than the missing
badge: `sourcePhrase` had no case for `mode === 'preview'`, so a run from WF.5's
test lane fell through to its *trigger* and read *"from a person, by hand"* —
byte-identical to a real hand-driven run. **Seven of the fleet's fourteen
business runs are test runs.** Half the page was presenting a rehearsal as work
that had happened.

The badge missed it because it sniffed the source *sentence* for the word
"test". No phrase contained it, so the check was always false — and it was the
wrong check regardless: **prose is for reading; a badge keyed on wording breaks
the day someone improves a phrase.** Fixed at the right level — the spine names
the lane and carries `mode`, the badge reads the fact. On prod the page went
from **0 test-run badges to 8**.

Two things worth keeping from how this was found:

- **A stub proves the logic, not the product.** Every earlier check passed. This
  needed the deployed page.
- **`curl` is not a deployment check for this page.** The markers only exist
  after client render, so grepping the SSR HTML returns zero whether or not the
  build shipped — a monitor built on it would have waited forever. The browser
  is the only valid signal.

**The through-line, and the reason this page took the shape it did.**
Seventeen defects were found on this page. **Not one was a type error.** They were a
paging button that did nothing, a filter that could not be used, a count printed
twice, a badge on top of its neighbour, a sentence reading "0 runs", a scroll
that never moved, a link to a deleted anchor, and a page contradicting itself
one click apart. Every one needed a browser and real data to see. On a page
whose entire job is to tell the truth about what happened, **the browser pass is
not polish — it is the only gate that can see the failures that matter.**

One consequence to note: `TimelineStream.tsx` is now rendered by **nothing** —
Activity has its own list, and the Overview has a teaser. It is left in place
rather than deleted; it belongs to another stream's directory, and whoever does
the SB.2 route move owns that call.

---

## Sources

**Workflow execution history** ·
[n8n — view all executions](https://docs.n8n.io/build/understand-workflows/understand-executions/view-all-executions) ·
[n8n — debug executions](https://docs.n8n.io/build/understand-workflows/understand-executions/debug-executions) ·
[n8n — execution data & pruning](https://docs.n8n.io/hosting/scaling/execution-data/) ·
[Make — incomplete executions](https://developers.make.com/api-documentation/api-reference/incomplete-executions) ·
[Gumloop — run log](https://docs.gumloop.com/core-concepts/run_log)

**LLM & agent observability** ·
[LangSmith — observability concepts](https://docs.langchain.com/langsmith/observability-concepts) ·
[LangSmith — filter traces](https://docs.langchain.com/langsmith/filter-traces-in-application) ·
[LangSmith — threads](https://docs.langchain.com/langsmith/threads) ·
[LangSmith — cost tracking](https://docs.langchain.com/langsmith/cost-tracking) ·
[LangSmith — annotation queues](https://docs.langchain.com/langsmith/annotation-queues) ·
[Phoenix — spans](https://arize.com/docs/ax/observe/tracing/spans) ·
[Phoenix — feedback & annotations](https://arize.com/docs/phoenix/tracing/how-to-tracing/feedback-and-annotations) ·
[Datadog — LLM Observability](https://docs.datadoghq.com/llm_observability/) ·
[Helicone — sessions](https://docs.helicone.ai/features/sessions)

**Job orchestration** ·
[Airflow 3.1](https://airflow.apache.org/blog/airflow-3.1.0/) ·
[Airflow — UI](https://airflow.apache.org/docs/apache-airflow/stable/ui.html) ·
[Airflow — human-in-the-loop](https://airflow.apache.org/docs/apache-airflow/stable/tutorial/hitl.html) ·
[Dagster — run monitoring](https://docs.dagster.io/deployment/execution/run-monitoring) ·
[Dagster — run retries](https://docs.dagster.io/deployment/execution/run-retries) ·
[Prefect — states](https://docs.prefect.io/v3/concepts/states) ·
[Prefect — events](https://docs.prefect.io/v3/concepts/events)

**Audit trails & activity feeds** ·
[GitHub Actions — run history](https://docs.github.com/en/actions/how-tos/monitor-workflows/view-workflow-run-history) ·
[GitHub Actions — re-running](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/re-running-workflows-and-jobs) ·
[CloudTrail — event history](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/view-cloudtrail-events-console.html) ·
[Datadog — audit trail events](https://docs.datadoghq.com/account_management/audit_trail/events/) ·
[Sentry — searchable issue properties](https://docs.sentry.io/concepts/search/searchable-properties/issues/) ·
[Notion — audit log events](https://developers.notion.com/compliance/audit-log-events) ·
[Cloudflare — audit logs v2](https://developers.cloudflare.com/changelog/2025-07-29-audit-logs-v2-ui-beta)

**Agent activity for non-engineers** ·
[LangChain — human-in-the-loop](https://docs.langchain.com/oss/python/langchain/human-in-the-loop) ·
[Glean — background agents](https://docs.glean.com/security/agents/background-agents) ·
[Glean — workflow run logs](https://docs.glean.com/administration/gce-logs/migrating-to-workflowrun-logs) ·
[Decagon — agent operations platform](https://decagon.ai/product/aop)

**In-repo, and load-bearing** ·
`docs/2026-08-07-naf-sb-fleet-pages.md` (the parent map) ·
`docs/2026-08-07-naf-dt-decision-timeline.md` (DT.1–DT.8; §7 is Part 6's
precedent) · `docs/2026-08-07-naf-sbw-workers-page.md` Part 5 (the boundary map
this one answers) · `docs/2026-08-07-naf-sb-session-locks.md` (claims) ·
`apps/api/scripts/_sba-activity-truth.mts` and
`_sba-failure-attribution.mts` (every number in Part 1).
