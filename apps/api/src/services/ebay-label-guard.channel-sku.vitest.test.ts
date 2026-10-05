/**
 * S4 (per-channel SKU) — the custom-label guard (a cron that revises a live item's Item.SKU) never puts a listing with
 * its own SKU back to Product.sku: the label is the main row's WANTED SKU, eBay holding the wanted or the confirmed SKU
 * is kept (moving a live SKU is step S10), and a label eBay takes is recorded as the SKU eBay holds. A listing with no
 * own SKU is labelled exactly as before. eBay is stubbed (no network).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({ controls: [] as any[], read: vi.fn(), token: vi.fn(async () => 'token'), trading: vi.fn(), confirm: vi.fn() }))
vi.mock('../db.js', () => ({ default: {
  sharedListingMembership: { groupBy: async ({ by }: any) => by.includes('parentSku') ? [{ marketplace: 'IT', itemId: '123', parentSku: 'PARENT', channelConnectionId: 'account' }] : [{ itemId: '123' }] },
  channelListing: {
    findMany: async (args: any) => { if (args.where.externalListingId !== '123') return []; s.read(args); return s.controls },
    updateMany: async (args: any) => { s.confirm(args); return { count: 1 } },
  },
} }))
vi.mock('./ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: s.token } }))
vi.mock('./ebay-trading-api.service.js', () => ({ callTradingApi: s.trading, siteIdForMarket: () => 101 }))
import { ensureListingLabels } from './ebay-label-guard.service.js'

const LIVE = { listingStatus: 'ACTIVE', isPublished: true, externalListingId: '123', syncPaused: false, offerClosedAt: null }
const root = (facts: Record<string, unknown> = {}) => ({ id: 'cl-root', productId: 'p', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'account', aliasKey: '',
  channelSku: null, liveChannelSku: null, alias: null, product: { sku: 'PARENT', parentId: null }, ...LIVE, ...facts })
const child = (facts: Record<string, unknown> = {}) => ({ ...root(), id: 'cl-child', productId: 'c', product: { sku: 'PARENT-M', parentId: 'p' }, ...facts })
const scope = [{ marketplace: 'IT', itemId: '123' }]
const label = (sku: string | null) => ({ raw: sku === null ? '<Item></Item>' : `<Item><SKU>${sku}</SKU></Item>` })
const revisedTo = () => s.trading.mock.calls.filter(c => c[0] === 'ReviseFixedPriceItem').map(c => /<SKU>([^<]*)<\/SKU>/.exec(String(c[1]))?.[1])
const confirmed = () => s.confirm.mock.calls.map(([args]) => [args.where.id, args.data.liveChannelSku])

beforeEach(() => { vi.clearAllMocks(); s.controls = [root(), child()] })

describe('parity — a listing with no own SKU is labelled exactly as before', () => {
  it('a label that is not the parent SKU is revised to it; nothing is recorded', async () => {
    s.trading.mockResolvedValue(label('OLD'))
    expect(await ensureListingLabels(scope)).toMatchObject({ set: 1, kept: 0, refusals: [] })
    expect(revisedTo()).toEqual(['PARENT'])
    expect(confirmed()).toEqual([])
    // The read asks for each row's product and alias (the label rule's facts), on this account and market only.
    expect(s.read.mock.calls[0][0]).toMatchObject({ where: { channel: 'EBAY', marketplace: 'IT', externalListingId: '123', channelConnectionId: 'account' },
      include: { product: expect.any(Object), alias: expect.any(Object) } })
  })

  it('the parent SKU is kept; a variation\'s own SKU does not change the item label', async () => {
    s.controls = [root(), child({ channelSku: 'OWN-M', liveChannelSku: 'OWN-M' })]
    s.trading.mockResolvedValue(label('PARENT'))
    expect(await ensureListingLabels(scope)).toMatchObject({ set: 0, kept: 1 })
    expect(revisedTo()).toEqual([])
  })
})

describe('🔴 a listing with its own SKU is never put back to Product.sku', () => {
  it('eBay holding the main row\'s own SKU: kept (it was reverted before)', async () => {
    s.controls = [root({ channelSku: 'OWN', liveChannelSku: 'OWN' }), child()]
    s.trading.mockResolvedValue(label('OWN'))
    expect(await ensureListingLabels(scope)).toMatchObject({ set: 0, kept: 1, refusals: [] })
    expect(revisedTo()).toEqual([])
  })

  it('a missing or other label gets the wanted SKU, recorded as the SKU eBay holds for the main row', async () => {
    s.controls = [root({ channelSku: 'OWN', liveChannelSku: 'OWN' })]
    s.trading.mockResolvedValue(label(null))
    expect(await ensureListingLabels(scope)).toMatchObject({ set: 1 })
    expect(revisedTo()).toEqual(['OWN'])
    expect(confirmed()).toEqual([['cl-root', 'OWN']])
  })

  it('S10: a wanted SKU eBay does not hold yet — eBay\'s product-SKU label is kept here (Publish moves it, never this guard)', async () => {
    s.controls = [root({ channelSku: 'WANT' })]
    s.trading.mockResolvedValue(label('PARENT'))
    expect(await ensureListingLabels(scope)).toMatchObject({ set: 0, kept: 1 })
    expect(revisedTo()).toEqual([])
  })

  it('an extra listing\'s main row: its alias SKU is wanted; eBay\'s product-SKU label stays; a missing label gets the alias SKU', async () => {
    const alias = root({ aliasKey: 'alias-1', alias: { sku: 'ALT', productId: 'p' } })
    s.controls = [alias]
    s.trading.mockResolvedValue(label('PARENT'))
    expect(await ensureListingLabels(scope)).toMatchObject({ kept: 1, set: 0 })
    s.trading.mockReset().mockResolvedValue(label(''))
    expect(await ensureListingLabels(scope)).toMatchObject({ set: 1 })
    expect(revisedTo()).toEqual(['ALT'])
    expect(confirmed()).toEqual([['cl-root', 'ALT']])
  })

  it('two main rows wanting different SKUs: refused with a reason, eBay is not called', async () => {
    s.controls = [root({ channelSku: 'A' }), root({ id: 'cl-root-2', productId: 'p2', channelSku: 'B' })]
    const result = await ensureListingLabels(scope)
    expect(result.refusals).toEqual([expect.objectContaining({ itemId: '123', code: 'CHANNEL_SKU_UNRESOLVED', sentence: expect.stringContaining('A, B') })])
    expect(s.token).not.toHaveBeenCalled(); expect(s.trading).not.toHaveBeenCalled()
  })
})
