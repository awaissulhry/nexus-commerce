import { describe, expect, it } from 'vitest'
import {
  aqlText,
  CHECKLIST_CODES,
  checklistOf,
  checklistProblems,
  computedResult,
  decisionProblems,
  defectCounts,
  defectProblems,
  inspectionLabel,
  isOverride,
  planProblems,
  reasonProblem,
  resultWords,
  type ChecklistAnswer,
} from './rules'

/** The final inspection's rules (B-W1-45; QHS-013, QHS-050), figures by hand. */

const plan = { lotSize: 10, sampleSize: 5, inspectionLevel: 'II', aqlMajor: '2.5', aqlMinor: '4.0', acceptMajor: 1, acceptMinor: 2 }
const allOk = (): ChecklistAnswer[] => CHECKLIST_CODES.map((code) => ({ code, ok: true }))
const paths = (issues: readonly { path: string }[]) => issues.map((entry) => entry.path)

describe('the sampling plan', () => {
  it('takes a lot of the finished garments, a sample up to the lot and acceptance numbers up to the sample', () => {
    expect(planProblems(plan, { pieces: 12, finished: 10 })).toEqual([])
    // A 100 % inspection: the sample is the lot.
    expect(planProblems({ ...plan, sampleSize: 10 }, { pieces: 12, finished: 10 })).toEqual([])
    // 10 finished of 12 pieces: a lot of 11 is too much; the sample above the lot, an Ac above the sample.
    expect(paths(planProblems({ ...plan, lotSize: 11, sampleSize: 12, acceptMajor: 13 }, { pieces: 12, finished: 10 }))).toEqual(['lotSize', 'sampleSize', 'acceptMajor'])
    expect(planProblems({ ...plan, lotSize: 11 }, { pieces: 12, finished: 10 })[0]!.message).toBe('The lot is at most the 10 finished garment(s) of the work order (good at the final operation).')
    expect(paths(planProblems({ ...plan, lotSize: 0, sampleSize: 0, acceptMinor: -1, aqlMajor: '2.5000', aqlMinor: '101', inspectionLevel: ' ' }, { pieces: 12, finished: 10 }))).toEqual([
      'lotSize',
      'sampleSize',
      'acceptMinor',
      'aqlMajor',
      'aqlMinor',
      'inspectionLevel',
    ])
    // No scanned operation in the routing: nothing is finished, nothing is inspected.
    expect(planProblems(plan, { pieces: 12, finished: null })[0]!.message).toMatch(/no scanned operation/)
    expect(aqlText('2.5')).toBe('2.500')
  })
})

describe('the checklist', () => {
  it('knows the QHS-050 checks, each once; a failed check says why; a decision answers every check', () => {
    expect(CHECKLIST_CODES).toHaveLength(12)
    expect(checklistProblems(allOk(), { forDecision: true })).toEqual([])
    const answers: ChecklistAnswer[] = [
      { code: 'CE_MARK', ok: false },
      { code: 'CE_MARK', ok: true },
      { code: 'NO_SUCH', ok: true },
    ]
    expect(paths(checklistProblems(answers, { forDecision: false }))).toEqual(['checklist/0/note', 'checklist/1/code', 'checklist/2/code'])
    const missing = checklistProblems([{ code: 'CE_MARK', ok: null }], { forDecision: true })
    expect(missing).toHaveLength(1)
    expect(missing[0]!.message).toMatch(/^Answer every check before signing .*: EN 17092 class label matches the certificate class, Size label, Care label/)
    // Not applicable is an answer (an unarmoured garment).
    expect(checklistProblems([...allOk().filter((entry) => entry.code !== 'ARMOUR_FITTED'), { code: 'ARMOUR_FITTED', ok: null }], { forDecision: true })).toEqual([])
    expect(checklistOf([{ code: 'PACKAGING', ok: true, note: ' ' }, { code: 'CE_MARK', ok: false, note: ' wrong size ' }])).toEqual([
      { code: 'CE_MARK', ok: false, note: 'wrong size' },
      { code: 'PACKAGING', ok: true, note: null },
    ])
  })
})

describe('the defects', () => {
  it('one line per class and code, from 1 garment up to the sample, of the work order cells', () => {
    const cells = new Set(['c1'])
    expect(defectProblems([{ defectClass: 'MINOR', code: 'LOOSE-THREAD', quantity: 2, workOrderSizeId: 'c1' }], { sampleSize: 5, cellIds: cells })).toEqual([])
    const problems = defectProblems(
      [
        { defectClass: 'MINOR', code: 'loose', quantity: 0 },
        { defectClass: 'MAJOR', code: 'SEAM', quantity: 6, workOrderSizeId: 'c9' },
        { defectClass: 'MAJOR', code: 'SEAM', quantity: 1 },
      ],
      { sampleSize: 5, cellIds: cells },
    )
    // …and the two MAJOR lines (6 + 1) are more than the sample of 5.
    expect(paths(problems)).toEqual(['defects/0/code', 'defects/0/quantity', 'defects/1/quantity', 'defects/1/workOrderSizeId', 'defects/2/code', 'defects'])
    // 3 + 3 minor garments in a sample of 5.
    expect(defectProblems([{ defectClass: 'MINOR', code: 'A1', quantity: 3 }, { defectClass: 'MINOR', code: 'A2', quantity: 3 }], { sampleSize: 5, cellIds: cells })[0]!.message).toBe(
      '6 garments with a minor defect is more than the sample of 5.',
    )
    expect(defectCounts([{ defectClass: 'MINOR', quantity: 3 }, { defectClass: 'MINOR', quantity: 1 }, { defectClass: 'MAJOR', quantity: 2 }])).toEqual({ critical: 0, major: 2, minor: 4 })
  })
})

describe('the computed result and the override (QHS-013)', () => {
  const zero = { critical: 0, major: 0, minor: 0 }
  it('FAILS with any critical defect, majors or minors above the acceptance numbers, or a check not ok', () => {
    expect(computedResult({ counts: { ...zero, major: 1, minor: 2 }, plan, checklist: allOk() })).toEqual({ result: 'PASS', reasons: [], byCountsOnly: false })
    expect(resultWords(computedResult({ counts: zero, plan, checklist: allOk() }))).toMatch(/^PASS/)
    const minors = computedResult({ counts: { ...zero, minor: 3 }, plan, checklist: allOk() })
    expect(minors).toEqual({ result: 'FAIL', reasons: ['3 garment(s) with a minor defect; the plan accepts 2.'], byCountsOnly: true })
    const critical = computedResult({ counts: { ...zero, critical: 1, major: 2 }, plan, checklist: [{ code: 'CE_MARK', ok: false }] })
    expect(critical.result).toBe('FAIL')
    expect(critical.byCountsOnly).toBe(false)
    expect(critical.reasons).toEqual([
      '1 garment(s) with a critical defect: a critical defect is never accepted.',
      'Checks not ok: CE marking.',
      '2 garment(s) with a major defect; the plan accepts 1.',
    ])
  })

  it('signs the computed result without a reason, an override only with one, and never a PASS over a critical defect or a failed check', () => {
    const pass = computedResult({ counts: zero, plan, checklist: allOk() })
    const counts = computedResult({ counts: { ...zero, major: 2 }, plan, checklist: allOk() })
    const hard = computedResult({ counts: { ...zero, critical: 1 }, plan, checklist: allOk() })
    expect(decisionProblems('PASS', pass, null)).toEqual([])
    expect(decisionProblems('PASS', pass, 'because')[0]!.path).toBe('overrideReason')
    expect(isOverride('PASS', counts)).toBe(true)
    expect(decisionProblems('PASS', counts, '')[0]!.message).toMatch(/^The rules say FAIL: a PASS over it is an override with your written reason \(QHS-013\)\. Say why/)
    expect(decisionProblems('PASS', counts, 'The customer accepts two loose threads on the lining (written concession).')).toEqual([])
    expect(decisionProblems('PASS', hard, 'We need them shipped.')[0]!.message).toMatch(/^A PASS over this FAIL is never signed: 1 garment\(s\) with a critical defect/)
    // A FAIL over a PASS (the inspector saw what the counts do not show) is an override too: with a reason.
    expect(decisionProblems('FAIL', pass, null)[0]!.path).toBe('overrideReason')
    expect(decisionProblems('FAIL', pass, 'Smell of solvent on the whole lot.')).toEqual([])
    expect(decisionProblems('FAIL', hard, null)).toEqual([])
    expect(reasonProblem('ab')!.message).toMatch(/at least 3/)
  })
})

describe('the label', () => {
  it("is the inspection's own number; one from before the series is named by its place in its work order", () => {
    expect(inspectionLabel('WO-0003', 2, 'INS-A-2026-0001')).toBe('INS-A-2026-0001')
    expect(inspectionLabel('WO-0003', 2, null)).toBe('WO-0003 · inspection 2')
    expect(inspectionLabel('WO-0003', 1)).toBe('WO-0003 · inspection 1')
  })
})
