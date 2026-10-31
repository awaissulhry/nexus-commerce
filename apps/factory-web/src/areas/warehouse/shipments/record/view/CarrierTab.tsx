'use client'

import { Download, MoreHorizontal, Printer, Tag as TagIcon, Truck } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, Menu, SummaryTable } from '@nexus/ui/components'
import { Button, Pill } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Shipment } from '../../api'
import { voidHeld, voidPlan } from '../../daily-model'
import { carrierWords, hasLeft, kilos } from '../../model'
import type { ShipmentRecordActions, ShipmentRecordModel } from '../record-model'
import { PartState } from './ShipmentRecordView'

const PRINT_TONE = { QUEUED: 'neutral', SENT: 'info', PRINTED: 'success', FAILED: 'danger' } as const

/**
 * Carrier & label (design sh-booking, sh-labels): who carries the goods, the service, the parcels with their weights (as
 * the labels are bought for them); Buy labels — held until the DDT is issued (the law's paper never trails the parcel),
 * through the company's own Sendcloud account (FAKE locally: nothing is bought); then one label per parcel with its
 * tracking number, its print state on the site's label printer, Print and Download PDF. Own van and customer pickup take
 * no label. B-W2a-71: Labels ⋯ Void labels (design pop:sh-void): every labelled parcel at once (the carrier voids parcel by
 * parcel; one it already has keeps its label), held with its reason.
 */
export function CarrierTab({ shipment, model, actions }: { shipment: Shipment; model: ShipmentRecordModel; actions?: ShipmentRecordActions }) {
  const t = useT('shipments')
  const locale = useLocale()
  const carrier = carrierWords(shipment)
  const liveDdt = model.ddts.value?.find((row) => row.status === 'LIVE') ?? null
  const labels = model.labels?.value ?? null
  const toLabel = labels ? labels.toLabel : shipment.parcels.filter((parcel) => !parcel.trackingNumber).length
  const left = hasLeft(shipment.status)
  const buyHeld = !model.can.buyLabels
    ? t('held.noBuy')
    : shipment.status !== 'PACKED'
      ? t('held.buyState')
      : shipment.ddtRequired && !liveDdt
        ? t('held.ddtFirst')
        : toLabel === 0
          ? t('held.allLabelled')
          : model.busy
            ? t('held.busy')
            : null
  const printHeld = !model.can.printLabels ? t('held.noPrint') : !labels?.labelPrinterId ? t('held.noLabelPrinter') : shipment.parcels.every((parcel) => !parcel.trackingNumber) ? t('held.noLabels') : null
  const deliveryHeld = !model.can.manage ? t('held.noManage') : liveDdt ? t('held.deliveryDdt') : shipment.status !== 'DRAFT' && shipment.status !== 'PACKED' ? t('held.deliveryLeft') : null
  const plan = voidPlan(shipment, model.tracking?.value ?? null)
  const voidBlocked = voidHeld(shipment, plan, model.can)
  const labelled = shipment.parcels.filter((parcel) => parcel.trackingNumber).length

  return (
    <div className="fw-sh-cards">
      <Card padded>
        <div className="fw-sh-card-head">
          <h2 className="fw-sh-h2">
            <Truck size={16} aria-hidden /> {t('carrier.booking')}
          </h2>
          {!left && (
            <Button size="sm" heldReason={deliveryHeld} onClick={() => actions?.onDialog?.({ kind: 'delivery' })}>
              {t('action.delivery')}
            </Button>
          )}
        </div>
        <KeyValue
          labelCase="sentence"
          items={[
            { label: t('carrier.transportBy'), value: t(`transportBy.${shipment.transportBy}`) },
            ...(shipment.transportBy === 'CARRIER' ? [{ label: t('carrier.carrier'), value: t(carrier.key, carrier.params) }, { label: t('carrier.service'), value: shipment.serviceCode ?? t('carrier.serviceDefault') }] : []),
            { label: t('carrier.parcels'), value: t('list.parcels', { count: shipment.parcels.length }) },
            ...(labels?.cutOff ? [{ label: t('carrier.cutOff'), value: labels.cutOff.passed ? t('carrier.cutOffPassed', { time: labels.cutOff.time }) : t('carrier.cutOffToday', { time: labels.cutOff.time }) }] : []),
          ]}
        />
        {shipment.transportBy === 'CARRIER' ? (
          <>
            <p className="fw-sh-hint">{t('carrier.account')}</p>
            {!left && toLabel > 0 && (
              <span className="fw-sh-inline">
                <Button size="sm" variant="primary" heldReason={buyHeld} onClick={() => actions?.onDialog?.({ kind: 'buyLabels' })} aria-keyshortcuts="l">
                  <TagIcon size={14} aria-hidden /> {t('step.buyLabels', { count: toLabel })}
                </Button>
              </span>
            )}
            {!left && toLabel === 0 && shipment.parcels.length > 0 && <p className="fw-sh-hint">{t('held.allLabelled')}</p>}
          </>
        ) : (
          <p className="fw-sh-hint">{t(`carrier.noLabel.${shipment.transportBy}`)}</p>
        )}
      </Card>

      {shipment.transportBy === 'CARRIER' && (
        <Card padded>
          <div className="fw-sh-card-head">
            <h2 className="fw-sh-h2">
              <TagIcon size={16} aria-hidden /> {t('carrier.labels')}
            </h2>
            <span className="fw-sh-inline">
              {model.can.pack && (
                <Button size="sm" heldReason={printHeld} onClick={() => actions?.onPrintLabels?.()}>
                  <Printer size={14} aria-hidden /> {t('carrier.print')}
                </Button>
              )}
              {labelled > 0 && (
                <Menu
                  label={<MoreHorizontal size={16} aria-label={t('carrier.labelsMore')} />}
                  align="right"
                  triggerProps={{ 'aria-label': t('carrier.labelsMore') }}
                  items={[{ id: 'void', label: t('void.action', { count: plan.toVoid.length || labelled }), disabled: !!voidBlocked || model.busy, description: voidBlocked ? t(voidBlocked.key, voidBlocked.params) : undefined, onSelect: () => actions?.onDialog?.({ kind: 'voidLabels' }) }]}
                />
              )}
            </span>
          </div>
          {model.labels && !model.labels.value ? (
            <PartState problem={model.labels.problem} onRetry={() => actions?.onRetryPart?.('labels')} label={t('carrier.labels')} />
          ) : shipment.parcels.length === 0 ? (
            <EmptyState title={t('carrier.noParcels.title')} description={t('carrier.noParcels.body')} />
          ) : (
            <SummaryTable
              label={t('carrier.labels')}
              columns={[t('carrier.col.parcel'), t('carrier.col.weight'), t('carrier.col.tracking'), t('carrier.col.print'), t('carrier.col.file')]}
              rows={shipment.parcels.map((parcel) => {
                const label = labels?.parcels.find((entry) => entry.parcelId === parcel.id) ?? null
                const pdf = label?.files.find((file) => file.format === 'PDF') ?? null
                const weight = kilos(parcel.grossWeightKg, locale)
                return {
                  id: parcel.id,
                  cells: [
                    t('cartons.name', { seq: parcel.seq, count: shipment.parcels.length }),
                    weight === null ? '—' : t('list.kg', { value: weight }),
                    parcel.trackingNumber ? (
                      <span key="t" className="fw-sh-cell">
                        <span className="fw-sh-mono">{parcel.trackingNumber}</span>
                        {parcel.labelledAt && <span className="fw-sh-cell-sub">{t('carrier.boughtAt', { when: formatDateTime(parcel.labelledAt, { locale }) })}</span>}
                      </span>
                    ) : (
                      <span key="t" className="fw-sh-muted">
                        {t('carrier.noLabelYet')}
                      </span>
                    ),
                    label?.print ? (
                      <Pill key="p" tone={PRINT_TONE[label.print.status as keyof typeof PRINT_TONE] ?? 'neutral'}>
                        {t(`printState.${label.print.status}`)}
                      </Pill>
                    ) : (
                      <span key="p" className="fw-sh-muted">
                        {parcel.trackingNumber ? t('carrier.notPrinted') : '—'}
                      </span>
                    ),
                    pdf && model.can.readFiles ? (
                      <Button key="f" size="sm" variant="quiet" onClick={() => actions?.onOpenFile?.(pdf.fileId)} aria-label={t('carrier.downloadOf', { seq: parcel.seq })}>
                        <Download size={14} aria-hidden /> {t('carrier.pdf')}
                      </Button>
                    ) : (
                      <span key="f">—</span>
                    ),
                  ],
                }
              })}
              density="roomy"
              stackOnPhone
            />
          )}
          {!model.can.pack && <p className="fw-sh-hint">{t('carrier.labelsHidden')}</p>}
          {labels && !labels.labelPrinterId && <Banner tone="info" title={t('carrier.noPrinter')} />}
        </Card>
      )}
    </div>
  )
}
