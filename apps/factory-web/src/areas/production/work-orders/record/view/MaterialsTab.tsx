'use client'

import { Card, SummaryTable } from '@nexus/ui/components'
import { Tag } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { WorkOrder } from '../../../_shared/api'
import { quantityText } from '../../../_shared/model'
import type { WorkOrderRecordActions, WorkOrderRecordModel } from '../record-model'
import { PartState } from './WorkOrderRecordView'

/**
 * Materials (design wo-leather, wo-materials; MES-005, SCM-215): what the work order plans per material and colour
 * (waste included, in the base unit), what the ledger issued to it net of returns, and the balance; with the pick list
 * (inventory.issue) — usable stock at the site, stock there that may not be issued and why (Cr VI pending, quality
 * hold …), and what the work order holds per lot and hide. Issuing is the floor's (by scan). No cost (W2a, money.cost).
 */
export function MaterialsTab({ workOrder, model, actions }: { workOrder: WorkOrder; model: WorkOrderRecordModel; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  const locale = useLocale()
  const q = (value: string) => quantityText(value, locale)
  const materials = workOrder.spec.materials
  return (
    <div className="fw-pr-stack">
      <Card padded className="fw-pr-card">
        <div className="fw-pr-card-head">
          <h2 className="fw-pr-h2">{t('materials.planned')}</h2>
          <span className="fw-pr-hint">{workOrder.spec.frozen ? t('materials.frozen') : t('materials.wouldFreeze')}</span>
        </div>
        {materials.length === 0 ? (
          <p className="fw-pr-hint">{t('materials.none')}</p>
        ) : (
          <div className="fw-pr-table">
            <SummaryTable
              label={t('materials.planned')}
              stackOnPhone
              columns={[t('materials.col.material'), t('materials.col.colour'), t('materials.col.planned'), t('materials.col.issued'), t('materials.col.balance')]}
              align={[undefined, undefined, 'right', 'right', 'right']}
              widths={['40%', '12%', '16%', '16%', '16%']}
              rows={materials.map((material) => ({
                id: `${material.itemId}:${material.itemColourId ?? ''}`,
                cells: [
                  <span key="m" className="fw-pr-cell">
                    <span className="fw-pr-ellipsis">{material.itemCode}</span>
                    <span className="nds-summary-sub">{material.itemName}</span>
                  </span>,
                  material.colourCode ?? '—',
                  `${q(material.planned)} ${material.baseUom}`,
                  `${q(material.issued)} ${material.baseUom}`,
                  `${q(material.balance)} ${material.baseUom}`,
                ],
              }))}
            />
          </div>
        )}
      </Card>
      {model.pick === null ? (
        <p className="fw-pr-hint">{t('materials.noPick')}</p>
      ) : workOrder.status === 'DRAFT' ? (
        <p className="fw-pr-hint">{t('materials.pickAfterRelease')}</p>
      ) : !model.pick.value ? (
        <PartState label={t('materials.pick')} problem={model.pick.problem} onRetry={() => actions?.onRetryPart?.('pick')} />
      ) : (
        <div className="fw-pr-cards">
          {model.pick.value.lines.map((line) => (
            <Card key={`${line.itemId}:${line.itemColourId ?? ''}`} padded className="fw-pr-card">
              <div className="fw-pr-card-head">
                <h3 className="fw-pr-h3">
                  {line.itemCode}
                  {line.colourCode ? ` · ${line.colourCode}` : ''}
                </h3>
                <Tag tone={line.covered ? 'success' : 'warning'}>{line.covered ? t('materials.covered') : t('materials.toIssue', { quantity: q(line.toIssue), uom: line.baseUom })}</Tag>
              </div>
              <p className="fw-pr-hint">{t('materials.usable', { quantity: q(line.usable.onHand), uom: line.baseUom, count: line.usable.candidates.length + line.usable.more })}</p>
              {line.held.length > 0 && (
                <ul className="fw-pr-list">
                  {line.held.map((held, index) => (
                    <li key={index}>
                      <Tag tone="danger">{t(`reason.${held.reason}`)}</Tag> {t('materials.held', { lot: held.lotCode, quantity: q(held.onHand), uom: line.baseUom, count: held.hides })}
                    </li>
                  ))}
                </ul>
              )}
              {line.atWorkOrder.length > 0 ? (
                <SummaryTable
                  label={t('materials.atWorkOrder')}
                  columns={[t('materials.col.lotHide'), t('materials.col.held'), t('materials.col.cut'), t('materials.col.returnable')]}
                  align={[undefined, 'right', 'right', 'right']}
                  rows={line.atWorkOrder.map((held, index) => ({
                    id: String(index),
                    cells: [[held.lotCode, held.hideCode].filter(Boolean).join(' · ') || '—', `${q(held.quantity)} ${line.baseUom}`, `${q(held.cut)} ${line.baseUom}`, `${q(held.returnable)} ${line.baseUom}`],
                  }))}
                />
              ) : (
                <p className="fw-pr-hint">{t('materials.nothingIssued')}</p>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
