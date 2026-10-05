import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Sheet publish parity, step 7 (item 5, D4) and build shape v2 (P3) — the listing-action engine on the real schema and
 * tenant policies. Channels are stubbed at their one door each (SCT.6 close/reopen, the Amazon live read and delete, the
 * Trading calls, the eBay Inventory sender, a fake Shopify store behind the admin client, the Etsy state writer); the
 * engine's plan, refusals, holds, draft shape, coordinates, audit records and gates are real.
 */
const fixture = vi.hoisted(() => ({
  database: null as any,
  modes: { amazon: 'live', ebay: 'live', shopify: 'live' } as Record<string, string>,
  close: vi.fn(), reopen: vi.fn(), trading: vi.fn(), end: vi.fn(), relist: vi.fn(), unpublish: vi.fn(), preference: vi.fn(),
  activated: vi.fn(), shopify: vi.fn(), events: [] as any[], amazonLive: vi.fn(), amazonDelete: vi.fn(), etsy: vi.fn(), ebaySend: vi.fn(),
}))

vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  fixture.database = await formulaDatabase()
  return { default: fixture.database.client, prisma: fixture.database.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../amazon-publish-gate.service.js', () => ({ getAmazonPublishMode: () => fixture.modes.amazon }))
vi.mock('../ebay-publish-gate.service.js', async (original) => ({ ...(await original<object>()), getEbayPublishMode: () => fixture.modes.ebay, ebayWriteRefusal: () => null }))
vi.mock('../shopify-publish-gate.service.js', async (original) => ({ ...(await original<object>()), getShopifyPublishMode: () => fixture.modes.shopify }))
vi.mock('../amazon-market-offer.service.js', () => ({ closeMarketOffers: fixture.close, reopenMarketOffers: fixture.reopen }))
vi.mock('../amazon/purchasable-offer.js', async (original) => ({ ...(await original<object>()), readAmazonOfferLive: fixture.amazonLive }))
vi.mock('../../lib/amazon-sp-client.js', async (original) => ({ ...(await original<object>()), getAmazonSellerId: async () => 'TEST-SELLER' }))
vi.mock('../ebay-trading-api.service.js', async (original) => ({ ...(await original<object>()),
  callTradingApi: fixture.trading, endFixedPriceItem: fixture.end, relistFixedPriceItem: fixture.relist }))
vi.mock('../channel-delist.service.js', async (original) => ({ ...(await original<object>()),
  unpublishEbay: fixture.unpublish, readEbayOutOfStockPreference: fixture.preference, deleteAmazonListingOnChannel: fixture.amazonDelete }))
vi.mock('../gateway/ebay.js', async (original) => ({ ...(await original<object>()), ebaySend: fixture.ebaySend }))
vi.mock('../connection-resolver.service.js', async (original) => ({ ...(await original<object>()),
  tryResolveConnection: async ({ accountId }: { accountId: string }) => ({ id: accountId, channelType: 'EBAY' }) }))
vi.mock('../ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: async () => 'token' } }))
vi.mock('../listing-activation-sync.service.js', () => ({ syncActivatedListings: fixture.activated }))
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: (event: unknown) => { fixture.events.push(event) } }))
vi.mock('../etsy/listing-write.service.js', () => ({ setEtsyListingState: fixture.etsy }))
vi.mock('../shopify/admin-client.js', async (original) => ({
  ...(await original<object>()),
  shopifyAdmin: async () => ({ graphql: fixture.shopify, domain: 'test-store.myshopify.com' }),
  assertShopifyResult: (payload: any, operation: string) => { if (!payload) throw new Error(`${operation} returned no result.`); if (payload.userErrors?.length) throw new Error(payload.userErrors[0].message); return payload },
}))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { permissionForRoute } from '../../lib/auth/permissions-manifest.js'
import { AMAZON_FBA_DELETE_WARNING, AMAZON_FBA_PAUSE_WARNING, AMAZON_PAN_EU_DELETE_WARNING, deleteDoneSentence, deletedStatusReason, ETSY_DELETE_NOT_YET, SHOPIFY_PAUSE_CHECK } from '@nexus/shared/listing-actions'
import { destinationSellingStates, OLD_CLOSE_PAUSE_REASON, previewListingAction, readListingActionState, runListingAction } from './listing-action.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}
const USER = 'listing-action-user'

async function family(prefix: string, sizes: string[], fulfillment: Record<string, string> = {}) {
  const root = await prisma.product.create({ data: { sku: prefix, name: prefix, basePrice: 10, isParent: true, fulfillmentMethod: 'FBM' } as never })
  const children: Record<string, string> = {}
  for (const size of sizes) children[size] = (await prisma.product.create({ data: { sku: `${prefix}-${size}`, name: `${prefix} ${size}`, basePrice: 10, parentId: root.id, fulfillmentMethod: fulfillment[size] ?? 'FBM' } as never })).id
  return { root: root.id, children }
}

async function listing(productId: string, channel: string, marketplace: string, account: string, extra: Record<string, unknown> = {}) {
  return (await prisma.channelListing.create({ data: {
    productId, channel, marketplace, region: marketplace, channelMarket: `${channel}_${marketplace}`, channelConnectionId: account, aliasKey: '',
    fulfillmentMethod: 'FBM', listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'EXT', followMasterQuantity: true, followMasterPrice: true,
    quantity: 5, price: 10, ...extra,
  } as never })).id
}

const row = (id: string) => prisma.channelListing.findUnique({ where: { id }, select: {
  listingStatus: true, isPublished: true, externalListingId: true, syncPaused: true, offerClosedAt: true, offerCloseReason: true, platformAttributes: true,
} })
const draftShape = { listingStatus: 'DRAFT', isPublished: false, externalListingId: null, syncPaused: true, offerClosedAt: null }

const amazonScope = () => ({ scope: { channel: 'AMAZON', marketplace: 'IT', accountId: ids.amazon, aliasKey: '' } })
const ebayScope = (account = ids.ebay) => ({ scope: { channel: 'EBAY', marketplace: 'IT', accountId: account, aliasKey: '' } })
const shopifyScope = () => ({ scope: { channel: 'SHOPIFY', marketplace: 'GLOBAL', accountId: ids.shopify } })
const etsyScope = () => ({ scope: { channel: 'ETSY', marketplace: 'GLOBAL', accountId: ids.etsy } })

beforeAll(async () => {
  vi.stubEnv('NEXUS_EBAY_REAL_API', 'true')
  await scoped(async () => {
    for (const [channel, code] of [['AMAZON', 'IT'], ['EBAY', 'IT'], ['SHOPIFY', 'GLOBAL'], ['ETSY', 'GLOBAL']] as const)
      await prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } as never })
    ids.amazon = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'la-amazon', isActive: true, isPrimary: true } as never })).id
    ids.ebay = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'la-ebay', externalAccountId: 'la-ebay-1', isActive: true, isPrimary: true } as never })).id
    ids.ebay2 = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'la-ebay-2', externalAccountId: 'la-ebay-2', isActive: true, isPrimary: false } as never })).id
    ids.shopify = (await prisma.channelConnection.create({ data: { channelType: 'SHOPIFY', accountLabel: 'la-shopify', isActive: true, isPrimary: true } as never })).id
    ids.etsy = (await prisma.channelConnection.create({ data: { channelType: 'ETSY', accountLabel: 'la-etsy', isActive: true, isPrimary: true } as never })).id
  })
}, 120_000)
afterAll(async () => { vi.unstubAllEnvs(); await fixture.database?.close() })

describe('Amazon: pause = remove this market\'s offer (FBA too, with a warning); delete = remove the listing here', () => {
  it('reads each row\'s state and offers only what the channel can do; FBA may pause', () => scoped(async () => {
    const f = await family('AMZ-STATE', ['S', 'M', 'L'], { L: 'FBA' })
    await listing(f.root, 'AMAZON', 'IT', ids.amazon)
    await listing(f.children.S, 'AMAZON', 'IT', ids.amazon)
    await listing(f.children.M, 'AMAZON', 'IT', ids.amazon, { offerClosedAt: new Date(), offerCloseReason: 'sheet-pause' })
    await listing(f.children.L, 'AMAZON', 'IT', ids.amazon, { fulfillmentMethod: 'FBA' })
    const read = await readListingActionState(f.children.S, { channel: 'AMAZON', market: 'IT', accountId: ids.amazon })
    const r = (sku: string) => read.rows.find(x => x.sku === sku)!
    expect(read.model).toBe('amazon')
    expect(r('AMZ-STATE-S')).toMatchObject({ state: 'active', actions: ['pause'] })
    expect(r('AMZ-STATE-M')).toMatchObject({ state: 'paused', actions: ['resume'] })
    expect(r('AMZ-STATE-L')).toMatchObject({ state: 'active', actions: ['pause'], refusals: { end: expect.stringMatching(/no End/) } })
    expect(r('AMZ-STATE')).toMatchObject({ isParent: true, state: 'mixed', actions: ['pause', 'resume'] })
  }))

  it('previews per row (FBA sent with its warning, main product skipped), closes with allowFba, audits, refuses a second run', () => scoped(async () => {
    const f = await family('AMZ-RUN', ['S', 'L'], { L: 'FBA' })
    await listing(f.root, 'AMAZON', 'IT', ids.amazon)
    const s = await listing(f.children.S, 'AMAZON', 'IT', ids.amazon)
    await listing(f.children.L, 'AMAZON', 'IT', ids.amazon, { fulfillmentMethod: 'FBA' })
    const preview = await previewListingAction(f.root, 'pause', amazonScope(), USER)
    expect(preview.rows.map(r => [r.sku, r.plan])).toEqual([['AMZ-RUN', 'skip'], ['AMZ-RUN-L', 'send'], ['AMZ-RUN-S', 'send']])
    expect(preview.rows.find(r => r.sku === 'AMZ-RUN-L')!.sentence).toContain(AMAZON_FBA_PAUSE_WARNING)
    expect(preview.rows.find(r => r.sku === 'AMZ-RUN-S')!.sentence).not.toContain('FBA')
    expect(preview).toMatchObject({ sendCount: 2, confirm: { kind: 'checkbox' }, consequence: expect.stringMatching(/Other markets keep selling.*FBA units stay/) })
    fixture.close.mockImplementationOnce(async (opts: any) => {
      expect(opts).toMatchObject({ reason: 'sheet-pause', allowFba: true })
      expect(opts.targets.map((t: any) => t.productId).sort()).toEqual([f.children.L, f.children.S].sort())
      return { updated: 2, skippedFba: 0, unchanged: 0, failed: 0, results: [
        { productId: f.children.L, sku: 'AMZ-RUN-L', marketplace: 'IT', action: 'CLOSED', fba: true },
        { productId: f.children.S, sku: 'AMZ-RUN-S', marketplace: 'IT', action: 'CLOSED' }] }
    })
    const result = await runListingAction(f.children.S, 'pause', { previewId: preview.previewId }, USER)
    expect(result).toMatchObject({ status: 'DONE' })
    expect(result.rows.find(r => r.sku === 'AMZ-RUN-L')).toMatchObject({ outcome: 'DONE', message: expect.stringMatching(/Amazon keeps your FBA units/) })
    expect(await prisma.channelListingSnapshot.findFirst({ where: { channelListingId: s, reason: 'pause' } }))
      .toMatchObject({ publishEventId: preview.previewId, outcome: 'ACCEPTED', payload: expect.objectContaining({ kind: 'listing-action', action: 'pause' }) })
    expect(await prisma.syncControlAudit.findFirst({ where: { scopeId: `${f.children.S}:AMAZON:IT` } })).toMatchObject({ field: 'offerClosed', after: { closed: true }, reason: 'Product sheet: Pause offer' })
    expect(await prisma.bulkOperation.findUnique({ where: { id: preview.previewId }, select: { status: true, kind: true } })).toEqual({ status: 'DONE', kind: 'listing-action' })
    await expect(runListingAction(f.children.S, 'pause', { previewId: preview.previewId }, USER)).rejects.toMatchObject({ statusCode: 409 })
  }))

  it('an FBA resume replays the offer with allowFba and says Nexus sent no quantity', () => scoped(async () => {
    const f = await family('AMZ-FBA-RES', ['L'], { L: 'FBA' })
    await listing(f.children.L, 'AMAZON', 'IT', ids.amazon, { fulfillmentMethod: 'FBA', offerClosedAt: new Date(), offerCloseReason: 'sheet-pause' })
    const preview = await previewListingAction(f.root, 'resume', amazonScope(), USER)
    expect(preview.consequence).toMatch(/Amazon keeps its own quantity; Nexus sends none/)
    fixture.reopen.mockImplementationOnce(async (opts: any) => {
      expect(opts.allowFba).toBe(true)
      return { updated: 1, skippedFba: 0, unchanged: 0, failed: 0, results: [{ productId: f.children.L, sku: 'AMZ-FBA-RES-L', marketplace: 'IT', action: 'REOPENED', fba: true }] }
    })
    const result = await runListingAction(f.root, 'resume', { previewId: preview.previewId }, USER)
    expect(result.rows).toEqual([expect.objectContaining({ outcome: 'DONE', message: expect.stringMatching(/Nexus sent none/) })])
  }))

  it('a publish mode that is not live refuses with its sentence and changes nothing', () => scoped(async () => {
    const f = await family('AMZ-GATE', ['S'])
    await listing(f.children.S, 'AMAZON', 'IT', ids.amazon)
    const preview = await previewListingAction(f.root, 'pause', amazonScope(), USER)
    fixture.modes.amazon = 'dry-run'
    fixture.close.mockClear()
    try {
      await expect(runListingAction(f.root, 'pause', { previewId: preview.previewId }, USER))
        .rejects.toMatchObject({ statusCode: 409, code: 'publish_gated', message: expect.stringMatching(/publish mode: dry-run\)\. Nothing was changed\./) })
    } finally { fixture.modes.amazon = 'live' }
    expect(fixture.close).not.toHaveBeenCalled()
    expect(await prisma.bulkOperation.findUnique({ where: { id: preview.previewId }, select: { status: true } })).toEqual({ status: 'PREVIEW' })
  }))

  it('another user cannot run my preview', () => scoped(async () => {
    const f = await family('AMZ-OWNER', ['S'])
    await listing(f.children.S, 'AMAZON', 'IT', ids.amazon)
    const preview = await previewListingAction(f.root, 'pause', amazonScope(), USER)
    await expect(runListingAction(f.root, 'pause', { previewId: preview.previewId }, 'someone-else')).rejects.toMatchObject({ statusCode: 404 })
  }))

  it('Delete is typed (DELETE, the family SKU); FBA is sent with its warning; variations first; the main product waits for every variation', () => scoped(async () => {
    const f = await family('AMZ-DEL', ['S', 'M'], { M: 'FBA' })
    const root = await listing(f.root, 'AMAZON', 'IT', ids.amazon, { externalListingId: 'B0PARENT' })
    const s = await listing(f.children.S, 'AMAZON', 'IT', ids.amazon, { externalListingId: 'B0SSSS' })
    const m = await listing(f.children.M, 'AMAZON', 'IT', ids.amazon, { fulfillmentMethod: 'FBA', externalListingId: 'B0MMMM' })
    const preview = await previewListingAction(f.root, 'delete', amazonScope(), USER)
    expect(preview).toMatchObject({ action: 'delete', confirm: { kind: 'type', expected: 'AMZ-DEL', token: 'DELETE' }, consequence: expect.stringMatching(/only; other markets.*as Not listed\. To list it again, set Status to Active and Publish\..*FBA units stay.*cannot be undone/) })
    expect(preview.rows.map(r => [r.sku, r.plan])).toEqual([['AMZ-DEL', 'send'], ['AMZ-DEL-M', 'send'], ['AMZ-DEL-S', 'send']])
    // No FBA count in Nexus: the plain FBA warning; IT is a Pan-EU market (no program set): the Pan-EU warning too.
    expect(preview.rows.find(r => r.sku === 'AMZ-DEL-M')!.warning).toBe(`${AMAZON_FBA_DELETE_WARNING} ${AMAZON_PAN_EU_DELETE_WARNING}`)
    expect(preview.rows.find(r => r.sku === 'AMZ-DEL-S')!.warning ?? null).toBeNull()
    await expect(runListingAction(f.root, 'delete', { previewId: preview.previewId, confirm: 'END' }, USER)).rejects.toMatchObject({ statusCode: 400, code: 'confirm_required' })
    fixture.amazonLive.mockReset().mockResolvedValue({ read: 'ok', offers: [], fulfillmentChannels: ['DEFAULT'], instances: [], productType: 'COAT' })
    // The FBA variation's delete is not confirmed by Amazon: the main product waits for it.
    fixture.amazonDelete.mockReset().mockImplementation(async ({ sku }: { sku: string }) => sku === 'AMZ-DEL-M'
      ? { success: false, outcome: 'FAILED', error: 'Amazon throttled the request.' } : { success: true, outcome: 'SUCCESS', submissionId: 'sub-1' })
    const result = await runListingAction(f.root, 'delete', { previewId: preview.previewId, confirm: 'DELETE' }, USER)
    expect(fixture.amazonDelete.mock.calls.map(([call]) => call.sku)).toEqual(['AMZ-DEL-M', 'AMZ-DEL-S'])
    expect(result.rows.find(r => r.sku === 'AMZ-DEL')).toMatchObject({ outcome: 'SKIPPED', message: expect.stringMatching(/1 variation is still on Amazon here \(AMZ-DEL-M\)/) })
    expect(result.rows.find(r => r.sku === 'AMZ-DEL-M')).toMatchObject({ outcome: 'UNKNOWN' })
    expect(result.rows.find(r => r.sku === 'AMZ-DEL-S')).toMatchObject({ outcome: 'DONE', message: `${deleteDoneSentence('Amazon · IT')} Other markets keep their listings.` })
    expect(result.message).toMatch(/deleted on Amazon · IT\. To list it again, set Status to Active and Publish\./)
    expect(await row(s)).toMatchObject(draftShape)
    expect(await row(m)).toMatchObject({ listingStatus: 'ACTIVE', externalListingId: 'B0MMMM' })
    expect(await row(root)).toMatchObject({ listingStatus: 'ACTIVE', externalListingId: 'B0PARENT' })
    expect(await prisma.channelListingSnapshot.findFirst({ where: { channelListingId: s, reason: 'delete' } }))
      .toMatchObject({ outcome: 'ACCEPTED', payload: expect.objectContaining({ evidence: expect.objectContaining({ oldExternalListingId: 'B0SSSS', fba: false }) }) })
    // The row reads Ended now (deleted, read-only): nothing to delete, no status change; its Action lists it again.
    const read = await readListingActionState(f.root, { channel: 'AMAZON', market: 'IT', accountId: ids.amazon })
    expect(read.rows.find(r => r.sku === 'AMZ-DEL-S')).toMatchObject({ state: 'not_listed', actions: [],
      reason: expect.stringMatching(/^Deleted on Amazon · IT on \d{1,2} [A-Z][a-z]{2}\. To list it again, set Status to Active and Publish\.$/) })
    const again = await previewListingAction(f.root, 'delete', amazonScope(), USER)
    expect(again.rows.find(r => r.sku === 'AMZ-DEL-S')).toMatchObject({ plan: 'skip', sentence: expect.stringMatching(/^Deleted on Amazon · IT on .*set Status to Active\.$/) })
  }))

  it('an FBA delete is sent though Amazon reports AMAZON_EU: the warning names Amazon\'s unit count and Pan-European FBA, the audit keeps Amazon\'s answer', () => scoped(async () => {
    const f = await family('AMZ-DEL2', ['S'], { S: 'FBA' })
    const s = await listing(f.children.S, 'AMAZON', 'IT', ids.amazon, { fulfillmentMethod: 'FBA', externalListingId: 'B0DEL2' })
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000 - 60_000)
    for (const [condition, quantity] of [['SELLABLE', 12], ['INBOUND', 2]] as const)
      await prisma.fbaInventoryDetail.create({ data: { productId: f.children.S, sku: 'AMZ-DEL2-S', asin: 'B0DEL2', marketplaceId: 'APJ6JRA9NG5V4', fulfillmentCenterId: 'MXP6', condition, quantity, lastSyncedAt: twoHoursAgo } })
    const preview = await previewListingAction(f.root, 'delete', amazonScope(), USER)
    expect(preview.rows.find(r => r.sku === 'AMZ-DEL2-S')).toMatchObject({ plan: 'send', warning:
      'Amazon holds 14 FBA units for this SKU here (12 sellable, 2 on the way), read 2 hours ago. They cannot sell until you list this SKU here again, and Amazon still charges storage. '
      + AMAZON_PAN_EU_DELETE_WARNING })
    fixture.amazonLive.mockReset().mockResolvedValue({ read: 'ok', offers: [], fulfillmentChannels: ['AMAZON_EU'], instances: [], productType: 'COAT' })
    fixture.amazonDelete.mockReset().mockResolvedValue({ success: true, outcome: 'SUCCESS', submissionId: 'sub-2' })
    const result = await runListingAction(f.root, 'delete', { previewId: preview.previewId, confirm: 'DELETE' }, USER)
    expect(result).toMatchObject({ status: 'DONE', rows: [{ outcome: 'DONE' }] })
    expect(fixture.amazonDelete).toHaveBeenCalledExactlyOnceWith({ sellerId: 'TEST-SELLER', sku: 'AMZ-DEL2-S', marketplaceId: 'APJ6JRA9NG5V4' })
    expect(await row(s)).toMatchObject(draftShape)
    expect(await prisma.channelListingSnapshot.findFirst({ where: { channelListingId: s, reason: 'delete' } }))
      .toMatchObject({ payload: expect.objectContaining({ evidence: expect.objectContaining({ oldExternalListingId: 'B0DEL2', fba: true, fulfillmentChannels: ['AMAZON_EU'] }) }) })
    // A program the seller set wins over the market list: not Pan-EU here → no Pan-EU warning.
    await prisma.marketplace.updateMany({ where: { channel: 'AMAZON', code: 'IT' }, data: { fbaProgram: 'MCI' } })
    const g = await family('AMZ-DEL3', ['S'], { S: 'FBA' })
    await listing(g.children.S, 'AMAZON', 'IT', ids.amazon, { fulfillmentMethod: 'FBA', externalListingId: 'B0DEL3' })
    expect((await previewListingAction(g.root, 'delete', amazonScope(), USER)).rows.find(r => r.sku === 'AMZ-DEL3-S')!.warning).toBe(AMAZON_FBA_DELETE_WARNING)
    await prisma.marketplace.updateMany({ where: { channel: 'AMAZON', code: 'IT' }, data: { fbaProgram: null } })
  }))
})

describe('S3 (per-channel SKU) — every Amazon row is acted on under the SKU Amazon holds for it', () => {
  const skuRow = (id: string) => prisma.channelListing.findUnique({ where: { id }, select: { channelSku: true, liveChannelSku: true, listingStatus: true, isPublished: true, externalListingId: true } })

  it('Delete names each row\'s own seller SKU (the product SKU for a row with none), clears the live SKU and keeps the wanted one', () => scoped(async () => {
    const f = await family('AMZ-OWN', ['S', 'M'])
    const s = await listing(f.children.S, 'AMAZON', 'IT', ids.amazon, { externalListingId: 'B0OWNS', channelSku: 'OWN-S-IT', liveChannelSku: 'OWN-S-IT' })
    const m = await listing(f.children.M, 'AMAZON', 'IT', ids.amazon, { externalListingId: 'B0OWNM' })
    const preview = await previewListingAction(f.root, 'delete', amazonScope(), USER)
    // The plan rows still name the products (the sheet's rows).
    expect(preview.rows.map(r => [r.sku, r.plan])).toEqual([['AMZ-OWN', 'skip'], ['AMZ-OWN-M', 'send'], ['AMZ-OWN-S', 'send']])
    fixture.amazonLive.mockReset().mockResolvedValue({ read: 'ok', offers: [], fulfillmentChannels: ['DEFAULT'], instances: [], productType: 'COAT' })
    fixture.amazonDelete.mockReset().mockResolvedValue({ success: true, outcome: 'SUCCESS', submissionId: 'sub-own' })
    const result = await runListingAction(f.root, 'delete', { previewId: preview.previewId, confirm: 'DELETE' }, USER)
    expect(result).toMatchObject({ status: 'DONE' })
    expect(fixture.amazonDelete.mock.calls.map(([call]) => call.sku)).toEqual(['AMZ-OWN-M', 'OWN-S-IT'])
    expect(fixture.amazonLive.mock.calls.map(([call]) => call.sku)).toEqual(['AMZ-OWN-M', 'OWN-S-IT'])
    expect(await skuRow(s)).toEqual({ channelSku: 'OWN-S-IT', liveChannelSku: null, listingStatus: 'DRAFT', isPublished: false, externalListingId: null })
    expect(await skuRow(m)).toEqual({ channelSku: null, liveChannelSku: null, listingStatus: 'DRAFT', isPublished: false, externalListingId: null })
    // The audit names the SKU that was deleted.
    expect(await prisma.channelListingSnapshot.findFirst({ where: { channelListingId: s, reason: 'delete' } })).toMatchObject({ payload: expect.objectContaining({ sku: 'OWN-S-IT' }) })
  }))

  it('a seller SKU held in an old store (an active offer) is the one deleted', () => scoped(async () => {
    const f = await family('AMZ-OFF', ['S'])
    const s = await listing(f.children.S, 'AMAZON', 'IT', ids.amazon, { externalListingId: 'B0OFFS' })
    await prisma.offer.create({ data: { channelListingId: s, sku: 'OFFER-S-IT', fulfillmentMethod: 'FBM', isActive: true } })
    const preview = await previewListingAction(f.root, 'delete', amazonScope(), USER)
    fixture.amazonLive.mockReset().mockResolvedValue({ read: 'ok', offers: [], fulfillmentChannels: ['DEFAULT'], instances: [], productType: 'COAT' })
    fixture.amazonDelete.mockReset().mockResolvedValue({ success: true, outcome: 'SUCCESS', submissionId: 'sub-off' })
    await runListingAction(f.root, 'delete', { previewId: preview.previewId, confirm: 'DELETE' }, USER)
    expect(fixture.amazonDelete).toHaveBeenCalledExactlyOnceWith({ sellerId: 'TEST-SELLER', sku: 'OFFER-S-IT', marketplaceId: 'APJ6JRA9NG5V4' })
  }))

  it('a row with two seller SKUs on record is refused with the reason; nothing is sent for it', () => scoped(async () => {
    const f = await family('AMZ-TWO', ['S', 'M'])
    const s = await listing(f.children.S, 'AMAZON', 'IT', ids.amazon, { externalListingId: 'B0TWOS' })
    await listing(f.children.M, 'AMAZON', 'IT', ids.amazon, { externalListingId: 'B0TWOM' })
    // One active offer per fulfilment method (FBM and FBA) under two different seller SKUs: Nexus cannot tell which to act on.
    for (const [sku, method] of [['TWO-A', 'FBM'], ['TWO-B', 'FBA']] as const) await prisma.offer.create({ data: { channelListingId: s, sku, fulfillmentMethod: method, isActive: true } })
    for (const action of ['delete', 'pause'] as const) {
      const preview = await previewListingAction(f.root, action, amazonScope(), USER)
      expect(preview.rows.find(r => r.sku === 'AMZ-TWO-S')).toMatchObject({ plan: 'refused', sentence: 'AMZ-TWO-S has multiple seller SKUs. Select its offer before publishing. Nothing was sent.' })
      expect(preview.rows.find(r => r.sku === 'AMZ-TWO-M')).toMatchObject({ plan: 'send' })
    }
  }))

  it('a still-draft row keeps the product SKU (nothing new is sent for a draft)', () => scoped(async () => {
    const f = await family('AMZ-DRF', ['S'])
    await listing(f.children.S, 'AMAZON', 'IT', ids.amazon, { listingStatus: 'DRAFT', isPublished: false, externalListingId: null, syncPaused: true, channelSku: 'WANT-S-IT' })
    const read = await readListingActionState(f.root, { channel: 'AMAZON', market: 'IT', accountId: ids.amazon })
    expect(read.rows.find(r => r.sku === 'AMZ-DRF-S')).toMatchObject({ state: 'draft' })
    const preview = await previewListingAction(f.root, 'delete', amazonScope(), USER)
    expect(preview.rows.find(r => r.sku === 'AMZ-DRF-S')).toMatchObject({ plan: 'skip' })
  }))
})

const getItem = (oos: 'true' | 'false' | null, skus: Array<[string, number]>) => ({ ack: 'Success', raw: `<Item><ItemID>111</ItemID>${oos === null ? '' : `<OutOfStockControl>${oos}</OutOfStockControl>`}<SellingStatus><ListingStatus>Active</ListingStatus></SellingStatus><Variations>${skus.map(([sku, qty]) => `<Variation><SKU>${sku}</SKU><Quantity>${qty}</Quantity><SellingStatus><QuantitySold>0</QuantitySold></SellingStatus></Variation>`).join('')}</Variations></Item>` })

describe('eBay (Trading): pause = quantity 0 under the out-of-stock control, then the hold', () => {
  it('refuses to pause when the item\'s out-of-stock control is off or unknown; nothing is held', () => scoped(async () => {
    const f = await family('EB-OOS', ['S', 'M'])
    await listing(f.root, 'EBAY', 'IT', ids.ebay, { externalListingId: '111' })
    const s = await listing(f.children.S, 'EBAY', 'IT', ids.ebay, { externalListingId: '111' })
    await listing(f.children.M, 'EBAY', 'IT', ids.ebay, { externalListingId: '111' })
    for (const oos of ['false', null] as const) {
      fixture.trading.mockReset().mockImplementation(async (call: string) => call === 'GetItem' ? getItem(oos, [['EB-OOS-S', 3], ['EB-OOS-M', 2]]) : { ack: 'Success', raw: '' })
      const preview = await previewListingAction(f.root, 'pause', { ...ebayScope(), productIds: [f.children.S] }, USER)
      const result = await runListingAction(f.root, 'pause', { previewId: preview.previewId }, USER)
      expect(result).toMatchObject({ status: 'NOT_SENT', rows: [{ sku: 'EB-OOS-S', outcome: 'NOT_SENT', message: oos === 'false' ? expect.stringMatching(/would end it/) : expect.stringMatching(/did not say/) }] })
      expect(fixture.trading.mock.calls.map(c => c[0])).toEqual(['GetItem'])
    }
    expect(await prisma.channelListing.findUnique({ where: { id: s }, select: { offerClosedAt: true } })).toEqual({ offerClosedAt: null })
  }))

  it('holds only the exact row eBay confirmed (not the same product on another account) and cancels its waiting pushes', () => scoped(async () => {
    const f = await family('EB-HOLD', ['S', 'M'])
    await listing(f.root, 'EBAY', 'IT', ids.ebay, { externalListingId: '111' })
    const s = await listing(f.children.S, 'EBAY', 'IT', ids.ebay, { externalListingId: '111' })
    await listing(f.children.M, 'EBAY', 'IT', ids.ebay, { externalListingId: '111' })
    const other = await listing(f.children.S, 'EBAY', 'IT', ids.ebay2, { externalListingId: '222' })
    const waiting = await prisma.outboundSyncQueue.create({ data: { productId: f.children.S, channelListingId: s, targetChannel: 'EBAY', targetRegion: 'IT', syncType: 'QUANTITY_UPDATE', syncStatus: 'PENDING', payload: {} } as never })
    fixture.trading.mockReset().mockImplementation(async (call: string) => call === 'GetItem' ? getItem('true', [['EB-HOLD-S', 3], ['EB-HOLD-M', 2]]) : { ack: 'Success', raw: '' })
    const preview = await previewListingAction(f.root, 'pause', { ...ebayScope(), productIds: [f.children.S] }, USER)
    const result = await runListingAction(f.root, 'pause', { previewId: preview.previewId }, USER)
    expect(result).toMatchObject({ status: 'DONE', rows: [{ sku: 'EB-HOLD-S', outcome: 'DONE' }] })
    expect(fixture.trading.mock.calls.map(c => c[0])).toEqual(['GetItem', 'ReviseInventoryStatus'])
    expect(fixture.trading.mock.calls[1][1]).toContain('<SKU>EB-HOLD-S</SKU>')
    expect(fixture.trading.mock.calls[1][1]).not.toContain('EB-HOLD-M')
    expect(await prisma.channelListing.findUnique({ where: { id: s }, select: { offerClosedAt: true, offerCloseReason: true, offerActive: true } }))
      .toMatchObject({ offerClosedAt: expect.any(Date), offerCloseReason: 'sheet-pause', offerActive: false })
    expect(await prisma.channelListing.findUnique({ where: { id: other }, select: { offerClosedAt: true } })).toEqual({ offerClosedAt: null })
    expect(await prisma.outboundSyncQueue.findUnique({ where: { id: waiting.id }, select: { syncStatus: true } })).toEqual({ syncStatus: 'CANCELLED' })
    // A second pause of the same row: already inactive.
    const again = await previewListingAction(f.root, 'pause', { ...ebayScope(), productIds: [f.children.S] }, USER)
    expect(again.rows.find(r => r.sku === 'EB-HOLD-S')).toMatchObject({ plan: 'skip', sentence: 'Already inactive.' })

    // Resume lifts the sheet's own hold and sends the current stock through the activation lane.
    fixture.activated.mockClear()
    const resume = await previewListingAction(f.root, 'resume', { ...ebayScope(), productIds: [f.children.S] }, USER)
    expect(resume.rows.find(r => r.sku === 'EB-HOLD-S')?.plan).toBe('send')
    expect(await runListingAction(f.root, 'resume', { previewId: resume.previewId }, USER)).toMatchObject({ status: 'DONE' })
    expect(fixture.activated).toHaveBeenCalledWith([s])
    expect(await prisma.channelListing.findUnique({ where: { id: s }, select: { offerClosedAt: true, offerActive: true } })).toEqual({ offerClosedAt: null, offerActive: true })
  }))

  it('a hand-pinned row gets its pin back on resume (the activation lane sends nothing for a pin)', () => scoped(async () => {
    const f = await family('EB-PIN', ['S'])
    const s = await listing(f.children.S, 'EBAY', 'IT', ids.ebay, { externalListingId: '112', followMasterQuantity: false, quantityOverride: 7,
      offerClosedAt: new Date(), offerCloseReason: 'sheet-pause' })
    const resume = await previewListingAction(f.root, 'resume', ebayScope(), USER)
    expect(await runListingAction(f.root, 'resume', { previewId: resume.previewId }, USER)).toMatchObject({ status: 'DONE' })
    expect(await prisma.outboundSyncQueue.findFirst({ where: { channelListingId: s, syncType: 'QUANTITY_UPDATE', syncStatus: 'PENDING' }, select: { payload: true } }))
      .toMatchObject({ payload: expect.objectContaining({ quantity: 7, source: 'LISTING_RESUMED' }) })
    expect(await prisma.channelListing.findUnique({ where: { id: s }, select: { followMasterQuantity: true, quantityOverride: true } })).toEqual({ followMasterQuantity: false, quantityOverride: 7 })
  }))

  it('End needs the confirm, keeps the item number, and reads Ended', () => scoped(async () => {
    const f = await family('EB-END', ['S'])
    const root = await listing(f.root, 'EBAY', 'IT', ids.ebay, { externalListingId: '333' })
    const s = await listing(f.children.S, 'EBAY', 'IT', ids.ebay, { externalListingId: '333' })
    const preview = await previewListingAction(f.root, 'end', ebayScope(), USER)
    expect(preview).toMatchObject({ reach: 'listing', confirm: { kind: 'type', expected: '333', token: 'END' }, consequence: expect.stringMatching(/Relist makes a new eBay item number/) })
    await expect(runListingAction(f.root, 'end', { previewId: preview.previewId }, USER)).rejects.toMatchObject({ statusCode: 400, code: 'confirm_required' })
    fixture.end.mockReset().mockResolvedValueOnce({ ack: 'Success', itemId: '333', errors: [] })
    expect(await runListingAction(f.root, 'end', { previewId: preview.previewId, confirm: 'END' }, USER)).toMatchObject({ status: 'DONE' })
    expect(fixture.end).toHaveBeenCalledWith({ itemId: '333', endingReason: 'NotAvailable' }, expect.objectContaining({ connectionId: ids.ebay }))
    for (const id of [root, s]) expect(await prisma.channelListing.findUnique({ where: { id }, select: { listingStatus: true, externalListingId: true } })).toEqual({ listingStatus: 'ENDED', externalListingId: '333' })
  }))

  it('Relist writes the new item number on this account and alias only', () => scoped(async () => {
    const f = await family('EB-RELIST', ['S'])
    const s = await listing(f.children.S, 'EBAY', 'IT', ids.ebay, { externalListingId: '444', listingStatus: 'ENDED' })
    const alias = await listing(f.children.S, 'EBAY', 'IT', ids.ebay, { externalListingId: '444', listingStatus: 'ENDED', aliasKey: 'ALT' })
    const preview = await previewListingAction(f.root, 'relist', ebayScope(), USER)
    fixture.relist.mockResolvedValueOnce({ ack: 'Success', newItemId: '555', errors: [] })
    fixture.activated.mockClear()
    expect(await runListingAction(f.root, 'relist', { previewId: preview.previewId }, USER)).toMatchObject({ status: 'DONE' })
    expect(await prisma.channelListing.findUnique({ where: { id: s }, select: { externalListingId: true, listingStatus: true } })).toEqual({ externalListingId: '555', listingStatus: 'ACTIVE' })
    expect(await prisma.channelListing.findUnique({ where: { id: alias }, select: { externalListingId: true, listingStatus: true } })).toEqual({ externalListingId: '444', listingStatus: 'ENDED' })
    expect(fixture.activated).toHaveBeenCalledWith([s])
  }))

  it('Delete ends a live item, then forgets its number on every row (draft shape, old number audited)', () => scoped(async () => {
    const f = await family('EB-DEL', ['S', 'M'])
    const root = await listing(f.root, 'EBAY', 'IT', ids.ebay, { externalListingId: '666' })
    const s = await listing(f.children.S, 'EBAY', 'IT', ids.ebay, { externalListingId: '666' })
    const m = await listing(f.children.M, 'EBAY', 'IT', ids.ebay, { externalListingId: '666' })
    const preview = await previewListingAction(f.children.S, 'delete', ebayScope(), USER)
    expect(preview).toMatchObject({ reach: 'listing', sendCount: 3, confirm: { kind: 'type', expected: 'EB-DEL', token: 'DELETE' }, consequence: expect.stringMatching(/forgets its item number/) })
    await expect(runListingAction(f.root, 'delete', { previewId: preview.previewId }, USER)).rejects.toMatchObject({ code: 'confirm_required' })
    fixture.end.mockReset().mockResolvedValueOnce({ ack: 'Success', itemId: '666', errors: [] })
    expect(await runListingAction(f.root, 'delete', { previewId: preview.previewId, confirm: 'DELETE' }, USER)).toMatchObject({ status: 'DONE',
      message: '3 of 3 deleted on eBay · IT. To list it again, set Status to Active and Publish.' })
    expect(fixture.end).toHaveBeenCalledExactlyOnceWith({ itemId: '666', endingReason: 'NotAvailable' }, expect.anything())
    for (const id of [root, s, m]) expect(await row(id)).toMatchObject(draftShape)
    expect(await prisma.channelListingSnapshot.findFirst({ where: { channelListingId: root, reason: 'delete' } }))
      .toMatchObject({ payload: expect.objectContaining({ evidence: expect.objectContaining({ oldExternalListingId: '666', endedNow: true }) }) })
  }))

  it('Delete of an item eBay already ended makes no End call', () => scoped(async () => {
    const f = await family('EB-DEL-ENDED', ['S'])
    const s = await listing(f.children.S, 'EBAY', 'IT', ids.ebay, { externalListingId: '777', listingStatus: 'ENDED' })
    const preview = await previewListingAction(f.root, 'delete', ebayScope(), USER)
    fixture.end.mockReset()
    expect(await runListingAction(f.root, 'delete', { previewId: preview.previewId, confirm: 'DELETE' }, USER)).toMatchObject({ status: 'DONE' })
    expect(fixture.end).not.toHaveBeenCalled()
    expect(await row(s)).toMatchObject(draftShape)
  }))
})

describe('eBay (Inventory): delete = withdraw, then delete this marketplace\'s offers', () => {
  it('withdraws the item group, deletes each SKU\'s offer here, keeps the inventory items, forgets the offer ids', () => scoped(async () => {
    const f = await family('EBI-DEL', ['S', 'M'])
    const root = await listing(f.root, 'EBAY', 'IT', ids.ebay, { externalListingId: '888' })
    const s = await listing(f.children.S, 'EBAY', 'IT', ids.ebay, { externalListingId: '888', platformAttributes: { __offerIds: { EBAY_IT: 'OFF-S', EBAY_DE: 'OFF-S-DE' } } })
    const m = await listing(f.children.M, 'EBAY', 'IT', ids.ebay, { externalListingId: '888', platformAttributes: { __offerIds: { EBAY_IT: 'OFF-M' } } })
    const preview = await previewListingAction(f.root, 'delete', ebayScope(), USER)
    expect(preview).toMatchObject({ model: 'ebay-inventory', consequence: expect.stringMatching(/inventory items stay/) })
    const calls: string[] = []
    fixture.ebaySend.mockReset().mockImplementation(async (_account: string, url: string, init: RequestInit = {}) => {
      calls.push(`${init.method ?? 'GET'} ${new URL(url).pathname}`)
      return init.method === 'DELETE' ? new Response(null, { status: 204 }) : new Response('{}', { status: 200 })
    })
    expect(await runListingAction(f.root, 'delete', { previewId: preview.previewId, confirm: 'DELETE' }, USER)).toMatchObject({ status: 'DONE' })
    expect(calls[0]).toBe('POST /sell/inventory/v1/offer/withdraw_by_inventory_item_group')
    expect(calls.slice(1).sort()).toEqual(['DELETE /sell/inventory/v1/offer/OFF-M', 'DELETE /sell/inventory/v1/offer/OFF-S'])
    expect(calls.some(c => c.includes('inventory_item/'))).toBe(false)
    for (const id of [root, s, m]) expect(await row(id)).toMatchObject(draftShape)
    expect((await row(s))!.platformAttributes).toEqual({ __offerIds: { EBAY_DE: 'OFF-S-DE' } })
  }))
})

/** A fake Shopify store behind the admin client: one product, its variants, stock at one location. */
function shopifyStore(productId: string, variants: Array<{ id: string; sku: string; policy: 'DENY' | 'CONTINUE'; qty: number }>, status = 'ACTIVE') {
  const store = { status, deleted: false, qty: new Map(variants.map(v => [v.id, v.qty])), calls: [] as string[], sets: [] as any[] }
  const product = `gid://shopify/Product/${productId}`
  const variantOf = (id: string) => variants.find(v => `gid://shopify/ProductVariant/${v.id}` === id)!
  fixture.shopify.mockReset().mockImplementation(async (query: string, variables: any) => {
    const name = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? '?'
    store.calls.push(name)
    switch (name) {
      case 'NexusPauseVariants': return { product: store.deleted ? null : { id: product, variants: { nodes: variants.map(v => ({ id: `gid://shopify/ProductVariant/${v.id}`, sku: v.sku, inventoryPolicy: v.policy, inventoryItem: { id: `gid://shopify/InventoryItem/${v.id}0` } })) } } }
      case 'NexusVariantPrice': { const v = variantOf(variables.id); return { productVariant: { id: variables.id, sku: v.sku, price: '10.00', product: { id: product }, inventoryItem: { id: `gid://shopify/InventoryItem/${v.id}0` } } } }
      case 'NexusVariant': { const v = variantOf(variables.id); return { productVariant: { id: variables.id, sku: v.sku, price: '10.00', product: { id: product }, inventoryItem: { id: `gid://shopify/InventoryItem/${v.id}0`, inventoryLevel: { quantities: [{ name: 'available', quantity: store.qty.get(v.id) }] } } } } }
      case 'NexusVariantStock': {
        const q = variables.input.quantities[0]
        store.sets.push(q)
        store.qty.set(q.inventoryItemId.split('/').at(-1).slice(0, -1), q.quantity)
        return { inventorySetQuantities: { inventoryAdjustmentGroup: { reason: 'correction' }, userErrors: [] } }
      }
      case 'NexusListingStatus': store.status = variables.product.status; return { productUpdate: { product: { id: product, status: store.status }, userErrors: [] } }
      case 'NexusListingStatusRead': return { product: { status: store.status } }
      case 'NexusListingDelete': store.deleted = true; return { productDelete: { deletedProductId: variables.input.id, userErrors: [] } }
      case 'NexusListingDeleteRead': return { product: store.deleted ? null : { id: product } }
      default: throw new Error(`unexpected Shopify call ${name}`)
    }
  })
  return store
}
const variantAttrs = (productId: string, variantId: string) => ({ nexusFamilyId: 'fam', shopifyProductId: productId, variantId, inventoryItemId: `${variantId}0`, inventoryLocationId: 'gid://shopify/Location/1' })

describe('Shopify: pause = quantity 0 per variant held by Nexus; delete = productDelete', () => {
  it('pauses each variant at quantity 0 and holds it; a variant that sells out of stock is not paused; the product reads Mixed', () => scoped(async () => {
    const f = await family('SH-QTY', ['S', 'M'])
    const root = await listing(f.root, 'SHOPIFY', 'GLOBAL', ids.shopify, { externalListingId: '9101', platformAttributes: { status: 'ACTIVE' } })
    const s = await listing(f.children.S, 'SHOPIFY', 'GLOBAL', ids.shopify, { externalListingId: '9101', platformAttributes: variantAttrs('9101', '11') })
    const m = await listing(f.children.M, 'SHOPIFY', 'GLOBAL', ids.shopify, { externalListingId: '9101', platformAttributes: variantAttrs('9101', '12') })
    const preview = await previewListingAction(f.root, 'pause', shopifyScope(), USER)
    expect(preview).toMatchObject({ reach: 'row', sendCount: 2, checkedAtSend: SHOPIFY_PAUSE_CHECK, consequence: expect.stringMatching(/quantity 0.*sold out/) })
    expect(preview.rows.map(r => [r.sku, r.plan])).toEqual([['SH-QTY', 'skip'], ['SH-QTY-M', 'send'], ['SH-QTY-S', 'send']])
    const store = shopifyStore('9101', [{ id: '11', sku: 'SH-QTY-S', policy: 'DENY', qty: 4 }, { id: '12', sku: 'SH-QTY-M', policy: 'CONTINUE', qty: 2 }])
    const result = await runListingAction(f.root, 'pause', { previewId: preview.previewId }, USER)
    expect(result.rows.find(r => r.sku === 'SH-QTY-S')).toMatchObject({ outcome: 'DONE', message: expect.stringMatching(/quantity 0/) })
    expect(result.rows.find(r => r.sku === 'SH-QTY-M')).toMatchObject({ outcome: 'NOT_SENT', message: expect.stringMatching(/Continue selling when out of stock/) })
    expect(store.sets).toEqual([expect.objectContaining({ inventoryItemId: 'gid://shopify/InventoryItem/110', locationId: 'gid://shopify/Location/1', quantity: 0, changeFromQuantity: 4 })])
    expect(store.qty.get('12')).toBe(2)
    expect(store.calls).not.toContain('NexusListingStatus')
    expect(await row(s)).toMatchObject({ offerClosedAt: expect.any(Date), offerCloseReason: 'sheet-pause' })
    expect(await row(m)).toMatchObject({ offerClosedAt: null })
    expect(await row(root)).toMatchObject({ offerClosedAt: null, platformAttributes: { status: 'ACTIVE' } })
    const read = await readListingActionState(f.root, { channel: 'SHOPIFY', market: 'GLOBAL', accountId: ids.shopify })
    expect(Object.fromEntries(read.rows.map(r => [r.sku, r.state]))).toEqual({ 'SH-QTY': 'mixed', 'SH-QTY-M': 'active', 'SH-QTY-S': 'paused' })
  }))

  it('resume lifts the hold and sends the current stock; a product that is a Draft in Shopify becomes Active first', () => scoped(async () => {
    const f = await family('SH-RES', ['S'])
    const root = await listing(f.root, 'SHOPIFY', 'GLOBAL', ids.shopify, { externalListingId: '9102', platformAttributes: { status: 'DRAFT' }, listingStatus: 'INACTIVE', isPublished: false })
    const s = await listing(f.children.S, 'SHOPIFY', 'GLOBAL', ids.shopify, { externalListingId: '9102', platformAttributes: variantAttrs('9102', '21'),
      offerClosedAt: new Date(), offerCloseReason: 'sheet-pause', listingStatus: 'INACTIVE', isPublished: false })
    const preview = await previewListingAction(f.root, 'resume', shopifyScope(), USER)
    expect(preview).toMatchObject({ sendCount: 1, consequence: expect.stringMatching(/active again in every market of the store/) })
    const store = shopifyStore('9102', [{ id: '21', sku: 'SH-RES-S', policy: 'DENY', qty: 0 }], 'DRAFT')
    fixture.activated.mockClear()
    expect(await runListingAction(f.root, 'resume', { previewId: preview.previewId }, USER)).toMatchObject({ status: 'DONE' })
    expect(store.status).toBe('ACTIVE')
    expect(fixture.activated).toHaveBeenCalledWith([s])
    expect(await row(s)).toMatchObject({ offerClosedAt: null, listingStatus: 'ACTIVE', isPublished: true })
    expect(await row(root)).toMatchObject({ platformAttributes: { status: 'ACTIVE' }, listingStatus: 'ACTIVE' })
  }))

  it('Delete is typed (DELETE, the family SKU), deletes the product, and every row goes back to the draft shape', () => scoped(async () => {
    const f = await family('SH-DEL', ['S'])
    const root = await listing(f.root, 'SHOPIFY', 'GLOBAL', ids.shopify, { externalListingId: '9103', platformProductId: '9103', platformAttributes: { status: 'ACTIVE', nexusFamilyId: 'fam' } })
    const s = await listing(f.children.S, 'SHOPIFY', 'GLOBAL', ids.shopify, { externalListingId: '9103', platformAttributes: variantAttrs('9103', '31') })
    const preview = await previewListingAction(f.root, 'delete', shopifyScope(), USER)
    expect(preview).toMatchObject({ reach: 'product', sendCount: 2, confirm: { kind: 'type', expected: 'SH-DEL', token: 'DELETE' }, consequence: expect.stringMatching(/deletes SH-DEL.*cannot be undone/) })
    await expect(runListingAction(f.root, 'delete', { previewId: preview.previewId }, USER)).rejects.toMatchObject({ code: 'confirm_required' })
    const store = shopifyStore('9103', [{ id: '31', sku: 'SH-DEL-S', policy: 'DENY', qty: 3 }])
    expect(await runListingAction(f.root, 'delete', { previewId: preview.previewId, confirm: 'DELETE' }, USER)).toMatchObject({ status: 'DONE' })
    expect(store.deleted).toBe(true)
    expect(await row(root)).toMatchObject({ ...draftShape, platformAttributes: { nexusFamilyId: 'fam' } })
    expect(await row(s)).toMatchObject({ ...draftShape, platformAttributes: { nexusFamilyId: 'fam', inventoryLocationId: 'gid://shopify/Location/1' } })
    expect(await prisma.channelListing.findUnique({ where: { id: root }, select: { platformProductId: true } })).toEqual({ platformProductId: null })
    expect(await prisma.channelListingSnapshot.findFirst({ where: { channelListingId: root, reason: 'delete' } }))
      .toMatchObject({ payload: expect.objectContaining({ evidence: expect.objectContaining({ oldExternalListingId: '9103' }) }) })
  }))

  it('a family split into colour products is refused', () => scoped(async () => {
    const f = await family('SH-LINKED', ['S'])
    await listing(f.root, 'SHOPIFY', 'GLOBAL', ids.shopify, { externalListingId: '9002', platformAttributes: { status: 'ACTIVE' } })
    await listing(f.children.S, 'SHOPIFY', 'GLOBAL', ids.shopify, { externalListingId: '9002' })
    await prisma.shopifyColourProduct.create({ data: { familyId: f.root, channelConnectionId: ids.shopify, splitAxis: 'color', valueKey: 'color:black' } as never })
    for (const action of ['pause', 'delete']) {
      const preview = await previewListingAction(f.root, action, shopifyScope(), USER)
      expect(preview.sendCount).toBe(0)
      expect(preview.rows.every(r => r.plan === 'refused' && /several Shopify products/.test(r.sentence))).toBe(true)
    }
  }))
})

describe('Etsy: pause = Etsy\'s own inactive, resume = active (never quantity 0)', () => {
  it('only while Etsy publishing is live; then inactive + the hold, and active again with the hold lifted and the stock sent', () => scoped(async () => {
    const f = await family('ETSY-P', ['S'])
    const root = await listing(f.root, 'ETSY', 'GLOBAL', ids.etsy, { externalListingId: '123456789' })
    const s = await listing(f.children.S, 'ETSY', 'GLOBAL', ids.etsy, { externalListingId: '123456789' })
    const preview = await previewListingAction(f.root, 'pause', etsyScope(), USER)
    expect(preview).toMatchObject({ model: 'etsy', reach: 'listing', sendCount: 1, consequence: expect.stringMatching(/inactive/) })
    await expect(runListingAction(f.root, 'pause', { previewId: preview.previewId }, USER)).rejects.toMatchObject({ code: 'publish_gated', message: expect.stringMatching(/Etsy publishing is turned off/) })
    vi.stubEnv('NEXUS_ENABLE_ETSY_PUBLISH', 'true'); vi.stubEnv('ETSY_PUBLISH_MODE', 'live')
    try {
      fixture.etsy.mockReset().mockResolvedValue({ sent: true })
      expect(await runListingAction(f.root, 'pause', { previewId: preview.previewId }, USER)).toMatchObject({ status: 'DONE' })
      expect(fixture.etsy).toHaveBeenCalledExactlyOnceWith({ accountId: ids.etsy, listingId: '123456789', change: { state: 'inactive' } })
      for (const id of [root, s]) expect(await row(id)).toMatchObject({ listingStatus: 'INACTIVE', offerClosedAt: expect.any(Date), offerCloseReason: 'sheet-pause' })
      const read = await readListingActionState(f.root, { channel: 'ETSY', market: 'GLOBAL', accountId: ids.etsy })
      expect(read.rows.find(r => r.sku === 'ETSY-P-S')).toMatchObject({ state: 'paused', actions: ['resume'] })

      const resume = await previewListingAction(f.root, 'resume', etsyScope(), USER)
      expect(resume.consequence).toMatch(/renewal fee/)
      fixture.activated.mockClear()
      expect(await runListingAction(f.root, 'resume', { previewId: resume.previewId }, USER)).toMatchObject({ status: 'DONE' })
      expect(fixture.etsy).toHaveBeenLastCalledWith({ accountId: ids.etsy, listingId: '123456789', change: { state: 'active', acceptRenewalAndQuantityReset: true } })
      for (const id of [root, s]) expect(await row(id)).toMatchObject({ listingStatus: 'ACTIVE', offerClosedAt: null })
      expect(fixture.activated).toHaveBeenCalledWith([s])
    } finally { vi.stubEnv('NEXUS_ENABLE_ETSY_PUBLISH', 'false') }
  }))

  it('Delete is not offered on Etsy yet', () => scoped(async () => {
    const f = await family('ETSY-DEL', ['S'])
    await listing(f.children.S, 'ETSY', 'GLOBAL', ids.etsy, { externalListingId: '223456789' })
    const preview = await previewListingAction(f.root, 'delete', etsyScope(), USER)
    expect(preview.sendCount).toBe(0)
    expect(preview.rows.find(r => r.sku === 'ETSY-DEL-S')).toMatchObject({ plan: 'refused', sentence: ETSY_DELETE_NOT_YET })
  }))
})

describe('the one state reader (destinationSellingStates)', () => {
  const at = new Date()
  const base = { externalListingId: '1', listingStatus: 'ACTIVE', isPublished: true, offerClosedAt: null, offerCloseReason: null, offerActive: true, fulfillmentMethod: 'FBM', platformAttributes: {} }
  const products = [{ id: 'p', sku: 'P', isParent: true }, { id: 'a', sku: 'P-A', isParent: false }, { id: 'b', sku: 'P-B', isParent: false, fulfillmentMethod: 'FBA' }]
  it('maps Etsy to its model and reads Shopify per variant', () => {
    const etsy = destinationSellingStates({ familyId: 'p', channel: 'ETSY', products, listings: [{ ...base, id: 'la', productId: 'a' }] })
    expect(etsy.model).toBe('etsy')
    const shopify = destinationSellingStates({ familyId: 'p', channel: 'SHOPIFY', products, listings: [
      { ...base, id: 'lp', productId: 'p', platformAttributes: { status: 'ACTIVE' } },
      { ...base, id: 'la', productId: 'a', offerClosedAt: at, offerCloseReason: 'sheet-pause' },
      { ...base, id: 'lb', productId: 'b' }] })
    expect(Object.fromEntries([...shopify.states].map(([id, s]) => [id, s.state]))).toEqual({ p: 'mixed', a: 'paused', b: 'active' })
    const draft = destinationSellingStates({ familyId: 'p', channel: 'SHOPIFY', products, listings: [
      { ...base, id: 'lp', productId: 'p', platformAttributes: { status: 'DRAFT' } }, { ...base, id: 'la', productId: 'a' }] })
    expect(draft.states.get('p')?.state).toBe('paused')
    const amazon = destinationSellingStates({ familyId: 'p', channel: 'AMAZON', products, listings: [{ ...base, id: 'la', productId: 'a' }, { ...base, id: 'lb', productId: 'b' }] })
    expect([amazon.isFba.get('la'), amazon.isFba.get('lb')]).toEqual([false, true])
  })

  it('delete and relist: a row Nexus deleted reads Not listed (a row not on the channel), its main product too when every variation is; listed again it reads Active', () => {
    const deletion = { at: at.toISOString(), where: 'Amazon · IT', oldReference: 'B0OLD', relistChosenAt: null }
    const draft = { externalListingId: null, listingStatus: 'DRAFT', isPublished: false }
    const listings = [{ ...base, ...draft, id: 'lp', productId: 'p' }, { ...base, ...draft, id: 'la', productId: 'a' }, { ...base, ...draft, id: 'lb', productId: 'b' }]
    const all = destinationSellingStates({ familyId: 'p', channel: 'AMAZON', products, listings, deletions: new Map(['la', 'lb'].map(id => [id, deletion])) })
    expect(all.states.get('a')).toEqual({ state: 'not_listed', reason: deletedStatusReason(deletion), deleted: deletion })
    expect(all.states.get('p')).toEqual({ state: 'not_listed', reason: deletedStatusReason(deletion), deleted: deletion })
    // A main product still on the channel itself reads its variations' delete, but is no row not on the channel.
    const live = destinationSellingStates({ familyId: 'p', channel: 'AMAZON', products, deletions: new Map(['la', 'lb'].map(id => [id, deletion])),
      listings: [{ ...base, id: 'lp', productId: 'p', externalListingId: 'B0PARENT' }, listings[1], listings[2]] })
    expect(live.states.get('p')).toEqual({ state: 'not_listed', reason: deletedStatusReason(deletion) })
    // Without its delete record the same draft reads Draft (never sent).
    expect(destinationSellingStates({ familyId: 'p', channel: 'AMAZON', products, listings }).states.get('a')?.state).toBe('draft')
    // Amazon accepted the relist of A (promoted, ASIN not read back yet): A reads Active by itself; B still reads Not listed.
    const relisted = destinationSellingStates({ familyId: 'p', channel: 'AMAZON', products, deletions: new Map(['la', 'lb'].map(id => [id, deletion])),
      listings: [listings[0], { ...listings[1], listingStatus: 'ACTIVE', isPublished: true }, listings[2]] })
    expect(relisted.states.get('a')).toEqual({ state: 'active', reason: null })
    expect(relisted.states.get('b')?.state).toBe('not_listed')
    expect(relisted.states.get('p')?.deleted ?? null).toBeNull()
  })
})

describe('delete and relist: a row Nexus deleted takes no selling change', () => {
  it('eBay: no Relist or Delete is offered or planned on it (its Status lists it again)', () => scoped(async () => {
    const f = await family('EB-GONE', ['S'])
    const root = await listing(f.root, 'EBAY', 'IT', ids.ebay, { externalListingId: null, listingStatus: 'DRAFT', isPublished: false })
    const s = await listing(f.children.S, 'EBAY', 'IT', ids.ebay, { externalListingId: null, listingStatus: 'DRAFT', isPublished: false })
    const at = new Date(Date.now() - 60_000)
    for (const id of [root, s]) await prisma.channelListingSnapshot.create({ data: { channelListingId: id, channel: 'EBAY', marketplace: 'IT', aliasKey: '', reason: 'delete',
      publishEventId: `gone-${id}`, outcome: 'ACCEPTED', acceptedAt: at, payload: { kind: 'listing-action', evidence: { oldExternalListingId: '888' } } } as never })
    const read = await readListingActionState(f.root, { channel: 'EBAY', market: 'IT', accountId: ids.ebay })
    const reason = deletedStatusReason({ where: 'eBay · IT', at: at.toISOString() })
    expect(read.rows.find(r => r.sku === 'EB-GONE-S')).toMatchObject({ state: 'not_listed', reason, actions: [] })
    for (const [action, plan] of [['relist', 'refused'], ['pause', 'refused'], ['delete', 'skip']] as const) {
      const preview = await previewListingAction(f.root, action, ebayScope(), USER)
      expect(preview.sendCount).toBe(0)
      expect(preview.rows.find(r => r.sku === 'EB-GONE-S')).toMatchObject({ plan, sentence: expect.stringMatching(/^Deleted on eBay · IT on .*set Status to Active\.$/) })
    }
  }))
})

describe('build shape v2 (P13): an eBay listing an OLDER Claude close-listing paused (pinned at 0 + endedAt, no hold)', () => {
  const mark = (id: string, reason: string | null) =>
    prisma.$executeRawUnsafe('UPDATE "ChannelListing" SET "endedAt" = now(), "endedBy" = $2, "endedReason" = $3 WHERE id = $1', id, 'claude', reason)
  const marks = async (id: string) => (await prisma.$queryRawUnsafe<Array<{ endedAt: Date | null }>>('SELECT "endedAt" FROM "ChannelListing" WHERE id = $1', id))[0]
  const stateOf = async (root: string, sku: string) => (await readListingActionState(root, ebayScope().scope)).rows.find(r => r.sku === sku)

  it('reads as before while the database has no presence columns; then reads Inactive, and Resume lifts the pin, clears the mark and sends the stock', () => scoped(async () => {
    const f = await family('EB-OLDCLOSE', ['S', 'M'])
    await listing(f.root, 'EBAY', 'IT', ids.ebay, { externalListingId: '131' })
    const s = await listing(f.children.S, 'EBAY', 'IT', ids.ebay, { externalListingId: '131', followMasterQuantity: false, quantityOverride: 0, quantity: 0 })
    await listing(f.children.M, 'EBAY', 'IT', ids.ebay, { externalListingId: '131' })
    // No presence columns (a database before the migration): a pin at 0 reads as it always did.
    expect(await stateOf(f.root, 'EB-OLDCLOSE-S')).toMatchObject({ state: 'active' })

    await fixture.database.db.exec('ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "endedAt" TIMESTAMP(3), ADD COLUMN IF NOT EXISTS "endedBy" TEXT, ADD COLUMN IF NOT EXISTS "endedReason" TEXT')
    await mark(s, 'too many returns')
    expect(await stateOf(f.root, 'EB-OLDCLOSE-S')).toMatchObject({ state: 'paused', reason: OLD_CLOSE_PAUSE_REASON, actions: ['resume', 'end'] })
    expect(await stateOf(f.root, 'EB-OLDCLOSE')).toMatchObject({ state: 'mixed' })
    const pause = await previewListingAction(f.root, 'pause', { ...ebayScope(), productIds: [f.children.S] }, USER)
    expect(pause.rows.find(r => r.sku === 'EB-OLDCLOSE-S')).toMatchObject({ plan: 'skip', sentence: 'Already inactive.' })

    fixture.activated.mockClear(); fixture.trading.mockReset()
    const resume = await previewListingAction(f.root, 'resume', { ...ebayScope(), productIds: [f.children.S] }, USER)
    expect(resume.rows.find(r => r.sku === 'EB-OLDCLOSE-S')?.plan).toBe('send')
    expect(await runListingAction(f.root, 'resume', { previewId: resume.previewId }, USER))
      .toMatchObject({ status: 'DONE', rows: [{ sku: 'EB-OLDCLOSE-S', outcome: 'DONE', message: expect.stringMatching(/^Pin at 0 lifted/) }] })
    expect(fixture.trading).not.toHaveBeenCalled()
    expect(fixture.activated).toHaveBeenCalledWith([s])
    expect(await prisma.channelListing.findUnique({ where: { id: s }, select: { followMasterQuantity: true, quantityOverride: true, offerClosedAt: true } }))
      .toEqual({ followMasterQuantity: true, quantityOverride: null, offerClosedAt: null })
    expect(await marks(s)).toEqual({ endedAt: null })
    expect(await stateOf(f.root, 'EB-OLDCLOSE-S')).toMatchObject({ state: 'active' })
  }))

  it('is not a pin at 0 without the mark (Zero & Pin), a channel-file delete, another channel, or a pin someone changed', () => scoped(async () => {
    await fixture.database.db.exec('ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "endedAt" TIMESTAMP(3), ADD COLUMN IF NOT EXISTS "endedBy" TEXT, ADD COLUMN IF NOT EXISTS "endedReason" TEXT')
    const f = await family('EB-NOTOLD', ['A', 'B', 'C'])
    const pinned = { followMasterQuantity: false, quantityOverride: 0, quantity: 0 }
    await listing(f.children.A, 'EBAY', 'IT', ids.ebay, { externalListingId: '141', ...pinned })
    const b = await listing(f.children.B, 'EBAY', 'IT', ids.ebay, { externalListingId: '141', ...pinned })
    const c = await listing(f.children.C, 'EBAY', 'IT', ids.ebay, { externalListingId: '141', followMasterQuantity: false, quantityOverride: 4, quantity: 4 })
    await mark(b, 'channel-file-delete')
    await mark(c, null)
    const rows = (await readListingActionState(f.root, ebayScope().scope)).rows
    expect(Object.fromEntries(rows.filter(r => !r.isParent).map(r => [r.sku, r.state]))).toEqual({ 'EB-NOTOLD-A': 'active', 'EB-NOTOLD-B': 'active', 'EB-NOTOLD-C': 'active' })
    // The same marks on Amazon are not this rule (an Amazon close reads from its own hold).
    const g = await family('AM-NOTOLD', ['A'])
    const a = await listing(g.children.A, 'AMAZON', 'IT', ids.amazon, pinned)
    await mark(a, null)
    expect((await readListingActionState(g.root, amazonScope().scope)).rows.find(r => r.sku === 'AM-NOTOLD-A')).toMatchObject({ state: 'active' })
  }))
})

describe('permissions', () => {
  it('registers one literal path per action, so ending and deleting resolve to products.delete', async () => {
    const { default: Fastify } = await import('fastify')
    const { default: routes } = await import('../../routes/listing-actions.routes.js')
    const app = Fastify()
    const registered: Array<[string, string]> = []
    app.addHook('onRoute', route => { for (const method of [route.method].flat()) if (method !== 'HEAD') registered.push([method, route.url]) })
    await app.register(routes, { prefix: '/api' })
    await app.ready()
    const base = '/api/products/:id/listing-actions'
    const expected: Record<string, string> = { [`GET ${base}/state`]: 'products.view' }
    for (const [action, permission] of [['pause', 'products.publish'], ['resume', 'products.publish'], ['end', 'products.delete'], ['relist', 'products.publish'], ['delete', 'products.delete']]) {
      expected[`POST ${base}/${action}/preview`] = permission
      expected[`POST ${base}/${action}/run`] = permission
    }
    expect(Object.fromEntries(registered.map(([method, url]) => [`${method} ${url}`, permissionForRoute(method, url)]))).toEqual(expected)
    await app.close()
  })
})

/**
 * S3/S4 — an eBay alias SKU was never sent (eBay publish built from Product.sku), so an extra listing with no confirmed
 * SKU still acts as its product SKU. S4 — eBay rows act on the SKU eBay holds (below); S5 — Shopify and Etsy too (below).
 */
describe('S3 — eBay rows keep acting on Product.sku (parity)', () => {
  it('eBay (Trading): an extra listing with its own recorded SKU still acts as the product SKU', () => scoped(async () => {
    const product = (await prisma.product.create({ data: { sku: 'EB-S3', name: 'EB-S3', basePrice: 10, fulfillmentMethod: 'FBM' } as never })).id
    const alias = await prisma.productListingAlias.create({ data: { productId: product, channel: 'EBAY', marketplace: 'IT', channelConnectionId: ids.ebay, label: 'Second', position: 1, sku: 'EB-S3-ALIAS' } })
    const s = await listing(product, 'EBAY', 'IT', ids.ebay, { externalListingId: '931', aliasId: alias.id, aliasKey: alias.id })
    const scope = { scope: { channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay, aliasKey: alias.id } }
    // A single-SKU item is paused whole (the hard-delete unpublish's own calls).
    fixture.unpublish.mockReset().mockResolvedValue({ success: true, outcome: 'SUCCESS', evidence: { zeroed: ['931'] } })
    const preview = await previewListingAction(product, 'pause', scope, USER)
    expect(preview.rows).toEqual([expect.objectContaining({ sku: 'EB-S3', plan: 'send' })])
    const result = await runListingAction(product, 'pause', { previewId: preview.previewId }, USER)
    expect(result, JSON.stringify(result.rows)).toMatchObject({ status: 'DONE', rows: [{ sku: 'EB-S3', outcome: 'DONE' }] })
    expect(JSON.stringify(result)).not.toContain('EB-S3-ALIAS')
    expect(await prisma.channelListingSnapshot.findFirst({ where: { channelListingId: s, reason: 'pause' } })).toMatchObject({ payload: expect.objectContaining({ sku: 'EB-S3' }) })
    expect(await row(s)).toMatchObject({ offerClosedAt: expect.any(Date) })
  }))
})

/**
 * S4 (per-channel SKU) — every eBay row is acted on under the SKU eBay HOLDS for it (`listingSendSku`): its own confirmed
 * SKU, else the product SKU (parity). A wanted SKU eBay has not confirmed is never named, and another account's row with
 * its own SKU is never involved.
 */
describe('S4 (per-channel SKU) — every eBay row is acted on under the SKU eBay holds for it', () => {
  it('Trading pause: an own confirmed SKU is set to 0 under that SKU; a wanted-only SKU and a plain row under the product SKU', () => scoped(async () => {
    const f = await family('EB-OWN', ['S', 'M', 'L'])
    await listing(f.root, 'EBAY', 'IT', ids.ebay, { externalListingId: '121' })
    const s = await listing(f.children.S, 'EBAY', 'IT', ids.ebay, { externalListingId: '121', channelSku: 'OWN-S-IT', liveChannelSku: 'OWN-S-IT' })
    const m = await listing(f.children.M, 'EBAY', 'IT', ids.ebay, { externalListingId: '121', channelSku: 'WANT-M-IT' })
    await listing(f.children.L, 'EBAY', 'IT', ids.ebay, { externalListingId: '121' })
    const other = await listing(f.children.S, 'EBAY', 'IT', ids.ebay2, { externalListingId: '122', liveChannelSku: 'OTHER-ACCOUNT-S' })
    fixture.trading.mockReset().mockImplementation(async (call: string) => call === 'GetItem'
      ? getItem('true', [['OWN-S-IT', 3], ['EB-OWN-M', 2], ['EB-OWN-L', 1]]) : { ack: 'Success', raw: '' })
    const preview = await previewListingAction(f.root, 'pause', { ...ebayScope(), productIds: [f.children.S, f.children.M] }, USER)
    // The plan rows still name the products (the sheet's rows).
    expect(preview.rows.filter(r => r.plan === 'send').map(r => r.sku).sort()).toEqual(['EB-OWN-M', 'EB-OWN-S'])
    const result = await runListingAction(f.root, 'pause', { previewId: preview.previewId }, USER)
    expect(result, JSON.stringify(result.rows)).toMatchObject({ status: 'DONE' })
    expect(fixture.trading.mock.calls.map(c => c[0])).toEqual(['GetItem', 'ReviseInventoryStatus'])
    const xml = String(fixture.trading.mock.calls[1][1])
    expect(xml).toContain('<SKU>OWN-S-IT</SKU>')
    expect(xml).toContain('<SKU>EB-OWN-M</SKU>')
    for (const absent of ['EB-OWN-S<', 'WANT-M-IT', 'EB-OWN-L', 'OTHER-ACCOUNT-S']) expect(xml).not.toContain(absent)
    for (const id of [s, m]) expect(await row(id)).toMatchObject({ offerClosedAt: expect.any(Date) })
    expect(await row(other)).toMatchObject({ offerClosedAt: null })
    // The audit names the SKU eBay was sent.
    expect(await prisma.channelListingSnapshot.findFirst({ where: { channelListingId: s, reason: 'pause' } })).toMatchObject({ payload: expect.objectContaining({ sku: 'OWN-S-IT' }) })
  }))

  it('Inventory delete: each offer is read by the SKU eBay holds; the group is withdrawn under the main row\'s SKU (the product SKU without one)', () => scoped(async () => {
    const calls: Array<{ method: string; path: string; sku: string | null; body: any }> = []
    fixture.ebaySend.mockReset().mockImplementation(async (_account: string, url: string, init: RequestInit = {}) => {
      const u = new URL(url)
      calls.push({ method: init.method ?? 'GET', path: u.pathname, sku: u.searchParams.get('sku'), body: typeof init.body === 'string' ? JSON.parse(init.body) : null })
      if (init.method === 'DELETE') return new Response(null, { status: 204 })
      if (u.pathname.endsWith('/offer') && u.searchParams.get('sku')) {
        return new Response(JSON.stringify({ offers: [{ offerId: `OFF-${u.searchParams.get('sku')}`, marketplaceId: 'EBAY_IT', format: 'FIXED_PRICE' }] }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    const withdrawKey = () => calls.find(c => c.path.endsWith('withdraw_by_inventory_item_group'))?.body?.inventoryItemGroupKey

    const own = await family('EBI-OWN', ['S', 'M'])
    await listing(own.root, 'EBAY', 'IT', ids.ebay, { externalListingId: '991', channelSku: 'GRP-OWN', liveChannelSku: 'GRP-OWN' })
    await listing(own.children.S, 'EBAY', 'IT', ids.ebay, { externalListingId: '991', liveChannelSku: 'OWN-S-IT' })
    await listing(own.children.M, 'EBAY', 'IT', ids.ebay, { externalListingId: '991', channelSku: 'WANT-M-IT', platformAttributes: { __offerIds: { EBAY_DE: 'OFF-M-DE' } } })
    let preview = await previewListingAction(own.root, 'delete', ebayScope(), USER)
    expect(preview).toMatchObject({ model: 'ebay-inventory' })
    expect(await runListingAction(own.root, 'delete', { previewId: preview.previewId, confirm: 'DELETE' }, USER)).toMatchObject({ status: 'DONE' })
    expect(withdrawKey()).toBe('GRP-OWN')
    expect(calls.filter(c => c.sku).map(c => c.sku).sort()).toEqual(['EBI-OWN-M', 'OWN-S-IT'])
    expect(calls.filter(c => c.method === 'DELETE').map(c => c.path).sort()).toEqual(['/sell/inventory/v1/offer/OFF-EBI-OWN-M', '/sell/inventory/v1/offer/OFF-OWN-S-IT'])

    calls.length = 0
    const plain = await family('EBI-PLAIN', ['S'])
    await listing(plain.root, 'EBAY', 'IT', ids.ebay, { externalListingId: '992' })
    await listing(plain.children.S, 'EBAY', 'IT', ids.ebay, { externalListingId: '992', platformAttributes: { __offerIds: { EBAY_IT: 'OFF-PLAIN-S' } } })
    preview = await previewListingAction(plain.root, 'delete', ebayScope(), USER)
    expect(await runListingAction(plain.root, 'delete', { previewId: preview.previewId, confirm: 'DELETE' }, USER)).toMatchObject({ status: 'DONE' })
    expect(withdrawKey()).toBe('EBI-PLAIN')
  }))

  it('Inventory pause: the bulk quantity update names the SKU eBay holds', () => scoped(async () => {
    const f = await family('EBI-PAUSE', ['S'])
    await listing(f.root, 'EBAY', 'IT', ids.ebay, { externalListingId: '993' })
    await listing(f.children.S, 'EBAY', 'IT', ids.ebay, { externalListingId: '993', liveChannelSku: 'OWN-PAUSE-S', platformAttributes: { __offerIds: { EBAY_IT: 'OFF-P-S' } } })
    fixture.preference.mockReset().mockResolvedValue('ON')
    const bodies: any[] = []
    fixture.ebaySend.mockReset().mockImplementation(async (_account: string, url: string, init: RequestInit = {}) => {
      if (url.includes('bulk_update_price_quantity')) {
        const body = JSON.parse(String(init.body)); bodies.push(body)
        return new Response(JSON.stringify({ responses: body.requests.map((r: any) => ({ sku: r.sku, statusCode: 200 })) }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    const preview = await previewListingAction(f.root, 'pause', { ...ebayScope(), productIds: [f.children.S] }, USER)
    const result = await runListingAction(f.root, 'pause', { previewId: preview.previewId }, USER)
    expect(result, JSON.stringify(result.rows)).toMatchObject({ status: 'DONE', rows: [{ sku: 'OWN-PAUSE-S', outcome: 'DONE' }] })
    expect(bodies).toEqual([{ requests: [{ sku: 'OWN-PAUSE-S', offers: [{ offerId: 'OFF-P-S', availableQuantity: 0 }] }] }])
  }))
})

/**
 * S5 — Shopify and Etsy rows carry the SKU the channel holds for them (`listingSendSku`): the confirmed `liveChannelSku`,
 * else the product SKU. A Shopify old store — the sheet's SKU column (`platformAttributes.sku`) or an older edit in the
 * override bag (`overrideData.listing_sku`) — is a wanted value that may never have been sent: never what an action
 * looks for, so it never blocks one.
 */
describe('S5 — Shopify and Etsy rows act on the SKU the channel holds', () => {
  it('parity: an edit only in the override bag (never sent) — paused under the product SKU, exactly as before', () => scoped(async () => {
    const f = await family('SH-S5P', ['S'])
    await listing(f.root, 'SHOPIFY', 'GLOBAL', ids.shopify, { externalListingId: '9301', platformAttributes: { status: 'ACTIVE' } })
    const s = await listing(f.children.S, 'SHOPIFY', 'GLOBAL', ids.shopify, { externalListingId: '9301',
      platformAttributes: variantAttrs('9301', '31'), overrideData: { listing_sku: 'SH-S5P-UNSENT' } })
    const preview = await previewListingAction(f.root, 'pause', shopifyScope(), USER)
    expect(preview.rows.find(r => r.sku === 'SH-S5P-S')).toMatchObject({ plan: 'send' })
    const store = shopifyStore('9301', [{ id: '31', sku: 'SH-S5P-S', policy: 'DENY', qty: 4 }])
    const result = await runListingAction(f.root, 'pause', { previewId: preview.previewId }, USER)
    expect(result.rows.find(r => r.productId === f.children.S)).toMatchObject({ sku: 'SH-S5P-S', outcome: 'DONE' })
    expect(store.sets).toEqual([expect.objectContaining({ inventoryItemId: 'gid://shopify/InventoryItem/310', quantity: 0 })])
    expect(JSON.stringify(result)).not.toContain('SH-S5P-UNSENT')
    expect(await row(s)).toMatchObject({ offerClosedAt: expect.any(Date) })
  }))

  it('an unsent sheet SKU (the native SKU column) does not block Pause: the variant, still under its product SKU, is paused', () => scoped(async () => {
    const f = await family('SH-S5N', ['S'])
    await listing(f.root, 'SHOPIFY', 'GLOBAL', ids.shopify, { externalListingId: '9302', platformAttributes: { status: 'ACTIVE' } })
    const s = await listing(f.children.S, 'SHOPIFY', 'GLOBAL', ids.shopify, { externalListingId: '9302',
      platformAttributes: { ...variantAttrs('9302', '32'), sku: 'SH-S5N-NEXT' } })
    const preview = await previewListingAction(f.root, 'pause', shopifyScope(), USER)
    const store = shopifyStore('9302', [{ id: '32', sku: 'SH-S5N-S', policy: 'DENY', qty: 6 }])
    const result = await runListingAction(f.root, 'pause', { previewId: preview.previewId }, USER)
    expect(result.rows.find(r => r.productId === f.children.S)).toMatchObject({ sku: 'SH-S5N-S', outcome: 'DONE' })
    expect(store.sets).toEqual([expect.objectContaining({ inventoryItemId: 'gid://shopify/InventoryItem/320', quantity: 0, changeFromQuantity: 6 })])
    expect(await row(s)).toMatchObject({ offerClosedAt: expect.any(Date) })
  }))

  it('🔴 no stored variant id and an unsent sheet SKU naming ANOTHER variant: looked up by the product SKU; the other variant is never written', () => scoped(async () => {
    const f = await family('SH-S5X', ['S'])
    await listing(f.root, 'SHOPIFY', 'GLOBAL', ids.shopify, { externalListingId: '9305', platformAttributes: { status: 'ACTIVE' } })
    await listing(f.children.S, 'SHOPIFY', 'GLOBAL', ids.shopify, { externalListingId: '9305',
      platformAttributes: { nexusFamilyId: 'fam', inventoryLocationId: 'gid://shopify/Location/1', sku: 'SH-S5X-OTHER' } })
    const preview = await previewListingAction(f.root, 'pause', shopifyScope(), USER)
    const store = shopifyStore('9305', [{ id: '36', sku: 'SH-S5X-S', policy: 'DENY', qty: 4 }, { id: '37', sku: 'SH-S5X-OTHER', policy: 'DENY', qty: 8 }])
    const result = await runListingAction(f.root, 'pause', { previewId: preview.previewId }, USER)
    expect(result.rows.find(r => r.productId === f.children.S)).toMatchObject({ sku: 'SH-S5X-S', outcome: 'DONE' })
    expect(store.sets).toEqual([expect.objectContaining({ inventoryItemId: 'gid://shopify/InventoryItem/360', quantity: 0, changeFromQuantity: 4 })])
    expect(store.qty.get('37')).toBe(8)
  }))

  it('own SKU confirmed (liveChannelSku) and no stored variant id: the variant is found by that SKU, never the product SKU', () => scoped(async () => {
    const f = await family('SH-S5L', ['S'])
    await listing(f.root, 'SHOPIFY', 'GLOBAL', ids.shopify, { externalListingId: '9303', platformAttributes: { status: 'ACTIVE' } })
    await listing(f.children.S, 'SHOPIFY', 'GLOBAL', ids.shopify, { externalListingId: '9303', liveChannelSku: 'SH-S5L-LIVE', channelSku: 'SH-S5L-WANT',
      platformAttributes: { nexusFamilyId: 'fam', inventoryLocationId: 'gid://shopify/Location/1' } })
    const preview = await previewListingAction(f.root, 'pause', shopifyScope(), USER)
    // Shopify also holds a variant under the product SKU: it is not this listing's and is never touched.
    const store = shopifyStore('9303', [{ id: '33', sku: 'SH-S5L-S', policy: 'DENY', qty: 9 }, { id: '34', sku: 'SH-S5L-LIVE', policy: 'DENY', qty: 2 }])
    const result = await runListingAction(f.root, 'pause', { previewId: preview.previewId }, USER)
    expect(result.rows.find(r => r.productId === f.children.S)).toMatchObject({ sku: 'SH-S5L-LIVE', outcome: 'DONE' })
    expect(store.sets).toEqual([expect.objectContaining({ inventoryItemId: 'gid://shopify/InventoryItem/340', quantity: 0, changeFromQuantity: 2 })])
    expect(store.qty.get('33')).toBe(9)
  }))

  it('an extra listing whose own SKU disagrees with the native one is not refused: neither is what Shopify holds (the product SKU)', () => scoped(async () => {
    // One product (no variations): its extra listing's own SKU belongs to it (the alias's main row).
    const f = await family('SH-S5C', [])
    const alias = await prisma.productListingAlias.create({ data: { productId: f.root, channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: ids.shopify, label: 'Second', position: 1, sku: 'SH-S5C-AL' } })
    await listing(f.root, 'SHOPIFY', 'GLOBAL', ids.shopify, { aliasKey: alias.id, aliasId: alias.id, externalListingId: '9304',
      platformAttributes: { ...variantAttrs('9304', '35'), sku: 'SH-S5C-NATIVE' } })
    const scope = { scope: { channel: 'SHOPIFY', marketplace: 'GLOBAL', accountId: ids.shopify, aliasKey: alias.id } }
    const pause = await previewListingAction(f.root, 'pause', scope, USER)
    expect(pause.rows.find(r => r.productId === f.root)).toMatchObject({ plan: 'send' })
    const store = shopifyStore('9304', [{ id: '35', sku: 'SH-S5C', policy: 'DENY', qty: 3 }])
    const result = await runListingAction(f.root, 'pause', { previewId: pause.previewId }, USER)
    expect(result.rows.find(r => r.productId === f.root)).toMatchObject({ sku: 'SH-S5C', outcome: 'DONE' })
    expect(store.sets).toEqual([expect.objectContaining({ quantity: 0, changeFromQuantity: 3 })])
  }))

  it('Etsy: the row names the SKU Etsy holds (its own, confirmed); the listing state change itself names none', () => scoped(async () => {
    const f = await family('ETSY-S5', ['S'])
    await listing(f.root, 'ETSY', 'GLOBAL', ids.etsy, { externalListingId: '323456789' })
    await listing(f.children.S, 'ETSY', 'GLOBAL', ids.etsy, { externalListingId: '323456789', liveChannelSku: 'ETSY-S5-OWN' })
    const preview = await previewListingAction(f.root, 'pause', etsyScope(), USER)
    vi.stubEnv('NEXUS_ENABLE_ETSY_PUBLISH', 'true'); vi.stubEnv('ETSY_PUBLISH_MODE', 'live')
    try {
      fixture.etsy.mockReset().mockResolvedValue({ sent: true })
      const result = await runListingAction(f.root, 'pause', { previewId: preview.previewId }, USER)
      expect(result.rows.find(r => r.productId === f.children.S)).toMatchObject({ sku: 'ETSY-S5-OWN', outcome: 'DONE' })
      expect(fixture.etsy).toHaveBeenCalledExactlyOnceWith({ accountId: ids.etsy, listingId: '323456789', change: { state: 'inactive' } })
    } finally { vi.stubEnv('NEXUS_ENABLE_ETSY_PUBLISH', 'false') }
  }))
})
