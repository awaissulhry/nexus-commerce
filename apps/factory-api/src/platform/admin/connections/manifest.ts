import { defineManifest } from '../../../core/manifest'

/**
 * The outside services in the Office (B-W0-28, SCR-087 Connections & API): the integration accounts, their calls and
 * the webhooks they sent, read with integrations.view; pause and resume with integrations.manage. Scope `record`: each
 * route checks the account's company with can() (a tenant-wide account: every active company for a write).
 */
export const manifest = defineManifest({
  'GET /integrations/accounts': { audiences: ['office'], permission: 'integrations.view', scope: 'record' },
  'GET /integrations/accounts/:accountId': { audiences: ['office'], permission: 'integrations.view', scope: 'record' },
  'GET /integrations/accounts/:accountId/calls': { audiences: ['office'], permission: 'integrations.view', scope: 'record' },
  'GET /integrations/accounts/:accountId/inbound': { audiences: ['office'], permission: 'integrations.view', scope: 'record' },
  'POST /integrations/accounts/:accountId/pause': { audiences: ['office'], permission: 'integrations.manage', scope: 'record' },
  'POST /integrations/accounts/:accountId/resume': { audiences: ['office'], permission: 'integrations.manage', scope: 'record' },
})
