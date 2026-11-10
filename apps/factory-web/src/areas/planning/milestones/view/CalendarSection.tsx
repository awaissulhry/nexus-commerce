'use client'

import { useEffect, useMemo, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { CalendarGrid, type CalendarKind } from '@nexus/ui/components/CalendarGrid/index'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useModeWords } from '../../../../list-frame/w2b/words'
import { usePageKeys } from '../../../_shared/buying/hooks'
import { dayText, lateWords, milestoneName, rowsOf, stateTone, stateWords, visibleRows, type MilestoneRow, type Words } from '../model'
import type { MilestonesActions, MilestonesModel } from '../view-model'

/** The kind of a day: its most pressing milestone (late, a gate waiting, due, all done). */
const DAY_KINDS = ['late', 'waiting', 'due', 'done'] as const
type DayKind = (typeof DAY_KINDS)[number]

function dayKindOf(rows: readonly MilestoneRow[]): DayKind {
  if (rows.some((row) => row.state !== 'DONE' && row.late !== null)) return 'late'
  if (rows.some((row) => row.state === 'WAITING')) return 'waiting'
  if (rows.some((row) => row.state !== 'DONE')) return 'due'
  return 'done'
}

const shiftMonth = (month: string, by: number): string => {
  const [year, number] = month.split('-').map(Number) as [number, number]
  const date = new Date(Date.UTC(year, number - 1 + by, 1))
  return date.toISOString().slice(0, 7)
}

/**
 * Milestones by date (design planning.milestones sec:calendar "Calendar (month)"): the DS CalendarGrid, each day with the
 * count of its milestones and its most pressing state (late · a gate waiting · due · done: tone AND pattern AND words), a
 * day opened lists its milestones (order, milestone, state, late) with Open; the milestones without a target date below.
 * Keys: ← / → the month before / after, t today (outside the calendar; inside it, the DS's own keys move by day and week).
 */
export function CalendarSection({ model, actions, words }: { model: MilestonesModel; actions?: MilestonesActions; words: Words }) {
  const { t, locale } = words
  const modeWords = useModeWords()
  const world = model.world.status === 'ready' ? model.world.value : null
  const rows = useMemo(() => visibleRows(rowsOf(world), model.controls), [world, model.controls])
  const today = world?.today ?? new Date().toISOString().slice(0, 10)
  const [month, setMonth] = useState(() => (model.day ?? today).slice(0, 7))
  const [day, setDay] = useState<string | null>(model.day ?? null)
  useEffect(() => {
    if (world && !model.day) setMonth(world.today.slice(0, 7))
    // Only when the read's day first arrives.
  }, [world?.today])

  const byDay = useMemo(() => {
    const map = new Map<string, MilestoneRow[]>()
    for (const row of rows) {
      if (!row.target) continue
      const list = map.get(row.target)
      if (list) list.push(row)
      else map.set(row.target, [row])
    }
    return map
  }, [rows])
  const undated = rows.filter((row) => !row.target)

  const kinds: CalendarKind[] = useMemo(
    () => [
      { id: 'late', label: t('calendar.kind.late'), tone: 'danger', pattern: 'stripe' },
      { id: 'waiting', label: t('calendar.kind.waiting'), tone: 'warning', pattern: 'dots' },
      { id: 'due', label: t('calendar.kind.due'), tone: 'info', pattern: 'outline' },
      { id: 'done', label: t('calendar.kind.done'), tone: 'success', pattern: 'plain' },
      { id: 'none', label: t('calendar.kind.none') },
    ],
    [t],
  )
  const days = useMemo(
    () =>
      Object.fromEntries(
        [...byDay].map(([iso, list]) => [
          iso,
          { kind: dayKindOf(list), reason: t('calendar.count', { count: list.length }), detail: list.slice(0, 3).map((row) => `${row.order.number} ${milestoneName(row, t)}`).join(', ') + (list.length > 3 ? ` ${t('calendar.andMore', { count: list.length - 3 })}` : '') },
        ]),
      ),
    [byDay, t],
  )

  usePageKeys((event) => {
    if (model.dialog || model.controls.open || event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target as HTMLElement | null
    if (target?.closest?.('.fw-tna-cal-grid')) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      setMonth((current) => shiftMonth(current, event.key === 'ArrowLeft' ? -1 : 1))
    } else if (event.key === 't') {
      event.preventDefault()
      setMonth(today.slice(0, 7))
      setDay(today)
    }
  })

  if (model.world.status === 'loading') {
    return (
      <div className="fw-tna-cal">
        <Skeleton height={360} />
        <Skeleton height={120} />
      </div>
    )
  }
  const shown = day ? (byDay.get(day) ?? []) : []
  const item = (row: MilestoneRow) => (
    <li key={row.id} className="fw-tna-agenda-row">
      <span className="fw-tna-cell">
        <span className="fw-tna-strong">
          {row.order.number} · {milestoneName(row, t)}
        </span>
        <span className="fw-tna-sub">
          {row.order.customer.name}
          {row.owner ? ` · ${t('row.owner', { name: row.owner.name })}` : ''}
          {row.actual ? ` · ${t('row.actual', { day: dayText(row.actual, locale) })}` : ''}
        </span>
      </span>
      <span className="fw-tna-inline">
        <Pill tone={stateTone(row)}>{stateWords(row, t)}</Pill>
        {row.late !== null && <span className="fw-tna-sub">{lateWords(row, t)}</span>}
        <Button size="sm" onClick={() => actions?.onOpen?.(row.id)}>
          {t('row.open')}
        </Button>
        <Button size="sm" variant="quiet" aria-label={t('row.orderNewTab', { order: row.order.number })} onClick={() => actions?.onOpenOrder?.(row.order.id, true)}>
          <ExternalLink size={13} aria-hidden />
        </Button>
      </span>
    </li>
  )

  return (
    <div className="fw-tna-cal">
      <div className="fw-tna-cal-grid">
        <CalendarGrid
          label={t('calendar.label')}
          kinds={kinds}
          days={days}
          weekKinds={['none', 'none', 'none', 'none', 'none', 'none', 'none']}
          month={month}
          onMonthChange={setMonth}
          views={['month']}
          today={today}
          onDayOpen={(iso) => setDay(iso)}
          words={{ ...modeWords.calendar, layoutGrid: t('calendar.layoutGrid'), layoutList: t('calendar.layoutList') }}
          locale={INTL_LOCALE[locale]}
        />
      </div>
      <section className="fw-tna-agenda" aria-live="polite" aria-label={t('calendar.dayLabel')}>
        {day ? (
          <>
            <h3 className="fw-tna-h3">{t('calendar.dayTitle', { day: dayText(day, locale), count: shown.length })}</h3>
            {shown.length === 0 ? <p className="fw-tna-hint">{rows.length === 0 ? t('calendar.empty') : t('calendar.dayEmpty')}</p> : <ul className="fw-tna-agenda-list">{shown.map(item)}</ul>}
          </>
        ) : (
          <p className="fw-tna-hint">{[...byDay.keys()].some((iso) => iso.startsWith(month)) ? t('calendar.pick') : t('calendar.emptyMonth')}</p>
        )}
        {undated.length > 0 && (
          <details className="fw-tna-undated">
            <summary>{t('calendar.undated', { count: undated.length })}</summary>
            <ul className="fw-tna-agenda-list">{undated.map(item)}</ul>
          </details>
        )}
      </section>
    </div>
  )
}
