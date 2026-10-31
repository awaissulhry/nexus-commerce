import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * People: the employee record and its reads (apps/factory-api modules/people/employees; B-W2b-26; MES-208, MES-209,
 * MES-211; design people.employees), in the people area. Each is checked with can() against the record's company and
 * site. What the record holds is what the work needs (GDPR art. 5(1)(c)); nothing here is a figure about one person's
 * work (Statuto dei Lavoratori art. 4): attendance, efficiency and pay are read through the legal gate of their site and
 * purpose (B-W2b-27), never with these.
 *
 *   people.view               the HR register: employees, teams, loans, leaver steps (owner, administrator, production
 *                             manager, floor supervisor; read-only through the registry)
 *   people.team.view          My team: the teams you lead or belong to (the office templates that work on records)
 *   people.employees.manage   add, change and link the records, import them from the payroll file (owner, administrator)
 */
export const PEOPLE_EMPLOYEES_DEFINITIONS = definePermissions('people', {
  view: {
    risk: 'read',
    description:
      "See the employees of the sites (name, employee code, type, agency, company, site, department, role, home line, team and lead, contract hours, dates, language and the state of their floor sign-in), the teams, the loans to other lines and the leaver steps. Never pay, attendance, health or a figure about one person's work.",
  },
  'team.view': {
    risk: 'read',
    description: 'See the teams you lead or belong to (My team): who is in them, their lead, and who is on loan to or from them today.',
  },
  'employees.manage': {
    risk: 'write',
    description:
      'Add employees (new, from a floor worker or from an office user: one record per person), change their identity, job and contract, link their floor sign-in and office account, keep agency and external workers with their agency and contract end, and import them from the payroll file with a dry run.',
  },
})

export const PEOPLE_VIEW = 'people.view' satisfies Permission
export const PEOPLE_TEAM_VIEW = 'people.team.view' satisfies Permission
export const PEOPLE_EMPLOYEES_MANAGE = 'people.employees.manage' satisfies Permission

export const PEOPLE_EMPLOYEES_PERMISSIONS: readonly Permission[] = Object.freeze([PEOPLE_VIEW, PEOPLE_TEAM_VIEW, PEOPLE_EMPLOYEES_MANAGE])
