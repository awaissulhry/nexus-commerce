import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * Order structures and their rules (owb-ss6; _owb-ss-common L3, L10): office only — the designer (orders.view.own only) and the
 * floor have no route, the portal never. A structure is kept with production.structures.manage and READ by holders of .manage OR
 * .rules; the rules, "Try an order" and one order by hand need production.structures.rules. A manifest names ONE permission, so
 * the routes that take either of two rights say `signed-in` and their handler asks both, against the record's company (and its
 * customer). An order's structure is read by whoever sees the order (orders.view) or holds .rules / .manage over its company and
 * customer. Each record checked with can() (`record`).
 */
const manage = { audiences: ['office'], permission: 'production.structures.manage', scope: 'record' } as const
const rules = { audiences: ['office'], permission: 'production.structures.rules', scope: 'record' } as const
const either = { audiences: ['office'], permission: SIGNED_IN, scope: 'record' } as const

export const manifest = defineManifest({
  'GET /production/order-structures': either,
  'POST /production/order-structures': manage,
  'PATCH /production/order-structures/:structureId': manage,
  'POST /production/order-structures/:structureId/close': manage,
  'POST /production/order-structures/:structureId/reopen': manage,
  'GET /production/structure-rules': either,
  'POST /production/structure-rules': rules,
  'PATCH /production/structure-rules/:ruleId': rules,
  'PUT /production/structure-rules/order': rules,
  'POST /production/structure-rules/:ruleId/close': rules,
  'POST /production/structure-rules/:ruleId/reopen': rules,
  'POST /production/structure-rules/try': rules,
  'GET /production/orders/:orderId/structure': either,
  'PUT /production/orders/:orderId/structure': rules,
  'DELETE /production/orders/:orderId/structure': rules,
  'GET /production/customers/:partyId/structure-rules': either,
})
