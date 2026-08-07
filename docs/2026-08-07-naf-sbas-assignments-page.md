# NAF.SB.AS — The Assignments page: what it is for, and what is on it

**Status: PROPOSAL — awaiting operator approval.** Nothing here is built. This is
step 1 of the two-step method the operator set out on 2026-08-07: *first agree
what sections a page needs and why; then study each section on its own; then
build them one at a time.*

Parent: `docs/2026-08-07-naf-sb-fleet-pages.md` (the ten-page map, approved).
Siblings in flight: **Workers** (`SB.W`), **Workflows** (`SB.8`, complete through
WF.6c), **Approvals** (`SB.AQ`), **Fleet map** (`SB.M`), **Activity** (`SB.ACT`).
Protocol and claims: `docs/2026-08-07-naf-sb-session-locks.md`.

| | |
|---|---|
| **Route** | `/fleet/assignments` (list) · `/fleet/assignments/[id]` (one assignment) |
| **Group** | BUILD — *what should happen* |
| **Built today** | nothing — `page.tsx` renders `PlannedPage` (52 lines) |
| **Operator ask** | #1, verbatim: *"if we have a campaign, I want to assign that worker… and take action on that single campaign."* |
| **Migration letter** | `20260807e` (claimed; a–d taken by AC / AP / WF / W.8) |

---

## PART 0 — The one sentence

> **Assignments is where you point one worker at one named thing, say what you
> want back, and watch that single job through to what it found.**

Four clauses, each mapping to something no other fleet page can do.

| Clause | Why only this page can do it |
|---|---|
| *one worker* | Workers owns **who exists**. Workflows owns **which workers run, in what order, on a clock**. Neither can express *this one, now, because I said so*. The nearest thing that exists is `POST /agent/fleet/run/:key`, which **takes no body at all** (`agent-fleet.routes.ts:746-768`) — a bare verb with nowhere to put anything. |
| *at one named thing* | **The target.** No other surface in the fleet has a field for it. `WorkflowStepV1` is `{ charterKey, gate }` (`workflow-defs.ts:21-27`) with no target slot, and `validateDefinition` refuses anything but `v:1`. This page makes a target mean something, or the concept has no home. |
| *say what you want back* | A charter's prompt says what a worker **always** does. Nothing anywhere asks what you want **this time**. `AgentRun.input` is the same three keys on all 43 `ask` runs: `{charterKey, charterVersion, observationKeys}`. |
| *watch that single job* | Activity owns the unscoped cross-fleet feed (locks §5 decision 5: the rule is **altitude, not ownership**). An `AgentRun` has `status: running\|done\|failed` and no idea it belonged to a job you created — or that finding nothing was the right answer. |

**Three clauses from the master map are deliberately cut from v1.** Each is cut
for a reason found in the code, not for scope:

- *"whether it may act or must propose"* — six of seven charters cap at OBSERVE
  and the seventh at PROPOSE. A gate control would bind nothing, which is the
  exact defect this page exists to fix (Part 6). Ship the sentence, not the
  toggle.
- *"attach a file"* — Files & data (SB.7) does not exist and has no owning
  session. A private uploader here would violate its stated hard boundary.
- *"recurring assignments become triggers"* — see Part 7, decision 4. Workflows
  has already chosen a direction and is waiting on us; the honest v1 answer is
  **no recurrence on either side**, not a button that silently drops the target.

---

## PART 1 — Ground truth, measured not assumed

Production, 2026-08-07, via `apps/api/scripts/_sbas-assignment-truth.mts`
(read-only, left in place).

### 1.1 The page's premise does not exist as data

- **`AgentRun` = 79 rows.** By mode: `ask` **43**, NULL (legacy ACP, not fleet)
  26, `preview` 8, `council` 2. **Zero** `sweep`, `tick`, `summit`, `incident`,
  `custom` — four of the eight modes in the schema comment have never occurred.
- **All 43 `ask` runs carry `entityType = NULL` and `entityId = NULL`.** Every
  input JSON is the identical three-key shape. **The `ask` verb as built is
  entirely untargeted.** This page is *creating* a concept, not surfacing one.
- By trigger: manual 77, schedule 2. By status: done 54, **failed 25 — a 31.6%
  lifetime failure rate.** Failure is the second-most-common outcome, not an
  edge case, and it needs a first-class state with the reason visible.
- 26 of the 79 runs belong to legacy ACP agents (`products-copilot`,
  `listing-quality-keeper`, `manual-action`, `pricing-watchdog`) which have **no
  `AgentCharter` row**. Any query keyed on `agentKey` must filter
  `mode IS NOT NULL` or it renders phantom rows for workers the Workers page
  does not list.

### 1.2 The entity universe is real and large

| | Count | What it means for a picker |
|---|---|---|
| Campaign | **220** (IT 150 · DE 38 · FR 22 · ES 10) | **133 are PAUSED.** A picker that does not default to ENABLED offers mostly dormant scope. 219/220 carry an `externalCampaignId`. |
| AmazonAdsPortfolio | **12**, all ENABLED | The only entity that fits in a plain dropdown — but 9 of 12 sit under one profile, so it must show its marketplace. Only **72 of 220** campaigns belong to one. |
| AdGroup | 289 | — |
| AdTarget | **5,211** — but **2,058 are negatives** | A search-and-page surface, never a list. The addressable positive universe is **3,153**. Negativity is `isNegative`, never `expressionType` (negative rows carry `EXACT` 1,393 / `PHRASE` 579). |
| Advertisable products | ~294 IT / 235 DE / 147 FR / 137 ES | Searchable list. Use `/api/products/search` with `advertisableOn=`. |

### 1.3 Findings have no typed target, and one of five grammars is a real key

`AgentFinding` = 64 rows, **100% `status='open'`** — no lifecycle transition has
ever occurred. 47 of 64 belong to `fleet-selftest`; only **17 are about
advertising**.

Identity is one polymorphic pair, `(entityType, entityId)`, with five
incompatible grammars — verified by resolving each against its table:

| entityType | Grammar | Resolves? |
|---|---|---|
| `AD_TARGET` | cuid | **5/5 — a real foreign key.** The only type where "show me the thing" works. |
| `SEARCH_TERM` | `<externalCampaignId>:<query>` | A parse, not a join — but the prefix **is** a campaign id, and it is findings' only campaign linkage. |
| `ACCOUNT` | `ngram:<token>` | No. |
| `COMPONENT` | `cron:<jobName>` | No. |
| `ASIN` | lowercase asin | **0/1** — it is a *competitor* ASIN a shopper typed. Do not build a "view product" link off it. |

`AgentFinding.marketplace` is written `null` **unconditionally**
(`agent-executor.ts:582`) on all 64 rows, even when the run was
marketplace-scoped. **A scoped run does not record its own scope.**

### 1.4 The rest of the fleet, honestly

- **`AgentApproval` = 18 rows, all legacy ACP** (`apply-content` ×12,
  `set-price` ×3, `send-customer-message` ×2, `publish-listing` ×1). **Zero
  pending. None from an ads tool.**
- **`AgentPlan` = 1 row, and it is blocked** — `criticVerdict='block'`,
  `approvalIds: []`, blast radius `proceed: false` on *"2 row(s) conflict with
  live Amazon state (limit 0)"*, while the plan's own `conflicts[]` carries a
  prose `resolution` the guard ignores.
- **Empty at zero rows:** `AgentStrategy`, `AgentExemplar`, `AgentControlAudit`,
  `AgentEvalRun`, `AgentMemory`. Do not give any of them a screen.
- **`AgentCharter` = 7 rows, every one `enabled=false, autonomyLevel='OFF'`.**
  `templateKey` NULL on all seven — **zero W.8 instances exist.** All scope
  arrays empty. Six cap at OBSERVE; only `amazon-ads-director` caps at PROPOSE.
- `AgentObservation` = **6** cached rows. `AgentWorkflow` = 4 (3 built-in + the
  first custom, `morning-negatives-pass`).

**The consequence that governs every section below:** the fleet is dark, and
**the only thing that will ever start an assignment is a human pressing a button
that spends money on a fleet they deliberately switched off.** Every empty state
must say that out loud rather than implying setup is incomplete.

---

## PART 2 — What the industry does

Four archetypes researched in depth. Condensed to what binds the design.

### 2A · RPA work queues — UiPath, Blue Prism, Automation Anywhere, Power Automate

The universal IA is **container → item → run**; nobody puts work items in a flat
global list. UiPath splits the lifecycle onto **two orthogonal axes** — an *item
status* owned by the automation (New / In Progress / Failed / Successful /
Abandoned / Retried / Deleted) and a *revision status* owned by the human in the
console (None / In Review / Verified). Blue Prism splits the same way across two
apps: **design** in System Manager, **operation** in Control Room.

**What we take:** the container/item/run levels; a *Progress* string displayed
alongside In Progress so a crash tells you where it died; and the discipline that
deadline breach **classifies and alerts, never blocks**.

**What we explicitly do not take: `Abandoned`-as-lock-reaper, and the vocabulary.**
UiPath's Abandoned exists because *In Progress is a lock* and an immortal lock
loses the item forever. We have no leases — but see Part 4, because we *do* have
a reaper, and it is not the one this archetype would predict.

**Banned words on this page: queue, item, transaction.** Approvals is already
"the blocking queue"; two adjacent rail items both called a queue is exactly the
naming collision the ten-page constraint exists to prevent. Use the model, never
the word. (The DS ratchet greps comments line-by-line, so this applies to
comments too — `reference_ds_guard_greps_comments`.)

### 2B · Agent task surfaces — GitHub Copilot, Devin, Relevance AI, CrewAI, Copilot Studio, Lindy

- **GitHub's "assign an issue to Copilot" is the purest form of our ask**, and
  its decisive property is that **the assign control lives on the object you are
  already looking at**. Median assignment is two clicks; the prompt is
  *explicitly optional*.
- **CrewAI makes `expected_output` required beside `description`** — but that
  field is written **once by a developer** authoring a reusable task, not every
  time by an operator. The research's own `doNotCopy` is blunt: *"Making the
  free-text prompt required… otherwise every assignment becomes a writing
  exercise and the typed target you built is decorative."*
- **Relevance AI** puts approval on the *connection* and shows the proposed
  action **with its reasoning** in one task view.
- **Lindy shipped a whole action for naming runs**, because auto-generated labels
  make history unreadable.

### 2C · Work management — Linear, Jira, Asana, ServiceNow

This archetype has solved **beginner legibility for a queue of assigned work**
better than anyone.

- **Linear's terminal categories** — Completed / Canceled / Duplicate as
  *distinct endings* — beat Jira's nullable Resolution, which fails silently
  whenever a post-function is missing. **Closing something that ran and
  cancelling something that never did are different facts, and history must keep
  them apart.**
- Linear tolerates no-confirm destructive actions **only because it ships
  universal undo**. Copy the pair or neither.
- State sprawl is the documented failure mode: the useful distinction is
  *status* vs *state category*, and beginners hold five or six, not fourteen.

### 2D · Job orchestration — Temporal, Airflow, Dagster, Prefect, SQS

- **Temporal's `WorkflowIdConflictPolicy: UseExisting`** — starting an
  already-running job *returns the open run* rather than creating a second. This
  is the answer to double-clicking a button that spends money.
- **Dagster's tick timeline records evaluations that launched nothing**, which is
  what answers a beginner's "why didn't it run?".
- **Priority is where these products disagree with themselves** (Dagster and
  Prefect cannot even agree which direction the numbers run) and free-integer
  priority degenerates into everything-is-high. **No priority field in v1.**

---

## PART 3 — The boundary: what this page is NOT

The operator's constraint is absolute: *nothing may be built twice across the ten
pages.* Five sibling sessions are live right now, so this is not hypothetical.

### 3.1 The sorting test — one question

> **How many workers does it name?**
>
> **One** worker → an **Assignment** (`AgentAssignment.charterKey`, singular).
> **Two or more, or any clock** → a **Workflow** (`WorkflowStepV1[]` +
> `WorkflowEdgeV1[]` + `WorkflowTriggerV1`).

It survives both hard cases: a targetless one-worker job is still one worker →
Assignments (and `on-demand-check`'s `steps: []` is literally that shape, which
is why Part 7 decision 3 retires it); and *"make this repeat"* would create a
**one-step custom workflow** with a schedule trigger, which `validateDefinition`
already accepts — so the boundary needs no new contract on the Workflows side.

### 3.2 Concept ownership

| Concept | Owned by | On Assignments it appears as |
|---|---|---|
| The worker list, health, dials, grades | **Workers** | A single-select picker showing name, tier, cap. **If it grows a second sortable column it has become the roster.** |
| Creating / editing / retiring a worker | **Workers** | Never. A link. |
| Named routines, steps, edges, gates, revisions | **Workflows** | Never. |
| Schedules, cron, triggers, re-arming clocks | **Workflows** | Never. No `cron` column on `AgentAssignment`. |
| The unscoped cross-fleet run feed, filters, export | **Activity** | The runs of **this one assignment**, no filter bar, no export — locks §5 decision 5 permits exactly that. |
| Step traces | **Activity** | A link. Never a second trace viewer. |
| Browsing / filtering / searching findings | **Activity**, later SB.10 | A count, ≤12 rows with `rationale` verbatim, "see all". |
| Finding lifecycle (promote / dismiss / expire) | **Activity / SB.10** | Never. Closing an assignment says something about the **job**, not the evidence. |
| The approvals queue; accept / reject | **Approvals** | One sentence, one count, one link. **No decide button, in any form** (Part 10.2). |
| Blast radius, plan critique | **Approvals** / the plan guard | Never. |
| Spend analysis, ROI, model split | **Cost & value** | One number: what this assignment cost. |
| The live map, pulses, overlays | **Fleet map** | Never. Not even a small canvas. |
| Kill switch, halt, ceilings, control audit feed | **Controls** | Never as a control. Named in a Stopped reason. |
| Uploading / parsing / versioning files | **Files & data** (SB.7) | Absent in v1, with the prerequisite named. |
| Autonomy ladder + confirms | shared `_shared/autonomy.tsx` | `ConfirmSpend` reused verbatim. No dial. |
| Failure classification, relative time | shared `_shared/run-health.ts` | Reused. `deriveStatus` is **not** — it derives a *worker's* state. |
| Run-outcome phrasing | **shared, to be extended** — see 3.4 | `outcomeOf()` added to `run-health.ts`, consumed by three pages. |
| Ranked entity search | shared `@/lib/option-search` | Reused. |
| The campaign picker **component** | **to be extracted** — see 3.4 | Consumed, not rebuilt. |

### 3.3 What the other nine pages should show about an assignment

The reverse direction, because **four sibling sessions are in study right now and
this is the only cheap window to wire it.**

| Page | Contract | Cost to them |
|---|---|---|
| **Approvals** | Every card names its originating assignment and links to it — *"From your assignment: negative miner on GALE \| IT \| Broad"*. Free via `AgentApproval.agentRunId → AgentRun.assignmentId`. **Settled with SB.AQ — Part 10.2.** | One join |
| **Activity** | `mode='assignment'` becomes a filter value; each such row links back. One additive `sourcePhrase` entry. | One string |
| **Cost & value** | Assignment becomes a breakdown dimension the day `AgentRun.assignmentId` exists. **Told now so they do not build their own attribution.** | Nothing |
| **Controls** | Three operator-facing phrases for the audit actions (Part 6.5). | Three strings |
| **Overview** | **One line in "what needs you"** — *"N assignments not started · M overdue"*, linking here pre-filtered. An object only a human starts, appearing on no morning screen, is forgotten by design. | One line |
| **Fleet map** | An assignment run is a **one-node walk belonging to no workflow**, so it falls outside D1's union-of-enabled-workflows. Their call whether to show it; runs are identifiable via `assignmentId`. **Raised with SB.M — Part 10.1.** | Nothing |
| **Files & data** (SB.7) | Reserve the shape: a picker over uploaded files bound to an assignment id. | Nothing |
| **Workers** | *"Its open assignments"* — a **count and a link**, served by `GET /agent/fleet/assignments?charterKey=`. The list itself lives here (`naf-sbw-workers-page.md:501`). | One fetch |
| **Workflows** | Nothing. The trigger payload is defined here for a later WF phase (Part 7 decision 4). | Nothing |

### 3.4 Three components that must be reused, not rebuilt

Boundary discipline at the level of *concepts* is not enough; the collisions live
at the level of *components*.

1. **The campaign picker exists twice already.**
   `rules-automation/_schedule/CampaignSection.tsx` is a complete picker —
   All Campaigns / Portfolios / Products tabs, `searchOptions` from
   `@/lib/option-search`, status filter, Add All, pager, an "N Campaigns Added"
   panel. `RuleBuilder.tsx:1098` holds a second private one. **Extract to
   `app/fleet/_shared/CampaignPicker.tsx`; do not write a third.** Consequence
   worth taking: it already has a Portfolios tab, so **portfolio targeting is a
   tab we would be deleting, not a feature we would be adding** (Part 7,
   decision 2).
2. **Run-outcome phrasing exists twice.** `RunsSection.groupOutcome` /
   `runOutcome` phrase "finished clean" / "N of M stopped at a limit";
   `run-health.classifyFailure` owns the failure taxonomy. Inventing a third
   vocabulary means the same `AgentRun` reads differently on three pages. **Add
   `outcomeOf(run)` to `_shared/run-health.ts`** (additive, permitted by locks
   §3; note it there) covering the one case nothing handles today —
   `ok && findingCount === 0` → *"nothing to do"* — and have Assignments,
   Workflows and Activity all read it.
3. **The scoped run list.** This would be the **fourth**. It forks deliberately
   and the reason is stated once: *an assignment produces exactly one run per
   Start, so its list is one row per attempt and is never grouped by
   orchestration.* If that stops being true, consume `RunsSection`'s row
   renderer instead.

---

## PART 4 — The lifecycle: seven states, plus one the code forced on us

The test each state had to pass: **if an operator cannot act differently on it, it
is a tooltip, not a state.** Airflow ships 14 and Prefect 16 because they are
general-purpose engines. This is a fleet of seven workers that can only look and
report.

The master map's chain — *New → Running → Produced N findings → Awaiting your
approval → Done* — does not survive contact with the code. "Produced N findings"
is a count, not a position. "Awaiting your approval" is **structurally impossible**
(Part 6.4). And it is missing the three outcomes this fleet will actually produce
most often: a guard stopping the run, a clean run that found nothing, and a job
that never started because nobody pressed anything.

**All state names, chip labels, tile labels, filter predicates, glossary entries
and tooltips come from ONE exported `ASSIGNMENT_STATES` record.** A tile that
says a word the chip does not say is the defect this page is most likely to ship.

| # | State | Means | Entry | Exit |
|---|---|---|---|---|
| 1 | **Not started** | *You made this. Nothing has run.* | created | Start · Cancel · Delete |
| 2 | **Running** | *A run is open right now.* | `AgentRun.status='running'` | whatever the run returns |
| 3 | **Finished** | *It ran and came back.* The delta line carries *"3 findings"* or *"found nothing"* | `ok:true` | Start again · Close |
| 4 | **Stopped** | *A guard stopped it.* | `haltedReason` set, **not** `orphaned:` | fix named, Start again |
| 5 | **Failed** | *It broke.* | `ok:false` with an error | Start again |
| 6 | **Abandoned** | *It stopped reporting. We closed it after 2 hours and cannot say what it cost.* | `haltedReason` starts with `orphaned:` | Start again |
| 7 | **Closed** | *Done with it.* **Terminal but reversible** (Reopen). | you press Close | Reopen |
| 8 | **Cancelled** | *You called it off.* Reachable only from Not started. **Terminal but reversible.** | you press Cancel | Reopen · Delete |

**Merged away, deliberately:** *"Came back with N"* and *"Nothing to do"* collapse
into **Finished** — the operator's action is identical for both (read it, start
again, close) and the only difference is a count the delta line already carries.
That is precisely the criticism this document levels at the master map.

**Deleted from v1:** *"Waiting on you."* It cannot happen — see Part 6.4. A tile,
a derived state and a detail panel built to render a provable zero are three
surfaces that should ship **deleted, not empty**.

**Not states:**

- **Overdue is a flag.** A due date colours the row grey → amber → red and raises
  it in the default order. It never blocks a start, never stops a run, never
  fires a transition. Universal across UiPath, Jira Service Management and
  Linear: blocking destroys work, ignoring makes the field decorative.
- **"Needs your decision" is a row badge**, not a state, if and when approvals
  become reachable — so it never overwrites the honest state and needs no
  fallback rule.

**Two rules that are not states:**

**Targets resolve at RUN time, and a target that no longer resolves goes to
Stopped — never to a wider scope.** A campaign archived between create and start
must produce *"the campaign you named is gone"* and zero work. This is the
advertising archetype's #1 documented pitfall, and here the fail-open case is
catastrophic: a filter that resolves nothing and falls through to `undefined` is
account-wide, so the miner would run over all 220 campaigns while the row still
said one. **Fail closed, loudly.**

**One assignment, many runs.** Start again creates a new `AgentRun`; each attempt
keeps its own error, cost, duration and evidence vintage. A mutated counter on
the assignment would lose every previous failure reason.

---

## PART 5 — The sections

Six sections. Each states its purpose, why it belongs here rather than on one of
the other nine pages, and what it must never become.

### AS-S1 · The list — one row per assignment

**Purpose.** Every assignment ever made, newest first: what it is, what it points
at, where it got to, and whether it needs you — without a click.

**Contents.** One row per assignment: state chip · title · worker · target chip ·
what you want back (truncated) · age · due badge · the run delta.

- **Title is derived at create time** from worker + target — *"Negative miner on
  GALE | IT | Broad"* — and is operator-overridable. Guaranteed non-empty,
  because a sibling page renders it as provenance (Part 10.2). Lindy shipped a
  whole action for this; auto-generated labels make history unreadable.
- **One quantitative delta per row, never a spinner or a percentage** — *"3
  findings"*, *"found nothing"*, *"stopped: fleet day budget"* — read from the
  shared `outcomeOf()` (3.4).
- **The target chip shows the frozen label only.** The raw 15-digit external id
  lives in its **tooltip** (*"GALE | IT | Broad — campaign 242957913137679"*) and
  on the detail page. Ids exist to survive renames, which is a correctness
  concern, not a reading concern. If the target no longer resolves the chip goes
  red: *"Campaign no longer exists"*.
- Search across title + target label through `@/lib/option-search` — plain
  substring returns zero for real ads names like `GALE | IT | Broad | Brand`.
- Filter state in the URL via `History.replaceState`, matching the Workers
  precedent.
- **Live updating** via the settled shared mechanism: `use-visibility-poll`
  (locks §5 decision 1), with the "as of" stamp and no silent re-sort.
- **Columns at narrow widths:** state chip, title and delta are the row's
  identity and never drop. Worker, due and age drop first; target collapses into
  the title line.

**Why here.** Activity owns run history, but **an assignment that has never run
has no representation there at all** — there is nothing to show. Most rows on
this page will be exactly that.

**Must never become.** A run log. The moment a row wants an outcome filter, an
export or a permalink to a trace, the reader wanted Activity. Never a worker
roster: one worker holds many assignments, and this list must never sort or group
by worker health, grade or dial.

**Empty states — three, and they must not share copy.**
*Never had data:* "No assignments yet. An assignment is one worker pointed at one
thing, with a note about what you want back. Make one and it will sit here until
you start it — **nothing starts on its own: every worker in this fleet is
switched off.**" *Filtered to nothing:* names the filter and offers to clear it.
*Cleared list:* "Nothing open. 3 closed, 1 cancelled — show them."

**Backend.** `GET /agent/fleet/assignments`, returning the row **with its run
linkage folded in**. Do **not** make the client join against
`/agent/fleet/runs?limit=100` — that feed is capped server-side and is global, so
an assignment older than the newest 100 fleet runs would render "never run" when
it did.

---

### AS-S2 · The state strip — counts that filter

**Purpose.** Answer *"is anything waiting on me?"* before reading a single row.

**Contents.** **One tile per state, tile label identical to the chip label,
character for character**, both read from `ASSIGNMENT_STATES`: Not started ·
Running · Finished · Stopped · Failed. Each tile's number is exactly the number
of rows clicking it reveals. The list defaults to open states and the strip
prints the remainder so the arithmetic is visibly total: *"Showing open
assignments — 3 closed, 1 cancelled."* Overdue is a sixth tile **only if a due
date has ever been set** — otherwise absent, not zero.

**Why here.** Overview shows fleet-wide health; this strip is scoped to the
objects on **this** page and every tile filters **this** list. A tile that does
not filter belongs on Overview.

**Must never become.** A dashboard. No sparklines, no trends, no cost breakdown,
no per-worker split.

**Backend.** None — derived client-side from AS-S1's payload. Reuses
`.acr-pg-strip` / `.acr-pg-stat`; no new CSS.

---

### AS-S3 · Create one assignment

**Purpose.** Turn *"I want the negative miner to look at this one campaign"* into
an object, in under a minute, without writing a prompt.

**Contents.** A DS **Drawer**, with any confirm rendered through its `overlay`
prop — a nested Modal opens *behind* a Drawer (`reference_drawer_confirm_overlay`).

1. **Worker** — a picker containing **only workers that can be pointed at
   something**. Beneath it, one grey line: *"Other workers read your whole
   account every time and cannot be narrowed. Run those from Workers →"*. This
   is what makes the page's headline literally true instead of false 71% of the
   time, and it deletes the disabled-picker branch entirely.
2. **Target** — kind chooser, then value. The **campaign picker is the extracted
   shared component** (3.4), defaulting to ENABLED. Kinds we cannot enforce are
   **absent with a printed reason**, never greyed silently.
3. **What you want back — *optional*.** Pre-filled from the chosen worker's
   charter one-liner, editable and clearable (*"Find wasted spend in this
   campaign."*), with two or three chips from the master doc's own examples:
   *find wasted spend · propose bids · audit structure*. The research's
   `doNotCopy` is explicit that a required essay makes the typed target
   decorative; GitHub's median assignment is two clicks.
4. **By when — optional.** A due date, never a start date (a start date needs a
   clock, and clocks are Workflows'). Microcopy states the semantics: *"A
   deadline colours the row and tells you it slipped. It never starts anything
   and never stops anything."*

**No prompt field, ever.** `promptOverride` **replaces** the entire charter
system prompt rather than appending (`agent-executor.ts:414-418`); the only
append mechanism, `promptOverlay`, is a persisted instance column, not a run
parameter. A free-text instruction that silently destroyed the charter would be
the worst bug on this page.

**Entry from the object you are standing on.** The operator's ask is *"if we have
a campaign, I want to assign that worker"* — so a row action on the ads campaigns
grid deep-links `?new=1&targetKind=CAMPAIGN&targetId=…&targetLabel=…`, opening
the drawer with the target pre-filled and frozen. **A URL imports none of the
assignment object's rules**, so the boundary holds. This is GitHub's strongest
lesson and it is otherwise absent.

**Why here.** The only place in the fleet where a worker is bound to work.
Workers' create drawer makes a worker *exist*; Workflows' editor decides what
runs *in what order*. Neither has a target field, and neither can acquire one
without becoming this page.

**Must never become.** A charter editor — no system prompt, no observation-key
picker, no model, no budget, no dial. Never a file uploader.

**Backend.** `POST /agent/fleet/assignments`. **Must refuse, with the reason in
the body**, any `(worker, targetKind)` pair the evidence layer cannot honour —
mirroring `agent-fleet-workers.routes.ts:128-135`, which refuses a
two-marketplace scope rather than accepting and ignoring it. Every route needs a
permissions-manifest entry or `check-rbac-coverage` fails the push.

---

### AS-S4 · What it will actually look at

**Purpose.** Before you start it, and again on the record afterwards: state
plainly what this assignment narrows, and what is withheld because it cannot be
narrowed.

**Contents — two honest halves.** The default answers one question in one
sentence: **"It will look at GALE | IT | Broad only — nothing else in your
account."** Everything else sits behind a closed disclosure labelled **"Why can't
it see everything?"**.

- **Static half** (no database read, always shown): which evidence this worker
  reads, which of it honours a target, which is withheld, and the resolved spend
  ceiling.
- **Measured half** (operator-triggered, labelled *"this reads the last 60 days
  of search terms and may take a few seconds"*): the real counters, served
  through the observation cache so a second click is free.

**Never print `droppedOutOfScope`, `unresolvedCampaign` or
`ngramsWithheldUnderScope` as named counters in a primary view**, and never say
*"3 of 4 evidence sections"* — a beginner reads that as breakage. Translate to
prose inside the disclosure.

**Why here.** It is a statement about the intersection of **this** worker's
evidence and **this** target, and that intersection exists as a concept nowhere
else. It is also this page's answer to the series' own law — *a control that is
not enforced must not be rendered* — made visible to the operator rather than
only to the reviewer.

**Must never become.** A cost dashboard or a blast-radius report. One ceiling
figure; blast radius belongs to the plan guard and Approvals.

---

### AS-S5 · One assignment — its life

**Purpose.** The record of a single job: where it is, why it is there, and every
attempt it has made.

**Contents.** Back link · state chip with its reason in plain words · the frozen
brief (worker, target, what you wanted back, due, who made it, when) · **the
life**: one row per attempt, newest first, each with its outcome sentence from
the shared `outcomeOf()`, duration, cost, and — for failures —
`classifyFailure()`'s class and blame · **what it found**: ≤12 findings with
severity, entity name and the `rationale` string **verbatim** (that field is
explicitly never parsed by code — it is the human sentence), then a count and
"see all in Activity" · **what it cost**: one number · **evidence provenance**:
the observation rows the runs cited, with vintages, so a stale-evidence stop is
explainable without opening a trace.

**Actions.** **Start again** (through `ConfirmSpend`, naming the target) ·
**Close** · **Cancel** · **Reopen** · **Delete** (only from Not started or
Cancelled, never once a run exists — then the runs are the record and Close is
correct).

**Close and Cancel apply immediately with no dialog, and are reversible** — a
6-second *"Closed. Undo"* toast plus a real Reopen route. Linear tolerates
no-confirm only because it ships universal undo; copy the pair or neither.
Reversibility is one nullable column and it removes the only irreversible action
a beginner can reach by accident.

**Start is idempotent.** Starting an assignment that already has a run with
`status='running'` **returns that run** rather than creating a second — Temporal's
`UseExisting`, and the answer to a double-click on the one control that spends
money. The confirm says so: *"Starting twice does nothing — if a run is already
open you will be taken to it."*

**Why here.** The chain assignment → run → finding → cost exists nowhere else,
because until this page there was no assignment to hang it on.

**Must never become.** A trace viewer, a second approvals inbox, or a findings
browser. Each has already been claimed once too often across the ten pages.

---

### AS-S6 · Make many at once

**Purpose.** One assignment per selected campaign, in one pass, with the count and
the ceiling shown before anything is written.

**Contents.** From the shared campaign picker, select N → *"Assign to each"* → one
worker, one shared "what you want back", one shared due date → N assignments, all
**Not started**. A hard preview before commit — *"This creates 14 assignments
across 14 campaigns"* — over **concrete resolved ids, never a live filter** (a
filter-derived selection is a query, not a set; Google Ads documents its own count
drifting between selection and commit). A cap of 25, stated in the UI. Per-row
created/refused with reasons afterwards, and **"Delete all 14"** on that panel.

**Creating is not starting.** Everything lands Not started; **there is no bulk
Start in v1.** Bulk creation is reversible by deletion; bulk starting is spend,
and spend on a fleet the operator switched off is the one thing this page must
never make easy.

**Why here.** The picker and the object both live here. A bulk create on the
campaigns grid would have to import this object's refusal rules into a page that
owns none of them.

**Must never become.** A bulk mutator — no bulk Start, no bulk close, no bulk
edit.

---

### AS-S7 · The teaching layer — a condition of done, not a section

The operator's standing requirement is *"everything must have proper tooltips."*
That is structural here, not editorial: **every state chip renders its
one-sentence definition from the same `ASSIGNMENT_STATES` record that names it**,
so chip, tile, filter, glossary and tooltip cannot drift.

**Minimum tooltip inventory:** the 7 state chips · the due badge (*"Due 12 Aug. A
due date only colours this row — it never starts or stops anything."*) · the
target chip (full name + id) · the spend ceiling · the cost figure · the worker's
cap.

**Glossary mints exactly two terms: `assignment` and `target`** — matching the
Workflows study's two-noun commitment. Not `deliverable` (the surface word is
**"what you want back"**, everywhere, and the schema column nobody sees is
`wantBack`). Not `overdue` (an ordinary English word; the badge tooltip carries
the semantics). Never redefines `trigger`, `workflow`, `gate`, `draft`, `publish`
— one definition per term is why `<Term>` exists. Append-only, re-read
immediately before editing (locks §3).

A **"How this works"** drawer on the page header, per FX.4.

---

## PART 6 — The engineering truth, and the defect this page inherits

### 6.1 "Run the negative miner on campaign X" is impossible today, at every layer

Verified in code. Scoping happens at **observation-gathering time only**, for
**marketplace only**, at **one line**:

```ts
// agent-executor.ts:312-314 — the ONLY non-test call site of getObservation
const obs = await getObservation(obsKey, {
  marketplace: singleMarketplace(charter.scopeMarketplaces),
})
```

Not at prompt time (`buildPrompt` has no slot — `:127-145`). **Not at write
time** (`runOrQueueTool` takes no charter and no scope —
`approval-gate.service.ts:38-95`). Nowhere else.

Five separate additions are needed, none large: the route accepts no body;
`ExecuteOptions` has no target field; the executor passes only marketplace; the
builder reads only `scope.marketplace`; the engine is called unfiltered.

**Whatever an assignment claims to narrow must be narrowed in the EVIDENCE,
because nothing downstream re-checks it.** A constraint stated only in a prompt
produces an unchallenged finding → plan item → approval for an out-of-scope
campaign, with nothing objecting.

### 6.2 The defect this page exists to fix — and must not repeat

`AgentCharter.scopeCampaignIds` is **stored** (`schema.prisma:15460`),
**accepted** at worker-create with zero validation
(`agent-fleet-workers.routes.ts:164`), **merged** onto the effective charter
(`charter-registry.ts:236`), and **rendered in two places** —
`WorkerClient.tsx:461-462` (*"· N named campaigns"*) and **`WorkersClient.tsx:725`**,
the roster shipped at W.1 — while being **read by no query, no filter and no
prompt anywhere in the codebase.**

The series' own house rule is written verbatim in the code that enforces the
marketplace version, `observations/scope-filter.ts:6-7`:

> *"House rule from this series: a control that is not enforced must not be
> rendered. This is the enforcement."*

**A worker can be created scoped to three campaigns, the roster will say so, and
the worker will read all 220.** Raised as locks §5 decision 7; the fix is
Workers' to choose, and this page ships the enforcement regardless at AS.1.

### 6.3 Scope is an INTERSECTION, never an override

The dangerous direction is widening. `agent-executor.ts:313` reads the
**charter's** scope, not the run's. If an assignment target simply overrode it,
an assignment on a charter scoped to IT could be pointed at DE and would read DE
evidence — **an assignment silently widening a worker past the scope set on the
Workers page.** That is the `scopeCampaignIds` defect at higher blast radius.

> **Law:** `effective = charter.scope ∩ assignment.target`. If the charter
> carries a scope and the intersection is empty, `POST /assignments` **refuses at
> create** with the reason in the body. If the intersection is empty at **run**
> time (the charter moved after create), the run goes to **Stopped** with
> `target_outside_worker_scope` — never to `undefined`, which is account-wide.

### 6.4 An assignment cannot produce an approval in v1 — structurally

`runOrQueueTool` is the only creator of an `AgentApproval`. Its only fleet caller
is `fleet-council.service.ts:164`, reachable only from the `fleet-council` cron.
**`executeCharter` never calls it, at any autonomy level, for any worker.**

**The Approvals stream reached the same wall from the opposite end, independently**
(locks §2, `SB.AQ`): all three fleet propose-tools are **preview-only**, so
`runOrQueueTool` returns `mode:'preview'`, the council counts them `blocked++`,
and *"no fleet approval can be created at all — a plan that PASSES the critic
still queues nothing."* Two independent proofs, one from the caller end and one
from the tool end, of the same fact.

So *"Awaiting your approval"* is not merely untested — it is a provable zero. The
tile, the derived state and the detail panel **ship deleted, not empty**, replaced
by one honest sentence: *"Assignments cannot produce approvals yet. Only the
weekly council queues actions for your decision, and it does not read assignment
runs."* Re-added when a plan created outside a council orchestration can be
consumed.

### 6.5 Three workers are not assignable in v1, and the reasons are specific

- **`amazon-ads-director`** — `findingCount` is only written for
  `outputSchemaKey === 'analyst-output'` (`agent-executor.ts:561`), so a director
  run returns `ok:true, findingCount:0` and would render as *Finished, found
  nothing* while having written an `AgentPlan`. Worse, that plan is
  **unreachable**: `runFleetCouncilOnce` locates its director run by
  `orchestrationId: fleet.orchestrationId` (`fleet-council.service.ts:57-60`), so
  a plan created outside a council is never critiqued, never queued, never
  approved. *An assignment on the director costs money and produces an orphan
  artifact the operator cannot see or act on.*
- **`plan-critic`** — `executeCharter` **throws unconditionally** when the
  pending-plan evidence carries no planId (`agent-executor.ts:653-657`), and the
  catch branch still writes `costUSD`. The one plan in production is blocked.
  *A critic assignment is a paid, guaranteed failure — the worst possible first
  experience.*
- **`fleet-auditor`** — has no `AgentCharter` row at all and has never run.

The create route refuses all three with the reason printed in the picker.

### 6.6 The model

```prisma
// ─── NAF.SB.AS ───  migration 20260807e
/// One worker, one target, one job. `Agent*` prefix is mandatory:
/// `WorkflowAssignment` already exists as an unrelated PIM model.
model AgentAssignment {
  id           String    @id @default(cuid())
  charterKey   String    // resolved via resolveCharter — built-ins AND W.8 instances
  title        String    // derived worker+target at create; operator-overridable; never empty
  targetKind   String?   // null | CAMPAIGN | MARKETPLACE
  targetIds    String[]  @default([])  // EXTERNAL Amazon ids — the fleet's lingua franca
  targetLabels String[]  @default([])  // frozen at create; names drift, ids do not
  wantBack     String?   @db.Text      // optional, prefilled from the charter one-liner
  dueAt        DateTime?               // classifies and colours; never blocks, never starts
  state        String    @default("not_started")
  closeNote    String?   @db.Text
  createdBy    String?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  closedAt     DateTime?
  @@index([state, createdAt])
  @@index([charterKey, createdAt])
}

/// Which runs detected which finding. Written on BOTH branches of the
/// existing upsert — see 6.7 for why AgentFinding.runId cannot answer this.
model AgentFindingRun {
  findingId  String
  runId      String
  detectedAt DateTime @default(now())
  @@id([findingId, runId])
  @@index([runId])
}

// on AgentRun (additive, mirroring what WF.2 did for workflowKey):
assignmentId String?   @@index([assignmentId])
```

Also set the two **already-indexed, never-used** columns `AgentRun.entityType` /
`entityId` from the target — making *"which runs ever touched campaign X"*
answerable forever, for free. And add `'assignment'` to the `mode` union
(`mode` is a free String with no DB enum; WF.6b set the precedent with
`'custom'`), so every existing `?mode=` filter serves it immediately.

**Deliberately absent:** no `cron` (recurrence is Workflows'), no `gate` (it would
bind nothing — 6.2's defect class), no `notBefore` (needs a clock), no `fileId`
(SB.7 does not exist), **no `priority`** (2D).

**Audit:** `control-audit.service.ts` carries a **closed** `ControlAction` union
shared by Controls and Approvals, and is **not** in locks §3 — a claim is
required. Reuse the existing `run_now` for Start rather than minting a synonym;
mint at most `assignment_closed` and `assignment_cancelled`, and ship their
operator-facing phrases in the same commit so Controls never renders a bare
action string. Write from the **service**, not the route — the known hole is that
route-layer auditing makes a script invisible to the trail.

### 6.7 Attribution: why `firstRunId` is not the fix

The tempting one-line fix — freeze `AgentFinding.runId` on create — **swaps one
lie for another.** The unique is
`@@unique([charterKey, entityType, entityId, dedupeKey])` and the enforced
`dedupeKeyPattern` is `<kind>:<entityId>`. **There is no scope in the key.** Two
assignments on the same worker over overlapping evidence collide on one row: the
same wasteful search term under campaign X and campaign Y. Today the row
re-attributes to the newest run; frozen, it would stick to the *first* assignment
and the second would render *"found nothing"* while its findings landed under
someone else's job — silently.

`AgentFindingRun` is two lines in the existing upsert, changes no behaviour, and
lets a finding legitimately belong to two assignments.

### 6.8 The observation cache must stay account-scoped

`AgentObservation` is `@@unique([key, entityType, entityId, marketplace])`, so
keying evidence per campaign means **no two campaign-scoped assignments share a
cache row** — 25 bulk-created assignments would perform 25 full-account
`previewHarvest` + `analyzeNgrams` scans and write 25 rows per builder.

**Keep the cached row account-scoped** (one scan per 6h TTL, shared by every
assignment) and apply `filterToCampaigns` at prompt-assembly time, recording the
counters on the **run** row. This also keeps `evidenceRefs` pointing at one row
every assignment can legitimately cite, which the executor's evidence-id
validation requires.

### 6.9 The reaper already exists

`reclaimStuckRuns(maxAgeHours = 2)` (`orchestrator.ts:257`) closes any fleet run
stuck `running` past the cutoff to `haltedReason: 'orphaned: …'`. Three
consequences: it fires **only from the sweep and council crons**, which on a dark
fleet may never run — so **the assignments service calls it on every list read**
(it is an idempotent `updateMany`); its `updateMany` **never writes `costUSD`**,
so an abandoned run shows €0 and must be excluded from the cost sum with a
footnote rather than adding a zero; and `ControlAction` already carries
`cancel_run`, so the series has a cancel concept.

**Honest statement for the UI:** *"A run cannot be cancelled once it has started —
the executor has no cancellation seam. A hung run is closed after 2 hours, and
until then the row says how long it has been silent."* A Stop button that greyed
the row while the model call continued would be a lie about spend.

### 6.10 The laws, checked explicitly

**L2 — zero new write paths.** Start calls `executeCharter(ignoreEnabled: true)`,
the identical clause `POST /agent/fleet/run/:key` already uses
(`agent-executor.ts:225-226`). Analyst charters write only `AgentFinding`.
`runOrQueueTool` is never reached (6.4). **No new write path.**
**L3 — no agent spawns an agent.** A human presses Start. **Holds.**
**L7 — blackboard, not mailbox.** An assignment carries a typed target and a
short intent, never a transcript. **Holds.**
**The one caveat:** a director assignment would write an orphan `AgentPlan` —
which is why the director is refused (6.5).

`ignoreEnabled` bypasses **only** the OFF/pause gate. Kill switch, fleet halt,
charter day budget, fleet day budget, evidence staleness (checked *before* the
provider, so that stop costs $0) and the mid-run token budget all still bind, and
it cannot revive a retired instance. **An assignment inherits the full layered
ceiling for free.**

**One authority question stated rather than buried:** `ignoreEnabled` also
overrides a **live pause**. An assignment can start a paused worker. That is
today's behaviour for Run-now; it is named here so the operator meets it in the
confirm rather than in the bill.

### 6.11 Worker instances are unreachable by every manual route

Every manual-run, preview, evaluate, revision, pause, resume and PATCH route
gates on `FLEET_CHARTERS[key]`, so a **W.8 instance 404s on all of them** — even
though `resolveCharter` and the workflow validator both resolve instances
correctly. **Start must call `executeCharter` directly, never
`POST /agent/fleet/run/:key`**, or every operator-created worker fails for
exactly the workers the operator most recently made. Zero instances exist today,
so this bug would not surface until the day someone creates one.

---

## PART 7 — Operator decisions requested

**1 · The v1 assignable roster is three workers, not seven.**
Recommend: the picker contains **only workers that can be pointed at something** —
`amazon-negative-miner`, `amazon-keyword-harvester`, `amazon-bid-tuner`. The
director and critic are refused for the specific code reasons in 6.5; the auditor
and self-test read the whole account and are run from Workers. *Why:* it makes
the page's headline literally true instead of false for five of seven workers,
and deletes the disabled-picker branch entirely. *Alternative:* offer all seven
with disabled targets — rejected, because the operator spends a decision before
being told it was the wrong one.

**2 · Target kinds: CAMPAIGN first, MARKETPLACE second, PORTFOLIO nearly free.**
Recommend: **AS.1 ships CAMPAIGN** — the operator's verbatim ask, and
`filterToCampaigns` is ~15 lines of *pure in-memory* filtering (harvest
candidates already carry `externalCampaignId`, so unlike the marketplace path it
needs **no DB read**). **Marketplace is deliberately not first**, because W.8
already ships marketplace scoping at worker-create — shipping it first would make
the first slice of this page the duplicated one. **Portfolio** is a tab we would
be *deleting* from the extracted picker, so take it in AS.2. Ad group, ASIN and
keyword-set are **absent with printed reasons** — `analyzeNgrams` takes no scope
at all, and `previewHarvest`'s own comment warns that an empty `adGroupExternalIds`
array intentionally matches nothing, so a resolution bug there harvests zero
silently.

**3 · Retire `on-demand-check`.** Recommend: retire it in the same commit as
AS.1, with the Workflows stream's consent, and point its card here. *Why:* it
promises this page's feature with `steps: []` and no implementation. **But the
real collision is not that card — it is the WF.5 test lane**, which already runs
one worker by hand through `executeCharter` with an up-front cost estimate. The
separating rule, proposed for locks §5: **the test lane runs a DRAFT DEFINITION
and writes nothing durable; an assignment run is a real run that writes findings
and is an attempt on a container the operator created.** Assignments' Start never
routes through `/workflows/:key/test`.

**4 · No recurrence on either side in v1.** Recommend: **delete the "Make this
repeat" button entirely.** *Why:* `WorkflowStepV1` has no target slot, so creating
a routine from a campaign-scoped assignment would produce an **account-wide**
recurring routine with the target silently dropped — precisely the
static-scope-rots failure named as this page's worst possible bug. And the
premise of a conflict is wrong: **Workflows has already chosen**
(`naf-wf-workflows-page.md:222` — *"An assignment arriving is a future workflow
trigger type; the assignment object itself never lives here"*) and WF.6 defers it
pending this page. Our v1 obligation is to **define the trigger payload**
(`charterKey + targetKind + targetIds + wantBack`) so `WorkflowStepV1` can grow a
target slot in a later WF phase. The assignment detail says: *"Assignments do not
repeat. A routine that runs a worker on a clock lives on Workflows — and it
cannot yet carry a target, so it would run the whole account."*

**5 · Closing an assignment does nothing to its findings.** Recommend: no.
Closing is a note about the **job**. All 64 findings are `open` and no transition
has ever occurred; the first code to move one should be the code that owns the
concept (Activity / SB.10). Otherwise an operator loses evidence by tidying their
list.

**6 · Show the typical cost, not just the ceiling.** Recommend the confirm reads
*"Usually about €0.01. It cannot spend more than €0.50 today, across every run of
this worker."* — typical from the median `costUSD` of this charter's last ten
completed runs, computed server-side; with no history, *"No runs yet to estimate
from"* rather than an invented number. *Why:* a measured `ask` run on this fleet
costs about **€0.014**; showing a daily ceiling 30× that as the only figure, to an
operator who deliberately switched the fleet off, is the most likely reason nobody
ever presses the button.

---

## PART 8 — Build order

Each step independently shippable and visibly better.

| Step | What | New backend |
|---|---|---|
| **AS.1** | The object, list, strip, create drawer, detail, **Start** — **CAMPAIGN target** for the two workers with an evidence seam. Six states. Idempotent Start. Delete / Reopen. `filterToCampaigns` + the **intersection** precedence rule. | `AgentAssignment` + migration `20260807e`; `agent-fleet-assignments.routes.ts` with RBAC manifest entries; `AgentRun.assignmentId` + `entityType`/`entityId`; `ExecuteOptions.assignmentId` + `target`; `filterToCampaigns` in `scope-filter.ts`; audit from the service |
| **AS.2** | `amazon-bid-tuner` (one argument to `previewBidOptimization` — **but it takes the INTERNAL `Campaign.id` while every fleet id is the EXTERNAL one**, so resolve at observation time) · MARKETPLACE and PORTFOLIO kinds · **the deep link from the campaigns grid** | id resolution; picker extraction |
| **AS.3** | AS-S4 pre-flight — static half always, measured half on demand | `GET …/assignments/preview` (must **not** call the model and must **not** create a run row — `preview:true` does both) |
| **AS.4** | The life: every guard named with its fix, `classifyFailure` blame, **Abandoned** + the reaper called on list reads, due dates and the colour ramp, `outcomeOf()` extracted to `run-health.ts` | none new |
| **AS.5** | `AgentFindingRun`; the "what it found" panel; evidence provenance | join table + 2 lines in the upsert |
| **AS.6** | Bulk create with the hard preview, the cap of 25, per-row results and Delete all | `POST …/assignments/bulk` |

Teaching layer, tooltips and `<Term>` coverage are **not a step** — they are a
condition of done on each one.

---

## PART 9 — Honest risks

1. **The page is empty on day one and its likeliest steady state is one row, Not
   started, forever.** Nothing picks up an assignment on its own.
2. **A campaign-scoped miner sees strictly less and will find less.** N-grams are
   cross-campaign aggregates with no campaign of their own and are withheld
   entirely under any narrowing. Operators will read that as broken. It is
   correct behaviour with an existing precedent, and it must be explained at the
   moment of choosing, not afterwards.
3. **Narrowing is a post-filter, not a narrowed query.** A one-campaign
   assignment costs the same database work as an account-wide one. Fine at 220
   campaigns; it does not scale to per-ad-group, and pretending otherwise sets up
   a rewrite.
4. **Failure is 31.6% of all runs to date**, and 21 of those were the provider
   being unreachable. The page will show failures often, and must never blame the
   worker for the network.
5. **`fleet-selftest` holds 47 of 64 findings.** Any aggregate that includes it is
   a diagnostic's shadow — it is not assignable in v1, which sidesteps this.
6. **Seven states is at the top of what a beginner holds.** The reason string on
   each chip is load-bearing, not decoration: if it is ever weaker than the state
   name, the page becomes seven words nobody can distinguish.
7. **Two objects on adjacent rail items are both queues.** Approvals is *the
   blocking queue*; this uses the queue-item model. The words are banned here.

---

## PART 10 — Cross-session

Protocol: `docs/2026-08-07-naf-sb-session-locks.md`. Claim recorded in §2.

### 10.1 Raised with the Fleet map (SB.M)

Their approved D1 draws effective wiring as the **union of enabled workflows**.
An assignment run is a **one-node walk belonging to no workflow**, so it lights a
node with no edge — invisible under that model, or rendering as a node pulsing
with nothing flowing in or out, which reads like a bug. **Their decision, not
mine** — it is a rendering choice on their canvas, and I do not want an
Assignments concept leaking into the map's model. My only obligation is that
assignment runs are identifiable via `AgentRun.assignmentId`.

### 10.2 Settled with Approvals (SB.AQ)

A five-field contract agreed in full, both sessions still in study:

- `GET /agent/fleet/approvals/rollup?assignmentIds=…` → `{ waiting, parked,
  returned, decided, expired }`, the `decidedBy`-set exclusion **inside** the
  rollup, ≤100 ids, **rejected over the cap, never truncated**
- `GET /agent/fleet/assignments/labels?ids=…` → `{ label, targetLabel, dueAt,
  state, href }` — my words rendered verbatim; **`href` so their card does not
  hardcode my route shape, and no denormalised label column, because a label that
  goes stale on rename would put their card and my page in disagreement about my
  own object**
- `AgentRun.assignmentId` — mine, `20260807e`; **they never read
  `AgentAssignment`**
- Deep link `/fleet/approvals?assignment=<id>`, landing the queue filtered
- **They own the decision; I own the lifecycle.** No approve/reject affordance
  here in any form — it would duplicate or bypass the Article-14 evidence gate,
  the per-worker track record, the AP.6 staleness re-check and the 20-second undo

Two findings of theirs that changed my design: **"waiting" is not
`status='pending'`** (it is `pending` + `scheduled`, and a *failed execution
returns an approval to `pending` with `decidedBy` still set*), and their
`whereFor()` tool filter means a non-ads approval is created, never shown, and
expired in 24h unseen. One finding of mine changed their naming: **`blocked` →
`returned`**, because `blocked` is already the *critic's verdict on a plan* and
the fleet's only plan is blocked — the word would have meant two things on the
one page where both are in play.

**Correction owed and sent:** 6.4 proves an assignment run **cannot** produce an
approval in v1. The contract stands — it is right the day it can fill — but every
counter is structurally zero until then, and their card's *"from your
assignment"* line has nothing to render yet.

### 10.3 Raised for locks §5

- **Decision 7 (written):** `scopeCampaignIds` is rendered on two shipped
  surfaces and enforced by nothing — the third instance of the stale-constant
  class and the first that is a live lie to the operator. Workers owns the
  choice; this page ships the enforcement at AS.1 regardless.
- **Proposed:** the test-lane / assignment separating rule (Part 7, decision 3).
- **Proposed, in Activity's "silence is assent" form:** no recurrence on either
  side in v1 (Part 7, decision 4). **Consequence for the Workflows stream: none,
  and no code changes asked.**

### 10.4 Claims this page will need

`app/fleet/assignments/**` · `agent-fleet-assignments.routes.ts` (new) ·
`assignment*.service.ts` (new) · `_sbas-*.mts` · migration `20260807e` ·
**additive to `_shared/run-health.ts`** (`outcomeOf`) · **a claim on
`control-audit.service.ts`** (closed union, shared, not yet in §3) · **a claim on
`agent-fleet-workers.routes.ts`** only if Workers wants this page to land the
`scopeCampaignIds` refusal.

---

## Sources

**RPA queues** — [UiPath queues](https://docs.uipath.com/orchestrator/automation-cloud/latest/user-guide/about-queues-and-transactions) · [item statuses](https://docs.uipath.com/orchestrator/automation-cloud/latest/user-guide/transaction-statuses) · [queue triggers](https://docs.uipath.com/orchestrator/automation-cloud/latest/user-guide/queue-triggers) · [Action Center](https://docs.uipath.com/action-center/automation-cloud/latest/user-guide/managing-actions) · [Blue Prism work queues](https://docs.blueprism.com/en-US/bundle/blue-prism-enterprise-7-3/page/user-guide/control-room/ug-cr-queue-management.htm) · [Automation Anywhere WLM](https://docs.automationanywhere.com/bundle/enterprise-v2019/page/enterprise-cloud/topics/aae-client/bot-creator/using-workload/cloud-queues.html) · [Power Automate work queues](https://learn.microsoft.com/en-us/power-automate/desktop-flows/work-queues)

**Agent tasks** — [GitHub Copilot coding agent](https://docs.github.com/en/copilot/using-github-copilot/coding-agent/about-assigning-tasks-to-copilot) · [Devin sessions](https://docs.devin.ai/get-started/devin-intro) · [Relevance AI approvals](https://relevanceai.com/docs/build/workforces/workforce-features/approvals-and-escalations) · [CrewAI tasks](https://docs.crewai.com/en/concepts/tasks) · [Copilot Studio multi-agent](https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/multi-agent-patterns)

**Work management** — [Linear issues](https://linear.app/docs/creating-issues) · [Linear workflows & statuses](https://linear.app/docs/configuring-workflows) · [Jira bulk change](https://support.atlassian.com/jira-cloud-administration/docs/edit-multiple-issues-at-the-same-time/) · [ServiceNow assignment rules](https://www.servicenow.com/docs/bundle/zurich-platform-administration/page/administer/task-table/task/t_CreateAnAssignmentRule.html)

**Orchestration** — [Temporal workflow id reuse](https://docs.temporal.io/workflow-execution/workflowid-runid) · [Airflow task instances](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/tasks.html) · [Dagster backfills](https://docs.dagster.io/guides/build/partitions-and-backfills/backfilling-data) · [Prefect work pools](https://docs.prefect.io/v3/concepts/work-pools) · [SQS DLQ](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)

**Ads entity scoping** — [Amazon Ads bulk operations](https://advertising.amazon.com/help/GHTRFDZRJPW6764R) · [Google Ads automated rules](https://support.google.com/google-ads/answer/2472779) · [Shopify Flow](https://help.shopify.com/en/manual/shopify-flow)

**In repo** — `docs/2026-08-07-naf-sb-fleet-pages.md` §7 · `docs/2026-08-07-naf-sbw-workers-page.md` · `docs/2026-08-07-naf-wf-workflows-page.md` · `docs/2026-08-07-naf-sb-session-locks.md` · `docs/AGENT_FLEET.md` Parts 4, 6, 7 · `apps/api/src/services/agent-fleet/agent-executor.ts` · `charter-registry.ts` · `orchestrator.ts` · `observations/scope-filter.ts` · `apps/api/src/services/agents/approval-gate.service.ts` · `apps/api/scripts/_sbas-assignment-truth.mts`
