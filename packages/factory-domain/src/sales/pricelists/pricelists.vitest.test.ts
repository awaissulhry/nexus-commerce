import { describe, expect, it } from 'vitest'
import {
  activationPlan,
  changedRows,
  compareEntries,
  endProblems,
  entryProblems,
  inForceOn,
  listFieldProblems,
  listPriceOnBasis,
  listStateOf,
  listTiles,
  marginPctOf,
  priceFrom,
  raiseByPct,
  raiseProblems,
  type VersionFacts,
} from './pricelists'

const v = (id: string, revision: number, status: 'DRAFT' | 'ACTIVE', validFrom: string | null, validTo: string | null = null): VersionFacts => ({ id, revision, status, validFrom, validTo })
const TODAY = '2026-10-30'

describe('versions in force and the list state (SAL-165)', () => {
  const versions = [v('v1', 1, 'ACTIVE', '2026-01-01', '2026-09-30'), v('v2', 2, 'ACTIVE', '2026-10-01'), v('v3', 3, 'DRAFT', '2027-01-01')]

  it('finds the version in force on a day', () => {
    expect(inForceOn(versions, '2026-05-01')?.id).toBe('v1')
    expect(inForceOn(versions, '2026-09-30')?.id).toBe('v1')
    expect(inForceOn(versions, '2026-10-01')?.id).toBe('v2')
    expect(inForceOn(versions, '2025-12-31')).toBeNull()
    expect(inForceOn([v('d', 1, 'DRAFT', '2026-01-01')], TODAY)).toBeNull()
  })

  it('names the list state', () => {
    expect(listStateOf('ACTIVE', versions, TODAY)).toBe('IN_FORCE')
    expect(listStateOf('ACTIVE', [v('a', 1, 'ACTIVE', '2026-12-01')], TODAY)).toBe('SCHEDULED')
    expect(listStateOf('ACTIVE', [v('a', 1, 'ACTIVE', '2026-01-01', '2026-06-30')], TODAY)).toBe('EXPIRED')
    expect(listStateOf('ACTIVE', [v('d', 1, 'DRAFT', null)], TODAY)).toBe('DRAFT')
    expect(listStateOf('ARCHIVED', versions, TODAY)).toBe('ARCHIVED')
  })

  it('counts the tiles: starting and ending within 30 days', () => {
    expect(listTiles([v('a', 1, 'ACTIVE', '2026-10-01', '2026-11-15'), v('b', 2, 'ACTIVE', '2026-11-16')], TODAY)).toEqual({ startsSoon: true, endsSoon: true })
    expect(listTiles([v('a', 1, 'ACTIVE', '2026-10-01'), v('b', 2, 'ACTIVE', '2027-03-01')], TODAY)).toEqual({ startsSoon: false, endsSoon: false })
  })
})

describe('activating a draft: the version before ends the day before', () => {
  it('ends the version in force at the new start', () => {
    const versions = [v('v1', 1, 'ACTIVE', '2026-10-01'), v('v2', 2, 'DRAFT', null)]
    expect(activationPlan(versions, 'v2', '2026-11-01', null, TODAY)).toEqual({ ok: true, plan: { end: { id: 'v1', revision: 1, validTo: '2026-10-31' } } })
    expect(activationPlan([v('v1', 1, 'ACTIVE', '2026-01-01', '2026-06-30'), v('v2', 2, 'DRAFT', null)], 'v2', TODAY, null, TODAY)).toEqual({ ok: true, plan: { end: null } })
  })

  it('refuses a past start, an active version, and cutting away a later one', () => {
    expect(activationPlan([v('v2', 2, 'DRAFT', null)], 'v2', '2026-10-29', null, TODAY)).toMatchObject({ ok: false, issues: [{ path: 'validFrom' }] })
    expect(activationPlan([v('v1', 1, 'ACTIVE', '2026-10-01')], 'v1', TODAY, null, TODAY)).toMatchObject({ ok: false, issues: [{ path: 'version' }] })
    const later = activationPlan([v('v1', 1, 'ACTIVE', '2026-12-01'), v('v2', 2, 'DRAFT', null)], 'v2', '2026-11-01', null, TODAY)
    expect(later).toMatchObject({ ok: false, issues: [{ path: 'validFrom', message: 'Version 1 is active from 2026-12-01: start this one later, or end it before 2026-12-01 and start this one after it.' }] })
    // A version that ends before the later one starts fits in the gap.
    expect(activationPlan([v('v1', 1, 'ACTIVE', '2026-12-01'), v('v2', 2, 'DRAFT', null)], 'v2', '2026-11-01', '2026-11-30', TODAY)).toEqual({ ok: true, plan: { end: null } })
    expect(activationPlan([v('v2', 2, 'DRAFT', null)], 'v2', '2026-11-10', '2026-11-01', TODAY)).toMatchObject({ ok: false, issues: [{ path: 'validTo' }] })
  })

  it("ends an active version from yesterday on, never into the next one", () => {
    const versions = [v('v1', 1, 'ACTIVE', '2026-01-01', '2026-11-30'), v('v2', 2, 'ACTIVE', '2026-12-01')]
    expect(endProblems(versions[0]!, '2026-11-15', TODAY, versions)).toEqual([])
    expect(endProblems(versions[0]!, '2026-12-15', TODAY, versions)).toMatchObject([{ message: 'Version 2 starts on 2026-12-01: end this one before it.' }])
    expect(endProblems(versions[0]!, null, TODAY, versions)).toMatchObject([{ path: 'validTo' }])
    expect(endProblems(versions[1]!, '2026-10-01', TODAY, versions)).toMatchObject([{ path: 'validTo' }])
    expect(endProblems(versions[0]!, '2026-10-01', TODAY, versions)).toMatchObject([{ message: 'An active version ends yesterday (2026-10-29) at the earliest: what was in force stays as it was.' }])
    expect(endProblems(v('d', 3, 'DRAFT', null), '2026-12-01', TODAY, versions)).toHaveLength(1)
  })
})

describe('prices', () => {
  const chain = [
    { listId: 'P1', versionId: 'p1v1', entries: [{ styleId: 'JKT', colourwayId: null, unitPrice: '420.000000' }, { styleId: 'JKT', colourwayId: 'RED', unitPrice: '430.000000' }] },
    { listId: 'BASE', versionId: 'b1', entries: [{ styleId: 'JKT', colourwayId: null, unitPrice: '450' }, { styleId: 'JKT2', colourwayId: null, unitPrice: '410' }] },
  ]

  it("reads the colourway's price, else the style's, else the list it falls back to", () => {
    expect(priceFrom(chain, 'JKT', 'RED')).toEqual({ unitPrice: '430', listId: 'P1', versionId: 'p1v1', colourwayPrice: true, depth: 0 })
    expect(priceFrom(chain, 'JKT', 'BLK')).toEqual({ unitPrice: '420', listId: 'P1', versionId: 'p1v1', colourwayPrice: false, depth: 0 })
    expect(priceFrom(chain, 'JKT2', 'BLK')).toEqual({ unitPrice: '410', listId: 'BASE', versionId: 'b1', colourwayPrice: false, depth: 1 })
    expect(priceFrom(chain, 'NONE', 'BLK')).toBeNull()
    expect(priceFrom([{ listId: 'P1', versionId: null, entries: [] }, chain[1]!], 'JKT', 'RED')).toMatchObject({ unitPrice: '450', depth: 1 })
  })

  it("puts a net list price on a consumer's VAT-inclusive basis", () => {
    expect(listPriceOnBasis('420.000000', 'NET', '22.00')).toBe('420')
    expect(listPriceOnBasis('420', 'GROSS', '22.00')).toBe('512.4')
    expect(listPriceOnBasis('99.99', 'GROSS', null)).toBe('99.99')
  })

  it('raises by a percent to the minor unit, and checks the percent', () => {
    expect(raiseByPct('420', '5', 'EUR')).toBe('441')
    expect(raiseByPct('435', '5', 'EUR')).toBe('456.75')
    expect(raiseByPct('99.99', '-3', 'EUR')).toBe('96.99')
    expect(raiseProblems('5')).toEqual([])
    expect(raiseProblems('-100')).toHaveLength(1)
    expect(raiseProblems('x')).toHaveLength(1)
  })

  it('gives the margin at a cost, none without one', () => {
    expect(marginPctOf('420', '281.031')).toBe('33.0879')
    expect(marginPctOf('420', null)).toBeNull()
    expect(marginPctOf('0', '10')).toBeNull()
  })

  it('checks a change of prices: above 0, at most 6 places, one row per style and colourway', () => {
    expect(entryProblems([{ styleId: 'a', colourwayId: null, unitPrice: '1.5' }, { styleId: 'a', colourwayId: 'r', unitPrice: null }])).toEqual([])
    expect(entryProblems([{ styleId: 'a', colourwayId: null, unitPrice: '0' }, { styleId: 'a', colourwayId: null, unitPrice: '1.1234567' }]).map((issue) => issue.path)).toEqual(['entries/0/unitPrice', 'entries/1', 'entries/1/unitPrice'])
    expect(entryProblems([])).toHaveLength(1)
  })

  it('compares two versions row by row', () => {
    const rows = compareEntries(
      [{ styleId: 'JKT', colourwayId: null, unitPrice: '420' }, { styleId: 'JKT', colourwayId: 'RED', unitPrice: '430' }, { styleId: 'OLD', colourwayId: null, unitPrice: '100' }],
      [{ styleId: 'JKT', colourwayId: null, unitPrice: '435' }, { styleId: 'JKT', colourwayId: 'RED', unitPrice: '430.000000' }, { styleId: 'NEW', colourwayId: null, unitPrice: '50' }],
    )
    expect(rows).toEqual([
      { styleId: 'JKT', colourwayId: null, before: '420', after: '435', change: 'CHANGED', changePct: '3.57' },
      { styleId: 'JKT', colourwayId: 'RED', before: '430', after: '430', change: 'SAME', changePct: '0' },
      { styleId: 'OLD', colourwayId: null, before: '100', after: null, change: 'REMOVED', changePct: null },
      { styleId: 'NEW', colourwayId: null, before: null, after: '50', change: 'ADDED', changePct: null },
    ])
    expect(changedRows(rows)).toBe(3)
  })

  it("checks a list's plain fields", () => {
    expect(listFieldProblems({ code: 'seed-pl-p1', name: 'Listino', currency: 'EUR' })).toEqual([])
    expect(listFieldProblems({ code: '!', name: ' ', currency: 'euro' }).map((issue) => issue.path)).toEqual(['code', 'name', 'currency'])
  })
})
