import { defineManifest } from '../../../core/manifest'

/**
 * Before an order (B-CQ-002; customer page › Quotes & incoming, settle L11): one customer's quotes, requests, portal orders and
 * drafts counted per group. Office only: parties.view over the customer (the handler checks it with can(), the customer-360
 * precedent); each kind is counted with its OWN view right inside (./counts.ts). A read: no command, no event.
 */
export const manifest = defineManifest({
  'GET /sales/before-order/counts': { audiences: ['office'], permission: 'parties.view', scope: 'record' },
})
