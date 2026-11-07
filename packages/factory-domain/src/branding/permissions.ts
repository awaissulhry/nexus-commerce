import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * Company branding (apps/factory-api platform/branding; B-W2b-161; PLT-228, SAL-064; design admin.documents › Branding):
 * a company's logo (and its logo for dark pages), its accent colour, the name its mail to partners is sent under and the
 * name its portal calls itself. Reading it in the office is documents.view (the documents' look, beside the letterhead
 * preview); changing it is this permission, checked with can() against the company. Step-up, as email.manage: the sender
 * name changes who the company's mail appears to come from (A1 §3.10). Partners never hold it: the portal, the link pages
 * and the sign-in page read the branding in the tenant's system scope.
 */
export const BRANDING_DEFINITIONS = definePermissions('documents', {
  'branding.manage': {
    risk: 'stepUp',
    description:
      "Change a company's branding: its logo and logo for dark pages (PNG or JPEG), its accent colour (used only where it passes the contrast rule), the name its mail to customers and suppliers is sent under, and the name of its portal.",
  },
})

export const BRANDING_MANAGE = 'documents.branding.manage' satisfies Permission

export const BRANDING_PERMISSIONS: readonly Permission[] = Object.freeze([BRANDING_MANAGE])
