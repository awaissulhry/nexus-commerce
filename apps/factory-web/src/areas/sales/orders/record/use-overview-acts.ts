'use client'

import { useState } from 'react'
import type { OrderRecordActions, OrderRecordModel } from './record-model'
import { REQUESTED_FIELD_ID } from './overview/model' // F-OP-104

export type OverviewActsModel = Pick<OrderRecordModel, 'overviewLine'>
export type OverviewActsActions = Pick<OrderRecordActions, 'onOpenLine' | 'onRequestedChange'>

/**
 * F-OP-134 (N-5): Overview's acts — F-SA-232: the line whose sizes the centred window shows (Overview › Progress by line). Mounted by
 * the container (OrderRecord.tsx), which hands what it returns to the view as plain props; a view never imports it. The production
 * read Overview draws is the container's (the band and every tab read it).
 * F-OP-104 (10-order-page §3.4): Next dates' requested date "Change…" — the order goes into edit mode (Amend: the lines' own acts) on
 * Lines, with that field focused (the container's focus, as "Show on the page").
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
    },
  }
}
