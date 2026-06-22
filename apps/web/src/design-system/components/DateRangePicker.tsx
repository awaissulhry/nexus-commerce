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
function addMonths(d: Date, n: number) {
  const x = new Date(d)
  x.setMonth(x.getMonth() + n)
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

const PRESETS: Array<{ label: string; get: () => DateRange }> = [
  { label: 'Today', get: () => { const t = sod(new Date()); return { start: t, end: t } } },
  { label: 'Yesterday', get: () => { const y = sod(addDays(new Date(), -1)); return { start: y, end: y } } },
  { label: 'Last 7 days', get: () => ({ start: sod(addDays(new Date(), -6)), end: sod(new Date()) }) },
  { label: 'Last 30 days', get: () => ({ start: sod(addDays(new Date(), -29)), end: sod(new Date()) }) },
  { label: 'Last 90 days', get: () => ({ start: sod(addDays(new Date(), -89)), end: sod(new Date()) }) },
  { label: 'This month', get: () => { const n = new Date(); return { start: sod(new Date(n.getFullYear(), n.getMonth(), 1)), end: sod(n) } } },
  { label: 'Last month', get: () => { const n = new Date(); return { start: sod(new Date(n.getFullYear(), n.getMonth() - 1, 1)), end: sod(new Date(n.getFullYear(), n.getMonth(), 0)) } } },
]

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

export function DateRangePicker({ value, onChange }: DateRangePickerProps) {
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
    <div className="h10-ds-dp-month">
      <div className="h10-ds-dp-mh">{monthLabel(month)}</div>
      <div className="h10-ds-dp-grid">
        {WEEKDAYS.map((w, i) => (
          <div key={`wd-${i}`} className="h10-ds-dp-wd">{w}</div>
        ))}
        {monthGrid(month).map((day, i) => {
          if (!day) return <span key={i} className="h10-ds-dp-day empty" />
          const future = day > today
          const isStart = draftStart ? sameDay(day, draftStart) : sameDay(day, value.start)
          const isEnd = !draftStart && sameDay(day, value.end)
          const inRange = !draftStart && day > value.start && day < value.end
          const cls = ['h10-ds-dp-day', future ? 'dis' : '', inRange ? 'in' : '', isStart ? 'start' : '', isEnd ? 'end' : '', sameDay(day, today) ? 'today' : '']
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
    <div className="h10-ds-dp" ref={ref}>
      <button type="button" className="h10-ds-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Calendar size={15} />
        {fmt(value.start)} – {fmt(value.end)}
        <ChevronDown size={15} />
      </button>
      {open && (
        <div className="h10-ds-dp-pop">
          <div className="h10-ds-dp-presets">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className="h10-ds-dp-preset"
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
          <div className="h10-ds-dp-cal">
            <div className="h10-ds-dp-nav">
              <button type="button" onClick={() => setView(addMonths(view, -1))} aria-label="Previous month">
                <ChevronLeft size={16} />
              </button>
              <button type="button" onClick={() => setView(addMonths(view, 1))} aria-label="Next month">
                <ChevronRight size={16} />
              </button>
            </div>
            <div className="h10-ds-dp-months">
              {renderMonth(view)}
              {renderMonth(addMonths(view, 1))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
