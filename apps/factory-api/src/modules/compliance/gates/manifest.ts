import { defineManifest } from '../../../core/manifest'

/**
 * Gate refusals and overrides, and the gate's answer (B-W2b-254; PRD-272; design compliance.status › cs-gates,
 * cs-override). Office only. Reading needs the certificate register's view permission (the events of the companies it
 * reaches); an override needs compliance.gates.override over the subject's company, a role the requirement names and a
 * fresh step-up (the handler checks them, 403 in words / `stepUp`).
 */
export const manifest = defineManifest({
  'GET /compliance/gates/events': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'POST /compliance/gates/events/:eventId/override': { audiences: ['office'], permission: 'compliance.gates.override', scope: 'tenant' },
  'GET /compliance/gates/check': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
})
