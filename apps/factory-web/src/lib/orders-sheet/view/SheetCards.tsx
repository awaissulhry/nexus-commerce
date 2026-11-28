'use client'

import { Checkbox } from '@nexus/ui/primitives'
import { StateChip } from '../../order-cells/view/StateChip'
import type { Translate } from '../../i18n/messages'
import type { Locale } from '../../i18n/locales'
import { formatNumber } from '../../i18n/format'
import type { OrdersSheetOrder, SheetKind } from '../model'
import { targetOf } from '../rows'
import { ActButtons, ChipRow, dayWords, OrderPictureButton } from './SheetCells'

/**
 * owb-of3 — the sheet on a phone (its room under 640 px): one card per order, never the grid (a spreadsheet does not fit a phone).
 * The picture is its own button (the camera always shows); the number opens the order; the chips are doors; the act button stays.
 * Every button of the card is 48 px tall to touch (orders-sheet.css).
 */
export function SheetCards({ orders, kind, t, locale, selected, onSelect, onOpen }: { orders: readonly OrdersSheetOrder[]; kind: SheetKind; t: Translate; locale: Locale; selected: ReadonlySet<string>; onSelect: (key: string, on: boolean) => void; onOpen: (target: string) => void }) {
  if (orders.length === 0) return <p className="fw-osh-muted fw-osh-cards-empty">{t('part.empty')}</p>
  return (
    <ul className="fw-osh-cards" aria-label={t('part.cards.label')}>
      {orders.map((order) => {
        const number = order.number ?? t('part.noNumber')
        return (
          <li key={order.key} className={order.life === 'WITHDRAWN' ? 'fw-osh-card is-gone' : 'fw-osh-card'}>
            <div className="fw-osh-card-head">
              <Checkbox checked={selected.has(order.key)} onChange={(event) => onSelect(order.key, event.target.checked)} aria-label={t('part.cards.select', { number })} />
              <OrderPictureButton order={order} number={number} onOpen={() => onOpen(targetOf('picture', order.key))} t={t} size="phone" />
              <button type="button" className="fw-osh-card-door" onClick={() => onOpen(targetOf('open', order.key))}>
                <span className="fw-osh-strong">{number}</span>
                <span className="fw-osh-ell">{order.subject ?? t('part.noSubject')}</span>
                {kind === 'office' && order.customer && <span className="fw-osh-muted fw-osh-ell">{order.customer.name}</span>}
              </button>
            </div>
            <div className="fw-osh-card-facts">
              <StateChip life={order.life} />
              <span className="fw-osh-muted">{t('part.cards.pieces', { count: order.pieces, pieces: formatNumber(order.pieces, locale) })}</span>
              {order.promised && order.life !== 'DRAFT' && order.life !== 'SENT' && <span className="fw-osh-muted">{t('part.cards.promised', { day: dayWords(order.promised, locale) })}</span>}
            </div>
            <ChipRow chips={order.chips} onOpen={onOpen} t={t} />
            <div className="fw-osh-card-acts">
              <ActButtons order={order} kind={kind} t={t} onOpen={onOpen} />
            </div>
          </li>
        )
      })}
    </ul>
  )
}
