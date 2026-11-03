import { describe, expect, it } from 'vitest'
import {
  answerSha256,
  checklistCodeOf,
  correctionProblems,
  correctionsOf,
  currentValue,
  fieldRuleOf,
  fieldsOf,
  fieldWords,
  normalValue,
  requestSha256,
  standing,
  targetKey,
  valueWords,
  waitingOn,
  type AmendmentRow,
  type FieldRule,
} from './rules'

const rule = (record: Parameters<typeof fieldRuleOf>[0], field: string, row: Parameters<typeof fieldRuleOf>[2]): FieldRule => {
  const found = fieldRuleOf(record, field, row)
  if (!found) throw new Error(`no rule for ${field}`)
  return found
}

const at = (minute: number) => new Date(Date.UTC(2026, 10, 3, 9, minute))
const row = (id: string, kind: AmendmentRow['kind'], fields: Partial<AmendmentRow> = {}): AmendmentRow => ({
  id,
  kind,
  requestId: null,
  field: null,
  recordType: null,
  recordId: null,
  before: null,
  after: null,
  reason: null,
  signedById: 'u1',
  signedAt: at(0),
  signatureSha256: 'a'.repeat(64),
  ...fields,
})

describe('what a correction may change', () => {
  it('takes the note of every record kind, a result value and note, a measured value, a defect line and a hide note', () => {
    for (const record of ['Inspection', 'IncomingInspection', 'InProcessCheck'] as const) expect(fieldRuleOf(record, 'note', null)?.kind).toBe('note')
    expect(fieldRuleOf('InProcessCheck', 'value', 'InspectionCheckResult')?.kind).toBe('value')
    expect(fieldRuleOf('Inspection', 'measured', 'InspectionMeasurement')?.kind).toBe('decimal')
    expect(fieldsOf('Inspection', 'InspectionDefect').map((entry) => entry.field)).toEqual(['zone', 'description', 'note', 'causeCodeId'])
    expect(fieldRuleOf('IncomingInspection', 'note', 'IncomingHideResult')?.kind).toBe('note')
  })

  it('never a verdict: outcomes, quantities, classes, sizes, a defect line of another kind of record', () => {
    expect(fieldRuleOf('Inspection', 'outcome', 'InspectionCheckResult')).toBeNull()
    expect(fieldRuleOf('Inspection', 'quantity', 'InspectionDefect')).toBeNull()
    expect(fieldRuleOf('Inspection', 'defectClass', 'InspectionDefect')).toBeNull()
    expect(fieldRuleOf('Inspection', 'lotSize', null)).toBeNull()
    expect(fieldRuleOf('IncomingInspection', 'zone', 'InspectionDefect')).toBeNull()
    expect(fieldRuleOf('InProcessCheck', 'pieces', null)).toBeNull()
  })

  it('a W1 checklist line of a final inspection by its code', () => {
    expect(checklistCodeOf('checklist.CE_MARK.note')).toBe('CE_MARK')
    expect(fieldRuleOf('Inspection', 'checklist.CE_MARK.note', null)?.kind).toBe('note')
    expect(fieldRuleOf('IncomingInspection', 'checklist.CE_MARK.note', null)).toBeNull()
    expect(fieldWords('Inspection', 'checklist.CE_MARK.note', null, 'en')).toBe('Checklist note CE_MARK')
  })
})

describe('correctionProblems', () => {
  const measured = rule('Inspection', 'measured', 'InspectionMeasurement')
  const facts = { measurement: { pointCode: 'CHEST', nominal: '58.000', tolerance: '1.000', pass: true } }

  it('takes a typo inside the tolerance, with the reason', () => {
    expect(correctionProblems({ rule: measured, facts, before: '58.400', after: '58.6', reason: 'Typed 58.4 for 58.6.' })).toEqual([])
  })

  it('SAFETY: refuses a value that turns a pass into a fail, or a fail into a pass', () => {
    const problems = correctionProblems({ rule: measured, facts, before: '58.400', after: '59.8', reason: 'Wrong reading.' })
    expect(problems).toEqual([expect.objectContaining({ path: 'refusal/VERDICT' })])
    expect(problems[0]!.message).toMatch(/pass into a fail.*reverse the release and inspect again/)
    const failed = { measurement: { ...facts.measurement, pass: false } }
    expect(correctionProblems({ rule: measured, facts: failed, before: '59.800', after: '58.2', reason: 'Wrong reading.' })[0]).toMatchObject({ path: 'refusal/VERDICT' })
  })

  it('a measurement check result keeps its outcome too', () => {
    const value = rule('InProcessCheck', 'value', 'InspectionCheckResult')
    const check = { check: { type: 'MEASUREMENT' as const, code: 'SEAM', nominal: '10.000', tolerance: '0.500', choices: [] }, outcome: 'PASS' as const }
    expect(correctionProblems({ rule: value, facts: check, before: '10.2', after: '10.4', reason: 'Typo at the bench.' })).toEqual([])
    expect(correctionProblems({ rule: value, facts: check, before: '10.2', after: '11', reason: 'Typo at the bench.' })[0]).toMatchObject({ path: 'refusal/VERDICT' })
  })

  it('a value of the check type; a pass/fail check, a photo and a not applicable result take none', () => {
    const value = rule('Inspection', 'value', 'InspectionCheckResult')
    const choice = { check: { type: 'CHOICE' as const, code: 'SHADE', nominal: null, tolerance: null, choices: ['1', '2'] }, outcome: 'PASS' as const }
    expect(correctionProblems({ rule: value, facts: choice, before: '1', after: '3', reason: 'Wrong tile.' })[0]).toMatchObject({ path: 'body/after', message: expect.stringMatching(/One of the check's choices: 1, 2/) })
    const passFail = { check: { type: 'PASS_FAIL' as const, code: 'CE_MARK', nominal: null, tolerance: null, choices: [] }, outcome: 'PASS' as const }
    expect(correctionProblems({ rule: value, facts: passFail, before: null, after: 'ok', reason: 'Add a value.' })[0]!.message).toMatch(/takes no value/)
    const notApplicable = { ...choice, outcome: 'NOT_APPLICABLE' as const }
    expect(correctionProblems({ rule: value, facts: notApplicable, before: null, after: '1', reason: 'Was applicable.' })[0]!.message).toMatch(/not applicable/)
    expect(correctionProblems({ rule: value, facts: choice, before: '1', after: null, reason: 'Clear it.' })[0]).toMatchObject({ path: 'body/after' })
  })

  it('the reason, a change at all, a zone of the map, an active cause', () => {
    const note = rule('Inspection', 'note', null)
    expect(correctionProblems({ rule: note, facts: {}, before: 'a', after: 'b', reason: 'x' })[0]).toMatchObject({ path: 'body/reason' })
    expect(correctionProblems({ rule: note, facts: {}, before: 'same', after: 'same', reason: 'Nothing.' })[0]).toMatchObject({ path: 'body/after', message: expect.stringMatching(/nothing to correct/) })
    expect(correctionProblems({ rule: measured, facts, before: '58.400', after: '58.40', reason: 'Same number.' })[0]!.message).toMatch(/nothing to correct/)
    const zone = rule('Inspection', 'zone', 'InspectionDefect')
    expect(correctionProblems({ rule: zone, facts: {}, before: null, after: 'MOON', reason: 'Wrong zone.' })[0]).toMatchObject({ path: 'body/after' })
    expect(correctionProblems({ rule: zone, facts: {}, before: null, after: 'ELBOW_L', reason: 'Pinned now.' })).toEqual([])
    const cause = rule('Inspection', 'causeCodeId', 'InspectionDefect')
    const active = { activeCauses: new Set(['0190f7c4-0000-7000-8000-000000000001']) }
    expect(correctionProblems({ rule: cause, facts: active, before: null, after: '0190f7c4-0000-7000-8000-000000000002', reason: 'Cause found.' })[0]!.message).toMatch(/active cause/)
    expect(correctionProblems({ rule: cause, facts: active, before: null, after: '0190f7c4-0000-7000-8000-000000000001', reason: 'Cause found.' })).toEqual([])
  })
})

describe('what stands now', () => {
  const ask = (id: string, minute: number, after: string, fields: Partial<AmendmentRow> = {}) => row(id, 'REQUEST', { field: 'note', before: null, after, reason: 'Why', signedAt: at(minute), ...fields })
  const answer = (id: string, requestId: string, kind: 'SIGNED' | 'REFUSED', minute: number) => row(id, kind, { requestId, signedById: 'u2', signedAt: at(minute), reason: kind === 'REFUSED' ? 'No.' : null })

  it('a request waits; signed it stands, newest signed last; refused it changes nothing', () => {
    const rows = [ask('r1', 1, 'first'), answer('a1', 'r1', 'SIGNED', 2), ask('r2', 3, 'second'), answer('a2', 'r2', 'REFUSED', 4), ask('r3', 5, 'third'), answer('a3', 'r3', 'SIGNED', 6), ask('r4', 7, 'fourth')]
    const corrections = correctionsOf(rows)
    expect(corrections.map((entry) => entry.state)).toEqual(['SIGNED', 'REFUSED', 'SIGNED', 'WAITING'])
    const now = standing(corrections)
    expect(currentValue('own', now, targetKey('note', null))).toBe('third')
    expect(currentValue('own', now, targetKey('note', { type: 'InspectionDefect', id: 'd1' }))).toBe('own')
    expect(waitingOn(corrections, targetKey('note', null))?.request.id).toBe('r4')
  })

  it('a row field is its own target', () => {
    const corrections = correctionsOf([ask('r1', 1, '58.600', { field: 'measured', recordType: 'InspectionMeasurement', recordId: 'm1' }), answer('a1', 'r1', 'SIGNED', 2)])
    const now = standing(corrections)
    expect(currentValue('58.400', now, targetKey('measured', { type: 'InspectionMeasurement', id: 'm1' }))).toBe('58.600')
    expect(currentValue('58.400', now, targetKey('measured', { type: 'InspectionMeasurement', id: 'm2' }))).toBe('58.400')
  })

  it('values in words and normalised as stored', () => {
    expect(normalValue('decimal', '58.4')).toBe('58.400')
    expect(normalValue('note', '  ')).toBeNull()
    expect(valueWords('decimal', '58.400', 'en')).toBe('58.4')
    expect(valueWords('zone', 'ELBOW_L', 'it')).toBe('Gomito sinistro')
    expect(valueWords('note', null, 'en')).toBe('(empty)')
  })
})

describe('the signatures', () => {
  it('a SHA-256 of what was signed: the same statement the same hash, any change another', () => {
    const statement = { recordType: 'Inspection' as const, recordId: 'i1', recordSignature: 'b'.repeat(64), field: 'note', row: null, before: null, after: 'x', reason: 'Why', signedById: 'u1', at: '2026-11-03T09:00:00.000Z' }
    expect(requestSha256(statement)).toMatch(/^[0-9a-f]{64}$/)
    expect(requestSha256(statement)).toBe(requestSha256({ ...statement }))
    expect(requestSha256({ ...statement, after: 'y' })).not.toBe(requestSha256(statement))
    const answered = { requestId: 'r1', requestSignature: requestSha256(statement), answer: 'SIGNED' as const, reason: null, signedById: 'u2', at: '2026-11-03T09:05:00.000Z' }
    expect(answerSha256(answered)).not.toBe(answerSha256({ ...answered, answer: 'REFUSED', reason: 'No' }))
  })
})
