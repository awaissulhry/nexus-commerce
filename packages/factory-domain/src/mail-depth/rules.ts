import type { Issue } from '../core/errors'
import { addressDomain, isAddress, normalizeAddress, type OutboundStatus } from '../email/rules'
import { isReplyToken } from '../threads/rules'

/**
 * Mail in depth (B-W2b-394; COL-021 the capture address for forwarded mail, COL-027 shared team inboxes, COL-031 the delivery
 * status of each message; follow-ups ML1:01-03), pure. apps/factory-api's platform/email-in/{capture,team-inbox} and
 * platform/email-out/delivery-status apply them; factory-db's notify-depth.prisma (B-W2b-366) holds the rows and its
 * …_notify_depth_w2b_guards triggers repeat the invariants for every login. Every refusal is said here FIRST, in words.
 *
 *   capture address   `c-<token>@<reply domain>`, one live per company: staff forward or BCC a mail to it; the factory never
 *                     reads a staff mailbox (Statuto dei Lavoratori art. 4). A forwarded mail is matched to the customer or
 *                     supplier who first wrote it, a BCC'd one to the people it went to, and to the record its subject names.
 *   team inbox        `<local part>@<reply domain>` (orders@, quotes@): its members take a mail (it leaves the queue for the
 *                     others), close it when done, snooze it, or ask for a follow-up that cancels itself when the partner
 *                     answers in the record's thread (the database clears it).
 *   delivery state    each mail we sent says where it is: waiting, sent, delivered, not delivered for now (a soft bounce), bounced,
 *                     complained, failed; a bounce makes a task for the person who sent it.
 */

// ---- addresses ----------------------------------------------------------------------------------------------------------

/** The local part of a capture address starts with this (a reply address starts with `r-`). */
export const CAPTURE_PREFIX = 'c-'

/** A capture address of a token at a reply domain. */
export const captureAddressOf = (token: string, replyDomain: string): string => `${CAPTURE_PREFIX}${token}@${replyDomain.trim().toLowerCase()}`

/**
 * The capture tokens among the recipients: `c-<token>@<a reply domain of the tenant>`, the token 26 lower-case base32 characters,
 * in the order given, each once.
 */
export function captureTokensOf(addresses: readonly string[], replyDomains: readonly string[]): string[] {
  const domains = new Set(replyDomains.map((domain) => domain.trim().toLowerCase()))
  const tokens: string[] = []
  for (const value of addresses) {
    const address = normalizeAddress(value)
    if (!isAddress(address) || !domains.has(addressDomain(address))) continue
    const local = address.slice(0, address.lastIndexOf('@'))
    const token = local.startsWith(CAPTURE_PREFIX) ? local.slice(CAPTURE_PREFIX.length) : ''
    if (isReplyToken(token) && !tokens.includes(token)) tokens.push(token)
  }
  return tokens
}

// ---- team inboxes -------------------------------------------------------------------------------------------------------

export const TEAM_INBOX_LIMITS = Object.freeze({ name: 100, members: 200, perCompany: 50 })
const LOCAL_PART = /^[a-z0-9][a-z0-9._+-]{0,63}$/

/** What is wrong with a team inbox's local part (`orders` of orders@…), or null. */
export function localPartProblem(value: string): string | null {
  if (!LOCAL_PART.test(value)) return 'The address before the @: lower-case letters, digits, dots, dashes, plus or underscore, starting with a letter or digit, at most 64.'
  if (value.startsWith('r-') || value.startsWith(CAPTURE_PREFIX)) return 'An address starting with r- or c- is kept for reply and capture addresses.'
  return null
}

/** What is wrong with a team inbox's name (one line, 1 to 100 characters), or null. */
export function inboxNameProblem(value: string): string | null {
  const name = value.trim()
  if (name.length === 0 || name.length > TEAM_INBOX_LIMITS.name || /[\r\n]/.test(value)) return 'A name of one line, 1 to 100 characters.'
  return null
}

/**
 * The team inbox the recipients name: the first `<local part>@<domain>` whose domain is one of the company's reply domains and
 * whose local part is a switched-on inbox of it (the envelope's recipients first: a BCC is only there). Null: none.
 */
export function teamInboxOf(addresses: readonly string[], replyDomains: readonly string[], inboxes: readonly { readonly id: string; readonly localPart: string; readonly active: boolean }[]): string | null {
  const domains = new Set(replyDomains.map((domain) => domain.trim().toLowerCase()))
  for (const value of addresses) {
    const address = normalizeAddress(value)
    if (!isAddress(address) || !domains.has(addressDomain(address))) continue
    const local = address.slice(0, address.lastIndexOf('@'))
    const inbox = inboxes.find((entry) => entry.active && entry.localPart === local)
    if (inbox) return inbox.id
  }
  return null
}

/**
 * The queue's views (design home.mail "Team inboxes"): OPEN (not closed, not snoozed now), MINE (open and mine), UNASSIGNED
 * (open, nobody has it), SNOOZED (snoozed until later), FOLLOW_UP (a follow-up waits for the partner), CLOSED, ALL.
 */
export const QUEUE_VIEWS = ['OPEN', 'MINE', 'UNASSIGNED', 'SNOOZED', 'FOLLOW_UP', 'CLOSED', 'ALL'] as const
export type QueueView = (typeof QUEUE_VIEWS)[number]

/** Where a team-inbox mail is for its people now. */
export const WORK_STATES = ['OPEN', 'SNOOZED', 'CLOSED'] as const
export type WorkState = (typeof WORK_STATES)[number]

export interface WorkFacts {
  readonly closedAt: Date | null
  readonly snoozedUntil: Date | null
  readonly followUpUntil: Date | null
}

/** A mail's state: closed wins; a snooze in the future hides it; otherwise open (a snooze that passed is over by itself). */
export function workStateOf(mail: WorkFacts, now: Date): WorkState {
  if (mail.closedAt !== null) return 'CLOSED'
  if (mail.snoozedUntil !== null && mail.snoozedUntil.getTime() > now.getTime()) return 'SNOOZED'
  return 'OPEN'
}

/** The longest a mail is snoozed or a follow-up waits, and the shortest. */
export const WORK_LIMITS = Object.freeze({ maxDays: 90, minMinutes: 5 })

/** What is wrong with a snooze or follow-up time, or null: at least 5 minutes ahead, at most 90 days. */
export function untilProblem(until: Date, now: Date): string | null {
  const ahead = until.getTime() - now.getTime()
  if (ahead < WORK_LIMITS.minMinutes * 60_000) return 'A time at least 5 minutes from now.'
  if (ahead > WORK_LIMITS.maxDays * 86_400_000) return 'A time within 90 days.'
  return null
}

/** The changes a team-inbox mail goes through (the event's `change`). */
export const WORK_CHANGES = ['ROUTED', 'CAPTURED', 'ASSIGNED', 'UNASSIGNED', 'CLOSED', 'REOPENED', 'SNOOZED', 'WOKEN', 'FOLLOW_UP_SET', 'FOLLOW_UP_CLEARED', 'FOLLOW_UP_DUE', 'MOVED'] as const
export type WorkChange = (typeof WORK_CHANGES)[number]

/** A mail an action cannot touch, in words; null: it may. A REJECTED mail changes no more (the guard's rule too). */
export function workRefusal(mail: { readonly status: string; readonly teamInboxId: string | null }): string | null {
  if (mail.status === 'REJECTED') return 'This mail was thrown away; it changes no more.'
  if (mail.teamInboxId === null) return 'This mail is in no team inbox: put it in one first.'
  return null
}

// ---- the capture address's matching -------------------------------------------------------------------------------------

/** The line a mail client puts before a forwarded mail. */
const FORWARD_MARKER = /^[\s>]*(?:-{2,}\s*(?:forwarded message|messaggio inoltrato|message transféré|weitergeleitete nachricht|mensaje reenviado|original message|messaggio originale)\s*-{2,}|_{5,}|-{5,}\s*$|begin forwarded message:)/i
/** A header line of the forwarded mail that names its sender. */
const FROM_LINE = /^[\s>*]*(?:from|da|de|von|mittente)\s*:\s*(.+)$/i
const ANGLE = /<\s*([^<>\s]+@[^<>\s]+)\s*>/
const BARE = /([^\s<>"'(),;:]+@[^\s<>"'(),;:]+)/

/** The subject without its forward or reply prefixes ("Fwd: Re: ordine 42" → "ordine 42"). */
export function plainSubject(subject: string | null | undefined): string {
  let text = (subject ?? '').trim()
  for (let round = 0; round < 5; round += 1) {
    const next = text.replace(/^\s*(?:fwd?|fw|i|inoltro|tr|wg|rv|re|r|aw|sv|ris)\s*:\s*/i, '')
    if (next === text) break
    text = next
  }
  return text
}

/**
 * The forwarded mail inside a text: where it starts (the forward marker, else the first "From:" header line of a quoted mail)
 * and who wrote it (the address of that "From:" line, lower case; its name when it has one). Null: no forwarded mail found.
 */
export function forwardedOf(text: string | null | undefined): { readonly start: number; readonly address: string; readonly name: string | null } | null {
  if (typeof text !== 'string' || text.trim() === '') return null
  const lines = text.split(/\r?\n/)
  const marker = lines.findIndex((line) => FORWARD_MARKER.test(line))
  const from = lines.findIndex((line, index) => index >= Math.max(marker, 0) && FROM_LINE.test(line))
  if (from < 0) return null
  // A "From:" line far below the marker belongs to something else (a signature, a quoted reply): the header block follows it.
  if (marker >= 0 && from - marker > 4) return null
  const value = FROM_LINE.exec(lines[from]!)![1]!.trim()
  const found = ANGLE.exec(value) ?? BARE.exec(value)
  const address = found ? normalizeAddress(found[1]!) : ''
  if (!isAddress(address)) return null
  const name = value.replace(ANGLE, '').replace(/["']/g, '').trim()
  const startLine = marker >= 0 ? marker : from
  const start = lines.slice(0, startLine).reduce((sum, line) => sum + line.length + 1, 0)
  return { start, address, name: name === '' || name.includes('@') ? null : name.slice(0, 200) }
}

/** The forwarded part of a text (from its marker), what the partner wrote; the staff's own words above it stay out. */
export function forwardedTextOf(text: string, start: number): string {
  return text.slice(start).replace(/^\s+/, '').slice(0, 100_000)
}

const NUMBER_TOKEN = /[A-Za-z0-9][A-Za-z0-9/_.-]*[0-9][A-Za-z0-9/_.-]*/g

/** The record numbers a subject may name ("Re: SO-2026-00042 sizes" → SO-2026-00042), upper case, each once, at most 10. */
export function recordNumbersIn(subject: string | null | undefined): string[] {
  const text = plainSubject(subject)
  const tokens = [...text.matchAll(NUMBER_TOKEN)].map((match) => match[0].replace(/[._/-]+$/, '').toUpperCase()).filter((token) => token.length >= 4 && token.length <= 40 && /[A-Z]/.test(token))
  return [...new Set(tokens)].slice(0, 10)
}

/** How a mail came to the capture address (the audit row says it): forwarded (in To or Cc), or copied (BCC) on our own mail. */
export type CaptureKind = 'FORWARDED' | 'COPIED'

// ---- delivery status ----------------------------------------------------------------------------------------------------

/** What a bounce was (EmailOutbound.bounceKind): PERMANENT (the address does not exist), TRANSIENT (a full mailbox, too large), UNDETERMINED. */
export const BOUNCE_KINDS = ['PERMANENT', 'TRANSIENT', 'UNDETERMINED'] as const
export type BounceKind = (typeof BOUNCE_KINDS)[number]

/** SES's bounce type as a bounce kind. */
export function bounceKindOf(type: string): BounceKind {
  if (type === 'Permanent') return 'PERMANENT'
  if (type === 'Transient') return 'TRANSIENT'
  return 'UNDETERMINED'
}

/**
 * Where a mail we sent is, for the person who reads its thread (COL-031; design shell.preview "Queued → Sent → Delivered /
 * Bounced"): WAITING (queued or being sent), SENT, DELIVERED, SOFT_BOUNCE (not delivered for now: the receiving server said
 * a full mailbox, too large, or could not decide), BOUNCED (the address does not take mail), COMPLAINED, FAILED (never left).
 */
export const DELIVERY_STATES = ['WAITING', 'SENT', 'DELIVERED', 'SOFT_BOUNCE', 'BOUNCED', 'COMPLAINED', 'FAILED'] as const
export type DeliveryState = (typeof DELIVERY_STATES)[number]

export function deliveryStateOf(status: OutboundStatus, bounceKind: BounceKind | null): DeliveryState {
  if (status === 'QUEUED' || status === 'SENDING') return 'WAITING'
  if (status === 'SENT') return bounceKind === 'TRANSIENT' || bounceKind === 'UNDETERMINED' ? 'SOFT_BOUNCE' : 'SENT'
  return status
}

/** The task a bounce makes for the person who sent the mail, in their language (the task keeps its words as made). */
export function bounceTaskWords(locale: string | null | undefined, facts: { readonly kind: BounceKind; readonly subject: string; readonly record: string | null }): { readonly title: string; readonly description: string } {
  const subject = facts.subject.slice(0, 120)
  const english = (locale ?? '').toLowerCase().startsWith('en')
  const where = facts.record ? (english ? ` (${facts.record})` : ` (${facts.record})`) : ''
  if (facts.kind === 'PERMANENT') {
    return english
      ? { title: `Mail bounced: ${subject}${where}`.slice(0, 200), description: 'The receiving server says the address does not take mail; it is blocked for every later mail. Check the address with the customer or supplier, correct the contact, and send the mail again.' }
      : { title: `Mail respinta: ${subject}${where}`.slice(0, 200), description: "Il server di destinazione dice che l'indirizzo non riceve posta; è bloccato per ogni mail successiva. Verifica l'indirizzo con il cliente o il fornitore, correggi il contatto e invia di nuovo la mail." }
  }
  return english
    ? { title: `Mail not delivered: ${subject}${where}`.slice(0, 200), description: 'The receiving server did not take the mail for now (a full mailbox, a message too large, or a temporary refusal). Send it again later, or reach them another way.' }
    : { title: `Mail non consegnata: ${subject}${where}`.slice(0, 200), description: 'Il server di destinazione per ora non ha accettato la mail (casella piena, messaggio troppo grande o rifiuto temporaneo). Inviala di nuovo più tardi, oppure contattali in un altro modo.' }
}

// ---- inquiry addresses (ML1:02) -----------------------------------------------------------------------------------------

export const INQUIRY_ADDRESS_LIMIT = 20

/** What is wrong with a list of inquiry addresses (lower case, each once, at most 20, each at most 254). */
export function inquiryAddressProblems(addresses: readonly string[], path = 'body/addresses'): Issue[] {
  const problems: Issue[] = []
  if (addresses.length > INQUIRY_ADDRESS_LIMIT) problems.push({ path, message: `At most ${INQUIRY_ADDRESS_LIMIT} addresses.` })
  const seen = new Set<string>()
  addresses.forEach((value, index) => {
    const address = normalizeAddress(value)
    if (!isAddress(address) || address.length > 254 || !/^[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(address)) problems.push({ path: `${path}/${index}`, message: 'An e-mail address.' })
    else if (seen.has(address)) problems.push({ path: `${path}/${index}`, message: 'Each address once.' })
    seen.add(address)
  })
  return problems
}

/** The inquiry address among the recipients, if any (the first). */
export function inquiryAddressIn(recipients: readonly string[], addresses: readonly string[]): string | null {
  const wanted = new Set(addresses.map(normalizeAddress))
  return recipients.map(normalizeAddress).find((address) => wanted.has(address)) ?? null
}

// ---- the FAKE SES account's webhook secret (ML1:01) ----------------------------------------------------------------------

export const WEBHOOK_SECRET_LIMITS = Object.freeze({ min: 32, max: 256 })

/** What is wrong with a typed webhook secret, or null: 32 to 256 printable characters without spaces. */
export function webhookSecretProblem(value: string): string | null {
  if (value.length < WEBHOOK_SECRET_LIMITS.min || value.length > WEBHOOK_SECRET_LIMITS.max || !/^[\x21-\x7e]+$/.test(value)) return 'A secret of 32 to 256 printable characters, without spaces.'
  return null
}

/** The last four characters a saved secret is recognised by ("ends in …4F2A"). */
export const secretEndOf = (value: string): string => value.slice(-4)

// ---- the database's own refusals ----------------------------------------------------------------------------------------

/**
 * The words of a refusal of B-W2b-366's guards a route of this step may reach in a race (check_violation messages that start
 * `email-in: `, `email: ` or `sales: `), sentence-cased; null: not one of them.
 */
export function guardRefusalWords(message: string): string | null {
  const prefix = ['email-in: ', 'email: ', 'sales: '].find((start) => message.startsWith(start))
  if (!prefix) return null
  const words = message.slice(prefix.length).trim()
  return words === '' ? null : `${words.charAt(0).toUpperCase()}${words.slice(1)}${/[.!?]$/.test(words) ? '' : '.'}`
}
