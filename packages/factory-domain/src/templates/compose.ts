import { escapeHtml } from '../email/footer'
import type { MailWords } from './mail'

/**
 * th-backend-g step 2 (threads plan TH-6/TH-9; B-TH-279 "the new mail templates are read"): a mail made of a template's filled words —
 * the request's receipt (request.received) and the portal's new-message mail (thread.message_posted) — as plain text and HTML, ended by
 * the lines the sender adds (the portal's "Manage e-mails" and unsubscribe links, the company's legal footer). The words are the
 * company's version in use or the code's; every character a person wrote is escaped, and no link in the words is made live (the
 * text says the address). Composed in memory: the body is never stored. Pure.
 */

export interface ComposedWordsMail {
  readonly subject: string
  readonly text: string
  readonly html: string
}

/** The end of a mail: its text lines (after a blank line) and its HTML. */
export interface MailEnd {
  readonly text: readonly string[]
  readonly html: string
}

export const SUBJECT_MAX = 200

/** A filled body as HTML: a paragraph at each blank line, its line breaks kept, every character escaped. */
export function wordsHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => `<p>${part.split('\n').map(escapeHtml).join('<br>')}</p>`)
    .join('')
}

/** The mail of a template's filled words, the subject on one line (at most 200 characters), with the sender's end. */
export function composeWordsMail(words: MailWords, end: MailEnd): ComposedWordsMail {
  const subject = words.subject.replace(/\s+/g, ' ').trim().slice(0, SUBJECT_MAX)
  return { subject, text: [words.body, ...end.text].join('\n'), html: wordsHtml(words.body) + end.html }
}
