'use client'

/**
 * PES.1 — the frame. Four fixed tracks and one flexible body.
 *
 *   ┌ header ── DetailHeader dense: back · identity · autosave · Publish ▾  48px, COLLAPSES to 32
 *   ├ bar    ── chips + tabs + market/locale, ONE row (v2 §3)               40px, never collapses
 *   └ body   ── the active tab, and PES.4's dock, as SIBLINGS              (the remainder)
 *
 * v2 (ruling #169/#182) merged the 44px scope bar and the 34px tab strip into one 40px row and made
 * the header collapse — together with the sheet's own savings that is +164px of rows at every
 * viewport height. The band that used to state a readiness failure is gone from here: nothing above
 * the grid may push it down (§6.6), so that note now belongs in the sheet's footer strip.
 *
 * Nothing here scrolls. See `studio.module.css` for why that is load-bearing rather than a taste:
 * `GridSheet` measures its own height from the document, so a sheet inside a scrolling container
 * would size itself once and then be wrong for the rest of the session.
 */

import { useRef } from 'react'

import { StudioSubheader } from './StudioSubheader'
import { StudioTabHost } from './StudioTabHost'
import { useHeaderCollapse } from './useHeaderCollapse'
import styles from './studio.module.css'

export function StudioFrame() {
  const frameRef = useRef<HTMLDivElement>(null)
  // 48 → 32 on GRID scroll, armed only when the scroll range can survive the collapse (§4.2).
  useHeaderCollapse(frameRef, styles.collapsed)
  // A <div>, not a <main>: AppShell's `noRail` branch already renders `<main id="main-content">`
  // around this route, and a second main landmark inside it would give the page two. (/products/next
  // does nest one — an existing flaw in the benchmark, not a thing to copy.)
  return (
    <div ref={frameRef} className={styles.shell}>
      <div className={styles.bands}>
        <StudioSubheader frameRef={frameRef} />
      </div>
      <div className={styles.body}>
        <div className={styles.tabBody}>
          <StudioTabHost />
        </div>
        {/* PES.4's dock track, granted as requested: a SIBLING of the tab body, so an open record
            shrinks the sheet instead of covering it. The frame reserves the track and publishes
            nothing into it; PES.4 renders the panel and sets `--studio-dock-w`. Empty and 0px
            wide until then. */}
        <aside className={styles.dock} data-studio-dock aria-label="Record" />
      </div>
    </div>
  )
}
