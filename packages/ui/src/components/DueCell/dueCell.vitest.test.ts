import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DueCell, DueCellRenderer, dueWords } from './DueCell'
import { DUE_CELL_LABELS } from './DueCellLabels'
import { dueComparator, dueDay, dueStatus, localToday } from './dueCellModel'

/** B-W2b-28 — DueCell: a due date as a tone and words, sorted by urgency. */
const today = '2026-11-03'

describe('dueStatus', () => {
  it('reads overdue, soon (today included), valid, needed, done and none', () => {
    expect(dueStatus('2026-10-31', { today })).toEqual({ tone: 'overdue', days: -3 })
    expect(dueStatus('2026-11-03', { today })).toEqual({ tone: 'soon', days: 0 })
    expect(dueStatus({ due: '2026-11-15' }, { today })).toEqual({ tone: 'soon', days: 12 })
    expect(dueStatus('2027-03-12', { today })).toMatchObject({ tone: 'valid' })
    expect(dueStatus({ due: '2026-11-15' }, { today, soonDays: 7 })).toMatchObject({ tone: 'valid' })
    expect(dueStatus({ state: 'needed' }, { today })).toEqual({ tone: 'needed', days: null })
    expect(dueStatus({ state: 'done', due: '2026-01-01' }, { today })).toEqual({ tone: 'done', days: null })
    expect(dueStatus(null, { today })).toEqual({ tone: 'none', days: null })
  })
  it('counts calendar days with no clock: an ISO instant uses its date, a DST change does not shift a day, a bad date is none', () => {
    expect(dueStatus('2026-11-04T23:30:00+01:00', { today })).toMatchObject({ days: 1 })
    expect(dueStatus('2027-03-29', { today: '2027-03-27' })).toMatchObject({ days: 2 })
    expect(dueDay('2026-02-30')).toBeNull()
    expect(dueStatus('soon', { today }).tone).toBe('none')
    expect(localToday(new Date(2026, 10, 3, 23, 59))).toBe('2026-11-03')
  })
})

describe('dueComparator', () => {
  it('sorts most urgent first: most overdue, needed, soonest, valid, done, none', () => {
    const values = [null, { state: 'done' }, '2027-03-12', '2026-11-15', { state: 'needed' }, '2026-10-31', '2026-09-01', '2026-11-03']
    const sorted = [...values].sort(dueComparator({ today }))
    expect(sorted).toEqual(['2026-09-01', '2026-10-31', { state: 'needed' }, '2026-11-03', '2026-11-15', '2027-03-12', { state: 'done' }, null])
  })
})

describe('DueCell', () => {
  const fmt = (d: string) => `[${d}]`
  it('says each tone in words', () => {
    const w = (v: unknown) => dueWords(dueStatus(v, { today }), v, DUE_CELL_LABELS, fmt)
    expect(w('2026-10-31')).toBe('Overdue by 3 days')
    expect(w('2026-11-02')).toBe('Overdue by 1 day')
    expect(w('2026-11-03')).toBe('Due today')
    expect(w('2026-11-04')).toBe('Due tomorrow')
    expect(w('2026-11-15')).toBe('Due in 12 days')
    expect(w('2027-03-12')).toBe('Valid until [2027-03-12]')
    expect(w({ state: 'needed' })).toBe('Needed')
    expect(w({ state: 'done', doneOn: '2026-11-01T10:00:00Z' })).toBe('Done [2026-11-01]')
    expect(w({ state: 'done' })).toBe('Done')
    expect(w(undefined)).toBe('—')
  })
  it('draws an icon and the words with the tone; the grid renderer passes its params through', () => {
    const html = render(h(DueCell, { value: '2026-10-31', today }))
    expect(html).toContain('data-tone="overdue"')
    expect(html).toContain('<svg')
    expect(html).toContain('Overdue by 3 days')
    expect(render(h(DueCell, { value: '2027-03-12', today }))).toContain('Valid until 12 Mar 2027')
    expect(render(h(DueCellRenderer, { value: { state: 'needed' }, today, labels: { needed: 'Da fare' } }))).toContain('Da fare')
  })
})
