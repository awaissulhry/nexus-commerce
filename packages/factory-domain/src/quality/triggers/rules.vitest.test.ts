import { describe, expect, it } from 'vitest'
import {
  becauseText,
  decide,
  drawOf,
  dueAtOf,
  dueHoursProblem,
  dueWords,
  EVENT_RULES,
  frequencyText,
  occurrencesOf,
  orderProblems,
  previewWords,
  recordKindOf,
  ruleProblems,
  selects,
  skipWords,
  type RuleFacts,
  type ScanFact,
} from './rules'

/** Inspection triggers (B-W2b-101; QHS-010, QHS-011): the rules, figures by hand. */

const STYLE = '0190a000-0000-7000-8000-000000000001'
const OTHER_STYLE = '0190a000-0000-7000-8000-000000000002'
const OP_SEW = '0190a000-0000-7000-8000-000000000003'
const CUSTOMER = '0190a000-0000-7000-8000-000000000004'
const MATERIAL = '0190a000-0000-7000-8000-000000000005'

describe('B-W2b-213: packing opens a final inspection; what a rule opens is due', () => {
  it('a packing rule names a final plan, every lot, a share or every Nth bundle, and the chips a bundle knows', () => {
    expect(EVENT_RULES.PACKING.held).toBeNull()
    expect(ruleProblems({ event: 'PACKING', stage: 'FINAL', appliesTo: [{ kind: 'STYLE', value: STYLE }], frequency: 'EVERY_LOT' })).toEqual([])
    expect(ruleProblems({ event: 'PACKING', stage: 'FINAL', appliesTo: [], frequency: 'EVERY_NTH_BUNDLE', frequencyValue: 4 })).toEqual([])
    expect(ruleProblems({ event: 'PACKING', stage: 'IN_LINE', appliesTo: [], frequency: 'EVERY_LOT' })).toEqual([{ path: 'planId', message: 'Packing opens a final inspection: pick a final plan.' }])
    expect(ruleProblems({ event: 'PACKING', stage: 'FINAL', appliesTo: [], frequency: 'FIRST_PIECE' }).map((p) => p.path)).toEqual(['frequency'])
    expect(ruleProblems({ event: 'PACKING', stage: 'FINAL', appliesTo: [{ kind: 'SUPPLIER', value: CUSTOMER }], frequency: 'EVERY_LOT' })).toEqual([{ path: 'appliesTo/0/kind', message: 'Packing does not know the supplier: this chip would never fit.' }])
    // A final plan is still never opened by an operation or a scan rule.
    expect(ruleProblems({ event: 'OPERATION_FINISHED', stage: 'FINAL', appliesTo: [], frequency: 'EVERY_LOT' }).map((p) => p.path)).toEqual(['planId'])
  })

  it('due within 1 to 720 hours, or none; the due time is the opening plus the hours', () => {
    expect(dueHoursProblem(null)).toBeNull()
    expect(dueHoursProblem(undefined)).toBeNull()
    expect(dueHoursProblem(1)).toBeNull()
    expect(dueHoursProblem(720)).toBeNull()
    expect(dueHoursProblem(0)?.path).toBe('dueHours')
    expect(dueHoursProblem(721)?.path).toBe('dueHours')
    expect(dueHoursProblem(2.5)?.path).toBe('dueHours')
    expect(ruleProblems({ event: 'GOODS_RECEIPT', stage: 'INCOMING', appliesTo: [], frequency: 'EVERY_LOT', dueHours: 0 }).map((p) => p.path)).toEqual(['dueHours'])
    const opened = new Date('2026-11-09T08:30:00.000Z')
    expect(dueAtOf(opened, 8)?.toISOString()).toBe('2026-11-09T16:30:00.000Z')
    expect(dueAtOf(opened, 48)?.toISOString()).toBe('2026-11-11T08:30:00.000Z')
    expect(dueAtOf(opened, null)).toBeNull()
    expect(dueAtOf(opened, 0)).toBeNull()
    expect(dueWords(8)).toEqual({ it: 'Da fare entro 8 h', en: 'Due within 8 h' })
    expect(dueWords(24)).toEqual({ it: 'Da fare entro 1 giorno', en: 'Due within 1 day' })
    expect(dueWords(72)?.en).toBe('Due within 3 days')
    expect(dueWords(null)).toBeNull()
  })

  it('why a packing rule opened nothing, in words', () => {
    expect(skipWords('NOTHING_WAITING', { subject: 'WO-0001 · PACK · bundle BN-1' }).en).toBe('WO-0001 · PACK · bundle BN-1: no finished garment waits for a final inspection (all released or in an open inspection already).')
    expect(skipWords('NO_PROFILE', { subject: 'WO-0001', plan: 'FIN-JACKET' }).en).toMatch(/^No AQL profile applies to WO-0001 \(not plan FIN-JACKET/)
    expect(skipWords('NO_INSPECTION_SERIES', { subject: 'WO-0001' }).it).toMatch(/serie dei numeri delle ispezioni finali/)
  })
})

describe('a rule (QHS-010)', () => {
  it('an event that can open something, a plan of the stage it opens, a frequency it takes', () => {
    expect(ruleProblems({ event: 'GOODS_RECEIPT', stage: 'INCOMING', appliesTo: [{ kind: 'MATERIAL', value: MATERIAL }], frequency: 'EVERY_LOT' })).toEqual([])
    expect(ruleProblems({ event: 'BUNDLE_SCAN', stage: 'IN_LINE', appliesTo: [], frequency: 'EVERY_NTH_BUNDLE', frequencyValue: 5 })).toEqual([])
    expect(ruleProblems({ event: 'OPERATION_FINISHED', stage: 'END_OF_LINE', appliesTo: [{ kind: 'OPERATION', value: OP_SEW }], frequency: 'PERCENT_OF_OPERATIONS', frequencyValue: 10 })).toEqual([])
    // Goods received open an incoming inspection, lot by lot.
    expect(ruleProblems({ event: 'GOODS_RECEIPT', stage: 'FINAL', appliesTo: [], frequency: 'FIRST_PIECE' }).map((p) => p.path)).toEqual(['planId', 'frequency'])
    // An operation opens an in-process check; the first piece is an in-line check.
    expect(ruleProblems({ event: 'OPERATION_FINISHED', stage: 'INCOMING', appliesTo: [], frequency: 'EVERY_LOT' }).map((p) => p.path)).toEqual(['planId'])
    expect(ruleProblems({ event: 'BUNDLE_SCAN', stage: 'CUTTING', appliesTo: [], frequency: 'FIRST_PIECE' })).toEqual([{ path: 'frequency', message: 'The first piece is an in-line check: pick an in-line plan, or another frequency.' }])
  })

  it("a return is held in words; the frequency's number; a chip the event never knows", () => {
    expect(EVENT_RULES.RETURN_RECEIVED.held).not.toBeNull()
    expect(ruleProblems({ event: 'RETURN_RECEIVED', stage: 'RETURN', appliesTo: [], frequency: 'EVERY_LOT' })[0]!.message).toBe('Not yet: a return has no inspection record; its grading stays on the return.')
    expect(ruleProblems({ event: 'OPERATION_FINISHED', stage: 'IN_LINE', appliesTo: [], frequency: 'PERCENT_OF_OPERATIONS', frequencyValue: 0 })).toEqual([{ path: 'frequencyValue', message: 'A share of the operations is 1 to 100 %.' }])
    expect(ruleProblems({ event: 'OPERATION_FINISHED', stage: 'IN_LINE', appliesTo: [], frequency: 'PERCENT_OF_OPERATIONS', frequencyValue: 101 }).map((p) => p.path)).toEqual(['frequencyValue'])
    expect(ruleProblems({ event: 'BUNDLE_SCAN', stage: 'IN_LINE', appliesTo: [], frequency: 'EVERY_NTH_BUNDLE' }).map((p) => p.path)).toEqual(['frequencyValue'])
    expect(ruleProblems({ event: 'BUNDLE_SCAN', stage: 'IN_LINE', appliesTo: [], frequency: 'FIRST_PIECE', frequencyValue: 3 })).toEqual([{ path: 'frequencyValue', message: 'This frequency takes no number.' }])
    expect(ruleProblems({ event: 'BUNDLE_SCAN', stage: 'IN_LINE', appliesTo: [{ kind: 'MATERIAL', value: MATERIAL }, { kind: 'SUPPLIER', value: CUSTOMER }], frequency: 'FIRST_PIECE' })).toEqual([
      { path: 'appliesTo/0/kind', message: 'Bundle scanned at an operation does not know the material: this chip would never fit.' },
      { path: 'appliesTo/1/kind', message: 'Bundle scanned at an operation does not know the supplier: this chip would never fit.' },
    ])
    expect(ruleProblems({ event: 'GOODS_RECEIPT', stage: 'INCOMING', appliesTo: [{ kind: 'CATEGORY', value: 'NOT_A_KIND' }], frequency: 'EVERY_LOT' }).map((p) => p.path)).toEqual(['appliesTo/0/value'])
  })

  it('the record each stage and frequency opens', () => {
    expect(recordKindOf('INCOMING', 'EVERY_LOT')).toBe('INCOMING')
    expect(recordKindOf('IN_LINE', 'FIRST_PIECE')).toBe('FIRST_PIECE')
    expect(recordKindOf('IN_LINE', 'EVERY_NTH_BUNDLE')).toBe('ROVING')
    expect(recordKindOf('CUTTING', 'PERCENT_OF_OPERATIONS')).toBe('CUTTING')
    expect(recordKindOf('END_OF_LINE', 'EVERY_LOT')).toBe('END_OF_LINE')
    expect(recordKindOf('FINAL', 'EVERY_LOT')).toBe('FINAL')
    expect(recordKindOf('RETURN', 'EVERY_LOT')).toBeNull()
  })

  it('a new order names every rule once', () => {
    const [a, b, c] = [STYLE, OTHER_STYLE, OP_SEW]
    expect(orderProblems([c, a, b], [a, b, c])).toEqual([])
    expect(orderProblems([a, a, b], [a, b, c]).map((p) => p.path)).toEqual(['order/1', 'order'])
    expect(orderProblems([a, b, c, MATERIAL], [a, b, c])).toEqual([{ path: 'order/3', message: 'Not a rule of this company.' }])
  })
})

describe('how often (QHS-011)', () => {
  const rule = (frequency: 'EVERY_LOT' | 'FIRST_PIECE' | 'EVERY_NTH_BUNDLE' | 'PERCENT_OF_OPERATIONS', frequencyValue: number | null = null) => ({ id: STYLE, frequency, frequencyValue })
  it('every lot and the first piece take the first; every Nth the Nth, 2Nth …', () => {
    expect([1, 2, 3].map((ordinal) => selects(rule('EVERY_LOT'), { ordinal, sampleKey: 'x' }))).toEqual([true, false, false])
    expect([1, 2].map((ordinal) => selects(rule('FIRST_PIECE'), { ordinal, sampleKey: 'x' }))).toEqual([true, false])
    expect([1, 2, 3, 4, 5, 6, 7].map((ordinal) => selects(rule('EVERY_NTH_BUNDLE', 3), { ordinal, sampleKey: 'x' }))).toEqual([false, false, true, false, false, true, false])
    expect([1, 2, 3].map((ordinal) => selects(rule('EVERY_NTH_BUNDLE', 1), { ordinal, sampleKey: 'x' }))).toEqual([true, true, true])
  })

  it('a share is a fixed draw per rule and subject, spread evenly', () => {
    expect(drawOf(STYLE, 'b|o')).toBe(drawOf(STYLE, 'b|o'))
    expect(drawOf(STYLE, 'b|o')).not.toBe(drawOf(OTHER_STYLE, 'b|o'))
    const keys = Array.from({ length: 4000 }, (_, n) => `bundle-${n}|op`)
    const share = (percent: number) => keys.filter((sampleKey) => selects(rule('PERCENT_OF_OPERATIONS', percent), { ordinal: 1, sampleKey })).length / keys.length
    expect(share(100)).toBe(1)
    expect(Math.abs(share(10) - 0.1)).toBeLessThan(0.02)
    expect(Math.abs(share(50) - 0.5)).toBeLessThan(0.03)
    // A bigger share takes every subject a smaller one took (the same draw, a higher bar).
    const at10 = keys.filter((sampleKey) => selects(rule('PERCENT_OF_OPERATIONS', 10), { ordinal: 1, sampleKey }))
    expect(at10.every((sampleKey) => selects(rule('PERCENT_OF_OPERATIONS', 25), { ordinal: 1, sampleKey }))).toBe(true)
  })

  it('in words, Italian and English', () => {
    expect(frequencyText('EVERY_NTH_BUNDLE', 5, 'en')).toBe('Every 5th bundle')
    expect(frequencyText('EVERY_NTH_BUNDLE', 2, 'en')).toBe('Every 2nd bundle')
    expect(frequencyText('EVERY_NTH_BUNDLE', 11, 'en')).toBe('Every 11th bundle')
    expect(frequencyText('EVERY_NTH_BUNDLE', 21, 'en')).toBe('Every 21st bundle')
    expect(frequencyText('EVERY_NTH_BUNDLE', 1, 'it')).toBe('Ogni pacco')
    expect(frequencyText('EVERY_NTH_BUNDLE', 5, 'it')).toBe('Un pacco ogni 5')
    expect(frequencyText('PERCENT_OF_OPERATIONS', 10, 'it')).toBe('10% delle operazioni')
    expect(frequencyText('FIRST_PIECE', null, 'en')).toBe('First piece')
  })
})

describe('the order: the first rule that fits decides, per kind of record', () => {
  const r = (id: string, sortOrder: number, recordKind: RuleFacts['recordKind'], chips: RuleFacts['chips'] = [], planChips: RuleFacts['planChips'] = []): RuleFacts => ({ id, sortOrder, recordKind, chips, planChips })
  const jacketsP1 = r('0190a000-0000-7000-8000-00000000000a', 10, 'ROVING', [{ kind: 'CATEGORY', value: 'JACKET' }, { kind: 'CUSTOMER', value: CUSTOMER }])
  const everything = r('0190a000-0000-7000-8000-00000000000b', 20, 'ROVING')
  const firstPiece = r('0190a000-0000-7000-8000-00000000000c', 30, 'FIRST_PIECE', [{ kind: 'OPERATION', value: OP_SEW }])
  const trousersPlan = r('0190a000-0000-7000-8000-00000000000d', 5, 'ROVING', [], [{ kind: 'CATEGORY', value: 'TROUSERS' }])
  const facts = { STYLE: [STYLE], CATEGORY: ['JACKET'], OPERATION: [OP_SEW], CUSTOMER: [CUSTOMER] }

  it('a narrow rule before a broad one; kinds never shadow each other; the plan must fit too', () => {
    const decided = decide([everything, firstPiece, jacketsP1, trousersPlan], facts)
    expect(decided.get('ROVING')?.rule.id).toBe(jacketsP1.id)
    expect(decided.get('ROVING')?.because).toEqual([{ kind: 'CATEGORY', value: 'JACKET' }, { kind: 'CUSTOMER', value: CUSTOMER }])
    expect(decided.get('FIRST_PIECE')?.rule.id).toBe(firstPiece.id)
    // Another customer's jackets: the broad rule.
    expect(decide([everything, jacketsP1], { ...facts, CUSTOMER: ['someone-else'] }).get('ROVING')?.rule.id).toBe(everything.id)
    // A kind the subject does not say fails the chip (a goods receipt says no operation).
    expect(decide([firstPiece], { STYLE: [STYLE] }).size).toBe(0)
    // Several customers on one work order: any of them fits.
    expect(decide([jacketsP1], { ...facts, CUSTOMER: ['someone-else', CUSTOMER] }).get('ROVING')?.rule.id).toBe(jacketsP1.id)
    expect(decide([], facts).size).toBe(0)
  })

  it('applies because …, in words', () => {
    expect(becauseText([{ kind: 'CATEGORY', label: 'Jackets' }, { kind: 'CUSTOMER', label: 'P1 Moto' }], 'en')).toBe('applies because: category Jackets, customer P1 Moto')
    expect(becauseText([], 'it')).toBe('si applica a tutto')
  })
})

describe("a bundle's first scan at an operation", () => {
  const WO = 'wo'
  const scan = (id: string, bundleId: string, kind: string, minute: number, op = 'op1'): ScanFact => ({ id, workOrderId: WO, workOrderOperationId: op, bundleId, kind, at: new Date(Date.UTC(2026, 10, 3, 8, minute)) })
  it('numbered by when each bundle reached the operation; later scans of a bundle count nothing', () => {
    const scans = [scan('s4', 'b2', 'REPORT', 9), scan('s1', 'b1', 'START', 1), scan('s2', 'b1', 'REPORT', 5), scan('s3', 'b2', 'START', 6), scan('s5', 'b1', 'UNDO', 10), scan('s6', 'b1', 'REPORT', 11), scan('s7', 'b3', 'REPORT', 12), scan('s8', 'b1', 'REPORT', 2, 'op2')]
    expect(occurrencesOf(scans, ['START', 'REPORT']).map((o) => [o.scanId, o.bundleId, o.workOrderOperationId, o.ordinal])).toEqual([
      ['s1', 'b1', 'op1', 1],
      ['s8', 'b1', 'op2', 1],
      ['s3', 'b2', 'op1', 2],
      ['s7', 'b3', 'op1', 3],
    ])
    expect(occurrencesOf(scans, ['REPORT']).map((o) => [o.scanId, o.ordinal, o.sampleKey])).toEqual([
      ['s8', 1, 'b1|op2'],
      ['s2', 1, 'b1|op1'],
      ['s4', 2, 'b2|op1'],
      ['s7', 3, 'b3|op1'],
    ])
  })
})

describe('words', () => {
  it('the preview, as the design says it', () => {
    const counts = { event: 'OPERATION_FINISHED' as const, considered: 120, fits: 40, earlier: 6, opened: 14, from: '2026-10-04', to: '2026-11-03', truncated: false }
    expect(previewWords(counts, 'en')).toBe('This rule would have created 14 inspections in the last month (2026-10-04 – 2026-11-03): 40 of 120 operations finished on a bundle fit it; 6 went to an earlier rule.')
    expect(previewWords({ ...counts, event: 'GOODS_RECEIPT', opened: 1, earlier: 0, truncated: true }, 'en')).toBe('This rule would have created at least 1 inspection in the last month (2026-10-04 – 2026-11-03): 40 of 120 lots received fit it.')
    expect(previewWords(counts, 'it')).toBe("Questa regola avrebbe creato 14 ispezioni nell'ultimo mese (2026-10-04 – 2026-11-03): 40 su 120 operazioni finite su un pacco le corrispondono; 6 sono andati a una regola precedente.")
  })

  it('why nothing opened', () => {
    expect(skipWords('FIRST_PIECE_LATE', { subject: 'WO-0001 at SEW', count: 3 }).en).toBe('WO-0001 at SEW: the run had gone on (3 bundles scanned at the operation) before the rule could hold it; a first piece is checked before the run, so none was opened.')
    expect(skipWords('LOT_NOT_COUNTED', { subject: 'Lot L-1', uom: 'M' }).en).toBe('Lot L-1 is in M: an AQL sample counts units (hides, rolls, pieces). Give the plan a fixed sample.')
  })
})
