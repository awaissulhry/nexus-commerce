import { describe, expect, it } from 'vitest'
import * as domain from '@nexus/factory-domain/quality/incoming/rules'
import * as units from '@nexus/factory-domain/quality/incoming/units'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { LOCALES } from '../../../lib/i18n/locales'
import { checkWords, measuredOutcome, verdictOf, wayOf } from '../shared/plan-checks'
import type { BenchPayload, IncomingRecord } from './api'
import { designScreen } from './fixtures'
import {
  applyKept,
  areaDifference,
  closeZone,
  COMPONENT_KINDS,
  componentBody,
  componentSuggestion,
  decisionDefault,
  decisionHeld,
  FOUR_POINT_LIMIT,
  hideByCode,
  hideDraftOf,
  hideHeld,
  hidePayload,
  KNOWN_REFUSALS,
  MARK_KINDS,
  MARK_LIMIT,
  NEXT_STEPS,
  nextStepOf,
  OUTLINE_LIMIT,
  per100Of,
  PROTECTOR_TYPES,
  receiptSplit,
  rollDraftFor,
  rollHeld,
  rollSampleFull,
  sampleOf,
  sectionsOf,
  sectionState,
  tapHeld,
  tapMap,
  UNIT_DECISIONS,
  viewBoxOf,
  waitingWrites,
  withAnswers,
  withLineToggled,
  type DecisionDraft,
} from './model'

/**
 * SCR-175's rules (B-W2b-115): the copies held to factory-domain quality/incoming, the sample and its sections, a hide's draft and
 * its write, the hide map, rolls by the 4-point system, component lines, the plan's checks, a workshop's bundles, the decision held
 * with every reason, and a write kept on the tablet moving the record. The made-up records are the design cases'.
 */

const CASES = new Map(designScreen.cases.map((entry) => [entry.id, entry.model]))
const recordOf = (id: string): IncomingRecord => {
  const step = CASES.get(id)!.step
  if (!('record' in step)) throw new Error(`case ${id} has no record`)
  return step.record
}
const FRESH = recordOf('hides-fresh')
const UNDER_WAY = recordOf('hides-under-way')
const SAMPLE_DONE = recordOf('decision-split')
const PASSING_DONE = recordOf('decision-pass')
const ROLLS = recordOf('rolls')
const PIECES = recordOf('components')
const WORKSHOP = recordOf('decision-workshop')

describe('the copies of factory-domain', () => {
  it('decisions, marks, next steps, component kinds, protector types and the limits are the domain\'s', () => {
    expect([...UNIT_DECISIONS]).toEqual([...domain.UNIT_DECISIONS])
    expect([...MARK_KINDS]).toEqual([...domain.MARK_KINDS])
    expect([...NEXT_STEPS]).toEqual([...domain.NEXT_STEPS])
    expect([...COMPONENT_KINDS]).toEqual([...units.COMPONENT_KINDS])
    expect([...PROTECTOR_TYPES]).toEqual([...units.PROTECTOR_TYPES])
    expect(String(FOUR_POINT_LIMIT)).toBe(units.FOUR_POINT_LIMIT)
    expect(MARK_LIMIT).toBe(domain.INCOMING_LIMITS.marks)
    expect(OUTLINE_LIMIT).toBe(domain.INCOMING_LIMITS.outline)
  })

  it('points per 100 square yards and the next step as the domain computes them', () => {
    for (const [counts, width, length] of [[[6, 4, 2, 1], 145, 60], [[10, 8, 4, 6], 150, 40], [[0, 0, 0, 0], 120, 25]] as const) {
      const ours = per100Of({ counts: counts as unknown as [number, number, number, number], widthCm: width, lengthM: length })
      const theirs = units.pointsPer100SqYd({ onePoint: counts[0], twoPoint: counts[1], threePoint: counts[2], fourPoint: counts[3] }, String(width), String(length))
      expect(ours?.toFixed(2)).toBe(theirs)
    }
    for (const [accepted, rejected, toSort] of [['12', '0', '0'], ['0', '12', '0'], ['4', '1', '7'], ['10', '2', '0']] as const) {
      expect(nextStepOf({ accepted, rejected, toSort }, '12')).toBe(domain.nextStepOf({ accepted, rejected, toSort }, '12'))
    }
  })

  it('a workshop\'s split and a component\'s suggestion as the domain says them', () => {
    const lines = WORKSHOP.receipt!.lines
    for (const rejected of [[], ['l2'], ['l1', 'l3'], ['l1', 'l2', 'l3']]) expect(receiptSplit(lines, new Set(rejected))).toEqual(units.receiptSplit(lines, new Set(rejected)))
    const draft = { seq: 1, kind: 'PROTECTOR' as const, protectorType: 'B' as const, certificateId: 'c1', markingOk: true, checked: 5, defective: 0 }
    expect(componentSuggestion(draft).suggested).toBe(units.componentVerdict({ kind: 'PROTECTOR', marking: 'EN 1621-1 · B', protectorType: 'B', checkedQuantity: 5, defectiveQuantity: 0 }, 'VALID').suggested)
    expect(componentSuggestion({ ...draft, certificateId: null }).suggested).toBe(units.componentVerdict({ kind: 'PROTECTOR', marking: null, protectorType: 'B', checkedQuantity: 5 }, 'MISSING').suggested)
    expect(componentSuggestion({ ...draft, kind: 'ZIP', defective: 1 }).suggested).toBe(units.componentVerdict({ kind: 'ZIP', checkedQuantity: 5, defectiveQuantity: 1 }, 'NOT_NEEDED').suggested)
  })

  it('the shared plan checks: the way, the words, the verdict by the numbers', () => {
    expect(['PASS_FAIL', 'MEASUREMENT', 'CHOICE', 'INSTRUCTION', 'FREE_TEXT'].map((type) => wayOf({ type }))).toEqual(['tap', 'value', 'value', 'read', 'office'])
    expect(checkWords({ labelIt: 'Spessore', labelEn: 'Thickness' }, 'it')).toBe('Spessore')
    expect(verdictOf({ type: 'MEASUREMENT', nominal: '1.200', tolerance: '0.200' }, '1.5')).toBe('FAIL')
    expect(measuredOutcome('1.25', '1.200', '0.200')).toBe(domain.measuredOutcome({ nominal: '1.200', tolerance: '0.200' }, '1.25'))
  })
})

describe('the sample and its sections', () => {
  it('says the sample from the numbers: hides, rolls, pieces back from a workshop', () => {
    expect(sampleOf(FRESH)).toMatchObject({ kind: 'hides', sample: 5, lot: 12, done: 0, all: false })
    expect(sampleOf(ROLLS)).toMatchObject({ kind: 'rolls', sample: 3, lot: 120, done: 1 })
    expect(sampleOf(WORKSHOP)).toMatchObject({ kind: 'workshop', sample: 3, lot: 7, done: null })
  })

  it('shows the sections the lot needs, in the design\'s order, each with its state', () => {
    expect(sectionsOf(FRESH)).toEqual(['hides', 'checks', 'decision'])
    expect(sectionsOf(ROLLS)).toEqual(['rolls', 'decision'])
    expect(sectionsOf(PIECES)).toEqual(['components', 'counter', 'decision'])
    expect(sectionState(FRESH, 'hides')).toEqual({ state: 'todo', done: 0, of: 5 })
    expect(sectionState(UNDER_WAY, 'hides')).toMatchObject({ state: 'partly', done: 3 })
    expect(sectionState(SAMPLE_DONE, 'hides').state).toBe('failed')
    expect(sectionState(PASSING_DONE, 'hides').state).toBe('done')
    expect(sectionState(PIECES, 'components').state).toBe('partly')
    expect(sectionState(FRESH, 'checks')).toMatchObject({ state: 'todo', of: 4 })
  })
})

describe('hide by hide', () => {
  it('finds a hide by its tag, holds a cut hide and a full sample', () => {
    const tag = FRESH.candidates[0]!.code
    expect(hideByCode(FRESH, ` ${tag.toLowerCase()} `)).toEqual({ hideId: 'h1', inSample: false, whole: true })
    expect(hideByCode(FRESH, 'HD-NOPE')).toBeNull()
    expect(hideHeld(FRESH, 'h12')).toBe('notWhole')
    expect(hideHeld(SAMPLE_DONE, 'h6')).toBe('sampleFull')
    expect(hideHeld(SAMPLE_DONE, 'h2')).toBeNull()
  })

  it('the 2-tap write: shade and decision, no area (the area received stands)', () => {
    const draft = { ...hideDraftOf(FRESH, 'h1')!, shadeGroupId: 'sh1' }
    expect(hidePayload('iin-2', draft, 'ACCEPTED')).toEqual({ what: 'HIDE', inspectionId: 'iin-2', hideId: 'h1', shadeGroupId: 'sh1', gradeId: null, marks: [], decision: 'ACCEPTED' })
    const measured = hidePayload('iin-2', { ...draft, measuredArea: 46.2 }, 'REJECTED')
    expect(measured).toMatchObject({ measuredArea: '46.2', areaUom: 'FT2', decision: 'REJECTED' })
    // The domain takes what the bench sends.
    expect(domain.hideDraftProblems({ measuredArea: measured.measuredArea, areaUom: measured.areaUom, decision: 'REJECTED' })).toEqual([])
  })

  it('the area against the tannery\'s in percent, with its tone', () => {
    expect(areaDifference({ measuredArea: 46, declaredArea: 50 }, 2)).toEqual({ percent: -8, outcome: 'SHORT' })
    expect(areaDifference({ measuredArea: 49.5, declaredArea: 50 }, 2)).toEqual({ percent: -1, outcome: 'WITHIN' })
    expect(areaDifference({ measuredArea: 52, declaredArea: 50 }, 2)).toEqual({ percent: 4, outcome: 'OVER' })
    expect(areaDifference({ measuredArea: null, declaredArea: 50 }, 2)).toBeNull()
  })

  it('the hide map: a tap places the defect picked; a zone closes with three points; the domain takes the marks', () => {
    expect(tapHeld({ kind: 'defect', code: null }, [])).toBe('pickDefect')
    const one = tapMap({ kind: 'defect', code: 'SCAR' }, [], 0.4, 1.3)
    expect(one.marks).toEqual([{ kind: 'DEFECT', x: 0.4, y: 1, code: 'SCAR', zone: null, outline: null }])
    let zone = { tool: { kind: 'zone' as const, zone: 'B', points: [] as { x: number; y: number }[] }, marks: one.marks }
    expect(closeZone(zone.tool, zone.marks)).toBeNull()
    for (const [x, y] of [[0.1, 0.1], [0.3, 0.1], [0.2, 0.3]] as const) zone = tapMap(zone.tool, zone.marks, x, y) as typeof zone
    const closed = closeZone(zone.tool, zone.marks)!
    expect(closed.marks).toHaveLength(2)
    expect(closed.marks[1]).toMatchObject({ kind: 'ZONE', zone: 'B' })
    const payload = hidePayload('iin-2', { ...hideDraftOf(FRESH, 'h1')!, marks: closed.marks }, 'REJECTED')
    expect(domain.markProblems(payload.marks)).toEqual([])
    expect(tapHeld({ kind: 'defect', code: 'SCAR' }, Array.from({ length: MARK_LIMIT }, () => one.marks[0]!))).toBe('full')
  })

  it('the view follows the cross when zoomed in, never off the hide', () => {
    expect(viewBoxOf(1, { x: 0.5, y: 0.5 })).toEqual({ x: 0, y: 0, width: 1000, height: 700 })
    expect(viewBoxOf(2, { x: 0, y: 0 })).toEqual({ x: 0, y: 0, width: 500, height: 350 })
    expect(viewBoxOf(2, { x: 1, y: 1 })).toEqual({ x: 500, y: 350, width: 500, height: 350 })
  })
})

describe('rolls, components, checks', () => {
  it('a roll from its tag, a known roll, or the supplier\'s number; width and length asked when unknown', () => {
    expect(rollDraftFor(ROLLS, ROLLS.rollCandidates[0]!.code)).toMatchObject({ rollId: 'roll2', widthCm: 145, lengthM: 40, fromTag: true })
    expect(rollDraftFor(ROLLS, ROLLS.rolls[0]!.rollRef)).toMatchObject({ rollId: 'roll1', counts: [6, 4, 2, 1] })
    const typed = rollDraftFor(ROLLS, ' SUP-77 ')
    expect(typed).toMatchObject({ rollId: null, rollRef: 'SUP-77', widthCm: null, fromTag: false })
    expect(rollHeld(typed)).toBe('width')
    expect(rollSampleFull({ ...ROLLS, inspection: { ...ROLLS.inspection, sampleSize: 1 } }, typed)).toBe(true)
  })

  it('a protector line\'s write: the marking is the certificate\'s when the piece reads so', () => {
    const body = componentBody({ seq: 3, kind: 'PROTECTOR', protectorType: 'B', certificateId: 'c1', markingOk: true, checked: 5, defective: 0 }, PIECES.choices.certificates, 4, 'ACCEPTED')
    expect(body).toMatchObject({ version: 4, kind: 'PROTECTOR', marking: 'EN 1621-1:2012 · B', protectorType: 'B', certificateId: 'c1', checkedQuantity: 5, defectiveQuantity: 0 })
    expect(units.componentDraftProblems({ ...body, marking: body.marking })).toEqual([])
    expect(componentBody({ seq: 1, kind: 'ZIP', protectorType: null, certificateId: null, markingOk: null, checked: 5, defective: 1 }, [], 1, 'REJECTED')).toMatchObject({ marking: null, protectorType: null })
  })

  it('every answer sends the WHOLE list, one result per check for the sample', () => {
    const answered = withAnswers(SAMPLE_DONE.checks, [{ checkId: 'pc-smell', outcome: 'FAIL' }])
    expect(answered).toHaveLength(SAMPLE_DONE.checks.length)
    expect(answered.find((entry) => entry.planCheckId === 'pc-smell')).toEqual({ planCheckId: 'pc-smell', sampleIndex: 1, outcome: 'FAIL' })
    expect(answered.find((entry) => entry.planCheckId === 'pc-shade')).toEqual({ planCheckId: 'pc-shade', sampleIndex: 1, outcome: 'PASS', value: 'Uniforme' })
    expect(withAnswers(FRESH.checks, [{ checkId: 'pc-thick', outcome: 'PASS', value: '1.25' }])).toEqual([{ planCheckId: 'pc-thick', sampleIndex: 1, outcome: 'PASS', value: '1.25' }])
  })
})

describe('the decision', () => {
  const place = { online: true, waiting: 0 }
  const keys = (draft: DecisionDraft, record = SAMPLE_DONE, at = place) => decisionHeld(record, draft, at).map((reason) => reason.key)

  it('starts at what the sample says: the whole lot on a passing sample, else accepted / rejected and the rest to sort', () => {
    expect(decisionDefault(PASSING_DONE)).toEqual({ accepted: 12, rejected: 0, toSort: 0, rejectedLines: [] })
    expect(decisionDefault(SAMPLE_DONE)).toEqual({ accepted: 4, rejected: 1, toSort: 7, rejectedLines: [] })
    expect(decisionDefault(WORKSHOP)).toEqual({ accepted: 6, rejected: 1, toSort: 0, rejectedLines: [] })
    expect(withLineToggled(WORKSHOP, decisionDefault(WORKSHOP), 'l2')).toEqual({ accepted: 5, rejected: 2, toSort: 0, rejectedLines: ['l2'] })
  })

  it('a valid split signs; each rule holds it with its reason (as the domain refuses them)', () => {
    expect(keys({ accepted: 4, rejected: 1, toSort: 7, rejectedLines: [] })).toEqual([])
    expect(keys({ accepted: 4, rejected: 1, toSort: 5, rejectedLines: [] })).toEqual(['sum'])
    expect(keys({ accepted: 5, rejected: 1, toSort: 6, rejectedLines: [] })).toEqual(['failedSplit'])
    expect(keys({ accepted: 3, rejected: 2, toSort: 7, rejectedLines: [] })).toEqual(['below'])
    // The whole lot over a failing sample: the rejected hide binds the rejected pad (the domain's rule), and the override is the office's.
    expect(keys({ accepted: 12, rejected: 0, toSort: 0, rejectedLines: [] })).toEqual(['below', 'override'])
    expect(keys({ accepted: 4, rejected: 1, toSort: 7, rejectedLines: [] }, SAMPLE_DONE, { online: false, waiting: 2 })).toEqual(['offline', 'waiting'])
    expect(keys({ accepted: 3, rejected: 1, toSort: 8, rejectedLines: [] }, UNDER_WAY)).toEqual(['outsideBeforeWhole'])
    const undecided = { ...UNDER_WAY, hides: UNDER_WAY.hides.map((hide, index) => (index === 0 ? { ...hide, decision: null } : hide)) }
    expect(keys({ accepted: 1, rejected: 1, toSort: 10, rejectedLines: [] }, undecided)).toEqual(['hidesUndecided'])
    // The whole lot rejected over a passing sample: the sample's accepted hides bind the pad too (the domain's rule), and the override is the office's.
    expect(keys({ accepted: 0, rejected: 12, toSort: 0, rejectedLines: [] }, PASSING_DONE)).toEqual(['below', 'override'])
    expect(keys({ accepted: 4.5, rejected: 1, toSort: 6.5, rejectedLines: [] })).toContain('whole')
    // The domain refuses the same drafts.
    const facts = { lotSize: '12', whole: true, sampleSize: 5, byHide: true, tally: domain.tallyOf(SAMPLE_DONE.hides.map((hide) => hide.decision)), undecided: [], computed: { result: 'FAIL' as const, reasons: ['major'], hard: [] }, mandatoryMissing: [] }
    expect(domain.decisionProblems({ accepted: '4', rejected: '1', toSort: '7' }, facts)).toEqual([])
    expect(domain.decisionProblems({ accepted: '5', rejected: '1', toSort: '6' }, facts).map((problem) => problem.path)).toContain('accepted')
  })

  it('a workshop leaves nothing to sort; the whole lot is never accepted over a critical failure', () => {
    expect(keys({ accepted: 5, rejected: 1, toSort: 1, rejectedLines: [] }, WORKSHOP)).toContain('workshopSort')
    const critical = { ...PASSING_DONE, inspection: { ...PASSING_DONE.inspection, found: { critical: 1, major: 0, minor: 0 } } }
    expect(keys({ accepted: 12, rejected: 0, toSort: 0, rejectedLines: [] }, critical)).toContain('hard')
    expect(keys({ accepted: 4, rejected: 1, toSort: 7, rejectedLines: [] }, { ...SAMPLE_DONE, may: { ...SAMPLE_DONE.may, decide: false } })).toEqual(['notYours'])
  })

  it('counts this inspection\'s writes still on the tablet', () => {
    const item = (inspectionId: string, state = 'waiting', kind = 'quality.incoming.record') => ({ kind, state, payload: { inspectionId } })
    expect(waitingWrites([item('iin-2'), item('iin-2', 'recorded'), item('iin-9'), item('iin-2', 'waiting', 'quality.final.record')], 'iin-2')).toBe(1)
  })
})

describe('a write kept on the tablet moves the record at once', () => {
  it('a new hide joins the sample with its shade, grade, marks (with their words) and decision', () => {
    const payload: BenchPayload = { what: 'HIDE', inspectionId: 'iin-2', hideId: 'h4', shadeGroupId: 'sh2', gradeId: 'gB', marks: [{ kind: 'DEFECT', x: 0.5, y: 0.5, code: 'HOLE' }], decision: 'REJECTED' }
    const moved = applyKept(UNDER_WAY, payload)
    const hide = moved.hides.find((entry) => entry.hideId === 'h4')!
    expect(hide).toMatchObject({ shadeGroup: { id: 'sh2', label: '2' }, grade: { id: 'gB', code: 'B' }, decision: 'REJECTED', worstClass: 'CRITICAL' })
    expect(hide.marks[0]).toMatchObject({ code: 'HOLE', labelEn: 'Hole', defectClass: 'CRITICAL' })
    expect(moved.candidates.some((entry) => entry.hideId === 'h4')).toBe(false)
    expect(moved.progress).toMatchObject({ done: 4, rejected: 2 })
  })

  it('a hide taken out goes back to the lot\'s hides; the checks take their answers', () => {
    const out = applyKept(UNDER_WAY, { what: 'HIDE_REMOVED', inspectionId: 'iin-2', hideId: 'h2' })
    expect(out.hides.map((entry) => entry.hideId)).toEqual(['h1', 'h3'])
    expect(out.candidates.some((entry) => entry.hideId === 'h2')).toBe(true)
    const answered = applyKept(FRESH, { what: 'RESULTS', inspectionId: 'iin-2', results: [{ planCheckId: 'pc-smell', sampleIndex: 1, outcome: 'PASS' }] })
    expect(answered.checks.find((check) => check.id === 'pc-smell')!.answers).toHaveLength(1)
  })
})

describe('the words', () => {
  it('every refusal the screen knows has its words in both languages', () => {
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['floor-incoming'] ?? {}
      for (const code of KNOWN_REFUSALS) {
        expect(words[`refusal.${code}.message`], `${locale} ${code}`).toBeTruthy()
        expect(words[`refusal.${code}.fix`], `${locale} ${code}`).toBeTruthy()
      }
    }
  })
})
