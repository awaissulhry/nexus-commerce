'use client'

/**
 * PES.1 — the collapsing product header (v2 spec §4).
 *
 * 48px → 32px as the GRID scrolls. Three things about this are load-bearing:
 *
 * 1. 🔴 **The arming invariant.** Collapse is armed iff `R − C ≥ T`, where `R` is the scroll range
 *    measured against EXPANDED geometry. Collapsing frees `C`, which shrinks the remaining range to
 *    `R − C`; if that falls below the threshold the grid can no longer hold the scroll position that
 *    caused the collapse, so it expands, so the range returns, so it collapses. Hysteresis alone
 *    cannot fix that, because the range itself moves. **Never recompute the arming test from
 *    collapsed geometry — that IS the loop.** With v2's proportions a 21-row family at 906px has
 *    R = 22 and never collapses, which is the rule working, not a defect: there is nothing to gain.
 *
 * 2. 🔴 **No height animation.** `GridSheet` re-measures its own top through a `ResizeObserver` on
 *    `document.body`, so animating 48→32 over 150ms makes AG re-virtualise on every frame. The
 *    height SNAPS; only the header's contents animate (see `studio.module.css`).
 *
 * 🔴 **This feature depends on the 36px row height, and the dependency is invisible.** At 28px rows
 *    the v2 budget leaves the grid ZERO scroll range at 906px (content 644 against a 678px
 *    viewport), so `R` is 0, the arming test fails everywhere and the header never collapses on any
 *    family. The 36px row the Owner ratified for the thumbnail is what restores it (content 812,
 *    R = 134, still 118 after the collapse). So: **anyone who "optimises" the row height back to
 *    28px silently kills this feature**, and it presents as a collapse bug — someone will come
 *    hunting in the threshold logic below, which will be perfectly correct. Spec §4.3 has the table.
 *
 * 3. **State is a ref plus a class toggle**, never the URL and never the provider. A provider change
 *    would re-render every consumer — including the sheet — on each threshold crossing, which is a
 *    lot of work to move 16 pixels.
 */

import { useCallback, useEffect, useRef } from 'react'

/** Height freed by collapsing: 48 → 32. */
const C = 16
/** Collapse threshold — one row. */
const T = 32
/** Expand at or below this, so the two edges never meet. */
const HYSTERESIS = 16
/**
 * How long to wait for a replacement sheet to put rows in the DOM before answering #549's question
 * anyway. Generous because it is not a timing target: the Master sheet was measured taking ~15s to
 * render, and answering early expands a header that did not need to move.
 */
const REPLACEMENT_SETTLE_MS = 20_000

/** AG 36's vertical scroller. `.ag-body-viewport` does not exist in this version. */
const SCROLLER = '.ag-grid-viewport'

export interface HeaderCollapse {
  /** Put on the frame element; drives the CSS. */
  collapsedClass: string
  /** Call when something changes the row count, the viewport, the view or the drawer. */
  reassess: () => void
}

export function useHeaderCollapse(frameRef: React.RefObject<HTMLElement | null>, collapsedClass: string) {
  const collapsed = useRef(false)
  const armed = useRef(false)
  /** A sheet was just swapped in and the #549 question has not been answered yet. */
  const pendingReplacement = useRef(false)
  /** Last scroll range the #549 question was answered for. `-1` = not yet measured. */
  const lastRange = useRef(-1)
  /** Height the header gives back, measured once from the DOM rather than assumed. */
  const setCollapsed = useCallback(
    (next: boolean) => {
      if (collapsed.current === next) return
      collapsed.current = next
      frameRef.current?.classList.toggle(collapsedClass, next)
    },
    [frameRef, collapsedClass],
  )

  const evaluate = useCallback(
    (scroller: HTMLElement) => {
      /*
       * `R` against EXPANDED geometry. While collapsed the viewport is C taller than it would be
       * expanded, so the expanded range is the current range PLUS what collapsing gave back — which
       * is how the test stays independent of the state it controls.
       */
      const currentRange = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
      const expandedRange = expandedScrollRange(currentRange, collapsed.current)
      armed.current = collapseIsArmed(expandedRange)
      if (!armed.current) {
        setCollapsed(false)
        return
      }
      const top = scroller.scrollTop
      if (!collapsed.current && top > T) setCollapsed(true)
      else if (collapsed.current && top <= HYSTERESIS) setCollapsed(false)
    },
    [setCollapsed],
  )

  const reassess = useCallback(() => {
    const scroller = frameRef.current?.querySelector<HTMLElement>(SCROLLER)
    if (scroller) evaluate(scroller)
  }, [frameRef, evaluate])

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return

    let scroller: HTMLElement | null = null
    let raf = 0
    const onScroll = () => {
      // One evaluation per frame: a scroll event fires far more often than 16px of movement matters.
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        if (scroller) evaluate(scroller)
      })
    }

    /*
     * Answer the replacement question once the sheet has actually rendered.
     *
     * Retries while the grid is still empty, because an empty grid and a short sheet are the same
     * measurement (`scrollHeight === clientHeight`) and only one of them should expand the header.
     * The timeout is the case that never resolves — a sheet that genuinely has no rows — where the
     * honest answer IS "cannot sustain collapse", so it falls through to the same check.
     */
    let settleRaf = 0
    let settleDeadline = 0
    const settleReplacement = () => {
      if (settleRaf) return
      if (!settleDeadline) settleDeadline = Date.now() + REPLACEMENT_SETTLE_MS
      settleRaf = requestAnimationFrame(() => {
        settleRaf = 0
        if (!scroller || !pendingReplacement.current) return
        const hasRows = !!scroller.querySelector('.ag-row')
        if (!hasRows && Date.now() < settleDeadline) {
          settleReplacement()
          return
        }
        pendingReplacement.current = false
        settleDeadline = 0
        const currentRange = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
        lastRange.current = currentRange
        if (!collapseSurvivesReplacement(currentRange, collapsed.current)) setCollapsed(false)
      })
    }

    const attach = () => {
      const found = frame.querySelector<HTMLElement>(SCROLLER)
      if (found === scroller) {
        /*
         * 🔴 Same ELEMENT, different sheet.
         *
         * #549 was written when a scope switch replaced the scroller, so "replacement" was the
         * signal. After the RSC-remount fix (#284) it usually is not: the route no longer
         * re-renders, AG keeps the same viewport node and swaps the data inside it. Measured —
         * Master → Amazon, same element throughout, range 81 → 0. Keying the exception on element
         * identity would therefore have made it dead code on the very gesture it was written for,
         * and it would have LOOKED implemented.
         *
         * The event that actually matters is the one #549 describes: the scroll range changing to
         * something that can no longer sustain a collapse. So ask on any range change, whatever
         * caused it — a scope switch, a filter, rows arriving.
         */
        if (!scroller) return
        const range = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
        if (range === lastRange.current) return
        lastRange.current = range
        pendingReplacement.current = true
        settleReplacement()
        return
      }
      scroller?.removeEventListener('scroll', onScroll)
      scroller = found
      scroller?.addEventListener('scroll', onScroll, { passive: true })
      lastRange.current = -1
      /*
       * 🔴 NOT `evaluate()` — spec §3.5a: chrome state changes on SCROLL, never on NAVIGATION.
       *
       * A new scroller means the sheet was replaced: a scope, market or tab switch. Evaluating in
       * full here un-collapsed the header every time, because the replacement sheet starts at
       * scrollTop 0 — so the scope chips jumped 16px BETWEEN THE TWO CLICKS of a Master → Amazon →
       * Master gesture, moving the target the operator was aiming at (measured by SR.1).
       *
       * Hub #549 carves out exactly one exception, and it is the case where staying collapsed is
       * not conservative but WRONG: if the new sheet cannot scroll far enough to sustain a
       * collapse, the collapsed state is unreachable by scrolling, so the header would be stuck
       * hiding content with no gesture available to get it back. Then, and only then, expand. If
       * the sheet can sustain it, do nothing — which is §3.5a's whole point. So the chrome moves
       * only when the sheet cannot scroll.
       *
       * ⚠ The measurement cannot be taken here. At the moment the scroller is inserted the grid has
       * not laid out and has no rows, so `scrollHeight === clientHeight` and the range reads 0 —
       * indistinguishable from a genuinely short sheet. Acting on that would expand on EVERY
       * switch, which is the jump this rule exists to remove. (Measured: the Master sheet takes
       * ~15s to put rows in the DOM.) So the decision is deferred until the sheet has actually
       * rendered, and `settleReplacement` below owns that.
       */
      pendingReplacement.current = true
      settleReplacement()
    }

    attach()
    /*
     * The grid mounts, remounts and re-virtualises under us — a tab change, a scope change or a view
     * change replaces the scroller entirely. Watching the subtree is what keeps the listener bound
     * to the element that actually exists, rather than to one that was removed. Re-binding only;
     * §3.5a forbids the state change that used to come with it.
     *
     * The ResizeObserver DOES still evaluate: a size change is the operator resizing their window,
     * not navigating, so §3.5a does not apply and §4.2's re-arm does.
     */
    const mo = new MutationObserver(attach)
    mo.observe(frame, { childList: true, subtree: true })
    const ro = new ResizeObserver(() => { attach(); if (scroller) evaluate(scroller) })
    ro.observe(frame)

    return () => {
      mo.disconnect()
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
      if (settleRaf) cancelAnimationFrame(settleRaf)
      scroller?.removeEventListener('scroll', onScroll)
    }
  }, [frameRef, evaluate])

  return { reassess }
}

/**
 * The arming rule, with no DOM — and the ONLY copy of it. `evaluate()` above calls this rather than
 * restating the arithmetic.
 *
 * 🔴 It used to be a second definition carrying the comment "exported for test" while no test
 * existed and nothing called it (FE.1 set-scanned the repo: two files, neither a test, 0 refs). So
 * the invariant lived in two places and the copy the comment protected was both untested and
 * unreachable — a comment asserting a guard the repo lacks is worse than no comment, because it
 * stops the next reader looking.
 */
export function collapseIsArmed(expandedRange: number, freed = C, threshold = T): boolean {
  return expandedRange - freed >= threshold
}

/**
 * On scroller REPLACEMENT: does the collapsed state survive, or must the header expand?
 *
 * Hub #549's exception to §3.5a, and the ONLY question asked at a replacement — deliberately not
 * the scrollTop rule, which is what used to un-collapse the header on every scope switch. A
 * replacement can therefore EXPAND the header, never collapse it.
 */
export function collapseSurvivesReplacement(currentRange: number, isCollapsed: boolean): boolean {
  return collapseIsArmed(expandedScrollRange(currentRange, isCollapsed))
}

/**
 * The scroll range as it would be with the header EXPANDED.
 *
 * While collapsed the viewport is `C` taller than it would be expanded, so the expanded range is
 * the current range plus what collapsing gave back. Measuring it this way is what keeps the arming
 * test independent of the state it controls — recomputing from collapsed geometry is the
 * oscillation loop in one line.
 */
export function expandedScrollRange(currentRange: number, isCollapsed: boolean, freed = C): number {
  return isCollapsed ? currentRange + freed : currentRange
}
