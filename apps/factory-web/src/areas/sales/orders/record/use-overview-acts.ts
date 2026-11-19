'use client'

import { useState } from 'react'
import type { OrderRecordActions, OrderRecordModel } from './record-model'

export type OverviewActsModel = Pick<OrderRecordModel, 'overviewLine'>
export type OverviewActsActions = Pick<OrderRecordActions, 'onOpenLine'>

/**
 * F-OP-134 (N-5): Overview's acts — F-SA-232: the line whose sizes the centred window shows (Overview › Progress by line). Mounted by
 * the container (OrderRecord.tsx), which hands what it returns to the view as plain props; a view never imports it. The production
 * read Overview draws is the container's (the band and every tab read it).
 */
export function useOverviewActs(): { model: OverviewActsModel; actions: OverviewActsActions } {
  const [overviewLine, setOverviewLine] = useState<string | null>(null)
  return { model: { overviewLine }, actions: { onOpenLine: setOverviewLine } }
}
