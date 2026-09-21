/**
 * P7a.1 — the channel-sync worker refuses rather than guesses.
 *
 * Found by P7a's census, not by the plan. `RESEARCH.md` A5 §1.1 calls this engine dead; it is
 * **started** (`index.ts:487`) and has a **live producer** (`routes/catalog.routes.ts` →
 * `POST /api/catalog/sync/bulk`). Two of its writes were things no writer in Nexus is allowed to
 * do, and both were latent — which is the P4.3a shape exactly: a wrong writer one button-press
 * away.
 *
 * ## Measured on the development database, 2026-09-21 (positive control in brackets)
 *
 * | fact | value |
 * |---|---|
 * | `ChannelListing` rows | **1003** |
 * | `channelMarket` values | AMAZON_IT 273, EBAY_IT 253, AMAZON_DE 214, AMAZON_ES 123, AMAZON_FR 115, EBAY_DE 21, SHOPIFY_GLOBAL 2, ETSY_GLOBAL 2 |
 * | rows with a `_US` market | **0** |
 * | rows with `region = 'US'` | **0** |
 * | rows stuck at `SYNCING` | **0** (spread: PENDING 431, IDLE 365, SYNCED 207) |
 * | 🔴 products with **more than one** listing on one channel | **214 Amazon, 21 eBay** |
 *
 * So neither defect has ever fired — and 235 products are loaded for the first one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  outbound: vi.fn(() => { throw new Error('Unexpected outbound fetch') }),
  product: vi.fn(), many: vi.fn(), unique: vi.fn(), create: vi.fn(), update: vi.fn(),
  amazon: vi.fn(), ebay: vi.fn(), shopify: vi.fn(),
}))
vi.stubGlobal('fetch', m.outbound)
vi.mock('../db.js', () => ({
  default: {
    product: { findUnique: m.product },
    channelListing: { findMany: m.many, findUnique: m.unique, create: m.create, update: m.update, findFirst: vi.fn() },
  },
}))
vi.mock('../lib/queue.js', () => ({ redis: { connection: null } }))
vi.mock('../lib/workspace-jobs.js', () => ({ WorkspaceWorker: class { on() { return this } } }))
vi.mock('../utils/logger.js', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }))
vi.mock('../services/marketplaces/amazon-sync.service.js', () => ({ syncProductToAmazon: m.amazon }))
vi.mock('../services/marketplaces/ebay-sync.service.js', () => ({ syncProductToEbay: m.ebay }))
vi.mock('../services/marketplaces/shopify-sync.service.js', () => ({ syncProductToShopify: m.shopify }))

const mod: any = await import('./channel-sync.worker.js')
const process_ = mod.processChannelSyncJob ?? mod.default?.processChannelSyncJob

const job = (data: Record<string, unknown>) => ({ id: 'j1', data, attemptsMade: 0 })

beforeEach(() => {
  vi.clearAllMocks()
  m.product.mockResolvedValue({ id: 'p1', sku: 'SKU-1', name: 'Mug', basePrice: 10, totalStock: 5 })
  m.unique.mockResolvedValue({ id: 'cl-1', channel: 'AMAZON', syncStatus: 'IDLE' })
  m.amazon.mockResolvedValue({ status: 'noop' })
  m.update.mockResolvedValue({})
})
afterEach(() => { expect(m.outbound).not.toHaveBeenCalled() })

describe('P7a.1 — Nexus never picks "the first"', () => {
  it('🔴 a product with FOUR Amazon listings is REFUSED, and the sentence names them', async () => {
    m.many.mockResolvedValue([
      { id: 'a', channelMarket: 'AMAZON_IT', marketplace: 'IT' },
      { id: 'b', channelMarket: 'AMAZON_DE', marketplace: 'DE' },
      { id: 'c', channelMarket: 'AMAZON_ES', marketplace: 'ES' },
      { id: 'd', channelMarket: 'AMAZON_FR', marketplace: 'FR' },
    ])
    await expect(process_(job({ productId: 'p1', targetChannel: 'AMAZON' })))
      .rejects.toThrow('SKU-1 has 4 AMAZON listings (AMAZON_IT, AMAZON_DE, AMAZON_ES, AMAZON_FR), so this sync must name one. Nothing was synced.')
    expect(m.update).not.toHaveBeenCalled()
    expect(m.amazon).not.toHaveBeenCalled()
  })

  it('🟢 POSITIVE CONTROL: exactly one listing goes through', async () => {
    m.many.mockResolvedValue([{ id: 'cl-1', channelMarket: 'AMAZON_IT', marketplace: 'IT' }])
    const result = await process_(job({ productId: 'p1', targetChannel: 'AMAZON' }))
    expect(result).toMatchObject({ status: 'SUCCESS', channelListingId: 'cl-1' })
    expect(m.amazon).toHaveBeenCalledTimes(1)
  })

  it('a job that NAMES its listing is unaffected — the ambiguity check is only for the unnamed path', async () => {
    await process_(job({ productId: 'p1', targetChannel: 'AMAZON', channelListingId: 'cl-1' }))
    expect(m.many).not.toHaveBeenCalled()
    expect(m.amazon).toHaveBeenCalledTimes(1)
  })
})

describe('P7a.1 — and never invents a market', () => {
  it('🔴 no listing at all is REFUSED — it used to CREATE one in a market nobody sells in', async () => {
    m.many.mockResolvedValue([])
    await expect(process_(job({ productId: 'p1', targetChannel: 'EBAY' })))
      .rejects.toThrow('SKU-1 has no EBAY listing, and Nexus will not create one for a market nobody named. Add the listing for its market first. Nothing was synced.')
    expect(m.create).not.toHaveBeenCalled()
  })

  it('🔴 nothing in this worker can create a ChannelListing any more', async () => {
    // The old branch built `${targetChannel}_US` with region 'US'. Measured: 0 such rows exist,
    // and every real row is IT / DE / ES / FR / GLOBAL. The create is gone, not guarded.
    m.many.mockResolvedValue([])
    await process_(job({ productId: 'p1', targetChannel: 'AMAZON' })).catch(() => {})
    m.many.mockResolvedValue([{ id: 'cl-1', channelMarket: 'AMAZON_IT', marketplace: 'IT' }])
    await process_(job({ productId: 'p1', targetChannel: 'AMAZON' }))
    expect(m.create).not.toHaveBeenCalled()
  })
})

describe('P7a.1 — a noop puts the status back', () => {
  it('🔴 SYNCING is restored to what it was — the row is not stranded mid-sync', async () => {
    m.many.mockResolvedValue([{ id: 'cl-1', channelMarket: 'AMAZON_IT', marketplace: 'IT' }])
    m.unique.mockResolvedValue({ id: 'cl-1', channel: 'AMAZON', syncStatus: 'SYNCED' })
    await process_(job({ productId: 'p1', targetChannel: 'AMAZON' }))
    const statuses = m.update.mock.calls.map((c: any[]) => c[0].data.syncStatus)
    expect(statuses).toEqual(['SYNCING', 'SYNCED'])   // set, then put back
  })

  it('a PENDING row goes back to PENDING, not to a default', async () => {
    m.many.mockResolvedValue([{ id: 'cl-1', channelMarket: 'AMAZON_IT', marketplace: 'IT' }])
    m.unique.mockResolvedValue({ id: 'cl-1', channel: 'AMAZON', syncStatus: 'PENDING' })
    await process_(job({ productId: 'p1', targetChannel: 'AMAZON' }))
    expect(m.update.mock.calls.at(-1)[0].data.syncStatus).toBe('PENDING')
  })

  it('🔴 FOUND BY A POSITIVE CONTROL: the IN_SYNC branch is UNREACHABLE', async () => {
    // This case was written as "a real publish still marks IN_SYNC", and it failed — the row came
    // back IDLE. The reason is that all three handlers inside this worker hardcode
    // `status: 'noop'` on their SUCCESS path (`channel-sync.worker.ts` ~287, ~317, ~347): Phase
    // 0.3 went further than "do not claim success on a noop" and made EVERY path a noop. So the
    // else branch that writes IN_SYNC / lastSyncStatus can never be taken.
    //
    // Mocking the underlying service does not change it — the handler discards the result's
    // status and returns its own. That is asserted here rather than worked around, because it is
    // the fact that makes this worker a genuine P7 deletion candidate: with the two defects above
    // fixed, it now writes NOTHING that survives its own run.
    m.many.mockResolvedValue([{ id: 'cl-1', channelMarket: 'AMAZON_IT', marketplace: 'IT' }])
    m.amazon.mockResolvedValue({ status: 'published', published: true })
    await process_(job({ productId: 'p1', targetChannel: 'AMAZON' }))
    const statuses = m.update.mock.calls.map((c: any[]) => c[0].data.syncStatus)
    expect(statuses).toEqual(['SYNCING', 'IDLE'])
    expect(m.update.mock.calls.flatMap((c: any[]) => Object.keys(c[0].data))).not.toContain('lastSyncedAt')
  })

  it('🟢 POSITIVE CONTROL: the restore really is a WRITE, not a skipped call', async () => {
    // Without this, the case above could pass because nothing was written at all.
    m.many.mockResolvedValue([{ id: 'cl-1', channelMarket: 'AMAZON_IT', marketplace: 'IT' }])
    await process_(job({ productId: 'p1', targetChannel: 'AMAZON' }))
    expect(m.update).toHaveBeenCalledTimes(2)
    expect(m.update.mock.calls[1][0]).toMatchObject({ where: { id: 'cl-1' }, data: { syncStatus: 'IDLE' } })
  })

  it('the noop path still does NOT claim success — the Phase 0.3 rule is untouched', async () => {
    m.many.mockResolvedValue([{ id: 'cl-1', channelMarket: 'AMAZON_IT', marketplace: 'IT' }])
    await process_(job({ productId: 'p1', targetChannel: 'AMAZON' }))
    const written = m.update.mock.calls.flatMap((c: any[]) => Object.keys(c[0].data))
    expect(written).not.toContain('lastSyncStatus')
    expect(written).not.toContain('lastSyncedAt')
  })
})
