import { defineManifest } from '../../../core/manifest'

/**
 * The DDT (B-W1-47; LOG-054; DPR 472/1996; A2 SCR-067 Documents tab): office only (a portal, link or floor session is
 * refused by audience). A DDT belongs to its shipment's company, site and party, so the handlers check each record
 * with can() and filter the list with scopeWhere() (`record`). Issuing with `ship` also needs shipping.manage (checked
 * in the handler); downloading the PDF also needs files.read (the files module checks it).
 */
export const manifest = defineManifest({
  'POST /shipping/shipments/:shipmentId/ddt/preview': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/ddt/preview/pdf': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/ddt': { audiences: ['office'], permission: 'shipping.ddt.issue', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/ship': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
  'GET /shipping/ddts': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'GET /shipping/ddts/:ddtId': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'GET /shipping/ddts/:ddtId/pdf': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/ddts/:ddtId/pdf': { audiences: ['office'], permission: 'shipping.ddt.issue', scope: 'record' },
  'POST /shipping/ddts/:ddtId/cancel': { audiences: ['office'], permission: 'shipping.ddt.cancel', scope: 'record' },
})
