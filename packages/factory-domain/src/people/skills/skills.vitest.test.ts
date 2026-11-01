import { describe, expect, it } from 'vitest'
import { assignmentOutcome, lineSkillsOf, qualificationOf, type HeldLevel, type MachineNeed, type QualificationFacts } from './qualification'
import { authorisationProblems, authorisationStateOf, endsWithin, levelPlan, signOffRefusal, skillProblems, traineeOn, traineeStateOf, trainerRefusal } from './rules'

const today = '2026-10-31'
const level = (value: HeldLevel['level'], extra: Partial<HeldLevel> = {}): HeldLevel => ({ levelId: 'l', level: value, since: '2026-01-05', traineeUntil: null, signedOffOn: null, ...extra })
const sew = (held: HeldLevel | null) => ({ operationId: 'op-sew', code: 'SEW', name: 'Sew the body', skills: [{ skillId: 's-sew', code: 'SK-SEW', name: 'Sewing', held }] })
const press = (extra: Partial<MachineNeed> = {}): MachineNeed => ({ machineClassId: 'c-cp', code: 'CLICKING_PRESS', label: 'Clicking press', assetNumbers: ['CP-01'], kept: true, authorisation: null, skills: [], ...extra })
const facts = (extra: Partial<QualificationFacts> = {}): QualificationFacts => ({ today, mode: 'WARN', person: { name: 'Made-up Person', active: true, hasRecord: true }, operation: null, machines: [], ...extra })

describe('skills and levels (MES-241)', () => {
  it('a skill has a code in capitals, a name, words per language and names exactly what it is about', () => {
    expect(skillProblems({ code: 'sk-sew.1', name: 'Sewing', nameI18n: { it: 'Cucitura' }, kind: 'OPERATION', operationId: 'op', sortOrder: 1 })).toEqual([])
    expect(skillProblems({ code: 'SK SEW', name: ' ', nameI18n: { ITA: 'x' }, kind: 'MACHINE', operationId: 'op', sortOrder: -1 }).map((problem) => problem.path)).toEqual(['code', 'name', 'nameI18n/ITA', 'operationId', 'machineClassId', 'sortOrder'])
    expect(skillProblems({ kind: 'GENERAL', machineClassId: 'c' }).map((problem) => problem.path)).toEqual(['machineClassId'])
  })

  it('a changed level is assessed again; the start moves to today unless the level has a trainee period; the same level writes nothing', () => {
    expect(levelPlan(null, { level: 'CAN_DO' }, today)).toEqual({ kind: 'INSERT', level: 'CAN_DO', since: today, traineeUntil: null })
    expect(levelPlan(null, { level: 'LEARNING', since: '2026-10-01', traineeUntil: '2026-12-15' }, today)).toMatchObject({ kind: 'INSERT', traineeUntil: '2026-12-15' })
    const current = { level: 'CAN_DO' as const, since: '2025-01-01', traineeUntil: null, signedOffOn: null }
    expect(levelPlan(current, { level: 'EXPERT' }, today)).toEqual({ kind: 'UPDATE', changes: { level: 'EXPERT', since: today }, assessed: true })
    expect(levelPlan(current, { level: 'CAN_DO' }, today)).toEqual({ kind: 'NONE' })
    expect(levelPlan(current, { level: 'CAN_DO', since: '2027-01-01' }, today)).toMatchObject({ kind: 'REFUSED', refusal: 'SINCE_IN_FUTURE' })
    const trainee = { level: 'LEARNING' as const, since: '2026-09-01', traineeUntil: '2026-12-15', signedOffOn: null }
    expect(levelPlan(trainee, { level: 'CAN_DO' }, today)).toEqual({ kind: 'UPDATE', changes: { level: 'CAN_DO' }, assessed: true })
    expect(levelPlan(trainee, { level: 'LEARNING', traineeUntil: '2027-01-15' }, today)).toEqual({ kind: 'UPDATE', changes: { traineeUntil: '2027-01-15' }, assessed: false })
  })

  it('a trainee stays one until signed off: an open period is never cleared, a signed-off one never moves', () => {
    const trainee = { level: 'LEARNING' as const, since: '2026-09-01', traineeUntil: '2026-12-15', signedOffOn: null }
    expect(levelPlan(trainee, { level: 'LEARNING', traineeUntil: null }, today)).toMatchObject({ kind: 'REFUSED', refusal: 'TRAINEE_OPEN' })
    expect(levelPlan(trainee, { level: 'LEARNING', traineeUntil: '2026-08-01' }, today)).toMatchObject({ kind: 'REFUSED', refusal: 'TRAINEE_OPEN', field: 'traineeUntil' })
    const signed = { ...trainee, level: 'CAN_DO' as const, signedOffOn: '2026-10-15' }
    expect(levelPlan(signed, { level: 'CAN_DO', traineeUntil: '2027-01-01' }, today)).toMatchObject({ kind: 'REFUSED', refusal: 'SIGNED_OFF' })
    expect(levelPlan(signed, { level: 'EXPERT' }, today)).toEqual({ kind: 'UPDATE', changes: { level: 'EXPERT' }, assessed: true })
    expect(levelPlan(signed, { level: 'EXPERT', since: '2026-10-20' }, today)).toMatchObject({ kind: 'REFUSED', refusal: 'SIGNED_OFF', field: 'since' })
  })

  it('trainee states, the trainee on a past day, and the sign-off and trainer rules (MES-244)', () => {
    expect(traineeStateOf({ traineeUntil: null, signedOffOn: null }, today)).toBe('NONE')
    expect(traineeStateOf({ traineeUntil: '2026-12-15', signedOffOn: null }, today)).toBe('TRAINEE')
    expect(traineeStateOf({ traineeUntil: '2026-10-30', signedOffOn: null }, today)).toBe('OVERDUE')
    expect(traineeStateOf({ traineeUntil: '2026-10-30', signedOffOn: '2026-10-29' }, today)).toBe('SIGNED_OFF')
    const row = { since: '2026-09-01', traineeUntil: '2026-10-31', signedOffOn: '2026-10-15' }
    expect([traineeOn(row, '2026-08-31'), traineeOn(row, '2026-09-01'), traineeOn(row, '2026-10-14'), traineeOn(row, '2026-10-15')]).toEqual([false, true, true, false])
    const open = { level: 'LEARNING' as const, since: '2026-09-01', traineeUntil: '2026-12-15', signedOffOn: null }
    expect(signOffRefusal(open, today, today)).toBeNull()
    expect(signOffRefusal(open, '2026-08-01', today)?.refusal).toBe('SIGN_OFF_BEFORE_START')
    expect(signOffRefusal(open, '2026-11-01', today)?.refusal).toBe('SIGN_OFF_IN_FUTURE')
    expect(signOffRefusal({ ...open, traineeUntil: null }, today, today)?.refusal).toBe('NOT_A_TRAINEE')
    expect(signOffRefusal({ ...open, signedOffOn: '2026-10-01' }, today, today)?.refusal).toBe('SIGNED_OFF')
    const trainer = { employeeId: 't', companyId: 'A', active: true, level: 'TRAINER' as const, trainee: false }
    expect(trainerRefusal(trainer, { employeeId: 'p', companyId: 'A' })).toBeNull()
    expect(trainerRefusal(trainer, { employeeId: 't', companyId: 'A' })?.refusal).toBe('TRAINER_IS_TRAINEE')
    expect(trainerRefusal(trainer, { employeeId: 'p', companyId: 'B' })?.refusal).toBe('TRAINER_OTHER_COMPANY')
    expect(trainerRefusal({ ...trainer, level: 'EXPERT' }, { employeeId: 'p', companyId: 'A' })?.refusal).toBe('TRAINER_NOT_TRAINER')
    expect(trainerRefusal({ ...trainer, active: false }, { employeeId: 'p', companyId: 'A' })?.refusal).toBe('TRAINER_LEFT')
  })

  it('machine authorisations: in force, starting later, ended, revoked; the end on or after the start (MES-246)', () => {
    expect(authorisationStateOf({ authorisedOn: '2026-01-01', validUntil: null, revoked: false }, today)).toBe('AUTHORISED')
    expect(authorisationStateOf({ authorisedOn: '2026-11-02', validUntil: null, revoked: false }, today)).toBe('NOT_YET')
    expect(authorisationStateOf({ authorisedOn: '2026-01-01', validUntil: '2026-10-30', revoked: false }, today)).toBe('EXPIRED')
    expect(authorisationStateOf({ authorisedOn: '2026-01-01', validUntil: today, revoked: false }, today)).toBe('AUTHORISED')
    expect(authorisationStateOf({ authorisedOn: '2026-01-01', validUntil: null, revoked: true }, today)).toBe('REVOKED')
    expect(authorisationProblems({ authorisedOn: '2026-11-01', validUntil: '2026-10-01' }).map((problem) => problem.path)).toEqual(['validUntil'])
    expect(endsWithin({ authorisedOn: '2026-01-01', validUntil: '2026-12-01', revoked: false }, today, '2026-12-30')).toBe(true)
    expect(endsWithin({ authorisedOn: '2026-01-01', validUntil: '2027-02-01', revoked: false }, today, '2026-12-30')).toBe(false)
  })
})

describe('the qualification check (MES-024, MES-246)', () => {
  it('a qualified person passes; nothing kept is nothing to check', () => {
    expect(qualificationOf(facts({ operation: sew(level('CAN_DO')) }))).toMatchObject({ outcome: 'QUALIFIED', decision: 'ALLOW', findings: [], trainee: false })
    const none = qualificationOf(facts({ operation: { operationId: 'op', code: 'QC', name: 'Check', skills: [] }, machines: [press({ kept: false })] }))
    expect(none).toMatchObject({ outcome: 'NOT_CHECKED', decision: 'ALLOW' })
    expect(none.message).toMatch(/nothing to check/)
  })

  it('a trainee works on and the work carries the trainee mark; Learning without a trainee period is not qualified', () => {
    const trainee = qualificationOf(facts({ operation: sew(level('LEARNING', { traineeUntil: '2026-12-15' })) }))
    expect(trainee).toMatchObject({ outcome: 'TRAINEE', decision: 'ALLOW', trainee: true })
    expect(trainee.message).toMatch(/as a trainee \(until 2026-12-15\)/)
    expect(qualificationOf(facts({ operation: sew(level('LEARNING')) })).findings.map((finding) => finding.code)).toEqual(['LEARNING_ONLY'])
  })

  it('a missing skill follows the site rule: FREE lets it go silently, WARN tells, STRICT holds and a team leader may override', () => {
    expect(qualificationOf(facts({ mode: 'FREE', operation: sew(null) }))).toMatchObject({ outcome: 'NOT_QUALIFIED', decision: 'ALLOW', findings: [] })
    expect(qualificationOf(facts({ mode: 'WARN', operation: sew(null) }))).toMatchObject({ decision: 'WARN', overridable: false, findings: [{ code: 'NO_SKILL', mode: 'WARN', overridable: true }] })
    const strict = qualificationOf(facts({ mode: 'STRICT', operation: sew(null) }))
    expect(strict).toMatchObject({ decision: 'HOLD', overridable: true })
    expect(strict.message).toMatch(/A team leader may override it with their PIN and a reason\.$/)
  })

  it('a class kept under authorisation always holds without one, ended or not yet valid, and is never overridden', () => {
    const none = qualificationOf(facts({ mode: 'FREE', operation: sew(level('CAN_DO')), machines: [press()] }))
    expect(none).toMatchObject({ outcome: 'NOT_QUALIFIED', decision: 'HOLD', overridable: false, findings: [{ code: 'NOT_AUTHORISED', kind: 'AUTHORISATION', mode: 'STRICT' }] })
    expect(none.message).toMatch(/not authorised on Clicking press machines \(CP-01\)/)
    const ended = qualificationOf(facts({ machines: [press({ authorisation: { authorisationId: 'a', authorisedOn: '2026-01-01', validUntil: '2026-10-01' } })] }))
    expect(ended.findings.map((finding) => finding.code)).toEqual(['AUTHORISATION_EXPIRED'])
    const later = qualificationOf(facts({ machines: [press({ authorisation: { authorisationId: 'a', authorisedOn: '2026-11-02', validUntil: null } })] }))
    expect(later.findings.map((finding) => finding.code)).toEqual(['AUTHORISATION_NOT_YET'])
    const authorised = qualificationOf(facts({ machines: [press({ authorisation: { authorisationId: 'a', authorisedOn: '2026-01-01', validUntil: null } })] }))
    expect(authorised).toMatchObject({ outcome: 'QUALIFIED', decision: 'ALLOW' })
    // A skill held next to a held authorisation: still not overridable as a whole.
    const mixed = qualificationOf(facts({ mode: 'STRICT', operation: sew(null), machines: [press()] }))
    expect(mixed).toMatchObject({ decision: 'HOLD', overridable: false })
  })

  it('the best of several skills decides, a machine skill counts, a person who left is held', () => {
    const operation = { operationId: 'op', code: 'SEW', name: 'Sew', skills: [{ skillId: 'a', code: 'A', name: 'A', held: level('LEARNING') }, { skillId: 'b', code: 'B', name: 'B', held: level('EXPERT') }] }
    expect(qualificationOf(facts({ operation })).requirements[0]).toMatchObject({ state: 'QUALIFIED', skill: { code: 'B' }, level: 'EXPERT' })
    const machineSkill = qualificationOf(facts({ machines: [press({ kept: false, skills: [{ skillId: 'm', code: 'M', name: 'Press', held: null }] })] }))
    expect(machineSkill.findings.map((finding) => [finding.code, finding.requirement])).toEqual([['NO_SKILL', 'CLICKING_PRESS']])
    expect(qualificationOf(facts({ person: { name: 'X', active: false, hasRecord: true }, operation: sew(level('EXPERT')) }))).toMatchObject({ outcome: 'NOT_QUALIFIED', decision: 'HOLD', overridable: false })
    expect(qualificationOf(facts({ person: { name: 'X', active: true, hasRecord: false }, operation: sew(null) })).findings[0]!.message).toMatch(/no employee record/)
  })

  it('dispatch: ALLOW assigns, WARN asks a reason, HOLD is a held drop in words', () => {
    expect(assignmentOutcome(qualificationOf(facts({ operation: sew(level('CAN_DO')) })), null)).toEqual({ assignable: true, override: null })
    const warn = qualificationOf(facts({ operation: sew(null) }))
    expect(assignmentOutcome(warn, '  ')).toMatchObject({ assignable: false, refusal: 'OVERRIDE_REASON_NEEDED' })
    expect(assignmentOutcome(warn, 'Covering for an absence')).toEqual({ assignable: true, override: { reason: 'Covering for an absence', codes: ['NO_SKILL'] } })
    expect(assignmentOutcome(qualificationOf(facts({ mode: 'STRICT', operation: sew(null) })), 'x')).toMatchObject({ assignable: false, refusal: 'NOT_QUALIFIED' })
    expect(assignmentOutcome(qualificationOf(facts({ machines: [press()] })), 'x')).toMatchObject({ assignable: false, refusal: 'NOT_AUTHORISED' })
  })

  it('the loan dialog: can do n of the kept operations on a line, trainees and operations with no skill said apart', () => {
    const line = lineSkillsOf('B', [sew(level('CAN_DO')), { ...sew(level('LEARNING', { traineeUntil: '2026-12-01' })), operationId: 'o2', code: 'SLV' }, { ...sew(null), operationId: 'o3', code: 'ZIP' }, { operationId: 'o4', code: 'IRON', name: 'Iron', skills: [] }], today)
    expect(line).toMatchObject({ canDo: 2, asTrainee: 1, kept: 3, notKept: 1, message: 'Can do 2 of 3 operations on line B (1 as a trainee; 1 more keeps no skill).' })
    expect(lineSkillsOf('B', [], today).message).toMatch(/nothing to check/)
  })
})
