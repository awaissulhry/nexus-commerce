import { defineManifest, PUBLIC } from '../../core/manifest'

/**
 * Company branding (B-W2b-161; PLT-228, SAL-064). Office routes are scoped by record: the handlers check the company with
 * can() (documents.view to know it, then documents.branding.manage and, for a logo, files.upload; the save also asks a
 * fresh step-up). The public read and the logo serve a company's portal sign-in page and link pages before anyone signs
 * in (rate-limited; the logo only while it is the company's). A link session reads its sender's branding.
 */
export const manifest = defineManifest({
  'GET /branding': { audiences: ['office'], permission: 'documents.view', scope: 'record' },
  'PUT /branding/:companyId': { audiences: ['office'], permission: 'documents.branding.manage', scope: 'record' },
  'POST /branding/:companyId/logo': { audiences: ['office'], permission: 'documents.branding.manage', scope: 'record' },
  'POST /branding/:companyId/logo/:fileId/complete': { audiences: ['office'], permission: 'documents.branding.manage', scope: 'record' },
  'GET /branding/public/:companyId': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  'GET /branding/public/:companyId/logo/:fileId': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  'GET /link/branding': { audiences: ['link'], permission: 'links.open', scope: 'party' },
})
