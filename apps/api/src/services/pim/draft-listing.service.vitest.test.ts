/**
 * Product-sheet create path, step 2 — `ensureDraftListings`, the one place a Nexus-created draft listing is decided
 * (the Owner's D1 = A: a draft is born on the first channel-scope save; D2 = A: it is inert through `syncPaused`).
 *
 * On an in-process PostgreSQL (PGlite) with the generated schema and the production row policies, so the unique key,
 * the column defaults and the business's row security are the real ones. PGlite is ONE connection, so it cannot show a
 * race: two concurrent calls are proven in draft-listing-postgres.vitest.test.ts on a real server. Every id is invented.
 *
 * Run: DATABASE_URL=postgresql://nexus@127.0.0.1:1/nexus_unit_test npx vitest run src/services/pim/draft-listing.service.vitest.test.ts
 * and again with NEXUS_WORKSPACES_ENABLED=1.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { ensureDraftListings, type EnsureDraftListingsInput } from './draft-listing.service.js'

// Production runs with business profiles on: every database call runs inside a business, as real callers do.
const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
/** The caller's transaction, as the sheet's writers will hold one. */
const ensure = (input: Partial<EnsureDraftListingsInput> & { productIds: string[] }) =>
  scoped(() => prisma.$transaction(tx => ensureDraftListings(tx, { channel: 'AMAZON', market: 'SE', ...input })))
const refusal = (input: Partial<EnsureDraftListingsInput> & { productIds: string[] }) => ensure(input).then(
  () => { throw new Error('expected a refusal') }, (error: any) => ({ name: error.name, code: error.code, statusCode: error.statusCode, message: error.message }))
const rowsOf = (productIds: string[], where: Record<string, unknown> = {}) =>
  scoped(() => prisma.channelListing.findMany({ where: { productId: { in: productIds }, ...where }, orderBy: { productId: 'asc' } }))

const ids: Record<string, string> = {}
const accounts: Record<string, string> = {}

async function product(key: string, parent?: string, extra: Record<string, unknown> = {}) {
  ids[key] = (await prisma.product.create({ data: { sku: `DL-${key}`, name: key, basePrice: 10, ...(parent ? { parentId: ids[parent] } : { isParent: true }), ...extra } as never })).id
}

afterAll(async () => { await state.db?.close() })

beforeAll(async () => {
  await scoped(async () => {
    const market = (channel: string, code: string, isActive = true) => prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`,
      currency: 'EUR', region: 'EU', language: 'en', isActive } })
    await market('AMAZON', 'SE')
    await market('AMAZON', 'DE')
    await market('AMAZON', 'XX', false)
    await market('EBAY', 'DE')
    await market('ETSY', 'GLOBAL')
    await market('SHOPIFY', 'GLOBAL')
    await market('WOOCOMMERCE', 'GLOBAL')
    const account = async (key: string, channelType: string, extra: Record<string, unknown> = {}) => {
      accounts[key] = (await prisma.channelConnection.create({ data: { channelType, accountLabel: key, isActive: true,
        externalAccountId: `SELLER-${key}`, authStatus: 'connected', managedBy: 'oauth', ...extra } as never })).id
    }
    await account('amazonPrimary', 'AMAZON', { isPrimary: true })
    await account('amazonSecond', 'AMAZON')
    await account('amazonGone', 'AMAZON', { isActive: false })
    await account('ebayGone', 'EBAY', { isActive: false })
    await account('wooA', 'WOOCOMMERCE')
    await account('wooB', 'WOOCOMMERCE')

    // A GALE-like family: a parent, three live variants and one deleted variant.
    await product('gale')
    for (const size of ['S', 'M', 'L']) await product(`gale${size}`, 'gale')
    await product('galeXL', 'gale', { deletedAt: new Date() })
    // Families for the variant pull, the existing listing, the alias and the account cases.
    for (const family of ['riser', 'live', 'alias', 'named', 'rollback']) {
      await product(family)
      for (const variant of ['A', 'B', 'C']) await product(`${family}${variant}`, family)
    }
    await product('solo', undefined, { isParent: false })
    await product('gone', undefined, { isParent: false, deletedAt: new Date() })

    // `live`: a published listing on Amazon SE for the parent and variant A only — B and C are left out.
    const listed = (key: string) => prisma.channelListing.create({ data: { productId: ids[key], channel: 'AMAZON', marketplace: 'SE', channelMarket: 'AMAZON_SE',
      region: 'SE', channelConnectionId: accounts.amazonPrimary, listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ASIN-${key}`, quantity: 4, price: 99 } })
    await listed('live')
    await listed('liveA')

    // `alias`: a second listing (alias) of the family on Amazon SE, with rows for the parent and variant A only.
    const alias = await prisma.productListingAlias.create({ data: { productId: ids.alias, channel: 'AMAZON', marketplace: 'SE',
      channelConnectionId: accounts.amazonPrimary, label: 'Listing 2' } })
    ids.aliasKey = alias.id
    for (const key of ['alias', 'aliasA']) {
      await prisma.channelListing.create({ data: { productId: ids[key], channel: 'AMAZON', marketplace: 'SE', channelMarket: 'AMAZON_SE', region: 'SE',
        channelConnectionId: accounts.amazonPrimary, aliasKey: alias.id, aliasId: alias.id, listingStatus: 'DRAFT', isPublished: false } })
    }
  })
}, 60_000)

describe('ensureDraftListings — a family draft is born whole and inert', () => {
  it('the parent brings every live variant, each with exactly the draft fields', async () => {
    const result = await ensure({ productIds: [ids.gale], family: true })
    // Parent first, then the variants by SKU; the deleted variant gets nothing.
    expect(result.map(r => r.productId)).toEqual([ids.gale, ids.galeL, ids.galeM, ids.galeS])
    expect(result.every(r => r.created && r.version === 1)).toBe(true)

    const rows = await rowsOf([ids.gale, ids.galeS, ids.galeM, ids.galeL, ids.galeXL])
    expect(rows).toHaveLength(4)
    for (const row of rows) {
      expect(row).toMatchObject({
        workspaceId: LEGACY_WORKSPACE_ID,
        channel: 'AMAZON', marketplace: 'SE', channelMarket: 'AMAZON_SE', region: 'SE',
        channelConnectionId: accounts.amazonPrimary, aliasKey: '', aliasId: null,
        listingStatus: 'DRAFT', isPublished: false, syncPaused: true,
        externalListingId: null, quantity: null, price: null, version: 1,
      })
      expect(result.find(r => r.productId === row.productId)?.id).toBe(row.id)
    }
  })

  it('a second call creates nothing and returns the same ids and versions', async () => {
    const before = await rowsOf([ids.gale, ids.galeS, ids.galeM, ids.galeL])
    const again = await ensure({ productIds: [ids.gale], family: true })
    expect(again.every(r => !r.created)).toBe(true)
    expect(again.map(r => [r.productId, r.id, r.version]).sort()).toEqual(before.map(r => [r.productId, r.id, r.version]).sort())
    // From a variant too: the same set, nothing new.
    const fromVariant = await ensure({ productIds: [ids.galeM], family: true })
    expect(fromVariant.map(r => r.id).sort()).toEqual(before.map(r => r.id).sort())
    expect(fromVariant.every(r => !r.created)).toBe(true)
    expect(await rowsOf([ids.gale, ids.galeS, ids.galeM, ids.galeL])).toHaveLength(4)
  })

  it('a variant brings its parent and its siblings', async () => {
    const result = await ensure({ productIds: [ids.riserB], family: true })
    expect(result.map(r => r.productId)).toEqual([ids.riser, ids.riserA, ids.riserB, ids.riserC])
    expect(result.every(r => r.created)).toBe(true)
  })

  it('an existing listing keeps the variants it leaves out: the asked-for variant joins, the others stay absent', async () => {
    const result = await ensure({ productIds: [ids.liveC], family: true })
    expect(result.map(r => [r.productId, r.created])).toEqual([[ids.live, false], [ids.liveA, false], [ids.liveC, true]])
    expect((await rowsOf([ids.liveB]))).toHaveLength(0)
    // The live rows are returned as they are — not turned into drafts, not paused.
    for (const row of await rowsOf([ids.live, ids.liveA])) {
      expect(row).toMatchObject({ listingStatus: 'ACTIVE', isPublished: true, syncPaused: false, externalListingId: `ASIN-${row.productId === ids.live ? 'live' : 'liveA'}`, version: 1 })
    }
    // Asking for the parent returns the listing as it now stands, and adds nothing.
    expect((await ensure({ productIds: [ids.live], family: true })).map(r => [r.productId, r.created]))
      .toEqual([[ids.live, false], [ids.liveA, false], [ids.liveC, false]])
    expect((await rowsOf([ids.liveB]))).toHaveLength(0)
  })

  it('family: false creates exactly the products asked for', async () => {
    const result = await ensure({ productIds: [ids.solo, ids.namedB], market: 'DE' })
    expect(result.map(r => [r.productId, r.created])).toEqual([[ids.solo, true], [ids.namedB, true]])
    expect(await rowsOf([ids.named, ids.namedA, ids.namedC], { marketplace: 'DE' })).toHaveLength(0)
  })

  it('an empty request writes nothing and checks nothing', async () => {
    expect(await ensure({ productIds: [], channel: 'ETSY', market: 'NOWHERE' })).toEqual([])
  })
})

describe('ensureDraftListings — the account is always explicit', () => {
  it('a named active account is used; the same product may have a draft under each account', async () => {
    const result = await ensure({ productIds: [ids.named], family: true, accountId: accounts.amazonSecond })
    expect(result).toHaveLength(4)
    const rows = await rowsOf([ids.named, ids.namedA, ids.namedB, ids.namedC], { marketplace: 'SE' })
    expect(rows.every(r => r.channelConnectionId === accounts.amazonSecond)).toBe(true)
    // The primary account's coordinate is a different listing.
    const primary = await ensure({ productIds: [ids.named], family: true })
    expect(primary.every(r => r.created)).toBe(true)
    expect(await rowsOf([ids.named], { marketplace: 'SE' })).toHaveLength(2)
  })

  it('a named account that is inactive, or of another channel, is refused — never swapped for the primary', async () => {
    for (const accountId of [accounts.amazonGone, accounts.ebayGone, accounts.wooA, 'no-such-account']) {
      expect(await refusal({ productIds: [ids.rollback], family: true, accountId })).toMatchObject({ name: 'DraftListingError', code: 'ACCOUNT_UNAVAILABLE', statusCode: 409,
        message: 'The selected Amazon account is not connected. Reconnect it or choose another account before listing on SE.' })
    }
    expect(await rowsOf([ids.rollback])).toHaveLength(0)
  })

  it('with no active account there is no draft', async () => {
    expect(await refusal({ productIds: [ids.solo], channel: 'EBAY', market: 'DE' }))
      .toMatchObject({ code: 'NO_ACTIVE_ACCOUNT', message: 'Connect an eBay account before listing on DE.' })
    expect(await refusal({ productIds: [ids.solo], channel: 'ETSY', market: 'GLOBAL' }))
      .toMatchObject({ code: 'NO_ACTIVE_ACCOUNT', message: 'Connect an Etsy account before listing on GLOBAL.' })
    expect(await refusal({ productIds: [ids.solo], channel: 'SHOPIFY', market: 'GLOBAL' }))
      .toMatchObject({ code: 'NO_ACTIVE_ACCOUNT', message: 'Connect a Shopify account before listing on GLOBAL.' })
    expect(await rowsOf([ids.solo], { channel: { in: ['EBAY', 'ETSY', 'SHOPIFY'] } })).toHaveLength(0)
  })

  it('several active accounts and none primary: the caller must name one', async () => {
    expect(await refusal({ productIds: [ids.solo], channel: 'WOOCOMMERCE', market: 'GLOBAL' })).toMatchObject({ code: 'AMBIGUOUS_CONNECTION', statusCode: 409 })
    const named = await ensure({ productIds: [ids.solo], channel: 'WOOCOMMERCE', market: 'GLOBAL', accountId: accounts.wooB })
    expect(named).toMatchObject([{ productId: ids.solo, created: true }])
  })
})

describe('ensureDraftListings — market, product and alias', () => {
  it('an inactive or unknown market is refused, naming it', async () => {
    expect(await refusal({ productIds: [ids.rollback], market: 'XX' }))
      .toMatchObject({ code: 'MARKET_UNAVAILABLE', statusCode: 400, message: 'Amazon · XX is not an active market in this business.' })
    expect(await refusal({ productIds: [ids.rollback], market: 'ZZ' }))
      .toMatchObject({ code: 'MARKET_UNAVAILABLE', message: 'Amazon · ZZ is not an active market in this business.' })
    // A market of another channel is not this channel's market.
    expect(await refusal({ productIds: [ids.rollback], channel: 'EBAY', market: 'SE' })).toMatchObject({ code: 'MARKET_UNAVAILABLE', message: 'eBay · SE is not an active market in this business.' })
    expect(await rowsOf([ids.rollback])).toHaveLength(0)
  })

  it('a deleted product is refused', async () => {
    expect(await refusal({ productIds: [ids.solo, ids.gone] })).toMatchObject({ code: 'PRODUCT_UNAVAILABLE', statusCode: 404 })
    expect(await rowsOf([ids.gone])).toHaveLength(0)
  })

  it('a non-primary alias listing is returned, never created', async () => {
    const [existing] = await rowsOf([ids.alias], { aliasKey: ids.aliasKey })
    expect(await ensure({ productIds: [ids.alias], aliasKey: ids.aliasKey })).toEqual([{ id: existing.id, productId: ids.alias, version: existing.version, created: false }])
    // Variant B has no row under the alias: refused, and nothing is written for the family.
    expect(await refusal({ productIds: [ids.aliasB], aliasKey: ids.aliasKey }))
      .toMatchObject({ code: 'ALIAS_LISTING_MISSING', message: 'This listing alias has no Amazon · SE listing for DL-aliasB. An edit never creates an alias listing.' })
    // With the family: the alias listing exists, so the parent and the asked-for variant are ensured — both are there…
    expect((await ensure({ productIds: [ids.aliasA], aliasKey: ids.aliasKey, family: true })).map(r => [r.productId, r.created]))
      .toEqual([[ids.alias, false], [ids.aliasA, false]])
    // …and a variant the alias leaves out is not added to it.
    expect(await refusal({ productIds: [ids.aliasB], aliasKey: ids.aliasKey, family: true })).toMatchObject({ code: 'ALIAS_LISTING_MISSING' })
    // An alias of another family, or none at all, is no authority.
    expect(await refusal({ productIds: [ids.gale], aliasKey: ids.aliasKey })).toMatchObject({ code: 'LISTING_SCOPE_MISMATCH' })
    expect(await refusal({ productIds: [ids.alias], aliasKey: 'made-up-alias' })).toMatchObject({ code: 'LISTING_SCOPE_MISMATCH' })
    expect(await rowsOf([ids.alias, ids.aliasA, ids.aliasB, ids.aliasC])).toHaveLength(2)
  })

  it('runs in the caller’s transaction: a rollback leaves no draft', async () => {
    await expect(scoped(() => prisma.$transaction(async tx => {
      const created = await ensureDraftListings(tx, { channel: 'AMAZON', market: 'SE', productIds: [ids.rollback], family: true })
      expect(created).toHaveLength(4)
      throw new Error('the caller failed')
    }))).rejects.toThrow('the caller failed')
    expect(await rowsOf([ids.rollback, ids.rollbackA, ids.rollbackB, ids.rollbackC])).toHaveLength(0)
  })
})
