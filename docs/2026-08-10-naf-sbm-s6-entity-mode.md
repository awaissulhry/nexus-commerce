# NAF.SB.M-S6R — Section 6, entity mode: a measured audit, and an argument for making it smaller

*"What they watch" — 38 campaigns and the 103 relationships the fleet derived
between them.*

Code: `app/fleet/map/EntityCanvas.tsx`, the entity branch of `MapClient.tsx`, and
the `.sbm-ent*` / `.rel-*` / `.sbm-crumbs` rules in `map.css`.

Measured on production 2026-08-10. Contrast measured per region **and** at page
level; the canvas measured in the real tab **and** in a nested viewport, because
the two disagreed and the disagreement is the finding.

**Status: study only. No code has been written.**

---

## PART 0 — The inherited raises, re-measured

Five raises this engagement dissolved when finally measured. Here is what
survived of the four this section inherits.

### 0.1 · Contrast — **mostly dissolves, and uncovers something all five sweeps missed**

Measured per region, in entity mode:

| region | text nodes | failing |
|---|---|---|
| census band | 4 | **0** |
| relation legend rail | 6 | **0** |
| centre pane | 44 | **0** |
| inspector rail | 4 | **0** |
| **the page** | 73 | **1** |

The entity-specific classes are clean — S1–S5's fixes reached them. But sweeping
`.sbm-page` rather than a sub-region found `.sbm-foot` at **2.81:1**
(`#8a95a3`), and it fails in **both** modes:

> *"Rebuilt every night by the sweep. An id shown instead of a name is one the
> fleet could not resolve…"* (entity)
> *"Wiring read from 4 enabled routines — fleet-sweep, fleet-council…"* (worker)

**Every one of the five prior sweeps was scoped to the region being rebuilt** —
`.sbm-orail`, `.sbm-rail`, `.sbm-centre`, `.sbm-band` — and the footer sits
between them. That is a method finding as much as a defect: *a sweep scoped to
your own section leaves the seams unmeasured.*

### 0.2 · C20 (the anonymous-dot tier) — **does not reproduce**

The tiers are `showText` at zoom ≥ **0.62** and `showAll` at ≥ **1.05**; the
arrival frame clamps to `max(0.55, min(1, (width − 44) / maxRight))`.

Loaded at each width and measured on arrival:

| viewport | canvas | arrival zoom | text tier | nodes showing text |
|---|---|---|---|---|
| 1512×793 | 1034 | 0.84 | ✓ | **38 of 38** |
| 1024×768 | 910 | **0.94** | ✓ | **38 of 38** |

The layout is width-fitted, so a narrower viewport produces a *higher* zoom, not
a lower one. **No supported width puts a card below the text threshold.** C20 is
closed for this mode.

What the same measurement *does* show is a different, smaller thing: the full
tier needs ≥1.05 and the arrival clamp is ≤1.0, so **the middle tier is the only
one you ever arrive in** — the third exists but nothing takes you there.

~~And an unrelated bug fell out of it: the frame is computed once at mount and
never re-fits.~~ **WITHDRAWN — this was my own measurement error, and it is the
sixth raise this engagement to dissolve.**

I measured the zoom as identical at 1920 and 1024 after resizing and concluded
the frame never re-fits. It does: there is a `ResizeObserver` on the wrapper
calling `refit`. But it schedules through `requestAnimationFrame`, and **rAF
does not run in a backgrounded tab** — a trap already recorded in
`reference_iframe_real_viewport_probe` from Section 3.

Proved rather than assumed, in the same tab that produced the bad reading:

```
requestAnimationFrame × 2  →  fired: 0
setTimeout                 →  fired: true
document.visibilityState   →  "hidden"
```

The resize handler was never exercised. **No code change**, and the phase that
would have "fixed" it is struck from Part 8.

### 0.3 · Inline chrome — **half resolved, and I resolved half of it myself**

S4.i moved entity mode's *detail* rail into the shared `RailShell`. Still inline
in `MapClient.tsx`: the census band (`.sbm-band tone-entities`), the relation
legend rail (`.sbm-orail`), and the breadcrumb.

### 0.4 · The equivalence gap — **survives, and Part 2 makes it larger**

Worker mode has a list because a node-link diagram needs a text alternative.
Entity mode has 38 nodes, 103 edges and **no table at all**. It survives — and
§2.1 turns it from an accessibility obligation into an argument about which view
should be primary.

---

## PART 1 — What is wrong today, measured

### 1.1 · The entity canvas never got Section 2's geometry fix, and it is the same bug that cost S2R a session

`reference_xyflow_never_measures` records it: *"Seven canvases in this repo use
custom `nodeTypes`; this can hit any of them."* `MapCanvas.tsx` was fixed by
declaring `width` / `height` / `handles`. **`EntityCanvas.tsx` declares none** —
grepped, zero matches.

Today it works, by luck. Same page, same data, same moment:

| | nodes | **edges drawn** | node `visibility` | declared width |
|---|---|---|---|---|
| the real tab | 38 | **103** | visible | — |
| a nested viewport | 38 | **0** | **`hidden`, permanently** | **none** |

That is the S2R signature exactly: the element has a real `offsetWidth` and
carries xyflow's not-yet-measured marker for ever, so `getEdgePosition()` cannot
resolve and every edge is dropped. The canvas renders its relationships only
while xyflow's measurement happens to fire.

**And when it does not fire, the band still says the number.** It reads *"38
things the fleet watches, and **103 links** it worked out between them"* over a
canvas with none. The page states a fact it is not showing.

### 1.2 · The page's own count is the strongest argument against its main view

38 nodes, 103 edges — `COMPETES_WITH` 74, `CANNIBALIZES` 29, `truncated: false`.
Hold that against §2.1.

### 1.3 · What is already right, and must survive

- **The legend's one-source rule holds.** Measured: `rel-competes` swatch
  `rgb(47,93,148)` = edge stroke `rgb(47,93,148)`; `rel-cannibalizes`
  `rgb(197,48,48)` = `rgb(197,48,48)`. The legend lists exactly the relations
  drawn, with counts — S3's convention, and Bloom's.
- **The off-screen marker works**: *"23 of 38 further down — scroll to reach
  them"*, which is the honest statement §2.6 asks for.
- Selection below 1400 already behaves as Section 4 decided — entity mode uses
  `RailShell`, so it reflows with everything else.
- An unresolved id is shown as itself; no node on prod needs it
  (`nodeTypes: ["campaign"]` only), so the case is real but currently unexercised.

---

## PART 2 — What the best tools do

### 2.1 · Above twenty nodes, the picture is the weaker instrument — and this graph has thirty-eight

The controlled experiment everyone cites here is Ghoniem, Fekete & Castagliola:

> "When graphs are bigger than **twenty vertices**, the matrix-based
> visualization outperforms node-link diagrams on most tasks."
> "For small graphs, node-link diagrams are always more readable… for larger
> graphs, the performance of node-link deteriorates quickly while matrices
> remain readable, with a lead of **30% of correct answers**."
> "**Only path finding is consistently in favour of node-link** throughout."

This page runs both cases. **Worker mode is 7 nodes** — below the threshold,
where node-link genuinely wins, and it has a table anyway for accessibility.
**Entity mode is 38 nodes and 103 edges** — well above it, and has *only* the
picture.

So the equivalence gap is not merely an accessibility debt. By the standard
reference, entity mode is presenting its data in the representation the research
says is worse for everything except tracing a path.

**Sources:** [Ghoniem, Fekete & Castagliola — readability of node-link vs matrix](https://www.semanticscholar.org/paper/A-Comparison-of-the-Readability-of-Graphs-Using-and-Ghoniem-Fekete/4effb869de6edd5e6e7e1ec476ab402fa9d28c55) ·
[the IVS 2005 extension](https://journals.sagepub.com/doi/10.1057/palgrave.ivs.9500092)

### 2.2 · Direction in a table

"A takes sales from B" is a directed edge, and a table keeps direction by making
it a column rather than a symbol — the pattern worker mode already uses with
*Feeds it* / *It feeds*. That is the shape to copy, because it is the shape this
page has already committed to.

### 2.3 · Derived relationships, labelled as derived

Data-catalog lineage tools present the diagram as *evidence* — Collibra's framing
is that diagrams "provide clear evidence needed to review all data sources and
transformations… which builds confidence." Notably, **searching for how inferred
relationships surface confidence or evidence turned up nothing** in either
Collibra or Atlan's public material. Our edges carry `properties.on`
(e.g. `kw:giacca moto uomo|EXACT`) — the actual search term the inference rests
on — and the canvas shows none of it.

**Sources:** [Collibra data lineage](https://www.collibra.com/products/data-lineage) ·
[Collibra's diagram UX](https://www.collibra.com/blog/a-better-way-to-visualize-data-relationships-a-new-diagram-user-experience) ·
[Atlan catalog overview](https://atlan.com/collibra/data-catalog-overview/)

---

## PART 3 — The design

### D-S6.1 · Declare the geometry (the only urgent item)

`width`, `height` and `handles` on every entity node, exactly as `MapCanvas`
does. This is not a refactor; it is the difference between a graph that draws
its 103 relationships and one that silently draws none while the band claims
them.

### D-S6.2 · Entity mode gets a table, and the table is the default view

Columns: **Thing · Type · Relation · Counterpart · On** — one row per
relationship, direction carried by the relation phrase ("takes sales from"),
sortable by degree so "which campaign is involved in the most overlap" is one
click. `properties.on` becomes the **On** column: the search term the inference
rests on, which is the evidence §2.3 says a derived edge owes the reader.

**Why default rather than merely available.** §2.1: at 38 nodes and 103 edges
the picture is the weaker instrument for every task except path-tracing, and the
mode's own band already summarises it in a sentence. The graph stays, one click
away, for the task it wins.

### D-S6.3 · The footer clears AA, in both modes

`#8a95a3` → `#55616f`. One declaration; it is page chrome, not entity chrome, so
it is called out rather than slipped in (§0.1).

### ~~D-S6.4 · The frame re-fits when the box changes~~ — withdrawn

See §0.2. The frame already re-fits; my probe could not run the handler because
`requestAnimationFrame` is dead in a backgrounded tab.

### D-S6.5 · The band and legend stay inline — deliberately

Entity mode's band is a different sentence over a different noun, and its legend
is relations rather than buckets. Consolidating them would mean parameterising
two components for one caller each. **Recorded as a decision, not an oversight.**

---

## PART 4 — Two options, and the recommendation

### Option A — table first, graph second *(recommended)*

Entity mode opens on the relationship table; the canvas is behind the same
Map/List switch worker mode already has.

- **Cost:** it demotes the surface's most visually striking asset, and
  path-tracing ("what does this cannibalise, and what does *that* compete with")
  needs a click to reach.
- **Gain:** the equivalence gap closes as a side effect; the mode gains sort and
  scan; the evidence column becomes possible; and it matches what the research
  says about 38-node graphs.

### Option B — repair the graph, add a table beside it

Fix the geometry, add the table as an alternative, leave the graph primary.

- **Cost:** keeps the weaker instrument in front, and keeps paying for canvas
  work — semantic zoom tiers, re-fitting, off-screen markers — on a view the
  evidence says is not the best one for this data.
- **Gain:** smallest change; nothing is taken away from anyone.

### The recommendation

**Option A, and I want to be plain that the honest version of it is "this mode
should be smaller than it is".**

The brief invited that answer and I think the measurements support it. D2 put
entity mode on this page to avoid an eleventh page — a routing decision, not
evidence that an operator needs it daily. Nobody has yet stated what the
operator *does* after learning that two campaigns compete: the mode ends in no
action, links to nothing, and the fleet's own workers already consume these
relations directly.

So the strongest form of Option A is: **a sortable table of derived
relationships, with the search term as evidence, and the canvas kept for
path-tracing.** That is a smaller, more honest surface than a 38-node node-link
diagram with three zoom tiers.

**What I am not proposing:** deleting the mode. The relationships are real, they
are expensive to compute, and they are invisible everywhere else in the product.

---

## PART 5 — What this mode is for, in one sentence

*"These are the overlaps the fleet found in your campaigns — which ones are
bidding against each other, and on which search terms."*

**And the honest caveat, which belongs in front of the operator:** we do not yet
know what you do next with that. Worker mode ends in links to Workers, Activity
and Workflows. This mode ends nowhere. Until someone can name the action, it
should stay small — which is the real argument of Part 4.

---

## PART 6 — Honesty rules · empty states · backend · accessibility

- **The band never claims a number the canvas is not drawing** (§1.1).
- **A derived relationship shows what it was derived from** — the term, not just
  the verb.
- **An unresolved id is shown as itself**, never invented.
- **The legend and the canvas render from one source** — verified holding today.
- **Empty / degenerate:** no relationships yet (already handled, with a good
  sentence); `truncated: true` (does not occur on prod — must be forced before
  shipping any change near it); an entity with no links; a non-campaign node type.
- **Backend: none.** `getEntityGraphOverview` already returns `properties.on`,
  `relationCounts` and `truncated`. As in Sections 4 and 5, the gap is between
  what the endpoint returns and what the page renders.
- **Accessibility:** the table *is* the equivalence answer (§0.4, §2.1); the
  footer fix is 1.4.3; the graph keeps its off-screen marker and its
  visually-hidden names.

---

## PART 7 — What this section must never become

- **A second Products or Campaigns page.** It shows derived relationships and
  nothing else.
- **A canvas that grows features to justify itself.** Three zoom tiers is
  already more machinery than a 38-node graph earns.
- **A place that states a count it is not drawing.**

---

## PART 8 — Build order

| phase | change | exit criterion |
|---|---|---|
| **S6.a** | declare node geometry (D-S6.1) | edges drawn in the real tab **and** in a nested viewport; count matches `relationCounts` |
| **S6.b** | footer contrast, both modes (D-S6.3) | 0 failures sweeping `.sbm-page`, worker **and** entity |
| **S6.c** | the relationship table (D-S6.2) | every edge in the payload is a row; direction and evidence readable |
| **S6.d** | table becomes the default view (D-S6.2) | switch remembers, URL carries it |
| **S6.f** | the mode itself goes in the URL | `?mode=entities` and `?ev=map` both round-trip |
| **S6.g** | the table tells the truth when capped | forced `truncated: true` and the footer agrees with the band |
| **S6.h** | every declared relation has an edge colour | forced `VARIANT_OF`; swatch, meter and stroke agree |

`S6.a` first: it is a correctness defect, it is three lines, and it is the same
fix a previous section already proved. **S6.f was not planned** — it was found
by verifying S6.d, see §10.2.

---

## PART 10 — Verified on production

### 10.1 · What the exit criteria measured

| phase | measurement | result |
|---|---|---|
| **S6.a** | real tab | 38 nodes · **103 edges** · 0 hidden |
| **S6.a** | **nested viewport** (0 edges before the fix) | 38 nodes · **103 edges** · 0 hidden |
| **S6.b** | `.sbm-foot` colour | `rgb(85,97,111)` = `#55616f` |
| **S6.c** | rows in the relationship table | **103** — one per edge, matching the band |
| **S6.d** | arrival view | Table, `aria-checked="true"` |

The nested-viewport row is the one that matters. That environment is what
exposed the defect — 0 edges and 38 permanently-hidden nodes — and it is the
environment in which the fix had to be proved, not merely the one where the bug
never showed.

### 10.2 · Verifying S6.d found a defect in S6.d

Entity mode had **no representation in the URL at all**. `view`, `window`,
`colour`, `worker`, `edge`, `thing` were all carried; the worker/entity switch
was not. Only `thing` implied entity mode, and `thing` requires a selection — so
entity mode with nothing selected could not be linked.

Which made the `ev` param S6.d had just added a URL that does not come back.
Measured, on production, on a URL **the page wrote itself**:

```
click "What they watch" → "Graph"   page writes  ?ev=map
reload exactly that                 lands in     WORKER mode, 7 nodes
                                    url now      ""   ← the writer erased it
```

`S6.f` adds `mode=entities`, the same shape `view=list` already uses. Worker
mode stays bare because it is the default.

That is the second time in this section that the verify step found a defect the
commit before had introduced, and the sixth across Sections 4–6.

Verified after the fix: `?mode=entities&ev=map` lands in entity mode, Graph
selected, both params preserved, 38 nodes and 103 edges drawn.

### 10.3 · Forcing the two states prod cannot reach — both were hiding a defect

Part 1 flagged two states the fleet's data never produces. Neither was
hypothetical.

**`truncated: true`** — patched the entity-graph fetch to cap at 40 links. The
screen said two things about one number:

```
band    "Capped, so it shows the strongest links first"
table   "One row per relationship the fleet derived — 40 of them"
```

The band was honest; the footer I had shipped in S6.c presented a capped view as
the whole set. **That is the defect S6.a fixed** — a surface stating a fact it is
not showing — reintroduced by the surface added to replace it. Fixed in S6.g.

**A relation with no rows** — the vocabulary declares eleven classes and
`map.css` coloured seven edges. `VARIANT_OF` is emitted by
`entity-graph.service.ts`, so the gap was reachable. Relabelled a third of the
edges and measured:

| surface | colour |
|---|---|
| legend swatch | `rgb(183,203,228)` `#b7cbe4` |
| meter segment | `rgb(183,203,228)` `#b7cbe4` |
| **edge stroke** | **`rgb(195,204,216)` `#c3ccd8`** — the fallback |

Measured beside `rel-competes` and `rel-cannibalizes`, which matched exactly.
**The one-source rule held everywhere it had ever been exercised, and nowhere it
had not** — which is precisely why §1.3's "the legend's one-source rule holds"
was true and still incomplete. Fixed in S6.h.

The method point: forcing is not a formality for empty states. Two forced
payloads, two real defects, one of them mine from an hour earlier.

---

## PART 9 — A measurement error of my own, recorded because it nearly shipped

My first probe reported **0 edges** in the real tab and I was one step from
writing "the relationship graph draws no relationships" as the headline. It was
wrong: I counted `.react-flow__edge`, which this canvas does not use — it wraps
each edge in its own `<svg>` with `.sbm-eedge`. The correct count was 103.

The screenshot is what caught it. The lines were plainly there.

Two rules, both of which this engagement has now paid for twice:
**verify that a selector matches before trusting a count of zero**, and
**look at the pixels alongside the probe** — a wrong selector and a
`text-overflow: clip` truncation fail in exactly the same way, by returning a
confident number about the wrong thing.

*Sources cited inline in Part 2. Measurements: production, 2026-08-10; canvas
measured in the real tab and a nested viewport; contrast measured per region and
at page level.*
