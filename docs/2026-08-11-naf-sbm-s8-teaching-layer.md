# NAF.SB.M-S8R — Section 8, the teaching layer: five wordings for one fact, and a paragraph that is the only evidence for its own claim

*The drawer, the definitions, the glossary terms, and the prose that teaches in
place.*

Code: `HowThisMapWorks.tsx`, `definitions.tsx`, the six `<Term>` call sites, and
the teaching prose in `CensusBand.tsx`, `OverlayRail.tsx`, `InspectorRail.tsx`,
`ListView.tsx` and `MapClient.tsx`.

Measured on production 2026-08-11.

**Status: study only. No code has been written.**

---

## PART 0 — Phase 0: the instrument, and the inherited raise

### 0.0 · The instrument is DEGRADED this session, and I am saying so up front

```
document.visibilityState   "hidden"
document.hasFocus()        false
requestAnimationFrame      fired 0 of 2
```

The Chrome window is minimised or occluded and I could not foreground it — a new
tab reported `hidden` too. **So no timing-dependent claim appears in this
study.** Layout still computes in a hidden tab, so every geometry number below
is valid and was taken with `getBoundingClientRect`; what is unavailable is
anything depending on rAF, transitions, or the visibility-gated poll.

Section 6 lost a raise to exactly this and Section 7 nearly lost two. Stating
the instrument's state is cheaper than retracting a finding.

### 0.1 · The inherited `.sbm-fact` raise — **it survives, and it constrains this section**

Section 7 recorded that `.sbm-fact` is `text-overflow: clip` with
`overflow: visible`, so a card fact that outgrows its card paints past the edge.
Re-measured: still true, and S7.c's `— no runs` currently leaves **18px** of
slack on the tightest card (`Fleet self-test analyst`).

**This constrains Section 8 directly.** Any teaching that lengthens a card fact
has ≤18px to spend before it reproduces S7.c's defect. **The design below adds
no text to a card**, for that reason and no other.

### 0.2 · The glossary count — **45, hand-counted, and the brief was right to warn**

Three regexes gave three answers (39, 45, 0). The reliable count agrees three
ways:

```
lines matching `^    title: `   45
lines matching `^    body: `    45
top-level keys before `{`       45
```

My first pass said 39 because it missed six quoted, hyphenated keys —
`preview-only`, `blast-radius`, `shadow-agreement`, `risk-tier`, `undo-window`,
`trust-ladder`. **Do not count this file with a naive regex.**

---

## PART 1 — The vocabulary inventory

What the page shows an operator, and whether it is defined, once, reachably.

| word / phrase | where shown | defined? | reachable by keyboard? | defined **once**? |
|---|---|---|---|---|
| worker, director, critic, finding, plan, handoff | drawer, rail | ✅ glossary via `<Term>` | ✅ | ✅ |
| **carried** | edge label, drawer | `DEFINITIONS.carried` exists — **no reader** | ❌ | prose in drawer only |
| **dropped** | edge panel, drawer | `DEFINITIONS.dropped` exists — **no reader** | ❌ | prose in drawer only |
| **no count** (critic edge) | edge label | `DEFINITIONS['no-count']` — **no reader** | ❌ | prose in drawer only |
| **spend** | card, list, rail | `DEFINITIONS.spend` — **no reader** | ❌ | — |
| **no runs / nothing to measure** | card, list, legend, drawer | `DEFINITIONS['no-runs']` — **no reader** | ❌ | ❌ **five wordings** |
| spent today, open findings | band | ✅ `Def` | ✅ | ✅ |
| the eleven census chips | band | ✅ `Def`, derived from `CHIPS` | ✅ | ✅ |
| **lane** ("Runs as part of the nightly job") | canvas container | ❌ nowhere | ❌ | — |
| **window / denominator** | header, S7 sentence | S7.d sentence only | ✅ (real text) | ✅ |
| **held at off, never run, stale, self-test** | cards, band, list | glossary has `staleness`, `selftest`; the others are self-describing | partial | ✅ |
| **may look / may propose / may act** | overlay rail | ✅ legend prose | ✅ | ✅ |

### 1.1 · Five of eight hand-written definitions have no reader

`definitions.tsx` opens with *"ONE SOURCE… Everything is keyed here; the surfaces
look it up."* Grepped every key against the whole `fleet/` tree, excluding the
file itself:

| key | readers |
|---|---|
| `spend-today` | 2 |
| `findings-open` | 3 |
| **`carried`** | **0** |
| **`dropped`** | **0** |
| **`no-count`** | **0** |
| **`spend`** | **0** |
| **`no-runs`** | **0** |

This is the stale-constant class the fleet has hit before, inverted: not a
surface reading a constant nobody writes, but **a constant nobody reads.** The
file's own rule is true of three keys and aspirational for five.

### 1.2 · And the worst of them is the sentence the page needed

`DEFINITIONS['no-runs']` reads *"It did not run in this window, so there is
nothing to measure — which is not the same as being cheap."* That is precisely
the fact S7.c had to express on the card. It was not used. Instead the concept
now exists in **five** wordings:

| surface | wording |
|---|---|
| overlay legend | *"Nothing to measure — It did not run in this window, so it has no cost here — which is not the same as being cheap."* |
| `DEFINITIONS['no-runs']` (unread) | *"…so there is nothing to measure — which is not the same as being cheap."* |
| card (S7.c) | `— no runs` |
| list | `no runs in this window` |
| drawer | *"the map says nothing to measure and marks it with a hatch"* |

The legend's and the definition's sentences differ by four words in the middle
and are otherwise identical — which is what two people writing the same sentence
twice looks like. **The page's own law is that a legend and the thing it
explains render from one source.** For this fact, there are five.

---

## PART 2 — The drawer, sentence by sentence

926 words, six headings. Marked against the live page.

| claim | verdict |
|---|---|
| "a picture of your workers… a view of things as they are" | ✅ true |
| "The coloured bar down its left side answers whichever question you picked in **Colour by**" | ✅ true |
| "a small shape and a word — *Off*, *Working*, *Needs attention*" | ⚠ **unverifiable by the reader** — every worker on this fleet is `Off`; the other two words never render |
| "A card with a dashed outline reading *not yet run* has never run" | ✅ true (`Fleet auditor`) |
| "The label counts what was actually **carried**" | ✅ true |
| "A faint dashed line means nothing has ever crossed it" | ✅ **true as of S7.a** — and it was *false* for the plan edge until yesterday |
| "The last line, into the critic, has no count… shows the verdict" | ✅ true |
| "**Map** and **List** show the same workers two ways" | ⚠ **stale** — true of worker mode; entity mode's switch is **Table / Graph** and defaults to Table (S6.d), which the drawer never mentions |
| "What this page cannot do… nothing changes anything" | ✅ true |
| "What each number counts" (generated from `CHIPS`) | ✅ true, **and the only part that cannot go stale** |
| "**Waiting for you is always zero**… tools are preview-only" | ✅ **re-measured true** — `approvals.waiting` is 0 at all four windows, and the band says the same |
| "**Spend can read $0.0000 while a worker has clearly run**… the map says *nothing to measure* and marks it with a hatch" | ❌ **FALSE** — see §2.1 |

### 2.1 · The false paragraph, and the measurement that settles it

Swept every leaf node on the page for a four-decimal currency string:

```
$0.0000  ×1   →  inside the drawer's own sentence claiming $0.0000 appears
```

**The only `$0.0000` on the page is the drawer saying there is one.** The card
renders money at 2dp (S2R deliberately, to match the band: `$0.11 spent`), and
since S7.c a worker that did not run in the window renders `— no runs`, not a
zero. The list renders 4dp but shows `no runs in this window` for the same case.

The rest of the paragraph misattributes a real thing. There *is* a hatch —
`ov-nodata` — but it is the **cost overlay's** no-data bucket, and it appears on
a card only when *"What it cost"* is selected. Under the default overlay the
only hatched elements on screen are two legend swatches. So the sentence
explains the card's spend slot using the legend's device for a different
question.

Three errors in one paragraph: the format, the surface, and the case.

### 2.2 · The drawer never mentions what Sections 6 and 7 added

Grepped the rendered drawer text: `denominator` **absent**; `table` **absent**.
The window is mentioned once, incidentally, inside the false paragraph. So the
page's newest and least intuitive rules — four denominators, "ever" versus "in
this window", entity mode opening on a table — have no presence in the surface
whose job is to explain the page.

### 2.3 · Opening the drawer hides the thing it explains

The file's own comment says:

> *"It sits above the map rather than over it, so opening it never hides the
> thing it is explaining."*

Measured at 1728×906, `scrollTop: 0`:

| | band `top` |
|---|---|
| drawer closed | **196px** |
| drawer open | **1453px** |

926 words push the band 1257px down and the canvas entirely out of the viewport.
The comment is true of the *technique* and false of the *result*.

---

## PART 3 — The definitions' own geometry

Two defects, both measured, both invisible to a probe that reads text.

### 3.1 · The two right-most definitions are cut off the window

`.sbm-def-tip` is 288px, `position: absolute`, `left: 0` — it opens down and to
the **right** of its trigger, whatever is to the right.

| trigger | tip right edge | viewport | off-screen |
|---|---|---|---|
| `SPENT TODAY` | 1741 | 1728 | **13px** |
| **`OPEN FINDINGS`** | **1850** | 1728 | **122px** |
| `7 switched off` | 391 | 1728 | — |
| `1 never run, ever` | 577 | 1728 | — |

`OPEN FINDINGS` loses **42% of its definition** off the right edge of the
window. The definition is this section's entire deliverable.

### 3.2 · And the closed tooltips are the page's horizontal scrollbar

Proved with a control rather than inferred — `display: none` on the closed tips,
then restore:

```
before            scrollWidth 1784   clientWidth 1662   overflow 122
tips display:none scrollWidth 1662   clientWidth 1662   overflow   0
restored          scrollWidth 1784                      overflow 122
```

**The hidden tooltips are the entire cause.** This is the cost of a *correct*
accessibility decision: S1R chose `visibility: hidden` over `display: none` so
the tip stays out of browse mode while remaining reachable through
`aria-describedby`. `visibility: hidden` keeps the box in layout, and an
absolutely-positioned box still contributes to an ancestor scroller's overflow.
Nobody measured that, and the page has scrolled sideways ever since.

---

## PART 4 — What the best tools do

**NN/g — a tooltip may never be the only home.** *"Important information should
always be on the page; therefore, tooltips shouldn't be essential for the tasks
users need to accomplish on your site. Users should never need to find a tooltip
in order to complete their task."* This page already obeys it: S1R put every
census definition into the drawer as real text and demoted the tooltip to an
accelerator. **That decision is the one piece of this layer that has aged well,
and §5 generalises it rather than replacing it.**

It also sets a limit on the operator's *"tooltips everywhere"*: everywhere as an
accelerator, nowhere as the sole carrier.

**WCAG — a glossary is a named technique, and the bar is "a mechanism".** SC
3.1.3 (Unusual Words, AAA) asks for *a mechanism for identifying specific
definitions of words or phrases used in an unusual or restricted way, including
idioms and jargon*; technique **G62** is literally "Providing a glossary". So
`<Term>` + `GLOSSARY` is the sanctioned shape, and the obligation is coverage
and reachability, not decoration.

**Carroll's minimalism — four principles, and the third is the one this page
keeps forgetting.** *Choose an action-oriented approach · anchor the tool in the
task domain · **support error recognition and recovery** · support reading to
do, study and locate.* The drawer's most valuable content by this standard is
"Two numbers that surprise people" — teaching the reader to recognise a state
they would otherwise misread. That is exactly the section that went stale.
Minimalism also argues the drawer is too long: learners given *procedurally
incomplete* materials performed better in less time than those given complete
ones.

**Docs-as-tests — the drift is a testable property.** Manny Silva's *Docs as
Tests* names the discipline: *"a tool-agnostic strategy for keeping docs and
their products in sync by using doc content as product tests"*, treating a
reader's bug report as a failed test. The generalisable half is cheap: **assert
the strings your prose quotes still exist in the code that renders them.**

**Sources:**
[NN/g tooltip guidelines](https://www.nngroup.com/articles/tooltip-guidelines/) ·
[W3C Understanding SC 3.1.3](https://www.w3.org/WAI/WCAG21/Understanding/unusual-words.html) ·
[W3C technique G62 — providing a glossary](https://www.w3.org/WAI/WCAG21/Techniques/general/G62) ·
[Carroll, *The Minimal Manual*](http://swcarpentry.github.io/swc-releases/2017.02/instructor-training/files/papers/carroll-minimal-manual-1987.pdf) ·
[Docs as Tests](https://podcasts.apple.com/us/podcast/docs-as-tests-keeping-documentation-resilient-to-product/id1093182479?i=1000716618704)

---

## PART 5 — The design

### D-S8.1 · One sentence per fact, and the fact owns it

`DEFINITIONS` becomes true rather than aspirational: **every key has a reader, or
it goes.** Specifically, `no-runs` becomes the single source for the
did-not-run-in-window sentence, and the legend, the list and the drawer render
it instead of restating it — collapsing five wordings to one.

The card is the exception and stays `— no runs`: it has 18px (§0.1) and a fact
slot is not a place for a sentence. It is a *label* whose definition lives
elsewhere, which is exactly NN/g's split.

### D-S8.2 · Delete the false paragraph; do not rewrite it

The spend paragraph is wrong in three ways and the thing it was trying to teach
is already taught correctly, twice — by the overlay legend (*"Nothing to
measure…"*) and by S7.d's denominator sentence. **A fourth telling is what
created the drift.** It goes.

What survives from it is the *idea* Carroll would keep — that a reader will
misread a zero — and that belongs where the zero is, not in a drawer.

### D-S8.3 · The drawer teaches the page as it is now

- "The two views" gains entity mode's **Table / Graph** and says why the table
  opens first (38 nodes, above the threshold where a matrix beats a diagram).
- A short "What the window covers" replaces the deleted paragraph, pointing at
  the four denominators in operator words — *in this window · ever · today ·
  open right now* — because S7 made that the page's least intuitive rule and it
  has no home in the drawer at all.
- "Off / Working / Needs attention" gains a clause admitting the fleet is
  currently all-`Off`, so a reader is not hunting for words that cannot appear.

### D-S8.4 · The drawer gets shorter, which is also the fix for §2.3

Cutting the false paragraph and the duplicated census prose takes the drawer
well under its 926 words. **This is a wording change, not a layout change** — it
reduces the 1257px push without touching the collapsible's placement. If it
still pushes the canvas out of view at the end, that is a layout finding to
raise, not to absorb.

### D-S8.5 · The tooltip stops falling off the right edge

Two changes to `.sbm-def-tip`, both in `map.css`:

- **Flip near the right edge.** A trigger in the right-hand third anchors the
  tip to its right edge instead of its left. 122px of `OPEN FINDINGS` comes back.
- **Take the closed tip out of layout.** The accessible description survives:
  `aria-describedby` computes its text from the referenced node whether or not
  that node is displayed, so nothing about S1R's reason is lost — only the 122px
  of phantom page width.

**Raised inside this design, because it is the same class of mistake as the one
being fixed:** I have not verified how `display: none` behaves for
`aria-describedby` across the actual screen readers this operator uses. If a
build phase cannot verify it, the fallback is to keep `visibility: hidden` and
clamp the tip's position instead, which fixes the overflow without touching the
accessibility contract at all. **The fallback is the safer default and the
build order takes it first.**

### D-S8.6 · Keeping it honest — the mechanism, and what it costs

The drawer went stale in three days. A design that does not answer this is a
design that will be re-audited in Section 9.

**What already works:** "What each number counts" is generated from `CHIPS` and
is the only part of the drawer that is still true. Generation beats prose.

**What is proposed, cheapest first:**

1. **A dead-definition test.** Assert every `DEFINITIONS` key is referenced
   outside `definitions.tsx`. Catches all five of §1.1 today, and catches the
   next one the day it is written. ~15 lines of vitest, no runtime cost.
2. **A quoted-string test.** The drawer quotes UI strings — *"not yet run"*,
   *"no runs"*, *"Table"*, *"Graph"*. Assert each still appears in the component
   that renders it. This is the cheap half of docs-as-tests and it is exactly
   what would have caught *"$0.0000"* the day S7.c shipped. ~20 lines.
3. **A section checklist condition**, free: no section is done until the drawer
   has been read against it. Sections 2–7 each changed the page and none did.

Cost: about 35 lines of test and one line in a checklist. Nothing at runtime.
**Option 2 is the one that pays**, because the failure mode is always the same —
prose quoting a string the code stopped rendering.

### D-S8.7 · Glossary: mint nothing, wire what exists

The page shows six glossary terms of 45. The obvious gaps — `carried`,
`dropped`, "no count" — **already have definitions in `definitions.tsx` with no
reader.** Minting glossary entries for them would add a sixth wording to a
section whose defect is five.

So: **wire `carried` / `dropped` / `no-count` to the edge inspector via `Def`,
and add no glossary term at all.** `lane` is the one genuine gap; it is one word
on one container and D-S8.3's drawer sentence covers it more cheaply than a term
in the repo's most contended file.

*"Suspect propagation before invention"* — the habit the brief names, applied to
the file most likely to conflict.

---

## PART 6 — Two options, and the recommendation

### Option A — repair, unify, and test *(recommended)*

D-S8.1 through D-S8.7. The drawer survives, shorter and true; five wordings
become one; the tooltip stops falling off the screen; two small tests make the
next drift fail a push instead of a reader.

**Why.** Every defect found is a defect of *upkeep*, not of shape. The drawer's
architecture is sound — it was right about tooltips before NN/g was consulted,
and its generated section is the only part that survived seven sections. Nothing
in the measurement argues for replacing it; the measurement argues that nobody
maintained it.

**Against.** It keeps a 900-word surface that a reader must choose to open, and
the honest reading of Carroll is that the best version of it is shorter still
than D-S8.4 will make it.

### Option B — dissolve the drawer; teach entirely in place

Delete `HowThisMapWorks`. Move "reading a card" beside the cards, "reading a
line" into the edge inspector, the numbers into the band where `Def` already is,
and let S7.d's sentence carry the denominators.

**Why not.** Three reasons, in order.

1. **The orientation paragraph has no home.** *"This is a picture of your
   workers… to change them, go to Workflows"* is about the page's place in the
   product, and there is no element to attach it to.
2. **It trades one stale surface for six.** Distributed prose is not
   self-maintaining; it is the same drift with more sites, and §1.2 shows this
   page already loses that game — the five wordings are distributed teaching.
3. **It costs layout.** Prose beside the cards and inside the rail is exactly the
   change this section is forbidden to make.

**Recommendation: Option A.**

---

## PART 7 — Honesty rules · empty states · backend · accessibility

- **A teaching surface may not be the only evidence for its own claim.** The
  `$0.0000` paragraph is the rule's origin: the string existed nowhere but in
  the sentence asserting it.
- **Never `title=`.** Unchanged, and `Def` is the replacement.
- **A tooltip is an accelerator, never the sole carrier** (NN/g). Everything a
  `Def` says must also exist as real text.
- **Teach the state the reader can see.** Where the fleet cannot currently
  produce a state — `Working`, `Needs attention`, an armed autonomy rung — the
  prose says so rather than describing an invisible thing as if present.
- **Degenerate: an all-`Off` fleet** is the current state and the drawer is
  written for a busy one. D-S8.3 fixes the one sentence where that matters.
- **Backend: none.** No route, no field, no migration. This section is prose,
  CSS and two tests.
- **Accessibility:** definitions stay keyboard-reachable and
  `aria-describedby`-associated; Escape still dismisses; the hoverable bridge
  stays. The only accessibility-adjacent change is D-S8.5's, and it carries its
  own fallback for exactly that reason.

---

## PART 8 — What this section must never become

- **Not a tour.** No spotlight, no coach marks, no "next" button. The house
  pattern is a collapsible and the operator reads, not clicks through.
- **Not a second glossary.** 45 terms exist; this page adds none.
- **Not prose on the canvas.** `<Term>`'s tooltip is clipped by every canvas
  wrapper — the rule from Section 2 stands.
- **Not longer.** Every future section that adds a paragraph here should first
  ask what it can delete or generate.
- **Not a layout change.** If teaching needs one, it is raised.

---

## PART 9 — Build order

| phase | change | exit criterion |
|---|---|---|
| **S8.a** | tooltip stops leaving the viewport (D-S8.5, clamp first) | `OPEN FINDINGS` tip fully on screen; page horizontal overflow **0** |
| **S8.b** | delete the false spend paragraph (D-S8.2) | no `$0.0000` anywhere on the page |
| **S8.c** | drawer teaches the two modes and the window (D-S8.3) | `Table`, `Graph`, and the four denominators present and true |
| **S8.d** | `no-runs` becomes one source (D-S8.1) | legend and list render the same sentence from one key |
| **S8.e** | wire `carried` / `dropped` / `no-count` (D-S8.7) | 0 `DEFINITIONS` keys without a reader |
| **S8.f** | the two tests (D-S8.6) | both fail against today's `main`, pass after S8.b–S8.e |

`S8.a` first: it is the only defect that makes the teaching physically
unreadable, and it is the one a reader hits without opening anything.

**S8.f deliberately last, and it must be seen to fail first.** A test written
after the fix that has never failed is a test nobody knows works.

---

*Measurements: production, 2026-08-11, 1728×906. Instrument degraded (hidden
tab) — geometry only, no timing claims. Glossary hand-counted at 45.*
