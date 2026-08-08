# NAF.SB.M-S1R — Section 1, the census strip: a measured audit and a rebuild

**Status: STUDY LANDED 2026-08-08, AWAITING OPERATOR APPROVAL. No code written.**

| | |
|---|---|
| **Page** | `/fleet/map` — the Operate group, page 4 of ten |
| **Section** | §M1, the census strip: the band above the canvas |
| **Parent** | `docs/2026-08-07-naf-sbm-fleet-map-page.md` §M1 (approved 2026-08-07) |
| **House shape** | `docs/2026-08-07-naf-sbw-section-studies.md` |
| **Lock** | `docs/2026-08-07-naf-sb-session-locks.md` §2, row **Fleet map (`SB.M`)** |
| **In scope** | `app/fleet/map/lib.ts` (`CHIPS`, `census`, `visibleCensus`, `filterSummary`, `diagnosticFootnote`) · `MapClient.tsx` (the `.sbm-census` block) · `definitions.tsx` · `HowThisMapWorks.tsx` · `map.css` (`.sbm-census*`, `.sbm-chip*`, `.sbm-def*`) |
| **Shared files claimed** | **none.** `fleet-pages.css` is not touched; `glossary.tsx` gains no term; `_shared/run-health.ts` is read, never edited |
| **Backend** | **none.** Every figure this section needs is already in the `GET /agent/fleet/map` payload — verified live, §7 |

Everything below was measured on the deployed build at
`https://nexus-commerce-three.vercel.app/fleet/map`, viewport **1728×906**,
2026-08-08. Every defect carries a number or a quotation. Nothing here is
inferred from reading the source.

---

## PART 0 — The one sentence, and what the section is for

> **Before the graph is read: is anything wrong, and is anything even on? And
> then let each number become a lens onto the graph beside it.**

That is the whole contract. The section is not a dashboard, not a roll-up, and
not a narrative. It is a verdict and a set of lenses.

Judged against that contract, the strip as shipped answers **neither** question
well. "Is anything even on?" is answered by a pill reading `7 off`, drawn in the
same 11.5px as `1 never run`. "Is anything wrong?" is answered by nothing at
all: the two facts that would answer it — that **26 of the 53 runs in the window
did not end ok**, and that **all 47 of the self-test's open findings are past
their expiry** — appear nowhere in the section, while the one figure the section
*does* caveat in a footnote is a figure it never shows.

---

## PART 1 — What is wrong today, measured

23 defects. They fall into six groups. I have marked the seven I would fix even
if nothing else changed.

### 1.1 · The strip spends its width on nothing (the biggest one)

**⚠ D1 — 1063px of the card is empty; 65.9% of it.** The card is 1614px wide.
`.sbm-census-rows` occupies **270.7px** and `.sbm-census-side` **254.3px**, with
**1063.0px** of nothing between them. Content ink is **525px of 1614 = 32.5%**.

And it gets worse as the screen gets better. The strip has **no `@media` rule of
any kind** (grepped: `map.css` defines media queries only for `.sbm-body`), so
this is an element-width probe with nothing hidden behind a breakpoint:

| viewport | card | chips | spend | dead | |
|---|---|---|---|---|---|
| 1280 | 1166.0 | 270.7 | 254.3 | **615.0** | 52.7% |
| 1440 | 1326.0 | 270.7 | 254.3 | **775.0** | 58.4% |
| 1728 | 1614.0 | 270.7 | 254.3 | **1063.0** | 65.9% |
| 1920 | 1806.0 | 270.7 | 254.3 | **1255.0** | 69.5% |

**⚠ D2 — the strip has no width problem; it has a layout that refuses width.**
Measured with a canvas text metric against the shipped font: **every lens the
census can ever draw — all ten states and facts — laid out on one line needs
1037.3px.** The card is 1614px. The full vocabulary of this section fits
horizontally with 576.7px to spare, and it is currently stacked into three rows
inside a 270.7px column.

```
running 74.5 · working 79.0 · off 50.6 · paused 73.4 · not provisioned 117.3
needs attention 119.6 · never run 84.9 · last run failed 109.0
stopped by a limit 129.3 · waiting in Approvals 145.7      Σ + gaps = 1037.3px
```

**⚠ D19 — and it spends vertical it does not have.** Card top to canvas top is
**164.0px**. Total chrome above the canvas is **308.8px of a 906px viewport =
34.1%**. The canvas's own bottom lands at **1088.4px — 182.4px past the fold.**
The section takes a fifth of the page's vertical budget to arrange 525px of
content inside 1614px.

### 1.2 · The three ranks are one rank

The design depends on a hierarchy — *subject* (the total), *state* (a partition
that sums to the total), *fact* (overlapping flags that do not). Measured, the
three render as very nearly the same object.

| | subject | state | fact |
|---|---|---|---|
| label | 11.5px / 600 | 11.5px / 400 | 11.5px / 400 |
| number | 11.5px / 700 | 11.5px / 700 | 11.5px / 700 |
| height | 27.3px | 27.3px | 27.3px |
| fill | `rgb(247,249,252)` | `rgb(255,255,255)` | `rgb(255,255,255)` |
| border | `#cfd8e3` | `#dde4ec` | `#dde4ec` |

**D3.** The entire visual difference between "this number is the denominator"
and "this number is one of the parts" is a font-weight step and a fill that
measures **1.05:1** against the active fill. Rank 3's only distinguishing marks
are a divider and a label, and both are below the standard:

**⚠ D4 — the "ALSO" label is the lowest-contrast text in the section, at 2.50:1**
(`#9aa5b3`, 10.5px, on white; AA needs 4.5:1). It is the *only* thing on screen
naming the section's most important distinction — which counts sum and which do
not.

**D5 — its divider measures 1.17:1** (1px dashed `#eaeef3` on white) and spans
**270.7px of a 1614px card**. In the rendered screenshot it is not visible at
all. A device carrying a load-bearing distinction cannot be a rule nobody sees
under a label nobody can read.

### 1.3 · Things that look interactive and are not, and things that are and do not look it

**⚠ D6 — the one chip that can never be active is drawn as the active one.**
`7 workers` is `<button aria-pressed="false">`; its click handler clears the
filter, and `aria-pressed` is structurally incapable of becoming `true`
(`MapClient.tsx:510`). It is drawn with a *filled* background and 600 weight —
and `.sbm-chip.on`, the active-filter state, is also a filled background. Two
fills, both "filled", one meaning "the total" and one meaning "the active
filter", **1.05:1 apart.**

**⚠ D7 — no channel distinguishing a pressed lens from an unpressed one reaches
even 1.5:1.** WCAG 1.4.11 asks 3:1 for the visual information identifying a
component *and its states*. Measured:

| channel | resting → active | |
|---|---|---|
| fill | `#ffffff` → `#eef4fb` | **1.11:1** |
| border | `#dde4ec` → `#a8c4e4` | **1.40:1** |
| text | `#4a5666` → `#1f4f8b` | **1.10:1** |

Three things change at once and no one of them is perceptible to the standard.
The state is carried, in practice, only by `aria-pressed`. Separately, the
control's own boundary — `#dde4ec` on white — measures **1.28:1**, so the chip
has no perceptible edge either.

**D8 — a lens that can only ever produce nothing is pressable.** Pressing
`0 waiting in Approvals` on prod dims all seven nodes and prints, verbatim:
`0 of 7 workers shown: waiting in Approvals — the rest are dimmed, not hidden.`
That zero is structural — the fleet's propose-tools are preview-only, so no
approval can ever be queued (locks §5 decision 8) — so the control's only
possible outcome is a graph with nothing in it.

**D21 — the counts jitter the row.** Growing one count from `7` to `1284`
widens its chip by **22.3px** and shifts every chip after it. On a 10-second
poll that is movement under the cursor.

### 1.4 · The strip breaks the page's own law

**⚠ D9 — pressing a lens moves the canvas 29.3px down.** `.sbm-canvas` top goes
**346.0 → 375.3**; the first node goes **y 918.3 → 947.5**. Inside the canvas
the law holds perfectly — x stays at 397.1 and non-matching nodes dim to
`opacity: 0.28` — and then the strip breaks it from outside, by inserting
`.sbm-filterline` as a new block between the strip and the graph. The node you
were pointing at is 29.3px from where it was.

### 1.5 · The section states things it has not read, and caveats things it does not show

**⚠ D10 — while the map's own fetch is in flight the strip asserts three counts
about a fleet it has not read.** Captured on prod, by navigating client-side
into `/fleet/map` with the map request delayed:

```
0: (no strip)
1: [0 workers · 0 running · 0 waiting in Approvals]  spend=ABSENT  canvas=skeleton
2: [7 workers · 0 running · 7 off · 1 never run · 0 waiting in Approvals]  spend=shown
```

State 1 is a counted claim, not a placeholder, and its lenses are live buttons.
This is the defect Activity recorded in its own S2R — on a surface whose silence
means *all clear*, an un-asked question and a tick are the same pixels.

**D11 — the footnote caveats a number the section does not show.** It reads
`47 of the 64 open findings belong to Fleet self-test analyst, which checks the
fleet rather than your account.` There is no findings count anywhere in the
strip. The reader is warned about the skew in a figure they have not been given.

**D12 — the footnote fails AA**: `#667485` on `#f4f6f9` = **4.41:1** at 11.5px.

**D13 — precision is mixed inside one sentence**: `spent $0.0000 of the $2.00
daily ceiling today`.

**D14 — the spend sentence has no relationship, horizontal or vertical, to
anything.** It sits 1063px right of the chips and ends at y=179.8 while the chip
column runs to y=256.5 — **76.8px above the bottom of the thing it shares a card
with.**

### 1.6 · Two tooltip mechanisms, in one card, both broken differently

**⚠ D15 — `Def` fails two of WCAG 2.2 SC 1.4.13's three requirements.**

- **Hoverable** — *"the pointer can be moved over the additional content without
  the additional content disappearing"*. `.sbm-def-tip` is `pointer-events:
  none`. Hit-testing the centre of each of the five open tooltips returns the
  element *behind* it: `sbm-chiprow rank-fact`, `n`, `sbm-chip`,
  `sbm-footnote`, `sbm-page`. Five of five.
- **Dismissible** — *"a mechanism is available to dismiss the additional content
  without moving pointer hover or keyboard focus"*. There is no key handler. The
  page's Escape handler clears the selection, then the filter — never the
  tooltip.
- Persistent is satisfied.

This is the same finding the Approvals stream measured on the shared `<Term>`
and shipped a fix for at `dd9a179da`. It is unfixed here, on this page's own
component.

**⚠ D16 — the tooltips are in the accessibility tree whether open or closed.**
They are hidden with `opacity: 0` while remaining `visibility: visible; display:
block`, with no `aria-hidden`. **The strip's flat text is 808 characters where
its five labels are 60 — 13.5×.** A screen-reader user browsing the strip hears
every definition unasked, and then hears it a second time as the chip's
description on focus. It begins:

> `7 workersEvery worker drawn on this map: the ones your enabled routines name,
> plus the ones the nightly job runs itself. Retired workers are not drawn.0
> runningNothing is running at this moment.7 offYou have switched it off…`

**D17 — `<Term>`'s definition is spliced into the middle of the spend
sentence.** The strip's own `textContent` reads:

> `spent $0.0000 of the $2.00 daily ceilingDaily ceilingThe hard cap on what the
> whole fleet may spend on AI per day ($2.00). … the fleet halts. today`

`<Term>` puts its tip inside the focusable span and sets no `aria-describedby`;
`Def` puts its tip beside the trigger and does. Two mechanisms, 1063px apart, in
one card, agreeing on nothing.

**D18 — and the definitions should not be tooltip-only at all.** NN/g:
*"Don't use tooltips for information that is vital to task completion."*
What a number counts is not supplementary — it is the number. Both mechanisms
are hover/focus-only, so on touch the definitions are unreachable, and tapping a
chip fires the filter instead.

**D20 — the strip has two tab stops too many, and will have ten.** Five chips
are five tab stops today, eleven at full population. The ARIA APG puts the
threshold for a toolbar with roving tabindex at **"3 or more controls."**

### 1.7 · Entity mode, and the teaching layer

**D22 — entity mode's strip is chips that are not controls.** Switching to
*What they watch* renders two `<span class="sbm-chip subject">` — `38 things`
and `103 relationships` — with `cursor: pointer`, **no role, no tabindex, no
`aria-pressed`, no definition**, visually identical to the Workers-mode chips
that *are* buttons and *do* filter. The cursor turns into a hand over something
that does nothing. Dead width in that mode: **977.6px, 60.6%**. Both of its
nouns are defined nowhere on the page.

**D23 — the teaching drawer directly above the strip never explains the strip.**
`HowThisMapWorks` has *Reading a card*, *Reading a line*, *The two views*, *What
this page cannot do*, and *Two numbers that surprise people* — and no section on
the census. Meanwhile the structural zero is written twice, in that drawer's
prose and in `CHIPS[].zeroNote`, from two sources that can drift.

### 1.8 · What is already right, and must survive the rebuild

Stated so the list above is trusted rather than taken as a verdict on the
section as a whole.

- **The count IS the predicate, and it holds live.** A chip reading `1 never run`
  produced `1 of 7 workers shown: never run`. `lib.vitest.test.ts` asserts the
  identity, the partition, the sum, reachability, and that a count never moves
  when another chip is active. **All ten tests must still pass at the end.**
- **Dimming is correct.** Non-matching nodes go to `opacity: 0.28`, positions
  unchanged (x = 397.1 before and after). Nothing is removed.
- **Focus is real.** Every chip takes a `2px solid #2b6cb0` ring at 1px offset,
  measuring **5.42:1** — comfortably past 1.4.11's 3:1 — and the tooltip opens
  on focus as well as hover, so the keyboard path is the same path.
- **Chip text passes AA**: labels 7.46:1 on white and 7.08:1 on the subject
  fill; numbers 15.48:1.
- **The section is a labelled region** (`aria-label="What is on this map"`), and
  the tooltip honours `prefers-reduced-motion`.
- **`Def` uses `aria-describedby`, not `title`.** That decision was right and is
  kept; only its visibility mechanics change.

---

## PART 2 — How the best consoles present a count strip that is also a filter

Sixteen products and five design systems, read against the eight questions this
section actually has to answer.

### 2.1 · Separating a total from its breakdown

Nobody good draws the total as a peer of its parts. **Airflow 3's** home page
leads with health indicators and then offers *quick links to DAGs filtered by
operational status* — the verdict first, the lenses second.
**Linear's** grouped list gives each status group a header with a coloured icon,
a label and a **muted count**, and the count is *inside* the group header, so it
can never be mistaken for a sibling of the groups. **Microsoft Agent 365's**
registry leads not with a total but with governance gaps — pending approvals,
ownership gaps, identified risks — because a total is the least actionable
number on the page.

**Consequence for us:** the total is a denominator, not a lens. It belongs in
the verdict sentence and inside each lens as "N of 7", and not as an eleventh
pill that pretends to filter.

### 2.2 · Pills vs tiles vs a stat row vs inline text

The choice tracks *how many* and *whether ranked*.

- **Tiles / stat cards** (Grafana's Stat panel, Agent 365, our own Workers
  strip) — few, equal-weight, each with room for a sub-line. Grafana's Stat is
  explicitly for "single values of interest"; it notes that a table is the right
  choice "when you need to show multiple rows of detailed data".
- **Inline counts in a group header** (Linear, GitHub) — many, subordinate to
  something else.
- **A faceted list with counts** (Datadog's log explorer) — many, in a rail,
  where each value "comes with … a count of logs matching" and clicking toggles
  the filter.
- **A legend that is the filter** (UiPath Orchestrator) — the states of one
  population, where you "filter out states by clicking the labels below the
  chart."

**Consequence:** ten ranked lenses is past the tile threshold and short of the
facet-rail threshold. The UiPath shape — a picture of the population with its
labels *underneath, as the filter* — is the closest match to a census that is
provably a partition.

### 2.3 · Showing that a count is interactive

Datadog, Airflow, UiPath and Sentry all make the count itself the control, and
all of them give it a control's affordances: a hover state, a cursor, a boundary
you can see. Carbon's status-indicator pattern is blunt about the encoding side:
statuses are made of symbol, shape, colour and type, and **"for WCAG compliance,
at least three of these elements must be present."**

**Consequence:** our lens carries exactly one — type — and a border at 1.28:1.
It needs a visible boundary and a glyph, not a heavier tint.

### 2.4 · Expressing the active state without moving anything

Everyone reviewed does the same three things: a fill change that clears 3:1, a
weight or border change, and an explicit removal affordance ("Clear filter" —
Cloudscape prescribes exactly that string). Nothing re-flows; the list dims,
truncates or re-queries in place.

**Consequence:** our active state must clear 3:1 on at least one channel and
carry a non-colour cue, and the summary of the active filter must occupy space
that was **already reserved**, or the graph moves — which it does today, by
29.3px.

### 2.5 · Placing a secondary fact beside counts

Grafana and Stripe keep the budget/threshold figure attached to the metric it
bounds, with the same period on both sides. The dashboard-design literature is
consistent that a metric needs "a single agreed-upon definition, an owner, a
refresh cadence, and documented caveats".

**Consequence:** spend belongs in its own labelled cell with a matching period
and a matching precision, not floated to the right margin of the lens card.

### 2.6 · Caveating a skewed number

The pattern is annotation attached to the figure, never a detached footnote:
name the cause next to the number. Carbon's rule for consolidation is the
related one — *"when multiple statuses are consolidated, use the highest-
attention color to represent the group"* — i.e. a roll-up must not launder its
worst constituent.

**Consequence:** our self-test caveat must sit against the findings figure, and
the findings figure must therefore exist. A caveat with no referent is worse
than no caveat.

### 2.7 · Explaining a count to a first-time reader

This is the question where the current design is furthest from the field.

- **NN/g:** *"Don't use tooltips for information that is vital to task
  completion"*; and *"Tooltips can be used only on devices with a mouse or
  keyboard. They are not normally available on touchscreens."*
- **GOV.UK:** *"Do not use the details component to hide information that the
  majority of your users will need"* — a disclosure is for "information that
  only some users will need".
- **WCAG 2.2 SC 1.4.13** then constrains whatever hover/focus content remains:
  Dismissible, Hoverable, Persistent.

**Consequence, and it is the section's biggest teaching decision:** the
definitions cannot live *only* in a tooltip. They need a keyboard- and
touch-reachable home in real DOM text, with the tooltip demoted to an
accelerator — and fixed.

### 2.8 · A zero that is zero for a structural reason

Cloudscape draws the sharpest line here, and names only two states: an **empty
state** ("the user hasn't created resources") and a **zero results state**
("the user has filtered and there are no matches") — with "No matches" and
"Clear filter" as the prescribed strings, and the rule *"Always provide an
action. Having no recourse creates confusion."* Grafana's Stat renders a hyphen
for no value by default, with configurable "No value" text.

Our `0 waiting in Approvals` is **neither** of Cloudscape's states. It is a
third thing: a count that is zero because the system structurally cannot produce
a non-zero, and will not be able to until Phase F. There is no recourse to
offer, so by Cloudscape's own rule it must not be a control.

**Consequence:** a structural zero is a *sentence*, not a lens.

---

## PART 3 — The design, with the reason under each decision

### D-S1.1 · The section leads with a verdict sentence, and the counts qualify it

One line, largest thing in the band, with a status glyph and the literal word.
Resolved in precedence order from data the payload already carries:

| when | the verdict |
|---|---|
| `state.halted` | **Halted.** Nothing will run, whatever any dial says. *(the existing banner keeps the who/why)* |
| any `running` | **N workers are running now.** |
| any severe last-run failure | **N workers' last run failed.** |
| every worker off | **The whole fleet is switched off.** Nothing is running, and nothing will start. |
| otherwise | **N of 7 workers are on, and their last runs were clean.** |

**Why.** The section's contract is a question, and today nothing on it answers
the question in a sentence — the answer has to be assembled by the reader from
five equal pills. Airflow leads with health and then offers filtered links;
Agent 365 leads with the gap, not the total. Our sibling Activity page already
proved this exact shape on prod at S2R: a headline that answers *is anything
wrong now* over rows that answer *what*. Two Operate pages then read the same
way, which is worth more than either page's local optimum. And the verdict is
the strongest possible form of the repair §M1 exists for: a green `running` pill
above seven `OFF` nodes becomes a sentence that cannot be misread.

### D-S1.2 · Rank is carried by three different devices, not three shades of one pill

- **Rank 0, the total** — deleted as a chip. It appears in the verdict sentence
  and as the denominator inside the active-filter summary.
  **Why.** Measured: it is a button that can never be pressed true, drawn in the
  fill that means "pressed", whose click does what the *Show all* link already
  does. Deleting it removes a control that lies about itself and costs nothing —
  the number stays on screen, twice.
- **Rank 1, the states** — a single horizontal **meter** divided in the states'
  proportions, with the labels underneath as the filter controls.
  **Why.** The partition is the one property this section's tests *guarantee*
  (`the state chips sum to the total`), and a divided bar is the only shape that
  shows summing. It is UiPath's legend-below-the-picture, and it makes "is
  anything even on" answerable without reading a single number: today the meter
  is one solid grey bar, end to end, which is the truest picture this page can
  draw. **Its licence is the test** — if the partition ever stops being a
  partition, the meter is a lie and must be deleted in the same commit.
  A non-zero state gets a minimum segment width so that 1-of-64 can never
  vanish.
- **Rank 2, the facts** — flags after a labelled `also`, with a leading glyph,
  visually outside the meter.
  **Why.** They deliberately overlap the partition (a worker is `off` *and*
  `never run`), and the current design says so with a 1.17:1 rule under a 2.50:1
  label. Being outside the bar is a structural statement instead of a decorative
  one.

### D-S1.3 · A structural zero is a sentence, not a control

`0 waiting in Approvals` and `0 running` stop being chips. `running`'s zero is
absorbed into the verdict ("Nothing is running, and nothing will start"), and
`waiting`'s becomes a stated fact with its cause inline: **"Nothing can wait for
you yet — the fleet's suggestion tools are preview-only, so a plan that passes
the critic still queues nothing."**

**Why.** Cloudscape's rule — always provide an action, and having no recourse
creates confusion — plus the measurement: pressing it today dims all seven nodes
and reports `0 of 7 workers shown`. And this *strengthens* the repair the chip
existed for: the reason `running` renders at zero is to stop a beginner reading
"the fleet is working", and a sentence does that better than a pill.

### D-S1.4 · The active state clears 3:1, and the filter summary occupies reserved space

The pressed lens gets a fill that clears 3:1 against the resting fill *and* a
non-colour cue (a check glyph and a weight step) — Carbon's "at least three of
these elements". The lens boundary itself clears 3:1. And the summary of the
active filter is rendered **inside the band, in a row that is always in the
layout**, replacing the verdict's sub-line rather than being inserted below the
card.

**Why.** Measured: nothing today reaches 1.5:1 between states (1.11 fill / 1.40
border / 1.10 text) and the boundary is 1.28:1, so the state is carried by
`aria-pressed` alone. And measured: inserting the summary moves the canvas
29.3px, which breaks this page's own stated law — *filtering dims, it never
re-lays-out* — from outside the canvas the law was written for. The Workflows
stream's rule applies verbatim: **reserve for the tallest honest sentence.**

### D-S1.5 · The spend fact and the findings fact become one labelled cell, and the orphan footnote goes into it

The band's right cell carries the fleet's two standing facts:

```
Spent today      $0.00 of $2.00
Open findings    64 — 47 of them stale, and 47 are the self-test's
```

Same period on both sides of the spend figure, same precision on both numbers,
and a sub-cent amount renders `<$0.01` rather than growing decimals.

**Why, and this is a change to the approved §M1 contents that needs your yes.**
The footnote today caveats "the 64 open findings" and the section shows no
findings count — a warning about a figure the reader was never given. Two ways
out: show the figure, or delete the caveat. I propose **showing it**, because
the map already ships `findings.openExpired` and **all 47 of the self-test's
open findings are past their expiry date, which no surface in the ten pages
currently says.** It is a fact that answers "is anything wrong" and it has
nowhere else to live.

The constraint from the Workers strip study is honoured: *a lens that filters
counts workers and its number is exactly the rows you get; a figure that does
not filter may report a different population.* **Open findings counts findings,
not workers, so it is a fact and never a lens** — clicking it could not produce
64 rows over 7 nodes.

If you would rather not add it: delete the footnote instead, and the section is
still correct. Say which.

### D-S1.6 · The definitions get a home in real text; the tooltip is demoted and fixed

Three layers, cheapest first:

1. **The label carries its own qualifier** where a word will do it — `7 switched
   off`, `1 never run — ever`, not `7 off` / `1 never run`.
2. **"What each number counts"** becomes a section of the existing
   `HowThisMapWorks` drawer, **generated from `DEFINITIONS`** so the two cannot
   drift, with a small affordance in the band that opens it. Real DOM text,
   reachable by keyboard and by touch.
3. **The hover/focus tooltip stays as an accelerator, and is repaired**:
   `visibility: hidden` when closed so it leaves the accessibility tree,
   `pointer-events: auto` so it satisfies Hoverable, and an Escape dismissal
   that does not require moving pointer or focus.

**Why.** NN/g and GOV.UK point the same way from opposite directions — a tooltip
must not carry what the task needs, and a disclosure must not hide what most
readers need. What a number counts is the number. Measured, the current
mechanism is unreachable on touch, fails two of SC 1.4.13's three requirements,
and inflates the strip's flat text from 60 characters to 808.

One drawer, not two: the teaching layer is already directly above the strip, and
a second collapsible would cost vertical this page cannot spare.

**The Escape fix must be written the way Approvals wrote theirs.** Their first
cut registered a `document` listener from every un-dismissed instance, so one
Escape would have dismissed all of them. The regression test belongs on the
surface with the most instances.

### D-S1.7 · The lenses are one tab stop

`role="toolbar"` with roving tabindex, Left/Right between lenses, Home/End to
the ends, one Tab in and one Tab out. Each lens stays a toggle button reporting
`aria-pressed`.

**Why.** APG: "3 or more controls". The section has five today and eleven at
full population, each currently its own stop, reached after 35 stops of app
chrome. Mutual exclusion (one lens at a time) stays a product decision the
*Show all* affordance makes reversible; modelling it as a radiogroup would be a
different lie, because "none selected" is a normal state here.

### D-S1.8 · Before the first successful read, the section states nothing

Until `data != null` the band renders a skeleton: the verdict line as a
placeholder, no meter, no lenses, no facts. On a failed read it keeps the last
good figures with the header's existing stamp, and never falls back to zeros.

**Why.** Measured on prod: the section currently asserts `0 workers · 0 running
· 0 waiting in Approvals` while its own request is in flight, with those zeros
as live buttons. Cloudscape's empty state means *the user has created nothing*,
not *we have not looked yet*, and Activity already paid for this lesson on a
sibling page.

### D-S1.9 · Entity mode gets an honest band of its own

The two spans stop being chips. They become that mode's verdict —
**"38 things the fleet watches, and 103 links it has worked out between them"**
— with `cursor: default`, no button semantics, and the counts defined in the
same drawer section as everything else.

**Why.** Measured: they are `<span>`s with `cursor: pointer`, no role, no focus,
no definition, drawn identically to controls that filter. That is the single
clearest instance on this page of "looks interactive and is not". Their nouns
are also the only two undefined counts on the map.

### D-S1.10 · Contrast, everywhere in this section

`#667485` → `#55616f` on the page background: **4.41:1 → 5.83:1**, page-local
under `.sbm-page`. The `ALSO` label and its divider are deleted with the device.

*(A note on a number in circulation: three streams have quoted `#55616f` as
6.02:1. Measured here against this page's resolved background `#f4f6f9` it is
**5.83:1**. Both clear AA; the figure differs because the backgrounds differ.
Quote 5.83 for a fleet page background.)*

**Not mine, measured for whoever owns it:** the header's `as of` stamp is
`#8a95a3` on `#f4f6f9` = **2.81:1**, and `.sbm-sub` is 4.41:1. Both are the page
header, which is S2's territory, not this section's. Numbers posted so nobody
re-measures.

---

## PART 4 — Two layouts, and which one I recommend

### Option A — the verdict band *(recommended)*

Three cells across the full width; two rows tall; the second row is reserved
whether or not a filter is on.

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ ◼ The whole fleet is switched off                    Spent today   $0.00 of $2.00  │
│   Nothing is running, and nothing will start.        Open findings 64 · 47 stale   │
│                                                                                    │
│ ████████████████████████████████████████████████████  ← 7 of 7 off                 │
│ [✓ 7 switched off]   also  [1 never run]  ·  Nothing can wait for you yet — the    │
│                            fleet's suggestions are preview-only.   ⓘ what these mean│
└────────────────────────────────────────────────────────────────────────────────────┘
```

When a lens is pressed, the verdict's sub-line becomes
`Showing 1 of 7 — never run. The rest are dimmed, not hidden. [Show all]` —
in space that was already there, so nothing below moves.

### Option B — the ranked stat row

The shape Workers already ships: evenly distributed tiles, each a big number, a
label and a qualifying sub-line, each a filter.

```
┌──────────┬──────────┬──────────┬───────────┬──────────┬──────────────────────┐
│    7     │    0     │    7     │     1     │    0     │  Spent today         │
│ workers  │ running  │   off    │ never run │ waiting  │   $0.00 of $2.00     │
│4 analyst…│ nothing  │ all of   │  auditor  │ can't    │  Open findings 64    │
│          │ in flight│  them    │           │ arrive   │   47 stale           │
└──────────┴──────────┴──────────┴───────────┴──────────┴──────────────────────┘
```

### The recommendation, and the reason

**Option A**, on five grounds, four of them measured:

1. **Ten lenses will not fit as tiles.** The section's full vocabulary is ten
   states and facts. As pills they measure **1037.3px** and fit one line in a
   1166px card at 1280. As tiles at a legible ~150px they need **1500px+**, so
   at 1280 they wrap into two rows of tiles — a second dashboard above a canvas
   already 182.4px past the fold.
2. **Tiles imply peers.** The partition/non-partition split is the one property
   this section's tests guarantee, and a row of identical tiles erases it — the
   same erasure the current three-shades-of-a-pill design already commits.
3. **Workers already owns the tile row** (six tiles, `naf-sbw-section-studies.md`
   STUDY 2). Two Operate pages wearing the same instrument is what the
   ten-page boundary table exists to prevent.
4. **Vertical.** The band targets **≤96px** card-top-to-canvas-top against
   today's **164px**; the sibling tile row measures ~90–110px *before* the
   filter summary and the caveat line.
5. **The verdict has nowhere to live in a tile row** without becoming a seventh
   tile — and it is the section's entire job.

**The honest case for B**, recorded rather than argued away: it is the shape the
operator has already learned on Workers; sub-lines give every count room for its
qualifier without any disclosure; and it is more obviously clickable. **If you
want consistency with Workers over per-page fit, say so and I will build B** —
consistency across ten pages can legitimately outrank local optimality, and
**every decision in Part 3 except D-S1.2's meter applies unchanged to either
layout.** The verdict sentence, the structural-zero rule, the 1.4.11 state fix,
the reserved summary row, the loading state, the tooltip rewrite, the toolbar
and the orphaned footnote are all layout-independent.

---

## PART 5 — Honesty rules for this section

1. **The count IS the predicate.** `census()` filters by the same `matches` the
   canvas dims by. Nothing else may produce these numbers, and the ten existing
   vitests stay green.
2. **A lens counts workers; a fact may count anything.** A lens's number is
   exactly the number of nodes left undimmed when you press it. Open findings
   counts findings, so it is never a lens.
3. **The meter is licensed by the partition test.** If the state chips ever stop
   partitioning, the meter is deleted in the same commit that breaks it.
4. **A structural zero states its cause and is not a control.**
5. **Nothing is asserted before it is read.** No count renders until the first
   successful read; a failed read shows the last good figures with their stamp.
6. **No fleet-wide failure percentage, ever** (Activity's rule): 24 of the 26
   not-ok runs in the window belong to one diagnostic worker hitting one network
   fault.
7. **A caveat sits against its figure.** No footnote may qualify a number the
   section does not show.
8. **Same period, same precision, one sentence.** Today's spend against a daily
   ceiling; never a 7-day sum against a daily ceiling.
9. **Filtering dims and never re-lays-out — including from outside the canvas.**
10. **The halt outranks the section.** When `state.halted`, the verdict defers to
    the banner and the meter greys entirely.

---

## PART 6 — Empty and degenerate states

| state | what the section does |
|---|---|
| **Before the first read** | Skeleton verdict line, no meter, no lenses, no facts. Zero counted assertions. |
| **Read failed** | The existing error banner stays above; the band keeps the last good figures and the header's stamp. Never zeros. |
| **No workers at all** (`nodes.length === 0`) | Verdict: *"No workers are wired up yet."* No meter, no lenses. The page's existing empty state carries the link to Workers. |
| **Halted** | Verdict defers: *"Halted — nothing will run."* Meter fully grey. Lenses still work; they are about looking, not running. |
| **Every worker off** (today) | *"The whole fleet is switched off. Nothing is running, and nothing will start."* One solid grey meter. |
| **One lens matches everything** | Pressing it dims nothing. The summary still says `Showing 7 of 7`, because a filter that changes nothing must say so rather than look broken. |
| **A structural zero** | A sentence with its cause, not a control. |
| **A four-digit count** | The number cell is `tabular-nums` with a min-width sized to four digits, so a poll cannot shift the row. Measured today: +22.3px and every later chip moves. |
| **All ten lenses populated** | One line at ≥1300px (1037.3px measured); a designed wrap to two lines below that, flags first. |
| **A wrapping label** | Labels are fixed vocabulary from a closed enum; the longest is `waiting in Approvals` at 145.7px. No lens wraps internally. |
| **Entity mode** | Its own verdict sentence; no lenses, because nothing in that mode filters. |

---

## PART 7 — The backend this section needs

**None.** Verified against the live payload rather than assumed
(`GET /api/agent/fleet/map?window=7d`, 200, `asOf 2026-08-08T10:02:51Z`):

- the verdict reads `state.halted` / `runs.runningNow` / `lastRun` — all present;
- the meter and the lenses read the same `nodes[]` `census()` reads today;
- spend reads `state.spentTodayUSD` (0) and `state.dailyCeilingUSD` (2);
- the findings fact reads `findings.open` and `findings.openExpired` — already
  served per node, and they sum to **64 open, 47 expired, all 47 the
  self-test's**.

No new endpoint, no new field, no migration, no change to any contract a sibling
stream reads.

---

## PART 8 — Accessibility and interaction

| | |
|---|---|
| **Landmark** | The band stays a labelled `region`; its label becomes the question it answers. |
| **Tab stops** | 5 (→11) become **1**. `role="toolbar"`, roving tabindex, Left/Right, Home/End. |
| **Toggle semantics** | Each lens stays a button with `aria-pressed`. The active state clears **3:1** on fill and carries a glyph + weight step, so colour is never the only channel (Carbon: at least three of symbol/shape/colour/type). |
| **Focus** | The existing `2px #2b6cb0 / 1px offset` ring is kept — measured **5.42:1** — and gets clearance from the neighbour so the ring is never clipped. |
| **Definitions** | Real DOM text in the teaching drawer, generated from `DEFINITIONS`; reachable by keyboard and by touch. |
| **Tooltip** | Accelerator only. `visibility: hidden` when closed so it leaves the a11y tree (today: 808 chars of flat text for 60 chars of label); `pointer-events: auto`; Escape dismisses without moving pointer or focus. Regression test on the surface with the most instances, per the Approvals precedent. |
| **Escape precedence** | Unchanged and extended by one: tooltip → selection → active lens. Written once, in `MapClient`, not claimed by four components. |
| **Motion** | Nothing animates. The meter changes value on a poll; it does not transition, so a poll can never move something under the pointer. `prefers-reduced-motion` already neutralises the tooltip fade and stays. |
| **Touch** | Every definition reachable without hover. A tap on a lens filters and does nothing else. |
| **Colour** | Zero text roles below 4.5:1 in this section (today: 2, worst **2.50:1**). |

---

## PART 9 — What this section must never become

Named with the page that would own it instead, because the ten-page ceiling is
held by refusing things.

| If it grows… | It belongs on |
|---|---|
| a spend breakdown, a sparkline, cost per accepted action, week-over-week | **`/fleet/cost`** — this cell shows one figure against one ceiling and stops |
| a findings triage list, severity breakdown, "resolve" or "extend expiry" | **`/fleet/workers`** (per worker) and the worker detail; the *decisions* are **`/fleet/approvals`** |
| a failure taxonomy, "3 provider-unreachable · 1 contract", run history | **`/fleet/activity`** — this section may say *N failed*, never *why* |
| "here is your morning", a to-do, a recommendation | **`/fleet/overview`** — narrative is theirs, census is ours |
| a switch, a pause, a halt, a *Run once* on the never-run worker | **`/fleet/controls`** and **`/fleet/workers`** — D3 is settled: the map never writes |
| a per-campaign or per-portfolio scope count | **`/fleet/assignments`** |
| a roster with dials and bulk actions | **`/fleet/workers`** |

And the section's own line: **a lens whose click cannot change what is drawn is
not a lens.** The first one that appears is the signal that a fact has been
dressed as a filter.

---

## PART 10 — Phases

Each is independently shippable, and each ends with a prod measurement, not a
build.

| | what | closes |
|---|---|---|
| **S1.a** | The band: three cells across the full width, the verdict sentence, the reserved summary row. | D1, D2, D9, D14, D19 |
| **S1.b** | The lenses: meter + labels, subject chip deleted, structural zeros become sentences, 1.4.11 state and boundary, `tabular-nums` min-width, `role="toolbar"`. | D3–D8, D20, D21 |
| **S1.c** | The tooltip: 1.4.13 Dismissible + Hoverable, out of the a11y tree when closed, `<Term>`'s splice removed from the spend sentence. | D15, D16, D17 |
| **S1.d** | "What each number counts" in the teaching drawer, generated from `DEFINITIONS`, plus the band's affordance into it. | D18, D23 |
| **S1.e** | Standing facts: spend precision and period, open findings + expired, the orphan footnote retired into the cell. | D11, D12, D13 |
| **S1.f** | Entity mode's band. | D22 |
| **S1.g** | The loading and degenerate states. | D10, Part 6 |

### Exit criteria — the numbers I will be held to

| | today | target |
|---|---|---|
| dead width in the band @1728 | 1063.0px (65.9%) | **≤ 5% of the card at 1280/1440/1728/1920** |
| band block, card top → canvas top | 164.0px | **≤ 96px** |
| chrome above the canvas | 308.8px (34.1%) | **≤ 240px** |
| canvas movement when a lens is pressed | 29.3px | **0** |
| text roles below 4.5:1 in the section | 2 (worst 2.50:1) | **0** |
| best pressed-vs-unpressed channel | 1.40:1 | **≥ 3:1**, plus a non-colour cue |
| control boundary | 1.28:1 | **≥ 3:1** |
| flat text of the band | 808 chars | **≤ 200** |
| tab stops in the section | 5 (→11) | **1** |
| counted assertions before the first read | 3 | **0** |
| controls that can only produce an empty graph | 1 | **0** |
| `lib.vitest.test.ts` | 10 passing | **10 passing** |

---

## PART 11 — What I did not verify, and one thing I got wrong

- **1280 and 1440 are element-width probes, not window resizes.** Chrome clamped
  `resize_window` to the display width (1728) and one attempt left the page at
  82% zoom, which I discarded. The probe is sound *for this section only*, and
  the reason is stated rather than assumed: `map.css` defines **no `@media` rule
  touching `.sbm-census*`** — the strip is width-independent flex. It is not
  sound for `.sbm-body`, which does have breakpoints at 1400 and 1100, and I
  make no claim about those.
- **The self-test's 47 expired findings** are read from the payload
  (`openExpired: 47`), not from the database. I have not re-derived the expiry.
- **The `#55616f` contrast figure in circulation is 6.02:1; I measure 5.83:1**
  against this page's background. Different backgrounds, both pass; I have used
  my own number and said why.
- Two JavaScript probes were refused by the browser tool's content filter
  ("Cookie/query string data") and were re-run in a different form. The eleven-
  chip width in D2 is therefore a **canvas text measurement against the shipped
  font and box model**, not a live DOM layout — stated because it is one of the
  load-bearing numbers in Part 4.

---

## Sources

Repo and prod evidence is cited inline. External:

- Carbon Design System — [status indicator pattern](https://v10.carbondesignsystem.com/patterns/status-indicator-pattern/) (symbol/shape/colour/type; "at least three of these elements"; highest-attention consolidation)
- Cloudscape — [empty states](https://cloudscape.design/patterns/general/empty-states/) (empty vs zero-results; "Always provide an action")
- Nielsen Norman Group — [tooltip guidelines](https://www.nngroup.com/articles/tooltip-guidelines/) (not for vital information; not available on touch; support mouse *and* keyboard)
- GOV.UK Design System — [Details](https://design-system.service.gov.uk/components/details/) ("Do not use the details component to hide information that the majority of your users will need")
- W3C — [WCAG 2.2 SC 1.4.13 Content on Hover or Focus](https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html) · [ARIA APG Toolbar pattern](https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/) ("3 or more controls")
- Datadog — [log explorer facets](https://docs.datadoghq.com/logs/explorer/facets/) (a count per value; clicking a value toggles the filter)
- Grafana — [Stat panel](https://grafana.com/docs/grafana/latest/panels-visualizations/visualizations/stat/) (single values; configurable "No value")
- Apache Airflow 3 — [UI](https://airflow.apache.org/docs/apache-airflow/stable/ui.html) (health first, then quick links to DAGs filtered by status)
- UiPath Orchestrator — [monitoring](https://docs.uipath.com/orchestrator/automation-cloud/latest/user-guide/monitoring-cloud-robots) (filter states by clicking the labels below the chart)
- Linear — [display options](https://linear.app/docs/display-options) (group header: icon, label, muted count, sticky)
- Microsoft — [Agent Registry in the M365 admin center](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-registry?view=o365-worldwide) (governance signals: pending approvals, ownership gaps, risks)
- Sentry — [issue states and triage](https://docs.sentry.io/product/issues/states-triage/) · Temporal [Web UI](https://docs.temporal.io/web-ui) · Honeycomb [query results](https://docs.honeycomb.io/investigate/query/) · Metabase [numbers](https://www.metabase.com/docs/latest/questions/visualizations/numbers)
