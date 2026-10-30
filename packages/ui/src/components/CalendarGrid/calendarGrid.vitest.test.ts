import { readFileSync } from 'node:fs'
import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CalendarGrid } from './CalendarGrid'
import {
  CALENDAR_GRID_WORDS,
  addDays,
  addMonths,
  addMonthsToDay,
  baseKindId,
  calendarKeyStep,
  capitalise,
  dayInfo,
  dayName,
  daysBetween,
  exceptionsIn,
  fill,
  focusIn,
  isIsoDay,
  isIsoMonth,
  kindCounts,
  legendCount,
  monthWeeks,
  moveDay,
  patternOf,
  periodDays,
  rangeOf,
  rangeSentence,
  shownAfter,
  weekdayOf,
  type CalendarDay,
  type CalendarKind,
} from './calendarGridModel'

const kinds: CalendarKind[] = [
  { id: 'work', label: 'Working day' },
  { id: 'weekend', label: 'Weekend', tone: 'neutral', off: true },
  { id: 'holiday', label: 'Public holiday', tone: 'danger', off: true },
  { id: 'closure', label: 'Closure', tone: 'warning', off: true },
  { id: 'extra', label: 'Extra shift', tone: 'success', pattern: 'dots' },
  { id: 'short', label: 'Short day', tone: 'info', pattern: 'stripe' },
]
const weekKinds = ['work', 'work', 'work', 'work', 'work', 'weekend', 'weekend']
const days: Record<string, CalendarDay> = {
  '2026-08-15': { kind: 'holiday', reason: 'Ferragosto' },
  '2026-08-10': { kind: 'closure', reason: 'Summer closure' },
  '2026-08-11': { kind: 'closure', reason: 'Summer closure' },
  '2026-08-22': { kind: 'extra', detail: '06:00–12:00' },
  '2026-08-24': { kind: 'work' },
  '2026-12-08': { kind: 'holiday', reason: 'Immacolata Concezione' },
}
const input = { kinds, days, weekKinds }

describe('ISO days on UTC midnights', () => {
  it('reads real days only, and months', () => {
    expect(isIsoDay('2026-02-28')).toBe(true)
    expect(isIsoDay('2026-02-29')).toBe(false)
    expect(isIsoDay('2028-02-29')).toBe(true)
    expect(isIsoDay('2026-13-01')).toBe(false)
    expect(isIsoDay('26-01-01')).toBe(false)
    expect(isIsoMonth('2026-08')).toBe(true)
    expect(isIsoMonth('2026-00')).toBe(false)
  })

  it('adds days across months, years and the summer-time change without drift', () => {
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30')
    expect(addDays('2026-10-24', 2)).toBe('2026-10-26')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(daysBetween('2026-08-10', '2026-08-21')).toBe(11)
    expect(weekdayOf('2026-08-15')).toBe(6)
  })

  it('adds months, clamping the day to a shorter month', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01')
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(addMonths('2026-05', -17)).toBe('2024-12')
    expect(addMonthsToDay('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonthsToDay('2028-03-31', -1)).toBe('2028-02-29')
  })

  it('lays a month out in weeks from Monday (or Sunday), null outside the month', () => {
    const weeks = monthWeeks('2026-08')
    // 1 August 2026 is a Saturday.
    expect(weeks[0]).toEqual([null, null, null, null, null, '2026-08-01', '2026-08-02'])
    expect(weeks.at(-1)).toEqual(['2026-08-31', null, null, null, null, null, null])
    expect(weeks).toHaveLength(6)
    expect(monthWeeks('2026-08', 0)[0]).toEqual([null, null, null, null, null, null, '2026-08-01'])
    expect(monthWeeks('2021-02')).toHaveLength(4)
    expect(monthWeeks('2026-02')).toHaveLength(5)
    expect(periodDays('year', '2026-05')).toHaveLength(365)
    expect(periodDays('month', '2028-02')).toHaveLength(29)
  })
})

describe('day kinds', () => {
  it('a day takes its own entry, else the weekly pattern, else nothing is known', () => {
    expect(baseKindId('2026-08-15', weekKinds)).toBe('weekend')
    expect(baseKindId('2026-08-17', weekKinds)).toBe('work')
    expect(dayInfo('2026-08-15', input)).toMatchObject({ kind: { id: 'holiday' }, reason: 'Ferragosto', exception: true })
    expect(dayInfo('2026-08-17', input)).toMatchObject({ kind: { id: 'work' }, reason: null, exception: false })
    // The same kind as the pattern and nothing more: not an exception.
    expect(dayInfo('2026-08-24', input).exception).toBe(false)
    // Without a weekly pattern a day without an entry is not known — never taken for a working day.
    expect(dayInfo('2026-08-17', { kinds, days }).kind).toBeNull()
    // A kind the key lacks is not known either.
    expect(dayInfo('2026-08-03', { kinds, days: { '2026-08-03': { kind: 'gone' } } }).kind).toBeNull()
  })

  it('a day off is hatched unless its kind names a pattern', () => {
    expect(patternOf(kinds[1])).toBe('hatch')
    expect(patternOf(kinds[0])).toBe('plain')
    expect(patternOf(kinds[4])).toBe('dots')
    expect(patternOf(null)).toBe('plain')
  })

  it('the list twin holds the days that differ from the pattern, in order, inside the period', () => {
    expect(exceptionsIn('month', '2026-08', input).map((d) => d.date)).toEqual(['2026-08-10', '2026-08-11', '2026-08-15', '2026-08-22'])
    expect(exceptionsIn('year', '2026-01', input).map((d) => d.date)).toContain('2026-12-08')
    expect(exceptionsIn('month', '2026-09', input)).toEqual([])
  })

  it('counts each kind over the period (the key)', () => {
    const counts = kindCounts('month', '2026-08', input)
    expect(counts.get('holiday')).toBe(1)
    expect(counts.get('closure')).toBe(2)
    expect(counts.get('extra')).toBe(1)
    // 31 days: 10 weekend days, of which Sat 15 is the holiday and Sat 22 the extra shift.
    expect(counts.get('weekend')).toBe(8)
    expect(counts.get('work')).toBe(31 - 8 - 1 - 2 - 1)
  })
})

describe('keyboard', () => {
  it('arrows by day and week, Home / End to the week, Page Up / Down by month; right-to-left swaps left and right', () => {
    expect(moveDay('2026-08-12', 'ArrowRight')).toBe('2026-08-13')
    expect(moveDay('2026-08-12', 'ArrowLeft')).toBe('2026-08-11')
    expect(moveDay('2026-08-12', 'ArrowDown')).toBe('2026-08-19')
    expect(moveDay('2026-08-12', 'ArrowUp')).toBe('2026-08-05')
    expect(moveDay('2026-08-12', 'Home')).toBe('2026-08-10')
    expect(moveDay('2026-08-12', 'End')).toBe('2026-08-16')
    expect(moveDay('2026-08-12', 'Home', 0)).toBe('2026-08-09')
    expect(moveDay('2026-08-31', 'PageDown')).toBe('2026-09-30')
    expect(moveDay('2026-08-12', 'ArrowRight', 1, 'rtl')).toBe('2026-08-11')
  })

  it('Shift extends a range from where it started; a plain move lets it go; read-only refuses it', () => {
    const one = calendarKeyStep({ focus: '2026-08-10', anchor: null }, 'ArrowRight', true)
    expect(one).toEqual({ state: { focus: '2026-08-11', anchor: '2026-08-10' }, range: { from: '2026-08-10', to: '2026-08-11' }, held: false })
    const two = calendarKeyStep(one.state, 'ArrowDown', true)
    expect(two.range).toEqual({ from: '2026-08-10', to: '2026-08-18' })
    const back = calendarKeyStep({ focus: '2026-08-10', anchor: '2026-08-12' }, 'ArrowLeft', true)
    expect(back.range).toEqual({ from: '2026-08-09', to: '2026-08-12' })
    expect(calendarKeyStep(two.state, 'ArrowRight', false)).toEqual({ state: { focus: '2026-08-19', anchor: null }, range: null, held: false })
    expect(calendarKeyStep({ focus: '2026-08-10', anchor: null }, 'ArrowRight', true, { held: true })).toEqual({ state: { focus: '2026-08-11', anchor: null }, range: null, held: true })
  })

  it('the view follows the focus into another month or year; the focus lands on a kept day, today, or the 1st', () => {
    expect(shownAfter('month', '2026-08', '2026-09-01')).toBe('2026-09')
    expect(shownAfter('month', '2026-08', '2026-08-31')).toBe('2026-08')
    expect(shownAfter('year', '2026-08', '2026-12-31')).toBe('2026-08')
    expect(shownAfter('year', '2026-08', '2027-01-01')).toBe('2027-01')
    expect(focusIn('month', '2026-08', '2026-08-20', '2026-08-03')).toBe('2026-08-20')
    expect(focusIn('month', '2026-08', '2026-07-20', '2026-08-03')).toBe('2026-08-03')
    expect(focusIn('month', '2026-09', null, '2026-08-03')).toBe('2026-09-01')
    expect(focusIn('year', '2026-09', null, null)).toBe('2026-01-01')
  })
})

describe('words', () => {
  const w = CALENDAR_GRID_WORDS
  it('fills placeholders and leaves a missing one in view', () => {
    expect(fill('{a} and {b}', { a: 1 })).toBe('1 and {b}')
  })

  it('a day is named with its date, kind, reason, detail, today and selection', () => {
    const info = dayInfo('2026-08-15', input)
    expect(dayName(w, { info, date: 'Saturday 15 August 2026', today: false, selected: false })).toBe('Saturday 15 August 2026, Public holiday: Ferragosto')
    const extra = dayInfo('2026-08-22', input)
    expect(dayName(w, { info: extra, date: 'Saturday 22 August 2026', today: true, selected: true })).toBe('Saturday 22 August 2026, Extra shift. 06:00–12:00. Today. Selected')
    expect(dayName(w, { info: dayInfo('2026-08-17', { kinds }), date: 'Monday 17 August 2026', today: false, selected: false })).toBe('Monday 17 August 2026')
  })

  it('a range is said with its days, one or many', () => {
    const format = (iso: string) => iso.slice(8)
    expect(rangeSentence(w, rangeOf('2026-08-14', '2026-08-10'), format, false)).toBe('Selecting 10 to 14: 5 days.')
    expect(rangeSentence(w, rangeOf('2026-08-10', '2026-08-10'), format, true)).toBe('10 selected: 1 day.')
    expect(legendCount(w, 'Closure', 1)).toBe('Closure: 1 day')
    expect(legendCount(w, 'Closure', 2)).toBe('Closure: 2 days')
    expect(capitalise('agosto 2026', 'it-IT')).toBe('Agosto 2026')
  })
})

describe('CalendarGrid markup', () => {
  const base = { label: 'Calendar · Site A', kinds, days, weekKinds, today: '2026-08-12', defaultMonth: '2026-08', onDayOpen: () => {}, onRangeSelect: () => {} }

  it('a month is a grid with weekday heads, one Tab stop on today, every day named in words', () => {
    const out = render(h(CalendarGrid, base))
    expect(out).toMatch(/<section[^>]*aria-label="Calendar · Site A"/)
    expect(out).toMatch(/<table role="grid"[^>]*aria-multiselectable="true"/)
    expect(out).toContain('abbr="Monday"')
    expect(out).toContain('>Mon</th>')
    expect(out.match(/data-cal-date="[^"]+" [^>]*tabindex="0"/g)).toHaveLength(1)
    expect(out).toMatch(/data-cal-date="2026-08-12"[^>]*tabindex="0"[^>]*aria-label="Wednesday, 12 August 2026, Working day. Today"[^>]*aria-current="date"/)
    expect(out).toContain('aria-label="Saturday, 15 August 2026, Public holiday: Ferragosto"')
    expect(out).toMatch(/data-cal-date="2026-08-15"[^>]*data-tone="danger"[^>]*data-pattern="hatch"/)
    // An exception shows its kind and reason in words; a base weekend only its pattern.
    expect(out).toContain('<span class="nds-cal-kind">Public holiday</span><span class="nds-cal-reason">Ferragosto</span>')
    expect(out).toMatch(/data-cal-date="2026-08-16"[^>]*><span class="nds-cal-day-in"><span class="nds-cal-num">16<\/span><\/span>/)
    expect(out).toContain('<span class="nds-cal-today">Today</span>')
    // One live region, mounted at rest; the instructions describe the grid.
    expect(out.match(/role="status"/g)).toHaveLength(1)
    expect(out).toContain(CALENDAR_GRID_WORDS.instructions)
    expect(out).toContain('August 2026')
  })

  it('the key names each kind with its count, and today', () => {
    const out = render(h(CalendarGrid, base))
    expect(out).toMatch(/role="group" aria-label="Key"/)
    expect(out).toContain('Public holiday: 1 day')
    expect(out).toContain('Closure: 2 days')
    expect(out).toMatch(/nds-cal-legend-item is-today/)
  })

  it('a range drawn: its days selected in the grid and in their names', () => {
    const out = render(h(CalendarGrid, { ...base, defaultRange: { from: '2026-08-10', to: '2026-08-14' } }))
    expect(out.match(/aria-selected="true"/g)).toHaveLength(5)
    expect(out).toContain('aria-label="Monday, 10 August 2026, Closure: Summer closure. Selected"')
  })

  it('no range without onRangeSelect: no multi-select, no selected state', () => {
    const out = render(h(CalendarGrid, { ...base, onRangeSelect: undefined }))
    expect(out).not.toContain('aria-multiselectable')
    expect(out).not.toContain('aria-selected')
  })

  it('read-only: drawn the same, the reason said at rest and describing the grid; no control is disabled', () => {
    const out = render(h(CalendarGrid, { ...base, heldReason: 'You need Planning settings to change calendars.' }))
    expect(out).toContain('nds-cal-held')
    expect(out).toContain('You need Planning settings to change calendars.')
    expect(out).toMatch(/aria-describedby="[^"]+-help [^"]+-held"/)
    expect(out).not.toMatch(/\sdisabled=""/)
  })

  it('loading: the given days drawn first, the others skeletons; no counts yet', () => {
    const out = render(h(CalendarGrid, { ...base, loading: true }))
    expect(out).toMatch(/aria-busy="true"/)
    expect(out).toContain('aria-label="Saturday, 15 August 2026, Public holiday: Ferragosto"')
    expect(out).toContain('aria-label="Monday, 17 August 2026"')
    expect(out).toContain('nds-skeleton')
    expect(out).not.toContain('Closure: 2 days')
    expect(out).toContain(CALENDAR_GRID_WORDS.loading)
  })

  it('a year: twelve small months, each its own grid named by its month, Open month buttons, one Tab stop', () => {
    const out = render(h(CalendarGrid, { ...base, defaultView: 'year' }))
    expect(out.match(/<table role="grid"/g)).toHaveLength(12)
    expect(out.match(/data-cal-date="[^"]+" [^>]*tabindex="0"/g)).toHaveLength(1)
    expect(out).toContain('aria-label="Open December 2026"')
    expect(out).toContain('aria-label="Tuesday, 8 December 2026, Public holiday: Immacolata Concezione"')
    expect(out).toContain('aria-label="Previous year"')
    expect(out).toContain('>2026</span>')
  })

  it('the list twin: the days that differ, grouped by month, each with Open; an empty period says so', () => {
    const out = render(h(CalendarGrid, { ...base, defaultLayout: 'list' }))
    expect(out).not.toContain('role="grid"')
    expect(out).toContain('Days that differ from the weekly pattern')
    expect(out).toContain('Saturday, 15 August 2026')
    expect(out).toContain('Public holiday: Ferragosto')
    expect(out).toContain('aria-label="Open Saturday, 15 August 2026"')
    expect(out.match(/class="nds-cal-list-day[" ]/g)).toHaveLength(4)
    const none = render(h(CalendarGrid, { ...base, defaultLayout: 'list', defaultMonth: '2026-09' }))
    expect(none).toContain('Every day of September 2026 follows the weekly pattern.')
  })

  it('names months and weekdays in the page language; words come from the app', () => {
    const out = render(h(CalendarGrid, { ...base, locale: 'it-IT', words: { todayMark: 'Oggi', legend: 'Legenda' } }))
    expect(out).toContain('Agosto 2026')
    expect(out).toContain('abbr="lunedì"')
    expect(out).toContain('aria-label="Sabato 15 agosto 2026, Public holiday: Ferragosto"')
    expect(out).toContain('<span class="nds-cal-today">Oggi</span>')
    expect(out).toMatch(/aria-label="Legenda"/)
  })

  it('Sunday first when asked', () => {
    const out = render(h(CalendarGrid, { ...base, weekStartsOn: 0 }))
    expect(out.indexOf('abbr="Sunday"')).toBeLessThan(out.indexOf('abbr="Monday"'))
  })
})

describe('calendar-grid.css', () => {
  const css = readFileSync(new URL('./calendar-grid.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

  it('semantic tokens only: no raw colour, no numbered ramp', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(css).not.toMatch(/var\(--nds-(grey|blue|green|red|amber|purple|cyan)-[0-9]/)
    expect(css).not.toMatch(/rgba?\(/)
  })

  it('a day off is hatched, the other patterns drawn, and motion can be reduced', () => {
    expect(css).toMatch(/\[data-pattern='hatch'\] \{[^}]*repeating-linear-gradient/)
    expect(css).toMatch(/\[data-pattern='dots'\] \{[^}]*radial-gradient/)
    expect(css).toMatch(/\[data-pattern='stripe'\] \{[^}]*box-shadow/)
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })
})

describe('Commerce pages do not carry the calendar', () => {
  it('the components barrel does not re-export this folder; it is its own entry point', () => {
    const barrel = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const code = barrel.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).not.toMatch(/CalendarGrid/)
    const entry = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    expect(entry).toMatch(/export \{ CalendarGrid/)
  })

  it("no shared stylesheet carries the calendar's rules", () => {
    for (const sheet of ['primitives.css', 'components.css', 'patterns.css', 'a11y.css']) {
      const text = readFileSync(new URL(`../../styles/${sheet}`, import.meta.url), 'utf8')
      expect(text, sheet).not.toMatch(/calendar-grid|nds-cal-/)
    }
  })
})
