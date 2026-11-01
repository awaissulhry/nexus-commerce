'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { CalendarDays, Columns3, LayoutGrid, Table2 } from 'lucide-react'
import type { ColDef } from '@nexus/ui/grid'
import { BoardView, type BoardViewWords } from '@nexus/ui/grid/views/board/index'
import { CalendarGrid, type CalendarGridWords, type CalendarKind } from '@nexus/ui/components/CalendarGrid/index'
import type { DateFieldLabels } from '@nexus/ui/components'
import { Button, SegmentedControl } from '@nexus/ui/primitives'
import { DateField } from '../../lib/i18n/ds-parts'
import { formatDate } from '../../lib/i18n/format'
import { INTL_LOCALE, type Locale } from '../../lib/i18n/locales'
import { boardCardOf, calendarDaysOf, calendarMonthOf, type ListBoardMode, type ListCalendarMode, type ListMode } from './model'
import type { InlineEdit } from './edit'

/**
 * The list frame's view modes (B-W2b-13; PLT-164; design shell.lists sec:view-modes "Table · Board · Calendar · Cards —
 * the same rows as a board by status, a calendar by a date, or cards on a phone"; the W2a gap Z16:01 "Table and Board
 * switch in the list frame"). The switch is a DS SegmentedControl beside Columns ▾; the mode is a term of the list's
 * address, so a saved view keeps it. Board = the DS BoardView over the list's rows (a card per row from its columns;
 * a drop only where the list says the move needs no review; the keyboard Move to… menu); Calendar = the DS
 * CalendarGrid (how many rows sit on each day) with the chosen day's rows beside it, each moved to another day through
 * the inline edit's save (the same version check) — the DS calendar has no dragging of items yet, so the move is a day
 * picker on the row.
 */

type Translate = (key: string, params?: Record<string, string | number>) => string

const ICONS = { table: Table2, board: Columns3, calendar: CalendarDays, cards: LayoutGrid } as const

export function ModeSwitch({ modes, mode, onMode, t }: { modes: readonly ListMode[]; mode: ListMode; onMode: (mode: ListMode) => void; t: Translate }) {
  if (modes.length < 2) return null
  return (
    <SegmentedControl
      size="sm"
      ariaLabel={t('modes.label')}
      value={mode}
      onChange={(next) => onMode(next as ListMode)}
      options={modes.map((value) => {
        const Icon = ICONS[value]
        return { value, label: t(`modes.${value}`), icon: <Icon size={13} aria-hidden /> }
      })}
    />
  )
}

export interface BoardModeProps<T> {
  label: string
  rows: readonly T[]
  rowId: (row: T) => string
  columns: readonly ColDef<T>[]
  board: ListBoardMode<T>
  hrefOf?: (row: T) => string | null
  onOpen?: (row: T) => void
  words: BoardViewWords
  locale: Locale
}

export function BoardMode<T>({ label, rows, rowId, columns, board, hrefOf, onOpen, words, locale }: BoardModeProps<T>) {
  const byId = useMemo(() => new Map(rows.map((row) => [rowId(row), row])), [rows, rowId])
  const cards = useMemo(
    () =>
      rows.map((row) => {
        const href = hrefOf?.(row) ?? undefined
        return boardCardOf(row, rowId(row), board.laneOf(row), columns, { ...(href ? { href } : {}), ...(board.card?.(row) ?? {}) })
      }),
    [rows, rowId, board, columns, hrefOf],
  )
  return (
    <div className="fw-list-board">
      <BoardView
        label={label}
        lanes={board.lanes}
        cards={cards}
        {...(board.onMove
          ? {
              onMove: async (move: { cardId: string; to: string }) => {
                const row = byId.get(move.cardId)
                return row ? await board.onMove!(row, move.to) : false
              },
            }
          : {})}
        {...(board.moveHeld
          ? {
              moveHeld: (card: { id: string }, laneId: string) => {
                const row = byId.get(card.id)
                return row ? board.moveHeld!(row, laneId) : null
              },
            }
          : {})}
        {...(onOpen
          ? {
              onOpen: (card: { id: string }) => {
                const row = byId.get(card.id)
                if (row) onOpen(row)
              },
            }
          : {})}
        heldReason={board.heldReason ?? null}
        words={words}
        locale={INTL_LOCALE[locale]}
      />
    </div>
  )
}

export interface CalendarModeProps<T> {
  label: string
  rows: readonly T[]
  rowId: (row: T) => string
  /** The row's name in the day's list (the list's first column's text). */
  nameOf: (row: T) => string
  calendar: ListCalendarMode<T>
  /** The site's day (YYYY-MM-DD). */
  today: string
  hrefOf?: (row: T) => string | null
  onOpen?: (row: T) => void
  edit: InlineEdit<T> | null
  words: CalendarGridWords
  dateWords: DateFieldLabels
  locale: Locale
  t: Translate
  /** Design cases: the day open. */
  day?: string | null
}

export function CalendarMode<T>({ label, rows, rowId, nameOf, calendar, today, hrefOf, onOpen, edit, words, dateWords, locale, t, day: openDay }: CalendarModeProps<T>) {
  const { days, undated } = useMemo(() => calendarDaysOf(rows, calendar.dateOf), [rows, calendar])
  const [month, setMonth] = useState(() => calendarMonthOf(days, openDay ?? today))
  const [day, setDay] = useState<string | null>(openDay ?? null)
  const [moving, setMoving] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const kinds: CalendarKind[] = useMemo(() => [{ id: 'rows', label: t('calendarMode.kindRows'), tone: 'info' }, { id: 'none', label: t('calendarMode.kindNone') }], [t])
  const dayMap = useMemo(
    () =>
      Object.fromEntries(
        [...days].map(([iso, list]) => [
          iso,
          { kind: 'rows', reason: t('calendarMode.count', { count: list.length }), detail: list.slice(0, 3).map(nameOf).join(', ') + (list.length > 3 ? ` ${t('calendarMode.andMore', { count: list.length - 3 })}` : '') },
        ]),
      ),
    [days, nameOf, t],
  )
  const shown = day ? (days.get(day) ?? []) : []
  const field = calendar.field
  const canMove = (row: T) => !!edit && !!field && edit.active && edit.editableFor(row, field)
  const move = async (row: T) => {
    const id = rowId(row)
    const target = moving[id]
    if (!edit || !field || !target) return
    setBusy(id)
    const saved = await edit.save(row, field, target)
    setBusy(null)
    if (saved) setMoving(({ [id]: _, ...rest }) => rest)
  }
  const dayText = (iso: string) => formatDate(`${iso}T12:00:00Z`, { locale })

  const item = (row: T) => {
    const id = rowId(row)
    const href = hrefOf?.(row) ?? null
    return (
      <li key={id} className="fw-list-agenda-row">
        <span className="fw-list-agenda-name">
          {href ? <Link href={href}>{nameOf(row)}</Link> : onOpen ? <Button size="sm" variant="link" onClick={() => onOpen(row)}>{nameOf(row)}</Button> : nameOf(row)}
        </span>
        {canMove(row) && (
          <span className="fw-list-agenda-move">
            <DateField
              value={moving[id] ?? calendar.dateOf(row) ?? ''}
              onChange={(value) => setMoving((current) => ({ ...current, [id]: value }))}
              ariaLabel={t('calendarMode.moveLabel', { name: nameOf(row), date: calendar.label })}
              locale={INTL_LOCALE[locale]}
              labels={dateWords}
            />
            <Button size="sm" onClick={() => void move(row)} heldReason={busy === id ? t('calendarMode.moving') : !moving[id] || moving[id] === calendar.dateOf(row) ? t('calendarMode.pickDay') : null}>
              {t('calendarMode.move')}
            </Button>
          </span>
        )}
      </li>
    )
  }

  return (
    <div className="fw-list-calendar">
      <CalendarGrid
        label={t('calendarMode.label', { list: label, date: calendar.label })}
        kinds={kinds}
        days={dayMap}
        weekKinds={['none', 'none', 'none', 'none', 'none', 'none', 'none']}
        month={month}
        onMonthChange={setMonth}
        views={['month']}
        today={today}
        onDayOpen={(iso) => setDay(iso)}
        words={words}
        locale={INTL_LOCALE[locale]}
      />
      <section className="fw-list-agenda" aria-live="polite" aria-label={t('calendarMode.dayLabel')}>
        {day ? (
          <>
            <h3 className="fw-list-agenda-title">{t('calendarMode.dayTitle', { day: dayText(day), count: shown.length })}</h3>
            {shown.length === 0 ? <p className="fw-list-agenda-note">{t('calendarMode.dayEmpty')}</p> : <ul className="fw-list-agenda-list">{shown.map(item)}</ul>}
          </>
        ) : (
          <p className="fw-list-agenda-note">{t('calendarMode.pick')}</p>
        )}
        {!field || !edit?.active ? <p className="fw-list-agenda-note">{t('calendarMode.readOnly', { date: calendar.label })}</p> : null}
        {undated.length > 0 && (
          <details className="fw-list-agenda-undated">
            <summary>{t('calendarMode.undated', { count: undated.length, date: calendar.label })}</summary>
            <ul className="fw-list-agenda-list">{undated.map(item)}</ul>
          </details>
        )}
      </section>
    </div>
  )
}
