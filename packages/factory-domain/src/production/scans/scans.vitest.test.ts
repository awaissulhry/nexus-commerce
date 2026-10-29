import { describe, expect, it } from 'vitest'
import { floorPrivacyStatus, floorReadiness, NO_DPIA_NOTE } from '../../privacy/readiness'
import { floorRulesStatus } from '../settings/monitoring'
import { W1_SCAN_REASONS } from './reasons'
import {
  capAt,
  clockCheck,
  correctionApprovalRefusal,
  correctionAskRefusal,
  finalOperationOf,
  nextScanned,
  normaliseDefects,
  previousScanned,
  reportDecision,
  scansReadyRefusal,
  scrapReasonColumn,
  sewnOperationOf,
  standingScans,
  subjectRefusal,
  undoRefusal,
  UNDO_WINDOW_MS,
  type ReportFacts,
  type ScanFact,
  type ScanOperation,
  type Viewer,
} from './rules'
import { wipOf } from './wip'

// Figures by hand. A routing of five operations: 10 cut, 20 sew, 25 a press that is not scanned, 30 inspection, 40 pack.
// Bundle B1 carries 10 whole garments of cell c50; B2 carries 4 sleeve sets of the same cell (a part bundle).
const op = (id: string, seq: number, kind: ScanOperation['workCentreKind'], scanRequired = true): ScanOperation => ({ id, seq, code: `OP-${seq}`, name: `Operation ${seq}`, scanRequired, workCentreKind: kind })
const OPS = [op('o40', 40, 'PACKING'), op('o10', 10, 'CUTTING'), op('o20', 20, 'SEWING'), op('o25', 25, 'FINISHING', false), op('o30', 30, 'INSPECTION')]
const T0 = new Date('2026-11-02T09:00:00.000Z')
const later = (seconds: number) => new Date(T0.getTime() + seconds * 1000)
let next = 0
const scan = (values: Partial<ScanFact> & Pick<ScanFact, 'workOrderOperationId'>): ScanFact => ({
  id: `s${++next}`,
  kind: 'REPORT',
  bundleId: 'B1',
  correctsId: null,
  goodQuantity: 0,
  scrapQuantity: 0,
  reworkQuantity: 0,
  workerId: 'maria',
  stationId: 'sew-01',
  deviceId: 'tab-1',
  clientScanId: `client-${next}`,
  deviceTime: null,
  serverTime: T0,
  ...values,
})
const maria: Viewer = { scanSubject: 'WORKER', workerId: 'maria', stationId: 'sew-01' }
const luca: Viewer = { scanSubject: 'WORKER', workerId: 'luca', stationId: 'sew-02' }
const bundle = { code: 'BN-7K-000010-X', quantity: 10, status: 'ACTIVE' as const, replacedCodes: [] as string[] }
const workOrder = { number: 'WO-00042', status: 'IN_PROGRESS' as const }
const facts = (scans: ScanFact[], overrides: Partial<ReportFacts> = {}): ReportFacts => ({
  workOrder,
  bundleId: 'B1',
  bundle,
  scanned: bundle.code,
  operations: OPS,
  operationId: null,
  station: { code: 'SEW-01', kind: 'SEWING' },
  kindReason: null,
  standing: standingScans(scans),
  counts: { good: 10, scrap: 0, rework: 0 },
  viewer: maria,
  stationCodes: new Map([['sew-01', 'SEW-01'], ['sew-02', 'SEW-02']]),
  timeZone: 'Europe/Rome',
  ...overrides,
})

describe('the operations a bundle is reported at (B-W1-14 final = last scanned; sewn = last sewing one)', () => {
  it('chains the scanned operations in routing order, skipping one that is not scanned', () => {
    expect(previousScanned(OPS, 'o10')).toBeNull()
    expect(previousScanned(OPS, 'o30')?.id).toBe('o20')
    // The press (25, not scanned) takes from 20 too; nothing waits for it.
    expect(previousScanned(OPS, 'o25')?.id).toBe('o20')
    expect(nextScanned(OPS, 'o20')?.id).toBe('o30')
    expect(nextScanned(OPS, 'o40')).toBeNull()
    expect(finalOperationOf(OPS)?.id).toBe('o40')
    expect(sewnOperationOf(OPS)?.id).toBe('o20')
    // An assembly step after the sewing one is where the garment is sewn; a routing that sews nowhere has none.
    expect(sewnOperationOf([...OPS, op('o22', 22, 'ASSEMBLY')])?.id).toBe('o22')
    expect(sewnOperationOf([op('a', 10, 'CUTTING'), op('b', 20, 'PACKING')])).toBeNull()
  })

  it('keeps one standing report per bundle and operation: an undo and a correction void the scan they name', () => {
    const report = scan({ workOrderOperationId: 'o20', goodQuantity: 10 })
    const undo = scan({ workOrderOperationId: 'o20', kind: 'UNDO', correctsId: report.id })
    const again = scan({ workOrderOperationId: 'o20', goodQuantity: 9, scrapQuantity: 1 })
    const correction = scan({ workOrderOperationId: 'o20', kind: 'CORRECTION', correctsId: again.id, goodQuantity: 10, deviceId: null })
    expect(standingScans([report]).get('B1|o20')?.id).toBe(report.id)
    expect(standingScans([report, undo]).has('B1|o20')).toBe(false)
    expect(standingScans([report, undo, again, correction]).get('B1|o20')?.id).toBe(correction.id)
  })
})

describe('scrap and rework reasons: one garment per tap, merged per reason (reason-first counting)', () => {
  it('merges the taps, sorts scrap first, and refuses a reason that is not in the list of its kind', () => {
    const lines = normaliseDefects(
      [
        { kind: 'REWORK', reason: 'RESTITCH', quantity: 1 },
        { kind: 'SCRAP', reason: 'STAIN', quantity: 1 },
        { kind: 'SCRAP', reason: 'LEATHER_FLAW', quantity: 1 },
        { kind: 'SCRAP', reason: 'STAIN', quantity: 1 },
      ],
      W1_SCAN_REASONS,
    )
    expect(lines).toEqual({
      ok: true,
      lines: [
        { kind: 'SCRAP', reason: 'LEATHER_FLAW', quantity: 1 },
        { kind: 'SCRAP', reason: 'STAIN', quantity: 2 },
        { kind: 'REWORK', reason: 'RESTITCH', quantity: 1 },
      ],
      scrap: 3,
      rework: 1,
    })
    // A rework code is no scrap reason.
    expect(normaliseDefects([{ kind: 'SCRAP', reason: 'RESTITCH', quantity: 1 }], W1_SCAN_REASONS)).toMatchObject({ ok: false, refusal: { code: 'UNKNOWN_REASON', final: true } })
    // The scan's one scrap reason column: one reason, else none (the defect lines hold several).
    expect(scrapReasonColumn([{ kind: 'SCRAP', reason: 'STAIN', quantity: 2 }, { kind: 'REWORK', reason: 'RESTITCH', quantity: 1 }])).toBe('STAIN')
    expect(scrapReasonColumn(lines.ok ? lines.lines : [])).toBeNull()
    expect(scrapReasonColumn([])).toBeNull()
  })
})

describe('a report (MES-069, MES-090): good + scrap + rework up to what the previous operation passed', () => {
  const cut = scan({ workOrderOperationId: 'o10', goodQuantity: 10, stationId: 'cut-01' })

  it('takes the bundle at the first operation up to its garments, and refuses more', () => {
    const atCut = facts([], { station: { code: 'CUT-01', kind: 'CUTTING' } })
    expect(reportDecision(atCut)).toMatchObject({ ok: true, operation: { id: 'o10' }, cap: 10, previous: null })
    expect(reportDecision({ ...atCut, counts: { good: 9, scrap: 1, rework: 1 } })).toMatchObject({
      ok: false,
      refusal: { code: 'MORE_THAN_BUNDLE', message: 'Bundle BN-7K-000010-X carries 10 garments; 11 reported.', fix: 'Count again: at most 10.' },
    })
  })

  it('caps a later operation at the good the previous one passed, and waits for it when it passed nothing yet', () => {
    const cutWithScrap = scan({ workOrderOperationId: 'o10', goodQuantity: 8, scrapQuantity: 2, stationId: 'cut-01' })
    expect(reportDecision(facts([cutWithScrap], { counts: { good: 7, scrap: 1, rework: 0 } }))).toMatchObject({ ok: true, operation: { id: 'o20' }, cap: 8, previous: { id: 'o10' } })
    expect(reportDecision(facts([cutWithScrap], { counts: { good: 9, scrap: 0, rework: 0 } }))).toMatchObject({
      ok: false,
      refusal: { code: 'MORE_THAN_PASSED', message: 'Op 10 Operation 10 passed 8 garments of bundle BN-7K-000010-X; 9 reported here.', final: true },
    })
    // Inspection (30) before sewing (20) passed it: refused, and sent again later (the sewing report may be queued elsewhere).
    expect(reportDecision(facts([cut], { operationId: 'o30', station: { code: 'QC-01', kind: 'INSPECTION' } }))).toMatchObject({
      ok: false,
      refusal: { code: 'PREVIOUS_NOT_REPORTED', message: 'Op 20 Operation 20 has not passed bundle BN-7K-000010-X yet.', final: false },
    })
    expect(reportDecision(facts([cut], { counts: { good: 0, scrap: 0, rework: 0 } }))).toMatchObject({ ok: false, refusal: { code: 'NO_COUNT' } })
  })

  it("says who reported it already in the viewer's words: 'you', or 'another person' (never a name)", () => {
    const sewn = scan({ workOrderOperationId: 'o20', goodQuantity: 10, serverTime: new Date('2026-11-02T09:41:00.000Z') })
    const own = reportDecision(facts([cut, sewn], { operationId: 'o20' }))
    expect(own).toMatchObject({ ok: false, refusal: { code: 'ALREADY_REPORTED', message: 'You reported bundle BN-7K-000010-X already at Op 20 at 10:41 on SEW-01.' } })
    const other = reportDecision(facts([cut, sewn], { operationId: 'o20', viewer: luca }))
    expect(other).toMatchObject({ ok: false, refusal: { code: 'ALREADY_REPORTED', fix: 'Discard this one: it was reported on another tablet.' } })
    expect(other.ok ? '' : other.refusal.message).toBe('Bundle BN-7K-000010-X is reported already at Op 20 at 10:41 on SEW-01, by another person (your team leader can see who): one report per bundle per operation.')
    expect(other.ok ? '' : other.refusal.message).not.toContain('maria')
  })

  it('finds the station’s operation, asks to pick one when two fit, and refuses another kind without a reason', () => {
    expect(reportDecision(facts([cut]))).toMatchObject({ ok: true, operation: { id: 'o20' } })
    const two = [...OPS, op('o35', 35, 'SEWING')]
    expect(reportDecision(facts([cut], { operations: two }))).toMatchObject({ ok: false, refusal: { code: 'CHOOSE_OPERATION', message: 'Op 20 Operation 20 · Op 35 Operation 35 of bundle BN-7K-000010-X are done at this station.' } })
    const sewn = scan({ workOrderOperationId: 'o20', goodQuantity: 10 })
    // Its sewing is reported: a second scan at a sewing station is answered "already reported", with when and where.
    expect(reportDecision(facts([cut, sewn]))).toMatchObject({ ok: false, refusal: { code: 'ALREADY_REPORTED' } })
    // A station whose kind the routing does not have: the bundle's next operation is named.
    expect(reportDecision(facts([cut, sewn], { station: { code: 'FIN-01', kind: 'FINISHING' } }))).toMatchObject({ ok: false, refusal: { code: 'NO_OPERATION_HERE', message: 'Bundle BN-7K-000010-X has nothing left to do at a finishing station: its next operation is Op 30 Operation 30.', fix: 'Take the bundle to Op 30.' } })
    const atPacking = facts([cut, sewn], { operationId: 'o30', station: { code: 'PACK-01', kind: 'PACKING' } })
    expect(reportDecision(atPacking)).toMatchObject({ ok: false, refusal: { code: 'OTHER_KIND', message: 'PACK-01 is a packing station; Op 30 Operation 30 is inspection work.' } })
    expect(reportDecision({ ...atPacking, kindReason: 'The inspection bench is down' })).toMatchObject({ ok: true, operation: { id: 'o30' }, cap: 10 })
    expect(reportDecision(facts([cut], { operationId: 'elsewhere' }))).toMatchObject({ ok: false, refusal: { code: 'NOT_AN_OPERATION' } })
  })

  it('refuses an old ticket with the new code, a void bundle and a work order that is not open', () => {
    expect(reportDecision(facts([], { scanned: 'BN-7K-000009-Q', bundle: { ...bundle, replacedCodes: ['BN-7K-000009-Q'] } }))).toMatchObject({
      ok: false,
      refusal: { code: 'REPLACED', fix: 'Discard it and scan the new ticket BN-7K-000010-X.' },
    })
    expect(reportDecision(facts([], { bundle: { ...bundle, status: 'VOID' } }))).toMatchObject({ ok: false, refusal: { code: 'VOIDED' } })
    expect(reportDecision(facts([], { workOrder: { number: 'WO-00042', status: 'COMPLETED' } }))).toMatchObject({ ok: false, refusal: { code: 'WORK_ORDER_NOT_OPEN' } })
  })
})

describe('undo of the last report (MES-095): own, last on the device, right after it, before the next operation took it', () => {
  const cut = scan({ workOrderOperationId: 'o10', goodQuantity: 10, stationId: 'cut-01', deviceId: 'tab-cut', workerId: 'anna' })
  const sewn = scan({ workOrderOperationId: 'o20', goodQuantity: 10, deviceTime: T0, serverTime: later(3600) })
  const undo = (overrides: Partial<Parameters<typeof undoRefusal>[0]> = {}) =>
    undoRefusal({ workOrder, target: sewn, operations: OPS, scans: [cut, sewn], latestOnDevice: sewn.id, deviceId: 'tab-1', viewer: maria, deviceTime: later(90), now: later(3700), ...overrides })

  it('undoes on the device clock: an offline queue sends report and undo an hour late, 90 seconds apart', () => {
    expect(undo()).toBeNull()
    expect(undo({ deviceTime: later(UNDO_WINDOW_MS / 1000 + 1) })).toMatchObject({ code: 'UNDO_TOO_LATE', fix: 'Ask a correction instead.' })
    // Without the device's times the server's decide: 100 seconds after the report was recorded is in time, 5 minutes not.
    expect(undo({ target: { ...sewn, deviceTime: null }, deviceTime: null })).toBeNull()
    expect(undo({ target: { ...sewn, deviceTime: null }, deviceTime: null, now: later(3600 + 300) })).toMatchObject({ code: 'UNDO_TOO_LATE' })
  })

  it("refuses another person's report, a report that is not the device's last, an undone one and one the next operation took", () => {
    expect(undo({ viewer: luca })).toMatchObject({ code: 'NOT_YOURS' })
    expect(undo({ deviceId: 'tab-2' })).toMatchObject({ code: 'NOT_YOURS' })
    expect(undo({ latestOnDevice: 'something-later' })).toMatchObject({ code: 'NOT_LAST' })
    const undone = scan({ workOrderOperationId: 'o20', kind: 'UNDO', correctsId: sewn.id })
    expect(undo({ scans: [cut, sewn, undone] })).toMatchObject({ code: 'VOIDED_ALREADY' })
    expect(undo({ target: undone })).toMatchObject({ code: 'NOT_A_REPORT' })
    const inspected = scan({ workOrderOperationId: 'o30', goodQuantity: 10, workerId: 'luca', stationId: 'qc-01', deviceId: 'tab-qc' })
    expect(undo({ scans: [cut, sewn, inspected] })).toMatchObject({ code: 'NEXT_REPORTED', message: 'Op 30 Operation 30 took this bundle already.' })
    expect(undo({ target: null })).toMatchObject({ code: 'UNKNOWN_SCAN' })
  })
})

describe('a correction (MES-096): asked by the one who took it, decided by another person, never under what the next operation took', () => {
  const cut = scan({ workOrderOperationId: 'o10', goodQuantity: 10, stationId: 'cut-01', workerId: 'anna', deviceId: 'tab-cut' })
  const sewn = scan({ workOrderOperationId: 'o20', goodQuantity: 9, scrapQuantity: 1 })
  const scrapLine = [{ kind: 'SCRAP' as const, reason: 'STAIN', quantity: 1 }]
  const ask = (overrides: Partial<Parameters<typeof correctionAskRefusal>[0]> = {}) =>
    correctionAskRefusal({ workOrder, bundle, target: sewn, operations: OPS, scans: [cut, sewn], counts: { good: 10, scrap: 0, rework: 0 }, lines: [], targetLines: scrapLine, viewer: maria, pending: false, ...overrides })

  it('takes new counts within the caps, and refuses the same counts, another person, a pending ask and too many', () => {
    expect(ask()).toBeNull()
    expect(ask({ counts: { good: 9, scrap: 1, rework: 0 }, lines: scrapLine })).toMatchObject({ code: 'SAME_COUNTS' })
    // The same counts with another reason is a correction of the reason.
    expect(ask({ counts: { good: 9, scrap: 1, rework: 0 }, lines: [{ kind: 'SCRAP', reason: 'TEAR', quantity: 1 }] })).toBeNull()
    expect(ask({ viewer: luca })).toMatchObject({ code: 'NOT_YOURS' })
    expect(ask({ pending: true })).toMatchObject({ code: 'ASKED_ALREADY' })
    expect(ask({ counts: { good: 11, scrap: 0, rework: 0 } })).toMatchObject({ code: 'MORE_THAN_PASSED' })
  })

  it('keeps the good at least what the next operation took', () => {
    const inspected = scan({ workOrderOperationId: 'o30', goodQuantity: 9, workerId: 'luca', stationId: 'qc-01', deviceId: 'tab-qc' })
    expect(ask({ scans: [cut, sewn, inspected], counts: { good: 8, scrap: 2, rework: 0 }, lines: [{ kind: 'SCRAP', reason: 'STAIN', quantity: 2 }] })).toMatchObject({
      code: 'LESS_THAN_TAKEN',
      message: 'Op 30 Operation 30 took 9 garments of bundle BN-7K-000010-X already; 8 good is fewer.',
    })
    expect(ask({ scans: [cut, sewn, inspected] })).toBeNull()
  })

  it('is decided by another person, once, while the scan it corrects still stands', () => {
    const approve = (overrides: Partial<Parameters<typeof correctionApprovalRefusal>[0]> = {}) =>
      correctionApprovalRefusal({ workOrder, bundle, target: sewn, operations: OPS, scans: [cut, sewn], counts: { good: 10, scrap: 0, rework: 0 }, lines: [], targetLines: scrapLine, status: 'PENDING', approverInvolved: false, ...overrides })
    expect(approve()).toBeNull()
    expect(approve({ approverInvolved: true })).toMatchObject({ code: 'SELF_APPROVAL' })
    expect(approve({ status: 'APPROVED' })).toMatchObject({ code: 'DECIDED_ALREADY' })
    const corrected = scan({ workOrderOperationId: 'o20', kind: 'CORRECTION', correctsId: sewn.id, goodQuantity: 10, deviceId: null })
    expect(approve({ scans: [cut, sewn, corrected] })).toMatchObject({ code: 'TARGET_VOIDED' })
    expect(approve({ workOrder: { number: 'WO-00042', status: 'COMPLETED' } })).toMatchObject({ code: 'WORK_ORDER_NOT_OPEN' })
  })
})

describe('work in progress (MES-167): per operation and cell, from the standing reports', () => {
  it('counts arrived, waiting, good, scrap, rework and bundles; sewn and finished per cell; output per line only', () => {
    const cells = [{ id: 'c50', quantity: 12 }, { id: 'c52', quantity: 6 }]
    const bundles = [
      { id: 'B1', workOrderSizeId: 'c50', part: null, quantity: 10 },
      { id: 'B3', workOrderSizeId: 'c52', part: null, quantity: 6 },
      { id: 'B2', workOrderSizeId: 'c50', part: 'Sleeves', quantity: 4 },
    ]
    const scans = [
      scan({ workOrderOperationId: 'o10', goodQuantity: 10, stationId: 'cut-01' }),
      scan({ workOrderOperationId: 'o10', bundleId: 'B3', goodQuantity: 6, stationId: 'cut-01' }),
      scan({ workOrderOperationId: 'o10', bundleId: 'B2', goodQuantity: 4, stationId: 'cut-01' }),
      // Sewing: B1 9 good, 1 scrapped; B3 4 good, 1 for rework, 1 missing.
      scan({ workOrderOperationId: 'o20', goodQuantity: 9, scrapQuantity: 1, stationId: 'sew-01' }),
      scan({ workOrderOperationId: 'o20', bundleId: 'B3', goodQuantity: 4, reworkQuantity: 1, stationId: 'sew-02' }),
      // Inspection: B1 passes 9; packing: B1 packs 9.
      scan({ workOrderOperationId: 'o30', goodQuantity: 9, stationId: 'qc-01' }),
      scan({ workOrderOperationId: 'o40', goodQuantity: 9, stationId: 'pack-01' }),
    ]
    const wip = wipOf({ operations: OPS, cells, bundles, scans, lineOf: (stationId) => (stationId.startsWith('sew') ? 'L1' : null) })
    const at = (id: string) => wip.operations.find((row) => row.operationId === id)!
    expect(at('o10')).toMatchObject({ arrived: 16, waiting: 0, good: 16, scrap: 0, bundles: { done: 2, waiting: 0, notReached: 0 }, partBundles: { done: 1, waiting: 0, notReached: 0 } })
    expect(at('o20')).toMatchObject({ arrived: 16, waiting: 0, good: 13, scrap: 1, rework: 1, missing: 1, sewn: true, lines: [{ lineId: 'L1', good: 13 }], partBundles: { done: 0, waiting: 1, notReached: 0 } })
    expect(at('o20').cells).toEqual([
      { workOrderSizeId: 'c50', arrived: 10, waiting: 0, good: 9, scrap: 1, rework: 0, missing: 0 },
      { workOrderSizeId: 'c52', arrived: 6, waiting: 0, good: 4, scrap: 0, rework: 1, missing: 1 },
    ])
    expect(at('o30')).toMatchObject({ arrived: 13, waiting: 4, good: 9, bundles: { done: 1, waiting: 1, notReached: 0 }, lines: [] })
    // The press (25) is not scanned: what sewing passed reaches it, and nothing waits for it downstream.
    expect(at('o25')).toMatchObject({ scanRequired: false, arrived: 13, waiting: 13 })
    expect(at('o40')).toMatchObject({ final: true, arrived: 9, good: 9, bundles: { done: 1, waiting: 0, notReached: 1 } })
    expect(wip.cells).toEqual([
      { workOrderSizeId: 'c50', quantity: 12, bundled: 10, sewn: 9, finished: 9, scrapped: 1, inRework: 0 },
      { workOrderSizeId: 'c52', quantity: 6, bundled: 6, sewn: 4, finished: 0, scrapped: 0, inRework: 1 },
    ])
    expect(wip).toMatchObject({ finalOperationId: 'o40', sewnOperationId: 'o20', allFinished: false })
    const done = wipOf({ operations: OPS, cells: [{ id: 'c50', quantity: 9 }], bundles: [bundles[0]!], scans, lineOf: () => null })
    expect(done.allFinished).toBe(true)
  })
})

describe('the gates and the clock', () => {
  const privacy = (dpia: boolean) => floorPrivacyStatus({ dpia: dpia ? { versionNo: 1, reviewDueOn: null } : null, workerNotice: { label: '2026-10' }, today: '2026-11-20' })
  it("holds scans until the floor is ready, in the gate's words, and sends them again later", () => {
    expect(scansReadyRefusal(floorReadiness(privacy(true), floorRulesStatus({ scanSubject: 'WORKER', basisOnRecord: true })))).toBeNull()
    expect(scansReadyRefusal(floorReadiness(privacy(false), floorRulesStatus({ scanSubject: 'WORKER', basisOnRecord: true })))).toEqual({
      code: 'FLOOR_NOT_READY',
      message: `Scans are held at this site until its floor is ready: ${NO_DPIA_NOTE}`,
      fix: 'Ask the office to finish the floor set-up; the queue sends the scan again by itself.',
      final: false,
    })
    expect(subjectRefusal({ scanSubject: 'WORKER', workerId: 'maria', acknowledged: false, stationId: 'sew-01' })).toMatchObject({ code: 'NOTICE_NOT_ACKNOWLEDGED', final: false })
    expect(subjectRefusal({ scanSubject: 'STATION', workerId: 'maria', acknowledged: false, stationId: null })).toMatchObject({ code: 'NO_STATION' })
    expect(subjectRefusal({ scanSubject: 'STATION', workerId: 'maria', acknowledged: false, stationId: 'sew-01' })).toBeNull()
  })

  it('reads the tablet clock against the server at the send', () => {
    expect(clockCheck(new Date('2026-11-02T09:53:00Z'), new Date('2026-11-02T10:00:00Z'))).toEqual({ skewSeconds: 420, off: true, flagged: false })
    expect(clockCheck(new Date('2026-11-02T09:58:00Z'), new Date('2026-11-02T10:00:00Z'))).toEqual({ skewSeconds: 120, off: false, flagged: false })
    expect(clockCheck(new Date('2026-11-04T10:00:00Z'), new Date('2026-11-02T10:00:00Z'))).toMatchObject({ flagged: true })
  })

  it('caps at the bundle without a previous operation', () => {
    expect(capAt(OPS, OPS.find((row) => row.id === 'o10')!, bundle, new Map(), 'B1')).toEqual({ ok: true, cap: 10, previous: null })
  })
})
