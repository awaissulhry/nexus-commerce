import { defineManifest } from '../../../core/manifest'

/**
 * The proforma invoice (B-W2b-391; LOG-058; design warehouse.shipments "Other documents … proforma (W2b)"): office only,
 * shipping.proforma.issue on the record's company and party (checked with can() in the handler: `record`), and the price grain
 * (a proforma prints prices).
 */
export const manifest = defineManifest({
  'GET /shipping/proformas': { audiences: ['office'], permission: 'shipping.proforma.issue', scope: 'record' },
  'POST /shipping/proformas': { audiences: ['office'], permission: 'shipping.proforma.issue', scope: 'record' },
})
