import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * People › Shifts: the roster and planned overtime (apps/factory-api modules/people/shifts; B-W2b-32; MES-218, MES-222;
 * design people.shifts), in the people area. Each is checked with can() against the person's (or the request's) company
 * and site. The roster is planning (who is planned on which shift), not attendance: what a person actually did (clock
 * events, attendance days, absences, overtime worked) is read behind the site's ATTENDANCE legal gate (B-W2b-27), never
 * with these.
 *
 *   people.shifts.view       read the roster of the sites in reach and the overtime requests
 *   people.shifts.manage     plan the roster of every person in reach: set a shift, assign, copy last week, publish
 *   people.shifts.team       plan the roster of the people of the teams one leads (design: "Leads edit their team")
 *   people.overtime.manage   plan overtime: ask people, record an answer a person told, add or take people off, cancel
 *   people.overtime.approve  approve planned overtime the people agreed to (D.Lgs. 66/2003 art. 5: by agreement)
 */
export const PEOPLE_SHIFTS_DEFINITIONS = definePermissions('people', {
  'shifts.view': {
    risk: 'read',
    description: 'See the roster (who is planned on which shift, the default shift faint and the changes bold) and the planned overtime requests of the sites in reach, with the working-time warnings in words.',
  },
  'shifts.manage': {
    risk: 'write',
    description: 'Plan the roster of every person of the sites in reach: set or clear a shift, assign a shift to many people, copy last week, and publish the roster the workers read.',
  },
  'shifts.team': {
    risk: 'write',
    description: 'Plan the roster of the people of the teams you lead (set, assign, copy and publish their shifts); the rest of the roster stays read only.',
  },
  'overtime.manage': {
    risk: 'write',
    description: 'Plan overtime for a date and line: ask people (each answers on their tablet, or tells you and you record it), add or take people off, and cancel a request with the reason.',
  },
  'overtime.approve': {
    risk: 'write',
    description: 'Approve planned overtime that people agreed to; only the people who said yes work it (overtime is never automatic: D.Lgs. 66/2003 art. 5).',
  },
})

export const PEOPLE_SHIFTS_VIEW = 'people.shifts.view' satisfies Permission
export const PEOPLE_SHIFTS_MANAGE = 'people.shifts.manage' satisfies Permission
export const PEOPLE_SHIFTS_TEAM = 'people.shifts.team' satisfies Permission
export const PEOPLE_OVERTIME_MANAGE = 'people.overtime.manage' satisfies Permission
export const PEOPLE_OVERTIME_APPROVE = 'people.overtime.approve' satisfies Permission

export const PEOPLE_SHIFTS_PERMISSIONS: readonly Permission[] = Object.freeze([PEOPLE_SHIFTS_VIEW, PEOPLE_SHIFTS_MANAGE, PEOPLE_SHIFTS_TEAM, PEOPLE_OVERTIME_MANAGE, PEOPLE_OVERTIME_APPROVE])
