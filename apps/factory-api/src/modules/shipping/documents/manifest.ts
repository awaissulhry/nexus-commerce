import { defineManifest, PUBLIC } from '../../../core/manifest'

/**
 * A shipment's documents (B-W1-49; LOG-020, SAL-099; A2 SCR-067 Documents tab, SCR-101 the link page).
 *
 * Office: the shipment's company, site and party are checked with can() in the handlers (`record`); attaching and
 * mailing the link change what the party sees, so they are shipping.manage (the warehouse ships, and the documents go
 * with the goods). Link: a DOCUMENT_VIEW link of a Shipment opens its own documents (links.open, its party's scope);
 * any other link is the one 404. "Ask for a new link" is public: a dead link has no session, and the answer is the
 * same whatever the token (rate limited per address like the link routes).
 */
export const manifest = defineManifest({
  'GET /shipping/shipments/:shipmentId/documents': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/documents/attach': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/documents/link': { audiences: ['office'], permission: 'shipping.manage', scope: 'record' },
  'GET /shipping/link/documents': { audiences: ['link'], permission: 'links.open', scope: 'record' },
  'POST /shipping/link/documents/:fileId/download': { audiences: ['link'], permission: 'links.open', scope: 'record' },
  'POST /shipping/link/renew': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  // B-W2a-48 (LOG-090): intra-EU transport evidence (evidence.ts); files.upload is checked over the company in the handler.
  'GET /shipping/shipments/:shipmentId/evidence': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/evidence/papers': { audiences: ['office'], permission: 'shipping.evidence.manage', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/evidence/papers/:fileId/complete': { audiences: ['office'], permission: 'shipping.evidence.manage', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/evidence/complete': { audiences: ['office'], permission: 'shipping.evidence.manage', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/evidence/reopen': { audiences: ['office'], permission: 'shipping.evidence.manage', scope: 'record' },
  'POST /shipping/shipments/:shipmentId/evidence/needed': { audiences: ['office'], permission: 'shipping.evidence.manage', scope: 'record' },
})
