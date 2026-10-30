import { defineManifest } from '../../../core/manifest'

/**
 * Carrier labels and tracking (B-W1-48; LOG-025, LOG-032, LOG-059; A2 SCR-067 in the office, SCR-098 on the floor).
 * Buying and voiding are the office's (buying spends the company's money; the gateway calls no carrier for a floor
 * device). Reading the labels and printing them are every packer's: the office and a floor device at its own site
 * (shipping.pack; printing also checks print.labels on the printer's site). Tracking is the office's read. The handlers
 * check each shipment with can() (`record`).
 */
export const manifest = defineManifest({
  'GET /shipping/shipments/:shipmentId/labels': { audiences: ['office', 'floor'], permission: 'shipping.pack', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/labels': { audiences: ['office'], permission: 'shipping.labels.buy', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/labels/print': { audiences: ['office', 'floor'], permission: 'shipping.pack', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/parcels/:parcelId/label/void': { audiences: ['office'], permission: 'shipping.labels.void', scope: 'record' },
  // B-W2a-48 (LOG-028): every label of the shipment at once.
  'POST /shipping/shipments/:shipmentId/labels/void': { audiences: ['office'], permission: 'shipping.labels.void', scope: 'record' },
  'GET /shipping/shipments/:shipmentId/tracking': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
})
