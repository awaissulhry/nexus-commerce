'use client'

import { useRef, type ReactNode } from 'react'
import { useHorizontalOverflow } from '../components/useHorizontalOverflow'

/**
 * GridToolbar — the Ad-Manager toolbar row (`.h10-am-toolbar`) as a reusable DS
 * pattern. Renders a count on the left, caller-supplied left actions, a flexible
 * spacer, then right-aligned actions. Pair it with `.nds-gridcard` (see
 * patterns.css) to seat the toolbar inside the grid card above a `DataGrid`,
 * matching the campaigns page exactly.
 *
 *   <div className="nds-gridcard">
 *     <GridToolbar count={<>Viewing <b>1–16</b> of 16 products</>} right={…}>
 *       {leftActions}
 *     </GridToolbar>
 *     <DataGrid … />
 *   </div>
 */
export interface GridToolbarProps {
  /** Left-most count text, e.g. "Viewing 1–16 of 16 products". Bold the numbers with <b>. */
  count?: ReactNode
  /** Left-aligned actions placed after the count (e.g. selection actions, search). */
  children?: ReactNode
  /** Right-aligned actions (e.g. Customise, Export, density, Live). */
  right?: ReactNode
}

/** How long the bar must keep overflowing, unchanged, before it makes room for its scrollbar (the fold latches in
 *  1–2 frames, its last tier a render later; measured in Chromium). */
const TOOLBAR_SETTLE_MS = 250

export function GridToolbar({ count, children, right }: GridToolbarProps) {
  const bar = useRef<HTMLDivElement>(null)
  // A sheet's toolbar scrolls sideways on its 40px band (grid.css): while it does, the band grows for the
  // scrollbar instead of the bar drawing it over the controls. It SETTLES first: on every load the bar overflows
  // for a frame or two until `GridToolbarFold` folds the chips, and marking at once made the toolbar jump.
  useHorizontalOverflow(bar, { settleMs: TOOLBAR_SETTLE_MS })
  return (
    <div className="nds-toolbar" ref={bar}>
      {count != null && <span className="cnt">{count}</span>}
      {children}
      <span className="grow" />
      {right}
    </div>
  )
}
