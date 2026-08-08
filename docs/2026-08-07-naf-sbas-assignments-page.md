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

> **SUPERSEDED IN PART by AS-S1R (Part 11), approved 2026-08-08.** The strip is
> now a chip band, not metric tiles, and it carries **six** state chips plus an
> *All* chip — not five. **The Overdue tile reserved below is retired, not
> deferred**: overdue is already carried twice, by the badge on the row and by
> the default ordering that lifts it to the top, and a seventh chip that appears
> and disappears with the data makes the band's arithmetic harder to trust for a
> fact the first row already shows. Everything else in this section still holds,
> and the counts still come from `views.ts`.

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

`runOrQueueTool` is the only creator of an `AgentApproval`, and it has **five**
callers in `apps/api/src` — `fleet-council.service.ts:164` (the only *fleet*
one), the two legacy ACP paths (`tool-loop.service.ts:197`,
`approval-gate.service.ts:117`), and **two scheduled autonomous agents**
(`agents/autonomous/pricing-watchdog.ts:155`,
`agents/autonomous/listing-quality-keeper.ts:201`) whose tools *do* have
executors and which produced the 18 historical rows.

The load-bearing fact is unchanged and is about the caller that is **absent**:
**`executeCharter` never calls `runOrQueueTool`, at any autonomy level, for any
worker.** So a sweep run, an `ask` run and an assignment run are all structurally
incapable of queueing an approval. *(An earlier draft of this section said the
council was the only caller at all — that was a grep scoped to two directories.
Corrected from the Approvals stream's full sweep; the conclusion it supports did
not move, but the two autonomous callers matter to them and are recorded here so
this document does not under-report the surface.)*

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

### AS.1 — EXECUTED 2026-08-07, enforcement proven on production data

**Operator decision, taken before build:** the v1 roster is restricted to the
targetable workers (Part 7 decision 1, approved). One consequence worth stating
plainly rather than letting it look like silent narrowing: **AS.1 ships two of
the three.** `BidProposal` carries `targetId` but **no** `externalCampaignId`, so
the bid tuner cannot be post-filtered like the other two — it needs the engine's
own `campaignId` argument, which takes the **internal `Campaign.id`** while every
fleet-facing id is the Amazon external one. That is a second, different
enforcement mechanism with its own id-dialect trap, so it lands at AS.2. The
picker shows exactly the workers whose campaign scope is *enforced today*;
showing the third before its enforcement exists would repeat the very defect this
page was built to fix.

**Shipped.** `AgentAssignment` + `AgentRun.assignmentId` (migration `20260807e`,
applied clean to prod) · `filterToCampaigns` in `scope-filter.ts` (pure,
in-memory — candidates already carry `externalCampaignId`, so unlike the
marketplace path it needs no DB read) · a `narrow()` hook on the observation
builder contract · `assignment-scope.ts` holding the intersection law ·
`assignment.service.ts` + `agent-fleet-assignments.routes.ts` · the list, state
strip, create drawer, detail page, and the How-this-works drawer.

**The cache decision held.** `narrow()` runs **after** the cache read and is
deliberately not part of the cache key, so twenty-five campaign-scoped
assignments share **one** account-wide `previewHarvest` scan instead of
triggering twenty-five. It also keeps `evidenceRefs` pointing at one row every
assignment can legitimately cite, which the executor's evidence-id validation
requires.

**Proven on production data** (`_sbas-narrow-probe.mts`, read-only — 12/12):

- Real narrowing: **4 of 9** live negative candidates kept for
  `GALE | IT | Exact | Category`; every kept row belongs to that campaign;
  `kept + dropped + unresolved` reconciles exactly.
- **Fail-closed, all three ways:** an empty scope yields nothing (never
  everything), `undefined` is the only value that means everything, an unknown
  campaign yields nothing.
- **`target_gone`** — a campaign that no longer resolves stops the run and
  returns no narrow, so a stale target can never fall through to all 220
  campaigns.
- **`target_outside_worker_scope`** — a DE-limited worker refuses an IT campaign.
  The intersection law holds in the widening direction, which is the dangerous
  one.
- **`target_unsupported`** — a worker whose evidence cannot narrow is refused
  outright rather than scoped for half its evidence.

**A real bug the tests caught before prod did.** The first `resolveAssignmentScope`
filtered the found campaigns by the charter's marketplace but never intersected
back with the ids actually named — so an IT-limited worker pointed at a DE
campaign would have run on a **different campaign the operator never named**,
while the row still displayed their choice. Worse than widening. Fixed by
re-asserting the ask in code rather than trusting the `WHERE` clause to be the
only thing bounding it; the vitest that caught it is `assignment-scope.vitest.test.ts`.

**Gates:** 23 new tests green (14 scope + 9 state), full agent-fleet suite
**327 passed / 37 files** (the `forceAsk` council test the locks doc recorded as
red is now green — fixed by its owner), `tsc` clean in both apps, RBAC coverage
**0 unmapped**, DS-conformance ratchet clean (three violations of my own —
a native date input, four inline `fontSize`s and one inline hex — fixed with the
DS `DateField` and page-local classes before pushing, since that ratchet is a
shared gate that blocks every session).

### AS.2 — EXECUTED 2026-08-08, the third worker and two more target kinds

**Shipped.** The bid tuner becomes assignable · **PORTFOLIO** target kind ·
the **"Assign" row action on the ads campaigns grid**, which is the entry point
the operator's ask actually implies.

**The bid tuner's trap, and why it is not the obvious fix.**
`previewBidOptimization` accepts a `campaignId` and would narrow the query
itself — but it takes the **internal `Campaign.id`** while every fleet-facing
id is the Amazon external one, *and* using it would key the observation cache
per campaign, so twenty-five assignments would run the account-wide engine
twenty-five times. Instead `narrow()` went **async** and does the dialect join
once: `AdTarget → AdGroup → Campaign.externalCampaignId`. One shared scan plus
one indexed join, and `evidenceRefs` still point at a row every assignment can
cite.

`targetAcosSummary` is **kept and relabelled account-wide** rather than
withheld: unlike the miner's n-grams it is *background* rather than a candidate
list, so removing it would delete the numbers that justify the bids without
removing a single proposal. Withholding and relabelling are different honest
answers to different kinds of unscopeable evidence.

**PORTFOLIO is enforced AS a campaign scope** — resolved to its member
campaigns at run time, then bound by the same filter. One binding path, not
two, so there is no second enforcement to keep honest. An empty or vanished
portfolio **refuses** (`target_gone`) rather than falling through.

**`narrowKinds` — the declaration that cannot become the next `scopeCampaignIds`.**
A per-observation declaration of which kinds it can honour, and the picker
derives from it. Split deliberately by what can be proven:
- **CAMPAIGN cannot lie** — `observation-builder.ts` **throws at import** if a
  builder declares it without a `narrow()`. A mistake is a boot failure.
- **MARKETPLACE binds inside `build(scope)`** and cannot be checked
  structurally, so it is checked **behaviourally**: a declaring builder must
  produce different evidence when given one, **and a non-declaring builder must
  ignore one** — so the omission is proven honest rather than assumed.
- **The default is refusal.** An undeclared feed returns `[]` → no targets →
  refused with a printed reason. (The Approvals stream hit the mirror-image bug
  the same night: a per-tool map defaulting to `?? []`, which compared nothing
  and complained about nothing. Same shape, opposite failure direction.)

The bid tuner declares **CAMPAIGN only** — its `build()` takes no scope
argument, so a marketplace target would bind nothing, and declaring it would be
the exact defect this page exists to fix.

**Proven on production data** (`_sbas2-narrow-probe.mts`, read-only — 15/15):
25 account-wide bid proposals spanning 12 campaigns, narrowed to exactly the
**11** belonging to `GALE | IT | Exact | Category`; 10 real portfolios, and
`Xavia GALE IT` resolving to exactly its 11 campaigns; an unknown portfolio
refused; the bid tuner accepting a campaign and still refusing a marketplace.
Suite **360 passed / 40 files**, both apps `tsc` clean, DS ratchet and
link-target guards green.

**One test deliberately changed rather than preserved.** AS.1 asserted that a
worker reading `bid-proposals` is *refused* a campaign target. AS.2 makes that
false on purpose, so the assertion now names `cron-health` instead — and two
new cases pin the change from both sides: the bid tuner **is** allowed a
campaign, and **is still refused** a marketplace.

**The deep link imports nothing.** `CampaignsGrid.tsx` gained one optional
field (the external id the API already returned) and one `<a>` to
`/fleet/assignments?new=1&targetKind=CAMPAIGN&targetId=…&targetLabel=…`. A URL
carries none of this page's rules across the boundary, which is why the grid
links rather than importing the assignment object — the objection AS-S6 raised
against a campaigns-grid entry point does not apply to a link.

### AS.3 — EXECUTED 2026-08-08, the pre-flight, split by honest cost

**The study was wrong here and the critique was right.** AS-S4's backend note
claimed *"nothing new is computed for display"* — false. `droppedOutOfScope`,
`unresolvedCampaign` and `ngramsWithheldUnderScope` are produced **inside
`build()`**, which runs a sixty-day scan of search terms. There is no way to
ask a builder what it *would* narrow without running it. So the panel splits
by what things actually cost:

- **Static half** — `GET /agent/fleet/assignment-preflight`. No scans, no
  model, no writes. Which evidence this worker reads, whether each feed
  honours the chosen kind, what is held back or stays account-wide, and the
  **resolved** ceilings (this worker's daily budget inside the fleet's). Safe
  on every keystroke; a vitest asserts it **never builds an observation**.
- **Measured half** — `POST /agent/fleet/assignment-preflight-measure`, behind
  a button that says what it costs first: *"Reads the last 60 days of your
  search terms and may take a few seconds. It calls no AI and writes
  nothing."* It builds real evidence **through the shared cache**, so a second
  look is free for six hours and every other reader benefits. It calls no
  model and creates no run row — `preview: true` on `executeCharter` does
  both, and this is deliberately not that.

**It refuses exactly where a run would refuse**, so the operator never gets a
cheerful preview of something that then stops.

**Knowledge stays with the builder**, same discipline as `narrow()`: `label`
(what the feed is, in the operator's words), `describeNarrowing(kind)` (plain
sentences about what a narrower scope does to it — returned **without running
anything**), and `itemCount(payload)` (one line per builder, so the panel can
say "4 things to look at" without the page learning every payload's shape).
The page holds no copy of what a feed contains, so the two cannot drift.

**The beginner rule held.** The default state is one sentence. `droppedOutOfScope`
and friends are never printed as named counters, and the phrase "3 of 4
evidence sections" appears nowhere — the *why a narrowed run finds less*
explanation sits behind a closed **"What will it read?"** disclosure.

**AS.3c — the record, moved from the assignment to the run.** The study said to
write the panel onto the assignment after a run. It goes on the **run's**
`input.resolvedScope` instead, and the reason is a correction: a portfolio
gains and loses campaigns, and a charter's own scope can be narrowed between
attempts, so *what it was allowed to look at* is a fact about **the attempt**.
Recording it per assignment would answer a different question, and recomputing
it later from a changed charter would answer a third. It also needs no
migration.

**Gates:** 9 new tests (369 across 41 files), API `tsc` clean, my web files
clean.

### AS.4 — EXECUTED 2026-08-08, two invariants typechecking cannot see

Most of AS.4's list shipped inside AS.1 — the eight states, the reaper on list
reads, the due-date ramp and ordering, `classifyFailure` blame. What remained
was the part that needed *proving* rather than writing, and one real gap it
found.

**The gap: three guards had no sentence.** `fleet_state_unreadable`,
`budget_tool_calls` and `target_unresolvable` fell through to the generic
fallback, so an operator would have read raw machine text at exactly the moment
they most needed a sentence. **This is the same shape as the `?? []` map the
Approvals stream found the same night** — a per-key map whose omissions are
invisible because the fallback does something plausible.

Closed by making omission fail loudly: `GUARD_PREFIXES` declares the complete
vocabulary an assignment run can emit (a snapshot of `agent-executor.ts`,
`budget-guard.ts`, `assignment-scope.ts` and the reaper, with citations,
because nothing web-side can derive it), and a vitest asserts **every one gets
a written sentence** — explicitly checking that neither the short nor the long
form equals the generic fallback, that the sentence is long enough to be
actionable, and that it never leaks a raw `snake_case` key. Add a guard without
a sentence and the test fails.

**The invariant: tiles must equal what clicking them reveals.** The blocking
critique named this precisely — a tile marked 3 landing on 2 rows teaches the
operator that the page lies — and nothing in the type system prevents it,
because the count and the filter were two expressions that merely looked alike.
Now they are one module (`views.ts`), the page **consumes it** rather than
keeping a copy, and the test asserts per-tile agreement plus that tiles and the
stated remainder account for every assignment. A test proving a module the page
does not use would have been its own lie.

**One more translation:** a retired worker surfaces from the executor as
`unknown charter: <key>` — true about the code, baffling to an operator looking
at a worker they can still see. `errorSentence()` turns it into what happened
and what to do instead.

**29 web tests**, both apps clean, DS ratchet green.

### AS.5 — EXECUTED 2026-08-08, attribution that survives the night

**The problem, restated exactly.** `AgentFinding` has ONE `runId`, and the
upsert's update branch rewrites it on every re-detection. So a finding produced
by an assignment silently re-attributes to whichever run noticed it most
recently — usually the next nightly sweep. No error, no warning: *"what this
assignment found"* just becomes shorter overnight. The detail page carried an
honest caveat about this since AS.1; it is now gone because the defect is.

**Why `firstRunId` was rejected** (the study's own first answer): freezing the
column picks a *different* lie. The finding unique is
`(charterKey, entityType, entityId, dedupeKey)` and carries **no scope**, so two
assignments over overlapping evidence collide on one row — the second would
render "found nothing" while its findings sat under the first's name. Both
failures are asserted in `assignment-attribution.vitest.test.ts`, including a
test that **demonstrates the old bug** so the reason for the join cannot be
forgotten.

**Shipped:** `AgentFindingRun` (composite PK, `@@index([runId])`, migration
`20260808a`, applied clean to prod) · written on **both** upsert branches,
because a re-detection is a real detection by that run · one batched insert with
`skipDuplicates`, so a model emitting the same `dedupeKey` twice cannot fail a
run · `getAssignment` reads findings through the join · **evidence provenance**
on the detail page: the observation rows the findings cite, with their vintages,
so a stale-evidence stop is explainable without opening a trace.

**One judgement the tests forced, worth recording.** The first version let the
join write throw. Ten existing executor tests went red, and the reason was the
real signal rather than a mock gap: **if that bookkeeping insert fails, a run
that has already persisted its findings and already paid for its model call
would be marked Failed.** The operator would see a failure for work sitting on
the board. So it degrades loudly instead — caught, logged with the run id and
count, run unaffected. Losing attribution is the smaller loss; destroying a
completed run to protect a foreign key is not a trade worth making.

**Verified:** table exists on prod, read path clean, 385 tests across 42 files.
**Honest limit:** the join holds **zero rows**, and will until an assignment is
actually started — which spends real money on a fleet deliberately switched off,
so it is the operator's call, not mine. The mechanism is proven by test and by
schema, not yet by a live row.

### AS.6 — EXECUTED 2026-08-08, and it resolved an ambiguity the page was shipping

**The inconsistency this found.** The campaign picker has been multi-select
since AS.1, and the drawer quietly created **one assignment covering all of
them**. That is a legitimate shape — *"look at these three together"* is one
job — but so is *"look at each of these three"*, and the operator could not
tell which they were getting. A page whose premise is *one worker, one thing*
was silently making a fourth thing.

So AS.6 is not a separate bulk surface: **the drawer asks what several targets
mean.** Pick more than one and it offers *"N separate assignments"* (default)
or *"One covering all N"*, with a sentence saying what each will do. That folds
the study's AS-S6 into the flow it belongs to, and avoids the second entry
point the boundary analysis warned about.

**Shipped:** `POST /assignments/bulk` (concrete resolved ids, **never a
filter** — a filter-derived selection is a query, not a set, and its count can
drift between the preview the operator agreed to and the commit) ·
`POST /assignments/bulk-delete` · the cap of **25**, stated in the UI and
**refused server-side rather than truncated** · a results panel showing
per-row created/refused **instead of** the form, because closing on a partial
success would hide the refusals · an **Undo** that deletes exactly what was
just made.

**Every row goes through the same `createAssignment`** as a single one, so it
inherits the identical refusals. A bulk path with its own validation is a bulk
path that eventually disagrees with the single one.

**Creating is not starting, and there is deliberately no bulk Start.** Every
row lands `not_started`. Bulk creation is reversible by deletion; bulk spending
is not, and making spending easy on a fleet the operator switched off is the
one thing this page must never do.

**Gates:** app boots with 2369 routes and 0 unmapped (a duplicate route path
would refuse to boot), 385 API tests, 29 web tests, DS ratchet clean, both apps
`tsc` clean. **Nothing was spent verifying it** — bulk create writes rows and
calls no model.

---

**One deliberate deviation from Part 3.4, stated rather than skipped.** The study
said to extract `outcomeOf()` into `_shared/run-health.ts` so Assignments,
Workflows and Activity phrase a run identically. I did **not** — the outcome
vocabulary here is assignment-specific (it carries "nothing to do" and the
target-specific stop reasons like *its campaign is gone*), and the shared
extraction only pays off when a second consumer actually wants those words. It
lives page-local in `states.ts` as `outcomeLine`. **Owed, not forgotten:** if
Activity or Workflows want it, the function is pure and moves in one commit.
Recorded in locks §3 so neither stream has to discover it.

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

## PART 11 — NAF.SB.AS-S1R · Section 1 restudied: the list as a *design*

**Status: AWAITING OPERATOR APPROVAL. No code written.**

Scope: `AssignmentsClient.tsx` — the list and the state strip. Not the create
drawer (AS-S3), not the detail page (AS-S5). The *model* is settled and
unchanged by this engagement: same states, same payload, same guards, same
words. Only what the operator looks at changes.

### 11.1 · PHASE 0 — the audit, measured on production

Method: the live Vercel build at 1728×906 and at 896px, with the list payload
replaced **client-side only** by 24 synthetic rows spanning all eight states
(`window.fetch` patched in the page; **nothing was written to the database and
nothing was started**). Geometry via `getBoundingClientRect`, contrast computed
from resolved `getComputedStyle` values against the resolved backdrop.

Nine defects. Every number below was measured, not estimated.

#### D1 · 42% of the table's width is allocated to nothing

At 1728px, 22 open rows, table width 1614px:

| Column | x | Width | Widest content | Unused | Ratio |
|---|---|---|---|---|---|
| STATE | 90 | **197** | 92 | 105 | 2.14× |
| ASSIGNMENT | 287 | 618 | 606 | 12 | 1.02× |
| POINTS AT | 905 | **429** | 125 | **304** | **3.43×** |
| LAST RUN | 1334 | **253** | 54 | 199 | 4.69× |
| DUE | 1587 | 117 | 50 | 67 | 2.34× |

**675px — 41.8% of the table — is empty by accident.** `acr-pg-tbl` is
`table-layout: auto` with no declared widths, so the browser distributes slack
by *text length*, which is not the same quantity as importance. The operator's
suspicion 4 is confirmed and it is worse than it looked: POINTS AT, the column
that carries this page's entire reason to exist, is three and a half times wider
than the widest thing in it.

#### D2 · The second line of every row is the same sentence

`CreateAssignment.tsx:124` prefills `wantBack` from `worker.description`. So
every row made from the negative miner renders *"Judges which zero-order
spenders and wasteful n-gra…"* — identical, truncated mid-word at 44ch, on every
row. Measured: it is what makes the row **56px instead of ~38px**, so on a
906px viewport it costs **five rows of the visible list** to say nothing.

The defect is not the truncation. It is that a *prefilled* field is not
information: it is the same string re-rendered per row, and the eye has to
re-read it each time to re-discover that.

#### D3 · The navigation target is 5.4% of the row

Measured on a 1066px-wide row: the row is 59,696px²; the only clickable thing
in it is the title anchor at 214×15 = 3,210px². **5.4%** — and it shrinks as
the viewport grows, because the row widens and the anchor does not. There is no
row action of any kind (suspicion 7, confirmed): no Open, no Close, no menu, no
whole-row target, no keyboard path to a row.

#### D4 · The column headers leave the screen and never come back

`.acr-pg-tbl th` computes `position: static`. With 22 rows the table is 1256px
tall inside a 723–906px viewport, so after one scroll the header sits at
**y = −515** and 22 rows of grey chips are on screen with nothing naming the
columns. The server cap is `take: 200` (`assignment.service.ts:408`), which is
~11,300px of exactly that. Suspicion 5, confirmed — and the failure is not
"slow", it is "unlabelled".

#### D5 · Four text roles fail WCAG AA, measured in place

| Role | Size / weight | Colour | Ratio | Verdict |
|---|---|---|---|---|
| `.acr-pg-stat .k` (tile label) | 10.5px / 700 | `#8d97a6` | **2.95** | fail |
| `.acr-pg-tbl th` (column header) | 10.5px / 700 | `#8d97a6` | **2.73** | fail |
| `.as-want` (row subtitle) | 11.5px | `#8d97a6` | **2.73** | fail |
| `.as-outcome.muted` (the delta) | 12px | `#97a1b0` | **2.41** | fail |
| `.as-title a` | 12.5px / 600 | `#1f2a37` | 13.43 | pass |
| `.as-target` | 11.5px | `#35507a` | 7.31 | pass |
| `.acr-pg-intro` | 13px | `#5a6675` | 5.40 | pass |

The first two are the shared roles the Workflows stream measured and posted in
locks §3 — **the same two numbers, independently reproduced on a second page**,
which settles that they are the stylesheet's and not one page's. The last two
failures are mine, page-local, in `assignments.css`.

The worst one is the one that matters most: **`.as-outcome.muted` at 2.41:1 is
the "never run" delta** — the single word the page exists to say about a fleet
that has never run anything.

#### D6 · The target chip silently drops its own icon

Measured across seven chips: six render an 11px icon; `GALE JACKET PRODUCT
TARGETING` renders **`svgW: 0`** and `scrollWidth 226 > clientWidth 218`.
`.as-target` is `overflow: hidden; max-width: 30ch` and the lucide `<svg>`
carries no `flex: none`, so on a long label the flex algorithm shrinks the icon
to zero before it truncates the text. The chip that most needs to say *"this is
a campaign"* is the one that stops saying it.

#### D7 · A portfolio target is labelled a marketplace

`AssignmentsClient.tsx:304-307` is a two-branch ternary: CAMPAIGN, else
*"Marketplace {label}."* AS.2 shipped PORTFOLIO as a third kind and never
reached this line, so hovering a portfolio row reads **"Marketplace Xavia GALE
IT."** — a false sentence about the object, on the page whose whole subject is
what the object points at.

#### D8 · The promise of a dead target chip was never kept

`.as-target.gone` exists in `assignments.css:72` and is applied **nowhere** —
grep across `app/fleet/` returns only `as-target` and `as-target account`. AS-S1
says *"If the target no longer resolves the chip goes red: Campaign no longer
exists"*. It does not, and it cannot: nothing on the list read resolves the
target. Today the only way to learn that a campaign is gone is to **start the
run and spend money to be told it stopped**.

This is the inverse of the fleet's stale-constant class: not a constant nobody
reads, but a **style nobody writes**. Same detection rule — grep for the writer,
not the declaration.

#### D9 · Small, specific untruths and omissions

- **The 200-row cap is silent.** `take: 200`, no total, no "showing the newest
  200". A silent cap reads as *"that is all of them"*.
- **"Nothing matches that filter"** does not name the filter, though AS-S1 says
  it must. With six tiles and a hidden closed-set, "that filter" is ambiguous
  between three different things.
- **Seven type sizes in one page body** — 10.5, 11, 11.5, 12, 12.5, 16, 19 —
  and the **16px** is the toolbar: `.acr-pg-sortbtn` and the "as of" stamp
  inherit the body size, so *"+ New assignment"* and the freshness stamp render
  larger than every row of actual content.
- **No search, no sort, no URL state** (suspicion 3, confirmed). Both sibling
  pages already mirror filter state to the address bar —
  `WorkersClient.tsx:287-292`, `ActivityClient.tsx:923-936` — so this page is
  the exception, not the precedent.
- **The strip spends 81px of vertical space on six numbers that are all `0`**
  in the shipped state, using `.acr-pg-stat`, which is a *metric* component,
  while `fleet-pages.css:126-151` already ships `.acr-pg-chip` — a filter chip
  **with a count slot and an `.on` state** — unused by this page.

#### D10 · Narrow widths: nothing drops, everything squeezes

Measured in a same-origin 900px iframe (an element-width probe does not fire a
media query — the Workflows stream's recorded trap), 12 rows:

| Column | 1728px | 896px |
|---|---|---|
| STATE | 197 | 106 |
| ASSIGNMENT | 618 | 299 |
| POINTS AT | 429 | 186 |
| LAST RUN | 253 | 129 |
| DUE | 117 | 62 |

All five columns survive; the title wraps to two lines; row heights become
**56 / 73 / 75 px — a 34% variance** down one list. The strip reflows to 4+2
with ~400px of blank beside the last two tiles. AS-S1's rule — *"state chip,
title and delta are the row's identity and never drop; worker, due and age drop
first; target collapses into the title line"* — was never implemented in any
form. Suspicion 6, confirmed.

---

### 11.2 · PHASE 1 — how the world renders *a list of work items with state*

Part 2 of this document researched the **model** (what an assignment is). This
pass is narrower: only the list page, and only *what does one row show and how
does it say it*.

**Sourcing honesty.** List pages are the least-documented screen in every
product — vendors document the editor and the detail view. Where a fact is
documented it is cited; where it is product knowledge the docs do not state, no
decision below rests on it alone.

| Product | Row carries | State shown as | "What happened" | Row actions | Notable |
|---|---|---|---|---|---|
| **Linear** | id · title · status · assignee · priority · labels · dates — **every one of them individually switchable** via *Display properties* | icon + colour, word on hover | — | keyboard-first; multi-select | **Grouping is a first-class control** (status, assignee, project, priority, cycle, label, parent, team, customer, release, SLA) with its own shortcut. Ordering is separate from grouping and from filtering. |
| **Sentry** | title + culprit · **events** · **users** · assignee · last/first seen | word + colour | **two counts**, sortable | assign, ignore, resolve | The row's two numbers are the triage input; sorting by them is the workflow. |
| **Datadog monitors** | Status · **Muted elapsed · Muted left** · Name · Tags, with a **column-visibility dropdown** | Alert / Warn / No Data / OK, colour + word | status graph on detail | hover → Edit, Clone, Mute, Delete; **bulk** mute/resolve/delete/edit | Has a *separate* "Triggered Monitors" page: the "needs you" subset is a view, not a badge. |
| **UiPath Orchestrator** | Transactions: Status · Progress · Started · Ended · Robot · exception type · reference | **grey = never executed is a state, not an absence** | per-item exception + retry lineage | retry, delete | *Retried* creates a **new item in New** rather than mutating — the "one job, many attempts" rule this page already follows. |
| **Temporal** | workflow type · id · run id · **status** · start/close time; filter by status/type/time; **Saved Views** | word | — | — | Status vocabulary is closed and small: Running / Completed / Failed / Canceled / Terminated / ContinuedAsNew / TimedOut. |
| **Airflow 3** | DAG id · schedule · next run · latest run · tags; **card view is the default, table is the escape hatch "for many DAGs"** | colour-coded run states | **bars: colour = outcome, height = duration** | pause, trigger, favourite, delete | And the counter-evidence — see below. |
| **GitHub Copilot agents page** | one row per delegated task, "**a clear status for each**"; click → session log with progress, token usage, session length | word | checklist inside the PR | open, steer, stop, archive | The nearest analogue to this page: *jobs a human handed to a machine*. |
| **Vercel deployments** | status · environment · branch · commit · duration; redesigned to a **denser layout "so you can see more deployments at once"**, grouped by environment | word + colour | duration | — | Density was the explicit goal of a redesign, not a side effect. |
| **Stripe payments** | amount · **status** · description · date | word | — | — | Four columns. The most-used financial list in the world is four columns wide. |
| **Jira** | list view: configurable columns | word | — | bulk change | The cautionary tale: the field configuration is a documented source of *"cognitive overload"*, and the Navigator's column picker only exposes the first ~10 fields — beyond that they are unreachable. |

**The seven things this changes for us, ranked:**

1. **Airflow's own users have falsified the picture-instead-of-a-number
   design.** Airflow 3 replaced per-DAG run-state counts with a bar chart;
   issue [#66946](https://github.com/apache/airflow/issues/66946) says it
   plainly — *the bar chart shows no numbers, you cannot tell if a DAG had 1
   failure or 50, you cannot sort by it, you cannot act on it.* Our AS-S1 rule
   ("one quantitative delta per row, never a spinner or a percentage") is
   independently confirmed by the strongest available counter-example. **Keep
   the number. Never trade it for a sparkline.**
2. **Sentry is the shape of this page.** Its row is identity + **two sortable
   numbers** + assignee + recency, and triage *is* sorting by those numbers.
   Ours is identity + one number (findings) + one clock (due). That is the same
   surface with a smaller vocabulary — which is an argument for a table, not
   against one.
3. **Datadog splits "needs you" into a view, not a badge.** The Triggered
   Monitors page shows only triggered monitors and supports bulk mute/resolve
   from there. Our equivalent already exists as the strip filter; what it lacks
   is that the *default* view is not the triage view. Ordering solves this
   more cheaply than a second page.
4. **UiPath makes "never executed" a colour.** Grey is a state, not a shrug.
   Ours is a state (`Not started`) and it is the majority state — Part 9 risk 1
   says the likeliest steady state of this page is *one row, Not started,
   forever*. So the empty-ish row must be **designed**, not defaulted.
5. **Linear separates grouping, ordering and filtering into three controls,
   and makes per-property visibility a user setting.** At our N this is too
   much machinery, but the *distinction* is the useful part: our tiles are a
   **filter**, and they are currently drawn as metrics. That single category
   error is D9's root.
6. **Every one of them has an explicit, persistent row-action affordance.**
   Carbon states the rule the others follow: overflow menus are **persistent on
   each row by default**, because "always visible signals to the user that
   actions can be taken", and hover-only actions are invisible to keyboard and
   touch users — an accessibility failure, not a space saver
   ([Carbon data table](https://carbondesignsystem.com/components/data-table/usage/),
   [WCAG 2.1 content on hover or focus](https://www.w3.org/WAI/WCAG21/Understanding/content-on-hover-or-focus)).
7. **Status must never be colour alone** — WCAG 1.4.1 Level A. Our chip already
   carries dot + word; the rule is recorded so no future "compact mode" drops
   the word.

**What a first-time user understands with no training, in all of them:** a word
they already know for the state; a name they chose themselves for the object; a
number they can compare to the number in the row below; a date; and a control
that says what happens next. Nothing on that list is a graph.

---

### 11.3 · What this section IS — and therefore what shape it takes

Three candidate identities. Only one survives our data.

- **A queue** (UiPath transactions): items arrive by machine, are worked
  automatically, and the human watches throughput. **Fails.** Nothing arrives on
  its own and nothing runs on its own; §6.4 and the fleet-off state make every
  throughput number structurally zero.
- **A monitor** (Datadog / Activity): rows are health. **Fails by boundary** —
  locks §5 decision 5 gives the unscoped cross-fleet feed to Activity, and this
  page must never grow an outcome filter or an export.
- **A worklist**: a small set of jobs *this operator made by hand*, each of
  which is waiting for **them** — to start it, to read what came back, or to
  close it. **This is it.** The nearest true analogue in the research is the
  GitHub agents page: tasks a human delegated to a machine, each with one clear
  status and a way in.

**The consequence is the whole design.** Every row's next action belongs to the
human, so the list is not a monitoring surface — it is **triage of the
operator's own backlog**. Status is therefore an *instruction*, not a
decoration; ordering is the primary "what needs me" mechanism; and the row must
end in something you can press.

And unlike Workflows' four named routines, **this list is built to get long on
purpose**: AS.6 ships bulk creation capped at 25 per action, against 220
campaigns and 10 portfolios. One click makes 25 rows.

---

### 11.4 · The substrate decision: DataGrid, and why — with the sibling's
argument answered

The standing rule is **tables use the shared DS DataGrid + GridToolbar +
FilterBar, in `h10-ds-gridcard`, with all four DS stylesheets**
(`feedback_tables_use_datagrid`). Three of the ten fleet pages already comply:
**Workers** (`WorkersClient.tsx:1381`), **Activity** (`ActivityClient.tsx:1842`)
and the **Fleet map's list view** — which records *"uses the shared DS DataGrid
(operator decision, 2026-08-08)"* (`map/ListView.tsx:26`). Assignments and
`workflows/RunsSection` are the two hold-outs on raw `acr-pg-tbl`.

The Workflows stream declined DataGrid for its routine list (their §9.4) on four
arguments. They were right **there** and each one inverts **here**:

| Their argument (routines) | Here (assignments) |
|---|---|
| *N=4; sorting four rows is furniture* | N is unbounded by design — bulk create makes 25 at a click. They wrote the falsifier themselves: *"the moment the list needs to be sorted, filtered or bulk-acted — in practice around 25 routines — it becomes a table and converges onto DataGrid."* **We are past it on day one.** |
| *Four of six columns are prose; a table compares values down a column and nobody compares two paragraphs* | Once `wantBack` leaves the row (D2), **not one cell is prose**: a state word, a title, a target label, a short delta, a relative time, a date badge. Every one of them is a value that compares down a column. |
| *`table-layout: auto` + `nowrap` is hostile to prose and had to be defeated page-locally* | Same override, opposite reason: we **want** `fixed` + `nowrap` + declared widths — it is the direct fix for D1, and we need no wrapping allow-list because we have no prose. |
| *No bulk action exists on a routine* | Bulk actions exist and ship server-side already: `POST /assignments/bulk-delete`, plus close/cancel per row. Selection is real here. |

Three further reasons, checked in code rather than asserted:

1. **DataGrid's header is sticky** (`components.css:884-896`, `position: sticky;
   top: 0; z-index: 4`). That is D4 fixed by adopting the component rather than
   by re-implementing it — and D4 is the defect that gets worse every time the
   operator bulk-creates.
2. **`aria-sort` is already there** (added by Workers at W.1), so sortable
   headers are announced correctly without this page inventing anything.
3. **Consistency has a reader, not just a rule.** The operator will move between
   Workers, Activity, Map-list and this page in one sitting. Four tables, one
   behaviour.

**The three things DataGrid cannot do, and the exact answer to each:**

- **No `onRowClick` / row href** — its whole prop surface is `columns · rows ·
  rowKey · selectable · selected · onSelectedChange · rowSelectable ·
  rowSelectableHint · selectAllHint · selectRowHint · showTotals · emptyState ·
  initialSort · maxHeight · className` (`DataGrid.tsx:22-45`). **Answer: no
  shared-file change.** The title cell renders a `display:block` anchor that
  fills its cell (turning D3's 5.4% into ~44% of the row), and an always-visible
  actions menu closes the rest. A whole-row `<a>` is not available and is not
  worth extending a 50-page component for.
- **Sort is internal state; there is no `onSortChange`** — so sort cannot be
  URL-persisted, and the page cannot offer "reset to the default order".
  **Answer: phase S1.e, and it is optional.** Two additive optional props
  (`sort`, `onSortChange`) make sorting controlled with a defaulted fallback —
  ~6 lines, no behaviour change for any existing consumer, under a locks §3
  claim. Until then, sort is session-local and the default order is *stated in
  words* in the toolbar rather than implied.
- **A menu inside a grid cell is a known trap, twice over** —
  `.h10-ds-gridcard` is `overflow: hidden` (`patterns.css:465-470`), which clips
  a dropdown, and a sticky cell opens its own stacking context, which no
  `z-index` escapes. **Answer: the actions column is NOT sticky, and the menu
  portals to `document.body`** — the proven pattern in
  `dayparting/ScheduleRowActions.tsx`.

**FilterBar is deliberately not adopted.** It is a collapsible multi-dimension
panel; our whole filter state is *one state + closed-or-not + a search string*,
which is visible in one chip row. A panel that hides a filter behind a
disclosure would make the strip's arithmetic invisible, and the strip's
arithmetic — every tile's number equals the rows it reveals — is the invariant
`views.ts` exists to protect.

**The falsifier, written down.** If this list ever needs more than one filter
dimension at once (state **and** worker **and** target kind), FilterBar is
correct and this decision reopens.

---

### 11.5 · What the row must answer without a click

Six questions. Each with the evidence for why it is on the row rather than one
click away.

| # | Question | On the row as | Evidence |
|---|---|---|---|
| 1 | *What is this job?* | **Title**, one line, ellipsised | Derived at create from worker + target, operator-overridable, guaranteed non-empty because Approvals renders it as provenance (§10.2). It carries the worker's name already — which is why there is **no Worker column** (§11.6). |
| 2 | *What does it point at?* | **Target chip** — kind icon + frozen label; red + *"no longer exists"* when it does not resolve | This page exists because scope binds (AS.1/AS.2). A row that hides its target hides its reason to exist. The raw id stays in the tooltip: ids survive renames, which is a correctness concern, not a reading one. |
| 3 | *Where did it get to?* | **State chip**: dot + word, tone from `states.ts` | WCAG 1.4.1 — colour alone is a Level A failure. The word is not optional. Eight states, one source, already enforced by `assignments.vitest`. |
| 4 | *What came back?* | **Delta**, as words and a number: *"3 findings" · "nothing to do" · "the fleet's day budget" · "never run"* | Airflow #66946: a picture you cannot count, sort or act on is a downgrade. `outcomeLine()` already produces exactly this. |
| 5 | *Is it late?* | **Due badge** + **overdue rows sort first** | Overdue is a flag, never a state (Part 4). `views.ts:overdueRank` already ranks it and nothing on screen says so. |
| 6 | *What do I do next?* | **An actions menu, always visible** | Carbon: persistent overflow menus signal that rows are actionable; hover-only is invisible to keyboard and touch. D3 today is 5.4%. |

**What moves one click away, and why:**

- **`wantBack`** — it is an instruction *to the worker*, not an identity of the
  job, and while it is prefilled it is literally the same string on every row
  (D2). It belongs on the detail page and in the row's title tooltip.
  **Recommendation, separate from this section: stop prefilling it from
  `worker.description`** in AS-S3. A field that is filled for you is not
  information; the three example chips the study already specifies
  (*find wasted spend · propose bids · audit structure*) do the teaching without
  manufacturing noise. Not in this engagement's scope — recorded for the
  operator's call.
- **Cost per row.** `$0.0173` at four decimals is not a triage input. One
  honest number replaces twenty-two: the toolbar count line carries
  *"22 assignments · $0.04 spent"*, with the `hasUnknownCost` caveat in its
  tooltip (an abandoned run's cost is unknown, not zero). This respects Cost &
  value's boundary — one number, no analysis.
- The error text, the findings themselves, the evidence vintages, the trace,
  the pre-flight, the close note: all already on the detail page.

---

### 11.6 · The exact column set, and what drops

`table-layout: fixed`, declared widths, one elastic column.

| # | Column | Content | Width | Sortable by | Drops |
|---|---|---|---|---|---|
| 1 | **State** | chip: dot + word | 132 | "needs you" rank, then alphabetical | never |
| 2 | **Assignment** | title, one line, ellipsised; below 900px it also carries the target chip and due badge | elastic | title A–Z | never |
| 3 | **Points at** | target chip | 300 | label A–Z | < 900 → into column 2 |
| 4 | **Last run** | delta phrase | 240 | state rank then findings desc | never |
| 5 | **When** | `8h ago` / `—`, right-aligned | 104 | recency | < 1400 → into the Last-run tooltip |
| 6 | **Due** | badge | 96 | date, undated last | < 1100 → into column 2 |
| 7 | *(actions)* | ⋮ menu, always visible | 48 | — | never |

Fixed total 920px; at 1728 the title takes the remaining ~694px. Every fixed
column is sized to **≤ 1.35× its widest real content** (from 3.43× today).

**Why no Worker column.** The title already reads *"Negative miner on GALE BROAD
DE"*; a Worker column would print the same string twice. Part 3.2's rule is that
the worker's roster identity — health, grade, dial — belongs to Workers, and
this page must never sort or group by it. Sorting by *title* sorts by worker
name for free, because the worker's name starts the string.

**The drop order honours AS-S1's own rule**: state chip, title and delta never
drop; When and Due go first; the target collapses into the title line last.
Implemented with `window.matchMedia` breakpoints, **not** an element-width
probe — an element-width probe never fires a media query (the Workflows
stream's recorded trap).

**Row height is uniform at every width** because no cell wraps: one line each,
ellipsis with the full value in the tooltip. Today's 34% variance (D10) goes to
zero.

---

### 11.7 · The five states of this list, written out

**1 · Never had data (0 rows, ever).** Render the teaching panel *instead of*
the grid card — a toolbar and a header row above nothing is chrome around
nothing. Copy stays as shipped (it is good and it is prod-verified for
geometry), with two additions: the sentence *"Every worker in this fleet is
switched off"* gets a link to Controls so the claim is checkable, and a second
line offers the other door: *"Some workers cannot be narrowed to one thing at
all — run those from Workers."*

**2 · One row.** Grid card renders. Chips render (the arithmetic must stay
total). **Search does not render below 8 rows** — a search box over one row is
furniture, and the number is stated here so it is a rule rather than a taste.
Sort carets stay (they cost nothing and they teach that the table sorts).

**3 · Many rows (8–200).** `maxHeight` pins the grid to the viewport so the
sticky header stays put and the page chrome never scrolls away; the toolbar
count reads *"Showing 22 of 24 · $0.04 spent"*. **At exactly 200 the cap must
speak**: *"Showing the newest 200 assignments. Older ones are not listed."*
A silent truncation reads as completeness.

**4 · Filtered to nothing.** The grid card stays (so the control that got you
here is still on screen) and DataGrid's `emptyState` names the filter:

> **No assignments are *Stopped*.** — *Clear the filter* to see all 24.

and with a query: **Nothing matches *"gale broad"* in *Stopped*.** — *Clear
search* · *Clear filter*.

**5 · Nothing open, everything closed.** Not an empty list — a *finished* one:

> **Nothing open.** 3 closed, 1 cancelled. — *Show them* · *New assignment*

This is the state today's code renders as "Nothing matches that filter", which
is both wrong (nothing is filtered) and unhelpful.

---

### 11.8 · The complete tooltip inventory

Rule: **every chip, badge, number and column header has a tooltip, and the
tooltip says what it counts or what to do about it — never a restatement of the
label.** Today: seven exist (six tiles + the as-of stamp) and six are missing.

| Element | Tooltip | Status |
|---|---|---|
| State chip (×8) | `ASSIGNMENT_STATES[k].tip` | ships |
| Strip chip (×6) | same `tip`, plus *"Click to show only these"* | ships (add the second clause) |
| Strip chip count | *"N of 24 assignments are in this state"* | **new** |
| Column header *State* | *"Where this job got to. Eight states; hover any chip for what it means."* | **new** |
| Column header *Assignment* | *"The name given when it was made — the worker and what it points at. You can rename it."* | **new** |
| Column header *Points at* | *"The one thing this worker is allowed to look at. Everything else in your account is out of scope for this job."* | **new** |
| Column header *Last run* | *"What came back the last time it ran. An assignment can be run many times; each attempt keeps its own result."* | **new** |
| Column header *When* | *"When the last attempt started."* | **new** |
| Column header *Due* | *"A deadline you set. It colours the row and moves it up the list. It never starts anything and never stops anything."* | **new** |
| Target chip (campaign) | *"{label} — campaign {id}. The name was frozen when you made this, so a rename cannot quietly relabel your history."* | ships |
| Target chip (portfolio) | *"{label} — portfolio {id}, resolved to its member campaigns each time it runs. A campaign added to the portfolio tomorrow is in scope tomorrow."* | **new** (fixes D7) |
| Target chip (marketplace) | *"Marketplace {label} — everything in your account for that marketplace."* | ships |
| Target chip (gone) | *"The {kind} this points at no longer exists. Starting this will stop immediately rather than widen to your whole account."* | **new** (fixes D8) |
| Target chip (whole account) | *"This worker reads the whole account every time — it has no way to be narrowed."* | ships |
| Delta *"N findings"* | *"N things this worker judged worth your attention. Open it to read them; nothing has been changed on Amazon."* | **new** |
| Delta *"nothing to do"* | *"It ran, read the evidence and judged that nothing needed doing. That is a result, not a failure."* | **new** |
| Delta *"never run"* | *"Nothing has run. Nothing will start it but you."* | **new** |
| Delta (stopped/failed) | `reasonSentence(haltedReason)` / `errorSentence(errorMessage)` — the full sentence with the fix | exists in `states.ts`, **not used on the list** |
| Due badge | as shipped | ships |
| Toolbar count *$ spent* | *"What every assignment shown here has cost in model calls. N runs stopped reporting and their cost is unknown — left out rather than counted as zero."* | **new** |
| "as of" stamp | as shipped | ships |
| ⋮ menu items | each disabled item says why (*"This has already run — close it instead"*) | **new** |

Every one of these sentences already exists somewhere in `states.ts` or the API
refusals. **None of it is new prose invented for the row** — that is the point:
the tooltip layer is a second consumer of the one vocabulary, not a second
vocabulary.

---

### 11.9 · What this section must never become

- **Activity's run log.** The moment a row wants an outcome filter, a date
  range, an export or a permalink to a trace, the reader wanted Activity —
  locks §5 decision 5. One assignment's runs live on its own page; the
  cross-fleet feed is not ours.
- **The Workers roster.** No health, no grade, no dial, no autonomy, no
  per-worker sort or group. If a worker column ever appears with a second
  sortable attribute, this has become the roster.
- **A dashboard.** No sparkline, no trend, no cost breakdown, no per-worker
  split. The one number in the toolbar is a total, not an analysis.
- **A place that spends money.** No Start on a row and no bulk Start, ever —
  §11.11 phase d states the reasoning. Making spending easy on a fleet the
  operator deliberately switched off is the one thing this page must not do.
- **A dense mode that drops the word from the chip.** WCAG 1.4.1.

---

### 11.10 · Where this contradicts the existing study

Stated plainly, because the study is the contract:

1. **AS-S1 puts *"what you want back (truncated)"* on the row. That is wrong**,
   and D2 is the proof — prefilled, it is the same sentence on every row. It
   leaves the row. If prefilling is also dropped in AS-S3, an operator-written
   note becomes worth showing again — on the detail page, not here.
2. **AS-S1 promises the red "no longer exists" chip. It never shipped and it
   cannot ship client-side** (D8) — the list read resolves nothing. Either the
   API resolves target existence on read (one indexed `IN` query per kind,
   phase S1.f) or the promise is retracted. **Recommendation: build it.** A page
   whose subject is *what this points at* should not need to spend money to
   discover the thing is gone.
3. **AS-S1 promises search + URL filter state. Neither shipped** (D9). Now in
   scope.
4. **AS-S1 lists row actions as Open / Start again / Close. I ship Open, Close,
   Reopen, Cancel and Delete — and deliberately NOT Start.** Start is the only
   irreversible, money-spending action on this page, and it belongs where its
   pre-flight is: the detail page, where AS.3 already states what it will read
   and what it costs before you press it.
5. **AS-S2 says five tiles; six ship** (Abandoned too). The code is right and
   the study is wrong: Abandoned is an open state, so a filter that could not
   reach it would break the "tiles + remainder account for everything"
   invariant.
6. **AS-S2 reserves a sixth Overdue tile "only if a due date has ever been
   set". Recommend dropping it permanently.** Overdue is already carried twice —
   the badge and the default ordering — and a seventh chip that appears and
   disappears makes the strip's arithmetic harder to trust, for a fact the first
   row already shows.
7. **AS-S2 says "tile label identical to the chip label, character for
   character".** The tile is uppercased by CSS (`text-transform`) while the chip
   is sentence case. That is presentational, not a vocabulary drift — but the
   chip-row rebuild drops the uppercase anyway, which makes the rule literally
   true instead of nearly true.

---

### 11.11 · Build order — six independently shippable phases

Each phase is a commit that leaves the page better than it found it, verified on
prod before the next starts.

**S1.a — Substrate and geometry.** DataGrid + GridToolbar inside
`h10-ds-gridcard`; `table-layout: fixed` with the declared widths;
sticky header; `maxHeight`; the seven columns; `wantBack` off the row; the
title anchor fills its cell; the chip icon gets `flex: none`; the portfolio
tooltip (D7); the four contrast failures fixed **page-locally under an
`.as-page` root** — `fleet-pages.css` is not touched and no claim is taken.
*Closes D1, D2, D3, D4, D5, D6, D7, D10.*

**S1.b — The strip becomes a filter.** Six `.acr-pg-chip`s with counts,
replacing six 261×67 metric tiles; the remainder sentence moves into the
GridToolbar count line; filter + show-closed mirrored to the URL via
`replaceState`, matching Workers and Activity. *Closes half of D9; frees ~40px
of vertical space.*

**S1.c — Search and honest counts.** `@/lib/option-search` over title + target
label + worker name (plain substring returns zero for `GALE | IT | Broad`);
appears at N ≥ 8; URL-persisted; the 200 cap stated in words; the three real
empty states of §11.7 with copy that names what is filtered.

**S1.d — Row actions.** An always-visible ⋮ per row, portalled to
`document.body`: **Open · Close · Reopen · Cancel · Delete**, each offered only
where the API accepts it and each disabled item saying why in its tooltip
(`deleteAssignment` refuses a row that has run; `setAssignmentState('cancelled')`
refuses the same). Selection + a bulk **Delete** through the existing
`POST /assignments/bulk-delete`, in the GridToolbar's selection swap, exactly as
the Workers roster does it. **No Start, no bulk Start.**

**S1.e — Controlled sort (optional; needs a shared-file claim).** Additive
optional `sort` / `onSortChange` on `DataGrid`, defaulted so all ~50 existing
consumers are byte-identical; sort mirrored to the URL; a *"Sorted by … · use
the default order"* affordance. **If the operator would rather not touch a
50-page component, S1.a–S1.d still stand** — sort simply stays session-local and
the default order is stated in words.

**S1.f — Target resolution on the list read (one API change, mine).**
`listAssignments` resolves each distinct target id against `Campaign` /
portfolio membership in one query per kind and returns `targetResolves:
boolean`. Delivers D8's red chip and makes the page able to say *"this points at
something that is gone"* without spending a cent.

---

### 11.12 · Acceptance — measured on prod, not eyeballed

Every phase re-runs this probe at 1728 and 896, with 0, 1 and 24 rows:

1. **No fixed-width column exceeds 1.35× its widest content** (today: 3.43×).
2. **Every text role ≥ 4.5:1** against its resolved backdrop (today: four below,
   worst 2.41).
3. **Row-height variance = 0** at every width (today: 34% at 896).
4. **The column header is on screen at row 22** — `rect.y ≥ 0` after scrolling
   to the last row (today: −515).
5. **The row's navigation target ≥ 40% of the row's area** (today: 5.4%).
6. **Every number on screen has a tooltip**, asserted by a vitest walking the
   rendered row, not by eye.
7. **Tiles still equal what clicking them reveals** — the existing `views.ts`
   invariant test must stay green, unmodified, through all six phases.
8. **The page fills its viewport at 0 rows** — `.as-empty` bottom within 40px of
   the fold, as measured today.

---

### 11.13 · Cross-session

- **No shared file is touched by S1.a–S1.d.** `fleet-pages.css` stays frozen;
  the two failing shared roles are overridden page-locally under `.as-page`,
  the same way Workflows and Activity handled the identical numbers.
- **`DataGrid.tsx` is claimed only at S1.e**, additive and defaulted, and only
  if the operator wants URL-persisted sort.
- **One finding for whoever owns `fleet-pages.css`:** the two shared failures
  (`.acr-pg-stat .k` 2.95:1, `.acr-pg-tbl th` 2.73:1) are now measured
  independently on two pages. Three fleet pages are working around them
  page-locally. That is the point at which the central fix costs less than the
  workarounds.
- **For Activity (`SB.ACT`):** your `FleetPageShell` `aside` claim is welcome
  here — when it lands, this page's "as of / Refresh" pair moves into the header
  slot and the toolbar keeps only count, search and chips. Nothing is asked of
  you; this page does not block on it and will not add a second prop for the
  same idea.
- **For Workflows (`SB.8`):** your §9.4 falsifier is what decides this page the
  other way, and the reasoning is quoted rather than paraphrased in §11.4. Two
  pages, two substrates, one test — that is the rule working, not a split.

---

### 11.14 · EXECUTED 2026-08-08 — S1.a–S1.f, all six, prod-verified

Approved by the operator and built in the order the study proposed. Commits:
`5ee2d3ee2` (S1.a) · `0f91520a0` (S1.b) · `c1d0e713f` (S1.c) · `550e86143`
(S1.d) · `d716f4ef8` (S1.e + S1.f) · `d05f5cd08` (two acceptance fixes).

**Measured on the deployed build, 1728×906, 24 rows, all eight states.** The
synthetic rows were injected **client-side only** — `window.fetch` patched in
the page — so nothing was written; the last pass then used four **real**
assignments created and deleted through the API, and **nothing was ever
started**.

| Acceptance criterion | Before | After |
|---|---|---|
| Recoverable slack in the fixed columns | **627px — 38.9%** of the table | **78px — 4.8%** (the rest is cell padding) |
| Worst column ratio | Points at at **3.43×** its widest content | Points at at **1.14×** |
| Row-height variance | 34% at 896px (56 / 73 / 75) | **0** at both widths (49px wide, 68px narrow) |
| Column header at row 22 | scrolled to **y = −515** | **pinned**, and the page itself does not scroll |
| Row navigation target | **5.4%** of the row | **~41%** (33.4% until the content-box fix) |
| Text roles below 4.5:1 | **4** (worst 2.41:1, the "never run" delta) | **0** |
| Filter state in the URL | none | state · closed · search · sort · direction |
| Row actions | none | Open · Close · Cancel · Reopen · Delete + bulk delete |

**Verified live, not inferred:** the sticky header holding at row 22 with the
page still; the row menu portalling clear of `.h10-ds-gridcard` at z-index 1200
with **Delete correctly disabled** and carrying the API's own refusal sentence;
the four-column drop order at 896px with the target chip and the deadline riding
the title line; `?sort=title&dir=asc` restoring the order on load with the
header's caret and *"sorted by name — use the default order"*; and **the gone
chip on a real row** — `⚠ ARCHIVED TEST CAMPAIGN · gone` — with the overdue row
sorted to the top above it.

**Five things this engagement learned that the study did not know:**

1. **`createAssignment` accepts a target id that resolves to nothing.** The
   `ARCHIVED TEST CAMPAIGN` row was created against `999999999999999` and the
   API took it. That is not a bug to fix at create — a campaign can vanish at
   any time afterwards, so the row must be *able* to say it either way — but it
   does mean the gone state was always reachable and was simply never shown.
2. **`min-height` under `border-box` includes the padding**, so the first
   attempt at the full-height click target shipped and changed nothing. Caught
   only because the acceptance probe re-ran against the deployed build; the diff
   looked right.
3. **A colour that passes on the card can fail on the page.** `#2f6feb` is
   4.56:1 on a white card and 4.22:1 on `#f4f6f9` — and every text link this
   page owns sits on the page background.
4. **The DS chip dims its own count to `opacity: 0.75`** (~3.4:1). On a filter
   band, those counts are the numbers being read.
5. **The list page cannot be probed through its SSR HTML** — the client subtree
   is not in it, so "grep the deployed HTML for a marker" reports *not deployed*
   forever. It cost about twenty minutes of waiting for a deploy that had
   already landed. Verify in the browser or not at all.

**Deliberately not built, and why:** no Start on a row (§11.11 phase d), no bulk
Start, no Overdue chip (the ordering and the badge already carry it twice), and
no partial-target marker — a row whose campaigns are *half* archived still runs,
so reddening it would be a new lie replacing an old silence.

**One acceptance criterion could not be met as written, and is recorded rather
than quietly dropped.** §11.12 item 6 said the tooltip inventory would be
"asserted by a vitest walking the rendered row". **There is no DOM-test
infrastructure in this repo** — no `jsdom`, no `happy-dom`, no
`@testing-library`, and no vitest environment configured for either app — so
that test cannot exist without adding a whole stack, which is a shared change
far outside this section. Verified by a probe of the deployed page instead,
walking every rendered element and checking it or an ancestor for a `title`:

| Element | Covered |
|---|---|
| state chip · target chip · delta · when · row menu | 20 / 20 each |
| filter chip · its count | 7 / 7 each |
| toolbar count · order line · as-of | 1 / 1 each |
| column headers | 6 / 6 visible (the 7th is the visually-hidden *Actions* label) |
| **due badge** | **4 / 20 — the gap the probe found** |

Sixteen of twenty due badges were the `—` placeholder carrying nothing. It is
the most common value in that column and it is not decoration: it says nobody
set a deadline. Closed in `58094527b` — and it is the argument for the probe, since
a test written against the same assumption that produced the omission would have
passed.

---

## PART 12 — NAF.SB.AS-S2R · Section 2 restudied: the create drawer

**Status: AWAITING OPERATOR APPROVAL. No code written.**

Scope: `CreateAssignment.tsx` — the drawer, its four steps, both pickers, the
pre-flight panel and the bulk receipt. Not the list (Part 11, done), not the
detail page. **The model is unchanged**: same workers, same target kinds, same
refusals, same endpoints, same words for what a run will read.

### 12.1 · PHASE 0 — the audit, measured on the deployed page

Method: the live Vercel build at 1728×906 and in a same-origin 896px frame,
driving the real drawer against the real account — **219 campaigns, 86 of them
ENABLED**. Two assignments were created through the UI to reach the receipt
screen and removed with its own Undo; prod ended at zero rows and **nothing was
started**.

Eleven findings. Two of the operator's ten are wrong, and both are recorded as
wrong rather than quietly built.

#### D1 · The wheel trap, quantified — and there are two of them

The campaign list is a **210px window onto 1940px of content: it shows 10.8% of
itself.** It sits at y=561–771, which is **26.9% of the visible drawer body**,
and while the pointer is anywhere in that band the wheel drives the list, not
the drawer — which still has **330px hidden below it**, holding the pre-flight,
the brief and the deadline.

**The operator found one; there are two.** `PortfolioPicker` has its own
`maxHeight: 230, overflowY: auto` (`CreateAssignment.tsx:853`). Same defect,
same fix, and it would have survived a repair aimed only at the campaign list.

Worth naming because the obvious fix is the wrong one: `overscroll-behavior:
contain` prevents an inner scroller from *chaining* to its parent. That is not
this bug. This is **capture** — the inner region consumes a gesture aimed at the
outer one — and no CSS property fixes it. Only removing the inner scroller does.

#### D2 · 59% of the drawer is empty at the moment it opens

Drawer body 782px tall; content on open **321px**. **461px — 59% — is blank**,
and the operator's first impression of the page's primary action is mostly
nothing. It is worse at the end: the receipt screen renders ~100px of content in
the same 782px body, **87% empty**.

#### D3 · A keyboard cannot reach this drawer: 41 Tab presses

Measured: **63 focusable elements on the page, and the first one inside the
drawer is number 41.** Because `Drawer.tsx` portals to the end of `<body>`,
moves focus nowhere on open (`document.activeElement` is `BODY`), traps nothing,
and leaves the page behind fully tabbable. The panel also carries
`role="dialog" aria-modal="true"` with **`aria-labelledby` and `aria-label` both
null — the dialog has no accessible name.**

This is the most serious finding in the audit and **it is not in this page's
code** — it is in the shared `Drawer.tsx`, which **22 files render**.

#### D4 · The picker hides 53% of what it offers, silently

`options.slice(0, 40)` (`:745`). The account has **219 campaigns, 86 ENABLED,
and the picker renders 40** — so **46 running campaigns (53%) cannot be reached
at all** unless the operator guesses a substring that matches one. Nothing on
screen says a cap exists. This is the same defect class as the list's silent
200-row cap that S1.c made speak, in a worse place: a list can be scrolled, a
missing option cannot be discovered.

#### D5 · Nine text roles below 4.5:1 — including the text you choose by

| Role | Size | Colour | Ratio |
|---|---|---|---|
| worker description ×3 (`.as-workerbtn .ds`) | 11.5px | `#8d97a6` | **2.82–2.95** |
| every `.as-hint` (5 of them) | 11.5px | `#8d97a6` | **2.82–2.95** |
| drawer subtitle | 12px | `#8a93a1` | **3.10** |
| DateField placeholder | 13px | `#8a93a1` | **3.10** |

The worst offenders are the three sentences that describe what each worker does
— **the only text on the screen that tells you which one to pick.**

#### D6 · Four levels of nesting to reach what the worker will read

Measured depth from the drawer body to the `<details>`: **3** (step → pre-flight
panel → details), four counting the drawer. NN/g's rule is explicit: *"designs
that go beyond 2 disclosure levels typically have low usability because users
often get lost."*

#### D7 · Two words for one action, 700px apart

On the receipt screen the footer says **Close** and the panel says **Done**, and
**both call `onCreated`** — byte-identical behaviour, two labels, and a
first-timer has to guess whether they differ. Meanwhile the header still reads
*"New assignment · One worker, one thing to look at"* on a screen that is a
receipt for work already done.

#### D8 · The one hint about what is missing is attached to the one element that cannot show it

The disabled Create button carries `title="Pick a worker, and a target if you
chose one."` **A disabled button suppresses pointer events in every major
browser, so that tooltip can never appear.** There is no other inline
validation: the form's only feedback is the button being grey.

#### D9 · Thirteen inline-styled elements and six type sizes

`style={{…}}` on 13 nodes (`maxHeight`, `marginTop`, `paddingLeft`,
`lineHeight`, `cursor`, `width`). None trips the DS ratchet, which greps
`fontSize` and hex — they are exactly the pattern the design-system rule exists
to prevent, one gate short of being caught. Six distinct font sizes in one
drawer: 11.5 / 12 / 12.5 / 13 / 15 / 16.

#### D10 · **Suspicion 7 is wrong: 560px is wide enough.** Do not widen it

The longest ENABLED campaign label in the account is 68 characters —
`IT_DEF_Gale_"Targets=All-Asins"_"Ads=All-ASINs-Except-Black-XL" · IT` — and it
measures **498px inside a 498px option**: `scrollWidth === clientWidth`, **0 of
40 options truncated**, and 0 truncated when searched for directly. Widening the
drawer would solve nothing and cost the list behind it. Recorded so it is not
re-proposed.

#### D11 · **Suspicion 2 is half wrong: the numbers do not lie, the length does**

Steps are numbered 1–4 and always in that order; nothing renumbers. What
actually happens is that the form **grows from 321px to 1112px** the moment a
worker is picked, because steps 2–4 do not exist before it. The defect is not a
false number — it is that at no point can you see how much task is left.

---

### 12.2 · PHASE 1 — how the world lets someone create a scoped piece of work

| Product | Minimum to create | Shape | Notable |
|---|---|---|---|
| **Linear** | **A title.** `C` opens the modal anywhere; everything else is optional and set with keyboard shortcuts inside it | one modal, no steps | Esc offers **save as draft** rather than discarding. The minimum-viable-object model: create now, refine later |
| **GitHub · assign to Copilot** | **Assign the issue.** Optional prompt field for extra context | no form at all — a field on an object that already exists | The work item is created *by delegating an existing object*, not by filling a form |
| **Google Ads** | goal → type → settings → ad groups → ads → **review** | true wizard, 6 steps, and **step 6 is a review page that lists what you configured and flags what is missing** | The only researched flow with a genuine commit-time summary |
| **Jira** | project + type + summary, then a screen whose fields are admin-configurable | one long screen | Documented as a source of *"cognitive overload"*; the Navigator's field picker only exposes ~10 fields, so the rest are unreachable |
| **Amazon Ads** | campaign settings, then bulk operations for scale | form + spreadsheet | At real scale it gives up on the picker entirely and hands you a bulksheet |
| **Zapier / n8n / Make** | pick a trigger app, then configure | staged, one step per node | Each step's configuration is revealed only when its node is selected |

**Five findings, ranked by what they change here:**

1. **Red Hat's UX research compared exactly our question and the wizard lost.**
   Progressive form (all steps on one surface) vs wizard: the progressive form
   was **faster in both tasks**, rated **easier**, and preferred **6 of 7** for
   sequential flows, **6 of 7** for familiar tasks, and still **5 of 7** for
   tasks with 10+ steps. Ours has two decisions.
2. **NN/g draws the line at two disclosure levels** — *"designs that go beyond 2
   disclosure levels typically have low usability"* — and says staged disclosure
   (a wizard) *"is problematic when the steps are interdependent and users must
   alternate between them."* **Our steps are interdependent by construction**:
   the worker determines which target kinds exist, the target determines the
   pre-flight, and changing the worker can invalidate a target already chosen.
   A wizard would force the operator backwards through it.
3. **Google Ads is the one product that shows consequences before commit**, and
   it spends a whole step on it. We cannot afford a step — but we can put the
   consequence *next to the button*, which is the same idea at one-tenth the
   cost.
4. **At 200+ options every source says search-first.** A combobox that filters
   beats a scrolling list, and the guidance is explicit that for long lists you
   must **expose the fact that more exist**, or they are never seen.
5. **Validation on blur, never as you type.** Baymard/NN/g-aligned consensus:
   on-blur beats both alternatives; as-you-type produces "premature error
   blindness" and measurably worse completion. And the thing this drawer needs
   is not stricter validation — it is a *visible statement of what is missing*.

---

### 12.3 · What this section IS

**A two-decision form wearing four labels.** Everything that is actually
required is *which worker* and *what it looks at*. The brief and the deadline
are optional and always have been; the pre-flight is a statement, not an input;
the bulk chooser only appears when the operator has already done something
ambiguous.

So the design target is not "a better wizard". It is: **make the two decisions
obvious, make their consequence visible at the moment of commit, and stop the
optional half from looking like homework.**

---

### 12.4 · The flow decision — one progressive form, and the DS Stepper is declined

**Decision: keep a single scrolling form with numbered sections. No stepper, no
pagination, no multi-screen wizard.** Four reasons, in order of weight:

1. **The research measured this exact comparison and the progressive form won**
   (§12.2 finding 1) — on speed, on perceived difficulty, and 6-of-7 on
   preference.
2. **Our steps are interdependent**, which is the specific case NN/g names as
   the one where staged disclosure fails.
3. **A wizard would make the shortest path longer.** The common case is one
   worker, one campaign, no brief, no deadline — two decisions. Paginating two
   decisions into four screens adds three commits to a task that has one.
4. **`Stepper` is display-only.** Its whole surface is `steps · current ·
   className`; it renders badges and connector lines and owns no navigation
   (`design-system/components/Stepper.tsx`). Adopting it would draw a progress
   bar over a form that is not paginated — a picture of steps we are not making
   the operator take. It is used by the two genuine wizards in this app
   (`list-wizard`, `EbayImportWizard`) and it is right there and wrong here.

**What replaces the sense of progress the operator is missing (D11):** all four
section headings render **from the moment the drawer opens** — 3 and 4 as quiet,
collapsed one-line rows marked *optional* until they become active. The shape of
the task is legible at t=0, the form stops growing under the reader, and D2's
461px of blank is spent on something true.

---

### 12.5 · The scroll-ownership rule

> **The drawer body is the only scroll container inside the drawer. No
> descendant of it may scroll, ever.**

That is the whole fix for D1, and it is a rule rather than a patch because the
defect appeared twice independently (campaigns and portfolios) and would
reappear the third time somebody needs a long list in here.

Consequences, each of which is a real design change and not a CSS tweak:

- **The campaign picker becomes search-first and renders inline**, at most 8
  results, with no `maxHeight` and no `overflow`. Eight rows is 320px of drawer
  — long enough to choose from, short enough that the pre-flight stays reachable
  by the same gesture that moves everything else.
- **The portfolio picker renders all 10 in full.** It never needed a scroller;
  it has one because the campaign picker did.
- **The pre-flight never scrolls**, and neither does the receipt.

**Verification is mechanical**, which is the point: *count the elements inside
`.h10-ds-drawer` whose computed `overflow-y` is `auto|scroll` and whose
`scrollHeight > clientHeight`. The answer must be exactly one — the body.*

---

### 12.6 · The picker at 86 running campaigns

The list is search-first, and **it states its own arithmetic** — the failure in
D4 was silence, not the cap:

- Empty query → the first 8 alphabetically, above the line
  **"86 campaigns are running. Type to narrow — showing 8."**
- With a query → up to 8 matches, **"12 match "gale" — showing 8."**
- Zero matches → **"Nothing matches "xyz". 86 campaigns are running; 133 more
  are paused."** with a one-click *include paused* toggle, since that is the
  actual reason a real campaign appears to be missing.
- Ranking stays `@/lib/option-search` — plain substring returns nothing for
  `GALE | IT | Broad` (`reference_ads_picker_search`).
- **Selected items are never hidden by a filter.** Chips above the search keep
  their position regardless of the query, which is already true and is worth
  keeping when the list stops scrolling.

**Explicitly not built:** virtualization. At 86 rows with 8 rendered it would be
machinery for nothing, and the falsifier is written down — if this account ever
exceeds ~2,000 campaigns, the picker becomes a virtualized combobox and this
paragraph is the reason it was not one sooner.

---

### 12.7 · The disclosure budget, and where the consequence goes

**Two levels, never three** (NN/g). Level 1 is the form. Level 2 is the single
disclosure *"What will it read?"*. The pre-flight panel stops being a level: its
headline sentence — *"It will look at GALE BROAD DE only — nothing else in your
account"* — becomes a plain line in the form, and the disclosure becomes its
sibling rather than its child. Measured target: **max depth 4 → 2**.

**And the consequence moves next to the button.** A commit bar above the footer
actions, always visible once a worker is chosen:

> **Creates 1 assignment** · Negative miner on GALE BROAD DE · **nothing runs
> until you start it**

That is Google Ads' review step compressed to one line and zero clicks. When the
form is not yet valid the same bar carries the reason **as text, not as a
tooltip on a disabled button** (D8):

> **Pick a campaign to continue** — Negative miner is chosen.

The button stays disabled — it cannot succeed — but the reason is now readable
by everyone, including the keyboard and screen-reader users who could never
reach a `title` on a disabled control.

---

### 12.8 · Every state, written out

| State | What the drawer says |
|---|---|
| **Open, nothing chosen** | Four headings; 1 active; 2–4 collapsed and marked optional where they are. Commit bar: *"Pick a worker to begin."* |
| **Worker chosen, no target** | Kind chips; the sentence naming what this worker *can* be pointed at, and what it cannot and why (already shipped, kept verbatim). Commit bar: *"Pick a campaign to continue."* |
| **Worker + whole account** | Valid. Commit bar: *"Creates 1 assignment · Negative miner on your whole account."* |
| **Target picked** | Pre-flight line + the one disclosure. Commit bar names the target. |
| **Several targets picked** | The AS.6 chooser, unchanged in meaning. Commit bar switches to *"Creates 3 assignments"* / *"Creates 1 covering 3"* to match the chosen reading. |
| **Over the cap of 25** | The existing sentence, kept: refused, never truncated. Commit bar: *"26 is more than 25 — remove some, or make one covering all of them."* |
| **A worker/kind pair the evidence layer refuses** | The API's own refusal sentence, rendered where the pre-flight line is. Never a greyed control with no reason. |
| **Submitting** | The button says *Creating…*; nothing else moves. |
| **Created — one** | Drawer closes; the list behind it already refreshes. No receipt for a single row: the row IS the receipt. |
| **Created — several** | The receipt screen, with **its own title** (*"3 assignments created"*), **one** primary action, and Undo. |
| **Partly refused** | Receipt lists created and refused separately with each refusal's own sentence — shipped behaviour, kept, because closing on a partial success would hide the refusals. |
| **Network/API error** | The error sentence stays in the form; nothing is cleared; the operator's choices survive. |

---

### 12.9 · Tooltip and microcopy inventory

Rule, inherited from Part 11: **every control has a tooltip or a visible
sentence, and it says what the thing does or why it cannot be used — never a
restatement of its label.**

| Element | Copy | Status |
|---|---|---|
| Worker card | its description, at **≥4.5:1** | shipped, contrast fails today |
| *"N other workers cannot be assigned…"* | shipped sentence + link to Workers | keep |
| Kind chip · One campaign / marketplace / portfolio | *"Narrow this worker to one {kind}. Everything else in your account is out of scope for this job."* | **new** |
| Kind chip · The whole account | *"No narrowing. It reads everything it normally reads."* | **new** |
| A kind this worker cannot honour | absent, with the printed reason | shipped |
| Search box | *"Every word you type must appear, in any order — so "gale broad" finds "GALE \| IT \| Broad \| Brand"."* | **new** |
| *Only campaigns that are running* | *"Most of this account is paused. Untick to include the other 133."* | **new** (count is live) |
| Result count line | *"86 running · showing 8. Type to narrow."* | **new** |
| Selected chip ✕ | *"Remove this one"* | shipped as `title="Remove"`, keep |
| Pre-flight line | the headline sentence | shipped, keep verbatim |
| *What will it read?* | disclosure; contents unchanged | shipped, re-parented |
| *Show me how much there is* | *"Reads the last 60 days of your search terms and may take a few seconds. It calls no AI and writes nothing."* | shipped, keep |
| Spend ceiling sentence | shipped | keep |
| Brief box + 3 example chips | shipped (S1 follow-up) | keep |
| Deadline field | *"A deadline colours the row and moves it up the list. It never starts anything and never stops anything."* | shipped, keep |
| Commit bar | §12.7 | **new** |
| Create button | *"Creates it. It will not run until you start it."* | shipped, keep |
| Receipt · single action | *"Back to your assignments"* | **new**, replaces Close/Done |
| Receipt · Undo | *"Deletes the ones just created. Possible only because none of them has run."* | shipped, keep |

---

### 12.10 · What this section must never become

- **A charter editor.** No system prompt, no model, no observation-key picker,
  no budget, no autonomy dial (Part 5, unchanged and non-negotiable).
- **A campaign manager.** The picker selects; it never edits, pauses or reports.
  If it grows a metric column it has become the ads console.
- **A second Workers page.** The worker list here is a picker with a name and a
  one-line description. A second sortable attribute makes it the roster.
- **A place that starts anything.** Create is not Start, here or anywhere on
  this page. The fleet is off and this drawer must never be the thing that
  changes that.
- **A wizard.** §12.4 decided it once, with evidence; reopening it needs new
  evidence, not new taste.

---

### 12.11 · Build order — five independently shippable phases

**S2.a — Scroll ownership.** Both inner scrollers removed; campaign picker
search-first with 8 inline results and the honest count line; portfolio picker
rendered in full. *Closes D1, D4.*

**S2.b — The shape of the task.** All four headings from open, 3–4 collapsed and
marked optional; the form stops growing under the reader. *Closes D2, D11.*

**S2.c — The commit bar.** Consequence next to the action; the missing-input
reason as visible text; one word for one action; the receipt gets its own title
and single primary action. *Closes D7, D8.*

**S2.d — Legibility.** Nine sub-AA roles fixed page-locally under `.as-page`;
type scale to ≤4 sizes; 13 inline styles to classes; the pre-flight flattened to
two disclosure levels. *Closes D5, D6, D9.*

**S2.e — Keyboard and screen reader. NEEDS AN OPERATOR DECISION (§12.13).**
Initial focus, focus trap, accessible name. *Closes D3.*

---

### 12.12 · Acceptance criteria — measured on the deployed page

Every number's "before" was measured in §12.1, not estimated.

| # | Criterion | Before | Target |
|---|---|---|---|
| 1 | Scroll containers inside the drawer | **2** | **0** (the body is the only one) |
| 2 | Drawer body blank on open | **461px, 59%** | **≤ 15%** |
| 3 | Campaign options reachable without guessing a substring | **40 of 86 (47%)** | **100%**, and any cap stated in words |
| 4 | Text roles below 4.5:1 | **9** | **0** |
| 5 | Max content-nesting depth to any information | **4** | **≤ 2** |
| 6 | Distinct font sizes in the drawer | **6** | **≤ 4** |
| 7 | Inline `style` attributes in the drawer | **13** | **0** |
| 8 | Words for the same action on the receipt | **2** (Close / Done) | **1** |
| 9 | Reason the primary action is unavailable, visible without hover | **no** | **yes** |
| 10 | Tab presses to reach the first control in the drawer | **41** | **1** (focus enters on open) — S2.e only |
| 11 | Dialog has an accessible name | **no** | **yes** — S2.e only |
| 12 | Drawer width | 560px, **0 of 40 labels truncated** | **unchanged, still 0** (regression guard — do not widen) |
| 13 | Horizontal scroll at 896px | none | **none** |

---

### 12.13 · Cross-session, and the one decision I need

**S2.a–S2.d touch only `app/fleet/assignments/**`.** No shared file, no claim,
no backend change, no migration.

**S2.e is the exception and it is your call.** The keyboard defect (D3) lives in
`design-system/components/Drawer.tsx`, which **22 files render**. Two ways:

- **(a) Fix it in `Drawer.tsx` — recommended.** Move focus to the panel on open,
  trap Tab inside it, restore focus to the opener on close, and give the dialog
  an accessible name from its own `title`. Additive and defaulted; every drawer
  in the app becomes keyboard-operable. **But it is a behaviour change on 22
  surfaces**, and that is exactly the kind of thing the locks protocol says to
  ask about rather than assume.
- **(b) Fix it page-locally.** Only this drawer improves; the other 21 stay
  unreachable; and I would be writing a focus trap inside a feature component,
  which is where they rot.

I recommend (a), taken as its own commit with the claim recorded in locks §3, so
it can be reverted independently of everything else in this engagement.

**Noted, not claimed:** `Drawer.tsx` already carries the `overlay` prop for
exactly the confirm case this drawer would need — Section 1 checked before
extending a shared component and so has this. Nothing here needs a new prop.

---

## Sources

**RPA queues** — [UiPath queues](https://docs.uipath.com/orchestrator/automation-cloud/latest/user-guide/about-queues-and-transactions) · [item statuses](https://docs.uipath.com/orchestrator/automation-cloud/latest/user-guide/transaction-statuses) · [queue triggers](https://docs.uipath.com/orchestrator/automation-cloud/latest/user-guide/queue-triggers) · [Action Center](https://docs.uipath.com/action-center/automation-cloud/latest/user-guide/managing-actions) · [Blue Prism work queues](https://docs.blueprism.com/en-US/bundle/blue-prism-enterprise-7-3/page/user-guide/control-room/ug-cr-queue-management.htm) · [Automation Anywhere WLM](https://docs.automationanywhere.com/bundle/enterprise-v2019/page/enterprise-cloud/topics/aae-client/bot-creator/using-workload/cloud-queues.html) · [Power Automate work queues](https://learn.microsoft.com/en-us/power-automate/desktop-flows/work-queues)

**Agent tasks** — [GitHub Copilot coding agent](https://docs.github.com/en/copilot/using-github-copilot/coding-agent/about-assigning-tasks-to-copilot) · [Devin sessions](https://docs.devin.ai/get-started/devin-intro) · [Relevance AI approvals](https://relevanceai.com/docs/build/workforces/workforce-features/approvals-and-escalations) · [CrewAI tasks](https://docs.crewai.com/en/concepts/tasks) · [Copilot Studio multi-agent](https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/multi-agent-patterns)

**Work management** — [Linear issues](https://linear.app/docs/creating-issues) · [Linear workflows & statuses](https://linear.app/docs/configuring-workflows) · [Jira bulk change](https://support.atlassian.com/jira-cloud-administration/docs/edit-multiple-issues-at-the-same-time/) · [ServiceNow assignment rules](https://www.servicenow.com/docs/bundle/zurich-platform-administration/page/administer/task-table/task/t_CreateAnAssignmentRule.html)

**Orchestration** — [Temporal workflow id reuse](https://docs.temporal.io/workflow-execution/workflowid-runid) · [Airflow task instances](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/tasks.html) · [Dagster backfills](https://docs.dagster.io/guides/build/partitions-and-backfills/backfilling-data) · [Prefect work pools](https://docs.prefect.io/v3/concepts/work-pools) · [SQS DLQ](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)

**Ads entity scoping** — [Amazon Ads bulk operations](https://advertising.amazon.com/help/GHTRFDZRJPW6764R) · [Google Ads automated rules](https://support.google.com/google-ads/answer/2472779) · [Shopify Flow](https://help.shopify.com/en/manual/shopify-flow)

**List-page design (Part 11, AS-S1R)** — [Linear display options](https://linear.app/docs/display-options) · [Sentry issues](https://docs.sentry.io/product/issues/) · [Datadog monitor list](https://docs.datadoghq.com/monitors/manage/) · [UiPath queue item statuses](https://docs.uipath.com/orchestrator/docs/queue-item-statuses) · [Temporal Web UI](https://docs.temporal.io/web-ui) · [Airflow UI](https://airflow.apache.org/docs/apache-airflow/stable/ui.html) · [**Airflow issue #66946** — the bar chart you cannot count, sort or act on](https://github.com/apache/airflow/issues/66946) · [GitHub Copilot agent sessions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents) · [GitHub agents panel](https://github.blog/changelog/2025-08-19-agents-panel-launch-copilot-coding-agent-tasks-anywhere-on-github-com/) · [Vercel redesigned deployments list](https://vercel.com/changelog/redesigned-deployments-list) · [Carbon data table](https://carbondesignsystem.com/components/data-table/usage/) · [Carbon empty states](https://carbondesignsystem.com/patterns/empty-states-pattern/) · [WCAG 1.4.1 Use of Color](https://www.w3.org/WAI/WCAG21/Understanding/use-of-color) · [WCAG content on hover or focus](https://www.w3.org/WAI/WCAG21/Understanding/content-on-hover-or-focus) · [Jira column/field overload](https://community.atlassian.com/forums/Jira-Cloud-Admins-discussions/Rethinking-Issue-View-Field-Configuration/td-p/2916049)

**Create-flow design (Part 12, AS-S2R)** — [Linear create issues](https://linear.app/docs/creating-issues) · [GitHub · assign an issue to Copilot](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/kick-off-a-task) · [Google Ads step 6 — review and publish](https://support.google.com/google-ads/answer/15864935) · [Google Ads campaign creation steps](https://support.google.com/google-ads/answer/15864533) · [**Red Hat / PatternFly — progressive form vs wizard**](https://medium.com/patternfly/comparing-web-forms-a-progressive-form-vs-a-wizard-110eefc584e7) · [**NN/g — progressive disclosure** (the two-level rule, and staged disclosure with interdependent steps)](https://www.nngroup.com/articles/progressive-disclosure/) · [Jira field-configuration overload](https://community.atlassian.com/forums/Jira-Cloud-Admins-discussions/Rethinking-Issue-View-Field-Configuration/td-p/2916049) · [W3C APG combobox patterns](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/examples/combobox-autocomplete-list/) · [Combobox vs multiselect vs listbox at scale](https://smart-interface-design-patterns.com/articles/combobox-multiselect-listbox/) · [Baymard — inline form validation](https://baymard.com/blog/inline-form-validation) · [Amazon Ads campaign manager + bulk operations](https://advertising.amazon.com/library/news/introducing-improved-campaign-manager-features) · [overscroll-behavior and dialog scroll containment](https://css-tricks.com/prevent-a-page-from-scrolling-while-a-dialog-is-open/)

**In repo** — `docs/2026-08-07-naf-sb-fleet-pages.md` §7 · `docs/2026-08-07-naf-sbw-workers-page.md` · `docs/2026-08-07-naf-wf-workflows-page.md` · `docs/2026-08-07-naf-sb-session-locks.md` · `docs/AGENT_FLEET.md` Parts 4, 6, 7 · `apps/api/src/services/agent-fleet/agent-executor.ts` · `charter-registry.ts` · `orchestrator.ts` · `observations/scope-filter.ts` · `apps/api/src/services/agents/approval-gate.service.ts` · `apps/api/scripts/_sbas-assignment-truth.mts`
