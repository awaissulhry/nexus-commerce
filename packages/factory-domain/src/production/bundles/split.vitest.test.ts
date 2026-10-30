import { describe, expect, it } from 'vitest'
import type { ScanFact, ScanOperation } from '../scans/rules'
import { bundleFlow, liveGarments, splitRefusal, type FlowRework } from './split'

/** Split a bundle and its flow (B-W2a-13; MES-071, MES-126): figures by hand. */

const OPS: ScanOperation[] = [
  { id: 'op10', seq: 10, code: 'CUT', name: 'Cut', scanRequired: true, workCentreKind: 'CUTTING' },
  { id: 'op20', seq: 20, code: 'SEW', name: 'Sew', scanRequired: true, workCentreKind: 'SEWING' },
  { id: 'op30', seq: 30, code: 'QC', name: 'Final check', scanRequired: true, workCentreKind: 'INSPECTION' },
  { id: 'op40', seq: 40, code: 'PACK', name: 'Pack', scanRequired: true, workCentreKind: 'PACKING' },
]
const T = (minutes: number) => new Date(Date.UTC(2026, 10, 2, 8, minutes))
const scan = (bundleId: string, op: string, good: number, rework = 0, at = 0): ScanFact => ({
  id: `${bundleId}-${op}`,
  kind: 'REPORT',
  bundleId,
  workOrderOperationId: op,
  correctsId: null,
  goodQuantity: good,
  scrapQuantity: 0,
  reworkQuantity: rework,
  workerId: null,
  stationId: null,
  deviceId: null,
  clientScanId: `c-${bundleId}-${op}`,
  deviceTime: null,
  serverTime: T(at),
})
const standingOf = (...scans: ScanFact[]) => new Map(scans.map((row) => [`${row.bundleId}|${row.workOrderOperationId}`, row]))
const rework = (over: Partial<FlowRework>): FlowRework => ({ id: 'rw1', status: 'OPEN', quantity: 2, goodQuantity: 0, reasonCode: 'RESTITCH', foundAtOperationId: 'op30', reworkAtOperationId: 'op20', sourceScanId: 'P-op30', createdAt: T(30), ...over })

describe('a split (MES-071)', () => {
  it('keeps the parent as cut: live garments are its quantity less its children that are not VOID', () => {
    expect(liveGarments(20, [{ quantity: 2, status: 'ACTIVE' }, { quantity: 3, status: 'VOID' }, { quantity: 1, status: 'ACTIVE' }])).toBe(17)
  })

  it('splits 1 … live − 1 garments off an ACTIVE bundle of an open work order, and says why not otherwise', () => {
    const facts = { bundle: { code: 'B-1', status: 'ACTIVE' as const, quantity: 10 }, workOrder: { number: 'WO-1', status: 'IN_PROGRESS' as const }, children: [{ quantity: 4, status: 'ACTIVE' as const }] }
    expect(splitRefusal({ ...facts, quantity: 5 })).toBeNull()
    expect(splitRefusal({ ...facts, quantity: 6 })?.code).toBe('SPLIT_TOO_MANY')
    expect(splitRefusal({ ...facts, quantity: 6 })?.message).toBe('Bundle B-1 carries 6 garments: split off 1 to 5 (at least one stays); 6 asked.')
    expect(splitRefusal({ ...facts, quantity: 0 })?.code).toBe('SPLIT_TOO_MANY')
    expect(splitRefusal({ ...facts, bundle: { ...facts.bundle, status: 'VOID' }, quantity: 1 })?.code).toBe('VOIDED')
    expect(splitRefusal({ ...facts, workOrder: { number: 'WO-1', status: 'ON_HOLD', holdReason: 'Stain on the lot' }, quantity: 1 })).toEqual({
      code: 'WORK_ORDER_ON_HOLD',
      message: 'Work order WO-1 is on hold (Stain on the lot): its bundles are split once the hold is lifted.',
    })
    expect(splitRefusal({ ...facts, workOrder: { number: 'WO-1', status: 'COMPLETED' }, quantity: 1 })?.code).toBe('WORK_ORDER_NOT_OPEN')
  })
})

describe('the flow of a split bundle (the scan hook)', () => {
  const parent = { id: 'P', code: 'B-P', quantity: 20, createdAt: T(0) }

  it('a bundle neither split nor in rework flows as before', () => {
    const own = standingOf(scan('P', 'op10', 20))
    const flow = bundleFlow({ bundle: parent, operations: OPS, standing: own, children: [], reworks: [], parent: null })
    expect(flow.quantity).toBe(20)
    expect(flow.standing.get('P|op10')?.goodQuantity).toBe(20)
    expect(flow.refusal).toBeNull()
  })

  it('a parent counts at most its live garments, also in reports made before the split', () => {
    // Op 10 passed 20; 2 split off at Op 20 (for a hold): Op 20 takes at most 18 of the parent.
    const flow = bundleFlow({ bundle: parent, operations: OPS, standing: standingOf(scan('P', 'op10', 20)), children: [{ quantity: 2, status: 'ACTIVE' }], reworks: [], parent: null })
    expect(flow.quantity).toBe(18)
    expect(flow.standing.get('P|op10')?.goodQuantity).toBe(18)
  })

  it('a child takes its parent’s place: the reports made before the split count for it, up to its garments', () => {
    const parentStanding = standingOf(scan('P', 'op10', 20, 0, 1), scan('P', 'op20', 20, 0, 2), scan('P', 'op30', 18, 0, 50))
    const child = { id: 'C', code: 'B-C', quantity: 2, createdAt: T(10) }
    const flow = bundleFlow({ bundle: child, operations: OPS, standing: new Map(), children: [], reworks: [], parent: { id: 'P', standing: parentStanding } })
    expect(flow.quantity).toBe(2)
    expect(flow.standing.get('C|op10')?.goodQuantity).toBe(2)
    expect(flow.standing.get('C|op20')?.goodQuantity).toBe(2)
    expect(flow.standing.get('C|op20')?.bundleId).toBe('C')
    // Op 30's report came after the split: the child is reported there itself.
    expect(flow.standing.has('C|op30')).toBe(false)
  })

  it('a rework child is held until its rework is done, then rejoins at the operation the fault was found at', () => {
    // Op 30 (final check) found 2 to redo: 18 good + 2 rework; the 2 split off for the rework, back to Op 20.
    const parentStanding = standingOf(scan('P', 'op10', 20, 0, 1), scan('P', 'op20', 20, 0, 2), scan('P', 'op30', 18, 2, 3))
    const child = { id: 'C', code: 'B-C', quantity: 2, createdAt: T(30) }
    const open = bundleFlow({ bundle: child, operations: OPS, standing: new Map(), children: [], reworks: [rework({})], parent: { id: 'P', standing: parentStanding } })
    expect(open.refusal?.code).toBe('PREVIOUS_NOT_REPORTED')
    expect(open.refusal?.message).toBe('Bundle B-C is in rework (RESTITCH): back to Op 20 Sew, found at Op 30 Final check.')
    expect(open.refusal?.final).toBe(false)
    // Before the fault's operation it carries the parent's reports; from there on none.
    expect(open.standing.get('C|op20')?.goodQuantity).toBe(2)
    expect(open.standing.has('C|op30')).toBe(false)

    const done = bundleFlow({ bundle: child, operations: OPS, standing: new Map(), children: [], reworks: [rework({ status: 'DONE', goodQuantity: 1 })], parent: { id: 'P', standing: parentStanding } })
    expect(done.refusal).toBeNull()
    // One came out good: Op 30 passed 1 of the child, so Op 40 takes 1.
    expect(done.standing.get('C|op30')?.goodQuantity).toBe(1)
  })

  it('a whole bundle sent back adds its good garments to the report that counted them as rework', () => {
    const single = { id: 'S', code: 'B-S', quantity: 1, createdAt: T(0) }
    const own = standingOf(scan('S', 'op10', 1, 0, 1), scan('S', 'op30', 0, 1, 3))
    const held = bundleFlow({ bundle: single, operations: OPS, standing: own, children: [], reworks: [rework({ quantity: 1, sourceScanId: 'S-op30' })], parent: null })
    expect(held.refusal?.message).toContain('Bundle B-S is in rework')
    const back = bundleFlow({ bundle: single, operations: OPS, standing: own, children: [], reworks: [rework({ quantity: 1, status: 'DONE', goodQuantity: 1, sourceScanId: 'S-op30' })], parent: null })
    expect(back.refusal).toBeNull()
    expect(back.standing.get('S|op30')?.goodQuantity).toBe(1)
  })
})
