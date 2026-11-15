import { defineManifest } from '../../../core/manifest'

/**
 * Integration health in Connections & API (B-W2b-415; PLT-196, PLT-201): the error queue (read with integrations.view,
 * retry and dismiss with integrations.errors.manage) and a connection's Test and Reconnect (integrations.manage). Scope
 * `record`: each handler checks the item's or the account's company with can() (no company: every active company for a write).
 */
export const manifest = defineManifest({
  'GET /integrations/errors': { audiences: ['office'], permission: 'integrations.view', scope: 'record' },
  'GET /integrations/errors/:itemId': { audiences: ['office'], permission: 'integrations.view', scope: 'record' },
  'POST /integrations/errors/:itemId/retry': { audiences: ['office'], permission: 'integrations.errors.manage', scope: 'record' },
  'POST /integrations/errors/:itemId/dismiss': { audiences: ['office'], permission: 'integrations.errors.manage', scope: 'record' },
  'POST /integrations/accounts/:accountId/test': { audiences: ['office'], permission: 'integrations.manage', scope: 'record' },
  'POST /integrations/accounts/:accountId/reconnect': { audiences: ['office'], permission: 'integrations.manage', scope: 'record' },
})
