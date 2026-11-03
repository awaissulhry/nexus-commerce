import { defineManifest } from '../../../core/manifest'

/**
 * Statutory periodic checks (B-W2b-124; QHS-205; D.Lgs. 81/2008 art. 71; design plant.preventive, plant.settings
 * "Statutory check types"). Office only. Reads need plant.view; keeping the types, plans, results and reports needs
 * plant.checks.manage (the types over every company: scope `tenant`); a check's job asks plant.jobs.manage and its lock
 * plant.report in the handler, over the machine's company and site (`record`).
 */
export const manifest = defineManifest({
  'GET /plant/checks/types': { audiences: ['office'], permission: 'plant.view', scope: 'tenant' },
  'POST /plant/checks/types': { audiences: ['office'], permission: 'plant.checks.manage', scope: 'tenant' },
  'PATCH /plant/checks/types/:checkTypeId': { audiences: ['office'], permission: 'plant.checks.manage', scope: 'tenant' },
  'GET /plant/checks/counts': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'GET /plant/checks/calendar': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'GET /plant/checks/plans': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'GET /plant/checks/plans/:planId': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'POST /plant/checks/plans': { audiences: ['office'], permission: 'plant.checks.manage', scope: 'record' },
  'PATCH /plant/checks/plans/:planId': { audiences: ['office'], permission: 'plant.checks.manage', scope: 'record' },
  'POST /plant/checks/plans/:planId/move': { audiences: ['office'], permission: 'plant.checks.manage', scope: 'record' },
  'POST /plant/checks/plans/:planId/end': { audiences: ['office'], permission: 'plant.checks.manage', scope: 'record' },
  'GET /plant/checks/results': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'GET /plant/checks/results/:resultId': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'POST /plant/checks/results': { audiences: ['office'], permission: 'plant.checks.manage', scope: 'record' },
  'POST /plant/checks/results/:resultId/job': { audiences: ['office'], permission: 'plant.jobs.manage', scope: 'record' },
  'POST /plant/checks/results/:resultId/lock': { audiences: ['office'], permission: 'plant.report', scope: 'record' },
  'POST /plant/checks/results/:resultId/reports': { audiences: ['office'], permission: 'plant.checks.manage', scope: 'record' },
  'POST /plant/checks/results/:resultId/reports/:fileId/complete': { audiences: ['office'], permission: 'plant.checks.manage', scope: 'record' },
  'GET /plant/checks/results/:resultId/reports/:fileId/download': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'GET /plant/checks/results/:resultId/pdf': { audiences: ['office'], permission: 'plant.view', scope: 'record' },
  'POST /plant/checks/results/:resultId/pdf': { audiences: ['office'], permission: 'plant.checks.manage', scope: 'record' },
})
