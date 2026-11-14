'use client'

import { Package, ShieldAlert } from 'lucide-react'
import type { FloorTone } from '@nexus/ui/floor'
import { formatNumber } from '../../../../../../lib/i18n/format'
import type { Locale } from '../../../../../../lib/i18n/locales'
import { useT } from '../../../../../../lib/i18n/provider'
import { FloorFacts } from '../../../../../frame/view/FloorFacts'
import type { CartonScanCard } from '../model'
import '../../../../pack/carton/carton.css'

/**
 * The carton's card on Scan anything (B-W2b-387; design floor.scan "What you scanned": "Carton (W2b)"): big, text not links
 * (a kiosk), never money, a customer or an address — its shipment and state, "Carton 2 of 3" (or open), the garments by
 * colour and size with their batch, what it is packed in, its weights, its marks; a hold in force said in the danger tone.
 */

const TONE: Readonly<Record<CartonScanCard['state'], FloorTone>> = { open: 'primary', closed: 'success', marksDue: 'warning', labelled: 'info' }

export function CartonResult({ card, locale }: { card: CartonScanCard; locale: Locale }) {
  const d = useT('floor-pack-depth')
  const p = useT('floor-pack')
  const f = useT('floor')
  const kg = (text: string) => formatNumber(Number.parseFloat(text), locale, { maximumFractionDigits: 2 })
  const weight = card.grossKg === null ? d('carton.notWeighed') : card.netKg !== null && card.netKg !== card.grossKg ? d('carton.grossNet', { gross: kg(card.grossKg), net: kg(card.netKg) }) : d('carton.kg', { weight: kg(card.grossKg) })
  return (
    <section className="fw-floor-card" aria-labelledby="fw-floor-card-code">
      <header className="fw-floor-card-head">
        <span className="fw-floor-card-icon" aria-hidden="true">
          <Package />
        </span>
        <span className="fw-floor-card-title">
          <span className="fw-floor-card-type">{f('label.carton')}</span>
          <span id="fw-floor-card-code" className="fw-floor-card-code">
            {card.code}
          </span>
        </span>
        <span className="fw-floor-pill" data-tone={TONE[card.state]}>
          {d(`carton.state.${card.state}`)}
        </span>
      </header>
      {card.hold ? (
        <p className="fw-floor-notice" data-tone="danger" role="note">
          <span className="fw-floor-inline-icon" aria-hidden="true">
            <ShieldAlert />
          </span>
          {d('scanCard.hold', { reason: d(`gate.reason.${card.hold}`) })}
        </p>
      ) : null}
      <FloorFacts
        facts={[
          { label: d('scanCard.shipment'), value: `${card.shipmentNumber} · ${p(`status.${card.shipmentStatus}`)}` },
          { label: d('scanCard.carton'), value: card.numbered ? d('carton.numbered', { n: card.numbered.n, of: card.numbered.of }) : d('scanCard.open', { seq: card.seq, count: card.cartons }) },
          { label: d('scanCard.garments'), value: formatNumber(card.garments, locale) },
          {
            label: d('scanCard.contents'),
            value:
              card.contents.length > 0 ? (
                <ul className="fw-pack-card-contents">
                  {card.contents.map((entry) => (
                    <li key={`${entry.label}|${entry.batch ?? ''}`}>{`${entry.batch ? d('carton.lineBatch', { cell: entry.label, count: entry.quantity, batch: entry.batch }) : d('carton.line', { cell: entry.label, count: entry.quantity })}${entry.serials > 0 ? ` · ${d('carton.serials', { count: entry.serials })}` : ''}`}</li>
                  ))}
                </ul>
              ) : (
                d('carton.empty')
              ),
          },
          { label: d('carton.packaging'), value: card.packaging ? `${card.packaging.name} (${d(`kind.${card.packaging.kind}`)})` : d('carton.noPackaging') },
          { label: d('carton.weight'), value: weight },
          { label: d('scanCard.marks'), value: d(`scanCard.marksState.${card.state}`) },
        ]}
      />
    </section>
  )
}
