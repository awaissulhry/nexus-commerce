/**
 * B-W2b-F58: the Local mailbox page's view model (SCR-007-mailbox): the mails the local test server's FAKE provider kept,
 * newest first, each with its text and the links in it.
 */

export interface MailboxMessage {
  id: string
  /** UTC; shown in the site's zone. */
  sentAt: string
  templateKey: string
  from: string
  to: readonly string[]
  cc: readonly string[]
  bcc: readonly string[]
  subject: string
  text: string
  links: readonly string[]
}

export type LocalMailboxModel = { state: 'ok'; messages: readonly MailboxMessage[] } | { state: 'failed'; code: string }

/** The recipients in one line (to, then cc and bcc named by the view). */
export const addresses = (list: readonly string[]): string => list.join(', ')
