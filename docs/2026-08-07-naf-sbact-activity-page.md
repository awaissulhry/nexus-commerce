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

---

# PART 18 — S1 REBUILD: the header, the scope line, and the freshness row

**Status: APPROVED by the operator 2026-08-08, and in build.** Two decisions
taken on the study as written:

1. **The rebuild is approved as specified, including the `FleetPageShell`
   `aside` slot** — so the freshness instrument moves into the title row and
   the 1187px of dead header space is used rather than worked around.
2. **§18.7 answered: option (b)** — test runs get their own toggle, exactly like
   the self-test, so hiding them removes them from **both** the count and the
   rows. The toggle itself is an **S3 follow-up**, not part of this engagement;
   S1's half — naming in the scope line whatever is currently hidden — ships
   here. Accepted consequence: once the toggle exists the default headline
   becomes **26 events across 7 runs**.

Stream tag `SB.ACT.S1R`, opened 2026-08-08 against the operator's standing
judgement on the shipped page: *"The UI is way off. It's very odd and
imperfect."* That is about the look, not the data. Parts 1–17 stand: the spine
is honest, the counts are the rows, and seventeen defects were found and fixed.
This part does not re-litigate any of that. It rebuilds the top of the page.

Scope: **S1 only** — the halt banner, `.sba-scope`, `.sba-scopetext`,
`.sba-scopetools`, `.sba-asof`, `.sba-refresh`, and the `FleetPageShell` header
those sit under. S2–S9 are untouched; §18.9 lists what I found in them and left.

---

## 18.0 — What S1 is FOR, in one sentence

> **Say how much history is in front of you, whether anything is still
> arriving, and how fresh this screen is — so an almost-empty page reads as a
> two-day-old fleet rather than a broken page.**

Everything below is judged against that sentence. The current S1 answers the
first clause, half-answers the second, and does not answer the third at all.

---

## 18.1 — What is actually on screen today, measured

Measured in a browser on live Vercel + Railway, 2026-08-08 03:26–03:31 CEST, at
1728×962, against the resolved page background `#f4f6f9`. Every number is
`getComputedStyle` / `getBoundingClientRect`, not a reading of the source.

### The type and colour ladder

| Element | Size / weight | Colour | Contrast |
|---|---|---|---|
| `.acr-head h1` — *Activity* | 20px / 650 | `#1c2530` | 14.30 ✓ |
| `.acr-sub` — the purpose sentence | 13px / 400 | `#667485` | **4.41 ✗** |
| `.sba-scopetext` — the counts | 13px / 400 | `#34404f` | 9.74 ✓ |
| `.sba-scopetext .acr-pg-muted` — *"The newest is at the top."* | 13px / 400 | `#98a2b0` | **2.39 ✗** |
| `.sba-asof` — *"as of 03:25:22"* | 11.5px / 400 | `#98a2b0` | **2.39 ✗** |
| `.sba-refresh` | 12px / 400 | `#4a5867` on white | 7.28 ✓ |

**Four sizes and five greys inside 78 vertical pixels**, and the three that fail
WCAG AA are the three that carry state. The freshness stamp — the one element
whose whole job is to tell you whether to trust the screen — is the least
legible thing on it, at 11.5px and 2.39:1.

The spacing is 4px (title→sub), 18px (sub→scope), 12px (scope→band). Nothing
groups: the reader gets five near-identical lines and has to work out which
two belong together. That is the "wall" in the operator's note, and it is not
a matter of taste — it is measurable as *no size, weight, colour or spacing
step large enough to signal a grouping*.

### The structural finding: the header row is half empty by construction

`.acr-head` is `display: flex; justify-content: space-between` and
`FleetPageShell` gives it **exactly one child**. Measured: the row is **1614px
wide and its only child is 427px**, so **1187px of the header row is dead
space** — on all six fleet pages that use the shell. Meanwhile `as of` and
**Refresh** sit on their *own* row 38px lower, jammed against the right margin,
**1080px away from the sentence they belong to**.

The CSS is not wrong. `.acr-refresh` in `control-room.css` is written to live in
exactly that right slot, and the Control Room uses it. `FleetPageShell`
dropped the slot and the pages grew a second row to replace it. That is the
root cause of "Refresh is a small outline button floating at the right margin
with no relationship to the thing it refreshes" — it *has* no relationship
because the shell has nowhere to put it.

### The sentence the build lost

Part 3 specified the scope line as:

> *119 events across 53 runs, all of it from 6–7 August. **The fleet is
> switched off, so nothing new is arriving.***

What shipped is `ActivityClient.tsx:1215`:

```
{runCount === 0 ? 'Nothing has run yet.' : 'The newest is at the top.'}
```

So the clause that answers *"is anything still happening?"* — the second of
S1's three jobs — was replaced by a restatement of the subtitle, in the lowest
contrast on the page. **"The newest is at the top." is not a leftover; it is
the hole where the liveness answer should be.**

### Three more, found in the browser

1. **The freshness stamp is a bare wall clock with seconds.** `as of 03:25:22`
   on a 10-second poll: the seconds are noise, there is no date, no age, and no
   statement that the page re-reads at all. Nothing on the page distinguishes
   *"read 4 seconds ago"* from *"read at 03:25 and never again"*.
2. **Nothing says the page auto-refreshes.** One fleet page already solved
   this — `workflows/[key]/RoutineClient.tsx:360` prints *"as of 03:25:22 ·
   refreshes every 10s while you watch"*. Six others, Activity included, print
   the stamp alone. The manual button next to a static-looking stamp implies
   the page is static.
3. **The halt banner has never been rendered.** `state.halted` is `false` and
   has always been false (`/agent/fleet/state` today:
   `{halted:false, haltedAt:null, haltReason:null, haltedBy:null,
   dailyCeilingUSD:2, degraded:false}`). Its design is unverified, and it is
   currently placed *below* the title — which both GOV.UK and Atlassian say is
   the wrong place (§18.2).

### Live ground truth, 2026-08-08 03:31 CEST

Read straight off the deployed API with the operator's session:

| | |
|---|---|
| Default view (self-test hidden) | **33 events across 14 runs** |
| `countsByKind` | `run.ok 12 · run.failed 2 · finding.raised 17 · plan.drafted 1 · plan.critiqued 1` — sums to 33 ✓ |
| With the self-test | **119 events**, `run.ok 27 · run.failed 26 · finding.raised 64 · plan.drafted 1 · plan.critiqued 1` — sums to 119 ✓ |
| So the default view hides | **86 events, and says so nowhere in the header** |
| Oldest in scope | `2026-08-06T12:15:40Z` |
| Newest in scope | `2026-08-07T19:45:33Z` — **~32 hours ago** |
| Fleet state | not halted, not degraded, ceiling $2 |
| Charters | **7 of 7 `enabled:false`, all `autonomyLevel:'OFF'`** |
| Scheduled jobs | `fleet-sweep` nightly `45 4 * * *` and `fleet-council` weekly, **both enabled** — last sweep summary `started=6 ok=0 failed=0 skipped=6` |

That last pair is the most useful fact S1 has never printed: **the nightly
sweep does fire, and skips all six workers because every one is switched off.**
The page is not stalled and it is not broken — it is a fleet that is turned
off, and nothing on screen says so.

---

## 18.2 — What the industry does with this exact strip

Six primary sources read for anatomy rather than for principles.

### A · The page header is a fixed anatomy, and ours violates its order

[HashiCorp Helios][helios] specifies the order **breadcrumb → title → icon →
badges → subtitle → description → metadata → actions**, with only the title
required. Two of its rules land directly on us:

- *"Don't use full sentences in the subtitle, use a description instead."*
  Our `.acr-sub` **is** a full sentence, so in Helios terms it is a
  *description*, not a subtitle. That is fine and it stays — but it means the
  page has a description and no subtitle, and the counts line is trying to be
  both.
- Badges are *"for high-priority metadata like the status of the page and
  metadata that is subject to change"*, **maximum three**. Status belongs
  beside the title, not three lines below it in 11.5px grey.
- *"Don't communicate information anywhere other than the top of the page"*
  and, for metadata, no more than four key/value pairs.

[GitHub Primer][primer] independently lands on the same split —
`TitleArea` (LeadingVisual / Title / TrailingVisual) · `Description` ·
`ContextArea` · `Actions` — and puts actions on the right of the title row.
Both systems reserve a right-hand slot on the title line. **Ours exists in CSS
and is unreachable in TSX.**

**Steal:** the right-hand slot on the title row; status as a badge next to the
title rather than a sentence below it; one description, not two.
**Reject:** breadcrumbs (the rail already says where you are), icon tiles, a
second action button. Helios's *"don't pair two primary actions"* is why
Refresh stays the only control in the header.

### B · Freshness: the settled pattern is *status + age + manual refresh, as one object*

[Microsoft Fabric's Real-Time Dashboard][fabric] is the most explicit
specification of this I found, and it is worth quoting because it answers the
operator's "the button implies the page is static" exactly:

- The refresh state is a **named state on a button**, not a timestamp:
  **Live refresh (Enabled)** — tooltip *"Visuals update automatically as new
  data comes in."*; **Live refresh (Paused)** — the button renders
  **with a strike-through**, tooltip *"Visuals don't refresh automatically."*
- *"Each visual displays its last refresh timestamp, so you can quickly assess
  how current the data is. Hover over the timestamp to view additional details,
  such as when the data was last refreshed and when the source was last
  checked."*
- *"To update the data manually, select the **Update** button on the visual at
  any time."* — **manual refresh coexists with auto-refresh and neither
  implies the other is broken**, because the auto state is named on screen.

[Grafana][grafana] — the operator's named reference — makes the same object out
of two parts: a refresh button with an interval dropdown attached to it, and
crucially an explicit **Off** in the dropdown alongside 5s/10s/30s/1m/5m/…/1d
and *Auto*. Grafana's default is **no auto-refresh**, so the picker is how you
learn the page can refresh itself at all. Its lesson for us is not the picker —
we have no interval to choose — it is that **the cadence is stated in the
control, not left to be inferred.**

[Vercel Runtime Logs][vercel] adds the cadence honestly in copy — live mode
*"update[s] every ~5 seconds without clearing existing logs or manual
refreshes"* — and [Datadog Live Tail][datadog] makes live a *mode* you can
pause to inspect something. [Smashing's real-time dashboard survey][smashing]
names the whole thing a **Data Freshness Indicator**: *"shows sync status,
displays the last updated time, includes a manual refresh button"*, and for
degraded reads recommends showing *"cached snapshots from the most recent
successful load, labeled with timestamps such as 'Data as of 10:42 AM'"* — which
is exactly our rule that *"as of" is the last **successful** read*.

**Steal:** sync status + age + manual refresh as ONE bordered object; a named
state (`Live` / `Not updating`) rather than a naked timestamp; the cadence
stated; the last *successful* read.
**Reject:** an interval picker (10s is a house decision, not a setting — *a
control that is not enforced is not rendered*); a countdown to the next refresh
(it makes the reader watch a clock instead of the data); auto-pause on
interaction (Fabric does it; our poll already never re-sorts under the reader,
which is the better fix and is already shipped).

### C · Relative age beats an absolute stamp — with the absolute one kept

[GitHub's `<relative-time>`][reltime] renders *"1 week ago"* over a machine
`datetime`, and [Primer's own accessibility revision][primera11y] adds the
correction worth having: *"The `title` attribute is inaccessible to screen
reader and keyboard users"*, so a `no-title` variant exists for when you supply
your own accessible label. [NN/g][nng] argues the other way for documents —
relative times lose meaning once cached, so print the full date.

Both are right about different things, and the resolution is not a compromise:
**for a screen that is refreshing, the relative age is the live signal and the
absolute time is the record.** A number that ticks 1s → 2s → 3s → back to 0s
*is itself the proof that the page is auto-refreshing* — no tooltip, no
sentence, no badge needed. That is the single strongest argument for the change,
and it is why *"as of 03:25:22"* is the worst possible form: a wall clock is
indistinguishable from a frozen wall clock.

**Steal:** visible relative age, `<time dateTime>` for machines, the absolute
time in an accessible name *and* the `title`.
**Reject:** `title`-only (Primer's objection); seconds precision in the
absolute form (noise at a 10s cadence).

### D · Where a page-level status banner goes

[GOV.UK][govuk] is unambiguous: *"position a notification banner immediately
before the page `h1`"* (below breadcrumbs if any), same width as the page
content, and *"avoid showing more than one notification banner on the same
page… only show the highest priority"*. [Atlassian][atlassian] splits it:
**banners** are *"only for critical system-level messaging"* and sit at the top
of the screen shifting content down; **section messages** sit *above the
affected area*.

Our halt banner sits **below** the title today, which is neither. Two
consequences, and they resolve in opposite directions:

- **The halt is genuinely system-level** — it stops every worker on every page.
  So it goes above the scope line, full content width, styled `acr-banner err`
  (which exists), and it is the only red thing in the header.
- **Only one banner at a time.** If the fleet is halted *and* the last read
  failed, the halt wins and the read failure is expressed only in the freshness
  state. GOV.UK's rule, adopted verbatim.

**Steal:** placement, one-banner-max, content width.
**Reject:** Atlassian's viewport-width app banner — this is a fleet fact on a
fleet page, not an app outage, and the fleet rail is not ours to paint. And
still, per Part 5: **a banner with a link, never a control.**

### E · The "N results" line

The convergent pattern is a scannable count directly above the thing it counts,
which **updates as filters change** so the reader can see the effect of each
filter ([UX Patterns][uxp]: *"Showing 47 results for 'carbon capture'"*).
Sentry, GitHub and Datadog all keep it small, single-line, and immediately
above the list rather than making it a headline number.

**Steal:** one line, right above the content, updating with the filters, and —
the part we currently fail — **naming what has been excluded**.
**Reject:** a tile/KPI treatment of the count. This page has 33 events. A
120px stat card reading "33" would be the editorialising Part 6 forbids, and
Workato's failed-count-first dashboard is already answered by S2's band.

### F · Hierarchy without a bigger font

Both the Linear and Vercel teardowns land on the same mechanic: *hierarchy
comes from spacing and type weight*, on a 4px scale, rather than from a wide
size ladder ([Linear tokens][linear]). This is the direct answer to our four
sizes: **the fix for "four text sizes with no rhythm" is fewer sizes, not
different ones.** Below, the whole block under the title is 13px, and weight,
colour and 4px-grid spacing do all the work.

---

## 18.3 — The proposal

### 18.3.1 The shape

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Activity                                   ┌──────────────────────┬─────────┐ │
│ Everything the fleet has done, newest      │ ● Live · updated 4s  │ ⟳ Refresh│ │
│ first — and every run that tried.          └──────────────────────┴─────────┘ │
│ ───────────────────────────────────────────────────────────────────────────── │
│ 33 events across 14 runs, 6–7 August.  86 more from the self-test are hidden.  │
│ Nothing has happened since yesterday 21:45 — no worker is switched on.         │
└───────────────────────────────────────────────────────────────────────────────┘
   16px
   WHAT NEEDS A LOOK … (S2, unchanged)
```

Three blocks, in the reading order Part 4 already argued for, but now *visibly*
three blocks instead of five loose lines:

1. **Identity** — who this page is. Static, never changes.
2. **A 1px rule.** The only new furniture. It says *above is the page, below is
   the data*, and it gives the freshness control something to be anchored to.
3. **Scope + state** — how much, and is it moving.

The freshness control moves **into the title row's right slot**, which is what
kills the orphan-button problem: it is no longer floating next to nothing, it is
the header's own instrument, on the same line as the page's name.

### 18.3.2 Type, colour, spacing — exact

**Two sizes, not four.** 20px for the title; **13px for everything else in the
block**; 12px only *inside* the freshness control, which is visually separated
by its own border and therefore allowed its own scale.

| Element | Size / weight | Colour | Contrast | Control or label |
|---|---|---|---|---|
| `h1` *Activity* | 20 / 650, `-0.01em` | `#1c2530` | 14.3 | label |
| Description (`.acr-sub`) | 13 / 400 | **`#55616f`** (was `#667485`) | **6.0** | label |
| Scope counts — *33*, *14* | 13 / **600**, `tabular-nums` | `#1c2530` | 14.3 | label |
| Scope prose | 13 / 400 | `#4a5867` | 7.0 | label |
| Exclusion clause + its action | 13 / 400 | `#4a5867`; the action is a text button | 7.0 | **control** |
| State sentence | 13 / 400 | `#6b7684` | 4.9 | label |
| Freshness word | 12 / 550 | per state, all ≥ 4.5 | — | label |
| Freshness age | 12 / 400, `tabular-nums` | `#5b6878` | 5.6 | label |
| Refresh | 12 / 500 | `#4a5867` on `#fff` | 7.3 | **control** |

Every value above 4.5:1. The three current AA failures all disappear, including
`.acr-sub` — fixed **page-locally**, not in the shared sheet (§18.6).

**Vertical rhythm**, 4px grid, top of block to top of S2:

```
h1                             30px line box
  4
description                    19.5px line box
 16
──── 1px rule  #e4e9ef ────    full content width
 14
scope line                     19.5px
  6
state sentence                 19.5px
 16
S2 band
```

The freshness control is `align-self: center` against the two-line identity
block, `flex-shrink: 0`, so a long title wraps and the instrument never does.

### 18.3.3 The freshness control — the specification

One rounded rectangle, `height 30px`, `radius 7px`, `1px #dfe5ec`, white,
split by a `1px #e8edf3` divider into a **readout** and a **button**:

```
 ┌─────────────────────────────┬──────────────┐
 │ ● Live · updated 4s ago     │  ⟳ Refresh   │
 └─────────────────────────────┴──────────────┘
   readout: label                 control
```

- **Readout** — `padding: 0 10px`; a 7px marker; the state word at 12/550; a
  `·`; the age at 12/400 with `tabular-nums` and a `min-width` so the row does
  not jitter as the number counts. Wrapped in
  `<time dateTime={asOf.toISOString()}>` with
  `title` **and** `aria-label` = *"Last successful read 03:25. This page
  re-reads every 10 seconds while you are looking at it."* — the absolute time
  reaches both a mouse and a screen reader, which is Primer's correction.
- **Button** — `⟳ Refresh`, the word kept visible (the operator's standing
  preference is visibility over minimalism, and a bare icon asks a non-engineer
  to guess). Spins `.acr-spin` (already in `control-room.css`) **only** on a
  manual press, never on a poll tick — a spinner every 10 seconds is noise.
- **The age ticks every second.** Its own tiny component with its own 1s
  interval, so the list does not re-render; the counter running 1s → 2s → … →
  0s is the visible proof of auto-refresh, and it is the reason none of this
  needs a sentence explaining that the page refreshes itself.

**The state is derived from the age, never from a flag.** This is the part that
makes it impossible for the indicator to lie:

| Condition | Marker | Word | Age text |
|---|---|---|---|
| `asOf == null` | hollow ring, spinning | Reading… | — |
| `err != null` | filled circle with `×` (red) | Can't read | `last good read 03:25` |
| `age ≤ 30s` | filled circle (green), gentle 2s pulse | Live | `updated 4s ago` |
| `age > 30s` | hollow ring (amber) | Not updating | `last read 03:25` |

Marker **shape** changes with every state as well as colour, and every state
carries a word — so the rule *state is never signalled by colour alone* holds
three times over. `@media (prefers-reduced-motion: reduce)` drops the pulse.

30s is three missed polls. The consequence worth naming: **the drawer holds the
poll (`pollable` throws while a run is open), so after a minute reading a trace
the indicator says "Not updating" — which is true.** No separate "Paused" state
is needed, and deriving from age rather than from a `detail != null` flag means
there is no second source of truth to drift.

### 18.3.4 The scope line — the wording, and the arithmetic behind each clause

```
33 events across 14 runs, 6–7 August.  86 more from the self-test are hidden. [Show them]
Nothing has happened since yesterday 21:45 — no worker is switched on.
```

| Clause | Source | Rule it serves |
|---|---|---|
| `33 events` | `shown.total` | counts and rows are ONE derivation — unchanged from today |
| `across 14 runs` | `countsByKind['run.ok'+'run.failed'+'run.running']` | same response, same read |
| `6–7 August` | oldest and newest loaded event | replaces *"all of it since 6 August"*, which reads as *up to now* |
| `86 more … are hidden` + **Show them** | one extra `limit=1` read without `includeSelfTest=0`, minus `shown.total` | **say what is missing**; *excluded, never concealed*, applied to the count and not only to the rows |
| `Nothing has happened since yesterday 21:45` | age of the newest event in scope | the liveness half of S1's purpose |
| `no worker is switched on` | `/agent/fleet/charters`, count of `enabled` | the *reason*, so the page reads as off rather than broken |

Two deliberate refusals in that table:

- **The `run.running` kind is counted in "runs".** It is a run. Today the count
  is zero and the branch is unexercised, which is exactly when this sort of
  thing gets forgotten.
- **No next-scheduled-run time.** `/agent/fleet/schedule` says `fleet-sweep`
  fires tonight at 04:45Z — but with every worker off it will skip all six, as
  last night's did (`started=6 ok=0 failed=0 skipped=6`). Printing *"next run
  in 3 hours"* would be true and misleading, which is the failure mode Part 6
  exists to prevent. When workers are switched on, the sentence becomes
  *"3 of 7 workers are switched on."* and the next-fire time becomes worth
  adding — at that point, not now.

### 18.3.5 Data: no backend, two extra client reads

| Read | When | Why |
|---|---|---|
| `/timeline?…` | in the 10s poll, as today | counts |
| `/state` | in the 10s poll, as today | a halt is urgent |
| `/timeline?limit=1` (no `includeSelfTest=0`) | once per mount, and on `includeSelfTest` change | the hidden-count clause |
| `/charters` | once per mount, and on manual Refresh | the enabled count |

`/charters` is deliberately **not** in the poll: it returns seven full charter
rows including `systemPrompt`, and the on/off state is only ever changed on
another page — which remounts this one. Manual Refresh covers the second-tab
case. **No new endpoint. No spine change. No migration.**

---

## 18.4 — Every state S1 must render, designed now

Seven, all specified before any of them is built. The freshness control is
listed separately because it is orthogonal to all of them.

| # | State | Scope block renders | Notes |
|---|---|---|---|
| 1 | **Loading** (first read) | `Reading the fleet's history…` at the scope line's exact size, colour and position | `.sba-scope { min-height: 46px }` so the S2 band does not jump when data lands. Skeleton over spinner, per Smashing. |
| 2 | **Normal** | the two lines of §18.3.4 | the everyday case |
| 3 | **Filtered** | `12 events across 4 runs, 6–7 August.` / `Filtered from 33 events.` | **no Clear button here** — S3 owns it and nothing is built twice. Says "filtered" only when `filterCount > 0`, never for a grain change (Part 16 defect 4, preserved). |
| 4 | **Halted** | `acr-banner err` immediately below the rule, above the scope line: **The whole fleet is halted.** {reason} · Stopped by {who} at {when}. · **Open Controls →** | The counts still render below it — they are still true. The *state sentence* is suppressed: the banner is the state. **No stop or resume control**, per Part 5. |
| 5 | **Error / failed refresh** | `acr-banner err`: **Could not read the fleet's history.** {message} · This is the last good read from 03:25. · **Try again** | Moves **up** from below the toolbar to directly under the scope block — a failure to read belongs beside the freshness it invalidates. Freshness reads `Can't read`. |
| 6 | **Stale** (read succeeded, but ≥30s ago) | scope block unchanged | expressed only in the freshness control. No banner: a slow poll is not an error, and treating it as one is how alarms get ignored. |
| 7 | **Zero events** | **(a)** no filters, self-test hidden, hidden count > 0 → `Nothing to show — all 119 events on record came from the self-test.` **[Show them]** · **(b)** no filters, nothing anywhere → `Nothing on record yet.` / `No worker is switched on.` · **(c)** filters on → `No events match. Filtered from 33.` | Today the whole line disappears at `total === 0`, leaving a header with a dangling freshness stamp and no explanation. |

**Halt + error together:** the halt banner shows, the read error does not —
GOV.UK's one-banner rule. The read failure is still visible in the freshness
control, so nothing is concealed.

**Verification of the unreachable states.** Halted, error and zero-events cannot
be produced from real data without changing production. They will be verified by
**intercepting the responses in the browser** (`fetch` shimmed in the page to
return a halted `/state`, a 500, and an empty page) — read-only, nothing
written, nothing enabled. The fleet stays off; agents are default-off by
operator decision and this study does not propose changing that.

---

## 18.5 — What S1 is NOT changing

The boundary, stated so review can hold me to it.

- **Title and description wording** — verbatim from the stub, per Part 0. Only
  the description's *colour* changes.
- **S2** the failure band, **S3** the toolbar, **S4** the list, **S5** the
  drawer, **S6** the footnote, **S7** the explainer — untouched. The band keeps
  its own fetch and its own tiles.
- **The self-test toggle stays in S3.** S1 *names* the hidden count and offers
  one text button that flips the same state; it does not grow a second toggle.
- **No new controls in the header** — no date range (Part 8, still rejected on
  the data), no refresh-interval picker (10s is a house decision, and *a
  control that is not enforced is not rendered*), no saved views, no sort.
- **No approval count**, though two `approval.requested` events appeared and
  vanished during this audit. `/fleet/approvals` owns the queue (Part 5).
- **No percentage of anything.** Part 6 stands.
- **No stop, resume, retry or run-now.** A record is read, not operated.
- **`fleet-pages.css` stays frozen.** All new rules are `sba-*` in
  `activity.css`.

---

## 18.6 — Buildability: two shared-file questions, one of them a real ask

**1 · `apps/web/src/app/fleet/_shell/FleetPageShell.tsx` — an additive
optional prop. This is a claim I need to take.**

```tsx
export function FleetPageShell({ title, sub, aside, children }: {
  title: string; sub: ReactNode; aside?: ReactNode; children: ReactNode
}) {
  …
      </div>
      {aside ?? null}      // ← the right half of a flex row that has been dead on ten pages
    </header>
```

Three lines, no prop renamed, no behaviour changed: the other five pages pass
nothing and render byte-identically. It activates a slot `.acr-head`'s own CSS
(`justify-content: space-between`) has always reserved. Per §3 of the locks
doc — *"Claim, and say what changed. Additive props only."* — this is exactly
the permitted shape, and the claim is registered there with this study.

**2 · `.acr-sub`'s 4.41:1 is fixed page-locally, with no claim.** The value
lives in `control-room.css`, another session's file, and the Workflows stream
has already measured three more shared roles below AA and chosen to override
locally rather than unfreeze a shared sheet. Same choice here — but note the
trap they recorded: **a page-local sheet persists across a client-side route
change**, so the override must be scoped to a page-unique root. `.acr-sub` sits
*outside* `.sba`, so Activity's own `page.tsx` (mine) wraps the shell in
`<div className="sba-page">` and `activity.css` carries
`.sba-page .acr-sub { color: #55616f }`. Nothing leaks to another page, and no
shared file is touched.

**Gates this must clear**

- **DS ratchet** — verified against `scripts/ds-conformance-guard.mjs`: it scans
  `.tsx` only, and matches `fontSize`/hex **inside `style={{…}}`**. No inline
  style objects; every colour and size in `activity.css`. No native `<select>`,
  no `type="date"`. Comments are grepped raw, so none of those tokens appears in
  a comment either.
- **`p3-token-sweep.mjs --check`** — no bare `text-slate-400` /
  `border-slate-200` / `border-slate-100`.
- **Contrast** — re-measured in the browser after the build, at 1728px and at
  200% zoom, with the same script that produced §18.1.
- **`tsc --noEmit` in `apps/web` before leaving any new file on disk**, not
  before committing — §5b of the locks doc, because the tree is shared.

---

## 18.7 — The open operator question, with the numbers

**Test runs are half the fleet's business history and only a badge says so.**

Measured on the live API, 2026-08-08:

| | |
|---|---|
| Default view | **33 events across 14 runs** |
| Of those 14 runs, `mode: 'preview'` (the Workflows test lane) | **7 — exactly half** |
| Real runs | 7 (`ask` 5, `council` 2) |
| Events those 7 test runs produced | **7 — one `run.ok` each, and nothing else** |
| Findings owned by a test run | **0** (all 17 belong to `mode: 'ask'` runs) |
| Plans / critiques owned by a test run | **0** (both belong to the 2 `council` runs) |
| If test runs were hidden | **26 events across 7 runs** |

Part 11 Q4 promised test runs would be *"excluded from headline counts"*. They
are not: the headline says 14 runs, half of which were rehearsals that wrote
nothing. A run that reports *"found 11 things"* and persisted none of them is
counted in the same number as a run that did the work.

Excluding them from the count while leaving them in the list would break the
rule this page exists to keep — **counts and rows are the same derivation** — so
the honest options are:

- **(a) Leave it.** The count stays 14, the badge stays the only distinction.
  Costs nothing, and the headline keeps overstating the fleet's real work by 2×.
- **(b) Give test runs their own toggle, exactly like the self-test.** Hiding
  them removes them from **both** the count and the rows; the scope line names
  what is hidden and offers the way back, the same sentence the self-test gets.

**My recommendation is (b), and the data makes it unusually cheap.** Those 7
test runs own **no** findings, plans, approvals or critiques — hiding them
removes exactly 7 events and orphans nothing, so there is no parent-without-
children problem and no spine restructuring. The filter must be **server-side**
(`?includeTestRuns=0` in `matchesFilters`, mirroring `includeDiagnostic`), for
the same reason ACT.1 gave: filtering in the client would leave `total`,
`countsByKind` and `actors` counting rows the page had already hidden. That is
~10 lines in a file this stream owns, plus a test.

**Where it would be built:** the *toggle* is an S3 control, so if you approve
(b) it ships as a small S3 follow-up, not inside S1. **S1's half — naming what
is hidden in the scope line — ships now either way**, because the self-test
already hides 86 events and the header says nothing about them today.

**One consequence to accept before saying yes:** approving (b) makes the
headline **26 events across 7 runs**. That is the smaller, truer number, and it
is the same trade you already accepted for the self-test at Part 11 Q3.

---

## 18.8 — Build order, if approved

| Step | What | Gate |
|---|---|---|
| **S1.a** | `FleetPageShell` gains `aside`; Activity's `page.tsx` gains the `.sba-page` root; the freshness control moves into the title row | the other five shell pages render unchanged |
| **S1.b** | The `<Freshness>` component — 1s ticker, four age-derived states, `<time>` + accessible absolute, manual-only spin | leave the tab, return, watch the state; open the drawer for a minute, watch it go to *Not updating* |
| **S1.c** | The scope block — rule, two lines, counts at 600/tabular, the hidden-count clause and its **Show them** | counts still equal the rows; the clause matches `119 − 33` |
| **S1.d** | The seven states, including the three that need a shimmed response | each one screenshotted |
| **S1.e** | Prod verification on live Vercel + Railway; contrast and 200%-zoom re-measured | the §18.1 table re-run, every row ≥ 4.5 |

`curl` is not a check for any of this (Part 17): the classes only exist after
client render.

---

## 18.9 — Found while auditing S1, belongs to another section, LEFT ALONE

**The filter chips are frozen at first paint, and were displaying four events
that no longer existed.** Caught live at 03:31: the scope line read *33 events
across 14 runs* while the chips read `Ran fine 14 · Run failed 2 · Noticed
something 17 · **Asked permission 2** · Drafted a plan 1 · Plan reviewed 1` —
**37**, including a whole category with zero rows. A sibling session created two
fleet approvals and two runs at 03:24 and cleaned them up minutes later; the
scope line followed the data down from 37 to 33, and the facets did not, because
their `useEffect` depends only on `[backend, includeSelfTest]` and never re-runs
on the poll (`ActivityClient.tsx:973-988`).

So: **S1's count is honest and S3's chips are stale**, and for a few minutes the
page disagreed with itself by four events across two elements 60px apart. That is
the exact class of bug this page exists not to have — and it is S3's, so it is
recorded here and not touched. It wants the facet read moved into the poll, or a
cheap `total` comparison to invalidate it.

Second, smaller: **the first fleet approval events in the fleet's history
appeared during this audit** — `approval.requested` from `amazon-bid-tuner`,
`high risk`, *needs a look*. §5 decision 8 of the locks doc records that the
fleet *cannot* queue an approval at all. Whatever produced these, the Approvals
stream will want to know the path was exercised on production at
2026-08-08T03:24Z, and that the rows did not survive.

---

## 18.10 — Sources

[helios]: https://helios.hashicorp.design/components/page-header
[primer]: https://primer.style/components/page-header
[primera11y]: https://github.com/primer/design/commit/f3524f71e053bf2d3ba61defe09703572d322ab4
[reltime]: https://github.com/github/relative-time-element
[fabric]: https://learn.microsoft.com/en-us/fabric/real-time-intelligence/dashboard-live-refresh
[grafana]: https://grafana.com/docs/grafana/latest/dashboards/use-dashboards/
[vercel]: https://vercel.com/changelog/improved-live-mode-in-runtime-logs
[datadog]: https://docs.datadoghq.com/logs/explorer/live_tail/
[smashing]: https://www.smashingmagazine.com/2025/09/ux-strategies-real-time-dashboards/
[govuk]: https://design-system.service.gov.uk/components/notification-banner
[atlassian]: https://atlassian.design/components/banner
[nng]: https://www.nngroup.com/articles/113-design-guidelines-homepage-usability/
[uxp]: https://uxpatterns.dev/patterns/advanced/search-results
[linear]: https://designmd.cc/benchmarks/linear

**Page header anatomy** ·
[HashiCorp Helios — Page Header][helios] ·
[GitHub Primer — PageHeader][primer] ·
[Primer — RelativeTime a11y revision][primera11y] ·
[Linear design tokens & type scale][linear]

**Freshness, live and paused** ·
[Microsoft Fabric — Live refresh in Real-Time Dashboard][fabric] ·
[Grafana — use dashboards (refresh picker)][grafana] ·
[Vercel — improved Live Mode in Runtime Logs][vercel] ·
[Datadog — Live Tail][datadog] ·
[Smashing Magazine — UX strategies for real-time dashboards][smashing]

**Timestamps** ·
[github/relative-time-element][reltime] · [NN/g — homepage usability, dating content][nng]

**Status banners** ·
[GOV.UK Design System — notification banner][govuk] ·
[Atlassian Design System — Banner][atlassian]

**Result counts** · [UX Patterns for Developers — search results][uxp]

**In-repo, measured** · live Vercel + Railway at 1728×962, 2026-08-08 03:26–03:35 CEST ·
`apps/api/scripts/_sba-closeout.mts` · `GET /api/agent/fleet/{timeline,state,charters,schedule}`

---

## 18.11 — S1R execution record (2026-08-08)

**Shipped in `7de406df1`.** `+1776 / −402` across six files: the shell's `aside`
slot, `ActivityClient.tsx`, `activity.css`, `page.tsx`, the verification stub,
and this study.

| File | What |
|---|---|
| `app/fleet/_shell/FleetPageShell.tsx` | `aside?: ReactNode` as the header's second flex child. Claim taken and released in locks §3; the other five shell pages pass nothing and render byte-identically |
| `app/fleet/activity/ActivityClient.tsx` | `<Freshness>` · the scope block and its seven states · both banners moved · `FleetPageShell` moved into the client (the instrument needs client state, so a server component cannot pass it) |
| `app/fleet/activity/activity.css` | the whole S1 block rewritten; `.sba-asof`, `.sba-refresh` and `.sba-banner` deleted |
| `app/fleet/activity/page.tsx` | the `.sba-page` root that scopes the page-local overrides |
| `apps/api/scripts/_sba-stub.mts` | `/charters`; `STUB_HALT` / `STUB_FAIL` / `STUB_EMPTY=1\|selftest`; real CORS |

### Measured on live Vercel + Railway, 1728×906

| §18.1 defect | Before | After |
|---|---|---|
| Distinct font sizes in S1 | 4 (20 · 13 · 12 · 11.5) | **3** (20 · 13 · 12), and 12px only inside the bordered instrument |
| WCAG AA failures | **3** — 2.39 · 2.39 · 4.41 | **0**; worst is 5.00 |
| Freshness stamp | `as of 03:25:22`, 11.5px, 2.39:1 | `● Live · updated 5s ago`, ticking, 5.68:1 |
| Dead space in the header row | **1187px** | **0** — instrument right edge flush with the content edge |
| Distance from Refresh to its subject | 1080px | in the same bordered object as the readout |
| "is anything still happening?" | unanswered | *"Nothing new for 7 hours — no worker is switched on."* |
| What the default view hides | unstated | *"86 more from the self-test are hidden. **Show them**"* |
| Halt banner | never rendered | verified, under the title block, `Open Controls →` right-aligned |

**States verified against the production database**, all seven: loading ·
normal · filtered (`8 events across 3 runs … Filtered from 33.`) · halted ·
failed refresh · stale · zero events, both branches. The three that real data
cannot produce were simulated **read-only in the stub** — nothing written, no
charter enabled, production untouched.

**Live on prod:** `Live → Not updating → Refresh → Live · updated 2s ago`;
header `33 events across 14 runs` above footer `Showing 33 of 33`; tick the
self-test and both move to 119 together (86 + 33 = 119); runs grain + one worker
chip reads `3 runs` above a grid of 3. Three S1 controls, none unnamed, none
keyboard-unreachable; no horizontal overflow; at a 652px content width the
instrument wraps below the title instead of crushing it.

### Four defects found in the browser. None was visible to `tsc`.

1. **A failed FIRST read left an empty paragraph** where the sentence belongs —
   `shown` null, `loading` false, so every branch was false and the block
   silently grew a 19.5px gap. The `<p>` is now rendered only when it has
   something to say.
2. **"Nothing new for 2 minutes"** — a strange thing to say two minutes after
   something happened; it reads as a complaint about a page that is working.
   Under a quarter of an hour the same fact is now phrased as news. Found by
   watching a sibling session run the bid tuner live.
3. **`#6b7684` measures 4.26:1 on this page.** It passes against white and
   fails against the `#f4f6f9` it actually sits on — which is the argument for
   measuring every colour *in place* rather than on paper.
4. **`.sba-inlinebtn` was 4.40:1**, just under the floor, and S1's *Show them*
   is one of them. Darkened to 5.40; S2 and S4's uses get it too.

**One environment trap worth banking**, because it cost twenty minutes and
looked exactly like a code defect: browsing the dev server at **`127.0.0.1`
instead of `localhost`** makes Next refuse its own dev resources
(*"Blocked cross-origin request to Next.js dev resource"*), so the page
server-renders and **never hydrates** — no effects, no fetches, no React fibers
on the DOM, and a header frozen on *Reading…* with a clean console. And a
Chrome-side sibling: `localhost:3010 → 127.0.0.1:8099` is blocked by Private
Network Access even with `access-control-allow-origin: *`. The stub now echoes
the origin, answers the preflight and sends
`access-control-allow-private-network`. **Use one hostname for both ends.**

### The through-line, unchanged and now at 21

Twenty-one defects have been found on this page. **Not one has been a type
error.** Four more today: an empty paragraph, a sentence that reads as a
complaint, and two colours that pass on paper and fail on the page.

---

# PART 19 — S2 REBUILD: "What needs a look"

**Status: STUDY ONLY. Nothing is built. Needs operator approval.**

Stream tag `SB.ACT.S2R`, opened 2026-08-08, inheriting the type scale, rhythm
and page-local root that Part 18 established. Scope: **S2 only** — `.sba-needs`,
`failureTally()`, `CLASS_ORDER`, `tileSentence()`, the band's own `failures`
fetch, the tiles, the all-clear line and the self-test note. S1 is done; S3 and
below are untouched, and §19.8 lists what I found there and left.

**No shared file is touched and no claim is needed.** `run-health.ts` is the
Workers stream's and S2 only *reads* `classifyFailure` — the blame wording is
presentation and stays here. No backend, no new endpoint, no migration.

---

## 19.0 — What S2 is FOR, in one sentence

> **Tell the operator whether anything needs them to do something — before they
> read a single row — and when nothing does, say so plainly enough to be
> believed.**

The question it answers is **"do I need to act?"**, and the answer has to be
trustworthy in *both* directions. A band that cries wolf gets ignored; a band
that goes quiet when it simply could not find out is worse, because silence
here means *all clear*.

---

## 19.1 — What is actually on screen today, measured

Live Vercel + Railway, 2026-08-08, 1728×906, against the resolved `#f4f6f9`.
Raw run data from `apps/api/scripts/_sba-s2-band.mts` (new, read-only) and
`_sba-closeout.mts`.

### The correctness defects — these are not cosmetic

**1 · A tile that says 1 produces a list of 2. Measured, not inferred.**
Clicking the tile reading *"**1** run produced an answer that did not match the
format it promised"* leaves the scope line reading **"2 events across 2 runs"**
above a list of two rows — *Bid tuner tried to run, and failed* and *Negative
miner tried to run, and failed*. The tile's `onClick` writes the event kind
`run.failed`, which is **class-agnostic**; the tile's count is **per class**.
So the band's number and the list the band produces are two different
derivations. **This is the exact bug the whole page exists not to have**, and it
is sitting in the section whose job is to be believed.

**2 · Every tile reports itself pressed when any one is clicked.** After the
single click above, **both** tiles carry `aria-pressed="true"` — because the
attribute is `kinds.includes('run.failed')`, one shared value. A screen reader
is told two filters are applied when the operator applied one.

**3 · That pressed state is invisible to everyone else.** There is no
`[aria-pressed="true"]` rule anywhere in `activity.css`. The state is announced
and never drawn — the inverse of the usual WCAG 1.4.1 failure, and just as
broken: the control has a state the sighted operator cannot see at all.

**4 · The band says "nothing has failed" when it has not yet asked, and when it
failed to ask.** `failures` initialises to `[]`, so `tally.length === 0` and the
green all-clear renders on first paint — verified during the S1 pass, where the
very first screenshot of a still-loading page read *"✓ Nothing has failed in
what you are looking at."* And the fetch's error path is
`.catch(() => { /* the list's error banner covers a dead endpoint */ })`, which
leaves `failures` empty — so **a failed check renders as an all-clear**. On a
band whose silence means *all clear*, an un-asked question and a green tick are
the same pixels.

**5 · A green tick for "I don't know."** When failures are filtered out of
scope the same `.sba-allclear` element renders — `color: #14764f`, with a
`<Check>` icon — saying *"Failures are filtered out of this view."* That is a
green success marker on a statement that no judgement was possible.

### The staleness problem, which is the reason Part 6 exists

| | |
|---|---|
| Business failures in scope | **2** |
| When | `2026-08-06T12:15:40Z` and `2026-08-06T12:16:32Z` — **two days ago** |
| Runs since the newest failure | **12** |
| Failures among those 12 | **0** |

The band today says *"what needs a look"* about a situation that stopped
happening two days and twelve runs ago. Part 6 rule 1 is explicit —
***"S2 answers 'is anything wrong now', not 'what has ever gone wrong'"*** — and
predicted the band would read *"Nothing has failed in the fleet's last 14
runs."* **The study and the shipped section disagree with each other**, and the
shipped one is the one the operator is looking at.

### The self-test note explains 21 of 24 failures and mis-attributes 3

Measured (`_sba-s2-band.mts`): **24** self-test failures spanning **249
minutes**, not one window —

- **21 × `fetch failed`**, `08:44:49Z → 08:50:45Z` — **5m56s**, the model server
  restarting. The study's "six-minute window" is correct *for these 21*.
- **3 × `Anthropic API error 400 … "Your credit balance is too low to access the
  Anthropic API"`**, at `04:50:15Z`, `08:56:37Z`, `08:59:19Z` — four hours
  apart, and a **billing** fact, not a model-server restart.

The note on screen — *"a run of failures in six minutes when its model server
restarted"* — is one explanation covering 21 of 24, silently wrong about 3.
And the window is `04:50–08:59Z`, i.e. **06:50–10:59 local: a morning**, not the
*"bad afternoon"* both the note and the study call it.

Worth recording while we are here: those three errors carry **distinct
`request_id`s** (`req_011CdmDiDZC2…`, `req_011CdmDWHbwT2…`,
`req_011Cdktigtn…`). A group-by on the message string renders three causes where
there is one — the live proof of the never-group-on-the-string rule, which the
current code correctly obeys.

### The visual defects, with numbers

| | Measured | Should be |
|---|---|---|
| `.sba-needs h3` — *WHAT NEEDS A LOOK* | 12px/600, **4.05:1** | ≥ 4.5:1 |
| `.sba-needsnote` — the self-test note | 11.5px, **2.73:1** | ≥ 4.5:1 |
| Font sizes S2 introduces | **18px** (tile number) and **11.5px** (note) | S1's ladder is 20 · 13 · 12 |
| Tile boxes | **343×52** and **300×52** for two one-line facts; the first **wraps to two lines** because the number and the sentence share a 34ch line | — |
| The band's ground | **none** — no border, no background, floating between S1's bordered instrument and the toolbar's card | — |
| Heading treatment | 12px uppercase letterspaced grey — **shared with nothing else on the page** since S1 changed | — |

So S2 undoes two of S1's three fixes: it puts back the 11.5px size S1 deleted
and re-introduces a sub-AA grey, in the section that is supposed to be the most
trustworthy thing above the fold.

**And the all-clear replaces the tiles entirely**, so the section changes
*shape* rather than *state* — the reader cannot tell "this is the same panel
reporting good news" from "a different thing is here now".

---

## 19.2 — What the industry does

### A · Alarm fatigue is a solved problem, and the solution is a rule about novelty

[Google's SRE book][sre] is the canonical source and it is unusually blunt.
Its five questions for any alert include the two that decide our design:

> *"Will I ever be able to ignore this alert, knowing it's benign? When and why
> will I be able to ignore this alert?"*

> *"Does this alert definitely indicate that users are being negatively
> affected?"*

and its four principles include:

> *"Every page should be actionable."* · *"Pages should be about a novel problem
> or an event that hasn't been seen before."* · *"Pages with rote, algorithmic
> responses should be a red flag."*

Our band today fails *novelty* exactly: a contract break from 6 August, already
understood, followed by twelve clean runs, is not a novel event. [incident.io's
survey][io] puts the same rule in operational terms — *"A CPU alert that fires
every night during a scheduled batch job is not an alert. It is scheduled
noise"* — and gives a benchmark worth quoting in review: *"If your
alert-to-actionable-incident conversion rate sits below 20%, you have a noise
problem. Your target operating range is 30–50% actionable."* Two tiles, neither
actionable, is 0%.

**Steal:** the novelty test, applied to the *headline* rather than to what is
listed. **Reject:** suppression. SRE can drop an alert; a record cannot drop a
row (Part 0: *a record must be complete*). The resolution is in §19.3.

### B · Age is a state, not a filter — Sentry

[Sentry's issue states][sentry] are the closest working model: **New** (created
in the last 7 days) → **Ongoing** (older than 7 days, *or* manually reviewed) →
**Escalating** / **Regressed** / **Archived** / **Resolved**. Archiving moves an
issue *"out of the issue stream and pause[s] alerts on it until the issue gets
worse"*, and the **escalating** algorithm resurfaces it automatically when
*"events in that issue significantly increase over a short period"*.

The lesson is not the seven days. It is that **an issue that stopped happening
changes state without being deleted, and comes back on its own if it recurs.**

**Steal:** exactly that. **Reject:** the calendar. This fleet ran 51 of its 53
runs because a human pressed a button, so "7 days old" says nothing;
"12 runs have run since, all clean" says everything. Part 6 already uses that
phrasing.

### C · The all-clear persists, and it is the headline — Statuspage

[Atlassian Statuspage][sp] computes a single top-level status from its
components, and when everything is fine the page reads **"All Systems
Operational"**: *"If all components have a status of 'Operational', top-level
status will read 'All Systems Operational.'"* The status area is shown *during
normal operation* — the all-clear is the product's most-viewed state, not an
empty state.

**This answers open question 2: the section stays.** A section that vanishes
when things are fine can never be trusted to appear when they are not — the
operator cannot distinguish "nothing is wrong" from "that thing is broken
again". **Steal:** persistence, and one named status as the headline.
**Reject:** the seven-value vocabulary; we have two severities.

### D · "Wrong now" and "went wrong" are different surfaces — Datadog

[Datadog][dd-list] keeps a **Triggered Monitors** page separate from the monitor
list: *"This page only shows monitors with a triggered status (Alert, Warn, or
No Data)"*, filtered on `group_status` and on `triggered` — *how long they have
been triggered*. Duration is a first-class filter, because how long something
has been wrong is the decision.

Its [Monitor Summary widget][dd-sum] is the closest thing to our tiles, and two
of its options are instructive: **`Hide empty Status Counts`** — *"only shows
the Status Counts for statuses that have more than zero monitors"* — and a
choice of applying colour to **text or background**. Both are deliberate
decisions we currently make by accident.

**Steal:** never render a zero-count class (we already don't); duration as part
of the statement; colour on text rather than flooding a whole card.
**Reject:** a second page. Activity is one list by operator decision (Part 3).

### E · Summary-above-list earns its place only by answering a different question

The convergent dashboard guidance is that a summary earns its space when it
answers something the table below cannot at a glance, and that working memory
handles 5–9 elements before cognitive load bites. Ours passes the test — *"is
anything wrong?"* is not answerable by scanning 21 rows — but it currently pays
for it in the wrong currency: **two 52px cards, 343px and 300px wide, for two
one-line facts.** At this volume the summary is physically heavier than the
thing it summarises.

**Steal:** keep the summary, spend far less on it. **Reject:** KPI-tile
treatment. A big number is for a metric you track over time; a count of two
failures is a sentence.

### F · Severity without colour — the normative rule

[WCAG 1.4.1][wcag] requires that colour is never the only visual means of
conveying information; the accepted techniques are *icons, text labels,
patterns, shapes*. Today the tile classes carry `border-color` + `background`
and the count and label carry the meaning — so 1.4.1 is *arguably* met by the
words. But `aria-pressed` has **no** visual counterpart at all, which is a plain
failure, and the severity difference between `severe` and `mild` is carried by
two pale washes (`#fdf6f5` vs `#fffaf1`) that are nearly indistinguishable.

**Steal:** shape per severity, plus the blame in words. **Reject:** relying on
the tint difference. S1's four-state marker (filled disc / ring / square /
spinner) is the in-house precedent and it works.

### G · What these products deliberately leave out

- **Statuspage** shows no history on the status line — incidents live below it.
- **Datadog's summary widget** hides zero-count statuses rather than showing a
  row of noughts.
- **Sentry** does not show a percentage anywhere in the issue stream header.
- **Google SRE** explicitly refuses to page for anything with a rote response.
- None of them puts a **proportion** on a triage surface. Which is convergent
  with Part 6's absolute rule, arrived at from the opposite direction: ratios
  over a small, skewed population are not decision-grade. **S2 renders no
  percentage, and the design below has nowhere to put one.**

---

## 19.3 — The proposal

### 19.3.1 Form: one status panel, not a grid of tiles

The band becomes **one bordered card with a stated status**, in the same idiom
as S1's freshness instrument: a marker, a headline, a qualifying line, and —
only when there is something to list — one line per failure class.

**Today's real state** (2 settled failures, 12 clean runs since):

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ✓  Nothing is failing now                                                  │
│    2 runs failed on 6 August, and the 12 runs since have all been clean.    │
│                                                                            │
│    ✕  1 run   produced an answer that did not match the format it promised │
│               the worker itself · 6 August                                 │
│    ⚠  1 run   stopped part-way at one of its own limits                    │
│               a limit doing its job, nobody's fault · 6 August              │
│                                                                            │
│    [ Show these 2 runs ]                                                   │
│    The self-test is hidden. It failed 24 times on 6 August — 21 in six      │
│    minutes when its model server restarted, and 3 when the AI account was   │
│    out of credit. Neither was ever about your Amazon account. Show me       │
└────────────────────────────────────────────────────────────────────────────┘
```

**Something actually failing now:**

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ✕  2 runs need a look                                                      │
│    The newest run failed.                                                  │
│    …rows…                                                                  │
│    [ Show these 2 runs ]                                                   │
└────────────────────────────────────────────────────────────────────────────┘
```

Three things change character:

1. **The headline is about NOW; the rows are about WHAT.** Green tick above a
   red row is not a contradiction, it is the two questions answered separately
   and reconciled by the line between them. Nothing is hidden, nothing is
   filtered — the recency is a **qualifier**, never a predicate, so *counts and
   rows stay one derivation*.
2. **The rows stop being controls.** They are labels. This is what fixes
   defect 1 honestly: a per-class filter does not exist server-side, so a
   per-class control can only ever produce a list that disagrees with it.
3. **There is exactly one control**, and it is labelled with the number it
   actually produces: *"Show these 2 runs"* writes `run.failed` and yields 2
   rows. Count and consequence match by construction.

### 19.3.2 The recency rule, stated so it cannot drift

> **Nothing is failing now** ⟺ **the newest run in scope succeeded.**

Binary, derived from data already fetched, no threshold to tune and no calendar
to argue with. The qualifying line then states the evidence: *"N runs failed on
{date}, and the {M} runs since have all been clean."*

`M` = runs in scope newer than the newest failure. Today M = 12, and the band's
own fetch already returns what it needs; `M` comes from the same
`countsByKind` the scope line uses.

Rejected alternatives, both worse: a **7-day window** (meaningless on a fleet
whose runs are 51/53 manual) and **hiding settled failures** (breaks Part 0's
completeness rule and re-creates the disagreement in defect 1).

### 19.3.3 Type, colour, spacing — inheriting S1

**Two sizes, both already on the page: 13px and 12px.** The 18px number and the
11.5px note both go. Hierarchy is weight and colour, as S1 established.

| Element | Size / weight | Colour | Contrast on `#fff` card | Control or label |
|---|---|---|---|---|
| Headline | 13 / 600 | per state, all ≥ 4.5 | — | label |
| Qualifying line | 13 / 400 | `#5b6878` | 5.6 | label |
| Row count — *1 run* | 13 / 600, `tabular-nums` | `#1c2530` | 15.6 | label |
| Row label | 13 / 400 | `#4a5867` | 7.3 | label |
| Row meta — blame · date | 12 / 400 | `#606b79` | 5.3 | label |
| The one action | 12 / 500 | `#2f61c0`, and pressed state below | 5.9 | **control** |
| Self-test note | **13** / 400 (was 11.5) | `#606b79` | 5.3 | label + one inline control |

Card: `1px #dfe5ec`, radius 8, `#fff`, padding `12px 14px`. In the severe state
the border becomes `#e6bcba` and the ground `#fdf6f6` — the **card**, once,
rather than each tile. Spacing on S1's 4px grid: 8px headline→qualifier, 12px
qualifier→rows, 6px between rows, 12px rows→action.

**Severity encoding, three signals deep:** shape (`✕` filled square / `⚠`
triangle / `✓` disc), colour, and the **blame in words** on every row —
*"the worker itself"*, *"a connection problem, not this worker"*, *"the AI
account"*, *"a limit doing its job, nobody's fault"*. Derived from
`classifyFailure().blame`, so it cannot drift from the classification.

### 19.3.4 The one control, and how "applied" reads

A single toggle, and it is a real toggle — pressing it again removes the filter,
so the band is never a dead end that only S3's *Clear* can undo.

| | Label | `aria-pressed` | Visual |
|---|---|---|---|
| not applied | `Show these 2 runs` | `false` | outline button |
| applied | `✓ Showing only failed runs` | `true` | **filled**, darker ground, tick glyph, 1px inset ring |

Pressed is carried by fill **and** a tick **and** the changed word — never by
colour alone, and never (as today) by nothing at all.

### 19.3.5 The heading goes

`<h3>WHAT NEEDS A LOOK</h3>` in 12px uppercase 4.05:1 grey is an orphaned
treatment and a redundant label: the headline sentence already says what the
panel is. The `<section>` keeps an `aria-label`, which makes it a named region
landmark — **more** navigable for a screen reader than a visually-tiny heading,
not less. Statuspage's precedent: the status *is* the label.

---

## 19.4 — Every state, designed now

| # | State | Marker | Headline | Under it |
|---|---|---|---|---|
| 1 | **Checking** (band's own first fetch in flight) | spinner ring | `Checking what needs a look…` | nothing. **Never the all-clear** — today this is a green tick over an unasked question |
| 2 | **Nothing has ever failed in scope** | ✓ green disc | `Nothing has failed in what you are looking at.` | self-test note if hidden |
| 3 | **Settled** — failures exist, newest run succeeded *(today)* | ✓ green disc | `Nothing is failing now` | `2 runs failed on 6 August, and the 12 runs since have all been clean.` + rows + action |
| 4 | **Failing now, severe** | ✕ red square | `{N} runs need a look` | `The newest run failed.` + rows + action. Card border/ground go red |
| 5 | **Failing now, only a limit** | ⚠ amber triangle | `One run stopped at its own limit` | `That limit worked — nothing is broken. Raise it, or accept the shorter answer.` Card amber. **Never red** |
| 6 | **Failures filtered out of scope** | ○ neutral hollow ring | `Failures are hidden by your filters, so this cannot say.` | no tick, no green — this is *unknown*, not *fine* |
| 7 | **The band's own check failed** | ! amber square | `Could not check what needs a look.` | `{error}. The list below is unaffected — press Refresh to try again.` Never renders as all-clear |
| 8 | **Self-test hidden** (overlays 1–7) | — | — | the corrected note (24 failures · 21 in six minutes · 3 out of credit) + `Show me` |
| 9 | **Self-test shown** | — | — | note absent; the band counts all 26 and the headline follows the same recency rule |

States 1, 6 and 7 are the three the current band renders as a green tick.

**Verification of the unreachable ones:** states 4, 5 and 7 cannot be produced
from real data (nothing is failing now, and the API is healthy). They will be
simulated **read-only in the stub**, as S1's were — `STUB_FAIL_BAND=1` for the
band's fetch, and a mode that back-dates/forward-dates the newest run so
"settled" flips to "failing now" without writing a byte. Nothing is written, no
charter is enabled, production is untouched.

---

## 19.5 — Open question 1: does a failed TEST run need a look?

**Measured:** `mode=preview` runs that have ever failed = **0 of 26**. Both
current business failures are `mode=ask`. The case is entirely unexercised, so
this is a rule to set before it fires rather than a bug to fix.

**Recommendation — two clauses, both cheap:**

1. **Scope follows the page.** If a test run is visible in the list, its failure
   is counted in the band; when the §18.7 test-run toggle hides them, they leave
   *both*. This needs no new rule and no new code — it falls out of the band
   sharing the page's filters, and it keeps counts and rows identical by
   construction.
2. **A failing test run never turns the headline severe.** It appears as a row,
   badged `test run`, and the headline's severity ignores it. A rehearsal that
   wrote nothing is not a production problem, and Part 6's whole lesson is that
   raising an alarm about something which was never about the operator's account
   spends trust that the next alarm needs.

So: **counted, listed, badged — never the reason the panel turns red.** One
condition in the severity derivation, and a test alongside it, because zero
occurrences is exactly when a rule gets forgotten.

## 19.6 — Open question 2: does the section stay when nothing is wrong?

**Yes, and it shrinks to one line.**

Statuspage's all-clear is the most-viewed state of the product, not an empty
state. The argument that decides it is not aesthetic: **a section that
disappears when things are fine can never be trusted to appear when they are
not.** The operator who sees nothing cannot distinguish *nothing is wrong* from
*that panel is broken again* — and this page's entire currency is that its
silence can be believed. The same reasoning is why the self-test note renders
whenever the self-test is hidden rather than only when the band is empty
(ACT.6's own correction).

At zero it costs **one line**: marker, sentence, and the note if the self-test
is hidden.

---

## 19.7 — The boundary

**Against S1, above.** S1 says how much history there is and whether the page
and the fleet are alive. S2 says whether any of it needs action. S2 counts
**runs**, never events, so its number can never be mistaken for S1's. S2 renders
no freshness of its own — one instrument per page.

**Against S3, below.** S3 owns the chips, *Clear*, the search box, the grain
switch and the self-test toggle. **S2 writes exactly one filter value
(`run.failed`) through exactly one toggle, and reads the filter state to render
that toggle.** It adds no chip, no second *Clear*, no date control, and it does
not touch the frozen-facets bug (§18.9) — that is S3's and it stays S3's.

**Against everything else.** No link to Workers or Controls: a failure *class*
is not a worker, and a run detail is one click away in the list already. No
retry, no re-run. No percentage, ever. No spend figure — `/fleet/cost` owns
money.

---

## 19.8 — Found while auditing S2, belongs elsewhere, LEFT ALONE

1. **`.acr-pg-chip` has no measured contrast audit.** S3's chips are next in
   line and the Workflows stream has already published three sub-AA shared
   roles; whoever takes S3 should re-measure rather than assume.
2. **The frozen facet chips (§18.9) are still live.** Untouched, as instructed.
3. **`AgentRun.status === 'running'` has still never occurred** (0 rows), so
   both the spine's `run.running` kind and `classifyFailure`'s running guard
   remain unexercised against real data. Worth one deliberate exercise the day
   a worker is switched on.

---

## 19.9 — Sources

[sre]: https://sre.google/sre-book/monitoring-distributed-systems/
[io]: https://incident.io/blog/sre-alerting-best-practices
[sentry]: https://docs.sentry.io/product/issues/states-triage/
[sp]: https://support.atlassian.com/statuspage/docs/top-level-status-and-incident-impact-calculations/
[dd-list]: https://docs.datadoghq.com/monitors/manage/
[dd-sum]: https://docs.datadoghq.com/dashboards/widgets/monitor_summary/
[wcag]: https://www.w3.org/TR/UNDERSTANDING-WCAG20/visual-audio-contrast-without-color.html

**Alerting and alarm fatigue** ·
[Google SRE — Monitoring Distributed Systems][sre] ·
[incident.io — SRE alerting best practices][io]

**Triage state models** ·
[Sentry — issue states and triage][sentry] ·
[Datadog — monitor list and Triggered Monitors][dd-list] ·
[Datadog — Monitor Summary widget][dd-sum]

**The all-clear** ·
[Atlassian Statuspage — top-level status calculation][sp]

**Severity without colour** ·
[W3C — Understanding SC 1.4.1 Use of Color][wcag]

**In-repo, measured** · `apps/api/scripts/_sba-s2-band.mts` (new, read-only) ·
`_sba-closeout.mts` · live Vercel + Railway at 1728×906, 2026-08-08

---

## 19.10 — S2R execution record (2026-08-08)

**Approved as written**, with the recommended recency rule. Built and verified
against the production database through the read-only stub.

| File | What |
|---|---|
| `ActivityClient.tsx` | `groupFailures` / `deriveBand` / `BandView` replace `failureTally`+`tileSentence`; the band's read became **runs, not failures, always with the self-test included**; the panel, its nine states and its one toggle |
| `activity.css` | the whole S2 block rewritten; `.sba-tile*`, `.sba-allclear` and the `h3` rule deleted |
| `apps/api/scripts/_sba-s2-band.mts` | **new**, read-only: the raw inputs `classifyFailure` reads, deliberately without classifying |
| `apps/api/scripts/_sba-stub.mts` | `STUB_BAND=fail-severe\|fail-limit\|fail-test\|err` |

### Measured before and after, on the same page

| §19.1 defect | Before | After |
|---|---|---|
| Tile count vs the list it produces | tile said **1**, list showed **2** | button says *"Show these 2 runs"* → scope `2 events across 2 runs`, footer `Showing 2 of 2`, **2 rows** |
| Pressed state | all tiles `aria-pressed=true` after one click, **drawn nowhere** | one toggle; `false→true`, background `#fff → rgb(47,97,192)`, word changes, tick appears; pressing again clears |
| WCAG AA failures | **2** — 4.05:1 and **2.73:1** | **0**; worst **5.42** |
| Font sizes | added 18px and 11.5px to S1's 20/13/12 | **13px and 12px only** |
| Ground | none | one card, severity on the card once |
| The stale alarm | 2 tiles about 6 August, 12 runs ago | *"Nothing is failing now — 2 runs failed on 6 August, and the 11 runs since have all been clean."* |
| Height, nothing wrong | 120px of tiles | **46px**, one line |

### All nine states seen in a browser

`checking` (the SSR pass — verified in the hidden `#S:0` tree, which renders
*"Checking what needs a look…"* with its spinner) · `clean` · `settled` ·
`failing-severe` · `failing-limit` · `failing-test` · `out-of-scope` · `error` ·
self-test hidden and shown. The four unreachable ones were simulated
**read-only** by re-ordering rows already in the response on their way out of
the stub — nothing written, no charter enabled, production untouched.

Two that matter most, because they are the ones the old band got wrong:

- **`error`** — *"Could not check what needs a look. timeline: 500. The list
  below is unaffected."* The list underneath still rendered 33 events and 21
  rows. **No green tick.**
- **`out-of-scope`** — *"Failures are hidden by your filters, so this cannot
  say"*, neutral grey. Previously a green success tick on a statement that no
  judgement was possible.

And **`failing-test`**, which is open question 1 made real: the panel goes
**amber, not red**, the row is listed and badged `test run`, and the copy says
nothing it decided was written.

### Four things the browser found that `tsc` could not

1. **"2 runs failed 6 August"** — missing its preposition.
2. **The derived self-test breakdown was a run-on sentence.** Joining
   `classifyFailure().label`s with "and" produced *"…21 could not reach the AI
   provider — a connection problem, not this worker and 3 were refused…"*. The
   note now names only the **count** and the date; pressing **Show me** puts all
   24 into the rows above, classified per class. That is a better answer than
   the one it replaced *and* than the one I first built: the old copy asserted a
   single cause that is right about 21 and wrong about 3, and prose that stitches
   five labels together will break again the next time one is reworded.
3. **`provider-unreachable`'s label already carries its own blame**, so beside a
   meta line naming the blame the row said it twice. Trimmed at the em-dash in
   presentation only; if the label is ever rewritten without the clause it
   no-ops rather than breaking.
4. **The "12 runs since" in §19.1 is the UNSCOPED figure.** The probe counted
   every fleet run after the newest business failure; the band counts runs *in
   scope*, so with the self-test hidden it correctly reads **11**, and with the
   self-test shown, 12. Both were verified on screen. A number quoted from a
   probe is not automatically the number the page should print — the scope has
   to match.

### Gates

`tsc --noEmit` clean on `apps/web` and `apps/api` · DS ratchet clean · P3 token
guard clean · link targets clean · `<section aria-label="What needs a look">` is
a named region landmark · **1 control, 0 unnamed, 0 keyboard-unreachable**, all
icons `aria-hidden` · nothing escapes at a 652px content width · zero horizontal
overflow.

**The through-line, now at 25.** Twenty-five defects have been found on this
page and **not one has been a type error.** Today's four: a missing preposition,
a run-on sentence assembled from someone else's vocabulary, a blame stated
twice, and a number quoted at the wrong scope.

### Prod verification, 2026-08-08 — live Vercel + Railway

Everything above was verified through the read-only stub against the production
*database*. That is not the deployed thing, so the band was then checked on
**live Vercel + Railway** at 1728×906, with real RBAC.

| Check | Result |
|---|---|
| Contrast, re-measured in place | **0 failures**, worst **5.42** (was 2.73) |
| Font sizes in S2 | **13px and 12px only** (was 20/18/13/12/11.5 across S1+S2) |
| Headline | *"Nothing is failing now"* |
| Evidence line | *"2 runs failed on 6 August, and the 11 runs since have all been clean."* |
| **Count vs consequence** | button *"Show these **2** runs"* → scope `2 events across 2 runs`, footer **`Showing 2 of 2`**, **2 rows** |
| Pressed state | `false → true`, background `#fff → rgb(47,97,192)`, word changes to *"Showing only failed runs"*; pressing again restores 33 events |
| Controls | **3, 0 unnamed, 0 keyboard-unreachable** |
| Horizontal overflow | none |
| Panel height | 238px with two failures listed; **46px** when nothing has failed |

**`curl` remains useless as a deployment check for this page**, and this pass
re-proved it: the SSR response is an 18,509-byte shell containing **zero**
occurrences of `sba-needs`, `sba-needshead`, `sba-tile` or `sba-fresh` — the
markup exists only after client render, so a grep returns 0 whether or not the
build shipped. The browser is the only valid signal, and a cache-busting query
was needed even there.

---

## PART 20 — Where the page stands after S1R and S2R

| Section | State |
|---|---|
| **S1** header · scope · freshness | **REBUILT, prod-verified** (Part 18, `7de406df1`) |
| **S2** what needs a look | **REBUILT, prod-verified** (Part 19, `73b6abcf2`) |
| **S3** the controls | ACT.3 as shipped. **Two open items** — the frozen facet chips (§18.9) and the approved-but-unbuilt test-run toggle (§18.7) |
| **S4–S7** list · drawer · footnote · explainer | ACT.2/5/6 as shipped, not re-examined |

**S3 is the next unit, and it has the only known live correctness bug left on
the page:** the filter chips are frozen at first paint (§18.9), caught showing
`Asked permission 2` for events the API no longer returned while the scope line
correctly followed the data down. It also carries the §18.7 test-run toggle,
which the operator approved on 2026-08-08 and which will take the default
headline to **26 events across 7 runs**.

**Twenty-five defects have now been found on this page. Not one has been a type
error.** The three from S2 that mattered most were a count that disagreed with
the list it produced, a control state announced only to screen readers, and a
green tick standing in for three different kinds of "I do not know" — none of
which any compiler, test or `curl` could have seen.

---

# PART 21 — S3 REBUILD: the controls strip

**Status: PHASE 0 SHIPPED (`f44c436af`, prod-verified). The rest is STUDY ONLY
and needs operator approval.**

Stream tag `SB.ACT.S3R`. Scope: **S3 only** — `.sba-toolbar`, the grain switch,
the facet chips and their read, the self-test toggle, search, Clear, the export,
and the URL-sync effect. S4–S7 are later units.

---

## 21.0 — What S3 is FOR, in one sentence

> **Let the operator narrow an unscoped record to the question they actually
> have — and say, at all times and in words, what has been narrowed away.**

The second clause is the one this section keeps failing. Everything below is
judged against it.

---

## 21.1 — The design system already ships this, and I did not check

**`apps/web/src/design-system/patterns/FilterBar.tsx` exists**, is exported from
the patterns index, and is used across `products`, `listings`, `fulfillment`,
`marketing/reviews` and `bulk-operations`. Its own doc-comment states the intent
in the first line:

> *"FilterBar — the **ONE** declarative, config-driven filter bar for every grid
> workspace… so feature pages own *configuration*, never the bar's UI."*

The house rule recorded in memory is **DataGrid + GridToolbar + FilterBar**.
Activity uses `DataGrid` and `GridToolbar` in the Runs grain and then hand-rolls
`.sba-toolbar` for the filters. **That was my omission at ACT.3: I did not look.**

What it already provides, against what S3 hand-rolled:

| S3 needs | `FilterBar` has |
|---|---|
| worker facet, multi-select, with counts | `kind: 'multiselect'` — and `FilterBarOption.count`, *"rendered muted after the label"* |
| event-kind facet, same | the same |
| self-test scope toggle | `kind: 'toggle'` |
| the §18.7 test-run toggle | a second `kind: 'toggle'` — **no new control class** |
| Clear, disabled when inactive | `onClear` + `activeCount` |
| a row above the fields | `presets` |
| search | **no** — `GridToolbar`'s left slot, per its own doc |
| export | **no** — `GridToolbar`'s `right` slot, *"e.g. Customise, Export, density"* |

So the DS composition answers the IA question before the research does: **filters
in a panel, list-scoped actions in the toolbar above the list.** Nothing has to
be invented; the two DS pieces already draw the line this section is missing.

**One risk, and it is already discharged elsewhere:** DS components on a fleet
page render correctly because `.fleet-surface` carries the DS light pin, added by
Workers at W.1 and recorded in the locks doc — *"it is what lets any DS component
render on a fleet page without drawing dark cards on a light background."* The
page already imports all four DS stylesheets (S1R kept them for `DataGrid`).

---

## 21.2 — What is on screen today, measured

Live prod, 1728×906, against `#f4f6f9`.

| | Measured |
|---|---|
| The strip | `1614 × 86px`, **17 controls in one wrapping row** |
| Chips | **10**, consuming **1226px of 1614px — 76% of the row** at *six* workers |
| Font sizes | 11.5px and 12px |
| `.sba-grainlabel` — the word *Show* | 11.5px, **2.82:1 — fails AA** |
| The Runs grain | toolbar **86px → 48px**, **5 chips vanish**, the list jumps **38px** up, unexplained |

Three things follow.

**1 · Five control classes share one row with no grouping.** A *lens* (grain), a
*scope* decision (self-test), two *facets* (worker, kind), *free text*, and an
*action* (export). §18.7 adds a second scope toggle. They differ in kind, not
just in value, and the row says so nowhere.

**2 · The chip row does not scale, and the number is not a guess.** 1226px at 10
chips. The Workers roster is designed for 25+ workers (W.8 instances); at 25 the
worker facet alone is ~2,700px — **two to three wrapped rows of chips before any
kind chip is drawn.**

**3 · A fifth WCAG failure** — `.sba-grainlabel` at 2.82:1, in the 11.5px size
S1 and S2 both had to remove. That is now four sections in a row where the same
two mistakes appear, which is an argument for the DS component rather than for
more vigilance.

---

## 21.3 — What the industry does

### A · Filters and facets are different things, and mixing them is the defect

[NN/g][nng-ff] draws the line precisely: a **filter** "analyse[s] a given set of
content to exclude items that don't meet certain criteria"; **faceted
navigation** "provides multiple filters, one for each different aspect of the
content" and is "composed of multiple filters that comprehensively describe a
set of content". Its warning is the one S3 has walked into: facets' "extra power"
adds complexity, and "a simple filter can often be easier to understand and
faster to use."

Applied to us: *worker* and *what happened* are **facets** — aspects of an event.
*Hide the self-test* is **not**. It does not describe an aspect of the thing you
are looking at; it decides **which population is on the table at all**. So does
*hide test runs*. Putting a population decision in the same row, in the same
visual weight, as an aspect filter is the central IA error, and it is why a
sixth control felt like it had nowhere to go.

**Steal:** the distinction, made visible. **Reject:** NN/g's e-commerce
left-rail default — we have two facets, not twelve.

### B · The correct facet-count semantics is neither of our two options

This is the genuinely contested question, and the search literature settles it.
[Solr][solr] and [Elasticsearch][es] converge on the rule:

> **Within one facet, values act as an OR; across facets, they act as an AND.**

and on the counting consequence:

> *"By default, Elasticsearch executes its aggregations on the result set, which
> means if you select France, the other country filters will have a count of
> 0."*

That is precisely the bug this page shipped and fixed (Part 16, defect 2: pick
one worker and every other worker's chip vanishes). Their answer is not our
answer either. The correct semantics is **"each facet counts under every filter
EXCEPT its own"** — Solr does it by tagging and excluding, Elasticsearch by
`post_filter`, which "applies filters AFTER aggregations are calculated".

We use pure base scope: counts respond to the scope toggles and to nothing else.
**Recommendation: keep base scope for now, and record the refinement with a
trigger.** At six workers, "except-own" buys one thing — it stops a chip
advertising 8 events that yields 0 rows once combined with another facet — and
costs one extra read per facet. At 25 workers that dead end becomes common, and
that is the moment to pay for it. Naming the end state matters more than
building it today.

**Steal:** OR-within / AND-across as the stated semantics, and the vocabulary to
explain it. **Reject:** implementing except-own now.

### C · How the good products show what is applied

[Linear][linear] puts filters behind a button (`F`), renders them as an editable
formula whose operators change with the selection — *"is either of"* when several
values are chosen — and, decisively for us, *"the applied filters are also
reflected in the browser URL. You can copy the browser address to share the
filtered view."* It is explicit that only main filters go in the URL; view
options do not.

[Sentry][sentry-search] keeps **page filters** (project, environment, date) as
fixed controls *above* a `key:value` query bar — two systems, deliberately
separate, one for scope and one for expression.

The e-commerce convention is unanimous and simpler: show active filters as
**tags or chips with a remove ✕**, plus a **Clear all**.

**Steal:** all three — filters behind a control, an always-visible applied
summary with removable pills, everything in the URL. The pill is also where
OR-within/AND-across can be *said* rather than documented: `Worker: Bid tuner or
Plan critic ✕` beside `What happened: Run failed ✕` communicates the semantics
with no formula editor. **Reject:** Linear's nested AND/OR groups — five
populated kinds and six workers do not need a query language, and Part 8 already
rejected a DSL on this data.

### D · When a chip row stops working

[Algolia][algolia] recommends a facet **dropdown** "when screen space is
limited", notes it "increases facet visibility… while simplifying the screen",
and shows the applied state on the trigger itself — a refined-state class, or
the label rewritten to name the selection, or a count of active refinements.

[Datadog][dd-facets] is the many-facets case: a left panel, facets "organized
into meaningful themes", each qualitative facet showing "a top list of unique
values, and a count of logs matching each of them" — plus the admission that the
list becomes unwieldy, answered by letting users **hide facets they do not need**
while keeping them findable through a facet search box.

**Steal:** the dropdown-with-applied-state-on-the-trigger, which is exactly what
the DS `MultiSelect` inside `FilterBar` is. **Reject:** a left rail and
per-facet hiding — two facets do not need either.

### E · What they leave out of the strip

- **Sentry** puts no export in the filter row.
- **Linear** puts no counts in the URL and no view options either.
- **Datadog** puts no free-text search inside the facet panel; the query bar is
  its own thing beside it.
- **None** of them puts a lens/mode switch inside the filter panel — modes sit
  with the content they reshape.

That last one decides where the grain switch goes.

---

## 21.4 — The proposal

### 21.4.1 Four classes, three places

```
  S1  header · scope sentence · freshness            ← says what is on the table
  S2  what needs a look                               ← says whether to act
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ Filters                                                   Hide ▾         │  ← DS FilterBar
 │  Counting        [•] the self-test   [ ] test runs                       │     (collapsed by
 │  Worker          [ Bid tuner, Plan critic        ▾ ]                     │      default)
 │  What happened   [ All                           ▾ ]                     │
 │                                              Clear                       │
 └──────────────────────────────────────────────────────────────────────────┘
  Worker: Bid tuner or Plan critic ✕   ·   Filtered from 33   ·   Clear all   ← applied pills
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ [Everything|Runs only]  [🔎 search…]              [Download 9 rows (CSV)] │  ← DS GridToolbar
 ├──────────────────────────────────────────────────────────────────────────┤
 │ the list (S4)                                                            │
 └──────────────────────────────────────────────────────────────────────────┘
```

| Class | Where | Why |
|---|---|---|
| **Scope** — self-test, test runs | a `Counting` group at the TOP of the FilterBar panel | it decides the population; it is not an aspect of a row. Grouped and labelled once, so §18.7's toggle is an entry, not a sixth control |
| **Facets** — worker, what happened | `multiselect` dimensions with counts | OR within, AND across. Scales to 25 workers because a dropdown does |
| **Applied state** | a pill row OUTSIDE the panel, always visible | the panel collapses; what is applied must not. NN/g's rule, Linear's model |
| **Lens** — grain | `GridToolbar` left | a mode belongs with the content it reshapes, not in the filter panel |
| **Free text** | `GridToolbar` left, after the grain | Sentry's separation: scope controls and expression are different systems |
| **Action** — export | `GridToolbar` right | the DS's own documented slot |

**The panel is collapsed by default** (`defaultOpen={false}`). Activity's primary
act is reading, not filtering — Sentry and Linear both put filters behind a
control — and the applied pills mean a collapsed panel never hides *what is
applied*, only *the controls for changing it*.

### 21.4.2 Type, colour, and what does not change

Everything comes from DS tokens, which removes the class of defect that has now
appeared in four consecutive sections. The one bespoke piece is the applied-pill
row: **13px**, S1's ladder, no new size. `.sba-grainlabel`'s 11.5px / 2.82:1 dies
with the hand-rolled strip.

**Not changing:** the URL contract (every filter stays a link — DT.5); the
export walking every page before writing and prefix-guarding `= + - @`; `actor`
failing **closed** on an unknown key while `kind`/`outcome` fall back to no
filter (deliberate, tested, asymmetric — §16); base-scope facet semantics
(§21.3B); and the Phase 0 pairing.

---

## 21.5 — Where §18.7's test-run toggle lands, and the arithmetic it changes

It becomes the **second `toggle` in the `Counting` group**. That is the whole
point of grouping scope: a new population costs an entry, not a control class.

**The numbers, verified** (`_sba-s2-band.mts`, `_sba-closeout.mts`):

| | Today | With test runs hidden |
|---|---|---|
| S1 scope line | 33 events across 14 runs | **26 events across 7 runs** |
| Hidden | 86 (self-test) | **93** — 86 self-test + **7** test runs |
| Arithmetic | 33 + 86 = 119 ✓ | 26 + 93 = 119 ✓ |
| S2's tally | 2 failures | **2 failures — unchanged** |

**Two consequences, both in scope for the build because leaving them wrong would
ship a known lie:**

1. **S1's hidden clause must name two populations.** *"86 more from the
   self-test are hidden"* becomes *"93 more are hidden — 86 from the self-test
   and 7 test runs"*, with the way back. The clause is already derived from
   `hiddenByScope`, so it generalises rather than being rewritten.
2. **S2 is genuinely unaffected**, and that is a measured fact rather than an
   assumption: **0 of the 26 not-ok runs have ever been a test run**, and both
   current failures are `mode: 'ask'`. §19.5's rule — the band's scope follows
   the page — holds without changing a number. S2's hidden-note, which today
   names the self-test, generalises the same way S1's does.

**Default state:** test runs **hidden**, matching the operator's §18.7 approval
and the accepted consequence that the honest headline is the smaller one.

---

## 21.6 — Every state, designed now

| # | State | What renders |
|---|---|---|
| 1 | **Nothing selected** | panel collapsed, header `Filters`; **no pill row**; toolbar shows grain + search + export. The quiet default |
| 2 | **One facet value** | one pill `Worker: Bid tuner ✕` · `Filtered from 33` · `Clear all` |
| 3 | **Several, across both facets** | one pill per facet, values joined by **or** inside it — `Worker: Bid tuner or Plan critic ✕` `What happened: Run failed ✕`. Separate pills read as AND. The semantics is stated by the punctuation, not by a legend |
| 4 | **Scope toggles changed** | a scope pill in a distinct treatment — `Counting: + the self-test ✕` — because it *widens* rather than narrows. S1's sentence remains the primary narration |
| 5 | **Runs grain** | the kind facet **stays**, showing only the three run kinds. Today it vanishes and the list jumps 38px for no stated reason; the facet is still meaningful in that grain, so the fix removes the jump *and* adds capability |
| 6 | **A filter matching nothing** | S1 already says *"Nothing matches what you asked for, out of 33."* The pill row stays, so the operator can see and remove the cause. **Never a dead end** |
| 7 | **The facet read failed** | counts are omitted from the options rather than shown as 0; the panel header says *"Counts unavailable — the filters still work."* A 0 that means "we could not ask" is the S2 mistake repeated |
| 8 | **25 workers** | the `MultiSelect` scrolls and is searchable; the trigger names the selection or its count. No wrapped chip rows. This is the state that decides the whole design |

---

## 21.7 — The boundary

**Against S2 above.** S2 writes exactly one filter value through one toggle and
reads the filter state. It keeps doing so. When S2's toggle is on, S3's pill row
shows `What happened: Run failed ✕` — the same fact, in the place that owns
"what is applied", and removing it there clears S2's toggle. One state, two
readouts, never two states.

**Against S4 below.** S3 does not own the list, the rollups, the day headers or
the "Show older" pager. It owns what the list is *asked for*. The row count in
the footer stays S4's; **S3 adds no count of its own** — the `GridToolbar`
`count` slot is deliberately left empty, because S1 already states the scope and
a third number in the same viewport is how this page breaks.

**Against everything else.** No date range (Part 8, still rejected on the data).
No query DSL (Part 8). No saved views (DT.7, deferred — needs storage that does
not exist). No per-facet hiding.

---

## 21.8 — Phase 0, shipped ahead of the design work

`f44c436af`, prod-verified. §18.9 is closed: the facet chips and the scope line
are now read in one tick and adopted in one moment, through a pure
`reconcilePoll` whose only outcomes are *adopt this pair* and *hold this pair* —
neither expressible on one half.

The second failure direction is the one worth recording, because fixing only the
cadence would have created it: arrivals are **held** behind the "N new events"
button, so facets that refreshed eagerly would have counted rows the list was not
showing. Measured with a new `STUB_DRIFT` mode that alternates the stream 33/32:
**seven samples across both states, zero divergences**; while an event waited
behind the banner the chips stayed at 32 with the list; pressing it moved both to
33 in the same instant. On prod: scope 33 = chips 33, five worker chips intact,
and **4 base-scope reads in the first ten seconds** where there had been one for
the lifetime of the page.

Base-scope semantics were deliberately **not** touched — the fix changed how
often the facets are read, never what they ask for. Re-verified on prod: after
selecting one worker all five chips remain and a second can still be added.

11 vitest cases in `facets.vitest.test.ts` assert the pairing, including that a
failed facet read travels as a pair rather than silently reusing the previous
tick's counts.

---

## 21.9 — Sources

[nng-ff]: https://www.nngroup.com/articles/filters-vs-facets/
[solr]: https://solr.apache.org/guide/solr/latest/query-guide/faceting.html
[es]: https://madewithlove.com/blog/faceted-search-using-elasticsearch/
[linear]: https://linear.app/docs/filters
[sentry-search]: https://docs.sentry.io/concepts/search/
[algolia]: https://www.algolia.com/doc/guides/building-search-ui/ui-and-ux-patterns/facet-dropdown/js
[dd-facets]: https://docs.datadoghq.com/logs/explorer/facets/

**Filters vs facets** · [NN/g — Filters vs. Facets: Definitions][nng-ff]

**Count semantics** · [Apache Solr — Faceting][solr] ·
[Faceted search with Elasticsearch — the post_filter problem][es]

**Applied state, URL, saved views** · [Linear — Filters][linear] ·
[Sentry — Search and page filters][sentry-search]

**When chips stop working** · [Algolia — facet dropdown pattern][algolia] ·
[Datadog — the log facet panel][dd-facets]

**In-repo** · `apps/web/src/design-system/patterns/FilterBar.tsx` ·
`GridToolbar.tsx` · `FilterPanel.tsx` · live prod measurement at 1728×906,
2026-08-08
