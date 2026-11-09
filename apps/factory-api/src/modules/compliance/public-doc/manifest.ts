import { defineManifest, PUBLIC } from '../../../core/manifest'

/**
 * The public DoC (B-W2b-166; PRD-294, PRD-356; design links.doc). Anyone holding the garment opens `/doc/<code>` on the web:
 * the lookup and the PDFs are PUBLIC (no session; rate-limited per address, the abuse guard's `public.lookup` policy per
 * network); every tenant is read in the platform scope, then in its own system scope, only once the code names a released
 * batch or a style with a published declaration. The office reads the address a label's QR prints for a style or a batch
 * (compliance.certificates.view over its company: `record`).
 */
export const manifest = defineManifest({
  'POST /public/doc/lookup': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  'GET /public/doc/:code/files/:fileId': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  'GET /compliance/public-doc/address': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'record' },
})
