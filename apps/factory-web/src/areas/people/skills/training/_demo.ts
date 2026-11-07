import type { Course, CourseRecord, CoursePreview, CourseRef, Courses, DueCellValue, InstructionEntry, InstructionList, PersonTraining, Requirements, RoleNeeds, ClassNeeds, ClassPreview, StandardList, TrainingRecord, TrainingSession, Attendance } from './api'
import { LAWS } from './constants'

/**
 * Made-up training data for the design cases of B-W2b-146 (no real company, person, course hours or law number): the
 * hours and periods are typed by a company from its own programme; the ones here are invented for the screens only.
 * Design-only: fixtures and tests import it.
 */

const uid = (block: string, n: number) => `0190f0e3-${block}-7000-8000-${String(n).padStart(12, '0')}`
export const DEMO_TODAY = '2026-11-02'
export const DEMO_COMPANY = { id: '0190f0e0-0001-7000-8000-000000000001', code: 'DEMO', name: 'Demo' }
const LAW = { training: LAWS.training, agreement: 'D.Lgs. 81/2008 art. 37 c.2; Accordo Stato-Regioni', machines: LAWS.machines }

const course = (n: number, code: string, type: Course['type'], it: string, en: string, hours: string, months: number | null, over: Partial<Course> = {}): Course => ({
  id: uid('5001', n),
  companyId: null,
  company: null,
  code,
  name: it,
  nameI18n: { it, en },
  type,
  hours,
  refresherMonths: months,
  refresherHours: null,
  inPersonRequired: false,
  provider: null,
  legalBasis: `D.Lgs. 81/2008 art. 37 c.1 ${type === 'GENERAL' ? 'a' : 'b'}; Accordo Stato-Regioni`,
  sortOrder: n,
  status: 'ACTIVE',
  version: 1,
  updatedAt: '2026-10-01T08:00:00.000Z',
  requiredBy: { roleSheets: 2, machineClasses: 0 },
  canManage: true,
  ...over,
})

export const DEMO_COURSES: Course[] = [
  course(1, 'GEN-DEMO', 'GENERAL', 'Formazione generale (esempio)', 'General training (example)', '4', null),
  course(2, 'SPEC-ALTO-DEMO', 'SPECIFIC_HIGH', 'Specifica rischio alto (esempio)', 'Specific training, high risk (example)', '12', 60, { requiredBy: { roleSheets: 1, machineClasses: 1 } }),
  course(3, 'PREPOSTO-DEMO', 'SUPERVISOR', 'Preposto (esempio)', 'Supervisor (example)', '8', 24, { inPersonRequired: true, refresherHours: '6', provider: 'Ente formativo Esempio', legalBasis: 'D.Lgs. 81/2008 art. 37 c.7; Accordo Stato-Regioni', requiredBy: { roleSheets: 1, machineClasses: 0 } }),
  course(4, 'ANTINC-DEMO', 'FIRE', 'Antincendio (esempio)', 'Fire safety (example)', '4', 60, { companyId: DEMO_COMPANY.id, company: { code: DEMO_COMPANY.code, name: DEMO_COMPANY.name }, legalBasis: 'D.Lgs. 81/2008 art. 37 c.9; art. 46', requiredBy: { roleSheets: 0, machineClasses: 0 } }),
]

export const ref = (entry: Course): CourseRef => ({ id: entry.id, code: entry.code, name: entry.name, nameI18n: entry.nameI18n, type: entry.type, hours: entry.hours, refresherMonths: entry.refresherMonths, status: entry.status, companyId: entry.companyId })
export const DEMO_COURSE_REFS: CourseRef[] = DEMO_COURSES.slice(0, 3).map(ref)

export const DEMO_CATALOGUE: Courses = { courses: DEMO_COURSES, complete: true, canAdd: true, canAddGroupWide: true, law: LAW, today: DEMO_TODAY }

export const DEMO_COURSE_RECORD: CourseRecord = {
  course: DEMO_COURSES[2]!,
  createdAt: '2026-01-10T08:00:00.000Z',
  askedBy: {
    roleSheets: [{ id: uid('5002', 1), code: 'CAPO-DEMO', name: 'Capo squadra', nameI18n: { it: 'Capo squadra', en: 'Team leader' }, companyId: DEMO_COMPANY.id, siteId: uid('5003', 1), site: { code: 'STAB-N', name: 'Stabilimento Nord' }, withinDays: 60 }],
    machineClasses: [],
  },
  people: { people: 3, met: 1, due: 1, overdue: 1 },
  law: LAW,
  today: DEMO_TODAY,
}

export const DEMO_PREVIEW: CoursePreview = {
  course: { ...DEMO_COURSES[2]!, refresherMonths: 36 },
  changes: [{ field: 'refresherMonths', from: 24, to: 36 }],
  refresher: {
    from: 24,
    to: 36,
    holders: 3,
    followPeriod: 2,
    wouldMove: 2,
    ownDate: 1,
    people: [
      { employeeId: uid('5004', 1), name: 'Giulia Esempio', completedOn: '2025-03-10', validUntil: '2027-03-10', withNewPeriod: '2028-03-10' },
      { employeeId: uid('5004', 2), name: 'Davide Modello', completedOn: '2025-06-02', validUntil: '2027-06-02', withNewPeriod: '2028-06-02' },
    ],
  },
  fingerprint: 'a'.repeat(64),
}

export const DEMO_STANDARD: StandardList = {
  courses: [
    { code: 'GEN', type: 'GENERAL', name: 'Formazione generale', nameI18n: { it: 'Formazione generale', en: 'General training' }, legalBasis: 'D.Lgs. 81/2008 art. 37 c.1 a; Accordo Stato-Regioni', codeTaken: false, existing: [] },
    { code: 'SPEC-BASSO', type: 'SPECIFIC_LOW', name: 'Specifica rischio basso', nameI18n: { it: 'Specifica rischio basso', en: 'Specific training, low risk' }, legalBasis: 'D.Lgs. 81/2008 art. 37 c.1 b; Accordo Stato-Regioni', codeTaken: false, existing: [] },
    { code: 'PREPOSTO', type: 'SUPERVISOR', name: 'Preposto', nameI18n: { it: 'Preposto', en: 'Supervisor' }, legalBasis: 'D.Lgs. 81/2008 art. 37 c.7; Accordo Stato-Regioni', codeTaken: true, existing: [{ id: DEMO_COURSES[2]!.id, code: 'PREPOSTO-DEMO', name: 'Preposto (esempio)', status: 'ACTIVE' }] },
    { code: 'PRIMO-SOCC', type: 'FIRST_AID', name: 'Primo soccorso', nameI18n: { it: 'Primo soccorso', en: 'First aid' }, legalBasis: 'D.Lgs. 81/2008 art. 37 c.9; art. 45', codeTaken: false, existing: [] },
  ],
  canAddGroupWide: true,
  law: LAW,
}

const counts = (people: number, met: number, due: number, overdue: number) => ({ people, met, due, overdue })
export const DEMO_REQUIREMENTS: Requirements = {
  roleSheets: [
    { id: uid('5002', 1), code: 'CAPO-DEMO', name: 'Capo squadra', nameI18n: { it: 'Capo squadra', en: 'Team leader' }, companyId: DEMO_COMPANY.id, siteId: uid('5003', 1), site: { code: 'STAB-N', name: 'Stabilimento Nord' }, people: 3, courses: [{ courseId: DEMO_COURSES[0]!.id, withinDays: null, note: null, ...counts(3, 3, 0, 0) }, { courseId: DEMO_COURSES[2]!.id, withinDays: 60, note: null, ...counts(3, 1, 1, 1) }] },
    { id: uid('5002', 2), code: 'TAGLIO-DEMO', name: 'Tagliatore', nameI18n: { it: 'Tagliatore', en: 'Cutter' }, companyId: DEMO_COMPANY.id, siteId: uid('5003', 1), site: { code: 'STAB-N', name: 'Stabilimento Nord' }, people: 4, courses: [{ courseId: DEMO_COURSES[0]!.id, withinDays: null, note: null, ...counts(4, 4, 0, 0) }, { courseId: DEMO_COURSES[1]!.id, withinDays: 60, note: null, ...counts(4, 2, 1, 1) }] },
  ],
  machineClasses: [{ id: uid('5005', 1), code: 'PRESSA-DEMO', label: { it: 'Pressa fustellatrice', en: 'Clicking press' }, icon: null, active: true, people: 2, courses: [{ courseId: DEMO_COURSES[1]!.id, withinDays: null, note: null, ...counts(2, 1, 0, 1) }] }],
  overall: { people: 7, met: 11, due: 2, overdue: 3, needs: 16 },
  courses: DEMO_COURSE_REFS,
  complete: true,
  canManageClasses: true,
  law: LAW,
  today: DEMO_TODAY,
}

const personNeed = (n: number, name: string, states: [string, 'MET' | 'DUE' | 'OVERDUE', string][]) => ({ employeeId: uid('5004', n), name, siteId: uid('5003', 1), since: '2026-03-02', courses: states.map(([courseId, state, dueOn]) => ({ courseId, state, dueOn })) })
export const DEMO_ROLE_NEEDS: RoleNeeds = {
  roleSheet: { ...DEMO_REQUIREMENTS.roleSheets[0]!, status: 'ACTIVE' },
  courses: DEMO_REQUIREMENTS.roleSheets[0]!.courses.map((line, index) => ({ ...line, id: uid('5006', index + 1) })),
  people: [
    personNeed(1, 'Giulia Esempio', [[DEMO_COURSES[0]!.id, 'MET', '2026-03-02'], [DEMO_COURSES[2]!.id, 'MET', '2026-05-01']]),
    personNeed(2, 'Davide Modello', [[DEMO_COURSES[0]!.id, 'MET', '2026-03-02'], [DEMO_COURSES[2]!.id, 'DUE', '2026-12-20']]),
    personNeed(3, 'Ion Campione', [[DEMO_COURSES[0]!.id, 'MET', '2026-03-02'], [DEMO_COURSES[2]!.id, 'OVERDUE', '2026-09-30']]),
  ],
  refs: DEMO_COURSE_REFS,
  law: LAW,
  today: DEMO_TODAY,
}

export const DEMO_CLASS_NEEDS: ClassNeeds = {
  machineClass: { id: uid('5005', 1), code: 'PRESSA-DEMO', label: { it: 'Pressa fustellatrice', en: 'Clicking press' }, icon: null, active: true },
  courses: [{ id: uid('5007', 1), version: 1, courseId: DEMO_COURSES[1]!.id, withinDays: null, note: null, ...counts(2, 1, 0, 1) }],
  people: [personNeed(1, 'Giulia Esempio', [[DEMO_COURSES[1]!.id, 'MET', '2026-02-16']]), personNeed(4, 'Paolo Prova', [[DEMO_COURSES[1]!.id, 'OVERDUE', '2026-10-20']])],
  sites: [{ id: uid('5003', 1), code: 'STAB-N', name: 'Stabilimento Nord' }],
  refs: DEMO_COURSE_REFS,
  canManage: true,
  law: LAW,
  today: DEMO_TODAY,
}

export const DEMO_CLASS_PREVIEW: ClassPreview = {
  machineClass: DEMO_CLASS_NEEDS.machineClass,
  changes: { added: [DEMO_COURSES[0]!.id], removed: [], changed: [], noted: [], nothing: false },
  impact: [{ kind: 'COURSE_NEEDED', courseId: DEMO_COURSES[0]!.id, people: 1, already: 1, names: [{ employeeId: uid('5004', 4), name: 'Paolo Prova' }], withinDays: null }],
  people: 2,
  refs: DEMO_COURSE_REFS,
  fingerprint: 'b'.repeat(64),
}

const entry = (n: number, over: Partial<InstructionEntry> = {}): InstructionEntry => ({
  id: uid('5008', n),
  companyId: DEMO_COMPANY.id,
  siteId: uid('5003', 1),
  site: { code: 'STAB-N', name: 'Stabilimento Nord' },
  employee: { id: uid('5004', 4), name: 'Paolo Prova', code: 'E-0004' },
  instructedOn: '2026-10-28',
  task: 'Uso sicuro della pressa: comandi a due mani',
  machineClass: { id: uid('5005', 1), code: 'PRESSA-DEMO', label: { it: 'Pressa fustellatrice', en: 'Clicking press' } },
  machine: { id: uid('5009', 1), assetNumber: 'PR-DEMO-01' },
  instructor: { employeeId: uid('5004', 1), name: 'Giulia Esempio' },
  minutes: 45,
  language: 'it',
  languageChecked: true,
  signed: { at: '2026-10-28T10:15:00.000Z', method: 'FLOOR_PIN', verifiable: true },
  voided: null,
  note: null,
  version: 2,
  canChange: true,
  ...over,
})

export const DEMO_ENTRIES: InstructionEntry[] = [
  entry(1),
  entry(2, { employee: { id: uid('5004', 3), name: 'Ion Campione', code: 'E-0003' }, instructedOn: '2026-10-30', task: 'Cambio lama in sicurezza', machineClass: null, machine: null, minutes: 30, language: 'ro', signed: null, version: 1 }),
  entry(3, { employee: { id: uid('5004', 2), name: 'Davide Modello', code: 'E-0002' }, instructedOn: '2026-10-12', task: 'Carico del rotolo', machineClass: null, machine: null, minutes: 20, signed: { at: '2026-10-12T09:00:00.000Z', method: 'PAPER', verifiable: false } }),
  entry(4, { instructedOn: '2026-09-01', voided: { at: '2026-09-02T08:00:00.000Z', reason: 'Registrata due volte', by: 'Anna Esempio' }, signed: null }),
]

export const DEMO_INSTRUCTION: InstructionList = { entries: DEMO_ENTRIES, complete: true, canAdd: true, law: { instruction: LAWS.instruction, language: LAWS.language }, today: DEMO_TODAY }

/** DueCells of the matrix's safety columns, per person (made-up). */
export const cell = (courseId: string, state: DueCellValue['state'], over: Partial<DueCellValue> = {}): DueCellValue => ({
  courseId,
  state,
  needed: state === 'NEEDED',
  required: true,
  dueOn: null,
  overdue: false,
  soon: state === 'DUE_SOON',
  neededBy: null,
  record: state === 'NEEDED' ? null : { id: uid('5010', courseId.length + state.length), completedOn: '2025-03-10', validUntil: state === 'EXPIRED' ? '2026-09-30' : state === 'DUE_SOON' ? '2026-12-10' : '2028-03-10', languageChecked: true },
  lastResult: state === 'NEEDED' ? null : 'PASSED',
  languageNotChecked: false,
  ...over,
})

export const DEMO_RECORD: TrainingRecord = {
  id: uid('5010', 1),
  employeeId: uid('5004', 2),
  companyId: DEMO_COMPANY.id,
  course: { ...DEMO_COURSE_REFS[2]!, legalBasis: DEMO_COURSES[2]!.legalBasis },
  completedOn: '2025-06-02',
  hours: '8',
  trainerName: 'Ente formativo Esempio',
  result: 'PASSED',
  validUntil: '2027-06-02',
  validUntilReason: null,
  validity: 'VALID',
  language: 'it',
  languageChecked: true,
  correctedBy: null,
  corrects: null,
  standing: true,
  session: null,
  signed: null,
  note: null,
  certificates: [{ id: uid('5011', 1), kind: 'CERTIFICATE', originalName: 'attestato-preposto-esempio.pdf', contentType: 'application/pdf', sizeBytes: 182_000 }],
  createdAt: '2025-06-03T08:00:00.000Z',
}

export const DEMO_PERSON_TRAINING: PersonTraining = {
  employee: { id: uid('5004', 2), name: 'Davide Modello', code: 'E-0002', companyId: DEMO_COMPANY.id, siteId: uid('5003', 1), language: 'it', status: 'ACTIVE', roleSheet: { id: uid('5002', 1), code: 'CAPO-DEMO', name: 'Capo squadra' } },
  cells: [cell(DEMO_COURSES[0]!.id, 'VALID', { record: { id: uid('5010', 2), completedOn: '2026-03-02', validUntil: null, languageChecked: true } }), cell(DEMO_COURSES[2]!.id, 'DUE_SOON', { record: { id: DEMO_RECORD.id, completedOn: '2025-06-02', validUntil: '2026-12-10', languageChecked: true } }), cell(DEMO_COURSES[1]!.id, 'NEEDED', { neededBy: '2026-12-20' })],
  counts: { overdue: 0, dueSoon: 1, languageNotChecked: 0 },
  records: [DEMO_RECORD, { ...DEMO_RECORD, id: uid('5010', 2), course: { ...DEMO_COURSE_REFS[0]!, legalBasis: DEMO_COURSES[0]!.legalBasis }, completedOn: '2026-03-02', hours: '4', trainerName: 'Giulia Esempio', validUntil: null, certificates: [], signed: { method: 'FLOOR_PIN', countersignMethod: 'FLOOR_PIN' }, session: { id: uid('5012', 1), heldOn: '2026-03-02', location: 'Sala riunioni' } }],
  instruction: [DEMO_ENTRIES[2]!],
  courses: DEMO_COURSE_REFS,
  canRecord: true,
  canInstruct: true,
  law: { training: LAWS.training, language: LAWS.language },
  today: DEMO_TODAY,
}

export const DEMO_SESSION: TrainingSession = {
  id: uid('5012', 2),
  companyId: DEMO_COMPANY.id,
  siteId: uid('5003', 1),
  site: { code: 'STAB-N', name: 'Stabilimento Nord' },
  course: { ...DEMO_COURSE_REFS[0]!, legalBasis: DEMO_COURSES[0]!.legalBasis },
  heldOn: '2026-10-30',
  hours: '4',
  language: 'it',
  trainer: { employeeId: uid('5004', 1), name: 'Giulia Esempio' },
  location: 'Sala riunioni',
  status: 'OPEN',
  version: 3,
  counts: { signed: 2, countersigned: 2, voided: 0 },
  canRecord: true,
}

const attendance = (n: number, name: string, over: Partial<Attendance> = {}): Attendance => ({ id: uid('5013', n), employee: { id: uid('5004', n + 10), name, code: null, language: 'it' }, method: 'FLOOR_PIN', signedAt: '2026-10-30T09:00:00.000Z', countersign: { at: '2026-10-30T12:00:00.000Z', method: 'FLOOR_PIN', byOffice: null, onFloor: true }, languageUnderstood: true, languageDiffers: false, voided: null, recordId: null, version: 2, ...over })
export const DEMO_ATTENDANCES: Attendance[] = [attendance(1, 'Sara Demo'), attendance(2, 'Chiara Copia', { languageUnderstood: false, languageDiffers: true })]

/** A one-page PDF that says it is made-up (built here so the design index needs no API; as Plant's preventive fixtures). */
export function demoPdf(title: string): Uint8Array {
  const text = `BT /F1 20 Tf 72 770 Td (${title}) Tj 0 -28 Td /F1 11 Tf (Made-up design data) Tj ET`
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${text.length} >>\nstream\n${text}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(body)
}
