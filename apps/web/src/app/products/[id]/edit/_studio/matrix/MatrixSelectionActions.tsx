'use client'

/**
 * What the toolbar offers while rows are ticked (Owner 2026-10-07): ONE `Edit…` — every field the Matrix can change,
 * on the markets the operator picks, with a preview and Undo (`bulk/BulkEditDialog.tsx`) — and `Stock source…`, which
 * keeps its own dialog (own stock, or the stock another business lends). It replaces the three verb menus
 * (Prices · Stock · Sync, 2026-09-26): a change the Owner looked for under one of them was hard to find.
 *
 * A held button stays focusable and says why (`aria-disabled` + its reason), never a silent `disabled`.
 */
import { memo } from 'react'
import { Pencil } from 'lucide-react'

import { Button } from '@/design-system/primitives'

export interface MatrixSelectionActionsProps {
  onEdit: () => void
  /** Why Edit cannot open now (the Matrix is still loading), or null. */
  editHeld: string | null
  /** `Stock source…` — the ticked SKUs, or the whole family when the parent is ticked; null = not offered. */
  stockSource: { description: string; onSelect: () => void } | null
}

export const MatrixSelectionActions = memo(function MatrixSelectionActions({ onEdit, editHeld, stockSource }: MatrixSelectionActionsProps) {
  return (
    <>
      <Button
        size="sm"
        variant="primary"
        aria-disabled={editHeld ? true : undefined}
        className={editHeld ? 'held' : undefined}
        title={editHeld ?? 'Change price, status, fulfilment, quantity and more on the ticked rows'}
        onClick={() => { if (!editHeld) onEdit() }}
      >
        <Pencil size={12} aria-hidden /> Edit…
      </Button>
      {stockSource && (
        <Button size="sm" variant="secondary" title={stockSource.description} onClick={stockSource.onSelect}>
          Stock source…
        </Button>
      )}
    </>
  )
})
