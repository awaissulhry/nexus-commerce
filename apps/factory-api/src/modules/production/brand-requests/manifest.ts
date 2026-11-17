import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * B-PR-26 — the factory answers its customers' requests (production plan §3 "Brand asks, we decide", "Who answers / sets"; §5
 * Home › Approvals "the one place brand requests are answered"; lead pick L4; review fixes R-05, R-32; wall tests PW-H01,
 * PW-H01b). Office only: a floor, portal or link session is refused by audience. Every route reads the request through the
 * brand wall: workorders.view or orders.view over the request's company AND customer (SIGNED_IN here: the handler asks either,
 * `record`) — another customer's request is "Change request not found." (never says it exists); neither permission anywhere:
 * 403. Refusing and countering also need the kind's own permission over the order (the handler, can()): CHANGE, CANCEL,
 * SPLIT_SHIPMENT orders.manage; RUSH, HOLD, RESUME production.brand.manage; SAMPLE_ROUND sales.samples.manage (403 in words).
 * Accepting is the kind's own route (Sales' /sales/change-requests/:id/accept; B-PR-27a/b's here).
 */
export const manifest = defineManifest({
  'GET /production/brand-requests': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  'GET /production/brand-requests/:requestId': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  'GET /production/brand-requests/:requestId/impact': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  'POST /production/brand-requests/:requestId/refuse': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  'POST /production/brand-requests/:requestId/counter': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
})
