import { defineManifest } from '../../../core/manifest'

/**
 * The month close, the LUL calendar, corrections of a closed day (B-W2b-48; MES-231) and the attendance report (MES-303, MES-236;
 * `modules/people/reports/attendance`: the routes loader reads one folder level down, and `modules/people/reports` is shared with
 * the earnings report, so its routes are declared here). Office only, checked per record with can() against the company and
 * its sites (`record`); a close and its counts are the whole company's, so the caller reaches every site of it. Every read
 * and write of a person's data asks the ATTENDANCE legal gate first (B-W2b-27; Statuto dei Lavoratori art. 4 c.2).
 */
export const manifest = defineManifest({
  'GET /people/month-close': { audiences: ['office'], permission: 'people.attendance.view', scope: 'record' },
  'GET /people/month-close/months': { audiences: ['office'], permission: 'people.attendance.view', scope: 'record' },
  'POST /people/month-close': { audiences: ['office'], permission: 'people.attendance.close', scope: 'record' },
  'POST /people/month-close/:closeId/seal': { audiences: ['office'], permission: 'people.attendance.close', scope: 'record' },
  'POST /people/month-close/:closeId/lul/open': { audiences: ['office'], permission: 'people.attendance.lul', scope: 'record' },
  'GET /people/month-close/:closeId/corrections': { audiences: ['office'], permission: 'people.attendance.view', scope: 'record' },
  'GET /people/attendance/days/:dayId/corrections': { audiences: ['office'], permission: 'people.attendance.view', scope: 'record' },
  'POST /people/attendance/days/:dayId/corrections': { audiences: ['office'], permission: 'people.attendance.correct', scope: 'record' },
  'GET /people/reports/attendance': { audiences: ['office'], permission: 'people.attendance.view', scope: 'record' },
  'GET /people/reports/attendance/differences': { audiences: ['office'], permission: 'people.attendance.view', scope: 'record' },
  'GET /people/reports/attendance/production': { audiences: ['office'], permission: 'people.attendance.view', scope: 'record' },
  'GET /people/reports/attendance/people/:employeeId': { audiences: ['office'], permission: 'people.attendance.view', scope: 'record' },
})
