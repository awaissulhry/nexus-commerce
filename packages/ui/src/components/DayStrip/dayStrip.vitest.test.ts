import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DayStrip } from './DayStrip'
import { DAY_STRIP_LABELS } from './DayStripLabels'
import { dayPct, daySpan, dayStripLines, dayTicks } from './dayStripModel'

/** B-W2b-28 — DayStrip: a day as a bar and as text. Made-up day, UTC times for a stable test. */
const at = (hhmm: string) => Date.parse(`2026-11-03T${hhmm}:00Z`)
const W = { from: at('06:00'), to: at('22:00') }
const DAY = {
  shift: { from: at('08:00'), to: at('17:00') },
  segments: [
    { id: 's1', from: at('08:02'), to: at('12:00'), kind: 'work' as const },
    { id: 's2', from: at('12:00'), to: at('12:30'), kind: 'break' as const },
    { id: 's3', from: at('12:30'), to: at('17:10'), kind: 'work' as const },
  ],
  events: [
    { id: 'e1', at: at('08:02'), kind: 'in' as const },
    { id: 'e2', at: at('17:10'), kind: 'manual' as const, label: 'reason: badge left at home', flagged: true },
  ],
  overlays: [{ id: 'o', name: 'Machine status', spans: [{ id: 'm1', from: at('09:00'), to: at('09:20'), label: 'Down', tone: 'danger' as const }] }],
  anomalies: [{ id: 'a1', label: 'Clock-out missing; automatic clock-out at 22:15' }],
}
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16)

describe('dayStrip geometry', () => {
  it('places moments and clips spans to the window', () => {
    expect(dayPct(W, at('14:00'))).toBe(50)
    expect(dayPct(W, at('03:00'))).toBe(0)
    expect(daySpan(W, at('05:00'), at('08:00'))).toEqual({ left: 0, width: 12.5 })
    expect(daySpan(W, at('22:30'), at('23:00'))).toBeNull()
    expect(daySpan(W, at('10:00'), at('09:00'))).toBeNull()
  })
  it('ticks fall on whole hours in the site zone, every step', () => {
    expect(dayTicks(W, 4, () => 0).map(hhmm)).toEqual(['06:00', '10:00', '14:00', '18:00', '22:00'])
    // A window starting at 06:15 in the zone: the first tick is the next whole hour.
    expect(dayTicks({ from: at('06:15'), to: at('09:00') }, 1, () => 15).map(hhmm)).toEqual(['07:00', '08:00', '09:00'])
    // A half-hour zone: the zone's minute decides, not UTC's.
    expect(dayTicks({ from: at('06:00'), to: at('08:00') }, 1, () => 30).map(hhmm)).toEqual(['06:30', '07:30'])
  })
})

describe('dayStripLines', () => {
  it('says the shift first, then everything in time order, anomalies without a time last', () => {
    expect(dayStripLines(DAY, DAY_STRIP_LABELS, hhmm)).toEqual([
      'Shift 08:00–17:00',
      'Worked 08:02–12:00',
      'Clock-in at 08:02',
      'Machine status: Down 09:00–09:20',
      'Break 12:00–12:30',
      'Worked 12:30–17:10',
      'Manual entry at 17:10 — reason: badge left at home — flagged for a check',
      'Anomaly: Clock-out missing; automatic clock-out at 22:15',
    ])
  })
})

describe('DayStrip', () => {
  it('hides the drawing from a screen reader and gives it the day as an ordered list', () => {
    const html = render(h(DayStrip, { label: 'Demo worker · 3 Nov', from: W.from, to: W.to, ...DAY, formatTime: hhmm }))
    expect(html).toContain('<figure')
    expect(html).toContain('Demo worker · 3 Nov')
    expect(html).toMatch(/class="nds-daystrip-visual" aria-hidden="true"/)
    expect(html).toContain('class="nds-vh"><ol><li>Shift 08:00–17:00</li>')
    expect(html).toContain('data-kind="break"')
    expect(html).toContain('data-untimed="true"')
    // The key names each kind drawn.
    expect(html).toMatch(/nds-daystrip-legend[\s\S]*Worked[\s\S]*Break/)
  })
  it('shows the day in words on screen when asked, in the host’s language', () => {
    const html = render(h(DayStrip, { label: 'x', from: W.from, to: W.to, segments: DAY.segments, formatTime: hhmm, showText: true, labels: { textTitle: 'La giornata a parole', kinds: { work: 'Lavorato', break: 'Pausa', absence: 'Assenza', overtime: 'Straordinario', idle: 'Nessuna scansione' } } }))
    expect(html).toContain('La giornata a parole')
    expect(html).toContain('Lavorato 08:02–12:00')
    expect(html).not.toContain('class="nds-vh"')
  })
})
