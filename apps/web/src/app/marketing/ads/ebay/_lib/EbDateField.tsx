'use client'

/**
 * EV4a — single-date form field with ZERO native browser chrome: an
 * .h10-dd-btn trigger + a portal month calendar reusing the console's own
 * .h10-dp-month vocabulary (same grid the Ad Manager range picker renders).
 * min/max as ISO dates; blank value = the placeholder; optional clear row.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react'

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const pad = (n: number) => String(n).padStart(2, '0')
const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const fromIso = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y!, (m ?? 1) - 1, d ?? 1) }
const fmt = (s: string) => { const d = fromIso(s); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` }
const addMonths = (d: Date, n: number) => { const x = new Date(d); x.setDate(1); x.setMonth(x.getMonth() + n); return x }
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

function monthDays(year: number, month: number): Date[] {
  const first = new Date(year, month, 1)
  const start = new Date(first); start.setDate(1 - first.getDay())
  return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d })
}

export function EbDateField({ value, onChange, min, max, placeholder = 'not set', clearable = true, clearLabel = 'clear', ariaLabel, width, dense }: {
  value: string // 'YYYY-MM-DD' or ''
  onChange: (v: string) => void
  min?: string
  max?: string
  placeholder?: string
  clearable?: boolean
  clearLabel?: string
  ariaLabel?: string
  width?: number | string
  /** 28px register (dense tables/toolbars); default = the 38px field register */
  dense?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const selected = value ? fromIso(value) : null
  const [view, setView] = useState(() => {
    const base = selected ?? (min ? fromIso(min) : new Date())
    return new Date(base.getFullYear(), base.getMonth(), 1)
  })

  useEffect(() => {
    if (!open) return
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [open])

  const toggle = () => {
    if (!open) {
      const el = btnRef.current
      if (el) {
        const r = el.getBoundingClientRect()
        const estH = 320
        const up = r.bottom + estH > window.innerHeight - 8
        setPos({ top: up ? r.top - 4 : r.bottom + 4, left: r.left, up })
      }
      if (selected) setView(new Date(selected.getFullYear(), selected.getMonth(), 1))
    }
    setOpen((o) => !o)
  }

  const minD = min ? fromIso(min) : null
  const maxD = max ? fromIso(max) : null
  const today = new Date(); today.setHours(0, 0, 0, 0)

  return (
    <div className={`h10-dd eb-dd-self ${dense ? 'dense' : ''}`} style={width != null ? { width } : undefined}>
      <button ref={btnRef} type="button" className={`h10-dd-btn ${open ? 'open' : ''}`} onClick={toggle} aria-haspopup="dialog" aria-expanded={open} aria-label={ariaLabel}>
        <span className={value ? undefined : 'ph'}>{value ? fmt(value) : placeholder}</span>
        <Calendar size={14} />
      </button>
      {open && pos && createPortal(<>
        <button type="button" className="h10-dd-back" aria-label="Close" onClick={() => setOpen(false)} />
        <div className="eb-df-pop" role="dialog" aria-label={ariaLabel ?? 'Pick a date'} style={{ top: pos.top, left: pos.left, transform: pos.up ? 'translateY(-100%)' : undefined }}>
          <div className="h10-dp-nav">
            <button type="button" onClick={() => setView(addMonths(view, -1))} aria-label="Previous month"><ChevronLeft size={16} /></button>
            <div className="mh"><span>{view.toLocaleString('en-US', { month: 'long' })} {view.getFullYear()}</span></div>
            <button type="button" onClick={() => setView(addMonths(view, 1))} aria-label="Next month"><ChevronRight size={16} /></button>
          </div>
          <div className="h10-dp-month">
            <div className="dow">{DOW.map((d, i) => <span key={i}>{d}</span>)}</div>
            <div className="days">
              {monthDays(view.getFullYear(), view.getMonth()).map((d, i) => {
                const out = d.getMonth() !== view.getMonth()
                const dis = (minD != null && d < minD) || (maxD != null && d > maxD)
                const cls = [out ? 'out' : '', dis ? 'dis' : '', selected && sameDay(d, selected) ? 'start' : '', sameDay(d, today) ? 'today' : ''].filter(Boolean).join(' ')
                return (
                  <button type="button" key={i} className={`day ${cls}`} disabled={dis}
                    onClick={() => { onChange(toIso(d)); setOpen(false) }}>
                    {d.getDate()}
                  </button>
                )
              })}
            </div>
          </div>
          {clearable && value && (
            <div className="eb-df-foot">
              <button type="button" className="h10-am-link" onClick={() => { onChange(''); setOpen(false) }}>{clearLabel}</button>
            </div>
          )}
        </div>
      </>, document.body)}
    </div>
  )
}
