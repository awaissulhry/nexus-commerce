import { defineManifest } from '../../core/manifest'

/**
 * The parties' routes (A2 SCR-032 Customers, SCR-033 Customer record, SCR-056 Suppliers, SCR-057 Supplier record): one
 * record for customers and suppliers. Office only: a portal or link session reads its own party through its own
 * module's routes, and the floor reads none. A party belongs to one company or to every company of the tenant, and a
 * role may be limited to some parties, so each handler checks the party with can() (company and party) and filters the
 * list with scopeWhere() (`record`). Blocking has its own permission (parties.block), and a VIES check its own
 * (parties.vies), checked over the company that asks.
 */
export const manifest = defineManifest({
  'GET /parties': { audiences: ['office'], permission: 'parties.view', scope: 'record' },
  'GET /parties/:partyId': { audiences: ['office'], permission: 'parties.view', scope: 'record' },
  'POST /parties': { audiences: ['office'], permission: 'parties.manage', scope: 'record' },
  'PATCH /parties/:partyId': { audiences: ['office'], permission: 'parties.manage', scope: 'record' },
  'POST /parties/:partyId/activate': { audiences: ['office'], permission: 'parties.manage', scope: 'record' },
  'POST /parties/:partyId/archive': { audiences: ['office'], permission: 'parties.manage', scope: 'record' },
  'POST /parties/:partyId/reactivate': { audiences: ['office'], permission: 'parties.manage', scope: 'record' },
  'POST /parties/:partyId/block': { audiences: ['office'], permission: 'parties.block', scope: 'record' },
  'POST /parties/:partyId/unblock': { audiences: ['office'], permission: 'parties.block', scope: 'record' },
  'POST /parties/:partyId/addresses': { audiences: ['office'], permission: 'parties.manage', scope: 'record' },
  'PATCH /parties/:partyId/addresses/:addressId': { audiences: ['office'], permission: 'parties.manage', scope: 'record' },
  'PUT /parties/:partyId/default-addresses': { audiences: ['office'], permission: 'parties.manage', scope: 'record' },
  'POST /parties/:partyId/contacts': { audiences: ['office'], permission: 'parties.manage', scope: 'record' },
  'PATCH /parties/:partyId/contacts/:contactId': { audiences: ['office'], permission: 'parties.manage', scope: 'record' },
  'POST /parties/:partyId/tax-identities': { audiences: ['office'], permission: 'parties.manage', scope: 'record' },
  'PATCH /parties/:partyId/tax-identities/:taxIdentityId': { audiences: ['office'], permission: 'parties.manage', scope: 'record' },
  'GET /parties/:partyId/vies-checks': { audiences: ['office'], permission: 'parties.view', scope: 'record' },
  'POST /parties/:partyId/vies-checks': { audiences: ['office'], permission: 'parties.vies', scope: 'record' },
  // B-W2a-19 (SAL-012): the customer's commercial terms; a price list given also needs pricelists.manage (checked inside).
  'GET /parties/:partyId/commercial-terms': { audiences: ['office'], permission: 'parties.view', scope: 'record' },
  'PATCH /parties/:partyId/commercial-terms': { audiences: ['office'], permission: 'parties.manage', scope: 'record' },
})
