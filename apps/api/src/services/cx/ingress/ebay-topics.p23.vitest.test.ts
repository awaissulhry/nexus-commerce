/**
 * P2.3 — eBay topic routing, and the configuration that must not drift.
 *
 * Context for every assertion here: before this package there was no eBay destination
 * and no subscription, so **no genuine eBay notification had ever arrived**. All seven
 * EBAY rows in the inbound ledger are this repository's own probes from 2026-08-29, one
 * of them named `probe.deploy.wait`. That is why three invented topic names could sit
 * in the receiver unchallenged — nothing real ever disagreed with them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { ebayTopicAction, knownEbayTopicIds, legacyEbayTopicAliases } = await import('./ebay-topics.js')
const { EBAY_DESIRED_TOPICS, ebayNotificationConfig, subscribeEbayTopic } = await import('../connectors/ebay/notifications.js')

const orderPayload = (topic: string | null, orderId = '12-34567-89012') => ({
  ...(topic ? { metadata: { topic } } : {}),
  notification: { data: { order: { orderId } } },
})

const envBefore = { ...process.env }
afterEach(() => { process.env = { ...envBefore } })

describe('routing an eBay notification', () => {
  it('routes the lifecycle topics eBay really has', () => {
    expect(ebayTopicAction('MARKETPLACE_ACCOUNT_DELETION', {})).toEqual({ action: 'account_deletion', via: 'topic' })
    expect(ebayTopicAction('AUTHORIZATION_REVOCATION', {})).toEqual({ action: 'authorization_revoked', via: 'topic' })
  })

  it('still routes the invented names, and marks them as the legacy aliases they are', () => {
    // Not because eBay sends them — it never has — but because rows carrying them are
    // in the ledger and a replay must still reach a handler.
    const decision = ebayTopicAction('marketplace.order.created', {})
    expect(decision.action).toBe('order_created')
    expect(decision.via).toBe('legacy_alias')
    expect(ebayTopicAction('ItemRevised', {}).action).toBe('listing_changed')
  })

  it('acts on an UNKNOWN topic that carries an order id, rather than dropping the sale', () => {
    // The real topic id for a sale is the one thing this codebase cannot supply for
    // itself. Dropping a genuine sale because its topic was not the string we guessed
    // is the worse failure, and the order service is idempotent.
    const decision = ebayTopicAction('SOME_TOPIC_WE_HAVE_NEVER_SEEN', orderPayload('SOME_TOPIC_WE_HAVE_NEVER_SEEN'))
    expect(decision.action).toBe('order_created')
    expect(decision.via).toBe('payload_shape')
  })

  it('never reads a flat data.orderId: eBay nests the order (notification.data.order.orderId)', () => {
    expect(ebayTopicAction('SOME_TOPIC_WE_HAVE_NEVER_SEEN', { notification: { data: { orderId: '12-34567-89012' } } })).toEqual({ action: null, via: 'none' })
    expect(ebayTopicAction(null, { notification: { orderId: '12-34567-89012' } })).toEqual({ action: null, via: 'none' })
  })

  it('does nothing for an unknown topic with nothing in it', () => {
    expect(ebayTopicAction('WHO_KNOWS', { notification: { data: {} } })).toEqual({ action: null, via: 'none' })
    expect(ebayTopicAction(null, {})).toEqual({ action: null, via: 'none' })
  })
})

describe('the invented names must never be offered to eBay', () => {
  it('keeps the legacy aliases out of the subscription list', () => {
    const aliases = legacyEbayTopicAliases()
    // Positive control: if this list were empty the loop below would assert nothing.
    expect(aliases.length).toBeGreaterThan(0)
    const subscribed = EBAY_DESIRED_TOPICS.map((t) => t.topicId)
    for (const alias of aliases) {
      expect(subscribed).not.toContain(alias)
      expect(knownEbayTopicIds()).not.toContain(alias)
    }
  })

  it('every topic we would subscribe is one the router can act on', () => {
    // Otherwise a subscription delivers events that reach the final `else` — recorded
    // by P2.1, dead-lettered, and useless.
    const routable = new Set(knownEbayTopicIds())
    for (const wish of EBAY_DESIRED_TOPICS) {
      expect(routable.has(wish.topicId)).toBe(true)
    }
  })
})

describe('the endpoint configuration cannot drift', () => {
  it('reads the SAME variables the challenge endpoint answers with', () => {
    // eBay computes SHA256(challengeCode + verificationToken + endpoint) from what the
    // DESTINATION says; we compute it from these. Two names for one fact means two
    // different hashes, a failed ownership check, and eBay marking the endpoint down
    // after 24 hours — taking every topic with it. The first draft of the setup did
    // exactly that, reading EBAY_NOTIFICATION_ENDPOINT / EBAY_VERIFICATION_TOKEN.
    process.env.EBAY_NOTIFICATION_ENDPOINT_URL = 'https://api.example/api/webhooks/ebay-notification'
    process.env.EBAY_NOTIFICATION_VERIFICATION_TOKEN = 'a-token-of-sufficient-length-1234'
    expect(ebayNotificationConfig()).toEqual({
      endpoint: 'https://api.example/api/webhooks/ebay-notification',
      verificationToken: 'a-token-of-sufficient-length-1234',
    })
  })

  it('reports nothing rather than a blank when it is unset', () => {
    delete process.env.EBAY_NOTIFICATION_ENDPOINT_URL
    delete process.env.EBAY_NOTIFICATION_VERIFICATION_TOKEN
    // An empty string would still hash to a well-formed, WRONG answer.
    expect(ebayNotificationConfig()).toEqual({ endpoint: null, verificationToken: null })
  })
})


describe("the subscription asks for the version eBay lists for that topic", () => {
  it('refuses to subscribe a topic eBay does not offer, without calling anything', async () => {
    const out = await subscribeEbayTopic('production', 'NOT_A_REAL_TOPIC', 'dest-1', new Map(), [])
    expect(out.status).toBe('not_offered')
  })

  it('refuses rather than guessing when eBay lists no usable payload version', async () => {
    // P2.2 found one hardcoded payload version standing for every Amazon notification
    // type, which would have been refused outright for one of them. The first draft of
    // the eBay subscribe had exactly the same constant, '1.0'. The version now comes
    // from the topic's own supportedPayloads, and a topic that offers none is a refusal
    // rather than a guess.
    const catalogue = new Map([['ITEM_SOLD', { topicId: 'ITEM_SOLD', supportedPayloads: [{ format: 'JSON', schemaVersion: '1.0', deprecated: true }] }]])
    const out = await subscribeEbayTopic('production', 'ITEM_SOLD', 'dest-1', catalogue as any, [])
    expect(out.status).toBe('failed')
    expect(out.detail).toContain('no usable payload version')
  })
})

// DOCUMENTED fixture: eBay Notification API release 1.6.6 (2025-12-01).
// https://www.developer.ebay.com/develop/api/notification/release-notes
it('names ORDER_CONFIRMATION for seller checkout, keeping ITEM_SOLD only for old ledger replays', () => {
  expect(EBAY_DESIRED_TOPICS.map(t => t.topicId)).toContain('ORDER_CONFIRMATION')
  expect(EBAY_DESIRED_TOPICS.map(t => t.topicId)).not.toContain('ITEM_SOLD')
  expect(ebayTopicAction('ORDER_CONFIRMATION', {})).toEqual({ action: 'order_created', via: 'topic' })
  expect(ebayTopicAction('ITEM_SOLD', {})).toEqual({ action: 'order_created', via: 'legacy_alias' })
})
