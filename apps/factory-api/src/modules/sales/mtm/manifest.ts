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
// B-W2b-371: a fitting's photos.
const fittings = { audiences: ['office'], permission: 'sales.fittings.manage', scope: 'record' } as const

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
  // B-W2b-371 (XF2:01): the office's and the fittings' photos with their delete dates (./photos). Read and opened with
  // sales.measurements.view (each opening recorded), added and dated with sales.mtm.record (a revision's) or sales.fittings.manage
  // (a fitting's); the handlers check the profile's customer (a fitting's company and customer).
  'GET /sales/mtm/profiles/:profileId/photos': view,
  'POST /sales/mtm/profiles/:profileId/photos': record,
  'POST /sales/mtm/profiles/:profileId/photos/:fileId/complete': record,
  'PUT /sales/mtm/profiles/:profileId/photos/:fileId/delete-after': record,
  'POST /sales/fittings/results/:resultId/photos': fittings,
  'POST /sales/fittings/results/:resultId/photos/:fileId/complete': fittings,
  'PUT /sales/fittings/results/:resultId/photos/:fileId/delete-after': fittings,
  'POST /sales/mtm/photos/:fileId/open': view,
  // B-W2b-371 (XF2:04): the styles and the open orders a measurement template serves (./where-used): product.styles.view; the
  // orders only over the caller's orders.view, a rider's name only over sales.measurements.view.
  'GET /product/measurement-templates/:templateId/where-used': { audiences: ['office'], permission: 'product.styles.view', scope: 'record' },
})
