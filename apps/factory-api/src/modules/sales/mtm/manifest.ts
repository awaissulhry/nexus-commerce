import { defineManifest } from '../../../core/manifest'

/**
 * The made-to-measure office's routes (B-W2b-358; SAL-291, SAL-292, SAL-300, SAL-303; design sales.mtm, SCR-036). Office only.
 * Reading a rider's profiles, revisions, review and worksheets is sales.measurements.view (body data); recording a revision and
 * keeping a worksheet sales.mtm.record; the factory review sales.mtm.review; a repeat order writes a quote (quotes.manage, and
 * sales.measurements.view over the customer in the handler); an order's units are the order's (orders.view). A profile has no
 * company: each handler checks the profile's customer (and a worksheet's company) with can() (`record`).
 */
const view = { audiences: ['office'], permission: 'sales.measurements.view', scope: 'record' } as const
const record = { audiences: ['office'], permission: 'sales.mtm.record', scope: 'record' } as const
const review = { audiences: ['office'], permission: 'sales.mtm.review', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /sales/mtm/profiles': view,
  'GET /sales/mtm/profiles/:profileId': view,
  'POST /sales/mtm/profiles': record,
  'POST /sales/mtm/profiles/:profileId/revisions': record,
  'POST /sales/mtm/profiles/:profileId/review': review,
  'GET /sales/mtm/profiles/:profileId/repeat': view,
  'POST /sales/mtm/profiles/:profileId/repeat': { audiences: ['office'], permission: 'quotes.manage', scope: 'record' },
  'GET /sales/mtm/profiles/:profileId/worksheets': view,
  'POST /sales/mtm/profiles/:profileId/worksheets': record,
  // Read only, the opening recorded (a POST for its audit row, as a body photo's).
  'POST /sales/mtm/profiles/:profileId/worksheets/:documentId/open': view,
  'GET /sales/orders/:orderId/made-to-measure': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
})
