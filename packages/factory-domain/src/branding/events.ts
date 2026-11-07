import { z } from 'zod'
import { defineEvent } from '../events/define'
import { BRANDING_FIELDS } from './rules'

/**
 * Company branding (B-W2b-161; PLT-228). apps/factory-api's platform/branding emits it in the command that saves a
 * company's branding, only when something changed.
 *
 *   company_branding.changed   which fields changed (logo, logo for dark pages, accent, sender name, portal label). The
 *                              Documents & numbering page reads the branding again; the portal and link frames read it on
 *                              their next page.
 *
 * Reaches the office people who see the documents (documents.view over the company): the company and the field names
 * only, never a value.
 */

export const events = [
  defineEvent({
    type: 'company_branding.changed',
    context: 'branding',
    description: "A company's branding changed: its logo, its logo for dark pages, its accent colour, the name its mail to partners is sent under or the name of its portal.",
    payload: z.strictObject({ companyId: z.uuid(), fields: z.array(z.enum(BRANDING_FIELDS)).min(1), version: z.number().int().min(1) }),
    live: { permission: 'documents.view', fields: ['companyId', 'fields', 'version'] },
  }),
] as const
