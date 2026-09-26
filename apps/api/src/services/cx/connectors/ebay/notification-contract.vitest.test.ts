import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ transport: vi.fn(), token: vi.fn() }))
vi.mock('./client.js', () => ({ ebayAppToken: m.token }))
vi.mock('../../../gateway/ebay.js', () => ({ ebayTransport: () => m.transport }))
vi.mock('../../../../utils/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }))
const { createEbayDestination, getEbayDestinations, getEbayTopics, getEbaySubscriptions, setupEbayNotifications, subscribeEbayTopic, ebayNotificationSetupSucceeded, sendEbayTestNotice, ensureEbayAlertEmail } = await import('./notifications.js')

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
// v1 subscribes AUTHORIZATION_REVOCATION only (application scope). Deletion is portal-only
// and ORDER_CONFIRMATION is a per-seller USER topic, so the fixture catalogue lists them too.
const topicIds = ['AUTHORIZATION_REVOCATION']
const alertEmail = 'alerts-fixture@example.test'
const supportedPayloads = [{ format: ['JSON'], deliveryProtocol: 'HTTPS', schemaVersion: '1.0', deprecated: false }]
const topics = topicIds.map(topicId => ({ topicId, status: 'ENABLED', scope: 'APPLICATION', supportedPayloads }))
const fullCatalogue = [
  ...topics,
  { topicId: 'MARKETPLACE_ACCOUNT_DELETION', status: 'ENABLED', scope: 'APPLICATION', supportedPayloads },
  { topicId: 'ORDER_CONFIRMATION', status: 'ENABLED', scope: 'USER', supportedPayloads },
]
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
  // Wire-contract controls run ARMED; notification-readiness proves the unarmed defaults.
  vi.stubEnv('NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP', '1')
  vi.stubEnv('NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS', 'AUTHORIZATION_REVOCATION')
  vi.stubEnv('EBAY_NOTIFICATION_ALERT_EMAIL', alertEmail)
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
    const result = { configured: true, armed: true, environment: 'production' as const, endpoint, destinationId: 'destination-fixture', catalogue: topicIds, notOffered: [], perTopic: [{ topicId: topicIds[0], status }] }
    expect(ebayNotificationSetupSucceeded(result)).toBe(false)
    expect(ebayNotificationSetupSucceeded({ ...result, perTopic: [{ topicId: topicIds[0], status: 'already_exists' }] })).toBe(true)
    expect(ebayNotificationSetupSucceeded({ ...result, armed: false, perTopic: [{ topicId: topicIds[0], status: 'already_exists' }] })).toBe(false)
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
    const subscriptions = topicIds.map(topicId => ({ topicId, destinationId: destination.destinationId, subscriptionId: topicId, status: 'ENABLED', payload }))
    m.transport.mockResolvedValueOnce(jsonResponse({ topics: fullCatalogue }))
      .mockResolvedValueOnce(jsonResponse({ destinations: [destination] }))
      .mockResolvedValueOnce(jsonResponse({ alertEmail }))
      .mockResolvedValueOnce(jsonResponse({ subscriptions }))
    const result = await setupEbayNotifications({ skipTopicsWithoutHandlers: false })
    expect(result.perTopic.map(t => t.topicId)).toEqual(topicIds)
    expect(m.transport).toHaveBeenCalledTimes(4)
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
      if (url === `${API}/config`) return jsonResponse({ alertEmail })
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
    expect(m.transport).toHaveBeenCalledTimes(4)
    expect(m.transport.mock.calls.every(([, request]) => request.method === 'GET')).toBe(true)
  })
})

/** A stateful stand-in for eBay's Notification API, served through the stubbed gateway. */
function fakeEbay(initial: { alertEmail?: string | null; destinations?: object[]; subscriptions?: object[] } = {}) {
  const state = {
    alertEmail: initial.alertEmail ?? null as string | null,
    destinations: [...(initial.destinations ?? [])] as any[],
    subscriptions: [...(initial.subscriptions ?? [])] as any[],
    requests: [] as string[],
  }
  m.transport.mockImplementation(async (url: string, request: RequestInit) => {
    const method = request.method ?? 'GET'
    state.requests.push(`${method} ${url.replace(API, '')}`)
    const body = request.body ? JSON.parse(String(request.body)) : null
    if (method === 'GET' && url === `${API}/topic?limit=100`) return jsonResponse({ topics: fullCatalogue, total: fullCatalogue.length })
    if (method === 'GET' && url === `${API}/destination?limit=100`) return jsonResponse({ destinations: state.destinations, total: state.destinations.length })
    if (method === 'GET' && url === `${API}/subscription?limit=100`) return jsonResponse({ subscriptions: state.subscriptions, total: state.subscriptions.length })
    if (method === 'GET' && url === `${API}/config`) {
      return state.alertEmail ? jsonResponse({ alertEmail: state.alertEmail }) : new Response(null, { status: 404 })
    }
    if (method === 'PUT' && url === `${API}/config`) { state.alertEmail = body.alertEmail; return new Response(null, { status: 204 }) }
    if (method === 'POST' && url === `${API}/destination`) {
      // eBay's documented rule: a destination needs the alert-email config first.
      if (!state.alertEmail) return new Response(JSON.stringify({ errors: [{ errorId: 195003 }] }), { status: 400 })
      state.destinations.push({ destinationId: 'destination-created', status: body.status, deliveryConfig: body.deliveryConfig })
      return createdResponse('destination', 'destination-created')
    }
    if (method === 'POST' && url === `${API}/subscription`) {
      state.subscriptions.push({ subscriptionId: `subscription-${body.topicId}`, topicId: body.topicId, destinationId: body.destinationId, status: body.status, payload: body.payload })
      return createdResponse('subscription', `subscription-${body.topicId}`)
    }
    if (method === 'POST' && /\/subscription\/[^/]+\/test$/.test(url)) return new Response(null, { status: 202 })
    throw new Error(`Unexpected notification request: ${method} ${url}`)
  })
  return state
}

describe('S1: an application-level setup eBay accepts', () => {
  it('sets a missing alert-email config from EBAY_NOTIFICATION_ALERT_EMAIL before creating the destination', async () => {
    const ebay = fakeEbay()
    const result = await setupEbayNotifications()
    expect(ebay.requests).toEqual([
      'GET /topic?limit=100', 'GET /destination?limit=100', 'GET /config', 'PUT /config',
      'POST /destination', 'GET /subscription?limit=100', 'POST /subscription',
    ])
    expect(JSON.parse(m.transport.mock.calls[3][1].body)).toEqual({ alertEmail })
    expect(result).toMatchObject({ armed: true, alertEmail: 'set', destinationId: 'destination-created', perTopic: [{ topicId: 'AUTHORIZATION_REVOCATION', status: 'created' }] })
    expect(ebayNotificationSetupSucceeded(result)).toBe(true)
  })

  it('leaves an existing alert-email config alone', async () => {
    const ebay = fakeEbay({ alertEmail: 'someone-else@example.test' })
    const result = await setupEbayNotifications()
    expect(ebay.requests).not.toContain('PUT /config')
    expect(ebay.alertEmail).toBe('someone-else@example.test')
    expect(result).toMatchObject({ alertEmail: 'present', perTopic: [{ status: 'created' }] })
  })

  it.each([undefined, '', 'not-an-email'])('refuses with zero writes when the config is missing and the alert email is %j', async value => {
    vi.stubEnv('EBAY_NOTIFICATION_ALERT_EMAIL', value)
    const ebay = fakeEbay()
    const result = await setupEbayNotifications()
    expect(ebay.requests.every(request => request.startsWith('GET '))).toBe(true)
    expect(ebay.requests).not.toContain('POST /destination')
    expect(result).toMatchObject({ destinationId: null, perTopic: [], error: expect.stringMatching(/EBAY_NOTIFICATION_ALERT_EMAIL/) })
    if (value) expect(result.error).not.toContain(value)
    expect(ebayNotificationSetupSucceeded(result)).toBe(false)
  })

  it('creates the revocation subscription once; a second run makes only GETs', async () => {
    const ebay = fakeEbay()
    expect((await setupEbayNotifications()).perTopic).toEqual([{ topicId: 'AUTHORIZATION_REVOCATION', status: 'created', subscriptionId: 'subscription-AUTHORIZATION_REVOCATION' }])
    const writes = ebay.requests.filter(request => !request.startsWith('GET ')).length
    ebay.requests.length = 0
    const second = await setupEbayNotifications()
    expect(second.perTopic).toEqual([{ topicId: 'AUTHORIZATION_REVOCATION', status: 'already_exists', subscriptionId: 'subscription-AUTHORIZATION_REVOCATION' }])
    expect(writes).toBe(3)
    expect(ebay.requests).toEqual(['GET /topic?limit=100', 'GET /destination?limit=100', 'GET /config', 'GET /subscription?limit=100'])
    expect(ebay.subscriptions).toHaveLength(1)
    // Portal-only deletion and the USER-level order topic were never sent to eBay.
    expect(ebay.subscriptions.map(s => s.topicId)).toEqual(['AUTHORIZATION_REVOCATION'])
  })

  const errorCases = [
    [195003, /alert.?email/i],
    [195019, /32.*80.*A-Za-z0-9_-/],
    [195020, /challenge/i],
    [195021, /already has a destination for this endpoint/i],
  ] as const
  it.each(errorCases)('names eBay errorId %i in the result without exposing a secret', async (errorId, meaning) => {
    fakeEbay({ alertEmail })
    const echo = { errors: [{ errorId, domain: 'API_NOTIFICATION', message: `synthetic echo ${verificationToken} ${alertEmail}`, parameters: [{ name: 'verificationToken', value: verificationToken }] }] }
    const inner = m.transport.getMockImplementation()!
    m.transport.mockImplementation(async (url: string, request: RequestInit) =>
      request.method === 'POST' && url === `${API}/destination` ? new Response(JSON.stringify(echo), { status: 400 }) : inner(url, request))
    const result = await setupEbayNotifications()
    expect(result.error).toContain(`errorId ${errorId}`)
    expect(result.error).toMatch(meaning)
    expect(JSON.stringify(result)).not.toContain(verificationToken)
    expect(JSON.stringify(result)).not.toContain(alertEmail)
  })

  it('gives each named error id its own explanation', async () => {
    const messages = new Set<string>()
    for (const [errorId] of errorCases) {
      m.transport.mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ errorId }] }), { status: 400 }))
      const error = await createEbayDestination('production', 'Nexus', endpoint, verificationToken).catch((err: Error) => err.message)
      messages.add(String(error).split(String(errorId)).join(''))
    }
    expect(messages.size).toBe(errorCases.length)
  })

  it('195021 (409): reuses the destination a re-read finds for exactly our endpoint, and subscribes', async () => {
    const ebay = fakeEbay({ alertEmail })
    const inner = m.transport.getMockImplementation()!
    let destinationReads = 0
    m.transport.mockImplementation(async (url: string, request: RequestInit) => {
      if (request.method === 'GET' && url === `${API}/destination?limit=100`) {
        // The first read misses it (for example, created by a concurrent run); the re-read sees it.
        ebay.requests.push('GET /destination?limit=100')
        return jsonResponse({ destinations: ++destinationReads === 1 ? [] : [destination] })
      }
      if (request.method === 'POST' && url === `${API}/destination`) {
        ebay.requests.push('POST /destination')
        return new Response(JSON.stringify({ errors: [{ errorId: 195021, message: 'Destination exists for this endpoint' }] }), { status: 409 })
      }
      return inner(url, request)
    })
    const result = await setupEbayNotifications()
    expect(result).toMatchObject({ destinationId: destination.destinationId, perTopic: [{ topicId: 'AUTHORIZATION_REVOCATION', status: 'created' }] })
    expect(result.error).toBeUndefined()
    expect(ebayNotificationSetupSucceeded(result)).toBe(true)
    expect(ebay.requests.filter(r => r === 'POST /destination')).toHaveLength(1)
    expect(ebay.subscriptions[0]).toMatchObject({ destinationId: destination.destinationId })
  })

  it.each([
    ['no destination with exactly our endpoint', [{ ...destination, deliveryConfig: { endpoint: `${endpoint}/` } }], /already has a destination/i],
    ['a DISABLED destination for our endpoint', [{ ...destination, status: 'DISABLED' }], /DISABLED.*repair/i],
  ])('195021 (409) with %s stays a failure and subscribes nothing', async (_label, reread, message) => {
    const ebay = fakeEbay({ alertEmail })
    const inner = m.transport.getMockImplementation()!
    let destinationReads = 0
    m.transport.mockImplementation(async (url: string, request: RequestInit) => {
      if (request.method === 'GET' && url === `${API}/destination?limit=100`) return jsonResponse({ destinations: ++destinationReads === 1 ? [] : reread })
      if (request.method === 'POST' && url === `${API}/destination`) return new Response(JSON.stringify({ errors: [{ errorId: 195021 }] }), { status: 409 })
      return inner(url, request)
    })
    const result = await setupEbayNotifications()
    expect(result.error).toMatch(message)
    expect(ebayNotificationSetupSucceeded(result)).toBe(false)
    expect(ebay.subscriptions).toHaveLength(0)
    expect(ebay.requests).not.toContain('POST /subscription')
  })

  // Review: a choke point that refused only POST survived every test. PUT is the config write.
  it('never sends the config PUT while unarmed, even after the read', async () => {
    vi.stubEnv('NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS', undefined)
    const ebay = fakeEbay()
    await expect(ensureEbayAlertEmail('production')).rejects.toThrow(/not armed/i)
    expect(ebay.requests).toEqual(['GET /config'])
    expect(ebay.alertEmail).toBeNull()
  })

  it('positive control: armed, the same call sends the config PUT', async () => {
    const ebay = fakeEbay()
    await expect(ensureEbayAlertEmail('production')).resolves.toBe('set')
    expect(ebay.requests).toEqual(['GET /config', 'PUT /config'])
    expect(ebay.alertEmail).toBe(alertEmail)
  })

  it('asks eBay for a test notice on our armed revocation subscription', async () => {
    const ebay = fakeEbay({
      alertEmail,
      destinations: [destination],
      subscriptions: [{ subscriptionId: 'sub-1', topicId: 'AUTHORIZATION_REVOCATION', destinationId: destination.destinationId, status: 'ENABLED', payload }],
    })
    expect(await sendEbayTestNotice('production', 'AUTHORIZATION_REVOCATION')).toEqual({ ok: true, topicId: 'AUTHORIZATION_REVOCATION', subscriptionId: 'sub-1' })
    expect(ebay.requests).toEqual(['GET /destination?limit=100', 'GET /subscription?limit=100', 'POST /subscription/sub-1/test'])
  })

  it('never asks for a test notice on a subscription that is not ours', async () => {
    const ebay = fakeEbay({
      destinations: [destination],
      subscriptions: [{ subscriptionId: 'foreign', topicId: 'AUTHORIZATION_REVOCATION', destinationId: 'someone-else', status: 'ENABLED', payload }],
    })
    expect(await sendEbayTestNotice('production', 'AUTHORIZATION_REVOCATION')).toMatchObject({ ok: false, error: expect.stringMatching(/setup/i) })
    expect(ebay.requests.every(request => request.startsWith('GET '))).toBe(true)
  })

  it.each(['ORDER_CONFIRMATION', 'MARKETPLACE_ACCOUNT_DELETION'])('refuses a test notice for the unarmed topic %s without a call', async topicId => {
    expect(await sendEbayTestNotice('production', topicId)).toMatchObject({ ok: false })
    expect(m.transport).not.toHaveBeenCalled()
  })
})
