import { describe, expect, it } from 'vitest'
import { placeOf, stuckOf, type PlaceFacts } from '../bundles/where'
import { DEFAULT_GUARD_SETTINGS, guardFindings, type GuardFacts } from '../guards/rules'
import { standingKey, type ScanFact, type ScanOperation } from '../scans/rules'
import { wipOf } from '../scans/wip'
import { MAX_BASKETS_PER_ACT, moveDecision, noQualityLeft, routeEditDecision, stayWords, stepOfDepartment, undoDecision, type MoveBasketFacts } from './moves'
import { basketPlace, type MoveFact } from './place'
import { basketRoute, type RouteEditFact } from './route'

/**
 * owb-fl2 (order workflow build, S5): moves by hand, undo, route edits (factory-domain baskets/moves), and the readers that follow
 * the basket's route and place — where (WAITING, a hand move's place), the guards (movedInto), WIP (moved) — with the proof that
 * with no edit and no move every answer is today's. Written, not run (Owner rule: checks at the end).
 */

const op = (id: string, seq: number, kind: ScanOperation['workCentreKind'], more: Partial<ScanOperation> = {}): ScanOperation => ({ id, seq, code: id.toUpperCase(), name: id, scanRequired: true, workCentreKind: kind, ...more })
const OPS: readonly ScanOperation[] = [op('cut', 10, 'CUTTING'), op('sew', 20, 'SEWING'), op('qc', 30, 'INSPECTION'), op('pack', 40, 'PACKING'), op('extra', 50, 'FINISHING', { scanRequired: false, unplanned: true })]
const B = 'bundle-1'
const at = (minute: number): Date => new Date(Date.UTC(2026, 10, 28, 9, minute))
const report = (operationId: string, minute: number, good = 4): ScanFact => ({ id: `scan-${operationId}-${minute}`, kind: 'REPORT', bundleId: B, workOrderOperationId: operationId, correctsId: null, goodQuantity: good, scrapQuantity: 0, reworkQuantity: 0, workerId: null, stationId: null, deviceId: null, clientScanId: `c-${operationId}-${minute}`, deviceTime: null, serverTime: at(minute) })
const standingOf = (...reports: ScanFact[]) => new Map(reports.map((row) => [standingKey(B, row.workOrderOperationId), row]))
const move = (id: string, kind: MoveFact['kind'], from: string | null, to: string | null, minute: number, undoesId: string | null = null, by: { workerId?: string | null; userId?: string | null } = {}) => ({ id, kind, fromOperationId: from, toOperationId: to, undoesId, serverTime: at(minute), workerId: by.workerId ?? null, userId: by.userId ?? null })
const basket = (standing: Map<string, ScanFact>, moves: MoveFact[] = [], edits: RouteEditFact[] = []): MoveBasketFacts => {
  const route = basketRoute(OPS, edits)
  return { bundleId: B, route, place: basketPlace(route, standing, B, moves), standing }
}

describe('moveDecision', () => {
  const twoDone = standingOf(report('cut', 1), report('sew', 2))
  it('FORWARD to a later step; TAKEN_HERE to any other step of the route; BACK to an earlier one', () => {
    expect(moveDecision('FORWARD', basket(twoDone), 'pack')).toEqual({ ok: true, from: 'qc', to: 'pack' })
    expect(moveDecision('TAKEN_HERE', basket(twoDone), 'sew')).toEqual({ ok: true, from: 'qc', to: 'sew' })
    expect(moveDecision('BACK', basket(twoDone), 'sew')).toEqual({ ok: true, from: 'qc', to: 'sew' })
  })

  it('stays: not on its route (another work order\'s step, a skipped one), already there, not later, not earlier', () => {
    expect(moveDecision('FORWARD', basket(twoDone), 'other-work-order-step')).toEqual({ ok: false, stay: 'NOT_ON_ROUTE' })
    expect(moveDecision('FORWARD', basket(twoDone, [], [{ kind: 'SKIP', operationId: 'pack' }, { kind: 'SKIP', operationId: 'qc' }]), 'qc')).toEqual({ ok: false, stay: 'NOT_ON_ROUTE' })
    expect(moveDecision('TAKEN_HERE', basket(twoDone), 'qc')).toEqual({ ok: false, stay: 'ALREADY_THERE' })
    expect(moveDecision('FORWARD', basket(twoDone), 'sew')).toEqual({ ok: false, stay: 'NOT_LATER' })
    expect(moveDecision('BACK', basket(twoDone), 'pack')).toEqual({ ok: false, stay: 'NOT_EARLIER' })
  })

  it('Ready to ship by hand only once the last step is reported (settle 7); never back to it', () => {
    expect(moveDecision('FORWARD', basket(twoDone), null)).toEqual({ ok: false, stay: 'PACK_FIRST' })
    const packed = standingOf(report('cut', 1), report('sew', 2), report('qc', 3), report('pack', 4))
    // A redo after Packing: moved back to Quality, the last step's report stands → Ready to ship by hand.
    expect(moveDecision('FORWARD', basket(packed, [move('m1', 'BACK', 'pack', 'qc', 10)]), null)).toEqual({ ok: true, from: 'qc', to: null })
    expect(moveDecision('BACK', basket(twoDone), null)).toEqual({ ok: false, stay: 'NOT_ON_ROUTE' })
    expect(stayWords('PACK_FIRST', 'B-1')).toBe('B-1: pack it first. Packed at Packing makes it ready to ship.')
  })

  it('one act takes at most 50 baskets', () => {
    expect(MAX_BASKETS_PER_ACT).toBe(50)
  })
})

describe('undoDecision', () => {
  it('the mover\'s own newest move: production.baskets.move; another person\'s, or moved since: production.baskets.route', () => {
    const own = move('m1', 'FORWARD', 'sew', 'qc', 5, null, { workerId: 'anna' })
    expect(undoDecision({ move: own, moves: [own], byWorkerId: 'anna', byUserId: null })).toEqual({ ok: true, needs: 'production.baskets.move', to: 'sew', from: 'qc' })
    expect(undoDecision({ move: own, moves: [own], byWorkerId: 'bruno', byUserId: null })).toMatchObject({ ok: true, needs: 'production.baskets.route' })
    const later = move('m2', 'FORWARD', 'qc', 'pack', 6, null, { workerId: 'bruno' })
    expect(undoDecision({ move: own, moves: [own, later], byWorkerId: 'anna', byUserId: null })).toMatchObject({ ok: true, needs: 'production.baskets.route' })
  })

  it('an UNDO is never undone; a move undone already is not undone twice', () => {
    const first = move('m1', 'FORWARD', 'sew', 'qc', 5)
    const undo = move('m2', 'UNDO', 'qc', 'sew', 6, 'm1')
    expect(undoDecision({ move: undo, moves: [first, undo], byWorkerId: null, byUserId: 'u' })).toEqual({ ok: false, code: 'NOT_UNDOABLE' })
    expect(undoDecision({ move: first, moves: [first, undo], byWorkerId: null, byUserId: 'u' })).toEqual({ ok: false, code: 'NOT_UNDOABLE' })
  })
})

describe('routeEditDecision, noQualityLeft, stepOfDepartment', () => {
  const route = basketRoute(OPS, [])
  it('the last step stays; what is done stays; only a skipped step is put back; ADD only a step not on the route', () => {
    expect(routeEditDecision('SKIP', { bundleId: B, route, standing: standingOf() }, 'pack')).toEqual({ ok: false, code: 'LAST_STAYS' })
    expect(routeEditDecision('SKIP', { bundleId: B, route, standing: standingOf(report('sew', 1)) }, 'sew')).toEqual({ ok: false, code: 'DONE_STAYS' })
    expect(routeEditDecision('SKIP', { bundleId: B, route, standing: standingOf() }, 'qc')).toEqual({ ok: true })
    expect(routeEditDecision('PUT_BACK', { bundleId: B, route, standing: standingOf() }, 'qc')).toEqual({ ok: false, code: 'NOT_SKIPPED' })
    expect(routeEditDecision('PUT_BACK', { bundleId: B, route: basketRoute(OPS, [{ kind: 'SKIP', operationId: 'qc' }]), standing: standingOf() }, 'qc')).toEqual({ ok: true })
    expect(routeEditDecision('ADD', { bundleId: B, route, standing: standingOf() }, 'extra')).toEqual({ ok: true })
    expect(routeEditDecision('ADD', { bundleId: B, route, standing: standingOf() }, 'sew')).toEqual({ ok: false, code: 'ALREADY_ON_ROUTE' })
  })

  it('a warning when no quality step is left; the same department\'s step in each basket\'s own route', () => {
    expect(noQualityLeft(route)).toBe(false)
    expect(noQualityLeft(basketRoute(OPS, [{ kind: 'SKIP', operationId: 'qc' }]))).toBe(true)
    const departmentOf = new Map<string, string | null>([['cut', 'd2'], ['sew', 'd4'], ['qc', 'd5'], ['pack', 'd6']])
    expect(stepOfDepartment(route, departmentOf, 'd5')?.id).toBe('qc')
    expect(stepOfDepartment(basketRoute(OPS, [{ kind: 'SKIP', operationId: 'qc' }]), departmentOf, 'd5', { skipped: true })?.id).toBe('qc')
    expect(stepOfDepartment(route, departmentOf, 'd9')).toBeNull()
  })
})

describe('where: WAITING, and a hand move\'s place (step 1b)', () => {
  const placeOps = OPS.map(({ id, seq, code, name, scanRequired }) => ({ id, seq, code, name, scanRequired }))
  const facts = (more: Partial<PlaceFacts> = {}): PlaceFacts => ({ status: 'ACTIVE', createdAt: at(0), operations: placeOps, standing: new Set(), lastScan: null, held: false, inRework: false, subcontract: null, ...more })

  it('a basket made at print with no report waits for its first step, and is never stuck; a bundle made at cutting is CUTTING, stuck after the limit', () => {
    const waiting = placeOf(facts({ madeAtPrint: true }))
    expect(waiting).toMatchObject({ place: 'WAITING', next: { id: 'cut' } })
    expect(stuckOf(waiting.place, 100 * 60, 4).stuck).toBe(false)
    const cut = placeOf(facts())
    expect(cut.place).toBe('CUTTING')
    expect(stuckOf(cut.place, 4 * 60, 4).stuck).toBe(true)
    // Left out: false (as before).
    expect(placeOf(facts({ madeAtPrint: false })).place).toBe('CUTTING')
  })

  it('moved by hand to a step: on the LINE with that step next; moved to Ready to ship: FINISHED; with no move: today\'s', () => {
    expect(placeOf(facts({ madeAtPrint: true, moved: { operationId: 'sew' } }))).toMatchObject({ place: 'LINE', next: { id: 'sew' } })
    expect(placeOf(facts({ standing: new Set(['cut', 'sew', 'qc', 'pack']), moved: { operationId: null } })).place).toBe('FINISHED')
    expect(placeOf(facts({ standing: new Set(['cut']), moved: null }))).toEqual(placeOf(facts({ standing: new Set(['cut']) })))
  })
})

describe('the guards after a hand move into the step (movedInto)', () => {
  const guardFacts = (more: Partial<GuardFacts> = {}): GuardFacts => ({
    operations: OPS,
    operation: OPS[2]!,
    bundleId: B,
    bundle: { code: 'B-1', quantity: 4 },
    workOrder: { number: 'WO-1' },
    standing: standingOf(report('cut', 1, 2)),
    counts: { good: 4, scrap: 0, rework: 0 },
    settings: { quantityGuard: 'STRICT', skippedOperationRule: 'STRICT' },
    lines: { station: null, workOrder: null, lineHasKind: false },
    ...more,
  })

  it('moved INTO the step: no skipped step, the cap is the basket\'s own garments; else the checks hold as today', () => {
    expect(guardFindings(guardFacts({ movedInto: true }))).toMatchObject({ cap: 4, findings: [] })
    const today = guardFindings(guardFacts())
    expect(today.findings.map((finding) => finding.kind).sort()).toEqual(['QUANTITY', 'SKIPPED_OPERATION'])
    // Left out or false: the same answer.
    expect(guardFindings(guardFacts({ movedInto: false }))).toEqual(today)
    expect(DEFAULT_GUARD_SETTINGS.quantityGuard).toBe('STRICT')
  })
})

describe('WIP: a basket moved into a step waits there', () => {
  it('with `moved` the step counts the basket waiting with its garments; without, as today', () => {
    const input: Parameters<typeof wipOf>[0] = { operations: OPS, cells: [{ id: 'cell-1', quantity: 4 }], bundles: [{ id: B, workOrderSizeId: 'cell-1', part: null, quantity: 4, status: 'ACTIVE' }], scans: [], lineOf: () => null }
    const row = (wip: ReturnType<typeof wipOf>, id: string) => wip.operations.find((entry) => entry.operationId === id)!
    // Today: nothing reported, the basket waits at the first step only.
    const today = wipOf(input)
    expect(row(today, 'sew').bundles.waiting).toBe(0)
    expect(row(today, 'cut').bundles.waiting).toBe(1)
    // Moved by hand to Stitching: it waits there with its 4 garments.
    const moved = wipOf({ ...input, moved: new Map([[B, 'sew']]) })
    expect(row(moved, 'sew').bundles.waiting).toBe(1)
    expect(row(moved, 'sew').waiting).toBe(4)
  })
})
