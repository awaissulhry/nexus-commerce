import { addressDomain, type DisplayNamePolicy } from './rules'

/**
 * The headers of a mail (plan A1 §3.7 "Sending", "Threading"; feature COL-024: "Outgoing mail shows the staff member's
 * name, uses the record's reply address and correct In-Reply-To and References so it threads in Outlook and Gmail"),
 * pure. Every value that goes into a header is cleaned here first: no line break, no control character, a display name
 * quoted or RFC 2047-encoded, so nothing a person typed can add a header or a recipient.
 */

/** An address with its display name, as a From line shows it. */
export interface MailAddress {
  readonly name: string
  readonly address: string
}

/** What the From line needs of the sending identity. */
export interface IdentityHeaders {
  readonly domain: string
  readonly fromAddress: string
  /** The company's name as mail shows it. */
  readonly displayName: string
  readonly displayNamePolicy: DisplayNamePolicy
}

/** The person who sends (an office user), when a person sends. */
export interface SendingPerson {
  readonly name: string
  /** Their sign-in address; used as From only under PERSON_ADDRESS and at the identity's own domain. */
  readonly email: string | null
}

const MAX_NAME = 120

/** A display name as a header may carry it: one line, no control characters, no quotes or angle brackets. */
export function cleanDisplayName(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f"<>\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME)
}

/**
 * The From line (COL-024, A1 §3.7: staff send as themselves):
 *   COMPANY              "Acme" <noreply@acme.example.com>
 *   PERSON_VIA_COMPANY   "Ada Esempio via Acme" <noreply@acme.example.com>
 *   PERSON_ADDRESS       "Ada Esempio" <ada.esempio@acme.example.com> when the person's own address is at the verified
 *                        domain (SES sends for any address of a verified domain); otherwise as PERSON_VIA_COMPANY.
 * Without a person (the system) every policy is COMPANY.
 */
export function fromLine(identity: IdentityHeaders, person: SendingPerson | null): MailAddress {
  const company = cleanDisplayName(identity.displayName)
  const name = person ? cleanDisplayName(person.name) : ''
  if (!person || name === '' || identity.displayNamePolicy === 'COMPANY') return { name: company, address: identity.fromAddress }
  if (identity.displayNamePolicy === 'PERSON_ADDRESS' && person.email && addressDomain(person.email) === identity.domain) {
    return { name, address: person.email }
  }
  return { name: cleanDisplayName(`${name} via ${company}`), address: identity.fromAddress }
}

/** The record's reply address (COL-020): `r-<thread reply token>@<reply domain>`. */
export function replyAddress(replyToken: string, replyDomain: string): string {
  return `r-${replyToken}@${replyDomain}`
}

/** Our Message-ID, with its angle brackets: `<id@domain>` (the id is the mail's UUID). */
export function messageIdFor(id: string, domain: string): string {
  return `<${id}@${domain}>`
}

/** References keep the thread's first mail and the latest ones: at most this many ids (RFC 5322 §3.6.4 allows trimming). */
export const MAX_REFERENCES = 10

/**
 * In-Reply-To and References of a new mail on a thread, from the Message-IDs of the thread's earlier mail (sent and
 * received), oldest first: In-Reply-To is the latest, References the first plus the latest ones. A first mail has none.
 */
export function threadingOf(earlier: readonly string[]): { readonly inReplyTo: string | null; readonly references: string[] } {
  const ids = earlier.filter((id) => /^<[^<>\s]+>$/.test(id))
  if (ids.length === 0) return { inReplyTo: null, references: [] }
  const references = ids.length <= MAX_REFERENCES ? [...ids] : [ids[0]!, ...ids.slice(ids.length - (MAX_REFERENCES - 1))]
  return { inReplyTo: ids[ids.length - 1]!, references }
}

/** "Re: <subject>" exactly once (ported from the old app's mime.ts): a reply keeps the thread's subject. */
export function replySubject(original: string): string {
  const subject = original.trim()
  return /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`
}

const PRINTABLE = /^[\x20-\x7e]*$/

/** RFC 2047 encoded words (UTF-8, base64) for a header text that is not plain ASCII, folded between words. */
export function encodeHeaderText(value: string): string {
  if (PRINTABLE.test(value)) return value
  const words: string[] = []
  let chunk = ''
  for (const char of value) {
    // At most 45 bytes per word: its encoded form stays under the 75-character limit of an encoded word.
    if (Buffer.byteLength(chunk + char, 'utf8') > 45) {
      words.push(chunk)
      chunk = ''
    }
    chunk += char
  }
  if (chunk) words.push(chunk)
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`).join('\r\n ')
}

/** An address with its name for a header: `"Ada Esempio" <ada@acme.example.com>`, or encoded words when it is not ASCII. */
export function formatAddress(address: MailAddress): string {
  const name = cleanDisplayName(address.name)
  if (name === '') return address.address
  return PRINTABLE.test(name) ? `"${name}" <${address.address}>` : `${encodeHeaderText(name)} <${address.address}>`
}

/** An RFC 5322 date (`Wed, 28 Oct 2026 09:00:00 +0000`). */
export function mailDate(instant: Date): string {
  return instant.toUTCString().replace(/GMT$/, '+0000')
}
