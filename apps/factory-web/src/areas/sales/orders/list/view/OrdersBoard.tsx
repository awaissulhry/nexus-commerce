'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { EmptyState, ProgressBar } from '@nexus/ui/components'
import { GridCard, GridFooterSpacer, GridFooterStrip, GridSearchSlot, GridToolbar } from '@nexus/ui/grid'
import { Button, Pill, Skeleton, Tag } from '@nexus/ui/primitives'
import { Ruler } from 'lucide-react' // F-SA-221: the made-to-measure mark
import { ListKeysInfo } from '../../../../../list-frame/ListKeysInfo'
import { isListKey, type ListKey } from '../../../../../list-frame/model'
import { formatDate } from '../../../../../lib/i18n/format'
import type { Locale } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { money } from '../../../quotes/model'
import type { OrderRow, OrderStatus } from '../../api'
import { boardLanes, createShipmentHref, dayInstant, depositTone, laneCount, laneValue, offBoard, shippedPercent, type Lane, type OrderAbilities } from '../../model'
import { waitDoorsOf } from '../../model' // F-SA-214
import type { OrdersListActions, OrdersListModel } from '../list-model'
// ---- F-SA-213 (sales page plan N8, picks P13, P15, P18; 12-lists-board §3): the photo, the label, the priority, new messages ----
import { RecordPicture } from '../../../../../lib/record-picture/view/RecordPicture'
import { PictureViewer } from '../../../../../lib/record-picture/view/PictureViewer'
import { LastMessageCell } from '../../../../../lib/last-message-cell/view/LastMessageCell'
import { useUnread } from '../../../../../lib/last-message-cell/use-unread'
import { NAMESPACE as SHEET } from '../sheet/model'
import { NAMESPACE as DEPTH } from '../../depth/model'

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

/**
 * The board by state (design `orders.board`; SAL-214): one lane per open state and Shipped, each with its count and —
 * with the price grain, when every order of the lane is read — its value; a card per order. Cards never drag: each state has
 * one writer (SAL-204), and a card's own verb is the one move a person makes from there (Make work orders on a confirmed order).
 * Each card's number is a real link; j / k walk the cards, Enter opens. The same saved rows and search as the list; closed and
 * cancelled orders are counted under the board with a way to the list. B-W2a-50: the board follows live changes by itself (open
 * it in a new tab for a second screen), and a ready order's card offers Create shipment.
 *
 * F-SA-213 (sales page plan N8; 12-lists-board §3.1–§3.3): the card shows the style's photo on the left (the ONE picture part at
 * its board size, fit not crop: 64 px, 72 from 1680 px wide, 48 on a phone), then the number and the deposit, the customer, the
 * label on the garment (only when it adds something: not the customer's own label), the pieces and the promise (late in red), and
 * on one line the reader's new messages (a door to the thread), "Priority · <level>" (only when not Normal) and "Urgent
 * (customer)" (the customer's own mark). The shipped bar only in Ready · Partly shipped · Shipped. The verb is held with why
 * instead of hidden. Lanes are 260 px wide and scroll sideways inside the card (an empty lane 160 px; they snap at a lane's
 * start), one under the other on a phone. A lane reads its own new-message counts (≤ 50 rows each).
 *
 * F-SA-214 (sales page plan N8 / N7; 12-lists-board §3.1, §3.4, §3.5): the first lane is Waiting for approval; its cards say why
 * each waits, each reason a door (Home › Approvals · the order · Made-to-measure › Riders, the last only for a reader of
 * measurements). Delivered orders are counted under the board with "See them in the list". An empty lane says "None". While a
 * card has the focus or the picture is open large, live changes wait behind "N updates · Show" (the board tells the page:
 * `onBoardHold`), so a card never moves under the person.
 */

/** The lanes whose cards show what left (elsewhere "0 of 40 shipped" is noise). */
export const SHIPPED_LANES: readonly OrderStatus[] = Object.freeze(['READY', 'PARTLY_SHIPPED', 'SHIPPED'])

/** A label on the garment as the card says it (the Brand cell's rule: a hidden label says so, never its name). */
export type CardLabel = { readonly kind: 'own' } | { readonly kind: 'hidden' } | { readonly kind: 'named'; readonly name: string }

export interface CardFacts {
  /** The labels that add something (the customer's own private label is left out: it is the customer's name again). */
  readonly labels: readonly CardLabel[]
  /** The office's level, only when not Normal. */
  readonly priority: 'LOW' | 'HIGH' | 'URGENT' | null
  /** The customer's own mark (P15: "Urgent (customer)"; bare "Urgent" is the factory rush). */
  readonly customerUrgent: boolean
  readonly shippedBar: boolean
  /** The card's one verb: a link, or held with its reason; null: none here (another lane, or no right). */
  readonly verb: { readonly kind: 'makeWorkOrders' | 'createShipment'; readonly held: string | null } | null
}

/** What a card shows (pure: the board's test reads it). */
export function cardFacts(row: OrderRow, can: Pick<OrderAbilities, 'makeWorkOrders' | 'createShipment'>): CardFacts {
  const labels: CardLabel[] = []
  for (const brand of row.brands) {
    if (brand.own) labels.push({ kind: 'own' })
    else if (brand.partyId === row.partyId) continue
    else if (brand.partyId === null || !brand.name) labels.push({ kind: 'hidden' })
    else labels.push({ kind: 'named', name: brand.name })
  }
  const level = row.priority?.level ?? 'NORMAL'
  const waitsForDeposit = row.deposit.state === 'OPEN' || row.deposit.state === 'MISSING'
  const verb =
    row.status === 'CONFIRMED' && can.makeWorkOrders
      ? { kind: 'makeWorkOrders' as const, held: waitsForDeposit ? 'board.held.deposit' : null }
      : row.status === 'READY' && can.createShipment
        ? { kind: 'createShipment' as const, held: null }
        : null
  return {
    labels,
    priority: level === 'NORMAL' ? null : level,
    customerUrgent: row.customerUrgency === 'URGENT',
    shippedBar: SHIPPED_LANES.includes(row.status),
    verb,
  }
}

/** The card's name for a screen reader: number, customer, pieces, the promise, and the reader's new messages when there are any. */
// F-SA-221: + "made to measure" for an order with a made-to-measure unit (never a rider's name).
export function cardName(t: Translate, row: Pick<OrderRow, 'number' | 'partyName' | 'units' | 'promiseDate' | 'madeToMeasure'>, locale: Locale, newMessages: number): string {
  const parts = [
    t('board.cardLabel', { number: row.number, customer: row.partyName || '—' }),
    t('board.cardPieces', { count: row.units }),
    row.promiseDate ? t('board.cardPromised', { date: formatDate(dayInstant(row.promiseDate), { locale }) }) : t('board.cardNoPromise'),
    ...(row.madeToMeasure ? [t('board.cardMtm')] : []),
    ...(newMessages > 0 ? [t('board.cardNew', { count: newMessages })] : []),
  ]
  return parts.join(', ')
}

export function OrdersBoard({ model, actions, search, rowsSelect, onHelp }: { model: OrdersListModel; actions?: OrdersListActions; search: ReactNode; rowsSelect: ReactNode; onHelp: () => void }) {
  const t = useT('orders')
  const locale = useLocale()
  const ref = useRef<HTMLDivElement>(null)
  const lanes = boardLanes(model.rows)
  const shown = model.lanes.filter((lane) => lanes.includes(lane.status))
  const off = offBoard(model.board)
  // F-SA-213: the photo large (one viewer for the board; Esc gives the focus back to the photo).
  const [viewer, setViewer] = useState<string | null>(null)
  const viewerRow = viewer ? (shown.flatMap((lane) => lane.items ?? []).find((row) => row.id === viewer) ?? null) : null
  // F-SA-214: a card with the focus, or the picture open large, holds the live re-reads (the page counts them as updates).
  const [focused, setFocused] = useState(false)
  const held = focused || viewer !== null
  const onHold = actions?.onBoardHold
  useEffect(() => onHold?.(held), [onHold, held])
  useEffect(() => () => onHold?.(false), [onHold])
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
      {/* F-SA-214: Delivered has no lane: counted here, a door to its rows in the list. */}
      {off && off.delivered > 0 ? (
        <Button size="sm" variant="link" onClick={() => actions?.onRows?.('DELIVERED')}>
          {t('offBoard.delivered', { count: off.delivered })}
        </Button>
      ) : null}
      <GridFooterSpacer />
      <ListKeysInfo keys={keys} onHelp={onHelp} />
    </GridFooterStrip>
  )

  return (
    <div
      ref={ref}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        // F-SA-214: the focus left the board (not only one card for the next).
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false)
      }}
    >
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
            {shown.map((lane) => (
              <BoardLaneView key={lane.status} lane={lane} model={model} actions={actions} t={t} locale={locale} onPicture={setViewer} />
            ))}
          </div>
        )}
      </GridCard>
      {viewerRow && (
        <PictureViewer
          source="order"
          recordId={viewerRow.id}
          number={viewerRow.number}
          picture={viewerRow.picture}
          styleCount={viewerRow.styleCount}
          read={actions?.readPictures}
          demo={model.demoPictures?.[viewerRow.id]}
          prefix={model.prefix}
          recordHref={`${model.prefix}/sales/orders/${viewerRow.id}`}
          linesHref={`${model.prefix}/sales/orders/${encodeURIComponent(viewerRow.id)}?tab=lines`}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  )
}

/** One lane: its head (state, count, value), its cards, and its own new-message counts (≤ 50 rows: one read per lane). */
function BoardLaneView({ lane, model, actions, t, locale, onPicture }: { lane: Lane; model: OrdersListModel; actions?: OrdersListActions; t: Translate; locale: Locale; onPicture: (id: string) => void }) {
  const count = laneCount(lane, model.rows, model.board)
  const value = laneValue(lane, model.can.price)
  const currency = lane.items?.[0]?.currency ?? 'EUR'
  const rows = useMemo(() => (lane.items ?? []).map((row) => ({ recordType: 'SalesOrder', id: row.id })), [lane.items])
  const unread = useUnread(model.boardUnread?.read ?? null, rows, model.boardUnread?.refresh ?? 0)
  const empty = lane.items !== null && lane.items.length === 0 && !lane.problem
  return (
    <section className={empty ? 'fw-so-lane is-empty' : 'fw-so-lane'} role="listitem" aria-label={t(`status.${lane.status}`)}>
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
          <Skeleton height={112} />
          <Skeleton height={112} />
        </div>
      ) : lane.items.length === 0 ? (
        <p className="fw-so-hint fw-so-lane-empty">{t('lane.none') /* F-SA-214: 0 is an answer; the lane says None */}</p>
      ) : (
        <ul className="fw-so-lane-cards">
          {lane.items.map((row) => (
            <li key={row.id}>
              <BoardCard row={row} model={model} actions={actions} newMessages={unread[row.id]} onPicture={() => onPicture(row.id)} />
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
}

function BoardCard({ row, model, actions, newMessages, onPicture }: { row: OrderRow; model: OrdersListModel; actions?: OrdersListActions; newMessages: { newCount: number; lastAt: string | null } | undefined; onPicture: () => void }) {
  const t = useT('orders')
  const s = useT(SHEET)
  const d = useT(DEPTH)
  const locale = useLocale()
  const href = `${model.prefix}/sales/orders/${row.id}`
  const late = row.daysLate !== null && row.daysLate > 0
  const facts = cardFacts(row, model.can)
  const labelWords = facts.labels.map((label) => (label.kind === 'own' ? s('brand.own') : label.kind === 'hidden' ? s('brand.hidden') : label.name)).join(', ')
  const fresh = newMessages && newMessages.newCount > 0 ? newMessages : undefined
  const waits = waitDoorsOf(row, model.prefix, model.can) // F-SA-214
  return (
    <article className="fw-so-card" aria-label={cardName(t, row, locale, fresh?.newCount ?? 0)}>
      <RecordPicture source="order" recordId={row.id} number={row.number} picture={row.picture} styleCount={row.styleCount} size="board" read={actions?.readPictures} demo={model.demoPictures?.[row.id]} onOpen={onPicture} />
      <div className="fw-so-card-text">
        <div className="fw-so-card-top">
          <Link className="fw-so-link fw-so-card-link" href={href}>
            {row.number}
          </Link>
          <Pill tone={depositTone(row.deposit.state, row.deposit.dueDate, model.today)}>{t(`board.deposit.${row.deposit.state}`)}</Pill>
        </div>
        <span className="fw-so-card-customer">{row.partyName || '—'}</span>
        {labelWords && <span className="fw-so-card-label">{labelWords}</span>}
        <span className="fw-so-card-facts">
          <span>{t('list.units', { count: row.units })}</span>
          {row.promiseDate ? (
            <Tag tone={late ? 'danger' : 'neutral'}>{late ? t('board.promiseLate', { date: formatDate(dayInstant(row.promiseDate), { locale }), count: row.daysLate ?? 0 }) : t('board.promise', { date: formatDate(dayInstant(row.promiseDate), { locale }) })}</Tag>
          ) : (
            <Tag tone="neutral">{t('list.noPromise')}</Tag>
          )}
        </span>
        {/* F-SA-214: why a waiting order waits, each reason a door where it is decided (none: the words alone). */}
        {waits.length > 0 && (
          <span className="fw-so-card-line">
            {waits.map((wait) =>
              wait.href ? (
                <Link key={wait.word} className="fw-so-link" href={wait.href}>
                  {t(wait.word)}
                </Link>
              ) : (
                <span key={wait.word} className="fw-so-card-sub">
                  {t(wait.word)}
                </span>
              ),
            )}
          </span>
        )}
        {(fresh || facts.priority || facts.customerUrgent || row.madeToMeasure) && (
          <span className="fw-so-card-line">
            {/* F-SA-221: the made-to-measure mark (and its units waiting for the factory review); never a rider's name. */}
            {row.madeToMeasure && (
              <Tag tone="neutral">
                <Ruler size={12} aria-hidden /> {s('mtm.mark')}
              </Tag>
            )}
            {row.madeToMeasure && row.madeToMeasure.waitingReview > 0 && <Tag tone="warning">{s('mtm.waitingReview', { count: row.madeToMeasure.waitingReview })}</Tag>}
            {fresh && <LastMessageCell unread={fresh} href={`${href}?thread=new`} record={row.number} />}
            {facts.priority && <Tag tone={facts.priority === 'URGENT' ? 'danger' : facts.priority === 'HIGH' ? 'warning' : 'neutral'}>{t('board.priority', { level: d(`priority.level.${facts.priority}`) })}</Tag>}
            {facts.customerUrgent && <Tag tone="warning">{t('board.customerUrgent')}</Tag>}
          </span>
        )}
      </div>
      {facts.shippedBar && (
        <div className="fw-so-card-span">
          <ProgressBar value={shippedPercent(row)} ariaLabel={t('list.shippedLabel', { number: row.number })} height={5} />
          <span className="fw-so-card-sub">{t('list.shipped', { shipped: row.shippedUnits, units: row.units })}</span>
        </div>
      )}
      {facts.verb && (
        <div className="fw-so-card-span fw-so-card-verb">
          {facts.verb.held ? (
            <Button size="sm" variant="secondary" heldReason={t(facts.verb.held)}>
              {t('step.makeWorkOrders')}
            </Button>
          ) : facts.verb.kind === 'makeWorkOrders' ? (
            <Button size="sm" variant="secondary" asChild>
              <Link href={`${model.prefix}/production/work-orders?new=1&order=${encodeURIComponent(row.number)}`}>{t('step.makeWorkOrders')}</Link>
            </Button>
          ) : (
            <Button size="sm" variant="secondary" asChild>
              <Link href={createShipmentHref(model.prefix, row.id)}>{t('action.createShipment')}</Link>
            </Button>
          )}
        </div>
      )}
    </article>
  )
}
