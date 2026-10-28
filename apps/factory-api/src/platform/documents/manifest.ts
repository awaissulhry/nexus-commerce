import { defineManifest } from '../../core/manifest'

/**
 * The documents routes (plan A1 §3.9). The preview is checked with can() against the company it shows (`record`).
 * Issued documents have no route here: the issuing module prints them in its own flow (storeDocumentPdf), and they
 * are downloaded as files.
 */
export const manifest = defineManifest({
  'GET /documents/sample': { audiences: ['office'], permission: 'documents.view', scope: 'record' },
})
