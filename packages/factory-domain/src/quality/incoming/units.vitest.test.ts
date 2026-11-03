import { describe, expect, it } from 'vitest'
import { EVENT_DEFINITIONS } from '../../events/catalogue'
import {
  certificateCheck,
  componentDraftProblems,
  componentVerdict,
  counterProblems,
  heldWords,
  isEn1621,
  isRollLot,
  pointsOf,
  pointsPer100SqYd,
  receiptDecision,
  receiptLotOf,
  receiptNextWords,
  receiptSplit,
  rollDecisionProblems,
  rollDraftProblems,
  rollSampleWords,
  rollSummary,
  rollVerdict,
  type CertificateFact,
  type ReceiptLineFact,
} from './units'

/** B-W2b-111: rolls by the 4-point system, component checks and goods back from a workshop (QHS-032, QHS-033, QHS-036). Made-up values only. */

const paths = (issues: readonly { path: string }[]) => issues.map((issue) => issue.path)
const counts = (onePoint: number, twoPoint: number, threePoint: number, fourPoint: number) => ({ onePoint, twoPoint, threePoint, fourPoint })

describe('the 4-point system (QHS-032)', () => {
  it('scores the counters and works out points per 100 square yards as the database does', () => {
    expect(pointsOf(counts(3, 2, 1, 4))).toBe(3 + 4 + 3 + 16)
    // 150 cm × 50 m = 75 m² = 89.70 sq yd; 26 points × 100 / 89.70 = 28.99.
    expect(pointsPer100SqYd(counts(3, 2, 1, 4), '150.00', '50.00')).toBe('28.99')
    expect(pointsPer100SqYd(counts(0, 0, 0, 0), '150', '50')).toBe('0.00')
    expect(pointsPer100SqYd(counts(10, 10, 10, 10), '140', '20')).toBe('298.62')
  })

  it('suggests a decision against the limit, in both languages', () => {
    expect(rollVerdict('28.99')).toMatchObject({ suggested: 'ACCEPTED', over: false })
    expect(rollVerdict('40.00').suggested).toBe('ACCEPTED')
    const over = rollVerdict('40.01')
    expect(over).toMatchObject({ suggested: 'REJECTED', over: true })
    expect(over.words.en).toBe('40.01 points per 100 sq yd, over the limit of 40: reject the roll.')
    expect(over.words.it).toContain('40,01 punti')
    expect(rollVerdict('25', '20').suggested).toBe('REJECTED')
  })

  it('checks a roll as sent', () => {
    expect(rollDraftProblems({ rollRef: 'R-1', onePoint: 2, widthCm: '150.5', lengthM: '48' })).toEqual([])
    expect(paths(rollDraftProblems({ rollRef: '  ', onePoint: -1, twoPoint: 1.5, widthCm: '0', lengthM: '12.345' }))).toEqual(['rollRef', 'onePoint', 'twoPoint', 'widthCm', 'lengthM'])
    expect(paths(rollDraftProblems({ widthCm: '1500', note: 'x'.repeat(501) }))).toEqual(['widthCm', 'note'])
  })

  it('sums the rolls looked at, weighted by their square yards', () => {
    const summary = rollSummary([
      { ...counts(2, 0, 0, 0), widthCm: '150', lengthM: '50', decision: 'ACCEPTED' },
      { ...counts(0, 0, 0, 12), widthCm: '150', lengthM: '50', decision: 'REJECTED' },
      { ...counts(0, 0, 0, 0), widthCm: '150', lengthM: '25', decision: null },
    ])
    expect(summary).toMatchObject({ rolls: 3, lengthM: '125.00', points: 50, over: 1, accepted: 1, rejected: 1, undecided: 1, limit: '40' })
    expect(summary.pointsPer100SqYd).toBe('22.30')
    expect(summary.words.en).toBe('3 rolls · 125.00 m · 22.30 points per 100 sq yd (limit 40) · 1 over the limit.')
    expect(rollSummary([]).pointsPer100SqYd).toBeNull()
  })

  it('a lot counted in a length is inspected roll by roll, its sample a number of rolls', () => {
    expect(isRollLot('M')).toBe(true)
    expect(isRollLot('CM')).toBe(true)
    expect(isRollLot('HIDE')).toBe(false)
    expect(isRollLot('PCS')).toBe(false)
    expect(rollSampleWords(3, '120.0000', 'M', 1)).toEqual({ it: 'Controlla 3 rotoli del lotto di 120 m · 1 fatto', en: 'Inspect 3 rolls of the lot of 120 m · 1 done' })
  })

  it('the rolls of the sample bind the decision in the lot’s length', () => {
    const facts = { lotSize: '200', uom: 'M' as const, sampleSize: 3, rolls: [{ lengthM: '50.00', decision: 'ACCEPTED' as const }, { lengthM: '40.00', decision: 'REJECTED' as const }] }
    // Two of three rolls in: accept nothing beyond the 50 m accepted; reject at least the 40 m rejected.
    expect(paths(rollDecisionProblems({ accepted: '160', rejected: '40', toSort: '0' }, facts))).toEqual(['accepted'])
    expect(paths(rollDecisionProblems({ accepted: '50', rejected: '30', toSort: '120' }, facts))).toEqual(['rejected'])
    expect(rollDecisionProblems({ accepted: '50', rejected: '40', toSort: '110' }, facts)).toEqual([])
    // The whole sample in: the rest may be accepted.
    const full = { ...facts, rolls: [...facts.rolls, { lengthM: '30.00', decision: 'ACCEPTED' as const }] }
    expect(rollDecisionProblems({ accepted: '160', rejected: '40', toSort: '0' }, full)).toEqual([])
    // A lot in centimetres: the rolls' metres convert.
    expect(paths(rollDecisionProblems({ accepted: '16000', rejected: '3000', toSort: '1000' }, { ...full, lotSize: '20000', uom: 'CM' }))).toEqual(['rejected'])
  })
})

describe('components against spec and certificate (QHS-033)', () => {
  const today = '2026-11-03'
  const valid: CertificateFact = { id: 'c1', number: 'NB-1621-001', standard: 'EN 1621-1:2012', status: 'VALID', validFrom: '2024-01-01', validTo: '2028-12-31' }

  it('checks a component row as sent', () => {
    expect(componentDraftProblems({ kind: 'PROTECTOR', marking: 'EN 1621-1:2012 L1 A', protectorType: 'A', size: 'M', checkedQuantity: 13, defectiveQuantity: 0 })).toEqual([])
    expect(paths(componentDraftProblems({ kind: 'ZIP', protectorType: 'A', checkedQuantity: 5, defectiveQuantity: 6 }))).toEqual(['defectiveQuantity', 'protectorType'])
    expect(paths(componentDraftProblems({ kind: 'PROTECTOR', protectorType: 'C', checkedQuantity: 0 }))).toEqual(['checkedQuantity', 'protectorType'])
  })

  it('a protector is checked against an EN 1621 certificate in force', () => {
    expect(isEn1621('EN 1621-2:2014')).toBe(true)
    expect(isEn1621('EN 17092-4:2020')).toBe(false)
    expect(certificateCheck('PROTECTOR', valid, today).state).toBe('VALID')
    expect(certificateCheck('PROTECTOR', null, today).state).toBe('MISSING')
    expect(certificateCheck('ZIP', null, today).state).toBe('NOT_NEEDED')
    expect(certificateCheck('PROTECTOR', { ...valid, validTo: '2026-11-02' }, today).state).toBe('NOT_IN_FORCE')
    expect(certificateCheck('PROTECTOR', { ...valid, status: 'SUSPENDED' }, today).state).toBe('NOT_IN_FORCE')
    expect(certificateCheck('PROTECTOR', { ...valid, standard: 'EN 17092-4:2020' }, today).state).toBe('NOT_EN_1621')
    expect(certificateCheck('REFLECTIVE', { ...valid, standard: 'EN 17353:2020' }, today).state).toBe('VALID')
  })

  it('suggests rejecting a row with a piece not right or a protector whose certificate does not hold', () => {
    expect(componentVerdict({ kind: 'PROTECTOR', marking: 'EN 1621-1 L2 B', protectorType: 'B', checkedQuantity: 13, defectiveQuantity: 0 }, 'VALID')).toEqual({ suggested: 'ACCEPTED', reasons: [] })
    const missing = componentVerdict({ kind: 'PROTECTOR', marking: null, protectorType: null, checkedQuantity: 13, defectiveQuantity: 1 }, 'MISSING')
    expect(missing.suggested).toBe('REJECTED')
    expect(missing.reasons.map((reason) => reason.en)).toEqual([
      '1 of 13 not right.',
      'Without an EN 1621 certificate the protector goes into no PPE garment.',
      'Read the marking (standard, level, type).',
      'Say the type, A or B, as marked.',
    ])
    expect(componentVerdict({ kind: 'ZIP', checkedQuantity: 5, defectiveQuantity: 0 }, 'NOT_NEEDED').suggested).toBe('ACCEPTED')
    expect(componentVerdict({ kind: 'ZIP', checkedQuantity: 5, defectiveQuantity: 2 }, 'NOT_NEEDED').suggested).toBe('REJECTED')
  })

  it('counts units with a defect up to the sample', () => {
    expect(counterProblems({ critical: 0, major: 2, minor: 5 }, 8)).toEqual([])
    expect(paths(counterProblems({ critical: -1, major: 9, minor: 1.5 }, 8))).toEqual(['found/critical', 'found/major', 'found/minor'])
  })
})

describe('goods back from a workshop (QHS-036)', () => {
  const lines: ReceiptLineFact[] = [
    { id: 'l1', seq: 10, bundleCode: 'BN-1', operationCode: 'SEW', good: 10, defective: 0, scrapped: 0 },
    { id: 'l2', seq: 20, bundleCode: 'BN-2', operationCode: 'SEW', good: 8, defective: 2, scrapped: 1 },
    { id: 'l3', seq: 30, bundleCode: null, operationCode: 'SEW', good: 5, defective: 0, scrapped: 0 },
  ]

  it('the lot is the pieces back good and defective; the split follows the lines rejected', () => {
    expect(receiptLotOf(lines)).toBe(25)
    expect(receiptSplit(lines, new Set())).toEqual({ accepted: 23, rejected: 2 })
    expect(receiptSplit(lines, new Set(['l2']))).toEqual({ accepted: 15, rejected: 10 })
  })

  it('decides bundle by bundle, the quantities following', () => {
    const none = receiptDecision({ accepted: '23', rejected: '2', toSort: '0' }, lines)
    expect(none.problems).toEqual([])
    expect([...none.rejected]).toEqual([])
    const all = receiptDecision({ accepted: '0', rejected: '25', toSort: '0' }, lines)
    expect(all.problems).toEqual([])
    expect([...all.rejected].sort()).toEqual(['l1', 'l2', 'l3'])
    const named = receiptDecision({ accepted: '15', rejected: '10', toSort: '0', rejectedLines: ['l2'] }, lines)
    expect(named.problems).toEqual([])
    expect([...named.rejected]).toEqual(['l2'])
  })

  it('refuses a split without its lines, quantities that do not follow, sorting, unknown or twice-named lines', () => {
    expect(paths(receiptDecision({ accepted: '15', rejected: '10', toSort: '0' }, lines).problems)).toEqual(['rejectedLines'])
    const wrong = receiptDecision({ accepted: '20', rejected: '5', toSort: '0', rejectedLines: ['l2'] }, lines)
    expect(wrong.problems.map((problem) => problem.message)).toEqual(['Rejecting bundle BN-2 (SEW), 15 pieces are accepted and 10 rejected (every defective piece is rejected).'])
    expect(paths(receiptDecision({ accepted: '13', rejected: '2', toSort: '10' }, lines).problems)).toContain('toSort')
    expect(paths(receiptDecision({ accepted: '15', rejected: '10', toSort: '0', rejectedLines: ['l2', 'l2', 'nope'] }, lines).problems)).toEqual(['rejectedLines/1', 'rejectedLines/2'])
  })

  it('says what waits and what follows, in both languages', () => {
    expect(heldWords(25, 'IIN-2026-0009').en).toBe('25 pieces wait for incoming inspection IIN-2026-0009: they do not go on to the next operation and the workshop is not paid until it is decided.')
    expect(heldWords(1, 'IIN-1').it).toContain('1 pezzo attende')
    const words = receiptNextWords({ accepted: 15, rejected: 10 }, ['BN-2'])
    expect(words.en).toBe("15 accepted pieces go on to the next operation and into the workshop's fee; 10 rejected (BN-2: not reported at the operation; rework them or send them back to the workshop).")
    expect(receiptNextWords({ accepted: 0, rejected: 0 }, [], true).en).toBe('Inspection cancelled: the pieces go on as received.')
  })
})

describe('events', () => {
  it('an incoming inspection event names a lot or a workshop receipt', () => {
    const opened = EVENT_DEFINITIONS.find((event) => event.type === 'incoming_inspection.opened')!
    const base = { incomingInspectionId: '00000000-0000-4000-8000-000000000001', number: 'IIN-1', planVersionId: '00000000-0000-4000-8000-000000000002', lotSize: '25.0000', uom: 'PCS', sampleSize: 8, postedBy: 'OFFICE' }
    expect(opened.payload.safeParse({ ...base, lotId: null, subcontractReceiptId: '00000000-0000-4000-8000-000000000003', itemId: null }).success).toBe(true)
    const recorded = EVENT_DEFINITIONS.find((event) => event.type === 'incoming_inspection.recorded')!
    expect(recorded.payload.safeParse({ incomingInspectionId: base.incomingInspectionId, number: 'IIN-1', lotId: base.planVersionId, subcontractReceiptId: null, what: 'ROLL', hideId: null, done: 1, sampleSize: 3 }).success).toBe(true)
  })
})
