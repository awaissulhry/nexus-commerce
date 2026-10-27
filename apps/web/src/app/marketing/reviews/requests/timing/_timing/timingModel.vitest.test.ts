import { describe, expect, it } from 'vitest'
import {
  addRow,
  dayParts,
  defaultsBody,
  defaultsChanges,
  defaultsHeld,
  heatView,
  rateNotMeasurableHere,
  moveRow,
  removeRow,
  rowsFromDefaults,
  sampleWords,
  updateRow,
  usedByWords,
  windowsBody,
  windowsChanges,
  windowsFor,
  type ConversionReport,
  type SendWindow,
} from './timingModel'

const DEFAULTS = [
  { pattern: 'glove', label: 'Gloves', delayDays: 10, sortOrder: 60, isActive: true },
  { pattern: 'helmet', label: 'Helmets', delayDays: 21, sortOrder: 10, isActive: true },
  { pattern: 'jacket', label: 'Jackets', delayDays: 14, sortOrder: 30, isActive: false },
]

describe('first try by product type', () => {
  it('reads the rows in their order and saves them 10, 20, 30 in lower case', () => {
    const rows = rowsFromDefaults(DEFAULTS)
    expect(rows.map((r) => r.pattern)).toEqual(['helmet', 'jacket', 'glove'])
    const moved = moveRow(rows, 2, -1)
    expect(defaultsBody(moved).items.map((i) => `${i.pattern}:${i.sortOrder}`)).toEqual(['helmet:10', 'glove:20', 'jacket:30'])
    expect(moveRow(rows, 0, -1)).toEqual(rows)
    const edited = updateRow(rows, rows[0].key, { pattern: ' Casco ', label: '', delayDays: 99 })
    expect(defaultsBody(edited).items[0]).toEqual({ pattern: 'casco', label: 'casco', delayDays: 60, sortOrder: 10, isActive: true })
  })

  it('counts added, removed, edited and moved rows', () => {
    const rows = rowsFromDefaults(DEFAULTS)
    expect(defaultsChanges(rows, rows)).toBe(0)
    expect(defaultsChanges(rows, moveRow(rows, 1, 1))).toBe(2)
    expect(defaultsChanges(rows, removeRow(rows, rows[0].key))).toBe(3)
    const added = addRow(rows)
    expect(defaultsChanges(rows, updateRow(added, added[3].key, { pattern: 'boot' }))).toBe(1)
  })

  it('holds Save for a row without words, or the same words twice', () => {
    const rows = rowsFromDefaults(DEFAULTS)
    expect(defaultsHeld(addRow(rows))).toBe('Row 4 needs the word it matches.')
    expect(defaultsHeld(updateRow(rows, rows[1].key, { pattern: 'HELMET' }))).toBe('“helmet” is in the table twice — keep one row.')
    expect(defaultsHeld(rows)).toBeNull()
  })

  it('names the rules that use the table', () => {
    expect(usedByWords([{ name: 'A', sendDelayDays: null, isActive: true }, { name: 'B', sendDelayDays: 7, isActive: true }, { name: 'C', sendDelayDays: null, isActive: false }]))
      .toBe('Used by 2 rules that do not set their own first day: A, C (off).')
    expect(usedByWords([{ name: 'B', sendDelayDays: 7, isActive: true }])).toBe('No rule uses this table now: every rule sets its own first day.')
  })
})

const WINDOWS: SendWindow[] = [
  ...[0, 1, 2, 3, 4, 5, 6].map((d) => ({ marketplace: '*', dayOfWeek: d, hourLocal: 19, dayRank: d + 1, isActive: true })),
  { marketplace: 'DE', dayOfWeek: 2, hourLocal: 10, dayRank: 1, isActive: true },
]

describe('send hour by weekday', () => {
  it('shows a market’s own days, or the global default it uses', () => {
    const de = windowsFor(WINDOWS, 'DE')
    expect(de.own).toBe(true)
    expect(de.rows.map((r) => r.dayOfWeek)).toEqual([1, 2, 3, 4, 5, 6, 0])
    expect(de.rows[1]).toEqual({ dayOfWeek: 2, hourLocal: 10, dayRank: 1, isActive: true })
    const it = windowsFor(WINDOWS, 'IT')
    expect(it.own).toBe(false)
    expect(it.rows[0]).toEqual({ dayOfWeek: 1, hourLocal: 19, dayRank: 2, isActive: true })
  })

  it('saves seven days for the market and counts the days changed', () => {
    const rows = windowsFor(WINDOWS, '*').rows
    const next = rows.map((r) => (r.dayOfWeek === 2 ? { ...r, hourLocal: 11 } : r))
    expect(windowsChanges(rows, next)).toBe(1)
    expect(windowsBody('IT', next).windows).toHaveLength(7)
    expect(windowsBody('IT', next).marketplace).toBe('IT')
  })
})

const REPORT: ConversionReport = {
  windowDays: 90,
  marketplace: null,
  totalSent: 150,
  totalConverted: 9,
  hasReviews: true,
  cells: [
    { dayOfWeek: 2, hour: 10, sent: 100, converted: 6 },
    { dayOfWeek: 2, hour: 19, sent: 40, converted: 3 },
    { dayOfWeek: 0, hour: 2, sent: 10, converted: 0 },
  ],
}

describe('send-hour heatmap', () => {
  it('shades by review rate, leaves unsent hours empty and outlines the hour we send', () => {
    const v = heatView(REPORT, windowsFor(WINDOWS, '*').rows)
    expect(v.data).toHaveLength(7)
    expect(v.data[1][10]).toBeCloseTo(0.06)
    expect(v.data[0][10]).toBeNull()
    expect(v.marked.has('1:19')).toBe(true)
    expect(v.cellWords(1, 10, 0.06)).toBe('Tue 10:00 · 100 sent · 6 reviews after · 6.0%')
    expect(v.cellWords(1, 19, 0.075)).toBe('Tue 19:00 · 40 sent · 3 reviews after · 7.5% · we send at this hour')
    expect(v.cellWords(0, 3, null)).toBe('Mon 03:00 · none sent')
    expect(v.colLabels.filter(Boolean)).toEqual(['00', '03', '06', '09', '12', '15', '18', '21'])
  })

  it('sums the parts of the day and says when the sample is small', () => {
    expect(dayParts(REPORT)).toEqual([
      { label: 'Morning · 6–12', sent: 100, reviews: 6, rate: '6.0%' },
      { label: 'Afternoon · 12–18', sent: 0, reviews: 0, rate: 'not sent' },
      { label: 'Evening · 18–22', sent: 40, reviews: 3, rate: '7.5%' },
      { label: 'Night · 22–6', sent: 10, reviews: 0, rate: '0.0%' },
    ])
    expect(sampleWords(REPORT)).toBe('150 requests in 90 days. Too few to compare hours yet: the differences can be luck. Amazon does not say who wrote a review, so rates are estimates.')
    expect(sampleWords({ ...REPORT, totalSent: 914 })).toMatch(/^914 requests in 90 days\. Differences under 1 point can be luck\./)
  })

  it('every send stays on its hour; where no review can follow, the rate says "Not measurable", never 0.0% (live audit A02)', () => {
    const words = 'Not measurable: Amazon gives no review count — import this market’s reviews to estimate it.'
    const none: ConversionReport = {
      windowDays: 90, marketplace: 'IT', totalSent: 291, totalMeasured: 0, totalConverted: 0, hasReviews: false, words,
      cells: [{ dayOfWeek: 1, hour: 19, sent: 196, measured: 0, converted: 0 }, { dayOfWeek: 1, hour: 23, sent: 95, measured: 0, converted: 0 }],
    }
    expect(dayParts(none).map((p) => `${p.label}=${p.sent}/${p.rate}`)).toEqual([
      'Morning · 6–12=0/not sent', 'Afternoon · 12–18=0/not sent', 'Evening · 18–22=196/Not measurable', 'Night · 22–6=95/Not measurable',
    ])
    expect(rateNotMeasurableHere(none)).toBe(true)
    expect(sampleWords(none)).toBe(`291 requests in 90 days. ${words}`)
    const v = heatView(none, windowsFor(WINDOWS, '*').rows)
    expect(v.data[0][19]).toBeNull()
    expect(v.cellWords(0, 23, null)).toBe('Mon 23:00 · 95 sent · review rate not measurable')
    // Part measurable: the rate is over the measured ones only.
    const part: ConversionReport = { ...none, totalMeasured: 10, totalConverted: 1, words: '286 of 291 sent where no review can be matched yet — left out of the rate.', cells: [{ dayOfWeek: 1, hour: 19, sent: 196, measured: 10, converted: 1 }] }
    expect(dayParts(part)[2]).toEqual({ label: 'Evening · 18–22', sent: 196, reviews: 1, rate: '10.0%' })
    expect(rateNotMeasurableHere(part)).toBe(false)
  })
})
