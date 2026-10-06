import { describe, expect, it } from 'vitest'

const valid = () => ({
  metadata: { topic: 'AUTHORIZATION_REVOCATION', schemaVersion: '1.0' },
  notification: { notificationId: 'notice-1', eventDate: '2026-09-23T01:02:03Z', publishDate: '2026-09-23T01:02:05.123Z', publishAttemptCount: 1,
    data: { userId: 'immutable-user', username: 'mutable-name', eiasToken: 'legacy-identity', revokeReason: 'REVOKED_BY_USER', revocationDate: '2026-09-23T01:02:03Z' } },
})
const parse = async (input: unknown) => (await import('./ebay-revocation-notice.js')).parseEbayRevocationNotice(input)
const identity = async (input: unknown) => (await import('./ebay-revocation-notice.js')).readEbayNoticeIdentity(input)

describe('the documented eBay revocation envelope', () => {
  it('uses notification-level identity/times and the explicit immutable subject', async () => {
    expect(await parse(valid())).toEqual({ notificationId: 'notice-1', topic: 'AUTHORIZATION_REVOCATION', schemaVersion: '1.0',
      userId: 'immutable-user', publishDate: new Date('2026-09-23T01:02:05.123Z'), revocationDate: new Date('2026-09-23T01:02:03Z') })
  })

  it('keeps revocation time distinct from later transmission time and retry metadata', async () => {
    const input = valid()
    input.notification.publishDate = '2026-09-25T08:09:10Z'
    input.notification.publishAttemptCount = 3
    expect(await parse(input)).toMatchObject({ notificationId: 'notice-1', publishDate: new Date('2026-09-25T08:09:10Z'), revocationDate: new Date('2026-09-23T01:02:03Z') })
  })

  it('does not read the legacy metadata notification ID or transmission timestamp', async () => {
    const input = { ...valid(), metadata: { ...valid().metadata, notificationId: 'wrong', publishDate: '2030-01-01T00:00:00Z' } }
    expect(await parse(input)).toMatchObject({ notificationId: 'notice-1', publishDate: new Date('2026-09-23T01:02:05.123Z') })
  })

  it('identifies a notice for quarantine even if its subject cannot be safely resolved', async () => {
    const input = valid(); delete (input.notification.data as any).userId
    expect(await identity(input)).toEqual({ notificationId: 'notice-1', topic: 'AUTHORIZATION_REVOCATION', userId: null })
    await expect(parse(input)).rejects.toMatchObject({ reason: 'subject_missing' })
  })

  it.each(['a-username', 'an-immutable-id-in-the-username-field'])('never infers immutable identity from username=%s', async username => {
    const input = valid(); delete (input.notification.data as any).userId; input.notification.data.username = username
    await expect(parse(input)).rejects.toMatchObject({ reason: 'subject_missing' })
  })

  it.each([undefined, '', ' ', 123, {}, 'x'.repeat(1025), 'user\u0000id', 'user\nid', 'user\u007fid'])('refuses invalid explicit subject %j', async userId => {
    const input = valid(); (input.notification.data as any).userId = userId
    await expect(parse(input)).rejects.toMatchObject({ reason: 'subject_missing' })
  })

  it.each([null, [], {}, { metadata: { topic: 'AUTHORIZATION_REVOCATION', notificationId: 'legacy-place' }, notification: { data: {} } }])('refuses an unsupported envelope %j', async input => {
    await expect(identity(input)).rejects.toMatchObject({ reason: 'envelope_invalid' })
  })

  it.each(['2.0', '', undefined])('holds unsupported schema %j for review', async schemaVersion => {
    const input = valid(); (input.metadata as any).schemaVersion = schemaVersion
    await expect(parse(input)).rejects.toMatchObject({ reason: 'schema_unsupported' })
  })

  it('does not reinterpret another topic as revocation', async () => {
    const input = valid(); input.metadata.topic = 'ORDER_CONFIRMATION'
    await expect(parse(input)).rejects.toMatchObject({ reason: 'topic_unsupported' })
  })

  it.each(['', 'not-a-date', '2026-02-30T01:00:00Z', '2026-09-23', '2026-09-23T01:00:00+02:00', undefined])('refuses invalid/missing UTC revocation time %j', async revocationDate => {
    const input = valid(); (input.notification.data as any).revocationDate = revocationDate
    await expect(parse(input)).rejects.toMatchObject({ reason: 'timestamp_invalid' })
  })

  it('does not manufacture publication time when absent', async () => {
    const input = valid(); delete (input.notification as any).publishDate
    expect(await parse(input)).toMatchObject({ publishDate: null, revocationDate: new Date('2026-09-23T01:02:03Z') })
  })

  it('never includes payload/identity data in its validation error', async () => {
    const input = valid(); input.metadata.schemaVersion = 'sensitive-provider-value'
    await expect(parse(input)).rejects.toMatchObject({ message: 'This eBay authorization notice does not match the supported contract.' })
  })

  it.each(['notice\u0000id', 'notice\nid'])('rejects control characters in delivery identity %j', async notificationId => {
    const input = valid(); input.notification.notificationId = notificationId
    await expect(identity(input)).rejects.toMatchObject({ reason: 'envelope_invalid' })
  })

  it('reads each topic\'s seller only from its own documented field', async () => {
    const order = { metadata: { topic: 'ORDER_CONFIRMATION', schemaVersion: '1.0' },
      notification: { notificationId: 'order-notice-1', data: { user: { userId: 'order-seller', username: 'order-name' }, order: { orderId: 'o-1' } } } }
    expect(await identity(order)).toEqual({ notificationId: 'order-notice-1', topic: 'ORDER_CONFIRMATION', userId: 'order-seller' })
    // An order notice with only the account topics' flat field has no seller; nothing is guessed.
    expect(await identity({ ...order, notification: { ...order.notification, data: { userId: 'flat-seller', order: { orderId: 'o-1' } } } }))
      .toEqual({ notificationId: 'order-notice-1', topic: 'ORDER_CONFIRMATION', userId: null })
    // And revocation never reads the order topic's nested field.
    const input = valid(); delete (input.notification.data as any).userId; (input.notification.data as any).user = { userId: 'nested-seller' }
    expect(await identity(input)).toEqual({ notificationId: 'notice-1', topic: 'AUTHORIZATION_REVOCATION', userId: null })
  })

  it('uses the same strict calendar validation when storing publication time', async () => {
    const { readEbayPublicationTime } = await import('./ebay-revocation-notice.js')
    const input = valid(); input.notification.publishDate = '2026-02-30T01:00:00Z'
    expect(readEbayPublicationTime(input)).toBeNull()
    await expect(parse(input)).rejects.toMatchObject({ reason: 'timestamp_invalid' })
  })
})
