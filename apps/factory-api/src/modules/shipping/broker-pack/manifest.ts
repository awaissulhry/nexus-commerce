import { defineManifest } from '../../../core/manifest'

/**
 * The document pack for the broker (B-W2b-409; LOG-097, LOG-088). Office: the shipment's company, site and party are checked
 * with can() in the handlers (`record`): reading the parts is shipping.view, the merged PDF also the price grain when it
 * carries values; sending it by link shipping.customs.manage and the price grain. Link: a BROKER_PACK link of a
 * CustomsDeclaration reads its page (links.open), downloads its papers (links.download) and types the MRN back
 * (links.submit); any other link is the one 404.
 */
export const manifest = defineManifest({
  'GET /shipping/shipments/:shipmentId/export/pack': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'GET /shipping/shipments/:shipmentId/export/pack/pdf': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/export/pack/link': { audiences: ['office'], permission: 'shipping.customs.manage', scope: 'record' },
  'GET /link/broker-pack': { audiences: ['link'], permission: 'links.open', scope: 'record' },
  'POST /link/broker-pack/files/:fileId/download': { audiences: ['link'], permission: 'links.download', scope: 'record' },
  'POST /link/broker-pack/mrn': { audiences: ['link'], permission: 'links.submit', scope: 'record' },
})
