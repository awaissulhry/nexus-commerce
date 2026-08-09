# NAF.SB.M-S2R — Section 2, the canvas and the header: a measured audit and a rebuild

**Status: APPROVED by the operator 2026-08-09 (Option A; the rail claim granted
and then NOT needed). Pass 1 SHIPPED AND PROD-VERIFIED; pass 2 partly shipped.
See PART 13 for the execution record, the one finding that explains half this
document, and the one fix that was reverted.**

| | |
|---|---|
| **Page** | `/fleet/map` — the Operate group, page 4 of ten |
| **Section** | §M2 the canvas, plus the page header that frames it |
| **Parent** | `docs/2026-08-07-naf-sbm-fleet-map-page.md` §M2 · Section 1: `docs/2026-08-08-naf-sbm-s1-census-strip.md` |
| **Lock** | `docs/2026-08-07-naf-sb-session-locks.md` §2, row **Fleet map (`SB.M`)** |
| **In scope** | `MapCanvas.tsx` · `EntityCanvas.tsx` · the `<header className="sbm-head">` block of `MapClient.tsx` · `.sbm-node*`, `.sbm-lane*`, `.sbm-edge*`, `.sbm-glyph*`, `.sbm-canvas*`, `.sbm-head*`, `.sbm-seg*`, `.sbm-ent*` in `map.css` |
| **Out of scope** | the census band (S1, shipped) · the overlay rail and legend · the inspector rail · the teaching drawer |
| **Shared files** | **none claimed.** `fleet-pages.css` untouched, `glossary.tsx` gains no term |
| **Backend** | **none.** Every figure is already in the `GET /agent/fleet/map` payload |
| **⚠ Raises** | **one change this section cannot make itself** — see Part 9 |

Measured on the deployed build at **1728×906** on 2026-08-09. Every defect carries
a number or a quotation.

---

## PART 0 — What this section is for

> **The canvas is the page.** It must make the fleet's shape and state legible at
> a glance and traceable by hand: what feeds what, who may act, who is failing —
> and it must read as an *instrument*, not as a picture of a whiteboard.

Section 1 established the page's design language, and the canvas has to belong to
it: a **verdict that leads**, **rank carried by three different devices** rather
than three shades of one, **one class driving both a swatch and the thing it
labels** so a legend can never become a second source, and **reserved space so
nothing moves**. Today the band above the canvas obeys all four and the canvas
obeys none of them.

The single most damning measurement in this audit is not a colour. It is that
**the canvas does not reliably frame its own contents**, and the one worker the
whole furniture lane exists to reveal is below the fold on every load.

---

## PART 1 — What is wrong today, measured

Twenty-one defects. The first five are one connected failure and are the reason
to do this section at all.

### 1.1 · The canvas does not frame itself, and the fix that was written for that does not run

**⚠ C1 — the fit is a coin toss.** Same URL, same viewport, four loads:

| load | `.react-flow__viewport` transform |
|---|---|
| 1st this session | `matrix(0.981873, 0, 0, 0.981873, 78.08, 45)` — fitted |
| 2nd, 3rd, 4th | `matrix(1, 0, 0, 1, 0, 0)` — **the identity matrix** |

On the identity loads `fitView` never ran at all: I sampled the transform every
100 ms for 4 s after load and it never left `1 @ 0,0`. This is the Workflows
stream's finding in a second place — they measured `fleet-council` at *zoom
0.455 on one load and 1.0 on three others at the same URL and viewport*.

**⚠ C2 — the ResizeObserver refit, written specifically to cure C1, does not
fire.** `MapCanvas.tsx:417-435` observes the wrapper and refits on resize. I
drove the container through 1034 → 620 → 1200 → 1034 px with 1.2 s to settle at
each step:

```
start         : zoom 1 @ 0,0    canvasW 1034
after 620px   : zoom 1 @ 0,0    canvasW 620
after 1200px  : zoom 1 @ 0,0    canvasW 1200
restored      : zoom 1 @ 0,0    canvasW 1034
```

The box changed four times by up to 580 px and the viewport never moved.

**⚠ C3 — `fleet-auditor` is below the fold**, at y 866.5–945, on a 906 px
viewport. That is precisely the node the standalone lane exists to reveal, and
`MapCanvas.tsx:405-416` says so in its own words: *"`Fleet auditor` is exactly
the node that lane exists to make visible, so a fit that clips it defeats the
section."* It is clipped on every load I measured.

**⚠ C4 — and the root cause is not `fitView` at all.** `.sbm-page` is
`box-sizing: border-box; min-height: 906px` — and renders **1078.4 px, 172.4 px
taller than the viewport**. A `min-height` gives the flex column no *definite*
height to distribute, so `.sbm-body`'s `flex: 1 1 auto` resolves against content
and its `min-height: 0` has nothing to shrink into. The canvas therefore ends at
**y 1025.9 — 119.9 px past the fold**. Fitting a graph into a box that is itself
off-screen cannot put anything on screen.

**⚠ C5 — the zoom controls are entirely below the fold**, at y 931.9–1009.9.
`Zoom In | Zoom Out | Fit View` — the only escape from C1 — is unreachable
without scrolling, and nothing on the page suggests scrolling.

**C6 — nothing indicates off-screen content, in either mode.** Workers: no
marker. Entity mode: **23 of 38 nodes sit outside the canvas box** and the page
says nothing.

### 1.2 · The node card

**⚠ C7 — four AA failures, and the worst is on the most informative string.**

| role | size | colour | contrast | |
|---|---|---|---|---|
| `.sbm-fact.muted` — *"not yet run"* | 10.5px | `#9aa5b3` | **2.47:1** | ✗ |
| `.sbm-node-tier` — *analyst / director / critic* | 10px | `#9aa5b3` | **2.50:1** | ✗ |
| `.sbm-lane-note` | 10.5px | `#8a95a3` | **2.96:1** | ✗ |
| `.sbm-tag-diag` — *SELF-TEST* | 9.5px | `#7d879a` | **3.28:1** | ✗ |
| `.sbm-node-name` | 12.5px | `#1c2530` | 15.48:1 | ✓ |
| `.sbm-node-word` | 11px | `#4a5666` | 7.46:1 | ✓ |

*"Not yet run"* is the single most useful thing this canvas can say about a
worker, and it is set in the lowest-contrast type on the page.

**⚠ C8 — the second channel is not perceivable.** `MapCanvas.tsx`'s rule 2 says
*"Every status is a ring AND a glyph AND the literal word."* The glyph measures
**8.8 × 8.8 px** and its resting fill is `#b9c2ce` — **1.8:1 against the card**.
WCAG 1.4.11 asks 3:1 of any non-text thing carrying information. The redundancy
the design depends on is present in the DOM and not in the eye.

**C9 — the card boundary is `#dde4ec` = 1.28:1**, the exact value Section 1
measured on the census chip and fixed.

**⚠ C10 — there is no hover state anywhere on the canvas.** I enumerated every
rule in every stylesheet matching `sbm-node|sbm-edge|sbm-ent` together with
`hover|focus`. The only hit is `.sbm-ent.is-focused` — a class, not a
pseudo-class. On a surface where every card and every line is clickable,
`cursor: pointer` is the entire affordance.

**C11 — every card is 247.4 × 78.5 px** regardless of tier, and the facts row is
an undifferentiated run of 10.5 px grey: `3 runs  5 open  $0.1090`.

**C12 — money is at two precisions on one page.** The cards say `$0.1090`,
`$0.3867`, `$0.0227`; the band Section 1 shipped one row above says
`$0.00 of $2.00`.

**⚠ C13 — dimming does not dim, it deletes.** At `opacity: 0.28`:

| | undimmed | dimmed |
|---|---|---|
| name | 15.48:1 | **1.78:1** |
| status word | 7.46:1 | 1.55:1 |
| facts | 4.77:1 | 1.42:1 |
| tier | 2.50:1 | 1.25:1 |

The page's own law is *filtering dims; it never removes*. In the DOM that holds.
At 1.78:1 the name of the worker is not readable, so in the eye it does not.

### 1.3 · Focus

**⚠ C14 — a keyboard-focused node has no visible focus indicator at all.**
Measured with a real Tab keypress: `:focus-visible` matches, and
`outline-style: none`, `box-shadow: none`, inner card shadow unchanged.

The root cause is citable and is not ours. xyflow's own stylesheet ships:

```css
.react-flow__node.selectable:focus,
.react-flow__node.selectable:focus-visible { outline: none; }
```

and replaces it with a `box-shadow` rule scoped to `.react-flow__node-input`,
`-default`, `-output` and `-group`. Our node type is `worker`, so we inherit the
removal and none of the replacement. That is WCAG **F78** — *"styling element
outlines and borders in a way that removes or renders non-visible the visual
focus indicator"* — failing **SC 2.4.7 Focus Visible, Level AA**, on the page's
primary interaction surface, and it silently undoes the keyboard traversal
`MapCanvas.tsx:239-287` was written to provide.

### 1.4 · The edges

**⚠ C15 — three converging labels read as a list, not as labels.** The three
analyst→director edges bundle, and their labels stack at the same x:

```
"4 carried"  x 656.9  y 447.6
"4 carried"  x 656.9  y 504.6
"7 carried"  x 657.3  y 561.5
```

Three chips in a 114 px column at one x, **two of them reading the same words**,
attached to lines that converge within a few pixels of each other. The comment at
`MapCanvas.tsx:359-369` records that the label was already shortened once because
`4 carried · 1 dropped` "collided with its neighbour and truncated mid-word on
prod" — the shortening treated the symptom.

**C16 — edge stroke `#7f9dc0` on `#fbfcfe` = 2.73:1**, under 1.4.11's 3:1, at
1.4 px wide.

**C17 — an edge announces nothing.** `interactionWidth: 22` gives a 22 px hit
target with no hover thickening, no cursor change and no hover colour — a
generous target the reader has no way to know exists.

**C18 — the dashed *never-carried* treatment is not exercised on prod.** All four
edges are currently `has-crossed`, so I could not verify that dashed reads at
100% zoom. Stated rather than assumed.

### 1.5 · Entity mode

**⚠ C19 — all 38 cards carry a native `title` attribute** (`EntityCanvas.tsx:139`).
This page's own `definitions.tsx` header calls the native tooltip *"the exact
mistake this study criticised the entity legend for: a `title` is unreachable by
keyboard, is not announced reliably by screen readers, and never appears on
touch."* At the tiny zoom tier the card renders a dot and no text, so the `title`
is the **only** way to identify it.

**C20 — labels truncate and wrap** inside the 210 px card:
`Exact_Gale_SV_LessThan_1k_Ke…`, and `IT-AIREON-SP-Category-Phrase` wraps to two
lines while its neighbours do not.

**C21 — the zoom controls do *not* overlap a card**, contrary to the lead I was
given: measured 0 overlaps at 1728. They sit at x 334, y 759.5, about 20 px above
a row of cards clipped by the canvas edge. Recorded because a lead that does not
reproduce is worth as much as one that does.

### 1.6 · The header

**H1 — the two AA failures Section 1 handed over**, unchanged: `.sbm-sub`
**4.41:1** and `.sbm-asof` **2.81:1**.

**⚠ H2 — the selected state of a segmented switch is invisible to the standard.**
Measured on the mode switch:

| channel | unselected → selected | |
|---|---|---|
| fill | `#ffffff` → `#eef4fb` | **1.11:1** |
| text | `#5a6675` → `#1f4f8b` | **1.41:1** |
| container border | `#d7dee7` on `#f4f6f9` | **1.25:1** |

This is the identical 1.4.11 defect Section 1 measured on the census chip and
fixed — living on the two most consequential controls on the page.

**⚠ H3 — the two switches are the same device for different orders of thing.**
*What to show* (181.1 px) changes **which universe of nodes the page is about**.
*Time window* (251.7 px) changes **the denominator of every number on the page**.
They are pixel-identical and sit 10 px apart.

**H4 — 317.4 px of the header row is empty** between the left block and the right
block — 19.7% of 1614 px. Better than the census strip's 65.9%, and the same
shape of problem.

**H5 — the right side is five things in a row** — mode switch, window switch,
as-of, Refresh, and 48 px reserved for the app shell's notification bell — with
no grouping to say which of them change what.

### 1.7 · What is already right, and must survive

Stated so the list above is read as an audit and not a verdict.

- **Layout really is a function of topology alone.** Positions are memoised on a
  topology hash; a poll repaints and never rearranges. Verified in S1: node x
  stayed at 397.1 across a filter press.
- **Selection preserves the status ring.** I predicted `border-color` on
  `.is-selected` would overwrite `border-left-color` and measured that it does
  not — the tone rule wins on order. A defect I nearly recorded and did not.
- **The screen-reader wiring is real and good**: a 1×1 absolutely-positioned
  `sr-only` span per card carrying *"Bid tuner. analyst. Off. 3 runs. 5 open
  findings. Starts the chain. Feeds Amazon Ads director."* — with a written
  reason for not using xyflow's `ariaLabel`, which prod confirms is ignored.
- **Lane headers are correctly not tab stops** (`focusable: false`, tabindex −1).
- **`prefers-reduced-motion` is handled** for `.sbm-node`, the edge paths and the
  skeleton.
- Card name 15.48:1, status word 7.46:1, lane title 5.69:1 all pass AA.

---

## PART 2 — What the best operational canvases do

The question: **what makes a node-link diagram read as an instrument rather than
a diagram?**

### 2.1 · What goes on a node, and what waits for selection

Grafana's Node Graph is the most explicit: a node carries a **main stat** ("shown
inside the node itself"), a **secondary stat** ("shown under it"), a title, a
subtitle, and optional **arcs** — a fixed, small, identical set for every node.
Kiali decorates nodes with shape for type and colour for health, and pushes
everything else to the side panel — including, explicitly, measurements it cannot
place legibly: *"response time information is not available on edges leading into
or out of operation nodes. But by selecting the edge the response time
information is available in the side panel."*

**Consequence for us:** the card should carry the *same three facts for every
worker*, ranked, so a column of cards is scannable — and anything that will not
fit legibly belongs in the inspector rail, which this page already has.

### 2.2 · Status at a small size

Carbon's status-indicator pattern (cited in full in the S1 study) is built from
symbol, shape, colour and type, and requires **at least three of the four** for
WCAG compliance. Kiali uses shape for node type and colour for health. Grafana
uses arcs — a *ring*, not a fill — because a ring survives at small sizes where a
fill of the same area does not.

**Consequence:** our glyph already has shape + colour + an adjacent word. Its
failure is purely that at 8.8 px and 1.8:1 the *shape* is not resolvable and the
*colour* is not perceivable. It needs size and contrast, not a fourth channel.

### 2.3 · Converging edges and their labels

The graph-drawing literature is blunt: edge-label placement is **NP-hard**, and
the goal is "making the association between edges and their corresponding labels
unambiguous". Practical consoles therefore avoid the general problem rather than
solve it — Kiali moves the number to the panel on selection; Grafana shows edge
stats **on hover** rather than persistently.

**Consequence:** with three edges converging on one node, a midpoint label cannot
be made unambiguous by shortening it. Either anchor each label to the end where
its edges have not yet converged, or take it off the canvas.

### 2.4 · How an edge announces it is selectable

Universally: a hover state that thickens or brightens the line, plus a cursor.
Grafana and Kiali both reveal edge detail on hover before selection. A wide
invisible hit target with no hover feedback is the one pattern nobody ships.

### 2.5 · Grouping

Airflow's Graph view uses **TaskGroups** — real collapsible containers with a
border and a header, not captions floating near their members. Grafana offers a
**Grid layout** "to provide a better overview" when the edges stop earning their
place.

**Consequence:** our lane header is a 640 px dashed top-border with two lines of
text above a row of cards it does not contain. It should be a container.

### 2.6 · Canvas chrome, zoom and off-screen content

The zoom-UI convention is settled: **plain scroll pans, Ctrl/⌘+scroll zooms** —
*"By convention, we use the control key to identify a zoom"*, and on a Mac
trackpad a pinch arrives as a wheel event with `ctrlKey: true`, so pinch works for
free. Grafana matches this (mouse wheel with Ctrl/Cmd).

On off-screen content, Grafana is the model: past its node limit it "shows a
warning at the top of the panel" and draws **clickable markers with an
approximate count of hidden nodes**. The minimap literature puts the threshold
plainly — a minimap earns its place "when content becomes larger than the browser
window and panning and zooming are needed to navigate". At seven nodes it does
not; at 38 with 23 off-screen it does, or an indicator does.

### 2.7 · Background

Dots are the canvas convention (Figma, Miro, xyflow's default) and they say *this
surface is pannable*. That is a real message on a surface that pans. The failure
mode is contrast: a dot grid that competes with 10 px type is texture, not
affordance.

### 2.8 · First paint

Nobody good shows a spinner where the empty state is the product. The Cloudscape
rule from S1 applies unchanged: **empty** (nothing exists), **no match** (your
filter), and — ours — **not yet read**, which must not look like either.

---

## PART 3 — The design, with the reason under each decision

### D-S2.1 · Fix the page box first; everything else in 1.1 follows from it

`.sbm-page` becomes a **definite** height (`height: 100dvh`) rather than
`min-height`, so `.sbm-body`'s `min-height: 0` finally has something to shrink
into and the canvas ends at the fold.

**Why.** Measured: the page renders 1078.4 px into a 906 px viewport, so the
canvas bottom is 119.9 px below the fold, `fleet-auditor` is at 866.5 and the
zoom controls at 931.9. **C3, C5 and C6 are all one bug**, and it is not in the
canvas — it is in one word of the page's own box. Fitting a graph into a box that
hangs off the screen cannot put anything on screen, which is why C1 and C2 look
worse than they are.

**⚠ This forces a change in a section I do not own — see Part 9.**

### D-S2.2 · Drive the fit from `useNodesInitialized`, and delete the ResizeObserver

**Why.** React Flow documents exactly one honest moment to frame a graph:
*"This hook tells you whether all the nodes in a flow have been measured and given
a width and height."* The `onInit` + ResizeObserver approach in `MapCanvas.tsx`
was written before that was understood and, measured, **does not work** — the
transform stayed at identity across four container resizes.

**And this repo has already solved it, one file away.** `EntityCanvas.tsx:162-178`
mounts a `FitWhenMeasured` child that calls back when `useNodesInitialized()`
flips true, with a doc-comment explaining why. The worker canvas — written first —
never got the fix. One page, two canvases, one of them right.

The RO is not replaced by another RO: a genuine container resize is a *layout*
event and, with D-S2.1, the container stops changing size after settle anyway.

### D-S2.3 · The card becomes three zones with a real hierarchy, and keeps its size

```
┌──────────────────────────────────────────────┐
│ Amazon Ads director                 DIRECTOR │   identity
│ ◼ Off                                        │   state
│ 2 runs · 0 open · $0.39                      │   evidence
└──────────────────────────────────────────────┘
```

- **identity** — name, plus the tier as a small-caps chip that is legible
  (2.50:1 → ≥4.5:1) rather than grey-on-white filler
- **state** — glyph at 11 px with a ≥3:1 fill and a 1px casing, plus the word
- **evidence** — the **same three facts on every card**, in the same order, at
  2-decimal money to match the band

**Why size stays uniform, against the lead I was given.** The brief suspected
"every card is the same size regardless of what it does" as a defect. It is not.
A column of identical cards is what makes the fleet *comparable* at a glance, and
Misue/Eades mental-map preservation is the reason the layout is topology-only in
the first place. Differentiation belongs in the tier chip and the column the card
stands in — both of which exist and neither of which is currently legible. Making
the director bigger would buy a hierarchy the column already encodes and cost the
scanability the grid provides.

**Why the same three facts every time.** Grafana's main-stat/secondary-stat model:
a fixed slot set can be read down a column; a variable one cannot. Today the row
is conditional — cards show one, two or three facts depending on their data — so
the third item on one card is the second item on the next.

### D-S2.4 · The glyph gets big enough and dark enough to be the channel it claims to be

11 px, a 1 px casing in a darker tone, and every fill ≥3:1 against the card.
Shapes unchanged: square = off, circle = working/running, bar = paused, triangle =
needs attention, hollow dashed = not set up.

**Why.** Measured at 1.8:1 and 8.8 px, the glyph is decoration. The file's rule 2
— *"colour is never the carrier"* — is only true if the non-colour channels are
actually resolvable, and a shape you cannot resolve is not a channel. This is the
cheapest possible repair of the rule the whole canvas is built on.

### D-S2.5 · Hover exists, on cards and on edges

Card: a raised shadow and a darker boundary. Edge: stroke thickens 1.4 → 2.4 px
and darkens, with the same treatment at `:focus-visible`.

**Why.** Measured: zero hover rules on the canvas. An edge with a 22 px invisible
hit target and no feedback is a generous target nobody can discover — the affordance
was built and never surfaced.

### D-S2.6 · A focus ring the reader can see

An explicit `.react-flow__node-worker:focus-visible` ring, at ≥3:1, offset so it
reads outside the card.

**Why.** WCAG F78 / SC 2.4.7 Level AA, root-caused to xyflow's own sheet removing
the outline and replacing it only for its four built-in node types. This is not a
polish item: the keyboard traversal this canvas is proud of is unusable without it.

### D-S2.7 · Dimming keeps the name readable

Instead of one `opacity: 0.28` on the whole card: hold the **name** at a contrast
that still clears 4.5:1, and dim the chrome, the glyph and the evidence row.

**Why.** *Dims, never removes* is a promise about what the reader can still see.
At 1.78:1 the name is gone, so the promise is kept in the DOM and broken on
screen. The point of dimming is to say *not this one* while leaving *this one* —
identifiable.

### D-S2.8 · Edge labels move to the source end

Each analyst→director label anchors near the **source** card, where the three
edges have not yet converged, rather than at the midpoint where they have.
The director→critic edge keeps its verdict chip — it is a single edge with no
neighbour to collide with. The full counts, and everything the director dropped
and why, stay in the inspector rail, which already prints them.

**Why.** Placement is NP-hard in general and trivially solvable here by not
placing labels where the lines bundle. Kiali's precedent is to move a measurement
it cannot place into the panel; ours can stay on the canvas if it stops standing
where three lines meet. **Falsifier:** if a fourth analyst is added and the source
ends crowd too, the labels come off the canvas entirely and live on hover +
the rail. Written down now so the next person does not re-derive it.

### D-S2.9 · The lane becomes a container

A bounded band with a background tint, a header rule and its cards *inside* it —
not a dashed top-border with two lines of text floating above a row.

**Why.** Airflow's TaskGroup is a container; our lane is a caption. Measured, its
note is 2.96:1 and its title sits 46 px above cards it has no visual relationship
to. It reads as debris, which is exactly the risk the brief named.

### D-S2.10 · Canvas chrome: reachable, conventional, and honest about what is off-screen

- Zoom controls stay bottom-left and become **reachable** (free with D-S2.1).
- **Ctrl/⌘+scroll zooms**, plain scroll pans — restoring the convention, and
  giving Mac trackpad pinch for free.
- A one-line hint in the canvas chrome saying so, because a gesture nobody
  mentions is a gesture nobody finds.
- **An off-screen indicator**: when nodes fall outside the viewport, a count and
  a "fit everything" affordance, in Grafana's hidden-node-marker idiom.
- **No minimap.** At seven nodes it is furniture; entity mode's 38 get the
  indicator and the fit control instead.

### D-S2.11 · Entity mode drops `title=` and stops truncating silently

The native `title` goes; identity at the tiny tier comes from the card itself
(the tier threshold rises so a card never renders as an anonymous dot), and a
truncated label gets a visible ellipsis with the full name in the inspector.

**Why.** `title=` is banned on this page by its own written rule, and here it is
load-bearing: at the tiny tier it is the only identification a card has. That is
the worst possible place to keep it.

### D-S2.12 · The header: two switches that stop pretending to be the same control

- **Mode** (*Workers / What they watch*) becomes the **subject control** and moves
  next to the title, styled as tabs — it changes what the page is *about*.
- **Window** stays right, gets a visible label (`Window`), and reads as a
  qualifier on the numbers.
- Both adopt the selected treatment Section 1 already proved on `.sbm-lens.on`:
  a fill clearing 3:1 plus a non-colour cue.
- `.sbm-sub` → the S1 value; `.sbm-asof` gets a colour that clears AA.

**Why.** Measured: two pixel-identical devices 10 px apart, one changing the
universe and one changing the denominator, with a selected state at 1.11:1. A
reader cannot be expected to learn which is which from position alone, and cannot
see which option is live in either.

---

## PART 4 — Two options for the canvas, and which I recommend

### Option A — repair the instrument *(recommended)*

Keep the layered node-link canvas. Fix the frame (D-S2.1/2), the card
(D-S2.3/4/7), the affordances (D-S2.5/6), the edges (D-S2.8), the lane (D-S2.9)
and the chrome (D-S2.10).

### Option B — demote the canvas at this size

Ghoniem/Fekete puts the node-link/matrix crossover near 20 vertices, and only
*path-finding* consistently favours node-link. At **7 workers and 4 edges** a
sortable list answers most questions better — and this page already ships that
list (M.5). Option B makes **List** the default view and keeps the canvas as the
secondary rendering.

### The recommendation, and the reason

**Option A.** Three reasons, two of them measured:

1. **The canvas is the page's reason to exist.** The parent study's one sentence
   is *"the fleet as it actually is, on one canvas"*, and the one question a list
   answers badly — *where does work go next* — is the question this page is for.
   The Map/List switch already lets a reader choose; changing the default answers
   a question the operator did not ask.
2. **The defects are not intrinsic to the form.** Of the 21, exactly one (C15,
   converging labels) is a genuine node-link problem. The rest are a wrong box
   model, a fit that never runs, four contrast values and a missing hover — all
   of which a list would inherit or has already had fixed.
3. **It is about to get bigger.** Worker instances (W.8) and custom workflows
   already exist, so the seven-node fleet is a floor, not a ceiling. Option B
   optimises for the smallest the graph will ever be.

**The honest case for B**, recorded: at today's size the canvas occupies ~60% of
the page to draw eleven objects, and the list is genuinely faster for *who costs
most* and *who failed*. If the fleet is still seven workers in six months, B
deserves revisiting — and the falsifier is concrete: **if the canvas still needs
scrolling to show every node at 1440 px after this rebuild, the form is wrong at
this size and B is right.**

---

## PART 5 — Honesty rules for this section

1. **Layout stays a function of topology alone**, memoised on a topology hash. A
   poll repaints; it never rearranges.
2. **Colour is never the carrier** — and a channel that cannot be resolved is not
   a channel. Every non-text status mark clears 3:1 and is legible at its size.
3. **Off is grey, never red. Never-run is dashed and never dimmed.**
4. **Filtering dims and never removes** — and *dimmed* must leave the worker
   identifiable, or it has removed it.
5. **The map is read-only.** Every control changes what you are looking at or
   navigates.
6. **One class drives both the mark and its legend**, so they cannot become two
   sources — the S1 meter rule, applied to the glyph and the overlay swatch.
7. **Money at one precision per page.** Two decimals, matching the band.
8. **The canvas never claims to show everything when it does not**: off-screen
   content is counted and named.
9. **No `title=` for information**, anywhere, including entity mode.
10. **Teaching stays off the canvas** — `<Term>` is clipped by `overflow: hidden`
    at z-index 40. Words on the canvas, explanations in the rails and the drawer.

---

## PART 6 — Empty and degenerate states

| state | what the canvas does |
|---|---|
| **Before the first read** | The existing skeleton, `aria-busy`, no nodes, no counts. Unchanged — S1 verified it. |
| **Read failed** | The band says so (S1.e). The canvas holds the last good graph with the header's stamp, or an empty frame — never a spinner that implies it is still trying. |
| **No workers** | The page's existing empty state; the canvas is not drawn. |
| **One worker, no edges** | Fits at `maxZoom` and centres; no lane, no edge chrome. |
| **All edges never-carried** | Every edge dashed. ⚠ Not reachable on prod today (C18) — must be forced in a fixture before shipping. |
| **A node off-screen** | Counted and named, with a control that frames everything. |
| **38 nodes (entity mode)** | Same, plus the tier threshold that stops a card rendering as an anonymous dot. |
| **A very long worker name** | Truncated with a visible ellipsis; full name in the rail. Never a `title`. |
| **Reduced motion** | Already handled; the new hover transitions join the same block. |

---

## PART 7 — The backend this section needs

**None.** Every value on the card and every edge count is already in the
`GET /agent/fleet/map` payload, verified live in the S1 audit. No new endpoint, no
new field, no migration.

---

## PART 8 — Accessibility and interaction

| | today | after |
|---|---|---|
| **Focus visible** | none — F78 / SC 2.4.7 fail | explicit ring ≥3:1 |
| **Status mark** | 1.8:1 at 8.8px | ≥3:1 at 11px |
| **Card boundary** | 1.28:1 | ≥3:1 |
| **Edge stroke** | 2.73:1 | ≥3:1 |
| **Sub-AA text on the canvas** | 4 roles (worst 2.47:1) | 0 |
| **Sub-AA text in the header** | 2 roles (worst 2.81:1) | 0 |
| **Switch selected state** | 1.11:1 | ≥3:1 + non-colour cue |
| **Hover** | none | card and edge |
| **Dimmed name** | 1.78:1 | ≥4.5:1 |
| **`title=` on the canvas** | 38 | 0 |
| **Keyboard traversal** | works, invisible | works, visible |
| **Screen-reader wiring** | good — keep exactly | unchanged |
| **Zoom** | scroll pans, nothing zooms, controls off-screen | Ctrl/⌘+scroll zooms, controls reachable, stated |

---

## PART 9 — ⚠ One change this section cannot make itself

**D-S2.1 gives `.sbm-page` a definite height. That makes `.sbm-body` a fixed-height
grid row — and the inspector rail is 780 px of content in it.** Without a
`overflow-y: auto` on `.sbm-rail`, the rail will clip instead of scroll.

`.sbm-rail` is the **inspector rail — Section M4, explicitly out of scope for this
session.** I am not editing it. Two ways forward, and the operator picks:

- **(a)** I take a one-line, additive claim on `.sbm-rail` (`overflow-y: auto;
  min-height: 0`) inside this section, recorded in the locks doc; or
- **(b)** the page-height fix waits for the M4 restudy, and S2 ships everything
  else — in which case **C3, C5 and C6 stay open**, because they are consequences
  of the box and not of the canvas.

**My recommendation is (a).** It is two declarations, it is provably behaviour-free
while the rail is shorter than its row, and holding the section's biggest fix
behind a different section's schedule buys nothing. But it is a boundary crossing
and the boundary is the operator's, not mine.

---

## PART 10 — What this section must never become

| If it grows… | It belongs on |
|---|---|
| a node you can drag, connect or delete | **`/fleet/workflows`** — the map is read-only (D3) |
| a dial, a pause, a run-now on a card | **`/fleet/workers`** and **`/fleet/controls`** |
| per-run history on a node | **`/fleet/activity`** |
| a cost breakdown or trend on a card | **`/fleet/cost`** — the card shows one number |
| the full drop reasons on an edge | the **inspector rail** (M4) — the canvas shows the count, never the prose |
| a second legend | the **overlay rail** (M3) — one class drives the mark and the legend |

And the canvas's own line: **a channel you cannot resolve is not a channel.** The
first status mark that needs a caption to be understood is the signal that colour
has quietly become the carrier again.

---

## PART 11 — Phases

The brief anticipated this being large. It splits cleanly into two passes, and
**pass 1 is the one that matters** — it contains every measured failure of the
frame plus the two WCAG failures.

**Pass 1 — the frame and the card**

| | what | closes |
|---|---|---|
| **S2.a** | the page box (D-S2.1) + `useNodesInitialized` fit (D-S2.2), RO deleted | C1–C6 |
| **S2.b** | the card: three zones, contrast, glyph, money precision, dimming | C7–C13 |
| **S2.c** | focus ring + hover on cards and edges | C10, C14, C17 |

**Pass 2 — the edges, the lane, the chrome and the header**

| | what | closes |
|---|---|---|
| **S2.d** | edge labels to the source end; stroke contrast | C15, C16 |
| **S2.e** | the lane becomes a container | C9 (lane note), D-S2.9 |
| **S2.f** | canvas chrome: Ctrl+scroll zoom, the hint, off-screen indicator | C6, D-S2.10 |
| **S2.g** | entity mode: `title=` removed, tier threshold, truncation | C19, C20 |
| **S2.h** | the header: two switches differentiated, contrast, selected state | H1–H5 |

### Exit criteria — the numbers I will be held to

| | today | target |
|---|---|---|
| page height vs viewport | 1078.4 / 906 (+172.4) | **≤ viewport** |
| canvas bottom past the fold | 119.9px | **0** |
| `fleet-auditor` visible without scrolling | no | **yes** |
| zoom controls reachable without scrolling | no | **yes** |
| viewport transform at identity after load | 3 of 4 loads | **0 of 6 loads** |
| sub-AA text roles, canvas + header | 6 (worst 2.47:1) | **0** |
| status glyph contrast | 1.8:1 | **≥3:1** |
| card boundary / edge stroke | 1.28 / 2.73 | **≥3:1 both** |
| keyboard focus indicator | none | **visible, ≥3:1** |
| hover states on canvas | 0 | **card + edge** |
| dimmed worker name | 1.78:1 | **≥4.5:1** |
| converging labels sharing one x | 3 | **0** |
| `title=` attributes on the canvas | 38 | **0** |
| switch selected-state contrast | 1.11:1 | **≥3:1 + non-colour** |
| nodes off-screen with no indication | 23 (entity) | **0 unannounced** |

---

## PART 12 — What I could not verify

- **The dashed never-carried edge treatment (C18).** All four edges have carried
  something, so I could not measure whether dashed reads at 100% zoom. It must be
  forced before S2.d ships.
- **Breakpoint behaviour at 1280 and 1440.** The harness cannot narrow the window
  below the display width — `resize_window` clamps, and one attempt silently left
  the page at 82% zoom. `.sbm-body` *does* carry `@media` rules at 1400 and 1100
  (they hide the rails), so an element-width probe would not fire them and is
  **not** a valid substitute here. What I did instead is stated as what it is: a
  probe of the canvas cell alone, which exercises the refit path and not the
  breakpoints. I make no claim about 1280/1440 layout.
- **Whether Ctrl+scroll currently zooms.** `zoomOnScroll={false}` is set and
  `zoomOnPinch` is left at its default; I did not synthesise a wheel event with
  `ctrlKey`, so D-S2.10 should be treated as restoring a convention rather than
  fixing a proven break.

---

## Sources

Repo and prod evidence cited inline. External:

- React Flow — [`useNodesInitialized()`](https://reactflow.dev/api-reference/hooks/use-nodes-initialized) ("tells you whether all the nodes in a flow have been measured") · [xyflow #4202](https://github.com/xyflow/xyflow/issues/4202) (nodesInitialized vs measured values)
- W3C — [SC 2.4.7 Focus Visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html) and failure **F78** · SC 1.4.11 Non-text Contrast
- Grafana — [Node Graph panel](https://grafana.com/docs/grafana/latest/panels-visualizations/visualizations/node-graph/) (main/secondary stat, arcs, layered vs grid, hidden-node markers, Ctrl+wheel zoom)
- Kiali — [graph topology](https://kiali.io/docs/features/topology/) (shape for type, colour for health, measurements moved to the side panel)
- Apache Airflow — [DAGs / TaskGroups](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dags.html) (collapsible groups, edge labels) · [UI](https://airflow.apache.org/docs/apache-airflow/stable/ui.html)
- Steve Ruiz — [Creating a Zoom UI](https://www.steveruiz.me/posts/zoom-ui) ("By convention, we use the control key to identify a zoom")
- Graph drawing — [Visualizing Graphs with Node and Edge Labels](https://arxiv.org/pdf/0911.0626) (ELP is NP-hard; unambiguous edge–label association) · [Edge Label Placement in Layered Graph Drawing](https://macau.uni-kiel.de/receive/macau_mods_00002021?lang=en)
- Carbon [status indicator pattern](https://v10.carbondesignsystem.com/patterns/status-indicator-pattern/) and Cloudscape [empty states](https://cloudscape.design/patterns/general/empty-states/) — as cited in the Section 1 study

---

## PART 13 — The execution record

| | commit |
|---|---|
| **S2.a** the page box + the first fit attempt | `c24fb3eb1` |
| **S2.b+c** the card, the glyph, the focus ring, hover | `d79bb685c` |
| **S2.a2/a3/a4** the frame, attempts two, three and four | `39e18f369`, `4fa51775d`, `9acc05aa5` |
| **S2.c2** two of my own targets I had missed | `185dd82aa` |
| **S2.g+h** the header switches, 38 banned tooltips | `1d8f1f5ac` |
| **S2.d+e** edge labels *(reverted)*, the lane container | `6296a27b7` |
| **revert** of the edge label | `5c96b6081` |

### 13.1 · Against the exit criteria

| | today | target | result |
|---|---|---|---|
| page height vs viewport | 1078.4 / 906 | ≤ viewport | **906, overshoot 0** ✅ |
| canvas past the fold | 119.9px | 0 | **−52.5px** ✅ |
| `fleet-auditor` visible | no | yes | **yes** ✅ |
| zoom controls reachable | no | yes | **yes** ✅ |
| transform at identity after load | 3 of 4 | 0 of 6 | **0** ✅ |
| sub-AA text, canvas + header | 6 (worst 2.47) | 0 | **0** (worst 4.62) ✅ |
| status glyph contrast | 1.8:1 | ≥3:1 | **4.62:1** ✅ |
| card boundary / edge stroke | 1.28 / 2.73 | ≥3:1 | **3.86 / 4.05** ✅ |
| keyboard focus indicator | none | visible ≥3:1 | **shipped** ✅ |
| hover states | 0 | card + edge | **both** ✅ |
| dimmed worker name | 1.78:1 | ≥4.5:1 | **6.31:1** ✅ |
| `title=` on the canvas | 38 | 0 | **0 author** ✅ |
| switch selected state | 1.11:1 | ≥3:1 | **8.24:1** ✅ |
| converging labels sharing one x | 3 | 0 | **3 — REVERTED, still open** ❌ |
| nodes off-screen unannounced | 23 (entity) | 0 | **not attempted** ❌ |

### 13.2 · The one finding that explains half this document

**xyflow never measures this canvas's nodes.** Every node carries
`visibility: hidden` inline — *permanently*, not transiently as `MapClient.tsx`
previously assumed — which is xyflow's not-yet-measured state, so `node.measured`
is never populated.

It was isolated behaviourally, not by reading source: **xyflow's own Zoom In
control moves the transform while its own Fit View control does nothing.** That
single asymmetry explains, at once:

- why `fitView` was a coin toss across loads (C1),
- why the ResizeObserver refit never fired (C2),
- why `useNodesInitialized` never opened its gate (attempt 2),
- why `setViewport` from a child of `<ReactFlow>` was inert (attempt 3),
- and why a custom edge component **deleted every edge** (13.4).

**The rule for anyone else here: on this canvas, any xyflow API that filters on
measured dimensions is a silent no-op.** Seven canvases in this repo use custom
`nodeTypes`; this is worth checking on each.

### 13.3 · The frame took four attempts, all of which passed review

1. `fitView` from `onInit` + a ResizeObserver — flaky across loads.
2. `fitView` gated on `useNodesInitialized` — the documented pattern, the one
   `EntityCanvas.tsx` already used. **Shipped, deployed, still identity.**
3. `setViewport` with our own arithmetic, retried until the node DOM existed.
   **Still identity.**
4. **Compute the viewport before render and pass `defaultViewport`.** Works —
   `zoom 0.7771 @ 173.4, 22` on prod.

The lesson is not "xyflow is awkward". It is that **three consecutive fixes
passed `tsc`, the ratchet, vitest and a careful read, and were wrong on
production**, because each one asked the library for something it could not do
and got silence rather than an error.

### 13.4 · The regression I shipped, and reverted

S2.d moved the converging labels off the midpoint with a custom `edgeTypes`
entry. It solved C15 and **removed all four edges from the graph** —
`.react-flow__edges` came back an empty `<div>` on prod while 8 nodes and 14
handles rendered normally. Custom edges are handed `sourceX/sourceY` computed
from measurements this canvas never gets; the built-in edge tolerates that and a
custom one does not.

Half the graph's information is worth more than three labels sharing an x, so it
is reverted and **C15 is open again**, with the receipt written into `map.css`
rather than quietly dropped. Solving it needs the measurement problem solved
first, or a label drawn outside xyflow's edge layer entirely.

### 13.5 · Two things I raised that turned out to be wrong

- **The Part 9 boundary crossing was not one.** `.sbm-orail` already carried
  `min-height: 0; overflow-y: auto` and `.sbm-rail-body` scrolls inside a
  `min-height: 0` rail. Both were built for a bounded row; the row was the
  missing part. The claim the operator granted was not taken and neither rail
  was touched.
- **Two audit leads did not reproduce.** The zoom controls do not overlap a card
  in entity mode (0 overlaps at 1728), and uniform card size is not a defect —
  it is what makes a column comparable, so it was kept deliberately and the
  illegible tier chip was fixed instead.

### 13.6 · And two of my own targets I missed on the first pass

The card boundary shipped at **2.05:1** because I chose the colour against white
when the card sits on the canvas's `#fbfcfe` — *a boundary is contrasted against
what is outside it*. And the glyph shipped rendering at **8.5px**, exactly where
it started, because the two fixes interact: the frame now actually runs, so the
canvas sits at zoom 0.777 and an 11px mark renders at 8.5. Contrast is
zoom-independent and was genuinely fixed; size is not. Both corrected in
`185dd82aa`, with the limit written into the file — as the fleet grows the fit
zooms further out and sizing stops winning, at which point **the word** is the
channel that survives, which is why rule 2 insists there are three.
