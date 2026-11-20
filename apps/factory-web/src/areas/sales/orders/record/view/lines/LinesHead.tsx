'use client'

import { Eye, Lock, MoreHorizontal, PencilLine, Plus } from 'lucide-react'
import { Menu, type MenuItemDef } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { money } from '../../../../quotes/model'
import type { Order } from '../../../api'
import { closeLinesHeld, reopenHeld } from '../../../daily-model'
import { dayInstant, isFinal, promiseHeld, type Phrase } from '../../../model'
import { MAKE_STATUSES } from '../../line-moves'
import type { LinesHead as HeadFigures, LinesReader, TaxBasis, TotalRow } from '../../lines-table'
import { makeHeldOf } from '../../production'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'

/** The "Add a style" button's id (the key n focuses it). */
export const ADD_STYLE_ID = 'lines-add-style'

/**
 * F-OL-02 (Order LINES lane; 10-design-tab §2) — the tab's head, one row that wraps: "17 pieces · 3 lines · 1 charge · Ready by 12 Jan
 * 2027 ✎" (the date opens the ONE promise dialog for the whole order), late days, the order total for price readers, Add a style and
 * the tab ⋯ (Close lines with fewer pieces… · Reopen lines… · Make work orders…). Sales reads one line why prices are hidden; a writer
 * held by the order's state reads today's held words once. Read-only and Warehouse: no buttons, no ⋯. Fetches nothing.
 */
export function LinesHead({ order, model, actions, head, total, basis, reader, held, busy }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; head: HeadFigures; total: TotalRow | null; basis: TaxBasis; reader: LinesReader; held: Phrase | null; busy: boolean }) {
  const t = useT('orders')
  const locale = useLocale()
  const say = (phrase: Phrase | null) => (phrase ? t(phrase.key, phrase.params?.date ? { ...phrase.params, date: formatDate(dayInstant(String(phrase.params.date)), { locale }) } : phrase.params) : null)
  const busyWords = busy ? t('held.busy') : null
  const promiseWait = promiseHeld(order, model.can)
  const readyBy = order.promiseDate ? t('lines.head.readyBy', { date: formatDate(dayInstant(order.promiseDate), { locale }) }) : t('lines.head.noReadyBy')
  const late = (order.daysLate ?? 0) > 0
  const moved = order.originalPromiseDate && order.promiseDate && order.originalPromiseDate !== order.promiseDate
  // The tab ⋯: the whole order's acts — who changes lines sees all, who makes work orders sees that one (held with words).
  const items: MenuItemDef[] = []
  if (model.can.manage) {
    const closeWait = closeLinesHeld(order, model.can)
    items.push({ id: 'closeLines', label: t('lines.menu.closeLines'), disabled: !!(closeWait ?? busy), description: say(closeWait) ?? busyWords ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'closeLines' }) })
    if (order.lines.some((line) => line.closedShort)) {
      const reopenWait = reopenHeld(order, model.can)
      items.push({ id: 'reopenLines', label: t('action.reopenLines'), disabled: !!(reopenWait ?? busy), description: say(reopenWait) ?? busyWords ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'reopenLines' }) })
    }
  }
  if ((model.can.manage || model.can.makeWorkOrders) && MAKE_STATUSES.includes(order.status)) {
    const makeWait = makeHeldOf(order, model.can)
    items.push({ id: 'make', label: t('bandMenu.makeWorkOrders'), disabled: !!makeWait, description: say(makeWait) ?? undefined, onSelect: () => actions?.makeWorkOrders?.onOpen?.() })
  }
  const showMore = items.length > 0 && !isFinal(order)
  const totalWords = total && reader.prices ? t(basis.kind === 'vatNone' ? 'lines.head.total' : 'lines.head.totalVat', { amount: money(total.amount, order.currency, locale) }) : null
  return (
    <>
      <div className="fw-lt-head">
        <span className="fw-lt-head-facts">
          <strong>{t('lines.head.pieces', { count: head.pieces })}</strong>
          {head.piecesWas !== null && <span className="fw-lt-sub">{t('lines.cell.was', { value: head.piecesWas })}</span>}
          <span className="fw-lt-sep" aria-hidden>
            ·
          </span>
          <span>{t('lines.head.lines', { count: head.lines })}</span>
          {head.charges > 0 && (
            <>
              <span className="fw-lt-sep" aria-hidden>
                ·
              </span>
              <span>{t('lines.head.charges', { count: head.charges })}</span>
            </>
          )}
          <span className="fw-lt-sep" aria-hidden>
            ·
          </span>
          {model.can.manage && !isFinal(order) ? (
            <Button size="sm" variant="quiet" heldReason={say(promiseWait) ?? busyWords} aria-label={t('lines.head.readyByChange')} onClick={() => actions?.onDialog?.({ kind: 'promise' })}>
              {readyBy} <PencilLine size={13} aria-hidden />
            </Button>
          ) : (
            <span>{readyBy}</span>
          )}
          {late && <Tag tone="danger">{t('lines.head.late', { count: order.daysLate! })}</Tag>}
          {moved && <span className="fw-lt-sub">{t('lines.head.firstPromised', { date: formatDate(dayInstant(order.originalPromiseDate!), { locale }) })}</span>}
        </span>
        <span className="fw-lt-head-acts">
          {totalWords && (
            <span className="fw-lt-head-total">
              {totalWords}
              {total?.was !== null && total?.was !== undefined && <span className="fw-lt-sub">{t('lines.cell.was', { value: money(total.was, order.currency, locale) })}</span>}
            </span>
          )}
          {!reader.prices && !reader.writes && <span className="fw-so-hint">{t('held.noPrice')}</span>}
          {reader.writes && !isFinal(order) && (
            <Button id={ADD_STYLE_ID} size="sm" heldReason={say(held) ?? busyWords} aria-keyshortcuts="n" onClick={() => actions?.linesTab?.onAddStyleOpen?.()}>
              <Plus size={14} aria-hidden /> {t('editor.add.title')}
            </Button>
          )}
          {showMore && <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('lines.head.more') }} items={items} />}
        </span>
      </div>
      {reader.salesHint && (
        <p className="fw-lt-quiet">
          <Eye size={13} aria-hidden /> {t('lines.head.salesHow')}
        </p>
      )}
      {reader.writes && held && held.key !== 'held.noManage' && (
        <p className="fw-lt-quiet">
          <Lock size={13} aria-hidden /> {say(held)}
        </p>
      )}
    </>
  )
}
