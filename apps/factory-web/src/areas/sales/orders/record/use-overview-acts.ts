'use client'

import { useState } from 'react'
import type { OrderRecordActions, OrderRecordModel, RecordDialog } from './record-model'
import { amendStyleAnchorOf } from './record-model' // F-OO-125
import { CUSTOMER_REF_FIELD_ID } from './record-model' // F-OO-209

export type OverviewActsModel = Pick<OrderRecordModel, 'overviewLine'>
export type OverviewActsActions = Pick<OrderRecordActions, 'onOpenLine' | 'onRequestedChange' | 'onLineChange' /* F-OO-125 */ | 'onCustomerRefChange' /* F-OO-209 */>

/**
 * F-OP-134 (N-5): Overview's acts — F-SA-232: the line whose sizes the centred window shows (Overview › Progress by line). Mounted by
 * the container (OrderRecord.tsx), which hands what it returns to the view as plain props; a view never imports it. The production
 * read Overview draws is the container's (the band and every tab read it).
 * F-OO-144 (order overview 10-design §4.2; review F7): Next dates' requested date "Change…" opens the small dialog in the page's one
 * dialog slot (`{ kind: 'requested' }`; its write is Lines' amendment, use-lines-acts) — the F-OP-104 hop to Lines went.
 * F-OO-125 (order overview 10-design §2.3): a line's "Change quantity or sizes…" — the same one edit path (Amend on Lines), with that
 * line's style group focused (`amend-style-<styleId>` in LinesEditor). No second editor.
 * F-OO-209 (order overview 11-design §7.2): Order facts' Customer PO "Change…" — the same one edit path, the customer PO focused
 * (CUSTOMER_REF_FIELD_ID on the Lines edit header). Ship to keeps the band's own door (use-lines-acts onChangeShipTo).
 */
export function useOverviewActs(
  input: {
    readonly startAmend?: () => void
    readonly focus?: (id: string) => void
    /** F-OO-144: the page's one dialog slot (the container's). */
    readonly setDialog?: (dialog: RecordDialog | null) => void
  } = {},
): { model: OverviewActsModel; actions: OverviewActsActions } {
  const [overviewLine, setOverviewLine] = useState<string | null>(null)
  return {
    model: { overviewLine },
    actions: {
      onOpenLine: setOverviewLine,
      // F-OO-144: the small dialog (held there by amendHeld, as the door is); no page hop.
      onRequestedChange: () => input.setDialog?.({ kind: 'requested' }),
      // F-OO-125: edit mode (an open draft kept: use-lines-acts' onAmendStart), the line's style group focused.
      onLineChange: (styleId) => {
        input.startAmend?.()
        input.focus?.(amendStyleAnchorOf(styleId))
      },
      // F-OO-209: edit mode (an open draft kept), the customer PO focused.
      onCustomerRefChange: () => {
        input.startAmend?.()
        input.focus?.(CUSTOMER_REF_FIELD_ID)
      },
    },
  }
}
