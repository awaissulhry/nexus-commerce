import { addressDomain, isAddress, normalizeAddress } from '../email/rules'
import { defineMachine } from '../state/machine'
import { isReplyToken } from '../threads/rules'

/**
 * The rules of email in (plan A1 §3.7 "Receiving", "Matching", "Content"; features COL-020, COL-022, COL-023, COL-025,
 * COL-026), pure: the statuses of a received mail, SES's verdicts, how a reply address and a reply's headers are read,
 * who counts as a known sender, and where a mail goes (`sortMail`). apps/factory-api's platform/email-in reads the
 * facts from the database and applies the outcome in one command; the …_email_in_guards trigger holds the invariants
 * for every login.
 */

/**
 * Where a received mail is. RECEIVED (SES said it arrived; the raw mail waits in S3) → FETCHED (read, parsed and
 * sanitised; its attachments are in the file store) → MATCHED (it is a message of a record's thread), TRIAGE (no record
 * found: "mail to sort"), HELD (a record may be found, but a person must look first) or REJECTED (a virus, a duplicate,
 * or a person threw it away). FAILED: the raw mail could not be read (gone, too large, the store did not answer).
 */
export const INBOUND_STATUSES = ['RECEIVED', 'FETCHED', 'MATCHED', 'TRIAGE', 'HELD', 'REJECTED', 'FAILED'] as const
export type InboundStatus = (typeof INBOUND_STATUSES)[number]

export const inboundMachine = defineMachine({
  name: 'inbound mail',
  states: INBOUND_STATUSES,
  transitions: {
    RECEIVED: ['FETCHED', 'REJECTED', 'FAILED'],
    FETCHED: ['MATCHED', 'TRIAGE', 'HELD', 'REJECTED'],
    // A person: assigns it to a record, or throws it away.
    TRIAGE: ['MATCHED', 'REJECTED'],
    // A person: releases it (into the thread it named, else to the triage list), assigns it elsewhere, or throws it away.
    HELD: ['MATCHED', 'TRIAGE', 'REJECTED'],
    FAILED: ['REJECTED'],
  },
})

/** The statuses a person sorts ("mail to sort", A2 SCR-019). */
export const TO_SORT: readonly InboundStatus[] = Object.freeze(['TRIAGE', 'HELD', 'FAILED'])

/** SES's verdicts (receipt notification: spfVerdict, dkimVerdict, dmarcVerdict, spamVerdict, virusVerdict). */
export const MAIL_VERDICTS = ['PASS', 'FAIL', 'GRAY', 'PROCESSING_FAILED', 'DISABLED'] as const
export type MailVerdict = (typeof MAIL_VERDICTS)[number]

/** A verdict as SES wrote it; anything else (missing, a new word) is GRAY: neither a pass nor a fail. */
export function verdictOf(value: unknown): MailVerdict {
  return typeof value === 'string' && (MAIL_VERDICTS as readonly string[]).includes(value) ? (value as MailVerdict) : 'GRAY'
}

/** How a mail found its thread. */
export const MATCHED_BY = ['TOKEN', 'HEADERS', 'SENDER', 'MANUAL'] as const
export type MatchedBy = (typeof MATCHED_BY)[number]

/** Why a mail waits for a person before it may join a thread (COL-022). */
export const HELD_REASONS = ['DMARC_FAIL', 'SPAM', 'UNKNOWN_SENDER', 'THREAD_CLOSED'] as const
export type HeldReason = (typeof HELD_REASONS)[number]

/** Why a mail was thrown away. VIRUS and DUPLICATE: by the worker; MARKED_SPAM and DISCARDED: by a person. */
export const REJECT_REASONS = ['VIRUS', 'DUPLICATE', 'MARKED_SPAM', 'DISCARDED'] as const
export type RejectReason = (typeof REJECT_REASONS)[number]
/** What a person may answer when throwing a mail away. */
export const PERSON_REJECT_REASONS = ['MARKED_SPAM', 'DISCARDED'] as const satisfies readonly RejectReason[]

const MIB = 1_048_576
/** SES receiving takes mail up to 40 MB; nothing larger is read. */
export const MAX_RAW_BYTES = 40 * MIB
/** The most text kept of one mail (the thread message and the triage view). */
export const MAX_INBOUND_TEXT = 100_000
/** The most sanitised HTML kept of one mail; a larger one keeps its text only. */
export const MAX_INBOUND_HTML = 400_000
/** The most attachments kept of one mail (a thread message attaches at most as many); the rest are listed as skipped. */
export const MAX_KEPT_ATTACHMENTS = 20
/** Tries to read the raw mail before it is FAILED. */
export const MAX_FETCH_ATTEMPTS = 5
export const MAX_SUBJECT = 300
const MAX_MESSAGE_ID = 300
const MAX_REFERENCES = 20

/** One attachment of a mail as it was read: kept (in the file store, then a file) or skipped, with why. */
export type InboundAttachment =
  | {
      readonly kept: true
      readonly name: string
      readonly contentType: string
      readonly sizeBytes: number
      readonly sha256: string
      /** The R2 account and key its bytes were put under (never shown). */
      readonly storeAccountId: string
      readonly storageKey: string
      /** The file that holds it (null until the mail is sorted). */
      readonly fileId: string | null
    }
  | {
      readonly kept: false
      readonly name: string
      readonly contentType: string
      readonly sizeBytes: number
      readonly reason: SkipReason
    }

/**
 * Why an attachment was not kept: a type files do not take (nothing a browser would run: HTML, SVG, scripts, archives
 * and executables), larger than a file may be, empty, an inline picture of the HTML (a signature logo), or past the
 * most a message attaches.
 */
export const SKIP_REASONS = ['type_not_allowed', 'too_large', 'empty', 'inline', 'too_many'] as const
export type SkipReason = (typeof SKIP_REASONS)[number]

/** A Message-ID as stored: `<…>`, one line, no space; null when it is not one. */
export function cleanMessageId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  const id = /^<[^<>\s]+>$/.test(trimmed) ? trimmed : /^[^<>\s@]+@[^<>\s@]+$/.test(trimmed) ? `<${trimmed}>` : null
  return id !== null && id.length <= MAX_MESSAGE_ID ? id : null
}

/** The Message-IDs a References or In-Reply-To header names, in order, each once (at most MAX_REFERENCES, the newest). */
export function messageIdsOf(header: string | null | undefined): string[] {
  if (typeof header !== 'string') return []
  const ids = [...header.matchAll(/<[^<>\s]+>/g)].map((match) => cleanMessageId(match[0])).filter((id): id is string => id !== null)
  return [...new Set(ids)].slice(-MAX_REFERENCES)
}

/** A subject as stored: one line, no control characters, at most MAX_SUBJECT characters. */
export function cleanSubject(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const subject = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return subject === '' ? null : subject.slice(0, MAX_SUBJECT)
}

/** A display name as stored: one line, no control characters, at most 200 characters; null when empty. */
export function cleanName(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const name = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return name === '' ? null : name.slice(0, 200)
}

/** The plain addresses of a list (lower case, valid ones only, each once). */
export function addressesOf(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string').map(normalizeAddress).filter(isAddress))]
}

/**
 * The reply tokens of the recipients (COL-020): `r-<token>@<reply domain>`, the token 26 lower-case base32 characters,
 * at one of the tenant's reply domains (an address at another domain names no thread of ours). In the order given,
 * each once: the envelope's recipients first, then To and Cc.
 */
export function replyTokensOf(addresses: readonly string[], replyDomains: readonly string[]): string[] {
  const domains = new Set(replyDomains.map((domain) => domain.trim().toLowerCase()))
  const tokens: string[] = []
  for (const value of addresses) {
    const address = normalizeAddress(value)
    if (!isAddress(address) || !domains.has(addressDomain(address))) continue
    const local = address.slice(0, address.lastIndexOf('@'))
    const token = local.startsWith('r-') ? local.slice(2) : ''
    if (isReplyToken(token) && !tokens.includes(token)) tokens.push(token)
  }
  return tokens
}

/**
 * Free mail and shared domains: an address there says nothing about the company behind it, so the same domain is never
 * a reason to trust a sender (A1 §3.7 "a known party domain") nor to suggest a party.
 */
export const SHARED_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'outlook.it',
  'hotmail.com',
  'hotmail.it',
  'live.com',
  'live.it',
  'msn.com',
  'yahoo.com',
  'yahoo.it',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'libero.it',
  'virgilio.it',
  'tiscali.it',
  'alice.it',
  'tim.it',
  'tin.it',
  'fastwebnet.it',
  'email.it',
  'inwind.it',
  'iol.it',
  'pec.it',
  'legalmail.it',
  'arubapec.it',
  'postecert.it',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'web.de',
  't-online.de',
  'orange.fr',
  'free.fr',
  'laposte.net',
  'proton.me',
  'protonmail.com',
  'mail.com',
  'zoho.com',
  'yandex.com',
])

/** The domain of an address when it can name a company (not a shared mail domain); null otherwise. */
export function companyDomainOf(address: string, shared: ReadonlySet<string> = SHARED_MAIL_DOMAINS): string | null {
  if (!isAddress(address)) return null
  const domain = addressDomain(address)
  return shared.has(domain) ? null : domain
}

/**
 * Whether the sender of a mail that names a thread is someone the thread already knows (A1 §3.7: "a participant or a
 * known party domain"; COL-022: "match a known contact"): a contact of the thread's party, an address the thread's mail
 * went to, or an address at the (company) domain of one of the party's contacts.
 */
export function knownSender(
  sender: string | null,
  known: { readonly contacts: readonly string[]; readonly participants: readonly string[] },
  shared: ReadonlySet<string> = SHARED_MAIL_DOMAINS,
): 'CONTACT' | 'PARTICIPANT' | 'DOMAIN' | null {
  if (sender === null || !isAddress(sender)) return null
  if (known.contacts.includes(sender)) return 'CONTACT'
  if (known.participants.includes(sender)) return 'PARTICIPANT'
  const domain = companyDomainOf(sender, shared)
  if (domain !== null && known.contacts.some((contact) => companyDomainOf(contact, shared) === domain)) return 'DOMAIN'
  return null
}

/** SES's verdicts on one mail. */
export interface Verdicts {
  readonly spf: MailVerdict
  readonly dkim: MailVerdict
  readonly dmarc: MailVerdict
  readonly spam: MailVerdict
  readonly virus: MailVerdict
}

/** What the sorting job found about one mail, read in its tenant. */
export interface SortFacts {
  readonly verdicts: Verdicts
  /** Its Message-ID is already a message of a thread (our own mail coming back, or the same mail again). */
  readonly duplicate: boolean
  /** The thread its reply token (TOKEN) or its In-Reply-To / References (HEADERS) named, if any. */
  readonly thread: { readonly id: string; readonly status: 'OPEN' | 'CLOSED'; readonly partyId: string | null; readonly by: 'TOKEN' | 'HEADERS' } | null
  /** The sender, as the thread knows it (`knownSender`); null when it does not, or there is no thread. */
  readonly senderKnown: 'CONTACT' | 'PARTICIPANT' | 'DOMAIN' | null
  /**
   * Without a thread: the one party the sender is a contact of, and that party's own thread (its record's thread: null
   * when the party has no thread record type yet). Null when the sender is no contact, or one of several parties.
   */
  readonly senderParty: { readonly partyId: string; readonly thread: { readonly id: string | null; readonly status: 'OPEN' | 'CLOSED' } | null } | null
}

/** Where a mail goes. */
export type SortOutcome =
  | { readonly status: 'MATCHED'; readonly by: 'TOKEN' | 'HEADERS' | 'SENDER'; readonly threadId: string | null }
  | { readonly status: 'HELD'; readonly reason: HeldReason; readonly threadId: string | null }
  | { readonly status: 'TRIAGE'; readonly threadId: string | null }
  | { readonly status: 'REJECTED'; readonly reason: RejectReason }

/**
 * Where a mail goes (A1 §3.7 "Matching"; COL-022, COL-023), in this order:
 *   1. a virus (SES's verdict FAIL) → REJECTED; the same Message-ID already in a thread → REJECTED (DUPLICATE);
 *   2. SES's DMARC verdict FAIL → HELD (a forged sender), and a spam verdict FAIL → HELD, whatever matched;
 *   3. a thread named by its reply token, else by In-Reply-To / References against our own mail:
 *        the thread has no party (nobody to share a reply with) → TRIAGE;
 *        the sender is not known to the thread (no contact of its party, not a recipient of its mail, not at a contact's
 *        company domain) → HELD (UNKNOWN_SENDER): a forwarded reply address, or a spoofed "new bank details" mail;
 *        the thread is CLOSED → HELD (THREAD_CLOSED);
 *        else → MATCHED (TOKEN, HEADERS);
 *   4. no thread: the sender is a contact of exactly one party, DMARC passed (the address is all there is to go by), and
 *      the party has a thread (its record's) → MATCHED (SENDER), or HELD when that thread is CLOSED;
 *   5. else → TRIAGE ("mail to sort"; the party, when one is known, is suggested).
 * `threadId` on HELD and TRIAGE is the thread found: a release writes there.
 */
export function sortMail(facts: SortFacts): SortOutcome {
  const { verdicts, thread } = facts
  if (verdicts.virus === 'FAIL') return { status: 'REJECTED', reason: 'VIRUS' }
  if (facts.duplicate) return { status: 'REJECTED', reason: 'DUPLICATE' }
  const found = thread?.id ?? facts.senderParty?.thread?.id ?? null
  if (verdicts.dmarc === 'FAIL') return { status: 'HELD', reason: 'DMARC_FAIL', threadId: found }
  if (verdicts.spam === 'FAIL') return { status: 'HELD', reason: 'SPAM', threadId: found }
  if (thread) {
    if (thread.partyId === null) return { status: 'TRIAGE', threadId: thread.id }
    if (facts.senderKnown === null) return { status: 'HELD', reason: 'UNKNOWN_SENDER', threadId: thread.id }
    if (thread.status === 'CLOSED') return { status: 'HELD', reason: 'THREAD_CLOSED', threadId: thread.id }
    return { status: 'MATCHED', by: thread.by, threadId: thread.id }
  }
  const party = facts.senderParty
  if (party?.thread && verdicts.dmarc === 'PASS') {
    if (party.thread.status === 'CLOSED') return { status: 'HELD', reason: 'THREAD_CLOSED', threadId: party.thread.id }
    return { status: 'MATCHED', by: 'SENDER', threadId: party.thread.id }
  }
  return { status: 'TRIAGE', threadId: null }
}
