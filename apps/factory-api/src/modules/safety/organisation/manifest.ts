import { defineManifest } from '../../../core/manifest'

/**
 * The safety organisation and the RLS notice to INAIL (B-W2b-120; QHS-224, QHS-226; design plant.calendar). Office only;
 * safety.view reads, safety.organisation.manage appoints, signs, ends and records the notice. Handlers check each record
 * with can() against its company and site (`record`); the pickers are the manager's (the dialog's people, contacts, shifts).
 */
export const manifest = defineManifest({
  'GET /safety/organisation': { audiences: ['office'], permission: 'safety.view', scope: 'record' },
  'GET /safety/organisation/people': { audiences: ['office'], permission: 'safety.organisation.manage', scope: 'record' },
  'GET /safety/organisation/contacts': { audiences: ['office'], permission: 'safety.organisation.manage', scope: 'record' },
  'GET /safety/organisation/shifts': { audiences: ['office'], permission: 'safety.organisation.manage', scope: 'record' },
  'GET /safety/appointments/:appointmentId': { audiences: ['office'], permission: 'safety.view', scope: 'record' },
  'POST /safety/appointments': { audiences: ['office'], permission: 'safety.organisation.manage', scope: 'record' },
  'PATCH /safety/appointments/:appointmentId': { audiences: ['office'], permission: 'safety.organisation.manage', scope: 'record' },
  'POST /safety/appointments/:appointmentId/sign': { audiences: ['office'], permission: 'safety.organisation.manage', scope: 'record' },
  'POST /safety/appointments/:appointmentId/end': { audiences: ['office'], permission: 'safety.organisation.manage', scope: 'record' },
  'GET /safety/rls-notices': { audiences: ['office'], permission: 'safety.view', scope: 'record' },
  'POST /safety/rls-notices/:noticeId/file': { audiences: ['office'], permission: 'safety.organisation.manage', scope: 'record' },
  'POST /safety/rls-notices/:noticeId/due': { audiences: ['office'], permission: 'safety.organisation.manage', scope: 'record' },
  'POST /safety/rls-notices/:noticeId/cancel': { audiences: ['office'], permission: 'safety.organisation.manage', scope: 'record' },
})
