'use client'

import { useRef, useState } from 'react'
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react'
import { useClickAway } from './useClickAway'

export interface DateFieldProps {
  /** ISO date 'YYYY-MM-DD', or '' for unset */
  value: string
  onChange: (value: string) => void
  min?: string
  max?: string
  placeholder?: string
  clearable?: boolean
  clearLabel?: string
  ariaLabel?: string
  className?: string
  disabled?: boolean
}

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const pad = (n: number) => String(n).padStart(2, '0')
const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const fromIso = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y!, (m ?? 1) - 1, d ?? 1) }
const fmt = (s: string) => { const d = fromIso(s); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` }
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
const monthLabel = (d: Date) => d.toLocaleString('en-GB', { month: 'long', year: 'numeric' })
const addMonths = (d: Date, n: number) => { const x = new Date(d); x.setDate(1); x.setMonth(x.getMonth() + n); return x }

function monthGrid(month: Date): Array<Date | null> {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const cells: Array<Date | null> = Array.from({ length: first.getDay() }, () => null)
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  for (let d = 1; d <= days; d++) cells.push(new Date(month.getFullYear(), month.getMonth(), d))
  return cells
}

/**
 * Single-date calendar field with ZERO native browser chrome — the
 * replacement for `<input type="date">` (banned by the Wave-1 conformance
 * ratchet). Same `.h10-ds-dp-*` month-grid vocabulary as DateRangePicker,
 * single month, min/max support, optional clear row. Wave 1 gap-fill
 * (2026-07-04).
 */
export function DateField({ value, onChange, min, max, placeholder = 'not set', clearable = true, clearLabel = 'clear', ariaLabel, className, disabled }: DateFieldProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClickAway(ref, () => setOpen(false), open)
  const selected = value ? fromIso(value) : null
  const [view, setView] = useState(() => {
    const base = selected ?? (min ? fromIso(min) : new Date())
    return new Date(base.getFullYear(), base.getMonth(), 1)
  })

  const minD = min ? fromIso(min) : null
  const maxD = max ? fromIso(max) : null
  const today = new Date(); today.setHours(0, 0, 0, 0)

  const toggle = () => {
    if (!open && selected) setView(new Date(selected.getFullYear(), selected.getMonth(), 1))
    setOpen((o) => !o)
  }

  return (
    <div className={`h10-ds-datefield${className ? ` ${className}` : ''}`} ref={ref} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button type="button" className="h10-ds-listbox-btn" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} aria-label={ariaLabel} onClick={toggle}>
        <span className={value ? undefined : 'ph'}>{value ? fmt(value) : placeholder}</span>
        <Calendar size={14} className="chev" aria-hidden />
      </button>
      {open && (
        <div className="h10-ds-dp-pop single" role="dialog" aria-label={ariaLabel ?? 'Pick a date'}>
          <div className="h10-ds-dp-nav">
            <button type="button" onClick={() => setView(addMonths(view, -1))} aria-label="Previous month"><ChevronLeft size={15} /></button>
            <div className="h10-ds-dp-mh">{monthLabel(view)}</div>
            <button type="button" onClick={() => setView(addMonths(view, 1))} aria-label="Next month"><ChevronRight size={15} /></button>
          </div>
          <div className="h10-ds-dp-month">
            <div className="h10-ds-dp-grid">
              {WEEKDAYS.map((w, i) => <div key={`wd-${i}`} className="h10-ds-dp-wd">{w}</div>)}
              {monthGrid(view).map((day, i) => {
                if (!day) return <span key={i} className="h10-ds-dp-day empty" />
                const dis = (minD != null && day < minD) || (maxD != null && day > maxD)
                const cls = ['h10-ds-dp-day', dis ? 'dis' : '', selected && sameDay(day, selected) ? 'start' : '', sameDay(day, today) ? 'today' : ''].filter(Boolean).join(' ')
                return (
                  <button key={i} type="button" className={cls} disabled={dis} onClick={() => { onChange(toIso(day)); setOpen(false) }}>
                    {day.getDate()}
                  </button>
                )
              })}
            </div>
          </div>
          {clearable && value && (
            <div className="h10-ds-datefield-foot">
              <button type="button" onClick={() => { onChange(''); setOpen(false) }}>{clearLabel}</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
