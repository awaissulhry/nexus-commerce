'use client'

import { Card, SummaryTable } from '@nexus/ui/components'
import { Pill, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { WorkOrder } from '../../../_shared/api'
import type { WorkOrderRecordActions, WorkOrderRecordModel } from '../record-model'
import { NotReleased, PartState } from './WorkOrderRecordView'

const INSPECTION_TONE = { OPEN: 'info', PASSED: 'success', FAILED: 'danger', CANCELLED: 'neutral' } as const

/**
 * Quality (design wo-inspections; read-only here): the final inspections of the work order (state, lot size, garments
 * released, an overridden result marked) and per size what was finished, labelled and released for shipping. Inspecting
 * and releasing are Quality's own screens (SCR-075, SCR-076) and the floor's bench (SCR-097).
 */
export function QualityTab({ workOrder, model, actions }: { workOrder: WorkOrder; model: WorkOrderRecordModel; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  const locale = useLocale()
  if (model.quality === null) return <p className="fw-pr-hint">{t('quality.noRight')}</p>
  if (workOrder.status === 'DRAFT') return <NotReleased what={t('quality.what')} />
  const final = model.quality.value
  if (!final) return <PartState label={t('tab.quality')} problem={model.quality.problem} onRetry={() => actions?.onRetryPart?.('quality')} />
  return (
    <div className="fw-pr-cards">
      <Card padded className="fw-pr-card">
        <h2 className="fw-pr-h2">{t('quality.inspections')}</h2>
        {final.inspections.length === 0 ? (
          <p className="fw-pr-hint">{t('quality.none')}</p>
        ) : (
          <SummaryTable
            label={t('quality.inspections')}
            stackOnPhone
            columns={[t('quality.col.inspection'), t('quality.col.status'), t('quality.col.lot'), t('quality.col.released'), t('quality.col.decided')]}
            align={[undefined, undefined, 'right', 'right', 'right']}
            rows={final.inspections.map((inspection) => ({
              id: inspection.id,
              cells: [
                <span key="i" className="fw-pr-inline">
                  {inspection.inspectionNumber ?? t('quality.number', { n: final.inspections.indexOf(inspection) + 1 })}
                  {inspection.overridden && <Tag tone="warning">{t('quality.overridden')}</Tag>}
                </span>,
                <Pill key="s" tone={INSPECTION_TONE[inspection.status]}>
                  {t(`quality.status.${inspection.status}`)}
                </Pill>,
                String(inspection.lotSize),
                String(inspection.released),
                inspection.decidedAt ? formatDateTime(inspection.decidedAt, { locale }) : '—',
              ],
            }))}
          />
        )}
      </Card>
      <Card padded className="fw-pr-card">
        <h2 className="fw-pr-h2">{t('quality.sizes')}</h2>
        <SummaryTable
          label={t('quality.sizes')}
          stackOnPhone
          columns={[t('quality.col.size'), t('quality.col.pieces'), t('quality.col.labels'), t('quality.col.released'), t('quality.col.releasable')]}
          align={[undefined, 'right', 'right', 'right', 'right']}
          rows={final.cells.map((cell) => ({
            id: cell.workOrderSizeId,
            cells: [`${cell.colourwayCode} ${cell.size}`, String(cell.pieces), String(cell.labelsPrinted), String(cell.released), String(cell.releasable)],
          }))}
        />
        <p className="fw-pr-hint">{t('quality.hint')}</p>
      </Card>
    </div>
  )
}
