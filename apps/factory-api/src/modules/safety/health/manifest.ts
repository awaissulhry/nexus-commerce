import { defineManifest } from '../../../core/manifest'

/**
 * Health surveillance (B-W2b-135; QHS-252, QHS-253, QHS-254, QHS-256; design plant.health SCR-212; D.Lgs. 81/2008 art. 41; GDPR
 * art. 9). Office only. safety.health.view reads the protected records (each view recorded), safety.health.manage keeps the visits
 * and judgements, safety.health.plans the plans per role (read with safety.view: no person in a plan), safety.health.views the
 * view log; "Authorise a machine" asks fit yes or no with people.authorisations.manage. The leaver's end-of-employment step is the
 * HR record's (people.view, people.leavers.manage) and asks the health reader's permission in its handler. Handlers check each
 * record with can() against the person's company and site (`record`). Nothing for the floor, a partner or a link.
 */
const view = { audiences: ['office'], permission: 'safety.health.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'safety.health.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /safety/health': view,
  'GET /safety/health/plans': { audiences: ['office'], permission: 'safety.view', scope: 'record' },
  'PATCH /safety/health/plans/:planId': { audiences: ['office'], permission: 'safety.health.plans', scope: 'record' },
  'POST /safety/health/visits/list': view,
  'POST /safety/health/visits/print': view,
  'POST /safety/health/visits/proposals': view,
  'POST /safety/health/visits/plan': manage,
  'POST /safety/health/visits/book': manage,
  'POST /safety/health/visits/:visitId/open': view,
  'POST /safety/health/visits/:visitId/unbook': manage,
  'PATCH /safety/health/visits/:visitId': manage,
  'POST /safety/health/visits/:visitId/cancel': manage,
  'POST /safety/health/visits/:visitId/done': manage,
  'GET /safety/health/judgements': view,
  'POST /safety/health/judgements': manage,
  'POST /safety/health/judgements/show': view,
  'POST /safety/health/judgements/:judgementId/open': view,
  'POST /safety/health/judgements/:judgementId/void': manage,
  'POST /safety/health/judgements/:judgementId/copy': manage,
  'POST /safety/health/judgements/:judgementId/copy/:fileId/complete': manage,
  'POST /safety/health/judgements/:judgementId/copy/:fileId/open': view,
  'GET /safety/health/views': { audiences: ['office'], permission: 'safety.health.views', scope: 'record' },
  'POST /safety/health/people/:employeeId/fitness': { audiences: ['office'], permission: 'people.authorisations.manage', scope: 'record' },
  'POST /people/leavers/:caseId/exit-visit/open': { audiences: ['office'], permission: 'people.view', scope: 'record' },
  'POST /people/leavers/:caseId/steps/:stepId/exit-visit': { audiences: ['office'], permission: 'people.leavers.manage', scope: 'record' },
})
