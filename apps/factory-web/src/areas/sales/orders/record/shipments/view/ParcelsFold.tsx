'use client'

import { Tag } from '@nexus/ui/primitives'
import { INTL_LOCALE } from '../../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { Bench } from '../../../../../warehouse/shipments/cartons/api'
import type { Order } from '../../../api'
import type { Part } from '../../record-model'
import { PartFailed, PartReading } from '../../../../../../lib/record-sections/Kit'
import { httpsOrNull } from '../model'
import type { ShipmentRow } from '../where'
import { parcelGroupsOf } from '../rows' // F-OS-301

/**
 * F-OS-103 (order SHIPMENTS tab, 10-design §5 "Parcels (n) fold") — a row's parcels, opened under it (closed by default): its head
 * "Parcels (3) · 3 of 3 parcels tracked", then one line per parcel — "Parcel 1 of 3 · 33.0 kg", what it holds of THIS order (style,
 * colour, sizes: the order read's own parcel contents, B-OS-001, + the other orders' pieces) and its own number ("From the label" or
 * "Typed by hand", Track ›), or "— Not tracked". Its weight is Warehouse's cartons read, loaded when the fold opens (an older answer
 * without parcel contents: the carton's contents). No packer names; no money (a declared value is never read here). Reading: skeleton
 * rows; failed: one line with Try again (the row stays).
 */
export function ParcelsFold({ row, order, part, onRetry }: { row: ShipmentRow; order: Pick<Order, 'lines'>; part: Part<Bench> | null; onRetry?: () => void }) {
  const t = useT('order-shipments')
  const o = useT('orders')
  const locale = useLocale()
  const parcels = [...(row.parcels ?? [])].sort((a, b) => a.seq - b.seq)
  const bench = part?.value ?? null
  const tracked = parcels.filter((parcel) => parcel.number !== null).length
  const kg = new Intl.NumberFormat(INTL_LOCALE[locale], { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return (
    <div className="fw-os-pf" role="group" aria-label={t('ships.parcels.label', { number: row.number })}>
      <div className="fw-os-pf-h">
        <b>{t('ships.travels.fold', { count: parcels.length })}</b>
        <span>{t('ships.parcels.tracked', { tracked, count: parcels.length })}</span>
      </div>
      {part?.problem ? <PartFailed part={t('ships.parcels.part')} problem={part.problem} onRetry={onRetry} /> : null}
      {!bench && !part?.problem ? <PartReading rows={Math.min(3, Math.max(1, parcels.length))} height={20} /> : null}
      {parcels.map((parcel) => {
        const carton = bench?.cartons.find((entry) => entry.id === parcel.id) ?? bench?.cartons.find((entry) => entry.seq === parcel.seq) ?? null
        // F-OS-305 (os-fx3): the order read's own weight when it sends one; else Warehouse's cartons read (loaded on open).
        const weight = parcel.grossWeightKg ? Number(parcel.grossWeightKg) : carton?.grossWeightKg ? Number(carton.grossWeightKg) : null
        // What it holds, one group per style and colour: "SEED-JKT-02 Black · 46 ×4 · 48 ×8" (this order's lines; the carton's otherwise).
        const groups = new Map<string, { style: string; colour: string; sizes: string[] }>()
        const add = (key: string, style: string, colour: string, size: string) => {
          const group = groups.get(key) ?? { style, colour, sizes: [] }
          group.sizes.push(size)
          groups.set(key, group)
        }
        // F-OS-301: the order read's own contents grouped by the one rule the Tracking numbers window says them with (rows.ts).
        if (parcel.contents) for (const group of parcelGroupsOf(parcel.contents, order.lines)) groups.set(group.key, { style: group.style, colour: group.colour, sizes: group.sizes })
        else for (const content of carton?.contents ?? []) add(`${content.styleCode}|${content.colourwayCode}`, content.styleCode, content.colourwayName, `${content.size} ×${content.quantity}`)
        const other = parcel.otherPieces ?? 0
        const known = !!parcel.contents || !!carton
        const url = httpsOrNull(parcel.url)
        return (
          <div key={parcel.id} className="fw-os-pr">
            <div className="fw-os-pr-p">
              {t('ships.parcels.row', { seq: parcel.seq, count: parcels.length })}
              {weight !== null && Number.isFinite(weight) ? <span className="fw-os-mu"> · {t('ships.parcels.kg', { kg: kg.format(weight) })}</span> : null}
            </div>
            <div className="fw-os-pr-c">
              {known ? (groups.size > 0 || other > 0 ? [...[...groups.values()].map((group) => [`${group.style} ${group.colour}`, ...group.sizes].join(' · ')), ...(other > 0 ? [t('ships.carries.other', { count: other, orders: t('ships.parcels.others') })] : [])].join(' — ') : t('ships.parcels.nothingIn')) : null}
            </div>
            <div className="fw-os-pr-x">
              {parcel.number ? (
                <>
                  <code className="fw-os-code">{parcel.number}</code>
                  {parcel.source === 'LABEL' ? <Tag tone="neutral">{t('ships.parcels.fromLabel')}</Tag> : parcel.source === 'TYPED' ? <Tag tone="info">{t('ships.parcels.typed')}</Tag> : null}
                  {url ? (
                    <a className="fw-pt-link" href={url} target="_blank" rel="noopener noreferrer">
                      {o('ship.track')}
                    </a>
                  ) : null}
                </>
              ) : (
                <span className="fw-os-mu">{t('ships.parcels.notTracked')}</span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
