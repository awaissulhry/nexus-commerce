/**
 * Step 7, part 1 — `recordLiveListings`, the one place a listing the channel already has is recorded, and the
 * wizard's ASIN write-back that now goes through it.
 *
 * On an in-process PostgreSQL (PGlite) with the generated schema and the production row policies, so the unique keys,
 * the column defaults and the business's row security are the real ones. PGlite is ONE connection, so it cannot show a
 * race: two concurrent calls are proven in live-listing-postgres.vitest.test.ts on a real server. Every id is invented.
 *
 * Run: DATABASE_URL=postgresql://nexus@127.0.0.1:1/nexus_unit_test npx vitest run src/services/pim/live-listing.service.vitest.test.ts
 * and again with NEXUS_WORKSPACES_ENABLED=1.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async importOriginal => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...await importOriginal<any>(), default: state.db.client, prisma: state.db.client }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { recordLiveListings, type RecordLiveListingsInput } from './live-listing.service.js'
import { ensureDraftListings } from './draft-listing.service.js'
import { isVersionConflict } from '../channel-listing-cas.js'
import { SubmissionService } from '../listing-wizard/submission.service.js'

// Production runs with business profiles on: every database call runs inside a business, as real callers do.
const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const record = (input: Partial<RecordLiveListingsInput> & Pick<RecordLiveListingsInput, 'rows'>) =>
  scoped(() => prisma.$transaction(tx => recordLiveListings(tx, { channel: 'AMAZON', market: 'SE', accountId: accounts.amazonPrimary, ...input })))
const refusal = (input: Partial<RecordLiveListingsInput> & Pick<RecordLiveListingsInput, 'rows'>) => record(input).then(
  () => { throw new Error('expected a refusal') }, (error: any) => ({ name: error.name, code: error.code, statusCode: error.statusCode, message: error.message }))
const rowsOf = (productIds: string[], where: Record<string, unknown> = {}) =>
  scoped(() => prisma.channelListing.findMany({ where: { productId: { in: productIds }, ...where }, orderBy: [{ productId: 'asc' }, { marketplace: 'asc' }] }))
const listing = (data: Record<string, unknown>) => scoped(() => prisma.channelListing.create({ data: { channel: 'AMAZON', marketplace: 'SE', channelMarket: 'AMAZON_SE',
  region: 'SE', channelConnectionId: accounts.amazonPrimary, ...data } as never }))

const ids: Record<string, string> = {}
const accounts: Record<string, string> = {}

afterAll(async () => { await state.db?.close() })

beforeAll(async () => {
  await scoped(async () => {
    const market = (channel: string, code: string, isActive = true) => prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`,
      currency: 'EUR', region: 'EU', language: 'en', isActive } })
    await market('AMAZON', 'SE')
    await market('AMAZON', 'IT')
    await market('AMAZON', 'XX', false)
    await market('EBAY', 'UK')
    const account = async (key: string, channelType: string, extra: Record<string, unknown> = {}) => {
      accounts[key] = (await prisma.channelConnection.create({ data: { channelType, accountLabel: key, isActive: true,
        externalAccountId: `SELLER-${key}`, authStatus: 'connected', managedBy: 'oauth', ...extra } as never })).id
    }
    await account('amazonPrimary', 'AMAZON', { isPrimary: true })
    await account('amazonSecond', 'AMAZON')
    await account('amazonGone', 'AMAZON', { isActive: false })
    await account('ebay', 'EBAY', { isPrimary: true })
    for (const key of ['fresh', 'draft', 'held', 'linked', 'legacy', 'legacySecond', 'twice', 'guarded', 'versioned', 'refused', 'gb', 'gbTwice', 'aliased']) {
      ids[key] = (await prisma.product.create({ data: { sku: `LL-${key}`, name: key, basePrice: 10, isParent: key === 'aliased' } })).id
    }
    // A wizard family: a parent and two sizes.
    ids.wizard = (await prisma.product.create({ data: { sku: 'LL-WIZ', name: 'wizard', basePrice: 10, isParent: true } })).id
    for (const size of ['S', 'M']) ids[`wizard${size}`] = (await prisma.product.create({ data: { sku: `LL-WIZ-${size}`, name: `wizard ${size}`, basePrice: 10, parentId: ids.wizard } })).id
  })
}, 60_000)

describe('recordLiveListings — a listing the channel has is recorded live', () => {
  it('a new row gets the account, the market spelling, published, the status and the channel id; create-only fields only on create', async () => {
    const [result] = await record({ rows: [{ productId: ids.fresh, listingStatus: 'BUYABLE', externalListingId: 'ASIN-FRESH',
      fields: { title: 'Fresh' }, createFields: { quantity: 3 } }] })
    expect(result).toMatchObject({ productId: ids.fresh, created: true, adopted: false, unpaused: false, version: 1 })
    const [row] = await rowsOf([ids.fresh])
    expect(row).toMatchObject({ id: result.id, workspaceId: LEGACY_WORKSPACE_ID, channel: 'AMAZON', marketplace: 'SE', channelMarket: 'AMAZON_SE', region: 'SE',
      channelConnectionId: accounts.amazonPrimary, aliasKey: '', aliasId: null, listingStatus: 'BUYABLE', isPublished: true, syncPaused: false,
      externalListingId: 'ASIN-FRESH', title: 'Fresh', quantity: 3 })

    // Recording it again updates the same row: the caller's fields change, the create-only ones do not.
    const [again] = await record({ rows: [{ productId: ids.fresh, listingStatus: 'ACTIVE', externalListingId: 'ASIN-FRESH', fields: { title: 'Fresh 2' }, createFields: { quantity: 99 } }] })
    expect(again).toMatchObject({ id: result.id, created: false, version: 2 })
    expect((await rowsOf([ids.fresh]))).toEqual([expect.objectContaining({ id: result.id, listingStatus: 'ACTIVE', title: 'Fresh 2', quantity: 3 })])
  })

  it('a still-draft becomes live and loses the pause that kept it inert', async () => {
    await scoped(() => prisma.$transaction(tx => ensureDraftListings(tx, { channel: 'AMAZON', market: 'SE', productIds: [ids.draft] })))
    const [draft] = await rowsOf([ids.draft])
    expect(draft).toMatchObject({ listingStatus: 'DRAFT', isPublished: false, syncPaused: true, externalListingId: null })

    const [result] = await record({ rows: [{ productId: ids.draft, listingStatus: 'ACTIVE', externalListingId: 'ASIN-DRAFT' }] })
    expect(result).toMatchObject({ id: draft.id, created: false, unpaused: true, version: draft.version + 1 })
    expect((await rowsOf([ids.draft]))).toEqual([expect.objectContaining({ id: draft.id, listingStatus: 'ACTIVE', isPublished: true, syncPaused: false, externalListingId: 'ASIN-DRAFT' })])
  })

  it("an operator's pause on a live listing stays", async () => {
    const held = await listing({ productId: ids.held, listingStatus: 'ACTIVE', isPublished: true, syncPaused: true, externalListingId: 'ASIN-HELD' })
    const [result] = await record({ rows: [{ productId: ids.held, listingStatus: 'ACTIVE', externalListingId: 'ASIN-HELD', fields: { title: 'Held' } }] })
    expect(result).toMatchObject({ id: held.id, unpaused: false })
    expect((await rowsOf([ids.held]))).toEqual([expect.objectContaining({ syncPaused: true, isPublished: true, title: 'Held' })])

    // A DRAFT row an old creator left published is not a still-draft either: its pause holds too.
    const [draftish] = await rowsOf([ids.held])
    await scoped(() => prisma.channelListing.update({ where: { id: draftish.id }, data: { listingStatus: 'DRAFT', externalListingId: null } }))
    expect((await record({ rows: [{ productId: ids.held, listingStatus: 'ACTIVE' }] }))[0].unpaused).toBe(false)
    expect((await rowsOf([ids.held]))[0].syncPaused).toBe(true)
  })

  it('a different stored channel id is kept and reported, never replaced; a missing one is filled', async () => {
    const linked = await listing({ productId: ids.linked, listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'ASIN-OLD', externalParentId: 'PARENT-OLD' })
    const [result] = await record({ rows: [{ productId: ids.linked, listingStatus: 'ACTIVE', externalListingId: 'ASIN-NEW', externalParentId: 'PARENT-NEW', fields: { title: 'Linked' } }] })
    expect(result).toMatchObject({ id: linked.id, keptExternalListingId: { stored: 'ASIN-OLD', offered: 'ASIN-NEW' }, keptExternalParentId: { stored: 'PARENT-OLD', offered: 'PARENT-NEW' } })
    // The rest of the record is written: only the identity is kept.
    expect((await rowsOf([ids.linked]))[0]).toMatchObject({ externalListingId: 'ASIN-OLD', externalParentId: 'PARENT-OLD', title: 'Linked' })

    await scoped(() => prisma.channelListing.update({ where: { id: linked.id }, data: { externalListingId: null } }))
    const [filled] = await record({ rows: [{ productId: ids.linked, listingStatus: 'ACTIVE', externalListingId: 'ASIN-NEW' }] })
    expect(filled.keptExternalListingId).toBeUndefined()
    expect((await rowsOf([ids.linked]))[0].externalListingId).toBe('ASIN-NEW')
  })

  it('a row saved without an account is adopted by the account that owns unattributed rows, not duplicated', async () => {
    const legacy = await listing({ productId: ids.legacy, channelConnectionId: null, listingStatus: 'DRAFT', isPublished: true })
    const [result] = await record({ rows: [{ productId: ids.legacy, listingStatus: 'ACTIVE', externalListingId: 'ASIN-LEGACY' }] })
    expect(result).toMatchObject({ id: legacy.id, created: false, adopted: true })
    expect(await rowsOf([ids.legacy])).toEqual([expect.objectContaining({ id: legacy.id, channelConnectionId: accounts.amazonPrimary, externalListingId: 'ASIN-LEGACY', isPublished: true })])

    // The second account is not the one an unattributed row belongs to: it gets its own row and the old one stays.
    const other = await listing({ productId: ids.legacySecond, channelConnectionId: null, listingStatus: 'ACTIVE' })
    const [second] = await record({ accountId: accounts.amazonSecond, rows: [{ productId: ids.legacySecond, listingStatus: 'ACTIVE' }] })
    expect(second).toMatchObject({ created: true, adopted: false })
    expect((await rowsOf([ids.legacySecond])).map(r => [r.id === other.id, r.channelConnectionId])).toEqual(expect.arrayContaining([[true, null], [false, accounts.amazonSecond]]))
  })

  it('eBay UK is recorded as UK (EBAY_UK, region GB), and a row an old push wrote as GB is adopted, not duplicated', async () => {
    const [result] = await record({ channel: 'EBAY', market: 'UK', accountId: accounts.ebay, rows: [{ productId: ids.fresh, listingStatus: 'ACTIVE', externalListingId: '110000000001' }] })
    expect(result.created).toBe(true)
    expect(await rowsOf([ids.fresh], { channel: 'EBAY' })).toEqual([expect.objectContaining({ marketplace: 'UK', channelMarket: 'EBAY_UK', region: 'GB', channelConnectionId: accounts.ebay })])

    const gb = await listing({ productId: ids.gb, channel: 'EBAY', marketplace: 'GB', channelMarket: 'EBAY_GB', region: 'GB', channelConnectionId: null, listingStatus: 'ACTIVE', externalListingId: '110000000002' })
    const [adopted] = await record({ channel: 'EBAY', market: 'UK', accountId: accounts.ebay, rows: [{ productId: ids.gb, listingStatus: 'ACTIVE', externalListingId: '110000000002' }] })
    expect(adopted).toMatchObject({ id: gb.id, adopted: true })
    expect(await rowsOf([ids.gb])).toEqual([expect.objectContaining({ id: gb.id, marketplace: 'UK', channelConnectionId: accounts.ebay, region: 'GB' })])
  })

  it('two older rows of one listing are refused: which one is live is not guessed', async () => {
    await listing({ productId: ids.gbTwice, channel: 'EBAY', marketplace: 'GB', channelMarket: 'EBAY_GB', region: 'GB', channelConnectionId: null, listingStatus: 'ACTIVE' })
    await listing({ productId: ids.gbTwice, channel: 'EBAY', marketplace: 'UK', channelMarket: 'EBAY_UK', region: 'GB', channelConnectionId: null, listingStatus: 'ACTIVE' })
    expect(await refusal({ channel: 'EBAY', market: 'UK', accountId: accounts.ebay, rows: [{ productId: ids.gbTwice, listingStatus: 'ACTIVE' }] }))
      .toMatchObject({ name: 'LiveListingError', code: 'LISTING_AMBIGUOUS', message: expect.stringContaining('LL-gbTwice') })
    expect(await rowsOf([ids.gbTwice])).toHaveLength(2)
  })

  it('an alias listing is created with its alias id', async () => {
    const alias = await scoped(() => prisma.productListingAlias.create({ data: { productId: ids.aliased, channel: 'AMAZON', marketplace: 'SE', channelConnectionId: accounts.amazonPrimary, label: 'Listing 2' } }))
    const [result] = await record({ aliasKey: alias.id, rows: [{ productId: ids.aliased, listingStatus: 'ACTIVE', externalListingId: 'ASIN-ALIAS' }] })
    expect(result.created).toBe(true)
    expect(await rowsOf([ids.aliased], { aliasKey: alias.id })).toEqual([expect.objectContaining({ aliasId: alias.id, isPublished: true, syncPaused: false })])
  })

  it("the caller's version and guard are checked on the row it writes", async () => {
    const versioned = await listing({ productId: ids.versioned, listingStatus: 'ACTIVE', version: 4 })
    const conflict = await record({ rows: [{ productId: ids.versioned, listingStatus: 'ACTIVE', expectedVersion: 3 }] }).catch(error => error)
    expect(isVersionConflict(conflict)).toBe(true)
    expect(conflict).toMatchObject({ id: versioned.id, expectedVersion: 3, currentVersion: 4 })
    expect((await record({ rows: [{ productId: ids.versioned, listingStatus: 'ACTIVE', expectedVersion: 4 }] }))[0].version).toBe(5)

    await listing({ productId: ids.guarded, listingStatus: 'ENDED' })
    expect(await refusal({ rows: [{ productId: ids.guarded, listingStatus: 'ACTIVE', guard: { listingStatus: 'DRAFT' } }] })).toMatchObject({ code: 'LISTING_CHANGED' })
    expect((await rowsOf([ids.guarded]))[0].listingStatus).toBe('ENDED')
  })
})

describe('recordLiveListings — refusals write nothing', () => {
  it('no account, an inactive account, another channel\'s account, an inactive market', async () => {
    const rows = [{ productId: ids.refused, listingStatus: 'ACTIVE' }]
    expect(await refusal({ accountId: null as never, rows })).toMatchObject({ code: 'NO_ACCOUNT', statusCode: 400 })
    expect(await refusal({ accountId: '  ', rows })).toMatchObject({ code: 'NO_ACCOUNT' })
    expect(await refusal({ accountId: accounts.amazonGone, rows })).toMatchObject({ code: 'ACCOUNT_UNAVAILABLE', statusCode: 409 })
    expect(await refusal({ accountId: accounts.ebay, rows })).toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
    expect(await refusal({ market: 'XX', rows })).toMatchObject({ code: 'MARKET_UNAVAILABLE', statusCode: 400 })
    expect(await rowsOf([ids.refused])).toHaveLength(0)
  })

  it('a caller may not write a rule-owned field, a status is required, and a product is named once', async () => {
    expect(await refusal({ rows: [{ productId: ids.refused, listingStatus: 'ACTIVE', fields: { syncPaused: true } }] }))
      .toMatchObject({ code: 'INVALID_REQUEST', message: expect.stringContaining('syncPaused') })
    expect(await refusal({ rows: [{ productId: ids.refused, listingStatus: 'ACTIVE', createFields: { channelConnectionId: null } }] })).toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await refusal({ rows: [{ productId: ids.refused, listingStatus: '' }] })).toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await refusal({ rows: [{ productId: ids.refused, listingStatus: 'ACTIVE' }, { productId: ids.refused, listingStatus: 'ACTIVE' }] })).toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await rowsOf([ids.refused])).toHaveLength(0)
  })
})

describe('the wizard ASIN write-back records through the rule', () => {
  const writeBack = () => scoped(() => new SubmissionService(prisma as never).writeAsinsBack({
    productId: ids.wizard, marketplace: 'it', parentAsin: 'PARENT-WIZ', childAsinByMasterSku: { 'LL-WIZ-S': 'ASIN-WIZ-S', 'LL-WIZ-M': 'ASIN-WIZ-M' } }))

  it('the first publish creates the family on the primary account; the second publish updates it instead of hitting the unique key', async () => {
    await writeBack()
    const first = await rowsOf([ids.wizard, ids.wizardS, ids.wizardM])
    expect(first).toHaveLength(3)
    for (const row of first) {
      expect(row).toMatchObject({ channel: 'AMAZON', marketplace: 'IT', channelConnectionId: accounts.amazonPrimary, aliasKey: '', listingStatus: 'ACTIVE', isPublished: true, syncPaused: false })
    }
    expect(first.find(r => r.productId === ids.wizard)).toMatchObject({ externalParentId: 'PARENT-WIZ', platformProductId: 'PARENT-WIZ', externalListingId: null })
    expect(first.find(r => r.productId === ids.wizardS)).toMatchObject({ externalListingId: 'ASIN-WIZ-S', platformProductId: 'ASIN-WIZ-S' })

    await writeBack()
    const second = await rowsOf([ids.wizard, ids.wizardS, ids.wizardM])
    expect(second.map(r => r.id).sort()).toEqual(first.map(r => r.id).sort())
    expect(second.every(r => r.version === 2)).toBe(true)
  })
})
