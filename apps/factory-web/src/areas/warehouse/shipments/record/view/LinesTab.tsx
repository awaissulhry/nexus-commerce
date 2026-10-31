'use client'

import Link from 'next/link'
import { CircleAlert, CircleCheck, CircleMinus, FileText, PackagePlus, Plus, Scale, Trash2, TriangleAlert } from 'lucide-react'
import { Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button, NumberStepper, Pill, Select, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Parcel, Shipment, ShipmentLine } from '../../api'
import { kilos, packingNeeds, type ReadyCheck } from '../../model'
import type { ShipmentRecordActions, ShipmentRecordModel } from '../record-model'
import { OrderProgressCard } from './OrderProgressCard'

const CHECK_ICON = { ok: CircleCheck, open: CircleAlert, warn: TriangleAlert, notNeeded: CircleMinus } as const

/**
 * Lines & cartons (design sh-ready, sh-lines, sh-cartons): "Ready to ship" — every check the law and the customer need
 * before the goods leave, each in words with the tab that fixes it (the stand-in of the DS ReadinessChecklist); the
 * lines, only from garments quality released (the API plans them so; a quantity changes only while a DRAFT, within what
 * the cell can still ship); the cartons with their contents, weight and size (the packing station fills them live, the
 * office may add or correct). Read-only once packed: unpack first (no label, no live DDT). B-W2a-71: the order's lines on
 * this shipment as size grids and what stays on backorder.
 */
export function LinesTab({ shipment, checks, model, actions }: { shipment: Shipment; checks: ReadyCheck[]; model: ShipmentRecordModel; actions?: ShipmentRecordActions }) {
  const t = useT('shipments')
  const locale = useLocale()
  const draft = shipment.status === 'DRAFT'
  const editLines = draft && model.can.manage
  const editCartons = draft && model.can.pack
  const recordHref = `${model.prefix}/warehouse/shipments/${shipment.id}`
  const parcelName = (parcel: Parcel) => t('cartons.name', { seq: parcel.seq, count: shipment.parcels.length })
  const contents = (parcel: Parcel) => {
    const inside = shipment.lines.filter((line) => line.parcelId === parcel.id)
    return inside.length === 0 ? t('cartons.empty') : inside.map((line) => `${line.size} ×${line.quantity}`).join(', ')
  }
  const garments = shipment.lines.reduce((sum, line) => sum + line.quantity, 0)
  const unplaced = shipment.lines.filter((line) => line.parcelId === null).reduce((sum, line) => sum + line.quantity, 0)

  return (
    <div className="fw-sh-split">
      <div className="fw-sh-stack">
        <Card padded>
          <div className="fw-sh-card-head">
            <h2 className="fw-sh-h2">{t('lines.title')}</h2>
            <span className="fw-sh-inline">
              <span className="fw-sh-hint">{t('lines.count', { count: garments, lines: shipment.lines.length })}</span>
              {editLines && (
                <Button size="sm" onClick={() => actions?.onDialog?.({ kind: 'addLines' })}>
                  <Plus size={14} aria-hidden /> {t('lines.add')}
                </Button>
              )}
            </span>
          </div>
          {!draft && hasPackingState(shipment) && <p className="fw-sh-hint">{t('lines.locked')}</p>}
          {shipment.lines.length === 0 ? (
            <EmptyState title={t('lines.empty.title')} description={editLines ? t('lines.empty.body') : t('lines.empty.readOnly')} />
          ) : (
            <SummaryTable
              label={t('lines.title')}
              columns={[t('lines.col.style'), t('lines.col.size'), t('lines.col.batch'), t('lines.col.quantity'), t('lines.col.carton'), ...(editLines ? [t('lines.col.actions')] : [])]}
              rows={shipment.lines.map((line) => ({
                id: line.id,
                cells: [
                  <span key="s" className="fw-sh-cell">
                    <span>
                      {line.styleCode} · {line.colourwayName}
                    </span>
                    <span className="fw-sh-cell-sub">{line.styleName}</span>
                  </span>,
                  <span key="z">{line.size}</span>,
                  <span key="b" className="fw-sh-cell">
                    <span className="fw-sh-mono">{line.batchNumber ?? '—'}</span>
                    <span className="fw-sh-cell-sub">{line.workOrderNumber}</span>
                    {line.serialTracked && <span className="fw-sh-cell-sub">{t('lines.serials', { count: line.serials.length, total: line.quantity })}</span>}
                  </span>,
                  editLines ? (
                    <NumberStepper
                      key="q"
                      size="sm"
                      min={Math.max(1, line.serials.length)}
                      value={line.quantity}
                      onChange={(next) => next !== line.quantity && actions?.onLineQuantity?.(line.id, next)}
                      aria-label={t('lines.quantityOf', { style: line.styleCode, size: line.size })}
                      decrementLabel={t('lines.minus')}
                      incrementLabel={t('lines.plus')}
                      disabled={model.busy}
                    />
                  ) : (
                    <span key="q">{line.quantity}</span>
                  ),
                  editCartons ? (
                    <Select
                      key="c"
                      size="sm"
                      aria-label={t('lines.cartonOf', { style: line.styleCode, size: line.size })}
                      value={line.parcelId ?? ''}
                      onChange={(event) => actions?.onPlaceLine?.(line.id, event.target.value || null)}
                      disabled={model.busy || shipment.parcels.length === 0}
                    >
                      <option value="">{t('lines.noCarton')}</option>
                      {shipment.parcels.map((parcel) => (
                        <option key={parcel.id} value={parcel.id} disabled={!!parcel.trackingNumber}>
                          {parcelName(parcel)}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <span key="c">{line.parcelId ? parcelName(shipment.parcels.find((parcel) => parcel.id === line.parcelId)!) : t('lines.noCarton')}</span>
                  ),
                  ...(editLines
                    ? [
                        <Button key="r" size="sm" variant="quiet" aria-label={t('lines.remove', { style: line.styleCode, size: line.size })} heldReason={line.serials.length > 0 ? t('lines.removeHeld') : null} onClick={() => actions?.onRemoveLine?.(line.id)}>
                          <Trash2 size={14} aria-hidden />
                        </Button>,
                      ]
                    : []),
                ],
              }))}
              density="roomy"
              stackOnPhone
              align={['left', 'left', 'left', 'right', 'left', ...(editLines ? (['right'] as const) : [])]}
            />
          )}
          {shipment.lines.some((line: ShipmentLine) => line.serialTracked && line.serials.length > 0) && (
            <details className="fw-sh-details">
              <summary>{t('lines.serialList')}</summary>
              <ul className="fw-sh-list fw-sh-mono">
                {shipment.lines.flatMap((line) => line.serials.map((serial) => <li key={serial.id}>{`${serial.serial} · ${line.styleCode} ${line.size}`}</li>))}
              </ul>
            </details>
          )}
        </Card>

        {/* B-W2a-71: the order's lines on this shipment and what stays on backorder (LOG-004). */}
        <OrderProgressCard shipment={shipment} model={model} actions={actions} />

        <Card padded>
          <div className="fw-sh-card-head">
            <h2 className="fw-sh-h2">{t('cartons.title')}</h2>
            <span className="fw-sh-inline">
              {draft && unplaced > 0 && <Tag tone="warning">{t('cartons.unplaced', { count: unplaced })}</Tag>}
              {editCartons && (
                <Button size="sm" onClick={() => actions?.onDialog?.({ kind: 'parcel', parcelId: null })}>
                  <PackagePlus size={14} aria-hidden /> {t('cartons.add')}
                </Button>
              )}
            </span>
          </div>
          {shipment.parcels.length === 0 ? (
            <EmptyState title={t('cartons.none.title')} description={t('cartons.none.body')} />
          ) : (
            <SummaryTable
              label={t('cartons.title')}
              columns={[t('cartons.col.carton'), t('cartons.col.contents'), t('cartons.col.weight'), t('cartons.col.size'), t('cartons.col.label'), ...(model.can.pack ? [t('cartons.col.actions')] : [])]}
              rows={shipment.parcels.map((parcel) => {
                const weight = kilos(parcel.grossWeightKg, locale)
                const size = parcel.lengthCm && parcel.widthCm && parcel.heightCm ? t('cartons.cm', { l: Number(parcel.lengthCm), w: Number(parcel.widthCm), h: Number(parcel.heightCm) }) : '—'
                const editable = (shipment.status === 'DRAFT' || shipment.status === 'PACKED') && !parcel.trackingNumber && model.can.pack
                return {
                  id: parcel.id,
                  cells: [
                    <span key="n">{parcelName(parcel)}</span>,
                    <span key="c" className="fw-sh-cell">
                      <span>{contents(parcel)}</span>
                      <span className="fw-sh-cell-sub">{t('cartons.garments', { count: parcel.garments })}</span>
                    </span>,
                    weight === null ? (
                      <Tag key="w" tone="warning">
                        {t('cartons.notWeighed')}
                      </Tag>
                    ) : (
                      <span key="w">{t('list.kg', { value: weight })}</span>
                    ),
                    <span key="s">{size}</span>,
                    parcel.trackingNumber ? (
                      <span key="l" className="fw-sh-cell">
                        <Pill tone="success">{t('cartons.labelled')}</Pill>
                        <span className="fw-sh-cell-sub fw-sh-mono">{parcel.trackingNumber}</span>
                      </span>
                    ) : (
                      <span key="l" className="fw-sh-muted">
                        {shipment.transportBy === 'CARRIER' ? t('cartons.noLabel') : t('cartons.labelNotNeeded')}
                      </span>
                    ),
                    ...(model.can.pack
                      ? [
                          <span key="a" className="fw-sh-inline">
                            <Button size="sm" variant="quiet" heldReason={editable ? null : parcel.trackingNumber ? t('held.parcelLabelled') : t('held.parcelLeft')} onClick={() => actions?.onDialog?.({ kind: 'parcel', parcelId: parcel.id })} aria-label={t('cartons.weigh', { carton: parcelName(parcel) })}>
                              <Scale size={14} aria-hidden />
                            </Button>
                            {draft && (
                              <Button size="sm" variant="quiet" heldReason={parcel.garments > 0 ? t('held.parcelFull') : parcel.trackingNumber ? t('held.parcelLabelled') : null} onClick={() => actions?.onRemoveParcel?.(parcel.id)} aria-label={t('cartons.remove', { carton: parcelName(parcel) })}>
                                <Trash2 size={14} aria-hidden />
                              </Button>
                            )}
                          </span>,
                        ]
                      : []),
                  ],
                }
              })}
              density="roomy"
              stackOnPhone
              align={['left', 'left', 'right', 'left', 'left', ...(model.can.pack ? (['right'] as const) : [])]}
            />
          )}
          <div className="fw-sh-card-foot">
            {draft && model.can.pack && (
              <span className="fw-sh-hint">
                {packingNeeds(shipment).length > 0 ? t('cartons.stillNeeds', { what: packingNeeds(shipment).map((need) => t(need.key, need.params)).join('; ') }) : t('cartons.readyToMark')}
              </span>
            )}
            <span className="fw-sh-inline">
              {model.can.pack && shipment.lines.length > 0 && unplaced === 0 && shipment.status !== 'CANCELLED' && (
                <Button size="sm" onClick={() => actions?.onPackingList?.()} heldReason={model.busy ? t('held.busy') : null}>
                  <FileText size={14} aria-hidden /> {t('cartons.packingList')}
                </Button>
              )}
            </span>
          </div>
        </Card>
      </div>

      <aside className="fw-sh-rail" aria-label={t('ready.title')}>
        <Card padded>
          <h2 className="fw-sh-h2">{t('ready.title')}</h2>
          <ul className="fw-sh-checks">
            {checks.map((check) => {
              const Icon = CHECK_ICON[check.state]
              return (
                <li key={check.code} className="fw-sh-check" data-state={check.state}>
                  <Icon size={16} aria-hidden className="fw-sh-check-icon" />
                  <span className="fw-sh-check-text">
                    <strong>{t(`ready.${check.code}.name`)}</strong>
                    <span>{t(check.words.key, check.words.params)}</span>
                    {check.state === 'open' && check.tab !== model.tab && (
                      <Link className="fw-sh-link" href={`${recordHref}?tab=${check.tab}`}>
                        {t(`ready.fix.${check.tab}`)}
                      </Link>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
          {checks.every((check) => check.state !== 'open') && shipment.status === 'PACKED' && <p className="fw-sh-ready-all">{t('ready.all')}</p>}
          {shipment.packedAt && <p className="fw-sh-hint">{t('ready.packedAt', { when: formatDateTime(shipment.packedAt, { locale }) })}</p>}
        </Card>
      </aside>
    </div>
  )
}

const hasPackingState = (shipment: Shipment): boolean => shipment.status === 'PACKED' || shipment.status === 'SHIPPED' || shipment.status === 'DELIVERED' || shipment.status === 'RETURNED'
