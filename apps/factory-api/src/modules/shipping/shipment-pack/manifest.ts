import { defineManifest } from '../../../core/manifest'

/**
 * One PDF per shipment (B-W2b-391; LOG-031; design floor.pack "Documents … in one print job", warehouse.shipments "Other
 * documents: Print all (one merged PDF)"): the office and a floor device at the shipment's site (its own site only: can() pins
 * it, row-level security too) with shipping.pack; the office's print job also needs print.documents at the printer's site
 * (checked in the handler). A floor write needs an Idempotency-Key. Handlers check each shipment with can() (`record`).
 */
export const manifest = defineManifest({
  'GET /shipping/shipments/:shipmentId/pack': { audiences: ['office', 'floor'], permission: 'shipping.pack', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/pack': { audiences: ['office', 'floor'], permission: 'shipping.pack', scope: 'record' },
  'GET /shipping/shipments/:shipmentId/pack/pdf': { audiences: ['office', 'floor'], permission: 'shipping.pack', scope: 'record' },
})
