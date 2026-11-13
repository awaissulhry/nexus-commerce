'use client'

import { useLocale } from '../../../../../../lib/i18n/provider'
import type { QuoteLine } from '../../../api'
import { percent, unitPrice } from '../../../model'
import type { PricingLine } from '../api'
import { lineDiscount, pricesBySize } from '../model'
import { PriceDepthMessages, usePriceWords } from '../words'
import '../price-depth.css'

export interface BlockPricesModel {
  lines: readonly QuoteLine[]
  currency: string
  /** The quote's pricing by line (the discount of each waterfall); null while read or without it. */
  pricing: readonly PricingLine[] | null
}

/**
 * A style block's W2b price rows (design quote.lines.blocks "Discount % (W2b); Size surcharge per size (W2b, from
 * price-list rules; shown as a second row 'Price by size')"): per colour line its discount and, when a size costs more,
 * the price of each such size. Nothing is drawn when no line has either. It fetches nothing.
 */
export function BlockPrices({ model }: { model: BlockPricesModel }) {
  return (
    <PriceDepthMessages>
      <Rows model={model} />
    </PriceDepthMessages>
  )
}

function Rows({ model }: { model: BlockPricesModel }) {
  const { t } = usePriceWords()
  const locale = useLocale()
  const rows = model.lines
    .map((line) => ({ line, discount: lineDiscount(line, model.pricing?.find((entry) => entry.lineId === line.id) ?? null), bySize: pricesBySize(line) }))
    .filter((row) => row.discount !== null || row.bySize.length > 0)
  if (rows.length === 0) return null
  return (
    <ul className="fw-qp-block" aria-label={t('block.label')}>
      {rows.map(({ line, discount, bySize }) => (
        <li key={line.id} className="fw-qp-block-row">
          <span className="fw-qp-block-colour">{line.colourway.code}</span>
          {discount !== null && <span>{t('block.discount', { pct: percent(discount, locale) })}</span>}
          {bySize.length > 0 && (
            <span>
              {t('block.bySize')}{' '}
              {bySize.map((entry) => t('block.size', { size: entry.size, price: unitPrice(entry.unitPrice, model.currency, locale) })).join(' · ')}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}
