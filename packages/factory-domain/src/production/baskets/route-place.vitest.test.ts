import { describe, expect, it } from 'vitest'
import { operationFor, standingKey, type ScanFact, type ScanOperation } from '../scans/rules'
import { basketPlace, effectiveMoves, lastMove, type MoveFact } from './place'
import { basketRoute, ownRoute, standingEdits, type RouteEditFact } from './route'
import { departmentOfStep, hereOf, nextOfPlace, stepStates, type DepartmentLook } from './steps'

/**
 * owb-fl1 (order workflow build, S5): the ONE pure pair basketRoute / basketPlace (build/briefs/owb-fl2.md step 1 is the spec)
 * and the step helpers of the basket read. Written, not run (Owner rule: checks at the end).
 */

const op = (id: string, seq: number, kind: ScanOperation['workCentreKind'], more: Partial<ScanOperation> = {}): ScanOperation => ({ id, seq, code: id.toUpperCase(), name: id, scanRequired: true, workCentreKind: kind, ...more })
// Pattern-free route of four steps (Cutting 10, Stitching 20, Quality 30, Packing 40) and an extra operation at the end, not scanned.
const CUT = op('cut', 10, 'CUTTING')
const SEW = op('sew', 20, 'SEWING')
const QC = op('qc', 30, 'INSPECTION')
const PACK = op('pack', 40, 'PACKING')
const EXTRA = op('extra', 50, 'FINISHING', { scanRequired: false, unplanned: true })
const OPS: readonly ScanOperation[] = [CUT, SEW, QC, PACK, EXTRA]
const B = 'bundle-1'
const at = (minute: number): Date => new Date(Date.UTC(2026, 10, 28, 9, minute))

/** A standing report of bundle B at the step, at the minute. */
const report = (operationId: string, minute: number): ScanFact => ({
  id: `scan-${operationId}-${minute}`,
  kind: 'REPORT',
  bundleId: B,
  workOrderOperationId: operationId,
  correctsId: null,
  goodQuantity: 1,
  scrapQuantity: 0,
  reworkQuantity: 0,
  workerId: null,
  stationId: null,
  deviceId: null,
  clientScanId: `client-${operationId}-${minute}`,
  deviceTime: null,
  serverTime: at(minute),
})
const standingOf = (...reports: ScanFact[]): Map<string, ScanFact> => new Map(reports.map((row) => [standingKey(B, row.workOrderOperationId), row]))
const move = (id: string, kind: MoveFact['kind'], from: string | null, to: string | null, minute: number, undoesId: string | null = null): MoveFact => ({ id, kind, fromOperationId: from, toOperationId: to, undoesId, serverTime: at(minute) })
const edit = (kind: RouteEditFact['kind'], operationId: string): RouteEditFact => ({ kind, operationId })
const ids = (route: readonly ScanOperation[]): string[] => route.filter((step) => step.scanRequired).map((step) => step.id)

describe('basketRoute', () => {
  it('no edit: the operations array itself, not a copy (every reader answers as today)', () => {
    expect(basketRoute(OPS, [])).toBe(OPS)
    expect(ownRoute([])).toBe(false)
  })

  it('SKIP takes a step off this basket; PUT_BACK puts the newest skip back; the last step is never skipped', () => {
    const skipped = basketRoute(OPS, [edit('SKIP', 'qc')])
    expect(skipped).not.toBe(OPS)
    expect(ids(skipped)).toEqual(['cut', 'sew', 'pack'])
    expect(skipped.find((step) => step.id === 'qc')).toMatchObject({ scanRequired: false, skipped: true })
    expect(ids(basketRoute(OPS, [edit('SKIP', 'qc'), edit('PUT_BACK', 'qc')]))).toEqual(['cut', 'sew', 'qc', 'pack'])
    // Skipped twice, put back once: still skipped.
    expect(ids(basketRoute(OPS, [edit('SKIP', 'qc'), edit('SKIP', 'qc'), edit('PUT_BACK', 'qc')]))).toEqual(['cut', 'sew', 'pack'])
    // The last step stays last (the command refuses it; read here as nothing).
    expect(ids(basketRoute(OPS, [edit('SKIP', 'pack')]))).toEqual(['cut', 'sew', 'qc', 'pack'])
    // The work order's own rows are never changed.
    expect(QC.scanRequired).toBe(true)
  })

  it('ADD puts an extra operation right before the last step, for this basket only', () => {
    const route = basketRoute(OPS, [edit('ADD', 'extra')])
    expect(ids(route)).toEqual(['cut', 'sew', 'qc', 'extra', 'pack'])
    const added = route.find((step) => step.id === 'extra')!
    expect(added).toMatchObject({ scanRequired: true, unplanned: false, added: true })
    expect(added.seq).toBeGreaterThan(QC.seq)
    expect(added.seq).toBeLessThan(PACK.seq)
    // Two added steps keep the order they were added in, both before the last.
    const two = basketRoute([...OPS, op('extra2', 60, 'FINISHING', { scanRequired: false, unplanned: true })], [edit('ADD', 'extra'), edit('ADD', 'extra2')])
    expect(ids(two)).toEqual(['cut', 'sew', 'qc', 'extra', 'extra2', 'pack'])
    expect(EXTRA.scanRequired).toBe(false)
  })

  it('NORMAL drops every earlier edit; later edits count again', () => {
    expect(basketRoute(OPS, [edit('SKIP', 'qc'), edit('ADD', 'extra'), edit('NORMAL', 'pack')]).map((step) => step.scanRequired)).toEqual(OPS.map((step) => step.scanRequired))
    expect(ownRoute([edit('SKIP', 'qc'), edit('NORMAL', 'pack')])).toBe(false)
    expect(ids(basketRoute(OPS, [edit('SKIP', 'qc'), edit('NORMAL', 'pack'), edit('SKIP', 'sew')]))).toEqual(['cut', 'qc', 'pack'])
    expect(standingEdits([edit('SKIP', 'qc'), edit('NORMAL', 'pack'), edit('ADD', 'extra')])).toEqual({ skipped: new Set(), added: ['extra'] })
  })
})

describe('basketPlace', () => {
  it('no move: EXACTLY today — the first scanned step with no standing report, as operationFor with no station', () => {
    const bundle = { code: 'B-1', quantity: 1, status: 'ACTIVE' as const, replacedCodes: [] }
    for (const standing of [standingOf(), standingOf(report('cut', 1)), standingOf(report('cut', 1), report('sew', 2)), standingOf(report('cut', 1), report('sew', 2), report('qc', 3))]) {
      const today = operationFor({ operations: OPS, station: null, standing, bundleId: B, bundle })
      expect(basketPlace(OPS, standing, B, [])).toEqual({ operationId: today.ok ? today.operation.id : null, how: 'SCANS' })
    }
    // Every step reported: Ready to ship.
    expect(basketPlace(OPS, standingOf(report('cut', 1), report('sew', 2), report('qc', 3), report('pack', 4)), B, [])).toEqual({ operationId: null, how: 'SCANS' })
  })

  it('BACK Quality → Stitching, then Done at Stitching (a FORWARD move) → Quality', () => {
    const standing = standingOf(report('cut', 1), report('sew', 2), report('qc', 3))
    const back = move('m1', 'BACK', 'qc', 'sew', 10)
    expect(basketPlace(OPS, standing, B, [back])).toEqual({ operationId: 'sew', how: 'MOVE' })
    // The second Done at Stitching writes a FORWARD move to the next step: Quality, whose report is older than that move.
    expect(basketPlace(OPS, standing, B, [back, move('m2', 'FORWARD', 'sew', 'qc', 12)])).toEqual({ operationId: 'qc', how: 'MOVE' })
  })

  it('a hand move Cutting → Stitching, then a Stitching report → Quality (Cutting stays unreported, by design)', () => {
    const hand = move('m1', 'FORWARD', 'cut', 'sew', 5)
    expect(basketPlace(OPS, standingOf(), B, [hand])).toEqual({ operationId: 'sew', how: 'MOVE' })
    expect(basketPlace(OPS, standingOf(report('sew', 6)), B, [hand])).toEqual({ operationId: 'qc', how: 'MOVE' })
  })

  it('an UNDO and the move it undoes count for nothing: back to today\'s answer', () => {
    const standing = standingOf(report('cut', 1))
    const moves = [move('m1', 'FORWARD', 'sew', 'qc', 5), move('m2', 'UNDO', 'qc', 'sew', 6, 'm1')]
    expect(effectiveMoves(moves)).toEqual([])
    expect(lastMove(moves)).toBeNull()
    expect(basketPlace(OPS, standing, B, moves)).toEqual({ operationId: 'sew', how: 'SCANS' })
  })

  it('a move to Ready to ship (no step) places it nowhere; a skipped anchor starts at the next scanned step', () => {
    expect(basketPlace(OPS, standingOf(), B, [move('m1', 'FORWARD', 'pack', null, 5)])).toEqual({ operationId: null, how: 'MOVE' })
    const route = basketRoute(OPS, [edit('SKIP', 'qc')])
    expect(basketPlace(route, standingOf(), B, [move('m1', 'TAKEN_HERE', 'sew', 'qc', 5)])).toEqual({ operationId: 'pack', how: 'MOVE' })
  })

  it('follows the basket\'s own route: a skipped step is passed, an added step is a stop', () => {
    expect(basketPlace(basketRoute(OPS, [edit('SKIP', 'sew')]), standingOf(report('cut', 1)), B, [])).toEqual({ operationId: 'qc', how: 'SCANS' })
    expect(basketPlace(basketRoute(OPS, [edit('ADD', 'extra')]), standingOf(report('cut', 1), report('sew', 2), report('qc', 3)), B, [])).toEqual({ operationId: 'extra', how: 'SCANS' })
  })
})

describe('the steps of a basket', () => {
  const look = (id: string, number: number): DepartmentLook => ({ id, number, name: `Dept ${number}`, shortName: `D${number}`, tone: 'blue', icon: 'shirt', nameI18n: {} })
  const DEPTS = [look('d-pattern', 1), look('d-cut', 2), look('d-patch', 3), look('d-stitch', 4), look('d-quality', 5), look('d-pack', 6)]

  it('a step\'s department: its route step\'s, else its library operation\'s, else its kind\'s default; a subcontracted step none', () => {
    expect(departmentOfStep({ routingDepartmentId: 'd-pattern', operationDepartmentId: 'd-cut', workCentreKind: 'CUTTING' }, DEPTS)?.id).toBe('d-pattern')
    expect(departmentOfStep({ routingDepartmentId: null, operationDepartmentId: 'd-patch', workCentreKind: 'SEWING' }, DEPTS)?.id).toBe('d-patch')
    expect(departmentOfStep({ routingDepartmentId: null, operationDepartmentId: null, workCentreKind: 'CUTTING' }, DEPTS)?.id).toBe('d-cut')
    expect(departmentOfStep({ routingDepartmentId: null, operationDepartmentId: null, workCentreKind: 'SUBCONTRACT' }, DEPTS)).toBeNull()
  })

  it('DONE before the place, HERE, NEXT, TODO, SKIPPED; Ready to ship: every scanned step DONE', () => {
    const route = basketRoute(OPS, [edit('SKIP', 'qc')])
    expect(stepStates(route, { operationId: 'sew', how: 'SCANS' })).toEqual([
      { operationId: 'cut', state: 'DONE', added: false },
      { operationId: 'sew', state: 'HERE', added: false },
      { operationId: 'qc', state: 'SKIPPED', added: false },
      { operationId: 'pack', state: 'NEXT', added: false },
    ])
    expect(stepStates(OPS, { operationId: null, how: 'SCANS' }).map((step) => step.state)).toEqual(['DONE', 'DONE', 'DONE', 'DONE'])
    expect(nextOfPlace(OPS, { operationId: 'sew', how: 'SCANS' })).toBe('qc')
    expect(nextOfPlace(OPS, { operationId: 'pack', how: 'SCANS' })).toBeNull()
  })

  it('the phone\'s department: the same as the place; on the route (Take it here); not on its route', () => {
    const departmentOf = new Map<string, string | null>([['cut', 'd-cut'], ['sew', 'd-stitch'], ['qc', 'd-quality'], ['pack', 'd-pack']])
    const place = { operationId: 'sew', how: 'SCANS' as const }
    expect(hereOf(OPS, place, departmentOf, null)).toEqual({ departmentId: null, sameDepartment: false, onRoute: false, takeHereOperationId: null })
    expect(hereOf(OPS, place, departmentOf, 'd-stitch')).toEqual({ departmentId: 'd-stitch', sameDepartment: true, onRoute: true, takeHereOperationId: null })
    expect(hereOf(OPS, place, departmentOf, 'd-quality')).toEqual({ departmentId: 'd-quality', sameDepartment: false, onRoute: true, takeHereOperationId: 'qc' })
    expect(hereOf(OPS, place, departmentOf, 'd-cut')).toEqual({ departmentId: 'd-cut', sameDepartment: false, onRoute: true, takeHereOperationId: 'cut' })
    expect(hereOf(OPS, place, departmentOf, 'd-patch')).toEqual({ departmentId: 'd-patch', sameDepartment: false, onRoute: false, takeHereOperationId: null })
  })
})
