import type { Issue } from '../../core/errors'
import { MAX_ATTACHMENTS, MAX_BODY_LENGTH, type MessageDirection, type ThreadStatus } from '../rules'

/**
 * A record's thread as a partner sees it in the portal (B-W2b-168; COL-059, COL-060; design portal.frame › thread "Ask a
 * question / Messages"). Pure: apps/factory-api's platform/threads/partner applies these rules; the database holds the
 * wall underneath (a partner session reads only the messages shared with its party, and its insert is held to a portal
 * post of its own party: INBOUND, PARTNER, PORTAL, PARTY — the …_portal_frame_w2b_guards trigger).
 *
 *   - What the partner reads: the messages shared with its party (OUTBOUND: what we sent, by mail or otherwise; INBOUND:
 *     what it answered, by mail or in the portal), never an internal note; each with the files the partner may see.
 *   - Who wrote it, as the partner reads it: our side (`COMPANY`: a person of the company by name, or the company itself
 *     for a message the system wrote) or theirs (`PARTNER`: the person's name; `mine` when it is the reader's own post).
 *   - One thread per record whichever way the partner answers (COL-060): a reply to our mail lands through the thread's
 *     reply address (email-in), a portal post is written into the same thread; the composer says so when our mail of that
 *     thread carries the reply address.
 *   - Who may write: a portal person whose access holds `portal.comment` (COL-062: "can comment"), while the thread is
 *     open, outside an office preview. A post to a CLOSED thread is refused in words (the email step HOLDS a mail to a
 *     closed thread for a person to sort; the portal says so at once instead). A link session reads but does not post
 *     here (B-W2b-200 decides for the record-invite link).
 */

/** Who wrote a shared message, as the partner reads it. */
export const PARTNER_SIDES = ['COMPANY', 'PARTNER'] as const
export type PartnerSide = (typeof PARTNER_SIDES)[number]

/** Our side for what we sent (OUTBOUND), theirs for what they answered (INBOUND). An internal note never reaches here. */
export function sideOf(direction: MessageDirection): PartnerSide {
  if (direction === 'INTERNAL_NOTE') throw new Error('An internal note is never shown to a partner.')
  return direction === 'OUTBOUND' ? 'COMPANY' : 'PARTNER'
}

/** Why the composer is not offered (null: the person may write). */
export const COMPOSER_REASONS = ['PREVIEW', 'NO_COMMENT', 'CLOSED'] as const
export type ComposerReason = (typeof COMPOSER_REASONS)[number]

export interface ComposerFacts {
  /** The thread's status, or null when the record has no thread yet (the first post makes it). */
  readonly threadStatus: ThreadStatus | null
  /** The person's access holds portal.comment over the record (COL-062). */
  readonly mayComment: boolean
  /** An office person previewing the portal (read-only, B-W2b-162). */
  readonly preview: boolean
}

/** Whether the person may write on the record's thread now, and if not why (the first reason that holds). */
export function composerOf(facts: ComposerFacts): { readonly canPost: boolean; readonly reason: ComposerReason | null } {
  if (facts.preview) return { canPost: false, reason: 'PREVIEW' }
  if (!facts.mayComment) return { canPost: false, reason: 'NO_COMMENT' }
  if (facts.threadStatus === 'CLOSED') return { canPost: false, reason: 'CLOSED' }
  return { canPost: true, reason: null }
}

export const PARTNER_THREAD_LOCALES = ['it', 'en'] as const
export type PartnerThreadLocale = (typeof PARTNER_THREAD_LOCALES)[number]

/** The portal's words for the composer's state, in Italian and English (`{company}`: the company's name). */
export const PARTNER_THREAD_WORDS = Object.freeze({
  PREVIEW: { it: "Questa è un'anteprima del portale: sola lettura.", en: 'This is a preview of the portal: it is read-only.' },
  NO_COMMENT: {
    it: 'Il tuo accesso permette di leggere questa conversazione, non di scrivere. Il tuo amministratore può cambiarlo.',
    en: 'Your access lets you read this conversation, not write in it. Your admin can change that.',
  },
  CLOSED: {
    it: '{company} ha chiuso questa conversazione: non si possono aggiungere messaggi.',
    en: '{company} closed this conversation: no new message can be added.',
  },
  REPLY_BY_EMAIL: {
    it: 'Puoi anche rispondere alle nostre e-mail: la risposta arriva qui.',
    en: 'You can also answer our e-mails: your reply lands here.',
  },
} satisfies Record<ComposerReason | 'REPLY_BY_EMAIL', Record<PartnerThreadLocale, string>>)

export type PartnerThreadWord = keyof typeof PARTNER_THREAD_WORDS

/** The person's language for the portal's words: Italian unless English. */
export const partnerLocaleOf = (locale: string | null | undefined): PartnerThreadLocale => (locale === 'en' ? 'en' : 'it')

/** One of the words in the person's language, `{company}` filled in. */
export function partnerThreadWords(word: PartnerThreadWord, locale: string | null | undefined, company: string): string {
  return PARTNER_THREAD_WORDS[word][partnerLocaleOf(locale)].replaceAll('{company}', company)
}

export interface PostDraft {
  /** Already cleaned (threads/rules `cleanBody`). */
  readonly bodyText: string
  /** Files of the record (each once). */
  readonly attachments: readonly string[]
}

/** The problems of a portal post before it is written (empty when it may be posted). */
export function postProblems(draft: PostDraft, at = 'body'): Issue[] {
  const problems: Issue[] = []
  if (draft.bodyText.length === 0 && draft.attachments.length === 0) problems.push({ path: `${at}/body`, message: 'Write something, or attach a file.' })
  if (draft.bodyText.length > MAX_BODY_LENGTH) problems.push({ path: `${at}/body`, message: `A message holds at most ${MAX_BODY_LENGTH} characters.` })
  if (draft.attachments.length > MAX_ATTACHMENTS) problems.push({ path: `${at}/attachments`, message: `A message attaches at most ${MAX_ATTACHMENTS} files.` })
  return problems
}

/** The conversations list of the portal (newest first): a page and the most one page holds. */
export const PARTNER_THREADS_PAGE = 20
export const PARTNER_THREADS_MAX = 50
/** How many of the party's newest shared messages the list reads to find its conversations. */
export const PARTNER_THREADS_SCAN = 500
