import { defineManifest } from '../../../core/manifest'

/**
 * The employee record (B-W2b-26; MES-208, MES-209, MES-211; design people.employees SCR-084 / SCR-085): office only;
 * people.view reads, people.employees.manage makes, changes and links the records. Handlers check each record with
 * can() against its company and site (`record`).
 */
export const manifest = defineManifest({
  'GET /people/employees': { audiences: ['office'], permission: 'people.view', scope: 'record' },
  'GET /people/employees/counts': { audiences: ['office'], permission: 'people.view', scope: 'record' },
  'GET /people/employees/unlinked-workers': { audiences: ['office'], permission: 'people.view', scope: 'record' },
  'GET /people/employees/import/:jobId/missing': { audiences: ['office'], permission: 'people.view', scope: 'record' },
  'GET /people/employees/:employeeId': { audiences: ['office'], permission: 'people.view', scope: 'record' },
  'POST /people/employees': { audiences: ['office'], permission: 'people.employees.manage', scope: 'record' },
  'POST /people/employees/from-worker': { audiences: ['office'], permission: 'people.employees.manage', scope: 'record' },
  'POST /people/employees/from-user': { audiences: ['office'], permission: 'people.employees.manage', scope: 'record' },
  'PATCH /people/employees/:employeeId': { audiences: ['office'], permission: 'people.employees.manage', scope: 'record' },
  'POST /people/employees/:employeeId/workers': { audiences: ['office'], permission: 'people.employees.manage', scope: 'record' },
  'POST /people/employees/:employeeId/workers/:workerId/unlink': { audiences: ['office'], permission: 'people.employees.manage', scope: 'record' },
  'PUT /people/employees/:employeeId/user': { audiences: ['office'], permission: 'people.employees.manage', scope: 'record' },
})
