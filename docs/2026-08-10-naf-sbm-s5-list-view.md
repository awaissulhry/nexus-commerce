# NAF.SB.M-S5R — Section 5, the list view and the URL contract: a measured audit and a rebuild

*The same graph as a table, and the thing that makes a link worth sending.*

Code: `app/fleet/map/ListView.tsx`, the URL effects and `view`/`window` state in
`MapClient.tsx`, and the `.sbm-list*` rules in `map.css`.

Measured on production 2026-08-10 at 1512×793 unless another viewport is named.
Breakpoints in a real nested viewport; states a switched-off fleet cannot reach
were forced with a synthetic payload and production restored afterwards. The URL
findings were measured with a **network trace**, not inferred from what the page
rendered.

**Status: study only. No code has been written.**

---

## PART 0 — The inherited raises, re-measured first

The brief asks for this before anything else, because four raises this
engagement dissolved when someone finally measured them. Here is what survived.

### 0.1 · The `?window=` raise **survives — and it is much bigger than it was written down as**

It was recorded as *"loading `?window=24h` shows the default window's data — a
**startup flash** on shared links, converging on the next poll tick."*

The startup half reproduces exactly. Cleared the network trace, reloaded
`?window=24h&colour=cost&view=list`, and the **first and only** request was:

```
GET /api/agent/fleet/map?window=7d      ← the default, while the URL says 24h
```

But the raise stopped one question too early. **Clicking the window switch fires
no request at all.** Measured twice, with a cleared trace each time:

| action | requests fired |
|---|---|
| click **30 days** | **0** |
| click **all time** | **0** |

The switch label updates, the URL updates, and the `as of` stamp stays frozen at
its old value. So this is not a deep-link edge case — **the page's primary
control does not fetch**, and every number on screen continues to describe
whatever window was last actually retrieved. The deep link is one symptom; the
everyday click is the other, and nobody had measured it.

On a *visible* tab the 10-second poll eventually corrects it, because
`loadRef.current` closes over the current `windowKey`. So the honest severity is
**"silently wrong for up to ten seconds, every time you change the window"** —
not permanent, and not a flash either.

**Cause, confirmed:** `useVisibilityPoll` keeps `load` in a ref
(`loadRef.current = load`) behind a `useCallback([], …)` tick, so its effect runs
exactly once and a changed `windowKey` triggers nothing. That ref pattern is
correct — it stops the interval restarting on every render — it simply has no
companion for "the input changed, fetch now".

### 0.2 · Every other URL parameter is fine, and the reason is structural

Measured `?colour=cost&worker=amazon-ads-director`:

| | |
|---|---|
| colour picker | **"What it cost"** |
| canvas buckets | `ov-cost3`, `ov-cost2`, `ov-nodata` — cost applied |
| rail | **"Worker"**, Amazon Ads director resolved |
| selected on canvas | 1 |

`?view=list` likewise applies. **Only `window` participates in the fetch**;
`colour`, `view`, `worker` and `edge` are client state applied to a payload that
has already arrived, so no race can exist for them. That is worth stating
because it bounds the fix: one parameter, one mechanism.

### 0.3 · A raise I might have created in S4 does not exist

S4.c added a "Not on this map" panel for an unresolvable selection. The obvious
risk is that a **valid** deep link shows it while the payload is still loading —
`selection` set, `nodes` empty.

It cannot happen: `MapClient` renders the body only when `data != null` **and**
`nodes.length > 0`; before that it is a skeleton. Checked before designing
anything around it.

---

## PART 1 — What is wrong today, measured

### 1.1 · The list has never been contrast-checked either — and it is the worst-placed failure yet

Section 2 swept the canvas, Section 3 the overlay rail, Section 4 the inspector
rail. This is the fourth surface and the pattern holds.

| | live fleet | forced |
|---|---|---|
| text nodes measured | 72 | 72 |
| **failing AA** | **24** | **26** |

| colour | measured | count | where |
|---|---|---|---|
| `#9aa5b3` @13px | **2.50:1** | **20** | `.sbm-listdim` |
| `#9aa5b3` @11px | **2.31:1** | 1 | `.sbm-viewhint` |
| `#8a95a3` @11px | **3.04:1** | 3 | `.sbm-listfoot`, two `<b>` |
| `#b7791f` @13px | **3.64:1** | 2 | `.sbm-liststatus.tone-warn` — *only reachable when something is paused or limited* |

**Look at what `.sbm-listdim` is carrying at 2.50:1**, twenty times over: the
**Role** column, and the adjacency column's own sentences — *"starts the chain"*
and *"ends the chain"*. The faintest text in the table is the answer to the
question the table exists to answer.

### 1.2 · The list is no longer an equivalent alternative to the canvas

This is the section's real problem. WCAG's requirement is not "a table exists"
but that the alternative *"serves a purpose **equivalent**"*, and for a complex
image, *"a **complete text equivalent** of the data or information provided"*.

What a canvas card carries today, after Sections 2–4, against what the table
carries:

| on the card | in the table |
|---|---|
| name | **Worker** |
| self-test tag | in the Worker cell |
| status glyph + status word | **Status** |
| **autonomy token** — *may look / may propose / may act* (S3.j) | **— nothing** |
| tier | **Role** |
| runs · open · spent (three fixed slots) | **Open findings**, **Spend** — no runs count |
| **lane container** — *"Runs as part of the nightly job"* | **— nothing** |
| the overlay colour (what it may do / how it went / what it cost) | **— nothing** |
| `sr-only` wiring sentence | **Feeds it** / **It feeds** ✓ |

Three losses, and they are not cosmetic:

- **Autonomy.** S3.j added the level in words to the card *specifically because
  colour alone failed SC 1.4.1*. The table never had it. So the page's default
  question — *what is each worker allowed to do?* — is answerable in the picture
  and unanswerable in its text alternative.
- **Lane.** Section 2 made the lane a real container saying *"Runs as part of
  the nightly job — not a step of any routine"*. That is a structural fact about
  how a worker is invoked, and the table has no column for it.
- **The colour dimension.** The overlay rail is deliberately not rendered in
  list view — the reasoning in `MapClient` is sound (*"a legend for tints the
  table does not use"*) — but the consequence is that one of three questions the
  page can ask simply does not exist here.

### 1.3 · Three different problems, one word — the same defect S4 fixed, still live here

Forced a failure, a limit and a degraded charter. The Status column:

| worker | status | tone |
|---|---|---|
| a failed run | **Needs attention** | `tone-bad` |
| stopped at a limit | **Needs attention** | `tone-warn` |
| settings unreadable | **Needs attention** | `tone-bad` |

Identical words; red versus amber is the only separator, and the two are
**1.50:1** apart in greyscale. S4.d fixed exactly this in the inspector rail by
printing the cause the shared module already computes (`WorkerStatus.tag`). The
table still throws it away.

### 1.4 · The adjacency columns are the first thing to fall off the edge

`table-layout: fixed` confirmed. At 1024×768 the wrapper scrolls horizontally:

| | |
|---|---|
| hidden width | **176px** |
| last column | **"It feeds"** |
| cut by | **175px** |

They are reachable — `.h10-ds-grid-wrap` is `overflow-x: auto` — but a
horizontal scroll nested inside a vertically scrolling page is where the *reason
this view exists* now lives at narrow widths.

### 1.5 · Selection is marked in one cell of eight

Measured selected vs unselected: the name goes `#2b6cb0` → `#1c2530`
(**5.42 → 15.48:1**) and gains an underline. Two channels, both fine — the
brief's suspicion that it was "only an underline" is **not** what the page does.

But the mark is confined to the **Worker** cell. Every other `<td>` in the
selected row is the same white as its neighbours, in a row **1262px** wide with
eight columns. The canvas gives a selected card a ring around the whole thing;
the table gives it a differently-coloured word at the far left.

### 1.6 · Focus, and what is already right

- **No focus rule exists** for `.h10-ds-grid` or `.sbm-list*` — grepped every
  stylesheet. Same gap S4.f closed in the inspector rail; the UA ring is the
  only affordance.
- **Sorting is largely correct already**, which is worth saying because it is the
  part most often wrong: `aria-sort` sits on the `<th>` (`"ascending"` on Status,
  `"none"` elsewhere), the activator is a real `<button>` with `tabIndex 0`, and
  the two adjacency columns are deliberately unsortable — sorting by "what feeds
  this" is meaningless.
- The DataGrid is the shared DS component, per the operator decision of
  2026-08-08, and takes **no** GridToolbar or FilterBar — filtering lives in the
  overlay rail and a second filter UI over the same state would be duplication.
- S3.l's `rowClassName` dimming works: the table honours the rail's role filter.
- A 68-character worker name wraps rather than clipping in the 244.4px Worker
  column — no truncation, no lost text.

---

## PART 2 — What the best tools do

### 2.1 · A table is not a consolation prize — it is the equivalence requirement

W3C is unambiguous: non-text content needs a text alternative that *"serves a
purpose **equivalent**"*, and for complex images the guidance is *"a **complete
text equivalent** of the data or information provided in the image"*, structured
as a short identifier plus a long description — for data, *"a well-structured
data table as an alternative format"*.

The test is therefore not "does a table exist" but **"can you learn from it
everything the picture would have told you"**. §1.2 says we currently cannot.

**Sources:** [W3C complex images](https://www.w3.org/WAI/tutorials/images/complex/) ·
[W3C images tutorial](https://www.w3.org/WAI/tutorials/images/)

### 2.2 · Graph and table as mutually exclusive views

Airflow 3 made Grid and Graph **mutually exclusive**, reversing 2.x where the
grid was pinned beside the graph — and gave the toggle a keyboard shortcut
(`g`). The reasoning discussed in the community is screen real estate: the graph
needs it, the grid does not.

That is our Map/List switch, and it validates the shape. What Airflow's change
also implies is that if the two are exclusive, **each must stand alone** — you
cannot lean on the other being visible.

**Source:** [Airflow 3 UI overview](https://airflow.apache.org/docs/apache-airflow/stable/ui.html) ·
[the mutual-exclusion discussion](https://github.com/apache/airflow/discussions/50492)

### 2.3 · Sortable columns, done properly

The settled pattern, and we already meet most of it:

> Put `aria-sort` **on the `<th>`**, not the button, with `ascending`,
> `descending` or `none`. Keep a direction on **only one header at a time**. Make
> the activator a real `<button>` inside the `<th>` so it is keyboard-operable.
> Mark the visual arrow `aria-hidden` so the state is not announced twice.
> Verify the header reads *"Date, ascending, column header, button"*.

**Sources:** [Adrian Roselli, Sortable Table Columns](https://adrianroselli.com/2021/04/sortable-table-columns.html) ·
[MDN `aria-sort`](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-sort) ·
[Deque, sortable table](https://dequeuniversity.com/library/aria/table-sortable)

### 2.4 · What belongs in the URL

The consensus is that **filtering, sorting, search and pagination belong in the
URL**, because it makes a view bookmarkable, shareable, and — the point most
relevant here — **reproducible in a bug report**.

And the caution that names our own defect exactly:

> "Deep links can arrive when an app is **cold-starting**, warm, or already
> active in a different section, and routing logic must handle all three states."

Ours handles the third and fails the first: the cold start fetches before it has
read the link.

**Sources:** [query params for frontend state](https://medium.com/@polymath0033/why-you-should-start-using-query-parameters-in-your-frontend-apps-a39d856211bf) ·
[deep-linking best practices](https://www.branch.io/resources/blog/branch-deep-linking-explained-best-practices-for-routing-users/)

---

## PART 3 — The design, with the reason under each decision

### D-S5.1 · The window is resolved before the first fetch, entirely inside `MapClient`

`useVisibilityPoll` is another stream's module and must not be edited. It already
returns `refresh()`, which calls the current `load`. So: a small effect that
fires `refresh()` when `windowKey` **changes** — skipping the mount, which the
hook's own first tick already covers.

**Why this and not a lazy `useState` initialiser reading `location.search`.** I
evaluated that first, as the brief asks. `MapClient` is a client component but
its first render still executes on the server for the initial HTML, where
`window` is undefined; guarding with `typeof window` makes the server render
`7d` and the client render `24h`, which is a hydration mismatch on the window
switch's own selected state. The `refresh()`-on-change approach has no such
split, needs no shared-module edit, and **fixes the everyday case as well as the
deep link** — clicking the switch currently fires nothing at all (§0.1).

### D-S5.2 · The table carries what the canvas carries

Three columns close the equivalence gap of §1.2:

- **Right now** — the autonomy bucket's short words, from
  `overlayById('autonomy').bucketOf(node)`. The same source the canvas paints
  from and the inspector rail reads (S4.d), so three surfaces cannot diverge.
- **Lane** — *step of a routine* / *run by the nightly job* / *not wired*, from
  `node.lane`, which the payload already carries.
- **Runs**, restoring the card's third fact slot.

**Why not simply link out.** Because this is the text alternative. A reader who
cannot use the canvas must be able to learn what it says *here*, and "open each
worker's page in turn" is not equivalence.

### D-S5.3 · The Status column names the cause

`Needs attention · stopped by a limit`, from `WorkerStatus.tag` — the same fix
S4.d shipped in the rail, for the same measured reason (§1.3). The words already
exist; only the rendering flattens them.

### D-S5.4 · Every colour in the list clears AA

The three greys go to the tokens Sections 1–4 established — `#55616f` (6.31:1)
for dim and secondary text — and `tone-warn` moves to the `#9a6410` S4.a already
uses for the same role in the rail. Nothing here is decoration: §1.1 measured the
adjacency sentences at 2.50:1.

### D-S5.5 · The selected row is marked as a row

A background and a left marker on the whole `<tr>`, not a differently-coloured
word in the first of eight cells. The existing name treatment stays — it is the
accessible name of the control that changed the selection.

**Why not make the whole row clickable.** Because the row contains two other
interactive things (the adjacency buttons, once they are buttons), and a row
click that competes with a cell click is the ambiguity the DS grid does not
model. The name stays the control; the row gains the *mark*.

### D-S5.6 · Adjacency stops being the first thing off the edge

The two adjacency columns move **left**, ahead of Spend and Open findings, so a
horizontal scroll truncates the ranking columns — which the picture answers
badly and which have a natural home elsewhere — rather than the columns that
exist to make this view an alternative at all.

### D-S5.7 · A focus ring on every control in the table

Matching the page's, as S4.f did for the rail: the sort buttons, the name
buttons, the adjacency buttons.

### D-S5.8 · The URL keeps saying only what it means

`worker` · `edge` · `view` · `window` · `colour` · `thing`. **Sort stays out**,
deliberately: it is a reading posture rather than a subject, the table's default
is a deliberate ranking, and every parameter added to a shareable URL is one more
thing that can be wrong when it arrives. This is stated so the next reader knows
it was a decision and not an omission.

---

## PART 4 — Two options for the URL race, and which I recommend

### Option A — `refresh()` on window change *(recommended)*

One effect in `MapClient`, skipping mount.

- **Cost:** the mount case still relies on the hook's own first tick, so the
  ordering must be right — the effect must run *after* the render in which
  `loadRef` was updated. That is what a `[windowKey]` effect does, but it is the
  part to verify on production rather than assume.
- **Gain:** no shared-module edit; fixes the deep link *and* the switch; no
  hydration split; ~6 lines.

### Option B — gate the first fetch until the URL is read

A `ready` flag that starts false; `load()` returns early until the mount effect
has parsed the URL and set it.

- **Cost:** every consumer of the payload must tolerate a slightly later first
  paint, and the skeleton is on screen marginally longer. It also does nothing
  for the switch click — the everyday case — so it fixes the smaller half of the
  defect.
- **Gain:** the wrong window is never fetched at all, rather than fetched and
  then corrected.

### The recommendation

**Option A.** The measurement in §0.1 is what decides it: the deep link is the
*narrower* symptom, and Option B addresses only that one. A fix that leaves
"clicking the time window does not fetch" in place is not a fix of this defect,
it is a fix of the way we first noticed it.

If A's ordering turns out not to hold on production, the fallback is A **plus** a
one-line `refresh()` in the URL-read effect itself — still entirely in
`MapClient`.

---

## PART 5 — Honesty rules for this section

1. **The table says everything the picture says.** If a later section adds a
   fact to the card, it is added here in the same commit or the alternative has
   quietly stopped being one.
2. **One source.** Status, autonomy and lane are read from the same functions the
   canvas and the rail use — never re-derived.
3. **Colour is never the only channel** — a failure and a limit differ in words.
4. **No dials, no bulk actions, no create.** If the list grows one it has become
   the Workers roster and should be deleted in favour of a link to it.
5. **The URL means what it says from the first frame.**
6. **A control that is not enforced is not rendered** — `scopeCampaignIds`,
   `scopePortfolioIds` stay out.

---

## PART 6 — Empty and degenerate states

| state | what the list does |
|---|---|
| before the first read | the page renders a skeleton; the table never mounts with empty data |
| no workers at all | the page's own empty state, above the body — the table is not reached |
| a worker with no wiring | *"starts the chain"* / *"ends the chain"*, at readable contrast |
| a long name | wraps in the 244.4px column — measured at 68 characters, no clipping |
| narrow viewport | the wrapper scrolls; after D-S5.6 what scrolls out is ranking, not adjacency |
| selection below 1400 | **already correct**: S4.h's reflow puts the rail below the table and it shows detail at 1399, 1280, 1100 and 1024 — measured |
| entity mode | **has no list view at all.** See §8 |

---

## PART 7 — The backend this section needs

**None.** `lane`, `runs.lifetime` and the autonomy charter fields are all on the
payload already. As in Section 4, the gap is between what the endpoint returns
and what the component renders.

---

## PART 8 — Raised, not taken

### C-S5.1 · Entity mode has no list view

The workers universe has a text alternative; the entity graph — 38 nodes and
their relations — has none. That is the same equivalence argument as §1.2, one
level up, and it is a bigger piece of work than this section: it needs its own
columns (thing, type, relation, counterpart) and its own sort. **Raised.**

### C-S5.2 · `.sbm-viewhint` and the view switch sit in the centre pane

`.sbm-viewhint` measured **2.31:1** and is fixed here because §M5 owns the centre
pane per `map.css`'s own section header. Noting it so the header's owner knows
the switch's hint text changed colour.

---

## PART 9 — What this section must never become

- **The Workers roster.** No dial, no bulk action, no create, no pause.
- **A second source of truth.** Status, autonomy and lane come from the shared
  functions or they will drift.
- **A place where the picture is the real view and the table is the fallback.**
  It is the alternative; equivalence is the bar.
- **A URL that carries everything.** Sort stays out on purpose.

---

## PART 10 — Build order

| phase | change | exit criterion, measured on prod |
|---|---|---|
| **S5.a** | contrast: the three greys + `tone-warn` (D-S5.4) | 0 failures in `.sbm-centre`, live **and** forced |
| **S5.b** | `refresh()` on window change (D-S5.1) | network trace: `?window=24h` fetches 24h first; clicking the switch fires exactly one request |
| **S5.c** | Status names the cause (D-S5.3) | no two rows share a status word with different tones |
| **S5.d** | Right now · Lane · Runs columns (D-S5.2) | every fact on a card is answerable from the table |
| **S5.e** | selected row marked as a row (D-S5.5) | the mark is visible at the right-hand edge of a 1262px row |
| **S5.f** | adjacency moves left (D-S5.6) | at 1024, what is cut is a ranking column |
| **S5.g** | focus rings (D-S5.7) | every control in the table has a ring ≥3:1 |

`S5.b` early because it is a correctness defect on the page's primary control and
is independent of everything else; `S5.a` first because it is the widest and
cheapest.

---

*Sources cited inline in Part 2. Measurements: production, 2026-08-10; URL
findings from a network trace; breakpoints in a same-origin nested viewport;
unreachable states forced and production restored.*
