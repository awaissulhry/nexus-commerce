import type { MailVerdict } from '@nexus/factory-domain/email-in/rules'

/**
 * Test support for email in (imported by tests only): SES's "Received" notification as SNS posts it, and a raw mail as a
 * mail client would send it (multipart, base64 attachments, an inline picture of the HTML). Made-up addresses only.
 */

export interface ReceivedInput {
  readonly snsMessageId: string
  readonly sesMessageId: string
  readonly bucket: string
  readonly key: string
  readonly from: string
  readonly to: readonly string[]
  readonly cc?: readonly string[]
  /** The SMTP envelope's recipients (default `to` and `cc`). */
  readonly destination?: readonly string[]
  readonly subject?: string
  readonly messageId?: string
  readonly verdicts?: Partial<Record<'spf' | 'dkim' | 'dmarc' | 'spam' | 'virus', MailVerdict>>
  readonly dmarcPolicy?: string
  readonly at?: Date
  /** The receipt rule's action type (default S3). */
  readonly actionType?: string
}

/** An SNS Notification carrying SES's "Received" notification of a receipt rule's S3 action. */
export function receivedNotificationBody(input: ReceivedInput): string {
  const timestamp = (input.at ?? new Date('2026-10-28T09:10:00Z')).toISOString()
  const verdict = (name: 'spf' | 'dkim' | 'dmarc' | 'spam' | 'virus') => ({ status: input.verdicts?.[name] ?? 'PASS' })
  const destination = input.destination ?? [...input.to, ...(input.cc ?? [])]
  const message = {
    notificationType: 'Received',
    mail: {
      timestamp,
      source: input.from.replace(/^.*<|>$/g, ''),
      messageId: input.sesMessageId,
      destination,
      headersTruncated: false,
      headers: [],
      commonHeaders: {
        returnPath: input.from.replace(/^.*<|>$/g, ''),
        from: [input.from],
        to: [...input.to],
        ...(input.cc ? { cc: [...input.cc] } : {}),
        ...(input.messageId ? { messageId: input.messageId } : {}),
        ...(input.subject ? { subject: input.subject } : {}),
      },
    },
    receipt: {
      timestamp,
      processingTimeMillis: 420,
      recipients: destination,
      spamVerdict: verdict('spam'),
      virusVerdict: verdict('virus'),
      spfVerdict: verdict('spf'),
      dkimVerdict: verdict('dkim'),
      dmarcVerdict: verdict('dmarc'),
      ...(input.dmarcPolicy ? { dmarcPolicy: input.dmarcPolicy } : {}),
      action: { type: input.actionType ?? 'S3', topicArn: 'arn:aws:sns:eu-south-1:000000000000:factory-inbound', bucketName: input.bucket, objectKeyPrefix: 'inbound/', objectKey: input.key },
    },
  }
  return JSON.stringify({
    Type: 'Notification',
    MessageId: input.snsMessageId,
    TopicArn: 'arn:aws:sns:eu-south-1:000000000000:factory-inbound',
    Message: JSON.stringify(message),
    Timestamp: timestamp,
    SignatureVersion: '2',
  })
}

export interface RawAttachment {
  readonly filename: string
  readonly contentType: string
  readonly content: Buffer
  /** An inline picture of the HTML (multipart/related, Content-ID), not an attachment of the record. */
  readonly contentId?: string
}

export interface RawMailInput {
  readonly from: string
  readonly to: readonly string[]
  readonly cc?: readonly string[]
  readonly subject: string
  readonly messageId?: string
  readonly inReplyTo?: string
  readonly references?: readonly string[]
  readonly text?: string
  readonly html?: string
  readonly attachments?: readonly RawAttachment[]
  readonly date?: Date
}

const base64 = (content: Buffer): string => content.toString('base64').replace(/.{76}/g, '$&\r\n')

/** A raw mail (CRLF lines) with a text and/or HTML body, inline pictures and attachments. */
export function rawMail(input: RawMailInput): string {
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to.join(', ')}`,
    ...(input.cc ? [`Cc: ${input.cc.join(', ')}`] : []),
    `Subject: ${input.subject}`,
    `Date: ${(input.date ?? new Date('2026-10-28T09:09:00Z')).toUTCString()}`,
    ...(input.messageId ? [`Message-ID: ${input.messageId}`] : []),
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references ? [`References: ${input.references.join(' ')}`] : []),
    'MIME-Version: 1.0',
  ]
  const inline = (input.attachments ?? []).filter((part) => part.contentId)
  const attached = (input.attachments ?? []).filter((part) => !part.contentId)
  const textPart = input.text !== undefined ? ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64(Buffer.from(input.text, 'utf8'))].join('\r\n') : null
  let htmlPart = input.html !== undefined ? ['Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64(Buffer.from(input.html, 'utf8'))].join('\r\n') : null
  if (htmlPart && inline.length > 0) {
    const parts = inline.map((part) =>
      [`Content-Type: ${part.contentType}; name="${part.filename}"`, 'Content-Transfer-Encoding: base64', `Content-ID: <${part.contentId}>`, `Content-Disposition: inline; filename="${part.filename}"`, '', base64(part.content)].join('\r\n'),
    )
    htmlPart = ['Content-Type: multipart/related; boundary="rel"', '', '--rel', htmlPart, ...parts.flatMap((part) => ['--rel', part]), '--rel--'].join('\r\n')
  }
  const bodies = [textPart, htmlPart].filter((part): part is string => part !== null)
  const body = bodies.length === 2 ? ['Content-Type: multipart/alternative; boundary="alt"', '', '--alt', bodies[0], '--alt', bodies[1], '--alt--'].join('\r\n') : (bodies[0] ?? 'Content-Type: text/plain; charset=UTF-8\r\n\r\n')
  const files = attached.map((part) =>
    [`Content-Type: ${part.contentType}; name="${part.filename}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${part.filename}"`, '', base64(part.content)].join('\r\n'),
  )
  const mime = files.length === 0 ? body : ['Content-Type: multipart/mixed; boundary="mix"', '', '--mix', body, ...files.flatMap((part) => ['--mix', part]), '--mix--'].join('\r\n')
  const [head, ...rest] = mime.split('\r\n\r\n')
  return `${[...headers, head].join('\r\n')}\r\n\r\n${rest.join('\r\n\r\n')}\r\n`
}
