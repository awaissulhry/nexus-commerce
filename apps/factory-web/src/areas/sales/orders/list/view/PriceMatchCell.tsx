'use client'

import { Equal, EqualNot } from 'lucide-react'
import { Tag } from '@nexus/ui/primitives'
import type { Locale } from '../../../../../lib/i18n/locales'
import type { OrderRow } from '../../api'
import { priceDiffOf, priceMatchCellOf, signedMoney } from '../price-check-columns'
import { FunnelButton } from '../sheet/parts'

type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * F-CP-140 (customer page plan C2d; design 11-money §3.1; review G1) — the Price check cell of the Orders sheet: a DS Tag with its own
 * mark, never colour alone — neutral "= Equal" (lucide Equal), danger "≠ Not equal" with "{count} lines" under it (lucide EqualNot) —
 * and "— No customer price yet" as plain text (the DS Tag has no plain tone; never "Equal"). A host that narrows by the check
 * (`onNarrow`) makes it a funnel, as Close to promise; without one the words stand alone. A row without the check (no price grain,
 * an older answer) draws nothing. F-OM-305: a difference accepted by hand is an info "≠ Not equal" with "Accepted by hand" under it.
 */
export function PriceMatchCell({ row, t, onNarrow }: { row: Pick<OrderRow, 'priceMatch' | 'priceNotEqualLines' | 'priceAccepted'>; t: Translate; onNarrow?: (() => void) | undefined }) {
  const cell = priceMatchCellOf(row)
  if (!cell) return null
  const words = t(cell.words.key, cell.words.params)
  // F-OM-305 (B-OM-020): accepted by hand — an info Tag and "Accepted by hand" under it; no funnel (the "Not equal" filter leaves it out).
  if (cell.state === 'ACCEPTED') {
    return (
      <span className="fw-sheet-cell">
        <Tag tone={cell.tone}>
          <EqualNot size={12} aria-hidden /> {words}
        </Tag>
        <span className="fw-sheet-sub">{[t(cell.accepted.key), ...(cell.lines ? [t(cell.lines.key, cell.lines.params)] : [])].join(' · ')}</span>
      </span>
    )
  }
  if (cell.state === 'NO_BRAND_PRICE') {
    const plain = <span className="fw-sheet-plain">{words}</span>
    return onNarrow ? (
      <FunnelButton tip={t(`priceCheck.filter.${cell.state}`)} onClick={onNarrow}>
        {plain}
      </FunnelButton>
    ) : (
      plain
    )
  }
  const tag = (
    <Tag tone={cell.tone}>
      {cell.state === 'EQUAL' ? <Equal size={12} aria-hidden /> : <EqualNot size={12} aria-hidden />} {words}
    </Tag>
  )
  const lines = cell.state === 'NOT_EQUAL' && cell.lines ? <span className="fw-sheet-sub">{t(cell.lines.key, cell.lines.params)}</span> : null
  return (
    <span className="fw-sheet-cell">
      {onNarrow ? (
        <FunnelButton tip={t(`priceCheck.filter.${cell.state}`)} onClick={onNarrow}>
          {tag}
        </FunnelButton>
      ) : (
        tag
      )}
      {lines}
    </span>
  )
}

/** The Difference cell: "+€60.00" with "we ask more" under it, "−€10.00" with "we ask less", "€0.00", "—" when not known. */
export function PriceDiffCell({ row, t, locale }: { row: Pick<OrderRow, 'priceDiff' | 'currency'>; t: Translate; locale: Locale }) {
  if (row.priceDiff === undefined) return null
  const diff = priceDiffOf(row)
  const amount = signedMoney(diff, row.currency, locale)
  if (!diff?.words) return <span className="fw-sheet-plain">{amount}</span>
  const words = t(diff.words.key)
  return (
    <span className="fw-sheet-cell" title={words}>
      <span>{amount}</span>
      <span className="fw-sheet-sub">{words}</span>
    </span>
  )
}
