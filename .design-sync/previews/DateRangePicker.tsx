// DateRangePicker — the window every ads surface is scoped by.
// Controlled and REQUIRED: `value` is a `{ start: Date, end: Date }` object.
// Passing undefined (or a `{start,end}` of strings) throws inside the picker —
// it reads `value.start.getFullYear()` on first render to seed the visible month.
//
// Composition ported from the ads page header
// (apps/web/src/app/marketing/ads/_shell/AdsPageHeader.tsx) and the DS catalog's
// "Date range" cell.
//
// Every date is a FIXED literal, never `new Date()`, so captures are deterministic.
import { useState } from 'react'
import { Button, DateRangePicker, type DateRange } from '@nexus/design-system'



const d = (y: number, m: number, day: number) => new Date(y, m - 1, day)

/** The default ads window — the trigger prints "01 Jun 2026 – 14 Jun 2026". */
export const LastFourteenDays = () => {
  const [range, setRange] = useState<DateRange>({ start: d(2026, 6, 1), end: d(2026, 6, 14) })
  return <DateRangePicker value={range} onChange={setRange} />
}

/** A one-day range: start and end are the same date, and the trigger says so twice. */
export const SingleDay = () => {
  const [range, setRange] = useState<DateRange>({ start: d(2026, 6, 14), end: d(2026, 6, 14) })
  return <DateRangePicker value={range} onChange={setRange} />
}

/** A long window — a quarter of reporting, the widest label the trigger has to carry. */
export const QuarterToDate = () => {
  const [range, setRange] = useState<DateRange>({ start: d(2026, 4, 1), end: d(2026, 6, 30) })
  return <DateRangePicker value={range} onChange={setRange} />
}

/** Where it actually lives: the right-hand end of a page header, beside the page's actions. */
export const InPageHeader = () => {
  const [range, setRange] = useState<DateRange>({ start: d(2026, 6, 1), end: d(2026, 6, 14) })
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-tertiary)' }}>
          Campaigns
        </div>
        <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--text-primary)' }}>Ad Manager</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <DateRangePicker value={range} onChange={setRange} />
        <Button>Export</Button>
        <Button variant="primary">New campaign</Button>
      </div>
    </div>
  )
}
