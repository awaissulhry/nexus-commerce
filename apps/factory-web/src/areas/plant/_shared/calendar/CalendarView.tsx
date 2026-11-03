'use client'

import { useMemo, type ReactNode } from 'react'
import Link from 'next/link'
import { CALENDAR_GRID_WORDS, CalendarGrid, type CalendarGridWords, type CalendarKind } from '@nexus/ui/components/CalendarGrid/index'
import { DueCell } from '@nexus/ui/components/DueCell/index'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { DAY_KINDS, dayKinds, defaultDay, itemsByDay, monthCounts, type CalendarState, type CalendarViewItem, type DayKind } from './model'
import './calendar-view.css'

/**
 * CalendarView — the Plant area part on the DS CalendarGrid (B-W2b-120; B-W2b-142's machine check plans read it): a month
 * of deadlines, each day drawn as the worst state of its items (overdue danger, due soon warning, to confirm / planned
 * info, done success; a pattern as well as a colour, and a legend with the counts), and beside it (below it on a narrow
 * screen) the chosen day's agenda: each item with its due state in words, Enter or a click opens it (its link, or the
 * host's `onOpen`). View-only: it fetches nothing and keeps no data; the month and the day are the host's (its address).
 * `[` / `]` are the host's keys (`monthStep` + `moveMonth` in ./model). Its words: `plant-calendar-view` (the host adds
 * CALENDAR_VIEW_NAMESPACES to its own messages when it draws `DueState` elsewhere) and the DS calendar's `calendar-kit`.
 */

export const CALENDAR_VIEW_NAMESPACES = ['plant-calendar-view', 'calendar-kit'] as const

export interface CalendarViewProps {
  /** The calendar's name for assistive technology ("Safety calendar · Officina Demo"). */
  label: string
  /** The items (already in words); null while the first read runs. */
  items: readonly CalendarViewItem[] | null
  /** The month shown (`YYYY-MM`). */
  month: string
  onMonth: (month: string) => void
  /** The site's day (`YYYY-MM-DD`). */
  today: string
  /** The day whose agenda is open; null: today when in the month, else the month's first day with an item. */
  selectedDay: string | null
  onDay: (day: string) => void
  /** Enter or a click on an item without a link. */
  onOpen?: (item: CalendarViewItem) => void
  /** An item's own address (a real link: ⌘-click opens a new tab); null: `onOpen`. */
  hrefOf?: (item: CalendarViewItem) => string | null
  /** A read is running: the days already known are drawn, the agenda says so. */
  loading?: boolean
  /** Under the agenda: the host's note (a source that could not be read). */
  note?: ReactNode
  className?: string
}

export function CalendarView(props: CalendarViewProps) {
  return (
    <WithMessages namespaces={CALENDAR_VIEW_NAMESPACES}>
      <Calendar {...props} />
    </WithMessages>
  )
}

const KIND_TONE: Readonly<Record<DayKind, CalendarKind['tone']>> = { overdue: 'danger', dueSoon: 'warning', planned: 'info', done: 'success', cancelled: 'neutral' }
const KIND_PATTERN: Readonly<Record<DayKind, NonNullable<CalendarKind['pattern']>>> = { overdue: 'stripe', dueSoon: 'dots', planned: 'outline', done: 'plain', cancelled: 'cross' }
const GRID_KEYS = Object.keys(CALENDAR_GRID_WORDS) as (keyof CalendarGridWords)[]

/** The DS calendar's words in the page's language (`calendar-kit`), with this part's own list words over them. */
function useGridWords(): CalendarGridWords {
  const kit = useT('calendar-kit')
  const t = useT('plant-calendar-view')
  return useMemo(() => ({ ...(Object.fromEntries(GRID_KEYS.map((key) => [key, kit(`calendar.${key}`)])) as unknown as CalendarGridWords), list: t('grid.list'), listEmpty: t('grid.listEmpty') }), [kit, t])
}

function Calendar({ label, items, month, onMonth, today, selectedDay, onDay, onOpen, hrefOf, loading = false, note, className }: CalendarViewProps) {
  const t = useT('plant-calendar-view')
  const locale = useLocale()
  const words = useGridWords()
  const byDay = useMemo(() => itemsByDay(items ?? []), [items])
  const kinds: CalendarKind[] = useMemo(() => [...DAY_KINDS.map((kind) => ({ id: kind, label: t(`kind.${kind}`), tone: KIND_TONE[kind], pattern: KIND_PATTERN[kind] })), { id: 'none', label: t('kind.none') }], [t])
  const days = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(dayKinds(byDay)).map(([day, entry]) => {
          const list = byDay.get(day) ?? []
          const shown = list.slice(0, 2).map((item) => item.title)
          const detail = list.length > 2 ? `${shown.join(' · ')} ${t('day.andMore', { count: list.length - 2 })}` : shown.join(' · ')
          return [day, { kind: entry.kind, reason: t('day.count', { count: entry.count }), detail }]
        }),
      ),
    [byDay, t],
  )
  const day = selectedDay ?? defaultDay(month, today, byDay)
  const agenda = day ? (byDay.get(day) ?? []) : []
  const counts = monthCounts(items ?? [], month)
  const dayText = (iso: string) => formatDate(`${iso}T12:00:00Z`, { locale })

  return (
    <div className={['fw-cv', className ?? ''].filter(Boolean).join(' ')}>
      <div className="fw-cv-grid">
        <CalendarGrid
          label={label}
          kinds={kinds}
          days={days}
          weekKinds={['none', 'none', 'none', 'none', 'none', 'none', 'none']}
          views={['month']}
          month={month}
          onMonthChange={onMonth}
          today={today}
          onDayOpen={(iso) => onDay(iso)}
          loading={loading && items === null}
          words={words}
          locale={INTL_LOCALE[locale]}
        />
      </div>
      <section className="fw-cv-agenda" aria-live="polite" aria-label={t('agenda.label')}>
        {items !== null && (
          <p className="fw-cv-note">
            {t('month.summary', { overdue: counts.OVERDUE, dueSoon: counts.DUE_SOON, planned: counts.PLANNED + counts.TO_CONFIRM, done: counts.DONE })}
          </p>
        )}
        {items === null ? (
          <div className="fw-cv-list" aria-busy="true">
            <p className="fw-cv-note">{t('agenda.loading')}</p>
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} height={32} />
            ))}
          </div>
        ) : day ? (
          <>
            <h3 className="fw-cv-title">{t('agenda.title', { day: dayText(day) })}</h3>
            {agenda.length === 0 ? (
              <p className="fw-cv-note">{t('agenda.empty', { day: dayText(day) })}</p>
            ) : (
              <ul className="fw-cv-list">
                {agenda.map((item) => {
                  const href = hrefOf?.(item) ?? null
                  return (
                    <li key={item.key} className="fw-cv-item" data-state={item.state}>
                      <DueState state={item.state} date={item.date} today={today} />
                      <span className="fw-cv-what">
                        {href ? (
                          <Link href={href} className="fw-cv-open">
                            {item.title}
                          </Link>
                        ) : onOpen ? (
                          <Button size="sm" variant="link" wrap aria-label={t('agenda.openItem', { title: item.title })} onClick={() => onOpen(item)}>
                            {item.title}
                          </Button>
                        ) : (
                          item.title
                        )}
                        {(item.meta || item.site) && <span className="fw-cv-meta">{[item.meta, item.site].filter(Boolean).join(' · ')}</span>}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        ) : (
          <p className="fw-cv-note">{t('agenda.pick')}</p>
        )}
        {loading && items !== null && <p className="fw-cv-note">{t('agenda.reading')}</p>}
        {note}
      </section>
    </div>
  )
}

/**
 * An item's due state as a tone AND words (the DS DueCell for a dated state: overdue by N days, due in N days, due on a
 * day, done; a pill for a day to confirm — never late — and a cancelled item). Its words: `say`, the host's translator of
 * `plant-calendar-view` (a grid cell draws inside the list frame's own messages), else the messages around it.
 */
export function DueState({ state, date, today, say }: { state: CalendarState; date: string; today: string; say?: Translate }) {
  const own = useT('plant-calendar-view')
  const t = say ?? own
  const ds = useDsWords()
  const locale = useLocale()
  const formatDay = (iso: string) => formatDate(`${iso.slice(0, 10)}T12:00:00Z`, { locale })
  if (state === 'TO_CONFIRM') {
    return (
      <span className="fw-cv-due">
        <Pill tone="info">{t('state.TO_CONFIRM')}</Pill>
        <span className="fw-cv-meta">{t('state.firstDay', { date: formatDay(date) })}</span>
      </span>
    )
  }
  if (state === 'CANCELLED') {
    return (
      <span className="fw-cv-due">
        <Pill tone="neutral">{t('state.CANCELLED')}</Pill>
      </span>
    )
  }
  return (
    <span className="fw-cv-due">
      <DueCell value={state === 'DONE' ? { due: date, state: 'done' } : { due: date }} today={today} formatDate={formatDay} labels={{ ...ds.dueCell, validUntil: (day) => t('state.dueOn', { date: day }) }} />
    </span>
  )
}
