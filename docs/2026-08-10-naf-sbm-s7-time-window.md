# NAF.SB.M-S7R — Section 7, the time window: the denominator inventory, and a convention this page already owns

*The control labelled **WINDOW** — 24 hours · 7 days · 30 days · all time — and
every number downstream of it.*

Code: the `WINDOWS` array, `windowKey` state and `?window=` handling in
`MapClient.tsx`; the `window` parameter, `since` boundary and every windowed
aggregate in `fleet-map.service.ts`; the `as of` stamp; and every surface that
prints a count.

Measured on production 2026-08-10, against the live payload at **all four
windows** and against the rendered DOM at two of them.

**Status: BUILT AND VERIFIED ON PRODUCTION.** Parts 0–9 are the study as
approved; **Part 10 is the execution record**, including the phase that shipped
twice and a correction to one of this document's own exit criteria.

---

## PART 0 — The inherited raises, re-measured, and the instrument

Six raises dissolved across Sections 4–6, one of them a genuine measurement at
two widths that turned out to be a probe artefact. So: instrument first.

### 0.0 · The instrument

```
document.visibilityState  "visible"
document.hasFocus()       true
requestAnimationFrame     fired 2 of 2
```

Timing-sensitive probes are valid — unlike Section 6, where the tab was hidden
and rAF was dead. **This mattered twice below.**

### 0.1 · Does the window govern entity mode? — **SURVIVES, and it is worse than stated**

`loadEntities` builds its query string from `focus` alone:

```ts
const qs = focus ? `?type=…&id=…` : ''
await fetch(`${backend}/api/agent/fleet/entity-graph${qs}`, …)
```

The window is **never sent**. Measured in entity mode, changing the window to
`all`:

| | |
|---|---|
| window control rendered | **yes** |
| any radio disabled | **no** (`[false,false,false,false]`) |
| fetches fired | **2**, both to `agent/fleet/map?window=all` |
| entity-graph refetched | **no** — it cannot be; the window is not a parameter |
| census band before/after | **byte-identical** |

So it is not merely inert. It is a live, enabled control that fires requests to
the *workers* endpoint whose data this mode does not display, and changes
nothing. `scope-filter.ts:6-7` — *"A control that is not enforced must not be
rendered"* — is this page's own law, and this is the largest violation of it on
the page.

### 0.2 · The minimum-window rule — **RETIRE IT**

The parent study specified that a rate must never be computed over too few runs.
The precondition is that a rate exists. Grepped every division and every
percentage in the page tree:

```
MapCanvas.tsx:602   const w = Math.round(r.width / 40) * 40
MapCanvas.tsx:603   const h = Math.round(r.height / 40) * 40
```

Grid snapping. **The page renders no rate, no ratio and no percentage
anywhere.** The rule protects nothing that exists. Retire it, and record the
condition that would revive it: the first derived rate to reach this page.

### 0.3 · `window=all` versus `24h` on a quiet fleet — **SURVIVES, sharply**

Every fact, at all four windows:

| fact | 24h | 7d | 30d | all |
|---|---|---|---|---|
| Σ `runs.window` | **2** | 57 | 57 | 57 |
| Σ `runs.notOkWindow` | **0** | 26 | 26 | 26 |
| Σ `cost.windowUSD` | **$0.0353** | 0.7328 | 0.7328 | 0.7328 |
| Σ `cost.runs` | **2** | 57 | 57 | 57 |
| Σ `plans.authoredWindow` | **0** | 1 | 1 | 1 |
| edges `everCrossed` | **3** | 4 | 4 | 4 |
| Σ `runs.lifetime` | 57 | 57 | 57 | 57 |
| Σ `findings.open` | 64 | 64 | 64 | 64 |
| `totals.crossedLifetime` | 15 | 15 | 15 | 15 |

**All 57 runs in this fleet's history fall inside 7 days.** So `7d`, `30d` and
`all` are indistinguishable — three of four buttons produce a byte-identical
page. The control has exactly **one** working boundary today.

That is a fact about the data, not a defect, and the honest response is not to
remove options — it is to stop the page implying that four choices are four
answers. See D-S7.5.

### 0.4 · Run replay — **stays deferred, and the count is now the argument**

The parent study deferred replay because there was nothing to replay: 0 sweeps,
47 runs. Now **57 runs**, still 0 sweeps, and **2 of 57 inside 24 hours**.
Ten more runs does not make a replay affordance earn a section. Deferred, with
the number recorded so the next re-check starts from 57.

### 0.5 · Two raises of my own that dissolved during this audit

Recorded because both would have shipped as findings.

**"Changing the window does not refetch."** Clicked `24 hours`, waited 4.5s,
and measured identical edges, identical labels and `$0.11 spent` where the API
returns `$0.00`. That reads exactly like the S5.b defect returning. It is not:
a **network trace** shows one `agent/fleet/map?window=24h` and the card moving
`$0.11 → $0.00`. **The API takes over 4.5 seconds; my wait was too short.**
Measuring the render instead of the network is the specific error S5 was written
about, and I made it again in the same file.

**"One window change fires two fetches."** Measured twice, 5.5s apart. The hook
polls every 10s while visible (`use-visibility-poll.ts:45`), so a poll landing
inside the observation window is indistinguishable from a duplicate. My control
— watch with no interaction — returned **0 calls in 26s**, which looked like
proof until the instrument check showed `visibilityState: "hidden"`: the tab had
backgrounded during the long wait, and the hook gates polling on visibility, so
zero is *correct*. Resolved by reading the code instead of the clock: the
window-change effect returns early once `loadedWindow.current === windowKey`, and
`tick` is `useCallback([])`, so the page issues **exactly one** fetch per change.
The second call was the 10s poll. **Not a defect.**

---

## PART 1 — The denominator inventory

Every number this page prints. **Four denominators, not two.**

- **W** — windowed: inside `since = asOf − N days` (rolling, not calendar)
- **L** — lifetime: all of history
- **T** — today: `utcDayStart(asOf)`, a UTC calendar day
- **S** — state: not a period at all. `status:'open'`, `status:'pending'` — a
  queue depth, which is why calling it "lifetime" would also be wrong

| surface | number | denom | does it say so? |
|---|---|---|---|
| band | `SPENT TODAY $0.00 of $2.00` | **T** | ✅ "TODAY" |
| band | `OPEN FINDINGS 64 · 47 past their expiry` | **S** | ◐ "open" implies it |
| band | `7 switched off` | **S** | ✅ n/a |
| band | `1 never run, ever` | **L** | ✅ **"ever"** |
| band | `0 waiting in Approvals` | **S** | ◐ |
| **card** | `3 runs` | **L** | ❌ **nothing** |
| **card** | `5 open` | **S** | ❌ **nothing** |
| **card** | `$0.11 spent` | **W** | ❌ **nothing** |
| edge | label `7 carried` / `nothing carried in 24 hours` | **W** | ✅ names the window |
| edge | label `nothing reviewed yet` (plan) | **W** | ❌ **reads as never** |
| edge | stroke solid/dashed (`everCrossed`) | **L** *intended* | ❌ **is W for plan edges** |
| list | `Runs` | **L** | ❌ |
| list | `Last run` | **L** | ❌ |
| list | `Open findings` | **S** | ❌ |
| list | `Spend` | **W** | ◐ only when zero |
| **rail** | `Runs — 3 in this window · 3 ever` | **W+L** | ✅✅ **both, named** |
| **rail** | `Spend — $0.1090 in this window · $0.1090 ever` | **W+L** | ✅✅ |
| rail | `Open findings — 5 · 1 critical…` | **S** | ◐ |
| header | `as of 23:41:35` | freshness | ◐ no date, no relation to the window |

**The inventory's own conclusion: the page has already solved this, in one
surface.** S4 gave the inspector rail `N in this window · N ever`. The card and
the list never adopted it. This section is mostly propagation, not invention.

---

## PART 2 — What is wrong today, measured

### 2.1 · The card mixes three denominators in three adjacent slots

Verbatim from production, `Bid tuner`, at 7 days and at 24 hours:

```
7d    Bid tuner | Off | ANALYST | 3 runs | 5 open | $0.11 spent
24h   Bid tuner | Off | ANALYST | 3 runs | 5 open | $0.00 spent
```

Three facts, three denominators (L, S, W), no marking. Changing the window moves
the third and not the first two, and nothing on the card explains why.

### 2.2 · And at 24h the card states a measured zero where there is no data

This is the sharpest defect in the section, because the code forbids it in a
comment directly above the line that does it.

`MapCanvas.tsx:145`:

```tsx
{/* A worker that never ran gets a dash, NOT `$0.00`. "Ran and cost
    nothing" and "was never measured" are different facts, and printing
    the cheaper-looking one is the exact error the parent study names
    for the cost overlay. */}
<span className={`sbm-fact ${d.neverRun ? 'is-empty' : ''}`}>
  <b>{d.neverRun ? '—' : usd(d.costWindow)}</b> spent
</span>
```

`neverRun` is `n.runs.lifetime === 0` — a **lifetime** test. `costWindow` is
**windowed**. Bid tuner at 24h:

| field | value |
|---|---|
| `runs.lifetime` | 3 → `neverRun = false` |
| `cost.runs` | **0** |
| `cost.windowUSD` | 0 |
| card prints | **`$0.00 spent`** |
| list prints, same node, same window | **`no runs in this window`** |

The service added `cost.runs` for precisely this, and says so:

> *"How many runs produced `windowUSD`. Without it, $0.00 over three runs and
> $0.00 over no runs render identically — one is a measured zero and the other
> is no data, and the overlay must not colour them the same."*

The card is never passed it. **Two renderings of one fact disagree on one
screen**, and the wrong one is the one the comment warns against — because the
guard uses the lifetime denominator against a windowed value. Mixing
denominators does not merely confuse; here it produces a false statement.

### 2.3 · A 24-hour window un-solids an edge that has carried work

`MapEdge.everCrossed` is documented:

> *"**LIFETIME, deliberately.** It drives the stroke, and a 24-hour window must
> not be able to un-solid an edge that has genuinely carried work."*

Measured — the plan edge `amazon-ads-director → plan-critic`:

| | 24h | 7d / 30d / all |
|---|---|---|
| `everCrossed` | **false** | true |
| stroke-dasharray | **`4px, 4px`** | `none` |
| stroke | **`rgb(138,148,163)`** grey | `rgb(91,127,168)` blue |

The three `finding` edges hold solid at every window. Cause, `fleet-map.service.ts:866`:

```ts
everCrossed: isPlan
  ? (verdicts?.pass ?? 0) + (verdicts?.revise ?? 0) + (verdicts?.block ?? 0) > 0
  : crossedLifetime > 0,
```

`crossedLifetimeByPair` is accumulated **outside** the window guard — correct.
`verdictsByPair` is built at line 688 under `if (p.criticVerdict && inWindow)` —
**strictly windowed**. So the plan branch of a field named `everCrossed` reads a
windowed counter.

The consequence is not cosmetic: this is the fleet's *only* critique edge,
carrying a 9-item BLOCK, and at 24 hours the map draws it as a link that has
never carried anything.

### 2.4 · The same edge then says "nothing reviewed yet"

At 24h, correct selector (`.react-flow__edge text`):

```
nothing carried in 24 hours     ← finding edge, windowed AND marked
nothing carried in 24 hours
nothing carried in 24 hours
nothing reviewed yet            ← plan edge, windowed, UNMARKED
```

*"Nothing reviewed yet"* reads as **never happened**. That is exactly the defect
S4.k fixed in the inspector rail — where the same fleet's 9-item BLOCK was
reported as "Nothing has been reviewed yet" at the default window — and the fix
S4.k shipped, `latestCritique { verdict, at, inWindow }`, is already on this
payload. The edge label never used it.

*(Method note: my first selector returned `[]` and I nearly reported the labels
as missing. `.react-flow__edgelabel-renderer *` matches nothing here. Same class
of error as Section 6's "0 edges". Verify a selector matches before trusting an
empty result.)*

### 2.5 · The window control is four tab stops

| radiogroup | tab stops |
|---|---|
| "Colour the map by" (rebuilt in S3) | **1** |
| **"Time window"** | **4** |

S3 established roving tabindex as this page's convention and took 9 stops to 3.
The window control never got it. WAI-ARIA APG: *"A radio group is one tab
stop."*

**Dissolved on measurement:** I expected no `radiogroup` wrapper. There is one,
`aria-label="Time window"`, and all four radios carry correct `aria-checked`.
`closest('[role]')` had matched the button itself. The ARIA *structure* is
right; only the tab management is not.

### 2.6 · The window change is never announced

A `polite` `sr-only` live region exists and currently reads *"Showing the whole
fleet."* — S3's filter announcement. Changing the window writes nothing to it. A
screen-reader user hears `"24 hours, selected"` and is told nothing about the
consequence, which is that most numbers on the page now mean something else.

### 2.7 · `as of` and WINDOW sit adjacent and are different kinds of time

`as of 23:41:35` — time only, no date, no relation to the window — sits in
`.sbm-head-right` beside the window radios. One is *when the screen was read*;
the other is *how far back the numbers reach*. Nothing distinguishes them.

---

## PART 3 — What the best tools do

**Datadog — the window is global, and an exception declares itself.** A
dashboard has a global time selector; a widget may opt out. The docs describe
the behaviour — *"Widgets not linked to global time show the data for their
local time frame as applied to the global window"* — and, notably, **do not
document any marker on the widget itself**. That is an honest negative result:
the industry leader solves the mechanism and leaves the labelling to the author.
It is the argument for this page marking its own exceptions rather than assuming
a convention exists to inherit.

**Grafana — "no data" is not zero, and the default is a gap.** *"'No data' is
different from returning a null value."* A null breaks the line by default;
rendering `null as zero` is an explicit opt-in, and `No value` must be
deliberately set to `0`. This is §2.2's defect stated as a product default: the
cheaper-looking number is never the automatic one.

**Splunk ITSI — a floor on the data before a derived number is trusted.**
Adaptive thresholds require roughly seven days of backfilled data and refuse
with an insufficient-data error otherwise. The principle is right and its
precondition — a derived statistic — is absent here (§0.2).

**Anthropic's usage & cost console — UTC, stated.** *"All dates and timestamps
are in UTC. Daily aggregates become available at midnight UTC,"* and the cost
API supports only `1d` buckets. Precedent for this page's `utcDayStart`: the
discipline is not to pick local time, it is to **say which day you mean**.

**WAI-ARIA APG — a radio group is one tab stop**, exactly one option carrying
`tabindex="0"`, the rest `-1`, arrows moving selection.

**Sources:**
[Datadog widget configuration](https://docs.datadoghq.com/dashboards/widgets/configuration/) ·
[Grafana no-data vs null](https://community.grafana.com/t/no-value-as-0-in-time-series/148676) ·
[Splunk ITSI adaptive thresholds](https://help.splunk.com/en/splunk-it-service-intelligence/splunk-it-service-intelligence/visualize-and-assess-service-health/4.18/advanced-thresholding/create-adaptive-kpi-thresholds-in-itsi) ·
[Anthropic usage & cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) ·
[WAI-ARIA APG radio group](https://w3.org/WAI/ARIA/apg/patterns/radio)

---

## PART 4 — The design

### D-S7.1 · The marking rule, stated once

> **A number that moves with the window is written `N in this window`. A number
> that does not is written with the word that names its denominator — `ever`,
> `today`, or `open`. Where both exist and both matter, the page prints both,
> in that order, separated by `·`.**

This is not invented here. It is the inspector rail's existing format —
`3 in this window · 3 ever` — promoted from one surface to the page's rule. The
band already complies (`SPENT TODAY`, `never run, ever`). The card, the list and
one edge label do not.

**We mark them; we do not stop mixing them.** Un-mixing would mean removing
lifetime facts from the card, and `3 runs` is the fact that distinguishes a
worker that has never run from one that is merely quiet in this window — the
distinction the whole page is built to preserve.

### D-S7.2 · The card gains the window's denominator where it changes the meaning

Slot 3 becomes window-aware and honest:

- `cost.runs > 0` → `$0.11 spent` (unchanged)
- `cost.runs === 0` **and** `runs.lifetime > 0` → **`— not in this window`**
- `runs.lifetime === 0` → `— not yet run` (unchanged)

This requires passing `cost.runs` to the card, which the service already
computes and documents for this exact purpose. Slot 1 stays `3 runs`; §D-S7.4
carries its denominator without spending card space.

### D-S7.3 · `everCrossed` becomes lifetime for plan edges too

The plan branch must not read `verdictsByPair`. The lifetime source already
exists on the payload: `latestCritique` is deliberately computed ignoring the
window (S4.k). A plan edge has carried work if a critique exists at all.

And the plan edge's empty label stops saying *never*: `nothing reviewed yet`
becomes `nothing reviewed in <window>` when `latestCritique` exists but is
out of window — the wording the finding edges already use, and the distinction
S4.k already drew in the rail.

**This is a backend change** to `fleet-map.service.ts` — this stream's own file.
It will be claimed in the locks doc before editing.

### D-S7.4 · The window is stated once, in words, where the numbers are

A single line under the census band, in prose, naming the denominator in force
and what it does not govern:

> *Counts below cover **the last 7 days**. Findings, approvals and “ever”
> figures are not limited by it; spend today is a UTC day.*

One sentence carries every unmarked number on the page without adding a suffix
to each. It is also the natural place to state §0.3's finding when it applies.

### D-S7.5 · Entity mode: the control says it does not apply

Entity mode's graph is rebuilt nightly and has no time dimension. Three
candidate treatments — disable, hide, annotate. **Annotate and disable**: the
radios go `aria-disabled` with the group carrying a short reason
(*"the entity graph is rebuilt nightly; it has no time window"*).

Hiding is wrong: the control would vanish and reappear across a mode switch,
which is the layout instability this page has spent six sections removing.
Leaving it live is what we have, and it fires two pointless requests.

### D-S7.6 · The change is announced

On window change, the existing `polite` region receives one sentence:
*"Showing the last 7 days. 57 runs, $0.73 spent."* — the denominator and what
moved, not a re-read of the page.

### D-S7.7 · Roving tabindex on the window group

Four tab stops → one, matching the other four radiogroups on the page.

---

## PART 5 — Two options, and the recommendation

### Option A — mark the numbers *(recommended)*

Adopt D-S7.1 as the page rule and propagate it: the card's cost slot tells the
truth (D-S7.2), the plan edge stops lying twice (D-S7.3), one sentence carries
the rest (D-S7.4), and the control declares where it does not apply (D-S7.5).

**Why.** It is the convention the page already proves in the inspector rail, so
it adds no new vocabulary for an operator to learn. It fixes the two statements
that are actually *false* (§2.2, §2.3) rather than the ones that are merely
unlabelled. And it costs no layout: one line of prose, one changed cost slot,
one changed label, one backend expression.

**Against.** The card still shows a lifetime `3 runs` beside a windowed spend,
carried only by a sentence elsewhere on the page.

### Option B — make the window total, and give every number a suffix

Window everything that *can* be windowed (findings opened in window, approvals
created in window), suffix every remaining number on every surface, and let the
denominator be uniform by construction.

**Why not.** Three reasons, in order of weight.

1. **It would break facts the window must not govern.** `5 open` is a queue
   depth. "Findings opened in the last 24 hours" is a different question, and
   the answer to it is not what an operator asking "what is outstanding?" needs.
2. **It contradicts a shipped decision.** The edge stroke is lifetime *on
   purpose*; §2.3 is a bug precisely because it made the stroke windowed.
3. **The suffixes would be noise on a page where three of the four window
   options are currently identical** (§0.3). We would add a mark to every number
   to explain a control with one working boundary.

**Recommendation: Option A.**

---

## PART 6 — Honesty rules, and the degenerate states

- **No data is never the bottom of a scale.** `$0.00` for a worker that did not
  run in this window is the single defect this section exists to remove. Grafana
  makes the same choice a product default.
- **Out-of-window content is never promoted into the window.** S4.k's rule.
  `nothing reviewed in 24 hours` says where to look; it does not quietly show
  the 4-day-old BLOCK under a 24-hour heading.
- **An unmarked number is a windowed number only if the sentence says so.**
  D-S7.4 is load-bearing, not decoration.
- **`ever` and `today` are words, not tooltips.** Never `title=`.
- **Degenerate: every window identical.** Today, `7d`/`30d`/`all` agree exactly
  (§0.3). The page must not pretend otherwise; D-S7.4's sentence is where that
  is said if it is said at all. **Raised, not designed:** whether to state it
  actively is a judgement I want the operator's view on, because it verges on
  editorialising about the fleet's inactivity.
- **Degenerate: an empty window.** At 24h, 5 of 7 workers have zero runs. Every
  such surface must read *not in this window*, never `0` or `$0.00`.
- **Forced, and still unexercised:** a window boundary that splits a *single*
  worker's runs (some in, some out) exists today at 24h. A boundary that splits
  an *edge's* crossings does not — all 15 crossings are inside 7 days. That case
  must be forced with a synthetic payload before D-S7.3 ships.

---

## PART 7 — Backend, URL, accessibility

**Backend.** One expression in `fleet-map.service.ts` (D-S7.3), plus `cost.runs`
reaching the card — already on the payload, only unplumbed in `MapCanvas.tsx`.
No schema change, no migration, no new query.

**URL.** `?window=` already round-trips and the S5.b2 startup race is closed. I
verified the refetch-on-change still works by network trace (§0.5) and will not
touch `use-visibility-poll.ts`. **Nothing in this section changes that contract.**

**Accessibility.** Roving tabindex (D-S7.7); a live-region sentence on change
(D-S7.6); `aria-disabled` plus a reason in entity mode (D-S7.5). The existing
`radiogroup`/`aria-checked` structure is already correct and is not touched.

---

## PART 8 — What this section must never become

- **Not a date picker.** Four relative windows, no custom ranges, no calendar —
  `type="date"` is banned by the ratchet and unnecessary here.
- **Not a per-surface window.** Datadog's per-widget override is right for
  dashboards a user composes; this page is one authored sentence about one fleet.
- **Not a rate engine.** §0.2 retired the minimum-window rule because there is no
  rate. Do not add one here to justify it.
- **Not replay.** Still deferred, now at 57 runs (§0.4).
- **Not a redesign of the band, card, rails or list.** This section changes what
  a number *says*, never how it looks.

---

## PART 9 — Build order

| phase | change | exit criterion |
|---|---|---|
| **S7.a** | `everCrossed` lifetime for plan edges (D-S7.3) | plan edge solid at 24h; forced split-boundary payload behaves |
| **S7.b** | plan edge label names the window (D-S7.3) | `nothing reviewed in 24 hours`, never bare "yet" |
| **S7.c** | card cost slot honours `cost.runs` (D-S7.2) | at 24h the card and the list agree, word for word |
| **S7.d** | the denominator sentence (D-S7.4) | present, and names what the window does not govern |
| **S7.e** | entity mode declares non-application (D-S7.5) | radios `aria-disabled`; **0** fetches on change |
| **S7.f** | roving tabindex (D-S7.7) | 4 tab stops → 1 |
| **S7.g** | announce the change (D-S7.6) | live region carries the new denominator |

`S7.a` first: it is the only defect that makes the canvas draw something false.

---

## PART 10 — The execution record

All measured on production. The API carries an exact deploy marker —
`GET /api/health` returns `{"build":"<sha>"}` — so every phase below was
verified against a build proven to contain it.

### 10.1 · What each phase did, measured

| phase | before | after |
|---|---|---|
| **S7.a** | plan edge at 24h: `everCrossed:false`, `dasharray 4px,4px`, `rgb(138,148,163)` | `everCrossed:true`, `dasharray none`, `rgb(91,127,168)` — identical to the finding edges, while `verdicts` stays 0/0/0 |
| **S7.b** | `nothing reviewed yet` | `nothing reviewed in 24 hours` |
| **S7.c** | card `$0.00 spent` vs list `no runs in this window` | card `— no runs`; never-run cards still `— spent` |
| **S7.d** | no denominator anywhere | the sentence, plus the clause at 7d/30d and correctly absent at 24h |
| **S7.e** | radios live; **2 fetches** to the workers endpoint; band byte-identical | `aria-disabled` ×4, reason in the group name, **0 fetches** |
| **S7.f** | **4** tab stops | **1** |
| **S7.g** | radio state only | a sentence naming the denominator and what moved |

`.is-na` measured on prod: **6.31:1** on white, **5.32:1** on `#e7ecf2`,
`opacity: 1` — so the composite-opacity trap does not apply.

### 10.2 · S7.c shipped twice, because the first wording overflowed one card

The first version said `— not in this window`, which is what §D-S7.2 specified.
It overflowed exactly one card. `Fleet self-test analyst` carries
`47 open · 47 stale` in slot 2, the facts row is 159px of `nowrap`, and the
third slot ran **17px past the card's inner edge** — visibly, because the row is
`overflow: visible`. Every other card had 23–40px of slack.

Measured by swapping the text and reading the painted `Range` against the card's
inner right edge (697px):

| phrase | text right | over |
|---|---|---|
| `— not in this window` | 714 | **+17** |
| `— no runs in this window` | 728 | +32 |
| `— none in this window` | 720 | +23 |
| `— no runs in window` | 714 | +18 |
| `— not in window` | 700 | +3 |
| **`— no runs`** | **679** | **−18** ✓ |

So the slot **cannot** say "window" on the widest card, and the denominator is
carried by S7.d's sentence instead — which is what that sentence is for.

**A correction to this study's own exit criterion.** §9 said S7.c passes when
"the card and the list agree, word for word". They do not: the card says
`— no runs`, the list says `no runs in this window`. They agree in *substance* —
neither states a measured zero — and word-for-word was unachievable in 159px of
`nowrap`. The criterion was written before the width was measured.

### 10.3 · Two raises of mine that dissolved, and one instrument save

Beyond §0.5's two, during the build:

- **"tsc says my `mode !== 'entities'` guard is unreachable"** — not a bug in
  the guard, a *proof* that S7.d's placement is already inside the workers arm
  of the mode ternary. The compiler answered a question I was about to answer by
  reading.
- **"The window control has no `radiogroup` wrapper"** (§2.5) — it does, with
  `aria-label="Time window"`. `closest('[role]')` had matched the button itself.
- **The instrument saved a false report twice**: once when a 4.5-second wait
  made a working refetch look broken (the API is slower than that), and once
  when a "0 polls in 26s" control turned out to have run in a backgrounded tab,
  where the hook *correctly* stops polling.

### 10.4 · What is still open

- **`.sbm-fact` is `text-overflow: clip` with `overflow: visible`.** So a slot
  that outgrows its card does not clip — it paints past the edge. That is how
  S7.c's overflow was visible at all, and it means **any** future lengthening of
  a card fact fails the same way, silently to a probe that only reads text.
  Raised, not fixed: it is a shipped section's layout.
- The split-boundary case for an **edge** (some crossings in window, some out)
  still does not occur on this fleet — all 15 are inside 7 days — so S7.a's
  behaviour there remains reasoned, not observed.

---

*Measurements: production, 2026-08-10; payload at four windows, DOM at two;
instrument verified visible with rAF firing before any timing-sensitive probe.*
