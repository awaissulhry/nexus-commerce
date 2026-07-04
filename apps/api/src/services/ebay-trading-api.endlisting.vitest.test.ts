// apps/api/src/services/ebay-trading-api.endlisting.vitest.test.ts
//
// P2.D3 — unit tests for EndFixedPriceItem Trading-API integration.
//
// Coverage:
//   - buildEndFixedPriceItemXml shape + escaping (pure)
//   - delistEbay via dispatchChannelDelist: success, idempotent already-ended,
//     missing itemId, genuine failure
//
// All network I/O is prevented:
//   - endFixedPriceItem (from ebay-trading-api.service) is mocked so
//     callTradingApi (and fetch) are never invoked
//   - @nexus/database prisma mock prevents real DB access
//   - ebay-auth.service mock prevents real token refresh calls

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Module mocks (must be declared before dynamic import) ─────────────────

// Mock the Trading-API service: keep pure functions real, mock the
// network-calling endFixedPriceItem so callTradingApi is never reached.
vi.mock('./ebay-trading-api.service.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./ebay-trading-api.service.js')>()
  return {
    ...mod,                               // buildEndFixedPriceItemXml, escapeXml, siteIdForMarket stay real
    endFixedPriceItem: vi.fn(),           // network call — mocked
  }
})

// Mock prisma (channel-delist.service uses @nexus/database for connection lookup)
const mockFindFirst = vi.fn()
vi.mock('@nexus/database', () => ({
  prisma: {
    channelConnection: { findFirst: mockFindFirst },
    outboundSyncQueue: { update: vi.fn(), findUnique: vi.fn() },
  },
}))

// Mock eBay auth service — prevents real token-refresh HTTP calls
const mockGetValidToken = vi.fn()
vi.mock('./ebay-auth.service.js', () => ({
  ebayAuthService: { getValidToken: mockGetValidToken },
}))

// Mock shopify + amazon clients imported transitively by channel-delist.service
vi.mock('./marketplaces/shopify.service.js', () => ({
  ShopifyService: class {},
}))
vi.mock('../clients/amazon-sp-api.client.js', () => ({
  amazonSpApiClient: {},
}))

// ── Dynamic imports (after vi.mock so mocks are active) ───────────────────

const { buildEndFixedPriceItemXml, endFixedPriceItem } = await import(
  './ebay-trading-api.service.js'
)
const { dispatchChannelDelist } = await import('./channel-delist.service.js')

// ── Test helpers ──────────────────────────────────────────────────────────

function makeEbayJob(overrides: Partial<{
  externalListingId: string | null
  targetRegion: string | null
}> = {}) {
  return {
    queueId: 'q-test-1',
    productId: 'prod-1',
    channelListingId: null,
    targetChannel: 'EBAY',
    targetRegion: 'IT',
    externalListingId: '110556677',
    syncType: 'DELETE_LISTING' as const,
    payload: { channelAction: 'delete' },
    ...overrides,
  }
}

function setupAuth() {
  mockFindFirst.mockResolvedValue({ id: 'conn-1', channelType: 'EBAY', isActive: true, updatedAt: new Date() })
  mockGetValidToken.mockResolvedValue('OAUTH_TOKEN_123')
}

// ── buildEndFixedPriceItemXml ─────────────────────────────────────────────

describe('buildEndFixedPriceItemXml', () => {
  it('emits an EndFixedPriceItemRequest with ItemID and EndingReason', () => {
    const xml = buildEndFixedPriceItemXml({ itemId: 'THEID' })
    expect(xml).toContain('<EndFixedPriceItemRequest')
    expect(xml).toContain('<ItemID>THEID</ItemID>')
    expect(xml).toContain('<EndingReason>NotAvailable</EndingReason>')
  })

  it('uses a custom endingReason when provided', () => {
    const xml = buildEndFixedPriceItemXml({ itemId: '999', endingReason: 'LostOrBroken' })
    expect(xml).toContain('<EndingReason>LostOrBroken</EndingReason>')
  })

  it('escapes XML metacharacters in itemId', () => {
    const xml = buildEndFixedPriceItemXml({ itemId: '<bad>&"id"' })
    expect(xml).toContain('<ItemID>&lt;bad&gt;&amp;&quot;id&quot;</ItemID>')
    expect(xml).not.toContain('<bad>')
  })

  it('escapes XML metacharacters in endingReason', () => {
    const xml = buildEndFixedPriceItemXml({ itemId: '1', endingReason: 'A&B' })
    expect(xml).toContain('<EndingReason>A&amp;B</EndingReason>')
  })

  it('does NOT embed an eBayAuthToken in the body (IAF header only)', () => {
    const xml = buildEndFixedPriceItemXml({ itemId: '1' })
    expect(xml).not.toContain('eBayAuthToken')
    expect(xml).not.toContain('RequesterCredentials')
  })
})

// ── delistEbay via dispatchChannelDelist ──────────────────────────────────

describe('delistEbay (via dispatchChannelDelist)', () => {
  const mockEndFixedPriceItem = endFixedPriceItem as ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls endFixedPriceItem with the correct itemId and returns success:true on ack Success', async () => {
    setupAuth()
    mockEndFixedPriceItem.mockResolvedValue({ ack: 'Success', errors: [] })

    const result = await dispatchChannelDelist(makeEbayJob({ externalListingId: '110556677' }))

    expect(result.success).toBe(true)
    expect(mockEndFixedPriceItem).toHaveBeenCalledOnce()
    const [input] = mockEndFixedPriceItem.mock.calls[0]
    expect(input.itemId).toBe('110556677')
  })

  it('passes siteId derived from targetRegion to endFixedPriceItem', async () => {
    setupAuth()
    mockEndFixedPriceItem.mockResolvedValue({ ack: 'Success', errors: [] })

    await dispatchChannelDelist(makeEbayJob({ targetRegion: 'DE' }))

    const [, ctx] = mockEndFixedPriceItem.mock.calls[0]
    // DE → site 77
    expect(ctx.siteId).toBe('77')
    expect(ctx.oauthToken).toBe('OAUTH_TOKEN_123')
  })

  it('returns success:false (not thrown) when externalListingId is null', async () => {
    const result = await dispatchChannelDelist(makeEbayJob({ externalListingId: null }))

    expect(result.success).toBe(false)
    // Top-level guard in dispatchChannelDelist fires before even reaching delistEbay
    expect(result.retryable).toBe(false)
    expect(mockEndFixedPriceItem).not.toHaveBeenCalled()
  })

  it('returns success:false (not thrown) when externalListingId is missing from job', async () => {
    const job = {
      ...makeEbayJob(),
      externalListingId: null,
    }
    const promise = dispatchChannelDelist(job)
    await expect(promise).resolves.toMatchObject({ success: false })
  })

  it('returns success:true (idempotent) when eBay signals item already ended (Item cannot be accessed)', async () => {
    setupAuth()
    mockEndFixedPriceItem.mockRejectedValue(
      new Error('eBay EndFixedPriceItem Failure: Item cannot be accessed'),
    )

    const result = await dispatchChannelDelist(makeEbayJob())

    expect(result.success).toBe(true)
  })

  it('returns success:true (idempotent) for "auction already closed" message', async () => {
    setupAuth()
    mockEndFixedPriceItem.mockRejectedValue(
      new Error('eBay EndFixedPriceItem Failure: auction already closed'),
    )

    const result = await dispatchChannelDelist(makeEbayJob())

    expect(result.success).toBe(true)
  })

  it('returns success:true (idempotent) for "already ended" message', async () => {
    setupAuth()
    mockEndFixedPriceItem.mockRejectedValue(
      new Error('eBay EndFixedPriceItem Failure: Listing already ended'),
    )

    const result = await dispatchChannelDelist(makeEbayJob())

    expect(result.success).toBe(true)
  })

  it('returns success:true (idempotent) for "invalid item" message', async () => {
    setupAuth()
    mockEndFixedPriceItem.mockRejectedValue(
      new Error('eBay EndFixedPriceItem Failure: Invalid item'),
    )

    const result = await dispatchChannelDelist(makeEbayJob())

    expect(result.success).toBe(true)
  })

  it('returns success:false, retryable:true on a genuine eBay error', async () => {
    setupAuth()
    mockEndFixedPriceItem.mockRejectedValue(
      new Error('eBay EndFixedPriceItem Failure: Internal server error'),
    )

    const result = await dispatchChannelDelist(makeEbayJob())

    expect(result.success).toBe(false)
    expect(result.retryable).toBe(true)
    expect(result.error).toMatch(/internal server error/i)
  })

  it('returns success:false when no active eBay connection is found', async () => {
    mockFindFirst.mockResolvedValue(null)

    const result = await dispatchChannelDelist(makeEbayJob())

    expect(result.success).toBe(false)
    expect(result.retryable).toBe(false)
    expect(result.errorCode).toBe('EBAY_DELIST_NO_CONNECTION')
    expect(mockEndFixedPriceItem).not.toHaveBeenCalled()
  })

  it('returns success:false (not thrown) when token fetch throws', async () => {
    mockFindFirst.mockResolvedValue({ id: 'conn-1' })
    mockGetValidToken.mockRejectedValue(new Error('token expired'))

    const result = await dispatchChannelDelist(makeEbayJob())

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('EBAY_DELIST_AUTH_ERROR')
  })

  it('uses IT siteId (101) as default when targetRegion is null', async () => {
    setupAuth()
    mockEndFixedPriceItem.mockResolvedValue({ ack: 'Success', errors: [] })

    await dispatchChannelDelist(makeEbayJob({ targetRegion: null }))

    const [, ctx] = mockEndFixedPriceItem.mock.calls[0]
    expect(ctx.siteId).toBe('101')
  })
})
