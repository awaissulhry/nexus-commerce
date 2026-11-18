import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * B-SA-041 (sales page plan, lead picks P6', R1): the work-order changes an accepted change of a sales order proposes. Office only
 * (a floor, portal or link session is refused by audience: the floor is told by a note on its work order, the customer never reads
 * a work order). The handlers check each record (`record`): the reads with orders.view over the order's customer or
 * workorders.view over the work order (./read), the decisions with workorders.manage over the work order (the brand wall's 404 for
 * another customer's).
 */
export const manifest = defineManifest({
  'GET /production/work-order-changes': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  'GET /production/work-order-changes/:changeId': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  'POST /production/work-order-changes': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /production/work-order-changes/:changeId/apply': { audiences: ['office'], permission: 'workorders.manage', scope: 'record' },
  'POST /production/work-order-changes/:changeId/decline': { audiences: ['office'], permission: 'workorders.manage', scope: 'record' },
})
