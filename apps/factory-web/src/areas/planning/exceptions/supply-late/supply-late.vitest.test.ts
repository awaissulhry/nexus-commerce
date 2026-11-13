import { describe, expect, it } from 'vitest'
import { createApiClient } from '../../../../lib/api/client'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { designScreen } from '../fixtures'
import { checkSupplyLate, supplyLateFixes, supplyLateList } from './api'
import { SUPPLY_LATE } from './demo'
import { boardHref, chaseHref, checkHeld, planHref, purchaseOrderOf, repromiseHeld, repromiseHref, supplierHref, supplyLateCan } from './model'

/**
 * Supply too late on Planning › Exceptions (SCR-125; B-W2b-336 on B-W2b-317's API): where each fix opens (real links, so
 * ⌘-click keeps the queue open), who may check and re-promise, and the calls as the API takes them. The SCR-125 test draws every
 * case (the `w2b-336-*` ones too) in both languages with no key left on screen.
 */

const place = { prefix: '/w/DEMO', siteId: 's1', built: OFFICE_PAGES }
const fixes = SUPPLY_LATE.fixes!

describe('supply too late: where each fix opens', () => {
  it('chase opens the PO record with its chase dialog; move the board at the work order; buy elsewhere the plan’s line; re-promise Promise dates', () => {
    expect(chaseHref(fixes.chase!, place)).toBe(`/w/DEMO/purchasing/orders/${fixes.chase!.purchaseOrder.id}?chase=1`)
    expect(boardHref(fixes.move[0]!.workOrder.id, place)).toBe(`/w/DEMO/planning/board?site=s1&wo=${fixes.move[0]!.workOrder.id}`)
    expect(planHref(fixes.buyElsewhere[0]!.requirementId, place)).toBe(`/w/DEMO/planning/mrp?site=s1&view=all&line=${fixes.buyElsewhere[0]!.requirementId}`)
    expect(planHref(null, { ...place, siteId: null })).toBe('/w/DEMO/planning/mrp?view=all')
    expect(supplierHref(fixes.buyElsewhere[0]!.supplier, place)).toBe(`/w/DEMO/sales/customers/${fixes.buyElsewhere[0]!.supplier.id}`)
    expect(repromiseHref(fixes.repromise[0]!.orderLine.id, place)).toBe(`/w/DEMO/planning/promise?site=s1&repromise=${fixes.repromise[0]!.orderLine.id}`)
  })
})

describe('supply too late: who may do what', () => {
  it('Check now needs planning.exceptions.manage and a purchase order; held while checking', () => {
    const planner = supplyLateCan(['planning.view', 'planning.exceptions.manage', 'planning.promise.view', 'planning.promise.manage', 'purchasing.view'])
    const reader = supplyLateCan(['planning.view', 'planning.promise.view'])
    expect(purchaseOrderOf(SUPPLY_LATE)).toBe(fixes.chase!.purchaseOrder.id)
    expect(purchaseOrderOf({ fixes: null, record: { type: 'PurchaseOrder', id: 'po1' } })).toBe('po1')
    expect(checkHeld(SUPPLY_LATE, planner, false)).toBeNull()
    expect(checkHeld(SUPPLY_LATE, planner, true)).toBe('supplyLate.held.checking')
    expect(checkHeld(SUPPLY_LATE, reader, false)).toBe('supplyLate.held.noCheck')
    expect(checkHeld({ fixes: null, record: null }, planner, false)).toBe('supplyLate.held.noOrder')
  })

  it('re-promise: Review where one waits; held without promise dates or its right', () => {
    const planner = supplyLateCan(['planning.promise.view', 'planning.promise.manage'])
    const buyer = supplyLateCan(['planning.view', 'planning.exceptions.manage', 'purchasing.view'])
    const reader = supplyLateCan(['planning.promise.view'])
    const [plain, waiting] = fixes.repromise
    expect(repromiseHeld(plain!, planner)).toEqual({ label: 'supplyLate.repromise.verb', held: null })
    expect(repromiseHeld(waiting!, reader)).toEqual({ label: 'supplyLate.repromise.review', held: null })
    expect(repromiseHeld(plain!, buyer).held).toBe('supplyLate.held.noPromise')
    expect(repromiseHeld(plain!, reader).held).toBe('supplyLate.held.noRepromise')
    expect(repromiseHeld({ ...plain!, may: false }, planner).held).toBe('supplyLate.held.mayNot')
  })
})

function mockApi(answers: unknown[]) {
  const calls: { method: string; url: string; body: unknown; key: string | null }[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : undefined, key: new Headers(init.headers).get('idempotency-key') })
    return new Response(JSON.stringify(answers.shift() ?? {}), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { api: createApiClient({ baseUrl: '/api', fetch, company: 'DEMO', csrfToken: () => 'csrf-demo' }), calls }
}

describe('supply too late: the calls as the API takes them', () => {
  it('the tile and its fixes, one exception’s fixes, Check now with its key', async () => {
    const list = { site: { id: 's1', code: 'ST1', name: 'x' }, asOf: 'x', tile: 1, exceptions: [SUPPLY_LATE] }
    const { api, calls } = mockApi([list, SUPPLY_LATE, { checked: true, siteId: 's1', raised: 1, stillOpen: 0, cleared: 0, replayed: false, view: list }])
    expect((await supplyLateList(api, 's1')).tile).toBe(1)
    expect(calls[0]!.url).toBe('/api/planning/exceptions/supply-late?siteId=s1')
    expect((await supplyLateFixes(api, 'e1')).fixes?.move).toHaveLength(2)
    expect(calls[1]!.url).toBe('/api/planning/exceptions/e1/fixes')
    expect((await checkSupplyLate(api, 'po1', 'k1')).raised).toBe(1)
    expect(calls[2]).toMatchObject({ method: 'POST', url: '/api/planning/exceptions/supply-late/check', body: { purchaseOrderId: 'po1' }, key: 'k1' })
  })

  it('SCR-125 carries the supply-too-late cases', () => {
    const ids = designScreen.cases.map((entry) => entry.id)
    for (const id of ['w2b-336-tile', 'w2b-336-tile-pressed', 'w2b-336-detail', 'w2b-336-detail-error', 'w2b-336-buyer', 'w2b-336-read-only']) expect(ids).toContain(id)
  })
})
