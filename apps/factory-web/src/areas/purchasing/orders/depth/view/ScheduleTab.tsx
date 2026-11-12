'use client'

import { useMemo, useState } from 'react'
import { CalendarClock, Eraser, MoreHorizontal, Split } from 'lucide-react'
import { CalendarGrid, type CalendarDay, type CalendarKind } from '@nexus/ui/components/CalendarGrid/index'
import { Banner, Card, EmptyState, Menu, SummaryTable } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Skeleton, Spinner } from '@nexus/ui/primitives'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { useCalendarWords } from '../../../../_shared/calendar-grid/words'
import { quantity } from '../../../../_shared/buying/model'
import type { PurchaseOrder } from '../../api'
import {
  closedDays,
  DEPTH,
  deliveryState,
  laterPhrase,
  onClosedDay,
  scheduleDraftOf,
  scheduleEditHeld,
  scheduleRows,
  supplierDateHeld,
  supplierDateMode,
  type OrderDepthActions,
  type OrderDepthModel,
  type ScheduleRow,
} from '../model'
import { useDay, useDepthSay } from './words'

const STATE_TONE = { DRAFT: 'neutral', ASKED: 'info', CONFIRMED: 'success', LATER: 'danger' } as const

/**
 * Purchase order › Delivery schedule (design purchasing.orders rec tab `schedule`, SCM-052 / SCM-088): every line's
 * deliveries on the list frame — line, delivery n of m, the day asked (a day the supplier is closed says so), the
 * supplier's day kept apart with "confirmed later than needed", quantity, note —, a draft line split into deliveries or
 * back to one (⋯), the supplier's day recorded once sent (its first one, or a move with the reason); the mini calendar of
 * the deliveries with the supplier's closures shaded (its weekly days off and dated closures); every move of a day with
 * who, when and why. A line without a schedule is one delivery (the design's empty state).
 */
export function ScheduleTab({ order, model, actions }: { order: PurchaseOrder; model: OrderDepthModel; actions?: OrderDepthActions }) {
  const t = useT(DEPTH)
  const tb = useT('buying')
  const say = useDepthSay()
  const day = useDay()
  const locale = useLocale()
  const depth = model.depth.value

  const columns = useMemo<ColDef<ScheduleRow>[]>(() => {
    const closed = closedDays(model.closures?.value ?? null)
    const LineCell = ({ data }: ICellRendererParams<ScheduleRow>) =>
      data ? (
        <span className="fw-by-cell">
          <span>{t('schedule.line', { seq: data.lineSeq, item: data.itemCode })}</span>
          {data.ended && <span className="fw-by-cell-sub">{t('schedule.ended')}</span>}
        </span>
      ) : null
    const DeliveryCell = ({ data }: ICellRendererParams<ScheduleRow>) => (data ? <span>{data.delivery ? t('schedule.nOfM', { n: data.seq, m: data.count }) : t('schedule.one')}</span> : null)
    const AskedCell = ({ data }: ICellRendererParams<ScheduleRow>) =>
      data ? (
        <span className="fw-by-cell">
          <span>{day(data.needDate)}</span>
          {model.closures?.value && onClosedDay(data.needDate, closed) && <span className="fw-by-cell-sub fw-by-warning">{t('schedule.closedDay')}</span>}
        </span>
      ) : null
    const TheirsCell = ({ data }: ICellRendererParams<ScheduleRow>) => {
      if (!data) return null
      const state = deliveryState(order.status, data)
      return (
        <span className="fw-by-cell">
          <span>{data.confirmedDate ? day(data.confirmedDate) : t(`schedule.state.${state}`)}</span>
          {data.confirmedDate && (
            <span>
              <Pill tone={STATE_TONE[state]}>{state === 'LATER' ? say(laterPhrase(data.confirmedLaterBy)) : t('schedule.state.CONFIRMED')}</Pill>
            </span>
          )}
        </span>
      )
    }
    const QuantityCell = ({ data }: ICellRendererParams<ScheduleRow>) => (data ? <span className="fw-by-num">{`${quantity(data.quantity, locale)} ${tb(`uom.${data.uom}`)}`}</span> : null)
    const NoteCell = ({ data }: ICellRendererParams<ScheduleRow>) => (data ? <span className="fw-by-ellipsis fw-by-cell-sub" title={data.note ?? undefined}>{data.note ?? ''}</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<ScheduleRow>) => {
      if (!data || !depth) return null
      const line = depth.lines.find((entry) => entry.id === data.lineId)
      if (!line) return null
      const editHeld = scheduleEditHeld(order.status, line, model.can)
      const dateHeld = supplierDateHeld(order.status, data, model.can)
      const items = [
        ...(editHeld === null && (data.delivery === null || data.seq === 1)
          ? [{ id: 'split', label: t(line.deliveries.length > 0 ? 'schedule.change' : 'schedule.split'), icon: <Split size={14} aria-hidden />, onSelect: () => actions?.onDialog?.({ kind: 'schedule', lineId: line.id, rows: scheduleDraftOf(line) }) }]
          : []),
        ...(editHeld === null && line.deliveries.length > 0 && data.seq === 1 ? [{ id: 'clear', label: t('schedule.clear'), icon: <Eraser size={14} aria-hidden />, onSelect: () => actions?.onDialog?.({ kind: 'clearSchedule', lineId: line.id }) }] : []),
        ...(dateHeld === null
          ? [
              {
                id: 'date',
                label: t(supplierDateMode(data) === 'FIRST' ? 'date.first' : 'date.move'),
                icon: <CalendarClock size={14} aria-hidden />,
                onSelect: () =>
                  actions?.onDialog?.({ kind: 'supplierDate', draft: { lineId: line.id, deliveryId: data.delivery?.id ?? null, mode: supplierDateMode(data), from: data.confirmedDate ?? data.needDate, date: data.confirmedDate ?? data.needDate, source: 'SUPPLIER', reason: '', contact: '' } }),
              },
            ]
          : []),
      ]
      if (items.length === 0) return null
      return <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('schedule.menu', { seq: data.lineSeq, n: data.seq }) }} items={items} />
    }
    return [
      { colId: 'line', headerName: t('schedule.col.line'), minWidth: 170, flex: 1.2, cellRenderer: LineCell },
      { colId: 'delivery', headerName: t('schedule.col.delivery'), minWidth: 130, flex: 0.8, cellRenderer: DeliveryCell },
      { colId: 'asked', headerName: t('schedule.col.asked'), minWidth: 140, flex: 0.9, cellRenderer: AskedCell },
      { colId: 'theirs', headerName: t('schedule.col.theirs'), minWidth: 200, flex: 1.2, cellRenderer: TheirsCell },
      { colId: 'quantity', headerName: t('schedule.col.quantity'), minWidth: 120, flex: 0.7, type: 'rightAligned', cellRenderer: QuantityCell },
      { colId: 'note', headerName: t('schedule.col.note'), minWidth: 140, flex: 1, cellRenderer: NoteCell },
      { colId: 'more', headerName: tb('po.col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    // The cells read the depth parts and the rights; the actions are the container's (their identity changes each render).
  }, [t, tb, locale, order.status, depth, model.can, model.closures?.value])

  if (!depth) {
    return model.depth.problem ? (
      <Card padded>
        <EmptyState
          title={t('schedule.failed')}
          description={tb(model.depth.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {tb('common.retry')}
            </Button>
          }
        />
      </Card>
    ) : (
      <Card padded aria-busy="true">
        <p className="fw-by-hint" role="status">
          <Spinner size={14} /> {t('schedule.loading')}
        </p>
        <div className="fw-by-stack">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} height={22} />
          ))}
        </div>
      </Card>
    )
  }

  const rows = scheduleRows(depth)
  const later = rows.filter((row) => row.confirmedLaterBy > 0)
  const scheduled = depth.lines.some((line) => line.deliveries.length > 0)
  return (
    <div className="fw-by-stack">
      <div className="fw-by-head">
        <span className="fw-by-hint">{order.status === 'DRAFT' ? t('schedule.hintDraft') : t('schedule.hintSent')}</span>
      </div>
      {later.length > 0 && <Banner tone="warning" title={t('schedule.laterBanner', { count: later.length, supplier: order.supplier.name })}>{t('schedule.laterHint')}</Banner>}
      <ListFrame<ScheduleRow>
        label={t('schedule.tableLabel')}
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        count={t('schedule.count', { count: rows.length })}
        listKey={null}
        state={rows.length === 0 ? <p className="fw-by-hint">{t('schedule.noLines')}</p> : undefined}
      />
      {!scheduled && rows.length > 0 && <p className="fw-by-hint">{t('schedule.empty')}</p>}
      <div className="fw-pod-two">
        <ScheduleCalendar order={order} model={model} actions={actions} rows={rows} />
        <DateHistory model={model} />
      </div>
    </div>
  )
}

/** The mini calendar: each delivery day (asked, confirmed, later; on a closed day it warns) over the supplier's closures. */
function ScheduleCalendar({ order, model, actions, rows }: { order: PurchaseOrder; model: OrderDepthModel; actions?: OrderDepthActions; rows: readonly ScheduleRow[] }) {
  const t = useT(DEPTH)
  const tb = useT('buying')
  const locale = useLocale()
  const day = useDay()
  const words = useCalendarWords()
  const closures = model.closures?.value ?? null
  const closed = closedDays(closures)
  const first = rows.map((row) => row.confirmedDate ?? row.needDate).sort()[0] ?? model.today
  const [opened, setOpened] = useState<string | null>(null)
  const month = model.month ?? first.slice(0, 7)

  const kinds: CalendarKind[] = [
    { id: 'open', label: t('calendar.open') },
    { id: 'closed', label: t('calendar.closed'), off: true, pattern: 'hatch' },
    { id: 'asked', label: t('calendar.asked'), tone: 'info', pattern: 'outline' },
    { id: 'confirmed', label: t('calendar.confirmed'), tone: 'success', pattern: 'plain' },
    { id: 'later', label: t('calendar.later'), tone: 'danger', pattern: 'stripe' },
    { id: 'clash', label: t('calendar.clash'), tone: 'warning', pattern: 'cross' },
  ]
  const days: Record<string, CalendarDay> = {}
  for (const [date, name] of Object.entries(closed.days)) days[date] = { kind: 'closed', reason: name }
  const byDay = new Map<string, ScheduleRow[]>()
  for (const row of rows) {
    const date = row.confirmedDate ?? row.needDate
    byDay.set(date, [...(byDay.get(date) ?? []), row])
  }
  for (const [date, list] of byDay) {
    const state = list.some((row) => row.confirmedLaterBy > 0) ? 'later' : list.every((row) => row.confirmedDate) ? 'confirmed' : 'asked'
    days[date] = { kind: closures && onClosedDay(date, closed) ? 'clash' : state, reason: list.map((row) => t('schedule.line', { seq: row.lineSeq, item: row.itemCode })).join(', '), detail: t('calendar.deliveries', { count: list.length }) }
  }
  const openedRows = opened ? (byDay.get(opened) ?? []) : []

  return (
    <Card padded>
      <div className="fw-by-stack">
        <h3 className="fw-by-h3">{t('calendar.title')}</h3>
        {model.closures === null ? (
          <p className="fw-by-hint">{t('calendar.noClosuresRight')}</p>
        ) : model.closures.problem ? (
          <p className="fw-by-hint fw-by-warning">{t('calendar.closuresFailed', { problem: tb(model.closures.problem) })}</p>
        ) : closures && closures.weeklyDaysOff.length === 0 && closures.ahead.length === 0 ? (
          <p className="fw-by-hint">{t('calendar.noClosures', { supplier: order.supplier.name })}</p>
        ) : null}
        <CalendarGrid
          label={t('calendar.label', { number: order.number })}
          kinds={kinds}
          days={days}
          weekKinds={closed.weekly.map((off) => (off ? 'closed' : 'open'))}
          views={['month']}
          month={month}
          onMonthChange={(next) => actions?.onMonth?.(next)}
          today={model.today}
          onDayOpen={(date) => setOpened(date)}
          loading={model.closures !== null && model.closures.value === null && model.closures.problem === null}
          listBelow={420}
          words={words}
          locale={INTL_LOCALE[locale]}
        />
        {opened && (
          <div className="fw-by-stack" role="status">
            <p className="fw-by-hint">
              <b>{day(opened)}</b> · {closed.days[opened] ? t('calendar.closedFor', { name: closed.days[opened]! }) : openedRows.length === 0 ? t('calendar.nothing') : t('calendar.deliveries', { count: openedRows.length })}
            </p>
            {openedRows.length > 0 && (
              <ul className="fw-by-list">
                {openedRows.map((row) => (
                  <li key={row.id}>
                    {t('schedule.line', { seq: row.lineSeq, item: row.itemCode })} · {row.delivery ? t('schedule.nOfM', { n: row.seq, m: row.count }) : t('schedule.one')} · {quantity(row.quantity, locale)} {tb(`uom.${row.uom}`)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}

/** The API's prefix of a scheduled line's own move, which follows its earliest delivery (its words are said in ours). */
const FOLLOWS = 'Follows its earliest delivery: '

/** Every move of a confirmed day (SCM-088): which line or delivery, from → to, who said or agreed it, when, why. */
function DateHistory({ model }: { model: OrderDepthModel }) {
  const t = useT(DEPTH)
  const locale = useLocale()
  const day = useDay()
  const changes = model.depth.value?.dateChanges ?? []
  return (
    <Card padded>
      <div className="fw-by-stack">
        <h3 className="fw-by-h3">{t('history.title')}</h3>
        {changes.length === 0 ? (
          <p className="fw-by-hint">{t('history.empty')}</p>
        ) : (
          <SummaryTable
            label={t('history.title')}
            stackOnPhone
            columns={[t('history.col.what'), t('history.col.move'), t('history.col.who'), t('history.col.why')]}
            align={['left', 'left', 'left', 'left']}
            widths={['22%', '28%', '22%', '28%']}
            rows={[...changes].reverse().map((change) => ({
              id: change.id,
              cells: [
                change.deliverySeq ? t('history.delivery', { seq: change.lineSeq, n: change.deliverySeq }) : t('history.line', { seq: change.lineSeq }),
                <span key="move" className="fw-by-cell">
                  <span>{t('history.fromTo', { from: day(change.fromDate), to: day(change.toDate) })}</span>
                  <span className="nds-summary-sub">{formatDateTime(change.changedAt, { locale })}</span>
                </span>,
                change.source === 'SUPPLIER' ? (change.supplierContactName ? t('history.supplierName', { name: change.supplierContactName }) : t('history.supplier')) : t('history.agreed'),
                <span key="why" className="fw-pod-wrap">
                  {change.reason.startsWith(FOLLOWS) ? t('history.follows', { reason: change.reason.slice(FOLLOWS.length) }) : change.reason}
                </span>,
              ],
            }))}
          />
        )}
      </div>
    </Card>
  )
}
