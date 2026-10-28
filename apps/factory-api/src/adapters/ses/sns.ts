import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { SignatureVerifier, VerifyInput, VerifyResult } from '@nexus/factory-domain/ports/signature'

/**
 * SES's notifications as they reach the factory (plan A1 §3.7 "Bounces and complaints": a configuration set → SNS →
 * HTTPS → the inbound ledger): an SNS envelope (`Type`, `MessageId`, `Message` …) whose `Message` is SES's event JSON
 * (event publishing: `eventType`; identity notifications: `notificationType`). One parser serves the verifier below and
 * the processor (platform/email-out/notifications.ts); a FAKE account's deliveries carry the same body, signed by the
 * factory's fake verifier instead.
 *
 * The verifier of LIVE and SANDBOX SES accounts (INBOUND_PROVIDERS.SES): the subscription's HTTPS endpoint carries the
 * account's webhook secret as basic-auth credentials (`https://sns:<secret>@<api>/inbound/ses/<tenant>/<account>`; SNS
 * sends them as `Authorization: Basic …`), checked in constant time, and the body must be an SNS message whose type
 * matches SNS's `x-amz-sns-message-type` header. The SNS message ID is the dedupe key. SNS's own signature (its signing
 * certificate fetched through the gateway) is the go-live step's addition (W0-27), before any LIVE account exists.
 */

const envelopeSchema = z.object({
  Type: z.enum(['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation']),
  MessageId: z.string().min(1).max(200),
  TopicArn: z.string().optional(),
  Message: z.string().optional(),
  Timestamp: z.string().optional(),
})

const recipient = z.object({ emailAddress: z.string() })
const eventSchema = z.object({
  eventType: z.string().optional(),
  notificationType: z.string().optional(),
  mail: z.object({ messageId: z.string().optional(), timestamp: z.string().optional(), tags: z.record(z.string(), z.array(z.string())).optional() }).optional(),
  bounce: z
    .object({ bounceType: z.string().optional(), bounceSubType: z.string().optional(), bouncedRecipients: z.array(recipient).optional(), timestamp: z.string().optional() })
    .optional(),
  complaint: z
    .object({ complainedRecipients: z.array(recipient).optional(), complaintFeedbackType: z.string().optional(), timestamp: z.string().optional() })
    .optional(),
  delivery: z.object({ recipients: z.array(z.string()).optional(), timestamp: z.string().optional() }).optional(),
})

export type SesEventKind = 'Delivery' | 'Bounce' | 'Complaint' | 'Other'

/** One parsed SES notification. */
export type SesNotification =
  | { readonly kind: 'subscription'; readonly snsType: 'SubscriptionConfirmation' | 'UnsubscribeConfirmation'; readonly snsMessageId: string }
  | {
      readonly kind: 'event'
      readonly snsMessageId: string
      readonly event: SesEventKind
      /** SES's own name of the event (`Bounce`, `DeliveryDelay` …). */
      readonly eventName: string
      /** SES's id of the mail it is about. */
      readonly sesMessageId: string | null
      /** The mail's tags (outbound, template), as SES copied them. */
      readonly tags: Readonly<Record<string, readonly string[]>>
      /** When it happened, by SES's clock. */
      readonly at: Date | null
      readonly bounce: { readonly type: string; readonly subType: string; readonly recipients: readonly string[] } | null
      readonly complaint: { readonly feedbackType: string | null; readonly recipients: readonly string[] } | null
    }

const instant = (value: string | undefined): Date | null => {
  if (!value) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

/** The notification in a body, or null when the body is not one. */
export function parseSesNotification(body: string): SesNotification | null {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return null
  }
  const envelope = envelopeSchema.safeParse(json)
  if (!envelope.success) return null
  const { Type, MessageId } = envelope.data
  if (Type !== 'Notification') return { kind: 'subscription', snsType: Type, snsMessageId: MessageId }
  let inner: unknown
  try {
    inner = JSON.parse(envelope.data.Message ?? '')
  } catch {
    return null
  }
  const parsed = eventSchema.safeParse(inner)
  if (!parsed.success) return null
  const event = parsed.data
  const eventName = event.eventType ?? event.notificationType ?? 'Unknown'
  const kind: SesEventKind = eventName === 'Delivery' || eventName === 'Bounce' || eventName === 'Complaint' ? eventName : 'Other'
  return {
    kind: 'event',
    snsMessageId: MessageId,
    event: kind,
    eventName,
    sesMessageId: event.mail?.messageId ?? null,
    tags: event.mail?.tags ?? {},
    at: instant(event.bounce?.timestamp ?? event.complaint?.timestamp ?? event.delivery?.timestamp ?? envelope.data.Timestamp),
    bounce: event.bounce
      ? { type: event.bounce.bounceType ?? 'Undetermined', subType: event.bounce.bounceSubType ?? 'Undetermined', recipients: (event.bounce.bouncedRecipients ?? []).map((entry) => entry.emailAddress) }
      : null,
    complaint: event.complaint
      ? { feedbackType: event.complaint.complaintFeedbackType ?? null, recipients: (event.complaint.complainedRecipients ?? []).map((entry) => entry.emailAddress) }
      : null,
  }
}

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()

export const snsVerifier: SignatureVerifier = {
  verify({ rawBody, headers, secret }: VerifyInput): VerifyResult {
    if (!secret) return { ok: false, reason: 'no_webhook_secret' }
    const authorization = headers.authorization
    if (!authorization?.startsWith('Basic ')) return { ok: false, reason: 'missing_signature' }
    const credentials = Buffer.from(authorization.slice(6).trim(), 'base64').toString('utf8')
    const password = credentials.slice(credentials.indexOf(':') + 1)
    if (!timingSafeEqual(digest(password), digest(secret))) return { ok: false, reason: 'signature_mismatch' }
    const notification = parseSesNotification(Buffer.from(rawBody).toString('utf8'))
    if (!notification) return { ok: false, reason: 'not_an_sns_message' }
    const type = notification.kind === 'subscription' ? notification.snsType : 'Notification'
    if (headers['x-amz-sns-message-type'] !== type) return { ok: false, reason: 'sns_type_mismatch' }
    return {
      ok: true,
      dedupeKey: notification.snsMessageId,
      eventType: notification.kind === 'subscription' ? notification.snsType : notification.eventName,
      ...(notification.kind === 'event' && notification.sesMessageId ? { externalId: notification.sesMessageId } : {}),
    }
  },
}
