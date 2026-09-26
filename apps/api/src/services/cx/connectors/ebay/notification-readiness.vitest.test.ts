import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ token: vi.fn(), transport: vi.fn() }))
vi.mock('./client.js', () => ({ ebayAppToken: calls.token }))
vi.mock('../../../gateway/ebay.js', () => ({ ebayTransport: () => calls.transport }))
const { EBAY_DESIRED_TOPICS, setupEbayNotifications, subscribeEbayTopic } = await import('./notifications.js')

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('EBAY_NOTIFICATION_ENDPOINT_URL', 'https://example.test/api/webhooks/ebay-notification')
  vi.stubEnv('EBAY_NOTIFICATION_VERIFICATION_TOKEN', 'AZaz09_-'.repeat(4))
  calls.token.mockResolvedValue('fixture-token')
  calls.transport.mockRejectedValue(new Error('No channel call is allowed before handler readiness'))
})
afterEach(() => vi.unstubAllEnvs())

// ORDER_CONFIRMATION has a dormant stored-receipt executor; admission still quarantines it and it stays unready.
it.each(['MARKETPLACE_ACCOUNT_DELETION', 'AUTHORIZATION_REVOCATION', 'ORDER_CONFIRMATION'])('does not advertise the incomplete %s handler as ready', topicId => {
  expect(EBAY_DESIRED_TOPICS.find(topic => topic.topicId === topicId)?.handlerMissing).toBe(true)
})

it.each([undefined, false, true])('refuses setup before credentials or destination creation when no handler is ready (override %s)', async skipTopicsWithoutHandlers => {
  const result = await setupEbayNotifications({ skipTopicsWithoutHandlers })
  expect(result).toMatchObject({ configured: true, destinationId: null, perTopic: [], error: expect.stringMatching(/no.*ready.*handler/i) })
  expect(calls.token).not.toHaveBeenCalled()
  expect(calls.transport).not.toHaveBeenCalled()
})

it.each(['MARKETPLACE_ACCOUNT_DELETION', 'AUTHORIZATION_REVOCATION'])('refuses direct creation or re-enabling of %s', async topicId => {
  const payload = { format: 'JSON', deliveryProtocol: 'HTTPS', schemaVersion: '1.0' }
  const catalogue = new Map([[topicId, { topicId, supportedPayloads: [{ ...payload, format: ['JSON'] }] }]])
  for (const existing of [[], [{ topicId, destinationId: 'd', subscriptionId: 's', status: 'DISABLED', payload }], [{ topicId, destinationId: 'd', subscriptionId: 's', status: 'ENABLED', payload }]]) {
    expect(await subscribeEbayTopic('production', topicId, 'd', catalogue, existing)).toMatchObject({ status: 'refused' })
  }
  expect(calls.token).not.toHaveBeenCalled()
  expect(calls.transport).not.toHaveBeenCalled()
})
