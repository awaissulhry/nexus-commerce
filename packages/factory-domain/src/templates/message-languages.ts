import type { LanguageSource } from './language'

// ---- B-TH-098 (threads plan TH-9, thread-G07; T8-F02 "Saved replies ▾ in the customer's language"; plan decision "mail texts in
// DE/FR/ES drafted by Claude, read once by the Owner or a trusted customer contact") ------------------------------------------------
/**
 * The languages of what is WRITTEN to a customer or supplier — saved replies and the fixed mail texts — beside Italian and English:
 * German, French and Spanish. Documents (quotes, confirmations, the printed layouts) stay Italian and English (templates/language.ts).
 *
 *   saved replies   written by people in any of the five (P4: never machine-translated); a person's own words need no reading
 *   fixed texts     the code's mail words (templates/mail.ts MAIL_DRAFTS) in German, French and Spanish were DRAFTED BY CLAUDE: each
 *                   language is "to be read once by the Owner or a trusted customer contact" (LANGUAGE_REVIEW: who read it and when,
 *                   set here once they have). Until then a drafted text is never sent on its own — the mail goes in English — and the
 *                   office uses it only by ticking "Send it anyway" (UNREAD words below), recorded with who ticked.
 */
export const MESSAGE_LANGUAGES = ['it', 'en', 'de', 'fr', 'es'] as const
export type MessageLanguage = (typeof MESSAGE_LANGUAGES)[number]
export const isMessageLanguage = (value: unknown): value is MessageLanguage => typeof value === 'string' && (MESSAGE_LANGUAGES as readonly string[]).includes(value)

/** The languages whose fixed texts Claude drafted (Italian and English are the code's own). */
export const DRAFTED_LANGUAGES = ['de', 'fr', 'es'] as const
export type DraftedLanguage = (typeof DRAFTED_LANGUAGES)[number]
export const isDraftedLanguage = (value: unknown): value is DraftedLanguage => typeof value === 'string' && (DRAFTED_LANGUAGES as readonly string[]).includes(value)

/** A drafted language's reading: who read the drafts once (the Owner, or a trusted contact of a customer who speaks it) and the day. */
export interface LanguageReview {
  readonly readBy: string | null
  readonly readOn: string | null
}

/**
 * The read state of each drafted language. Set ONLY when the Owner (or the customer contact he trusts) has read that language's drafts
 * in templates/mail.ts MAIL_DRAFTS, e.g. `de: { readBy: 'Owner', readOn: '2026-11-20' }` — a one-line change with its own commit.
 */
export const LANGUAGE_REVIEW: Readonly<Record<DraftedLanguage, LanguageReview>> = Object.freeze({
  de: { readBy: null, readOn: null },
  fr: { readBy: null, readOn: null },
  es: { readBy: null, readOn: null },
})

/** Whether a language's fixed texts may go out on their own: Italian and English always; a drafted one once it was read. */
export const isLanguageRead = (language: MessageLanguage, review: Readonly<Record<DraftedLanguage, LanguageReview>> = LANGUAGE_REVIEW): boolean =>
  !isDraftedLanguage(language) || review[language].readBy !== null

export const LANGUAGE_NAMES: Readonly<Record<MessageLanguage, { readonly it: string; readonly en: string }>> = Object.freeze({
  it: { it: 'italiano', en: 'Italian' },
  en: { it: 'inglese', en: 'English' },
  de: { it: 'tedesco', en: 'German' },
  fr: { it: 'francese', en: 'French' },
  es: { it: 'spagnolo', en: 'Spanish' },
})

export const MESSAGE_LANGUAGE_WORDS = Object.freeze({
  it: 'Le risposte salvate si scrivono in italiano, inglese, tedesco, francese o spagnolo.',
  en: 'Saved replies are written in Italian, English, German, French or Spanish.',
})

/** The words of a drafted text not read yet (the office's tick, and the 409 without it). `{language}` is the language's name. */
export const UNREAD_WORDS = Object.freeze({
  it: 'Questo testo in {language} è stato scritto da Claude e non è ancora stato letto dal titolare o da un contatto fidato del cliente: spunta «Invia comunque» per usarlo, oppure scrivi in inglese.',
  en: 'This {language} text was drafted by Claude and has not yet been read by the Owner or a trusted customer contact: tick "Send it anyway" to use it, or write in English.',
})

/** The unread words for a language, in the reader's language. */
export const unreadWords = (language: DraftedLanguage, locale: 'it' | 'en'): string => UNREAD_WORDS[locale].replace('{language}', LANGUAGE_NAMES[language][locale])

export interface MessageLanguageChoice {
  /** The language written to the person: theirs when it is one of the five, else English. */
  readonly language: MessageLanguage
  readonly source: LanguageSource
  /** Their language as kept, when it is none of the five ("pt"); else null. */
  readonly notOffered: string | null
  /** Whether the fixed texts of that language may go out on their own (isLanguageRead). */
  readonly read: boolean
}

const languageCode = (value: string | null | undefined): string | null => {
  const language = (value ?? '').trim().toLowerCase().slice(0, 2)
  return /^[a-z]{2}$/.test(language) ? language : null
}

/** The message language for a contact (or a party without one): the contact's, the party's, the company's; none: Italian. */
export function messageLanguageOf(input: { readonly contact?: string | null; readonly party?: string | null; readonly company?: string | null }): MessageLanguageChoice {
  const candidates: [LanguageSource, string | null][] = [
    ['CONTACT', languageCode(input.contact)],
    ['PARTY', languageCode(input.party)],
    ['COMPANY', languageCode(input.company)],
  ]
  const found = candidates.find(([, language]) => language !== null)
  if (!found) return { language: 'it', source: 'COMPANY', notOffered: null, read: true }
  const [source, code] = found as [LanguageSource, string]
  const language: MessageLanguage = isMessageLanguage(code) ? code : 'en'
  return { language, source, notOffered: isMessageLanguage(code) ? null : code, read: isLanguageRead(language) }
}
// ---- end B-TH-098
