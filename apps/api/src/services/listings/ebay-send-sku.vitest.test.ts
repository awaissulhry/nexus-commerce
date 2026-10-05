/**
 * S4 — the eBay sending rules (ebay-send-sku.ts): what Publish sends per row, the custom label of an item, and each
 * product's SKU on one item (real PostgreSQL through PGlite: production schema and policies). Parity first: a listing
 * with no SKU of its own gets the product SKU everywhere. Another account and another business are never read.
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
import { ebayItemLabel, ebayPublishSku, ebayRowsOnItem, readEbayItemRows, readListingAliases, type EbayItemRow } from './ebay-send-sku.js'

const LIVE = { listingStatus: 'ACTIVE', isPublished: true, externalListingId: '111' }
const DRAFT = { listingStatus: 'DRAFT', isPublished: false, externalListingId: null }

describe('ebayPublishSku — what Publish sends for one row', () => {
  it('parity: no own SKU → the product SKU, for a live row, a draft row and no row', () => {
    expect(ebayPublishSku({ ...LIVE }, 'P')).toEqual({ sku: 'P', wanted: 'P', live: 'P', waitsForMove: false })
    expect(ebayPublishSku({ ...DRAFT }, 'P')).toEqual({ sku: 'P', wanted: 'P', live: null, waitsForMove: false })
    expect(ebayPublishSku(null, 'P')).toEqual({ sku: 'P', wanted: 'P', live: null, waitsForMove: false })
  })

  it('a row eBay does not hold yet sends its wanted SKU (own, else an extra listing\'s own on its main row)', () => {
    expect(ebayPublishSku({ ...DRAFT, channelSku: 'OWN' }, 'P').sku).toBe('OWN')
    expect(ebayPublishSku({ ...DRAFT, productId: 'r', aliasKey: 'a', alias: { sku: 'ALT', productId: 'r' } }, 'P').sku).toBe('ALT')
    // A child row of an extra listing does not carry the alias SKU.
    expect(ebayPublishSku({ ...DRAFT, productId: 'child', aliasKey: 'a', alias: { sku: 'ALT', productId: 'r' } }, 'P').sku).toBe('P')
  })

  it('a row eBay holds sends what eBay holds: its confirmed SKU, else the product SKU', () => {
    expect(ebayPublishSku({ ...LIVE, liveChannelSku: 'HELD', channelSku: 'HELD' }, 'P')).toEqual({ sku: 'HELD', wanted: 'HELD', live: 'HELD', waitsForMove: false })
  })

  it('TODO(S10): a live row wanting another SKU keeps eBay\'s and says it waits for a move', () => {
    expect(ebayPublishSku({ ...LIVE, channelSku: 'WANT' }, 'P')).toEqual({ sku: 'P', wanted: 'WANT', live: 'P', waitsForMove: true })
    expect(ebayPublishSku({ ...LIVE, channelSku: 'WANT', liveChannelSku: 'HELD' }, 'P')).toEqual({ sku: 'HELD', wanted: 'WANT', live: 'HELD', waitsForMove: true })
    expect(ebayPublishSku({ ...LIVE, productId: 'r', aliasKey: 'a', alias: { sku: 'ALT', productId: 'r' } }, 'P')).toEqual({ sku: 'P', wanted: 'ALT', live: 'P', waitsForMove: true })
  })

  it('no SKU at all sends nothing (the review names an empty SKU)', () => {
    expect(ebayPublishSku({ ...DRAFT }, '').sku).toBe('')
  })
})

describe('ebayItemLabel — the custom label of one eBay item', () => {
  const root = (id: string, facts: Record<string, unknown> = {}, sku = 'FAM'): EbayItemRow => ({ id, productId: `p-${id}`, ...LIVE, product: { sku, parentId: null }, ...facts })
  const child = (id: string, facts: Record<string, unknown> = {}): EbayItemRow => ({ id, productId: `c-${id}`, ...LIVE, product: { sku: `FAM-${id}`, parentId: 'p' }, ...facts })

  it('parity: no main row, or one with no own SKU → the caller\'s fallback, exactly as before', () => {
    const before = { target: 'FAM', keep: ['FAM'], listingId: null, refusal: null }
    expect(ebayItemLabel([], 'FAM')).toEqual(before)
    expect(ebayItemLabel([root('r'), child('m', { liveChannelSku: 'OWN-M' })], 'FAM')).toEqual(before)
    // A main row whose product SKU differs from the caller's (e.g. a membership parent SKU) still gets the old fallback,
    // also once a publish confirmed its product SKU as the SKU eBay holds (that is no SKU of its own).
    expect(ebayItemLabel([root('r', {}, 'OTHER')], 'FAM')).toEqual(before)
    expect(ebayItemLabel([root('r', { liveChannelSku: 'OTHER', channelSku: 'OTHER' }, 'OTHER')], 'FAM')).toEqual(before)
  })

  it('a main row with its own wanted SKU: that is the label; the SKU eBay holds may stay (S10 moves it)', () => {
    expect(ebayItemLabel([root('r', { channelSku: 'OWN' })], 'FAM')).toEqual({ target: 'OWN', keep: ['OWN', 'FAM'], listingId: 'r', refusal: null })
    expect(ebayItemLabel([root('r', { channelSku: 'OWN', liveChannelSku: 'OWN' })], 'FAM')).toEqual({ target: 'OWN', keep: ['OWN'], listingId: 'r', refusal: null })
  })

  it('an extra listing\'s main row: its alias SKU is the label; eBay\'s product-SKU label may stay', () => {
    const alias = root('r', { aliasKey: 'a', productId: 'p-r', alias: { sku: 'ALT', productId: 'p-r' } })
    expect(ebayItemLabel([alias], 'FAM')).toEqual({ target: 'ALT', keep: ['ALT', 'FAM'], listingId: 'r', refusal: null })
  })

  it('two main rows wanting different SKUs: no label is written', () => {
    const label = ebayItemLabel([root('r1', { channelSku: 'A' }), root('r2', { channelSku: 'B' })], 'FAM')
    expect(label).toMatchObject({ keep: [], listingId: null, refusal: expect.stringContaining('A, B') })
  })
})

describe('on the database', () => {
  const OTHER_BUSINESS = 'ebay-send-sku-other'
  const as = (workspaceId: string) => <T>(work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
  const scoped = as(LEGACY_WORKSPACE_ID)
  const ids: Record<string, string> = {}

  const row = (productId: string, account: string, facts: Record<string, unknown> = {}) => prisma.channelListing.create({ data: {
    productId, channel: 'EBAY', marketplace: 'IT', region: 'IT', channelMarket: 'EBAY_IT', channelConnectionId: account, aliasKey: '', ...LIVE, ...facts,
  } as never }).then(r => r.id)

  beforeAll(async () => {
    await scoped(async () => {
      ids.acc = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'ess-a', externalAccountId: 'ess-a', isActive: true, isPrimary: true } as never })).id
      ids.acc2 = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'ess-b', externalAccountId: 'ess-b', isActive: true, isPrimary: false } as never })).id
      const parent = await prisma.product.create({ data: { sku: 'ESS', name: 'ESS', basePrice: 10, isParent: true } as never })
      ids.parent = parent.id
      for (const size of ['S', 'M', 'L', 'XL']) ids[size] = (await prisma.product.create({ data: { sku: `ESS-${size}`, name: size, basePrice: 10, parentId: parent.id } as never })).id
      ids.rootRow = await row(ids.parent, ids.acc, { externalListingId: '501', channelSku: 'ESS-EB' })
      ids.sRow = await row(ids.S, ids.acc, { externalListingId: '501', channelSku: 'OWN-S', liveChannelSku: 'OWN-S' })
      ids.mRow = await row(ids.M, ids.acc, { externalListingId: '501' })
      // A variation not on eBay yet, under the same (main) listing, with its own wanted SKU.
      ids.lRow = await row(ids.L, ids.acc, { ...DRAFT, channelSku: 'NEW-L' })
      // Another account's row of the same product, with its own SKU: never read for this account.
      ids.mOther = await row(ids.M, ids.acc2, { externalListingId: '501', channelSku: 'OTHER-M' })
      ids.alias = (await prisma.productListingAlias.create({ data: { productId: ids.parent, channel: 'EBAY', marketplace: 'IT', channelConnectionId: ids.acc, label: 'Second', position: 1, sku: 'ESS-ALT' } })).id
    })
    await prisma.workspace.create({ data: { id: OTHER_BUSINESS, name: 'Other business', createdByUserId: 'ess', creationKey: 'ess-other' } as never })
  }, 120_000)
  afterAll(async () => { await state.db?.close() })

  it('ebayRowsOnItem: each product\'s wanted SKU on this item and account; no row → the product SKU', () => scoped(async () => {
    const products = ['S', 'M', 'L', 'XL'].map(size => ({ id: ids[size], sku: `ESS-${size}` }))
    const onItem = await ebayRowsOnItem(prisma as never, { itemId: '501', marketplace: 'it', accountId: ids.acc, products })
    expect(Object.fromEntries([...onItem].map(([id, r]) => [id, [r.wanted, r.listingId]]))).toEqual({
      [ids.S]: ['OWN-S', ids.sRow], [ids.M]: ['ESS-M', ids.mRow], [ids.L]: ['NEW-L', ids.lRow], [ids.XL]: ['ESS-XL', null] })
    // The other account's row on the same item number names its own wanted SKU there, and only there.
    const other = await ebayRowsOnItem(prisma as never, { itemId: '501', marketplace: 'IT', accountId: ids.acc2, products })
    expect(other.get(ids.M)).toMatchObject({ wanted: 'OTHER-M', listingId: ids.mOther })
    expect(other.get(ids.S)).toMatchObject({ wanted: 'ESS-S', listingId: null })
  }))

  it('readEbayItemRows + ebayItemLabel: the main row\'s own SKU is the item label on this account only', () => scoped(async () => {
    const rows = await readEbayItemRows(prisma as never, { itemId: '501', marketplace: 'IT', accountId: ids.acc })
    expect(rows.map(r => r.id).sort()).toEqual([ids.rootRow, ids.sRow, ids.mRow].sort())
    expect(ebayItemLabel(rows, 'ESS')).toEqual({ target: 'ESS-EB', keep: ['ESS-EB', 'ESS'], listingId: ids.rootRow, refusal: null })
    expect(await readEbayItemRows(prisma as never, { itemId: '501', marketplace: 'IT', accountId: null })).toEqual([])
  }))

  it('readListingAliases reads the extra listings named, and nothing for rows that are not one', () => scoped(async () => {
    expect(await readListingAliases(prisma as never, [{ aliasId: null }, {}])).toEqual(new Map())
    expect(await readListingAliases(prisma as never, [{ aliasId: ids.alias }])).toEqual(new Map([[ids.alias, { sku: 'ESS-ALT', productId: ids.parent }]]))
  }))

  it('🔴 another business reads none of these rows', () => as(OTHER_BUSINESS)(async () => {
    expect(await readEbayItemRows(prisma as never, { itemId: '501', marketplace: 'IT', accountId: ids.acc })).toEqual([])
    const onItem = await ebayRowsOnItem(prisma as never, { itemId: '501', marketplace: 'IT', accountId: ids.acc, products: [{ id: ids.S, sku: 'ESS-S' }] })
    expect(onItem.get(ids.S)).toMatchObject({ wanted: 'ESS-S', listingId: null })
    expect(await readListingAliases(prisma as never, [{ aliasId: ids.alias }])).toEqual(new Map())
  }))
})
