'use client'

import { useState } from 'react'
import type { OrderRecordActions, OrderRecordModel } from './record-model'
import { REQUESTED_FIELD_ID } from './overview/model' // F-OP-104
import { amendStyleAnchorOf } from './record-model' // F-OO-125

export type OverviewActsModel = Pick<OrderRecordModel, 'overviewLine'>
export type OverviewActsActions = Pick<OrderRecordActions, 'onOpenLine' | 'onRequestedChange' | 'onLineChange' /* F-OO-125 */>

/**
 * F-OP-134 (N-5): Overview's acts — F-SA-232: the line whose sizes the centred window shows (Overview › Progress by line). Mounted by
 * the container (OrderRecord.tsx), which hands what it returns to the view as plain props; a view never imports it. The production
 * read Overview draws is the container's (the band and every tab read it).
 * F-OP-104 (10-order-page §3.4): Next dates' requested date "Change…" — the order goes into edit mode (Amend: the lines' own acts) on
 * Lines, with that field focused (the container's focus, as "Show on the page").
 * F-OO-125 (order overview 10-design §2.3): a line's "Change quantity or sizes…" — the same one edit path (Amend on Lines), with that
 * line's style group focused (`amend-style-<styleId>` in LinesEditor). No second editor.
 */
export function useOverviewActs(input: { readonly startAmend?: () => void; readonly focus?: (id: string) => void } = {}): { model: OverviewActsModel; actions: OverviewActsActions } {
  const [overviewLine, setOverviewLine] = useState<string | null>(null)
  return {
    model: { overviewLine },
    actions: {
      onOpenLine: setOverviewLine,
      onRequestedChange: () => {
        input.startAmend?.()
        input.focus?.(REQUESTED_FIELD_ID)
      },
      // F-OO-125: edit mode (an open draft kept: use-lines-acts' onAmendStart), the line's style group focused.
      onLineChange: (styleId) => {
        input.startAmend?.()
        input.focus?.(amendStyleAnchorOf(styleId))
      },
    },
  }
}
