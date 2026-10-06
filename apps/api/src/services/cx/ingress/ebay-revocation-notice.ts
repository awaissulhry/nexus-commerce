/** Official fields: https://developer.ebay.com/develop/api/buy/notification_events */
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const identifier = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024 && value === value.trim()
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value : null

export class EbayNoticeInvalid extends Error {
  constructor(readonly reason: 'envelope_invalid' | 'subject_missing' | 'schema_unsupported' | 'topic_unsupported' | 'timestamp_invalid') {
    super('This eBay authorization notice does not match the supported contract.')
    this.name = 'EbayNoticeInvalid'
  }
}

/** Strict UTC instants, including calendar validity; never a replacement for a grant fence. */
function utcInstant(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) return null
  const millis = Date.parse(value)
  if (!Number.isFinite(millis)) return null
  const date = new Date(millis)
  return date.toISOString().slice(0, 19) === value.slice(0, 19) ? date : null
}

export interface EbayNoticeIdentity {
  readonly notificationId: string
  readonly topic: string
  readonly userId: string | null
}

/** Admission may retain a malformed notice; it must not normalize an invalid date. */
export function readEbayPublicationTime(payload: unknown): Date | null {
  return utcInstant(object(object(payload)?.notification)?.publishDate)
}

/** Minimal authenticated metadata for durable admission, including unresolved subjects. */
export function readEbayNoticeIdentity(payload: unknown): Readonly<EbayNoticeIdentity> {
  const root = object(payload), metadata = object(root?.metadata), notification = object(root?.notification)
  const topic = identifier(metadata?.topic), notificationId = identifier(notification?.notificationId)
  if (!topic || !notificationId) throw new EbayNoticeInvalid('envelope_invalid')
  // Each topic names its seller in its own documented place, and only there: ORDER_CONFIRMATION's
  // OrderConfirmationData carries `user.userId`; the account topics carry a flat `userId`.
  // No fallback from one shape to the other, and never the mutable username.
  const data = object(notification?.data)
  const userId = identifier(topic === 'ORDER_CONFIRMATION' ? object(data?.user)?.userId : data?.userId)
  return Object.freeze({ notificationId, topic, userId })
}

export interface EbayRevocationNotice extends EbayNoticeIdentity {
  readonly topic: 'AUTHORIZATION_REVOCATION'
  readonly schemaVersion: '1.0'
  readonly userId: string
  readonly publishDate: Date | null
  readonly revocationDate: Date
}

export function parseEbayRevocationNotice(payload: unknown): Readonly<EbayRevocationNotice> {
  const identity = readEbayNoticeIdentity(payload)
  if (identity.topic !== 'AUTHORIZATION_REVOCATION') throw new EbayNoticeInvalid('topic_unsupported')
  const root = object(payload)!, metadata = object(root.metadata)!, notification = object(root.notification)!
  if (metadata.schemaVersion !== '1.0') throw new EbayNoticeInvalid('schema_unsupported')
  // Immutable userId is a Nexus automation precondition. The docs do not establish
  // it as mandatory, and username may mean a mutable name or an ID for some users.
  if (!identity.userId) throw new EbayNoticeInvalid('subject_missing')
  const revocationDate = utcInstant(object(notification.data)?.revocationDate)
  const publishDate = readEbayPublicationTime(payload)
  if (!revocationDate || (notification.publishDate != null && !publishDate)) throw new EbayNoticeInvalid('timestamp_invalid')
  return Object.freeze({ ...identity, topic: 'AUTHORIZATION_REVOCATION', schemaVersion: '1.0', userId: identity.userId, publishDate, revocationDate })
}
