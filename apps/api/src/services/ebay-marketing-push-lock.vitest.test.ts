import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => {
  const send = vi.fn(() => { throw new Error('Unexpected outbound request') })
  vi.stubGlobal('fetch', send)
  return { send, read: vi.fn(), all: vi.fn(), markdown: vi.fn(), volume: vi.fn(), updateMarkdown: vi.fn(), updateVolume: vi.fn(), connection: vi.fn(), token: vi.fn() }
})
vi.mock('../db.js', () => ({ default: { channelListing: { findMany: s.all } } }))
vi.mock('./listing-push-controls.js', () => ({ readPushControls: s.read }))
vi.mock('./connection-resolver.service.js', () => ({ tryResolveConnection: s.connection }))
vi.mock('./ebay-auth.service.js', () => ({ EbayAuthService: class { getValidToken = s.token } }))
import { postEbayMarketing } from './ebay-marketing-dispatch.service.js'
import { pushMarkdownToEbay } from './ebay-markdown.service.js'
import { pushVolumePromotion } from './ebay-volume-pricing-push.service.js'

const prisma = {
  ebayMarkdown: { findUnique: s.markdown, update: s.updateMarkdown },
  ebayVolumePromotion: { findUnique: s.volume, update: s.updateVolume },
} as any
const locks = [{ syncPaused: true }, { offerClosedAt: new Date('2026-09-13') },
  ...['HELD', 'WITHDRAWN', 'ENDED', 'DISCONTINUED', 'RELEASED'].map(presenceIntent => ({ presenceIntent }))]
const markdownPayload = { selectedInventoryDiscounts: [{ discountSpecification: { listingIds: ['listing'] } }] }
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', s.send)
  vi.stubEnv('NEXUS_EBAY_MARKDOWN_LIVE', '1')
  vi.stubEnv('NEXUS_EBAY_VOLUME_LIVE', '1')
  s.read.mockResolvedValue([{}]); s.all.mockResolvedValue([{}])
  s.send.mockResolvedValue(new Response('', { status: 201, headers: { location: '/promotion/fixture' } }) as never)
  s.connection.mockResolvedValue({ id: 'fixture' }); s.token.mockResolvedValue('fixture-token')
  s.markdown.mockResolvedValue({ id: 'markdown', status: 'DRAFT', originalPrice: 10, discountType: 'PERCENTAGE', discountValue: 5,
    startDate: new Date('2026-09-12'), channelListing: { channel: 'EBAY', externalListingId: 'listing', marketplace: 'IT', price: 10 } })
  s.volume.mockResolvedValue({ id: 'volume', name: 'Local fixture', status: 'DRAFT', marketplace: 'IT', skus: ['SKU'], tiers: [{ minQty: 2, percentOff: 5 }] })
  s.updateMarkdown.mockResolvedValue({}); s.updateVolume.mockResolvedValue({})
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

for (const [name, run, update, flag, success] of [
  ['markdown', () => pushMarkdownToEbay(prisma, 'markdown'), s.updateMarkdown, 'NEXUS_EBAY_MARKDOWN_LIVE', 'OK'],
  ['volume', () => pushVolumePromotion(prisma, 'volume'), s.updateVolume, 'NEXUS_EBAY_VOLUME_LIVE', 'SUCCESS'],
] as const) {
  it.each(locks)(`${name} records %j as a refusal before dispatch`, async lock => {
    s.read.mockResolvedValue([{}, lock])
    const result = await run()
    expect(result).toMatchObject({ ok: false, liveMode: true, error: expect.stringContaining('PUSH_') })
    expect(s.send).not.toHaveBeenCalled(); expect(s.connection).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledOnce()
    expect(update.mock.calls[0][0].data).toMatchObject({ lastSyncStatus: 'FAILED', lastSyncError: expect.stringContaining('PUSH_') })
    expect(update.mock.calls[0][0].data).not.toHaveProperty('status')
  })
  it(`${name} permits an unlocked mocked promotion and records acknowledgement`, async () => {
    expect(await run()).toMatchObject({ ok: true, externalPromotionId: 'fixture' })
    expect(s.send).toHaveBeenCalledOnce()
    expect(update.mock.calls[0][0].data).toMatchObject({ lastSyncStatus: success })
  })
  it(`${name} preserves explicit dry-run even for held inventory`, async () => {
    vi.stubEnv(flag, '0'); s.read.mockResolvedValue([{ presenceIntent: 'ENDED' }])
    expect(await run()).toMatchObject({ ok: true, liveMode: false })
    expect(s.read).not.toHaveBeenCalled(); expect(s.send).not.toHaveBeenCalled()
    expect(update.mock.calls[0][0].data.lastSyncStatus).toBe('PENDING')
  })
  it(`${name} records unavailable controls as failure`, async () => {
    s.read.mockRejectedValue(new Error('PUSH_CONTROL_UNAVAILABLE'))
    expect(await run()).toMatchObject({ ok: false, error: 'PUSH_CONTROL_UNAVAILABLE' })
    expect(s.send).not.toHaveBeenCalled()
    expect(update.mock.calls[0][0].data.lastSyncStatus).toBe('FAILED')
  })
}
it.each(locks)('dispatcher also refuses %j without relying on a producer', async lock => {
  s.read.mockResolvedValue([lock])
  expect(await postEbayMarketing('/sell/marketing/v1/item_promotion', markdownPayload)).toMatchObject({ ok: false, status: 409, errorMessage: expect.stringContaining('PUSH_') })
  expect(s.send).not.toHaveBeenCalled()
})
it('rechecks controls at dispatch after a producer preflight was allowed', async () => {
  s.read.mockResolvedValueOnce([{}]).mockResolvedValue([{ presenceIntent: 'ENDED' }])
  expect(await pushMarkdownToEbay(prisma, 'markdown')).toMatchObject({ ok: false })
  expect(s.updateMarkdown.mock.calls[0][0].data).toMatchObject({ lastSyncStatus: 'FAILED', lastSyncError: expect.stringContaining('PUSH_INTENT_ENDED') })
  expect(s.send).not.toHaveBeenCalled()
})
it('checks every stored eBay row before an inventory-wide promotion', async () => {
  s.all.mockResolvedValue([{}, { presenceIntent: 'ENDED' }])
  expect(await postEbayMarketing('/sell/marketing/v1/item_promotion', { inventoryCriterion: { inventoryCriterionType: 'INVENTORY_ANY' } })).toMatchObject({ ok: false, status: 409 })
  expect(s.all).toHaveBeenCalledWith({ where: { channel: 'EBAY' } })
  expect(s.send).not.toHaveBeenCalled()
})
it('allows inventory-wide promotion with unlocked controls and preserves its payload', async () => {
  const payload = { inventoryCriterion: { inventoryCriterionType: 'INVENTORY_ANY' } }
  expect(await postEbayMarketing('/sell/marketing/v1/item_promotion', payload)).toMatchObject({ ok: true })
  expect(JSON.parse((s.send.mock.calls[0] as any)[1].body)).toEqual(payload)
})
it('refuses inventory-wide promotion with no observable controls', async () => {
  s.all.mockResolvedValue([])
  expect(await postEbayMarketing('/sell/marketing/v1/item_promotion', { inventoryCriterion: { inventoryCriterionType: 'INVENTORY_ANY' } })).toMatchObject({ ok: false, status: 409 })
  expect(s.send).not.toHaveBeenCalled()
})
it('does not let one known item hide another unresolvable target', async () => {
  s.read.mockResolvedValueOnce([{}]).mockRejectedValueOnce(new Error('PUSH_CONTROL_UNAVAILABLE'))
  const payload = { selectedInventoryDiscounts: [{ discountSpecification: { listingIds: ['known', 'unknown'] } }] }
  expect(await postEbayMarketing('/sell/marketing/v1/item_price_markdown_promotion', payload)).toMatchObject({ ok: false, status: 409 })
  expect(s.read).toHaveBeenNthCalledWith(2, { channel: 'EBAY', externalIds: ['unknown'] })
  expect(s.send).not.toHaveBeenCalled()
})
it.each([null, {}, { selectedInventoryDiscounts: [] }, { selectedInventoryDiscounts: [{ discountSpecification: { listingIds: [''] } }] },
  { inventoryCriterion: { inventoryCriterionType: 'INVENTORY_BY_VALUE', inventoryItems: [{ inventoryReferenceId: 'SKU', inventoryReferenceType: 'UNSUPPORTED' }] } },
])('refuses malformed inventory %j', async payload => {
  expect(await postEbayMarketing('/sell/marketing/v1/item_promotion', payload)).toMatchObject({ ok: false, status: 409 })
  expect(s.send).not.toHaveBeenCalled()
})
