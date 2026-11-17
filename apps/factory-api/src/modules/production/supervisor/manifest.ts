import { defineManifest } from '../../../core/manifest'

/**
 * B-PR-42a — the production supervisor of a customer and of its orders (production plan §3 "Supervisor"; lead pick L21). Office
 * only: a floor, portal or link session is refused by audience (the customer is never told who its supervisor is: R-41). Each
 * handler finds the customer or the orders through the brand wall — a customer the caller does not reach is "Customer not
 * found.", another customer's order is counted, never named — and checks production.brand.manage over the company AND the
 * customer (`record`).
 */
export const manifest = defineManifest({
  'GET /production/supervisors': { audiences: ['office'], permission: 'production.brand.manage', scope: 'record' },
  'PUT /production/brands/:partyId/supervisor': { audiences: ['office'], permission: 'production.brand.manage', scope: 'record' },
  'POST /production/orders/supervisor': { audiences: ['office'], permission: 'production.brand.manage', scope: 'record' },
})
