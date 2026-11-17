'use client'

import { SummaryTable } from '@nexus/ui/components'
import { useT } from '../../../../../../lib/i18n/provider'
import type { WorkOrder } from '../../../../_shared/api'
import { progressCell, progressTableOf } from '../model'

/**
 * F-PR-05a — the work order's pieces in ONE table (06-tree A.4 O-WO-progress; replaces the 6-way size layer switch): per colourway
 * the rows Ordered (Quantity) · Cut · In bundles · Sewn · Finished · Still to finish, the sizes and Total as columns, then the Total
 * of every colourway. "—" where the floor does not count a step (never 0); an empty cell where a colourway has no such size.
 */
export function ProgressTable({ workOrder }: { workOrder: Pick<WorkOrder, 'cells' | 'style'> }) {
  const t = useT('production')
  const table = progressTableOf(workOrder)
  const label = (step: string) => t(`size.layers.${step}`)
  const rows = [
    ...table.blocks.flatMap((block, index) =>
      block.rows.map((row, at) => ({
        id: `${index}-${row.step}`,
        cells: [at === 0 ? <strong key="c">{block.colourway}</strong> : '', label(row.step), ...row.cells.map(progressCell), progressCell(row.total)],
      })),
    ),
    ...(table.blocks.length > 1
      ? table.totals.map((row, at) => ({ id: `total-${row.step}`, cells: [at === 0 ? <strong key="c">{t('size.copy.total')}</strong> : '', label(row.step), ...row.cells.map(progressCell), progressCell(row.total)] }))
      : []),
  ]
  return (
    <SummaryTable
      label={t('size.table')}
      stackOnPhone
      columns={[t('size.copy.colour'), t('size.step'), ...table.sizes, t('size.copy.total')]}
      align={[undefined, undefined, ...table.sizes.map(() => 'right' as const), 'right']}
      rows={rows}
    />
  )
}
