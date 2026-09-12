'use client'

/**
 * PES.4 — the bridge between PES.1's reserved track and this lane's panel.
 *
 * The frame renders `<aside data-studio-dock>` as a FLEX SIBLING of the tab body and puts nothing
 * inside it: the track's width is `var(--studio-dock-w, 0px)` and PES.4 publishes that value. So
 * this component does exactly three things, and deliberately nothing else:
 *
 *   1. finds the track,
 *   2. sets `--studio-dock-w` ON THE TRACK ITSELF — scoped, since `.dock` is where the var is
 *      read, so no global custom property is written and no other surface can be affected,
 *   3. portals the drawer into it.
 *
 * Portalling here does NOT make the drawer a floating overlay. The portal TARGET is an in-flow
 * flex sibling, so the sheet still shrinks beside the panel rather than being covered — which is
 * the whole point of the dock and the reason `Drawer mode="dock"` carries no portal of its own.
 *
 * ⚠ The track is `overflow: hidden` (studio.module.css). Anything the drawer opens that is
 * `position: absolute` — a tooltip bubble, a listbox popup — is therefore clipped BY THE TRACK,
 * rendered but invisible and un-hit-testable, with no error anywhere
 * (reference_gridcard_clips_dropdowns). `position: fixed` popups escape it; absolutely-positioned
 * ones do not. Verified in PES.4.8 rather than assumed.
 */

import { useEffect, useRef, useState } from 'react'
import { restingPanel, type RevealIntent } from './revealCell'
import { createPortal } from 'react-dom'
import { useStudioRecord } from '../contracts'
import { RecordDrawer, type RecordDrawerProps } from './RecordDrawer'
import type { SheetRow } from './types'
import { useDrawerWidth } from './useRecordDrawer'

/**
 * What the host passes: the DATA. Open state, width, focus cell and close all come from the frame
 * and this lane, so a sheet mounting this writes one line and owns none of the drawer's behaviour.
 */
export type StudioDockProps<R extends SheetRow = SheetRow> = Omit<
  RecordDrawerProps<R>,
  'width' | 'onWidthChange' | 'onClose' | 'className' | 'row' | 'focusKey'
> & {
  /** Resolve the open row id against the rows the grid ALREADY holds. Null while it cannot. */
  resolveRow: (rowId: string) => R | null
  /**
   * §5.4 — uncover the cell the record was opened from.
   *
   * The panel overlays the right edge of the sheet, so opening a record from a column in that band
   * hides the very cell that prompted it, and nothing on screen says so. The sheet holds the
   * `GridApi`; this panel does not — so it reports WHEN and against WHAT, and the host scrolls:
   * `api.ensureColumnVisible(colKey, 'start')` is the supported mechanism (needs `ScrollApiModule`,
   * registered by AG.1 #184, before which it threw). `isCellCovered` / `revealDistance` in
   * `./revealCell` are the shared rule, exported so a host never re-derives the threshold.
   *
   * Called ONCE per opened cell, never per render: re-scrolling the grid while an operator reads
   * is worse than the problem it fixes.
   *
   * 🔴 **It needs a `colKey`, and a row-only open is a valid open that reveals NOTHING.** The
   * `open-record` verb opens with a row id alone, so this never fires for it — correctly: there is
   * no originating cell to uncover. A host that wants the reveal must supply the cell, and must
   * supply the RIGHT one: reading `getFocusedCell()` when a verb runs yields the chrome cell the
   * click just moved focus to (`actions`), which is pinned and always visible, so the reveal
   * computes "not covered" and silently does nothing. Track the last anchor-worthy focus instead —
   * `isRevealAnchor` in `./revealCell` is that rule, shared so master and channel cannot disagree
   * about what counts as chrome. Measured by PES.3 (#227); the feature ran, measured fine, and left
   * the operator's cell hidden.
   */
  /**
   * 🔴 The panel's width is NOT passed (#457).
   *
   * It used to be, and both hosts ignored it: what `revealDistance` needs is how much of the grid
   * the panel COVERS, and only the host can measure that — the dock knows where it is, not what it
   * lies on top of. Under an overlay the two numbers coincided, which is the whole reason a width
   * was travelling under the name of an overlap. A parameter every consumer discards is not
   * harmless: it is a standing invitation to use it for the thing it resembles.
   *
   * A host that ever needs the dock's own width measures the dock element.
   */
  onRevealCell?: (colKey: string, intent: RevealIntent) => void
}

/**
 * 🔴 How a host finds the PANEL — the one selector, exported so nobody re-derives it.
 *
 * Two elements in this studio answer to the name "studio dock" and only one of them is the panel:
 *
 *   `[data-studio-dock]`  the frame's flex TRACK. Deliberately 0 wide (see the note below), so its
 *                         box sits flush against the viewport's right edge.
 *   `.nds-drawer-dock`    the panel itself — `position: fixed`, 520px, portalled INTO that track.
 *
 * Both hosts asked for `'.nds-studio-dock, [data-studio-dock]'`. The first does not exist; the
 * second is the track. So they measured a zero-width box at x=1728, computed `panelOverlap: 0`,
 * and `isCellCovered` was never true — the §5.4 reveal was inert at every width, with nothing
 * locally wrong at any single line. Measured 1728: track left 1728 / width 0 against panel left
 * 1208 / width 520.
 *
 * It could not be caught until PES.2's staged inset was deleted, because until then the grid really
 * was narrowed out from under the panel and an overlap of 0 was the truth. A check that cannot fail
 * is not a check that is passing (UX.1, #601).
 */
export const STUDIO_PANEL_SELECTOR = '.nds-drawer-dock'

export function StudioDock<R extends SheetRow = SheetRow>({ resolveRow, onRevealCell, ...rest }: StudioDockProps<R>) {
  const record = useStudioRecord()
  const { width, setWidth } = useDrawerWidth()
  const [track, setTrack] = useState<HTMLElement | null>(null)

  // The frame renders the track; this runs after mount, so it is there by now. Re-queried when the
  // open record changes so a remount of the frame (a market switch, a scope change) is picked up
  // rather than leaving the panel portalled into a detached node.
  useEffect(() => {
    setTrack(document.querySelector<HTMLElement>('[data-studio-dock]'))
  }, [record.rowId])

  // Publish the width the frame reserves. Set on the track, not on :root — `.dock` is where the
  // var is read, so scoping it there means nothing outside this panel can see it.
  const open = record.rowId != null

  /**
   * The track stays 0px — ALWAYS, now (layout-v2 §5).
   *
   * The panel used to be docked, so it published its width and the sheet reflowed around it. A
   * slide-over overlays instead: "the sheet keeps its full width underneath", which is most of what
   * the v2 reproportioning bought (1660px of sheet with a record open, against 1140 docked). Still
   * setting the var would narrow the sheet by 520px for no visual gain and undo that.
   *
   * It is set rather than left alone because the frame's `.dock:not(:empty)` rule draws a seam once
   * this portals content in, and a 0-width track with a border is a 1px line down the viewport.
   */
  useEffect(() => {
    if (!track) return
    track.style.setProperty('--studio-dock-w', '0px')
    // The frame draws a seam on `.dock:not(:empty)`, and portalling a panel in makes the track
    // non-empty even though the panel is `position: fixed` and takes no space. Left alone that is a
    // 1px line down the full height of the viewport, belonging to nothing. Suppressed here rather
    // than in the frame's stylesheet because the track is PES.1's and this is PES.4's consequence.
    track.style.setProperty('border-left-width', '0px')
  }, [track, open])

  /**
   * Publish where the panel WILL be, before it gets there (#651/#653).
   *
   * 🔴 Measured by UX.1 in a visible browser: `.nds-drawer-dock` enters over ~249ms / 28 frames, and
   * for the first ~34ms — two frames — its rect is the viewport's right edge. That is exactly the
   * window a host reads in when the panel mounts in the same commit as `?rec=`, so it computed an
   * overlap of 0 and correctly declined to scroll. The rule was never wrong; the geometry handed to
   * it was. With the animation disabled the same cells write 82/112/64 at 1440/1280/1728 — the
   * shortfall plus the 16px margin — which is what this makes true with the animation running.
   *
   * Published rather than awaited: waiting on the animation is unbounded, and in a tab where it
   * never runs it would trade a missing scroll for a missing reveal.
   *
   * Declared ABOVE the reveal effect deliberately — React runs effects in declaration order, so the
   * attribute is on the element before the reveal that reads it is delivered.
   */
  useEffect(() => {
    if (!open) return
    const apply = () => {
      const panel = document.querySelector<HTMLElement>(STUDIO_PANEL_SELECTOR)
      if (!panel) return
      const rest = restingPanel(window.innerWidth, width)
      panel.setAttribute('data-resting-left', String(rest.left))
      // A full-bleed panel covers the sheet entirely; scrolling a grid nobody can see is pointless.
      // Stated on the element rather than left as a silent no-op, because a silent refusal is
      // indistinguishable from a rule that ran and found nothing — the shape this reveal has
      // already been bitten by twice.
      if (rest.coversSheet) panel.setAttribute('data-reveal-skipped', 'panel-covers-sheet')
      else panel.removeAttribute('data-reveal-skipped')
    }
    apply()
    // A published value does not correct itself the way a measurement would.
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
    /**
     * 🔴 `track` IS a dependency, and leaving it out regressed the URL path (UX.1, measured).
     *
     * On the VERB path `track` is already set and `open` flips false→true, so this runs in a commit
     * where the portal — and therefore the panel — is in the DOM. On the URL path `open` is true
     * from the FIRST render while `track` is still null, so no portal has rendered: this ran once,
     * found no panel, returned early, and never re-ran. The attribute was never written, the host
     * read null, and the reveal deferred — `writes []` where it had written [82].
     *
     * Same shape as the reveal's own early-return-and-never-retry, one effect over: a guard that
     * returns on "not ready yet" needs the readiness in its deps, or "not yet" becomes "never".
     */
  }, [open, width, track])

  // Keyed on row AND cell, so re-opening the same cell after a close reveals it again while
  // re-rendering with the panel already open does nothing.
  const revealed = useRef<string | null>(null)
  /**
   * True until the first reveal has been delivered. Set in the BODY of the effect rather than in a
   * cleanup: a cleanup-only flag latches under StrictMode's mount/unmount/mount and the first real
   * delivery would then be classed as in-app, losing the deep link the rule exists for.
   */
  const firstDelivery = useRef(true)
  useEffect(() => {
    const key = record.rowId && record.colKey ? `${record.rowId}:${record.colKey}` : null
    if (!key) {
      revealed.current = null
      return
    }
    if (revealed.current === key) return
    const colKey = record.colKey
    if (!colKey || !onRevealCell) return

    /**
     * Delivered SYNCHRONOUSLY, and the dedupe is marked only once it has been.
     *
     * 🔴 This briefly used deferred retries (0/150/400ms) on the theory that a cold load fires
     * before the host's grid api exists. That made it strictly worse, and the mechanism is worth
     * recording because it is invisible in review: under StrictMode's double-invocation the first
     * run marked the key and scheduled the timers, the immediate cleanup CANCELLED them, and the
     * second run saw the key already marked and returned without scheduling. Net effect: zero
     * calls, where before there had been one. It is why my warm-grid reading failed too — the api
     * was ready and nothing ever asked it.
     *
     * So: no timers to cancel, nothing for a cleanup to undo, and the mark records what was
     * actually delivered rather than what was intended. If the host still needs the call later
     * (its grid not yet ready), that wants a `gridReady` signal replayed once — a contract change
     * with the host, not more guessing from this side.
     */
    /**
     * #412 — which question the host should answer.
     *
     * The FIRST delivery after mount is a deep link: the cell arrived in the URL before this
     * component existed, and the operator is asking to SEE it. Every later delivery is in-app — a
     * verb, or opening another cell — where the grid is already where the operator put it and
     * moving it leftward would be the defect the never-negative rule exists to prevent.
     *
     * Derived here rather than sniffed by the host, because only this side knows whether the cell
     * predates the mount. It is one bit, passed explicitly; the host does not guess.
     */
    // Abstain, with the reason already on the element (see the effect above).
    if (restingPanel(window.innerWidth, width).coversSheet) return

    const intent: RevealIntent = firstDelivery.current ? 'reveal' : 'uncover'
    firstDelivery.current = false
    revealed.current = key
    onRevealCell(colKey, intent)
    // `width` is no longer a dependency: it is not passed, and a resize must not re-fire a reveal.
  }, [record.rowId, record.colKey, onRevealCell])

  if (!track || !open) return null
  // The panel fills the track; the TRACK carries the pixel width, so one number drives both and
  // they cannot disagree mid-drag.
  return createPortal(
    <RecordDrawer
      key={JSON.stringify([record.rowId, rest.scope])}
      {...rest}
      row={record.rowId ? resolveRow(record.rowId) : null}
      focusKey={record.colKey}
      // A px width, not "100%": the panel is `position: fixed` now and sizes ITSELF, so this is
      // the operator's persisted preference and what `.nds-drawer-grip` drags.
      width={width}
      onWidthChange={setWidth}
      onClose={record.close}
    />,
    track,
  )
}
