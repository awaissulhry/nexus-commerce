'use client'

import { Box, CircleAlert, CircleCheck, CloudOff, PackageMinus, PackageOpen, Ruler, ScanLine, Scale, Trash2, TriangleAlert } from 'lucide-react'
import { FloorButton, type FloorTone } from '@nexus/ui/floor'
import { formatNumber } from '../../../../../lib/i18n/format'
import type { Locale } from '../../../../../lib/i18n/locales'
import type { Translate } from '../../../../../lib/i18n/messages'
import { TaskLine } from '../../../shared/view/TaskParts'
import type { BenchLeft, KeptScan, PackCartonView, ScanFlash } from '../model'

/**
 * Scan into the carton's parts (B-W2b-387; design floor.pack "Scan into the carton"): the flash of the last scan (big, its
 * words from its code, a wrong piece in the danger tone with its reason), a carton's card, the scans the tablet keeps while
 * the network is gone, and what packing still needs. Words from codes only; no money; never a customer.
 */

/** What the last scan did, big and clear: a refusal is an alert in the danger tone with the code scanned and the reason (keyed by its `seq`, so it flashes again). */
export function ScanFlashLine({ flash, t, locale }: { flash: ScanFlash; t: Translate; locale: Locale }) {
  const n = (value: number) => formatNumber(value, locale)
  let tone: 'success' | 'danger' | 'warning' | 'info' = 'success'
  let icon = <CircleCheck />
  let words: string
  switch (flash.kind) {
    case 'in':
      words = t(flash.newCarton ? 'flash.inNew' : 'flash.in', { cell: flash.cell, seq: flash.carton, packed: n(flash.packed), ordered: n(flash.ordered) })
      break
    case 'out':
      tone = 'info'
      icon = <PackageMinus />
      words = t(flash.reopened ? 'flash.outReopened' : 'flash.out', { cell: flash.cell, seq: flash.carton })
      break
    case 'kept':
      tone = 'info'
      icon = <CloudOff />
      words = t('flash.kept')
      break
    case 'refused':
      tone = 'danger'
      icon = <TriangleAlert />
      words = t(`refusal.${flash.refusal ?? 'other'}`)
      break
    case 'chooseSize':
      tone = 'warning'
      icon = <CircleAlert />
      words = t(flash.cellIds.length > 0 ? 'flash.chooseSize' : 'flash.chooseNone')
      break
    case 'cartonLabel':
      tone = 'warning'
      icon = <Box />
      words = t('flash.cartonLabel', { seq: flash.carton })
      break
    case 'needsNetwork':
      tone = 'warning'
      icon = <CloudOff />
      words = t('flash.needsNetwork')
      break
  }
  const alert = tone === 'danger' || tone === 'warning'
  return (
    <div className="fw-pack-flash" data-tone={tone} role={alert ? 'alert' : 'status'}>
      <span className="fw-pack-flash-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="fw-pack-flash-text">
        <span className="fw-pack-flash-code">{flash.code}</span>
        <span className="fw-pack-flash-words">{words}</span>
      </span>
    </div>
  )
}

/** One carton: "Carton 2 of 3" (closed) or "Carton 3 · open", its state, garments, contents by size with the batch, packaging and weights. */
export function CartonCard({
  carton,
  t,
  locale,
  takingOut,
  actions,
}: {
  carton: PackCartonView
  t: Translate
  locale: Locale
  /** The next scan takes a garment out of this carton. */
  takingOut?: boolean
  /** What can be done with it here (DRAFT, not labelled), each held with its reason. */
  actions?: { close?: () => void; weigh?: () => void; takeOut?: () => void; remove?: () => void; held?: string | null }
}) {
  const kg = (text: string) => formatNumber(Number.parseFloat(text), locale, { maximumFractionDigits: 2 })
  const state = carton.labelled ? 'labelled' : carton.closed ? (carton.marks === 'due' ? 'marksDue' : 'closed') : 'open'
  const tone: FloorTone = carton.labelled ? 'info' : carton.closed ? (carton.marks === 'due' ? 'warning' : 'success') : carton.current ? 'primary' : 'neutral'
  const title = carton.numbered ? t('carton.numbered', { n: carton.numbered.n, of: carton.numbered.of }) : t('carton.open', { seq: carton.seq })
  const weight = carton.grossKg === null ? t('carton.notWeighed') : carton.netKg !== null && carton.netKg !== carton.grossKg ? t('carton.grossNet', { gross: kg(carton.grossKg), net: kg(carton.netKg) }) : t('carton.kg', { weight: kg(carton.grossKg) })
  const held = actions?.held ?? null
  return (
    <section className="fw-floor-card fw-pack-carton" data-current={carton.current ? 'true' : undefined} data-out={takingOut ? 'true' : undefined} aria-labelledby={`fw-pack-carton-${carton.id}`}>
      <header className="fw-floor-card-head">
        <span className="fw-floor-card-icon" aria-hidden="true">
          {carton.closed ? <Box /> : <PackageOpen />}
        </span>
        <span className="fw-floor-card-title">
          <span className="fw-floor-card-type">{carton.current ? t('carton.current') : t('carton.type')}</span>
          <span id={`fw-pack-carton-${carton.id}`} className="fw-floor-card-code">
            {title}
          </span>
        </span>
        <span className="fw-task-big">
          <span className="fw-task-big-value">{formatNumber(carton.garments, locale)}</span>
          <span className="fw-task-big-label">{t('carton.garments')}</span>
        </span>
        <span className="fw-floor-pill" data-tone={tone}>
          {t(`carton.state.${state}`)}
        </span>
      </header>
      {carton.contents.length > 0 ? (
        <ul className="fw-pack-contents">
          {carton.contents.map((entry) => (
            <li key={`${entry.label}|${entry.batch ?? ''}`}>
              <span className="fw-pack-code">{entry.batch ? t('carton.lineBatch', { cell: entry.label, count: entry.quantity, batch: entry.batch }) : t('carton.line', { cell: entry.label, count: entry.quantity })}</span>
              {entry.serials > 0 ? <span className="fw-floor-muted">{` · ${t('carton.serials', { count: entry.serials })}`}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="fw-floor-muted">{t('carton.empty')}</p>
      )}
      <p className="fw-pack-carton-facts">
        <span>
          <span className="fw-floor-inline-icon" aria-hidden="true">
            <Ruler />
          </span>
          {`${t('carton.packaging')}: ${carton.packaging ? `${carton.packaging.name} (${t(`kind.${carton.packaging.kind}`)})` : t('carton.noPackaging')}`}
        </span>
        <span>
          <span className="fw-floor-inline-icon" aria-hidden="true">
            <Scale />
          </span>
          {`${t('carton.weight')}: ${weight}`}
        </span>
      </p>
      {actions && (actions.close || actions.weigh || actions.takeOut || actions.remove) ? (
        <div className="fw-floor-row-actions fw-pack-carton-actions">
          {actions.remove ? (
            <FloorButton size="md" variant="secondary" icon={<Trash2 />} heldReason={held} onClick={actions.remove}>
              {t('carton.remove')}
            </FloorButton>
          ) : null}
          {actions.takeOut ? (
            <FloorButton size="md" variant={takingOut ? 'primary' : 'secondary'} icon={<PackageMinus />} aria-pressed={takingOut ? 'true' : 'false'} heldReason={held} onClick={actions.takeOut}>
              {takingOut ? t('carton.takeOutStop') : t('carton.takeOut')}
            </FloorButton>
          ) : null}
          {actions.weigh ? (
            <FloorButton size="md" variant="secondary" icon={<Scale />} heldReason={held} onClick={actions.weigh}>
              {t('carton.weigh', { seq: carton.seq })}
            </FloorButton>
          ) : null}
          {actions.close ? (
            <FloorButton size="md" variant="secondary" icon={<Box />} heldReason={held} onClick={actions.close}>
              {t('carton.close', { seq: carton.seq })}
            </FloorButton>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

/** This shipment's scans kept on the tablet (they go in when the network is back), and those refused when they were sent. */
export function KeptScans({ waiting, refused, t }: { waiting: readonly KeptScan[]; refused: readonly KeptScan[]; t: Translate }) {
  if (waiting.length === 0 && refused.length === 0) return null
  return (
    <div className="fw-floor-stack">
      {waiting.length > 0 ? (
        <section className="fw-pack-kept" aria-labelledby="fw-pack-kept">
          <h3 id="fw-pack-kept" className="fw-floor-subtitle fw-pack-heading">
            <span className="fw-floor-inline-icon" aria-hidden="true">
              <CloudOff />
            </span>
            {t('kept.title', { count: waiting.length })}
          </h3>
          <p className="fw-floor-muted">{t('kept.lead')}</p>
          <ul className="fw-pack-kept-codes">
            {waiting.map((scan) => (
              <li key={scan.id} className="fw-pack-code">
                {scan.code}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {refused.length > 0 ? (
        <TaskLine tone="danger" icon={<CircleAlert />} alert>
          <strong>{t('kept.refusedTitle', { count: refused.length })}</strong>
          {refused.map((scan) => (
            <span key={scan.id} className="fw-pack-kept-refused">
              {t('kept.refused', { code: scan.code, words: t(`refusal.${scan.refusal ?? 'other'}`) })}
            </span>
          ))}
          <span className="fw-pack-kept-refused">{t('kept.refusedLead')}</span>
        </TaskLine>
      ) : null}
    </div>
  )
}

/** What packing still needs, or that it can be packed. */
export function LeftList({ left, t }: { left: readonly BenchLeft[]; t: Translate }) {
  if (left.length === 0) {
    return (
      <TaskLine tone="success" icon={<CircleCheck />}>
        {t('left.none')}
      </TaskLine>
    )
  }
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-pack-left">
      <h3 id="fw-pack-left" className="fw-floor-subtitle fw-pack-heading">
        <span className="fw-floor-inline-icon" aria-hidden="true">
          <ScanLine />
        </span>
        {t('left.title')}
      </h3>
      <ul className="fw-pack-left">
        {left.map((item) => (
          <li key={item.kind}>{leftWords(item, t)}</li>
        ))}
      </ul>
    </section>
  )
}

export function leftWords(item: BenchLeft, t: Translate): string {
  switch (item.kind) {
    case 'noLines':
      return t('left.noLines')
    case 'toScan':
      return t('left.toScan', { count: item.count })
    case 'serials':
      return t('left.serials')
    case 'open':
    case 'unweighed':
    case 'empty':
    case 'marks':
      return t(`left.${item.kind}`, { cartons: item.seqs.join(', ') })
  }
}
