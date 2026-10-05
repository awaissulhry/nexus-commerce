/**
 * eBay ORDER_CONFIRMATION notice — the seller-side checkout event (Notification API release 1.6.6).
 * Its OrderConfirmationData carries the seller as `notification.data.user.userId` and the order as an
 * object: `notification.data.order.orderId`.
 * https://developer.ebay.com/develop/api/buy/notification_events (spec: /develop/api/spec/events/ORDER_CONFIRMATION.yaml)
 *
 * The notice only names a seller and an order. Admission routes it by the seller id; the order itself
 * is read back from the Fulfillment API with the receipt's own account, so nothing else in the body is
 * trusted. A flat `notification.data.orderId` or `data.userId` is not eBay's contract (the old
 * ebay-topics.ts fallback guessed the first) and is refused.
 */
import { readEbayNoticeIdentity, EbayNoticeInvalid, type EbayNoticeIdentity } from './ebay-revocation-notice.js'

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const identifier = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024 && value === value.trim()
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value : null

export class EbayOrderNoticeInvalid extends Error {
  constructor(readonly reason: 'envelope_invalid' | 'topic_unsupported' | 'schema_unsupported' | 'seller_missing' | 'seller_mismatch' | 'order_missing' | 'order_mismatch' | 'account_missing') {
    super('This eBay order notice does not match the supported contract.')
    this.name = 'EbayOrderNoticeInvalid'
  }
}

export interface EbayOrderNotice extends EbayNoticeIdentity {
  readonly topic: 'ORDER_CONFIRMATION'
  readonly schemaVersion: string
  /** The seller the notice is for (`data.user.userId`): checked against the receipt's account. */
  readonly userId: string
  readonly orderId: string
}

/** Pure. Requires the envelope identity, the ORDER_CONFIRMATION topic, the seller id and the nested order id. */
export function parseEbayOrderNotice(payload: unknown): Readonly<EbayOrderNotice> {
  let identity: Readonly<EbayNoticeIdentity>
  try { identity = readEbayNoticeIdentity(payload) } catch (error) {
    if (error instanceof EbayNoticeInvalid) throw new EbayOrderNoticeInvalid('envelope_invalid')
    throw error
  }
  if (identity.topic !== 'ORDER_CONFIRMATION') throw new EbayOrderNoticeInvalid('topic_unsupported')
  const root = object(payload)!
  // The version is recorded, not pinned: the order body is read back from the Fulfillment API.
  const schemaVersion = object(root.metadata)?.schemaVersion
  if (typeof schemaVersion !== 'string' || !/^\d{1,4}\.\d{1,4}(?:\.\d{1,4})?$/.test(schemaVersion)) throw new EbayOrderNoticeInvalid('schema_unsupported')
  // Like revocation's subject: without the seller id the notice cannot be tied to its account.
  if (!identity.userId) throw new EbayOrderNoticeInvalid('seller_missing')
  const orderId = identifier(object(object(object(root.notification)?.data)?.order)?.orderId)
  if (!orderId) throw new EbayOrderNoticeInvalid('order_missing')
  return Object.freeze({ ...identity, topic: 'ORDER_CONFIRMATION', schemaVersion, userId: identity.userId, orderId })
}
