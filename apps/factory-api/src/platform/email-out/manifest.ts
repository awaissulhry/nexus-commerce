import { defineManifest } from '../../core/manifest'

/**
 * Email out's routes (plan A1 §3.2 step 2, §3.7). A record mail belongs to its record's company, site and party, so the
 * handlers check each one with can() (`record`); an identity belongs to its company (can() on it). Office only: a party
 * reads the mail it got as its thread's shared messages (platform/threads). email.manage is a step-up permission: its
 * routes ask for a fresh code (requireStepUp).
 */
export const manifest = defineManifest({
  'POST /threads/:recordType/:recordId/emails': { audiences: ['office'], permission: 'email.send', scope: 'record' },
  'GET /threads/:recordType/:recordId/emails': { audiences: ['office'], permission: 'threads.read', scope: 'record' },
  'GET /email/identities': { audiences: ['office'], permission: 'email.send', scope: 'record' },
  'POST /email/identities': { audiences: ['office'], permission: 'email.manage', scope: 'record' },
  'POST /email/identities/:identityId/check': { audiences: ['office'], permission: 'email.manage', scope: 'record' },
  'PUT /email/identities/:identityId': { audiences: ['office'], permission: 'email.manage', scope: 'record' },
  // B-W2a-41 (PLT-149): the delivery log (scopeWhere over the mail's company) and the tenant-wide blocked list.
  'GET /email/delivery': { audiences: ['office'], permission: 'email.delivery.view', scope: 'record' },
  'GET /email/blocked': { audiences: ['office'], permission: 'email.delivery.view', scope: 'tenant' },
  'POST /email/blocked/:suppressionId/unblock': { audiences: ['office'], permission: 'email.delivery.unblock', scope: 'tenant' },
})
