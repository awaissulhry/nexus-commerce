import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * People: lines, teams and leads, loans to another line (apps/factory-api modules/people/teams; B-W2b-26; MES-210,
 * PLT-020; design people.employees "Teams view", "Loan to another line", "Change team"), in the people area. Each is
 * checked with can() against the team's (or the person's) company and site. The site › area › line tree is the site's
 * structure: read with sites.view, kept with sites.manage (Admin › Companies & sites).
 */
export const PEOPLE_TEAMS_DEFINITIONS = definePermissions('people', {
  'teams.manage': {
    risk: 'write',
    description: 'Add, change and archive the teams of a site (a line\'s crew, a group to assign and mention), set their lead and move people between teams (the history of who was in which team is kept).',
  },
  'loans.manage': {
    risk: 'write',
    description: 'Lend a person to another line of their site for some hours or days with the reason, end a loan early, and remove one that has not begun.',
  },
})

export const PEOPLE_TEAMS_MANAGE = 'people.teams.manage' satisfies Permission
export const PEOPLE_LOANS_MANAGE = 'people.loans.manage' satisfies Permission

export const PEOPLE_TEAMS_PERMISSIONS: readonly Permission[] = Object.freeze([PEOPLE_TEAMS_MANAGE, PEOPLE_LOANS_MANAGE])
