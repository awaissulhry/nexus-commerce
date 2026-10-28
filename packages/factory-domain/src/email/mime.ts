import { encodeHeaderText, formatAddress, mailDate, type MailAddress } from './headers'

/**
 * The raw MIME message SES sends (plan A1 §3.7: "SES v2 API SendEmail with raw MIME (ported MIME builder)"; ported and
 * extended from the old app's apps/factory/src/lib/google/mime.ts), pure: the headers and a multipart/alternative body
 * (plain text and HTML, each UTF-8 in base64); with attachments, a multipart/mixed around it and one base64 part per
 * file (`Content-Disposition: attachment`, the name as an ASCII fallback and RFC 2231 UTF-8). Bcc recipients are never
 * written into it (SES gets them as destinations only). Lines end in CRLF; the boundaries are made from the mail's id
 * and start with `=_`, which base64 never contains, so no part can end one by accident.
 */

/** One file attached to a mail. */
export interface MimeAttachment {
  readonly filename: string
  readonly contentType: string
  readonly content: Uint8Array
}

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
  /** Files attached, in order. */
  readonly attachments?: readonly MimeAttachment[]
}

const wrap76 = (base64: string): string => base64.replace(/(.{76})(?=.)/g, '$1\r\n')
const base64 = (text: string): string => wrap76(Buffer.from(text, 'utf8').toString('base64'))

/** A file name a header may carry: no path, no control characters, no quotes; `attachment` when nothing is left. */
export function attachmentName(value: string): string {
  const name = value
    .replace(/^.*[\\/]/, '')
    .replace(/[\u0000-\u001f\u007f"\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150)
  return name === '' ? 'attachment' : name
}

/** A media type as a header may carry it (`type/subtype`), else application/octet-stream. */
const mediaType = (value: string): string => (/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value.trim()) ? value.trim().toLowerCase() : 'application/octet-stream')

/** The Content-Disposition of an attachment: an ASCII fallback `filename` and, when needed, RFC 2231 `filename*`. */
function disposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_')
  if (ascii === filename) return `attachment; filename="${filename}"`
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${ascii}";\r\n filename*=UTF-8''${encoded}`
}

/** A header line, refusing a line break in its value (a header can never be added through a value). */
function header(name: string, value: string): string {
  if (/[\r\n]/.test(value.replace(/\r\n /g, ''))) throw new Error(`The ${name} header has a line break.`)
  return `${name}: ${value}`
}

export function buildMime(input: MimeInput): string {
  const id = input.id.replace(/[^0-9a-f]/gi, '')
  const alternative = `=_alt_${id}`
  const mixed = `=_mix_${id}`
  const attachments = input.attachments ?? []
  const head = [
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
  ]
  const body = [
    `Content-Type: multipart/alternative; boundary="${alternative}"`,
    '',
    `--${alternative}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64(input.text),
    `--${alternative}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64(input.html),
    `--${alternative}--`,
  ]
  if (attachments.length === 0) return [...head, ...body, ''].join('\r\n')
  const files = attachments.flatMap((file) => {
    const filename = attachmentName(file.filename)
    return [
      `--${mixed}`,
      `Content-Type: ${mediaType(file.contentType)}; name="${filename.replace(/[^\x20-\x7e]/g, '_')}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: ${disposition(filename)}`,
      '',
      wrap76(Buffer.from(file.content).toString('base64')),
    ]
  })
  return [...head, `Content-Type: multipart/mixed; boundary="${mixed}"`, '', `--${mixed}`, ...body, ...files, `--${mixed}--`, ''].join('\r\n')
}
