import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS, FLOOR_SHARED_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { EVENT_DEFINITIONS } from '../../events/catalogue'
import {
  checksNow,
  computedOf,
  decisionProblems,
  decisionShape,
  foundOf,
  hideDraftProblems,
  isOverride,
  markProblems,
  measuredOutcome,
  nextStepOf,
  nextWords,
  resultProblems,
  sampleWords,
  secondOpenWords,
  tallyOf,
  worstClass,
  type CheckFacts,
  type DecisionFacts,
} from './rules'

/** B-W2b-98: the incoming inspection's pure rules (QHS-025, QHS-028, QHS-034, MES-054). Made-up values only. */

const paths = (issues: readonly { path: string }[]) => issues.map((issue) => issue.path)

describe('hide results and marks', () => {
  it('takes a defect point and a zone with its outline; refuses marks off the hide or half made', () => {
    expect(markProblems([{ kind: 'DEFECT', x: 0.4, y: 0.3, code: 'HIDE-SCAR', zone: 'A' }, { kind: 'ZONE', x: 0.5, y: 0.5, zone: 'B', outline: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.5, y: 0.9 }] }])).toEqual([])
    expect(paths(markProblems([{ kind: 'DEFECT', x: 1.2, y: 0.3, code: 'HIDE-SCAR' }]))).toEqual(['marks/0/x'])
    expect(paths(markProblems([{ kind: 'DEFECT', x: 0.2, y: 0.3 }]))).toEqual(['marks/0/code'])
    expect(paths(markProblems([{ kind: 'DEFECT', x: 0.2, y: 0.3, code: 'X', outline: [{ x: 0, y: 0 }] }]))).toEqual(['marks/0/outline'])
    expect(paths(markProblems([{ kind: 'ZONE', x: 0.2, y: 0.3, zone: 'A', outline: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }]))).toEqual(['marks/0/outline'])
    expect(paths(markProblems([{ kind: 'ZONE', x: 0.2, y: 0.3, code: 'HIDE-SCAR', outline: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }] }]))).toEqual(['marks/0/code', 'marks/0/zone'])
    expect(paths(markProblems([{ kind: 'ZONE', x: 0.2, y: 0.3, zone: 'A', outline: [{ x: 0, y: 0 }, { x: 1, y: 1.5 }, { x: 1, y: 0 }] }]))).toEqual(['marks/0/outline'])
    expect(markProblems(Array.from({ length: 61 }, () => ({ kind: 'DEFECT' as const, x: 0, y: 0, code: 'X' })))).toEqual([{ path: 'marks', message: 'At most 60 marks on one hide.' }])
  })

  it('measures in an area unit; the tannery area only beside a measure', () => {
    expect(hideDraftProblems({ measuredArea: '51.2', areaUom: 'FT2', declaredArea: '52', decision: 'ACCEPTED' })).toEqual([])
    expect(hideDraftProblems({ decision: 'ACCEPTED' })).toEqual([])
    expect(paths(hideDraftProblems({ measuredArea: '0', areaUom: 'FT2' }))).toEqual(['measuredArea'])
    expect(paths(hideDraftProblems({ measuredArea: '50.12345', areaUom: 'FT2' }))).toEqual(['measuredArea'])
    expect(paths(hideDraftProblems({ measuredArea: '50', areaUom: 'PCS' }))).toEqual(['areaUom'])
    expect(paths(hideDraftProblems({ declaredArea: '52' }))).toEqual(['measuredArea'])
  })
})

describe('found counts and the computed result', () => {
  it('counts a hide once, under its worst class', () => {
    expect(worstClass([])).toBeNull()
    expect(worstClass(['MINOR', 'MAJOR', 'MINOR'])).toBe('MAJOR')
    expect(foundOf([{ classes: ['MINOR', 'MAJOR'] }, { classes: [] }, { classes: ['MINOR'] }, { classes: ['CRITICAL', 'MINOR'] }])).toEqual({ critical: 1, major: 1, minor: 1 })
  })

  it('fails as the database does: critical, a failed critical check, a class over its acceptance number', () => {
    const base = { sampleSize: 13, acceptMajor: 1, acceptMinor: 2, failedCritical: [] }
    expect(computedOf({ ...base, found: { critical: 0, major: 1, minor: 2 } })).toEqual({ result: 'PASS', reasons: [], hard: [] })
    expect(computedOf({ ...base, found: { critical: 0, major: 2, minor: 0 } })).toMatchObject({ result: 'FAIL', hard: [] })
    expect(computedOf({ ...base, found: { critical: 1, major: 0, minor: 0 } }).hard).toEqual(['1 unit with a critical defect: a critical defect is never accepted.'])
    expect(computedOf({ ...base, found: { critical: 0, major: 0, minor: 0 }, failedCritical: ['Cr VI on the tag'] }).hard).toEqual(['Critical checks failed: Cr VI on the tag.'])
    // A fixed sample (no acceptance numbers): only critical fails, as the database reads the sample as the limit.
    expect(computedOf({ sampleSize: 5, acceptMajor: null, acceptMinor: null, failedCritical: [], found: { critical: 0, major: 5, minor: 5 } }).result).toBe('PASS')
  })
})

describe('the decision (QHS-034)', () => {
  const pass = computedOf({ sampleSize: 13, acceptMajor: 1, acceptMinor: 2, failedCritical: [], found: { critical: 0, major: 1, minor: 0 } })
  const failSoft = computedOf({ sampleSize: 13, acceptMajor: 1, acceptMinor: 2, failedCritical: [], found: { critical: 0, major: 2, minor: 0 } })
  const failHard = computedOf({ sampleSize: 13, acceptMajor: 1, acceptMinor: 2, failedCritical: [], found: { critical: 1, major: 0, minor: 0 } })
  const facts = (over: Partial<DecisionFacts> = {}): DecisionFacts => ({
    lotSize: '120',
    whole: true,
    sampleSize: 13,
    byHide: true,
    tally: tallyOf([...Array<'ACCEPTED'>(12).fill('ACCEPTED'), 'REJECTED']),
    undecided: [],
    computed: pass,
    mandatoryMissing: [],
    ...over,
  })

  it('adds up to the lot, in whole hides, never fewer than the sample says', () => {
    expect(decisionProblems({ accepted: '119', rejected: '1', toSort: '0' }, facts())).toEqual([])
    expect(decisionProblems({ accepted: '12', rejected: '1', toSort: '107' }, facts())).toEqual([])
    expect(paths(decisionProblems({ accepted: '118', rejected: '1', toSort: '0' }, facts()))).toEqual(['toSort'])
    expect(paths(decisionProblems({ accepted: '119.5', rejected: '0.5', toSort: '0' }, facts()))).toEqual(['accepted', 'rejected'])
    expect(paths(decisionProblems({ accepted: '120', rejected: '0', toSort: '0' }, facts()))).toEqual(['rejected'])
    expect(paths(decisionProblems({ accepted: '-1', rejected: '1', toSort: '120' }, facts()))).toEqual(['accepted'])
  })

  it('accepts hides outside the sample only on a whole sample; every hide of it decided first', () => {
    const half = facts({ tally: tallyOf(['ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'REJECTED']) })
    expect(decisionProblems({ accepted: '119', rejected: '1', toSort: '0' }, half)[0]!.message).toBe('Inspect the whole sample (5 of 13 hides done) before accepting hides outside it; reject or sort the rest now.')
    expect(decisionProblems({ accepted: '4', rejected: '1', toSort: '115' }, half)).toEqual([])
    expect(decisionProblems({ accepted: '119', rejected: '1', toSort: '0' }, facts({ undecided: ['HD-0007'] }))[0]).toEqual({ path: 'hides', message: 'Decide every hide of the sample first: HD-0007 has no decision.' })
  })

  it('never accepts the whole lot over a critical defect or a missing mandatory check', () => {
    const all = facts({ tally: tallyOf(Array<'ACCEPTED'>(13).fill('ACCEPTED')) })
    expect(paths(decisionProblems({ accepted: '120', rejected: '0', toSort: '0' }, { ...all, computed: failHard, mandatoryMissing: [] }))).toContain('accepted')
    expect(decisionProblems({ accepted: '120', rejected: '0', toSort: '0' }, { ...all, mandatoryMissing: ['Shade against the swatch'] })[0]!.message).toBe('Answer the mandatory checks before accepting the whole lot: Shade against the swatch.')
    // A split is still allowed with a critical find: the critical hides go out, the rest to sort.
    expect(decisionProblems({ accepted: '12', rejected: '1', toSort: '107' }, { ...facts(), computed: failHard })).toEqual([])
  })

  it('never accepts hides outside a failed sample in a split', () => {
    expect(decisionProblems({ accepted: '119', rejected: '1', toSort: '0' }, facts({ computed: failSoft }))[0]!.message).toBe(
      'The sample fails (2 units with a major defect; the plan accepts 1.): accept only the 12 hides inspected and accepted; reject or sort the rest.',
    )
    expect(decisionProblems({ accepted: '12', rejected: '108', toSort: '0' }, facts({ computed: failSoft }))).toEqual([])
  })

  it('asks the reason exactly when the whole lot goes against the computed result', () => {
    const all = facts({ tally: tallyOf(Array<'ACCEPTED'>(13).fill('ACCEPTED')) })
    expect(isOverride(decisionShape({ accepted: '120', rejected: '0' }, '120'), failSoft)).toBe(true)
    expect(paths(decisionProblems({ accepted: '120', rejected: '0', toSort: '0' }, { ...all, computed: failSoft }))).toEqual(['overrideReason'])
    expect(decisionProblems({ accepted: '120', rejected: '0', toSort: '0', overrideReason: 'Two light scars, the customer agreed in writing (made up).' }, { ...all, computed: failSoft })).toEqual([])
    const none = facts({ tally: tallyOf(Array<'REJECTED'>(13).fill('REJECTED')) })
    expect(paths(decisionProblems({ accepted: '0', rejected: '120', toSort: '0' }, none))).toEqual(['overrideReason'])
    expect(paths(decisionProblems({ accepted: '119', rejected: '1', toSort: '0', overrideReason: 'Not needed here.' }, facts()))).toEqual(['overrideReason'])
  })

  it('says what comes next in words: the lot waits for the quality role', () => {
    expect(nextStepOf({ accepted: '120', rejected: '0', toSort: '0' }, '120')).toBe('RELEASE')
    expect(nextStepOf({ accepted: '0', rejected: '120', toSort: '0' }, '120')).toBe('REJECT')
    expect(nextStepOf({ accepted: '12', rejected: '1', toSort: '107' }, '120')).toBe('SORT')
    expect(nextStepOf({ accepted: '119', rejected: '1', toSort: '0' }, '120')).toBe('RELEASE_PART')
    expect(nextWords('RELEASE_PART', 'LA-000001', { accepted: '119', rejected: '1', toSort: '0' }, 'HIDE').en).toBe(
      '119 accepted, 1 rejected: hold or return the rejected hide, then a person with the quality role types the code of lot LA-000001 (never the person who received it) to release it.',
    )
    expect(nextWords('RELEASE', 'LA-000001', { accepted: '120', rejected: '0', toSort: '0' }, 'HIDE').it).toContain('mai chi lo ha ricevuto')
    expect(secondOpenWords('LA-000001', 'IIN-2026-0001')).toBe('Lot LA-000001 has an open incoming inspection already, IIN-2026-0001: finish or cancel it first.')
  })

  it('words the sample as the bench shows it', () => {
    expect(sampleWords(13, '120.0000', 'HIDE', 5)).toEqual({ it: 'Controlla 13 pelli su 120 · 5 fatte', en: 'Inspect 13 of 120 hides · 5 done' })
    expect(sampleWords(2, '2', 'HIDE', null)).toEqual({ it: 'Controlla tutte le 2 pelli', en: 'Inspect all 2 hides' })
  })
})

describe('plan check results', () => {
  const checks = new Map<string, CheckFacts>([
    ['c-shade', { id: 'c-shade', code: 'SHADE', label: 'Shade against the swatch', type: 'CHOICE', checkClass: 'MAJOR', mandatory: true, nominal: null, tolerance: null, choices: ['1', '2', '3'] }],
    ['c-thick', { id: 'c-thick', code: 'THICKNESS', label: 'Thickness', type: 'MEASUREMENT', checkClass: 'MINOR', mandatory: false, nominal: '1.200', tolerance: '0.200', choices: [] }],
    ['c-crvi', { id: 'c-crvi', code: 'CRVI_TAG', label: 'Cr VI on the tag', type: 'PASS_FAIL', checkClass: 'CRITICAL', mandatory: true, nominal: null, tolerance: null, choices: [] }],
    ['c-read', { id: 'c-read', code: 'READ', label: 'Read the sheet', type: 'INSTRUCTION', checkClass: null, mandatory: false, nominal: null, tolerance: null, choices: [] }],
  ])

  it('takes values by type and outcomes by the numbers', () => {
    expect(measuredOutcome(checks.get('c-thick')!, '1.35')).toBe('PASS')
    expect(measuredOutcome(checks.get('c-thick')!, '1.45')).toBe('FAIL')
    expect(resultProblems([{ planCheckId: 'c-shade', outcome: 'PASS', value: '1' }, { planCheckId: 'c-thick', outcome: 'FAIL', value: '1.45' }, { planCheckId: 'c-crvi', outcome: 'PASS' }], checks, 13)).toEqual([])
    expect(paths(resultProblems([{ planCheckId: 'c-shade', outcome: 'PASS', value: '4' }], checks, 13))).toEqual(['results/0/value'])
    expect(resultProblems([{ planCheckId: 'c-thick', outcome: 'PASS', value: '1.45' }], checks, 13)[0]!.message).toBe('1.45 against 1.200 ± 0.200 is a FAIL, by the numbers.')
    expect(paths(resultProblems([{ planCheckId: 'c-read', outcome: 'PASS' }], checks, 13))).toEqual(['results/0/planCheckId'])
    expect(paths(resultProblems([{ planCheckId: 'nope', outcome: 'PASS' }], checks, 13))).toEqual(['results/0/planCheckId'])
    expect(paths(resultProblems([{ planCheckId: 'c-shade', outcome: 'PASS', value: '1' }, { planCheckId: 'c-shade', outcome: 'PASS', value: '2' }], checks, 13))).toEqual(['results/1/planCheckId'])
    expect(paths(resultProblems([{ planCheckId: 'c-shade', sampleIndex: 14, outcome: 'PASS', value: '1' }], checks, 13))).toEqual(['results/0/sampleIndex'])
  })

  it('never skips a critical check in silence', () => {
    expect(resultProblems([{ planCheckId: 'c-crvi', outcome: 'NOT_APPLICABLE' }], checks, 13)[0]).toEqual({ path: 'results/0/note', message: 'Cr VI on the tag is a critical check: say why it does not apply.' })
    expect(resultProblems([{ planCheckId: 'c-crvi', outcome: 'NOT_APPLICABLE', note: 'The lot has no tag: the lab tests it (made up).' }], checks, 13)).toEqual([])
  })

  it('reads the checks as the database does', () => {
    const list = [...checks.values()]
    expect(checksNow(list, [])).toEqual({ failed: [], failedCritical: [], mandatoryMissing: ['Shade against the swatch', 'Cr VI on the tag'] })
    expect(checksNow(list, [{ planCheckId: 'c-shade', failed: false }, { planCheckId: 'c-crvi', failed: true }])).toEqual({ failed: ['Cr VI on the tag'], failedCritical: ['Cr VI on the tag'], mandatoryMissing: [] })
  })
})

describe('permissions, templates and events', () => {
  it('declares the two permissions, shares them with the floor and gives them to the templates', () => {
    expect(FACTORY_PERMISSIONS.isDeclared('quality.incoming.view')).toBe(true)
    expect(FACTORY_PERMISSIONS.isDeclared('quality.incoming.record')).toBe(true)
    expect(FLOOR_SHARED_PERMISSIONS).toEqual(expect.arrayContaining(['quality.incoming.view', 'quality.incoming.record']))
    expect(templateOf('quality_inspector')!.permissions).toEqual(expect.arrayContaining(['quality.incoming.view', 'quality.incoming.record']))
    expect(templateOf('floor_inspector')!.permissions).toEqual(expect.arrayContaining(['quality.incoming.view', 'quality.incoming.record']))
    expect(templateOf('warehouse')!.permissions).toContain('quality.incoming.view')
    expect(templateOf('warehouse')!.permissions).not.toContain('quality.incoming.record')
    // Releasing the lot stays the quality role's (W3): the floor never holds it.
    expect(templateOf('floor_inspector')!.permissions).not.toContain('quality.lots.release')
  })

  it('declares the four events, live on the office and the tablet', () => {
    const mine = EVENT_DEFINITIONS.filter((event) => event.type.startsWith('incoming_inspection.'))
    expect(mine.map((event) => event.type)).toEqual(['incoming_inspection.opened', 'incoming_inspection.recorded', 'incoming_inspection.decided', 'incoming_inspection.cancelled'])
    for (const event of mine) expect(event.live).toMatchObject({ permission: 'quality.incoming.view', floor: 'quality.incoming.view' })
  })
})
