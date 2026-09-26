import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ token: vi.fn(), transport: vi.fn() }))
vi.mock('./client.js', () => ({ ebayAppToken: calls.token }))
vi.mock('../../../gateway/ebay.js', () => ({ ebayTransport: () => calls.transport }))
const {
  EBAY_DESIRED_TOPICS, setupEbayNotifications, subscribeEbayTopic, createEbayDestination, ebayNotificationSetupGate, sendEbayTestNotice,
} = await import('./notifications.js')

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('EBAY_NOTIFICATION_ENDPOINT_URL', 'https://example.test/api/webhooks/ebay-notification')
  vi.stubEnv('EBAY_NOTIFICATION_VERIFICATION_TOKEN', 'AZaz09_-'.repeat(4))
  vi.stubEnv('NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP', undefined)
  vi.stubEnv('NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS', undefined)
  calls.token.mockResolvedValue('fixture-token')
  calls.transport.mockRejectedValue(new Error('No channel call is allowed while setup is unarmed'))
})
afterEach(() => vi.unstubAllEnvs())

const wish = (topicId: string) => EBAY_DESIRED_TOPICS.find(topic => topic.topicId === topicId)

describe('v1 scope: account revocation by subscription, account deletion by the developer portal', () => {
  it('marks AUTHORIZATION_REVOCATION ready and application-level (the C8 check is written in the plan)', () => {
    expect(wish('AUTHORIZATION_REVOCATION')).toMatchObject({ delivery: 'application' })
    expect(wish('AUTHORIZATION_REVOCATION')?.handlerMissing).toBeFalsy()
  })
  it('keeps MARKETPLACE_ACCOUNT_DELETION portal-only and its erasure handler unready', () => {
    expect(wish('MARKETPLACE_ACCOUNT_DELETION')).toMatchObject({ delivery: 'portal', handlerMissing: true })
  })
  it('defers ORDER_CONFIRMATION: a per-seller USER topic with no ready handler', () => {
    expect(wish('ORDER_CONFIRMATION')).toMatchObject({ delivery: 'user', handlerMissing: true })
  })
  it('drops the two buy-side item topics', () => {
    const ids = EBAY_DESIRED_TOPICS.map(topic => topic.topicId)
    expect(ids).toEqual(['MARKETPLACE_ACCOUNT_DELETION', 'AUTHORIZATION_REVOCATION', 'ORDER_CONFIRMATION'])
    expect(ids).not.toContain('ITEM_PRICE_REVISION')
    expect(ids).not.toContain('ITEM_AVAILABILITY')
  })
})

describe('the arming gate: setup needs the old switch AND an Owner-named topic list', () => {
  // The stale-environment case the review found: the scheduler may still hold the old
  // switch from before 2026-09-22. That alone must never reach eBay.
  it.each([
    ['old switch alone (stale environment)', '1', undefined],
    ['old switch with an empty list', '1', ''],
    ['old switch with only separators', '1', ' , ,'],
    ['a portal-only topic', '1', 'MARKETPLACE_ACCOUNT_DELETION'],
    ['a per-seller USER topic', '1', 'ORDER_CONFIRMATION'],
    ['a dropped item topic', '1', 'ITEM_AVAILABILITY'],
    ['one bad entry beside a good one', '1', 'AUTHORIZATION_REVOCATION,ORDER_CONFIRMATION'],
    ['a lower-case topic id', '1', 'authorization_revocation'],
    ['the list without the old switch', undefined, 'AUTHORIZATION_REVOCATION'],
    ['the list with switch 0', '0', 'AUTHORIZATION_REVOCATION'],
    ['the list with switch true', 'true', 'AUTHORIZATION_REVOCATION'],
  ])('stays unarmed and makes no call: %s', async (_label, setup, armed) => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP', setup)
    vi.stubEnv('NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS', armed)
    const gate = ebayNotificationSetupGate()
    expect(gate).toMatchObject({ armed: false, topics: [], reason: expect.any(String) })
    const result = await setupEbayNotifications()
    expect(result).toMatchObject({ armed: false, destinationId: null, perTopic: [], error: expect.stringMatching(/not armed/i) })
    await expect(createEbayDestination('production', 'Nexus', 'https://example.test/hook', 'AZaz09_-'.repeat(4))).rejects.toThrow(/not armed/i)
    expect(await sendEbayTestNotice('production', 'AUTHORIZATION_REVOCATION')).toMatchObject({ ok: false, error: expect.stringMatching(/not armed/i) })
    expect(calls.token).not.toHaveBeenCalled()
    expect(calls.transport).not.toHaveBeenCalled()
  })

  it('never echoes an entry that is not a topic id', () => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP', '1')
    vi.stubEnv('NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS', 'secret-looking value=')
    const gate = ebayNotificationSetupGate()
    expect(gate.armed).toBe(false)
    expect(gate.reason).not.toContain('secret-looking')
  })

  it('refuses to arm an application topic whose handler is not ready', () => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP', '1')
    vi.stubEnv('NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS', 'AUTHORIZATION_REVOCATION')
    const revocation = wish('AUTHORIZATION_REVOCATION')!
    revocation.handlerMissing = true
    try {
      expect(ebayNotificationSetupGate()).toMatchObject({ armed: false, reason: expect.stringMatching(/no ready handler/) })
    } finally { delete revocation.handlerMissing }
  })

  // S2 may make the order executor ready; that must still never arm a USER or portal topic.
  it.each(['ORDER_CONFIRMATION', 'MARKETPLACE_ACCOUNT_DELETION'])('refuses to arm %s even once its handler is ready', topicId => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP', '1')
    vi.stubEnv('NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS', topicId)
    const topic = wish(topicId)!
    topic.handlerMissing = false
    try {
      expect(ebayNotificationSetupGate()).toMatchObject({ armed: false, reason: expect.stringMatching(/never subscribed with the application token/) })
    } finally { topic.handlerMissing = true }
  })

  it('positive control: the old switch plus AUTHORIZATION_REVOCATION arms exactly that topic', () => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP', '1')
    vi.stubEnv('NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS', ' AUTHORIZATION_REVOCATION , AUTHORIZATION_REVOCATION ')
    expect(ebayNotificationSetupGate()).toEqual({ armed: true, topics: ['AUTHORIZATION_REVOCATION'], reason: null })
  })
})

describe('never a portal or USER topic with the application token, even when armed', () => {
  beforeEach(() => {
    vi.stubEnv('NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP', '1')
    vi.stubEnv('NEXUS_EBAY_NOTIFICATION_ARMED_TOPICS', 'AUTHORIZATION_REVOCATION')
  })
  const payload = { format: 'JSON', deliveryProtocol: 'HTTPS', schemaVersion: '1.0' }
  const states = (topicId: string) => [[], [{ topicId, destinationId: 'd', subscriptionId: 's', status: 'DISABLED', payload }]]

  it.each(['MARKETPLACE_ACCOUNT_DELETION', 'ORDER_CONFIRMATION'])('refuses to create or enable %s', async topicId => {
    const catalogue = new Map([[topicId, { topicId, scope: 'APPLICATION', supportedPayloads: [{ ...payload, format: ['JSON'] }] }]])
    for (const existing of states(topicId)) {
      expect(await subscribeEbayTopic('production', topicId, 'd', catalogue, existing)).toMatchObject({ status: 'refused' })
    }
    expect(calls.token).not.toHaveBeenCalled()
    expect(calls.transport).not.toHaveBeenCalled()
  })

  it.each(['USER', undefined])('refuses AUTHORIZATION_REVOCATION when eBay lists its scope as %s', async scope => {
    const topicId = 'AUTHORIZATION_REVOCATION'
    const catalogue = new Map([[topicId, { topicId, scope, supportedPayloads: [{ ...payload, format: ['JSON'] }] }]])
    for (const existing of states(topicId)) {
      expect(await subscribeEbayTopic('production', topicId, 'd', catalogue, existing)).toMatchObject({ status: 'refused', detail: expect.stringMatching(/APPLICATION/) })
    }
    expect(calls.transport).not.toHaveBeenCalled()
  })
})
