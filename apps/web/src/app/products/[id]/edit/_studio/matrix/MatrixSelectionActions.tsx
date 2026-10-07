'use client'

/**
 * What the toolbar offers while rows are ticked (Owner 2026-10-07): ONE `Edit…` — every field the Matrix can change,
 * on the markets the operator picks, with a preview and Undo (`bulk/BulkEditDialog.tsx`) — and `Stock source…`, which
 * keeps its own dialog (own stock, or the stock another business lends). It replaces the three verb menus
 * (Prices · Stock · Sync, 2026-09-26): a change the Owner looked for under one of them was hard to find.
 *
 * Step 4 (Owner 2026-10-07): `Send to FBA…` — the ticked SKUs (a ticked parent = every variation) into ONE dialog that
 * creates an Amazon inbound plan (`fba/SendToFbaDialog.tsx`). Offered to a person who may manage inbound, on a family
 * that is on Amazon, outside preview.
 *
 * A held button stays focusable and says why (`aria-disabled` + its reason), never a silent `disabled`.
 */
import { memo } from 'react'
import { Pencil } from 'lucide-react'

import { FBA_SEND_COPY } from '@nexus/shared/fba-send'

import { Button } from '@/design-system/primitives'

export interface MatrixSelectionActionsProps {
  onEdit: () => void
  /** Why Edit cannot open now (the Matrix is still loading), or null. */
  editHeld: string | null
  /** `Stock source…` — the ticked SKUs, or the whole family when the parent is ticked; null = not offered. */
  stockSource: { description: string; onSelect: () => void } | null
  /** `Send to FBA…` — the ticked SKUs; `held` = why it cannot open now (still loading, too many SKUs); null = not offered. */
  sendToFba?: { description: string; held: string | null; onSelect: () => void } | null
}

export const MatrixSelectionActions = memo(function MatrixSelectionActions({ onEdit, editHeld, stockSource, sendToFba }: MatrixSelectionActionsProps) {
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
      {sendToFba && (
        <Button
          size="sm"
          variant="secondary"
          aria-disabled={sendToFba.held ? true : undefined}
          className={sendToFba.held ? 'held' : undefined}
          title={sendToFba.held ?? sendToFba.description}
          onClick={() => { if (!sendToFba.held) sendToFba.onSelect() }}
        >
          {FBA_SEND_COPY.open}
        </Button>
      )}
    </>
  )
})
