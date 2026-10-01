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
    queueUpdate: vi.fn(),
    market: vi.fn(),
    policies: new Map() as Map<string, { pushesPaused: boolean; newListingDefaultMode: string }>,
    ingest: vi.fn(),
  }
})
vi.mock('../db.js', () => ({ default: { channelListing: { findUnique: m.read, findMany: m.many }, outboundSyncQueue: { update: m.queueUpdate }, marketplace: { findFirst: m.market }, etsyReceiptIngest: { findUnique: m.ingest } } }))
vi.mock('../lib/queue.js', () => ({ addJobSafely: vi.fn(), outboundSyncQueue: null, readCacheQueue: null, searchIndexQueue: null, redis: { connection: null } }))
// The real policy lookup over the policies a test sets (none by default).
vi.mock('./sync-control-policy.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sync-control-policy.service.js')>()),
  loadChannelPolicies: async () => m.policies,
}))
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
  vi.stubEnv('NEXUS_ENABLE_ETSY_ORDER_INGEST', '1')   // a stock row also needs Etsy order import (its own arms below)
  m.ingest.mockResolvedValue({ activatedAt: new Date('2026-10-01T00:00:00Z') })   // ...activated for the account
  m.policies = new Map()
  m.read.mockResolvedValue({ id: 'l1', syncPaused: false, marketplace: 'GLOBAL' })
  m.many.mockResolvedValue([])
  m.destinations.mockResolvedValue([{ connectionId: 'etsy-acct', reason: 'NAMED' }])
  m.inventory.mockResolvedValue({ sent: true, body: {}, drift: [], confirmed: true })
  m.content.mockResolvedValue({ sent: true, fields: {} })
  m.market.mockResolvedValue({ currency: 'EUR' })   // the ETSY/GLOBAL Marketplace row a price is sent in
})
afterEach(() => { expect(m.outbound).not.toHaveBeenCalled(); vi.unstubAllEnvs() })

describe('P4.6e — the gates, in order', () => {
  it.each(['ACCOUNT_NEEDS_SIGNIN', 'CONNECTION_NEEDS_REAUTH', 'TOKEN_UNAVAILABLE'])('preserves %s through dispatch and parks the queue row without spending retry budget', async code => {
    live()
    m.inventory.mockRejectedValue(Object.assign(new Error('Credential hold'), { code }))
    const item = row({ retryCount:3,maxRetries:3 })
    const result = await service.dispatchSync(item)
    expect(result).toMatchObject({success:false,errorCode:code})
    await service.handleSyncFailure(item,result.error,{errorCode:result.errorCode,retryable:result.retryable})
    const data = m.queueUpdate.mock.calls[0][0].data
    expect(data).toMatchObject({errorCode:'AUTH_REQUIRED',nextRetryAt:expect.any(Date)})
    expect(data).not.toHaveProperty('retryCount')
    expect(data).not.toHaveProperty('isDead')
  })
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
    expect(m.inventory.mock.calls[0][0].priceCurrency).toBe('EUR')
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

/**
 * 2026-10-01 (Owner) — Etsy stock joins the cascade. A stock row is sent only with the publish switches live AND Etsy
 * order import on; a Sync Control policy is re-checked at send time; a number above Etsy's 999 says it was clamped.
 * `fetch` is the only way out and every arm ends with it uncalled (afterEach).
 */
describe('Etsy stock rows: order import, the policy pause, the ceiling', () => {
  it.each([[''], ['0'], ['true']])('🔴 order import %p (not 1): the stock row is SKIPPED naming the switch, and nothing is read or sent', async (flag) => {
    live(); vi.stubEnv('NEXUS_ENABLE_ETSY_ORDER_INGEST', flag)
    const result = await service.syncToEtsy(row())
    expect(result).toMatchObject({ success: true, channel: 'ETSY', status: 'SKIPPED', errorCode: 'ETSY_ORDER_IMPORT_OFF', retryable: false })
    expect(result.message).toContain('NEXUS_ENABLE_ETSY_ORDER_INGEST is not 1')
    expect(result.message).toContain('could put back units Etsy has already sold')
    expect(m.inventory).not.toHaveBeenCalled()
    expect(m.market).not.toHaveBeenCalled()
    // Through the dispatcher as well, and the queue row records it as not sent.
    const dispatched = await service.dispatchSync(row())
    expect(dispatched).toMatchObject({ status: 'SKIPPED', errorCode: 'ETSY_ORDER_IMPORT_OFF' })
    const { completedSyncQueueData } = await import('./outbound-sync.service.js')
    expect(completedSyncQueueData(dispatched)).toMatchObject({ syncStatus: 'SKIPPED', syncedAt: null, errorCode: 'ETSY_ORDER_IMPORT_OFF' })
  })

  it('🔴 order import on but THIS account not activated: SKIPPED naming the activation, and nothing is read or sent', async () => {
    live(); m.ingest.mockResolvedValue(null)
    const result = await service.syncToEtsy(row())
    expect(result).toMatchObject({ success: true, channel: 'ETSY', status: 'SKIPPED', errorCode: 'ETSY_ORDER_IMPORT_NOT_ACTIVATED', retryable: false })
    expect(result.message).toBe('Etsy order import is not activated for this Etsy account (it has no activation record), so its sales do not reach Nexus stock. A stock number sent now could put back units Etsy has already sold, so nothing was sent to Etsy. Activate Etsy order import for this account first.')
    // It asked about the row's own account.
    expect(m.ingest).toHaveBeenCalledWith({ where: { workspace_connectionId: { connectionId: 'etsy-acct' } }, select: { activatedAt: true } })
    expect(m.inventory).not.toHaveBeenCalled()
  })

  it('the activation of ANOTHER Etsy account does not count: the read names the row\'s account', async () => {
    live()
    m.ingest.mockImplementation(async ({ where }: any) => (where.workspace_connectionId.connectionId === 'other-shop' ? { activatedAt: new Date() } : null))
    expect(await service.syncToEtsy(row())).toMatchObject({ status: 'SKIPPED', errorCode: 'ETSY_ORDER_IMPORT_NOT_ACTIVATED' })
    expect(m.inventory).not.toHaveBeenCalled()
  })

  it('an activation that cannot be read is not "activated": FAILED (retried later), nothing sent', async () => {
    live(); m.ingest.mockRejectedValue(new Error('database unavailable'))
    const result = await service.syncToEtsy(row())
    expect(result).toMatchObject({ success: false, status: 'FAILED', errorCode: 'ETSY_ORDER_IMPORT_UNKNOWN', retryable: true })
    expect(result.message).toContain('could not read whether Etsy order import is activated')
    expect(m.inventory).not.toHaveBeenCalled()
  })

  it('with the switch off the activation is not even read', async () => {
    live(); vi.stubEnv('NEXUS_ENABLE_ETSY_ORDER_INGEST', '')
    expect(await service.syncToEtsy(row())).toMatchObject({ status: 'SKIPPED', errorCode: 'ETSY_ORDER_IMPORT_OFF' })
    expect(m.ingest).not.toHaveBeenCalled()
  })

  it('the publish gate still answers first: both switches off names the publish switches', async () => {
    vi.stubEnv('NEXUS_ENABLE_ETSY_ORDER_INGEST', '')
    expect((await service.syncToEtsy(row())).message).toBe('Etsy gated — not published (set NEXUS_ENABLE_ETSY_PUBLISH=true + ETSY_PUBLISH_MODE=live)')
  })

  it('order import off or not activated does not hold a PRICE or a CONTENT row (neither is a stock number)', async () => {
    live(); vi.stubEnv('NEXUS_ENABLE_ETSY_ORDER_INGEST', ''); m.ingest.mockResolvedValue(null)
    await service.syncToEtsy(row({ syncType: 'PRICE_UPDATE', payload: { price: 24.5 } }))
    expect(m.inventory.mock.calls[0][0].changes).toEqual([{ sku: 'RED-S', price: 24.5 }])
    await service.syncToEtsy(row({ syncType: 'CONTENT_UPDATE', payload: { title: 'Mug' } }))
    expect(m.content).toHaveBeenCalledTimes(1)
  })

  it('🔴 a Sync Control policy pausing Etsy holds the row at send time: SKIPPED, not retried, nothing sent', async () => {
    live()
    const { policyKey } = await import('./sync-control-policy.service.js')
    m.policies = new Map([[policyKey('ETSY', '*'), { pushesPaused: true, newListingDefaultMode: 'FOLLOW' }]])
    expect(await service.syncToEtsy(row())).toMatchObject({ success: false, status: 'SKIPPED', errorCode: 'SYNC_PAUSED_POLICY', retryable: false, message: 'Channel-market pushes PAUSED (Sync Control policy)' })
    expect(m.inventory).not.toHaveBeenCalled()
  })

  it('a policy for ANOTHER Etsy account, or another channel, does not hold it', async () => {
    live()
    const { policyKey } = await import('./sync-control-policy.service.js')
    m.policies = new Map([
      [policyKey('ETSY', '*', 'other-shop'), { pushesPaused: true, newListingDefaultMode: 'FOLLOW' }],
      [policyKey('SHOPIFY', '*'), { pushesPaused: true, newListingDefaultMode: 'FOLLOW' }],
    ])
    expect(await service.syncToEtsy(row())).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(m.inventory).toHaveBeenCalledTimes(1)
  })

  it('a number Etsy cannot hold is sent as 999, and the row says so', async () => {
    live()
    m.inventory.mockResolvedValue({ sent: true, body: {}, drift: [], confirmed: true, clamped: [{ sku: 'RED-S', requested: 1500, sent: 999 }] })
    const result = await service.syncToEtsy(row({ payload: { quantity: 1500 } }))
    expect(result).toMatchObject({ success: true, status: 'SUCCESS' })
    expect(result.message).toBe('Etsy listing 700 updated and confirmed. Etsy holds at most 999 of an item, so 1500 was sent as 999.')
  })

  it('a stock refusal from the writer (duplicate SKU, one shared quantity) fails the row WITHOUT a retry', async () => {
    live()
    const { EtsyQuantityRefusal } = await import('./etsy/inventory.js')
    m.inventory.mockRejectedValue(new EtsyQuantityRefusal('Etsy has 2 products with SKU "RED-S" on this listing, and they hold separate quantities; Nexus holds one stock number for that SKU and will not put it on each of them, so nothing was sent.'))
    expect(await service.syncToEtsy(row())).toMatchObject({ success: false, status: 'FAILED', errorCode: 'ETSY_QUANTITY_REFUSED', retryable: false })
  })
})
