import { describe, expect, it } from 'vitest'
import { CATALOGUE } from '../../../../lib/i18n/messages'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CALENDAR_STATES, DAY_KIND_OF, DAY_KINDS, dayInMonth, dayKinds, defaultDay, isIsoDay, isIsoMonth, itemsByDay, monthBounds, monthCounts, monthStep, moveMonth, worstState, type CalendarViewItem } from './model'

/** B-W2b-120 — CalendarView's pure rules (the Plant area part B-W2b-142 reads too): day kinds, the worst state, month moves. */

const item = (key: string, date: string, state: CalendarViewItem['state'], title = key): CalendarViewItem => ({ key, date, title, state })

describe('CalendarView: a day is drawn as its worst state', () => {
  it('overdue > due soon > to confirm > planned > done > cancelled', () => {
    expect(worstState(['DONE', 'PLANNED', 'DUE_SOON'])).toBe('DUE_SOON')
    expect(worstState(['TO_CONFIRM', 'PLANNED'])).toBe('TO_CONFIRM')
    expect(worstState(['CANCELLED', 'DONE'])).toBe('DONE')
    expect(worstState(['PLANNED', 'OVERDUE'])).toBe('OVERDUE')
    expect(worstState([])).toBeNull()
  })

  it('to confirm and planned share the info kind; a day to confirm is never drawn late', () => {
    expect(DAY_KIND_OF.TO_CONFIRM).toBe('planned')
    expect(DAY_KIND_OF.PLANNED).toBe('planned')
    expect(DAY_KIND_OF.OVERDUE).toBe('overdue')
    for (const state of CALENDAR_STATES) expect(DAY_KINDS).toContain(DAY_KIND_OF[state])
  })

  it('items per day, worst first then by title; the day kinds count them; a bad date is left out', () => {
    const days = itemsByDay([item('a', '2026-11-03', 'PLANNED', 'Zeta'), item('b', '2026-11-03', 'OVERDUE', 'Beta'), item('c', '2026-11-03', 'PLANNED', 'Alpha'), item('d', '2026-11-31', 'OVERDUE'), item('e', '2026-11-10', 'DONE')])
    expect(days.get('2026-11-03')?.map((entry) => entry.key)).toEqual(['b', 'c', 'a'])
    expect(days.has('2026-11-31')).toBe(false)
    expect(dayKinds(days)).toEqual({ '2026-11-03': { kind: 'overdue', worst: 'OVERDUE', count: 3 }, '2026-11-10': { kind: 'done', worst: 'DONE', count: 1 } })
  })

  it('the month counts only its own days', () => {
    const counts = monthCounts([item('a', '2026-11-03', 'OVERDUE'), item('b', '2026-12-01', 'OVERDUE'), item('c', '2026-11-30', 'TO_CONFIRM')], '2026-11')
    expect(counts).toMatchObject({ OVERDUE: 1, TO_CONFIRM: 1, PLANNED: 0 })
  })
})

describe('CalendarView: months and days', () => {
  it('moves across years both ways', () => {
    expect(moveMonth('2026-12', 1)).toBe('2027-01')
    expect(moveMonth('2026-01', -1)).toBe('2025-12')
    expect(moveMonth('2026-11', 13)).toBe('2027-12')
    expect(moveMonth('2026-11', -23)).toBe('2024-12')
  })

  it('a month runs from its first to its last day (a leap February too)', () => {
    expect(monthBounds('2026-11')).toEqual({ first: '2026-11-01', last: '2026-11-30' })
    expect(monthBounds('2028-02')).toEqual({ first: '2028-02-01', last: '2028-02-29' })
  })

  it('[ goes back, ] goes on; any other key nothing', () => {
    expect(monthStep('[')).toBe(-1)
    expect(monthStep(']')).toBe(1)
    expect(monthStep('j')).toBeNull()
  })

  it('days and months are checked', () => {
    expect(isIsoDay('2026-02-29')).toBe(false)
    expect(isIsoDay('2028-02-29')).toBe(true)
    expect(isIsoMonth('2026-13')).toBe(false)
    expect(isIsoMonth('2026-11')).toBe(true)
    expect(dayInMonth('2026-11-03', '2026-11')).toBe(true)
    expect(dayInMonth(null, '2026-11')).toBe(false)
  })

  it('the agenda opens on today in the month shown, else its first day with an item, else none', () => {
    const days = itemsByDay([item('a', '2026-12-09', 'PLANNED'), item('b', '2026-12-02', 'PLANNED')])
    expect(defaultDay('2026-11', '2026-11-03', days)).toBe('2026-11-03')
    expect(defaultDay('2026-12', '2026-11-03', days)).toBe('2026-12-02')
    expect(defaultDay('2027-01', '2026-11-03', days)).toBeNull()
  })
})

describe('CalendarView: its words', () => {
  it('every kind and the states it says itself exist in Italian and English', () => {
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['plant-calendar-view'] ?? {}
      for (const kind of [...DAY_KINDS, 'none']) expect(words[`kind.${kind}`], `${locale} kind.${kind}`).toBeTruthy()
      for (const key of ['state.TO_CONFIRM', 'state.CANCELLED', 'state.firstDay', 'state.dueOn', 'agenda.title', 'agenda.empty', 'agenda.pick', 'agenda.loading', 'agenda.reading', 'agenda.openItem', 'agenda.label', 'month.summary', 'grid.list', 'grid.listEmpty', 'day.count_one', 'day.andMore_other']) expect(words[key], `${locale} ${key}`).toBeTruthy()
    }
  })
})
