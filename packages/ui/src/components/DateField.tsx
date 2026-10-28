'use client'

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react'
import { useClickAway } from './useClickAway'
import { usePopoverPosition } from './usePopoverPosition'

/**
 * How the date READS. `value` and `onChange` are ISO (`yyyy-mm-dd`) whatever this is set to, so
 * the stored date cannot change meaning — only its presentation does.
 *
 * It exists because the component hard-coded `dd/mm/yyyy` while the ads console renders
 * `m/d/yyyy`, and "08/09" is two different days in those two formats. A page cannot mix them.
 */
export type DateFormat = 'dd/mm/yyyy' | 'mm/dd/yyyy' | 'yyyy-mm-dd'

export interface DateFieldProps {
  /** ISO date 'YYYY-MM-DD', or '' for unset */
  /** ISO `yyyy-mm-dd`. Unaffected by `format`. */
  value: string
  /** Display format. Default `dd/mm/yyyy`, which is what this component always did. */
  format?: DateFormat
  /** BCP-47 locale for the month/year heading. Default `en-GB`. */
  locale?: string
  /**
   * id for the TRIGGER, so a `<label htmlFor>` reaches it. `Field` clones its single element
   * child with a generated id; a component that drops it leaves the label pointing at nothing,
   * which is worse than an unlabelled control because the markup looks correct.
   */
  id?: string
  'aria-describedby'?: string
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
const fmt = (s: string, f: DateFormat = 'dd/mm/yyyy') => {
  const d = fromIso(s)
  const dd = pad(d.getDate())
  const mm = pad(d.getMonth() + 1)
  const yyyy = d.getFullYear()
  if (f === 'mm/dd/yyyy') return `${mm}/${dd}/${yyyy}`
  if (f === 'yyyy-mm-dd') return `${yyyy}-${mm}-${dd}`
  return `${dd}/${mm}/${yyyy}`
}
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
const monthLabel = (d: Date, locale = 'en-GB') => d.toLocaleString(locale, { month: 'long', year: 'numeric' })
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
 * ratchet). Same `.nds-dp-*` month-grid vocabulary as DateRangePicker,
 * single month, min/max support, optional clear row. Wave 1 gap-fill
 * (2026-07-04).
 */
export function DateField({ id, 'aria-describedby': describedBy, value, onChange, format = 'dd/mm/yyyy', locale = 'en-GB', min, max, placeholder = 'not set', clearable = true, clearLabel = 'clear', ariaLabel, className, disabled }: DateFieldProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // The calendar is portalled with fixed coordinates, like Listbox (usePopoverPosition): an absolute
  // panel was cut off by every scrolling or overflow-hidden ancestor — measured 2026-09-19 inside a
  // DS Modal, where only a 4 px strip of the calendar showed under the field.
  const { popRef, style: popStyle } = usePopoverPosition(open, ref, { width: 'auto' })
  useClickAway([ref, popRef], () => setOpen(false), open)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // Choosing, clearing or Escape returns to the field, like Listbox. A click away leaves focus where it went.
  const close = () => { setOpen(false); triggerRef.current?.focus() }

  // Portalled, the calendar is no longer next to the field in the Tab order — and inside a Modal the
  // modal's Tab trap would never reach it. So, as a date picker dialog does, focus moves INTO it on
  // open (the chosen day, else today, else the first day that can be picked) and Tab stays inside it.
  useEffect(() => {
    if (!open) return
    const pop = popRef.current
    const day = pop?.querySelector<HTMLButtonElement>('.nds-dp-day.start:not(:disabled)')
      ?? pop?.querySelector<HTMLButtonElement>('.nds-dp-day.today:not(:disabled)')
      ?? pop?.querySelector<HTMLButtonElement>('button.nds-dp-day:not(:disabled)')
      ?? pop?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    day?.focus({ preventScroll: true })
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const onPopKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // preventDefault: a Modal that holds this field ignores a handled key (Escape closes only the calendar).
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return }
    if (e.key !== 'Tab') return
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
    if (items.length === 0) return
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at === items.length - 1 ? 0 : at + 1)
    e.preventDefault()
    items[next]?.focus()
  }
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
    <div className={`nds-datefield${className ? ` ${className}` : ''}`} ref={ref} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button ref={triggerRef} type="button" id={id} aria-describedby={describedBy} className="nds-listbox-btn" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} aria-label={ariaLabel} onClick={toggle}>
        <span className={value ? undefined : 'ph'}>{value ? fmt(value, format) : placeholder}</span>
        <Calendar size={14} className="chev" aria-hidden />
      </button>
      {open && createPortal(
        // `ag-custom-component-popup`: AG Grid counts a click or focus in an element with this class as
        // inside its editor. A DateField inside a grid cell editor (the Shopify sheet's metafield dialog)
        // would otherwise end the cell edit when a day is clicked, now that the calendar sits in <body>.
        <div ref={popRef} style={popStyle} className="nds-dp-pop single ag-custom-component-popup" role="dialog" aria-label={ariaLabel ?? 'Pick a date'} onKeyDown={onPopKey}>
          {/* The same body box as DateRangePicker: without it the title and the grid sat side by side
              (the popover is a flex row) with no padding. */}
          <div className="nds-dp-cal">
          <div className="nds-dp-nav">
            <button type="button" onClick={() => setView(addMonths(view, -1))} aria-label="Previous month"><ChevronLeft size={15} /></button>
            <div className="nds-dp-mh">{monthLabel(view, locale)}</div>
            <button type="button" onClick={() => setView(addMonths(view, 1))} aria-label="Next month"><ChevronRight size={15} /></button>
          </div>
          <div className="nds-dp-month">
            <div className="nds-dp-grid">
              {WEEKDAYS.map((w, i) => <div key={`wd-${i}`} className="nds-dp-wd">{w}</div>)}
              {monthGrid(view).map((day, i) => {
                if (!day) return <span key={i} className="nds-dp-day empty" />
                const dis = (minD != null && day < minD) || (maxD != null && day > maxD)
                const cls = ['nds-dp-day', dis ? 'dis' : '', selected && sameDay(day, selected) ? 'start' : '', sameDay(day, today) ? 'today' : ''].filter(Boolean).join(' ')
                return (
                  <button key={i} type="button" className={cls} disabled={dis} onClick={() => { onChange(toIso(day)); close() }}
                    aria-label={day.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                    aria-pressed={selected ? sameDay(day, selected) : false} aria-current={sameDay(day, today) ? 'date' : undefined}>
                    {day.getDate()}
                  </button>
                )
              })}
            </div>
          </div>
          {clearable && value && (
            <div className="nds-datefield-foot">
              <button type="button" onClick={() => { onChange(''); close() }}>{clearLabel}</button>
            </div>
          )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
