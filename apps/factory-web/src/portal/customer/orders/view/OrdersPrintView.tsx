'use client'

import { ArrowLeft, Printer } from 'lucide-react'
import { SummaryTable } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { kindKey, rowState, yoursOf, type ListRow } from '../model'
import { useOrderWords } from '../words'
import { Loading, ReadFailed } from './parts'
import '../orders.css'

/**
 * tab:print — "Print this list" (design portal.customer.orders tabs): the current view in its own tab, its filters written at
 * the top (the chip and the search), every row it read, who printed it and when; on paper the portal's frame is left out
 * (orders.css `@media print`). The toolbar (Print, Back to the list) never prints. Prices only with the price grain.
 */
export interface OrdersPrintModel {
  state: 'loading' | 'error' | 'ready'
  // B-TH-223: the requests and the orders of the view, each with the customer's own number.
  rows: readonly ListRow[]
  /** The rows the view holds in all (the paper says when it shows fewer). */
  count: number
  seesPrices: boolean
  /** The chip's words and the search, as the list showed them. */
  filters: { chip: string; q: string }
  partyName: string
  printedBy: string
  printedAt: string
  backHref: string
}

export function OrdersPrintView({ model, onRetry }: { model: OrdersPrintModel; onRetry?: () => void }) {
  const words = useOrderWords()
  const { t, locale, day, at } = words
  return (
    <div className="fw-pord-print">
      <div className="fw-pord-print-toolbar" role="region" aria-label={t('print.toolbar')}>
        <Button variant="primary" size="sm" onClick={() => window.print()} heldReason={model.state !== 'ready' ? t('print.held') : null}>
          <Printer size={14} aria-hidden /> {t('print.print')}
        </Button>
        <Button asChild variant="quiet" size="sm">
          <a href={model.backHref}>
            <ArrowLeft size={14} aria-hidden /> {t('print.back')}
          </a>
        </Button>
      </div>
      <header className="fw-pord-print-head">
        <strong>{model.partyName}</strong>
        <h1 className="fw-pord-print-title">{t('list.title')}</h1>
        <p className="fw-pord-print-meta">{model.filters.q ? t('print.filtersSearch', { chip: model.filters.chip, q: model.filters.q }) : t('print.filters', { chip: model.filters.chip })}</p>
        <p className="fw-pord-print-meta">{t('print.printedBy', { name: model.printedBy, when: at(model.printedAt) })}</p>
        {model.rows.length < model.count ? <p className="fw-pord-print-meta">{t('print.capped', { shown: model.rows.length, count: model.count })}</p> : null}
        {!model.seesPrices ? <p className="fw-pord-print-meta">{t('prices.none')}</p> : null}
      </header>
      {model.state === 'loading' ? (
        <Loading rows={4} height={28} />
      ) : model.state === 'error' ? (
        <ReadFailed title={t('list.failed')} onRetry={onRetry} />
      ) : model.rows.length === 0 ? (
        <p className="fw-pord-hint">{t('list.noMatch')}</p>
      ) : (
        <SummaryTable
          label={t('list.label')}
          columns={[t('col.yourPo'), t('col.yours'), t('col.kind'), t('col.subject'), t('col.date'), t('col.status'), t('col.wanted'), t('col.pieces'), t('col.open'), ...(model.seesPrices ? [t('col.value')] : []), t('col.nextShipment')]}
          rows={model.rows.map((row) => ({
            id: row.id,
            cells:
              row.kind === 'request'
                ? [
                    row.request.customerRef ?? '—',
                    yoursOf(row, locale) ?? '—',
                    t(kindKey(row)),
                    row.request.subject,
                    day(row.request.receivedAt.slice(0, 10)),
                    rowState(row, locale).words,
                    row.request.wantedDate ? day(row.request.wantedDate) : '—',
                    row.request.pieces > 0 ? t('list.piecesAsked', { count: row.request.pieces }) : '—',
                    '—',
                    ...(model.seesPrices ? ['—'] : []),
                    '—',
                  ]
                : [
                    row.order.customerRef ?? '—',
                    yoursOf(row, locale) ?? '—',
                    t(kindKey(row)),
                    '—',
                    row.order.orderedOn ? day(row.order.orderedOn) : '—',
                    rowState(row, locale).words,
                    row.order.promiseDate ? day(row.order.promiseDate) : '—',
                    t('list.piecesShipped', { shipped: row.order.pieces.shipped, ordered: row.order.pieces.ordered }),
                    String(row.order.pieces.open),
                    ...(model.seesPrices ? [words.money(row.order.netAmount, row.order.currency)] : []),
                    row.order.nextShipment ? [row.order.nextShipment.date ? day(row.order.nextShipment.date) : null, row.order.nextShipment.carrierName, row.order.nextShipment.words[locale]].filter(Boolean).join(' · ') : '—',
                  ],
          }))}
        />
      )}
    </div>
  )
}
