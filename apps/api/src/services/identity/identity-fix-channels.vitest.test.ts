/**
 * Item ID control, steps I2–I4 (docs/sheet-ids-sku-rows/A2-item-id-control.md) — the Etsy Listing ID, the Shopify
 * Product ID and the Amazon ASIN, through the sheet's door (`channel-id.service.ts`) and identity-fix's plans, on PGlite
 * with the production schema and policies. Every channel is stood in at its one door (`LinkDeps`): Etsy's account reader,
 * Shopify's read-only admin reader and colour products' services, Amazon's catalog read. Nothing is sent anywhere.
 *
 * Proven per channel: the proof's success and each refusal (not found, another shop or store, another family, no matching
 * SKU, another Nexus identity or business), main row only, moved and kept rows, the status written, pushes paused, a
 * snapshot first, the SKU the channel proved recorded as `liveChannelSku` (cleared by an unlink, `channelSku` kept), and
 * Amazon's draft ASIN (set, kept, cleared) beside the live offer's refusal with Amazon's reason.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property) }) }
})
vi.mock('../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: () => undefined }))

import { checkChannelId, planLink, planUnlink, runLink, runUnlink, AMAZON_AT_PUBLISH, IdentityFixRefusal, pushesStayPaused, type LinkDeps } from './identity-fix.service.js'
import { checkSheetChannelId, linkSheetChannelId, mainRowOnly, unlinkSentence, unlinkSheetChannelId } from './channel-id.service.js'
import { COLOUR_CLEAR_REFUSED, type ColourView } from './channel-id-proofs/shopify.js'
import { readListingDeletions } from '../listings/listing-deletions.js'

const A = LEGACY_WORKSPACE_ID
const B = 'i2_channel_ids_bravo'
const TIMEOUT = 30_000
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const db = () => database.client
const ids: Record<string, string> = {}
type Data = Record<string, any>
const one = async (key: string, workspaceId = A) => inside(() => db().channelListing.findUniqueOrThrow({ where: { id: ids[key] } }), workspaceId) as Promise<Data>

/* ── the channels, stood in ─────────────────────────────────────────────────────────────────────── */

const SHOP = '555'
const etsyListings = new Map<string, { shop: string; state: string; skus: string[]; title?: string }>()
const etsyCalls: string[] = []
const notFound = () => Object.assign(new Error('Etsy could not read this resource (HTTP 404).'), { status: 404 })
const etsyDeps: LinkDeps = { etsy: { reader: async () => ({ shopId: SHOP, get: async <T>(path: string): Promise<T> => {
  etsyCalls.push(path)
  const id = /\/listings\/(\d+)/.exec(path)?.[1] ?? ''
  const listing = etsyListings.get(id)
  if (!listing) throw notFound()
  if (path.endsWith('/inventory')) return { products: listing.skus.map((sku) => ({ sku, is_deleted: false })) } as T
  return { listing_id: Number(id), shop_id: Number(listing.shop), state: listing.state, title: listing.title ?? 'Etsy jacket' } as T
} }) } }

const PG = (n: string) => `gid://shopify/Product/${n}`
const shopifyProducts = new Map<string, { status: string; identity?: string | null; variants: Array<{ id: string; sku: string; item: string }> }>()
let shopifyLocations: string[] = ['gid://shopify/Location/1']
const colour = { finds: [] as unknown[], confirms: [] as unknown[], view: null as ColourView | null, onConfirm: async () => undefined as void }
const shopifyDeps = (colourMode = false): LinkDeps => ({ shopify: {
  reader: async () => ({ domain: 'alpha.myshopify.com', read: async <T>(_query: string, variables: Record<string, unknown> = {}) => {
    const id = String(variables.id ?? '').split('/').at(-1)!
    const product = shopifyProducts.get(id)
    return { errors: [], data: { product: product ? { id: PG(id), title: `Product ${id}`, status: product.status, identity: product.identity ? { value: product.identity } : null,
      variants: { nodes: product.variants.map((v) => ({ id: `gid://shopify/ProductVariant/${v.id}`, sku: v.sku, inventoryItem: { id: `gid://shopify/InventoryItem/${v.item}` } })), pageInfo: { hasNextPage: false } } } : null,
      locations: { nodes: shopifyLocations.map((l) => ({ id: l, isActive: true })) } } as T }
  } }),
  colour: {
    enabled: async () => colourMode, mode: async () => (colourMode ? 'colour-products' : 'one-product'),
    find: async (rootId, scope, body) => { colour.finds.push({ rootId, scope, body }); return colour.view! },
    confirm: async (rootId, scope, body) => { colour.confirms.push({ rootId, scope, body }); await colour.onConfirm() },
  },
} })

const catalog = new Map<string, { title: string }>()
const catalogCalls: Array<{ accountId: string; asin: string; market: string }> = []
const amazonDeps: LinkDeps = { amazon: { catalog: async (accountId, asin, market) => {
  catalogCalls.push({ accountId, asin, market })
  const found = catalog.get(`${market}:${asin}`)
  return found ? { found: true, title: found.title, brand: 'Xbrand' } : { found: false }
} } }

/* ── the business ───────────────────────────────────────────────────────────────────────────────── */

beforeAll(async () => {
  database = await formulaDatabase()
  const client = database.client
  const person = await client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Ida Ids' } })
  ids.user = person.id
  await client.workspace.create({ data: { id: B, name: 'Bravo channel ids business', createdByUserId: person.id, creationKey: randomUUID() } })
  await inside(async () => {
    ids.etsy = (await client.channelConnection.create({ data: { channelType: 'ETSY', isActive: true, externalAccountId: SHOP } })).id
    ids.shopify = (await client.channelConnection.create({ data: { channelType: 'SHOPIFY', isActive: true, externalAccountId: 'alpha' } })).id
    ids.amazon = (await client.channelConnection.create({ data: { channelType: 'AMAZON', isActive: true, externalAccountId: 'amz-a' } })).id
    const make = async (sku: string, extra: Data = {}) => { ids[sku] = (await client.product.create({ data: { sku, name: sku, basePrice: '10.00', ...extra } })).id }
    const list = async (key: string, sku: string, channel: string, market: string, account: string, extra: Data = {}) => {
      ids[key] = (await client.channelListing.create({ data: {
        productId: ids[sku], channel, marketplace: market, region: market, channelMarket: `${channel}_${market}`, channelConnectionId: account,
        listingStatus: 'DRAFT', isPublished: false, externalListingId: null, syncPaused: true, quantity: 2, ...extra,
      } })).id
    }
    // Etsy: a family whose S sends its OWN Etsy SKU; M holds another listing.
    await make('ETY-JKT', { isParent: true })
    await make('ETY-JKT-S', { parentId: ids['ETY-JKT'] })
    await make('ETY-JKT-M', { parentId: ids['ETY-JKT'] })
    await list('eRoot', 'ETY-JKT', 'ETSY', 'GLOBAL', ids.etsy)
    await list('eS', 'ETY-JKT-S', 'ETSY', 'GLOBAL', ids.etsy, { channelSku: 'OWN-ETY-S' })
    await list('eM', 'ETY-JKT-M', 'ETSY', 'GLOBAL', ids.etsy, { listingStatus: 'ACTIVE', isPublished: true, externalListingId: '2000000002' })
    await make('ETY-OTHER')
    await list('eOther', 'ETY-OTHER', 'ETSY', 'GLOBAL', ids.etsy, { listingStatus: 'ACTIVE', isPublished: true, externalListingId: '2000000099' })
    // Shopify, one product per family.
    await make('SHP-JKT', { isParent: true })
    await make('SHP-JKT-S', { parentId: ids['SHP-JKT'] })
    await make('SHP-JKT-M', { parentId: ids['SHP-JKT'] })
    await list('sRoot', 'SHP-JKT', 'SHOPIFY', 'GLOBAL', ids.shopify)
    await list('sS', 'SHP-JKT-S', 'SHOPIFY', 'GLOBAL', ids.shopify)
    await list('sM', 'SHP-JKT-M', 'SHOPIFY', 'GLOBAL', ids.shopify, { channelSku: 'OWN-SHP-M' })
    await make('SHP-OTHER')
    await list('sOther', 'SHP-OTHER', 'SHOPIFY', 'GLOBAL', ids.shopify, { listingStatus: 'ACTIVE', isPublished: true, externalListingId: '8099' })
    // Shopify, colour products.
    await make('SHC-JKT', { isParent: true })
    await make('SHC-JKT-RED-S', { parentId: ids['SHC-JKT'] })
    await list('cRoot', 'SHC-JKT', 'SHOPIFY', 'GLOBAL', ids.shopify)
    await list('cRedS', 'SHC-JKT-RED-S', 'SHOPIFY', 'GLOBAL', ids.shopify)
    // Amazon: a still-draft row, and a live offer under its own seller SKU.
    await make('AMZ-DRAFT')
    await list('aDraft', 'AMZ-DRAFT', 'AMAZON', 'IT', ids.amazon)
    await make('AMZ-LIVE')
    await list('aLive', 'AMZ-LIVE', 'AMAZON', 'IT', ids.amazon, { listingStatus: 'ACTIVE', isPublished: true, syncPaused: false, externalListingId: 'B0LIVE0001', channelSku: 'AMZ-LIVE-IT', liveChannelSku: 'AMZ-LIVE-IT' })
  })
  // Business B: its own Etsy shop and Shopify store, a listing holding B's Etsy listing.
  await inside(async () => {
    ids.etsyB = (await client.channelConnection.create({ data: { channelType: 'ETSY', isActive: true, externalAccountId: '777' } })).id
    ids.bravo = (await client.product.create({ data: { sku: 'ETY-JKT', name: 'Bravo jacket', basePrice: '10.00' } })).id
    ids.bravoEtsy = (await client.channelListing.create({ data: {
      productId: ids.bravo, channel: 'ETSY', marketplace: 'GLOBAL', region: 'GLOBAL', channelMarket: 'ETSY_GLOBAL', channelConnectionId: ids.etsyB,
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: '3000000777',
    } })).id
  }, B)
}, 120_000)

afterAll(async () => { await database?.close() }, 30_000)

beforeEach(() => {
  etsyListings.clear(); etsyCalls.length = 0
  shopifyProducts.clear(); shopifyLocations = ['gid://shopify/Location/1']
  colour.finds = []; colour.confirms = []; colour.view = null; colour.onConfirm = async () => undefined
  catalog.clear(); catalogCalls.length = 0
})

const fenceOf = async (key: string) => { const r = await one(key); return { expectedExternalId: r.externalListingId as string | null, expectedVersion: r.version as number } }

/* ── Etsy (I2) ──────────────────────────────────────────────────────────────────────────────────── */

describe('Etsy Listing ID: proven as this account\'s shop, by this family\'s channel SKUs', () => {
  it('Check: a listing of this shop carrying S\'s own Etsy SKU proves; it carries the main row and S; M (another listing, not on it) is kept', async () => {
    etsyListings.set('2000000001', { shop: SHOP, state: 'active', skus: ['OWN-ETY-S'] })
    const out = await inside(() => checkSheetChannelId(ids.eRoot, { externalId: '2000000001' }, etsyDeps))
    expect(out).toMatchObject({ ok: true, refusal: null, verdict: 'verified', status: 'ACTIVE', channelStatus: 'active', currentId: null, pushes: pushesStayPaused('listing') })
    expect(out.rows.map((r) => r.sku).sort()).toEqual(['ETY-JKT', 'ETY-JKT-S'])
    expect(out.kept).toEqual([expect.objectContaining({ sku: 'ETY-JKT-M', externalListingId: '2000000002',
      sentence: 'ETY-JKT-M holds listing 2000000002; Etsy does not show its SKU on listing 2000000001, so Link leaves it as it is.' })])
    expect(out.found).toEqual(expect.arrayContaining(['Etsy reports it as active.', 'Listed by this account\'s Etsy shop.']))
    expect(etsyCalls).toEqual(['/listings/2000000001', '/listings/2000000001/inventory'])
  }, TIMEOUT)

  it('refuses only what cannot work, in plain sentences: not a number, another family\'s, not found, another shop, a draft, no SKU of the family', async () => {
    const check = (externalId: string) => inside(() => checkChannelId(ids.eRoot, { externalId }, etsyDeps))
    expect(await check('12ab')).toMatchObject({ ok: false, refusal: expect.stringContaining('an Etsy Listing ID is a number') })
    // F4 (browser check 2026-10-05): the place in the sheet's words — Etsy sells one listing everywhere, so no "· GLOBAL".
    expect((await check('12ab')).refusal).toMatch(/^The Etsy listing of ETY-JKT: an Etsy Listing ID is a number/)
    expect(await check('2000000099')).toMatchObject({ ok: false, verdict: 'rejected', refusal: expect.stringContaining('already linked to another product here (ETY-OTHER)') })
    expect(await check('2000000404')).toMatchObject({ ok: false, refusal: expect.stringContaining('Etsy has no listing 2000000404 that this account can read') })
    etsyListings.set('2000000005', { shop: '777', state: 'active', skus: ['OWN-ETY-S'] })
    expect(await check('2000000005')).toMatchObject({ ok: false, refusal: expect.stringContaining('belongs to Etsy shop 777, not this account\'s shop 555') })
    etsyListings.set('2000000006', { shop: SHOP, state: 'draft', skus: ['OWN-ETY-S'] })
    expect(await check('2000000006')).toMatchObject({ ok: false, refusal: expect.stringContaining('as a draft: it does not sell yet') })
    // ETY-JKT-S's product SKU is not what it sends to Etsy (OWN-ETY-S): another product's SKU, refused.
    etsyListings.set('2000000007', { shop: SHOP, state: 'active', skus: ['ETY-JKT-S'] })
    expect(await check('2000000007')).toMatchObject({ ok: false, verdict: 'rejected', refusal: expect.stringContaining('belong to this family on this account') })
  }, TIMEOUT)

  it('a listing with no SKUs: the sheet refuses; Claude\'s tool needs an explicit yes', async () => {
    etsyListings.set('2000000008', { shop: SHOP, state: 'active', skus: [] })
    expect(await inside(() => checkChannelId(ids.eRoot, { externalId: '2000000008' }, etsyDeps))).toMatchObject({ ok: false, verdict: 'unverifiable', refusal: expect.stringContaining('Give its variations their SKUs on Etsy') })
    await expect(inside(() => planLink(ids.eRoot, { externalId: '2000000008' }, etsyDeps))).rejects.toThrow('acknowledgeUnverifiable')
    expect((await inside(() => planLink(ids.eRoot, { externalId: '2000000008', acknowledgeUnverifiable: true }, etsyDeps))).verdict).toBe('unverifiable')
  }, TIMEOUT)

  it('main row only: a variation row is refused with Etsy\'s sentence', async () => {
    await expect(inside(() => checkSheetChannelId(ids.eS, { externalId: '2000000001' }, etsyDeps))).rejects.toThrow(mainRowOnly('ETSY'))
    expect(mainRowOnly('ETSY')).toBe('Set on the main row: one Etsy listing carries the whole family.')
  }, TIMEOUT)

  it('Link: the carried rows take the listing (Active, published, paused, Etsy\'s read stamped), a snapshot first, S records its proven SKU', async () => {
    etsyListings.set('2000000001', { shop: SHOP, state: 'active', skus: ['OWN-ETY-S'] })
    const out = await inside(async () => linkSheetChannelId(ids.eRoot, { externalId: '2000000001', ...(await fenceOf('eRoot')) }, ids.user, etsyDeps))
    expect(out).toMatchObject({ ok: true, status: 'ACTIVE', sentence: 'Linked listing 2000000001 on 2 rows.', pushes: pushesStayPaused('listing') })
    for (const key of ['eRoot', 'eS']) {
      expect(await one(key)).toMatchObject({ externalListingId: '2000000001', listingStatus: 'ACTIVE', isPublished: true, syncPaused: true, lastSyncStatus: 'SUCCESS' })
      expect((await one(key)).lastSyncedAt).toBeInstanceOf(Date)
    }
    expect(await one('eS')).toMatchObject({ liveChannelSku: 'OWN-ETY-S', channelSku: 'OWN-ETY-S' })
    expect((await one('eRoot')).liveChannelSku).toBeNull()
    expect(await one('eM')).toMatchObject({ externalListingId: '2000000002' }) // kept
    expect(await inside(() => db().channelListingSnapshot.count({ where: { channelListingId: { in: [ids.eRoot, ids.eS] }, label: 'before link-channel-id (2000000001)' } }))).toBe(2)
    const audit = await inside(() => db().auditLog.findFirstOrThrow({ where: { entityId: ids.eRoot, action: 'listing.channel-id.link' } }))
    expect(audit).toMatchObject({ userId: ids.user })
    expect(audit.metadata).toMatchObject({ channel: 'ETSY', liveChannelSkus: [{ id: ids.eS, sku: 'OWN-ETY-S' }] })
  }, TIMEOUT)

  it('Owner option A: M (on another listing) moves only when Etsy shows its own SKU — listed before, its SKU recorded', async () => {
    etsyListings.set('2000000003', { shop: SHOP, state: 'inactive', skus: ['OWN-ETY-S', 'ETY-JKT-M'] })
    const check = await inside(() => checkChannelId(ids.eRoot, { externalId: '2000000003' }, etsyDeps))
    expect(check.moved).toEqual([{ listingId: ids.eM, sku: 'ETY-JKT-M', channelSku: 'ETY-JKT-M', from: '2000000002',
      sentence: 'ETY-JKT-M holds listing 2000000002; Etsy shows its SKU ETY-JKT-M on listing 2000000003; Link moves it to 2000000003.' }])
    const out = await inside(async () => linkSheetChannelId(ids.eRoot, { externalId: '2000000003', ...(await fenceOf('eRoot')) }, ids.user, etsyDeps))
    expect(out.sentence).toContain('It does not sell on Etsy now: the rows read Inactive.')
    expect(out.moved.map((m) => m.sku)).toEqual(['ETY-JKT-M'])
    expect(await one('eM')).toMatchObject({ externalListingId: '2000000003', listingStatus: 'INACTIVE', liveChannelSku: 'ETY-JKT-M' })
    expect(await inside(() => db().channelListingSnapshot.count({ where: { channelListingId: ids.eM, label: 'before link-channel-id (2000000003)' } }))).toBe(1)
  }, TIMEOUT)

  it('a listing Etsy did not return on its last read (MISSING): Check → Keep writes the read again; then nothing to change', async () => {
    await inside(() => db().channelListing.updateMany({ where: { id: { in: [ids.eRoot, ids.eS, ids.eM] } }, data: { lastSyncStatus: 'MISSING' } }))
    etsyListings.set('2000000003', { shop: SHOP, state: 'inactive', skus: ['OWN-ETY-S', 'ETY-JKT-M'] })
    const check = await inside(() => checkChannelId(ids.eRoot, {}, etsyDeps))
    expect(check).toMatchObject({ ok: true, unchanged: false, itemId: '2000000003', currentId: '2000000003' })
    await inside(async () => linkSheetChannelId(ids.eRoot, { externalId: '2000000003', ...(await fenceOf('eRoot')) }, ids.user, etsyDeps))
    expect((await one('eRoot')).lastSyncStatus).toBe('SUCCESS')
    const kept = await inside(async () => linkSheetChannelId(ids.eRoot, { externalId: '2000000003', ...(await fenceOf('eRoot')) }, ids.user, etsyDeps))
    expect(kept).toMatchObject({ rows: [], sentence: 'Etsy confirms listing 2000000003; Nexus already holds it. Nothing changed.' })
  }, TIMEOUT)

  it('Clear: every row of the listing becomes a paused draft read as Not listed; the proven SKU is forgotten, the sent SKU kept', async () => {
    const out = await inside(async () => unlinkSheetChannelId(ids.eRoot, await fenceOf('eRoot'), ids.user))
    expect(out).toMatchObject({ ok: true, externalId: '2000000003', sentence: unlinkSentence('2000000003', 'ETSY') })
    expect(out.sentence).toBe('Nexus forgets Etsy listing 2000000003. Nothing changes on Etsy; it stays live and Nexus stops updating it.')
    for (const key of ['eRoot', 'eS', 'eM']) expect(await one(key)).toMatchObject({ externalListingId: null, listingStatus: 'DRAFT', isPublished: false, syncPaused: true, liveChannelSku: null })
    expect((await one('eS')).channelSku).toBe('OWN-ETY-S')
    const removed = await inside(async () => readListingDeletions([await one('eRoot')].map((r) => ({ id: r.id, channel: 'ETSY', marketplace: 'GLOBAL', externalListingId: r.externalListingId, listingStatus: r.listingStatus, isPublished: r.isPublished }))))
    expect(removed.get(ids.eRoot)).toMatchObject({ unlinked: true, oldReference: '2000000003' })
  }, TIMEOUT)

  it('never across businesses: B\'s listing is not found here; B\'s shop\'s listing is refused for A', async () => {
    await expect(inside(() => checkChannelId(ids.bravoEtsy, {}, etsyDeps))).rejects.toMatchObject({ code: 'not_found' })
    etsyListings.set('3000000777', { shop: '777', state: 'active', skus: ['OWN-ETY-S'] })
    expect(await inside(() => checkChannelId(ids.eRoot, { externalId: '3000000777' }, etsyDeps))).toMatchObject({ ok: false, refusal: expect.stringContaining('not this account\'s shop 555') })
    expect((await one('bravoEtsy', B)).externalListingId).toBe('3000000777')
  }, TIMEOUT)
})

/* ── Shopify (I3) ───────────────────────────────────────────────────────────────────────────────── */

describe('Shopify Product ID, one product per family: a product of this store, matched variant by variant', () => {
  const product = (status = 'ACTIVE', identity: string | null = null) => ({ status, identity, variants: [{ id: '91', sku: 'SHP-JKT-S', item: '71' }, { id: '92', sku: 'OWN-SHP-M', item: '72' }] })

  it('Check: each row matched to a variant by its own channel SKU; the main row with them', async () => {
    shopifyProducts.set('8001', product())
    const out = await inside(() => checkSheetChannelId(ids.sRoot, { externalId: 'gid://shopify/Product/8001' }, shopifyDeps()))
    expect(out).toMatchObject({ ok: true, itemId: '8001', status: 'ACTIVE', channelStatus: 'ACTIVE', pushes: pushesStayPaused('product') })
    expect(out.rows.map((r) => r.sku).sort()).toEqual(['SHP-JKT', 'SHP-JKT-M', 'SHP-JKT-S'])
    expect(out.found).toEqual(expect.arrayContaining(['Shopify reports it as Active.', 'A product of this business\'s Shopify store.']))
  }, TIMEOUT)

  it('refuses: not in this store (another store\'s product), another Nexus identity, another family\'s product, no SKU of the family, this family\'s colour product', async () => {
    const check = (externalId: string) => inside(() => checkChannelId(ids.sRoot, { externalId }, shopifyDeps()))
    expect(await check('8404')).toMatchObject({ ok: false, refusal: expect.stringContaining('(alpha.myshopify.com) has no product 8404. A product of another store is never linked here.') })
    expect((await check('8404')).refusal).toMatch(/^The Shopify listing of SHP-JKT: /)
    shopifyProducts.set('8002', product('ACTIVE', `${B}:someone`))
    expect(await check('8002')).toMatchObject({ ok: false, refusal: expect.stringContaining('carries another Nexus identity') })
    expect(await check('8099')).toMatchObject({ ok: false, refusal: expect.stringContaining('already linked to another product here (SHP-OTHER)') })
    shopifyProducts.set('8003', { status: 'ACTIVE', variants: [{ id: '93', sku: 'SOMEONE-ELSE', item: '73' }] })
    expect(await check('8003')).toMatchObject({ ok: false, refusal: expect.stringContaining('is a SKU this family sends to this store') })
    shopifyProducts.set('8004', product('ACTIVE', `${A}:${ids['SHP-JKT']}:c:row1`))
    expect(await check('8004')).toMatchObject({ ok: false, refusal: expect.stringContaining('one of this family\'s colour products') })
    expect(await check('abc')).toMatchObject({ ok: false, refusal: expect.stringContaining('a Shopify Product ID is a number') })
  }, TIMEOUT)

  it('Link: the product id on every row, the variant and inventory item (and the one location) on each variant row; Active; paused; SKUs recorded', async () => {
    shopifyProducts.set('8001', product('ACTIVE', `${A}:${ids['SHP-JKT']}`))
    const out = await inside(async () => linkSheetChannelId(ids.sRoot, { externalId: '8001', ...(await fenceOf('sRoot')) }, ids.user, shopifyDeps()))
    expect(out).toMatchObject({ ok: true, status: 'ACTIVE', sentence: 'Linked product 8001 on 3 rows.', pushes: pushesStayPaused('product') })
    expect(await one('sRoot')).toMatchObject({ externalListingId: '8001', platformProductId: '8001', listingStatus: 'ACTIVE', isPublished: true, syncPaused: true, liveChannelSku: null,
      platformAttributes: { shopifyProductId: '8001', nexusFamilyId: ids['SHP-JKT'] } })
    expect((await one('sRoot')).platformAttributes).not.toHaveProperty('variantId')
    expect(await one('sS')).toMatchObject({ externalListingId: '8001', liveChannelSku: 'SHP-JKT-S',
      platformAttributes: { shopifyProductId: '8001', variantId: '91', inventoryItemId: '71', inventoryLocationId: 'gid://shopify/Location/1', nexusFamilyId: ids['SHP-JKT'] } })
    expect(await one('sM')).toMatchObject({ liveChannelSku: 'OWN-SHP-M', channelSku: 'OWN-SHP-M', platformAttributes: { variantId: '92', inventoryItemId: '72' } })
    // Keep on what Nexus already holds and Shopify confirms.
    const kept = await inside(async () => linkSheetChannelId(ids.sRoot, { externalId: '8001', ...(await fenceOf('sRoot')) }, ids.user, shopifyDeps()))
    expect(kept).toMatchObject({ rows: [], sentence: 'Shopify confirms product 8001; Nexus already holds it. Nothing changed.' })
  }, TIMEOUT)

  it('a Draft or Archived product links as Inactive (not for sale); a store with several locations says stock waits for one', async () => {
    shopifyProducts.set('8001', product('DRAFT'))
    shopifyLocations = ['gid://shopify/Location/1', 'gid://shopify/Location/2']
    const check = await inside(() => checkChannelId(ids.sRoot, { externalId: '8001' }, shopifyDeps()))
    expect(check).toMatchObject({ ok: true, status: 'INACTIVE', unchanged: false })
    expect(check.found).toEqual(expect.arrayContaining(['Shopify reports it as Draft: Nexus records it as Inactive (not for sale).',
      'The store has 2 active locations: stock is not sent to this product until its location is set (Publish review).']))
    await inside(async () => linkSheetChannelId(ids.sRoot, { externalId: '8001', ...(await fenceOf('sRoot')) }, ids.user, shopifyDeps()))
    expect(await one('sS')).toMatchObject({ listingStatus: 'INACTIVE', isPublished: false, platformAttributes: { inventoryLocationId: 'gid://shopify/Location/1' } })
  }, TIMEOUT)

  it('Clear: the product, variant and inventory item ids leave every row; the proven SKUs are forgotten', async () => {
    await inside(async () => unlinkSheetChannelId(ids.sRoot, await fenceOf('sRoot'), ids.user))
    for (const key of ['sRoot', 'sS', 'sM']) {
      const row = await one(key)
      expect(row).toMatchObject({ externalListingId: null, listingStatus: 'DRAFT', liveChannelSku: null })
      for (const k of ['shopifyProductId', 'variantId', 'inventoryItemId']) expect(row.platformAttributes ?? {}).not.toHaveProperty(k)
    }
    expect((await one('sM')).channelSku).toBe('OWN-SHP-M')
  }, TIMEOUT)

  it('a variation row is refused: the family\'s product is set on the main row', async () => {
    await expect(inside(() => checkSheetChannelId(ids.sS, { externalId: '8001' }, shopifyDeps()))).rejects.toThrow(mainRowOnly('SHOPIFY'))
  }, TIMEOUT)
})

describe('Shopify colour products: the root row is the door; Check runs Find, Link confirms the one colour', () => {
  const view = (productId: string | null, issues: string[] = []): ColourView => ({
    plan: { mode: 'colour-products', products: [{ key: 'red', nexusValue: 'Red' }] },
    colourProducts: [{ id: 'cp-red', valueKey: 'red', state: 'PROPOSED', shopifyProductId: null, proposal: productId ? {
      shopifyProductId: PG(productId), title: 'Jacket Red', status: 'ACTIVE', variants: [{ productId: ids['SHC-JKT-RED-S'], sku: 'SHC-JKT-RED-S', shopifyVariantId: 'gid://shopify/ProductVariant/95', inventoryItemId: 'gid://shopify/InventoryItem/75' }],
      skusToWrite: [], issues: issues.map((message) => ({ message })) } : { shopifyProductId: null } }],
  })

  it('Check: Find with the typed product; the colour and sizes it matched, and what Confirm writes on Shopify', async () => {
    colour.view = view('8100')
    const out = await inside(() => checkSheetChannelId(ids.cRoot, { externalId: '8100' }, shopifyDeps(true)))
    expect(colour.finds).toEqual([{ rootId: ids['SHC-JKT'], scope: { accountId: ids.shopify, market: 'GLOBAL', aliasKey: undefined }, body: { sourceProductId: PG('8100') } }])
    expect(out).toMatchObject({ ok: true, status: 'ACTIVE', rows: [{ listingId: ids.cRedS, sku: 'SHC-JKT-RED-S', from: null }] })
    expect(out.found).toContain('Link confirms "Red": Nexus writes its identity on Shopify product 8100, reads it back, then links 1 size.')
    colour.view = view(null)
    expect(await inside(() => checkChannelId(ids.cRoot, { externalId: '8100' }, shopifyDeps(true)))).toMatchObject({ ok: false, refusal: expect.stringContaining('is not one of this family\'s colours') })
    colour.view = view('8100', ['"Jacket Red" is already the Shopify product of OTHER-FAMILY.'])
    expect(await inside(() => checkChannelId(ids.cRoot, { externalId: '8100' }, shopifyDeps(true)))).toMatchObject({ ok: false, refusal: expect.stringContaining('already the Shopify product of OTHER-FAMILY') })
  }, TIMEOUT)

  it('Link: Confirm for that colour (its own Shopify writes and read-back), a snapshot of each size first, each size\'s SKU recorded', async () => {
    colour.view = view('8100')
    colour.onConfirm = async () => {
      await inside(() => db().channelListing.update({ where: { id: ids.cRedS }, data: { externalListingId: '8100', listingStatus: 'ACTIVE', isPublished: true,
        platformAttributes: { shopifyColourProductId: 'cp-red', shopifyProductId: '8100', variantId: '95', inventoryItemId: '75' } } }))
    }
    const out = await inside(async () => linkSheetChannelId(ids.cRoot, { externalId: '8100', ...(await fenceOf('cRoot')) }, ids.user, shopifyDeps(true)))
    expect(colour.confirms).toEqual([{ rootId: ids['SHC-JKT'], scope: expect.objectContaining({ accountId: ids.shopify }), body: { colours: [{ valueKey: 'red', shopifyProductId: PG('8100') }] } }])
    expect(out).toMatchObject({ ok: true, sentence: 'Linked "Red" to Shopify product 8100 on 1 row.' })
    expect(await one('cRedS')).toMatchObject({ externalListingId: '8100', liveChannelSku: 'SHC-JKT-RED-S' })
    expect(await inside(() => db().channelListingSnapshot.count({ where: { channelListingId: ids.cRedS, label: 'before link-channel-id (8100)' } }))).toBe(1)
  }, TIMEOUT)

  it('Clear on a colour product is refused (colour products own its links); nothing changes', async () => {
    const before = await one('cRedS')
    await expect(inside(() => runUnlink(ids.cRedS, '8100', ids.user))).rejects.toThrow(COLOUR_CLEAR_REFUSED)
    expect((await one('cRedS')).externalListingId).toBe(before.externalListingId)
  }, TIMEOUT)
})

/* ── Amazon (I4) ────────────────────────────────────────────────────────────────────────────────── */

describe('Amazon ASIN: a draft row lists on a typed ASIN at Publish; a live offer\'s ASIN is Amazon\'s', () => {
  const LIVE = 'Amazon ties seller SKU AMZ-LIVE-IT to ASIN B0LIVE0001 on Amazon · IT. To use another ASIN: Delete (Status), set the ASIN here, Publish — or give this listing a new SKU, which lists as a new offer.'

  it('Check on a draft: the ASIN is read in Amazon\'s catalog for this market, as the listing\'s own account; nothing is sent', async () => {
    catalog.set('IT:B0NEW00001', { title: 'Giacca' })
    const out = await inside(() => checkSheetChannelId(ids.aDraft, { externalId: 'b0new00001' }, amazonDeps))
    expect(catalogCalls).toEqual([{ accountId: ids.amazon, asin: 'B0NEW00001', market: 'IT' }])
    expect(out).toMatchObject({ ok: true, itemId: 'B0NEW00001', currentId: null, pushes: AMAZON_AT_PUBLISH, rows: [{ listingId: ids.aDraft, sku: 'AMZ-DRAFT' }] })
    expect(out.found).toEqual(['Amazon has ASIN B0NEW00001 on Amazon · IT: "Giacca" (brand Xbrand).', 'Publish lists seller SKU AMZ-DRAFT on it, as a new offer. Nothing is sent to Amazon now.'])
    expect(await inside(() => checkChannelId(ids.aDraft, { externalId: 'B0NOTHERE1' }, amazonDeps))).toMatchObject({ ok: false, refusal: 'Amazon has no ASIN B0NOTHERE1 on Amazon · IT. Nothing changed.' })
    expect(await inside(() => checkChannelId(ids.aDraft, { externalId: 'B0SHORT' }, amazonDeps))).toMatchObject({ ok: false, refusal: expect.stringContaining('10 letters or digits') })
  }, TIMEOUT)

  it('Link sets merchant_suggested_asin for THIS market\'s listing (the sheet column\'s store); Keep changes nothing; Clear removes it', async () => {
    catalog.set('IT:B0NEW00001', { title: 'Giacca' })
    const set = await inside(async () => linkSheetChannelId(ids.aDraft, { externalId: 'B0NEW00001', ...(await fenceOf('aDraft')) }, ids.user, amazonDeps))
    expect(set).toMatchObject({ ok: true, externalId: 'B0NEW00001', pushes: AMAZON_AT_PUBLISH })
    const row = await one('aDraft')
    expect(row).toMatchObject({ externalListingId: null, listingStatus: 'DRAFT', isPublished: false, overrideData: { merchant_suggested_asin: 'B0NEW00001' } })
    expect(set.rows).toEqual([{ listingId: ids.aDraft, version: row.version }])
    // The sheet now shows the suggestion: its fence is that ASIN.
    const kept = await inside(() => linkSheetChannelId(ids.aDraft, { externalId: 'B0NEW00001', expectedExternalId: 'B0NEW00001', expectedVersion: row.version }, ids.user, amazonDeps))
    expect(kept).toMatchObject({ rows: [], sentence: expect.stringContaining('Nothing changed.') })
    await expect(inside(() => linkSheetChannelId(ids.aDraft, { externalId: 'B0NEW00001', expectedExternalId: null, expectedVersion: row.version }, ids.user, amazonDeps))).rejects.toMatchObject({ code: 'conflict' })
    const cleared = await inside(() => unlinkSheetChannelId(ids.aDraft, { expectedExternalId: 'B0NEW00001', expectedVersion: row.version }, ids.user))
    expect(cleared).toMatchObject({ ok: true, externalId: 'B0NEW00001', sentence: unlinkSentence('B0NEW00001', 'AMAZON') })
    expect((await one('aDraft')).overrideData ?? {}).not.toHaveProperty('merchant_suggested_asin')
    const audit = await inside(() => db().auditLog.findMany({ where: { entityId: ids.aDraft, action: 'listing.channel-id.suggest' } }))
    expect(audit).toHaveLength(2)
  }, TIMEOUT)

  it('a live offer: Check, Link and Clear are refused with Amazon\'s reason and the way to do it; Amazon is not asked; nothing changes', async () => {
    catalog.set('IT:B0NEW00001', { title: 'Giacca' })
    expect(await inside(() => checkSheetChannelId(ids.aLive, { externalId: 'B0NEW00001' }, amazonDeps))).toMatchObject({ ok: false, refusal: LIVE })
    await expect(inside(async () => linkSheetChannelId(ids.aLive, { externalId: 'B0NEW00001', ...(await fenceOf('aLive')) }, ids.user, amazonDeps))).rejects.toThrow(LIVE)
    await expect(inside(async () => unlinkSheetChannelId(ids.aLive, await fenceOf('aLive'), ids.user))).rejects.toThrow(LIVE)
    // One rule with Claude's unlink-channel-id: identity-fix's own plan refuses it in the same words, before any write.
    await expect(inside(() => planUnlink(ids.aLive))).rejects.toThrow(LIVE)
    await expect(inside(() => runUnlink(ids.aLive, 'B0LIVE0001', ids.user))).rejects.toThrow(LIVE)
    expect(catalogCalls).toEqual([])
    expect(await one('aLive')).toMatchObject({ externalListingId: 'B0LIVE0001', listingStatus: 'ACTIVE' })
  }, TIMEOUT)

  it('Claude\'s tool, one rule: a typed ASIN on a draft is the ASIN it lists on at Publish; on a live offer it is refused', async () => {
    catalog.set('IT:B0NEW00002', { title: 'Giacca 2' })
    const plan = await inside(() => planLink(ids.aDraft, { externalId: 'B0NEW00002' }, amazonDeps))
    expect(plan).toMatchObject({ channel: 'AMAZON', externalId: 'B0NEW00002', suggestedAsin: { sellerSku: 'AMZ-DRAFT', current: null } })
    const record = await inside(() => runLink(ids.aDraft, { externalId: 'B0NEW00002', expectedExternalId: 'B0NEW00002', actor: ids.user }, amazonDeps))
    expect(record).toMatchObject({ suggestedAsin: { previous: null, changed: true } })
    // The draft's ASIN for Publish is cleared by the same plan the sheet's Clear runs: only that ASIN goes, the row stays a draft.
    expect(await inside(() => planUnlink(ids.aDraft))).toMatchObject({ externalId: 'B0NEW00002', suggested: { sellerSku: 'AMZ-DRAFT' }, live: false })
    expect(await inside(() => runUnlink(ids.aDraft, 'B0NEW00002', ids.user))).toMatchObject({ suggested: true, externalId: 'B0NEW00002', snapshotIds: [] })
    expect(await one('aDraft')).toMatchObject({ externalListingId: null, listingStatus: 'DRAFT', isPublished: false })
    expect((await one('aDraft')).overrideData ?? {}).not.toHaveProperty('merchant_suggested_asin')
    await expect(inside(() => planLink(ids.aLive, { externalId: 'B0NEW00002' }, amazonDeps))).rejects.toThrow('Amazon ties seller SKU AMZ-LIVE-IT to ASIN B0LIVE0001')
  }, TIMEOUT)
})

describe('the sheet door keeps refusing what it does not change', () => {
  it('a listing of no supported channel id is refused in plain words', async () => {
    const woo = await inside(async () => {
      const connection = await db().channelConnection.create({ data: { channelType: 'WOOCOMMERCE', isActive: true } })
      return (await db().channelListing.create({ data: { productId: ids['AMZ-DRAFT'], channel: 'WOOCOMMERCE', marketplace: 'GLOBAL', region: 'GLOBAL', channelMarket: 'WOOCOMMERCE_GLOBAL', channelConnectionId: connection.id, listingStatus: 'DRAFT', isPublished: false } })).id
    })
    await expect(inside(() => checkSheetChannelId(woo, { externalId: '1' }))).rejects.toBeInstanceOf(IdentityFixRefusal)
  }, TIMEOUT)
})
