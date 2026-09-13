import { beforeEach, expect, it, vi } from 'vitest'
const s = vi.hoisted(() => ({ controls: [] as any[], fail: false, read: vi.fn(), token: vi.fn(async () => 'token'), trading: vi.fn() }))
vi.mock('../db.js', () => ({ default: {
  sharedListingMembership: { groupBy: async ({ by }: any) => by.includes('parentSku') ? [{ marketplace: 'IT', itemId: '123', parentSku: 'PARENT', channelConnectionId: 'account' }] : [{ itemId: '123' }] },
  channelListing: { findMany: async (args: any) => {
    if (args.where.externalListingId !== '123') return []
    s.read(args)
    if (s.fail) throw new Error('synthetic unavailable DB')
    return s.controls
  } },
} }))
vi.mock('./ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: s.token } }))
vi.mock('./ebay-trading-api.service.js', () => ({ callTradingApi: s.trading, siteIdForMarket: () => 101 }))
import { ensureListingLabels } from './ebay-label-guard.service.js'
const row = () => ({ id: 'cl', productId: 'p', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'account', aliasKey: '', externalListingId: '123', listingStatus: 'ACTIVE', syncPaused: false, offerClosedAt: null })
const scope = [{ marketplace: 'IT', itemId: '123' }]
beforeEach(() => {
  vi.clearAllMocks(); s.controls = [row()]; s.fail = false
  s.trading.mockResolvedValue({ raw: '<Item><SKU>OLD</SKU></Item>' })
})
it.each([
  [{ syncPaused: true }, 'PUSH_SYNC_PAUSED'],
  [{ offerClosedAt: new Date() }, 'PUSH_OFFER_CLOSED'],
  [{ presenceIntent: 'HELD' }, 'PUSH_INTENT_HELD'],
  [{ presenceIntent: 'WITHDRAWN' }, 'PUSH_INTENT_WITHDRAWN'],
  [{ presenceIntent: 'ENDED' }, 'PUSH_INTENT_ENDED'],
  [{ listingStatus: 'ENDED' }, 'PUSH_LEGACY_ENDED'],
])('label revise refuses %j and preserves %s', async (fields, code) => {
  s.controls = [row(), { ...row(), productId: 'sibling', ...fields }]
  const r = await ensureListingLabels(scope)
  expect(r.refusals[0]).toMatchObject({ itemId: '123', code, sentence: expect.any(String) })
  expect(s.token).not.toHaveBeenCalled(); expect(s.trading).not.toHaveBeenCalled()
})
it.each(['absent', 'failed'])('label revise refuses %s control reads', async mode => {
  s.controls = []; s.fail = mode === 'failed'
  const r = await ensureListingLabels(scope)
  expect(r.refusals[0].code).toBe('PUSH_CONTROL_UNAVAILABLE')
  expect(s.token).not.toHaveBeenCalled(); expect(s.trading).not.toHaveBeenCalled()
})
it('unlocked owning controls permit the mocked revise and preserve account/market scope', async () => {
  const r = await ensureListingLabels(scope)
  expect(r.set).toBe(1); expect(r.refusals).toEqual([])
  expect(s.read.mock.calls[0][0].where).toEqual({ channel: 'EBAY', marketplace: 'IT', externalListingId: '123', channelConnectionId: 'account' })
  expect(s.token).toHaveBeenCalledWith('account')
  expect(s.trading.mock.calls.map(c => c[0])).toEqual(['GetItem', 'ReviseFixedPriceItem'])
})
