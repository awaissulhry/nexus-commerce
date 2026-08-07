# NAF.SB.W — section studies

Step two of the operator's two-step. `docs/2026-08-07-naf-sbw-workers-page.md`
agreed *what sections the Workers page has and why*; this studies each one in
enough detail to build it without inventing anything at the keyboard.

Studies are added as we reach them, in build order. Each one specifies: the
decisions, the exact data derivation, the exact copy, every empty state, and
what it must not become.

| Study | Section | Build step | Status |
|---|---|---|---|
| **0** | The table substrate — DS DataGrid or `acr-*` | precedes W.1 | **settled below** |
| **1** | S4 · The roster table, and the Status column | W.1 | specified |
| **2** | S2 · The roster health strip | W.2 | specified |
| **3** | S3 · Find, filter, views | W.3 | specified |
| 4 | S5 · The shared dial + bulk actions | W.4–W.5 | pending |
| 5 | S8 · Live updating | W.6 | pending |
| 6 | Worker detail — the missing sections | W.7 | pending |
| 7 | S6 · Create a worker | W.8 | pending, blocked on the instance model |
| 8 | S7 · Retirement | W.9 | pending |

---

## STUDY 0 — What the table is made of

This has to be settled before a line of W.1, because it decides whether bulk
selection, sorting, pagination and column customization are things we *get* or
things we *build*.

### The standing rule, and the objection to it

The operator's standing instruction (2026-07-21, on Sync Control) is explicit:

> "I would prefer something like we have built on the /products/next page. In
> fact, we must use the shared component."

Table surfaces use `DataGrid` + `GridToolbar` + `FilterBar` + DS `Pagination`
inside `h10-ds-gridcard`, with all four DS stylesheets imported by the page.

Against that, this exact subtree carries a documented refusal.
`control-room/GuardrailGrid.tsx`:

> "Deliberately NOT the shared DataGrid… the DS stylesheets carry `.dark` rules
> and `.h10-shell` pins this console light, which is the dark-cards-in-a-light-
> shell defect the ACR design notes decided against."

Both cannot be followed. So the objection has to be tested rather than inherited.

### The objection does not survive inspection

The premise is that the DS stylesheets carry `.dark` rules. They do not. Counted:

| Stylesheet | `.dark` rules |
|---|---|
| `tokens.css` | **1** — a single block that redefines `--h10-*` custom properties |
| `primitives.css` | 0 |
| `components.css` | 0 |
| `patterns.css` | 0 |

Dark mode in this design system is **entirely token substitution**. Every
component reads variables. Custom properties inherit, so re-declaring them on a
container beats an ancestor `.dark` for that container's whole subtree.

That fix is not hypothetical here — it is shipped, twice:

- `.productsNextLight` (`products/next/products-next-shell.css`) — on the very
  page the operator named as the standard.
- `.h10-shell` (`ads.css`, ACR.1.6) — 40 declarations, with the warning that
  matters: **"Pin ALL of them or none. A subset leaves a half-dark palette —
  light cards with light text — which is worse than either extreme."**

So `/products/next` is *already* a light-pinned surface running the DS DataGrid.
The combination the GuardrailGrid comment calls impossible is the combination
the reference page is built on.

### ⚠ The two pins are not interchangeable — copy the right one

They disagree about what a token *is*, and this is a known live defect, not a
style difference:

```css
/* ads.css .h10-shell — Tailwind TRIPLETS, for rgb(var(--x) / <alpha>) */
--border-default: 203 213 225;

/* products-next-shell.css .productsNextLight — WHOLE COLOUR VALUES */
--border-default: var(--h10-grey-200);
```

`design-system/styles/primitives.css` consumes them as whole values:
`border: 1px solid var(--border-default)`. Under the triplet convention that
becomes `1px solid 203 213 225`, which is invalid, so the **entire declaration is
dropped** and Tailwind preflight's `border: 0px solid` wins. That is why DS
buttons render with no border in the ads console and correctly on
`/products/next`, and it is why the hand-rolled hex overrides all over the ads
console exist — they are workarounds for a base style that never applied.
(`reference_ds_token_triplet_collision`; measured on prod 2026-08-05.)

**Copying ACR.1.6's block onto `.fleet-surface` would reproduce that defect on
every fleet page.** The pin to copy is **`.productsNextLight`** — semantic
aliases expressed through the `--h10-*` primitive ramp, which the `.dark` block
never touches, so there is one source of truth for the hex.

The corollary, and it becomes a rule for this subtree: **inside
`.fleet-surface`, semantic tokens are whole colours.** Do not use Tailwind
colour utilities that consume them as triplets (`text-primary`, `surface-card`,
`border-default` and friends) anywhere under it. The fleet pages consume none
today — they are `acr-*` with literal hex — so the subtree starts consistent and
must stay that way. Verify with the ten-second console check in that reference:
`getComputedStyle(btn).borderTopWidth` must not be `0px`.

### A latent defect on `/fleet`, found on the way

`.fleet-surface` (`fleet-pages.css:19`) sets `background`, `color` and
`color-scheme: light` — and **does not pin the DS tokens.** Today nothing
notices, because every fleet page uses only `acr-*` classes with hard-coded
light hex. The moment any DS component renders on a fleet page in dark mode, it
draws dark cards on a light page — the exact ACR.1.6 defect, waiting.

### Decision

> **Pin the DS tokens on `.fleet-surface` — the same block ACR.1.6 already
> reviewed — and build the roster on the DS `DataGrid` + `GridToolbar` +
> `FilterBar` + `Pagination` stack inside `h10-ds-gridcard`.**

Because: it honours the standing rule; it closes a latent defect rather than
routing around it; it costs one CSS block instead of a hand-built selection
model, sort model, pagination and column-visibility system; and it touches
neither `control-room.css` nor `fleet-sections.css`, both owned by other
sessions.

**Consequences to handle, not to discover later.**

1. **Pin all, or none — and pin the `productsNextLight` way**, semantic aliases
   expressed through `var(--h10-*)`, never as Tailwind triplets. See the warning
   above; getting this wrong is invisible in review and produces borderless
   buttons in production.
2. **Two visual families on one page.** The roster becomes a DS grid card among
   `acr-*` cards. That tension already exists across the ads console and is
   accepted there. The header, strip and drawers stay `acr-*`; only the *table*
   is DS.
3. **The DS ratchet greps comments.** Inline `fontSize` and hex are blocked, and
   naming an element in a *comment* can fail the ratchet
   (`reference_ds_guard_greps_comments`). Utility classes only.
4. **Page-local stylesheet.** New rules go in `app/fleet/workers/workers.css`,
   per the session-lock convention. `fleet-pages.css` stays frozen.

**If the operator prefers the `acr-*` family instead**, say so and Study 1 still
stands — every derivation, every word of copy and every empty state below is
substrate-independent. Only the rendering changes.

---

## STUDY 1 — S4 · The roster table, and the Status column *(build step W.1)*

### 1.1 The problem this section actually solves

Today's table has seven columns and cannot answer the first question an operator
asks: **is this thing working?** It shows `OFF` for every worker — which is true —
and `1 failed` for a worker that was stopped by its own token limit, which is a
safety mechanism succeeding.

Six of seven rows say exactly the same thing. The column that would make them
different does not exist.

### 1.2 The Status column — six words, and a reason under each

Nine distinct conditions exist in the data. Nine badges is a legend nobody
reads. The resolution: **six status words, each with a mandatory reason line**
that carries the specificity. The word is scannable; the reason is honest.

| Word | Tone | When | Reason line — worked examples from real data |
|---|---|---|---|
| **Not set up** | grey, outlined | no `AgentCharter` row exists for this key | "It exists in code but has no settings row — it has never been set up. Seed it and it joins the roster properly." |
| **Off** | grey | `!enabled` or `autonomyLevel === 'OFF'` | "Switched off — it does not run and costs nothing." · if it has never run: "Switched off, and it has never run." |
| **Paused** | amber | `pausedUntil` in the future | "Paused until 14 Aug — “waiting on the credit top-up”." |
| **Running now** | blue | an `AgentRun` with `status: 'running'` | "Started 40 seconds ago." |
| **Needs attention** | red | on, and its last run was not ok — see §1.3 | class-specific, below |
| **Working** | green | on, and its last run was ok | "Ran 3h ago · 4 findings · $0.0041." |

Six words, ordered by precedence — first match wins, top to bottom, with one
exception: **Degraded outranks everything.** If `degraded` is true the settings
could not be read at all, so no other status can be trusted; the row shows
**Needs attention** with "Its settings could not be read from the database. What
you see is the fail-safe posture, not your choices."

**Why "Needs attention" and not "Failing".** Three of the four real failure
classes are not the worker's fault. A word that blames the worker for the
provider being unreachable trains the operator to distrust the wrong thing.

### 1.3 The failure taxonomy — never flattened

Measured on 26 not-ok runs (`_sbw-failure-classes.mts`). Derived from
`errorMessage` and `haltedReason`; the classifier is the one in that script and
should move into shared code so the roster, Activity and the detail page agree.

| Class | Count | Reason line | Whose fault |
|---|---|---|---|
| `fetch failed` | **21** | "Couldn't reach the AI provider on its last run. That is a connection problem, not this worker's." | infrastructure |
| `credit balance is too low` | **3** | "The AI provider refused the request — the account is out of credit." | billing |
| `schema validation failed` | **1** | "Its answer didn't match the format it promised. Nothing was written." | **the worker** |
| `halted: budget_tokens…` | **1** | "It hit its own token limit and stopped part-way. That limit worked — raise it, or accept the shorter answer." | **nobody** |
| anything else | 0 | the raw message, truncated, verbatim | unknown |

**`halted: budget_tokens` is not a failure and must never be coloured as one.**
It is stored as `ok: false` and it is a limit doing its job. Its status word is
**Needs attention** — because it does need a decision — but its tone is amber,
not red, and its reason line says the limit worked.

### 1.4 The columns

Nine by default. Everything else is opt-in through *Customize columns* (§Study 3).

| # | Header | Tooltip (`<Term>` where a glossary entry exists) | Cell | Sort | Align |
|---|---|---|---|---|---|
| 1 | **Worker** | *worker* | avatar · name → `/fleet/workers/[key]` · key below · **diagnostic badge** on `fleet-selftest` | name | left |
| 2 | **Status** | "Whether this worker is running, and if not, why." | word + reason line (§1.2) | precedence order | left |
| 3 | **Job** | *tier* | tier as `<Term>` · domain muted | tier order, then name | left |
| 4 | **What it may do** | *off/observe/propose/auto* + *ceiling* | level chip · ceiling when it differs · **inline dial at W.4** | ladder order | left |
| 5 | **Scope** | "Which marketplaces and campaigns this worker may look at." | marketplaces, or **"Everything"** with a warning tint when unscoped and above OFF | scoped-first | left |
| 6 | **Last run** | "When it last ran, and how that went." | relative time + outcome dot | timestamp | left |
| 7 | **Open findings** | *finding* | count, or `—` | count | right |
| 8 | **Cost 7d** | "What it spent on AI in the last 7 days." | `$0.0041`, or muted `$0` | amount | right |
| 9 | **Report card** | *grade* | grade chip + "may be promoted" | grade | left |

**Optional columns:** Model · **Charter** (`code` / `edited · rev 2`) · Next run ·
Budget/day · Tokens/run · Created by · Created on.

Two of those deserve a note. **Charter** is currently invisible and matters: two
revisions exist, so at least one worker runs an *edited* instruction and the
roster says nothing. **Scope** shows "Everything" for all six workers today —
which is correct, and is exactly why it should be visible rather than assumed.

### 1.5 The `fleet-selftest` treatment *(approved 2026-08-07)*

It holds 47 of 64 open findings and 38 of 47 runs. Left untreated every number
on this page is mostly about a self-test.

- It stays in the table, with a **`diagnostic`** badge beside its name and a
  tooltip: "A self-test worker. It checks that the fleet itself works, and its
  findings are not about your account."
- Headline numbers in the health strip are **business workers only**, with the
  self-test's contribution as a footnote — never hidden, never averaged in.
- **The classifier is a flag on the charter, not a heuristic on `domain`.**
  `CharterDefinition.diagnostic`, set only on `fleet-selftest`.

  This document first proposed `domain === 'ops'`, "which today selects
  `fleet-selftest` and `fleet-auditor`". That was wrong twice, and prod caught
  it: `fleet-auditor` is `domain: 'fleet'`, so the rule missed it — and
  `domain: 'ops'` is precisely where Part 6 of `docs/AGENT_FLEET.md` puts
  `ops-schema-drift`, `ops-sync-health` and `ops-tech-debt-triage`, three real
  business analysts the rule would have silently dropped out of the totals on
  the day they were written. A heuristic that is right by coincidence today and
  wrong by design tomorrow is worse than the hard-coded key it was avoiding.

  Which leaves `fleet-auditor` a **business** worker, correctly: it writes the
  operator brief and attributes outcomes. Reporting on the fleet is its job, not
  a self-test.

### 1.6 Empty and degenerate states

| State | What the table says |
|---|---|
| Loading | skeleton rows, not a spinner — the shape arrives before the data |
| No workers at all | "No workers are set up yet. Seed the roster to create the settings rows for the seven workers that exist in code." + the seed action |
| Whole fleet off *(today)* | table renders normally; the strip carries the sentence, not the table |
| Filter matches nothing | "No worker matches that." + the specific filters to clear, named |
| A cell has no data | never bare `—`. "Not graded yet — report cards are computed nightly." |
| API error | the existing error banner with Try again; the table keeps the last good data and marks itself stale |

### 1.7 The one backend change W.1 needs

**A `provisioned: boolean` on the charter payload.** `toEffective()` renders a
worker with no database row as `enabled: false, autonomyLevel: 'OFF', degraded:
false` — byte-identical to a worker deliberately switched off. The client
cannot tell them apart, so **Not set up** is underivable without it.

One field, in `charter-registry.ts`, additive, no route change — so it does not
touch `agent-fleet.routes.ts` and cannot collide with the parallel session. The
file is claimed in the session-lock register.

Alongside it, and separately: **seed `fleet-auditor`.**
`POST /agent/fleet/charters/seed` is already create-if-absent. That fixes the
one instance we have; the field is what stops the next one being invisible.

### 1.8 Accessibility and interaction

- Sortable headers are buttons with `aria-sort`; the DS DataGrid provides this.
- Status is never colour-alone — the word carries the meaning, colour reinforces.
- The reason line is real text in the cell, not a `title` attribute. A tooltip
  that hides the reason for a failure is a tooltip hiding the point.
- Row click does not navigate. The name is the link; a click target that swallows
  the whole row makes selection checkboxes hazardous.
- "Running now" animates; it respects `prefers-reduced-motion`.

### 1.9 What this section must never become

A runs table. One *last* run per row and a link to Activity. The moment a second
run appears in a row, the boundary in Part 5 of the parent document has been
crossed.

---

## STUDY 2 — S2 · The roster health strip *(build step W.2)*

### 2.1 What is wrong with the strip today

Four tiles: Workers · Switched on · Open findings · Spent 7 days. Three of four
are census. None is clickable. None would have told the operator that one of
their seven workers has never been set up.

Agent 365's registry leads with *Total agents*, **Agents without owners**,
**Unmanaged agents** — two of three are governance gaps. That is the correction.

### 2.2 The five tiles

| Tile | Value | Sub-line | Click → |
|---|---|---|---|
| **Workers** | count | tier breakdown: "4 analysts · 1 director · 1 critic · 1 auditor" | clears filters |
| **Switched on** | live count | 0 → **"the whole fleet is off"**; else "of 7" | filter: live |
| **Needs attention** ⚠ | count | the classes present: "1 never set up · 1 stopped by a limit" | filter: needs attention |
| **Earned a promotion** | `promotionEligible` count | 0 → "none yet — they earn it over 14 days"; else "and has not been given it" | filter: eligible |
| **Spent, 7 days** | `$0.0000` | "of the $X daily ceiling" | → `/fleet/cost` |

**Needs attention** is the union of: not provisioned · degraded · paused · last
run not ok · enabled but never run. Its definition and the Status column's are
**one function**, so a tile reading `3` and a table showing four amber rows is
structurally impossible.

**Every tile is a button.** Summary-card-to-filtered-list is standard in every
console studied and we do not do it. A number the operator cannot act on is a
poster.

### 2.3 Honesty rules

1. **Business workers only** in Workers, Needs attention, Earned a promotion and
   Spent — with the self-test footnote below the strip: "Not counting
   `fleet-selftest`, a diagnostic worker: 47 more findings, $0.0032."
2. **No fabricated denominators.** Spend shows "of the $X daily ceiling" only
   when `/agent/fleet/state` actually returns one.
3. **Zero is a sentence, not a dash.** "The whole fleet is off" is the most
   useful thing this page can say today, and it should say it in words.
4. **A halted fleet outranks the strip.** If `state.halted`, a banner sits above
   it: nothing runs regardless of what any tile says.

### 2.4 What this section must never become

A cost dashboard. The first sparkline, model breakdown or week-over-week
comparison belongs on `/fleet/cost`. The strip points; it does not analyse.

---

## STUDY 3 — S3 · Find, filter, views *(build step W.3)*

### 3.1 Sizing the problem honestly

Six rows today. Part 6 of `docs/AGENT_FLEET.md` plans a roster of roughly
twenty-five. Filtering must be built for twenty-five and must not feel like
bureaucracy at six.

The resolution: **three named views do the work; facets are there when the views
are not enough.**

### 3.2 The three built-in views

| View | Shows | Why it is a view and not a filter |
|---|---|---|
| **All** | everything | the default |
| **Live** | `enabled && level ≠ OFF` | "what is actually running" — the morning question |
| **Needs attention** | the S2 union | "what needs me" — the only question that ends in an action |

Built-in, not user-saved. Saved views are a power-user feature that costs a
beginner a concept; three named answers to three real questions cost nothing.
Selecting a view sets the URL (`?view=live`) so it can be linked and bookmarked.

### 3.3 Facets

Search across name, key, description and domain — debounced, and reflected in
the URL.

Chips for **tier · status · autonomy · domain · grade**. Each carries its count
and toggles off when clicked again. Rendered in one visible row, not behind a
dropdown, so the whole filter state is readable without opening anything — the
convention `acr-pg-chips` already sets on this page.

**Deliberately not built yet:**
- *Scope* — every worker is unscoped today, so the facet would render one bucket.
- *Marketplace* — same reason.
- *Free-text query builder* — that is Activity's job, over runs, not this.

Both become worth building the moment scoping is used; noted so the omission is
a decision rather than an oversight.

### 3.4 Customize columns

The honest column list (§1.4) is longer than one screen. Agent 365 solves this
with *Customize view*; so do we.

- A popover listing every column with a checkbox; the nine defaults pre-checked.
- **Worker and Status cannot be unchecked** — a registry row without an identity
  or a health state is not a registry row.
- Choice persists per browser (`localStorage`), not per account. A per-account
  preference implies a settings surface this page does not have.

### 3.5 Freshness

- An **"as of HH:MM:SS"** stamp beside Refresh, always visible.
- On the shared polling hook (W.6), the stamp updates itself and a *"3 workers
  changed since you looked"* cue appears rather than the table silently
  re-sorting under the cursor.
- Refresh stays as a manual control. Polling that removes the manual control
  leaves an operator with no way to force the question.

### 3.6 What this section must never become

A cross-page query surface. If someone wants "every run by this worker last
Tuesday that cost more than $0.01", that is Activity, and this page links there.

---

## Open items carried forward

| # | Item | Where it lands |
|---|---|---|
| 1 | `provisioned` field on the charter payload | W.1, `charter-registry.ts` (claimed) |
| 2 | Seed `fleet-auditor` | one existing POST, any time |
| 3 | Move the failure classifier into shared code so roster / Activity / detail agree | W.1, then reused |
| 4 | `AgentControlAudit` is empty after real dial use — diagnose | before W.4 writes more attributable changes |
| 5 | Pin the DS tokens on `.fleet-surface`, the `productsNextLight` way | Study 0, precedes W.1 |
| 6 | Verify no DS button under `.fleet-surface` computes `border-top-width: 0px` | W.1 browser check on prod |
| 7 | `.h10-shell` pins the semantic tokens as triplets and breaks DS borders across the ads console — not ours to fix, but do not copy it | noted; owner's call per `reference_ds_token_triplet_collision` |
