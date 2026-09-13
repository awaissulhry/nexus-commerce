import { beforeEach, expect, it, vi } from 'vitest'
const s = vi.hoisted(() => ({ controls: [] as any[], send: vi.fn() }))
vi.mock('./ebay-trading-api.service.js', () => ({ callTradingApi: s.send, siteIdForMarket: () => '101', escapeXml: (v: string) => v }))
vi.mock('./ebay-description-theme.service.js', () => ({ renderListingDescriptionSafe: async () => ({ html: '<p>Fixture</p>', warnings: [], themed: false }), resolveDescriptionMode: async () => 'single', stampDescriptionPushSafe: async () => {} }))
vi.mock('./ebay-variation-push.service.js', () => ({ resolvePerMarketContent: () => ({ title: 'Fixture', subtitle: '', description: 'Fixture' }) }))
import { pushDescriptions } from './ebay-description-push.service.js'
const db = { product: { findFirst: async () => ({ id: 'product', sku: 'SKU', parentId: null }), findMany: async () => [] }, channelListing: { findFirst: async () => ({ id: 'listing', externalListingId: '123', platformAttributes: {} }), findMany: async ({ where }: any) => where.externalListingId ? s.controls : [] }, sharedListingMembership: { findMany: async () => [] } }
const locks = [{ syncPaused: true }, { offerClosedAt: new Date() }, ...['HELD','WITHDRAWN','ENDED','DISCONTINUED','RELEASED'].map(presenceIntent => ({ presenceIntent }))]
beforeEach(() => { vi.clearAllMocks(); s.controls = [{}]; s.send.mockImplementation(async (name: string) => ({ ack: 'Success', raw: name === 'GetItem' ? '<Description><![CDATA[<p>Fixture</p>]]></Description>' : '<ReviseFixedPriceItemResponse />' })) })
it.each(locks)('refuses description updates for %j', async lock => {
 s.controls = [lock]
 const result = await pushDescriptions({ productIds: ['product'], marketplace: 'IT' }, { prisma: db as any, oauthToken: 'fixture', sleepMs: 0 })
 expect(result.listings[0]).toMatchObject({ outcome: 'failed', message: expect.stringMatching(/^PUSH_/) }); expect(s.send).not.toHaveBeenCalled()
})
it('refuses absent control rows and allows a mocked revise/readback when unlocked', async () => {
 s.controls = []
 expect((await pushDescriptions({ productIds: ['product'] }, { prisma: db as any, oauthToken: 'fixture', sleepMs: 0 })).listings[0].message).toContain('PUSH_CONTROL_UNAVAILABLE')
 expect(s.send).not.toHaveBeenCalled(); s.controls = [{}]
 expect((await pushDescriptions({ productIds: ['product'] }, { prisma: db as any, oauthToken: 'fixture', sleepMs: 0 })).listings[0].outcome).toBe('revised')
 expect(s.send).toHaveBeenCalledTimes(2)
})
