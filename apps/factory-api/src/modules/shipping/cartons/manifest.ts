import { defineManifest } from '../../../core/manifest'

/**
 * The packing bench's cartons (B-W2b-384; LOG-007, LOG-003, LOG-010, LOG-013; A2 SCR-098 on the floor, SCR-067 in the
 * office): the office and a floor device (its own site only: can() pins it, row-level security too) with shipping.pack; the
 * office's shipment record reads the cartons with shipping.view. A floor write needs an Idempotency-Key. Handlers check each
 * shipment with can() (`record`); printing marks on a label printer also needs print.labels at the printer's site.
 */
export const manifest = defineManifest({
  'GET /shipping/packing/:shipmentId/cartons': { audiences: ['office', 'floor'], permission: 'shipping.pack', scope: 'record' },
  'POST /shipping/packing/:shipmentId/scan': { audiences: ['office', 'floor'], permission: 'shipping.pack', scope: 'record' },
  'POST /shipping/packing/:shipmentId/cartons/:parcelId/take-out': { audiences: ['office', 'floor'], permission: 'shipping.pack', scope: 'record' },
  'POST /shipping/packing/:shipmentId/cartons/:parcelId/close': { audiences: ['office', 'floor'], permission: 'shipping.pack', scope: 'record' },
  'POST /shipping/packing/:shipmentId/cartons/marks/print': { audiences: ['office', 'floor'], permission: 'shipping.pack', scope: 'record' },
  'POST /shipping/packing/:shipmentId/cartons/marks/pdf': { audiences: ['office', 'floor'], permission: 'shipping.pack', scope: 'record' },
  'GET /shipping/shipments/:shipmentId/cartons': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
})
