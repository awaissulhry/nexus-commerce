'use client'

/**
 * EntityPathCell — the cell of `entityPathColumn` (Keyword Harvest DS lane H7, 2026-10-10): the DS `EntityPath` of the
 * path at the column's field. A click in the cell is flagged for AG (`keepFromGrid`), so following a link never ticks or
 * opens the row. Keys: `entityPathKeys`.
 */
import { memo } from 'react'
import type { ICellRendererParams } from 'ag-grid-community'

import { EntityPath } from '../../components/EntityPath'
import type { EntityLinkComponent } from '../../components/EntityLinks'
import type { EntityRef } from '../../components/entityLinksModel'
import { keepFromGrid } from './rowVerbs'

export interface EntityPathCellParams<T = unknown> {
  linkAs?: EntityLinkComponent
  /** What the path is for this row, for a screen reader: "Goes to". */
  label?: (row: T) => string
}

/** The cell value as a path (top first); anything else is empty. */
export const entityPathOf = (value: unknown): Array<EntityRef | null> => (Array.isArray(value) ? (value as Array<EntityRef | null>) : [])

function EntityPathCellView<T>(p: ICellRendererParams<T> & EntityPathCellParams<T>) {
  if (!p.data) return null
  return (
    <span className="nds-cell-entitylinks" onClickCapture={keepFromGrid}>
      <EntityPath items={entityPathOf(p.value)} linkAs={p.linkAs} label={p.label?.(p.data)} />
    </span>
  )
}

export const EntityPathCell = memo(EntityPathCellView) as typeof EntityPathCellView
