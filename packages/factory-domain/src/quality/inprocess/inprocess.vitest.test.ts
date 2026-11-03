import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS, FLOOR_SHARED_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { EVENT_DEFINITIONS } from '../../events/catalogue'
import { QUEUED_ACTIONS, isFloorSyncKind } from '../../floor-sync/kinds'
import { summaryOf } from '../../floor-sync/rules'
import { chargedOperationRefusal, normaliseDefects, type DefectLine } from '../../production/scans/rules'
import { QUALITY_INPROCESS_PERMISSIONS } from './permissions'
import {
  chargeDisputeWords,
  chargesByOperation,
  dhuOf,
  findingProblems,
  firstPieceHold,
  firstPieceRefusal,
  firstPieceSha256,
  heldOperations,
  holdsScanKind,
  lineDhu,
  measuredOutcome,
  OUTCOMES_OF,
  placeProblems,
  resultProblems,
  rovingColourOf,
  STAGE_OF_KIND,
  type FirstPieceRow,
  type FirstPieceStatement,
} from './rules'

/**
 * In-process checks (B-W2b-99; QHS-039 … QHS-042, MES-127): the pure rules, figures worked by hand. The database's
 * InProcessCheck_guard and OperationScan_awaits_first_piece hold the same; the PG tests of apps/factory-api prove both agree.
 */

const at = (minute: number) => new Date(Date.UTC(2026, 10, 20, 8, minute))
const row = (id: string, extra: Partial<FirstPieceRow>): FirstPieceRow => ({ id, status: 'OPEN', outcome: null, bundleId: 'b1', workOrderOperationId: 'op30', createdAt: at(0), ...extra })

describe('where a check is (the database rule, in words)', () => {
  it('a first piece names its work order and first bundle; a cutting check its work order; roving and end of line a line or a work order', () => {
    expect(placeProblems('FIRST_PIECE', { workOrderId: 'wo' }).map((problem) => problem.path)).toEqual(['bundleId'])
    expect(placeProblems('FIRST_PIECE', { workOrderId: 'wo', bundleId: 'b' })).toEqual([])
    expect(placeProblems('CUTTING', { lineId: 'l' }).map((problem) => problem.path)).toEqual(['workOrderId'])
    expect(placeProblems('ROVING', {}).map((problem) => problem.path)).toEqual(['lineId'])
    expect(placeProblems('END_OF_LINE', { lineId: 'l' })).toEqual([])
    // A bundle or an operation always with its work order.
    expect(placeProblems('ROVING', { lineId: 'l', workOrderOperationId: 'op' }).map((problem) => problem.path)).toEqual(['workOrderId'])
  })

  it('first piece and roving run on in-line plans, cutting and end of line on their own stage', () => {
    expect(STAGE_OF_KIND).toEqual({ FIRST_PIECE: 'IN_LINE', CUTTING: 'CUTTING', ROVING: 'IN_LINE', END_OF_LINE: 'END_OF_LINE' })
    expect(OUTCOMES_OF.ROVING).toEqual(['GREEN', 'AMBER', 'RED'])
  })
})

describe('what a check found', () => {
  const paths = (...args: Parameters<typeof findingProblems>) => findingProblems(...args).map((problem) => problem.path)

  it('an end-of-line pass: one garment, no defect', () => {
    expect(paths('END_OF_LINE', { outcome: 'PASS', pieces: 1, defectivePieces: 0, defects: 0 })).toEqual([])
    expect(paths('END_OF_LINE', { outcome: 'PASS', pieces: 1, defectivePieces: 0, defects: 1 })).toEqual(['defects'])
  })

  it('an end-of-line defect names the defect and at least one piece with it', () => {
    expect(paths('END_OF_LINE', { outcome: 'FAIL', pieces: 20, defectivePieces: 2, defects: 3, defectCodeId: 'd' })).toEqual([])
    expect(paths('END_OF_LINE', { outcome: 'FAIL', pieces: 20, defectivePieces: 0, defects: 0, defectCodeId: 'd' })).toEqual(['defectivePieces', 'defectCodeId'])
    expect(paths('END_OF_LINE', { outcome: 'FAIL', pieces: 20, defectivePieces: 1, defects: 1 })).toEqual(['defectCodeId'])
  })

  it('counts: pieces from 1, defective up to the pieces, at least one defect on each', () => {
    expect(paths('ROVING', { outcome: 'AMBER', pieces: 0, defectivePieces: 0, defects: 0 })).toEqual(['pieces'])
    expect(paths('ROVING', { outcome: 'RED', pieces: 5, defectivePieces: 6, defects: 6 })).toEqual(['defectivePieces'])
    expect(paths('ROVING', { outcome: 'RED', pieces: 5, defectivePieces: 3, defects: 2 })).toEqual(['defects'])
    expect(paths('FIRST_PIECE', { outcome: 'PASS', pieces: 1, defectivePieces: 0, defects: 0 })).toEqual(['outcome'])
  })

  it('green means every piece right; a cutting fail names the pieces rejected', () => {
    expect(paths('ROVING', { outcome: 'GREEN', pieces: 7, defectivePieces: 1, defects: 1 })).toEqual(['outcome'])
    expect(paths('CUTTING', { outcome: 'FAIL', pieces: 40, defectivePieces: 0, defects: 0 })).toEqual(['defectivePieces'])
    expect(paths('CUTTING', { outcome: 'PASS', pieces: 40, defectivePieces: 2, defects: 2 })).toEqual(['defects'])
  })

  it('the roving traffic light: none wrong green, one amber, two or a critical red', () => {
    expect(rovingColourOf({ defectivePieces: 0 })).toBe('GREEN')
    expect(rovingColourOf({ defectivePieces: 1 })).toBe('AMBER')
    expect(rovingColourOf({ defectivePieces: 2 })).toBe('RED')
    expect(rovingColourOf({ defectivePieces: 1, critical: true })).toBe('RED')
  })
})

describe('DHU (QHS-042): defects per 100 pieces looked at', () => {
  it('by hand: 9 defects in 200 pieces is 4.5; 1 in 3 is 33.3; nothing looked at is none', () => {
    expect(dhuOf(9, 200)).toBe('4.5')
    expect(dhuOf(1, 3)).toBe('33.3')
    expect(dhuOf(0, 50)).toBe('0.0')
    expect(dhuOf(4, 0)).toBeNull()
  })

  it("the line's day counts its decided end-of-line checks only", () => {
    const day = lineDhu([
      { kind: 'END_OF_LINE', status: 'DECIDED', pieces: 20, defects: 0 },
      { kind: 'END_OF_LINE', status: 'DECIDED', pieces: 20, defects: 3 },
      { kind: 'END_OF_LINE', status: 'OPEN', pieces: 0, defects: 0 },
      { kind: 'ROVING', status: 'DECIDED', pieces: 7, defects: 5 },
    ])
    expect(day).toEqual({ checks: 2, pieces: 40, defects: 3, dhu: '7.5' })
  })
})

describe('the first-piece hold (QHS-039): exactly the database trigger', () => {
  it('nobody asked: nothing waits', () => {
    expect(firstPieceHold([], { bundleId: 'b2', workOrderOperationId: 'op30' }).held).toBe(false)
  })

  it('asked and open: other bundles wait, the first bundle goes through, another operation is free', () => {
    const rows = [row('fp1', {})]
    expect(firstPieceHold(rows, { bundleId: 'b2', workOrderOperationId: 'op30' }).held).toBe(true)
    expect(firstPieceHold(rows, { bundleId: 'b1', workOrderOperationId: 'op30' })).toMatchObject({ held: false, firstBundle: true })
    expect(firstPieceHold(rows, { bundleId: 'b2', workOrderOperationId: 'op40' }).held).toBe(false)
  })

  it('a rejected first piece keeps the hold; a new one approved lifts it; a cancelled one holds nothing', () => {
    expect(firstPieceHold([row('fp1', { status: 'DECIDED', outcome: 'REJECTED' })], { bundleId: 'b2', workOrderOperationId: 'op30' }).held).toBe(true)
    expect(firstPieceHold([row('fp1', { status: 'DECIDED', outcome: 'REJECTED' }), row('fp2', { status: 'DECIDED', outcome: 'APPROVED', createdAt: at(5) })], { bundleId: 'b2', workOrderOperationId: 'op30' }).held).toBe(false)
    expect(firstPieceHold([row('fp1', { status: 'CANCELLED' })], { bundleId: 'b2', workOrderOperationId: 'op30' }).held).toBe(false)
  })

  it('a first piece naming no operation holds every operation; one approved at op 30 frees op 30 only', () => {
    const rows = [row('whole', { workOrderOperationId: null }), row('fp30', { status: 'DECIDED', outcome: 'APPROVED', createdAt: at(3) })]
    expect(firstPieceHold(rows, { bundleId: 'b2', workOrderOperationId: 'op30' }).held).toBe(false)
    expect(firstPieceHold(rows, { bundleId: 'b2', workOrderOperationId: 'op40' }).held).toBe(true)
    expect(heldOperations(rows, ['op10', 'op30', 'op40'])).toEqual(['op10', 'op40'])
  })

  it('the newest first piece is the one shown; stopping and mending work always passes', () => {
    const hold = firstPieceHold([row('old', { status: 'DECIDED', outcome: 'REJECTED' }), row('new', { createdAt: at(9) })], { bundleId: 'b2', workOrderOperationId: 'op30' })
    expect(hold.check?.id).toBe('new')
    expect(['PAUSE', 'HAND_BACK', 'UNDO', 'CORRECTION'].map(holdsScanKind)).toEqual([false, false, false, false])
    expect(['REPORT', 'START', 'RESUME', 'PARTIAL'].map(holdsScanKind)).toEqual([true, true, true, true])
  })

  it('the hold in words, with the one fix', () => {
    const refusal = firstPieceRefusal({ workOrderNumber: 'WO-0007', firstBundleCode: 'B-000123', rejected: true })
    expect(refusal.code).toBe('FIRST_PIECE')
    expect(refusal.message).toContain('WO-0007')
    expect(refusal.message).toContain('rejected')
    expect(refusal.fix).toContain('B-000123')
    expect(refusal.final).toBe(false)
  })
})

describe('the first-piece signature', () => {
  it('is the SHA-256 of what was signed: the same statement the same hash, any change another', () => {
    const statement: FirstPieceStatement = { checkId: 'c', workOrderId: 'w', bundleId: 'b', workOrderOperationId: null, planVersionId: null, outcome: 'APPROVED', pieces: 1, defectivePieces: 0, defects: 0, results: [], signer: { workerId: 'x', userId: null }, at: '2026-11-20T08:00:00.000Z' }
    expect(firstPieceSha256(statement)).toMatch(/^[0-9a-f]{64}$/)
    expect(firstPieceSha256({ ...statement })).toBe(firstPieceSha256(statement))
    expect(firstPieceSha256({ ...statement, outcome: 'REJECTED' })).not.toBe(firstPieceSha256(statement))
  })
})

describe('plan results (the database result guard, in words)', () => {
  const checks = [
    { code: 'SEAM', type: 'PASS_FAIL', nominal: null, tolerance: null, choices: [] },
    { code: 'CHEST', type: 'MEASUREMENT', nominal: '56.000', tolerance: '1.000', choices: [] },
    { code: 'READ', type: 'INSTRUCTION', nominal: null, tolerance: null, choices: [] },
    { code: 'SHADE', type: 'CHOICE', nominal: null, tolerance: null, choices: ['A', 'B'] },
  ]
  it('a measurement passes exactly when the numbers say so: 56.8 against 56 ± 1 passes, 57.2 fails', () => {
    expect(measuredOutcome('56.8', '56.000', '1.000')).toBe('PASS')
    expect(measuredOutcome('57.001', '56.000', '1.000')).toBe('FAIL')
    expect(resultProblems([{ code: 'CHEST', outcome: 'PASS', value: '57.2' }], checks).map((problem) => problem.path)).toEqual(['results/0/outcome'])
  })
  it('an instruction takes no result, a choice one of its choices, a check once per unit', () => {
    expect(resultProblems([{ code: 'READ', outcome: 'PASS' }], checks).map((problem) => problem.path)).toEqual(['results/0/code'])
    expect(resultProblems([{ code: 'SHADE', outcome: 'PASS', value: 'C' }], checks).map((problem) => problem.path)).toEqual(['results/0/value'])
    expect(resultProblems([{ code: 'SEAM', outcome: 'PASS' }, { code: 'SEAM', outcome: 'FAIL' }], checks).map((problem) => problem.path)).toEqual(['results/1/code'])
    expect(resultProblems([{ code: 'SEAM', outcome: 'PASS' }, { code: 'SEAM', sampleIndex: 2, outcome: 'FAIL' }, { code: 'CHEST', outcome: 'NOT_APPLICABLE' }], checks)).toEqual([])
    expect(resultProblems([{ code: 'NOPE', outcome: 'PASS' }], checks).map((problem) => problem.path)).toEqual(['results/0/code'])
  })
})

describe('defects charged to an operation (MES-127): per operation, never per person', () => {
  it('sums each operation by source, most first', () => {
    expect(
      chargesByOperation([
        { source: 'END_OF_LINE', workOrderOperationId: 'op30', defects: 2 },
        { source: 'SCAN', workOrderOperationId: 'op30', defects: 1 },
        { source: 'ROVING', workOrderOperationId: 'op20', defects: 1 },
        { source: 'ROVING', workOrderOperationId: 'op40', defects: 0 },
      ]),
    ).toEqual([
      { workOrderOperationId: 'op30', defects: 3, bySource: { END_OF_LINE: 2, ROVING: 0, SCAN: 1 } },
      { workOrderOperationId: 'op20', defects: 1, bySource: { END_OF_LINE: 0, ROVING: 1, SCAN: 0 } },
    ])
  })

  it('a scan line charged to an operation stays its own line; a charge to another work order is refused', () => {
    const reasons = [{ kind: 'SCRAP' as const, code: 'STAIN', active: true }]
    const lines: DefectLine[] = [
      { kind: 'SCRAP', reason: 'STAIN', quantity: 1 },
      { kind: 'SCRAP', reason: 'STAIN', quantity: 2, causedAtOperationId: 'op20' },
      { kind: 'SCRAP', reason: 'STAIN', quantity: 1, causedAtOperationId: 'op20' },
    ]
    const normal = normaliseDefects(lines, reasons as never)
    expect(normal.ok && normal.lines).toEqual([
      { kind: 'SCRAP', reason: 'STAIN', quantity: 1 },
      { kind: 'SCRAP', reason: 'STAIN', quantity: 3, causedAtOperationId: 'op20' },
    ])
    expect(normal.ok && normal.scrap).toBe(4)
    expect(chargedOperationRefusal(lines, ['op20'])).toBeNull()
    expect(chargedOperationRefusal(lines, ['op10'])?.code).toBe('CHARGED_OPERATION_UNKNOWN')
  })

  it("the worker's dispute words name the defect, the operation and the bundle", () => {
    expect(chargeDisputeWords({ defect: 'STITCH-SKIP', operation: 'Op 30 Collar', bundleCode: 'B-000123', source: 'END_OF_LINE' })).toBe('Defect STITCH-SKIP charged to Op 30 Collar on B-000123 (end of line).')
  })
})

describe('the catalogues', () => {
  it('declares the two permissions, shares both with the floor and gives them to the templates the design names', () => {
    for (const name of QUALITY_INPROCESS_PERMISSIONS) {
      expect(FACTORY_PERMISSIONS.isDeclared(name)).toBe(true)
      expect(FLOOR_SHARED_PERMISSIONS).toContain(name)
    }
    const holders = (permission: string) => ROLE_TEMPLATES.filter((template) => (template.permissions as readonly string[]).includes(permission)).map((template) => template.key).sort()
    expect(holders('quality.inprocess.record')).toEqual(expect.arrayContaining(['floor_inspector', 'floor_supervisor', 'production_manager', 'quality_inspector', 'team_leader']))
    expect(holders('quality.inprocess.record')).not.toContain('operator')
  })

  it('declares the two events, the first piece reaching every tablet of the site', () => {
    const changed = EVENT_DEFINITIONS.find((event) => event.type === 'in_process_check.changed')
    const firstPiece = EVENT_DEFINITIONS.find((event) => event.type === 'in_process_check.first_piece')
    expect(changed?.live?.floor).toBe('quality.inprocess.view')
    expect(firstPiece?.live?.floor).toBe('floor.work')
  })

  it('queues a roving or end-of-line check offline (never who), and keeps a first piece online', () => {
    expect(isFloorSyncKind('quality.inprocess.record')).toBe(true)
    expect(QUEUED_ACTIONS['quality.inprocess.record'].permission).toBe('quality.inprocess.record')
    expect(summaryOf('quality.inprocess.record', { kind: 'END_OF_LINE', decision: { outcome: 'FAIL', pieces: 1 }, note: 'words' })).toEqual({ code: 'END_OF_LINE', target: 'FAIL', quantity: 1 })
  })
})
