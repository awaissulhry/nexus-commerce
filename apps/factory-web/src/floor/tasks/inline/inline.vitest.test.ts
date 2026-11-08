import { describe, expect, it } from 'vitest'
import * as domain from '@nexus/factory-domain/quality/inprocess/rules'
import en from '../../../../messages/en/floor-inline.json'
import it_ from '../../../../messages/it/floor-inline.json'
import scansEn from '../../../../messages/en/floor-scans.json'
import scansIt from '../../../../messages/it/floor-scans.json'
import { causeOf, causeValue, NOT_KNOWN } from '../reasons/model'
import { workHold } from '../scans/checks'
import { firstPieceAt, firstPieceHolds, firstPieceLifted, firstPieceMessageFor, withFirstPiece, type FirstPieceFlag } from '../scans/first-piece'
import { causeOperations, KNOWN_REFUSALS as SCAN_REFUSALS, NO_COUNTS, reportPayload, withCause, type BundleCard } from '../scans/model'
import {
  approveHeld,
  checkWords,
  colourHeld,
  cuttingDecision,
  eolFailDecision,
  eolPassDecision,
  firstPieceDecision,
  IN_PROCESS_KINDS,
  IN_PROCESS_OUTCOMES,
  kindHeld,
  KNOWN_REFUSALS,
  measuredOutcome,
  NEW_EOL,
  NEW_ROVING,
  openFirstPieces,
  reworkReasonOf,
  rovingColourOf,
  rovingDecision,
  sendBackHeld,
  valueText,
  verdictOf,
  wayOf,
  withResult,
  withRovingPieces,
} from './model'

/** B-W2b-105: SCR-176's rules and the operation screen's first-piece hold and "Which operation caused it?", figures by hand. */

describe('the copies of factory-domain quality/inprocess (a browser module never imports it: node:crypto)', () => {
  it('has the same kinds and outcomes', () => {
    expect([...IN_PROCESS_KINDS]).toEqual([...domain.IN_PROCESS_KINDS])
    expect([...IN_PROCESS_OUTCOMES]).toEqual([...domain.IN_PROCESS_OUTCOMES])
  })
  it('suggests the roving light as the domain does', () => {
    for (const defectivePieces of [0, 1, 2, 5]) for (const critical of [false, true]) expect(rovingColourOf({ defectivePieces, critical })).toBe(domain.rovingColourOf({ defectivePieces, critical }))
  })
  it('measures against a nominal and a tolerance as the domain does', () => {
    for (const [value, nominal, tolerance] of [['64.3', '64.5', '0.5'], ['65.1', '64.5', '0.5'], ['64', '64.5', '0.5'], ['63.999', '64.5', '0.5'], ['56', '56', '0']] as const) expect(measuredOutcome(value, nominal, tolerance)).toBe(domain.measuredOutcome(value, nominal, tolerance))
  })
})

describe('which check', () => {
  it('holds a first piece and a cutting result offline, roving without a line', () => {
    expect(kindHeld('FIRST_PIECE', { online: false, hasLine: true })).toBe('online')
    expect(kindHeld('CUTTING', { online: false, hasLine: true })).toBe('online')
    expect(kindHeld('FIRST_PIECE', { online: true, hasLine: false })).toBeNull()
    expect(kindHeld('ROVING', { online: true, hasLine: false })).toBe('noLine')
    expect(kindHeld('ROVING', { online: false, hasLine: true })).toBe('online')
    expect(kindHeld('ROVING', { online: false, hasLine: true, boardKept: true })).toBeNull()
    expect(kindHeld('END_OF_LINE', { online: false, hasLine: false })).toBeNull()
  })
  it('lists the open first pieces, the oldest first', () => {
    const rows = [
      { id: 'b', kind: 'FIRST_PIECE', status: 'OPEN', createdAt: '2026-11-08T08:00:00.000Z' },
      { id: 'a', kind: 'FIRST_PIECE', status: 'OPEN', createdAt: '2026-11-08T07:00:00.000Z' },
      { id: 'c', kind: 'ROVING', status: 'OPEN', createdAt: '2026-11-08T06:00:00.000Z' },
      { id: 'd', kind: 'FIRST_PIECE', status: 'DECIDED', createdAt: '2026-11-08T05:00:00.000Z' },
    ]
    expect(openFirstPieces(rows).map((row) => row.id)).toEqual(['a', 'b'])
  })
})

describe('roving', () => {
  it('holds green with a piece wrong and anything but red with a critical defect (the API refuses both)', () => {
    expect(colourHeld('GREEN', { defectivePieces: 1 })).toBe('greenWithDefects')
    expect(colourHeld('AMBER', { defectivePieces: 1 })).toBeNull()
    expect(colourHeld('AMBER', { defectivePieces: 1, critical: true })).toBe('critical')
    expect(colourHeld('RED', { defectivePieces: 1, critical: true })).toBeNull()
    expect(colourHeld('GREEN', { defectivePieces: 0 })).toBeNull()
  })
  it('records the suggestion unless the inspector picks, one defect per piece, the defect only when found', () => {
    expect(rovingDecision(NEW_ROVING, false)).toEqual({ outcome: 'GREEN', pieces: 7, defectivePieces: 0, defects: 0 })
    expect(rovingDecision({ ...NEW_ROVING, defective: 1, defectId: 'd1' }, false)).toEqual({ outcome: 'AMBER', pieces: 7, defectivePieces: 1, defects: 1, defectCodeId: 'd1' })
    expect(rovingDecision({ ...NEW_ROVING, defective: 1, defectId: 'd1', colour: 'RED' }, false).outcome).toBe('RED')
    expect(rovingDecision({ ...NEW_ROVING, defective: 1, defectId: 'crit' }, true).outcome).toBe('RED')
    expect(rovingDecision({ ...NEW_ROVING, defective: 0, defectId: 'd1' }, false)).not.toHaveProperty('defectCodeId')
    // Its findings pass the domain's own rules.
    expect(domain.findingProblems('ROVING', rovingDecision({ ...NEW_ROVING, defective: 2, defectId: 'd1' }, false))).toEqual([])
  })
  it('never has more wrong pieces than looked at', () => {
    expect(withRovingPieces({ ...NEW_ROVING, defective: 5 }, 3)).toMatchObject({ pieces: 3, defective: 3 })
    expect(withRovingPieces(NEW_ROVING, 0).pieces).toBe(1)
  })
})

describe('end of line', () => {
  it('passes a bundle in one step with all its pieces; a defect names the pieces, the defect and one defect each', () => {
    expect(eolPassDecision(20)).toEqual({ outcome: 'PASS', pieces: 20 })
    expect(eolFailDecision({ ...NEW_EOL, defective: 2, defectId: 'd1' }, 20)).toEqual({ outcome: 'FAIL', pieces: 20, defectivePieces: 2, defects: 2, defectCodeId: 'd1' })
    expect(eolFailDecision({ ...NEW_EOL, defective: 40, defectId: 'd1' }, 20).defectivePieces).toBe(20)
    expect(domain.findingProblems('END_OF_LINE', eolFailDecision({ ...NEW_EOL, defective: 2, defectId: 'd1' }, 20))).toEqual([])
    expect(domain.findingProblems('END_OF_LINE', { ...eolPassDecision(20), defectivePieces: 0, defects: 0 })).toEqual([])
  })
  it('holds Send back until the defect, the operation and (with no OTHER) the rework reason are picked', () => {
    expect(sendBackHeld(NEW_EOL, false)).toBe('defect')
    expect(sendBackHeld({ ...NEW_EOL, defectId: 'd' }, false)).toBe('operation')
    expect(sendBackHeld({ ...NEW_EOL, defectId: 'd', operationId: 'o' }, false)).toBeNull()
    expect(sendBackHeld({ ...NEW_EOL, defectId: 'd', operationId: 'o' }, true)).toBe('reason')
    expect(sendBackHeld({ ...NEW_EOL, defectId: 'd', operationId: 'o', reasonCode: 'RESTITCH' }, true)).toBeNull()
  })
  it('sends back with OTHER when the tenant has it, else only the reason picked (never a guess)', () => {
    expect(reworkReasonOf([{ kind: 'REWORK', code: 'RESTITCH' }, { kind: 'REWORK', code: 'OTHER' }], null)).toBe('OTHER')
    expect(reworkReasonOf([{ kind: 'SCRAP', code: 'OTHER' }, { kind: 'REWORK', code: 'RESTITCH' }], null)).toBeNull()
    expect(reworkReasonOf([{ kind: 'REWORK', code: 'RESTITCH' }], 'RESTITCH')).toBe('RESTITCH')
  })
})

describe('cutting', () => {
  it('passes with none rejected, fails with the pieces to recut', () => {
    expect(cuttingDecision({ pieces: 20, rejected: 0, defectId: 'x' })).toEqual({ outcome: 'PASS', pieces: 20 })
    expect(cuttingDecision({ pieces: 20, rejected: 2, defectId: 'x' })).toEqual({ outcome: 'FAIL', pieces: 20, defectivePieces: 2, defects: 2, defectCodeId: 'x' })
    expect(cuttingDecision({ pieces: 20, rejected: 2, defectId: null })).not.toHaveProperty('defectCodeId')
    expect(domain.findingProblems('CUTTING', { defectivePieces: 0, defects: 0, ...cuttingDecision({ pieces: 20, rejected: 2, defectId: null }) })).toEqual([])
    expect(domain.findingProblems('CUTTING', { defectivePieces: 0, defects: 0, ...cuttingDecision({ pieces: 20, rejected: 0, defectId: null }) })).toEqual([])
  })
})

describe('first piece: the plan', () => {
  const check = (code: string, type: string, extra: Record<string, unknown> = {}) => ({ code, labelIt: `${code} it`, labelEn: `${code} en`, labelI18n: { ro: `${code} ro` }, type, checkClass: 'MAJOR', mandatory: true, nominal: null, tolerance: null, uom: null, choices: [], ...extra })
  it('answers taps, values, reads instructions and leaves words to the office', () => {
    expect(['PASS_FAIL', 'PHOTO', 'SIGNATURE', 'MEASUREMENT', 'COUNT', 'CHOICE', 'INSTRUCTION', 'FREE_TEXT'].map((type) => wayOf({ type }))).toEqual(['tap', 'tap', 'tap', 'value', 'value', 'value', 'read', 'office'])
    expect(checkWords(check('A', 'PASS_FAIL'), 'it')).toBe('A it')
    expect(checkWords(check('A', 'PASS_FAIL'), 'ro')).toBe('A ro')
    expect(checkWords(check('A', 'PASS_FAIL'), 'pl')).toBe('A en')
  })
  it('sends the WHOLE list with one first-unit answer put in', () => {
    const results = [{ code: 'A', sampleIndex: 1, outcome: 'PASS' as const, value: null }, { code: 'B', sampleIndex: 1, outcome: 'FAIL' as const, value: '3' }]
    expect(withResult(results, { code: 'B', outcome: 'PASS', value: '4' })).toEqual([{ code: 'A', sampleIndex: 1, outcome: 'PASS' }, { code: 'B', sampleIndex: 1, outcome: 'PASS', value: '4' }])
    expect(domain.resultProblems(withResult(results, { code: 'B', outcome: 'PASS', value: '4' }), [{ code: 'A', type: 'PASS_FAIL', nominal: null, tolerance: null, choices: [] }, { code: 'B', type: 'COUNT', nominal: null, tolerance: null, choices: [] }])).toEqual([])
  })
  it('takes a measurement\'s verdict from the numbers when the plan gives a tolerance', () => {
    const sleeve = check('S', 'MEASUREMENT', { nominal: '64.5', tolerance: '0.5' })
    expect(verdictOf(sleeve, valueText(64.3, 'MEASUREMENT'))).toBe('PASS')
    expect(verdictOf(sleeve, valueText(65.4, 'MEASUREMENT'))).toBe('FAIL')
    expect(verdictOf(check('C', 'COUNT'), '3')).toBeNull()
    expect(verdictOf(sleeve, '')).toBeNull()
    expect(valueText(64.30001, 'MEASUREMENT')).toBe('64.3')
    expect(valueText(3.4, 'COUNT')).toBe('3')
  })
  it('holds Approve while a required check is unanswered or a critical one failed; Reject never', () => {
    const checks = [check('A', 'PASS_FAIL', { checkClass: 'CRITICAL' }), check('B', 'MEASUREMENT'), check('I', 'INSTRUCTION', { mandatory: true }), check('O', 'PASS_FAIL', { mandatory: false })]
    expect(approveHeld({ checks, results: [], blockers: ['A', 'B'] })).toEqual({ key: 'left', count: 2 })
    expect(approveHeld({ checks, results: [{ code: 'A', sampleIndex: 1, outcome: 'PASS', value: null }, { code: 'B', sampleIndex: 1, outcome: 'PASS', value: '1' }], blockers: [] })).toBeNull()
    expect(approveHeld({ checks, results: [{ code: 'A', sampleIndex: 1, outcome: 'FAIL', value: null }], blockers: ['B'] })).toEqual({ key: 'critical', code: 'A' })
    expect(approveHeld({ checks: [], results: [], blockers: [] })).toBeNull()
  })
  it('signs one piece: approved with nothing wrong, rejected with one defect per failed check', () => {
    expect(firstPieceDecision('APPROVED', [])).toEqual({ outcome: 'APPROVED', pieces: 1, defectivePieces: 0, defects: 0 })
    expect(firstPieceDecision('REJECTED', [{ code: 'A', sampleIndex: 1, outcome: 'FAIL', value: null }, { code: 'B', sampleIndex: 1, outcome: 'FAIL', value: null }])).toEqual({ outcome: 'REJECTED', pieces: 1, defectivePieces: 1, defects: 2 })
    expect(firstPieceDecision('REJECTED', []).defects).toBe(1)
    expect(domain.findingProblems('FIRST_PIECE', firstPieceDecision('REJECTED', []))).toEqual([])
  })
})

describe('the operation screen (B-W2b-69\'s, here B-W2b-105): the first-piece hold', () => {
  const flag = (extra: Partial<FirstPieceFlag> = {}): FirstPieceFlag => ({ heldOperationIds: ['op-20'], firstBundle: false, check: { id: 'fp', status: 'OPEN', outcome: null, workOrderOperationId: 'op-20' }, message: null, fix: null, ...extra })
  const card = (firstPiece: FirstPieceFlag | null | undefined) => ({ firstPiece }) as Pick<BundleCard, 'firstPiece'>
  it('says held, rejected, the first bundle, or nothing', () => {
    expect(firstPieceAt(card(flag()), 'op-20')).toBe('held')
    expect(firstPieceAt(card(flag()), 'op-30')).toBeNull()
    expect(firstPieceAt(card(flag({ check: { id: 'fp', status: 'DECIDED', outcome: 'REJECTED', workOrderOperationId: 'op-20' } })), 'op-20')).toBe('rejected')
    expect(firstPieceAt(card(flag({ heldOperationIds: [], firstBundle: true })), 'op-20')).toBe('firstBundle')
    expect(firstPieceAt(card(flag({ heldOperationIds: [], firstBundle: true, check: { id: 'fp', status: 'OPEN', outcome: null, workOrderOperationId: null } })), 'op-30')).toBe('firstBundle')
    expect(firstPieceAt(card(null), 'op-20')).toBeNull()
    expect(firstPieceAt(card(undefined), 'op-20')).toBeNull()
    expect(firstPieceAt(card(flag()), null)).toBeNull()
  })
  it('holds Finish before anything else the operation asks', () => {
    expect(workHold({ steps: { open: 2, steps: [] }, asked: [], lots: [], counts: NO_COUNTS, expected: 20, firstPiece: firstPieceHolds(card(flag()), 'op-20') })).toEqual({ key: 'firstPiece' })
    expect(workHold({ steps: null, asked: [], lots: [], counts: NO_COUNTS, expected: 20, firstPiece: false })).toBeNull()
  })
  it('lifts with a success when a newer read holds it no more', () => {
    const before = card(flag()) as BundleCard
    const after = withFirstPiece(before, flag({ heldOperationIds: [], check: { id: 'fp', status: 'DECIDED', outcome: 'APPROVED', workOrderOperationId: 'op-20' } }))
    expect(firstPieceLifted(before, after, 'op-20')).toBe(true)
    expect(firstPieceLifted(after, after, 'op-20')).toBe(false)
    expect(firstPieceLifted(before, before, 'op-20')).toBe(false)
  })
  it('reads again on its work order\'s first-piece message only', () => {
    const wo = { workOrder: { id: 'wo-1' } } as Pick<BundleCard, 'workOrder'>
    expect(firstPieceMessageFor({ type: 'in_process_check.first_piece', fields: { workOrderId: 'wo-1' } }, wo)).toBe(true)
    expect(firstPieceMessageFor({ type: 'in_process_check.first_piece', fields: { workOrderId: 'wo-2' } }, wo)).toBe(false)
    expect(firstPieceMessageFor({ type: 'in_process_check.changed', fields: { workOrderId: 'wo-1' } }, wo)).toBe(false)
  })
})

describe('"Which operation caused it?" (MES-127)', () => {
  const ops = [
    { id: 'op-30', seq: 30, code: 'C', name: 'c' },
    { id: 'op-10', seq: 10, code: 'A', name: 'a' },
    { id: 'op-20', seq: 20, code: 'B', name: 'b' },
  ]
  it('offers the operations up to this one, this one marked', () => {
    expect(causeOperations({ operations: ops } as unknown as Pick<BundleCard, 'operations'>, { id: 'op-20', seq: 20 })).toEqual([
      { id: 'op-10', seq: 10, code: 'A', name: 'a', here: false },
      { id: 'op-20', seq: 20, code: 'B', name: 'b', here: true },
    ])
  })
  it('charges each kind\'s lines to the operation picked; Not known charges nothing', () => {
    const counts = withCause({ scrap: { STAIN: 2 }, rework: { RESTITCH: 1 }, typedGood: null }, 'SCRAP', 'op-10')
    const body = reportPayload({ bundle: { code: 'BN-1' } } as Pick<BundleCard, 'bundle'>, 'op-20', counts, 20)
    expect(body).toMatchObject({ scrap: [{ reason: 'STAIN', quantity: 2, causedAtOperationId: 'op-10' }], rework: [{ reason: 'RESTITCH', quantity: 1 }] })
    expect((body.rework as Record<string, unknown>[])[0]).not.toHaveProperty('causedAtOperationId')
    expect(reportPayload({ bundle: { code: 'BN-1' } } as Pick<BundleCard, 'bundle'>, 'op-20', withCause(counts, 'SCRAP', null), 20).scrap).toEqual([{ reason: 'STAIN', quantity: 2 }])
  })
  it('picks Not known by default and when the operation is no longer offered', () => {
    expect(causeValue({ operations: ops, value: null })).toBe(NOT_KNOWN)
    expect(causeValue({ operations: ops, value: 'op-99' })).toBe(NOT_KNOWN)
    expect(causeValue({ operations: ops, value: 'op-10' })).toBe('op-10')
    expect(causeOf(NOT_KNOWN)).toBeNull()
    expect(causeOf('op-10')).toBe('op-10')
  })
})

describe('words', () => {
  const words = (catalogue: unknown, code: string) => (catalogue as { refusal: Record<string, { message?: string; fix?: string }> }).refusal[code]
  it('has its own words for every refusal it knows, in both languages', () => {
    for (const code of KNOWN_REFUSALS) for (const catalogue of [en, it_]) expect(words(catalogue, code), code).toMatchObject({ message: expect.any(String), fix: expect.any(String) })
    for (const code of ['FIRST_PIECE', 'CHARGED_OPERATION_UNKNOWN']) {
      expect(SCAN_REFUSALS).toContain(code)
      for (const catalogue of [scansEn, scansIt]) expect(words(catalogue, code), code).toMatchObject({ message: expect.any(String), fix: expect.any(String) })
    }
  })
})
