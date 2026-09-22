import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ transport: vi.fn(), token: vi.fn() }))
vi.mock('./client.js', () => ({ ebayAppToken: m.token }))
vi.mock('../../../gateway/ebay.js', () => ({ ebayTransport: () => m.transport }))
vi.mock('../../../../utils/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }))
const { createEbayDestination, getEbayDestinations, getEbayTopics, getEbaySubscriptions, setupEbayNotifications, subscribeEbayTopic, ebayNotificationSetupSucceeded } = await import('./notifications.js')

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
  topicId, status: 'ENABLED', supportedPayloads: [{ format: ['JSON'], deliveryProtocol: 'HTTPS', schemaVersion: '1.0', deprecated: false }],
}))
const catalogue = new Map(topics.map(topic => [topic.topicId, topic]))
const payload = { format: 'JSON', deliveryProtocol: 'HTTPS', schemaVersion: '1.0' }
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
  it.each(['ENABLED', 'DISABLED'])('refuses an incompatible existing %s subscription without writing', async status => {
    const existing = [{ subscriptionId: 'old-schema', topicId: topicIds[0], destinationId: destination.destinationId, status, payload: { ...payload, schemaVersion: '0.5' } }]
    expect(await subscribeEbayTopic('production', topicIds[0], destination.destinationId, catalogue, existing)).toMatchObject({ status: 'failed', detail: expect.stringMatching(/payload/i) })
    expect(m.transport).not.toHaveBeenCalled()
  })
  it.each(['failed', 'refused', 'not_offered'] as const)('never reports reconciliation success for a %s subscription', status => {
    const result = { configured: true, environment: 'production' as const, endpoint, destinationId: 'destination-fixture', catalogue: topicIds, notOffered: [], perTopic: [{ topicId: topicIds[0], status }] }
    expect(ebayNotificationSetupSucceeded(result)).toBe(false)
    expect(ebayNotificationSetupSucceeded({ ...result, perTopic: [{ topicId: topicIds[0], status: 'already_exists' }] })).toBe(true)
    expect(ebayNotificationSetupSucceeded({ ...result, perTopic: [] })).toBe(false)
  })

  it('fails closed at the page bound with continuation remaining', async () => {
    let page = 0
    m.transport.mockImplementation(async () => jsonResponse({ topics: [topics[0]], next: `${API}/topic?cursor=${++page}` }))
    await expect(getEbayTopics()).rejects.toThrow(/pagination.*incomplete/i)
    expect(m.transport).toHaveBeenCalledTimes(20)
  })

  it('reports a remote read failure as a configured failed attempt, not no call made', async () => {
    m.transport.mockResolvedValueOnce(new Response('{"error":"forbidden"}', { status: 403 }))
    const result = await setupEbayNotifications()
    expect(result).toMatchObject({ configured: true, error: expect.stringContaining('403') })
    expect(m.transport).toHaveBeenCalledTimes(1)
  })

  it('refuses a disabled matching destination before subscribing', async () => {
    m.transport.mockResolvedValueOnce(jsonResponse({ topics }))
      .mockResolvedValueOnce(jsonResponse({ destinations: [{ ...destination, status: 'DISABLED' }] }))
    expect(await setupEbayNotifications()).toMatchObject({ configured: true, error: expect.stringMatching(/destination.*DISABLED/i) })
    expect(m.transport).toHaveBeenCalledTimes(2)
    expect(m.transport.mock.calls.every(([, request]) => request.method === 'GET')).toBe(true)
  })

  it('does not let the legacy false override enable a missing handler', async () => {
    const completeCatalogue = [...topics, { ...topics[0], topicId: 'ORDER_CONFIRMATION' }]
    const subscriptions = topicIds.map(topicId => ({ topicId, destinationId: destination.destinationId, subscriptionId: topicId, status: 'ENABLED', payload }))
    m.transport.mockResolvedValueOnce(jsonResponse({ topics: completeCatalogue }))
      .mockResolvedValueOnce(jsonResponse({ destinations: [destination] }))
      .mockResolvedValueOnce(jsonResponse({ subscriptions }))
    const result = await setupEbayNotifications({ skipTopicsWithoutHandlers: false })
    expect(result.perTopic.map(t => t.topicId)).toEqual(topicIds)
    expect(m.transport).toHaveBeenCalledTimes(3)
    expect(m.transport.mock.calls.every(([, request]) => request.method === 'GET')).toBe(true)
  })

  it.each([
    [{ format: ['XML'], deliveryProtocol: 'HTTPS', schemaVersion: '1.0' }],
    [{ format: ['JSON'], deliveryProtocol: 'EMAIL', schemaVersion: '1.0' }],
    [{ format: ['JSON'], deliveryProtocol: 'HTTPS', schemaVersion: '1.0', deprecated: true }],
  ])('refuses incompatible payloads before obtaining credentials or enabling a subscription', async payload => {
    const incompatible = new Map([[topicIds[0], { ...topics[0], supportedPayloads: [payload] }]])
    expect(await subscribeEbayTopic('production', topicIds[0], destination.destinationId, incompatible, []))
      .toMatchObject({ status: 'failed' })
    expect(m.token).not.toHaveBeenCalled()
    expect(m.transport).not.toHaveBeenCalled()
  })

  it('never creates or enables a topic whose handler is missing', async () => {
    const unsupported = new Map([['ORDER_CONFIRMATION', { ...topics[0], topicId: 'ORDER_CONFIRMATION' }]])
    const existing = [{ topicId: 'ORDER_CONFIRMATION', destinationId: destination.destinationId, subscriptionId: 'disabled', status: 'DISABLED' }]
    expect(await subscribeEbayTopic('production', 'ORDER_CONFIRMATION', destination.destinationId, unsupported, existing)).toMatchObject({ status: 'refused' })
    expect(m.transport).not.toHaveBeenCalled()
  })

  it.each(['topic', 'destination', 'subscription'] as const)('reads every %s page using documented absolute next URLs', async resource => {
    const first = `${API}/${resource}?limit=100`
    const next = `${first}&continuation_token=page2`
    const key = `${resource}s`
    m.transport.mockResolvedValueOnce(jsonResponse({ [key]: [], next }))
      .mockResolvedValueOnce(jsonResponse({ [key]: [resource === 'topic' ? topics[0] : resource === 'destination' ? destination : { subscriptionId: 's', topicId: topicIds[0] }] }))
    const get = resource === 'topic' ? getEbayTopics : resource === 'destination' ? getEbayDestinations : getEbaySubscriptions
    expect(await get()).toHaveLength(1)
    expect(m.transport.mock.calls.map(([url]) => url)).toEqual([first, next])
  })

  it.each(['https://evil.example/commerce/notification/v1/topic', `${API}/destination`, `${API}/topic?limit=100`])('refuses unsafe or repeated pagination instead of returning partial success', async next => {
    m.transport.mockImplementation(async () => jsonResponse({ topics: [topics[0]], next }))
    await expect(getEbayTopics()).rejects.toThrow(/pagination/i)
    expect(m.transport).toHaveBeenCalledTimes(1)
  })
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
      destinationId: destination.destinationId, status: 'DISABLED', payload,
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
      destinationId: destination.destinationId, status: 'ENABLED', payload,
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
