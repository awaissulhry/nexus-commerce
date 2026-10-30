'use client'

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import { ChevronLeft, ChevronRight, Lock } from 'lucide-react'
import { Button } from '../../primitives/Button'
import { SegmentedControl } from '../../primitives/SegmentedControl'
import { Skeleton } from '../../primitives/Skeleton'
import {
  CALENDAR_GRID_WORDS,
  addMonths,
  addMonthsToDay,
  calendarKeyStep,
  capitalise,
  dateOf,
  dayInfo,
  dayName,
  exceptionsIn,
  fill,
  focusIn,
  inPeriod,
  inRange,
  isCalendarNavKey,
  isIsoDay,
  isIsoMonth,
  kindCounts,
  legendCount,
  localToday,
  monthOf,
  monthWeeks,
  patternOf,
  periodMonths,
  rangeOf,
  rangeSentence,
  shownAfter,
  weekdayOrder,
  type CalendarDay,
  type CalendarGridWords,
  type CalendarKind,
  type CalendarLayout,
  type CalendarRange,
  type CalendarView,
  type DayInfo,
  type DayInput,
  type Weekday,
} from './calendarGridModel'
import './calendar-grid.css'

export interface CalendarGridProps {
  /** The calendar's name (a region): "Calendar · Site A · Line 2". */
  label: string
  /** The key: every kind of day the app draws, with its words, tone and pattern. */
  kinds: readonly CalendarKind[]
  /** What the app knows per day (`YYYY-MM-DD` → kind, reason, detail): holidays, closures, exceptions. */
  days?: Readonly<Record<string, CalendarDay>>
  /** The weekly base pattern, Monday first (seven kind ids; null = not set). A day with no entry takes it. */
  weekKinds?: readonly (string | null)[]
  /** `month` (one month, weeks as rows) or `year` (twelve small months). Controlled with `onViewChange`. */
  view?: CalendarView
  defaultView?: CalendarView
  onViewChange?: (view: CalendarView) => void
  /** The views the switch offers (default both; one view = no switch). */
  views?: readonly CalendarView[]
  /** The month shown (`YYYY-MM`; in the year view, its year). Controlled with `onMonthChange`. */
  month?: string
  defaultMonth?: string
  onMonthChange?: (month: string) => void
  /** Today (`YYYY-MM-DD`) in the site's own calendar; default the browser's. */
  today?: string | null
  /** The first column: 1 = Monday (default), 0 = Sunday. */
  weekStartsOn?: Weekday
  /** A day was opened (click, Enter, the list's Open): the app shows its popover with the anchor, or a dialog. */
  onDayOpen?: (date: string, anchor: HTMLElement | null) => void
  /**
   * Days were selected (a drag across days, or Shift with the arrow keys then Enter): the app asks what they are (a
   * closure from … to …). Without it no range can be selected.
   */
  onRangeSelect?: (range: CalendarRange) => void
  /** The range drawn once used (controlled); the app clears it with null. */
  range?: CalendarRange | null
  /** The person let the selection go (Escape, a plain move or click): a controlled `range` should become null. */
  onRangeClear?: () => void
  /** A range drawn at the start (a design case). */
  defaultRange?: CalendarRange | null
  /** Why days cannot be selected now (no permission, offline): said at rest and on every attempt. Opening still works. */
  heldReason?: string | null
  /** The days are being read: the days already given are drawn, the others are skeletons. */
  loading?: boolean
  /** `grid` (default) or `list` (the days that differ from the weekly pattern). Controlled with `onLayoutChange`. */
  layout?: CalendarLayout
  defaultLayout?: CalendarLayout
  onLayoutChange?: (layout: CalendarLayout) => void
  /** Below this width (px, the calendar's own) it is always the list. Default 560. */
  listBelow?: number
  /** Draw the key under the calendar (default true). */
  legend?: boolean
  words?: Partial<CalendarGridWords>
  /** The page's language for dates (default `en-GB`). */
  locale?: string
  className?: string
}

/** The calendar's own width (null until measured): the list fallback reads it, not the window's. */
function useOwnWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    setWidth(element.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return width
}

interface Selection {
  range: CalendarRange
  /** Given to the app (`onRangeSelect`); a selection still being made is not. */
  used: boolean
}

interface Drag {
  anchor: string
  current: string
  moved: boolean
}

const dateAt = (target: EventTarget | null): string | null => {
  const element = target as HTMLElement | null
  if (!element || typeof element.closest !== 'function') return null
  const date = element.closest<HTMLElement>('[data-cal-date]')?.dataset.calDate
  return date && isIsoDay(date) ? date : null
}

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ')

/**
 * CalendarGrid — a month or a year of days with their state (factory part "CalendarGrid"): working days, weekends,
 * public holidays, closures and dated exceptions (an extra shift, a short day, a line closed), each drawn with its
 * tone AND a pattern (a day off hatched) and named in words; today marked in words; a key with the count of each kind.
 *
 * - Click or Enter on a day: `onDayOpen(date, anchor)` (the app's exception popover).
 * - A range: drag across days (mouse or pen), or Shift with the arrow keys and Enter: `onRangeSelect({ from, to })`.
 * - Keyboard: one Tab stop (the focus day); arrows by day and week, Home / End to the week's ends, Page Up / Down by
 *   month (into the next month or year by itself); Escape clears a selection. Every step is said in one live region.
 * - Read-only (`heldReason`): drawn the same, opening still works, a selection is refused with the reason.
 * - The list twin (`layout="list"`, and always below `listBelow` px of its own width): the days that differ from the
 *   weekly pattern, grouped by month, each with Open.
 *
 * Data in, events out: it calls nothing. Every word comes in through `words` (English by default); month and weekday
 * names come from `Intl` in `locale`. Its own entry point (not the components barrel):
 * `@nexus/ui/components/CalendarGrid/index`.
 */
export function CalendarGrid(props: CalendarGridProps) {
  const {
    label,
    kinds,
    days,
    weekKinds,
    views = ['month', 'year'],
    weekStartsOn = 1,
    onDayOpen,
    onRangeSelect,
    heldReason,
    loading = false,
    listBelow = 560,
    legend = true,
    locale = 'en-GB',
    className,
  } = props
  const words = useMemo<CalendarGridWords>(() => ({ ...CALENDAR_GRID_WORDS, ...props.words }), [props.words])
  const [ownToday] = useState(() => localToday())
  const today = props.today && isIsoDay(props.today) ? props.today : props.today === null ? null : ownToday

  const [viewState, setViewState] = useState<CalendarView>(props.defaultView ?? views[0] ?? 'month')
  const asked = props.view ?? viewState
  const view: CalendarView = views.includes(asked) ? asked : (views[0] ?? 'month')
  const [monthState, setMonthState] = useState<string>(() =>
    isIsoMonth(props.defaultMonth) ? props.defaultMonth : monthOf(props.defaultRange?.from && isIsoDay(props.defaultRange.from) ? props.defaultRange.from : (today ?? ownToday)),
  )
  const shown = isIsoMonth(props.month) ? props.month : monthState
  const [layoutState, setLayoutState] = useState<CalendarLayout>(props.defaultLayout ?? 'grid')
  const rootRef = useRef<HTMLElement>(null)
  const width = useOwnWidth(rootRef)
  const narrow = width !== null && width < listBelow
  const layout: CalendarLayout = narrow ? 'list' : (props.layout ?? layoutState)

  const [focusState, setFocusState] = useState<string | null>(props.defaultRange?.to ?? null)
  const focus = focusIn(view, shown, focusState, today)
  const [anchor, setAnchor] = useState<string | null>(null)
  const [selection, setSelection] = useState<Selection | null>(props.defaultRange ? { range: rangeOf(props.defaultRange.from, props.defaultRange.to), used: true } : null)
  const drawn: CalendarRange | null = selection && (!selection.used || props.range === undefined) ? selection.range : (props.range ?? null)
  const [said, setSaid] = useState({ n: 0, text: '' })
  const say = useCallback((text: string) => setSaid((last) => ({ n: last.n + 1, text })), [])
  const focusPending = useRef(false)
  const drag = useRef<Drag | null>(null)
  const swallowClick = useRef(false)

  const ids = useId()
  const titleId = `${ids}-title`
  const helpId = `${ids}-help`
  const heldId = `${ids}-held`

  const input = useMemo<DayInput>(() => ({ kinds, days, weekKinds }), [kinds, days, weekKinds])
  const longDate = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }), [locale])
  const rangeDate = useMemo(() => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }), [locale])
  const monthTitle = useMemo(() => new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }), [locale])
  const monthName = useMemo(() => new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }), [locale])
  const yearName = useMemo(() => new Intl.DateTimeFormat(locale, { year: 'numeric', timeZone: 'UTC' }), [locale])
  const weekdayShort = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }), [locale])
  const weekdayNarrow = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: 'narrow', timeZone: 'UTC' }), [locale])
  const weekdayLong = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }), [locale])
  // 7 Jan 2024 was a Sunday: weekday w is 7 + w January 2024.
  const weekdays = useMemo(
    () =>
      weekdayOrder(weekStartsOn).map((w) => {
        const sample = new Date(Date.UTC(2024, 0, 7 + w))
        return { w, short: weekdayShort.format(sample), narrow: weekdayNarrow.format(sample), long: weekdayLong.format(sample) }
      }),
    [weekStartsOn, weekdayShort, weekdayNarrow, weekdayLong],
  )
  const formatLong = useCallback((iso: string) => capitalise(longDate.format(dateOf(iso)), locale), [longDate, locale])
  const formatRange = useCallback((iso: string) => rangeDate.format(dateOf(iso)), [rangeDate])
  const titleOfMonth = useCallback((month: string) => capitalise(monthTitle.format(dateOf(`${month}-01`)), locale), [monthTitle, locale])
  const period = view === 'year' ? yearName.format(dateOf(`${shown}-01`)) : titleOfMonth(shown)
  // Inside a sentence the month keeps the language's own case ("ogni giorno di settembre 2026").
  const periodInText = view === 'year' ? period : monthTitle.format(dateOf(`${shown}-01`))

  const changeMonth = useCallback(
    (month: string, sayIt: boolean) => {
      if (props.month === undefined) setMonthState(month)
      props.onMonthChange?.(month)
      if (sayIt) say(fill(words.shown, { period: view === 'year' ? yearName.format(dateOf(`${month}-01`)) : titleOfMonth(month) }))
    },
    [props.month, props.onMonthChange, say, words.shown, view, yearName, titleOfMonth],
  )

  const changeView = (next: CalendarView) => {
    if (props.view === undefined) setViewState(next)
    props.onViewChange?.(next)
  }
  const changeLayout = (next: CalendarLayout) => {
    if (props.layout === undefined) setLayoutState(next)
    props.onLayoutChange?.(next)
  }

  // After a keyboard move the focus follows the day (also into another month).
  useEffect(() => {
    if (!focusPending.current) return
    focusPending.current = false
    rootRef.current?.querySelector<HTMLElement>(`[data-cal-date="${focus}"]`)?.focus()
  }, [focus, shown, view])

  const canSelect = Boolean(onRangeSelect)
  const step = view === 'year' ? 12 : 1
  const goBy = (months: number) => {
    const next = addMonths(shown, months)
    setFocusState(addMonthsToDay(focus, months))
    changeMonth(next, true)
  }
  const goToday = () => {
    if (!today) return
    setFocusState(today)
    if (!inPeriod(view, shown, today)) changeMonth(monthOf(today), true)
    else say(fill(words.shown, { period }))
  }

  const takeRange = (range: CalendarRange) => {
    setSelection({ range, used: true })
    setAnchor(null)
    say(rangeSentence(words, range, formatRange, true))
    onRangeSelect?.(range)
  }

  const clearSelection = (sayIt: boolean) => {
    if (!selection && !anchor && !props.range) return false
    setSelection(null)
    setAnchor(null)
    if (selection?.used || props.range) props.onRangeClear?.()
    if (sayIt) say(words.cleared)
    return true
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const from = dateAt(event.target)
    if (!from) return
    if (event.key === 'Escape') {
      if (clearSelection(true)) {
        event.preventDefault()
        event.stopPropagation()
      }
      return
    }
    if (!isCalendarNavKey(event.key) || event.altKey || event.ctrlKey || event.metaKey) return
    event.preventDefault()
    const dir = typeof getComputedStyle === 'function' && getComputedStyle(event.currentTarget).direction === 'rtl' ? 'rtl' : 'ltr'
    const shift = event.shiftKey && canSelect
    const result = calendarKeyStep({ focus: from, anchor }, event.key, shift, { weekStartsOn, dir, held: Boolean(heldReason) })
    setFocusState(result.state.focus)
    setAnchor(result.state.anchor)
    focusPending.current = true
    if (result.held && heldReason) say(heldReason)
    else if (result.range) {
      setSelection({ range: result.range, used: false })
      say(rangeSentence(words, result.range, formatRange, false))
    } else clearSelection(false)
    const next = shownAfter(view, shown, result.state.focus)
    if (next !== shown) changeMonth(next, true)
  }

  const onDayClick = (event: ReactMouseEvent<HTMLButtonElement>, iso: string) => {
    if (swallowClick.current) {
      swallowClick.current = false
      return
    }
    setFocusState(iso)
    const byKeyboard = event.detail === 0
    if (byKeyboard && selection && !selection.used) {
      takeRange(selection.range)
      return
    }
    if (!byKeyboard) clearSelection(false)
    onDayOpen?.(iso, event.currentTarget)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!canSelect || event.button !== 0 || event.pointerType === 'touch') return
    const iso = dateAt(event.target)
    if (!iso) return
    drag.current = { anchor: iso, current: iso, moved: false }
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current
    if (!current) return
    const over = typeof document !== 'undefined' ? document.elementFromPoint(event.clientX, event.clientY) : null
    const iso = dateAt(over)
    if (!iso || iso === current.current) return
    current.current = iso
    if (!current.moved) {
      current.moved = true
      // From here the drag owns the pointer, so a release outside the calendar still ends it (a plain click is untouched).
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // an old browser: the drag ends at the next release inside
      }
      if (heldReason) say(heldReason)
    }
    if (heldReason) return
    // Drawn as it grows; said once, when the drag ends (a word per day crossed would flood the live region).
    setSelection({ range: rangeOf(current.anchor, iso), used: false })
  }
  const onPointerUp = () => {
    const current = drag.current
    drag.current = null
    if (!current?.moved) return
    // The click that may follow the drag is not an "open".
    swallowClick.current = true
    setTimeout(() => {
      swallowClick.current = false
    }, 0)
    setFocusState(current.current)
    if (heldReason) return
    takeRange(rangeOf(current.anchor, current.current))
  }
  const onPointerCancel = () => {
    const moved = drag.current?.moved
    drag.current = null
    if (moved && selection && !selection.used) setSelection(null)
  }

  const describedBy = cx(helpId, heldReason ? heldId : null) || undefined

  const dayCell = (iso: string | null, key: string, size: 'month' | 'mini') => {
    if (!iso) return <td key={key} className={size === 'mini' ? 'nds-cal-mcell is-out' : 'nds-cal-cell is-out'} />
    const own = days?.[iso]
    const info: DayInfo = loading && !own ? { date: iso, kind: null, reason: null, detail: null, exception: false } : dayInfo(iso, input)
    const isToday = iso === today
    const selected = inRange(iso, drawn)
    const name = dayName(words, { info, date: formatLong(iso), today: isToday, selected })
    const skeleton = loading && !own
    return (
      <td key={key} role="gridcell" className={size === 'mini' ? 'nds-cal-mcell' : 'nds-cal-cell'} aria-selected={canSelect ? selected : undefined}>
        <button
          type="button"
          className={cx(size === 'mini' ? 'nds-cal-mday' : 'nds-cal-day', isToday && 'is-today', selected && 'is-selected', info.exception && 'is-exception', info.kind?.off && 'is-off')}
          data-cal-date={iso}
          data-tone={info.kind?.tone}
          data-pattern={patternOf(info.kind)}
          tabIndex={iso === focus ? 0 : -1}
          aria-label={name}
          aria-current={isToday ? 'date' : undefined}
          onClick={(event) => onDayClick(event, iso)}
        >
          <span className="nds-cal-day-in">
            <span className="nds-cal-num">{Number(iso.slice(8, 10))}</span>
            {size === 'month' && isToday ? <span className="nds-cal-today">{words.todayMark}</span> : null}
            {size === 'month' && skeleton ? <Skeleton height={8} width="70%" /> : null}
            {size === 'month' && info.exception && info.kind ? <span className="nds-cal-kind">{info.kind.label}</span> : null}
            {size === 'month' && info.reason ? <span className="nds-cal-reason">{info.reason}</span> : null}
            {size === 'month' && info.detail ? <span className="nds-cal-detail">{info.detail}</span> : null}
          </span>
        </button>
      </td>
    )
  }

  const monthTable = (month: string, size: 'month' | 'mini') => {
    const headId = `${ids}-m-${month}`
    return (
      <table
        role="grid"
        className={size === 'mini' ? 'nds-cal-mini-grid' : 'nds-cal-grid'}
        aria-labelledby={size === 'mini' ? headId : titleId}
        aria-describedby={describedBy}
        aria-multiselectable={canSelect ? true : undefined}
        aria-busy={loading || undefined}
      >
        <thead>
          <tr>
            {weekdays.map((day) => (
              <th key={day.w} scope="col" abbr={day.long} className="nds-cal-weekday">
                {size === 'mini' ? day.narrow : day.short}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {monthWeeks(month, weekStartsOn).map((week, row) => (
            <tr key={row}>{week.map((iso, col) => dayCell(iso, `${row}-${col}`, size))}</tr>
          ))}
        </tbody>
      </table>
    )
  }

  const yearView = () => (
    <div className="nds-cal-year">
      {periodMonths('year', shown).map((month) => {
        const headId = `${ids}-m-${month}`
        const name = capitalise(monthName.format(dateOf(`${month}-01`)), locale)
        return (
          <div key={month} className="nds-cal-mini">
            <div className="nds-cal-mini-head" id={headId}>
              {views.includes('month') ? (
                <Button
                  size="sm"
                  variant="quiet"
                  aria-label={fill(words.openMonth, { month: monthTitle.format(dateOf(`${month}-01`)) })}
                  onClick={() => {
                    changeMonth(month, false)
                    changeView('month')
                  }}
                >
                  {name}
                </Button>
              ) : (
                <span className="nds-cal-mini-name">{name}</span>
              )}
            </div>
            {monthTable(month, 'mini')}
          </div>
        )
      })}
    </div>
  )

  const listView = () => {
    const found = exceptionsIn(view, shown, input)
    const groups = periodMonths(view, shown)
      .map((month) => ({ month, items: found.filter((info) => monthOf(info.date) === month) }))
      .filter((group) => group.items.length > 0)
    return (
      <div className="nds-cal-list" aria-busy={loading || undefined}>
        <p className="nds-cal-list-title">{words.list}</p>
        {found.length === 0 ? (
          <p className="nds-cal-list-empty">{fill(loading ? words.listLoading : words.listEmpty, { period: periodInText })}</p>
        ) : (
          groups.map((group) => (
            <section key={group.month} className="nds-cal-list-month" aria-label={titleOfMonth(group.month)}>
              <p className="nds-cal-list-month-name" aria-hidden="true">
                {titleOfMonth(group.month)}
              </p>
              <ul className="nds-cal-list-days">
                {group.items.map((info) => {
                  const date = formatLong(info.date)
                  const isToday = info.date === today
                  return (
                    <li key={info.date} className={cx('nds-cal-list-day', isToday && 'is-today')} data-tone={info.kind?.tone} data-pattern={patternOf(info.kind)}>
                      <span className="nds-cal-swatch" aria-hidden="true" />
                      <span className="nds-cal-list-text">
                        <span className="nds-cal-list-date">
                          {date}
                          {isToday ? <span className="nds-cal-today">{words.todayMark}</span> : null}
                        </span>
                        <span className="nds-cal-list-kind">
                          {info.kind && info.reason ? fill(words.kindReason, { kind: info.kind.label, reason: info.reason }) : (info.kind?.label ?? info.reason ?? '')}
                        </span>
                        {info.detail ? <span className="nds-cal-list-detail">{info.detail}</span> : null}
                      </span>
                      {onDayOpen ? (
                        <Button size="sm" aria-label={fill(words.openDay, { date })} onClick={(event) => onDayOpen(info.date, event.currentTarget)}>
                          {words.open}
                        </Button>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    )
  }

  const counts = useMemo(() => (loading ? null : kindCounts(view, shown, input)), [loading, view, shown, input])

  return (
    <section
      ref={rootRef}
      className={cx('nds-cal', className)}
      aria-label={label}
      data-view={view}
      data-layout={layout}
      onKeyDown={layout === 'grid' ? onKeyDown : undefined}
      onPointerDown={layout === 'grid' ? onPointerDown : undefined}
      onPointerMove={layout === 'grid' ? onPointerMove : undefined}
      onPointerUp={layout === 'grid' ? onPointerUp : undefined}
      onPointerCancel={layout === 'grid' ? onPointerCancel : undefined}
    >
      <div className="nds-cal-bar">
        <span className="nds-cal-title" id={titleId}>
          {period}
        </span>
        <span className="nds-cal-nav">
          <Button size="sm" variant="quiet" aria-label={view === 'year' ? words.previousYear : words.previousMonth} onClick={() => goBy(-step)}>
            <ChevronLeft size={16} aria-hidden="true" />
          </Button>
          {today ? (
            <Button size="sm" onClick={goToday}>
              {words.today}
            </Button>
          ) : null}
          <Button size="sm" variant="quiet" aria-label={view === 'year' ? words.nextYear : words.nextMonth} onClick={() => goBy(step)}>
            <ChevronRight size={16} aria-hidden="true" />
          </Button>
        </span>
        <span className="nds-cal-switches">
          {views.length > 1 ? (
            <SegmentedControl
              size="sm"
              ariaLabel={words.viewLabel}
              value={view}
              onChange={(value) => changeView(value as CalendarView)}
              options={views.map((value) => ({ value, label: value === 'year' ? words.viewYear : words.viewMonth }))}
            />
          ) : null}
          {narrow ? null : (
            <SegmentedControl
              size="sm"
              ariaLabel={words.layoutLabel}
              value={layout}
              onChange={(value) => changeLayout(value as CalendarLayout)}
              options={[
                { value: 'grid', label: words.layoutGrid },
                { value: 'list', label: words.layoutList },
              ]}
            />
          )}
        </span>
      </div>
      {heldReason ? (
        <p className="nds-cal-held" id={heldId}>
          <Lock size={14} aria-hidden="true" />
          {heldReason}
        </p>
      ) : null}
      <p className="nds-cal-status" role="status" aria-live="polite">
        <span key={said.n}>{said.text}</span>
      </p>
      {loading ? <span className="nds-cal-sr">{words.loading}</span> : null}
      {layout === 'list' ? listView() : view === 'year' ? yearView() : <div className="nds-cal-month">{monthTable(shown, 'month')}</div>}
      <p id={helpId} className="nds-cal-sr">
        {words.instructions}
      </p>
      {legend ? (
        <div className="nds-cal-legend" role="group" aria-label={words.legend}>
          <span className="nds-cal-legend-title" aria-hidden="true">
            {words.legend}
          </span>
          <ul className="nds-cal-legend-list">
            {kinds.map((kind) => (
              <li key={kind.id} className="nds-cal-legend-item" data-tone={kind.tone} data-pattern={patternOf(kind)}>
                <span className="nds-cal-swatch" aria-hidden="true" />
                <span>{counts ? legendCount(words, kind.label, counts.get(kind.id) ?? 0) : kind.label}</span>
              </li>
            ))}
            {today ? (
              <li className="nds-cal-legend-item is-today">
                <span className="nds-cal-swatch" aria-hidden="true" />
                <span>{words.legendToday}</span>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
