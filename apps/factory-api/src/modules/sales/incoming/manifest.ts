import { defineManifest } from '../../../core/manifest'

/**
 * Sales › Incoming's one read (B-TH-039; threads plan G2). Office only: the route asks sales.inquiries.view (Incoming is the
 * requests' page, the list key `sales.inquiries`); each row is then checked against its OWN view permission over its company and
 * customer — requests sales.inquiries.view, catalogue orders and change requests orders.view — so a reader never lists a row they
 * may not open (`record`).
 */
export const manifest = defineManifest({
  'GET /sales/incoming': { audiences: ['office'], permission: 'sales.inquiries.view', scope: 'record' },
})
