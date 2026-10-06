import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EbayOrderNoticeInvalid, parseEbayOrderNotice } from './ebay-order-notice.js'
import { readEbayNoticeIdentity } from './ebay-revocation-notice.js'

const notice = (data: unknown, metadata: Record<string, unknown> = { topic: 'ORDER_CONFIRMATION', schemaVersion: '1.0' }, notificationId: unknown = 'n-1') =>
  ({ metadata, notification: { notificationId, publishDate: '2026-09-23T10:00:00.000Z', data } })
const seller = { userId: 'seller-1', username: 'seller-name' }
const reason = (payload: unknown) => { try { parseEbayOrderNotice(payload); return null } catch (error) { return error instanceof EbayOrderNoticeInvalid ? error.reason : String(error) } }

/**
 * eBay's topic page publishes no sample body for ORDER_CONFIRMATION ("sample": []), so this fixture
 * follows its AsyncAPI schema field for field (/develop/api/spec/events/ORDER_CONFIRMATION.yaml:
 * metadata{topic,schemaVersion,deprecated}, notification{notificationId,eventDate,publishDate,
 * publishAttemptCount,data: OrderConfirmationData{user{userId,username},order{orderId,orderLineItems
 * [{orderLineItemId,listingId,quantity}]}}}). Every id in it is fake.
 */
const contract = JSON.parse(readFileSync(new URL('./__fixtures__/ebay-order-confirmation.json', import.meta.url), 'utf8'))

describe('eBay\'s documented ORDER_CONFIRMATION contract', () => {
  it('parses the documented body: seller from data.user.userId, order from data.order.orderId', () => {
    expect(parseEbayOrderNotice(contract)).toEqual({ notificationId: '00000000-fake-0000-notice-000000000001', topic: 'ORDER_CONFIRMATION',
      schemaVersion: '1.0', userId: 'fake-seller-user-id-A', orderId: '00-00000-00001' })
  })

  it('gives admission the same seller id it routes by', () => {
    expect(readEbayNoticeIdentity(contract)).toEqual({ notificationId: '00000000-fake-0000-notice-000000000001', topic: 'ORDER_CONFIRMATION', userId: 'fake-seller-user-id-A' })
  })
})

describe('parseEbayOrderNotice', () => {
  it('reads the nested seller and order ids of eBay\'s OrderConfirmationData', () => {
    expect(parseEbayOrderNotice(notice({ user: seller, order: { orderId: '12-34567-89012' } }))).toMatchObject({
      topic: 'ORDER_CONFIRMATION', notificationId: 'n-1', userId: 'seller-1', orderId: '12-34567-89012', schemaVersion: '1.0' })
  })

  it('refuses a flat data.orderId, which is not eBay\'s contract', () => {
    expect(reason(notice({ user: seller, orderId: '12-34567-89012' }))).toBe('order_missing')
    expect(reason(notice({ user: seller, orderId: '12-34567-89012', order: {} }))).toBe('order_missing')
  })

  it('refuses a notice without the nested seller id: never a flat data.userId, never the username', () => {
    expect(reason(notice({ order: { orderId: 'o' } }))).toBe('seller_missing')
    expect(reason(notice({ userId: 'seller-1', order: { orderId: 'o' } }))).toBe('seller_missing')
    expect(reason(notice({ user: { username: 'seller-name' }, order: { orderId: 'o' } }))).toBe('seller_missing')
  })

  it.each([' seller', '', 12, 'sel\u0000ler', null, {}])('refuses seller id %j', userId => {
    expect(reason(notice({ user: { userId }, order: { orderId: 'o' } }))).toBe('seller_missing')
  })

  it.each([' 12-3', '', 12, '12\u00073', null])('refuses order id %j', orderId => {
    expect(reason(notice({ user: seller, order: { orderId } }))).toBe('order_missing')
  })

  it('refuses another topic, a missing envelope identity and an unreadable version', () => {
    expect(reason(notice({ user: seller, order: { orderId: 'o' } }, { topic: 'AUTHORIZATION_REVOCATION', schemaVersion: '1.0' }))).toBe('topic_unsupported')
    expect(reason(notice({ user: seller, order: { orderId: 'o' } }, { topic: 'ORDER_CONFIRMATION', schemaVersion: '1.0' }, null))).toBe('envelope_invalid')
    expect(reason(notice({ user: seller, order: { orderId: 'o' } }, { topic: 'ORDER_CONFIRMATION' }))).toBe('schema_unsupported')
    expect(reason(notice({ user: seller, order: { orderId: 'o' } }, { topic: 'ORDER_CONFIRMATION', schemaVersion: 'latest' }))).toBe('schema_unsupported')
    expect(reason(null)).toBe('envelope_invalid')
  })
})
