import { createHash } from 'node:crypto'
import PostalMime from 'postal-mime'
import { addressesOf, cleanMessageId, cleanName, cleanSubject, inlinePictureName, keepsInlinePart, MAX_KEPT_ATTACHMENTS, messageIdsOf, type SkipReason } from '@nexus/factory-domain/email-in/rules'
import { cleanInboundText, sanitiseMailHtml, textOfHtml } from '@nexus/factory-domain/email-in/sanitise'
import { cleanFileName, KIND_RULES, normaliseContentType } from '../files/rules'
import { mailboxesOf } from './notification'

/**
 * Reading a raw mail (plan A1 §3.7 "Content"; COL-025, COL-026), in the worker, outside any transaction: postal-mime
 * parses the RFC 5322 bytes (MIME parts, encodings, RFC 2047 words); the HTML is sanitised and the text kept
 * (factory-domain email-in/sanitise); the headers the sorting needs are cleaned; each attachment is either kept (an
 * ATTACHMENT file may hold its type and size: platform/files rules) or listed as skipped with why — B-TH-088: a picture
 * pasted in the mail is kept like one, unless it is small or repeated (a signature logo). Nothing here touches the database
 * or the network.
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
  const bodies = email.attachments.map((attachment) => bytesOf(attachment.content))
  const hashes = bodies.map((body) => createHash('sha256').update(body).digest('hex'))
  // B-TH-088: how often each picture is in the mail (a signature logo comes back in every quoted reply).
  const copies = new Map<string, number>()
  for (const hash of hashes) copies.set(hash, (copies.get(hash) ?? 0) + 1)
  const parts = email.attachments.map((attachment, index) => {
    const body = bodies[index]!
    const contentType = sniffedType(normaliseContentType(attachment.mimeType ?? ''), body)
    const inline = attachment.related === true
    const name = cleanFileName(attachment.filename ?? '') ?? (inline ? inlinePictureName(contentType, index + 1) : `attachment-${index + 1}`)
    const skipped = (reason: SkipReason) => ({ kept: false as const, part: { name, contentType, sizeBytes: body.length, reason } })
    // A part of the HTML (multipart/related) is kept only as a pasted picture (B-TH-088): a small or repeated one is a signature's
    // logo or icon, never a file of the record.
    if (inline && !keepsInlinePart({ contentType, sizeBytes: body.length, copies: copies.get(hashes[index]!) ?? 1 })) return skipped('inline')
    if (body.length === 0) return skipped('empty')
    if (!ATTACHMENT.contentTypes.includes(contentType)) return skipped('type_not_allowed')
    if (body.length > ATTACHMENT.maxBytes) return skipped('too_large')
    if (kept >= MAX_KEPT_ATTACHMENTS) return skipped('too_many')
    kept += 1
    return { kept: true as const, part: { name, contentType, body, sha256: hashes[index]! } }
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
