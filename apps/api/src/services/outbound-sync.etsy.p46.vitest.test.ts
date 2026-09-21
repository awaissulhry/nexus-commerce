/**
 * P4.6e — the Etsy lane of the outbound queue.
 *
 * `SyncChannel` had AMAZON, EBAY, SHOPIFY, WOOCOMMERCE, GOOGLE, META and TIKTOK — and no ETSY —
 * although Etsy has been a connected channel since P2.5. So no queue row could name an Etsy
 * destination and P4.6's writers had nothing to reach them. This is that lane.
 *
 * The order of the guards IS the safety, so the tests walk it: push lock, publish mode,
 * destination account, wrong-account guard, listing id, then the change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => {
  const outbound = vi.fn(() => { throw new Error('Unexpected outbound fetch') })
  vi.stubGlobal('fetch', outbound)
  return {
    outbound,
    read: vi.fn(), many: vi.fn(), audit: vi.fn(),
    inventory: vi.fn(), content: vi.fn(),
    destinations: vi.fn(),
  }
})
vi.mock('../db.js', () => ({ default: { channelListing: { findUnique: m.read, findMany: m.many } } }))
vi.mock('../lib/queue.js', () => ({ addJobSafely: vi.fn(), outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
vi.mock('./sync-control-policy.service.js', () => ({ loadChannelPolicies: async () => new Map(), policyFor: () => null }))
vi.mock('./channel-publish-audit.service.js', () => ({ writeAttemptLog: m.audit, digestPayload: () => 'stub' }))
vi.mock('./outbound-rows.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveDestinations: m.destinations,
}))
vi.mock('./etsy/inventory-write.service.js', () => ({ writeEtsyInventory: m.inventory }))
vi.mock('./etsy/listing-write.service.js', () => ({ updateEtsyListingContent: m.content }))

const { OutboundSyncService } = await import('./outbound-sync.service.js')
const service: any = new OutboundSyncService()

const live = () => { vi.stubEnv('NEXUS_ENABLE_ETSY_PUBLISH', 'true'); vi.stubEnv('ETSY_PUBLISH_MODE', 'live') }

const row = (over: Record<string, unknown> = {}) => ({
  id: 'q1', channelListingId: 'l1', targetChannel: 'ETSY', syncType: 'QUANTITY_UPDATE',
  channelConnectionId: 'etsy-acct',
  product: { id: 'p1', sku: 'RED-S', etsyListingId: '700' },
  channelListing: { id: 'l1', sku: 'RED-S', externalListingId: '700', channelConnectionId: 'etsy-acct' },
  payload: { quantity: 12 },
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXUS_ENABLE_ETSY_PUBLISH', 'false'); vi.stubEnv('ETSY_PUBLISH_MODE', '')
  vi.stubEnv('NEXUS_SYNC_ORDERING_V2', '0')     // keep the quantity path to the payload value
  m.read.mockResolvedValue({ id: 'l1', syncPaused: false, marketplace: 'GLOBAL' })
  m.many.mockResolvedValue([])
  m.destinations.mockResolvedValue([{ connectionId: 'etsy-acct', reason: 'NAMED' }])
  m.inventory.mockResolvedValue({ sent: true, body: {}, drift: [], confirmed: true })
  m.content.mockResolvedValue({ sent: true, fields: {} })
})
afterEach(() => { expect(m.outbound).not.toHaveBeenCalled(); vi.unstubAllEnvs() })

describe('P4.6e — the gates, in order', () => {
  it('a paused listing is refused before anything else', async () => {
    m.read.mockResolvedValue({ syncPaused: true })
    expect(await service.syncToEtsy(row())).toMatchObject({ channel: 'ETSY', status: 'SKIPPED', errorCode: 'PUSH_SYNC_PAUSED', retryable: false })
    expect(m.inventory).not.toHaveBeenCalled()
  })

  it('🔴 the publish gate holds it: SKIPPED, naming both switches, and nothing is sent', async () => {
    const result = await service.syncToEtsy(row())
    expect(result).toMatchObject({ success: true, status: 'SKIPPED', dryRun: true })
    expect(result.message).toBe('Etsy gated — not published (set NEXUS_ENABLE_ETSY_PUBLISH=true + ETSY_PUBLISH_MODE=live)')
    expect(m.inventory).not.toHaveBeenCalled()
  })

  it('dry-run is held too, and says so', async () => {
    vi.stubEnv('NEXUS_ENABLE_ETSY_PUBLISH', 'true')
    expect((await service.syncToEtsy(row())).message).toContain('Etsy dry-run — not published')
    expect(m.inventory).not.toHaveBeenCalled()
  })

  it('no destination account is a terminal failure, not a retry', async () => {
    live()
    m.destinations.mockResolvedValue([{ connectionId: null, reason: 'NONE' }])
    expect(await service.syncToEtsy(row({ channelConnectionId: null })))
      .toMatchObject({ status: 'FAILED', errorCode: 'NO_DESTINATION_ACCOUNT', retryable: false })
    expect(m.inventory).not.toHaveBeenCalled()
  })

  it('🔴 a listing of ANOTHER Etsy shop is refused — listing ids are per shop', async () => {
    live()
    const result = await service.syncToEtsy(row({
      channelListing: { id: 'l1', sku: 'RED-S', externalListingId: '700', channelConnectionId: 'other-shop' },
    }))
    expect(result).toMatchObject({ status: 'FAILED', errorCode: 'WRONG_ACCOUNT_WRITE', retryable: false })
    expect(m.inventory).not.toHaveBeenCalled()
  })

  it('a product with no Etsy listing id has nothing to change', async () => {
    live()
    const result = await service.syncToEtsy(row({
      channelListing: { id: 'l1', sku: 'RED-S', externalListingId: null, channelConnectionId: 'etsy-acct' },
      product: { id: 'p1', sku: 'RED-S' },
    }))
    expect(result).toMatchObject({ status: 'FAILED', errorCode: 'NO_EXTERNAL_LISTING', retryable: false })
    expect(m.inventory).not.toHaveBeenCalled()
  })
})

describe('P4.6e — what each syncType does', () => {
  it('a quantity change reaches the inventory writer, naming the account, listing and SKU', async () => {
    live()
    const result = await service.syncToEtsy(row())
    expect(m.inventory).toHaveBeenCalledTimes(1)
    expect(m.inventory.mock.calls[0][0]).toMatchObject({
      accountId: 'etsy-acct', listingId: '700', changes: [{ sku: 'RED-S', quantity: 12 }],
    })
    expect(result).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(result.message).toBe('Etsy listing 700 updated and confirmed.')
  })

  it('the push lock is handed THROUGH to the writer, so the gateway checks it again at the call', async () => {
    live()
    await service.syncToEtsy(row())
    expect(m.inventory.mock.calls[0][0].pushLock).toEqual([expect.objectContaining({ id: 'l1' })])
  })

  it('a content change goes to the content writer, not the inventory one', async () => {
    live()
    await service.syncToEtsy(row({ syncType: 'CONTENT_UPDATE', payload: { title: 'Mug', description: 'Nice' } }))
    expect(m.content).toHaveBeenCalledTimes(1)
    expect(m.content.mock.calls[0][0]).toMatchObject({ accountId: 'etsy-acct', listingId: '700', content: { title: 'Mug', description: 'Nice' } })
    expect(m.inventory).not.toHaveBeenCalled()
  })

  it('a price change goes through the inventory writer as a PRICE', async () => {
    live()
    await service.syncToEtsy(row({ syncType: 'PRICE_UPDATE', payload: { price: 24.5 } }))
    expect(m.inventory.mock.calls[0][0].changes).toEqual([{ sku: 'RED-S', price: 24.5 }])
  })
})

describe('P4.6e — 🔴 a read-back that did not match is a SUCCESS with a warning', () => {
  it('drift does not fail the row — a retry on a full-replace endpoint is the wrong move', async () => {
    live()
    m.inventory.mockResolvedValue({ sent: true, body: {}, drift: [{ product: 'BLU-S', offering: 1, field: 'price', sent: 24.5, found: 0 }], confirmed: false })
    const result = await service.syncToEtsy(row())
    // The change WAS accepted. Calling it FAILED would invite a retry, and on a full-replace
    // endpoint a retry is exactly what would make it worse.
    expect(result).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(result.message).toContain('the read-back did not match')
    expect(result.message).toContain('1 field(s) differ')
    expect(result.message).toContain('An alert has been raised')
  })

  it('a read-back that could not be READ says so, and is still not a failure', async () => {
    live()
    m.inventory.mockResolvedValue({ sent: true, body: {}, drift: null, confirmed: false, reason: 'HTTP 503' })
    const result = await service.syncToEtsy(row())
    expect(result.status).toBe('SUCCESS')
    expect(result.message).toContain('Etsy could not be re-read')
  })

  it('nothing to change is a success that says nothing was sent', async () => {
    live()
    m.inventory.mockResolvedValue({ sent: false, body: null, drift: [], confirmed: true, reason: 'Etsy already holds these values; nothing was sent.' })
    expect((await service.syncToEtsy(row())).message).toBe('Etsy already holds these values; nothing was sent.')
  })

  it('the writer throwing IS a failure, and is logged as an attempt', async () => {
    live()
    m.inventory.mockRejectedValue(new Error('Etsy refused this change (HTTP 400).'))
    expect(await service.syncToEtsy(row())).toMatchObject({ success: false, status: 'FAILED', message: 'Etsy refused this change (HTTP 400).' })
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ channel: 'ETSY', outcome: 'failed' }))
  })
})

describe('P4.6e — dispatchSync routes ETSY', () => {
  it('a row targeting ETSY reaches the Etsy lane, not "Unknown channel"', async () => {
    live()
    const result = await service.dispatchSync(row())
    expect(result.channel).toBe('ETSY')
    expect(m.inventory).toHaveBeenCalledTimes(1)
  })
})
