import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * Working-time limits (B-W2b-42; MES-232; design people.settings "Working-time limits"), office only, checked per record
 * with can() (`record`). A limit carries no person: it reads with the roster's, attendance's or its own permission
 * (SIGNED_IN: the handler asks any of them over the place). What a limit says about a person is attendance data:
 * people.attendance.view, behind the site's ATTENDANCE legal gate (Statuto dei Lavoratori art. 4 c.2).
 */
export const manifest = defineManifest({
  'GET /people/limits': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  'PUT /people/limits': { audiences: ['office'], permission: 'people.limits.manage', scope: 'record' },
  'POST /people/limits/:ruleId/archive': { audiences: ['office'], permission: 'people.limits.manage', scope: 'record' },
  'GET /people/limits/warnings': { audiences: ['office'], permission: 'people.attendance.view', scope: 'record' },
  'GET /people/employees/:employeeId/limits': { audiences: ['office'], permission: 'people.attendance.view', scope: 'record' },
})
