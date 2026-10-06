'use client'

/**
 * CBN.2f — date-range picker, pixel-matched to the Helium 10 Ad Manager control:
 * a dual-month range calendar (Monday-first, AM-36) with ‹ › navigation on the left and a
 * scrollable preset rail on the right. Selecting a start then an end commits the
 * range; presets commit immediately. Label renders MM/DD/YYYY - MM/DD/YYYY.
 *
 * AM-16 — the window rule, the same as the API's (`apps/api/src/services/ads-core/date-range.ts`): every rolling
 * window ("Latest N days", "Last N months") is complete days ENDING YESTERDAY. Amazon's daily report for a day arrives
 * the next morning, so a window ending today held one day fewer of data than the period it was compared with.
 * Today, This Week/Month/Quarter still include today. `latest7`/`latest30` map to the server's `last7`/`last30`
 * (`rules-automation/_shared/adsScope.ts`), so both sides move together.
 *
 * AM-36 — a week starts on MONDAY, as the server's `wtd` does (ISO weeks, Europe/Rome). "This Week" / "Last Week" and
 * the calendar's columns started on Sunday here, so "This Week" on a Sunday was one day long in the picker and seven
 * on the server.
 */
import { useState } from 'react'
import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { InfoTip } from '@/design-system/primitives'

const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
/** AM-36 — days since Monday (Mon 0 … Sun 6), the ISO week the server uses. */
const sinceMonday = (d: Date) => (d.getDay() + 6) % 7
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
/** The last `n` complete days, ending yesterday (local midnights) — the default window of every ads page (AM-16). */
export function lastCompleteDays(n: number): { start: Date; end: Date } {
  const end = sod(new Date()); end.setDate(end.getDate() - 1)
  const start = new Date(end); start.setDate(start.getDate() - (n - 1))
  return { start, end }
}

/** The rule in one sentence, for the picker and any page that states its window. */
export const COMPLETE_DAYS_NOTE = 'Last N days and months end yesterday: Amazon reports a day the next morning. Today has its own preset.'

export function presetRange(key: string): { start: Date; end: Date } {
  const today = sod(new Date())
  const s = new Date(today); const e = new Date(today)
  switch (key) {
    case 'today': break
    case 'yesterday': s.setDate(s.getDate() - 1); e.setDate(e.getDate() - 1); break
    case 'thisWeek': s.setDate(s.getDate() - sinceMonday(s)); break
    case 'lastWeek': s.setDate(s.getDate() - sinceMonday(s) - 7); e.setDate(e.getDate() - sinceMonday(e) - 1); break
    case 'thisMonth': s.setDate(1); break
    case 'lastMonth': s.setMonth(s.getMonth() - 1, 1); e.setDate(0); break
    // AM-16 — rolling windows end yesterday (complete days).
    case 'last3m': s.setMonth(s.getMonth() - 3); e.setDate(e.getDate() - 1); break
    case 'last12m': s.setMonth(s.getMonth() - 12); e.setDate(e.getDate() - 1); break
    case 'last18m': s.setMonth(s.getMonth() - 18); e.setDate(e.getDate() - 1); break
    case 'last24m': s.setMonth(s.getMonth() - 24); e.setDate(e.getDate() - 1); break
    case 'thisQuarter': s.setMonth(Math.floor(s.getMonth() / 3) * 3, 1); break
    case 'lastQuarter': { const q = Math.floor(s.getMonth() / 3); s.setMonth(q * 3 - 3, 1); e.setMonth(q * 3, 0); break }
    case 'latest7': return lastCompleteDays(7)
    case 'latest30': return lastCompleteDays(30)
    case 'latest60': return lastCompleteDays(60)
  }
  return { start: s, end: e }
}

function monthDays(year: number, month: number): Date[] {
  const first = new Date(year, month, 1)
  const start = new Date(first); start.setDate(1 - sinceMonday(first)) // back to the Monday on/before the 1st
  return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d })
}

export function DateRangePicker({ value, onChange, disabledReason }: {
  value: { start: Date; end: Date }; onChange: (start: Date, end: Date) => void
  /**
   * AM-26 — the page cannot take a range from here yet. The control stays visible (placeholder controls are kept),
   * shows the range the page is showing, does not open, and says why: on hover AND on keyboard focus (it stays
   * focusable, `aria-disabled` rather than `disabled`, and the reason is part of its accessible name).
   */
  disabledReason?: string
}) {
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
  const label = `${fmt(value.start)} - ${fmt(value.end)}`
  // One trigger: with `disabledReason` it is focusable but inert (`aria-disabled`), its name carries the reason, and
  // the InfoTip shows the reason on hover and keyboard focus.
  const trigger = (
    <button
      type="button" className="h10-hbtn"
      aria-disabled={disabledReason ? 'true' : undefined}
      aria-label={disabledReason ? `${label}. ${disabledReason}` : undefined}
      onClick={() => { if (!disabledReason) setOpen((o) => !o) }}
    >
      <Calendar size={14} /> {label} <ChevronDown size={13} />
    </button>
  )
  return (
    <div className="h10-hsel">
      {disabledReason ? <InfoTip tip={disabledReason}>{trigger}</InfoTip> : trigger}
      {open && !disabledReason && <>
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
            <p className="h10-dp-note">{COMPLETE_DAYS_NOTE}</p>
          </div>
        </div>
      </>}
    </div>
  )
}
