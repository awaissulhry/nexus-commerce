import type { Issue } from '../core/errors'
import { defineMachine } from '../state/machine'

/**
 * The rules of email out (plan A1 §2.3 EmailOutbound, §3.7; features PLT-139, PLT-149, COL-024), pure: the statuses and
 * their machine, the template keys and languages, the recipients' addresses and the suppression check.
 * apps/factory-api's platform/email-out applies them before any write; the …_email_guards trigger holds the same status
 * moves for every login.
 */

export const OUTBOUND_STATUSES = ['QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'BOUNCED', 'COMPLAINED', 'FAILED'] as const
export type OutboundStatus = (typeof OUTBOUND_STATUSES)[number]
export const IDENTITY_KINDS = ['CONVERSATION', 'NOTIFICATION'] as const
export type IdentityKind = (typeof IDENTITY_KINDS)[number]
export const DISPLAY_NAME_POLICIES = ['COMPANY', 'PERSON_VIA_COMPANY', 'PERSON_ADDRESS'] as const
export type DisplayNamePolicy = (typeof DISPLAY_NAME_POLICIES)[number]
export const VERIFICATION_STATUSES = ['NOT_STARTED', 'PENDING', 'SUCCESS', 'FAILED', 'TEMPORARY_FAILURE'] as const
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number]
export const IDENTITY_STATUSES = ['ACTIVE', 'DISABLED'] as const
export type IdentityStatus = (typeof IDENTITY_STATUSES)[number]
export const SUPPRESSION_REASONS = ['BOUNCE', 'COMPLAINT', 'MANUAL'] as const
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number]

/**
 * Where a mail is. QUEUED → SENDING → SENT → DELIVERED; a bounce or a complaint after it was sent (a later notification
 * may only make it worse: SENT → DELIVERED → BOUNCED → COMPLAINED); a failed try goes back to QUEUED for the next one;
 * a refusal (suppressed, no verified identity, out of tries) is FAILED. COMPLAINED and FAILED are final.
 */
export const outboundMachine = defineMachine({
  name: 'emailOutbound',
  states: OUTBOUND_STATUSES,
  transitions: {
    QUEUED: ['SENDING', 'FAILED'],
    SENDING: ['QUEUED', 'SENT', 'FAILED'],
    SENT: ['DELIVERED', 'BOUNCED', 'COMPLAINED'],
    DELIVERED: ['BOUNCED', 'COMPLAINED'],
    BOUNCED: ['COMPLAINED'],
    COMPLAINED: [],
    FAILED: [],
  },
})

/** May a mail move from `from` to `to`? (Staying is not a move.) */
export function canMove(from: OutboundStatus, to: OutboundStatus): boolean {
  return (outboundMachine.transitions[from] ?? []).includes(to)
}

/** How many tries a mail gets before it is FAILED. */
export const MAX_SEND_ATTEMPTS = 5
/** How long a SENDING claim holds before another job may take the mail again. */
export const SEND_CLAIM_MS = 2 * 60_000

/** The templates that make mail (their fixed text: compose.ts). */
export const TEMPLATE_KEYS = ['thread.message', 'auth.invitation', 'auth.password_reset'] as const
export type TemplateKey = (typeof TEMPLATE_KEYS)[number]

/** The languages the fixed text is written in; any other falls back to Italian. */
export const LOCALES = ['it', 'en'] as const
export type Locale = (typeof LOCALES)[number]
export function localeOf(value: string | null | undefined): Locale {
  const base = (value ?? '').toLowerCase().split(/[-_]/)[0]
  return base === 'en' ? 'en' : 'it'
}

/** The most recipients one mail has (to, cc and bcc together) and the longest subject. */
export const MAX_RECIPIENTS = 50
export const MAX_SUBJECT_LENGTH = 200
/** An address's longest length (RFC 5321: 254 in a path). */
export const MAX_ADDRESS_LENGTH = 254

/**
 * A plain address (no display name): a local part of RFC 5322 "atext" dot-atoms (no quoted strings, no comments) and a
 * domain of letters, digits and hyphens with a dot and a top-level label of letters. Deliberately narrower than the
 * RFC: nothing that could carry a header, a second address or a line break gets through.
 */
const LOCAL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** An address as stored and compared: trimmed and lower case. */
export function normalizeAddress(value: string): string {
  return value.trim().toLowerCase()
}

/** A plain, sendable address (already normalized)? */
export function isAddress(value: string): boolean {
  if (value.length === 0 || value.length > MAX_ADDRESS_LENGTH) return false
  const at = value.lastIndexOf('@')
  if (at <= 0 || at !== value.indexOf('@')) return false
  const local = value.slice(0, at)
  const domain = value.slice(at + 1)
  return local.length <= 64 && LOCAL.test(local) && DOMAIN.test(domain)
}

/** A domain name as stored (lower case, no trailing dot), or null when it is not one. */
export function domainOf(value: string): string | null {
  const domain = value.trim().toLowerCase().replace(/\.$/, '')
  return domain.length <= 253 && DOMAIN.test(domain) ? domain : null
}

/** The domain part of an address. */
export function addressDomain(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1)
}

export interface Recipients {
  readonly to: readonly string[]
  readonly cc: readonly string[]
  readonly bcc: readonly string[]
}

/** The recipients normalized, each address once (to wins over cc, cc over bcc), in the order given. */
export function normalizeRecipients(input: { readonly to?: readonly string[]; readonly cc?: readonly string[]; readonly bcc?: readonly string[] }): Recipients {
  const seen = new Set<string>()
  const take = (list: readonly string[] | undefined): string[] =>
    (list ?? []).map(normalizeAddress).filter((address) => {
      if (seen.has(address)) return false
      seen.add(address)
      return true
    })
  const to = take(input.to)
  const cc = take(input.cc)
  const bcc = take(input.bcc)
  return { to, cc, bcc }
}

/** Every recipient, to then cc then bcc. */
export function allRecipients(recipients: Recipients): string[] {
  return [...recipients.to, ...recipients.cc, ...recipients.bcc]
}

/** What is wrong with a mail's recipients (empty: none). Paths are `<at>/to/0` … */
export function recipientProblems(recipients: Recipients, at = 'body'): Issue[] {
  const problems: Issue[] = []
  if (recipients.to.length === 0) problems.push({ path: `${at}/to`, message: 'Name at least one recipient.' })
  if (allRecipients(recipients).length > MAX_RECIPIENTS) problems.push({ path: `${at}/to`, message: `A mail goes to at most ${MAX_RECIPIENTS} addresses.` })
  for (const field of ['to', 'cc', 'bcc'] as const) {
    recipients[field].forEach((address, index) => {
      if (!isAddress(address)) problems.push({ path: `${at}/${field}/${index}`, message: 'Not an email address.' })
    })
  }
  return problems
}

/** A subject as sent: one line, no control characters, trimmed. */
export function cleanSubject(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function subjectProblems(subject: string, at = 'body'): Issue[] {
  if (subject.length === 0) return [{ path: `${at}/subject`, message: 'Write a subject.' }]
  if (subject.length > MAX_SUBJECT_LENGTH) return [{ path: `${at}/subject`, message: `A subject holds at most ${MAX_SUBJECT_LENGTH} characters.` }]
  return []
}

/**
 * The suppression check (PLT-149): the recipients on the list. A mail whose recipients are all suppressed is not sent;
 * one with some suppressed recipients is refused too (the sender takes them out, so nobody believes they got it).
 */
export function suppressedRecipients(recipients: Recipients, suppressed: ReadonlySet<string> | readonly string[]): string[] {
  const set = suppressed instanceof Set ? suppressed : new Set(suppressed as readonly string[])
  return allRecipients(recipients).filter((address) => set.has(address))
}

/** The issues of suppressed recipients, at their paths. */
export function suppressionProblems(recipients: Recipients, suppressed: ReadonlySet<string>, at = 'body'): Issue[] {
  const problems: Issue[] = []
  for (const field of ['to', 'cc', 'bcc'] as const) {
    recipients[field].forEach((address, index) => {
      if (suppressed.has(address)) problems.push({ path: `${at}/${field}/${index}`, message: 'This address bounced or complained before; no mail goes to it.' })
    })
  }
  return problems
}

/** Is an identity ready to send: active, and SES verified the domain and its DKIM records? */
export function identityReady(identity: { readonly status: IdentityStatus; readonly verificationStatus: VerificationStatus; readonly dkimStatus: VerificationStatus }): boolean {
  return identity.status === 'ACTIVE' && identity.verificationStatus === 'SUCCESS' && identity.dkimStatus === 'SUCCESS'
}

/** The order of the states a notification may move a sent mail through (a later one only makes it worse). */
const AFTER_SENDING: readonly OutboundStatus[] = ['SENT', 'DELIVERED', 'BOUNCED', 'COMPLAINED']

/**
 * The status after a notification: the worse of the current one and what it reports. A delivery after a bounce (another
 * recipient) leaves the mail BOUNCED; a notification for a mail that is not sent yet leaves it as it is.
 */
export function statusAfter(current: OutboundStatus, reported: 'DELIVERED' | 'BOUNCED' | 'COMPLAINED'): OutboundStatus {
  const now = AFTER_SENDING.indexOf(current)
  if (now < 0) return current
  return AFTER_SENDING.indexOf(reported) > now ? reported : current
}

/** The text of a failure as stored on the mail: one line, no address, at most 500 characters. */
export function failureText(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '[email]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
}
