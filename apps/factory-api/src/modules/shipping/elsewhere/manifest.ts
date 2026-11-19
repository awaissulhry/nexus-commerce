import { defineManifest } from '../../../core/manifest'

/**
 * B-OP-032 (order page N5): "Record a shipment made elsewhere" — office only. The order, its customer and the site are checked
 * with can() (`record`): an order the caller may not see (another customer's, for a person limited to some) is answered as an
 * unknown one. The preview reads (shipping.view); the recording needs shipping.manage here and shipping.ddt.issue in the
 * handler (it records the goods' transport document), and shipping.holds.release to record over a customer hold (R-9).
 */
export const manifest = defineManifest({
  'POST /shipping/shipments/elsewhere/preview': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/shipments/elsewhere': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
})
