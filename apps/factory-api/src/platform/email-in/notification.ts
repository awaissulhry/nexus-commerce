import { addressParser, decodeWords, type Address } from 'postal-mime'
import { z } from 'zod'
import { addressesOf, cleanMessageId, cleanName, cleanSubject, verdictOf, type Verdicts } from '@nexus/factory-domain/email-in/rules'

/**
 * SES's "Received" notification (plan A1 §3.7 "Receiving": the receipt rule's S3 action notifies SNS → our webhook → the
 * inbound ledger), as it reaches platform/email-in: an SNS envelope (`Type: Notification`, `MessageId`, `Message`) whose
 * `Message` is SES's JSON with `notificationType: "Received"`, the mail's envelope and common headers, the receipt's
 * verdicts and where the S3 action stored the raw mail. SES's other notifications (delivery, bounce, complaint) are
 * email out's (platform/email-out/notifications.ts): `receivedMailOf` answers null for them.
 */

const verdict = z.object({ status: z.string().optional() }).optional()
const strings = z.array(z.string().max(2_000)).max(500).optional()

const receivedSchema = z.object({
  notificationType: z.literal('Received'),
  mail: z.object({
    timestamp: z.string().optional(),
    source: z.string().max(1_000).optional(),
    messageId: z.string().min(1).max(200),
    destination: strings,
    commonHeaders: z
      .object({
        from: strings,
        to: strings,
        cc: strings,
        subject: z.string().max(10_000).optional(),
        messageId: z.string().max(1_000).optional(),
      })
      .optional(),
  }),
  receipt: z.object({
    timestamp: z.string().optional(),
    recipients: strings,
    spfVerdict: verdict,
    dkimVerdict: verdict,
    dmarcVerdict: verdict,
    dmarcPolicy: z.string().max(40).optional(),
    spamVerdict: verdict,
    virusVerdict: verdict,
    action: z.object({ type: z.string(), bucketName: z.string().max(255).optional(), objectKey: z.string().max(1_024).optional() }),
  }),
})

/** One received mail as SES announced it. */
export interface ReceivedMail {
  readonly sesMessageId: string
  readonly receivedAt: Date | null
  /** The S3 action's bucket and key; null when the receipt rule did not store the mail in S3. */
  readonly location: { readonly bucket: string; readonly key: string } | null
  readonly envelopeFrom: string | null
  /** The recipients SES took it for (the receipt's, else the envelope's), lower case. */
  readonly envelopeTo: readonly string[]
  readonly from: { readonly address: string | null; readonly name: string | null }
  readonly to: readonly string[]
  readonly cc: readonly string[]
  readonly subject: string | null
  readonly emailMessageId: string | null
  readonly verdicts: Verdicts
  readonly dmarcPolicy: string | null
}

const instant = (value: string | undefined): Date | null => {
  if (!value) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

/** The mailboxes of parsed address lists (groups opened), in order. */
export function mailboxesOf(addresses: readonly Address[] | undefined): { address: string; name: string }[] {
  return (addresses ?? []).flatMap((entry) => (entry.group ? entry.group : [entry])).map((box) => ({ address: box.address ?? '', name: box.name ?? '' }))
}

const parsed = (values: readonly string[] | undefined): { address: string; name: string }[] => mailboxesOf((values ?? []).flatMap((value) => addressParser(value)))

/**
 * The received mail in a notification body (the SNS envelope's raw text), or null when the body is not an SES
 * "Received" notification. A "Received" notification that is not well formed throws: the receipt fails for a person.
 */
export function receivedMailOf(body: string): ReceivedMail | null {
  let inner: unknown
  try {
    const envelope = JSON.parse(body) as { Type?: unknown; Message?: unknown }
    if (envelope?.Type !== 'Notification' || typeof envelope.Message !== 'string') return null
    inner = JSON.parse(envelope.Message)
  } catch {
    return null
  }
  if ((inner as { notificationType?: unknown } | null)?.notificationType !== 'Received') return null
  const result = receivedSchema.safeParse(inner)
  if (!result.success) throw new Error(`The SES "Received" notification is not well formed: ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`)
  const { mail, receipt } = result.data
  const headers = mail.commonHeaders ?? {}
  const from = parsed(headers.from)[0]
  const action = receipt.action
  return {
    sesMessageId: mail.messageId,
    receivedAt: instant(mail.timestamp) ?? instant(receipt.timestamp),
    location: action.type === 'S3' && action.bucketName && action.objectKey ? { bucket: action.bucketName, key: action.objectKey } : null,
    envelopeFrom: addressesOf([mail.source])[0] ?? null,
    envelopeTo: addressesOf(receipt.recipients ?? mail.destination ?? []),
    from: { address: addressesOf([from?.address])[0] ?? null, name: cleanName(from?.name ? decodeWords(from.name) : null) },
    to: addressesOf(parsed(headers.to).map((box) => box.address)),
    cc: addressesOf(parsed(headers.cc).map((box) => box.address)),
    subject: cleanSubject(headers.subject),
    emailMessageId: cleanMessageId(headers.messageId),
    verdicts: {
      spf: verdictOf(receipt.spfVerdict?.status),
      dkim: verdictOf(receipt.dkimVerdict?.status),
      dmarc: verdictOf(receipt.dmarcVerdict?.status),
      spam: verdictOf(receipt.spamVerdict?.status),
      virus: verdictOf(receipt.virusVerdict?.status),
    },
    dmarcPolicy: receipt.dmarcPolicy?.toLowerCase() ?? null,
  }
}
