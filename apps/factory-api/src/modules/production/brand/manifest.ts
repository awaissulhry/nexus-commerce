import { defineManifest } from '../../../core/manifest'

/**
 * The customer's production state of its orders, steered by the office (production plan §3, §4; modules/production/brand). Office
 * only: a floor, portal or link session is refused by audience (the customer reads its own orders' state through its portal reads,
 * B-PR-18). The handlers find each sales order through the brand wall — a customer the caller does not reach is "Sales order not
 * found.", as an unknown one — and check the permission over the order's company and customer (`record`).
 *
 * B-PR-35: the factory raises an order's health to At risk with a reason (production.brand.manage), reads it (workorders.view)
 * and clears it.
 */
export const manifest = defineManifest({
  'GET /production/brand-orders/:orderId/health': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'PUT /production/brand-orders/:orderId/health': { audiences: ['office'], permission: 'production.brand.manage', scope: 'record' },
  'DELETE /production/brand-orders/:orderId/health': { audiences: ['office'], permission: 'production.brand.manage', scope: 'record' },
  // B-PR-22b: the customer's urgency — the Customer card's list (workorders.view over the customer), our set-back with lock and
  // our unlock (production.brand.override over each order's company and customer, step-up, no second person).
  'GET /production/brands/:partyId/urgency': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'POST /production/brand-orders/urgency/regular': { audiences: ['office'], permission: 'production.brand.override', scope: 'record' },
  'POST /production/brand-orders/urgency/unlock': { audiences: ['office'], permission: 'production.brand.override', scope: 'record' },
})
