import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The month close (B-W2b-48; apps/factory-api modules/people/close; MES-231; design people.attendance "Month close", "Correct
 * a closed day", new tab "LUL calendar"), in the people area. Reading the checklist, the corrections and the attendance
 * report stays B-W2b-33's people.attendance.view, behind the ATTENDANCE legal gate of the sites (Statuto dei Lavoratori art.
 * 4 c.2).
 *
 *   people.attendance.close     close a company's month for good (a typed phrase) and seal its LUL attendance calendar
 *   people.attendance.correct   correct a closed day: a new entry with its reason, never over the closed figure, never on
 *                               your own day
 *   people.attendance.lul       open the LUL calendar of a closed month: everyone's name and hours, day by day. Every opening
 *                               is recorded, so read_only never holds it
 */
export const PEOPLE_CLOSE_DEFINITIONS = definePermissions('people', {
  'attendance.close': {
    risk: 'write',
    description: "Close a company's attendance month for good (with a typed phrase) once its days are approved, and seal its LUL attendance calendar.",
  },
  'attendance.correct': {
    risk: 'write',
    description: 'Correct a day of a closed month: a new entry with its reason, for the payroll correction export. Never on your own day.',
  },
  'attendance.lul': {
    risk: 'write',
    description: "Open the LUL attendance calendar of a closed month (everyone's name and hours, day by day), for the labour consultant. Every opening is recorded.",
  },
})

export const PEOPLE_ATTENDANCE_CLOSE = 'people.attendance.close' satisfies Permission
export const PEOPLE_ATTENDANCE_CORRECT = 'people.attendance.correct' satisfies Permission
export const PEOPLE_ATTENDANCE_LUL = 'people.attendance.lul' satisfies Permission

export const PEOPLE_CLOSE_PERMISSIONS: readonly Permission[] = Object.freeze([PEOPLE_ATTENDANCE_CLOSE, PEOPLE_ATTENDANCE_CORRECT, PEOPLE_ATTENDANCE_LUL])
