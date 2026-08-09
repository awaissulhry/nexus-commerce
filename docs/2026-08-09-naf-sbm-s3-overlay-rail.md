# NAF.SB.M-S3R — Section 3, the overlay rail: a measured audit and a rebuild

*The left rail beside the canvas: `Colour by`, `What the colours mean`, `Show`.*

Code: `app/fleet/map/OverlayRail.tsx`, `overlays.ts`, `overlays.vitest.test.ts`,
and the `.sbm-orail*` / `.sbm-legend*` / `.sbm-swatch*` / `.ov-*` rules in
`map.css`.

Everything below was measured on production
(`https://nexus-commerce-three.vercel.app/fleet/map`) on 2026-08-09, at
1728×962 unless another viewport is named. Breakpoint measurements were taken in
a real nested viewport — see §1.10 — not by narrowing an element.

**Status: study only. No code has been written.**

---

## PART 0 — What this section is for

The canvas paints seven cards in one colour channel. The rail is the only thing
on the page that says what that channel means, and the only thing that lets the
operator change what it means or narrow what it applies to. It has three jobs:

1. **Choose the question** the colour answers (`Colour by`).
2. **Decode the answer** (`What the colours mean`).
3. **Narrow the subject** (`Show`).

The section's founding rule, written into `overlays.ts`, is that the legend and
the graph are not two sources: one class per bucket drives both the node ring
and the legend swatch, and a test suite asserts the properties that make
disagreement impossible. That rule is the best thing about this section and the
rebuild must not weaken it.

The audit found the rule intact. It found nearly everything around it unmeasured.

---

## PART 1 — What is wrong today, measured

### 1.1 · The rail's text was never contrast-checked — 11 failures

Section 2's contrast sweep covered the canvas and the header. The rail was not
in it, and it shows. Every colour below is measured against its **resolved**
background (`#ffffff` — the rail paints its own white card), compositing every
ancestor's alpha and opacity.

| Element | Colour | Size | Measured | Needs | |
|---|---|---|---|---|---|
| `h3` "Colour by" | `#9aa5b3` | 10.5px | **2.50:1** | 4.5 | ✗ |
| `h3` "What the colours mean" | `#9aa5b3` | 10.5px | **2.50:1** | 4.5 | ✗ |
| `h3` "Show" | `#9aa5b3` | 10.5px | **2.50:1** | 4.5 | ✗ |
| `.sbm-orail-q` (the overlay's question) | `#7d879a` | 11px | **3.62:1** | 4.5 | ✗ |
| `.sbm-legend .note` × 6 | `#9aa5b3` | 10px | **2.50:1** | 4.5 | ✗ |
| `.sbm-orail-foot` ("Filtering dims…") | `#9aa5b3` | 10.5px | **2.50:1** | 4.5 | ✗ |
| `.sbm-legend .lab` × 6 | `#364152` | 11px | 10.32:1 | 4.5 | ✓ |
| `.sbm-seg button` unselected | `#45505f` | 11.5px | 8.18:1 | 4.5 | ✓ |
| `.sbm-seg button.on` | `#fff` on `#1f4f8b` | 11.5px | 8.24:1 | 4.5 | ✓ |
| `.sbm-chip` / `.sbm-chip.on` | `#4a5666` / `#1f4f8b` | 11.5px | 7.46 / 7.44 | 4.5 | ✓ |
| `.sbm-orail-check` label | `#4a5666` | 11px | 7.46:1 | 4.5 | ✓ |

**11 failures of 30 text nodes.** The pattern is exact and tells you what
happened: every element that was *typed as a label* passes, and every element
that was *typed as an aside* — the three section headings, the question, all six
legend notes, the footnote — was given `#9aa5b3` or `#7d879a` and never checked.

The single worst one is `.sbm-orail-q` at 3.62:1. That sentence — *"What is each
worker allowed to do right now?"* — is the one line that tells a beginner what
the whole colour channel means, and it is the faintest important text in the
section.

Two things this table does **not** claim. The four `.sbm-def-tip` nodes measure
1.00:1, but they are closed tooltips at `opacity: 0` and that is not a failure;
they are counted in §1.6 for a different reason. And `#55616f` on this page's
`#f4f6f9` is **5.83:1**, not the 6.02 quoted across three streams — on the
rail's white it is 6.31:1.

### 1.2 · The rail does not fit, and the filters are the part that falls off

`.sbm-orail` is `overflow-y: auto`. Its content is **778px**. Its box is
**621px**. So 157px is hidden at rest, and what is hidden is the bottom — the
whole `Show` block.

| viewport | rail box | content | hidden | **`Show` visible** |
|---|---|---|---|---|
| 1920×1080 | 739px | 778px | 39px | 146.3 of 174.4px |
| **1728×962** (measured) | 621px | 778px | 157px | **28.3 of 174.4px** |
| **1440×900** | 559px | 778px | 219px | **0 of 174.4px** |
| **1280×800** | 232px | 820px | 588px | **0 of 174.4px** |
| 1280×720 | 192px | 820px | 628px | 0 of 174.4px |
| 1100×800 | — | — | — | rail is `display: none` |

**At 1440×900 — an ordinary laptop — the entire `Show` block is invisible.** The
role filters, the *Dim the self-test* checkbox, and the sentence that states this
page's filtering law are all below the fold of a container whose scrollbar is an
overlay scrollbar and therefore invisible until you already know to scroll. At
1280 the rail shows **28%** of itself.

The screenshot at the top of the section is the proof: at rest you see `Colour
by` and most of the legend, and there is nothing on screen to suggest a third
block exists. Scrolling to reach the filters pushes `Colour by` off the top, so
there is no scroll position at which the control and the filters are both visible.

Where the 778px goes:

| block | height | share |
|---|---|---|
| `Colour by` | 154.4px | 19.8% |
| **`What the colours mean`** | **400.8px** | **51.5%** |
| `Show` | 174.4px | 22.4% |

and inside the legend, the six per-bucket notes are **210px — 27% of the entire
rail**, for 475 characters of prose.

### 1.3 · Five of the six legend rows describe a colour that is not on the canvas

Under the default overlay the legend renders six entries. The canvas occupies
**one** bucket (`ov-off`, all seven workers).

So **5 of 6 legend rows (83%) teach a colour the reader cannot find on the
canvas**, and those five rows carry ~175px of the 210px of notes. The reader is
paying half the rail's height, and most of its prose, to be told about states
nothing is in.

This is not a bug — it is the deliberate autonomy-ladder exception in
`visibleBuckets()`, and the reason given is sound: *"a scale with its unused
rungs removed stops showing where a worker sits on it."* But the exception was
written as *keep the rungs*, and it was implemented as *keep the rungs and their
paragraphs*, which is a different and much more expensive decision. §3 separates
them.

### 1.4 · Four of twelve bucket colours fail non-text contrast, and the ramps are hue-only

The swatch is an 11×11px square; the node ring is a 3px left border. Both are
graphical objects required to understand the content, so SC 1.4.11 asks 3:1.

| bucket | on rail `#fff` | on canvas `#fbfcfe` | |
|---|---|---|---|
| `ov-cost0` `#dfe6ee` | **1.26:1** | **1.23:1** | ✗ |
| `ov-nodata` hatch | **1.62:1** | — | ✗ |
| `ov-cost1` `#b7cbe4` | **1.66:1** | **1.61:1** | ✗ |
| `ov-off` `#b9c2ce` | **1.80:1** | **1.75:1** | ✗ |
| `ov-observe` `#6b8fc4` | 3.31:1 | 3.22:1 | ✓ |
| `ov-cost2` `#6b8fc4` | 3.31:1 | 3.22:1 | ✓ |
| `ov-propose` / `ov-warn` `#b7791f` | 3.64:1 | 3.55:1 | ✓ |
| `ov-auto` / `ov-good` `#2f855a` | 4.54:1 | 4.42:1 | ✓ |
| `ov-bad` `#c53030` | 5.47:1 | 5.33:1 | ✓ |
| `ov-cost3` `#2f5d94` | 6.74:1 | 6.57:1 | ✓ |

**`ov-off` is the bucket every worker on this fleet currently occupies.** The
entire canvas is painted, today, in a ring measuring **1.75:1**.

Worse is what separates the rungs from each other. WCAG is explicit that a
lightness difference only counts as a second channel when it reaches 3:1:

> "If content is conveyed through the use of colors that differ not only in
> their hue, but that also have a significant difference in lightness, then this
> counts as an additional visual distinction, as long as the difference in
> relative luminance between the colors leads to a contrast ratio of 3:1 or
> greater."
> — [Understanding SC 1.4.1](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)

Measured luminance separation between adjacent rungs:

| pair | separation |
|---|---|
| `observe` vs `propose` — *"may look"* vs *"may propose"* | **1.10:1** |
| `good` vs `bad` — *"finished cleanly"* vs *"ended in an error"* | **1.20:1** |
| `propose` vs `auto` | 1.25:1 |
| `cost0` vs `cost1` | 1.32:1 |
| `warn` vs `bad` | 1.50:1 |

None reaches 3:1. Every one of these distinctions is carried by **hue alone**.

For `health` and `cost` that is survivable, because the card states the fact in
words next to the colour — *"last run failed"*, *"$0.11 spent"*. For **autonomy
it is not**, and this is the section's most serious defect:

`deriveStatus`'s entire label vocabulary is `running`, `working`, `switched
off`, `paused`, `not set up`, `needs attention`, `never run, ever`, `last run
failed`, `stopped by a limit`, `waiting in Approvals`. **Not one of those words
names an autonomy level.** A worker at OBSERVE and a worker at AUTO both render
the word *running*. Under the page's default overlay, *"may look, may not act"*
versus *"may act on its own"* — the distinction that decides whether a robot can
change a live Amazon account — is carried by a blue-vs-green difference that is
**1.37:1** in greyscale and nothing else.

It is not exercisable on production today because all seven workers are off. It
is provable from the code, and it will appear the moment one is switched on.

### 1.5 · The focus ring on the selected option is literally invisible

```css
.sbm-seg button.on      { background: #1f4f8b; }
.sbm-seg button:focus-visible { outline: 2px solid #1f4f8b; outline-offset: -2px; }
```

The outline is drawn *inside* the border box, in the same colour as the selected
button's background. Measured: **1.00:1**. On an unselected button the same ring
is 8.24:1 and perfectly good.

In a radiogroup the selected option is exactly the one that receives focus, so
the broken case is the common case — a WCAG 2.4.7 failure of the F78 kind. This
is not local to the rail: `.sbm-seg` is shared by four segmented groups on this
page.

What the brief suspected here — that three vertical buttons "look like a list,
not a control" and that the selected state might not read — is **not** what the
measurement shows. The selected state is 8.24:1 and reads clearly; Section 1 and
Section 2's fix to `.sbm-seg`'s border (`#d7dee7` 1.25:1 → `#78838f` 3.86:1)
already reached this control. The dividers between the vertical options are
`#e6ebf1` = **1.20:1**, which is what makes the group read as a list, and the
focus ring is the real fault.

### 1.6 · The keyboard contract is declared and not implemented

`role="radiogroup"` with three `role="radio"` children, and:

- **all three have `tabIndex 0`** — no roving tabindex, so the group is three tab
  stops where the ARIA pattern specifies one;
- **there is no key handler at all** in `OverlayRail.tsx` — arrow keys do
  nothing. A screen reader announces "radio button, 1 of 3" and the arrow keys
  that announcement promises are dead.

Section 1's lens toolbar already implements the roving pattern correctly on this
same page.

The `Show` chips have the opposite problem: they are a **mutually exclusive**
set (picking `analyst` clears `director`) expressed as five independent
`aria-pressed` toggles. The two control groups in one rail use two different
patterns for the same kind of choice, and the one with the right semantics has
the broken keyboard.

The *Dim the self-test* checkbox is a raw `<input type="checkbox">`:

- **13×13px**, inside a label whose box is 194×**16.5px**. WCAG 2.2 SC 2.5.8
  asks 24×24. The label association is correct (the input is wrapped), so the
  16.5px-high strip is the real target.
- there is no `:focus-visible` rule for it anywhere — the only two focus rules
  in the rail are `.sbm-seg button:focus-visible` and `.sbm-chip:focus-visible`.
  It falls back to the UA ring, which is the only control on the page that does.
- `accent-color: auto` — it renders in the OS accent, not the page's `#1f4f8b`.

### 1.7 · The tier tooltips are 94px wider than the box that clips them

Each role chip is wrapped in `Def` with a note like *"Show only the analysts.
The rest stay on the map, dimmed."* Measured:

- tooltip width **288px**
- `.sbm-orail` content box **194px** (214px client − 10px padding each side)
- `.sbm-orail` is `overflow-y: auto / overflow-x: auto` → **it is a clipping
  container**, and the tip's offset parent (`.sbm-def`, `position: relative`)
  is inside it

So the tooltip overflows its clipping ancestor by **94px** horizontally and
cannot escape it. This is the same class of trap Section 2 recorded for `<Term>`
inside the canvas, in a different container.

The content is also redundant: the block already ends with *"Filtering dims; it
never removes."*

### 1.8 · A filter that silently stops applying

Measured, on production:

1. In map view, press `analyst` → `aria-pressed="true"`, **3 of 7 cards dimmed**.
2. Switch to **List**. → **7 rows, 0 dimmed**, and the rail is not rendered at
   all in list view, so the control that set the filter is gone too.
3. Switch back to **Map** → the filter is still set and the 3 cards dim again.

`ListView` is not passed `dimmed`, so the filter is genuinely inert there — but
the state persists, unshown and unmentioned. The operator sets a filter, changes
view, sees an unfiltered table with no filter control, and has no way to learn
that a filter is still armed and waiting.

### 1.9 · The invariant holds — and the way I nearly reported otherwise is worth recording

The brief called a legend/canvas colour drift "the section's worst possible
defect". I measured one, twice:

```
ov-good [Last run finished cleanly] sw=rgb(47,133,90)
                                    ring=rgb(47,93,148)/rgb(107,143,196)  AGREE=false
```

Green in the legend, blue on the cards. It reproduced. It was wrong.

`.sbm-node` carries `transition: border-color 0.12s`, and the tab was
backgrounded, where Chrome throttles style recalculation — stretching a 120ms
crossfade into seconds and letting `getComputedStyle` report the *previous*
overlay's ring long after the class had changed. The timeline shows it exactly:
at +1000ms the node classes were already `ov-cost3`/`ov-cost2` while the
computed colours were still the health greens; at +2443ms they agreed.

The control settles it. With one injected rule — `.sbm-node { transition: none }`
— and nothing else changed:

```
ov-good  expected rgb(47,133,90)  actual rgb(47,133,90)  ok=true   × 6
ov-nodata expected rgb(195,204,216) actual rgb(195,204,216) ok=true × 1
```

**The invariant holds in every settled state, in all three overlays.** What
remains is a structural risk rather than a live defect, and it is real: the
comment above the tints claims

> "ONE class per bucket, used by both the legend swatch and the node ring, so a
> colour changed here changes both"

but the CSS declares each colour **twice** —
`.sbm-swatch.ov-X { background }` on one line and `.sbm-node.ov-X {
border-left-color }` eleven lines later. One class, two declarations, and
nothing but care keeps them equal. They are equal today; I checked all eleven
pairs. The `ov-nodata` hatch is **already not equal**: the swatch hatches
`#eef2f6`/white at 3px, the card hatches `rgba(200,210,222,0.16)`/white at 4px.
Same bucket, two different textures — the legend's hatch is noticeably stronger
than the one on the card it is supposed to explain.

### 1.10 · Raised, not touched: a dead media query costs the rail 226px

Section 2 recorded that the harness could not reach 1280/1440. It can: **a
same-origin iframe has its own viewport, so media queries evaluate against it**
— unlike narrowing an element, which fires nothing. Every breakpoint figure in
this document was measured that way, in a real 1280- and 1440-wide viewport.

Doing so surfaced a rule that has never worked:

```css
@media (max-width: 1400px) { .sbm-rail { display: none } }   /* line 703 */
...
.sbm-rail { display: flex; ... }                             /* line 1566 */
```

Equal specificity, and **source order decides** — the same trap recorded for the
Workflows page. The base rule wins, so the inspector rail has never been dropped
below 1400px as intended. Measured at 1280×800, both rails stack into one 200px
column and:

| | today | with the query working |
|---|---|---|
| overlay rail height | 234.3px | **460.5px** (+226.2) |
| canvas height | **197px** | **423.3px** (+226.3) |

A 197px-tall graph canvas is not a graph. The overlay rail showing 232 of 820px
is not a rail.

**`.sbm-rail` belongs to the inspector, which this section does not own, so I
have not touched it.** It is written down here and raised: the one-line fix is
to move the `display: none` after the base rule, or scope it. Whoever owns the
inspector rail should take it — it is worth 226px to two sections at once.

### 1.11 · What is already right, and must survive

- **The bucket model.** An overlay is an ordered list of buckets, a total
  function into exactly one of them, and a sentence each. The canvas asks
  `bucketOf(node)` for a class; the legend iterates the same `buckets`.
- **No data is not the bottom of the scale.** `$0.00 over three runs` and
  `$0.00 over no runs` are different facts in different buckets, with the test
  to prove it.
- **The legend is real DOM text, always visible**, not a hover tooltip. The file
  says why, and it is right.
- **The rail carries no counts.** The census band owns the node population.
- **Health is bucketed from the last run, not `deriveStatus`**, with the
  reasoning written down.
- **A live pause cannot paint a worker as armed** — asserted by test.
- The legend already drops empty buckets for `health` and `cost` (measured: 2
  entries and 3 entries respectively, no orphans in either direction).

---

## PART 2 — What the best consoles do

### 2.1 · Panel, inline, or on demand

The products that colour a live graph put the key in a **persistent panel**, not
on the canvas and not behind a hover. Neo4j Bloom's Legend panel "shows a list of
all categories and relationship types available in the current Perspective,
along with the style used to render their nodes and relationships", and is
collapsible by an arrow button rather than removable. Grafana's node graph is the
counter-example that proves the cost: its legend exists **only in grid layout**,
so in the graph layout — the one you actually read topology in — there is no key
at all.

Inline (direct labelling) is the strong general recommendation in charting —
labels next to the mark reduce the spatial gap the reader must bridge — but it
degrades exactly where we are: a node here is 252×82px carrying four facts
already, and a bucket label like *"May propose, you approve"* cannot ride on it.
A panel is right for this canvas. What the direct-labelling literature does
establish is the *cost* we are paying, and therefore the obligation to keep the
panel short enough to hold in the eye.

**Sources:** [Bloom legend panel](https://neo4j.com/docs/bloom-user-guide/current/bloom-visual-tour/legend-panel/) ·
[Grafana node graph](https://grafana.com/docs/grafana/latest/panels-visualizations/visualizations/node-graph/) ·
[Observable Plot legends](https://observablehq.com/plot/features/legends) ·
[Data Design Standards: legends](https://xdgov.github.io/data-design-standards/components/legends)

### 2.2 · Does the legend double as a filter?

The charting default is **yes, and silently**: in Highcharts, "when the legend
item belonging to a series is clicked, the default action is to toggle the
visibility of the series". Bloom goes further — "Click on a category or
relationship type in the legend to select all nodes or relationships of that
type" — but makes it *selection*, not hiding.

The ambiguity is real and the best products resolve it by **making the legend do
one obvious thing and labelling it**. Bloom's legend selects and styles; its
filtering lives in a separate Filter control, and the two are described
separately.

Our rail already separates them into two blocks with two headings. The risk is
not that we have the wrong model — it is that `Colour by` and `Show` are two
identically-styled blocks in one scroll, so nothing but the words distinguishes
"repaints" from "narrows".

**Sources:** [Highcharts `legend.events.itemClick`](https://api.highcharts.com/highcharts/legend.events.itemClick) ·
[Bloom legend panel](https://neo4j.com/docs/bloom-user-guide/current/bloom-visual-tour/legend-panel/)

### 2.3 · Unoccupied buckets

This is the question our autonomy exception turns on, and Bloom has the most
developed answer: it shows **all** categories in the Perspective, and then adds
a control — "you can use a filter to limit the legend to show only elements
present in the scene, or find those not present in the scene" — plus, decisively,
"a count shows the number of items of a type that are currently visible somewhere
in the scene."

So the mature pattern is not hide-versus-show. It is **show the full vocabulary,
and mark which parts of it are present**. A zero count is information: it says
*no worker is in this state*, which on a fleet where nothing may act is the most
reassuring sentence on the page.

Dynatrace's service map legend likewise "shows live counts of services,
databases, queues, and frontends" — a legend that is also a census of what you
are looking at.

Our split — autonomy keeps all rungs, health and cost drop empties — is
defensible for **presence**. Nothing in the industry supports paying full prose
for an absent bucket.

**Sources:** [Bloom legend panel](https://neo4j.com/docs/bloom-user-guide/current/bloom-visual-tour/legend-panel/) ·
[Dynatrace service map](https://docs.dynatrace.com/docs/observe/application-observability/services/service-map)

### 2.4 · "No data" versus the low end of a scale

Kiali treats absence as a **separate, named, off-by-default display option**
rather than a value on the scale: "Idle Edges" can be enabled to "include request
edges that previously had traffic, but not during the requested time period",
and it is "disabled by default to present a cleaner graph". The naming matters —
*idle*, not *zero*.

Cloudscape separates the two states in prose that maps exactly onto ours: an
**empty state** is when nothing has been created; a **zero results state** is
when a filter matched nothing. Different words, different pictures.

Our `ov-nodata` hatch plus a bucket note is ahead of both. The thing to protect
is that the hatch reads as *"nothing to measure"* and never as a pale value at
the bottom of the ramp — which is precisely what `ov-cost0` at 1.26:1 currently
risks, since it sits next to a hatch of similar weight.

**Sources:** [Kiali graph FAQ](https://kiali.io/docs/faq/graph/) ·
[Cloudscape empty states](https://cloudscape.design/patterns/general/empty-states/)

### 2.5 · How much text belongs in a legend

Nobody recommends a paragraph per swatch. Cloudscape caps a chart at "up to 8
data series" and warns "Avoid showing too many metrics on a single chart". The
federal data design standard's guidance on legend text is about the *title*: "A
legend title is not necessary to include", and if present it should be
meaningful — "Population per Square Mile" rather than "Legend" or "Key".

Read against our rail: six buckets is within every stated limit, so the entry
**count** is fine. 475 characters of permanent note across them is not a legend
convention — it is a glossary that has been pasted into one.

Our generic heading `What the colours mean` sitting directly above a specific
question (`What is each worker allowed to do right now?`) is the exact pattern
the standard warns about, with the meaningful title already written one block
above and the generic one given the prominence.

**Sources:** [Cloudscape data visualization](https://cloudscape.design/patterns/general/data-vis/) ·
[Data Design Standards: legends](https://xdgov.github.io/data-design-standards/components/legends)

### 2.6 · Announcing that a control re-paints rather than filters

Kiali's model is the clearest in the category: a **Display** menu that governs
how the graph is drawn (edge labels — response time, throughput, traffic
distribution — plus badges and animation), kept entirely separate from **Find
and Hide**, which govern which elements are there. Two menus, two verbs, never
merged.

Grafana keeps the same separation by putting colour and arc configuration in
panel *options* and interaction in the panel itself.

The lesson is that the separation is carried by **placement and naming**, not by
a tooltip explaining the difference.

**Sources:** [Kiali topology](https://kiali.io/docs/features/topology/) ·
[Kiali graph tutorial](https://kiali.io/docs/tutorials/travels/04-observe/) ·
[Grafana node graph](https://grafana.com/docs/grafana/latest/panels-visualizations/visualizations/node-graph/)

### 2.7 · Filters that dim rather than remove

Bloom does exactly what this page does, and says so plainly: "When a filter is
applied, all filtered elements are greyed out in the Scene, they are still
visible but you cannot interact with them."

Two differences worth noting. Bloom **removes interactivity** from dimmed
elements; our page keeps them clickable, which is better for a map whose whole
claim is that it never re-lays-out. And faceted-search practice is that a filter
control should carry "result counts showing how many results each filter will
return" — which our chips deliberately do not, because the census band owns
counts. That deliberate choice is right, but it means the dimming itself is the
only feedback, so the dimming has to be legible and the rule has to be stated
where it can be read.

**Sources:** [Bloom scene interactions](https://neo4j.com/docs/bloom-user-guide/current/bloom-visual-tour/bloom-scene-interactions/) ·
[NN/g on faceted search](https://www.nngroup.com/articles/mobile-faceted-search/)

### 2.8 · What a rail does when the viewport narrows

The universal answer is **collapse, never delete**. Bloom's legend collapses via
an arrow button and can be expanded again. Grafana hides *nodes* beyond 200 but
replaces them with "clickable markers that show an approximate number of hidden
nodes" — the pattern Section 2 already adopted for off-screen entities. Nothing
in the surveyed products drops the key to the colours while continuing to paint
in them.

Below 1100px we do exactly that.

**Sources:** [Bloom legend panel](https://neo4j.com/docs/bloom-user-guide/current/bloom-visual-tour/legend-panel/) ·
[Grafana node graph](https://grafana.com/docs/grafana/latest/panels-visualizations/visualizations/node-graph/)

---

## PART 3 — The design, with the reason under each decision

### D-S3.1 · The rail stops being one scroll; the two controls are pinned and only the explanation scrolls

`.sbm-orail` becomes `display: grid; grid-template-rows: auto minmax(0, 1fr)
auto`, and `overflow-y: auto` moves off the rail and onto the legend block alone.

**Why.** The defect in §1.2 is not that the rail is too tall — it is that the
*controls* are what falls off the bottom of it. A legend is reference material
and scrolling reference material is normal; a filter you cannot see does not
exist. Pinning `Colour by` at the top and `Show` at the bottom makes both
reachable at every viewport where the rail is rendered, and makes the middle
block absorb the variance. It also fixes the "no scroll position shows both"
problem in §1.2, because there is no longer a scroll position that can hide
either.

Exit criterion: at 1440×900 and at 1280×800, `Show`'s visible height equals its
full height.

### D-S3.2 · An unoccupied rung keeps its swatch and its label, and loses its paragraph

`visibleBuckets` keeps returning every autonomy rung. The legend renders a note
**only for buckets a node on this canvas occupies**.

**Why.** §1.3 measured the exception's true cost: 83% of the rows, and ~175px of
prose, describing states nothing is in. But the reason the exception exists —
you cannot see where a worker sits on a ladder whose rungs have been deleted —
is about the rung being *present*, not about it being *explained*. A sentence
explains something on the canvas; when there is nothing on the canvas, the
sentence has no referent. Bloom's pattern in §2.3 is the same instinct: show the
whole vocabulary, mark what is present.

Measured effect on today's fleet: 1 occupied row at 67.8px + 5 label-only rows at
~24.9px = **~192px, down from 365.1px** — the legend stops being 51.5% of the
rail, and ~173px comes back.

This needs a small addition to the model: the legend already knows which buckets
are occupied (it computes `visibleBuckets`), so it needs the occupancy set, not
new data. **No backend change, no new field.**

### D-S3.3 · Each rung says whether anything is in it

An unoccupied rung reads `Held at off · none right now`, in the same de-emphasised
weight as a note.

**Why.** This is what makes D-S3.2 honest rather than merely shorter. Without it,
a row with no sentence just looks like a row we forgot to write. With it, the
absence becomes the information — and on a fleet where nothing may act, *"May act
on its own — none right now"* is the single most reassuring line the page can
print. It is Bloom's per-category count and Dynatrace's live legend counts, in
the smallest form that fits a 216px rail.

**This is not a count of the node population** and does not reopen the rail's
no-counts rule: it is a binary presence marker on a row that already exists, and
it cannot drift from the canvas because it is derived from the same `bucketOf`
pass the swatch is.

### D-S3.4 · Every text colour in the rail clears AA

All six `#9aa5b3` uses and the one `#7d879a` become `#55616f` — **6.31:1** on the
rail's white, and the token Section 1 established for exactly this role.

**Why.** They are not decoration. The three headings name the three jobs; the
question is the beginner's entry point; the notes are the legend's actual
content; the footnote states the page's filtering law. Every one of them was
tinted as an aside and none was ever measured. Nothing here needs to be faint —
it needs to be secondary, which is weight and size, not 2.5:1.

The `h3`s stay 10.5px uppercase; at 650 weight and 6.31:1 that reads as a label
without whispering.

### D-S3.5 · Every bucket colour clears 3:1 against both backgrounds it sits on

A bucket colour is used in two places on two backgrounds — the swatch on the
rail's `#ffffff`, the ring on the canvas's `#fbfcfe`. The rule becomes: **≥3:1
against both**, and adjacent rungs in an ordered ramp **≥1.5:1 from each other**.

**Why 3:1:** SC 1.4.11, and Cloudscape's palette holds the same floor — "All
colors maintain at minimum a 3:1 contrast ratio against container backgrounds."
Four of our twelve fail it, including the one every worker currently wears.

**Why 1.5 and not 3 between rungs:** four rungs each 3:1 apart needs 27× of
luminance range, which cannot coexist with every rung also clearing 3:1 against
white. That is a real, arithmetic impossibility, not a preference — so the ramp
buys as much separation as it can (1.5:1 makes the ladder rankable in
greyscale), and the *identification* problem is solved by a second channel
instead. See D-S3.6.

Two consequences to state plainly:

- `ov-off` `#b9c2ce` → a grey around **`#8a9199`** (3.19:1 on white, 3.10:1 on
  canvas), still the lightest and most recessive rung.
- ~~The cost ramp cannot hold four steps under this rule.~~ **Corrected during
  S3.e — this was wrong.** It conflated the impossible 3:1 *separation* with the
  1.5 one. Four steps at ~1.5× apart run 3.18 → 4.90 → 7.45 → 11.40, all clearing
  3:1 on both backgrounds. So no bucket is merged and `free` keeps its own
  colour; the paragraph that proposed sharing a class is withdrawn.

Exact hex values are derived and verified by measurement in the build phase, not
asserted here.

**Health is deliberately excluded from the re-spacing.** `good` 4.54, `warn`
3.64 and `bad` 5.47 already clear 3:1, and green-vs-red is 1.20:1 in greyscale —
but on the card the health bucket is fully redundant with the status word
(*"last run failed"*), so colour is not the only channel and 1.4.1 is satisfied.
Darkening a red that already says "error" in words buys nothing.

**This changes the canvas's appearance.** The `ov-*` tints live in this
section's block of `map.css` and are this section's to set, but the ring is
painted on Section 2's cards. It is the intended consequence of one class
driving both, and it is called out rather than slipped in.

### D-S3.6 · The hatch becomes one definition, and every tint becomes one declaration

`.sbm-swatch.ov-X` and `.sbm-node.ov-X` stop being two hand-kept-equal
declarations. Each bucket declares its colour once as a custom property on the
`ov-*` class; the swatch consumes it as `background`, the node as
`border-left-color`. The `ov-nodata` hatch is defined once, at one angle, one
stripe width and one pair of colours.

**Why.** §1.9 proved the runtime invariant holds and that the *structural* claim
in the comment is false — one class, two declarations, and the hatch already
diverged. The comment describes the property we want; this makes the CSS
actually have it. After this, a colour changed in one place changes both, and
the comment becomes true.

### D-S3.7 · The focus ring becomes visible on the selected option

`.sbm-seg button.on:focus-visible` gets a ring that contrasts with `#1f4f8b`
rather than matching it.

**Why.** 1.00:1, on the option that by definition holds focus in a radiogroup.
It touches all four segmented groups on the page and fixes the identical bug in
all four — a focus state only, no layout, no colour change at rest.

### D-S3.8 · The two control groups agree with each other and with the keyboard

- `Colour by` gets **roving tabindex and arrow keys** — one tab stop, `←/→/↑/↓`
  to move, matching the ARIA radiogroup pattern it already declares and the
  lens toolbar Section 1 shipped on this page.
- `Show` becomes a **radiogroup too**, because it is one: `every role` and the
  four tiers are mutually exclusive. `aria-pressed` on five independent toggles
  describes a multi-select that does not exist.
- The **checkbox** gets a ≥24px target row, a `:focus-visible` ring matching the
  rail's other controls, and `accent-color` set to the page blue.

### D-S3.9 · The tier tooltips are deleted

**Why.** They are 288px of content inside a 194px clipping box — 94px of every
one of them is unreachable (§1.7). And the sentence they carry, *"The rest stay
on the map, dimmed"*, is the same sentence the block already ends with in
permanent, readable text. A hover-only, keyboard-hostile, clipped restatement of
a line printed 40px below it is not worth repairing. Deleting them removes a
mechanism rather than adding one.

### D-S3.10 · The heading says what the block is for

`What the colours mean` is replaced by the overlay's own question, promoted into
the heading position, with the block's job carried by structure rather than by a
generic label.

**Why.** §2.5: a legend title should be meaningful, not "Legend" or "Key". We
have a meaningful title already written — *"What is each worker allowed to do
right now?"* — and we currently print it in the faintest text in the section
(3.62:1) *underneath* a generic heading. Swapping their roles costs no height and
gives the beginner the sentence that orients them, first and legibly.

---

## PART 4 — Two shapes for the rail, and which I recommend

### Option A — keep one rail, make it fit *(recommended)*

Three blocks stay in one column. The two controls pin, the legend scrolls, the
prose is paid only where it buys something, and the colours clear their floors.

- **Cost:** the legend can still scroll at 1280 and below; the reader may not
  see all six rungs at once at small heights.
- **Gain:** every control is always visible; ~173px of prose recovered; nothing
  moves to another section's surface; the smallest diff of any option.

### Option B — split the rail: the colour control joins the canvas toolbar

`Colour by` moves up beside `Map / List` as a horizontal control; the rail keeps
only the legend and the filters.

- **Cost:** puts a Section 3 control into Section 2's canvas chrome, which the
  brief puts out of scope and which would need that owner's agreement. Separates
  the control from the question and the legend that explain it — precisely the
  coupling §2.6 says the good products preserve. Adds a fourth horizontal control
  to a strip that already carries three.
- **Gain:** the rail loses 154.4px and would fit without pinning.

### The recommendation, and why

**Option A.** The measured defect is that the *filters* fall off the bottom,
and pinning fixes that directly and entirely, in one CSS rule, without moving a
control into a section this session does not own. Option B is a bigger change
that buys the same 154px the prose reduction in D-S3.2 already buys (~173px), and
pays for it by breaking the adjacency between the colour control, the question
it answers, and the key that decodes it.

The deciding argument is §2.6: Kiali's Display menu is one place because *how the
graph is drawn* is one idea. Option B would split that idea across two surfaces
to solve a height problem that has a height solution.

---

## PART 5 — Honesty rules for this section

1. **The legend never shows a colour the canvas cannot show.** Buckets are
   declared, `bucketOf` is total, and the tests assert both.
2. **An unoccupied rung says it is unoccupied.** Presence is stated, never
   implied by absence of a sentence.
3. **No data is never a value on the scale.** The hatch is not the light end of
   the cost ramp, and after D-S3.5 it is no longer within 0.4 of it either.
4. **The rail carries no census.** Presence markers are binary; every count on
   this page belongs to the band above the canvas.
5. **Colour is one channel of the answer, never the whole answer** — and where
   the page cannot honour that today, it is written down (§6, C-S3.1) rather
   than glossed.
6. **`Colour by` re-paints; `Show` narrows.** Neither is ever described in the
   other's verb.
7. **Filtering dims and never removes** — and that sentence stays permanently
   visible, not in a tooltip.

---

## PART 6 — Empty and degenerate states

| state | what the rail does |
|---|---|
| **before the first read** | the rail renders nothing rather than an empty scaffold — the overlay is unknown until the nodes are |
| **one bucket occupied** (today, `autonomy`) | live now: 6 rungs, 1 with a note, 5 marked *none right now* |
| **one bucket occupied** (`health`/`cost`) | measured: legend renders 2 and 3 entries; empties already dropped |
| **no workers at all** | `.sbm-body` is not rendered; the page shows its own empty state and the rail never mounts |
| **only one tier present** | `Show` already suppresses itself unless `tiers.length > 1 \|\| hasDiagnostic` — correct, and kept |
| **no self-test worker** | the checkbox is already conditional on `hasDiagnostic` — kept |
| **below 1100px** | today: `display: none`, and the canvas keeps painting in colours nothing explains. See C-S3.2 |

---

## PART 7 — The backend this section needs

**None.** Every decision above is computed from `MapNode[]`, which the rail
already receives. D-S3.3's presence marker is derived from the same `bucketOf`
pass that paints the swatch, which is what makes it incapable of drifting from
the canvas.

---

## PART 8 — Accessibility and interaction

- **1.4.3** — 11 text failures fixed to 6.31:1 (D-S3.4).
- **1.4.11** — 4 bucket colours raised above 3:1 on both backgrounds (D-S3.5).
- **1.4.1** — partially addressed: the ramps get real luminance ordering, but
  under the autonomy overlay the level is still carried by hue alone. See
  C-S3.1; this section cannot close it from inside the rail.
- **2.4.7 / F78** — the invisible focus ring on the selected option (D-S3.7).
- **2.5.8** — the 16.5px checkbox target raised to ≥24px (D-S3.8).
- **ARIA radiogroup** — roving tabindex and arrow keys, on both groups (D-S3.8).
- **1.4.13** — the only hover-revealed content in the rail is deleted (D-S3.9),
  so the criterion stops applying rather than being satisfied by machinery.
- **`prefers-reduced-motion`** — the rail's only transitions are colour and
  opacity, which are not motion; no change needed, and the existing block for
  `.sbm-def-tip` becomes moot with D-S3.9.

---

## PART 9 — What this section must never become

- **A second glossary.** The rail explains a colour channel. It is not where the
  fleet's vocabulary lives — the teaching drawer and `definitions.tsx` are.
- **A second census.** Counts belong to the band. Presence is not a count.
- **A place where colour is invented.** Every tint is a declared bucket with a
  class and a sentence, or it does not exist.
- **A filter panel that grows.** Two control groups, both mutually exclusive,
  both stating what they do to the map. A rail that accumulates controls will
  push its own legend off the bottom again.
- **Hover-dependent.** Anything the reader must know to read the canvas is
  permanent text.

---

## PART 10 — Raised for decision, not taken

### C-S3.1 · Under `autonomy`, colour is the only channel — and the fix is on the card

Measured in §1.4: the card's status vocabulary contains no autonomy term, so
OBSERVE and AUTO both print *running*, and the rungs separate at 1.10–1.37:1 in
greyscale. D-S3.5 improves the ramp but cannot reach WCAG's 3:1 bar for four
rungs, and no rail-side change can put a word on a card.

**The fix is one token on the node card under the autonomy overlay** — the
bucket's short label beside the tier badge. `overlays.ts` can supply it; the card
that renders it is `MapCanvas.tsx`, which is Section 2's. **Raised, not touched.**

### C-S3.2 · Below 1100px the rail is deleted, and the canvas keeps painting

`@media (max-width: 1100px) { .sbm-orail { display: none } }`. The colour
control, the legend and the filters all vanish while the canvas continues to
colour its cards — the exact failure `overlays.ts` was written to prevent
("`FleetMapCanvas` tints a border by autonomy level and no legend says so").
Nothing in §2.8 supports it.

In scope to fix, and I recommend collapsing rather than deleting — the rail's
three blocks become one disclosure above the canvas. **Sequenced last**, because
it is the least likely viewport for this operator and the largest of the changes.

### C-S3.3 · The tier filter is armed and inert in List view

Measured in §1.8. Three fixes, all landing outside the rail: apply it to the
list (`ListView.tsx`), clear it on view change (`MapClient.tsx`), or state it.
**Raised** — the rail is not rendered in list view, so it cannot say anything
there itself. My recommendation is to apply it and dim the rows, because
*"filtering dims; it never removes"* is a page law and the table is part of the
page.

### C-S3.4 · The dead `.sbm-rail` media query — worth 226px to two sections

Fully measured in §1.10. One line, owned by the inspector rail. **Raised.**

### C-S3.5 · Should the rail carry Section 2's converging-edge count (C15)?

Section 2 left C15 open — three analyst edges converge on the director and their
labels land within 0.3px of one another, because the analysts share a column, so
source-anchoring cannot separate them. One candidate resolution is to move the
handoff count off the edge entirely, and the rail was named as a possible home.

**My recommendation: no, and not for want of precedent.** There is precedent —
Dynatrace's legend "shows live counts", Bloom's shows per-category counts. But
both count *the kinds of thing the legend is a key to*. A handoff count is a
per-edge measurement, and the rail would then hold a number that is not about
colour, on a surface whose own header comment forbids counts for a specific
reason: *"a second set of numbers a few hundred pixels away is how a summary and
its rows drift apart."*

The two homes that survive that argument are **the target node's badge** (the
director already has a card, and *"7 carried in"* is a fact about that worker) and
**the inspector rail's handoff panel** (which already has room to print what was
dropped and why). Of those I would choose the node badge, because it needs no
selection to be read.

**Presented, not taken — this is the operator's call.**

**RESOLVED 2026-08-10, and the answer is that there is nothing to move.** Before
building anything I measured the labels I was proposing to relocate. On prod, at
five viewports from 1920 down to 1100:

| | |
|---|---|
| edges drawn / labels rendered | **4 / 4** at every width |
| pairwise label overlap | **none**, at every width |
| truncated labels | **0** |
| smallest vertical gap between any two labels | **13.8px** |
| the three converging labels | x ≈ 698 for all three, **37.6px apart vertically** |
| canvas zoom | 0.643, identical at all five widths |

The three analyst labels do share an x — that part of C15 was correctly
observed — but they sit in a clean vertical stack, because the analysts occupy
different rows. **Sharing an x is not a collision.** What made C15 look like one
was the old label text: S2R measured `4 carried · 1 dropped` colliding and
truncating mid-word, and S2R's own fix — shortening the label to `4 carried` and
moving what was dropped into the edge inspector, where there is room to print the
reason — removed the overlap. The finding outlived the defect.

So the badge is not built, and it should not be: it would move a per-edge
measurement onto a node, away from the edge it describes, onto a surface whose
own rule forbids carrying counts. **C15 is closed as not reproducible**, with the
numbers above rather than an opinion.

*(The stable 0.643 zoom across five widths is a free confirmation of S2R's
deterministic framing — the coin-toss `fitView` really is gone.)*

---

## PART 11 — Build order

Each phase is one shippable unit: DS ratchet, `tsc`, vitest, push, then verify on
production with measured geometry.

| phase | change | exit criterion, measured on prod |
|---|---|---|
| **S3.a** | contrast: 11 text colours (D-S3.4), heading swap (D-S3.10) | 0 text nodes below 4.5:1 in `.sbm-orail` |
| **S3.b** | the rail's three-row grid; only the legend scrolls (D-S3.1) | `Show` fully visible at 1920, 1728, 1440 **and** 1280 |
| **S3.c** | notes only where occupied + presence markers (D-S3.2/3) | legend ≤200px on today's fleet; all `overlays.vitest` green |
| **S3.d** | one declaration per tint, one hatch (D-S3.6) | swatch and ring resolve identical for all 12 buckets, transitions disabled |
| **S3.e** | the ramps clear 3:1 / 1.5:1 (D-S3.5) | every bucket ≥3:1 on `#fff` and `#fbfcfe`; adjacent rungs ≥1.5:1 |
| **S3.f** | focus ring, both radiogroups, checkbox target (D-S3.7/8) | ring ≥3:1 on selected; 1 tab stop per group; arrows move; target ≥24px |
| **S3.g** | delete the tier tooltips (D-S3.9) | 0 `.sbm-def-tip` in the rail; no clipped content |
| **S3.h** | below 1100: collapse, do not delete (C-S3.2) | at 1024, the colour control and legend are reachable |

`S3.d` before `S3.e` on purpose: unify the declarations first, so the ramp change
is made in one place and cannot half-land.

---

*Sources cited inline in Part 2. Measurements: production, 2026-08-09, viewport
1728×962; breakpoints in a same-origin nested viewport at the widths named.*

---

## PART 12 — The execution record

Nine commits, all prod-verified. `2e97ce758` · `be4748700` · `fbaa135cc` ·
`9d0d56dfa` · `13d30a49b` · `4b31c876c` · `885412da2` · `2671e7a8f`.

### What moved

| | before | after |
|---|---|---|
| text nodes below AA | **11 of 30** | **0 of 25** |
| worst text in the rail | 2.50:1 | **6.31:1** |
| the overlay's question | 3.62:1, a footnote | **10.32:1, the heading** |
| `Show` visible at 1440×900 | **0 of 174.4px** | **181.9 of 181.9** |
| `Show` visible at 1728×962 | 28.3 of 174.4px | **181.9 of 181.9** |
| `Show` visible at 1280×800 | 0 of 174.4px | 80.1 of 181.9 *(see C-S3.4)* |
| rail content hidden at rest | 157px | **0** |
| legend height on this fleet | 365.1px | **183.8px** |
| legend rows explaining a colour that is not on the canvas | 5 of 6, with prose | 5 of 6, marked `none` |
| bucket colours below 3:1 | **4 of 12** | **0 of 12** |
| the ring every worker wears | 1.75:1 | **3.10:1** |
| adjacent rungs, autonomy | 1.10–1.84 | **1.52–1.54** |
| adjacent steps, cost | 1.32–2.04 | **1.52–1.54** |
| focus ring on the selected radio | **1.00:1** | **8.24:1** |
| tab stops in the rail | 9 | **3** |
| arrow-key support | declared, absent | **both groups** |
| checkbox target | 194×16.5px | ≥24px, page-blue, own focus ring |
| clipped hover tooltips | 4, each 94px too wide | **0** |
| the rail below 1100px | `display: none` | 3 columns, legend in 2 |
| colour declared per bucket | **twice** | **once** |

The legend/canvas invariant was re-verified in all three overlays with
transitions disabled: swatch edge and node ring identical for every bucket, and
no node in a bucket the legend does not show.

### Four things worth keeping

**1 · A contrast probe lies while a transition is running.** I measured a
legend/canvas colour mismatch — the section's worst possible defect — and it
*reproduced*. It was not real: `.sbm-node` carries
`transition: border-color 0.12s`, and a backgrounded tab throttles style
recalculation, so `getComputedStyle` reported the previous overlay's ring for
seconds after the class had changed. One injected `{transition: none}` settled
it in a single call. **Before believing any cross-surface colour disagreement,
kill the transition and re-measure.** (Related: `requestAnimationFrame` yields
*zero* samples in a background tab — use `setTimeout`.)

**2 · Breakpoints are reachable after all.** Section 2 recorded that the harness
could not narrow below the display width. It cannot — but **a same-origin iframe
has its own viewport, so `@media` evaluates against it**, unlike narrowing an
element, which fires nothing. Every 1280/1440/1100/1024 figure here was measured
that way, and it is what found C-S3.4.

**3 · Source order beats specificity — three times in one file.** `.sbm-orail-q`
(S3.a) needed the element in its selector. `.sbm-rail`'s 1400px query has never
fired (C-S3.4, worth 226px to two sections). And **S3.b's own `display: grid`
silently disabled the 1100px rule** — a behaviour change I shipped without
noticing, caught only by measuring the breakpoint afterwards. S3.h turned that
into the intended behaviour and *deleted* the rule rather than moving it: a
`display: none` that hides nothing is worse than no rule, because the next
reader believes it.

**4 · I was wrong in the study, in writing.** D-S3.5 claimed the cost ramp could
not hold four steps and proposed merging two buckets. It had conflated the
impossible 3:1 separation with the achievable 1.5 one. Four steps fit; nothing
was merged; the paragraph is struck through in place rather than quietly edited.

### Closed after the section, on the operator's go-ahead (S3.i–S3.m)

Every item raised in Part 10 has now been taken or retired.

| | what happened |
|---|---|
| **C-S3.4** *(S3.i)* | The `.sbm-rail` 1400px query fires for the first time. At 1280×800: overlay rail **234.3 → 460.5px**, canvas **197 → 423.3px**. Consequence stated rather than discovered — below 1400 there is now no inspector, which is what the rule always said. |
| **C-S3.2** *(via S3.i)* | Follows from the above: `Show` no longer competes with a panel the stylesheet said should not be there. |
| **C-S3.1** *(S3.j)* | `OverlayBucket.short` puts the level in words on the card — `may look` / `may propose` / `may act` — set **only** where the tint is the sole carrier, and asserted both ways in the test. **Verified with a synthetic payload** (see below), because no worker on this fleet is armed. |
| **≤1100 canvas 2px** *(S3.k)* | The row had nothing to size to: react-flow is absolutely positioned, so an `auto` row collapsed to the view switch. `2 → 77.3 → 152.5px` across the two fixes. |
| **C-S3.3** *(S3.l)* | The table dims the rows the rail filtered out, via one additive `rowClassName` on the shared `DataGrid` (claimed and released). |
| **C-S3.5 / C15** *(S3.m)* | **Retired, not built.** Measured first: no label overlap at any of five viewports. See Part 10. |

### Verifying S3.j, on a fleet where nothing is armed

Every worker here is OFF, so no card can render an autonomy token and the one
change that fixes a WCAG failure was the one change prod could not show. Patched
`fetch` to intercept `GET /api/agent/fleet/map` and flip three workers to
OBSERVE / PROPOSE / AUTO — the real payload, two fields changed — then pressed
Refresh. Measured:

- three cards that **all print "Working"** rendered `may look`, `may propose`
  and `may act`, at **8.18:1**; the four OFF cards rendered no token, as designed
- each token's dot resolved to its own bucket colour — `#56729d` / `#744d14` /
  `#17422d` — from the same `--ov` the ring reads
- the status row **fits** on all seven cards; nothing overflowed
- the legend flipped those three rungs from `none` to occupied-with-a-note by
  itself, which is S3.c working on data it had never seen
- and the harder layout case held: **4 occupied rungs with notes, `Colour by`
  FULL, `Show` FULL, rail overflow 0**, the legend absorbing the extra by
  scrolling 101px internally — exactly what S3.b's pinned structure was for, and
  only testable with a fleet that has something switched on

Two process notes from doing it. **The first attempt showed no token at all**,
because `Refresh` refetches data but not code and the tab still held the bundle
from before S3.j deployed — so the probe now asserts the build carries
`.sbm-node-lvl` before trusting anything it renders. And the ring appeared not to
match its dot until I killed the transition: **the same artefact, third time,
caught by the control instead of by shipping a wrong fix.**

### S3.n — and the last open item turned out not to need the band at all

The remaining complaint was that at 1100×800 the header, census band and footer
take **407px of an 800px viewport**. I had raised it against §M1's band, on the
assumption that the fix was to make the chrome smaller. Measured, it is not.

| at 1100×800 | |
|---|---|
| header | 112.3px (identical at 1728 — it does not grow) |
| teaching disclosure | 29.3px |
| census band | 140.8px — **+51.3** over its 1728 height, from text wrapping |
| footer | 37px — **+16.5** over 1728, same cause |
| left for `.sbm-body` | **392.7px**, to split between the rail and the graph |

Only 67.8px of that is width-induced wrapping. The other ~339px is what the page
*is*. Three fixed panels and a graph do not fit in 800px, and no redistribution
of the chrome makes them — recovering every wrapped pixel would still leave a
220px graph.

So the fix is not a smaller band; it is that **`height: 100dvh` is the wrong
promise below 1100**. Above it the promise holds — at 1101×800 the canvas gets
355.4px with no scrolling at all. Below, the page stops dividing a fixed height
and becomes as tall as it needs:

| | as shipped | after |
|---|---|---|
| canvas at 1100×800 | 152.5px | **400px** |
| canvas at 1024×768 | 101.8px | **400px** |
| canvas at 1101×800 | 355.4px | 355.4px — rule correctly does not apply |

**Verified reachable**, because a taller page only helps if you can get to the
bottom of it: the app shell's `main.flex-1.overflow-auto` picks up the overflow
(scrollHeight 1068 vs clientHeight 800) and scrolling to the end brings the
footer fully into view. Probing `document.scrollingElement` would have reported
"no scroll" and been wrong — the page root never scrolls on this shell.

The cost, stated: a wheel over the canvas pans the graph, so the ~250px of scroll
has to be driven from the chrome around it. That is the standard bargain for an
embedded canvas and the gesture is already written on screen.

**Nothing is now open against another section.** The band was raised and then
cleared by measurement rather than by editing it — which is the better outcome,
because §M1 would have been changed for a problem it was not causing.
- **New:** at ≤1100 the canvas measures **2px tall**, before and after this work,
  and the rail clips 16px at 1100 / 42px at 1024. **Both have the same cause and
  it is not the rail.** I first assumed the clipping was my own `max-height` and
  raised it 210 → 260; measured after deploying, **the clipping is identical**,
  because the cap is never reached — the parent grid hands the rail's row only
  174.7px at 1100. The constraint is `.sbm-body`'s height distribution in its
  one-column form, which is also what flattens the canvas. **Raised** — the
  canvas and the body grid are S2R's. The cap stays as a guard, with the wrong
  theory corrected in place rather than deleted.

  This is the second time in one section that a fix shipped on an unverified
  theory (the first was the three transition-artefact "mismatches"). Both were
  caught by the same habit: measure the thing you claim to have fixed, on prod,
  after it deploys.
