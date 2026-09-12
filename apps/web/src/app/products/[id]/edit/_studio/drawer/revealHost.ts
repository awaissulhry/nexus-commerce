/**
 * PES.4 §5.4 — the HOST half of the reveal: measure this grid, apply the rule, move the grid.
 *
 * 🔴 ONE implementation for both sheets (#752). This lived as a local `revealColumn` in
 * `MasterSheet.tsx` with a near-copy in `ChannelSheet.tsx`, and the two-implementation shape is why
 * the same defect has been fixed twice and differently: #747 corrected the master copy and left the
 * channel's untouched, and making `panelReadiness` state its question properly broke the other
 * lane's compile because only one call site moved. The RULE was already shared (`revealCell.ts`);
 * this is the part that reads a real grid, and it was not.
 *
 * The split is unchanged: `revealCell.ts` is pure arithmetic a node-only vitest can test, and
 * everything here touches the DOM. What moved is only the wiring between them.
 */
import {
  GRID_SCROLL_VIEWPORT,
  gridColumnGeometry,
  gridScrollViewport,
  scrollGridTo,
} from '@/design-system/grid'

import { panelReadiness, revealDistance, revealScroll, type RevealIntent } from './revealCell'
import { STUDIO_PANEL_SELECTOR } from './StudioDock'

/** What this needs of a `GridApi` — structural, so both sheets' row types satisfy it. */
export type RevealGridApi = { getColumn: (k: string) => unknown; getDisplayedLeftColumns: () => unknown[] }

/**
 * Why the host decided what it decided.
 *
 * 🔴 `no-api` and `no-host` are here because the first version of this trace COULD NOT SEE THEM.
 * The caller guards both before calling in, so on the cold path — the one this instrument exists
 * for — the two likeliest exits emitted nothing at all, and an empty buffer would have read as
 * "the reveal never fired" when it had fired and bailed one frame early. That is the same
 * could-not-measure/measured-empty confusion the trace was built to end, reintroduced by the trace.
 */
export type RevealWhy =
  | 'no-api'
  | 'no-host'
  | 'panel-not-measurable'
  | 'band-not-derived'
  | 'no-geometry'
  | 'pinned'
  | 'already-clear'
  | 'scrolled'

/** One decision, as the host made it. Dev-only; see `trace`. */
export interface RevealTrace {
  colKey: string
  intent: RevealIntent
  readiness: 'none' | 'pending' | 'at'
  panelLeft: number | null
  why: RevealWhy
  cellRight?: number
  viewportRight?: number
  panelOverlap?: number
  cellLeft?: number
  viewportLeft?: number
  scrollLeft?: number
  maxScroll?: number
  distance?: number
  wrote?: number | null
  unreachableBy?: number
  /** WHICH element was written to — see the note at the write. */
  viewportEl?: string
  served?: boolean
}

/**
 * The trace, and the question it exists to settle (#752, resumed).
 *
 * Three lanes spent a day unable to separate "the reveal ran and computed zero" from "the reveal
 * never ran", because from outside the call they produce the identical observation: a grid that did
 * not move. Every instrument built to tell them apart measured the OUTCOME, and the outcome is the
 * one thing both hypotheses agree on.
 *
 * 🔴 The narrowed question it answers: `panelOverlap` is `max(0, gridRight - panelLeft)`
 * (`gridScroll.ts:153`), so an overlap of **0 with the panel visibly present** has exactly two
 * causes and they need opposite fixes — either `panelLeft` was **null at the moment of the call**
 * (the readiness was `none`/`pending` even though the DOM later shows `data-resting-left`), or
 * `gridRight <= panelLeft`, meaning the grid genuinely ends before the panel starts and nothing is
 * covered. `readiness` and `viewportRight` in the same line separate them in one load.
 *
 * Kept in a ring buffer as well as logged, because a probe that reads `console` must install itself
 * before the load it wants to watch — which on a cold deep link is the one thing it cannot do.
 * `window.__ndsRevealTrace` is readable afterwards.
 */
const TRACE_LIMIT = 20

/**
 * The caller's OWN early exits, on the same tape.
 *
 * `revealNow` cannot delegate these — `api.isDestroyed()` and the React ref live on its side — but a
 * trace that only starts once those pass is blind exactly where the cold path fails.
 */
export function traceRevealSkip(colKey: string, intent: RevealIntent, why: 'no-api' | 'no-host'): boolean {
  return trace({ colKey, intent, readiness: 'none', panelLeft: null, why }, false)
}

function trace(entry: RevealTrace, served: boolean): boolean {
  if (process.env.NODE_ENV === 'production') return served
  const full = { ...entry, served, at: Date.now() }
  const w = globalThis as unknown as { __ndsRevealTrace?: RevealTrace[] }
  const buf = (w.__ndsRevealTrace ??= [])
  buf.push(full)
  if (buf.length > TRACE_LIMIT) buf.shift()
  // eslint-disable-next-line no-console
  console.info('[reveal]', JSON.stringify(full))
  return served
}

/**
 * §5.4 applied: how far must the grid move so this column clears the panel, and move it that far.
 * Returns whether the reveal was served.
 *
 * 🔴 The column's right edge is COMPUTED (`gridColumnRight`), not measured. AG virtualises columns,
 * so a deep-linked far-right column is not in the DOM at all — and the first version of this
 * measured what was rendered and fell back to `ensureColumnVisible` for what was not. That fallback
 * is a DESTINATION, not a distance: it parked the grid at `maxScroll` and the follow-up measurement
 * then correctly declined to move, so every cold deep link landed at the far end with the target
 * stranded on the wrong side of the viewport (UX.1 measured 1089/1089, 1377/1377, 1537/1537 — the
 * failure inverted rather than went away). The arithmetic works rendered or not, and was validated
 * against the DOM on every rendered centre column: delta 0px, 7 of 7.
 *
 * A PINNED column is never revealed by scrolling — it is always on screen — so it is nothing to do.
 */
export function revealColumn(
  api: RevealGridApi,
  host: HTMLElement,
  colKey: string,
  /* 🔴 `'uncover'` moves a cell out from under the panel; `'reveal'` may ALSO scroll LEFT to bring a
     cell in from off-screen. A `?cell=` deep link needs the second: the column may be anywhere,
     including left of the current scroll. Defaulted here only because the substrate's signature is
     still optional — PES.4 makes it required once every host forwards it, and this host does. */
  intent: RevealIntent = 'uncover',
  /* 🔴 Does the APP say a record is open? REQUIRED, and not defaulted (#750): the DOM cannot answer
     it while the drawer is arriving, and a default would let this host keep the old reading by
     saying nothing — which is exactly how the cold path stayed broken through the #747 fix. */
  recordOpen = false,
  /* 🔴 Has the identity band DERIVED its width yet? REQUIRED, and not defaulted, for the same
     reason `recordOpen` is not: a default of `true` compiles at every call site and silently keeps
     the pre-derivation reading, which is the exact defect this parameter exists to remove. Each
     sheet owns its own band and is the only thing that knows. */
  bandReady: boolean,
): boolean {
  /* 🔴 `panelLeft`, MEASURED, not derived — AG.1's #410, and the 4th argument is required so this
     line could not keep compiling with the old reading.
     I first wrote `window.innerWidth - panelWidth`, which agrees with the measurement today and
     carries three assumptions it does not: that the panel is flush to the window's right edge (a
     right rail, a margin or a max-width container each break it), that `innerWidth` equals the
     layout viewport's right edge (it can include the classic scrollbar, ~15px, while
     `getBoundingClientRect` is layout-accurate), and — the one that matters — **it derives the
     panel's POSITION from its WIDTH**, which is the exact source-vs-role conflation `panelOverlap`
     exists to remove, put back one function earlier. Caught by AG.1; the channel host had it right.
     `null` when nothing is open: no panel is not a zero-width panel. */
  // 🔴 The PANEL, not the frame's track. `[data-studio-dock]` is a 0-width flex track sitting
    // flush at the viewport's right edge; measuring it gave panelLeft 1728 and an overlap of 0, so
    // `isCellCovered` was never true and the §5.4 reveal was inert at every width. PES.4 exports
    // the one selector so this cannot drift again.
    const panel = document.querySelector<HTMLElement>(STUDIO_PANEL_SELECTOR)
  // 🔴 The panel's RESTING left, published by the drawer — NOT its live rect (#655). Measured by
  // UX.1: `.nds-drawer-dock` sits at the viewport edge for its first ~34ms (two frames) of a 249ms
  // entrance, which is exactly when a verb-opened panel mounts and this runs. Reading the rect
  // there gave overlap 0 and the reveal correctly declined; with the animation off the same cells
  // write 82/112/64. The live rect stays the VERIFICATION instrument, never the input.
  // Absent → null, the geometry's documented "not measurable" case, which defers.
  // NOT `Number(null ?? NaN)`: that yields NaN, every comparison against it is false, and
  // the reveal would decline silently — the exact shape this whole change removes.
  const readiness = panelReadiness(panel !== null, panel?.getAttribute('data-resting-left') ?? null, recordOpen)
  /* 🔴 A MOUNTING panel is "not measurable yet", not "no panel" (#747) — and so is a panel that has
     not mounted at all while the URL says a record is open (#750). Returning here is what puts the
     caller into stash-and-replay; treating either as an absent panel gave `panelOverlap: 0`, a
     distance of 0, and a `true` the caller read as success — so a cold deep link left its cell under
     the drawer and nothing reported it.

     🔴 The pair that separated the two cases, because one reading could not have: on one cold load
     at 1280 (UX.1, interceptor witnessed) `bullet_point` — inside the viewport, covered by 24px —
     wrote nothing, while `supplier_declared_dg_hz_regulation` — off the right edge — wrote 300. Only
     `panelOverlap: 0` yields both, and at that moment the panel element did not exist: the portal
     target is set by an effect, so on the URL path no panel has rendered when this first runs. */
  if (readiness.kind === 'pending') {
    return trace({ colKey, intent, readiness: 'pending', panelLeft: null, why: 'panel-not-measurable' }, false)
  }
  const panelLeft = readiness.kind === 'at' ? readiness.left : null
  /**
   * 🔴 The BAND has to have derived its width, and this is the whole of #752 (measured 2026-09-03).
   *
   * The identity column mounts at `BAND_WIDTH_FLOOR` (240) and is corrected to its content-derived
   * width once the first band renders — `MasterSheet`'s own comment states the cost: *"the column
   * mounts at the floor and is corrected once the first band exists"*. On master·DE·it that
   * correction is **240 → 404**, and the reveal's replay was landing in the 46ms before it.
   *
   * Sampled on one cold `?rec=&cell=` load at 1280, the same tape for both:
   *
   * | t     | pinned block | `bullet_point` |
   * |-------|--------------|----------------|
   * | 698ms | 43 + **240** | 510 → **620**  |
   * | 744ms | 43 + **404** | 674 → **784**  |
   *
   * The replay ran at 698 and read 620 against a panel at 760: clear by 140px, `distance` 0,
   * `served` — so the stash was retired as satisfied. The cell settles at **784**, i.e. **covered by
   * 24px**, which is exactly the figure UX.1 measured and could not explain.
   *
   * 🔴 So the diagnosis this replaces was wrong, and wrong in an instructive way. #752 recorded
   * `panelOverlap: 0` and the lanes went looking for a panel that had not mounted. Measured here:
   * `readiness: 'at'`, `panelLeft: 760`, `panelOverlap: **519**`. Every input was correct. The
   * defect was that `pinnedLeftWidth` was correct *for the instant it was read* and wrong 46ms
   * later — a stale measurement, not a missing one, and the two look identical from the outcome.
   * The far-column arm falls out of the same number: 164px of shortfall less `REVEAL_MARGIN` is the
   * **148px short** that was logged beside it.
   *
   * Deferring rather than measuring is what the panel already does one branch up. The band is the
   * second thing that arrives late, and it needed the same answer.
   */
  if (!bandReady) {
    return trace({ colKey, intent, readiness: readiness.kind, panelLeft, why: 'band-not-derived' }, false)
  }
  const geo = gridColumnGeometry(api, host, colKey, panelLeft)
  // Not measurable yet — the caller stashes and replays. NOT "nothing to do": on a cold deep link
  // this is exactly the state the reveal arrives in.
  if (!geo) return trace({ colKey, intent, readiness: readiness.kind, panelLeft, why: 'no-geometry' }, false)
  // A pinned column is always on screen; scrolling cannot reveal it and must not try.
  if (geo.pinned) return trace({ colKey, intent, readiness: readiness.kind, panelLeft, why: 'pinned' }, true)
  const distance = revealDistance(
    {
      cellRight: geo.cellRight,
      viewportRight: geo.viewportRight,
      /* 🔴 The OVERLAP, not the panel's width. `panelWidth` was never the panel's width to this
         rule — it was always "how much of the grid the panel covers", and under an overlay the two
         happen to be equal. My §5.4 inset broke that coincidence and nearly every cell started
         reading as covered while the panel covered nothing. `panelOverlap` measures the two edges
         instead of assuming a relationship between them. */
      panelOverlap: geo.panelOverlap,
      // The LEFT edges, which this host was not passing — without them `revealDistance` returns 0
      // for every off-left cell however clearly it is off screen (`revealCell.ts:89`).
      // `viewportLeft` is `hostLeft + pinnedLeftWidth`, i.e. after the pinned block, deliberately
      // asymmetric with `viewportRight`: the panel overlays the right, the pinned block occupies
      // the left.
      cellLeft: geo.cellLeft,
      viewportLeft: geo.viewportLeft,
    },
    intent,
  )
  /* 🔴 `=== 0`, not `<= 0`. A NEGATIVE distance is the answer, not the absence of one: it means
     scroll LEFT by that much. `<= 0` discarded it before `revealScroll` ever saw it, so under
     `'reveal'` the plumbing above was inert and every off-left deep link stayed off-left. Zero
     still means the cell is clear and the grid must not move — an operator who could already see
     it should not have the sheet slide under them. */
  const seen = {
    colKey, intent, readiness: readiness.kind, panelLeft,
    cellRight: geo.cellRight, viewportRight: geo.viewportRight, panelOverlap: geo.panelOverlap,
    cellLeft: geo.cellLeft, viewportLeft: geo.viewportLeft,
    scrollLeft: geo.scrollLeft, maxScroll: geo.maxScroll, distance,
  }
  if (distance === 0) return trace({ ...seen, why: 'already-clear', wrote: null }, true)
  const target = revealScroll(distance, geo.scrollLeft, geo.maxScroll)
  const el = gridScrollViewport(host)
  scrollGridTo(el, target.scrollLeft)
  // `target.unreachableBy > 0` is the trailing-column case: the grid gave everything it had and the
  // cell is still partly under the panel. The remedy is a right-hand scroll pad — UX.1's call.
  return trace({
    ...seen, why: 'scrolled', wrote: target.scrollLeft, unreachableBy: target.unreachableBy,
    viewportEl: el ? GRID_SCROLL_VIEWPORT : 'NONE — nothing to write to',
  }, true)
}
