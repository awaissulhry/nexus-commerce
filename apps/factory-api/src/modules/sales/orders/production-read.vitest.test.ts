import { describe, expect, it } from 'vitest'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { alsoMakesOf, BLOCKER_WORDS, daysBetween, inWorkPiecesOf, mtmGroupsOf, ownShareOf, partsOf, sumOrNull, withheldOf, type OtherOrder } from './production-read'
import { BLOCKER_KINDS } from '@nexus/factory-domain/production-brand/waiting'

/**
 * B-SA-031 / B-SA-032 — the office's read of one order's production, its pure parts (the PG suite production-read.pg.vitest.test.ts
 * proves the reads): the parts asked, what is withheld by right, "also makes" (only this customer's orders named, the rest of them
 * counted, another customer's never named nor counted), made-to-measure units grouped per style × colourway, the order's own share
 * of a work order, and what is in work as counts. Every id and name is made up (Brand Alpha, Brand Beta).
 */

const ALPHA = '11111111-1111-4111-8111-111111111111'
const BETA = '22222222-2222-4222-8222-222222222222'
const order = (number: string, partyId: string, companyId = 'c1'): OtherOrder => ({ id: `id-${number}`, number, companyId, partyId })

describe('partsOf: the parts a read asks', () => {
  it('reads every part when none is named, keeps the contract’s order, and refuses an unknown part in words', () => {
    expect(partsOf(undefined)).toEqual(['headline', 'lines', 'work', 'dates', 'quality', 'people', 'changes'])
    expect(partsOf('people, headline,lines')).toEqual(['headline', 'lines', 'people'])
    expect(partsOf('lines,lines')).toEqual(['lines'])
    expect(() => partsOf('lines,money')).toThrow(ValidationError)
    expect(() => partsOf(' , ')).toThrow("Not a part of the order's production.")
  })
})

describe('withheldOf: a part or block the reader may not read is named, never an empty part', () => {
  const holding = (...rights: Permission[]) => (permission: Permission) => rights.includes(permission)

  it('the Sales template (orders.view, no workorders.view, no planning.promise.view): work, people, the office notes, issues, NCRs, final and forecast withheld', () => {
    expect(withheldOf(['headline', 'lines', 'work', 'dates', 'quality', 'people', 'changes'], holding('orders.view'))).toEqual([
      'work',
      'people',
      'headline.notes',
      'quality.issues',
      'quality.ncrs',
      'quality.final',
      'dates.forecast',
    ])
  })

  it('only the parts asked are looked at; every right: nothing withheld', () => {
    expect(withheldOf(['lines', 'changes'], holding())).toEqual([])
    expect(withheldOf(['quality'], holding('workorders.view', 'quality.ncr.view'))).toEqual(['quality.final'])
    expect(withheldOf(['headline', 'work', 'dates', 'quality', 'people'], holding('workorders.view', 'quality.ncr.view', 'quality.inspections.view', 'planning.promise.view'))).toEqual([])
  })
})

describe('alsoMakesOf: what a work order also makes, behind the brand wall', () => {
  it('names the other orders of THIS customer the reader reaches, counts the others of this customer, never another customer’s', () => {
    const others = [order('SO-A2', ALPHA), order('SO-A3', ALPHA, 'c2'), order('SO-B1', BETA)]
    const reaches = (other: OtherOrder) => other.companyId === 'c1'
    expect(alsoMakesOf(others, ALPHA, reaches)).toEqual({ orders: [{ id: 'id-SO-A2', number: 'SO-A2' }], more: 1 })
    // Brand Beta's order is never named nor counted on Brand Alpha's order, even for a reader who reaches it.
    expect(alsoMakesOf(others, ALPHA, () => true)).toEqual({ orders: [{ id: 'id-SO-A2', number: 'SO-A2' }, { id: 'id-SO-A3', number: 'SO-A3' }], more: 0 })
    expect(JSON.stringify(alsoMakesOf(others, ALPHA, () => true))).not.toContain('SO-B1')
    expect(alsoMakesOf([], ALPHA, () => true)).toEqual({ orders: [], more: 0 })
  })
})

describe('mtmGroupsOf: made-to-measure work orders, one per unit, grouped per style × colourway', () => {
  it('folds twelve unit work orders of one style and colour into one row, with their statuses', () => {
    const units = [
      ...Array.from({ length: 9 }, (_, index) => ({ id: `w${index}`, styleId: 'JKT', colourwayId: 'BLK', status: 'RELEASED', units: 1 })),
      ...Array.from({ length: 3 }, (_, index) => ({ id: `d${index}`, styleId: 'JKT', colourwayId: 'BLK', status: 'DRAFT', units: 1 })),
      { id: 'r1', styleId: 'JKT', colourwayId: 'RED', status: 'IN_PROGRESS', units: 1 },
    ]
    const groups = mtmGroupsOf(units)
    expect(groups.map((group) => [group.styleId, group.colourwayId, group.units, group.workOrders, group.byStatus])).toEqual([
      ['JKT', 'BLK', 12, 12, [{ status: 'DRAFT', count: 3 }, { status: 'RELEASED', count: 9 }]],
      ['JKT', 'RED', 1, 1, [{ status: 'IN_PROGRESS', count: 1 }]],
    ])
  })
})

describe('the order’s own share and what is in work', () => {
  it('sums only the order’s own cells; a step nobody counts stays null, never a made-up 0', () => {
    const counts = new Map([
      ['c1', { cut: 4, sewn: null, inspected: 0 }],
      ['c2', { cut: 2, sewn: null, inspected: 1 }],
    ])
    expect(ownShareOf([{ cellId: 'c1', quantity: 20 }, { cellId: 'c2', quantity: 20 }], counts)).toEqual({ cells: 2, pieces: 40, cut: 6, sewn: null, checked: 1 })
    // A draft's cell has no count at all.
    expect(ownShareOf([{ cellId: 'draft', quantity: 10 }], counts)).toEqual({ cells: 1, pieces: 10, cut: null, sewn: null, checked: null })
    expect(sumOrNull([null, null])).toBeNull()
    expect(sumOrNull([null, 0])).toBe(0)
  })

  it('pieces between the steps, as counts; sewing not counted: no sewing or checking figure', () => {
    expect(inWorkPiecesOf({ started: 40, cut: 30, sewn: 20, checked: 12, packed: 4 })).toEqual({ cutting: 10, sewing: 10, checking: 8, packing: 8 })
    expect(inWorkPiecesOf({ started: 40, cut: 30, sewn: null, checked: 0, packed: 0 })).toEqual({ cutting: 10, sewing: null, checking: null, packing: 0 })
    expect(inWorkPiecesOf({ started: 0, cut: null, sewn: null, checked: null, packed: null })).toEqual({ cutting: 0, sewing: null, checking: null, packing: null })
  })

  it('the promise slip in days, and every blocker has its words (it + en)', () => {
    expect(daysBetween('2026-12-02', '2026-12-08')).toBe(6)
    expect(daysBetween('2026-12-08', '2026-12-02')).toBe(-6)
    for (const kind of BLOCKER_KINDS) expect(BLOCKER_WORDS[kind].it.length * BLOCKER_WORDS[kind].en.length).toBeGreaterThan(0)
  })
})
