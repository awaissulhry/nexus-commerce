import { DOCUMENT_LANGUAGES, type DocumentLanguage } from '../documents/model'

/**
 * The partner contact's language (B-W2b-422; PLT-131; design admin.languages "Document and e-mail languages … per partner
 * contact", shell.preview "the partner contact's language is preselected"): quotes, confirmations, mails and the portal
 * follow the language of the person they go to, whatever the sender's own. The contact's language (PartyContact.language)
 * wins, else the party's (Party.language), else the company's (Company.locale). Documents and mail are written in Italian
 * and English (DOCUMENT_LANGUAGES): Italian when that language is Italian, English for any other (a German buyer reads
 * English better than Italian), as quotes do since W1. Pure.
 */

export const TEMPLATE_LANGUAGES = DOCUMENT_LANGUAGES
export type TemplateLanguage = DocumentLanguage

export const isTemplateLanguage = (value: unknown): value is TemplateLanguage => typeof value === 'string' && (TEMPLATE_LANGUAGES as readonly string[]).includes(value)

/** Where the language comes from. */
export const LANGUAGE_SOURCES = ['CONTACT', 'PARTY', 'COMPANY'] as const
export type LanguageSource = (typeof LANGUAGE_SOURCES)[number]

export interface RecipientLanguage {
  /** The language documents and mail go out in. */
  readonly language: TemplateLanguage
  readonly source: LanguageSource
  /** The language as kept where it came from (two letters), when it is not one documents are written in ("de"); else null. */
  readonly notOffered: string | null
}

const code = (value: string | null | undefined): string | null => {
  const language = (value ?? '').trim().toLowerCase().slice(0, 2)
  return /^[a-z]{2}$/.test(language) ? language : null
}

/** The language for a partner contact (or a party without one), from the contact's, the party's, the company's. */
export function recipientLanguageOf(input: { readonly contact?: string | null; readonly party?: string | null; readonly company?: string | null }): RecipientLanguage {
  const candidates: [LanguageSource, string | null][] = [
    ['CONTACT', code(input.contact)],
    ['PARTY', code(input.party)],
    ['COMPANY', code(input.company)],
  ]
  const found = candidates.find(([, language]) => language !== null)
  if (!found) return { language: 'it', source: 'COMPANY', notOffered: null }
  const [source, language] = found as [LanguageSource, string]
  return isTemplateLanguage(language) ? { language, source, notOffered: null } : { language: 'en', source, notOffered: language }
}
