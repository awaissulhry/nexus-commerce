import { describe, expect, it } from 'vitest'
import { EbayOrderNoticeInvalid, parseEbayOrderNotice } from './ebay-order-notice.js'

const notice = (data: unknown, metadata: Record<string, unknown> = { topic: 'ORDER_CONFIRMATION', schemaVersion: '1.0' }, notificationId: unknown = 'n-1') =>
  ({ metadata, notification: { notificationId, publishDate: '2026-09-23T10:00:00.000Z', data } })
const reason = (payload: unknown) => { try { parseEbayOrderNotice(payload); return null } catch (error) { return error instanceof EbayOrderNoticeInvalid ? error.reason : String(error) } }

describe('parseEbayOrderNotice', () => {
  it('reads the nested order id of eBay\'s OrderConfirmationData', () => {
    expect(parseEbayOrderNotice(notice({ order: { orderId: '12-34567-89012' } }))).toMatchObject({
      topic: 'ORDER_CONFIRMATION', notificationId: 'n-1', orderId: '12-34567-89012', schemaVersion: '1.0' })
  })

  it('refuses a flat data.orderId, which is not eBay\'s contract', () => {
    expect(reason(notice({ orderId: '12-34567-89012' }))).toBe('order_missing')
    expect(reason(notice({ orderId: '12-34567-89012', order: {} }))).toBe('order_missing')
  })

  it.each([' 12-3', '', 12, '12\u00073', null])('refuses order id %j', orderId => {
    expect(reason(notice({ order: { orderId } }))).toBe('order_missing')
  })

  it('refuses another topic, a missing envelope identity and an unreadable version', () => {
    expect(reason(notice({ order: { orderId: 'o' } }, { topic: 'AUTHORIZATION_REVOCATION', schemaVersion: '1.0' }))).toBe('topic_unsupported')
    expect(reason(notice({ order: { orderId: 'o' } }, { topic: 'ORDER_CONFIRMATION', schemaVersion: '1.0' }, null))).toBe('envelope_invalid')
    expect(reason(notice({ order: { orderId: 'o' } }, { topic: 'ORDER_CONFIRMATION' }))).toBe('schema_unsupported')
    expect(reason(notice({ order: { orderId: 'o' } }, { topic: 'ORDER_CONFIRMATION', schemaVersion: 'latest' }))).toBe('schema_unsupported')
    expect(reason(null)).toBe('envelope_invalid')
  })
})
