import { beforeEach, expect, it, vi } from 'vitest'
const s = vi.hoisted(() => ({ controls: [] as any[], send: vi.fn(), closed: new Set<string>() }))
vi.mock('../db.js', () => ({ default: { channelListing: { findMany: async () => s.controls } } }))
vi.mock('../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: async () => 'seller' }))
vi.mock('../clients/amazon-sp-api.client.js', () => ({ amazonSpApiClient: { putListingsItem: s.send, getListingsItem: async () => ({ success: true, asin: 'fixture' }) } }))
vi.mock('./amazon-market-offer.service.js', () => ({ closedMarketSet: async () => s.closed }))
vi.mock('./pim/variation-theme-facts.js', () => ({ loadAmazonThemeFacts: vi.fn() }))
vi.mock('./amazon-publish-gate.service.js', () => ({ getAmazonPublishMode: () => 'live', checkAmazonCircuit: () => ({ ok: true }), acquireAmazonPublishToken: async () => ({ ok: true }), recordAmazonOutcome: vi.fn() }))
vi.mock('./channel-publish-audit.service.js', () => ({ digestPayload: () => 'digest', writeAttemptLog: vi.fn() }))
vi.mock('../utils/logger.js', () => ({ logger: { info() {}, warn() {}, error() {} } }))
import { AmazonPublishAdapter } from './listing-wizard/amazon-publish.adapter.js'
const payload = { parentSku: 'SKU', productType: 'PRODUCT', marketplaceId: 'MP', attributes: {} }
const locks = [{ syncPaused: true }, { offerClosedAt: new Date() }, ...['HELD','WITHDRAWN','ENDED','DISCONTINUED','RELEASED'].map(presenceIntent => ({ presenceIntent }))]
beforeEach(() => { vi.clearAllMocks(); s.closed = new Set(); s.controls = [{ productId: 'product', marketplace: 'IT' }]; s.send.mockResolvedValue({ success: true }) })
it.each(locks)('refuses a wizard publish before its first PUT for %j', async lock => {
 Object.assign(s.controls[0], lock)
 expect(await new AmazonPublishAdapter().publish(payload)).toMatchObject({ ok: false, failedStep: 'push-lock', error: expect.stringMatching(/^PUSH_/) })
 expect(s.send).not.toHaveBeenCalled()
})
it('allows an unlocked wizard control to make one mocked PUT', async () => {
 expect(await new AmazonPublishAdapter().publish(payload)).toMatchObject({ ok: true })
 expect(s.send).toHaveBeenCalledTimes(1)
})
