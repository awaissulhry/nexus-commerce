'use client'

import { useState } from 'react'

import { Checkbox } from '@/design-system/primitives'
import { CalendarGrid, type CalendarDay, type CalendarKind, type CalendarRange } from '@/design-system/components/CalendarGrid'

/*
 * 2026-10-30 — calendar grid (factory part "CalendarGrid", `packages/ui/src/components/CalendarGrid`). A made-up line
 * calendar. Verify: weekends hatched, the public holidays cross-hatched, the closure, an extra shift (dots), a short day
 * (an edge bar) and a line closed (a dashed frame), each with its word in the month and in its name; today marked in
 * words; the key counts each kind. Click a day (or Tab into the grid, arrows, Enter) — the line below says which; drag
 * across days, or Shift + arrows then Enter, to select a range; Escape clears it. Month ⇄ Year; Calendar ⇄ List (the
 * screen-reader twin, and always below 560 px of its own width). "Read-only" refuses a selection with the reason. Light
 * and dark, 1440 and 390.
 */

const kinds: CalendarKind[] = [
  { id: 'work', label: 'Working day' },
  { id: 'weekend', label: 'Weekend', tone: 'neutral', off: true },
  { id: 'holiday', label: 'Public holiday', tone: 'danger', off: true, pattern: 'cross' },
  { id: 'closure', label: 'Closure', tone: 'warning', off: true },
  { id: 'extra', label: 'Extra shift', tone: 'success', pattern: 'dots' },
  { id: 'short', label: 'Short day', tone: 'info', pattern: 'stripe' },
  { id: 'line', label: 'Line closed', tone: 'danger', off: true, pattern: 'outline' },
]
const week = ['work', 'work', 'work', 'work', 'work', 'weekend', 'weekend']
const days: Record<string, CalendarDay> = {
  '2026-11-01': { kind: 'holiday', reason: 'All Saints’ Day' },
  '2026-11-06': { kind: 'short', reason: 'Stock count', detail: '06:00–11:00' },
  '2026-11-14': { kind: 'extra', reason: 'Order peak', detail: '06:00–12:00' },
  '2026-11-18': { kind: 'line', reason: 'Machine overhaul' },
  '2026-12-08': { kind: 'holiday', reason: 'Immaculate Conception' },
  '2026-12-24': { kind: 'closure', reason: 'Christmas closure' },
  '2026-12-25': { kind: 'holiday', reason: 'Christmas Day' },
  '2026-12-26': { kind: 'holiday', reason: 'St Stephen’s Day' },
  '2026-12-28': { kind: 'closure', reason: 'Christmas closure' },
  '2026-12-29': { kind: 'closure', reason: 'Christmas closure' },
  '2026-12-30': { kind: 'closure', reason: 'Christmas closure' },
  '2026-12-31': { kind: 'closure', reason: 'Christmas closure' },
}

export function CalendarGridExample() {
  const [readOnly, setReadOnly] = useState(false)
  const [last, setLast] = useState('')
  const [range, setRange] = useState<CalendarRange | null>(null)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--nds-space-12)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--nds-space-12)', alignItems: 'center' }}>
        <Checkbox checked={readOnly} onChange={(event) => setReadOnly(event.currentTarget.checked)} label="Read-only" />
        <span style={{ color: 'var(--nds-text-2)' }}>{last || 'Nothing opened or selected yet.'}</span>
      </div>
      <CalendarGrid
        label="Calendar · Line 2 (example)"
        kinds={kinds}
        days={days}
        weekKinds={week}
        defaultMonth="2026-11"
        today="2026-11-05"
        range={range}
        heldReason={readOnly ? 'Read-only: you need the planning settings permission to change calendars.' : null}
        onDayOpen={(date) => setLast(`Opened ${date}: the app shows its exception popover here.`)}
        onRangeClear={() => setRange(null)}
        onRangeSelect={(next) => {
          setRange(next)
          setLast(`Selected ${next.from} to ${next.to}: the app asks “Closure from … to …?”.`)
        }}
      />
    </div>
  )
}
