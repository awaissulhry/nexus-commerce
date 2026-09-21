import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const s = vi.hoisted(() => ({ controls: [] as any[], send: vi.fn(), review: vi.fn() }))
vi.mock('../db.js', () => ({ default: { channelListing: { findMany: async () => s.controls, findFirst: async () => null }, product: { findFirst: async () => null },
  // P1.5 — eBay listing writes take their language from the Marketplace row (the seeded IT row).
  marketplace: { findFirst: async ({ where }: any) => (where.code === 'IT' ? { marketplaceId: 'EBAY_IT', languages: ['it'], language: 'it', currency: 'EUR' } : null) } } }))
vi.mock('./pim/stored-variation-projection.js', () => ({ loadStoredVariationProjection: vi.fn() }))
vi.mock('./ebay-presentation-consumer.service.js', () => ({ assertLegacyPresentationPublishAllowed: s.review }))
vi.mock('./pim/publish-review-gate.js', () => ({ assertListingContentReviewed: async () => {} }))
vi.mock('./listing-activation-sync.service.js', () => ({ syncActivatedListings: async () => {} }))
vi.mock('./ebay-account.service.js', () => ({ ebayAccountService: { getSnapshot: async () => ({ fulfillmentPolicies: [], paymentPolicies: [], returnPolicies: [], locations: [{ key: 'location' }] }) } }))
vi.mock('./pim/variation-rules.service.js', () => ({ ebayDeclaredAxes: vi.fn() }))
// P1.2 — the sends go through the channel gateway; its account check and ledger are stood in.
vi.mock('./gateway/account.js', () => import('../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./gateway/ledger.js', () => import('../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
import { asResponse } from '../test-support/gateway-stubs.js'
import { pushOffersOnly, pushVariationGroup } from './ebay-variation-push.service.js'
const rows = [{ sku: 'SKU', price: 10, quantity: 2, _productId: 'product' }]
const args = [rows, 'IT', 'fixture', 'account', {}, 'https://fixture.invalid', 'EBAY_IT', (_id: unknown, _sku: unknown, qty: number) => qty] as const
const locks = [{ syncPaused: true }, { offerClosedAt: new Date() }, ...['HELD','WITHDRAWN','ENDED','DISCONTINUED','RELEASED'].map(presenceIntent => ({ presenceIntent }))]
beforeEach(() => { vi.clearAllMocks(); s.controls = [{ product: { sku: 'SKU' }, platformAttributes: { __offerIds: { EBAY_IT: 'offer' } } }]; s.review.mockRejectedValue(new Error('REVIEW_CONTROL_REACHED')); s.send.mockResolvedValue({ ok: true, json: async () => ({ offers: [{ offerId: 'offer' }] }), text: async () => '' }); vi.stubGlobal('fetch', (...args: unknown[]) => asResponse(s.send(...args)))
 // P0.1 — these model production: eBay publish mode `live`.
 vi.stubEnv('NEXUS_ENABLE_EBAY_PUBLISH', 'true'); vi.stubEnv('EBAY_PUBLISH_MODE', 'live') })
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
it.each(locks)('refuses both eBay direct publishers for %j', async lock => {
 Object.assign(s.controls[0], lock)
 expect((await pushOffersOnly(...args))[0]).toMatchObject({ status: 'ERROR', message: expect.stringMatching(/^PUSH_/) })
 expect((await pushVariationGroup('group', ...args))[0]).toMatchObject({ status: 'ERROR', message: expect.stringMatching(/^PUSH_/) })
 expect(s.send).not.toHaveBeenCalled(); expect(s.review).not.toHaveBeenCalled()
})
it('lets unlocked offers reach one mocked PUT and full-publish reach the next independent review guard', async () => {
 expect((await pushOffersOnly(...args))[0].status).toBe('PUSHED')
 expect(s.send).toHaveBeenCalledTimes(1); expect(s.send.mock.calls[0][1].method).toBe('PUT')
 await expect(pushVariationGroup('group', ...args)).rejects.toThrow('REVIEW_CONTROL_REACHED')
 expect(s.review).toHaveBeenCalledTimes(1)
})
it.each([['gated', ''], ['dry-run', 'dry-run'], ['sandbox with a production host', 'sandbox']])('P0.1 — %s: both direct publishers refuse with no read and no call', async (_label, mode) => {
 if (mode) vi.stubEnv('EBAY_PUBLISH_MODE', mode); else vi.stubEnv('NEXUS_ENABLE_EBAY_PUBLISH', '')
 for (const result of [await pushOffersOnly(...args), await pushVariationGroup('group', ...args)])
  expect(result[0]).toMatchObject({ status: 'ERROR', message: expect.stringMatching(/^EBAY_WRITE_REFUSED: .*Nothing was sent to eBay/) })
 expect(s.send).not.toHaveBeenCalled(); expect(s.review).not.toHaveBeenCalled()
})
it('P0.1 — sandbox mode with the sandbox host still reaches the mocked transport', async () => {
 vi.stubEnv('EBAY_PUBLISH_MODE', 'sandbox')
 const sandboxArgs = [rows, 'IT', 'fixture', 'account', {}, 'https://api.sandbox.ebay.com', 'EBAY_IT', (_id: unknown, _sku: unknown, qty: number) => qty] as const
 expect((await pushOffersOnly(...sandboxArgs))[0].status).toBe('PUSHED')
 expect(s.send).toHaveBeenCalledTimes(1); expect(s.send.mock.calls[0][0]).toContain('https://api.sandbox.ebay.com/')
})
