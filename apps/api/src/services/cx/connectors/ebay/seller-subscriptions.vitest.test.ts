/**
 * GAP2 phase 2 — each eBay account is subscribed to ORDER_CONFIRMATION with its OWN sign-in.
 *
 * eBay is stubbed at the gateway transport; no test reaches a network. The transport factory is
 * recorded, so every test can say WHOSE token a call carried: `ebayTransport(connectionId)` with
 * no Authorization header is the seller's own token (the gateway takes it from the token
 * service for exactly that account); `ebayTransport(null, { appLevel: true })` is the app token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  token: vi.fn(), factory: vi.fn(), transport: vi.fn(), findUnique: vi.fn(), workspaces: vi.fn(), list: vi.fn(),
  seenWorkspaces: [] as Array<string | undefined>,
}))
vi.mock('./client.js', () => ({ ebayAppToken: m.token }))
vi.mock('../../../gateway/ebay.js', () => ({
  ebayTransport: (connectionId: string | null, options?: { appLevel?: boolean }) => {
    m.factory(connectionId, options)
    return (url: string, init: RequestInit) => m.transport(url, init, connectionId, options)
  },
}))
vi.mock('../../../../db.js', () => ({ default: { channelConnection: { findUnique: m.findUnique }, workspace: { findMany: m.workspaces } } }))
vi.mock('../../../connection-resolver.service.js', async () => {
  const { workspaceContext } = await import('../../../../lib/workspace-context.js')
  return {
    listActiveConnections: async (channel: string) => { m.seenWorkspaces.push(workspaceContext()?.workspaceId); return m.list(channel) },
    isOwnConnection: (row: { own?: boolean }) => row.own !== false,
  }
})
vi.mock('../../../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const {
  reconcileEbaySellerSubscriptions, inspectEbaySellerSubscription, reconcileEbaySellersForSetup, ebaySellerSubscriptionStatus,
  sendEbaySellerTestNotice,
  sellerReportFailed, summariseSellerReport,
} = await import('./seller-subscriptions.js')
const { sellerNotificationCall } = await import('./notifications.js')

const API = 'https://api.ebay.com/commerce/notification/v1'
const S = 'https://api.ebay.com/oauth/api_scope'
const endpoint = 'https://example.test/api/webhooks/ebay-notification'
const DEST = 'destination-fixture'
const SELLER = 'conn-seller-a'
const FULL_SCOPES = [S, `${S}/sell.fulfillment`, `${S}/sell.fulfillment.readonly`, `${S}/commerce.notification.subscription`, `${S}/commerce.notification.subscription.readonly`]
const payloads = [
  { format: ['JSON'], deliveryProtocol: 'HTTPS', schemaVersion: '0.9', deprecated: true },
  { format: ['JSON'], deliveryProtocol: 'HTTPS', schemaVersion: '1.0', deprecated: false },
]
const orderTopic = { topicId: 'ORDER_CONFIRMATION', status: 'ENABLED', scope: 'USER', authorizationScopes: [`${S}/sell.fulfillment`, `${S}/sell.fulfillment.readonly`], supportedPayloads: payloads }
const context = { environment: 'production' as const, destinationId: DEST, topic: orderTopic }
const subPayload = { format: 'JSON', deliveryProtocol: 'HTTPS', schemaVersion: '1.0' }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const ebayError = (errorId: number, status = 403) => json({ errors: [{ errorId, message: 'synthetic' }] }, status)

function account(overrides: Record<string, unknown> = {}) {
  return { id: SELLER, channelType: 'EBAY', isActive: true, authStatus: 'connected', grantedScopes: FULL_SCOPES, ...overrides }
}

/**
 * A stand-in for the seller side of eBay's Notification API: each account sees its own list
 * (starting from `subscriptions`), and a subscription it creates is its own.
 */
function fakeSeller(subscriptions: object[] = [], overrides: Partial<Record<'get' | 'create' | 'enable', () => Response>> = {}) {
  const state = { byAccount: new Map<string, any[]>(), requests: [] as string[] }
  const listOf = (connectionId: string) => state.byAccount.get(connectionId) ?? state.byAccount.set(connectionId, [...subscriptions]).get(connectionId)!
  m.transport.mockImplementation(async (url: string, init: RequestInit, connectionId: string) => {
    const method = init.method ?? 'GET'
    state.requests.push(`${method} ${url.replace(API, '')}`)
    if (method === 'GET' && url === `${API}/subscription?limit=100`) return overrides.get?.() ?? json({ subscriptions: listOf(connectionId), total: listOf(connectionId).length })
    if (method === 'POST' && url === `${API}/subscription`) {
      if (overrides.create) return overrides.create()
      const body = JSON.parse(String(init.body))
      const subscriptionId = connectionId === SELLER ? 'sub-created' : `sub-${connectionId}`
      listOf(connectionId).push({ subscriptionId, ...body })
      return new Response(null, { status: 201, headers: { Location: `${API}/subscription/${subscriptionId}` } })
    }
    if (method === 'POST' && /\/subscription\/[^/]+\/enable$/.test(url)) return overrides.enable?.() ?? new Response(null, { status: 204 })
    throw new Error(`Unexpected ${method} ${url}`)
  })
  return state
}

/** `null` leaves a variable unset (an explicit `undefined` would take the default). */
function arm(topics: string | null, setup: string | null = '1') {
  vi.stubEnv('NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP', setup ?? undefined)
  vi.stubEnv('NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS', topics ?? undefined)
}

/** Every eBay call carried THIS seller's own token: the account's transport, no app token, no Authorization header. */
function expectOnlySellerCalls(connectionId = SELLER) {
  expect(m.token).not.toHaveBeenCalled()
  for (const [id, options] of m.factory.mock.calls) {
    expect(id).toBe(connectionId)
    expect(options?.appLevel).toBeFalsy()
  }
  for (const [, init] of m.transport.mock.calls) {
    expect(Object.keys((init as RequestInit).headers ?? {}).map(h => h.toLowerCase())).not.toContain('authorization')
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  m.seenWorkspaces = []
  vi.stubEnv('EBAY_NOTIFICATION_ENDPOINT_URL', endpoint)
  vi.stubEnv('EBAY_NOTIFICATION_VERIFICATION_TOKEN', 'AZaz09_-'.repeat(4))
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', undefined)
  arm('AUTHORIZATION_REVOCATION,ORDER_CONFIRMATION')
  m.token.mockResolvedValue('fixture-app-token')
  m.findUnique.mockResolvedValue(account())
  m.list.mockResolvedValue([])
  m.transport.mockRejectedValue(new Error('No eBay call is expected in this test'))
})
afterEach(() => vi.unstubAllEnvs())

describe('the arming gate: unarmed means no account read, no token, no call', () => {
  it.each([
    ['nothing set', null, null],
    ['the old switch alone', null, '1'],
    ['only the application topic armed (the v1 setting)', 'AUTHORIZATION_REVOCATION', '1'],
    ['the topic named without the switch', 'ORDER_CONFIRMATION', null],
    ['the topic named with the switch at 0', 'ORDER_CONFIRMATION', '0'],
    ['the topic beside a portal topic (nothing is armed)', 'ORDER_CONFIRMATION,MARKETPLACE_ACCOUNT_DELETION', '1'],
  ])('%s → not_armed', async (_label, topics, setup) => {
    arm(topics, setup)
    fakeSeller()
    const result = await reconcileEbaySellerSubscriptions(SELLER, { context })
    expect(result).toMatchObject({ connectionId: SELLER, topicId: 'ORDER_CONFIRMATION', status: 'not_armed', reason: expect.stringMatching(/No eBay call/) })
    expect(m.findUnique).not.toHaveBeenCalled()
    expect(m.token).not.toHaveBeenCalled()
    expect(m.factory).not.toHaveBeenCalled()
    expect(m.transport).not.toHaveBeenCalled()
  })

  it('positive control: named, the same account is read and eBay is asked', async () => {
    arm('ORDER_CONFIRMATION')
    fakeSeller([{ subscriptionId: 's-1', topicId: 'ORDER_CONFIRMATION', destinationId: DEST, status: 'ENABLED', payload: subPayload }])
    expect(await reconcileEbaySellerSubscriptions(SELLER, { context })).toMatchObject({ status: 'subscribed' })
    expect(m.transport).toHaveBeenCalledOnce()
  })

  it('the choke point refuses a seller-token write while only the application topic is armed', async () => {
    arm('AUTHORIZATION_REVOCATION')
    fakeSeller()
    await expect(sellerNotificationCall(SELLER, 'production', 'POST', '/commerce/notification/v1/subscription', { topicId: 'ORDER_CONFIRMATION' }))
      .rejects.toThrow(/not armed/i)
    expect(m.factory).not.toHaveBeenCalled()
    expect(m.transport).not.toHaveBeenCalled()
  })
})

describe("the seller's own sign-in, never the app token", () => {
  it('an enabled subscription on our destination: one read, no write', async () => {
    const ebay = fakeSeller([{ subscriptionId: 's-1', topicId: 'ORDER_CONFIRMATION', destinationId: DEST, status: 'ENABLED', payload: subPayload }])
    expect(await reconcileEbaySellerSubscriptions(SELLER, { context })).toEqual({ connectionId: SELLER, topicId: 'ORDER_CONFIRMATION', status: 'subscribed', subscriptionId: 's-1' })
    expect(ebay.requests).toEqual(['GET /subscription?limit=100'])
    expectOnlySellerCalls()
  })

  it('a missing subscription is created on our destination with the topic\'s own schema version', async () => {
    const ebay = fakeSeller([
      // Another destination's subscription to the same topic is not ours and is left alone.
      { subscriptionId: 'elsewhere', topicId: 'ORDER_CONFIRMATION', destinationId: 'someone-else', status: 'ENABLED', payload: subPayload },
    ])
    expect(await reconcileEbaySellerSubscriptions(SELLER, { context })).toEqual({ connectionId: SELLER, topicId: 'ORDER_CONFIRMATION', status: 'created', subscriptionId: 'sub-created' })
    expect(ebay.requests).toEqual(['GET /subscription?limit=100', 'POST /subscription'])
    const create = m.transport.mock.calls.find(([, init]) => (init as RequestInit).method === 'POST')!
    expect(JSON.parse(String((create[1] as RequestInit).body))).toEqual({
      topicId: 'ORDER_CONFIRMATION', destinationId: DEST, status: 'ENABLED',
      payload: { format: 'JSON', schemaVersion: '1.0', deliveryProtocol: 'HTTPS' },
    })
    expectOnlySellerCalls()
  })

  it('a second run after creating makes only the read', async () => {
    const ebay = fakeSeller()
    await reconcileEbaySellerSubscriptions(SELLER, { context })
    ebay.requests.length = 0
    expect(await reconcileEbaySellerSubscriptions(SELLER, { context })).toMatchObject({ status: 'subscribed', subscriptionId: 'sub-created' })
    expect(ebay.requests).toEqual(['GET /subscription?limit=100'])
  })

  it('a disabled subscription is enabled, never recreated', async () => {
    const ebay = fakeSeller([{ subscriptionId: 's-off', topicId: 'ORDER_CONFIRMATION', destinationId: DEST, status: 'DISABLED', payload: subPayload }])
    expect(await reconcileEbaySellerSubscriptions(SELLER, { context })).toEqual({ connectionId: SELLER, topicId: 'ORDER_CONFIRMATION', status: 'enabled', subscriptionId: 's-off' })
    expect(ebay.requests).toEqual(['GET /subscription?limit=100', 'POST /subscription/s-off/enable'])
    expectOnlySellerCalls()
  })

  it('an existing subscription with a payload eBay no longer advertises is reported, not enabled', async () => {
    const ebay = fakeSeller([{ subscriptionId: 's-old', topicId: 'ORDER_CONFIRMATION', destinationId: DEST, status: 'DISABLED', payload: { ...subPayload, schemaVersion: '0.9' } }])
    expect(await reconcileEbaySellerSubscriptions(SELLER, { context })).toMatchObject({ status: 'failed', reason: expect.stringMatching(/payload/i) })
    expect(ebay.requests).toEqual(['GET /subscription?limit=100'])
  })

  it('without a passed context, the app token only READS the topic and destination; every subscription call is the seller\'s', async () => {
    m.transport.mockImplementation(async (url: string, init: RequestInit, connectionId: string | null) => {
      if (connectionId === null) {
        expect(init.method).toBe('GET')
        if (url === `${API}/topic?limit=100`) return json({ topics: [orderTopic] })
        if (url === `${API}/destination?limit=100`) return json({ destinations: [{ destinationId: DEST, status: 'ENABLED', deliveryConfig: { endpoint } }] })
        throw new Error(`Unexpected app-level ${init.method} ${url}`)
      }
      expect(connectionId).toBe(SELLER)
      if (url === `${API}/subscription?limit=100`) return json({ subscriptions: [] })
      if (init.method === 'POST' && url === `${API}/subscription`) return new Response(null, { status: 201, headers: { Location: `${API}/subscription/sub-new` } })
      throw new Error(`Unexpected seller ${init.method} ${url}`)
    })
    expect(await reconcileEbaySellerSubscriptions(SELLER)).toMatchObject({ status: 'created', subscriptionId: 'sub-new' })
    const subscriptionCalls = m.transport.mock.calls.filter(([url]) => String(url).includes('/subscription'))
    expect(subscriptionCalls).toHaveLength(2)
    for (const [, init, connectionId, options] of subscriptionCalls) {
      expect(connectionId).toBe(SELLER)
      expect(options?.appLevel).toBeFalsy()
      expect(Object.keys((init as RequestInit).headers ?? {}).map(h => h.toLowerCase())).not.toContain('authorization')
    }
    // The app token went only on the two catalogue/destination reads.
    expect(m.token).toHaveBeenCalledTimes(2)
  })
})

describe('reconnect needed only for what the account shows; eBay\'s 195011 is a red failure', () => {
  it.each([
    ['no commerce.notification.subscription', FULL_SCOPES.filter(s => !s.includes('commerce.notification'))],
    ['only the read-only notification scope', FULL_SCOPES.filter(s => !s.endsWith('commerce.notification.subscription'))],
    ['no recorded scope at all', []],
    ['no fulfillment scope', FULL_SCOPES.filter(s => !s.includes('sell.fulfillment'))],
  ])('%s → reconnect_needed before any token or call', async (_label, grantedScopes) => {
    m.findUnique.mockResolvedValue(account({ grantedScopes }))
    fakeSeller()
    expect(await reconcileEbaySellerSubscriptions(SELLER, { context })).toMatchObject({ status: 'reconnect_needed', reason: expect.stringMatching(/Reconnect.*No eBay call/) })
    expect(m.factory).not.toHaveBeenCalled()
    expect(m.transport).not.toHaveBeenCalled()
    expect(m.token).not.toHaveBeenCalled()
  })

  it.each([
    ['needs_reauth', true], ['revoked', true], ['disconnected', true], ['connected', false],
  ])('a sign-in that is %s (active=%s) → reconnect_needed, no call', async (authStatus, isActive) => {
    m.findUnique.mockResolvedValue(account({ authStatus, isActive }))
    fakeSeller()
    expect(await reconcileEbaySellerSubscriptions(SELLER, { context })).toMatchObject({ status: 'reconnect_needed' })
    expect(m.transport).not.toHaveBeenCalled()
  })

  it('positive control: a full sign-in reaches eBay', async () => {
    fakeSeller()
    expect(await reconcileEbaySellerSubscriptions(SELLER, { context })).toMatchObject({ status: 'created' })
  })

  // Review S1: the sign-in already records the scopes, so 195011 is eBay refusing the topic to the
  // app/account. Calling it "reconnect needed" kept the nightly run green and sent the Owner to Reconnect for nothing.
  it('eBay 195011 on the read → failed (not a sign-in problem), and no POST', async () => {
    const ebay = fakeSeller([], { get: () => ebayError(195011) })
    expect(await reconcileEbaySellerSubscriptions(SELLER, { context })).toMatchObject({ status: 'failed', reason: expect.stringMatching(/195011.*not a sign-in problem/) })
    expect(ebay.requests).toEqual(['GET /subscription?limit=100'])
  })

  it('eBay 195011 on the create → failed, and the report fails the run', async () => {
    fakeSeller([], { create: () => ebayError(195011, 403) })
    const result = await reconcileEbaySellerSubscriptions(SELLER, { context })
    expect(result).toMatchObject({ status: 'failed', reason: expect.stringMatching(/refused this topic for the app\/account.*not a sign-in problem/) })
    expect(sellerReportFailed({ accounts: [{ ...result, signInName: null }] })).toBe(true)
  })

  it('eBay 195011 on the enable → failed', async () => {
    fakeSeller([{ subscriptionId: 's-off', topicId: 'ORDER_CONFIRMATION', destinationId: DEST, status: 'DISABLED', payload: subPayload }], { enable: () => ebayError(195011) })
    expect(await reconcileEbaySellerSubscriptions(SELLER, { context })).toMatchObject({ status: 'failed', subscriptionId: 's-off', reason: expect.stringContaining('195011') })
  })

  it('another eBay error is failed(reason), not reconnect', async () => {
    fakeSeller([], { create: () => ebayError(195000, 500) })
    expect(await reconcileEbaySellerSubscriptions(SELLER, { context })).toMatchObject({ status: 'failed', reason: expect.stringContaining('createSubscription returned 500') })
  })

  it('the gateway holding the account (needs sign-in) → reconnect_needed', async () => {
    m.transport.mockRejectedValue(Object.assign(new Error('Held, nothing sent: the eBay account needs to be reconnected (needs_reauth).'), { code: 'ACCOUNT_NEEDS_SIGNIN' }))
    expect(await reconcileEbaySellerSubscriptions(SELLER, { context })).toMatchObject({ status: 'reconnect_needed' })
  })
})

// Review S2: a create that eBay answers "Subscription already exists" (409 / 195012).
describe('"subscription already exists": read the seller\'s list again', () => {
  /** The first read sees `before`; the create answers 409 195012; the re-read sees `after`. */
  function raced(before: object[], after: object[]) {
    const requests: string[] = []
    let reads = 0
    m.transport.mockImplementation(async (url: string, init: RequestInit, connectionId: string) => {
      expect(connectionId).toBe(SELLER)
      const method = init.method ?? 'GET'
      requests.push(`${method} ${url.replace(API, '')}`)
      if (method === 'GET' && url === `${API}/subscription?limit=100`) return json({ subscriptions: ++reads === 1 ? before : after })
      if (method === 'POST' && url === `${API}/subscription`) return ebayError(195012, 409)
      if (method === 'POST' && /\/subscription\/[^/]+\/enable$/.test(url)) return new Response(null, { status: 204 })
      throw new Error(`Unexpected ${method} ${url}`)
    })
    return requests
  }
  const on = (destinationId: string, status: string, subscriptionId = 's-raced') =>
    ({ subscriptionId, topicId: 'ORDER_CONFIRMATION', destinationId, status, payload: subPayload })

  it('a concurrent run made it on our destination → subscribed, no second create', async () => {
    const requests = raced([], [on(DEST, 'ENABLED')])
    expect(await reconcileEbaySellerSubscriptions(SELLER, { context })).toEqual({ connectionId: SELLER, topicId: 'ORDER_CONFIRMATION', status: 'subscribed', subscriptionId: 's-raced' })
    expect(requests).toEqual(['GET /subscription?limit=100', 'POST /subscription', 'GET /subscription?limit=100'])
    expectOnlySellerCalls()
  })

  it('on our destination but disabled → enabled', async () => {
    const requests = raced([], [on(DEST, 'DISABLED')])
    expect(await reconcileEbaySellerSubscriptions(SELLER, { context })).toMatchObject({ status: 'enabled', subscriptionId: 's-raced' })
    expect(requests).toEqual(['GET /subscription?limit=100', 'POST /subscription', 'GET /subscription?limit=100', 'POST /subscription/s-raced/enable'])
  })

  it('on ANOTHER destination → failed, naming that destination', async () => {
    const requests = raced([on('old-destination', 'ENABLED', 's-old')], [on('old-destination', 'ENABLED', 's-old')])
    const result = await reconcileEbaySellerSubscriptions(SELLER, { context })
    expect(result).toMatchObject({ status: 'failed', subscriptionId: 's-old', reason: expect.stringMatching(/another destination \(old-destination\)/) })
    expect(requests.filter(r => r.startsWith('POST'))).toEqual(['POST /subscription'])
  })

  it('eBay says it exists but the list shows none → failed with eBay\'s answer', async () => {
    raced([], [])
    expect(await reconcileEbaySellerSubscriptions(SELLER, { context })).toMatchObject({ status: 'failed', reason: expect.stringMatching(/409.*shows none/) })
  })
})

describe("eBay's catalogue and our destination decide before any seller call", () => {
  it.each([
    ['eBay does not offer the topic', { topic: undefined }, 'not_offered'],
    ['eBay lists it as an APPLICATION topic', { topic: { ...orderTopic, scope: 'APPLICATION' } }, 'failed'],
    ['no usable JSON/HTTPS payload', { topic: { ...orderTopic, supportedPayloads: [payloads[0]] } }, 'failed'],
    ['our destination is missing or not ENABLED', { destinationId: null }, 'failed'],
  ])('%s → %s', async (_label, change, status) => {
    fakeSeller()
    expect(await reconcileEbaySellerSubscriptions(SELLER, { context: { ...context, ...change } as any })).toMatchObject({ status })
    expect(m.transport).not.toHaveBeenCalled()
  })

  it("the topic's own authorisation scopes count: none granted → reconnect_needed", async () => {
    fakeSeller()
    const topic = { ...orderTopic, authorizationScopes: [`${S}/sell.something.else`] }
    expect(await reconcileEbaySellerSubscriptions(SELLER, { context: { ...context, topic } })).toMatchObject({ status: 'reconnect_needed' })
    expect(m.transport).not.toHaveBeenCalled()
  })
})

describe('every account of every active business, after the app-level setup', () => {
  const setup = { configured: true, armed: true, environment: 'production' as const, endpoint, destinationId: DEST, catalogue: ['ORDER_CONFIRMATION'], notOffered: [], perTopic: [], sellerTopics: [orderTopic] }

  it("subscribes this business's own accounts only; a shared-in account is its owner's", async () => {
    m.list.mockResolvedValue([{ id: 'own-1', ebaySignInName: 'seller_one' }, { id: 'shared-in', ebaySignInName: 'other', own: false }, { id: 'own-2', ebaySignInName: null }])
    m.findUnique.mockImplementation(async ({ where }: any) => account({ id: where.id }))
    fakeSeller()
    const report = await reconcileEbaySellersForSetup(setup, 'this_business')
    expect(report.accounts.map(a => [a.connectionId, a.status, a.subscriptionId, a.signInName])).toEqual([['own-1', 'created', 'sub-own-1', 'seller_one'], ['own-2', 'created', 'sub-own-2', null]])
    expect(m.factory.mock.calls.map(([id]) => id)).not.toContain('shared-in')
    expect(sellerReportFailed(report)).toBe(false)
    expect(summariseSellerReport(report)).toBe('sellers: created=2')
  })

  it('two accounts reported with the same subscription: the second is a failure, never "subscribed"', async () => {
    m.list.mockResolvedValue([{ id: 'own-1' }, { id: 'own-2' }])
    m.findUnique.mockImplementation(async ({ where }: any) => account({ id: where.id }))
    fakeSeller([{ subscriptionId: 's-same', topicId: 'ORDER_CONFIRMATION', destinationId: DEST, status: 'ENABLED', payload: subPayload }])
    const report = await reconcileEbaySellersForSetup(setup, 'this_business')
    expect(report.accounts.map(a => [a.connectionId, a.status])).toEqual([['own-1', 'subscribed'], ['own-2', 'failed']])
    expect(report.accounts[1].reason).toMatch(/two eBay accounts/)
    expect(sellerReportFailed(report)).toBe(true)
  })

  it('the nightly scope visits every active business, each in its own context', async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    m.workspaces.mockResolvedValue([{ id: 'ws-a' }, { id: 'ws-b' }])
    m.list.mockResolvedValue([])
    await reconcileEbaySellersForSetup(setup, 'every_business')
    expect(m.seenWorkspaces).toEqual(['ws-a', 'ws-b'])
    expect(m.workspaces).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'active' } }))
  })

  it.each([
    ['ORDER_CONFIRMATION not armed', 'AUTHORIZATION_REVOCATION', setup],
    ['the app-level setup failed', 'ORDER_CONFIRMATION', { ...setup, error: 'eBay topics returned 500' }],
    ['no destination', 'ORDER_CONFIRMATION', { ...setup, destinationId: null }],
  ])('skips every seller when %s', async (_label, topics, result) => {
    arm(topics)
    m.list.mockResolvedValue([{ id: 'own-1' }])
    const report = await reconcileEbaySellersForSetup(result, 'this_business')
    expect(report).toMatchObject({ skipped: expect.any(String), accounts: [] })
    expect(m.list).not.toHaveBeenCalled()
    expect(m.transport).not.toHaveBeenCalled()
  })

  it('one business whose accounts cannot be listed does not stop the next; the report fails', async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    m.workspaces.mockResolvedValue([{ id: 'ws-a' }, { id: 'ws-b' }])
    m.list.mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValueOnce([{ id: 'own-b', ebaySignInName: 'seller_b' }])
    m.findUnique.mockImplementation(async ({ where }: any) => account({ id: where.id }))
    fakeSeller()
    const report = await reconcileEbaySellersForSetup(setup, 'every_business')
    expect(report.accounts.map(a => [a.connectionId, a.status])).toEqual([['own-b', 'created']])
    expect(report.accounts[0].subscriptionId).toBe('sub-own-b')
    expect(report.businessErrors).toEqual(['database unavailable'])
    expect(sellerReportFailed(report)).toBe(true)
    expect(summariseSellerReport(report)).toBe('sellers: created=1 business_errors=1')
  })

  it('a failed seller fails the report; reconnect needed does not', async () => {
    expect(sellerReportFailed({ accounts: [{ connectionId: 'a', topicId: 'ORDER_CONFIRMATION', status: 'reconnect_needed', signInName: null }] })).toBe(false)
    expect(sellerReportFailed({ accounts: [{ connectionId: 'a', topicId: 'ORDER_CONFIRMATION', status: 'failed', signInName: null }] })).toBe(true)
  })
})

describe('the status view (read only)', () => {
  it('reports reconnect needed from the sign-in even before arming, with no call', async () => {
    arm(null, null)
    m.findUnique.mockResolvedValue(account({ grantedScopes: [] }))
    expect(await inspectEbaySellerSubscription(SELLER, context)).toMatchObject({ status: 'reconnect_needed' })
    expect(m.transport).not.toHaveBeenCalled()
  })

  it('reports not_armed with no call for a ready account while the topic is not armed', async () => {
    arm('AUTHORIZATION_REVOCATION')
    expect(await inspectEbaySellerSubscription(SELLER, context)).toMatchObject({ status: 'not_armed' })
    expect(m.factory).not.toHaveBeenCalled()
    expect(m.token).not.toHaveBeenCalled()
  })

  it.each([
    [[{ subscriptionId: 's', topicId: 'ORDER_CONFIRMATION', destinationId: DEST, status: 'ENABLED', payload: subPayload }], 'subscribed'],
    [[{ subscriptionId: 's', topicId: 'ORDER_CONFIRMATION', destinationId: DEST, status: 'DISABLED', payload: subPayload }], 'disabled'],
    [[], 'not_subscribed'],
  ])('reads the seller\'s own subscriptions and never writes: %j → %s', async (subscriptions, status) => {
    const ebay = fakeSeller(subscriptions)
    expect(await inspectEbaySellerSubscription(SELLER, context)).toMatchObject({ status })
    expect(ebay.requests).toEqual(['GET /subscription?limit=100'])
    expectOnlySellerCalls()
  })

  it("lists this business's own accounts with their sign-in name and no eBay ids", async () => {
    m.list.mockResolvedValue([{ id: 'own-1', ebaySignInName: 'seller_one', externalAccountId: 'ebay-user-id' }, { id: 'shared-in', own: false }])
    m.findUnique.mockResolvedValue(account({ id: 'own-1', grantedScopes: [] }))
    const status = await ebaySellerSubscriptionStatus(context)
    expect(status).toEqual({ topicId: 'ORDER_CONFIRMATION', armed: true, accounts: [{ connectionId: 'own-1', signInName: 'seller_one', status: 'reconnect_needed', reason: expect.any(String) }] })
    expect(JSON.stringify(status)).not.toContain('ebay-user-id')
  })
})

// Review N2: eBay's test notice for ONE seller's order subscription, with that seller's own token.
describe('the per-seller test notice', () => {
  const enabled = { subscriptionId: 's-1', topicId: 'ORDER_CONFIRMATION', destinationId: DEST, status: 'ENABLED', payload: subPayload }
  /** App-level reads for the context; the seller's list and the test POST as the seller. */
  function ebayForTest(sellerSubscriptions: object[], testStatus = 202) {
    const requests: string[] = []
    m.transport.mockImplementation(async (url: string, init: RequestInit, connectionId: string | null, options?: { appLevel?: boolean }) => {
      const method = init.method ?? 'GET'
      requests.push(`${connectionId ?? 'app'} ${method} ${url.replace(API, '')}`)
      if (connectionId === null) {
        expect(options?.appLevel).toBe(true)
        expect(method).toBe('GET')
        if (url === `${API}/topic?limit=100`) return json({ topics: [orderTopic] })
        if (url === `${API}/destination?limit=100`) return json({ destinations: [{ destinationId: DEST, status: 'ENABLED', deliveryConfig: { endpoint } }] })
      } else {
        expect(connectionId).toBe(SELLER)
        expect(Object.keys(init.headers ?? {}).map(h => h.toLowerCase())).not.toContain('authorization')
        if (method === 'GET' && url === `${API}/subscription?limit=100`) return json({ subscriptions: sellerSubscriptions })
        if (method === 'POST' && url === `${API}/subscription/s-1/test`) return new Response(null, { status: testStatus })
      }
      throw new Error(`Unexpected ${connectionId} ${method} ${url}`)
    })
    return requests
  }
  beforeEach(() => m.list.mockResolvedValue([{ id: SELLER, ebaySignInName: 'seller_a' }]))

  it.each([
    ['nothing armed', null, null],
    ['only the application topic armed', 'AUTHORIZATION_REVOCATION', '1'],
  ])('unarmed (%s) → refused, no account read, no call', async (_label, topics, setup) => {
    arm(topics, setup)
    ebayForTest([enabled])
    expect(await sendEbaySellerTestNotice(SELLER)).toMatchObject({ ok: false, refused: 'not_armed', error: expect.stringMatching(/No eBay call/) })
    expect(m.list).not.toHaveBeenCalled()
    expect(m.findUnique).not.toHaveBeenCalled()
    expect(m.factory).not.toHaveBeenCalled()
    expect(m.token).not.toHaveBeenCalled()
  })

  it.each([
    ["another business's account (not listed here)", [{ id: 'conn-other-business' }]],
    ['an account another business shares in', [{ id: SELLER, own: false }]],
  ])('%s → refused, no call', async (_label, listed) => {
    m.list.mockResolvedValue(listed)
    ebayForTest([enabled])
    expect(await sendEbaySellerTestNotice(SELLER)).toMatchObject({ ok: false, refused: 'not_own_account' })
    expect(m.findUnique).not.toHaveBeenCalled()
    expect(m.factory).not.toHaveBeenCalled()
  })

  it('an account that needs Reconnect → refused before any call', async () => {
    m.findUnique.mockResolvedValue(account({ grantedScopes: [] }))
    ebayForTest([enabled])
    expect(await sendEbaySellerTestNotice(SELLER)).toMatchObject({ ok: false, refused: 'account', error: expect.stringMatching(/Reconnect/) })
    expect(m.factory).not.toHaveBeenCalled()
  })

  it.each([
    ['no subscription', []],
    ['a subscription on another destination', [{ ...enabled, destinationId: 'someone-else' }]],
    ['a disabled subscription', [{ ...enabled, status: 'DISABLED' }]],
  ])('%s → plain refusal, no test requested', async (_label, subscriptions) => {
    const requests = ebayForTest(subscriptions)
    expect(await sendEbaySellerTestNotice(SELLER)).toMatchObject({ ok: false, refused: 'no_subscription', error: expect.stringMatching(/Run the setup first/) })
    expect(requests.filter(r => r.includes('/test'))).toEqual([])
  })

  it("happy path: eBay answers 202 to THIS seller's own subscription, sent with the seller's token", async () => {
    const requests = ebayForTest([enabled])
    expect(await sendEbaySellerTestNotice(SELLER)).toEqual({ ok: true, topicId: 'ORDER_CONFIRMATION', connectionId: SELLER, subscriptionId: 's-1' })
    expect(requests).toEqual([
      'app GET /topic?limit=100', 'app GET /destination?limit=100',
      `${SELLER} GET /subscription?limit=100`, `${SELLER} POST /subscription/s-1/test`,
    ])
    // The app token went only on the two catalogue/destination reads, never on a subscription call.
    expect(m.token).toHaveBeenCalledTimes(2)
  })

  it('a refusal from eBay on the test is reported, not ok', async () => {
    ebayForTest([enabled], 500)
    expect(await sendEbaySellerTestNotice(SELLER)).toMatchObject({ ok: false, subscriptionId: 's-1', error: expect.stringContaining('testSubscription returned 500') })
  })
})
