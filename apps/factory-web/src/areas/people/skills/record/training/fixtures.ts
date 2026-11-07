import { createElement } from 'react'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { PREFIX } from '../../../_shared/fixtures'
import { inShellAs, TRAINING_ROLES, type TrainingRole } from '../../fixtures'
import { DEMO_COURSES, DEMO_ENTRIES, DEMO_PERSON_TRAINING, DEMO_TODAY } from '../../training/_demo'
import { emptyInstructionDraft, emptyRecordDraft, recordPerson, trainingCan } from '../../training/model'
import type { TrainingDialog } from '../../training/use-training'
import { EmployeeTrainingView, type EmployeeTrainingModel } from './view/EmployeeTrainingView'

/**
 * SCR-085-training — Employee › Skills & training, the W2b-2 sections (B-W2b-146): Safety training (records, DueCells, the
 * Needed rows, the certificate in a new tab, the language check) and Hands-on instruction, made-up data only.
 */

interface TrainingCase {
  permissions: readonly string[]
  model: EmployeeTrainingModel
}

const person = { employeeId: DEMO_PERSON_TRAINING.employee.id, name: DEMO_PERSON_TRAINING.employee.name, companyId: DEMO_PERSON_TRAINING.employee.companyId, siteId: DEMO_PERSON_TRAINING.employee.siteId }

function model(role: TrainingRole, over: Partial<EmployeeTrainingModel> = {}, dialog: TrainingDialog | null = null): TrainingCase {
  const permissions = TRAINING_ROLES[role]
  const can = trainingCan(permissions)
  return {
    permissions,
    model: {
      allowed: can.view,
      loaded: { status: 'ready', value: DEMO_PERSON_TRAINING },
      prefix: PREFIX,
      notice: null,
      dialogs: { dialog, can, courses: DEMO_COURSES, people: [person], machineClasses: [], today: DEMO_TODAY, canAddGroupWide: false, riskHref: null, prefix: PREFIX },
      ...over,
    },
  }
}

function TrainingDesign({ model: value }: { model: TrainingCase }) {
  return inShellAs('/people/employees', createElement(EmployeeTrainingView, { model: value.model }), value.permissions)
}

export const designScreen = defineDesignScreen<TrainingCase>({
  screen: 'SCR-085-training',
  title: 'Employee › Skills & training: safety training and hands-on instruction',
  view: TrainingDesign,
  cases: [
    { id: 'hr', label: 'HR: courses done and due, a Needed row, the certificate, the instruction entries', model: model('hrSafety'), note: 'A record row opens its Certificate (PDF) in a new tab; a Needed row opens Record training for that course.' },
    { id: 'record', label: 'Record training for this person', model: model('hrSafety', {}, { kind: 'record', way: 'elsewhere', draft: { ...emptyRecordDraft(DEMO_TODAY, [recordPerson(person)], DEMO_COURSES[1]!.id), hours: '12' }, sessions: null, sessionId: null, session: null, results: {}, certificateFailed: 0, busy: false, problem: null }) },
    { id: 'entry', label: 'Add an instruction entry for this person', model: model('production', {}, { kind: 'instruction', draft: { ...emptyInstructionDraft(DEMO_TODAY, person.employeeId), task: 'Carico del rotolo' }, busy: false, problem: null }) },
    { id: 'done', label: 'Recorded, the certificate could not be added', model: model('hrSafety', { notice: { tone: 'warning', key: 'done.recordedNoCertificate', params: { count: 1, failed: 1 } } }) },
    { id: 'read-only', label: 'Read-only: Record training and Add entry held', model: model('readOnly', { loaded: { status: 'ready', value: { ...DEMO_PERSON_TRAINING, canRecord: false, canInstruct: false } } }) },
    { id: 'empty', label: 'No training recorded', model: model('hrSafety', { loaded: { status: 'ready', value: { ...DEMO_PERSON_TRAINING, records: [], cells: [], instruction: [], counts: { overdue: 0, dueSoon: 0, languageNotChecked: 0 } } } }) },
    { id: 'left', label: 'Someone who left: nothing new', model: model('hrSafety', { loaded: { status: 'ready', value: { ...DEMO_PERSON_TRAINING, employee: { ...DEMO_PERSON_TRAINING.employee, status: 'LEFT' }, instruction: [DEMO_ENTRIES[1]!] } } }) },
    { id: 'loading', label: 'Loading', model: model('hrSafety', { loaded: { status: 'loading' } }) },
    { id: 'error', label: "Couldn't load", model: model('hrSafety', { loaded: { status: 'error', problem: 'problem.unavailable' } }) },
    { id: 'no-right', label: 'Without safety.view (the administrator template)', model: { permissions: [], model: { ...model('hrSafety').model, allowed: false } } },
  ],
})
