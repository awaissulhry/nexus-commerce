/**
 * eBay ORDER_CONFIRMATION notice — the seller-side checkout event (Notification API release 1.6.6).
 * Its OrderConfirmationData carries the order as an object: `notification.data.order.orderId`.
 * https://developer.ebay.com/develop/api/buy/notification_events
 *
 * The notice only names an order. The order itself is read back from the Fulfillment API with the
 * receipt's own account, so nothing else in the body is trusted. A flat `notification.data.orderId`
 * is not eBay's contract (the old ebay-topics.ts fallback guessed it) and is refused.
 */
import { readEbayNoticeIdentity, EbayNoticeInvalid, type EbayNoticeIdentity } from './ebay-revocation-notice.js'

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const identifier = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024 && value === value.trim()
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value : null

export class EbayOrderNoticeInvalid extends Error {
  constructor(readonly reason: 'envelope_invalid' | 'topic_unsupported' | 'schema_unsupported' | 'order_missing' | 'order_mismatch' | 'account_missing') {
    super('This eBay order notice does not match the supported contract.')
    this.name = 'EbayOrderNoticeInvalid'
  }
}

export interface EbayOrderNotice extends EbayNoticeIdentity {
  readonly topic: 'ORDER_CONFIRMATION'
  readonly schemaVersion: string
  readonly orderId: string
}

/** Pure. Requires the envelope identity, the ORDER_CONFIRMATION topic and the nested order id. */
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
  const orderId = identifier(object(object(object(root.notification)?.data)?.order)?.orderId)
  if (!orderId) throw new EbayOrderNoticeInvalid('order_missing')
  return Object.freeze({ ...identity, topic: 'ORDER_CONFIRMATION', schemaVersion, orderId })
}
