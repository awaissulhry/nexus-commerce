'use client'

import { Fragment } from 'react'
import { Info, Receipt } from 'lucide-react'
import { Card } from '@nexus/ui/components'
import { InfoTip } from '@nexus/ui/primitives'
import { formatNumber } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { money } from '../../../../quotes/model'
import type { Order } from '../../../api'
import { chargesOf, natureKindOf, type LinesReader, type TaxBasis, type TotalRow } from '../../lines-table'

/**
 * F-OL-02 (Order LINES lane; 10-design-tab §7, §10; 18-lead-settles F2) — the charges in their own small READ-ONLY block ("A charge
 * changes from the quote": no add, no ⋯), each "Development · for SEED-JKT-05 · billed once" with its amount for price readers only;
 * and the totals in plain words by the order's tax basis (price readers only): VAT on a net order "Subtotal (excl. VAT) · VAT 22 % ·
 * Total (VAT incl.)", no VAT on the sale "VAT: none · export outside the EU" (the code only in a tooltip), a consumer's gross "Total
 * (VAT incl.) · of which VAT". Sales and everyone without prices: no money anywhere. Fetches nothing.
 */

const KINDS = new Set(['DEVELOPMENT', 'SAMPLE', 'TOOLING'])
const rateText = (rate: string | null, locale: 'it' | 'en') => (rate === null ? null : formatNumber(Number(rate), locale, { maximumFractionDigits: 2 }))

export function ChargesBlock({ order, reader }: { order: Order; reader: LinesReader }) {
  const t = useT('orders')
  const locale = useLocale()
  const charges = chargesOf(order)
  if (charges.length === 0) return null
  return (
    <Card padded className="fw-lt-card" aria-label={t('lines.charges.title')}>
      <div className="fw-lt-card-head">
        <Receipt size={16} aria-hidden />
        <h2 className="fw-lt-style">{t('lines.charges.title')}</h2>
      </div>
      {charges.map((charge) => (
        <div key={charge.id} className="fw-lt-charge">
          <span className="fw-lt-head-facts">
            <strong>{t(`lines.charges.kind.${charge.kind && KINDS.has(charge.kind) ? charge.kind : 'other'}`)}</strong>
            {charge.forStyle && <span>· {t('lines.charges.forStyle', { style: charge.forStyle })}</span>}
            <span>· {t('lines.charges.once')}</span>
          </span>
          {reader.prices && <span className="fw-lt-head-total">{money(charge.amount, order.currency, locale)}</span>}
        </div>
      ))}
      <p className="fw-lt-quiet">
        <Info size={13} aria-hidden /> {t('lines.charges.fromQuote')}
      </p>
    </Card>
  )
}

export function TotalsBlock({ order, rows, basis }: { order: Order; rows: readonly TotalRow[]; basis: TaxBasis }) {
  const t = useT('orders')
  const locale = useLocale()
  const label = (row: TotalRow) => {
    switch (row.key) {
      case 'subtotal':
        return t('lines.sum.subtotal')
      case 'vat':
        return t('lines.sum.vat', { rate: rateText(basis.kind === 'vat' ? basis.rate : null, locale) ?? '0' })
      case 'vatNone': {
        const nature = basis.kind === 'vatNone' ? basis.nature : ''
        return (
          <>
            {t(`lines.sum.vatNone.${natureKindOf(nature)}`)} <InfoTip tip={t('lines.sum.code', { code: nature })} />
          </>
        )
      }
      case 'ofWhichVat': {
        const rate = rateText(basis.kind === 'gross' ? basis.rate : null, locale)
        return rate ? t('lines.sum.ofWhichVat', { rate }) : t('lines.sum.ofWhichVatNoRate')
      }
      default:
        return t('lines.sum.total')
    }
  }
  return (
    <Card padded className="fw-lt-card" aria-label={t('lines.totals')}>
      <dl className="fw-lt-sums">
        {rows.map((row) => (
          <Fragment key={row.key}>
            <dt className={row.grand ? 'is-grand' : undefined}>{label(row)}</dt>
            <dd className={row.grand ? 'is-grand' : undefined}>
              {money(row.amount, order.currency, locale)}
              {row.was !== null && <span className="fw-lt-sub">{t('lines.cell.was', { value: money(row.was, order.currency, locale) })}</span>}
            </dd>
          </Fragment>
        ))}
      </dl>
    </Card>
  )
}
