import { describe, expect, it } from 'vitest'
import { sheet } from './fixtures'
import {
  applyKept,
  classTakeBack,
  countPayload,
  defectsOfClass,
  failNote,
  firstOpenSection,
  identityLine,
  measureDraft,
  measureHeld,
  measurePayload,
  measureVerdict,
  specOf, // B-W2b-283
  valueBand, // B-W2b-283
  nextUnit,
  passPayload,
  photoTargets,
  pointAsks,
  sampleOf,
  sectionsOf,
  signHeld,
  startsAtBench,
  suggestedPlanOf,
  tapGroups,
  waitingWrites,
  withDefectDelta,
  type DefectLine,
} from './model'

/**
 * The final bench on its plan (B-W2b-109): the sections and how each stands, the checklist groups, the defects' plus and minus,
 * one point of measure per step, the serial check's words, the photo set, what holds the signature, the kept write moving the
 * sheet at once, and where a code goes. Made-up data (fixtures.ts).
 */

describe('the sections of the bench', () => {
  it('lists the sections the plan has, each with how it stands, and opens on the first not done', () => {
    const fresh = sheet()
    expect(sectionsOf(fresh).map((section) => `${section.id}:${section.state}`)).toEqual(['aql:open', 'checks:open', 'measure:open', 'serial:open', 'photos:open'])
    expect(firstOpenSection(fresh)).toBe('aql')
    const counted = sheet({ counter: { ...fresh.counter, inspected: 8, remaining: 0, verdict: 'accept' } })
    expect(sectionsOf(counted)[0]).toEqual({ id: 'aql', state: 'done' })
    expect(firstOpenSection(counted)).toBe('checks')
  })

  it('a section without anything in the plan is left out; a failed check or value marks its section failed', () => {
    const plain = sheet({ chart: { ...sheet().chart, points: [] }, photos: { slots: [], waiting: [], mandatoryMissing: [], words: '' } })
    expect(sectionsOf(plain).map((section) => section.id)).toEqual(['aql', 'checks', 'serial'])
    const failed = sheet({ checks: sheet().checks.map((check) => (check.code === 'ZIPS' ? { ...check, results: [{ id: 'r', sampleIndex: 1, outcome: 'FAIL' as const, value: null, note: 'x', photos: [], recordedBy: 'FLOOR' as const, recordedAt: '' }] } : check)) })
    expect(sectionsOf(failed).find((section) => section.id === 'checks')?.state).toBe('failed')
  })
})

describe('the checks', () => {
  it('groups the tap checks by class, critical first; counts, choices, free text, photos and measurements stay out', () => {
    expect(tapGroups(sheet()).map((group) => [group.id, group.checks.map((check) => check.code)])).toEqual([
      ['CRITICAL', ['CE_MARK', 'ARMOUR']],
      ['MAJOR', ['CARE', 'ZIPS']],
      ['MINOR', ['LOOSE']],
    ])
  })

  it('a pass is the first unit of each check; a fail says what is wrong with the defect\'s code', () => {
    expect(passPayload('i', ['A', 'B'])).toEqual({ what: 'RESULTS', inspectionId: 'i', results: [{ checkCode: 'A', sampleIndex: 1, outcome: 'PASS', note: null }, { checkCode: 'B', sampleIndex: 1, outcome: 'PASS', note: null }] })
    expect(failNote('Cerniera difettosa', 'ZIP-FAULT')).toBe('Cerniera difettosa (ZIP-FAULT)')
    expect(failNote('Non come dovrebbe', null)).toBe('Non come dovrebbe')
  })
})

describe('the AQL counter: a plus and a minus per defect', () => {
  const lines: DefectLine[] = [{ defectClass: 'MINOR', code: 'MARK', quantity: 1 }]
  it('adds a line, counts it up, takes it down and drops it at zero (the whole list is sent)', () => {
    expect(withDefectDelta(lines, { defectClass: 'MAJOR', code: 'ZIP-FAULT' }, 1)).toEqual([...lines, { defectClass: 'MAJOR', code: 'ZIP-FAULT', quantity: 1 }])
    expect(withDefectDelta(lines, { defectClass: 'MINOR', code: 'MARK' }, 1)).toEqual([{ defectClass: 'MINOR', code: 'MARK', quantity: 2 }])
    expect(withDefectDelta(lines, { defectClass: 'MINOR', code: 'MARK' }, -1)).toEqual([])
    expect(withDefectDelta(lines, { defectClass: 'MAJOR', code: 'NONE' }, -1)).toEqual(lines)
  })

  it('− on a class: the one line goes down; several ask which; none holds', () => {
    expect(classTakeBack(lines, 'MINOR')).toEqual({ kind: 'one', line: lines[0] })
    expect(classTakeBack([...lines, { defectClass: 'MINOR', code: 'LOOSE', quantity: 2 }], 'MINOR').kind).toBe('pick')
    expect(classTakeBack(lines, 'MAJOR')).toEqual({ kind: 'none' })
  })

  it('a class\'s + offers the FINAL vocabulary of that severity, else the class\'s own tile', () => {
    const vocabulary = [{ id: '1', code: 'ZIP-FAULT', label: 'Cerniera', severity: 'MAJOR', needsDetail: false }]
    expect(defectsOfClass(vocabulary, 'MAJOR')).toEqual([{ code: 'ZIP-FAULT', label: 'Cerniera' }])
    expect(defectsOfClass(vocabulary, 'MINOR')).toEqual([{ code: 'MINOR-OTHER', label: null }])
    expect(countPayload('i', 1)).toEqual({ what: 'COUNT', inspectionId: 'i', add: 1 })
  })
})

describe('measurements: one point per step', () => {
  const plan = sheet().chart.points[0]!
  it('the plan sets nominal and tolerance; a profile point asks its tolerance; a size-chart point both', () => {
    expect(pointAsks(plan)).toEqual({ nominal: false, tolerance: false })
    expect(pointAsks({ source: 'PROFILE', nominal: '64', tolerance: null })).toEqual({ nominal: false, tolerance: true })
    expect(pointAsks({ source: 'SIZE_CHART', nominal: null, tolerance: null })).toEqual({ nominal: true, tolerance: true })
  })

  it('the next unit is the first without a value; the size is the point\'s or the only one, else asked', () => {
    expect(nextUnit({ values: [{ id: 'a', size: '50', sampleIndex: 1, measured: '58', nominal: '58', tolerance: '1', pass: true, words: '' }] }, 8, '50')).toBe(2)
    expect(measureDraft(plan, 8, ['50']).size).toBe('50')
    const draft = measureDraft(plan, 8, ['50', '52'])
    expect(measureHeld(plan, draft)).toBe('size')
    expect(measureHeld(plan, { ...draft, size: '52' })).toBe('value')
  })

  it('in or out by the numbers, and what goes to the office (nothing the plan sets is typed)', () => {
    const draft = { ...measureDraft(plan, 8, ['50']), value: 58.9 }
    expect(measureVerdict(plan, draft)).toBe('PASS')
    expect(measureVerdict(plan, { ...draft, value: 59.2 })).toBe('FAIL')
    expect(measurePayload('i', plan, draft)).toEqual({ what: 'MEASUREMENTS', inspectionId: 'i', measurements: [{ checkCode: 'CHEST', size: '50', sampleIndex: 1, measured: '58.9' }] })
    const chart = { ...plan, checkCode: null, pointCode: 'HEM', source: 'TYPED' as const, nominal: null, tolerance: null }
    const typed = measurePayload('i', chart, { ...draft, pointCode: 'HEM', nominal: 40, tolerance: 0.5 })
    expect(typed.what === 'MEASUREMENTS' ? typed.measurements[0] : null).toEqual({ pointCode: 'HEM', size: '50', sampleIndex: 1, measured: '58.9', nominal: '40', tolerance: '0.5', uom: 'CM' })
  })
})

describe('the serial check, the photo set, the signature', () => {
  it('says the serial or batch check from its figures', () => {
    expect(identityLine({ ...sheet().identity, matched: 3 })).toMatchObject({ key: 'serial.serial.open', params: { matched: 3, target: 8 } })
    expect(identityLine({ ...sheet().identity, ok: false, unknown: ['X'], noNumber: 1 }).tone).toBe('danger')
    expect(identityLine({ ...sheet().identity, mode: 'BATCH', done: true, ok: true, batchNumber: 'B-1' }).key).toBe('serial.batch.done')
  })

  it('lists the slots, then the results that wait for their photo', () => {
    const waiting = sheet({ checks: sheet().checks.map((check) => (check.code === 'ARMOUR' ? { ...check, results: [{ id: 'r9', sampleIndex: 1, outcome: 'FAIL' as const, value: null, note: 'x', photos: [], recordedBy: 'FLOOR' as const, recordedAt: '' }] } : check)) })
    expect(photoTargets(waiting, 'it').map((target) => `${target.key}:${target.state}`)).toEqual(['slot:FRONT:MISSING', 'slot:BACK:MISSING', 'slot:LABEL:OPEN', 'result:r9:MISSING'])
  })

  it('holds a PASS with every reason, in the screen\'s words; a FAIL may stop early when the stop rule allows', () => {
    expect(signHeld(sheet(), 'PASS').map((word) => word.key)).toEqual(['sign.held.checks', 'sign.held.photoSet', 'sign.held.serials', 'sign.held.sample'])
    const rejected = sheet({ counter: { ...sheet().counter, inspected: 3, verdict: 'reject' }, sign: { pass: { held: true, reasons: ['x'] }, fail: { held: false, reasons: [] } } })
    expect(signHeld(rejected, 'FAIL')).toEqual([])
    const finish = sheet({ counter: { ...rejected.counter, stop: { stop: false, source: 'PLAN', words: '' } } })
    expect(signHeld(finish, 'FAIL').map((word) => word.key)).toEqual(['sign.held.sampleFail'])
  })

  it('counts the bench writes still waiting on the tablet for this inspection', () => {
    const items = [
      { kind: 'quality.final.record', state: 'waiting', payload: { inspectionId: 'i' } },
      { kind: 'quality.final.record', state: 'recorded', payload: { inspectionId: 'i' } },
      { kind: 'quality.final.record', state: 'waiting', payload: { inspectionId: 'j' } },
      { kind: 'andon.call.send', state: 'waiting', payload: {} },
    ]
    expect(waitingWrites(items, 'i')).toBe(1)
  })
})

describe('a write kept on the tablet moves the sheet at once', () => {
  it('the count, a result, a value in or out, the defects', () => {
    const base = sheet()
    expect(applyKept(base, { what: 'COUNT', inspectionId: 'i', add: 1 }, 'now').counter).toMatchObject({ inspected: 1, remaining: 7, verdict: 'open' })
    expect(applyKept(base, passPayload('i', ['CARE']), 'now').checks.find((check) => check.code === 'CARE')?.results).toHaveLength(1)
    const measured = applyKept(base, { what: 'MEASUREMENTS', inspectionId: 'i', measurements: [{ checkCode: 'CHEST', size: '50', sampleIndex: 1, measured: '59.5' }] }, 'now')
    expect(measured.chart).toMatchObject({ values: 1, outOfTolerance: 1 })
    const defects = applyKept(base, { what: 'DEFECTS', inspectionId: 'i', defects: [{ defectClass: 'MAJOR', code: 'ZIP-FAULT', quantity: 1 }] }, 'now')
    expect(defects.counter.verdict).toBe('reject')
    expect(defects.counter.classes.find((entry) => entry.defectClass === 'MAJOR')).toMatchObject({ found: 1, state: 'reject' })
  })
})

describe('opening on the plan, and where a code goes', () => {
  it('takes the suggested usable plan and the API\'s sample (never computed here)', () => {
    const answer = { plans: [{ id: 'p', code: 'FIN', name: 'n', approved: { id: 'v', number: 2 }, matches: true, usable: true, suggested: true, because: null }], suggestedId: 'p', sampling: { method: 'AQL_PROFILE' as const, sampleSize: 8, plan: { lotSize: 48, levelText: 'II', codeLetter: 'E', sampleSize: 8, hundredPercent: false, classes: [] }, named: false } }
    expect(suggestedPlanOf(answer)?.code).toBe('FIN')
    expect(sampleOf(answer)).toEqual({ size: 8, letter: 'E', level: 'II', classes: [] })
    expect(suggestedPlanOf({ ...answer, plans: [{ ...answer.plans[0]!, usable: false }] })).toBeNull()
    expect(sampleOf({ sampling: null })).toBeNull()
  })

  it('a lot, a batch, a bundle, a serial or a carton starts at the bench; a hide or a work order does not', () => {
    expect(['lot', 'batch', 'bundle', 'serial', 'carton'].every((type) => startsAtBench({ kind: 'label', type }))).toBe(true)
    expect(startsAtBench({ kind: 'label', type: 'hide' })).toBe(false)
    expect(startsAtBench({ kind: 'label', type: 'workOrder' })).toBe(false)
    expect(startsAtBench({ kind: 'free' })).toBe(false)
  })
})

// B-W2b-283 (FU1:05): a point of the approved measurement spec whose sides differ.
describe('a spec point with a band (B-W2b-283)', () => {
  const point = {
    ...sheet().chart.points[0]!,
    pointCode: 'SLEEVE_LEN',
    checkCode: null,
    source: 'SPEC' as const,
    nominal: null,
    tolerance: null,
    bySize: [{ size: '52', nominal: '64.000', tolerance: '1.500', toleranceMinus: '0.500', tolerancePlus: '1.500', words: '64 −0.5/+1.5 cm' }],
    values: [],
  }
  const draft = { pointCode: 'SLEEVE_LEN', unit: 1, size: '52', value: 63.4, nominal: null, tolerance: null, field: 'value' as const }

  it('asks only the value; judges it against the band of its size (centre ± half), never nominal ± the larger side', () => {
    expect(pointAsks(point)).toEqual({ nominal: false, tolerance: false })
    expect(specOf(point, draft)).toEqual({ nominal: 64.5, tolerance: 1 })
    expect(measureVerdict(point, draft)).toBe('FAIL')
    expect(measureVerdict(point, { ...draft, value: 65.5 })).toBe('PASS')
    expect(specOf(point, { ...draft, size: '54' })).toEqual({ nominal: null, tolerance: null })
    expect(valueBand({ nominal: '64.000', tolerance: '1.500', toleranceMinus: '0.500', tolerancePlus: '1.500' })).toEqual({ nominal: 64.5, tolerance: 1 })
    expect(valueBand({ nominal: '58.000', tolerance: '1.000' })).toEqual({ nominal: 58, tolerance: 1 })
  })
})
