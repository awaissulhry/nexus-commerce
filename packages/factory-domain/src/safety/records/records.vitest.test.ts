import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import type { CompanyLegal } from '../../documents/model'
import { EVENT_DEFINITIONS } from '../../events/catalogue'
import { qualificationOf, type CourseNeed, type MachineNeed, type QualificationFacts } from '../../people/skills/qualification'
import type { PersonNeed } from '../training/rules'
import { dueListDocument, trainingRecordDocument } from './documents'
import { SAFETY_INSTRUCTION_RECORD, SAFETY_TRAINING_RECORD } from './permissions'
import {
  closePlan,
  countDue,
  dueCellsOf,
  expectedValidUntil,
  heldByTrainingOf,
  inView,
  instructionProblems,
  latestOf,
  recordProblems,
  sessionProblems,
  signedAttendanceText,
  standingOf,
  stoppedWords,
  validityOf,
  validUntilOf,
  type RecordFacts,
} from './rules'

/** The training records (B-W2b-139; QHS-243, QHS-244, QHS-246, QHS-247, QHS-248). Every id, name and number is made up. */

const today = '2026-11-05'
const C = { general: 'c-general', high: 'c-high', fire: 'c-fire' }
const P = { anna: 'p-anna', bruno: 'p-bruno', carla: 'p-carla' }

let seq = 0
const record = (fields: Partial<RecordFacts> & Pick<RecordFacts, 'employeeId' | 'courseId' | 'completedOn'>): RecordFacts => ({
  id: `r-${++seq}`,
  result: 'PASSED',
  validUntil: null,
  languageChecked: true,
  correctsId: null,
  createdAt: `${fields.completedOn}T10:00:00.000Z`,
  ...fields,
})
const need = (employeeId: string, courseId: string, dueOn: string, kind: 'ROLE_SHEET' | 'MACHINE_CLASS' = 'ROLE_SHEET', withinDays: number | null = 30): PersonNeed => {
  const state = dueOn < today ? 'OVERDUE' : 'DUE'
  return { employeeId, courseId, met: false, dueOn, state, sources: [{ kind, id: kind === 'ROLE_SHEET' ? 'sheet-1' : 'class-press', since: '2026-01-01', withinDays, dueOn, state }] }
}

describe('validity and what stands (QHS-243, QHS-244)', () => {
  it('a record is valid until its day plus the course’s refresher period; none: no expiry', () => {
    expect(expectedValidUntil('2024-03-15', 24)).toBe('2026-03-15')
    expect(expectedValidUntil('2024-03-15', null)).toBeNull()
    expect(validityOf(null, today)).toBe('VALID')
    expect(validityOf('2026-11-04', today)).toBe('EXPIRED')
    expect(validityOf('2026-11-05', today)).toBe('DUE_SOON')
    expect(validityOf('2027-01-04', today)).toBe('DUE_SOON')
    expect(validityOf('2027-01-05', today)).toBe('VALID')
  })

  it('a correction replaces the record it names; a VOID correction removes it; the newest PASSED decides', () => {
    const first = record({ employeeId: P.anna, courseId: C.general, completedOn: '2025-01-10', validUntil: '2030-01-10' })
    const wrongDay = record({ employeeId: P.anna, courseId: C.general, completedOn: '2025-01-12', validUntil: '2030-01-12', correctsId: first.id })
    const failed = record({ employeeId: P.anna, courseId: C.general, completedOn: '2026-02-01', result: 'FAILED' })
    expect(standingOf([first, wrongDay, failed]).map((row) => row.id)).toEqual([failed.id, wrongDay.id])
    expect(latestOf([first, wrongDay, failed]).get(`${P.anna}|${C.general}`)).toMatchObject({ passed: { id: wrongDay.id }, last: { id: failed.id } })
    const voided = record({ employeeId: P.anna, courseId: C.general, completedOn: '2025-01-12', result: 'VOID', correctsId: wrongDay.id })
    expect(latestOf([first, wrongDay, voided]).get(`${P.anna}|${C.general}`)).toBeUndefined()
  })
})

describe('the due cells, the list and the tiles (design DueCell; "Training overdue", "Due in 60 days", "Language not checked")', () => {
  const records = [
    record({ employeeId: P.anna, courseId: C.general, completedOn: '2022-01-10', validUntil: '2027-06-01' }),
    record({ employeeId: P.anna, courseId: C.high, completedOn: '2021-11-01', validUntil: '2026-12-01', languageChecked: false }),
    record({ employeeId: P.bruno, courseId: C.general, completedOn: '2020-01-10', validUntil: '2025-01-10' }),
    // A lapsed record nobody needs any more.
    record({ employeeId: P.carla, courseId: C.fire, completedOn: '2019-01-10', validUntil: '2024-01-10' }),
  ]
  const needs = [need(P.anna, C.general, '2022-02-01'), need(P.anna, C.high, '2022-02-01'), need(P.bruno, C.general, '2020-02-01'), need(P.bruno, C.high, '2026-12-20'), need(P.carla, C.general, '2026-10-01', 'MACHINE_CLASS', null)]
  const cells = dueCellsOf({ needs, records, today })
  const cell = (employeeId: string, courseId: string) => cells.find((row) => row.employeeId === employeeId && row.courseId === courseId)!

  it('one cell per need and per standing PASSED record: valid, due soon, expired, Needed', () => {
    expect(cell(P.anna, C.general)).toMatchObject({ state: 'VALID', needed: true, required: true, overdue: false, soon: false, dueOn: '2027-06-01' })
    expect(cell(P.anna, C.high)).toMatchObject({ state: 'DUE_SOON', overdue: false, soon: true, dueOn: '2026-12-01', languageNotChecked: true })
    // Needed, lapsed and past the requirement's day: overdue.
    expect(cell(P.bruno, C.general)).toMatchObject({ state: 'EXPIRED', overdue: true, soon: false, dueOn: '2025-01-10', lastResult: 'PASSED' })
    // Never passed, due within the window: soon; never passed and past due (a machine type's "before starting"): overdue.
    expect(cell(P.bruno, C.high)).toMatchObject({ state: 'NEEDED', overdue: false, soon: true, dueOn: '2026-12-20', record: null, lastResult: null })
    expect(cell(P.carla, C.general)).toMatchObject({ state: 'NEEDED', overdue: true, required: false })
    // A lapsed record nobody needs: shown in "all", counted in no tile.
    expect(cell(P.carla, C.fire)).toMatchObject({ state: 'EXPIRED', needed: false, overdue: false, soon: false })
  })

  it('tiles count person × course, and the lenses pick the rows', () => {
    expect(countDue(cells)).toEqual({ overdue: 2, dueSoon: 2, languageNotChecked: 1 })
    expect(cells.filter((row) => inView(row, 'due')).length).toBe(4)
    expect(cells.filter((row) => inView(row, 'all')).length).toBe(6)
    expect(cells.filter((row) => inView(row, 'language')).map((row) => row.courseId)).toEqual([C.high])
  })
})

describe('expired training holds a machine authorisation (B-W2b-39 finding, kind AUTHORISATION, STRICT)', () => {
  const press = (courses: CourseNeed[]): MachineNeed => ({
    machineClassId: 'class-press',
    code: 'CLICKING_PRESS',
    label: 'Clicking press',
    assetNumbers: ['CP-01'],
    kept: true,
    authorisation: { authorisationId: 'auth-1', authorisedOn: '2026-09-01', validUntil: null },
    skills: [],
    courses,
  })
  const course = (fields: Partial<CourseNeed>): CourseNeed => ({ courseId: C.high, code: 'SPEC-HIGH', name: 'Specific training, high risk', withinDays: null, met: true, validUntil: '2027-01-01', everPassed: true, ...fields })
  const facts = (machines: MachineNeed[], mode: QualificationFacts['mode'] = 'FREE'): QualificationFacts => ({ today, mode, person: { name: 'Made-up Person', active: true, hasRecord: true }, operation: null, machines })

  it('a course held today lets the authorisation work', () => {
    expect(qualificationOf(facts([press([course({})])]))).toMatchObject({ outcome: 'QUALIFIED', decision: 'ALLOW', findings: [] })
  })

  it('a lapsed course holds it whatever the site rule, and no team leader overrides it', () => {
    const result = qualificationOf(facts([press([course({ met: false, validUntil: '2026-10-01' })])]))
    expect(result).toMatchObject({ outcome: 'NOT_QUALIFIED', decision: 'HOLD', overridable: false })
    expect(result.findings).toMatchObject([{ code: 'TRAINING_EXPIRED', kind: 'AUTHORISATION', mode: 'STRICT', overridable: false, requirement: 'CLICKING_PRESS' }])
    expect(result.findings[0]!.message).toMatch(/expired on 2026-10-01: the authorisation is held/)
  })

  it('a course never passed holds it once due; within its days it is only listed as due', () => {
    const missing = qualificationOf(facts([press([course({ met: false, validUntil: null, everPassed: false })])]))
    expect(missing.findings.map((finding) => finding.code)).toEqual(['TRAINING_MISSING'])
    expect(missing.findings[0]!.message).toMatch(/before starting/)
    const late = qualificationOf(facts([press([course({ met: false, validUntil: null, everPassed: false, withinDays: 30 })])]))
    expect(late.findings.map((finding) => finding.code)).toEqual(['TRAINING_MISSING'])
    expect(late.findings[0]!.message).toMatch(/within 30 days of the authorisation \(by 2026-10-01\)/)
    const within = qualificationOf(facts([press([course({ met: false, validUntil: null, everPassed: false, withinDays: 90 })])]))
    expect(within).toMatchObject({ decision: 'ALLOW', findings: [] })
    expect(within.requirements.filter((requirement) => requirement.kind === 'AUTHORISATION' || requirement.kind === 'TRAINING')).toMatchObject([{ kind: 'AUTHORISATION', state: 'AUTHORISED' }, { kind: 'TRAINING', state: 'DUE', dueOn: '2026-11-30' }])
  })

  it('a class that asks no authorisation, or an authorisation not in force, asks no course here', () => {
    expect(qualificationOf(facts([{ ...press([course({ met: false })]), kept: false }])).findings).toEqual([])
    const notYet = qualificationOf(facts([{ ...press([course({ met: false })]), authorisation: { authorisationId: 'a', authorisedOn: '2026-12-01', validUntil: null } }]))
    expect(notYet.findings.map((finding) => finding.code)).toEqual(['AUTHORISATION_NOT_YET'])
  })

  it('the matrix marks the same authorisations Held (needs not met: before starting, or past their days)', () => {
    const needs = [need(P.anna, C.high, '2026-09-01', 'MACHINE_CLASS', null), need(P.bruno, C.high, '2026-12-01', 'MACHINE_CLASS', 30), need(P.carla, C.high, '2026-10-01', 'MACHINE_CLASS', 30)]
    const held = heldByTrainingOf(needs, new Set(['class-press']))
    expect([...held.keys()].sort()).toEqual([`${P.anna}|class-press`, `${P.carla}|class-press`])
    expect(heldByTrainingOf(needs, new Set()).size).toBe(0)
  })
})

describe('what is wrong with a session, a record, an entry (400s at the field)', () => {
  it('a session: hours above 0 and at most 24, the language in two letters, a trainer', () => {
    expect(sessionProblems({ heldOn: today, hours: '4', language: 'it', trainerName: null, trainerEmployeeId: 'e-1', location: null, note: null })).toEqual([])
    expect(sessionProblems({ heldOn: today, hours: '25', language: 'italiano', trainerName: ' ', trainerEmployeeId: null, location: null, note: null }).map((problem) => problem.path)).toEqual(['hours', 'language', 'trainerName'])
  })

  it('a record keeps the refresher period’s day unless a reason says why not; a training not passed is valid for nothing', () => {
    const draft = { completedOn: '2026-10-01', hours: '8', trainerName: 'Made-up Provider', language: 'it', result: 'PASSED' as const, validUntil: undefined, validUntilReason: undefined, note: null }
    expect(recordProblems(draft, 60, today)).toEqual([])
    expect(validUntilOf(draft, 60)).toBe('2031-10-01')
    expect(recordProblems({ ...draft, validUntil: '2028-10-01' }, 60, today).map((problem) => problem.path)).toEqual(['validUntilReason'])
    expect(recordProblems({ ...draft, validUntil: '2028-10-01', validUntilReason: 'The provider’s certificate says so' }, 60, today)).toEqual([])
    expect(recordProblems({ ...draft, validUntilReason: 'no reason needed' }, 60, today).map((problem) => problem.path)).toEqual(['validUntilReason'])
    expect(recordProblems({ ...draft, result: 'FAILED', validUntil: '2028-10-01' }, 60, today).map((problem) => problem.path)).toEqual(['validUntil'])
    expect(recordProblems({ ...draft, completedOn: '2026-11-06' }, 60, today).map((problem) => problem.path)).toEqual(['completedOn'])
    expect(validUntilOf({ ...draft, result: 'FAILED' }, 60)).toBeNull()
    // A VOID correction may carry 0 hours.
    expect(recordProblems({ ...draft, result: 'VOID', hours: '0' }, 60, today)).toEqual([])
  })

  it('an instruction entry: a task, 1 to 1440 minutes, an instructor who is not the person instructed', () => {
    const entry = { instructedOn: today, task: 'Change the press die safely', minutes: 30, language: 'it', instructorName: null, instructorEmployeeId: 'e-lead', note: null }
    expect(instructionProblems(entry, 'e-1', today)).toEqual([])
    expect(instructionProblems({ ...entry, minutes: 0, instructorEmployeeId: 'e-1', task: ' ' }, 'e-1', today).map((problem) => problem.path)).toEqual(['task', 'minutes', 'instructorEmployeeId'])
  })
})

describe('closing a session (QHS-248, QHS-247)', () => {
  const attendance = (id: string, fields: Partial<{ countersigned: boolean; voided: boolean; languageUnderstood: boolean | null }> = {}) => ({ id, employeeId: `p-${id}`, countersigned: true, voided: false, languageUnderstood: true, ...fields })

  it('one record per countersigned attendance not voided; a language not understood is never passed (art. 37 c.13)', () => {
    const plan = closePlan([attendance('a'), attendance('b', { languageUnderstood: false }), attendance('c', { voided: true, countersigned: false })], [{ attendanceId: 'a', result: 'FAILED', note: 'Left after an hour' }])
    expect(plan).toMatchObject({ ok: true, records: [{ attendanceId: 'a', result: 'FAILED', note: 'Left after an hour', languageChecked: true }, { attendanceId: 'b', result: 'FAILED', languageChecked: true }] })
    expect(plan.ok && plan.records[1]!.note).toMatch(/art\. 37 c\.13/)
  })

  it('refused while an attendance waits for its countersignature, with nobody, for a stranger, or PASSED against the trainer’s check', () => {
    expect(closePlan([attendance('a'), attendance('b', { countersigned: false, languageUnderstood: null })], [])).toEqual({ ok: false, refusal: 'NOT_COUNTERSIGNED', attendanceIds: ['b'] })
    expect(closePlan([attendance('a', { voided: true })], [])).toEqual({ ok: false, refusal: 'NO_ATTENDANCE', attendanceIds: [] })
    expect(closePlan([attendance('a')], [{ attendanceId: 'x', result: 'PASSED', note: null }])).toEqual({ ok: false, refusal: 'NOT_OF_SESSION', attendanceIds: ['x'] })
    expect(closePlan([attendance('a', { languageUnderstood: false })], [{ attendanceId: 'a', result: 'PASSED', note: null }])).toEqual({ ok: false, refusal: 'LANGUAGE_NOT_UNDERSTOOD', attendanceIds: ['a'] })
  })

  it('the words signed on the floor are fixed by the session, the person, the tablet and the moment; signing stops with the reason', () => {
    const signed = { language: 'it' as const, sessionId: 's-1', courseCode: 'GEN', heldOn: today, hours: '4.00', sessionLanguage: 'it', trainerName: ' Made-up Trainer ', employeeId: 'e-1', workerId: 'w-1', deviceId: 'd-1', signedAt: '2026-11-05T09:00:00.000Z' }
    const text = signedAttendanceText(signed)
    expect(text).toBe(signedAttendanceText({ ...signed, hours: '4' }))
    expect(text).toMatch(/^Ho partecipato a questa sessione/)
    expect(text).toMatch(/\ntrainer Made-up Trainer\n/)
    expect(signedAttendanceText({ ...signed, workerId: 'w-2' })).not.toBe(text)
    expect(stoppedWords('OPEN', null)).toBeNull()
    expect(stoppedWords('CANCELLED', 'The trainer is ill')).toBe('This session was cancelled: The trainer is ill. Signing has stopped.')
  })
})

describe('the documents (new tabs "Certificate (PDF)", "Training due list (PDF)")', () => {
  const company: CompanyLegal = {
    legalName: 'Fabbrica Esempio S.r.l.',
    address: { line1: 'Via Esempio 1', postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT' },
    vatNumber: 'IT12345670009',
    fiscalCode: '12345670009',
    reaOffice: 'MI',
    reaNumber: '0000001',
    shareCapital: null,
    currency: 'EUR',
  }
  const base = { id: 'r-1', completedOn: '2026-10-01', hours: '8', trainerName: 'Made-up Provider', result: 'PASSED' as const, validUntil: '2031-10-01', validUntilReason: null, language: 'it', languageChecked: true, corrects: false, correctionReason: null, corrected: false, createdAt: '2026-10-01T10:00:00.000Z' }

  it('a record as the register keeps it: the law, the language check, how it was signed; a VOID one says so', () => {
    const doc = trainingRecordDocument({ language: 'en', company, person: { name: 'Made-up Person', code: 'E-001' }, course: { code: 'GEN', name: 'General training', legalBasis: 'D.Lgs. 81/2008 art. 37 c.1 a' }, record: base, attendance: { method: 'FLOOR_PIN', countersignMethod: 'FLOOR_PIN', heldOn: '2026-10-01', location: 'Room 1' } })
    expect(doc.banner).toBeNull()
    expect(doc.facts).toEqual(expect.arrayContaining([{ label: 'Understanding of the language checked', value: 'yes' }, { label: 'Attendance signed', value: 'on the tablet with badge and PIN, countersigned by the trainer' }]))
    expect(doc.notices[0]).toMatch(/art\. 37.*art\. 37 c\.13/)
    const voided = trainingRecordDocument({ language: 'it', company, person: { name: 'Made-up Person', code: null }, course: { code: 'GEN', name: 'Formazione generale', legalBasis: 'art. 37' }, record: { ...base, result: 'VOID', validUntil: null }, attendance: null })
    expect(voided.banner).toMatch(/ANNULLATA/)
  })

  it('the due list as the page filtered it, with an empty line when nothing is due', () => {
    const doc = dueListDocument({ language: 'en', company, on: today, view: 'due', scope: 'A1', rows: [{ person: 'Made-up Person', course: 'General training', state: 'EXPIRED', overdue: true, dueOn: '2025-01-10', why: 'ROLE', languageChecked: true }] })
    expect(doc.table.rows).toEqual([['Made-up Person', 'General training', 'Expired (overdue)', expect.any(String), 'Role', 'yes']])
    expect(dueListDocument({ language: 'it', company, on: today, view: 'all', scope: 'A1', rows: [] }).table.rows[0]![1]).toBe('Nessuna formazione in questa vista.')
  })
})

describe('permissions and events', () => {
  it('two writes, declared; the safety officer and HR keep the records, the preposti the instruction register too; read_only none', () => {
    for (const name of [SAFETY_TRAINING_RECORD, SAFETY_INSTRUCTION_RECORD]) expect(FACTORY_PERMISSIONS.get(name)?.risk).toBe('write')
    const holds = (key: string) => ROLE_TEMPLATES.find((template) => template.key === key)?.permissions ?? []
    expect(holds('safety_officer')).toEqual(expect.arrayContaining([SAFETY_TRAINING_RECORD, SAFETY_INSTRUCTION_RECORD]))
    expect(holds('hr')).toEqual(expect.arrayContaining([SAFETY_TRAINING_RECORD, SAFETY_INSTRUCTION_RECORD]))
    expect(holds('floor_supervisor')).toContain(SAFETY_INSTRUCTION_RECORD)
    expect(holds('floor_supervisor')).not.toContain(SAFETY_TRAINING_RECORD)
    expect(holds('read_only')).not.toContain(SAFETY_TRAINING_RECORD)
  })

  it('the four events carry ids, counts and states, never a name; the session and attendance ones reach the site’s tablets', () => {
    const types = ['training_session.changed', 'training_attendance.changed', 'training.recorded', 'instruction.changed']
    const found = EVENT_DEFINITIONS.filter((definition) => types.includes(definition.type))
    expect(found.map((definition) => definition.type).sort()).toEqual([...types].sort())
    for (const definition of found) expect(JSON.stringify(definition.live)).not.toMatch(/name|reason/i)
    expect(found.filter((definition) => (definition.live as { floor?: string }).floor === 'floor.work').map((definition) => definition.type).sort()).toEqual(['training_attendance.changed', 'training_session.changed'])
  })
})
