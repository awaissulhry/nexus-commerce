import { defineManifest } from '../../../core/manifest'

/**
 * Leaver steps (B-W2b-26; MES-214; design people.employees "Leavers in progress", "Start leaver steps"): office only;
 * people.view reads, people.leavers.manage starts, ticks, skips, reopens, cancels and settles. Handlers check the person
 * with can() against their company and site (`record`).
 */
export const manifest = defineManifest({
  'GET /people/leavers': { audiences: ['office'], permission: 'people.view', scope: 'record' },
  'GET /people/leavers/:caseId': { audiences: ['office'], permission: 'people.view', scope: 'record' },
  'GET /people/employees/:employeeId/leaving/preview': { audiences: ['office'], permission: 'people.view', scope: 'record' },
  'POST /people/employees/:employeeId/leaving': { audiences: ['office'], permission: 'people.leavers.manage', scope: 'record' },
  'POST /people/leavers/:caseId/steps/:stepId/done': { audiences: ['office'], permission: 'people.leavers.manage', scope: 'record' },
  'POST /people/leavers/:caseId/steps/:stepId/skip': { audiences: ['office'], permission: 'people.leavers.manage', scope: 'record' },
  'POST /people/leavers/:caseId/steps/:stepId/reopen': { audiences: ['office'], permission: 'people.leavers.manage', scope: 'record' },
  'POST /people/leavers/:caseId/cancel': { audiences: ['office'], permission: 'people.leavers.manage', scope: 'record' },
  'POST /people/leavers/:caseId/check': { audiences: ['office'], permission: 'people.leavers.manage', scope: 'record' },
})
