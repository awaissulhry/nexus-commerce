'use client'

import type { ReactElement } from 'react'
import type { StyleView } from '@nexus/factory-domain/product/styles/contracts'
import { useOfficeSession } from '../../../../../lib/session/context'
import { abilitiesOf, grainsOf } from '../../model'
import { costTabOpen } from '../now/model'
import { useCostSheets } from './use-cost-sheets'
import { CostSheetsView } from './view/CostSheetsView'

/**
 * Style › Cost, the cost sheets of W2b (B-W2b-430), the container the Style studio mounts in the Cost tab's section list
 * (StyleRecordView's `costSheets` slot): it reads and writes through `useCostSheets`, the view draws it.
 * owb-pd5b (step 5.3): with the cost grain the tab's own page (page/CostPage.tsx) draws these parts in the design's order (by size, the
 * kept versions; the other costs, the target price and the size mix under "More") and reads them once, so this slot draws nothing then;
 * without the cost grain it draws them as before (the structure, no figure).
 */
export function CostSheets({ style, revisionId, cell }: { style: StyleView; revisionId: string | null; cell: { colourwayId: string; size: string } | null }): ReactElement | null {
  const session = useOfficeSession()
  if (costTabOpen(abilitiesOf(session.permissions), grainsOf(session.permissions))) return null
  return <SheetsToday style={style} revisionId={revisionId} cell={cell} />
}

function SheetsToday({ style, revisionId, cell }: { style: StyleView; revisionId: string | null; cell: { colourwayId: string; size: string } | null }): ReactElement {
  const { model, actions } = useCostSheets({ style, revisionId, cell })
  return <CostSheetsView model={model} actions={actions} />
}
