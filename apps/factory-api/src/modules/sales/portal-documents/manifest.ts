import { defineManifest } from '../../../core/manifest'

/**
 * Customer documents in the portal (B-W2b-178; SAL-086, SAL-087, SAL-092, QHS-111). Partner sessions only, inside their
 * party (row-level security), in the portal's company. Which kinds of documents a person sees goes by role (the handlers:
 * delivery papers and the rest, conformity, invoices; money documents only with the price grain); the open is the only
 * write: its audit row.
 */
export const manifest = defineManifest({
  'GET /portal/customer-documents': { audiences: ['partner'], permission: 'portal.customerDocuments.view', scope: 'party' },
  'GET /portal/customer-documents/conformity': { audiences: ['partner'], permission: 'portal.customerDocuments.conformity', scope: 'party' },
  'GET /portal/customer-documents/:fileId': { audiences: ['partner'], permission: 'portal.customerDocuments.view', scope: 'party' },
  'POST /portal/customer-documents/:fileId/download': { audiences: ['partner'], permission: 'portal.customerDocuments.view', scope: 'party' },
})
