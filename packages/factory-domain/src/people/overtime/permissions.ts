import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Overtime worked and timesheets (B-W2b-42; apps/factory-api modules/people/overtime; MES-229, MES-230; design
 * people.attendance "Overtime to approve"), in the people area. Reading stays B-W2b-33's people.attendance.view, behind the
 * site's ATTENDANCE legal gate (Statuto dei Lavoratori art. 4 c.2): a list never names, filters, groups or totals by person
 * (Owner answer W1). Planned overtime stays B-W2b-32's people.overtime.manage and .approve: nothing here is automatic.
 *
 *   people.overtime.review   approve or reject the overtime people worked, or take a decision back: it is paid only once
 *                            approved (never your own)
 *   people.timesheets.team   approve as the lead the timesheets of the people of the teams you lead: the days and their
 *                            state, not the hours, which the ATTENDANCE basis never opens to leads (B-W2b-27)
 *   people.timesheets.lead   approve as the lead any timesheet in reach (a team with no lead, or whose lead works on the
 *                            tablet only), and send one back
 *   people.timesheets.hr     prepare a month's timesheets, approve them after the lead (another person), send one back
 */
export const PEOPLE_OVERTIME_DEFINITIONS = definePermissions('people', {
  'overtime.review': {
    risk: 'write',
    description: 'Approve or reject the overtime people worked (it is paid only once approved), or take a decision back, with the working-time limits in words. Never your own.',
  },
  'timesheets.team': {
    risk: 'write',
    description: "Approve as the lead the timesheets of the people of the teams you lead: you confirm the days, the hours stay HR's. Never your own.",
  },
  'timesheets.lead': {
    risk: 'write',
    description: 'Approve as the lead any timesheet of the sites in reach (a team with no lead, or whose lead works on the tablet only), and send one back with the reason. Never your own.',
  },
  'timesheets.hr': {
    risk: 'write',
    description: "Prepare a month's timesheets, approve them after the lead (always another person), and send one back with the reason. Never your own.",
  },
})

export const PEOPLE_OVERTIME_REVIEW = 'people.overtime.review' satisfies Permission
export const PEOPLE_TIMESHEETS_TEAM = 'people.timesheets.team' satisfies Permission
export const PEOPLE_TIMESHEETS_LEAD = 'people.timesheets.lead' satisfies Permission
export const PEOPLE_TIMESHEETS_HR = 'people.timesheets.hr' satisfies Permission

export const PEOPLE_OVERTIME_PERMISSIONS: readonly Permission[] = Object.freeze([PEOPLE_OVERTIME_REVIEW, PEOPLE_TIMESHEETS_TEAM, PEOPLE_TIMESHEETS_LEAD, PEOPLE_TIMESHEETS_HR])
