'use client'

import { type ReactNode } from 'react'

/**
 * GridToolbar — the Ad-Manager toolbar row (`.h10-am-toolbar`) as a reusable DS
 * pattern. Renders a count on the left, caller-supplied left actions, a flexible
 * spacer, then right-aligned actions. Pair it with `.h10-ds-gridcard` (see
 * patterns.css) to seat the toolbar inside the grid card above a `DataGrid`,
 * matching the campaigns page exactly.
 *
 *   <div className="h10-ds-gridcard">
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

export function GridToolbar({ count, children, right }: GridToolbarProps) {
  return (
    <div className="h10-ds-toolbar">
      {count != null && <span className="cnt">{count}</span>}
      {children}
      <span className="grow" />
      {right}
    </div>
  )
}
