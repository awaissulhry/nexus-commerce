import { defineManifest } from '../../../core/manifest'

/**
 * Packing (LOG-039, LOG-002, QHS-073; A2 SCR-098 on the floor, SCR-067 in the office): the office and a floor device
 * (its own site only: can() pins it, row-level security too) with shipping.pack. A floor write needs an
 * Idempotency-Key. Handlers check each shipment with can() and filter the queue with scopeWhere() (`record`).
 */
export const manifest = defineManifest({
  'GET /shipping/packing': { audiences: ['office', 'floor'], permission: 'shipping.pack', scope: 'record' },
  'GET /shipping/packing/:shipmentId': { audiences: ['office', 'floor'], permission: 'shipping.pack', scope: 'record' },
  'POST /shipping/packing/:shipmentId/parcels': { audiences: ['office', 'floor'], permission: 'shipping.pack', scope: 'record' },
  'PATCH /shipping/packing/:shipmentId/parcels/:parcelId': { audiences: ['office', 'floor'], permission: 'shipping.pack', scope: 'record' },
  'DELETE /shipping/packing/:shipmentId/parcels/:parcelId': { audiences: ['office', 'floor'], permission: 'shipping.pack', scope: 'record' },
  'PUT /shipping/packing/:shipmentId/lines/:lineId/parcel': { audiences: ['office', 'floor'], permission: 'shipping.pack', scope: 'record' },
  'POST /shipping/packing/:shipmentId/serials': { audiences: ['office', 'floor'], permission: 'shipping.pack', scope: 'record' },
  'DELETE /shipping/packing/:shipmentId/serials/:serialId': { audiences: ['office', 'floor'], permission: 'shipping.pack', scope: 'record' },
  'POST /shipping/packing/:shipmentId/pack': { audiences: ['office', 'floor'], permission: 'shipping.pack', scope: 'record' },
  'POST /shipping/packing/:shipmentId/unpack': { audiences: ['office', 'floor'], permission: 'shipping.pack', scope: 'record' },
})
