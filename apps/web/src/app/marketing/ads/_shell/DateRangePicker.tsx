'use client'

/**
 * CBN.2f — date-range picker, pixel-matched to the Helium 10 Ad Manager control:
 * a dual-month range calendar (Sunday-first) with ‹ › navigation on the left and a
 * scrollable preset rail on the right. Selecting a start then an end commits the
 * range; presets commit immediately. Label renders MM/DD/YYYY - MM/DD/YYYY.
 */
import { useState } from 'react'
import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const fmt = (d: Date) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`
const sod = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
const addMonths = (d: Date, n: number) => { const x = new Date(d); x.setDate(1); x.setMonth(x.getMonth() + n); return x }
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

export const DATE_PRESETS: Array<{ key: string; label: string }> = [
  { key: 'today', label: 'Today' }, { key: 'yesterday', label: 'Yesterday' },
  { key: 'thisWeek', label: 'This Week' }, { key: 'lastWeek', label: 'Last Week' },
  { key: 'thisMonth', label: 'This Month' }, { key: 'lastMonth', label: 'Last Month' },
  { key: 'last3m', label: 'Last 3 Months' }, { key: 'last12m', label: 'Last 12 Months' },
  { key: 'last18m', label: 'Last 18 Months' }, { key: 'last24m', label: 'Last 24 Months' },
  { key: 'thisQuarter', label: 'This Quarter' }, { key: 'lastQuarter', label: 'Last Quarter' },
  { key: 'latest7', label: 'Latest 7 days' }, { key: 'latest30', label: 'Latest 30 days' },
  { key: 'latest60', label: 'Latest 60 days' },
]
export function presetRange(key: string): { start: Date; end: Date } {
  const today = sod(new Date())
  const s = new Date(today); const e = new Date(today)
  switch (key) {
    case 'today': break
    case 'yesterday': s.setDate(s.getDate() - 1); e.setDate(e.getDate() - 1); break
    case 'thisWeek': s.setDate(s.getDate() - s.getDay()); break
    case 'lastWeek': s.setDate(s.getDate() - s.getDay() - 7); e.setDate(e.getDate() - e.getDay() - 1); break
    case 'thisMonth': s.setDate(1); break
    case 'lastMonth': s.setMonth(s.getMonth() - 1, 1); e.setDate(0); break
    case 'last3m': s.setMonth(s.getMonth() - 3); break
    case 'last12m': s.setMonth(s.getMonth() - 12); break
    case 'last18m': s.setMonth(s.getMonth() - 18); break
    case 'last24m': s.setMonth(s.getMonth() - 24); break
    case 'thisQuarter': s.setMonth(Math.floor(s.getMonth() / 3) * 3, 1); break
    case 'lastQuarter': { const q = Math.floor(s.getMonth() / 3); s.setMonth(q * 3 - 3, 1); e.setMonth(q * 3, 0); break }
    case 'latest7': s.setDate(s.getDate() - 6); break
    case 'latest30': s.setDate(s.getDate() - 29); break
    case 'latest60': s.setDate(s.getDate() - 59); break
  }
  return { start: s, end: e }
}

function monthDays(year: number, month: number): Date[] {
  const first = new Date(year, month, 1)
  const start = new Date(first); start.setDate(1 - first.getDay()) // back to the Sunday on/before the 1st
  return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d })
}

export function DateRangePicker({ value, onChange }: { value: { start: Date; end: Date }; onChange: (start: Date, end: Date) => void }) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState(() => new Date(value.start.getFullYear(), value.start.getMonth(), 1))
  const [sel, setSel] = useState<{ start: Date; end: Date | null }>({ start: value.start, end: value.end })

  const clickDay = (d: Date) => {
    if (sel.end == null) {
      if (d >= sel.start) { setSel({ start: sel.start, end: d }); onChange(sel.start, d); setOpen(false) }
      else setSel({ start: d, end: null })
    } else {
      setSel({ start: d, end: null })
    }
  }
  const pick = (key: string) => { const r = presetRange(key); setSel({ start: r.start, end: r.end }); setView(new Date(r.start.getFullYear(), r.start.getMonth(), 1)); onChange(r.start, r.end); setOpen(false) }
  const inRange = (d: Date) => sel.end != null && d > sel.start && d < sel.end
  const isStart = (d: Date) => sameDay(d, sel.start)
  const isEnd = (d: Date) => sel.end != null && sameDay(d, sel.end)

  const today = sod(new Date())
  const months = [view, addMonths(view, 1)]
  return (
    <div className="h10-hsel">
      <button type="button" className="h10-hbtn" onClick={() => setOpen((o) => !o)}>
        <Calendar size={14} /> {fmt(value.start)} - {fmt(value.end)} <ChevronDown size={13} />
      </button>
      {open && <>
        <button type="button" className="h10-menu-back" aria-label="Close" onClick={() => setOpen(false)} />
        <div className="h10-dp" role="dialog" aria-label="Select date range">
          <div className="h10-dp-cal">
            <div className="h10-dp-nav">
              <button type="button" onClick={() => setView(addMonths(view, -1))} aria-label="Previous month"><ChevronLeft size={16} /></button>
              <div className="mh">{months.map((m, i) => <span key={i}>{m.toLocaleString('en-US', { month: 'long' })} {m.getFullYear()}</span>)}</div>
              <button type="button" onClick={() => setView(addMonths(view, 1))} aria-label="Next month"><ChevronRight size={16} /></button>
            </div>
            <div className="h10-dp-months">
              {months.map((m, mi) => (
                <div className="h10-dp-month" key={mi}>
                  <div className="dow">{DOW.map((d, i) => <span key={i}>{d}</span>)}</div>
                  <div className="days">
                    {monthDays(m.getFullYear(), m.getMonth()).map((d, di) => {
                      const out = d.getMonth() !== m.getMonth()
                      const future = d > today
                      const cls = [out ? 'out' : '', future ? 'dis' : '', inRange(d) ? 'in' : '', isStart(d) ? 'start' : '', isEnd(d) ? 'end' : '', sameDay(d, today) ? 'today' : ''].filter(Boolean).join(' ')
                      return <button type="button" key={di} className={`day ${cls}`} disabled={future} onClick={() => clickDay(d)}>{d.getDate()}</button>
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="h10-dp-presets">
            <div className="ph">Preset</div>
            {DATE_PRESETS.map((p) => <button type="button" key={p.key} onClick={() => pick(p.key)}>{p.label}</button>)}
          </div>
        </div>
      </>}
    </div>
  )
}
