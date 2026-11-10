import { defineManifest } from '../../../core/manifest'

/**
 * The brand's samples and tech packs in the portal (B-W2b-262; PRD-245; design portal.customer.samples, SCR-225). Partner
 * sessions only, inside their party (row-level security), in the portal's company. The page reads; the open of a tech pack
 * PDF is the only write (its audit row). Deciding a sample is B-W2b-184's portal answer (portal.approvals.view + portal.approve).
 */
export const manifest = defineManifest({
  'GET /portal/samples': { audiences: ['partner'], permission: 'portal.samples.view', scope: 'party' },
  'POST /portal/samples/tech-packs/:documentId/download': { audiences: ['partner'], permission: 'portal.samples.view', scope: 'party' },
})
