import { createHash } from 'node:crypto'
import PostalMime from 'postal-mime'
import { addressesOf, cleanMessageId, cleanName, cleanSubject, MAX_KEPT_ATTACHMENTS, messageIdsOf, type SkipReason } from '@nexus/factory-domain/email-in/rules'
import { cleanInboundText, sanitiseMailHtml, textOfHtml } from '@nexus/factory-domain/email-in/sanitise'
import { cleanFileName, KIND_RULES, normaliseContentType } from '../files/rules'
import { mailboxesOf } from './notification'

/**
 * Reading a raw mail (plan A1 §3.7 "Content"; COL-025, COL-026), in the worker, outside any transaction: postal-mime
 * parses the RFC 5322 bytes (MIME parts, encodings, RFC 2047 words); the HTML is sanitised and the text kept
 * (factory-domain email-in/sanitise); the headers the sorting needs are cleaned; each attachment is either kept (an
 * ATTACHMENT file may hold its type and size: platform/files rules) or listed as skipped with why. Nothing here touches
 * the database or the network.
 */

/** An attachment to keep: its bytes go to the file store. */
export interface KeptPart {
  readonly name: string
  readonly contentType: string
  readonly body: Buffer
  readonly sha256: string
}

export interface SkippedPart {
  readonly name: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly reason: SkipReason
}

export interface ParsedMail {
  readonly from: { readonly address: string | null; readonly name: string | null }
  readonly to: readonly string[]
  readonly cc: readonly string[]
  readonly subject: string | null
  readonly emailMessageId: string | null
  readonly inReplyTo: string | null
  readonly referenceIds: readonly string[]
  readonly text: string
  readonly html: string | null
  /** In the mail's order: each kept or skipped. */
  readonly parts: readonly ({ readonly kept: true; readonly part: KeptPart } | { readonly kept: false; readonly part: SkippedPart })[]
}

const ATTACHMENT = KIND_RULES.ATTACHMENT

/** A type the sender left generic (`application/octet-stream`), told by its first bytes when they are unmistakable. */
function sniffedType(declared: string, body: Buffer): string {
  if (declared !== 'application/octet-stream' && declared !== '') return declared
  if (body.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf'
  if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg'
  return declared
}

const bytesOf = (content: ArrayBuffer | Uint8Array | string): Buffer =>
  typeof content === 'string' ? Buffer.from(content, 'utf8') : content instanceof Uint8Array ? Buffer.from(content.buffer, content.byteOffset, content.byteLength) : Buffer.from(new Uint8Array(content))

/** Parses a raw mail. A mail postal-mime cannot read throws (the job records it as FAILED). */
export async function parseRawMail(raw: Buffer): Promise<ParsedMail> {
  const email = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer', maxNestingDepth: 64 })
  const from = mailboxesOf(email.from ? [email.from] : [])[0]
  const html = sanitiseMailHtml(email.html)
  const text = cleanInboundText(email.text && email.text.trim() !== '' ? email.text : textOfHtml(email.html))
  let kept = 0
  const parts = email.attachments.map((attachment, index) => {
    const body = bytesOf(attachment.content)
    const contentType = sniffedType(normaliseContentType(attachment.mimeType ?? ''), body)
    const name = cleanFileName(attachment.filename ?? '') ?? `attachment-${index + 1}`
    const skipped = (reason: SkipReason) => ({ kept: false as const, part: { name, contentType, sizeBytes: body.length, reason } })
    // A part of the HTML (multipart/related: a logo, a signature picture) is not an attachment of the record.
    if (attachment.related === true) return skipped('inline')
    if (body.length === 0) return skipped('empty')
    if (!ATTACHMENT.contentTypes.includes(contentType)) return skipped('type_not_allowed')
    if (body.length > ATTACHMENT.maxBytes) return skipped('too_large')
    if (kept >= MAX_KEPT_ATTACHMENTS) return skipped('too_many')
    kept += 1
    return { kept: true as const, part: { name, contentType, body, sha256: createHash('sha256').update(body).digest('hex') } }
  })
  return {
    from: { address: addressesOf([from?.address])[0] ?? null, name: cleanName(from?.name) },
    to: addressesOf(mailboxesOf(email.to).map((box) => box.address)),
    cc: addressesOf(mailboxesOf(email.cc).map((box) => box.address)),
    subject: cleanSubject(email.subject),
    emailMessageId: cleanMessageId(email.messageId),
    inReplyTo: messageIdsOf(email.inReplyTo).at(-1) ?? null,
    referenceIds: messageIdsOf(email.references),
    text,
    html,
    parts,
  }
}
