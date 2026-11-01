import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Attendance days (B-W2b-37; apps/factory-api modules/people/attendance; MES-225, MES-226, MES-228, MES-233, MES-238;
 * design people.attendance, people.settings "Rounding, tolerance and grace" and "Absence codes"), in the people area.
 * Reading the days is B-W2b-33's `people.attendance.view` (the sites in reach). Every read and write of a person's
 * attendance goes through the site's ATTENDANCE legal gate (Statuto dei Lavoratori art. 4 c.2, B-W2b-27); a list never
 * names, filters, groups or totals by person (Owner answer W1): one person's day opens one record at a time.
 *
 *   people.attendance.manage    enter and fix a day by hand, always with a reason: a missing clock-in or clock-out, a
 *                               duplicate voided (kept, marked void), work outside the plant, an absence code; accept an
 *                               anomaly with a note; reopen an approved day
 *   people.attendance.approve   approve attendance days with no anomaly left (never your own: a person decides, D.Lgs.
 *                               152/1997 art. 1-bis)
 *   people.attendance.settings  keep the absence codes (with the labour consultant's LUL code) and how clock events
 *                               become hours (rounding, grace, overtime unit, automatic clock-out, fixed breaks)
 *   people.attendance.rollcall  open the roll call: the names of the people clocked in now at a site, for an evacuation
 *                               (D.Lgs. 81/2008 art. 43); every opening is recorded, so read_only never holds it
 */
export const PEOPLE_ATTENDANCE_DEFINITIONS = definePermissions('people', {
  'attendance.manage': {
    risk: 'write',
    description:
      "Enter and fix attendance days by hand, always with a reason (a missing clock-in or clock-out, a duplicate voided and kept, work outside the plant, an absence code), accept an anomaly with a note, reopen an approved day, where the site's attendance purpose is switched on.",
  },
  'attendance.approve': {
    risk: 'write',
    description: 'Approve attendance days that have no anomaly left (never your own day); one day at a time or the clean days in one go.',
  },
  'attendance.settings': {
    risk: 'write',
    description: "Keep the absence codes with the labour consultant's LUL code, and how clock events become hours: rounding, lateness grace, the overtime unit, the automatic clock-out and fixed breaks.",
  },
  'attendance.rollcall': {
    risk: 'write',
    description: 'Open the roll call of a site: the names of the people clocked in now, for an evacuation. Every opening is recorded.',
  },
})

export const PEOPLE_ATTENDANCE_MANAGE = 'people.attendance.manage' satisfies Permission
export const PEOPLE_ATTENDANCE_APPROVE = 'people.attendance.approve' satisfies Permission
export const PEOPLE_ATTENDANCE_SETTINGS = 'people.attendance.settings' satisfies Permission
export const PEOPLE_ATTENDANCE_ROLLCALL = 'people.attendance.rollcall' satisfies Permission

export const PEOPLE_ATTENDANCE_PERMISSIONS: readonly Permission[] = Object.freeze([PEOPLE_ATTENDANCE_MANAGE, PEOPLE_ATTENDANCE_APPROVE, PEOPLE_ATTENDANCE_SETTINGS, PEOPLE_ATTENDANCE_ROLLCALL])
