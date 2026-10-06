/**
 * CM-30 — the Budget Manager's limits drawer opens on each campaign's own Min/Max Budget (the grid's numbers); a limit
 * the older Budget Manager kept only on a month's plan is filled in and counted, so it is visible and one Save keeps it.
 */
import { describe, expect, it } from 'vitest'
import { initialLimitEdits } from './limitEdits'

describe('initialLimitEdits', () => {
  it('shows the campaign\'s own limits, in euros', () => {
    expect(initialLimitEdits([{ id: 'a', minCents: 150, maxCents: null }])).toEqual({ edits: { a: { min: '1.50', max: '' } }, oldCount: 0 })
  })

  it('fills in an old month limit only where the campaign has none, and counts it', () => {
    const out = initialLimitEdits([
      { id: 'a', minCents: null, maxCents: null, oldMonthLimit: { minCents: 400, maxCents: 1_200 } },
      { id: 'b', minCents: 200, maxCents: null, oldMonthLimit: { minCents: 900, maxCents: null } },
      { id: 'c', minCents: null, maxCents: null, oldMonthLimit: null },
    ])
    expect(out.edits).toEqual({ a: { min: '4.00', max: '12.00' }, b: { min: '2.00', max: '' }, c: { min: '', max: '' } })
    expect(out.oldCount).toBe(1)
  })
})
