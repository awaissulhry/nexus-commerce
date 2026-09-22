import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ transport: vi.fn(), token: vi.fn() }))
vi.mock('./client.js', () => ({ ebayAppToken: m.token }))
vi.mock('../../../gateway/ebay.js', () => ({ ebayTransport: () => m.transport }))
vi.mock('../../../../utils/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }))
const { createEbayDestination, getEbayDestinations, setupEbayNotifications, subscribeEbayTopic } = await import('./notifications.js')

// DOCUMENTED fixtures, with synthetic IDs and token; never a channel call.
// https://developer.ebay.com/api-docs/master/commerce/notification/openapi/3/commerce_notification_v1_oas3.json
// Destination.deliveryConfig; POST /destination and /subscription 201 Location;
// SubscriptionPayloadDetail; POST /subscription/{subscription_id}/enable.
const API = 'https://api.ebay.com/commerce/notification/v1'
const endpoint = 'https://example.test/api/webhooks/ebay-notification'
const verificationToken = 'AZaz09_-'.repeat(4)
const destination = {
  destinationId: 'destination-fixture', name: 'Nexus inbound notifications', status: 'ENABLED',
  deliveryConfig: { endpoint, verificationToken },
}
const topicIds = ['MARKETPLACE_ACCOUNT_DELETION', 'AUTHORIZATION_REVOCATION']
const topics = topicIds.map(topicId => ({
  topicId, status: 'ENABLED', supportedPayloads: [{ format: 'JSON', schemaVersion: '1.0', deprecated: false }],
}))
const catalogue = new Map(topics.map(topic => [topic.topicId, topic]))
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json' },
})
const createdResponse = (resource: 'destination' | 'subscription', id: string) => new Response(null, {
  status: 201, headers: { Location: `${API}/${resource}/${id}` },
})

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('EBAY_NOTIFICATION_ENDPOINT_URL', endpoint)
  vi.stubEnv('EBAY_NOTIFICATION_VERIFICATION_TOKEN', verificationToken)
  m.token.mockResolvedValue('fixture-app-token')
  m.transport.mockRejectedValue(new Error('Unexpected notification transport request'))
})
afterEach(() => vi.unstubAllEnvs())

describe('eBay Notification API wire contract', () => {
  it('reads a new destination ID from Location when the 201 body is empty', async () => {
    m.transport.mockResolvedValueOnce(createdResponse('destination', destination.destinationId))
    await expect(createEbayDestination('production', destination.name, endpoint, verificationToken))
      .resolves.toBe(destination.destinationId)
    expect(m.transport).toHaveBeenCalledOnce()
  })

  it('exposes the endpoint from the documented nested deliveryConfig', async () => {
    m.transport.mockResolvedValueOnce(jsonResponse({ destinations: [destination], total: 1 }))
    expect(await getEbayDestinations()).toEqual([{
      destinationId: destination.destinationId, name: destination.name, status: 'ENABLED', endpoint,
    }])
  })

  it('does not return the verification token contained in eBay destination responses', async () => {
    m.transport.mockResolvedValueOnce(jsonResponse({ destinations: [destination], total: 1 }))
    const result = await getEbayDestinations()
    expect(result).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain(verificationToken)
    expect(JSON.stringify(result)).not.toContain('verificationToken')
  })

  it('creates subscriptions using the documented HTTPS payload fields', async () => {
    m.transport.mockResolvedValueOnce(createdResponse('subscription', 'subscription-fixture'))
    await subscribeEbayTopic('production', topicIds[0]!, destination.destinationId, catalogue, [])
    expect(m.transport).toHaveBeenCalledOnce()
    const [url, request] = m.transport.mock.calls[0]!
    expect(url).toBe(`${API}/subscription`)
    expect(request.method).toBe('POST')
    expect(JSON.parse(request.body)).toEqual({
      topicId: topicIds[0], destinationId: destination.destinationId, status: 'ENABLED',
      payload: { format: 'JSON', schemaVersion: '1.0', deliveryProtocol: 'HTTPS' },
    })
  })

  it('returns the created subscription ID from an empty 201 response Location', async () => {
    m.transport.mockResolvedValueOnce(createdResponse('subscription', 'subscription-fixture'))
    expect(await subscribeEbayTopic('production', topicIds[0]!, destination.destinationId, catalogue, []))
      .toEqual({ topicId: topicIds[0], status: 'created', subscriptionId: 'subscription-fixture' })
  })

  it('enables a disabled subscription with POST', async () => {
    m.transport.mockResolvedValueOnce(new Response(null, { status: 204 }))
    const existing = [{
      subscriptionId: 'subscription-fixture', topicId: topicIds[0]!,
      destinationId: destination.destinationId, status: 'DISABLED',
    }]
    expect(await subscribeEbayTopic('production', topicIds[0]!, destination.destinationId, catalogue, existing))
      .toEqual({ topicId: topicIds[0], status: 'enabled', subscriptionId: 'subscription-fixture' })
    expect(m.transport).toHaveBeenCalledOnce()
    expect(m.transport).toHaveBeenCalledWith(`${API}/subscription/subscription-fixture/enable`,
      expect.objectContaining({ method: 'POST' }))
  })

  it('reuses the existing endpoint and enabled subscriptions without issuing a write', async () => {
    const subscriptions = topicIds.map((topicId, index) => ({
      subscriptionId: `subscription-fixture-${index}`, topicId,
      destinationId: destination.destinationId, status: 'ENABLED',
    }))
    m.transport.mockImplementation(async (url: string, request: RequestInit) => {
      if (request.method !== 'GET') throw new Error(`Existing setup must not write: ${request.method} ${url}`)
      if (url === `${API}/topic?limit=100`) return jsonResponse({ topics, total: topics.length })
      if (url === `${API}/destination?limit=100`) return jsonResponse({ destinations: [destination], total: 1 })
      if (url === `${API}/subscription?limit=100`) return jsonResponse({ subscriptions, total: subscriptions.length })
      throw new Error(`Unexpected notification URL: ${url}`)
    })
    const result = await setupEbayNotifications({ skipTopicsWithoutHandlers: true })
    expect(result).toMatchObject({
      configured: true, destinationId: destination.destinationId, notOffered: [],
      perTopic: subscriptions.map(subscription => ({
        topicId: subscription.topicId, status: 'already_exists', subscriptionId: subscription.subscriptionId,
      })),
    })
    expect(m.transport).toHaveBeenCalledTimes(3)
    expect(m.transport.mock.calls.every(([, request]) => request.method === 'GET')).toBe(true)
  })
})
