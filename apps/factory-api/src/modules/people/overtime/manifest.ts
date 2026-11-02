import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * Overtime worked and timesheets (B-W2b-42; MES-229, MES-230; design people.attendance), office only, checked per record
 * with can() against the entry's or the person's company and site (`record`). Overtime reads with people.attendance.view
 * and is decided with people.overtime.review. A timesheet reads and goes through its first approval with any of the
 * lead's or HR's permissions (SIGNED_IN: the handler asks them over the person, and for people.timesheets.team that the
 * caller led the person's team in the period). Every read and write of a person's data asks the site's ATTENDANCE legal
 * gate first (B-W2b-27; Statuto dei Lavoratori art. 4 c.2).
 */
export const manifest = defineManifest({
  'GET /people/overtime/entries': { audiences: ['office'], permission: 'people.attendance.view', scope: 'record' },
  'GET /people/overtime/counts': { audiences: ['office'], permission: 'people.attendance.view', scope: 'record' },
  'GET /people/overtime/entries/:entryId': { audiences: ['office'], permission: 'people.attendance.view', scope: 'record' },
  'POST /people/overtime/entries/:entryId/approve': { audiences: ['office'], permission: 'people.overtime.review', scope: 'record' },
  'POST /people/overtime/entries/:entryId/reject': { audiences: ['office'], permission: 'people.overtime.review', scope: 'record' },
  'POST /people/overtime/entries/:entryId/reopen': { audiences: ['office'], permission: 'people.overtime.review', scope: 'record' },
  'GET /people/timesheets': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  'POST /people/timesheets/prepare': { audiences: ['office'], permission: 'people.timesheets.hr', scope: 'record' },
  'GET /people/timesheets/:timesheetId': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  'POST /people/timesheets/:timesheetId/lead-approve': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  'POST /people/timesheets/:timesheetId/hr-approve': { audiences: ['office'], permission: 'people.timesheets.hr', scope: 'record' },
  'POST /people/timesheets/:timesheetId/send-back': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
})
