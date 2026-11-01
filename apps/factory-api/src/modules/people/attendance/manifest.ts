import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * Attendance days (B-W2b-37; MES-225, MES-226, MES-228, MES-233, MES-238; design people.attendance SCR-157, people.settings
 * "Rounding, tolerance and grace" and "Absence codes"), office only, checked per record with can() against the person's,
 * the day's or the site's company and site (`record`). The reads need people.attendance.view; the writes are listed with
 * the permission they need (manage, approve, settings, rollcall). Who is in now is read with people.attendance.view or the
 * roll call's permission (SIGNED_IN: the handler asks either over the site). Every read and write of a person's attendance
 * asks the site's ATTENDANCE legal gate first (B-W2b-27; Statuto dei Lavoratori art. 4 c.2); codes and settings are not a
 * person's data.
 */
export const manifest = defineManifest({
  'GET /people/attendance/days': { audiences: ['office'], permission: 'people.attendance.view', scope: 'record' },
  'GET /people/attendance/counts': { audiences: ['office'], permission: 'people.attendance.view', scope: 'record' },
  'GET /people/attendance/days/:dayId': { audiences: ['office'], permission: 'people.attendance.view', scope: 'record' },
  'GET /people/employees/:employeeId/attendance': { audiences: ['office'], permission: 'people.attendance.view', scope: 'record' },
  'POST /people/attendance/entries': { audiences: ['office'], permission: 'people.attendance.manage', scope: 'record' },
  'POST /people/attendance/days/:dayId/fix': { audiences: ['office'], permission: 'people.attendance.manage', scope: 'record' },
  'POST /people/attendance/days/:dayId/absence': { audiences: ['office'], permission: 'people.attendance.manage', scope: 'record' },
  'POST /people/attendance/days/:dayId/approve': { audiences: ['office'], permission: 'people.attendance.approve', scope: 'record' },
  'POST /people/attendance/days/approve': { audiences: ['office'], permission: 'people.attendance.approve', scope: 'record' },
  'POST /people/attendance/days/:dayId/reopen': { audiences: ['office'], permission: 'people.attendance.manage', scope: 'record' },
  'POST /people/attendance/anomalies/:anomalyId/accept': { audiences: ['office'], permission: 'people.attendance.manage', scope: 'record' },
  'GET /people/attendance/absence-codes': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  'POST /people/attendance/absence-codes': { audiences: ['office'], permission: 'people.attendance.settings', scope: 'record' },
  'PATCH /people/attendance/absence-codes/:codeId': { audiences: ['office'], permission: 'people.attendance.settings', scope: 'record' },
  'POST /people/attendance/absence-codes/:codeId/archive': { audiences: ['office'], permission: 'people.attendance.settings', scope: 'record' },
  'POST /people/attendance/absence-codes/:codeId/restore': { audiences: ['office'], permission: 'people.attendance.settings', scope: 'record' },
  'POST /people/attendance/absence-codes/standard': { audiences: ['office'], permission: 'people.attendance.settings', scope: 'record' },
  'GET /people/attendance/settings': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  'PUT /people/attendance/settings': { audiences: ['office'], permission: 'people.attendance.settings', scope: 'record' },
  'GET /people/attendance/who-is-in': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  'POST /people/attendance/roll-call': { audiences: ['office'], permission: 'people.attendance.rollcall', scope: 'record' },
})
