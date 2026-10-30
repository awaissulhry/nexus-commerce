'use client'

import { Card, Menu, SummaryTable } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { WorkOrder } from '../../../_shared/api'
import { quantityText } from '../../../_shared/model'
import type { WorkOrderRecordActions, WorkOrderRecordModel } from '../record-model'
import { PartState } from './WorkOrderRecordView'
import { DAILY_NAMESPACE, leatherMaterials, readinessView, reserveHeld } from '../../daily/model'
import { PrintButton, ReadinessPill, say } from '../../daily/view/DailyParts'

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
  // B-W2a-46: the readiness word per material (wo-materials), Reserve leather… (wo-leather, the Find hides dialog), Print pick list.
  const tw = useT(DAILY_NAMESPACE)
  const daily = model.daily ?? null
  const readiness = readinessView(workOrder, model.check.value, daily?.readiness?.value ?? null)
  const wordOf = (itemId: string, itemColourId: string | null) => readiness?.materials.find((entry) => entry.itemId === itemId && (entry.itemColourId ?? null) === itemColourId) ?? null
  const leathers = leatherMaterials(workOrder)
  const reserveWait = daily ? say(tw, reserveHeld(workOrder, daily.can)) : null
  const reserve = (material: (typeof leathers)[number]) => daily && actions?.daily?.onDialog?.({ kind: 'reserve', itemId: material.itemId, itemColourId: material.itemColourId ?? null })
  return (
    <div className="fw-pr-stack">
      <Card padded className="fw-pr-card">
        <div className="fw-pr-card-head">
          <h2 className="fw-pr-h2">{t('materials.planned')}</h2>
          <span className="fw-pr-actions">
            <span className="fw-pr-hint">{workOrder.spec.frozen ? t('materials.frozen') : t('materials.wouldFreeze')}</span>
            {daily && leathers.length === 1 && (
              <Button size="sm" heldReason={reserveWait} onClick={() => reserve(leathers[0]!)}>
                {tw('reserve.button')}
              </Button>
            )}
            {daily && leathers.length > 1 && (
              <Menu label={tw('reserve.button')} align="right" items={leathers.map((material) => ({ id: `${material.itemId}:${material.itemColourId ?? ''}`, label: [material.itemCode, material.colourCode].filter(Boolean).join(' · '), disabled: !!reserveWait, description: reserveWait ?? undefined, onSelect: () => reserve(material) }))} />
            )}
          </span>
        </div>
        {materials.length === 0 ? (
          <p className="fw-pr-hint">{t('materials.none')}</p>
        ) : (
          <div className="fw-pr-table">
            <SummaryTable
              label={t('materials.planned')}
              stackOnPhone
              columns={[t('materials.col.material'), t('materials.col.colour'), t('materials.col.planned'), t('materials.col.issued'), t('materials.col.balance'), tw('readiness.column')]}
              align={[undefined, undefined, 'right', 'right', 'right', undefined]}
              widths={['32%', '10%', '14%', '14%', '14%', '16%']}
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
                  (() => {
                    const word = wordOf(material.itemId, material.itemColourId ?? null)
                    return word ? <ReadinessPill key="r" word={word.word} date={word.date} /> : <span key="r">{tw(readiness ? 'readiness.notPlannedShort' : 'readiness.unknown')}</span>
                  })(),
                ],
              }))}
            />
          </div>
        )}
      </Card>
      {daily && model.pick?.value && (
        <div className="fw-pr-actions">
          <PrintButton what="pick" actions={actions?.daily} />
        </div>
      )}
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
