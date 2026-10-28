import { encodeHeaderText, formatAddress, mailDate, type MailAddress } from './headers'

/**
 * The raw MIME message SES sends (plan A1 §3.7: "SES v2 API SendEmail with raw MIME (ported MIME builder)"; ported and
 * extended from the old app's apps/factory/src/lib/google/mime.ts), pure: the headers and a multipart/alternative body
 * (plain text and HTML, each UTF-8 in base64). Bcc recipients are never written into it (SES gets them as
 * destinations only). Lines end in CRLF; the boundary is made from the mail's id and starts with `=_`, which base64
 * never contains, so no part can end it by accident.
 */

export interface MimeInput {
  /** The mail's UUID (its Message-ID's left part): the boundary is made from it. */
  readonly id: string
  readonly from: MailAddress
  readonly to: readonly string[]
  readonly cc: readonly string[]
  /** The record's reply address; null for a mail nobody answers (sign-in mail). */
  readonly replyTo: string | null
  readonly subject: string
  /** `<id@domain>`. */
  readonly messageId: string
  readonly inReplyTo: string | null
  readonly references: readonly string[]
  readonly date: Date
  readonly text: string
  readonly html: string
  /** A mail no person wrote (sign-in, notifications): `Auto-Submitted: auto-generated` (RFC 3834), so replies stay away. */
  readonly automatic: boolean
}

const wrap76 = (base64: string): string => base64.replace(/(.{76})(?=.)/g, '$1\r\n')
const base64 = (text: string): string => wrap76(Buffer.from(text, 'utf8').toString('base64'))

/** A header line, refusing a line break in its value (a header can never be added through a value). */
function header(name: string, value: string): string {
  if (/[\r\n]/.test(value.replace(/\r\n /g, ''))) throw new Error(`The ${name} header has a line break.`)
  return `${name}: ${value}`
}

export function buildMime(input: MimeInput): string {
  const boundary = `=_alt_${input.id.replace(/[^0-9a-f]/gi, '')}`
  const lines = [
    header('From', formatAddress(input.from)),
    header('To', input.to.join(', ')),
    ...(input.cc.length > 0 ? [header('Cc', input.cc.join(', '))] : []),
    ...(input.replyTo ? [header('Reply-To', input.replyTo)] : []),
    header('Subject', encodeHeaderText(input.subject)),
    header('Date', mailDate(input.date)),
    header('Message-ID', input.messageId),
    ...(input.inReplyTo ? [header('In-Reply-To', input.inReplyTo)] : []),
    ...(input.references.length > 0 ? [header('References', input.references.join('\r\n '))] : []),
    ...(input.automatic ? [header('Auto-Submitted', 'auto-generated')] : []),
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64(input.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64(input.html),
    `--${boundary}--`,
    '',
  ]
  return lines.join('\r\n')
}
