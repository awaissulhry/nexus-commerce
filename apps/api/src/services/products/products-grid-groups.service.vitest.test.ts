import { describe, expect, it } from 'vitest'

import { needsRollup, type GroupingRequest } from './products-grid-groups.service.js'

const level = (over: Partial<GroupingRequest> = {}): GroupingRequest => ({ groupColId: 'brand', aggregations: [], sort: { by: 'key', dir: 'asc' }, ...over })

describe('needsRollup — which path answers a grouped level', () => {
  it('a plain level (keys and counts) is a column groupBy: no product ids are read', () => {
    expect(needsRollup(level())).toBe(false)
    expect(needsRollup(level({ sort: { by: 'key', dir: 'desc' } }))).toBe(false)
  })
  it('a price aggregate is a column aggregate, and a count of anything is just a count', () => {
    expect(needsRollup(level({ aggregations: [{ colId: 'price', func: 'avg' }], sort: { by: 'price', dir: 'desc' } }))).toBe(false)
    expect(needsRollup(level({ aggregations: [{ colId: 'sales', func: 'count' }, { colId: 'available', func: 'count' }] }))).toBe(false)
  })
  it('Available, Sales and Units summed/averaged/bounded are roll-ups over an id set', () => {
    expect(needsRollup(level({ aggregations: [{ colId: 'available', func: 'sum' }] }))).toBe(true)
    expect(needsRollup(level({ aggregations: [{ colId: 'sales', func: 'max' }] }))).toBe(true)
    expect(needsRollup(level({ aggregations: [{ colId: 'price', func: 'avg' }, { colId: 'units', func: 'avg' }] }))).toBe(true)
  })
})
