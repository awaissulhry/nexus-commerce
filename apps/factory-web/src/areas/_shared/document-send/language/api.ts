import { z } from 'zod'
import { LANGUAGE_SOURCES, TEMPLATE_LANGUAGES } from '@nexus/factory-domain/templates/language'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The partner contact's language for the send panel (B-W2b-432 on B-W2b-422's `GET /templates/language?partyId&contactId`,
 * parties.view; PLT-131): the language the contact's documents and mails go out in, where it comes from (the contact's own,
 * the party's, the company's), and the language they read when we do not write it. Mirrors platform/templates/contract.ts.
 */

export const recipientLanguageSchema = z.object({
  partyId: z.string(),
  contactId: z.string().nullable(),
  language: z.enum(TEMPLATE_LANGUAGES),
  source: z.enum(LANGUAGE_SOURCES),
  notOffered: z.string().nullable(),
})
export type RecipientLanguage = z.infer<typeof recipientLanguageSchema>

export const recipientLanguage = (api: ApiClient, query: { partyId: string; contactId?: string | null }, signal?: AbortSignal) =>
  api.get('/templates/language', { query: { partyId: query.partyId, contactId: query.contactId ?? undefined }, schema: recipientLanguageSchema, signal })
