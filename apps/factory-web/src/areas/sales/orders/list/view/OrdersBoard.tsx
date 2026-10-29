'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import Link from 'next/link'
import { EmptyState, ProgressBar } from '@nexus/ui/components'
import { GridCard, GridFooterSpacer, GridFooterStrip, GridSearchSlot, GridToolbar } from '@nexus/ui/grid'
import { Button, Pill, Skeleton, Tag } from '@nexus/ui/primitives'
import { ListKeysInfo } from '../../../../../list-frame/ListKeysInfo'
import { isListKey, type ListKey } from '../../../../../list-frame/model'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { money } from '../../../quotes/model'
import type { OrderRow } from '../../api'
import { boardLanes, dayInstant, depositTone, laneCount, laneValue, offBoard, shippedPercent } from '../../model'
import type { OrdersListActions, OrdersListModel } from '../list-model'

/**
 * The board by state (design `orders.board`; SAL-214): one lane per open state and Shipped, each with its count and —
 * with the price grain, when every order of the lane is read — its value; a card per order (number, customer, units,
 * the promise with its days late, the deposit, what left). Cards never drag: each state has one writer (SAL-204), and a
 * card's own verb is the one move a person makes from there (Make work orders on a confirmed order). Each card is a real
 * link; j / k walk the cards, Enter opens. The same saved rows and search as the list; closed and cancelled orders are
 * counted under the board with a way to the list.
 */
export function OrdersBoard({ model, actions, search, rowsSelect, onHelp }: { model: OrdersListModel; actions?: OrdersListActions; search: ReactNode; rowsSelect: ReactNode; onHelp: () => void }) {
  const t = useT('orders')
  const locale = useLocale()
  const ref = useRef<HTMLDivElement>(null)
  const lanes = boardLanes(model.rows)
  const shown = model.lanes.filter((lane) => lanes.includes(lane.status))
  const off = offBoard(model.board)
  const keys: ListKey[] = [
    { keys: ['v'], does: t('list.keyView') },
    { keys: ['j', 'k'], does: t('board.keyWalk') },
    { keys: ['↵'], does: 'keys.open' },
    { keys: ['/'], does: 'keys.search' },
    { keys: ['?'], does: 'keys.help' },
  ]

  // j / k walk the cards in reading order, / focuses the search, ? the keys (not while typing or in a menu or dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isListKey(event, event.target as HTMLElement | null)) return
      const root = ref.current
      if (!root) return
      if (event.key === '/') {
        const field = root.querySelector<HTMLInputElement>('.nds-toolbar input')
        if (!field) return
        event.preventDefault()
        field.focus()
        return
      }
      if (event.key === '?') {
        event.preventDefault()
        onHelp()
        return
      }
      if (event.key !== 'j' && event.key !== 'k') return
      const cards = Array.from(root.querySelectorAll<HTMLAnchorElement>('a.fw-so-card-link'))
      if (cards.length === 0) return
      event.preventDefault()
      const at = cards.findIndex((card) => card === document.activeElement)
      const next = at < 0 ? 0 : Math.min(cards.length - 1, Math.max(0, at + (event.key === 'j' ? 1 : -1)))
      cards[next]?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onHelp])

  const toolbar = (
    <GridToolbar
      wrap
      count={t('board.count', { count: shown.length })}
      right={
        model.updates > 0 ? (
          <Button size="sm" variant="tonal" onClick={() => actions?.onShowUpdates?.()}>
            {t('board.updates', { count: model.updates })}
          </Button>
        ) : undefined
      }
    >
      <GridSearchSlot>{search}</GridSearchSlot>
      {rowsSelect}
    </GridToolbar>
  )
  const footer = (
    <GridFooterStrip>
      {off && off.closed + off.cancelled > 0 ? (
        <span className="fw-so-hint">
          {t('board.offBoard', { closed: off.closed, cancelled: off.cancelled })}{' '}
          <Button size="sm" variant="link" onClick={() => actions?.onRows?.('CLOSED')}>
            {t('board.seeClosed')}
          </Button>
        </span>
      ) : null}
      <GridFooterSpacer />
      <ListKeysInfo keys={keys} onHelp={onHelp} />
    </GridFooterStrip>
  )

  return (
    <div ref={ref}>
      <GridCard toolbar={toolbar} footer={footer} className="fw-so-boardcard">
        {lanes.length === 0 ? (
          <div className="fw-so-board-state">
            <EmptyState
              title={t('board.notOnBoard.title')}
              description={t('board.notOnBoard.body')}
              action={
                <Button size="sm" onClick={() => actions?.onLayout?.('list')}>
                  {t('board.notOnBoard.list')}
                </Button>
              }
            />
          </div>
        ) : (
          <div className="fw-so-board" role="list" aria-label={t('board.label')}>
            {shown.map((lane) => {
              const count = laneCount(lane, model.rows, model.board)
              const value = laneValue(lane, model.can.price)
              const currency = lane.items?.[0]?.currency ?? 'EUR'
              return (
                <section key={lane.status} className="fw-so-lane" role="listitem" aria-label={t(`status.${lane.status}`)}>
                  <header className="fw-so-lane-head">
                    <h2 className="fw-so-h3">
                      {t(`status.${lane.status}`)} <span className="fw-so-lane-count">{count === null ? (lane.items ? t('board.countMore', { count: lane.items.length }) : '—') : count}</span>
                    </h2>
                    {model.can.price && <span className="fw-so-hint">{value === null ? (lane.items && lane.items.length > 0 ? t('board.valuePartial') : '') : money(value, currency, locale)}</span>}
                  </header>
                  {lane.problem ? (
                    <div className="fw-so-lane-state">
                      <p className="fw-so-hint">{t(lane.problem)}</p>
                      <Button size="sm" onClick={() => actions?.onRetry?.()}>
                        {t('common.retry')}
                      </Button>
                    </div>
                  ) : lane.items === null ? (
                    <div className="fw-so-lane-cards" aria-busy="true">
                      <Skeleton height={84} />
                      <Skeleton height={84} />
                    </div>
                  ) : lane.items.length === 0 ? (
                    <p className="fw-so-hint fw-so-lane-empty">{t('board.laneEmpty')}</p>
                  ) : (
                    <ul className="fw-so-lane-cards">
                      {lane.items.map((row) => (
                        <li key={row.id}>
                          <BoardCard row={row} model={model} />
                        </li>
                      ))}
                      {lane.more && (
                        <li>
                          <Button size="sm" variant="link" onClick={() => actions?.onRows?.(lane.status)}>
                            {t('board.allInList', { state: t(`status.${lane.status}`) })}
                          </Button>
                        </li>
                      )}
                    </ul>
                  )}
                </section>
              )
            })}
          </div>
        )}
      </GridCard>
    </div>
  )
}

function BoardCard({ row, model }: { row: OrderRow; model: OrdersListModel }) {
  const t = useT('orders')
  const locale = useLocale()
  const href = `${model.prefix}/sales/orders/${row.id}`
  const late = row.daysLate !== null && row.daysLate > 0
  return (
    <article className="fw-so-card" aria-label={t('board.cardLabel', { number: row.number, customer: row.partyName })}>
      <div className="fw-so-card-top">
        <Link className="fw-so-link fw-so-card-link" href={href}>
          {row.number}
        </Link>
        <Pill tone={depositTone(row.deposit.state, row.deposit.dueDate, model.today)}>{t(`board.deposit.${row.deposit.state}`)}</Pill>
      </div>
      <span className="fw-so-card-customer">{row.partyName || '—'}</span>
      <span className="fw-so-card-facts">
        <span>{t('list.units', { count: row.units })}</span>
        {row.promiseDate ? (
          <Tag tone={late ? 'danger' : 'neutral'}>{late ? t('board.promiseLate', { date: formatDate(dayInstant(row.promiseDate), { locale }), count: row.daysLate ?? 0 }) : t('board.promise', { date: formatDate(dayInstant(row.promiseDate), { locale }) })}</Tag>
        ) : (
          <Tag tone="neutral">{t('list.noPromise')}</Tag>
        )}
      </span>
      <ProgressBar value={shippedPercent(row)} ariaLabel={t('list.shippedLabel', { number: row.number })} height={5} />
      <span className="fw-so-card-sub">{t('list.shipped', { shipped: row.shippedUnits, units: row.units })}</span>
      {row.status === 'CONFIRMED' && model.can.makeWorkOrders && row.deposit.state !== 'OPEN' && row.deposit.state !== 'MISSING' && (
        <Button size="sm" variant="secondary" asChild>
          <Link href={`${model.prefix}/production/work-orders?new=1&order=${encodeURIComponent(row.number)}`}>{t('step.makeWorkOrders')}</Link>
        </Button>
      )}
    </article>
  )
}
