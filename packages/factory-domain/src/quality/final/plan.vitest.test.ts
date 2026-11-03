import { describe, expect, it } from 'vitest'
import {
  applicablePlans,
  changeScans,
  checksState,
  countProblem,
  deviationWords,
  fixedSampling,
  identityEntry,
  identitySummary,
  inspectedOf,
  isSystemEntry,
  measurementPass,
  mtmPoints,
  NO_NUMBER,
  photoSet,
  planChecklist,
  planDecisionProblems,
  resolveMeasurements,
  resultProblems,
  sampleEntry,
  sampleRejected,
  samplingChanges,
  scansOf,
  stopRuleOf,
  withEntry,
  type PlanCheck,
} from './plan'
import { computedResult, decisionProblems } from './rules'

/**
 * The final inspection by plan (B-W2b-97): figures by hand. Made-up codes and values only.
 */

const check = (code: string, extra: Partial<PlanCheck> = {}): PlanCheck => ({
  id: `id-${code}`,
  code,
  labelIt: code,
  labelEn: code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' '),
  type: 'PASS_FAIL',
  checkClass: 'MAJOR',
  mandatory: true,
  photoRequired: false,
  nominal: null,
  tolerance: null,
  uom: null,
  choices: [],
  ...extra,
})

const CE = check('CE_MARK', { checkClass: 'CRITICAL' })
const ZIPS = check('ZIPS')
const CHEST = check('CHEST', { type: 'MEASUREMENT', nominal: '58.000', tolerance: '1.000', uom: 'CM' })
const SLEEVE = check('SLEEVE', { type: 'MEASUREMENT' })
const READ = check('READ', { type: 'INSTRUCTION', checkClass: null, mandatory: false })
const FRONT = check('FRONT', { type: 'PHOTO', checkClass: null })
const BACK = check('BACK', { type: 'PHOTO', checkClass: null, mandatory: false })
const SHADE = check('SHADE', { type: 'CHOICE', choices: ['A', 'B'] })
const LABEL = check('LABEL', { photoRequired: true, checkClass: 'MINOR' })
const CHECKS = [CE, ZIPS, CHEST, SLEEVE, READ, FRONT, BACK, SHADE, LABEL]

describe('results (QHS-049)', () => {
  it('a value by type, a failed check says why, a critical check is never skipped in silence', () => {
    const problems = resultProblems(
      [
        { checkCode: 'CE_MARK', outcome: 'NOT_APPLICABLE' },
        { checkCode: 'ZIPS', outcome: 'FAIL' },
        { checkCode: 'SHADE', outcome: 'PASS', value: 'C' },
        { checkCode: 'READ', outcome: 'PASS' },
        { checkCode: 'CHEST', outcome: 'PASS', value: '58' },
        { checkCode: 'NOPE', outcome: 'PASS' },
        { checkCode: 'LABEL', outcome: 'PASS', sampleIndex: 6 },
        { checkCode: 'FRONT', outcome: 'PASS', value: 'x' },
      ],
      CHECKS,
      { sampleSize: 5 },
    )
    expect(problems.map((problem) => problem.path)).toEqual(['results/0/note', 'results/1/note', 'results/2/value', 'results/3/checkCode', 'results/4/checkCode', 'results/5/checkCode', 'results/6/sampleIndex', 'results/7/value'])
    expect(problems[0]!.message).toContain('a safety check is never skipped in silence')
    expect(resultProblems([{ checkCode: 'CE_MARK', outcome: 'NOT_APPLICABLE', note: 'No CE mark on a non-PPE accessory.' }, { checkCode: 'ZIPS', outcome: null }], CHECKS, { sampleSize: 5 })).toEqual([])
    expect(resultProblems([{ checkCode: 'ZIPS', outcome: 'PASS' }, { checkCode: 'ZIPS', outcome: 'FAIL', note: 'x' }], CHECKS, { sampleSize: 5 })[0]!.message).toContain('answered twice')
  })
})

describe('the checks now and the checklist written from them', () => {
  const results = [
    { id: 'r1', planCheckId: CE.id, sampleIndex: 1, outcome: 'PASS' as const, value: null, note: null, photos: 0 },
    { id: 'r2', planCheckId: ZIPS.id, sampleIndex: 1, outcome: 'FAIL' as const, value: null, note: 'Zip stuck', photos: 0 },
    { id: 'r3', planCheckId: SHADE.id, sampleIndex: 1, outcome: 'NOT_APPLICABLE' as const, value: null, note: 'Black only', photos: 0 },
  ]
  const values = [{ id: 'm1', planCheckId: CHEST.id, pointCode: 'CHEST', size: '52', sampleIndex: 2, nominal: '58.000', tolerance: '1.000', measured: '59.800', uom: 'CM' as const, pass: false }]

  it('"4 of 8 checked · 2 failed · critical failed: none"; the instruction takes none', () => {
    const state = checksState(CHECKS, results, values)
    expect(state.words).toBe('4 of 8 checked · 2 failed · critical failed: none')
    expect(state.failed).toEqual(['Zips', 'Chest'])
    expect(state.mandatoryMissing).toEqual(['Sleeve', 'Front', 'Label'])
  })

  it('writes W1 entries by code: a failure ok false (the lot FAILS, no PASS is ever signed over it), all not applicable ok null, the counter last', () => {
    const checklist = planChecklist(CHECKS, results, values, { inspected: 3, sampleSize: 5, identity: null })
    expect(checklist).toEqual([
      { code: 'CE_MARK', ok: true, note: null },
      { code: 'ZIPS', ok: false, note: 'Zip stuck' },
      { code: 'CHEST', ok: false, note: 'Unit 2: over by 0.8 cm' },
      { code: 'SHADE', ok: null, note: 'Black only' },
      { code: 'AQL_SAMPLE', ok: null, note: '3 of 5 inspected', inspected: 3 },
    ])
    const computed = computedResult({ counts: { critical: 0, major: 0, minor: 0 }, plan: { acceptMajor: 3, acceptMinor: 5 }, checklist })
    expect(computed).toMatchObject({ result: 'FAIL', byCountsOnly: false })
    // SAFETY: never a PASS over a failed check, not even with a reason.
    expect(decisionProblems('PASS', computed, 'Customer agreed')[0]!.message).toContain('A PASS over this FAIL is never signed')
  })

  it('a critical defect always fails, with Ac 0, and nothing else changes it', () => {
    const checklist = planChecklist([CE], [{ planCheckId: CE.id, sampleIndex: 1, outcome: 'PASS', note: null }], [], { inspected: 5, sampleSize: 5, identity: null })
    const computed = computedResult({ counts: { critical: 1, major: 0, minor: 0 }, plan: { acceptMajor: 10, acceptMinor: 10 }, checklist })
    expect(computed.result).toBe('FAIL')
    expect(decisionProblems('PASS', computed, 'Only a small one')).toHaveLength(1)
    expect(sampleRejected({ counts: { critical: 1, major: 0, minor: 0 }, acceptMajor: 10, acceptMinor: 10, failedCritical: 0 })).toBe(true)
    expect(sampleRejected({ counts: { critical: 0, major: 0, minor: 0 }, acceptMajor: 0, acceptMinor: 0, failedCritical: 1 })).toBe(true)
    expect(sampleRejected({ counts: { critical: 0, major: 3, minor: 6 }, acceptMajor: 3, acceptMinor: 5, failedCritical: 0 })).toBe(true)
    expect(sampleRejected({ counts: { critical: 0, major: 3, minor: 5 }, acceptMajor: 3, acceptMinor: 5, failedCritical: 0 })).toBe(false)
  })

  it('the system entries: kept apart from the answers, replaced in place', () => {
    const list = withEntry(withEntry([{ code: 'CE_MARK', ok: true, note: null }], sampleEntry(1, 5)), sampleEntry(2, 5))
    expect(list.map((entry) => entry.code)).toEqual(['CE_MARK', 'AQL_SAMPLE'])
    expect(inspectedOf(list)).toBe(2)
    expect(inspectedOf(null)).toBe(0)
    expect(isSystemEntry('AQL_SAMPLE')).toBe(true)
    expect(isSystemEntry('IDENTITY')).toBe(true)
    expect(isSystemEntry('CE_MARK')).toBe(false)
  })
})

describe('measurements (QHS-014, QHS-053)', () => {
  const context = { checks: CHECKS, sampleSize: 5, sizes: ['50', '52'], mtm: null }

  it("the plan's check binds nominal, tolerance and unit; a size-chart point is typed whole; the size is named", () => {
    const { rows, problems } = resolveMeasurements(
      [
        { checkCode: 'CHEST', size: '52', sampleIndex: 1, measured: '58.4' },
        { checkCode: 'SLEEVE', size: '50', measured: '61', nominal: '61.5', tolerance: '1' },
        { pointCode: 'BACK-LENGTH', size: '52', measured: '70', nominal: '70', tolerance: '1.5' },
      ],
      context,
    )
    expect(problems).toEqual([])
    expect(rows.map((row) => [row.pointCode, row.planCheckId, row.value?.nominal, row.value?.tolerance, row.value?.uom, row.value?.source])).toEqual([
      ['CHEST', CHEST.id, '58.000', '1.000', 'CM', 'PLAN'],
      ['SLEEVE', SLEEVE.id, '61.500', '1.000', 'CM', 'TYPED'],
      ['BACK-LENGTH', null, '70.000', '1.500', 'CM', 'TYPED'],
    ])
  })

  it('refuses what the plan sets, a missing size and spec, a unit past the sample, a check that is no measurement', () => {
    const { problems } = resolveMeasurements(
      [
        { checkCode: 'CHEST', size: '52', measured: '58', nominal: '57', tolerance: '2' },
        { checkCode: 'SLEEVE', measured: '61' },
        { checkCode: 'ZIPS', size: '52', measured: '1' },
        { pointCode: 'X', size: '52', sampleIndex: 9, measured: '1', nominal: '1', tolerance: '1' },
        { pointCode: 'has space', size: '52', measured: 'abc', nominal: '1', tolerance: '1' },
      ],
      context,
    )
    expect(problems.map((problem) => problem.path)).toEqual([
      'measurements/0/nominal',
      'measurements/1/size',
      'measurements/1/nominal',
      'measurements/1/tolerance',
      'measurements/2/checkCode',
      'measurements/2/nominal',
      'measurements/2/tolerance',
      'measurements/3/sampleIndex',
      'measurements/4/pointCode',
      'measurements/4/measured',
    ])
    expect(problems[0]!.message).toBe('The plan sets CHEST at 58 ± 1 cm: nothing else is typed.')
  })

  it("made to measure: the rider's profile gives the nominal by the template's point code, the tolerance is typed; the size is the unit's", () => {
    const points = mtmPoints(
      [
        { code: 'chest', name: 'Chest', uom: 'CM' },
        { code: 'waist', name: 'Waist', uom: 'CM' },
        { code: 'sleeve', name: 'Sleeve', uom: 'CM' },
      ],
      { chest: { value: '100.0', unit: 'cm' }, sleeve: { value: '64.5', unit: 'cm' }, waist: { value: 'eighty' } },
    )
    expect(points).toEqual([
      { code: 'chest', name: 'Chest', nominal: '100.000', uom: 'CM' },
      { code: 'sleeve', name: 'Sleeve', nominal: '64.500', uom: 'CM' },
    ])
    const mtm = { checks: [CHEST, SLEEVE], sampleSize: 1, sizes: ['52'], mtm: { size: '52', points } }
    const { rows, problems } = resolveMeasurements([{ checkCode: 'SLEEVE', measured: '65.4', tolerance: '1' }, { pointCode: 'chest', measured: '99', tolerance: '1.5' }], mtm)
    expect(problems).toEqual([])
    expect(rows.map((row) => [row.pointCode, row.size, row.planCheckId, row.value?.nominal, row.value?.source])).toEqual([
      ['SLEEVE', '52', SLEEVE.id, '64.500', 'PROFILE'],
      ['chest', '52', null, '100.000', 'PROFILE'],
    ])
    const refused = resolveMeasurements([{ pointCode: 'chest', measured: '99', nominal: '98' }], mtm).problems
    expect(refused.map((problem) => problem.path)).toEqual(['measurements/0/nominal', 'measurements/0/tolerance'])
    expect(refused[0]!.message).toContain("The rider's measurement profile gives Chest 100 cm")
  })

  it('a value against its spec, in words, never colour alone; taking a value back needs only its place', () => {
    expect(measurementPass('59.000', '58.000', '1.000')).toBe(true)
    expect(measurementPass('59.001', '58.000', '1.000')).toBe(false)
    expect(deviationWords('59.800', '58.000', '1.000', 'CM')).toBe('over by 0.8 cm')
    expect(deviationWords('56.500', '58.000', '1.000', 'CM')).toBe('under by 0.5 cm')
    expect(deviationWords('58.200', '58.000', '1.000', 'CM')).toBe('within 58 ± 1 cm')
    expect(resolveMeasurements([{ checkCode: 'SLEEVE', size: '50', measured: null }], context).rows).toEqual([{ planCheckId: SLEEVE.id, pointCode: 'SLEEVE', size: '50', sampleIndex: 1, value: null }])
  })
})

describe('the serial or batch check (QHS-052)', () => {
  const stamp = { at: '2026-11-03T10:00:00.000Z', by: 'FLOOR' as const }

  it('serials: every garment of the lot ticked; an unknown or a missing number fails; missing ones named when the lot is every serial', () => {
    let scans = changeScans([], { add: ['sn-0001', 'SN-0002'] }, stamp).scans
    const ask = { mode: 'SERIAL' as const, expected: ['SN-0001', 'SN-0002', 'SN-0003'], batchNumber: null, lotSize: 3 }
    expect(identitySummary({ ...ask, scans })).toMatchObject({ target: 3, matched: 2, missing: ['SN-0003'], missingCount: 1, done: false, ok: null, words: 'Expected 3 · scanned 2 · missing 1 (SN-0003) · unknown 0.' })
    const again = changeScans(scans, { add: ['SN-0002', 'SN-0003'] }, stamp)
    expect(again.duplicates).toEqual(['SN-0002'])
    scans = again.scans
    expect(identitySummary({ ...ask, scans })).toMatchObject({ matched: 3, done: true, ok: true })
    const wrong = changeScans(scans, { remove: ['SN-0003'], add: ['XX-9', null] }, stamp).scans
    expect(identitySummary({ ...ask, scans: wrong })).toMatchObject({ matched: 2, unknown: ['XX-9'], noNumber: 1, done: true, ok: false })
    expect(changeScans(wrong, { remove: [NO_NUMBER, NO_NUMBER, 'SN-0009'] }, stamp).problems.map((problem) => problem.path)).toEqual(['remove/1', 'remove/2'])
    // A lot smaller than the serials waiting: counted, not named.
    expect(identitySummary({ ...ask, lotSize: 2, scans: changeScans([], { add: ['SN-0001'] }, stamp).scans })).toMatchObject({ target: 2, missing: [], missingCount: 1 })
    expect(identitySummary({ ...ask, expected: [], scans: [] })).toMatchObject({ target: 0, done: false, ok: null })
  })

  it('a batch: its number once; another number or a garment without one fails; kept in the IDENTITY entry', () => {
    const ask = { mode: 'BATCH' as const, expected: [], batchNumber: 'BT-0042', lotSize: 120 }
    expect(identitySummary({ ...ask, scans: [] })).toMatchObject({ target: 1, done: false, ok: null })
    const scans = changeScans([], { add: ['bt-0042'] }, stamp).scans
    const summary = identitySummary({ ...ask, scans })
    expect(summary).toMatchObject({ matched: 1, done: true, ok: true, words: 'Batch BT-0042: checked.' })
    expect(identitySummary({ ...ask, scans: changeScans(scans, { add: ['BT-0041'] }, stamp).scans })).toMatchObject({ ok: false })
    const entry = identityEntry('BATCH', scans, summary)
    expect(entry).toMatchObject({ code: 'IDENTITY', ok: true })
    expect(scansOf([entry])).toEqual([{ code: 'BT-0042', ...stamp }])
  })
})

describe('the counter, the stop rule and the decision (QHS-023)', () => {
  it("the plan's rule, else the company's, the tenant's, else finish the sample", () => {
    expect(stopRuleOf({ plan: null, company: null, tenant: null })).toMatchObject({ stop: false, source: 'DEFAULT' })
    expect(stopRuleOf({ plan: null, company: null, tenant: true })).toMatchObject({ stop: true, source: 'TENANT' })
    expect(stopRuleOf({ plan: null, company: false, tenant: true })).toMatchObject({ stop: false, source: 'COMPANY' })
    expect(stopRuleOf({ plan: true, company: false, tenant: false })).toMatchObject({ stop: true, source: 'PLAN' })
    expect(countProblem(6, 5)?.path).toBe('inspected')
    expect(countProblem(-1, 5)?.path).toBe('inspected')
    expect(countProblem(5, 5)).toBeNull()
  })

  it('a PASS: every mandatory check, the identity done, the photos, the whole sample; a FAIL early only when stopping at the reject number', () => {
    const base = { checks: { mandatoryMissing: [] }, identity: { done: true, ok: true, words: 'ok' }, photos: { waiting: [], mandatoryMissing: [] }, inspected: 5, sampleSize: 5, stop: stopRuleOf({ plan: null, company: null, tenant: null }), rejected: false }
    expect(planDecisionProblems({ ...base, decision: 'PASS' })).toEqual([])
    const held = planDecisionProblems({ ...base, decision: 'PASS', checks: { mandatoryMissing: ['Front'] }, identity: { done: false, ok: null, words: 'Expected 3 · scanned 2.' }, photos: { waiting: ['Photo with Label'], mandatoryMissing: ['Front'] }, inspected: 4 })
    expect(held.map((problem) => problem.path)).toEqual(['photos', 'checks', 'photos', 'identity', 'inspected'])
    expect(planDecisionProblems({ ...base, decision: 'FAIL', inspected: 2, rejected: true }).map((problem) => problem.path)).toEqual(['inspected'])
    const stopping = stopRuleOf({ plan: true, company: null, tenant: null })
    expect(planDecisionProblems({ ...base, decision: 'FAIL', inspected: 2, rejected: true, stop: stopping })).toEqual([])
    expect(planDecisionProblems({ ...base, decision: 'FAIL', inspected: 2, rejected: false, stop: stopping })[0]!.message).toContain('does not reject yet')
  })
})

describe('the photo set (QHS-054)', () => {
  it('slots from the PHOTO checks; a "photo required" result waits for its photo', () => {
    const set = photoSet(CHECKS, [
      { planCheckId: BACK.id, outcome: 'PASS', photos: 1, sampleIndex: 1 },
      { planCheckId: LABEL.id, outcome: 'FAIL', photos: 0, sampleIndex: 2 },
    ])
    expect(set.slots.map((slot) => [slot.code, slot.state])).toEqual([
      ['FRONT', 'MISSING'],
      ['BACK', 'TAKEN'],
    ])
    expect(set.mandatoryMissing).toEqual(['Front'])
    expect(set.waiting).toEqual(['Photo with Label (unit 2)'])
    expect(set.words).toBe('Front ✕ missing · Back ✓ · 1 photo(s) waiting')
    expect(photoSet([CE], []).words).toBe('This plan asks for no photos.')
  })
})

describe('which plan applies, and the sample it keeps', () => {
  it('the most specific usable plan; one without a version in force is never suggested', () => {
    const fit = applicablePlans(
      [
        { id: 'p1', code: 'FIN-ALL', name: 'All', appliesTo: [], approved: { id: 'v1', number: 1 } },
        { id: 'p2', code: 'FIN-JACKET', name: 'Jackets', appliesTo: [{ kind: 'CATEGORY', value: 'JACKET' }], approved: { id: 'v2', number: 3 } },
        { id: 'p3', code: 'FIN-EXM', name: 'Example customer', appliesTo: [{ kind: 'CATEGORY', value: 'JACKET' }, { kind: 'CUSTOMER', value: 'c1' }], approved: null },
        { id: 'p4', code: 'FIN-HIDE', name: 'Hides', appliesTo: [{ kind: 'MATERIAL', value: 'm1' }], approved: { id: 'v4', number: 1 } },
      ],
      { STYLE: ['s1'], CATEGORY: ['JACKET'], CUSTOMER: ['c1'] },
    )
    expect(fit.suggestedId).toBe('p2')
    expect(fit.plans.map((plan) => [plan.code, plan.matches, plan.usable])).toEqual([
      ['FIN-ALL', true, true],
      ['FIN-JACKET', true, true],
      ['FIN-EXM', true, false],
      ['FIN-HIDE', false, false],
    ])
  })

  it('a fixed sample on a lot; the sampling fields a change moves', () => {
    expect(fixedSampling(8, 5)).toEqual({ lotSize: 5, sampleSize: 5, inspectionLevel: 'FIXED', aqlMajor: '0', aqlMinor: '0', acceptMajor: 0, acceptMinor: 0 })
    expect(fixedSampling(3, 40, { acceptMinor: 1 }).acceptMinor).toBe(1)
    const before = { lotSize: 20, sampleSize: 5, inspectionLevel: 'II', aqlMajor: '2.500', aqlMinor: '4.000', acceptMajor: 0, acceptMinor: 1 }
    expect(samplingChanges(before, { lotSize: 20, aqlMajor: '2.5', inspectionLevel: ' II ' })).toEqual([])
    expect(samplingChanges(before, { sampleSize: 8, aqlMinor: '6.5' })).toEqual(['sampleSize', 'aqlMinor'])
  })
})
