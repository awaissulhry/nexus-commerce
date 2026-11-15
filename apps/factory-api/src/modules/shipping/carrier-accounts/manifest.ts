import { defineManifest } from '../../../core/manifest'

/**
 * Carrier accounts (B-W2b-400; LOG-033, LOG-038): office only. A contract belongs to a company (and maybe a site), a
 * customer's account to a party, so the handlers check them with can() (`record`). Our contracts: read with
 * shipping.settings.view, kept with shipping.settings.manage (a new number also asks a fresh step-up, in the handler). The
 * customer's account: read with parties.view, kept with parties.manage.
 */
export const manifest = defineManifest({
  'GET /shipping/carrier-contracts': { audiences: ['office'], permission: 'shipping.settings.view', scope: 'record' },
  'POST /shipping/carrier-contracts': { audiences: ['office'], permission: 'shipping.settings.manage', scope: 'record' },
  'PATCH /shipping/carrier-contracts/:contractId': { audiences: ['office'], permission: 'shipping.settings.manage', scope: 'record' },
  'POST /shipping/carrier-contracts/:contractId/switch-off': { audiences: ['office'], permission: 'shipping.settings.manage', scope: 'record' },
  'GET /shipping/customer-carrier-accounts/:partyId': { audiences: ['office'], permission: 'parties.view', scope: 'record' },
  'PUT /shipping/customer-carrier-accounts/:partyId': { audiences: ['office'], permission: 'parties.manage', scope: 'record' },
})
