import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, PEOPLE_ROLES, type PeopleRole } from '../../_shared/fixtures'
import { EMPLOYEE_SKILLS, MATRIX, ROWS, SKILLS } from '../fixtures'
import { skillsCan } from '../model'
import { EmployeeSkillsView, type EmployeeSkillsModel } from './view/EmployeeSkillsView'

/** SCR-085-skills — the employee record's Skills & training tab, made-up data only (the sub-id follows SCR-148-print). */
interface TabCase {
  role: PeopleRole
  tab: EmployeeSkillsModel
}

function tab(role: PeopleRole, over: Partial<EmployeeSkillsModel> = {}): TabCase {
  return {
    role,
    tab: {
      can: skillsCan(PEOPLE_ROLES[role]),
      loaded: { status: 'ready', value: EMPLOYEE_SKILLS },
      notice: null,
      names: {},
      dialogs: { dialog: null, rows: ROWS, classes: MATRIX.machineClasses, skills: SKILLS, sites: MATRIX.sites, today: EMPLOYEE_SKILLS.today, signer: 'Anna Esempio', stepUp: { open: false, busy: false, sentence: '', problem: null } },
      ...over,
    },
  }
}

function TabDesign({ model }: { model: TabCase }) {
  return inShell('/people/employees', createElement(EmployeeSkillsView, { model: model.tab }), model.role)
}

export const designScreen = defineDesignScreen<TabCase>({
  screen: 'SCR-085-skills',
  title: 'Employee › Skills & training',
  view: TabDesign,
  holdsPage: true,
  cases: [
    { id: 'hr', label: 'Levels, a trainee, a machine, what ended', model: tab('hr'), note: 'Safety training and hands-on instruction join in W2b-2.' },
    { id: 'add', label: 'Add a skill', model: tab('hr', { dialogs: { ...tab('hr').tab.dialogs, dialog: { kind: 'level', person: { employeeId: ROWS[1]!.employeeId, name: ROWS[1]!.name, companyId: ROWS[1]!.companyId, siteId: ROWS[1]!.siteId }, skillId: null, skillLabel: null, level: null, until: '', version: null, hasTrainee: false, busy: false, problem: null } } }) },
    { id: 'read-only', label: 'Read-only: the right to set levels is missing', model: tab('readOnly', { loaded: { status: 'ready', value: { ...EMPLOYEE_SKILLS, canManage: false, canAuthorise: false } } }) },
    { id: 'left', label: 'Someone who left: nothing new', model: tab('hr', { loaded: { status: 'ready', value: { ...EMPLOYEE_SKILLS, employee: { ...EMPLOYEE_SKILLS.employee, status: 'LEFT' } } } }) },
    { id: 'empty', label: 'No skills recorded', model: tab('hr', { loaded: { status: 'ready', value: { ...EMPLOYEE_SKILLS, levels: [], authorisations: [], history: { levels: [], authorisations: [] } } } }) },
    { id: 'no-right', label: 'Without people.skills.view', model: tab('sales') },
    { id: 'loading', label: 'Loading', model: tab('hr', { loaded: { status: 'loading' } }) },
    { id: 'error', label: "Couldn't load", model: tab('hr', { loaded: { status: 'error', problem: 'problem.unavailable' } }) },
  ],
})
