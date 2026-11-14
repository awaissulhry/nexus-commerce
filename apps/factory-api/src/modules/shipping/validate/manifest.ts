import { defineManifest } from '../../../core/manifest'

/**
 * The check before printing (B-W2b-390; LOG-045): every packer's read, the office and a floor device at its own site
 * (shipping.pack, as the labels' own read); the handler checks the shipment with can() (`record`).
 */
export const manifest = defineManifest({
  'GET /shipping/shipments/:shipmentId/labels/check': { audiences: ['office', 'floor'], permission: 'shipping.pack', scope: 'record' },
})
