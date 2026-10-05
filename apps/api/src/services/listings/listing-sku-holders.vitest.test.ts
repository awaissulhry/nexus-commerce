/**
 * S8 — which listings answer to a channel SKU, on real PostgreSQL (PGlite: production schema and row-level security):
 * the wide store lookup (`listingsThatMayHoldSkus`, channel-sku.ts) and the resolver's precise answer for SKUs that
 * arrive without a listing; and the two per-write guards — the wrong-account write guard and the push-lock lookup —
 * which match a listing's own SKU on the indexed columns only (`channelSku` / `liveChannelSku`). Each with parity (a
 * listing without its own SKU is found as before), its own SKU (per market), another business never involved, and
 * conflicts reported.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { readPushControls } from '../listing-push-controls.js'
import { assertWriteAccount, assertWriteAccountPerSku, WrongAccountWriteError } from '../write-account-guard.js'
import { listingsThatMayHoldSkus } from './channel-sku.js'
import { listingAccounts, listingAnswersToSku, listingsAnsweringToSkus, productForChannelSkuOnAccounts } from './listing-sku-holders.js'

const OTHER_BUSINESS = 'skurows-holders-other'
const as = (workspaceId: string) => <T>(work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const scoped = as(LEGACY_WORKSPACE_ID)
const other = as(OTHER_BUSINESS)

const acc = { a: '', b: '', ebay: '', shopify: '', foreign: '' }
const pid: Record<string, string> = {}
const lid: Record<string, string> = {}

async function product(sku: string, data: Record<string, unknown> = {}) {
  pid[sku] = (await prisma.product.create({ data: { sku, name: sku, basePrice: 10, ...data } as never })).id
}
async function listing(name: string, productSku: string, seed: { channel?: string; marketplace?: string; account?: string | null; data?: Record<string, unknown>; offers?: Array<{ sku: string; isActive: boolean; method?: 'FBA' | 'FBM' }> } = {}) {
  const channel = seed.channel ?? 'AMAZON'
  const marketplace = seed.marketplace ?? 'IT'
  const row = await prisma.channelListing.create({ data: {
    productId: pid[productSku], channel, marketplace, region: marketplace, channelMarket: `${channel}_${marketplace}`,
    channelConnectionId: seed.account === undefined ? acc.a : seed.account, aliasKey: '', listingStatus: 'ACTIVE', isPublished: true,
    ...seed.data,
  } as never })
  for (const o of seed.offers ?? []) await prisma.offer.create({ data: { channelListingId: row.id, sku: o.sku, fulfillmentMethod: o.method ?? 'FBM', isActive: o.isActive } })
  lid[name] = row.id
}
const connection = (channelType: string, label: string) => prisma.channelConnection.create({ data: { channelType, accountLabel: label, displayName: label, externalAccountId: label, isActive: true, isPrimary: false } as never }).then(c => c.id)

beforeAll(async () => {
  await scoped(async () => {
    acc.a = await connection('AMAZON', 'holders-amazon-a')
    acc.b = await connection('AMAZON', 'holders-amazon-b')
    acc.ebay = await connection('EBAY', 'holders-ebay')
    acc.shopify = await connection('SHOPIFY', 'holders-shopify')
    await product('H-PLAIN'); await listing('plain', 'H-PLAIN')
    // Its own SKU in IT (confirmed by Amazon); DE follows the product SKU.
    await product('H-OWN')
    await listing('ownIT', 'H-OWN', { account: acc.b, data: { channelSku: 'H-OWN-IT', liveChannelSku: 'H-OWN-IT' } })
    await listing('ownDE', 'H-OWN', { account: acc.b, marketplace: 'DE' })
    // Renamed in Nexus, not published yet: Nexus sends NEW, Amazon still holds the product SKU.
    await product('H-RENAMED'); await listing('renamed', 'H-RENAMED', { data: { channelSku: 'H-RENAMED-NEW' } })
    // Only the confirmed column set (as a pull or the backfill would leave it), on account B.
    await product('H-LIVEONLY'); await listing('liveOnly', 'H-LIVEONLY', { account: acc.b, data: { liveChannelSku: 'H-LIVE-ONLY' } })
    await product('H-OFFER'); await listing('offer', 'H-OFFER', { offers: [{ sku: 'H-OFFER-FBA', isActive: true, method: 'FBA' }, { sku: 'H-OLD', isActive: false }] })
    await product('H-ATTR'); await listing('attr', 'H-ATTR', { data: { platformAttributes: { seller_sku: ' H-ATTR-SKU ' } } })
    await product('H-FF'); await listing('ff', 'H-FF', { data: { flatFileSnapshot: { item_sku: 'H-FF-SKU' } } })
    // Two SKUs on record for one listing: a conflict.
    await product('H-TWO'); await listing('two', 'H-TWO', { data: { platformAttributes: { seller_sku: 'H-TWO-A' } }, offers: [{ sku: 'H-TWO-B', isActive: true }] })
    await product('H-EBAY', { isParent: true })
    const alias = await prisma.productListingAlias.create({ data: { productId: pid['H-EBAY'], channel: 'EBAY', marketplace: 'IT', channelConnectionId: acc.ebay, label: 'Second', position: 1, sku: 'H-EBAY-ALIAS' } })
    await listing('ebayAlias', 'H-EBAY', { channel: 'EBAY', account: acc.ebay, data: { aliasId: alias.id, aliasKey: alias.id } })
    await product('H-SHOP'); await listing('shop', 'H-SHOP', { channel: 'SHOPIFY', marketplace: 'GLOBAL', account: acc.shopify, data: { platformAttributes: { sku: 'H-SHOP-NATIVE' } } })
    await product('H-GONE', { deletedAt: new Date() }); await listing('gone', 'H-GONE', { data: { channelSku: 'H-GONE-SKU' } })
    // The push lock: a paused listing found only by its own SKU.
    await product('H-LOCK'); await listing('lock', 'H-LOCK', { data: { channelSku: 'H-LOCK-IT', liveChannelSku: 'H-LOCK-IT', syncPaused: true } })
    // One SKU, two products, two accounts: ambiguous when the account is not known.
    await product('H-AMB-1'); await listing('amb1', 'H-AMB-1', { data: { channelSku: 'AMB-SKU', liveChannelSku: 'AMB-SKU' } })
    await product('H-AMB-2'); await listing('amb2', 'H-AMB-2', { account: acc.b, data: { channelSku: 'AMB-SKU', liveChannelSku: 'AMB-SKU' } })
  })
  await prisma.workspace.create({ data: { id: OTHER_BUSINESS, name: 'Other business', createdByUserId: 'skurows', creationKey: 'skurows-holders-other' } as never })
  await other(async () => {
    acc.foreign = await connection('AMAZON', 'holders-foreign-amazon')
    await product('F-1'); await listing('foreign', 'F-1', { account: acc.foreign, data: { channelSku: 'H-OWN-IT', liveChannelSku: 'H-OWN-IT' } })
    await product('F-2'); await listing('foreignOnly', 'F-2', { account: acc.foreign, data: { channelSku: 'FOREIGN-ONLY' } })
  })
}, 120_000)
afterAll(async () => { await state.db?.close() })

const held = (skus: string[], channel = 'AMAZON', marketplace?: string) =>
  scoped(() => listingsThatMayHoldSkus(prisma, { skus, channel, marketplace })).then(rows => rows.map(r => `${r.sku}>${Object.keys(lid).find(k => lid[k] === r.listingId)}`).sort())

describe('listingsThatMayHoldSkus (channel-sku.ts) — every store, every account, one business, filtered in SQL', () => {
  it('finds each store: own SKU, confirmed SKU, offers (inactive too), Amazon mirror keys (trimmed), flat-file snapshot', async () => {
    expect(await held(['H-OWN-IT', 'H-RENAMED-NEW', 'H-OFFER-FBA', 'H-OLD', 'H-ATTR-SKU', 'H-FF-SKU'])).toEqual(
      ['H-ATTR-SKU>attr', 'H-FF-SKU>ff', 'H-OFFER-FBA>offer', 'H-OLD>offer', 'H-OWN-IT>ownIT', 'H-RENAMED-NEW>renamed'])
  })
  it('an extra listing\'s own SKU (eBay) and Shopify\'s native SKU, on their channels only', async () => {
    expect(await held(['H-EBAY-ALIAS'], 'EBAY')).toEqual(['H-EBAY-ALIAS>ebayAlias'])
    expect(await held(['H-SHOP-NATIVE'], 'SHOPIFY')).toEqual(['H-SHOP-NATIVE>shop'])
    expect(await held(['H-EBAY-ALIAS', 'H-SHOP-NATIVE'])).toEqual([])
  })
  it('per market: the IT listing\'s own SKU is not the DE listing\'s; the market reads marketplace or region', async () => {
    expect(await held(['H-OWN-IT'], 'AMAZON', 'IT')).toEqual(['H-OWN-IT>ownIT'])
    expect(await held(['H-OWN-IT'], 'AMAZON', 'DE')).toEqual([])
  })
  it('the product SKU alone is the caller\'s match, not this lookup\'s; a trashed product\'s listing is left out', async () => {
    expect(await held(['H-PLAIN', 'H-GONE-SKU'])).toEqual([])
  })
  it('one account only, when named (the single-SKU form productForChannelSku and setChannelSku read)', async () => {
    expect((await scoped(() => listingsThatMayHoldSkus(prisma, { skus: ['AMB-SKU'], channel: 'AMAZON', connectionId: acc.b }))).map(r => r.listingId)).toEqual([lid.amb2])
  })
  it('another business\'s listings are never read, even with the same SKU', async () => {
    expect(await held(['H-OWN-IT', 'FOREIGN-ONLY'])).toEqual(['H-OWN-IT>ownIT'])
    expect(await other(() => listingsThatMayHoldSkus(prisma, { skus: ['H-OWN-IT'], channel: 'AMAZON' })).then(r => r.map(x => x.listingId))).toEqual([lid.foreign])
  })
})

describe('listingsAnsweringToSkus / listingAnswersToSku — the resolver decides', () => {
  const answering = (skus: string[], extra: { marketplace?: string; channelConnectionIds?: string[] } = {}) =>
    scoped(() => listingsAnsweringToSkus(prisma, { skus, channel: 'AMAZON', ...extra }))
      .then(map => Object.fromEntries([...map].map(([sku, rows]) => [sku, rows.map(r => Object.keys(lid).find(k => lid[k] === r.id))])))
  it('the SKU Nexus sends or the channel holds; an inactive offer is neither', async () => {
    expect(await answering(['H-OWN-IT', 'H-RENAMED-NEW', 'H-OFFER-FBA', 'H-OLD'])).toEqual({ 'H-OWN-IT': ['ownIT'], 'H-RENAMED-NEW': ['renamed'], 'H-OFFER-FBA': ['offer'] })
  })
  it('a listing with two SKUs on record answers to each of them (a report about one is about this listing)', async () => {
    expect(await answering(['H-TWO-A', 'H-TWO-B'])).toEqual({ 'H-TWO-A': ['two'], 'H-TWO-B': ['two'] })
  })
  it('narrowed to accounts', async () => {
    expect(await answering(['H-OWN-IT', 'AMB-SKU'], { channelConnectionIds: [acc.a] })).toEqual({ 'AMB-SKU': ['amb1'] })
  })
  it('pure: a renamed listing answers to the new SKU (sent) and the product SKU (still held); a confirmed one no longer to the product SKU', () => {
    const renamed = { channel: 'AMAZON', aliasKey: '', channelSku: 'NEW', listingStatus: 'ACTIVE', isPublished: true }
    expect([listingAnswersToSku(renamed, 'P1', 'NEW'), listingAnswersToSku(renamed, 'P1', 'P1')]).toEqual([true, true])
    const moved = { ...renamed, liveChannelSku: 'NEW' }
    expect([listingAnswersToSku(moved, 'P1', 'NEW'), listingAnswersToSku(moved, 'P1', 'P1')]).toEqual([true, false])
    // A still-draft listing holds nothing on the channel: only what it would send.
    const draft = { channel: 'AMAZON', aliasKey: '', listingStatus: 'DRAFT', isPublished: false, externalListingId: null }
    expect([listingAnswersToSku(draft, 'P1', 'P1'), listingAnswersToSku(draft, 'P1', 'X')]).toEqual([true, false])
  })
})

describe('productForChannelSkuOnAccounts — a SKU that arrives without its account', () => {
  it('lists the accounts this business sells on there, then matches one product (and where)', async () => {
    const accounts = await scoped(() => listingAccounts(prisma, { channel: 'AMAZON', marketplace: 'IT' }))
    expect([...accounts].sort()).toEqual([acc.a, acc.b].sort())
    expect(await scoped(() => productForChannelSkuOnAccounts(prisma, { channel: 'AMAZON', sku: 'H-OWN-IT', marketplace: 'IT', connectionIds: accounts })))
      .toEqual({ productId: pid['H-OWN'], connectionIds: [acc.b] })
    // Parity: a product SKU still names its product.
    expect(await scoped(() => productForChannelSkuOnAccounts(prisma, { channel: 'AMAZON', sku: 'H-PLAIN', marketplace: 'IT', connectionIds: accounts })))
      .toMatchObject({ productId: pid['H-PLAIN'] })
  })
  it('two products on two accounts: ambiguous, never a pick; nothing known: null', async () => {
    const connectionIds = [acc.a, acc.b]
    expect(await scoped(() => productForChannelSkuOnAccounts(prisma, { channel: 'AMAZON', sku: 'AMB-SKU', marketplace: 'IT', connectionIds })))
      .toEqual({ ambiguous: true, productIds: [pid['H-AMB-1'], pid['H-AMB-2']].sort() })
    expect(await scoped(() => productForChannelSkuOnAccounts(prisma, { channel: 'AMAZON', sku: 'FOREIGN-ONLY', marketplace: 'IT', connectionIds }))).toBeNull()
  })
})

describe('the wrong-account write guard reads a listing\'s own SKU', () => {
  it('a write naming a listing\'s own SKU through another account is refused (it passed silently before S8)', async () => {
    const refusal = await scoped(() => assertWriteAccount('AMAZON', acc.a, { skus: ['H-OWN-IT'], marketplace: 'IT' })).catch(e => e)
    expect(refusal).toBeInstanceOf(WrongAccountWriteError)
    expect(refusal.detail.ownerConnectionIds).toEqual([acc.b])
    await expect(scoped(() => assertWriteAccount('AMAZON', acc.b, { skus: ['H-OWN-IT'], marketplace: 'IT' }))).resolves.toBeUndefined()
  })
  it('parity: a product SKU is checked as before', async () => {
    await expect(scoped(() => assertWriteAccount('AMAZON', acc.a, { skus: ['H-PLAIN'] }))).resolves.toBeUndefined()
    await expect(scoped(() => assertWriteAccount('AMAZON', acc.b, { skus: ['H-PLAIN'] }))).rejects.toBeInstanceOf(WrongAccountWriteError)
  })
  it('the batch form names the own SKU of another account', async () => {
    const refusal = await scoped(() => assertWriteAccountPerSku('AMAZON', acc.a, ['H-PLAIN', 'H-OWN-IT'], 'IT')).catch(e => e)
    expect(refusal).toBeInstanceOf(WrongAccountWriteError)
    expect(refusal.message).toContain('SKU H-OWN-IT belong to the Amazon account')
  })
  it('found by channelSku alone and by liveChannelSku alone (the indexed columns), per market', async () => {
    await expect(scoped(() => assertWriteAccount('AMAZON', acc.b, { skus: ['H-RENAMED-NEW'], marketplace: 'IT' }))).rejects.toBeInstanceOf(WrongAccountWriteError)
    await expect(scoped(() => assertWriteAccount('AMAZON', acc.a, { skus: ['H-RENAMED-NEW'], marketplace: 'IT' }))).resolves.toBeUndefined()
    await expect(scoped(() => assertWriteAccount('AMAZON', acc.a, { skus: ['H-LIVE-ONLY'], marketplace: 'IT' }))).rejects.toBeInstanceOf(WrongAccountWriteError)
    await expect(scoped(() => assertWriteAccountPerSku('AMAZON', acc.a, ['H-LIVE-ONLY'], 'IT'))).rejects.toBeInstanceOf(WrongAccountWriteError)
    await expect(scoped(() => assertWriteAccount('AMAZON', acc.a, { skus: ['H-LIVE-ONLY'], marketplace: 'DE' }))).resolves.toBeUndefined()
  })
  it('hot path, agreed: a SKU only an old store holds (an offer) is not matched until the backfill copies it — as before S8', async () => {
    await expect(scoped(() => assertWriteAccount('AMAZON', acc.b, { skus: ['H-OFFER-FBA'] }))).resolves.toBeUndefined()
  })
  it('another business\'s listing with that SKU never makes an owner here', async () => {
    await expect(scoped(() => assertWriteAccount('AMAZON', acc.a, { skus: ['FOREIGN-ONLY'] }))).resolves.toBeUndefined()
  })
})

describe('the push-lock lookup reads a listing\'s own SKU', () => {
  it('a paused listing is found by its own SKU (its lock was missed before S8), and still by its product SKU', async () => {
    const byOwn = await scoped(() => readPushControls({ channel: 'AMAZON', skus: ['H-LOCK-IT'] }))
    expect(byOwn.map(r => [r.id, r.syncPaused])).toEqual([[lid.lock, true]])
    const byProduct = await scoped(() => readPushControls({ channel: 'AMAZON', skus: ['H-LOCK'] }))
    expect(byProduct.map(r => r.id)).toEqual([lid.lock])
  })
  it('found by channelSku alone and by liveChannelSku alone', async () => {
    expect((await scoped(() => readPushControls({ channel: 'AMAZON', skus: ['H-RENAMED-NEW'] }))).map(r => r.id)).toEqual([lid.renamed])
    expect((await scoped(() => readPushControls({ channel: 'AMAZON', skus: ['H-LIVE-ONLY'] }))).map(r => r.id)).toEqual([lid.liveOnly])
  })
  it('another business\'s listing is never read', async () => {
    await expect(scoped(() => readPushControls({ channel: 'AMAZON', skus: ['FOREIGN-ONLY'] }))).rejects.toMatchObject({ code: 'PUSH_CONTROL_UNAVAILABLE' })
  })
})
