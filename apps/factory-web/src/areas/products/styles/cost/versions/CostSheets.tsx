'use client'

import type { StyleView } from '@nexus/factory-domain/product/styles/contracts'
import { useCostSheets } from './use-cost-sheets'
import { CostSheetsView } from './view/CostSheetsView'

/**
 * Style › Cost, the cost sheets of W2b (B-W2b-430), the container the Style studio mounts in the Cost tab's section list
 * (StyleRecordView's `costSheets` slot): it reads and writes through `useCostSheets`, the view draws it.
 */
export function CostSheets({ style, revisionId, cell }: { style: StyleView; revisionId: string | null; cell: { colourwayId: string; size: string } | null }) {
  const { model, actions } = useCostSheets({ style, revisionId, cell })
  return <CostSheetsView model={model} actions={actions} />
}
