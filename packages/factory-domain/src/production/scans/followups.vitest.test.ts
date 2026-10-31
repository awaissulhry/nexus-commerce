import { describe, expect, it } from 'vitest'
import { bundleFlow } from '../bundles/split'
import { outsideCounts, outsidePlan, receiptLineClientId, rootReport, type OutsideFacts } from './outside'
import { CLIENT_SCAN_ID, correctionApprovalRefusal, standingScans, type ScanFact, type ScanOperation } from './rules'
import { wipOf, type WipRework } from './wip'

// B-W2b-10: the production follow-ups of B-W2a-13 (WIP and progress count rework orders; corrections capped at a split
// parent's live garments) and of B-W2a-25/-76 (the outside operation reported at receive back). Figures by hand.
// Routing: 10 cut, 20 sew, 30 inspect, 40 pack (all scanned). Cell c50 (quantity 5): bundle B carries 5 whole garments.
const op = (id: string, seq: number, kind: ScanOperation['workCentreKind']): ScanOperation => ({ id, seq, code: `OP-${seq}`, name: `Operation ${seq}`, scanRequired: true, workCentreKind: kind })
const OPS = [op('o10', 10, 'CUTTING'), op('o20', 20, 'SEWING'), op('o30', 30, 'INSPECTION'), op('o40', 40, 'PACKING')]
const T0 = new Date('2026-11-02T09:00:00.000Z')
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000)
let next = 0
const scan = (values: Partial<ScanFact> & Pick<ScanFact, 'workOrderOperationId'>): ScanFact => ({
  id: `s${++next}`,
  kind: 'REPORT',
  bundleId: 'B',
  correctsId: null,
  goodQuantity: 0,
  scrapQuantity: 0,
  reworkQuantity: 0,
  workerId: null,
  stationId: 'sew-01',
  deviceId: 'tab-1',
  clientScanId: `client-${next}`,
  deviceTime: null,
  serverTime: T0,
  ...values,
})
const rework = (values: Partial<WipRework> & Pick<WipRework, 'id' | 'quantity'>): WipRework => ({
  status: 'OPEN',
  goodQuantity: 0,
  scrapQuantity: 0,
  reasonCode: 'RESTITCH',
  foundAtOperationId: 'o20',
  reworkAtOperationId: 'o20',
  sourceScanId: null,
  createdAt: at(30),
  workOrderSizeId: 'c50',
  bundleId: 'B',
  ...values,
})
const cells = [{ id: 'c50', quantity: 5 }]
const row = (wip: ReturnType<typeof wipOf>, id: string) => wip.operations.find((entry) => entry.operationId === id)!

describe('WIP and progress count rework orders (B-W2b-10; B-W2a-13 follow-up)', () => {
  // B: cut 5, sewing 3 good and 2 for rework (scan s20); a rework of those 2 splits child C off B at 09:30.
  const cut = scan({ workOrderOperationId: 'o10', goodQuantity: 5, stationId: 'cut-01' })
  const sew = scan({ workOrderOperationId: 'o20', goodQuantity: 3, reworkQuantity: 2, serverTime: at(10) })
  const bundles = [
    { id: 'B', workOrderSizeId: 'c50', part: null, quantity: 5, createdAt: T0 },
    { id: 'C', workOrderSizeId: 'c50', part: null, quantity: 2, parentBundleId: 'B', createdAt: at(30) },
  ]
  const opened = rework({ id: 'R', quantity: 2, sourceScanId: sew.id, bundleId: 'C' })

  it('before W2b: the split child shows as missing and waiting, the rework only as a scan count', () => {
    // Without the bundles' parents and the rework orders, the figures are W1's: B as cut, no child flow.
    const wip = wipOf({ operations: OPS, cells, bundles: [bundles[0]!], scans: [cut, sew], lineOf: () => null })
    expect(row(wip, 'o20')).toMatchObject({ arrived: 5, good: 3, rework: 2, waiting: 0, missing: 0 })
  })

  it('an open rework holds its garments in rework where they were found: the child is neither waiting nor missing', () => {
    const wip = wipOf({ operations: OPS, cells, bundles, scans: [cut, sew], reworks: [opened], lineOf: () => null })
    // Op 10: B passed its 3 live garments, the child its 2 there before the split (its parent's report).
    expect(row(wip, 'o10')).toMatchObject({ arrived: 5, good: 5, waiting: 0, missing: 0, bundles: { done: 2, waiting: 0, notReached: 0 } })
    // Op 20: B 3 good; its 2 for rework are the rework order's now (counted once), the child waits for its rework.
    expect(row(wip, 'o20')).toMatchObject({ arrived: 5, good: 3, rework: 2, waiting: 0, missing: 0, bundles: { done: 1, waiting: 1, notReached: 0 } })
    expect(row(wip, 'o30')).toMatchObject({ arrived: 3, waiting: 3, bundles: { done: 0, waiting: 1, notReached: 1 } })
    expect(wip.cells).toEqual([{ workOrderSizeId: 'c50', quantity: 5, bundled: 5, sewn: 3, finished: 0, scrapped: 0, inRework: 2 }])
  })

  it('a DONE rework counts its good garments as passed and its scrap as scrapped; the next operation takes the good ones', () => {
    const done = { ...opened, status: 'DONE' as const, goodQuantity: 1, scrapQuantity: 1 }
    const wip = wipOf({ operations: OPS, cells, bundles, scans: [cut, sew], reworks: [done], lineOf: () => null })
    expect(row(wip, 'o20')).toMatchObject({ arrived: 5, good: 4, scrap: 1, rework: 0, waiting: 0, missing: 0 })
    expect(row(wip, 'o30')).toMatchObject({ arrived: 4, waiting: 4 })
    expect(wip.cells[0]).toMatchObject({ sewn: 4, scrapped: 1, inRework: 0 })
  })

  it('a whole bundle sent back by hand takes its garments out of the report that passed them', () => {
    const two = [{ id: 'W', workOrderSizeId: 'c50', part: null, quantity: 2, createdAt: T0 }]
    const scans = [scan({ workOrderOperationId: 'o10', bundleId: 'W', goodQuantity: 2 }), scan({ workOrderOperationId: 'o20', bundleId: 'W', goodQuantity: 2, serverTime: at(10) })]
    const byHand = rework({ id: 'H', bundleId: 'W', quantity: 2, foundAtOperationId: 'o20', reworkAtOperationId: 'o20' })
    const open = wipOf({ operations: OPS, cells, bundles: two, scans, reworks: [byHand], lineOf: () => null })
    expect(row(open, 'o20')).toMatchObject({ arrived: 2, good: 0, rework: 2, missing: 0 })
    expect(row(open, 'o30')).toMatchObject({ arrived: 2, waiting: 2 })
    const back = wipOf({ operations: OPS, cells, bundles: two, scans, reworks: [{ ...byHand, status: 'DONE', goodQuantity: 2 }], lineOf: () => null })
    expect(row(back, 'o20')).toMatchObject({ arrived: 2, good: 2, rework: 0 })
  })

  it('a rework with no bundle, or found outside the routing, counts in its cell only; a cancelled one nowhere', () => {
    const loose = rework({ id: 'L', bundleId: null, quantity: 1 })
    const outside = rework({ id: 'F', quantity: 1, foundAtOperationId: null, status: 'DONE', scrapQuantity: 1 })
    const cancelled = rework({ id: 'X', quantity: 2, status: 'CANCELLED' })
    const wip = wipOf({ operations: OPS, cells, bundles: [bundles[0]!], scans: [cut], reworks: [loose, outside, cancelled], lineOf: () => null })
    expect(row(wip, 'o20')).toMatchObject({ rework: 0, scrap: 0, waiting: 5 })
    expect(wip.cells[0]).toMatchObject({ inRework: 1, scrapped: 1 })
  })
})

describe('corrections capped at the live garments of a split (B-W2b-10; B-W2a-13 follow-up)', () => {
  it('a correction of a split parent is capped at the garments still in it, not at the bundle as cut', () => {
    // B (5) reported at Op 10 5 good; 2 split off (HOLD). A correction asking 4 good at Op 10 is more than B holds now.
    const report = scan({ workOrderOperationId: 'o10', goodQuantity: 5, stationId: 'cut-01' })
    const scans = [report]
    const flow = bundleFlow({ bundle: { id: 'B', code: 'BN-B', quantity: 5, createdAt: T0 }, operations: OPS, standing: standingScans(scans), children: [{ quantity: 2, status: 'ACTIVE' }], reworks: [], parent: null })
    const facts = {
      workOrder: { number: 'WO-1', status: 'IN_PROGRESS' as const },
      bundle: { code: 'BN-B', quantity: flow.quantity },
      target: report,
      operations: OPS,
      scans,
      standing: flow.standing,
      counts: { good: 4, scrap: 0, rework: 0 },
      lines: [],
      targetLines: [],
      status: 'PENDING' as const,
      approverInvolved: false,
    }
    expect(correctionApprovalRefusal(facts)).toMatchObject({ code: 'MORE_THAN_BUNDLE', message: 'Bundle BN-B carries 3 garments; 4 reported.' })
    expect(correctionApprovalRefusal({ ...facts, counts: { good: 2, scrap: 1, rework: 0 } })).toBeNull()
    // As cut (the W1 read), 4 would pass: the database alone caps at the bundle as cut.
    expect(correctionApprovalRefusal({ ...facts, bundle: { code: 'BN-B', quantity: 5 }, standing: undefined })).toBeNull()
  })
})

describe('the outside operation reported at receive back (B-W2b-10; B-W2a-25, -76 follow-up)', () => {
  const base: OutsideFacts = {
    line: { good: 3, defective: 1, scrapped: 1 },
    bundle: { code: 'BN-B', status: 'ACTIVE', live: 5 },
    workOrder: { number: 'WO-1', status: 'IN_PROGRESS' },
    operation: { seq: 20, name: 'Sewing (outside)' },
    standing: null,
    held: null,
    byPerson: true,
  }

  it('reports the bundle at the operation with the line counts: good, scrapped as scrap, defective as rework', () => {
    expect(outsideCounts(base.line)).toEqual({ good: 3, scrap: 1, rework: 1 })
    expect(outsidePlan(base)).toEqual({ action: 'REPORT', counts: { good: 3, scrap: 1, rework: 1 } })
    expect(CLIENT_SCAN_ID.test(receiptLineClientId('0b9f2a8e-55aa-4c1e-9d0f-2f5a4b0c7e11'))).toBe(true)
  })

  it('says in words why nothing is reported: no bundle, voided, work order not open, a hold, more than the bundle', () => {
    expect(outsidePlan({ ...base, bundle: null })).toMatchObject({ action: 'NONE', words: expect.stringContaining('without a bundle') })
    expect(outsidePlan({ ...base, bundle: { ...base.bundle!, status: 'VOID' } })).toMatchObject({ action: 'NONE', words: expect.stringContaining('voided') })
    expect(outsidePlan({ ...base, workOrder: { number: 'WO-1', status: 'ON_HOLD' } })).toMatchObject({ action: 'NONE', words: expect.stringContaining('Work order WO-1 is ON_HOLD') })
    expect(outsidePlan({ ...base, held: 'Bundle BN-B is on hold (QH-1).' })).toMatchObject({ action: 'NONE', words: expect.stringMatching(/^Bundle BN-B is on hold \(QH-1\)\. .*Report at the operation/) })
    expect(outsidePlan({ ...base, bundle: { ...base.bundle!, live: 4 } })).toMatchObject({ action: 'NONE', words: expect.stringContaining('carries 4 garments now') })
  })

  it('adds a later receipt to the report an earlier receipt made (a correction by the office person), never to a floor report', () => {
    const standing = { id: 'r1', goodQuantity: 2, scrapQuantity: 0, reworkQuantity: 0, fromReceipt: true }
    const line = { good: 2, defective: 0, scrapped: 1 }
    expect(outsidePlan({ ...base, line, standing })).toEqual({ action: 'CORRECTION', correctsId: 'r1', counts: { good: 4, scrap: 1, rework: 0 }, added: 3 })
    expect(outsidePlan({ ...base, line, standing, byPerson: false })).toMatchObject({ action: 'NONE', words: expect.stringContaining('the office adds these 3 garments') })
    expect(outsidePlan({ ...base, line, standing: { ...standing, fromReceipt: false } })).toMatchObject({ action: 'NONE', words: expect.stringContaining('on the floor') })
    expect(outsidePlan({ ...base, line: { good: 4, defective: 0, scrapped: 0 }, standing })).toMatchObject({ action: 'NONE', words: expect.stringContaining('6 would be reported') })
  })

  it('finds the report a correction chain started from', () => {
    const scans = [
      { id: 'a', kind: 'REPORT' as const, correctsId: null },
      { id: 'b', kind: 'CORRECTION' as const, correctsId: 'a' },
      { id: 'c', kind: 'CORRECTION' as const, correctsId: 'b' },
    ]
    expect(rootReport(scans, 'c')?.id).toBe('a')
    expect(rootReport(scans, 'a')?.id).toBe('a')
    expect(rootReport(scans, 'z')).toBeNull()
  })
})
