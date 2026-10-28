'use client'

/**
 * EntityLinksCell — the cell of `entityLinksColumn` (bid page DS lane, 2026-10-10): the DS `EntityLinks` of the
 * things at the column's field. A click in the cell is flagged for AG (`keepFromGrid`), so following a link or opening
 * the list never ticks or opens the row; Esc in the list gives the focus back to the cell.
 */
import { memo } from 'react'
import type { ICellRendererParams } from 'ag-grid-community'

import { EntityLinks, type EntityLinkComponent } from '../../components/EntityLinks'
import type { EntityNoun, EntityRef } from '../../components/entityLinksModel'
import { keepFromGrid } from './rowVerbs'

export interface EntityLinksCellParams<T = unknown> {
  noun: EntityNoun
  linkAs?: EntityLinkComponent
  /** The list's accessible name for this row: "Campaigns of Rule A". */
  listLabel?: (row: T) => string
  /** The row's true count when its list is capped (polish round 2): "153 campaigns" over 100 links. */
  total?: (row: T) => number | null | undefined
}

/** The cell value as things to link to; anything else is none. */
export const entityRefsOf = (value: unknown): EntityRef[] => (Array.isArray(value) ? (value as EntityRef[]) : [])

function EntityLinksCellView<T>(p: ICellRendererParams<T> & EntityLinksCellParams<T>) {
  if (!p.data) return null
  const cell = p.eGridCell
  return (
    <span className="nds-cell-entitylinks" onClickCapture={keepFromGrid}>
      <EntityLinks
        items={entityRefsOf(p.value)}
        total={p.total?.(p.data)}
        noun={p.noun}
        linkAs={p.linkAs}
        listLabel={p.listLabel?.(p.data)}
        returnFocus={cell ? () => cell.focus() : undefined}
      />
    </span>
  )
}

export const EntityLinksCell = memo(EntityLinksCellView) as typeof EntityLinksCellView
