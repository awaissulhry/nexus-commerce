'use client'

import { ArrowLeft, Printer } from 'lucide-react'
import { SummaryTable } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import type { OrderRow } from '../api'
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
  rows: readonly OrderRow[]
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
          columns={[t('col.yourPo'), t('col.ourOrder'), t('facts.orderedOn'), t('col.status'), t('facts.promise'), t('col.pieces'), t('col.open'), ...(model.seesPrices ? [t('col.value')] : []), t('col.nextShipment')]}
          rows={model.rows.map((row) => ({
            id: row.id,
            cells: [
              row.customerRef ?? '—',
              row.number ?? '—',
              row.orderedOn ? day(row.orderedOn) : '—',
              row.words[locale],
              row.promiseDate ? day(row.promiseDate) : '—',
              t('list.piecesShipped', { shipped: row.pieces.shipped, ordered: row.pieces.ordered }),
              String(row.pieces.open),
              ...(model.seesPrices ? [words.money(row.netAmount, row.currency)] : []),
              row.nextShipment ? [row.nextShipment.date ? day(row.nextShipment.date) : null, row.nextShipment.carrierName, row.nextShipment.words[locale]].filter(Boolean).join(' · ') : '—',
            ],
          }))}
        />
      )}
    </div>
  )
}
