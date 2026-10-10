'use client'

import { useMemo, useState } from 'react'

import { WeekHourGrid } from '../components/WeekHourGrid'
import type { WeekHourBrush, WeekHourCell, WeekHourMode } from '../components/weekHourModel'

/*
 * 2026-10-10 — ads brain page D1. Made-up data. Verify:
 *  - Tab lands on ONE hour; arrows move, Shift + arrows select, Space paints (Paint) or flips the lock (Lock), Esc clears;
 *    1–4 pick a brush only while the grid has focus; Home/End = first/last hour, PageUp/PageDown = previous/next day;
 *  - drag paints on release; Mon–Fri 02:00–05:59 are locked and Paint keeps them ("… locked, kept");
 *  - "Shade by" Orders: Sunday before 06:00 is hatched (no data), never the palest blue; a quiet hour with 0 orders is not hatched;
 *  - the dot marks the hours the new plan changed ("was …"); hover or focus reads the hour under the grid;
 *  - the narrow copy (390 px) stands on its side: 24 hour rows × 7 day columns, nothing cut off. Light and dark.
 */
const BRUSHES: WeekHourBrush[] = [
  { id: 'lower', label: 'Lower', tone: 'info', description: 'Bid 20 % under the base' },
  { id: 'push', label: 'Push', tone: 'success', description: 'Bid 20 % over the base' },
  { id: 'defend', label: 'Defend top', tone: 'accent', mark: 'D', description: 'Bid 40 % over the base, top of search' },
  { id: 'rest', label: 'Rest', tone: 'warning', description: 'Lowest bid: hours that never sell' },
]

/** A made-up week: quiet nights, a working day, busy evenings. */
function startWeek(): WeekHourCell[][] {
  return Array.from({ length: 7 }, (_, day) => Array.from({ length: 24 }, (_, hour) => {
    const weekday = day >= 1 && day <= 5
    const brush = hour >= 18 && hour <= 21 ? 'defend' : hour >= 8 && hour <= 17 ? 'push' : hour >= 6 ? 'lower' : null
    const was = hour >= 18 && hour <= 21 && day === 2 ? 'push' : undefined
    const orders = day === 0 && hour < 6 ? null : hour < 6 ? 0 : Math.round(2 + (hour >= 18 && hour <= 21 ? 8 : hour >= 8 ? 4 : 1) + ((day * 3 + hour) % 3))
    return { brush, locked: weekday && hour >= 2 && hour <= 5, heat: orders, before: was }
  }))
}

const METRICS = [
  { id: 'plan', label: 'The plan' },
  { id: 'orders', label: 'Orders' },
]

export function WeekHourGridExample() {
  const [cells, setCells] = useState<WeekHourCell[][]>(startWeek)
  const [mode, setMode] = useState<WeekHourMode>('paint')
  const [brush, setBrush] = useState('push')
  const [metric, setMetric] = useState('plan')
  const [focused, setFocused] = useState('none yet')
  const [log, setLog] = useState('nothing yet')

  const edit = (hours: { day: number; hour: number }[], change: (c: WeekHourCell) => WeekHourCell) => {
    const keys = new Set(hours.map((h) => `${h.day}-${h.hour}`))
    setCells((prev) => prev.map((row, day) => row.map((c, hour) => (keys.has(`${day}-${hour}`) ? change(c) : c))))
  }
  const formatHeat = useMemo(() => (v: number | null) => (v == null ? 'no data' : `${v} ${v === 1 ? 'order' : 'orders'}`), [])

  const common = {
    cells,
    brushes: BRUSHES,
    baseLabel: 'Base',
    mode,
    brush,
    onBrush: setBrush,
    onPaint: (hours: { day: number; hour: number }[], id: string) => {
      edit(hours, (c) => ({ ...c, brush: id }))
      setLog(`onPaint: ${hours.length} hours → ${id}`)
    },
    onLock: (hours: { day: number; hour: number }[], locked: boolean) => {
      edit(hours, (c) => ({ ...c, locked }))
      setLog(`onLock: ${hours.length} hours → ${locked ? 'locked' : 'unlocked'}`)
    },
    shade: metric === 'plan' ? ('brush' as const) : ('heat' as const),
    formatHeat,
    heatLabel: 'Orders',
    readOnlyReason: 'View only: choose Paint or Lock to change hours.',
  }

  return (
    <section id="week-hour-grid-example" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--nds-space-14)' }}>
      <WeekHourGrid
        {...common}
        label="Hourly plan (example)"
        onMode={setMode}
        metrics={METRICS}
        metric={metric}
        onMetric={setMetric}
        timeZoneLabel="Times in Europe/Rome"
        onFocusHour={(day, hour) => setFocused(`d${day}h${hour}`)}
      />
      <div style={{ display: 'flex', gap: 'var(--nds-space-16)', fontSize: 'var(--nds-font-size-sm)', color: 'var(--nds-text-2)' }}>
        <span>Focused address: <b>{focused}</b></span>
        <span>Last callback: <b>{log}</b></span>
      </div>
      <div style={{ maxWidth: 390, padding: 'var(--nds-space-12)', border: '1px solid var(--nds-border)', borderRadius: 'var(--nds-radius-lg)' }}>
        <WeekHourGrid {...common} label="Hourly plan on a phone (example)" />
      </div>
    </section>
  )
}
