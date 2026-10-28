'use client'

import { useRef, useState } from 'react'
import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { useClickAway } from './useClickAway'

export interface DateRange {
  start: Date
  end: Date
}

export interface DateRangePickerProps {
  value: DateRange
  onChange: (range: DateRange) => void
  className?: string
  /**
   * Override the preset rail. Omit it and you get `DEFAULT_PRESETS` — the eight the operator
   * picked as the platform default, matching the ads console's picker.
   *
   * A prop rather than a hardcoded list because the default DROPPED the three day-count presets
   * (`Last 7 / 30 / 90 days`) that shipped before it, and a surface that genuinely reasons in
   * rolling days should be able to say so instead of being told the platform no longer counts
   * that way.
   */
  presets?: ReadonlyArray<{ label: string; get: () => DateRange }>
}

function sod(d: Date) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}
function addDays(d: Date, n: number) {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}
/**
 * Month arithmetic that CLAMPS to the target month's length.
 *
 * `setMonth` alone overflows: from 2026-03-31, `setMonth(month - 1)` asks for February 31st and
 * JavaScript hands back March 3rd — a "last month" range that starts AFTER it ends. It never
 * surfaced while the only caller was the month navigation, which always works from the 1st, where
 * no month is too short. `Last 3 Months` / `Last 12 Months` call it with TODAY, so it surfaces on
 * the 29th, 30th and 31st.
 */
function addMonths(d: Date, n: number) {
  const x = new Date(d)
  const day = x.getDate()
  x.setDate(1) // never sit on a day the target month may not have while the month changes
  x.setMonth(x.getMonth() + n)
  x.setDate(Math.min(day, new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate()))
  return x
}
function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}
function fmt(d: Date) {
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}
function monthLabel(d: Date) {
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
}
function monthGrid(month: Date): Array<Date | null> {
  const lead = new Date(month.getFullYear(), month.getMonth(), 1).getDay()
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const cells: Array<Date | null> = []
  for (let i = 0; i < lead; i++) cells.push(null)
  for (let d = 1; d <= days; d++) cells.push(new Date(month.getFullYear(), month.getMonth(), d))
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}

/** Sunday-start, because the calendar beside it renders S M T W T F S. A week preset that
 *  disagreed with the grid it sits next to would be the picker contradicting itself. */
function startOfWeek(d: Date) {
  const x = sod(d)
  x.setDate(x.getDate() - x.getDay())
  return x
}

/**
 * The platform default, chosen by the operator 2026-08-25 from the ads console's picker: eight
 * presets, calendar-relative rather than rolling-day.
 *
 * This REPLACES the previous seven. `Last 7 / 30 / 90 days` are gone from the default — a rolling
 * window and a calendar period answer different questions, and mixing both in one rail made the
 * list read as two half-finished ideas. Anything that needs them passes `presets`.
 */
export const DEFAULT_PRESETS: ReadonlyArray<{ label: string; get: () => DateRange }> = [
  { label: 'Today', get: () => { const t = sod(new Date()); return { start: t, end: t } } },
  { label: 'Yesterday', get: () => { const y = sod(addDays(new Date(), -1)); return { start: y, end: y } } },
  { label: 'This Week', get: () => ({ start: startOfWeek(new Date()), end: sod(new Date()) }) },
  { label: 'Last Week', get: () => { const s = addDays(startOfWeek(new Date()), -7); return { start: s, end: addDays(s, 6) } } },
  { label: 'This Month', get: () => { const n = new Date(); return { start: sod(new Date(n.getFullYear(), n.getMonth(), 1)), end: sod(n) } } },
  { label: 'Last Month', get: () => { const n = new Date(); return { start: sod(new Date(n.getFullYear(), n.getMonth() - 1, 1)), end: sod(new Date(n.getFullYear(), n.getMonth(), 0)) } } },
  // Calendar months back, not 90/365 days — and via the clamping `addMonths` above, so the 31st
  // does not ask for a date the target month has never had.
  { label: 'Last 3 Months', get: () => ({ start: sod(addMonths(new Date(), -3)), end: sod(new Date()) }) },
  { label: 'Last 12 Months', get: () => ({ start: sod(addMonths(new Date(), -12)), end: sod(new Date()) }) },
]

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

export function DateRangePicker({ value, onChange, className, presets = DEFAULT_PRESETS }: DateRangePickerProps) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState(() => new Date(value.start.getFullYear(), value.start.getMonth(), 1))
  const [draftStart, setDraftStart] = useState<Date | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useClickAway(ref, () => { setOpen(false); setDraftStart(null) }, open)

  const today = sod(new Date())

  const pickDay = (day: Date) => {
    if (!draftStart) {
      setDraftStart(day)
    } else {
      const start = day < draftStart ? day : draftStart
      const end = day < draftStart ? draftStart : day
      onChange({ start, end })
      setDraftStart(null)
      setOpen(false)
    }
  }

  const renderMonth = (month: Date) => (
    <div className="nds-dp-month">
      <div className="nds-dp-mh">{monthLabel(month)}</div>
      <div className="nds-dp-grid">
        {WEEKDAYS.map((w, i) => (
          <div key={`wd-${i}`} className="nds-dp-wd">{w}</div>
        ))}
        {monthGrid(month).map((day, i) => {
          if (!day) return <span key={i} className="nds-dp-day empty" />
          const future = day > today
          const isStart = draftStart ? sameDay(day, draftStart) : sameDay(day, value.start)
          const isEnd = !draftStart && sameDay(day, value.end)
          const inRange = !draftStart && day > value.start && day < value.end
          const cls = ['nds-dp-day', future ? 'dis' : '', inRange ? 'in' : '', isStart ? 'start' : '', isEnd ? 'end' : '', sameDay(day, today) ? 'today' : '']
            .filter(Boolean)
            .join(' ')
          return (
            <button key={i} type="button" className={cls} disabled={future} onClick={() => pickDay(day)}>
              {day.getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )

  return (
    <div className={`nds-dp${className ? ` ${className}` : ''}`} ref={ref}>
      <button type="button" className="nds-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Calendar size={15} />
        {fmt(value.start)} – {fmt(value.end)}
        <ChevronDown size={15} />
      </button>
      {open && (
        <div className="nds-dp-pop">
          <div className="nds-dp-presets">
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                className="nds-dp-preset"
                onClick={() => {
                  onChange(p.get())
                  setDraftStart(null)
                  setOpen(false)
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="nds-dp-cal">
            <div className="nds-dp-nav">
              <button type="button" onClick={() => setView(addMonths(view, -1))} aria-label="Previous month">
                <ChevronLeft size={16} />
              </button>
              <button type="button" onClick={() => setView(addMonths(view, 1))} aria-label="Next month">
                <ChevronRight size={16} />
              </button>
            </div>
            <div className="nds-dp-months">
              {renderMonth(view)}
              {renderMonth(addMonths(view, 1))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
