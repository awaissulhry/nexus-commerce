import { describe, expect, it } from 'vitest'
import {
  extendedCounts,
  genealogyPlan,
  genealogyProblems,
  genealogyWords,
  impactLevels,
  impactStates,
  laneFacts,
  mergeImpact,
  nextStepProblem,
  nodeHoldOf,
  placeCodeKey,
  placeOfCode,
  quarantineTransfers,
  type ImpactEdge,
  type ImpactNode,
} from './depth'

const SITE = 'site-a1'
const COMPANY = 'company-1'
const node = (key: string, over: Partial<ImpactNode> = {}): ImpactNode => {
  const [kind, id] = key.split(':') as [ImpactNode['kind'], string]
  const holdable = ['LOT', 'HIDE', 'WORK_ORDER', 'BUNDLE', 'SERIAL', 'SHIPMENT'].includes(kind)
  return {
    key,
    kind,
    id,
    code: id.toUpperCase(),
    reach: 'EXACT',
    companyId: COMPANY,
    siteId: SITE,
    hidden: false,
    state: null,
    holdKind: holdable ? ({ LOT: 'Lot', HIDE: 'Hide', WORK_ORDER: 'WorkOrder', BUNDLE: 'Bundle', SERIAL: 'GarmentSerial', SHIPMENT: 'Shipment' } as const)[kind as 'LOT'] : null,
    hold: holdable ? 'HOLDABLE' : 'NONE',
    problem: null,
    holds: [],
    workOrderId: null,
    ...over,
  }
}

// lot → hide → WO-1 (2 sizes: 30 made, 10 shipped) → bundle b1 → serials s1 (made), s2 (shipped) → shipments sh1 (DRAFT), sh2 (SHIPPED) → customer
const NODES: ImpactNode[] = [
  node('LOT:l1', { lot: { itemCode: 'LEA', itemName: 'Leather', uom: 'FT2', onHand: '412.5', colourCode: 'BLK' } }),
  node('HIDE:h1', { hideOnHand: '40' }),
  node('WORK_ORDER:wo1', { workOrderId: 'wo1', workOrder: { styleCode: 'JKT', batchNumber: 'B1', status: 'IN_PROGRESS' } }),
  node('CELL:c1', { workOrderId: 'wo1', cell: { colourwayCode: 'BLK', size: '50', quantity: 20, released: 15, packed: 3, shipped: 10, returned: 0 } }),
  node('CELL:c2', { workOrderId: 'wo1', cell: { colourwayCode: 'BLK', size: '52', quantity: 10, released: 0, packed: 0, shipped: 0, returned: 0 } }),
  node('BUNDLE:b1', { workOrderId: 'wo1', bundle: { quantity: 10, part: null } }),
  node('SERIAL:s1', { workOrderId: 'wo1', state: 'MADE' }),
  node('SERIAL:s2', { workOrderId: 'wo1', state: 'SHIPPED', hold: 'LEFT', problem: 'gone' }),
  node('SHIPMENT:sh1', { state: 'DRAFT' }),
  node('SHIPMENT:sh2', { state: 'SHIPPED', hold: 'LEFT', problem: 'gone' }),
  node('CUSTOMER:cu1', { siteId: null, received: true }),
]
const EDGES: ImpactEdge[] = [
  { from: 'CELL:c1', to: 'SHIPMENT:sh1', link: 'SHIPPED', exact: true, quantity: '3', uom: 'PCS' },
  { from: 'CELL:c1', to: 'SHIPMENT:sh2', link: 'SHIPPED', exact: true, quantity: '10', uom: 'PCS' },
]

describe('the hold board (QHS-077)', () => {
  it('moves an active hold to another lane only; counts each lane with its oldest age', () => {
    expect(nextStepProblem({ status: 'ACTIVE', nextStep: 'NEW' }, 'INVESTIGATING')).toBeNull()
    expect(nextStepProblem({ status: 'ACTIVE', nextStep: 'NEW' }, 'NEW')).toMatch(/at this step already/)
    expect(nextStepProblem({ status: 'RELEASED', nextStep: 'NEW' }, 'READY_TO_RELEASE')).toMatch(/released: only an active hold/)
    const lanes = laneFacts([
      { status: 'ACTIVE', nextStep: 'NEW', ageDays: 2 },
      { status: 'ACTIVE', nextStep: 'NEW', ageDays: 9 },
      { status: 'RELEASED', nextStep: 'INVESTIGATING', ageDays: 30 },
      { status: 'ACTIVE', nextStep: 'READY_TO_RELEASE', ageDays: 1 },
    ])
    expect(lanes.map((lane) => [lane.step, lane.count, lane.oldestDays])).toEqual([
      ['NEW', 2, 9],
      ['INVESTIGATING', 0, null],
      ['WAITING_DECISION', 0, null],
      ['READY_TO_RELEASE', 1, 1],
    ])
  })
})

describe('what a node is to a hold by genealogy (QHS-075)', () => {
  it('holdable, held, gone, refused by the guard, hidden, or no kind of hold', () => {
    expect(nodeHoldOf({ kind: 'LOT', code: 'L1', state: 'RELEASED', heldBy: 0, hidden: false })).toEqual({ holdKind: 'Lot', hold: 'HOLDABLE', problem: null })
    expect(nodeHoldOf({ kind: 'LOT', code: 'L1', state: 'REJECTED', heldBy: 0, hidden: false }).hold).toBe('NOT_HOLDABLE')
    expect(nodeHoldOf({ kind: 'WORK_ORDER', code: 'WO-1', state: 'IN_PROGRESS', heldBy: 1, hidden: false }).hold).toBe('HELD')
    expect(nodeHoldOf({ kind: 'SHIPMENT', code: 'SH-1', state: 'DELIVERED', heldBy: 0, hidden: false })).toMatchObject({ hold: 'LEFT', problem: expect.stringMatching(/PPE register/) })
    expect(nodeHoldOf({ kind: 'SERIAL', code: 'SN-1', state: 'SHIPPED', heldBy: 0, hidden: false }).hold).toBe('LEFT')
    expect(nodeHoldOf({ kind: 'BUNDLE', code: 'BN-1', state: 'VOID', heldBy: 0, hidden: false }).problem).toMatch(/only an active bundle/)
    expect(nodeHoldOf({ kind: 'HIDE', code: null, state: 'IN_STOCK', heldBy: 0, hidden: true }).hold).toBe('HIDDEN')
    expect(nodeHoldOf({ kind: 'CELL', code: 'BLK 50', state: null, heldBy: 0, hidden: false })).toEqual({ holdKind: null, hold: 'NONE', problem: null })
  })
})

describe('the plan of a hold by genealogy', () => {
  it('one hold per kind and site, a work order covering its bundles and garments; shipped goods counted, never held', () => {
    const plan = genealogyPlan(NODES, EDGES, NODES.map((entry) => entry.key))
    expect(plan.holds.map((hold) => [hold.subjectType, hold.ids])).toEqual([
      ['Lot', ['l1']],
      ['Hide', ['h1']],
      ['WorkOrder', ['wo1']],
      ['Shipment', ['sh1']],
    ])
    expect(plan.covered).toEqual(['BUNDLE:b1', 'SERIAL:s1'])
    expect(plan.refused.map((entry) => entry.key)).toEqual(['SERIAL:s2', 'SHIPMENT:sh2'])
    // 20 + 10 made, 10 of them gone: 20 held by the work order; the draft shipment's 3 are of the held work order.
    expect(plan.counts).toEqual({ Lot: 1, Hide: 1, WorkOrder: 1, Bundle: 0, GarmentSerial: 0, Shipment: 1, garments: 20, shippedGarments: 10, customers: 1 })
    expect(genealogyWords(plan.counts)).toBe('Hold 1 lot, 1 hide, 1 work order, 1 shipment and 20 garments; 10 garments already shipped to 1 customer.')
  })

  it('a bundle alone holds its garments; already held and unknown picks are said; more than 100 records split', () => {
    const plan = genealogyPlan(NODES, EDGES, ['BUNDLE:b1', 'SERIAL:s1', 'LOT:gone'])
    expect(plan.holds.map((hold) => hold.subjectType)).toEqual(['Bundle', 'GarmentSerial'])
    expect(plan.counts.garments).toBe(11)
    expect(plan.refused).toEqual([{ key: 'LOT:gone', code: null, hold: 'NONE', words: expect.stringMatching(/read it again/) }])
    const held = genealogyPlan([node('LOT:l1', { hold: 'HELD' })], [], ['LOT:l1'])
    expect(held.alreadyHeld).toEqual(['LOT:l1'])
    expect(held.holds).toEqual([])
    const many = Array.from({ length: 150 }, (_, index) => node(`SERIAL:s${String(index).padStart(3, '0')}`, { state: 'MADE' }))
    expect(genealogyPlan(many, [], many.map((entry) => entry.key)).holds.map((hold) => hold.ids.length)).toEqual([100, 50])
    const two = [node('LOT:a'), node('LOT:b', { siteId: 'site-b1' })]
    expect(genealogyPlan(two, [], ['LOT:a', 'LOT:b']).holds.map((hold) => hold.siteId)).toEqual([SITE, 'site-b1'])
  })

  it('extends counts: records and garments add up, the recall facts are the latest', () => {
    const added = { Lot: 0, Hide: 0, WorkOrder: 2, Bundle: 0, GarmentSerial: 0, Shipment: 0, garments: 40, shippedGarments: 12, customers: 3 }
    expect(extendedCounts({ Lot: 1, garments: 5, shippedGarments: 2, customers: 1, other: 9 }, added)).toEqual({ ...added, Lot: 1, garments: 45 })
    expect(genealogyProblems({ picks: [] }, '2026-11-03').map((issue) => issue.path)).toEqual(['picks'])
    expect(genealogyProblems({ picks: ['LOT:a'], expectedReleaseOn: '2026-11-02' }, '2026-11-03').map((issue) => issue.path)).toEqual(['expectedReleaseOn'])
  })
})

describe('what a hold touches (Hold › Affected)', () => {
  it('merges the traces of several records and counts by state', () => {
    const one = { starts: ['LOT:l1'], nodes: NODES.slice(0, 4), edges: [], gaps: [{ code: 'BATCH_TRACKED', severity: 'COARSE', at: 'CELL:c1', count: 1 }] }
    const two = { starts: ['WORK_ORDER:wo1'], nodes: [node('CELL:c1', { reach: 'POSSIBLE', workOrderId: 'wo1', cell: NODES[3]!.cell! }), ...NODES.slice(4)], edges: EDGES, gaps: [{ code: 'BATCH_TRACKED', severity: 'COARSE', at: 'CELL:c1', count: 1 }] }
    const merged = mergeImpact([two, one])
    expect(merged.starts).toEqual(['LOT:l1', 'WORK_ORDER:wo1'])
    expect(merged.nodes.length).toBe(NODES.length)
    expect(merged.nodes.find((entry) => entry.key === 'CELL:c1')!.reach).toBe('EXACT')
    expect(merged.gaps.length).toBe(1)
    expect(impactLevels(merged.nodes).find((level) => level.kind === 'SERIAL')).toEqual({ kind: 'SERIAL', exact: 2, possible: 0 })
    expect(impactStates(merged.nodes)).toEqual({ material: [{ uom: 'FT2', onHand: '412.5' }], hidesInStock: 0, garments: { inWork: 15, inStock: 2, packed: 3, shipped: 10, returned: 0 }, customers: 1 })
    expect(impactStates([node('HIDE:h1', { hideOnHand: '40' })]).hidesInStock).toBe(1)
  })
})

describe('the quarantine move (QHS-078)', () => {
  it('reads a place code with case, spaces and hyphens aside; moves every balance but the place and an outside workshop', () => {
    expect(placeCodeKey(' q-01 ')).toBe('Q01')
    const places = [{ id: 'q1', code: 'A1-QUA' }, { id: 'q2', code: 'A1-QUA-2' }]
    expect(placeOfCode('a1 qua', places)?.id).toBe('q1')
    expect(placeOfCode('A1QUA2', places)?.id).toBe('q2')
    expect(placeOfCode('A1-STORE', places)).toBeNull()
    expect(placeOfCode('  ', places)).toBeNull()
    const balance = (locationId: string, locationKind: string, onHand = '10') => ({ locationId, locationKind, itemId: 'i', itemColourId: null, lotId: 'l1', hideId: null, onHand })
    const out = quarantineTransfers([balance('store', 'WAREHOUSE'), balance('q1', 'QUARANTINE'), balance('p2', 'SUBCONTRACTOR'), balance('bin', 'BIN', '0')], 'q1')
    expect(out.moves.map((entry) => entry.locationId)).toEqual(['store'])
    expect(out.stays.map((entry) => entry.locationId)).toEqual(['p2'])
  })
})
