import { defineManifest } from '../../../core/manifest'

/**
 * Reprint a label with a reason (B-W2b-391; LOG-027; design warehouse.shipments Carrier & label "W2b Reprint with a reason
 * (logged)", floor.labels "Reprint asks a reason"): the office and a floor device at the shipment's site (its own site only:
 * can() pins it, row-level security too) with shipping.pack, as printing the labels; the reprint also needs print.labels at
 * the printer's site (checked in the handler). A floor write needs an Idempotency-Key. Handlers check each shipment with
 * can() (`record`).
 */
export const manifest = defineManifest({
  'GET /shipping/shipments/:shipmentId/label-jobs': { audiences: ['office', 'floor'], permission: 'shipping.pack', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/label-jobs/reprint': { audiences: ['office', 'floor'], permission: 'shipping.pack', scope: 'record' },
})
