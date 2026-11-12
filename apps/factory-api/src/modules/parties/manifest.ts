import { defineManifest, SIGNED_IN } from '../../core/manifest'

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
  // B-W2b-290 (SAL-014): requirements; the record read checks the record's own view permission inside (a quote's
  // quotes.view, an order's orders.view, a shipment's shipping.view, an invoice's invoices.view).
  'GET /parties/:partyId/requirements': { audiences: ['office'], permission: 'parties.view', scope: 'record' },
  'POST /parties/:partyId/requirements': { audiences: ['office'], permission: 'parties.manage', scope: 'record' },
  'POST /parties/:partyId/requirements/:requirementId/replace': { audiences: ['office'], permission: 'parties.manage', scope: 'record' },
  'POST /parties/:partyId/requirements/:requirementId/end': { audiences: ['office'], permission: 'parties.manage', scope: 'record' },
  'GET /parties/requirements/for/:recordType/:recordId': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  // B-W2b-290 (SAL-023): account holds (parties.hold over the party and the company named).
  'GET /parties/:partyId/holds': { audiences: ['office'], permission: 'parties.view', scope: 'record' },
  'POST /parties/:partyId/holds': { audiences: ['office'], permission: 'parties.hold', scope: 'record' },
  'POST /parties/:partyId/holds/:holdId/release': { audiences: ['office'], permission: 'parties.hold', scope: 'record' },
  // B-W2b-290 (SAL-028, SAL-013): terms per company (over the party and that company; a price list also pricelists.manage).
  'GET /parties/:partyId/company-terms': { audiences: ['office'], permission: 'parties.view', scope: 'record' },
  'PUT /parties/:partyId/company-terms/:companyId': { audiences: ['office'], permission: 'parties.manage', scope: 'record' },
  'POST /parties/:partyId/company-terms/:companyId/end': { audiences: ['office'], permission: 'parties.manage', scope: 'record' },
  // B-W2b-290 (SAL-022): the contacts' personal data; the erasure also asks a fresh code (risk stepUp).
  'GET /parties/:partyId/contacts/privacy': { audiences: ['office'], permission: 'parties.view', scope: 'record' },
  'PUT /parties/:partyId/contacts/:contactId/lawful-basis': { audiences: ['office'], permission: 'parties.privacy', scope: 'record' },
  'POST /parties/:partyId/contacts/:contactId/objection': { audiences: ['office'], permission: 'parties.privacy', scope: 'record' },
  'POST /parties/:partyId/contacts/:contactId/access-copy': { audiences: ['office'], permission: 'parties.privacy', scope: 'record' },
  'POST /parties/:partyId/contacts/:contactId/erase': { audiences: ['office'], permission: 'parties.erase', scope: 'record' },
  // B-W2b-290 (SAL-021): riders under a team or dealer.
  'GET /parties/:partyId/riders': { audiences: ['office'], permission: 'parties.view', scope: 'record' },
  'PUT /parties/:partyId/team': { audiences: ['office'], permission: 'parties.manage', scope: 'record' },
})
