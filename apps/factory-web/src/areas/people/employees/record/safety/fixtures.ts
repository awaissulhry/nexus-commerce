import { createElement } from 'react'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { PREFIX } from '../../../_shared/fixtures'
import { inShellAs, TRAINING_ROLES, type TrainingRole } from '../../../skills/fixtures'
import type { JudgementRow, PersonRoleSheet, PpeCard } from './api'
import { safetyCan, type FitnessState } from './model'
import { EmployeeSafetyView, type EmployeeSafetyModel } from './view/EmployeeSafetyView'

/**
 * SCR-085-safety — Employee › Safety (B-W2b-146; design people.employees rec:Employee tab "Safety"), made-up data only: the
 * role risk sheet, PPE issued with the receipts and the missing kit, the fitness judgement behind ProtectedValue (hidden,
 * opening, shown with the next visit, restricted), incidents (not served by the API yet), and the roles the design names.
 */

const uid = (block: string, n: number) => `0190f0e4-${block}-7000-8000-${String(n).padStart(12, '0')}`
const EMPLOYEE = uid('6001', 1)

const ROLE: PersonRoleSheet = {
  employee: { id: EMPLOYEE, name: 'Paolo Prova', siteId: uid('6002', 1), jobRole: 'Tagliatore', status: 'ACTIVE', version: 4 },
  roleSheet: { id: uid('6003', 1), code: 'TAGLIO-DEMO', name: 'Tagliatore', status: 'ACTIVE' },
  since: '2026-03-02',
  asks: {
    risks: ['Taglio con lama', 'Movimentazione carichi', 'Rumore'],
    courses: [
      { courseId: uid('6004', 1), course: { code: 'GEN-DEMO', name: 'Formazione generale (esempio)', type: 'GENERAL' }, withinDays: null, held: true },
      { courseId: uid('6004', 2), course: { code: 'SPEC-ALTO-DEMO', name: 'Specifica rischio alto (esempio)', type: 'SPECIFIC_HIGH' }, withinDays: 60, held: false },
    ],
    kit: [
      { ppeItemId: uid('6005', 1), item: { code: 'GUANTI-DEMO', name: 'Guanti antitaglio', category: 'CATEGORY_II' }, quantity: 2, held: 2, whenToWear: 'Al taglio' },
      { ppeItemId: uid('6005', 2), item: { code: 'CUFFIE-DEMO', name: 'Cuffie antirumore', category: 'CATEGORY_III' }, quantity: 1, held: 0, whenToWear: 'Alla pressa' },
    ],
    visits: { shown: true, needed: true, frequencyMonths: 12, needs: ['NOISE'] },
  },
  law: { roleSheet: 'D.Lgs. 81/2008 artt. 28-29', kit: 'D.Lgs. 81/2008 art. 77', training: 'D.Lgs. 81/2008 art. 37', surveillance: 'D.Lgs. 81/2008 art. 41' },
  today: '2026-11-02',
}

const PPE: PpeCard = {
  employee: { id: EMPLOYEE, name: 'Paolo Prova', status: 'ACTIVE' },
  role: { id: uid('6003', 1), code: 'TAGLIO-DEMO', name: 'Tagliatore' },
  kit: [
    { ppeItemId: uid('6005', 1), item: { code: 'GUANTI-DEMO', name: 'Guanti antitaglio', nameI18n: { it: 'Guanti antitaglio', en: 'Cut-resistant gloves' }, category: 'CATEGORY_II' }, quantity: 2, held: 2, missing: 0, replace: 0, whenToWear: 'Al taglio' },
    { ppeItemId: uid('6005', 2), item: { code: 'CUFFIE-DEMO', name: 'Cuffie antirumore', nameI18n: { it: 'Cuffie antirumore', en: 'Ear defenders' }, category: 'CATEGORY_III' }, quantity: 1, held: 0, missing: 1, replace: 0, whenToWear: 'Alla pressa' },
  ],
  receipts: [
    { id: uid('6006', 1), issuedAt: '2026-09-15T08:30:00.000Z', method: 'FLOOR_PIN', state: 'SIGNED_PIN', scan: null, document: { fileId: uid('6007', 1) }, lines: [{ id: uid('6008', 1), issuedAt: '2026-09-15T08:30:00.000Z', item: { id: uid('6005', 1), code: 'GUANTI-DEMO', name: 'Guanti antitaglio', nameI18n: { it: 'Guanti antitaglio', en: 'Cut-resistant gloves' } }, size: '9', quantity: 2, voided: null }] },
    { id: uid('6006', 2), issuedAt: '2026-03-02T09:00:00.000Z', method: 'PAPER', state: 'NOT_SIGNED', scan: null, document: null, lines: [{ id: uid('6008', 2), issuedAt: '2026-03-02T09:00:00.000Z', item: { id: uid('6005', 3), code: 'SCARPE-DEMO', name: 'Scarpe antinfortunistiche', nameI18n: { it: 'Scarpe antinfortunistiche', en: 'Safety shoes' } }, size: '42', quantity: 1, voided: null }] },
  ],
  canIssue: true,
  today: '2026-11-02',
  law: { issue: 'D.Lgs. 81/2008 art. 77', receipt: 'D.Lgs. 81/2008 art. 77 c.4' },
}

const JUDGEMENT: JudgementRow = { id: uid('6009', 1), judgedOn: '2026-04-10', expiresOn: '2027-04-10', state: 'IN_FORCE', fromVisit: true, hasCopy: true, version: 1 }

interface SafetyCase {
  permissions: readonly string[]
  model: EmployeeSafetyModel
}

function tab(role: TrainingRole, over: Partial<EmployeeSafetyModel> = {}): SafetyCase {
  const permissions = TRAINING_ROLES[role]
  const can = safetyCan(permissions)
  const fitness: FitnessState = can.health ? { status: 'hidden', judgement: JUDGEMENT } : { status: 'restricted' }
  return {
    permissions,
    model: {
      can,
      employeeId: EMPLOYEE,
      roleSheet: can.roleSheet ? { status: 'ready', value: ROLE } : { status: 'restricted' },
      ppe: can.ppe ? { status: 'ready', value: PPE } : { status: 'restricted' },
      fitness,
      issueHref: null,
      riskHref: null,
      incidentsHref: `${PREFIX}/plant/incidents`,
      ...over,
    },
  }
}

function SafetyDesign({ model: value }: { model: SafetyCase }) {
  return inShellAs('/people/employees', createElement(EmployeeSafetyView, { model: value.model }), value.permissions)
}

const SHOWN: Extract<FitnessState, { status: 'shown' }> = { status: 'shown', judgement: { ...JUDGEMENT, outcome: 'FIT_WITH_LIMITS', taskLimits: 'Non sollevare oltre 15 kg', unfitUntil: null }, next: { id: uid('6010', 1), type: 'PERIODIC', dueOn: '2027-03-01', status: 'DUE', state: 'PLANNED', booked: null }, recordedAt: '2 nov 2026, 09:42' }

export const designScreen = defineDesignScreen<SafetyCase>({
  screen: 'SCR-085-safety',
  title: 'Employee › Safety',
  view: SafetyDesign,
  cases: [
    { id: 'hr', label: 'HR: role sheet, PPE with the missing kit, the fitness judgement hidden until Show', model: tab('hrSafety'), note: 'Show records the view on the API; the outcome and the next visit live in the tab alone. Issue PPE waits for Plant › PPE (held with why).' },
    { id: 'fitness-shown', label: 'Fitness shown: Fit with limits, the task limits, the next visit (the view recorded)', model: tab('hrSafety', { fitness: SHOWN }) },
    { id: 'fitness-unfit', label: 'Temporarily unfit until …', model: tab('hrSafety', { fitness: { ...SHOWN, judgement: { ...SHOWN.judgement, outcome: 'TEMPORARILY_UNFIT', taskLimits: null, unfitUntil: '2026-12-15' } } }) },
    { id: 'fitness-opening', label: 'Show pressed: reading (recorded)', model: tab('hrSafety', { fitness: { status: 'opening', judgement: JUDGEMENT } }) },
    { id: 'fitness-failed', label: 'Show failed: try again', model: tab('hrSafety', { fitness: { status: 'failed', judgement: JUDGEMENT } }) },
    { id: 'fitness-none', label: 'No judgement on record', model: tab('hrSafety', { fitness: { status: 'none' } }) },
    { id: 'issue-ready', label: 'Issue PPE once Plant › PPE is built (opens its dialog for this person)', model: tab('hrSafety', { issueHref: `${PREFIX}/plant/ppe?issue=${EMPLOYEE}`, riskHref: `${PREFIX}/plant/risk` }) },
    { id: 'no-role', label: 'No role sheet given', model: tab('hrSafety', { roleSheet: { status: 'ready', value: { ...ROLE, roleSheet: null, asks: null } } }) },
    { id: 'visits-hidden', label: 'A reader who may not know the visit need: nothing about visits', model: tab('production', { roleSheet: { status: 'ready', value: { ...ROLE, asks: { ...ROLE.asks!, visits: { shown: false, needed: null, frequencyMonths: null, needs: [] } } } } }) },
    { id: 'ppe-none', label: 'No PPE issued', model: tab('hrSafety', { ppe: { status: 'ready', value: { ...PPE, receipts: [], kit: PPE.kit.map((line) => ({ ...line, held: 0, missing: line.quantity })) } } }) },
    { id: 'production', label: 'Production manager: role sheet and PPE; fitness restricted; incidents for safety and HR only', model: tab('production') },
    { id: 'read-only', label: 'Read-only: Issue PPE held', model: tab('readOnly', { ppe: { status: 'ready', value: { ...PPE, canIssue: false } } }) },
    { id: 'loading', label: 'Loading', model: tab('hrSafety', { roleSheet: { status: 'loading' }, ppe: { status: 'loading' }, fitness: { status: 'loading' } }) },
    { id: 'error', label: "Couldn't load (each section on its own)", model: tab('hrSafety', { roleSheet: { status: 'error', problem: 'problem.unavailable' }, ppe: { status: 'error', problem: 'problem.unavailable' }, fitness: { status: 'error', problem: 'problem.unavailable' } }) },
  ],
})
