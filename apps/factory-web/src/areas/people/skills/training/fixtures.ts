import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShellAs, page, trainingCase, TRAINING_ROLES, type SkillsCaseAs, type TrainingOver, type TrainingRole } from '../fixtures'
import { SkillsView } from '../view/SkillsView'
import { DEMO_ATTENDANCES, DEMO_CATALOGUE, DEMO_CLASS_NEEDS, DEMO_CLASS_PREVIEW, DEMO_COURSE_RECORD, DEMO_COURSES, DEMO_ENTRIES, DEMO_INSTRUCTION, DEMO_PREVIEW, DEMO_REQUIREMENTS, DEMO_ROLE_NEEDS, DEMO_SESSION, DEMO_STANDARD, DEMO_TODAY } from './_demo'
import { classLinesOf, courseDraftOf, emptyCourseDraft, emptyInstructionDraft, emptyRecordDraft, recordPerson, standardRowsOf } from './model'
import type { TrainingDialog } from './use-training'

/**
 * SCR-160-training — the training part of People › Skills & training (B-W2b-146; design people.skills sections "Course
 * catalogue", "Who needs what", "Instruction register", pop-ups "Course" and "Record training"), made-up data only: each
 * lens with its states, every pop-up and its refusals, and the roles the design names (the safety officer who keeps the
 * catalogue, HR who records, the production manager and the floor supervisor who keep the instruction register, read-only,
 * the occupational doctor, no right).
 */

const common = { busy: false, problem: null }
const lens = (role: TrainingRole, terms: string, training: TrainingOver = {}): SkillsCaseAs => trainingCase(role, {}, terms, training)
const withDialog = (role: TrainingRole, terms: string, dialog: TrainingDialog) => lens(role, terms, { dialog })

const course = DEMO_COURSES[2]!
const people = [
  { employeeId: '0190f0e2-4007-7000-8000-000000000002', name: 'Paolo Prova', companyId: DEMO_COURSES[3]!.companyId!, siteId: '0190f0e2-3101-7000-8000-000000000001' },
  { employeeId: '0190f0e2-4007-7000-8000-000000000003', name: 'Ion Campione', companyId: DEMO_COURSES[3]!.companyId!, siteId: '0190f0e2-3101-7000-8000-000000000001' },
]
const recordDraft = (over: Partial<ReturnType<typeof emptyRecordDraft>> = {}) => ({ ...emptyRecordDraft(DEMO_TODAY, people.map(recordPerson), course.id), hours: '8', trainerName: 'Ente formativo Esempio', completedOn: '2026-10-30', ...over })
const record = (over: Partial<Extract<TrainingDialog, { kind: 'record' }>> = {}): TrainingDialog => ({ kind: 'record', way: 'elsewhere', draft: recordDraft(), sessions: null, sessionId: null, session: null, results: {}, certificateFailed: 0, ...common, ...over })
const courseDialog = (over: Partial<Extract<TrainingDialog, { kind: 'course' }>> = {}): TrainingDialog => ({ kind: 'course', courseId: course.id, record: DEMO_COURSE_RECORD, loading: false, draft: courseDraftOf(course), preview: null, ...common, ...over })
const classDialog = (over: Partial<Extract<TrainingDialog, { kind: 'classCourses' }>> = {}): TrainingDialog => ({ kind: 'classCourses', classId: DEMO_CLASS_NEEDS.machineClass.id, needs: DEMO_CLASS_NEEDS, lines: classLinesOf(DEMO_CLASS_NEEDS.courses), preview: null, ...common, ...over })
const pdfFile = new File([new Uint8Array([37, 80, 68, 70])], 'attestato-esempio.pdf', { type: 'application/pdf' })

function TrainingDesign({ model }: { model: SkillsCaseAs }) {
  return inShellAs('/people/skills', createElement(SkillsView, { model: model.page }), model.permissions ?? TRAINING_ROLES.hrSafety)
}

export const designScreen = defineDesignScreen<SkillsCaseAs>({
  screen: 'SCR-160-training',
  title: 'Skills & training: courses, who needs what, instruction register, Record training',
  view: TrainingDesign,
  holdsPage: true,
  cases: [
    // ---- Course catalogue ----
    { id: 'courses', label: 'Safety officer: the course catalogue (hours and refresher as settings, the law)', model: lens('safety', 'view=courses'), note: 'The safety officer has no matrix (no people.skills.view): the page opens on the catalogue; the row opens the Course pop-up.' },
    { id: 'courses-hr', label: 'HR: the catalogue to read, Record training in the band', model: lens('hrSafety', 'view=courses') },
    { id: 'courses-archived', label: 'Archived and active courses (the status column appears)', model: lens('safety', 'view=courses&status=all', { courses: { status: 'ready', value: { ...DEMO_CATALOGUE, courses: [...DEMO_COURSES, { ...DEMO_COURSES[3]!, id: '0190f0e3-5001-7000-8000-000000000009', code: 'OLD-DEMO', status: 'ARCHIVED' }] } } }) },
    { id: 'courses-empty', label: 'No courses yet: Start from the standard list', model: lens('safety', 'view=courses', { courses: { status: 'ready', value: { ...DEMO_CATALOGUE, courses: [] } } }) },
    { id: 'courses-loading', label: 'Catalogue loading', model: lens('safety', 'view=courses', { courses: { status: 'loading' } }) },
    { id: 'courses-error', label: "The catalogue couldn't be read", model: lens('safety', 'view=courses', { courses: { status: 'error', problem: 'problem.unavailable' } }) },
    { id: 'course', label: 'Course pop-up: the fields, who asks it, people met / due / overdue', model: withDialog('safety', 'view=courses', courseDialog()) },
    { id: 'course-review', label: 'Course: refresher 24 → 36 months, "2 due dates would move" (records keep their dates)', model: withDialog('safety', 'view=courses', courseDialog({ draft: { ...courseDraftOf(course), refresherMonths: '36' }, preview: DEMO_PREVIEW })) },
    { id: 'course-changed', label: 'Course: changed meanwhile (IMPACT_CHANGED), back to the form', model: withDialog('safety', 'view=courses', courseDialog({ problem: { key: 'refusal.IMPACT_CHANGED' } })) },
    { id: 'course-new', label: 'Add a course (code, type, hours typed: the plan gives no number)', model: withDialog('safety', 'view=courses', { kind: 'course', courseId: null, record: null, loading: false, draft: { ...emptyCourseDraft('FORKLIFT'), code: 'CARRELLI', nameIt: 'Carrellisti', hours: '' }, preview: null, ...common }) },
    { id: 'course-taken', label: 'Add a course refused: the code is taken', model: withDialog('safety', 'view=courses', { kind: 'course', courseId: null, record: null, loading: false, draft: { ...emptyCourseDraft('FIRE'), code: 'ANTINC-DEMO', nameIt: 'Antincendio', hours: '4' }, preview: null, busy: false, problem: { key: 'refusal.CODE_TAKEN' } }) },
    { id: 'course-archive-held', label: 'Archive held: a role sheet asks this course', model: withDialog('safety', 'view=courses', courseDialog({ record: { ...DEMO_COURSE_RECORD, course: { ...course, requiredBy: { roleSheets: 1, machineClasses: 0 } } } })) },
    { id: 'course-archived', label: 'An archived course: Restore to edit', model: withDialog('safety', 'view=courses&status=all', courseDialog({ record: { ...DEMO_COURSE_RECORD, course: { ...course, status: 'ARCHIVED', requiredBy: { roleSheets: 0, machineClasses: 0 } } } })) },
    { id: 'course-read-only', label: 'Course pop-up for HR: every change held with why', model: withDialog('hrSafety', 'view=courses', courseDialog({ record: { ...DEMO_COURSE_RECORD, course: { ...course, canManage: false } } })) },
    { id: 'standard', label: 'Start from the standard list: types and the law, hours and refresher typed', model: withDialog('safety', 'view=courses', { kind: 'standard', list: DEMO_STANDARD, rows: standardRowsOf(DEMO_STANDARD.courses).map((row, index) => (index === 0 ? { ...row, hours: '4' } : row)), groupWide: true, ...common }) },
    // ---- Who needs what ----
    { id: 'needs', label: 'Who needs what: roles and machine types → courses · people · met / due / overdue', model: lens('safety', 'view=needs'), note: 'Counts only; names inside one role or machine type. Roles are edited in their role sheet (Plant › Risk assessment).' },
    { id: 'need-role', label: 'One role: its courses and its people by name with each due day', model: withDialog('safety', 'view=needs', { kind: 'need', ref: { kind: 'role', id: DEMO_ROLE_NEEDS.roleSheet.id }, role: DEMO_ROLE_NEEDS, machine: null, ...common }) },
    { id: 'need-class', label: 'One machine type: its people, Change courses', model: withDialog('safety', 'view=needs', { kind: 'need', ref: { kind: 'class', id: DEMO_CLASS_NEEDS.machineClass.id }, role: null, machine: DEMO_CLASS_NEEDS, ...common }) },
    { id: 'class-courses', label: "A machine type's courses: the lines", model: withDialog('safety', 'view=needs', classDialog({ lines: [...classLinesOf(DEMO_CLASS_NEEDS.courses), { courseId: DEMO_COURSES[0]!.id, withinDays: '30', note: '' }] })) },
    { id: 'class-review', label: 'What this changes: 1 person now needs a course (named)', model: withDialog('safety', 'view=needs', classDialog({ preview: DEMO_CLASS_PREVIEW })) },
    { id: 'class-refused', label: 'Refused: a company course on a machine type (the group only)', model: withDialog('safety', 'view=needs', classDialog({ problem: { key: 'refusal.COURSE_NOT_GROUP_WIDE' } })) },
    { id: 'needs-empty', label: 'No role sheet or machine type asks a course yet', model: lens('safety', 'view=needs', { requirements: { status: 'ready', value: { ...DEMO_REQUIREMENTS, roleSheets: [], machineClasses: [], overall: { people: 0, met: 0, due: 0, overdue: 0, needs: 0 } } } }) },
    { id: 'needs-error', label: "Who needs what couldn't be read", model: lens('safety', 'view=needs', { requirements: { status: 'error', problem: 'problem.unavailable' } }) },
    // ---- Instruction register ----
    { id: 'instruction', label: 'Production manager: the instruction register (signed on the floor with the PIN, paper, waiting, voided)', model: lens('production', 'view=instruction') },
    { id: 'instruction-unsigned', label: 'Waiting for the person to sign', model: lens('supervisor', 'view=instruction&entries=unsigned', { instruction: { status: 'ready', value: { ...DEMO_INSTRUCTION, entries: [DEMO_ENTRIES[1]!] } } }) },
    { id: 'instruction-empty', label: 'No instruction recorded', model: lens('production', 'view=instruction', { instruction: { status: 'ready', value: { ...DEMO_INSTRUCTION, entries: [] } } }) },
    { id: 'instruction-read-only', label: 'Read-only: the register, Add entry held', model: lens('readOnly', 'view=instruction', { instruction: { status: 'ready', value: { ...DEMO_INSTRUCTION, canAdd: false, entries: DEMO_ENTRIES.map((entry) => ({ ...entry, canChange: false })) } } }) },
    { id: 'instruction-error', label: "The register couldn't be read", model: lens('production', 'view=instruction', { instruction: { status: 'error', problem: 'problem.unavailable' } }) },
    { id: 'entry-add', label: 'Add entry: person, task or machine, instructor, minutes, language, signed on the floor', model: withDialog('production', 'view=instruction', { kind: 'instruction', draft: { ...emptyInstructionDraft(DEMO_TODAY, people[0]!.employeeId), task: 'Uso sicuro della pressa', machineClassId: DEMO_CLASS_NEEDS.machineClass.id, minutes: '45' }, ...common }) },
    { id: 'entry-refused', label: 'Add entry refused: the instructor is the person', model: withDialog('production', 'view=instruction', { kind: 'instruction', draft: { ...emptyInstructionDraft(DEMO_TODAY, people[0]!.employeeId), task: 'Carico del rotolo', minutes: '20', instructorName: 'Paolo Prova' }, busy: false, problem: { key: 'refusal.INSTRUCTOR_IS_PERSON' } }) },
    { id: 'entry', label: 'One entry waiting: Signed on paper, or Void with the reason', model: withDialog('production', 'view=instruction', { kind: 'voidEntry', entry: DEMO_ENTRIES[1]!, reason: '', ...common }) },
    // ---- Record training ----
    { id: 'record', label: 'Record training for 2: result and language understood per person, expiry from the refresher period, the certificate', model: withDialog('hrSafety', 'view=courses', record({ draft: recordDraft({ certificate: pdfFile }) })) },
    { id: 'record-other-until', label: 'Another valid-until than the period gives: the reason is asked', model: withDialog('hrSafety', 'view=courses', record({ draft: recordDraft({ people: people.map((person, index) => ({ ...recordPerson(person), validUntil: index === 0 ? '2027-06-30' : '' })) }) })) },
    { id: 'record-language', label: 'Language not understood: the warning (art. 37 c.13)', model: withDialog('hrSafety', 'view=courses', record({ draft: recordDraft({ people: people.map((person, index) => ({ ...recordPerson(person), languageChecked: index !== 1 })) }) })) },
    { id: 'record-empty', label: 'Record training from the band: nothing chosen yet', model: withDialog('safety', 'view=courses', record({ draft: emptyRecordDraft(DEMO_TODAY) })) },
    { id: 'record-refused', label: 'Record training refused: the course was archived meanwhile', model: withDialog('hrSafety', 'view=courses', record({ problem: { key: 'refusal.COURSE_NOT_AVAILABLE' } })) },
    { id: 'record-floor', label: 'From the floor sign-off: a session signed and countersigned, closed into records', model: withDialog('safety', 'view=courses', record({ way: 'session', sessions: [DEMO_SESSION], sessionId: DEMO_SESSION.id, session: { session: DEMO_SESSION, attendances: DEMO_ATTENDANCES }, results: Object.fromEntries(DEMO_ATTENDANCES.map((entry) => [entry.id, entry.languageUnderstood === false ? 'FAILED' : 'PASSED'])) })) },
    { id: 'record-floor-none', label: 'From the floor sign-off: no session open', model: withDialog('safety', 'view=courses', record({ way: 'session', sessions: [] })) },
    { id: 'record-held', label: 'Production manager: Record training held (no right)', model: withDialog('production', 'view=instruction', record()) },
    { id: 'done', label: 'Recorded: "2 training records added"', model: { ...lens('hrSafety', 'view=courses'), page: { ...lens('hrSafety', 'view=courses').page, notice: { tone: 'success', ns: 'training', key: 'done.recorded', params: { count: 2, failed: 0 } } } } },
    // ---- roles ----
    { id: 'doctor', label: 'Occupational doctor: the training lenses to read', model: lens('doctor', 'view=needs') },
    { id: 'no-right', label: 'Sales: no right (no navigation row either)', model: { ...page('sales'), permissions: [] } },
  ],
})
