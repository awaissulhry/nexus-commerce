import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS, FLOOR_SHARED_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { DEFAULT_GUARD_SETTINGS, guardFindings, passedTo } from '../guards/rules'
import { lastOperationOf } from '../reports/daily'
import { capAt, correctionAskRefusal, finalOperationOf, nextScanned, operationFor, previousScanned, reportDecision, sewnOperationOf, standingKey, undoRefusal, UNDO_WINDOW_MS, type ReportFacts, type ScanFact, type ScanOperation } from '../scans/rules'
import { wipOf } from '../scans/wip'
import { extraOperationProblem, extraPayOf, extraReasonText, unplannedSeq } from './rules'

const facts = { workOrder: { number: 'WO-1', open: true }, operation: { code: 'OP-EXTRA', active: true }, planned: false, added: false, centre: { kind: 'FINISHING', found: true }, reasonCode: 'QUALITY_FIX', note: null } as const

describe('an unplanned operation (MES-086)', () => {
  it('goes on an open work order, from the library, off the routing, with a reason', () => {
    expect(extraOperationProblem(facts)).toBeNull()
    expect(extraOperationProblem({ ...facts, workOrder: { number: 'WO-1', open: false } })).toMatch(/not released or in progress/)
    expect(extraOperationProblem({ ...facts, operation: null })).toMatch(/not an active operation/)
    expect(extraOperationProblem({ ...facts, operation: { code: 'OP-EXTRA', active: false } })).toMatch(/not an active operation/)
    expect(extraOperationProblem({ ...facts, planned: true })).toBe("OP-EXTRA is on this work order's routing already.")
    expect(extraOperationProblem({ ...facts, added: true })).toBe('OP-EXTRA was added to this work order already: scan the bundles at it.')
    expect(extraOperationProblem({ ...facts, centre: { kind: 'FINISHING', found: false } })).toBe('This site has no active finishing work centre for OP-EXTRA.')
    expect(extraOperationProblem({ ...facts, reasonCode: 'OTHER' })).toMatch(/few words/)
    expect(extraOperationProblem({ ...facts, reasonCode: 'OTHER', note: 'Extra bar tack' })).toBeNull()
  })

  it('sits after every operation of the work order', () => {
    expect(unplannedSeq([10, 20, 40])).toBe(50)
    expect(unplannedSeq([40, 10, 50])).toBe(60)
    expect(unplannedSeq([])).toBe(10)
  })

  it('tells what a report at it pays, in a word', () => {
    expect(extraPayOf({ piecePayOn: false, rated: true })).toBe('NO_PIECE_PAY')
    expect(extraPayOf({ piecePayOn: true, rated: true })).toBe('PIECE_RATE')
    expect(extraPayOf({ piecePayOn: true, rated: false })).toBe('OFF_STANDARD')
  })

  it('keeps the reason in words', () => {
    expect(extraReasonText('QUALITY_FIX', null)).toBe('To fix a defect')
    expect(extraReasonText('OTHER', 'Extra bar tack')).toBe('Other (say why): Extra bar tack')
  })

  it('the team leader on the tablet, the production office and the owner hold the right', () => {
    expect(FACTORY_PERMISSIONS.get('production.extraops.add')).toMatchObject({ area: 'production', risk: 'write' })
    expect(FLOOR_SHARED_PERMISSIONS).toContain('production.extraops.add')
    for (const key of ['team_leader', 'production_manager', 'floor_supervisor', 'owner']) expect(templateOf(key)?.permissions).toContain('production.extraops.add')
    expect(templateOf('operator')?.permissions).not.toContain('production.extraops.add')
  })
})

describe('a real step: it can be scanned, and nothing waits for it (B-W2b-82)', () => {
  const op = (id: string, seq: number, workCentreKind: ScanOperation['workCentreKind'], extra: Partial<ScanOperation> = {}): ScanOperation => ({ id, seq, code: id.toUpperCase(), name: id, scanRequired: true, workCentreKind, ...extra })
  const cut = op('cut', 10, 'CUTTING')
  const sew = op('sew', 20, 'SEWING')
  const pack = op('pack', 30, 'FINISHING')
  const extra = op('extra', 40, 'SEWING', { scanRequired: false, unplanned: true })
  const operations = [cut, sew, pack, extra]
  const at = new Date('2026-10-20T08:00:00Z')
  const scan = (operation: ScanOperation, good: number, more: Partial<ScanFact> = {}): ScanFact => ({ id: `s-${operation.id}`, kind: 'REPORT', bundleId: 'b1', workOrderOperationId: operation.id, correctsId: null, goodQuantity: good, scrapQuantity: 0, reworkQuantity: 0, workerId: 'w1', stationId: 'st', deviceId: 'd1', clientScanId: `c-${operation.id}-1234`, deviceTime: null, serverTime: at, ...more })
  const bundle = { code: 'BN-1', quantity: 20, status: 'ACTIVE' as const, replacedCodes: [] }
  const report = (facts: Partial<ReportFacts>): ReportFacts => ({
    workOrder: { number: 'WO-1', status: 'IN_PROGRESS' },
    bundleId: 'b1',
    bundle,
    scanned: 'BN-1',
    operations,
    operationId: extra.id,
    station: { code: 'SEW-1', kind: 'SEWING' },
    kindReason: null,
    standing: new Map(),
    counts: { good: 20, scrap: 0, rework: 0 },
    viewer: { scanSubject: 'WORKER', workerId: 'w1', stationId: 'st' },
    stationCodes: new Map(),
    timeZone: 'Europe/Rome',
    guarded: true,
    ...facts,
  })
  const guards = (operation: ScanOperation, standing: ReadonlyMap<string, ScanFact>, good: number, quantityGuard: 'STRICT' | 'FREE' = 'STRICT') =>
    guardFindings({ operations, operation, bundleId: 'b1', bundle: { code: 'BN-1', quantity: 20 }, workOrder: { number: 'WO-1' }, standing, counts: { good, scrap: 0, rework: 0 }, settings: { ...DEFAULT_GUARD_SETTINGS, quantityGuard, skippedOperationRule: 'STRICT' }, lines: { station: null, workOrder: null, lineHasKind: false } })

  it('is never the final or the sewn operation, and never the one before or after another', () => {
    expect(finalOperationOf(operations)?.id).toBe('pack')
    expect(sewnOperationOf(operations)?.id).toBe('sew')
    expect(nextScanned(operations, 'pack')).toBeNull()
    expect(previousScanned(operations, 'extra')).toBeNull()
    expect(nextScanned(operations, 'extra')).toBeNull()
    // Wherever it sits in the order.
    const between = [cut, { ...extra, seq: 15 }, sew, pack]
    expect(previousScanned(between, 'sew')?.id).toBe('cut')
    expect(nextScanned(between, 'cut')?.id).toBe('sew')
  })

  it('a scan never opens it by itself: a person picks it', () => {
    const open = operationFor({ operations, station: { code: 'SEW-1', kind: 'SEWING' }, standing: new Map([[standingKey('b1', 'sew'), scan(sew, 20)]]), bundleId: 'b1', bundle })
    // Every routing operation of this station is reported: the screen says so; it never falls through to the unplanned one.
    expect(open).toMatchObject({ ok: true, operation: { id: 'sew' } })
  })

  it('takes the bundle at any point, up to its own garments, whatever the routing passed', () => {
    expect(capAt(operations, extra, bundle, new Map(), 'b1')).toEqual({ ok: true, cap: 20, previous: null })
    expect(passedTo(operations, extra, 20, new Map(), 'b1')).toEqual({ previous: null, from: null, passed: 20, skipped: [] })
    expect(reportDecision(report({}))).toMatchObject({ ok: true, cap: 20, previous: null })
    expect(guards(extra, new Map(), 20).findings).toEqual([])
    // What the routing passed so far does not cap it (15 passed at cutting, 20 here).
    expect(guards(extra, new Map([[standingKey('b1', 'cut'), scan(cut, 15)]]), 20).findings).toEqual([])
    expect(reportDecision(report({ counts: { good: 21, scrap: 0, rework: 0 } }))).toMatchObject({ ok: false, refusal: { code: 'MORE_THAN_BUNDLE' } })
  })

  it('the next operation\'s guard reads the routing, never a report here', () => {
    const standing = new Map([
      [standingKey('b1', 'cut'), scan(cut, 15)],
      [standingKey('b1', 'extra'), scan(extra, 20)],
    ])
    const at20 = guards(sew, standing, 16)
    expect(at20.passed).toMatchObject({ from: { id: 'cut' }, passed: 15, skipped: [] })
    expect(at20.findings.map((finding) => finding.refusal.code)).toEqual(['MORE_THAN_PASSED'])
    // Not reported at it: nothing is skipped, even at a site that holds skipped operations.
    const placedBefore = [cut, sew, { ...extra, seq: 25 }, pack]
    expect(passedTo(placedBefore, pack, 20, new Map([[standingKey('b1', 'sew'), scan(sew, 18)]]), 'b1')).toMatchObject({ from: { id: 'sew' }, passed: 18, skipped: [] })
  })

  it('counts good garments only: scrap or rework here would stay in the routing\'s flow', () => {
    expect(reportDecision(report({ counts: { good: 19, scrap: 1, rework: 0 } }))).toMatchObject({ ok: false, refusal: { code: 'UNPLANNED_GOOD_ONLY', final: true } })
    expect(reportDecision(report({ counts: { good: 19, scrap: 0, rework: 1 } }))).toMatchObject({ ok: false, refusal: { code: 'UNPLANNED_GOOD_ONLY' } })
    // A routing operation still takes them.
    expect(reportDecision(report({ operationId: sew.id, counts: { good: 19, scrap: 1, rework: 0 } }))).toMatchObject({ ok: true })
    const target = scan(extra, 20)
    const refused = correctionAskRefusal({ workOrder: { number: 'WO-1', status: 'IN_PROGRESS' }, bundle, target, operations, scans: [target], counts: { good: 19, scrap: 1, rework: 0 }, lines: [{ kind: 'SCRAP', reason: 'STAIN', quantity: 1 }], targetLines: [], viewer: { scanSubject: 'WORKER', workerId: 'w1', stationId: 'st' }, pending: false })
    expect(refused?.code).toBe('UNPLANNED_GOOD_ONLY')
    expect(correctionAskRefusal({ workOrder: { number: 'WO-1', status: 'IN_PROGRESS' }, bundle, target, operations, scans: [target], counts: { good: 18, scrap: 0, rework: 0 }, lines: [], targetLines: [], viewer: { scanSubject: 'WORKER', workerId: 'w1', stationId: 'st' }, pending: false })).toBeNull()
  })

  it('is undone like any report: no later operation took it from here', () => {
    const target = scan(extra, 20, { serverTime: at })
    const taken = scan(pack, 20, { id: 's-pack2', serverTime: new Date(at.getTime() + 1000) })
    expect(undoRefusal({ workOrder: { number: 'WO-1', status: 'IN_PROGRESS' }, target, operations, scans: [taken, target], latestOnDevice: target.id, deviceId: 'd1', viewer: { scanSubject: 'WORKER', workerId: 'w1', stationId: 'st' }, deviceTime: null, now: new Date(at.getTime() + UNDO_WINDOW_MS - 1) })).toBeNull()
  })

  it('in WIP only what was reported there arrived there; it holds up no completion', () => {
    const bundles = [
      { id: 'b1', workOrderSizeId: 'c1', part: null, quantity: 20 },
      { id: 'b2', workOrderSizeId: 'c1', part: null, quantity: 20 },
    ]
    const done = (bundleId: string, operation: ScanOperation, good: number) => scan(operation, good, { id: `${bundleId}-${operation.id}`, bundleId })
    const scans = ['b1', 'b2'].flatMap((id) => [done(id, cut, 20), done(id, sew, 20), done(id, pack, 20)])
    const wip = wipOf({ operations, cells: [{ id: 'c1', quantity: 40 }], bundles, scans: [...scans, done('b1', extra, 5)], lineOf: () => null })
    const row = wip.operations.find((entry) => entry.operationId === 'extra')!
    expect(row).toMatchObject({ unplanned: true, final: false, sewn: false, arrived: 5, waiting: 0, good: 5, missing: 0, bundles: { done: 1, waiting: 0, notReached: 1 } })
    expect(wip.operations.find((entry) => entry.operationId === 'pack')).toMatchObject({ unplanned: false, final: true, good: 40 })
    expect(wip.allFinished).toBe(true)
    expect(wip.cells[0]).toMatchObject({ finished: 40, sewn: 40 })
    // No report at it at all: nothing waits there either.
    const none = wipOf({ operations, cells: [{ id: 'c1', quantity: 40 }], bundles, scans, lineOf: () => null })
    expect(none.operations.find((entry) => entry.operationId === 'extra')).toMatchObject({ arrived: 0, waiting: 0, bundles: { done: 0, waiting: 0, notReached: 2 } })
    expect(none.allFinished).toBe(true)
  })

  it('is no line\'s last operation: a garment leaves the line once', () => {
    const daily = operations.map((operation) => ({ id: operation.id, workOrderId: 'wo', seq: operation.seq, scanRequired: operation.scanRequired, workCentreId: operation.workCentreKind, standardMinutes: '1' }))
    expect(lastOperationOf(daily, new Set(['SEWING']))).toBe('sew')
  })
})
