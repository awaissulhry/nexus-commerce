import { describe, expect, it } from 'vitest'
import { holdOf, lotSized, needWeekOf, parseRequestId, positionOf, reorderNeedOf, reorderWhy, requestIdOf, requestTiles, compareRequests, kindOfPath, type HoldFacts, type ReorderRule } from './requests'

/* Requests to buy (SCM-034, SCM-036), pure. Every id, code and number is made up. */

const ID = '0193a6f1-7c2b-7d4e-9f00-000000000001'

const rule = (over: Partial<ReorderRule> = {}): ReorderRule => ({
  method: 'REORDER_POINT',
  reorderPoint: '24',
  lotSize: '48',
  minStock: null,
  maxStock: null,
  minOrderQty: null,
  orderMultiple: '12',
  maxOrderQty: null,
  ...over,
})

describe('a request’s id', () => {
  it('names its kind and the row behind it, and reads back', () => {
    expect(requestIdOf('PLAN', ID)).toBe(`plan:${ID}`)
    expect(requestIdOf('REORDER', ID)).toBe(`reorder:${ID}`)
    expect(parseRequestId(`reorder:${ID}`)).toEqual({ kind: 'REORDER', refId: ID })
    expect(parseRequestId(`plan:${ID}`)).toEqual({ kind: 'PLAN', refId: ID })
    expect(parseRequestId(`staff:${ID}`)).toBeNull()
    expect(parseRequestId('plan:not-an-id')).toBeNull()
    expect([kindOfPath('plan'), kindOfPath('reorder'), kindOfPath('PLAN')]).toEqual(['PLAN', 'REORDER', null])
  })
})

describe('reorder points and min/max (base unit)', () => {
  it('counts usable + on order − reserved', () => {
    expect(positionOf({ usable: '10', onOrder: '12', reserved: '4' })).toBe('18.0000')
    expect(positionOf({ usable: '0', onOrder: '0', reserved: '6' })).toBe('-6.0000')
  })

  it('orders the lot size at or below the reorder point, then the site’s minimum, steps and maximum', () => {
    expect(reorderNeedOf(rule(), { usable: '20', onOrder: '4', reserved: '0' })).toEqual({
      method: 'REORDER_POINT',
      position: '24.0000',
      level: '24.0000',
      triggered: true,
      quantity: '48.0000',
      steps: [{ rule: 'LOT_SIZE', quantity: '48.0000' }],
    })
    expect(reorderNeedOf(rule(), { usable: '25', onOrder: '0', reserved: '0' })).toMatchObject({ triggered: false, quantity: '0.0000', steps: [] })
    expect(reorderNeedOf(rule({ lotSize: '40' }), { usable: '0', onOrder: '0', reserved: '0' })).toMatchObject({ quantity: '48.0000', steps: [{ rule: 'LOT_SIZE' }, { rule: 'MULTIPLE', quantity: '48.0000' }] })
    expect(reorderNeedOf(rule({ lotSize: '40', minOrderQty: '60', maxOrderQty: '50', orderMultiple: null }), { usable: '0', onOrder: '0', reserved: '0' })!.steps.map((step) => step.rule)).toEqual(['LOT_SIZE', 'MINIMUM', 'MAXIMUM'])
  })

  it('orders up to the maximum below the minimum (not at it)', () => {
    const minMax = rule({ method: 'MIN_MAX', reorderPoint: null, lotSize: null, minStock: '50', maxStock: '300', minOrderQty: '50', orderMultiple: '50' })
    expect(reorderNeedOf(minMax, { usable: '38.5', onOrder: '0', reserved: '0' })).toEqual({
      method: 'MIN_MAX',
      position: '38.5000',
      level: '50.0000',
      triggered: true,
      quantity: '300.0000',
      steps: [
        { rule: 'UP_TO_MAXIMUM', quantity: '261.5000' },
        { rule: 'MULTIPLE', quantity: '300.0000' },
      ],
    })
    expect(reorderNeedOf(minMax, { usable: '50', onOrder: '0', reserved: '0' })).toMatchObject({ triggered: false })
  })

  it('suggests nothing from a rule that is not complete', () => {
    expect(reorderNeedOf(rule({ lotSize: null }), { usable: '0', onOrder: '0', reserved: '0' })).toBeNull()
    expect(reorderNeedOf(rule({ method: 'MIN_MAX', minStock: '50', maxStock: null }), { usable: '0', onOrder: '0', reserved: '0' })).toBeNull()
    expect(reorderNeedOf(rule({ method: 'MIN_MAX', minStock: '50', maxStock: '50' }), { usable: '0', onOrder: '0', reserved: '0' })).toBeNull()
  })

  it('rounds a quantity up to four places before the rules', () => {
    expect(lotSized('0.00001', { minOrderQty: null, orderMultiple: null, maxOrderQty: null })).toEqual({ quantity: '0.0001', steps: [] })
  })

  it('says why in words', () => {
    const stock = { usable: '10', onOrder: '12', reserved: '4' }
    expect(reorderWhy(reorderNeedOf(rule(), stock)!, stock, 'PCS')).toBe('Stock 18 PCS (usable 10 + on order 12 − reserved 4) is at or below the reorder point 24: order 48 PCS.')
  })
})

describe('what stops a request', () => {
  const facts = (over: Partial<HoldFacts> = {}): HoldFacts => ({
    status: 'OPEN',
    latest: true,
    needed: true,
    material: { code: 'LEA-01', active: true },
    supplier: { name: 'Conceria Uno', roles: ['SUPPLIER'], status: 'ACTIVE' },
    approved: true,
    ...over,
  })

  it('holds an older plan’s line, a reorder no longer needed, what is not open, an archived material, no or a wrong supplier, and one that is not an approved source', () => {
    expect(holdOf(facts())).toBeNull()
    expect(holdOf(facts({ supplier: { name: 'Conceria Uno', roles: ['SUPPLIER'], status: 'PROSPECT' } }))).toBeNull() // drafted, not sent
    expect(holdOf(facts({ status: 'CONVERTED' }))?.code).toBe('NOT_OPEN')
    expect(holdOf(facts({ status: 'SET_ASIDE' }))?.message).toBe('It was set aside: open it again first.')
    expect(holdOf(facts({ material: { code: 'LEA-01', active: false } }))?.code).toBe('MATERIAL_ARCHIVED')
    expect(holdOf(facts({ supplier: null }))?.message).toBe('Pick a supplier first: LEA-01 has no approved source or default supplier.')
    expect(holdOf(facts({ supplier: { name: 'Brand X', roles: ['CUSTOMER'], status: 'ACTIVE' } }))?.code).toBe('NOT_A_SUPPLIER')
    expect(holdOf(facts({ supplier: { name: 'Conceria Uno', roles: ['SUPPLIER'], status: 'BLOCKED' } }))?.message).toBe('Conceria Uno is blocked: pick another approved source.')
    expect(holdOf(facts({ supplier: { name: 'Conceria Uno', roles: ['SUBCONTRACTOR'], status: 'ARCHIVED' } }))?.code).toBe('SUPPLIER_ARCHIVED')
    expect(holdOf(facts({ approved: false }))?.code).toBe('NOT_APPROVED')
    expect(holdOf(facts({ latest: false, status: 'CONVERTED' }))?.code).toBe('PLAN_REPLACED') // first: nothing of an older plan is drafted
    expect(holdOf(facts({ needed: false }))?.message).toBe('The stock is above its reorder level now (the reorder point, or the minimum): nothing to buy.')
  })
})

describe('the queue', () => {
  it('groups by the ISO week of the need date', () => {
    expect(needWeekOf('2026-10-30')).toBe('2026-W44')
    expect(needWeekOf('2027-01-01')).toBe('2026-W53')
    expect(needWeekOf('2027-01-04')).toBe('2027-W01')
    expect(needWeekOf('2024-12-30')).toBe('2025-W01')
    expect(() => needWeekOf('30/10/2026')).toThrow(RangeError)
  })

  it('counts the tiles: open, needed within 14 days (late included), drafted today; staff requests are not known yet', () => {
    const rows = [
      { status: 'OPEN', needDate: '2026-10-20', convertedOn: null },
      { status: 'OPEN', needDate: '2026-11-13', convertedOn: null },
      { status: 'OPEN', needDate: '2026-11-14', convertedOn: null },
      { status: 'CONVERTED', needDate: '2026-11-01', convertedOn: '2026-10-30' },
      { status: 'CONVERTED', needDate: '2026-11-01', convertedOn: '2026-10-29' },
      { status: 'SET_ASIDE', needDate: '2026-11-01', convertedOn: null },
    ] as const
    expect(requestTiles(rows, '2026-10-30')).toEqual({ open: 3, needWithin14Days: 2, waitingApproval: null, convertedToday: 1 })
  })

  it('orders by need date, then order-by day, material and id', () => {
    const rows = [
      { needDate: '2026-11-10', orderBy: '2026-11-01', code: 'B', id: '2' },
      { needDate: '2026-11-10', orderBy: '2026-10-20', code: 'C', id: '3' },
      { needDate: '2026-11-01', orderBy: '2026-11-01', code: 'Z', id: '1' },
      { needDate: '2026-11-10', orderBy: '2026-11-01', code: 'A', id: '4' },
    ]
    expect([...rows].sort(compareRequests).map((row) => row.id)).toEqual(['1', '3', '4', '2'])
  })
})
