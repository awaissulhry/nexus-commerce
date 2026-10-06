/**
 * The eBay notification STATUS endpoint, and the drift that made it unreadable.
 *
 * ## What was measured, 2026-09-21, production
 *
 * `PROGRESS.md` §4 tells the next session to check
 * `GET /api/admin/ebay-notification-status` after the nightly reconcile. It was checked,
 * and it answered:
 *
 * ```json
 * { "environment": "production", "endpoint": null, "destination": null,
 *   "subscriptions": [], "catalogueSize": 27 }
 * ```
 *
 * `catalogueSize: 27` proves the call reached eBay and the keyset works, so the nulls
 * are not a transport failure. But `endpoint` could never be anything else: the handler
 * read `process.env.EBAY_NOTIFICATION_ENDPOINT` while every other reader — the challenge
 * handler eight lines below it, the destination setup, the reconcile job — reads
 * `EBAY_NOTIFICATION_ENDPOINT_URL`.
 *
 * `notifications.ts` fixed exactly this drift in itself and wrote it down: *"two names
 * for one fact, which is the shape of every drift defect in this programme."* The status
 * route was missed.
 *
 * ## Why it matters more here than anywhere else
 *
 * `ours = destinations.find(d => d.endpoint === endpoint)`. With `endpoint` null, every
 * real destination is compared against `null`, nothing matches, and the endpoint reports
 * `destination: null` **whether or not a destination exists**. This file's own header
 * says a status endpoint that cannot see the thing that is broken is worse than none,
 * because it is quoted — and it was quoted.
 *
 * So these tests hold three things: one accessor rather than two names, a null endpoint
 * reported as *"we did not ask"* rather than *"eBay has nothing"*, and the raw catalogue
 * so a wrong topic id is READ rather than guessed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const m = vi.hoisted(() => ({
  topics: vi.fn(),
  destinations: vi.fn(),
  subscriptions: vi.fn(),
}))

vi.mock('../services/cx/connectors/ebay/notifications.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEbayTopics: m.topics,
  getEbayDestinations: m.destinations,
  getEbaySubscriptions: m.subscriptions,
}))
// The per-account view has its own tests (seller-subscriptions, setup-gate); here it reads no database.
vi.mock('../services/cx/connectors/ebay/seller-subscriptions.js', () => ({
  EBAY_ORDER_TOPIC: 'ORDER_CONFIRMATION',
  ebaySellerSubscriptionStatus: async () => ({ topicId: 'ORDER_CONFIRMATION', armed: false, accounts: [] }),
}))

const OUR_ENDPOINT = 'https://api.example.test/api/webhooks/ebay-notification'
const OURS = { destinationId: 'dest-1', endpoint: OUR_ENDPOINT, status: 'ENABLED' }
const SOMEONE_ELSES = { destinationId: 'dest-9', endpoint: 'https://old.example.test/hook', status: 'ENABLED' }

/** Build the app with only this route registered. */
async function status(query = '') {
  const Fastify = (await import('fastify')).default
  const app = Fastify()
  const routes = (await import('./ebay-notification.routes.js')).default
  await app.register(routes, { prefix: '/api' })
  const res = await app.inject({ method: 'GET', url: `/api/admin/ebay-notification-status${query}` })
  await app.close()
  return { statusCode: res.statusCode, body: res.json() as Record<string, any> }
}

beforeEach(() => {
  vi.clearAllMocks()
  m.topics.mockResolvedValue([{ topicId: 'MARKETPLACE_ACCOUNT_DELETION' }, { topicId: 'ITEM_PRICE_REVISION' }])
  m.destinations.mockResolvedValue([])
  m.subscriptions.mockResolvedValue([])
  vi.stubEnv('EBAY_NOTIFICATION_ENDPOINT_URL', OUR_ENDPOINT)
  vi.stubEnv('EBAY_NOTIFICATION_VERIFICATION_TOKEN', 'a-token-long-enough')
})
afterEach(() => vi.unstubAllEnvs())

describe('1. 🔴 one accessor, not two names for one fact', () => {
  it('reads EBAY_NOTIFICATION_ENDPOINT_URL — the name every other reader uses', async () => {
    const { body } = await status()
    expect(body.endpoint).toBe(OUR_ENDPOINT)
  })

  it('🔴 the OLD name alone does NOT configure it', async () => {
    // The regression restated: if the handler ever reads the bare name again, this is
    // the case that goes green while production reports null.
    vi.stubEnv('EBAY_NOTIFICATION_ENDPOINT_URL', '')
    vi.stubEnv('EBAY_NOTIFICATION_ENDPOINT', OUR_ENDPOINT)
    const { body } = await status()
    expect(body.endpoint).toBeNull()
    expect(body.configured.hasEndpoint).toBe(false)
  })

  it('MATCHES a destination that carries our endpoint — the whole point of reading it', async () => {
    m.destinations.mockResolvedValue([SOMEONE_ELSES, OURS])
    const { body } = await status()
    expect(body.destination).toMatchObject({ destinationId: 'dest-1' })
  })

  it('🟢 CONTROL — with the wrong variable set the SAME destination stops matching', async () => {
    // Proves the match above is carried by the variable and not by the fixture.
    m.destinations.mockResolvedValue([SOMEONE_ELSES, OURS])
    vi.stubEnv('EBAY_NOTIFICATION_ENDPOINT_URL', '')
    const { body } = await status()
    expect(body.destination).toBeNull()
  })
})

describe('2. 🔴 "could not measure" is not "measured empty"', () => {
  it('says whether the two variables are set at all', async () => {
    const { body } = await status()
    expect(body.configured).toEqual({ hasEndpoint: true, hasVerificationToken: true, verificationTokenValid: false, hasAlertEmail: false })
  })

  it('🔴 an unconfigured endpoint still reports what eBay actually holds', async () => {
    // The production symptom: destination null with two real destinations at eBay. The
    // raw count and the endpoints are what tell that apart from a seller with none.
    m.destinations.mockResolvedValue([SOMEONE_ELSES, OURS])
    vi.stubEnv('EBAY_NOTIFICATION_ENDPOINT_URL', '')
    const { body } = await status()
    expect(body.destination).toBeNull()
    expect(body.destinationsAtEbay).toBe(2)
    expect(body.destinationEndpoints).toEqual([SOMEONE_ELSES.endpoint, OUR_ENDPOINT])
  })

  it('🟢 a genuinely empty eBay reports ZERO, not the same answer', async () => {
    // Without this arm, destinationsAtEbay could be a constant and nobody would know.
    const { body } = await status()
    expect(body.destinationsAtEbay).toBe(0)
    expect(body.destinationEndpoints).toEqual([])
  })

  it('does not invent a match when the endpoint is unset', async () => {
    // `find(d => d.endpoint === null)` would be vacuous; a destination whose endpoint is
    // itself null must not be adopted as ours.
    m.destinations.mockResolvedValue([{ destinationId: 'dest-null', endpoint: null as any, status: 'ENABLED' }])
    vi.stubEnv('EBAY_NOTIFICATION_ENDPOINT_URL', '')
    const { body } = await status()
    expect(body.destination).toBeNull()
  })
})

describe('3. a wrong topic id must be READ, never guessed', () => {
  it('returns eBay’s own catalogue, sorted', async () => {
    // P6.7: inventing two plausible eBay scope names broke every connect for nineteen
    // days. A wish that is not offered is answered by looking at this list.
    const { body } = await status()
    expect(body.catalogue).toEqual(['ITEM_PRICE_REVISION', 'MARKETPLACE_ACCOUNT_DELETION'])
    expect(body.catalogueSize).toBe(2)
  })

  it('a wish eBay does not offer is flagged, and one it does is not', async () => {
    const { body } = await status()
    const byId = Object.fromEntries(body.wanted.map((w: any) => [w.topicId, w.offeredByEbay]))
    expect(byId.MARKETPLACE_ACCOUNT_DELETION).toBe(true)
    expect(byId.ORDER_CONFIRMATION).toBe(false)
    expect(body.wanted.map((t: { topicId: string }) => t.topicId)).not.toContain('ITEM_SOLD')
  })
})

describe('4. subscriptions are reported whole', () => {
  it('🔴 an empty list is a REAL zero — it is not filtered by our destination', async () => {
    // Production returned []. That has to mean "eBay has none", not "none matched a
    // lookup that could not match".
    m.subscriptions.mockResolvedValue([{ subscriptionId: 's1', topicId: 'ITEM_PRICE_REVISION', destinationId: 'dest-9' }])
    vi.stubEnv('EBAY_NOTIFICATION_ENDPOINT_URL', '')
    const { body } = await status()
    expect(body.subscriptions).toHaveLength(1)
    expect(body.subscriptions[0].pointsAtOurDestination).toBe(false)
  })

  it('a subscription on our destination is marked as pointing at it', async () => {
    m.destinations.mockResolvedValue([OURS])
    m.subscriptions.mockResolvedValue([{ subscriptionId: 's1', topicId: 'ITEM_PRICE_REVISION', destinationId: 'dest-1' }])
    const { body } = await status()
    expect(body.subscriptions[0].pointsAtOurDestination).toBe(true)
  })
})

// Status still reads eBay's catalogue when the local token is malformed: the two facts differ.
it('reports a present but invalid token without exposing it or hiding the catalogue', async () => {
  vi.stubEnv('EBAY_NOTIFICATION_VERIFICATION_TOKEN', 'invalid-private-token')
  const { body } = await status()
  expect(body.configured).toMatchObject({ hasVerificationToken: true, verificationTokenValid: false })
  expect(body.configurationError).toMatch(/32.*80.*A-Za-z0-9_-/)
  expect(body.catalogueSize).toBe(2)
  expect(JSON.stringify(body)).not.toContain('invalid-private-token')
})
it('positive control: reports an allowed token as valid', async () => {
  vi.stubEnv('EBAY_NOTIFICATION_VERIFICATION_TOKEN', 'AZaz09_-'.repeat(4))
  const { body } = await status()
  expect(body.configured.verificationTokenValid).toBe(true)
  expect(body.configurationError).toBeNull()
})
