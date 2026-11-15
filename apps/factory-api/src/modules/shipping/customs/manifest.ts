import { defineManifest } from '../../../core/manifest'

/**
 * Export and customs (B-W2b-409; LOG-086, LOG-087, LOG-088, LOG-089, LOG-095): office only. The shipment's company, site and
 * party are checked with can() in the handlers (`record`): reading the Export tab is shipping.view, the papers' PDFs also the
 * price grain; making a paper, the declaration's writes shipping.customs.manage (a paper also the price grain). The company's
 * EORI and a site's broker-pack switch are the shipping settings' (view | manage); switching the pack ON asks a step-up.
 */
export const manifest = defineManifest({
  'GET /shipping/shipments/:shipmentId/export': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/export/commercial-invoice': { audiences: ['office'], permission: 'shipping.customs.manage', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/export/postal-form': { audiences: ['office'], permission: 'shipping.customs.manage', scope: 'record' },
  'GET /shipping/shipments/:shipmentId/export/documents/:documentId/pdf': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/export/declaration': { audiences: ['office'], permission: 'shipping.customs.manage', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/export/declaration/mrn': { audiences: ['office'], permission: 'shipping.customs.manage', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/export/declaration/invoice': { audiences: ['office'], permission: 'shipping.customs.manage', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/export/declaration/exit': { audiences: ['office'], permission: 'shipping.customs.manage', scope: 'record' },
  'DELETE /shipping/shipments/:shipmentId/export/declaration': { audiences: ['office'], permission: 'shipping.customs.manage', scope: 'record' },
  'GET /shipping/companies/:companyId/customs': { audiences: ['office'], permission: 'shipping.settings.view', scope: 'record' },
  'PUT /shipping/companies/:companyId/eori': { audiences: ['office'], permission: 'shipping.settings.manage', scope: 'record' },
  'PUT /shipping/sites/:siteId/broker-pack': { audiences: ['office'], permission: 'shipping.settings.manage', scope: 'record' },
})
