import { z } from 'zod'
import { LANGUAGE_SOURCES, TEMPLATE_LANGUAGES } from '@nexus/factory-domain/templates/language'
import type { ApiClient } from '../../../../lib/api/client'
import { updateContact } from '../../../parties/_shared/api'

/**
 * The partner contacts' languages (B-W2b-432 on B-W2b-422's `GET /templates/languages/contacts`; PLT-131): the active
 * contacts of prospect and active parties by name — their own language, their party's, and the language their documents
 * and mails go out in (with where it comes from, and the language they read when we do not write it). A contact's own
 * language is changed where the contact is kept: the parties' `PATCH /parties/:partyId/contacts/:contactId` with the
 * contact's version (parties.manage). Mirrors apps/factory-api platform/templates/contract.ts.
 */

export type LanguageSource = (typeof LANGUAGE_SOURCES)[number]

export const contactLanguageSchema = z.object({
  contactId: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  own: z.string().nullable(),
  party: z.object({ id: z.string(), code: z.string(), name: z.string(), language: z.string() }),
  language: z.enum(TEMPLATE_LANGUAGES),
  source: z.enum(LANGUAGE_SOURCES),
  notOffered: z.string().nullable(),
  version: z.number(),
})
export type ContactLanguage = z.infer<typeof contactLanguageSchema>

const listAnswer = z.object({ contacts: z.array(contactLanguageSchema), nextCursor: z.string().nullable(), languages: z.array(z.enum(TEMPLATE_LANGUAGES)) })
export type ContactLanguagesAnswer = z.infer<typeof listAnswer>

export const listContactLanguages = (api: ApiClient, query: { q?: string; cursor?: string | null; limit?: number }, signal?: AbortSignal) =>
  api.get('/templates/languages/contacts', { query: { q: query.q?.trim() || undefined, cursor: query.cursor ?? undefined, limit: query.limit ?? 50 }, schema: listAnswer, signal })

/** A contact's own language (null: its party's), at the version read; answers the contact's new version. */
export async function setContactLanguage(api: ApiClient, contact: Pick<ContactLanguage, 'contactId' | 'version' | 'party'>, language: string | null): Promise<number> {
  const party = await updateContact(api, contact.party.id, contact.contactId, { version: contact.version, language })
  return party.contacts.find((entry) => entry.id === contact.contactId)?.version ?? contact.version + 1
}
