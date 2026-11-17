import type { BusinessDate } from '../../core/time'
import type { Issue } from '../../core/errors'

/**
 * The customer's request from the portal (B-TH-010; threads plan G1, design P-CUS-NEW "Order like an e-mail"), pure. A
 * customer's portal person writes what it needs in its own words (a subject, optional; the message, up to 20 000 characters),
 * with its PO, the day it wants the goods and where they go, all optional; the API makes it an Inquiry of the session's
 * company and party (source PORTAL, numbered INQ-… in the office's scope) whose request is the customer's words as written,
 * and the words are the first message of the request's thread (INBOUND, PORTAL), which the office cannot edit.
 *
 * The subject has no column of its own: it is the request's first line ("Empty subject: the first line is used", P-CUS-NEW.head),
 * so the office's list summary (its first line) and the customer's receipt say the same subject.
 */

export interface Words {
  readonly it: string
  readonly en: string
}

export const PORTAL_REQUEST_LIMITS = Object.freeze({ subject: 200, message: 20_000, customerRef: 100, request: 20_000 })

const ELLIPSIS = '…'
const firstLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '') ?? ''
const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}${ELLIPSIS}`)

/** The subject used: the one typed (trimmed), else the message's first line; at most 200 characters, cut with "…". */
export function subjectOf(subject: string | null | undefined, message: string): string {
  const typed = (subject ?? '').trim()
  return cut(typed !== '' ? typed : firstLine(message), PORTAL_REQUEST_LIMITS.subject)
}

/**
 * The request as the office reads it: the customer's message as written, after its subject as the first line when a subject
 * was typed and the message does not already start with it.
 */
export function requestTextOf(subject: string | null | undefined, message: string): string {
  const typed = (subject ?? '').trim()
  const body = message.replace(/\s+$/, '')
  if (typed === '' || firstLine(body) === typed) return body
  return `${typed}\n\n${body}`
}

/** What holds a request in words (each with the field's path), before anything is written. */
export function requestProblems(input: { readonly subject?: string | null; readonly message: string; readonly wantedDate?: string | null }, today: BusinessDate): Issue[] {
  const problems: Issue[] = []
  if (input.message.trim() === '') problems.push({ path: 'body/message', message: 'Write what you need.' })
  else if (requestTextOf(input.subject, input.message).length > PORTAL_REQUEST_LIMITS.request) problems.push({ path: 'body/message', message: 'The subject and the message are 20 000 characters at most together.' })
  if (input.wantedDate && input.wantedDate < today) problems.push({ path: 'body/wantedDate', message: 'The day you want the goods is today or later.' })
  return problems
}

/** The neutral refusal of a request the portal cannot take now (no request numbering for the company: B-TH-012). */
export const PORTAL_REQUESTS_CLOSED = (company: string): Words => ({
  en: `Orders by portal are not open yet for ${company} — please write to your contact.`,
  it: `Gli ordini dal portale non sono ancora aperti per ${company}: scrivete al vostro referente.`,
})
