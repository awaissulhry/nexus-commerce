# NAF.SB.M-S4R — Section 4, the inspector rail: a measured audit and a rebuild

*The right rail: the fleet at a glance, a worker, a handoff — and the two entity
states currently written somewhere else.*

Code: `app/fleet/map/InspectorRail.tsx`, the entity-mode rail block inside
`MapClient.tsx`, and the `.sbm-rail*` / `.sbm-row*` / `.sbm-drops` /
`.sbm-samples` rules in `map.css`.

Measured on production 2026-08-10 at 1512×793 unless another viewport is named.
Most of this rail's content cannot occur on a fleet that is switched off, so the
states below were **forced with a synthetic payload** — Section 3's method — and
production was restored afterwards. Breakpoints were measured in a real nested
viewport.

**Status: study only. No code has been written.**

---

## PART 0 — What this section is for

The canvas shows the shape of the fleet. The rail is where a shape becomes a
fact: who this worker is, what it is allowed to do, what it has done — and, on
an edge, **what the director carried and what it refused to carry, in the words
it wrote at the time.** That last panel is the only place in the ten fleet pages
where the handoff is legible at all. No roster, timeline or cost page holds it.

So this section has one job above the others: make the most valuable panel on
the page reachable, readable, and honest. Today it is none of the three below
1400px, and only partly the second anywhere.

---

## PART 1 — What is wrong today, measured

### 1.1 · Selection has nowhere to go below 1400 — and the page pretends otherwise

This is the headline, and it is worse than "the rail is hidden".

Measured in a real 1280×800 viewport, with `?worker=amazon-bid-tuner` in the URL:

| | |
|---|---|
| URL still carries the selection | **yes** |
| card still painted **selected** on the canvas | **yes** — 1 node with the blue ring |
| `.sbm-rail` display | **`none`** |
| detail visible anywhere on the page | **no** |

Identical at 1399, 1280 and 1100. So the page **acknowledges the click** — the
card lights up, the URL changes, the browser history moves — and then shows
nothing. That is not a responsive compromise; it is a control that reports
success and does nothing, which is worse than a control that is absent.

And half the selections have no fallback even in principle: a worker has
`/fleet/workers/[key]` to fall back to, **a handoff has no page anywhere**. The
one thing this page uniquely shows is the one thing that cannot be sent
somewhere else.

### 1.2 · The rail has never been contrast-checked, in any state

Section 2 swept the canvas and header; Section 3 swept the overlay rail to 0 of
25. **The inspector rail is a different component and has never been swept.**
Every colour measured against its resolved background:

| state | text nodes | **failing AA** |
|---|---|---|
| the fleet at a glance *(live, dark fleet)* | 23 | **16** |
| the fleet at a glance *(forced, six statuses)* | 23 | **13** |
| a worker | 35 | **21** |
| a handoff, finding edge with drops | 39 | **18** |
| a handoff, plan edge | 17 | **9** |
| entity mode, nothing selected | 4 | **4** |
| entity mode, a thing selected | 29 | **15** |

Three colours account for nearly all of it:

| colour | measured | where |
|---|---|---|
| `#9aa5b3` | **2.50:1** | every `h4` section heading · every `.sbm-dim` · the roll-up's meta line · the monospace key |
| `#8a95a3` | **3.04:1** | `.sbm-row .k` — every field label · `tone-neutral` status words |
| `#7d879a` | **3.62:1** | the panel title · `.sbm-rail-hint` · `.sbm-rail-note` |

`.sbm-dim` at 2.50:1 is not decoration. Measured, it is carrying:

- `· cannot go above OBSERVE` — the **safety ceiling**
- `· 2 critical, 9 high, 12 medium, 6 low, 2 info` — the whole severity breakdown
- `· $0.0242 ever` — lifetime spend
- `nothing — it starts the chain` / `nothing — it is the end of the chain`

The faintest text in the panel is where the safety facts live.

*(Also measured and **not mine**: `<Term>`'s trigger text renders at 2.50:1 via
`.acr-term` in `control-room.css`, a shared file. Raised in §10, not touched.)*

### 1.3 · The way out is below the fold, in every state

`.sbm-rail-body` is `overflow-y: auto` behind a macOS overlay scrollbar — the
same invisible-until-you-scroll container Section 3 found in the overlay rail.

| state | content vs box | **`.sbm-rail-exits` visible** |
|---|---|---|
| a worker *(live)* | 115px hidden | **0 of 51.5px** |
| a worker *(31 findings)* | 161px hidden | **0 of 51.5px** |
| a handoff, 5 drops | **988px in a 529px box — 46.5% hidden** | **0 of 28.3px** |

The links to the worker's profile and to Activity — the rail's entire reason for
ending in links rather than growing tabs — are **never on screen** when there is
anything to read. With five dropped items the panel hides 459px; a real director
drops more than five.

### 1.4 · The panel drops three things the endpoint already returns

Not missing data. Data on the payload, rendered nowhere:

- **`node.approvals.waiting` / `.scheduled`.** Forced a worker with **4 waiting,
  1 scheduled**; the panel says nothing — `mentionsApprovals: false`. Something
  waiting for a human is the most actionable fact a worker can have, and the
  panel is silent about it.
- **`node.plans.authoredWindow` / `.verdictsWindow`.** 3 plans authored, 2
  passed, 1 sent back. Silent.
- **`edge.conflicts[]`.** The panel *does* print `In conflict = 3` — and the
  array explaining those three (`findingIds`, `kind`, `resolution`) is rendered
  nowhere. **It shows a count whose meaning it is holding and not printing.**

### 1.5 · The rail and the canvas answer the same question differently

For one paused worker, at one moment, on one screen:

| surface | says |
|---|---|
| canvas card | word **"Paused"**, bucket `ov-off` |
| overlay legend | **"Held at off"** |
| **inspector rail**, under the heading *What it may do* | **"Autonomy: OBSERVE · at its ceiling"** |

The rail's reason line does say *"Paused until 11 Aug — 'held while we check the
bid floor'"*, so the panel is not lying overall. But the row **labelled with the
question** answers `OBSERVE` when the true answer to *what may it do right now*
is *nothing*. `overlays.ts` exists to prevent exactly this — its own comment
says a node tinted from `autonomyLevel` alone "would paint a paused worker as
armed". The canvas honours that rule. The rail does not.

### 1.6 · Three different problems, one word, separated only by hue

Forced a failed run, a limit-stopped run and a degraded charter. The roll-up:

| worker | word | tone | on white |
|---|---|---|---|
| Negative miner *(last run errored)* | **Needs attention** | `tone-bad` | 5.47 |
| Keyword harvester *(stopped at a limit)* | **Needs attention** | `tone-warn` | 3.64 |
| Plan critic *(settings unreadable)* | **Needs attention** | `tone-bad` | 5.47 |

Same word for three unrelated conditions; red vs amber is the only thing
separating "it broke" from "a safety limit did its job". Their greyscale
separation is **1.50:1**, and WCAG credits lightness as a second channel only at
3:1. This is the same failure Section 3 fixed on the autonomy ramp, in a
different component — and here the fix is cheaper, because a roll-up row has
room for a cause.

### 1.7 · A stale deep link says nothing at all

`?worker=deleted-thing`, measured:

- panel title reverts to **"The fleet at a glance"**
- body renders the normal *"Select a worker…"* hint
- **the close button is rendered** — a control to clear a selection that does not exist
- **nothing anywhere says the worker is missing** (`/no longer|not found|gone/` → no match)
- the URL keeps `?worker=deleted-thing`, so a reload or a share repeats it

The selection is truthy and unresolvable, and the component's ternary chain
silently treats that as "nothing selected".

### 1.8 · The plan panel is titled for something it explicitly is not

The rail's title is hardcoded `'Handoff'` for any edge. On the plan edge the
body then says: *"The critic does not write an artifact — it records a verdict
on the plan itself, so there is nothing to count crossing here."* Header and
body contradict each other on screen.

Worse, the asymmetry underneath: the finding edge's centrepiece is **"Why it
dropped them"** in the director's own words. The plan edge prints
`Blocked = 1` and `Most recent = block · 3 items blocked` and **never says why**
(`/reason|because|why/` → no match). A block is the most consequential verdict
on the page. The reason is not on the payload — `lastCritique` carries only
`planId`, `verdict`, `blockedCount` — so this one needs the backend (§7).

### 1.9 · Entity mode is a second rail with different rules

Written inline in `MapClient.tsx` rather than in the rail component, and it has
drifted:

| | worker/edge rail | entity rail |
|---|---|---|
| close button | yes | **never rendered** |
| Escape clears it | yes | **no** — measured, still selected after Escape |
| selection in the URL | `?worker=` / `?edge=` | **not in the URL at all** |
| panel title | "Worker" / "Handoff" | **"Thing"** |
| contrast failures | — | **4 of 4** empty · **15 of 29** selected |

So in entity mode a selection cannot be cleared by keyboard at all, and cannot
be shared or restored.

### 1.10 · Keyboard, focus and announcement

- **Not one `:focus-visible` rule exists for anything in this rail.** Grepped
  every stylesheet for `focus` × `sbm-rail|sbm-row|sbm-drops|sbm-samples|sbm-linkbtn`
  → **none**. The seven roll-up buttons, the wiring link-buttons, the close
  button and the exit links all fall back to the UA ring, on a page where
  Sections 1–3 established explicit ones.
- **The rail has no live region.** The page has exactly one (`role="status"` on
  the census band's sub-line) and it does not cover the rail — so when the entire
  panel swaps on selection, a screen-reader user hears **nothing**.
- Roll-up hit targets are fine: **314 × 50.8px**, all ≥24.
- `prefers-reduced-motion` does not touch the rail; its only transition is
  colour, which is not motion. No change needed.

### 1.11 · What is already right, and must survive

- **Docked, never floating**, with the reason written in the file header —
  Camunda shipped node details as a popover over the diagram and reversed it.
  The graph does not move, re-centre or re-zoom on selection. **Verified**: 4
  edges and a stable 0.643 zoom across every selection change measured.
- **Read-only.** Every control changes what you are looking at or navigates.
- **It ends in links** rather than growing tabs.
- **Two controls stay unrendered on purpose** — `scopeCampaignIds` binds nothing
  and `scopePortfolioIds` is enforced nowhere; `scope-filter.ts:6-7` says a
  control that is not enforced must not be rendered. Keep them out.
- `.sbm-row .v` already carries `min-width: 0` + `overflow-wrap: anywhere`, with
  the reason in a comment. The 108px key column does not clip any current key
  (longest, "Open findings", fits exactly).
- The dropped-reason blocks **wrap rather than clip** — a 361-character verbatim
  renders 8 lines tall, fully.
- `deriveStatus` always carries a reason, and the panel always prints it.

---

## PART 2 — What the best tools do

### 2.1 · The narrow-viewport question — and it has a settled answer

Cloudscape's split panel is the closest analogue in a mature system, and its
guidance is unambiguous:

> "On small viewports the panel moves to the bottom of the screen. **This allows
> for interaction with the content and the panel.**"

The reason is the whole argument: at a narrow width you must still be able to
work with *both*. Cloudscape goes further and treats position as a user
preference — "There are two positions of the panel: bottom and side… **We
strongly recommend implementing both positions and allow users to change the
default position**" — with side for "a small set of content for users to browse"
and bottom when you need horizontal room.

Material 3 names the same move as one of three adaptive strategies — *show and
hide, levitate, and reflow* — and puts side sheets on large screens, bottom
sheets on small.

Nobody in the surveyed set answers "hide it".

**Sources:** [Cloudscape secondary panels](https://cloudscape.design/patterns/general/secondary-panels/) ·
[Cloudscape split view](https://cloudscape.design/patterns/resource-management/view/split-view/) ·
[Material 3 layout](https://m3.material.io/foundations/layout/layout-overview/adaptive-design) ·
[Material 3 side sheets](https://m3.material.io/components/side-sheets)

### 2.2 · One shell, three states — including "the graph as a whole"

Kiali is the closest product to this page and does exactly what this rail does:

> "The **collapsible** side-panel summarizes the current graph selection, **or
> the graph as a whole**."
> "A single-click will select the node, edge, or box of interest."

One panel, one shell, contents switching by what is selected — and the
nothing-selected state is a *summary*, not an empty state. That is our Overview,
and it is the right pattern rather than an indulgence.

**Source:** [Kiali topology](https://kiali.io/docs/features/topology/)

### 2.3 · What belongs in the panel, and what belongs behind a link

Cloudscape is categorical:

> "**Always use details pages to display full resource details of a single
> resource. A split view should never replace details pages** in the service
> information architecture."

Kiali's panel likewise ends in "**Links** to fully-detailed pages". Our
"never a second worker page" rule is the industry position, not a local
preference — which also means the links have to be *reachable* (§1.3).

### 2.4 · The nothing-selected state

> "When nothing is selected, display the empty state: a line of text informing
> users why the panel is empty and suggesting they make a selection to view more
> content." — Cloudscape

Ours does that **and** lists the seven workers. Kiali's summarises the whole
graph. Both are defensible; what is not defensible is an empty state that only
apologises. Ours earns its space.

### 2.5 · Keeping selection legible in both directions

> "The content in the split panel should always reflect the selected resources.
> When a resource is deselected, remove its details from the split panel."

The corollary is the one we fail: if the selection cannot be resolved, the panel
must not silently render as though nothing were selected (§1.7). General
empty-state practice is explicit that a dead end needs a way forward — *always
provide an action; if none is possible, link somewhere that helps.*

**Source:** [Carbon empty states](https://carbondesignsystem.com/patterns/empty-states-pattern/)

### 2.6 · Collapsibility

Kiali's panel is collapsible; Cloudscape's has an explicit control — "Users can
use the **angle-down** icon button to collapse the panel… Once users close the
details panel, it stays closed even if they change the resource selection."

Ours takes 340px unconditionally and offers no way to get it back.

### 2.7 · Long verbatim text in a narrow column

Nothing in the surveyed set truncates an explanation to a fixed character count
in a panel this narrow; they wrap and scroll. Our drop blocks already wrap
correctly. The failure is not the text — it is that the container hides 46.5% of
itself with no visible scrollbar and no count telling you how much there is.

### 2.8 · Panels that must not be modal

Camunda's reversal — node details from a popover over the diagram to a docked
panel — is already cited in our file header, and it is the reason a modal is
wrong at *any* width: the graph is the thing you are reasoning about, and a
sheet over it removes the context that made the detail meaningful.

---

## PART 3 — The design, with the reason under each decision

### D-S4.1 · Below 1400 the panel reflows to the bottom of the canvas column

It stops being a third grid column and becomes a panel under the canvas, full
width, with the same shell and the same contents.

**Why.** It is the only option that keeps the graph visible *and* works for
edges, and it is what the mature systems do at exactly this moment
(§2.1). At ≤1100 the page already scrolls (S3.n), so a panel below the canvas is
the natural reading order rather than a new mechanism. Full width also *helps*
the two panels that suffer most in 340px: the drop reasons and the roll-up.

Not a modal — §2.8. Not "navigate to the worker page" — there is no page for a
handoff.

### D-S4.2 · The rail collapses, at every width, and remembers

A header control collapses the panel to a narrow strip; the strip says what is
selected and restores on click. Selecting something while collapsed does **not**
force it open — Cloudscape's rule, and it is right: a reader who has deliberately
made the graph wide should not have it taken back by their next click.

**Why.** 340px unconditionally is the second-largest thing on the page after the
canvas, and there are real tasks — tracing a chain, reading the lanes — where the
graph is what you want. Kiali and Cloudscape both ship this.

### D-S4.3 · The exits stop scrolling away

`.sbm-rail-exits` moves out of the scrolling body and pins to the bottom of the
panel, above the panel's edge, always visible.

**Why.** §1.3: measured at **0 of 51.5px visible** in every state that has
content. The rail's entire architecture is "it ends in links"; links you can
only reach by scrolling an invisible scrollbar are not an ending, and the
architecture quietly depends on them.

### D-S4.4 · Every colour in the rail clears AA

The three greys go to the tokens Sections 1–3 established: `#55616f` (6.31:1 on
white) for labels, dim text and section headings; `#45505f` (8.18:1) where the
text is a value rather than a label. Nothing in this panel is decoration.

**Why.** 83 failures across six states, and the faintest text is carrying the
autonomy ceiling and the severity breakdown.

### D-S4.5 · The panel says what is waiting for a human

A row for approvals — `4 waiting · 1 scheduled` — and a row for what it produced
(`3 plans · 2 passed, 1 sent back`), both from fields already on the payload.

**Why.** §1.4. A worker with proposals waiting is the only state on this page
that asks the operator for something, and the panel currently cannot say so.
**This does not make the rail a worker page**: it is two rows of numbers already
in the response, and both end at the existing links.

### D-S4.6 · "What it may do" answers the question it asks

The autonomy row states the **effective** answer first and the dial second:
*"Nothing right now — paused until 11 Aug. Dial is at OBSERVE."* When nothing
overrides it, it reads as it does today.

**Why.** §1.5. Two surfaces on one screen currently answer one question two
ways, and the canvas's answer is the correct one. The rail should not re-derive
the rule — it should read the same bucket the canvas paints from, so they cannot
diverge. That is the legend/canvas one-source rule applied to a third surface.

### D-S4.7 · The roll-up names the cause, not just the severity

`Needs attention` gains a cause clause from the status the shared module already
computes: *Needs attention · last run failed* / *· stopped by a limit* /
*· settings unreadable*.

**Why.** §1.6. Three unrelated conditions currently share one word and are
separated by a 1.50:1 hue difference. The words exist; only the rendering
flattens them.

### D-S4.8 · A selection that cannot be resolved says so

When `selection` is set and neither a node nor an edge matches, the panel says
which key was asked for, that it is not on this map, and offers the two ways
forward (clear the selection; open Workers). The close button belongs to that
state, not to the summary.

**Why.** §1.7. Today a dead link is indistinguishable from no selection, and the
URL keeps repeating it. Every empty-state guideline in §2.5 says a dead end needs
a way forward.

### D-S4.9 · The conflict count gets the detail it is already holding

`In conflict = 3` becomes expandable to the `conflicts[]` the payload carries —
which findings, what kind, and how it was resolved (or that it was not).

**Why.** §1.4. Printing a count while holding its explanation is the same defect
class as a legend that disagrees with its graph.

### D-S4.10 · The panel is titled for what it is

`Handoff` for a finding edge; **`Review`** for the plan edge, whose body already
explains that nothing crosses it.

### D-S4.11 · Entity mode uses this component, not a copy

The two entity states move out of `MapClient.tsx` into the rail: same shell,
same close button, same Escape, same URL round-trip (`?thing=`), and a title
better than "Thing".

**Why.** §1.9 is four behavioural divergences and 19 contrast failures that exist
only because the states were written somewhere else. One shell means one set of
rules.

### D-S4.12 · Focus, and one announcement

A `:focus-visible` ring on every control in the rail, matching the page's. And
**one** `aria-live="polite"` region for the panel — not several — announcing what
was selected when the contents swap.

**Why.** §1.10: currently zero focus rules and zero announcement.

---

## PART 4 — Two options for the narrow viewport

### Option A — reflow to the bottom *(recommended)*

Below 1400 the rail becomes a full-width panel under the canvas.

- **Cost:** the canvas gets shorter when something is selected — at 1280×800 the
  canvas is 394px today and a 260px panel would leave ~130px. So the panel must
  be collapsible (D-S4.2) and, below 1100 where the page already scrolls, it can
  simply extend the page instead of stealing canvas height.
- **Gain:** the graph stays visible; edges work; full width suits the drop
  reasons better than 340px ever did; no new mechanism at ≤1100.

### Option B — an overlay drawer from the right

Below 1400 selection opens a drawer over the canvas.

- **Cost:** it occludes the graph — the exact thing Camunda reversed and this
  file's own header cites as settled. It also needs a focus trap, a scrim, and
  an Escape contract that competes with the page's existing Escape precedence.
- **Gain:** the canvas keeps its full height; the panel keeps its 340px shape at
  every width, so one layout serves both.

### The recommendation, and why

**Option A.** The deciding argument is not screen real estate, it is what the
panel is *for*: you read a handoff **against** the graph — which analyst fed
which director, and what it refused. A drawer that covers the graph makes the
detail less useful exactly when the screen is smallest. Cloudscape names the
same reason in one sentence — the bottom position "allows for interaction with
the content and the panel".

Option B's advantage is real but smaller, and D-S4.2's collapse control recovers
most of it.

---

## PART 5 — Honesty rules for this section

1. **The panel never answers a question differently from the canvas.** Where
   both show a worker's state, both read the same derived value.
2. **A count is never shown without its meaning being reachable.**
3. **A selection that cannot be resolved is said, not swallowed.**
4. **The rail never becomes a second worker page.** It ends in links, and the
   links stay on screen.
5. **A control that is not enforced is not rendered** — `scopeCampaignIds` and
   `scopePortfolioIds` stay out.
6. **Colour is never the only channel** — a failure and a safety limit differ in
   words.
7. **The graph does not move when the selection changes**, at any width, in any
   layout.

---

## PART 6 — Empty and degenerate states

| state | what the rail does |
|---|---|
| nothing selected | the roster — summary, not apology (§2.4) |
| **selection unresolvable** | names the key, says it is not on this map, offers two ways out (D-S4.8) |
| worker never run | "never run" — already correct, keep |
| worker with no wiring | "nothing — it starts the chain" / "…end of the chain", kept, at readable contrast |
| edge with zero carried | measured today: renders correctly with no drops section |
| edge with no drops | the centrepiece section is omitted rather than shown empty — correct today |
| plan edge with no verdicts | "Nothing has been reviewed yet." — correct today |
| **plan edge with a block** | must say why once the backend carries it (§7); until then, say plainly that the reason is not recorded |
| entity mode, nothing selected | the explanatory paragraph, at readable contrast |
| collapsed | strip states what is selected; selecting again does not force it open |

---

## PART 7 — The backend this section needs

**One field, and it is the only one.** `lastCritique` carries `planId`,
`verdict` and `blockedCount` — but not the critic's reason. §1.8: the finding
edge explains every drop in the director's own words, and the plan edge cannot
explain a **block**, which is the more consequential verdict.

Everything else in Part 3 is already on the payload: `approvals`, `plans`,
`conflicts[]`, and the derived status the roll-up needs.

---

## PART 8 — Accessibility and interaction

- **1.4.3** — 83 failures across six states → 0 (D-S4.4).
- **1.4.1** — "Needs attention" gains a cause, so a failure and a limit stop
  being distinguished by hue at 1.50:1 (D-S4.7).
- **2.4.7** — a focus ring on every control in the rail; there are currently none.
- **4.1.3** — one polite live region announcing the selection change.
- **2.1.1** — Escape clears the selection in entity mode too (currently it does
  nothing there).
- **1.4.13** — no hover-only content is added; `Def`/`Term` used only where a
  definition genuinely belongs, and checked against `overflow` ancestors.
- **2.5.8** — roll-up targets already 314 × 50.8px; the collapse control must
  clear 24×24.

---

## PART 9 — What this section must never become

- **A second worker page.** No tabs. It ends in links.
- **A modal.** The graph is the context that makes the detail mean anything.
- **A place that re-derives status.** It reads what the canvas reads.
- **A form.** The map is read-only; nothing here writes.
- **Two rails.** Entity mode uses this component or it drifts again.

---

## PART 10 — Raised for decision, not taken

### C-S4.1 · Should this rail carry the handoff count, if C15 moves it off the edge?

**The premise no longer holds, and that is the honest answer.** Section 3
retired C15 rather than resolving it: measured at five viewports, the converging
edge labels have **zero pairwise overlap**, 13.8px minimum gap, no truncation —
because S2R's own shortening of `4 carried · 1 dropped` to `4 carried` had
already fixed it. Nothing needs to move off the edge.

**If it ever did, my answer is still no for the count and yes for the detail.**
The count belongs on the target node's badge, where it needs no selection to be
read. This rail already carries the *explanation* — what crossed, what was
dropped and why — and that is the right division: the edge label is a
measurement you see at a glance, the rail is the account you open. Putting the
count here would mean the number is only visible after a click, which is a
worse place than where it is now.

**Presented; the operator decides.**

### C-S4.2 · `.acr-term` renders at 2.50:1, on a shared file

Measured in the edge panel: the `<Term>` trigger for "handoff" is 2.50:1.
`control-room.css` is shared and `<Term>` appears on nineteen files, so a fix
lands well beyond this page. **Raised, not touched.**

### C-S4.3 · Below 1400 there is currently no inspector at all

Shipped deliberately in S3.i with the consequence stated, and D-S4.1 is the
resolution. Noting it here so the two studies do not disagree: S3 accepted the
loss as the right trade *at the time*, on the grounds that 340px of panel does
not fit beside a graph at 1280. Option A is how it stops being a loss.

---

## PART 11 — Build order

Each phase is one shippable unit: DS ratchet, `tsc`, vitest, push, then verify on
production — with a forced payload for any state a dark fleet cannot reach.

| phase | change | exit criterion, measured on prod |
|---|---|---|
| **S4.a** | contrast, all three greys (D-S4.4) | 0 failures in all six states, forced |
| **S4.b** | exits pin; body scrolls beneath them (D-S4.3) | exits fully visible in every state incl. 5-drop edge |
| **S4.c** | unresolvable selection (D-S4.8) | `?worker=deleted-thing` names the key and offers two exits |
| **S4.d** | roll-up causes + effective autonomy (D-S4.6/7) | no two roll-up rows share a word with different tones; rail and canvas agree on a paused worker |
| **S4.e** | approvals, plans, conflicts (D-S4.5/9) | forced payload renders all three; no new links |
| **S4.f** | focus rings + one live region (D-S4.12) | every control has a ring ≥3:1; one `aria-live` in the rail |
| **S4.g** | collapse control (D-S4.2) | collapses at every width; selecting while collapsed does not reopen |
| **S4.h** | **reflow to the bottom below 1400** (D-S4.1) | at 1280 and 1100: selection shows detail, canvas still visible, graph does not move |
| **S4.i** | entity states into the component (D-S4.11) | close button, Escape, URL round-trip, 0 contrast failures |

`S4.h` late on purpose: it is the largest layout change and every phase before it
makes the panel it reflows better. `S4.a` first because it is the widest and
cheapest win.

---

*Sources cited inline in Part 2. Measurements: production, 2026-08-10, viewport
1512×793; breakpoints in a same-origin nested viewport; states that cannot occur
on a switched-off fleet were forced with a synthetic payload and production
restored afterwards.*
