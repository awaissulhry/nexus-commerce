# NAF.SB.W — The Workers page: what it is for, and what is on it

**Status: PROPOSAL — awaiting operator approval.** Nothing here is built. This is
step 1 of the two-step the operator set out on 2026-08-07: *first agree what
sections a page needs and why; then study each section on its own; then build
them one at a time.*

Parent: `docs/2026-08-07-naf-sb-fleet-pages.md` (the ten-page map, approved).
Sibling in flight: **Workflows**, owned by a parallel session — see Part 11 for
the file-ownership protocol that keeps the two out of each other's way.

| | |
|---|---|
| **Route** | `/fleet/workers` (roster) · `/fleet/workers/[key]` (one worker) |
| **Group** | BUILD — *what should happen* |
| **Built today** | roster `4e3ec6576` (419 lines, read-only table) · detail `FX.3` (643 lines, 10 sections) |
| **This document** | the section list for both surfaces, each with its purpose and its boundary |

---

## PART 0 — The one sentence

> **Workers is the registry: every worker the fleet has, what each may do, whether
> each is healthy, which one needs you — and the only place a new one is made.**

A page whose purpose cannot be said in one sentence is two pages. This one can,
and the sentence has four clauses that map exactly to the four things no other
fleet page can do:

| Clause | Why only this page can do it |
|---|---|
| *every worker … in one list* | The map draws six nodes beautifully and twenty-five nodes as a hairball. A table is the only surface that scales with the roster. |
| *what each may do* | Comparison **down a column**. "Which of my workers can act unsupervised?" is one glance here and eleven clicks anywhere else. |
| *whether each is healthy* | Inventory integrity — degraded, unseeded, paused, failing, never-run. Nothing else in the fleet asks "is my roster itself broken?" |
| *the only place a new one is made* | Authorship. Creating and retiring workers has no other home, and must not acquire one. |

Everything proposed below has to earn its place against one of those four
clauses. Anything that does not belongs on one of the other nine pages, and
Part 10 says which.

---

## PART 1 — Ground truth: what the page will actually render

Measured against the production database on 2026-08-07, not assumed.
(`apps/api/scripts/_sbw-roster-truth.mts`, `_sbw-failure-classes.mts` — both
read-only.)

### 1.1 The roster is six rows, and one of them is a lie

`FLEET_CHARTERS` in `charter-registry.ts` declares **seven** workers. The
database holds **six** `AgentCharter` rows. `fleet-auditor` has **no row at
all** — it was never seeded.

This matters more than it sounds. Read `toEffective()`:

```ts
if (degraded || !db) {
  return { ...def, enabled: false, autonomyLevel: 'OFF', /* … */ degraded }
}
```

A worker with no policy row resolves to `enabled: false, autonomyLevel: 'OFF',
degraded: false` — **pixel-identical to a worker the operator deliberately
switched off.** Today's roster shows seven rows, all OFF, and gives the operator
no way to tell "I turned this off" from "this has never existed in the
database". That is precisely the blind spot Microsoft's Agent Registry surfaces
with its *Unmanaged agents* card, and it is the first concrete argument for
Section 2 below.

| Worker | Tier | Domain | Level | Ceiling | Budget/day | Row in DB? |
|---|---|---|---|---|---|---|
| `fleet-selftest` | analyst | ops | OFF | OBSERVE | $0.25 | yes |
| `amazon-negative-miner` | analyst | amazon-ads | OFF | OBSERVE | $0.10 | yes |
| `amazon-keyword-harvester` | analyst | amazon-ads | OFF | OBSERVE | $0.10 | yes |
| `amazon-bid-tuner` | analyst | amazon-ads | OFF | OBSERVE | $0.10 | yes |
| `amazon-ads-director` | director | amazon-ads | OFF | PROPOSE | $0.30 | yes |
| `plan-critic` | critic | amazon-ads | OFF | OBSERVE | $0.20 | yes |
| `fleet-auditor` | auditor | fleet | OFF | OBSERVE | — | **NO** |

(That domain is `fleet`, not `ops` — the row has no database entry, so the value
comes from the code charter. An earlier draft of this table guessed `ops`, and
the guess went on to produce a real bug; see Study 1 §1.5.)

Every `cadence` is `null` and every `scopeMarketplaces` is `[]`. So a "Next run"
column has nothing per-worker to say, and a "Scope" column says *everything,
everywhere* for all six. Both facts are load-bearing for the column design in
Part 3.

### 1.2 "Failed" is four different things, and one of them is success

47 fleet runs ever. 26 not-ok. But they do not mean the same thing, and an
operator who is shown one word for all four learns to distrust the word:

| Class | Count | Whose fault | What the operator should do |
|---|---|---|---|
| Provider unreachable (`fetch failed`) | **21** | Infrastructure | Nothing about the worker. Fix the network/provider. |
| Provider refused — out of credit | **3** | Billing | Top up. Not a worker problem. |
| Output failed its own contract | **1** | **The worker** | Read the charter. This is the only one that indicts the worker. |
| `halted: budget_tokens 20142 of 20000` | **1** | **Nobody — this is a limit working** | Raise the cap, or accept the truncation. |

That last row is the sharpest finding in this document. `amazon-negative-miner`
hit its token ceiling and was stopped mid-flight, exactly as designed, and it is
recorded as `ok: false`. A Status column that renders it as *Failing* teaches
the operator that a functioning safety limit is a defect. **A worker's status
must distinguish "it broke" from "we stopped it".**

Per worker: `fleet-selftest` 38 runs / 24 not-ok (and 21 of those 24 are the
network class); every other worker has run between 1 and 4 times.

### 1.3 What else exists, and what does not

- **14 scorecards** exist, so the grade column has data.
- **2 charter revisions** exist, so at least one worker is running an *edited*
  instruction rather than the code one. **Nothing on the roster says so.**
- **0 rows in `AgentControlAudit`** — and, diagnosed at W.4, this is **correct,
  not a defect.** An earlier draft of this document called it "the audit write
  not firing on the paths that have actually been used". It was wrong. A write
  probe inserts and reads back fine; every route that changes a control does
  call `recordControlChange`. The table is empty because **no control has ever
  been changed through the API**: the two charter revisions were authored by
  `_ac-preview-prod.mts`, a verification script calling
  `createRevision`/`activateRevision` in the service layer directly, and the 18
  approvals are dated 2026-06-17 — nearly two months before AP.1 added approval
  auditing, and they belong to the older copilot tool-approval flow
  (`apply-content`, `set-price`, `send-customer-message`), not to the fleet.
  The one real residue: **auditing lives in the route layer, so a script that
  changes a control on prod is invisible to the trail.** Worth knowing before
  anyone writes one.
- 43 of 47 runs were `mode: ask`; triggers are `manual` and `schedule`.
- Newest fleet run: **2026-08-07T01:51Z** (`amazon-negative-miner`). The fleet is
  dark but not inert.

**Design consequence.** Every section below is specified with an *empty state
that teaches* and a *populated state*, because on the day this ships most cells
will be empty, and an empty registry that explains itself is the difference
between "the product is broken" and "the fleet is off, here is how to light it".

---

## PART 2 — What the industry puts on this exact page

Part 1 of the parent document surveyed the *products*. This surveys the *page* —
seven registries, and the one idea each contributes that we do not already have.

### A · Microsoft Agent 365 — Agent Registry
The closest archetype we have. Its list carries name, publisher, platform,
**owner**, deployment status, Graph permissions, data and tool access, risk
count and 30-day sessions; filters are Status, Publisher type, Channel, Platform
and Data source; the toolbar is Refresh · Export CSV · Add agent · **Customize
view** (choose your columns).

**The idea worth stealing:** its three summary cards are *Total agents*, **Agents
without owners**, **Unmanaged agents**. Two of three are governance *gaps*, not
vanity metrics. Our current strip is Workers / Switched on / Open findings /
Spend — three of four are vanity. §1.1 just proved we have an unmanaged worker
and no way to see it.

Its detail view is tabbed: Details · Users · **Data & Tools** · Security ·
**Permissions** · Certification · **Activity** · Agent instances · Connected
agents. Note *Agent instances* — the registry already distinguishes a template
from its instantiations.

### B · LangGraph / LangSmith — Assistants over Graphs
> "An assistant is an *instance* of a graph with a specific configuration."

Graphs are code; assistants are data. Editing an assistant mints a new version;
any version can be promoted or rolled back. This is our Part-4 capability /
composition split, already shipped by someone else, under a name we should
borrow the *shape* of but not the word.

**The idea worth stealing:** the whole model for "create a worker" (Part 6),
including its most important warning — updating an assistant requires the
**entire** configuration payload, because a partial update silently drops the
fields you omitted. Our create/edit API must be explicit about merge semantics
or it will quietly reset budgets.

### C · UiPath Orchestrator — Robots, Machines, Statuses
Robots and Machines are separate pages, and the Machines page carries an
**Accept Jobs** column (*is this thing allowed to take work?*) distinct from a
**Status** column (*is it reachable?*).

**The idea worth stealing:** *allowed to work* and *able to work* are two
different columns. We conflate them: `enabled` is permission, but "did its last
run reach the provider" is capability, and today the roster shows neither
honestly. §1.2's 21 unreachable runs are a capability failure that no amount of
dial-twiddling fixes.

### D · Temporal — Worker Deployments
Versions carry lifecycle state: Inactive · Active (Current or **Ramping**) ·
Draining · Drained, with a ramp percentage for gradual rollout.

**The idea worth stealing:** *a worker is never simply on or off.* Temporal's
"scheduled work with no worker polling" is the classic silent failure, and it is
ours too — a charter with `cadence` set and no successful run in a week looks
identical to a healthy one on our roster. Ramping also foreshadows charter A/B
(AC.8), which we have in the backend and show nowhere.

### E · ServiceNow AI Control Tower — the Value dashboard
Consolidates ROI, cost avoidance and, usefully, **adoption blockers** — policy
holds, latency, access gaps.

**The idea worth stealing:** for each worker *not* promoted, name the specific
thing it still owes. The deep version is `/fleet/cost`; the roster's share is
one honest column — **Report card**, with promotion eligibility on it — and no
more.

### F · Salesforce Agentforce Studio
Moved Testing Center **out of Setup and into the Studio as a tab**, beside
Builder and Observability, explicitly because a separate surface got ignored.

**The idea worth stealing:** keep the thing you do to a worker *next to the
worker*. It is the argument for creating a worker in a drawer on the roster
rather than at `/fleet/workers/new`, and for the detail page keeping its Charter
Studio rather than exporting it to a governance page.

### G · CrewAI AMP / Agent Control Plane
"A centralized view of fleet health, LLM consumption, and enterprise-wide
policies"; per-execution traces capture reasoning, tool calls, token split and
timeline.

**The idea worth stealing:** *fleet health* is a first-class noun, ranked
alongside consumption and policy. Confirms Section 2's third tile.

### H · n8n — the counter-example, and why it matters
n8n's sidebar is Overview · **Workflows** · Executions · Credentials · Insights ·
Variables · Data tables. There is **no workers page at all**, because in n8n the
unit of authorship *is* the workflow; nodes are stock parts.

**The idea worth stealing:** the negative one. n8n proves a workflow product does
not need a registry. We need one because our unit of authorship is the *worker*
— a durable thing with a budget, a grade, a scope and a trust level that
persists across every routine it appears in. If Workers ever degenerates into "a
list of nodes you can drag onto the Workflows canvas", it should be deleted and
folded into Workflows. **The test: does a row here own a budget, a grade and a
trust ladder position? If yes, the registry earns its place.** Today it does.

---

## PART 3 — The roster: `/fleet/workers`

Nine sections. Each states its purpose, why it belongs here rather than on one
of the other nine pages, and what it must never grow into.

---

### S1 · Header and the teaching layer
**Purpose.** Tell someone who has never seen the fleet what a worker is, in one
sentence, before they read a single number.

**Contents.** Title, one-sentence subtitle, an intro line, and the shared
**"How this works"** drawer trigger — the FX.4 teaching layer that every fleet
page carries, not a Workers invention. Plus `<Term>` glossary tooltips on every
piece of jargon in the page (`worker`, `tier`, `autonomy`, `ceiling`, `finding`,
`grade`, `charter`, `scope`).

**Why here.** Beginner-legibility is a condition of done on every fleet page.

**Must never become.** A second copy of `/fleet/guide`. The drawer explains *this
page*; the guide explains *the fleet*.

---

### S2 · Roster health strip — *five tiles, each one a filter*
**Purpose.** Answer "is my roster itself healthy, and does anything need me?" in
under two seconds — then let the operator click straight into the rows behind
the answer.

**Contents (proposed).**

| Tile | Reads | Why it is on the strip |
|---|---|---|
| **Workers** | count + tier breakdown | Inventory. The only pure-census tile. |
| **Switched on** | `enabled && level ≠ OFF`, of total | Posture. Says *"the whole fleet is off"* in plain words when the count is 0 — which is today. |
| **Needs attention** ⚠ | unseeded + degraded + paused + failing + never-run | **The new one.** Agent 365's *Unmanaged agents*, adapted. §1.1 says this is `1` right now and nothing shows it. |
| **Earned a promotion** | `promotionEligible` | The only good-news tile, and it is actionable: a worker that has earned trust and has not been given it is wasted evidence. |
| **Spend, 7 days** | Σ cost, and % of the fleet daily ceiling | The cost anchor. A number and a proportion — never an analysis. |

Every tile is a button that applies the matching filter to S4. This is standard
in every console studied and we do not do it today.

**Why here.** Comparison and integrity are the registry's job. A per-worker page
cannot tell you one of seven workers was never seeded.

**Must never become.** A cost dashboard. The moment a tile wants a sparkline or a
breakdown by model, it belongs on `/fleet/cost`.

---

### S3 · Find, filter, and views
**Purpose.** Make the table usable at 25 workers — the roster size Part 6 of the
master brief plans for — not just at 7.

**Contents.**
- Search across name, key, description, domain.
- Facet chips: **tier · status · autonomy · domain · grade**. (Scope facet is
  deferred: §1.1 shows every worker is currently unscoped, so a marketplace
  filter would render one bucket.)
- Three **built-in views**, not user-saved ones: **All · Live · Needs
  attention**. Saved views are a power-user feature that costs a beginner a
  concept; three named answers to three real questions cost nothing.
- **Customize columns** (Agent 365's *Customize view*), because Part 3's honest
  column list is longer than one screen.
- Refresh, and an "as of" timestamp so a stale tab is visibly stale.

**Why here.** Filtering a table is the table's own affordance.

**Must never become.** A query builder. If someone needs a saved cross-page
query, that is Activity's filter set, not this.

---

### S4 · The roster table — *the heart of the page*
**Purpose.** One row per worker, comparable down every column, sortable by every
column, and honest about what it does not know.

**Proposed default columns.** (Each gets its own study before build; this is the
shape, not the final spec.)

| # | Column | Why | New? |
|---|---|---|---|
| 1 | **Worker** — name, key, avatar; links to detail | Identity | — |
| 2 | **Status** — one word: Off · Idle · Running · Failing · Stopped by a limit · Paused · Degraded · **Not set up** | UiPath's *able to work* vs *allowed to work*, and §1.2's four failure classes collapsed into words an operator can act on | **NEW** |
| 3 | **Job** — tier + domain | What kind of thing it is | — |
| 4 | **What it may do** — level + ceiling | The trust ladder position | — |
| 5 | **Scope** — marketplaces / campaign count, or *everything* | Blast surface. Governance-critical and currently visible only on Controls | **NEW** |
| 6 | **Last run** — relative time + outcome | Liveness | — |
| 7 | **Open findings** | Output volume | — |
| 8 | **Cost 7d** | Spend anchor | — |
| 9 | **Report card** — grade + promotion eligibility | Trust evidence | — |

**Optional columns** (off by default, available in *Customize columns*): Model ·
**Charter revision** (code, or edited — §1.3 says two workers run edited
instructions and nothing says so) · Next run · Budget/day · Tokens/run · Created
by · Created on.

**Two rules the table must obey.**

1. **A failure class is never flattened.** "1 failed" is not a status. The cell
   must distinguish *the provider was unreachable* (not the worker's fault) from
   *it broke its own contract* (entirely the worker's fault) from *a limit
   stopped it* (working as designed). §1.2 is the evidence.
2. **`fleet-selftest` must not dominate.** It holds 47 of the 64 open findings
   and 38 of the 47 runs. It is a **diagnostic** worker, not a business one. The
   table needs to say so — a badge, and probably exclusion from the strip's
   headline numbers — or every aggregate on this page is a self-test's shadow.

**Row actions** (hover / kebab): Open · Run it now · Pause until… · Switch off ·
See its activity · See its charter.

**Why here.** This is the clause-1 and clause-2 surface. It is the page.

**Must never become.** A runs table. One *last* run per row, and a link. Runs are
Activity's.

---

### S5 · Select and act — *bulk operations*
**Purpose.** The registry's reason to exist at scale: do one thing to twelve
workers without twelve page visits.

**Contents.** Checkbox column → a sticky action bar: **Switch off · Pause
until… · Run now · Set scope · Set autonomy**, each with a server-built sentence
naming exactly what will change.

**The safety rule, inherited from Controls verbatim:** *controls that reduce risk
apply immediately; controls that let a worker do more ask first and say what it
will cost.* A bulk switch-off is instant. A bulk promotion enumerates every
worker and its new level before it commits.

**The anti-duplication mechanism, and it is the important part of this
document.** Controls (`/fleet/controls`) already renders an autonomy ladder with
per-rung effect sentences and a confirmation dialog. Workers must not grow a
second one. The resolution: **extract the dial, its effect copy and its confirm
into one shared component**, and let both pages render it in different modes —
Controls in *explain* mode (one card per worker, full prose, the ladder as a
teaching object), Workers in *operate* mode (inline in a row, and over a
selection). One component, one confirmation, one audit write, two presentations.
Divergence then becomes impossible rather than merely discouraged.

**Why here.** Bulk needs a multi-select surface, and a table is the only one.

**Must never become.** A place to edit prompts, budgets or tools in bulk. Bulk
editing an *instruction* across workers is how a fleet changes behaviour without
anyone reading a diff.

---

### S6 · Create a worker
**Purpose.** Operator ask #4, at the scope Part 7 decision 3 approved: **a new
*instance* of a charter type that already exists in code.** New name, scope,
budget, cadence and instruction overlay. Never new tools, never new write paths,
never a new capability.

**Contents.** A drawer (not a route — Agentforce's lesson in §2F), stepped:

1. **Start from** — pick a charter type, with its plain-language job description
   and what it reads.
2. **Name it** — display name, auto-derived key, one-line description.
3. **Where it works** — marketplaces, portfolios, campaigns.
4. **What it may spend** — daily budget and tokens per run, both **capped by the
   template's code values and visibly so**.
5. **When it runs** — cadence, or *only when asked*.
6. **Extra instructions** — an overlay appended to the template's prompt, never a
   replacement.
7. **Review** — two columns, *what this worker will be able to do* and **what it
   will never be able to do**, generated from the template rather than written by
   hand. Then: created at **OFF**, always.

**Why here.** Clause 4. There is no other candidate page, and there must not be.

**Must never become.** Charter authoring. Writing a prompt from scratch is the
detail page's Charter Studio (AC.1–AC.3), which has revisions, diffs, evals and
rollback. This drawer produces an *overlay*, and it says so.

**⚠ This section has a hard backend prerequisite — see Part 6.** It cannot be
built as a UI-only change, and it is the reason this section is last in the
build order.

---

### S7 · Retirement and lifecycle
**Purpose.** If instances can be created they must be retirable, and retiring a
worker must not erase it — its runs, findings, costs and decisions are history
the audit trail depends on.

**Contents.** Retire (a state, not a delete) · a **Retired** filter value ·
restore · and a refusal to retire anything code-owned, with the reason stated.

**Why here.** Lifecycle belongs with the registry in every archetype studied.

**Must never become.** A delete button. Nothing in the fleet is ever deleted.

---

### S8 · Live updating
**Purpose.** The operator asked for real-time. A roster that is stale the moment
a run starts, a dial moves in another tab, or a finding lands is a screenshot.

**Contents.** Poll while the tab is visible; pause when hidden; a visible "as of"
stamp and a *changed since you looked* affordance rather than a silent re-sort
under the cursor.

**Why here — and why it is not a Workers decision.** Every one of the ten pages
needs this and the answer must be identical on all ten, or "real-time" means ten
different things. **This is a shared-infrastructure decision that both live
sessions must agree on before either implements it.** Logged in Part 11.

**Must never become.** A per-page polling implementation. Ten timers is a bug
with ten homes.

---

### S9 · Teaching empty states
**Purpose.** On the day this ships, most cells are empty. An empty cell must say
*what will appear here, when, and what has to be true first* (FX.4's rule), never
"—" alone.

Worked examples, from the real data:
- **No grade yet** → "Report cards are computed nightly. This one appears after
  its first night on the books."
- **Never run** → "It has never run. It is switched off — switch it on, or run it
  once by hand to see what it does."
- **Not set up** (`fleet-auditor`) → "This worker exists in code but has no
  settings row. Seed it, and it joins the roster properly."
- **Whole fleet off** → the strip says so in words, and offers the one next step.

**Why here.** Condition of done, per FX.4. Listed as a section so it is reviewed
rather than assumed.

---

## PART 4 — The worker's own page: `/fleet/workers/[key]`

Ten sections exist (FX.3 + AC.1–AC.8) and they are good. This is an audit — what
stays, what is missing, and where it duplicates.

### 4.1 What exists, and the verdict on each

| # | Section | Verdict |
|---|---|---|
| 1 | Who I am — description, tier, dial, ceiling | **Keep.** The dial becomes the S5 shared component. |
| 2 | Its pipeline — real steps from the last run | **Keep.** The best section on the page. |
| 3 | What it reads — evidence feeds with previews | **Keep.** |
| 4 | What it has found lately | **Keep**, capped, with "see all" → Activity. |
| 5 | Its limits — budget, tokens, findings, no write access | **Keep.** |
| 6 | Its report card | **Keep.** |
| 7 | Run controls — run now, pause, resume | **Keep**, but replace two `window.prompt()` calls with a real dialog. A native prompt cannot be tooltipped, styled, validated or translated, and this page's standard is higher than that. |
| 8 | Charter Studio — revisions, diff, activate, revert, A/B | **Keep.** This is the deep authoring surface S6 deliberately is not. |
| 9 | What has been changed, and by whom | **Keep** — and **investigate**: §1.3 found this table empty after real dial changes. Either the audit write is not firing or it is not firing on the paths used. Either way the page currently promises an audit trail it does not have. |
| 10 | Run history with inline traces | **Keep**, capped at 20, with "see all" → Activity. |

### 4.2 What is missing

| Missing | Why it belongs here | Where it must not go |
|---|---|---|
| **Where it sits in the fleet** — who feeds it, who it feeds, as a small static picture | Answers "why does this exist" better than any prose | Not a second interactive canvas. A picture with links. |
| **Its scope** — marketplaces, portfolios, campaigns, editable | The blast surface of *this* worker. Currently visible only as a chip on Controls | Fleet-wide scope policy stays on Controls |
| **Its model and what it costs** — model, per-run cost, today's burn against budget | Cost attaches to a worker before it attaches to a fleet | Trend analysis is `/fleet/cost` |
| **Its status, stated** — the S4 status in a sentence, with the failure class | §1.2: an operator on this page deserves "the provider was unreachable 21 times; that is not this worker's fault" | — |
| **Its assignments** and **its workflows** | Cross-links, once those pages exist. Placeholders until then | The lists themselves live on their own pages |
| **Duplicate / retire** | Instance lifecycle, per S7 | — |

### 4.3 The roster/detail split, stated once

> **The roster compares. The detail explains. Anything you would do to *one*
> worker knowing only its name belongs on the roster; anything that needs its
> history belongs on the detail page.**

Run-now and pause satisfy that test on both surfaces, which is fine — they are
the *same action*, invoked from the same shared component, not two
implementations.

---

## PART 5 — The boundary map: Workers versus the other nine

The operator's constraint was explicit: *nothing may be built twice across the
ten pages.* This table is how that gets enforced, and it is meant to be quoted
in review.

| Concept | **Owned by** | On Workers it appears as | On the detail page as |
|---|---|---|---|
| The list of workers | **Workers** | the table (S4) | — |
| Autonomy dial + its confirm | **one shared component**; Controls explains, Workers operates | inline + bulk (S5) | the same component |
| Fleet halt, daily ceiling, tool policy, protected terms, authority pins | **Controls** | a banner if the fleet is halted, nothing more | — |
| The promotion ladder as a teaching object | **Controls** | one Report-card column | grade + what it still owes |
| Runs: list, filter, export, permalink | **Activity** | one *Last run* cell | last 20 + "see all" |
| Step traces | **Activity** | never | inline for its own runs |
| Findings: browse, filter, search | **Activity** / SB.10 | a count | last 12 + "see all" |
| Approvals queue | **Approvals** | never | a link |
| Spend analysis, cost per accepted action, ROI | **Cost & value** | one *Cost 7d* column | its own budget burn |
| Who feeds whom, live pulses, overlays | **Fleet map** | never | one static "its place in the fleet" |
| Named routines, edges, triggers, gates, versions | **Workflows** | never | "used by these workflows" |
| One worker, one job, one target | **Assignments** | never | "its open assignments" |
| Uploaded sheets and reference tables | **Files & data** | never | "files attached to it" |
| Prompt authoring, revisions, diff, A/B, evals | **Worker detail** (Charter Studio) | one optional *revision* column | the Studio |
| **Creating and retiring a worker** | **Workers** | S6, S7 | duplicate / retire |

Read the "never" column as a build instruction. Six of the fourteen concepts must
be **absent** from the roster; each is one link away.

---

## PART 6 — The thing that would have bitten us: `FLEET_CHARTERS` is frozen

Section 6 ("Create a worker") cannot be built as a UI change. Here is why,
precisely.

`charter-registry.ts` treats code as the sole source of existence:

```ts
/** Code truth — a charter absent here does not exist, whatever the DB says. */
export const FLEET_CHARTERS = Object.freeze({ /* seven entries */ })

// loadDbPolicies():
where: { key: { in: Object.keys(FLEET_CHARTERS) } }

// listCharters():
return Object.values(FLEET_CHARTERS).map(def => toEffective(def, policies?.get(def.key), …))

// resolveCharter(key):
const def = FLEET_CHARTERS[key]
if (!def) return null
```

A worker created as a database row and nothing else would be **invisible to the
roster, unresolvable by the executor, absent from scorecards, and missing from
the fleet graph.** The create drawer would appear to work and produce nothing.

**The design that keeps every law true.** An *instance* is a stored row that
names a code template and may only ever **narrow** it — the same discipline
`toEffective()` already applies to policy, extended to identity:

- `templateKey` **must** exist in `FLEET_CHARTERS`; validated on save.
- Inherited and **not editable**: `outputSchemaKey`, `toolNames`,
  `observationKeys`, `autonomyCap`, `tier`, `outputs`. This is what keeps L2
  (*agents get zero new write paths*) and L3 (*no agent may spawn an agent*)
  true by construction rather than by policy.
- Editable and **clamped by the template's values**: name, description, scope,
  `dailyBudgetUSD`, `maxTokensPerRun`, `maxFindingsPerRun`, `cadence`, and a
  prompt **overlay** (appended, never replacing).
- `resolveCharter()` falls through to instances; `listCharters()` returns code
  charters ⊕ instances; both keep the existing degraded fail-safe.

**Three consequences worth naming now.**

1. **The fleet graph is code too.** `FLEET_GRAPH` names seven node keys. An
   instance of `amazon-negative-miner` has to inherit its template's edges, or it
   runs disconnected and the director never sees its findings. **This is a
   direct dependency on the Workflows session's Layer-2 design** — flagged in
   Part 11 as the one true cross-session coupling.
2. **`topoLevels()` throws on unknown edge endpoints.** A malformed graph is a
   build error today; with instances it becomes a *runtime* error unless edge
   derivation is part of the same change.
3. **LangGraph's warning applies** (§2B): the update payload must be explicit
   about merge semantics, or editing an instance's name silently resets its
   budget.

**Recommendation: this is its own phase, after the registry ships.** Sections
1–5 and 7–9 need no schema change and can ship over the existing endpoints.
Section 6 needs a table, a resolver change, a graph-derivation rule and an
agreement with the Workflows session. Building the registry first also means
"create a worker" is designed against a page that exists.

---

## PART 7 — Two defects found while researching, which are not this page's fault

Recorded here so they are not lost, and so the Workers page is not blamed for
them:

1. **`fleet-auditor` has no charter row.** It has never been seeded, has never
   run, and is indistinguishable from a deliberately-off worker. `POST
   /agent/fleet/charters/seed` is create-if-absent and would fix it. Cheap, and
   it makes the *Needs attention* tile provably correct on day one.
2. ~~`AgentControlAudit` is empty despite two authored charter revisions and real
   dial usage.~~ **Withdrawn — diagnosed at W.4 and there is no defect.** See
   §1.3: the writer works, every control route calls it, and the trail is empty
   because nothing has yet changed a control through a control surface. The
   narrow finding that survives is that **service-layer calls bypass the audit**,
   so a script changing a control on prod would leave no trace.

Only the first blocks anything, and it blocks nothing on this page.

---

## PART 8 — Proposed build order

Each step is independently shippable and visibly better than the one before.
Steps 1–5 need **no new API surface**, which matters while a parallel session
owns `agent-fleet.routes.ts`.

| Step | What | New backend? |
|---|---|---|
| **W.1** | Status column + failure classes + honest empty states (S4 rules, S9) | none |
| **W.2** | Health strip with *Needs attention* and *Earned a promotion*; tiles filter the table (S2) | none |
| **W.3** | Filters, the three built-in views, Customize columns, "as of" (S3) | none |
| **W.4** | Extract the shared dial + confirm; inline dial on the row; Controls re-points at it (S5, first half) | none |
| **W.5** | Bulk select and act (S5, second half) | none — existing PATCH per row |
| **W.6** | Live updating, using whatever shared mechanism both sessions agree (S8) | shared decision |
| **W.7** | Worker detail: missing sections, real dialogs instead of `window.prompt`, capped lists with "see all" (Part 4.2) | small |
| **W.8** | **Create a worker** — instance model, resolver fallthrough, graph derivation, the drawer (S6, Part 6) | **substantial** |
| **W.9** | Retirement and lifecycle (S7) | small |

Teaching layer, tooltips and `<Term>` coverage are **not a step** — they are a
condition of done on each one.

---

## PART 9 — Operator decisions (settled 2026-08-07)

All four as recommended.

1. **The autonomy dial is operable from the roster — APPROVED.** One shared
   component: the dial, its per-rung effect copy and its confirmation dialog are
   extracted once. Controls renders it in *explain* mode (a card per worker, full
   prose, the ladder as a teaching object); Workers renders it inline in a row
   and over a bulk selection. One confirm, one audit write, so the two surfaces
   cannot drift. The safety rule is unchanged and inherited: **reducing risk
   applies immediately, increasing it confirms and says what it will cost.**
2. **"Create a worker" is step W.8, after the registry ships — APPROVED.** W.1
   through W.7 need no new API surface and can ship over existing endpoints while
   the parallel session owns `agent-fleet.routes.ts`. Instantiating workers that
   have never successfully run would be authoring against a hypothesis.
3. **`fleet-selftest` is badged and excluded from headline numbers — APPROVED.**
   It stays in the table, visibly marked as a diagnostic worker. The health
   strip's counts — findings, runs, spend — are **business workers only**, with
   the self-test's contribution shown as a footnote rather than hidden. Nothing
   is concealed; nothing is averaged into a lie. Implemented as an explicit
   `CharterDefinition.diagnostic` flag — see Study 1 §1.5 for why the `domain`
   heuristic this document originally proposed was wrong, and how prod caught it.
4. **Real-time is visibility-gated polling — APPROVED.** One shared hook:
   refetch roughly every 10s while the document is visible, pause when hidden, an
   "as of" stamp, and a *changed since you looked* cue rather than a silent
   re-sort under the cursor. No new infrastructure, works identically through
   Vercel and Railway. **This is the answer for all ten pages** — recorded in
   `docs/2026-08-07-naf-sb-session-locks.md` §5 so the Workflows session adopts
   the same one.

---

## PART 10 — Parallel-session file ownership

Two sessions are live: this one on **Workers**, another on **Workflows**. The
protocol, and the current claims, live in
**`docs/2026-08-07-naf-sb-session-locks.md`** — read it before touching any
shared file, and record a claim before editing one.

The one genuine coupling is **Part 6's instance model**: Workflows' Layer-2
stored graph and Workers' worker instances are the same architectural question
seen from two sides. Neither should design it alone. It is not needed before
W.8, so there is time.

---

## Sources

- [Microsoft 365 Agent Registry](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-registry?view=o365-worldwide) · [agent details](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-details?view=o365-worldwide) · [governance & lifecycle actions](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-actions?view=o365-worldwide)
- [LangGraph Platform — Assistants](https://docs.langchain.com/langgraph-platform/assistants) · [Assistant versioning](https://langchain-ai.github.io/langgraphjs/cloud/how-tos/assistant_versioning/) · [Assistant Editor](https://blog.langchain.com/asssistant-editor/)
- [UiPath Orchestrator — Managing Robots](https://docs.uipath.com/orchestrator/automation-cloud/latest/user-guide/managing-robots-modern-folders) · [Robot statuses](https://docs.uipath.com/orchestrator/standalone/2023.4/user-guide/robot-statuses) · [Managing Machines](https://docs.uipath.com/orchestrator/automation-cloud/latest/user-guide/managing-machines)
- [Temporal — Worker Versioning](https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning) · [Safe deployments with Worker Versioning](https://temporal.io/blog/safe-deployments-with-temporal-worker-versioning-on-kubernetes)
- [ServiceNow AI Control Tower](https://www.servicenow.com/products/ai-control-tower.html) · [solution brief (PDF)](https://www.servicenow.com/content/dam/servicenow-assets/public/en-us/doc-type/resource-center/solution-brief/sb-ai-control-tower.pdf)
- [Agentforce Studio & Builder](https://help.salesforce.com/s/articleView?id=ai.agent_builder_studio.htm&language=en_US&type=5) · [Agentforce Testing Center](https://www.salesforce.com/blog/agentforce-testing-center/)
- [CrewAI AMP](https://docs.crewai.com/en/enterprise/introduction) · [CrewAI traces](https://docs.crewai.com/en/enterprise/features/traces)
- [n8n editor UI](https://docs.n8n.io/courses/level-one/chapter-1/) · [n8n executions](https://docs.n8n.io/workflows/executions/)
- [What is an Agent Registry? (Prefactor)](https://prefactor.tech/learn/what-is-an-agent-registry) · [Agentic explainability at scale (arXiv 2604.14984)](https://arxiv.org/pdf/2604.14984)

In-repo: `docs/2026-08-07-naf-sb-fleet-pages.md` · `docs/AGENT_FLEET.md` Parts 4,
6, 7 · `apps/api/src/services/agent-fleet/charter-registry.ts` ·
`apps/api/src/services/agent-fleet/fleet-graph.ts` ·
`apps/web/src/app/fleet/workers/WorkersClient.tsx` ·
`apps/web/src/app/fleet/controls/ControlsClient.tsx`
