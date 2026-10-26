/**
 * Negative Targeting page — the tables' start state (waste/gridStart.ts): the columns hidden by default stay hidden on
 * a first visit (with or without a sort), a person's saved layout wins whole, the phone starts bare.
 */
import { describe, expect, it } from 'vitest'
import { STOPPED_COLUMN_SPECS, WASTE_COLUMN_SPECS } from './columns'
import { WORD_COLUMN_SPECS } from '../words/wordColumns'
import { gridStartState } from './gridStart'

const hiddenOf = (specs: ReadonlyArray<{ key: string; hidden?: boolean }>) => specs.filter((c) => c.hidden).map((c) => c.key)

describe('gridStartState', () => {
  it('a first visit names every hidden column, a sort or not (AG would show them all otherwise)', () => {
    expect(gridStartState({ saved: undefined, hidden: ['impressions', 'acos'], sort: null, phone: false })).toEqual({ columnVisibility: { hiddenColIds: ['impressions', 'acos'] } })
    expect(gridStartState({ saved: null, hidden: ['impressions'], sort: { colId: 'spend', dir: 'desc' }, phone: false }))
      .toEqual({ columnVisibility: { hiddenColIds: ['impressions'] }, sort: { sortModel: [{ colId: 'spend', sort: 'desc' }] } })
  })
  it('a person\'s saved layout wins whole (a column they showed stays shown); the address\'s sort goes on top', () => {
    const saved = { columnVisibility: { hiddenColIds: ['cpc'] }, columnSizing: { columnSizingModel: [{ colId: 'term', width: 300 }] } }
    expect(gridStartState({ saved, hidden: ['impressions', 'cpc'], sort: null, phone: false })).toEqual(saved)
    expect(gridStartState({ saved: { columnOrder: { orderedColIds: ['term'] } }, hidden: ['impressions'], sort: { colId: 'term', dir: 'asc' }, phone: false }))
      .toEqual({ columnOrder: { orderedColIds: ['term'] }, sort: { sortModel: [{ colId: 'term', sort: 'asc' }] } })
  })
  it('the phone starts bare (three columns, no desktop layout)', () => {
    expect(gridStartState({ saved: { columnVisibility: { hiddenColIds: ['x'] } }, hidden: ['impressions'], sort: null, phone: true })).toEqual({})
  })
  it('the three tables each hide what their own registry hides', () => {
    expect(hiddenOf(WASTE_COLUMN_SPECS)).toEqual(['impressions', 'acos', 'cpc', 'spend90', 'trend', 'stockOut', 'stillServes'])
    expect(hiddenOf(STOPPED_COLUMN_SPECS)).toContain('stillServes')
    expect(hiddenOf(WORD_COLUMN_SPECS)).toEqual(['impressions', 'acos', 'cpc', 'sold', 'stockOut'])
  })
})
