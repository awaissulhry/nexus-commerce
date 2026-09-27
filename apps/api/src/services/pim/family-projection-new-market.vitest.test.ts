/**
 * Product-sheet create path, step 4 (the Owner's D1 = A, D2 = A) — the variation theme and the Variants tick on a
 * coordinate where the family has NO listing.
 *
 *   · `PATCH /studio/projection` with version 0 ("I saw no listing") starts the family's draft (parent and variants,
 *     through `ensureDraftListings`) inside its own Serializable transaction and saves the theme on the new parent
 *     draft; the Amazon publisher's reader (`loadStoredVariationProjection`, what `studio-publication-amazon.ts`
 *     resolves the theme through) reads that override back.
 *   · `PATCH /studio/projection/children` starts exactly the rows a tick names (`family: false`).
 *
 * On an in-process PostgreSQL (PGlite) with the generated schema and the production row policies. PGlite is ONE
 * connection, so it cannot show a race: two concurrent token-0 theme saves are proven in
 * family-projection-postgres.vitest.test.ts on a real server. Every id is invented.
 *
 * Run: DATABASE_URL=postgresql://nexus@127.0.0.1:1/nexus_unit_test npx vitest run src/services/pim/family-projection-new-market.vitest.test.ts
 * and again with NEXUS_WORKSPACES_ENABLED=1.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60_000 })
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
/** A controlled Amazon product type: two variation attributes and the theme enum that combines them. */
const DEFINITION = vi.hoisted(() => {
  const attribute = () => ({ type: 'array', minUniqueItems: 1, maxUniqueItems: 1, items: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } })
  return { type: 'object', properties: { item_name: attribute(), color: attribute(), size: attribute(),
    variation_theme: { type: 'array', minUniqueItems: 1, maxUniqueItems: 1, items: { type: 'object', properties: { name: { type: 'string', enum: ['COLOR', 'SIZE', 'COLOR/SIZE', 'SIZE/COLOR'] } }, required: ['name'] } } } }
})
vi.mock('../categories/seller-schema.service.js', async () => {
  const { amazonSpecFromDefinition } = await import('./channel-specs/amazon.js')
  return { amazonSellerSpec: async (_account: string, marketplace: string, productType: string) => amazonSpecFromDefinition({ marketplace, productType, fetchedAt: new Date(), schemaVersion: 'fixture', schemaDefinition: DEFINITION }) }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { getProjectionRead, writeProjectionInclusion, writeProjectionMapping } from './family-projection.service.js'
import { loadStoredVariationProjection } from './stored-variation-projection.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}
let account = ''
const scope = (key: string) => ({ productId: ids[key], channel: 'AMAZON', market: 'SE', accountId: account, includeOrder: false })
const rowsOf = (key: string) => scoped(() => prisma.channelListing.findMany({ where: { productId: { in: [ids[key], ids[`${key}A`], ids[`${key}B`], ids[`${key}C`]].filter(Boolean) } }, orderBy: { productId: 'asc' } }))

async function family(key: string) {
  ids[key] = (await prisma.product.create({ data: { sku: `PJ-${key}`, name: key, basePrice: 10, isParent: true, productType: 'OUTERWEAR', variationAxes: ['Color', 'Size'] } as never })).id
  for (const [variant, color, size] of [['A', 'Red', 'S'], ['B', 'Blue', 'M'], ['C', 'Red', 'M']]) {
    ids[`${key}${variant}`] = (await prisma.product.create({ data: { sku: `PJ-${key}-${variant}`, name: `${key} ${variant}`, basePrice: 10, parentId: ids[key],
      productType: 'OUTERWEAR', categoryAttributes: { variations: { Color: color, Size: size } } } as never })).id
  }
}

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'SE', name: 'Sweden', currency: 'SEK', region: 'EU', language: 'sv', languages: ['sv'], marketplaceId: 'FAKE-SE-ID' } as never })
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'projection', isActive: true, isPrimary: true, externalAccountId: 'FAKE-SELLER' } as never })).id
  await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'SE', productType: 'OUTERWEAR', schemaVersion: 'fixture', schemaDefinition: DEFINITION as never, expiresAt: new Date('2099-01-01') } })
  for (const key of ['theme', 'tick']) await family(key)
}), 120_000)
afterAll(async () => { await state.db?.close() }, 30_000)

describe('the variation theme on a coordinate with no listing', () => {
  it('version 0 starts the family\'s draft and saves the theme on the new parent draft', async () => {
    const before = await scoped(() => getProjectionRead(scope('theme')))
    expect(before.version).toBe(0)
    expect(before.parent.listing.listingId).toBeNull()
    expect(before.variation?.theme?.code).toBe('COLOR/SIZE')   // derived, shown before any save

    const saved = await scoped(() => writeProjectionMapping({ ...scope('theme'), expectedVersion: 0, theme: 'SIZE/COLOR' }))
    const rows = await rowsOf('theme')
    expect(rows).toHaveLength(4)                                  // ONE set: the parent and every variant
    for (const row of rows) {
      expect(row).toMatchObject({ marketplace: 'SE', channelConnectionId: account, aliasKey: '', listingStatus: 'DRAFT', isPublished: false, syncPaused: true, externalListingId: null })
    }
    const parent = rows.find(row => row.productId === ids.theme)!
    expect(parent).toMatchObject({ variationTheme: 'SIZE/COLOR', version: 2 })
    expect(saved.version).toBe(2)
    expect(saved.parent.listing.listingId).toBe(parent.id)
    expect(saved.variation?.source.kind).toBe('override')
    expect(saved.variation?.theme?.code).toBe('SIZE/COLOR')
    expect(saved.children.every(child => child.included)).toBe(true)

    // The Amazon publisher resolves its theme through this reader: it reads the override from the new parent draft.
    const published = await scoped(() => loadStoredVariationProjection({ productId: ids.theme, channel: 'AMAZON', market: 'SE', accountId: account, aliasKey: '' }))
    expect(published.cell.theme?.code).toBe('SIZE/COLOR')
    expect(published.cell.source.kind).toBe('override')
  })

  it('version 0 once the draft exists is a conflict, and the stored theme is untouched', async () => {
    await expect(scoped(() => writeProjectionMapping({ ...scope('theme'), expectedVersion: 0, theme: 'COLOR/SIZE' })))
      .rejects.toMatchObject({ code: 'version_conflict', statusCode: 409 })
    expect((await rowsOf('theme')).find(row => row.productId === ids.theme)).toMatchObject({ variationTheme: 'SIZE/COLOR', version: 2 })
  })

  it('a reset with no listing has nothing to reset and starts no draft', async () => {
    const read = await scoped(() => writeProjectionMapping({ ...scope('tick'), expectedVersion: 0, reset: true }))
    expect(read.version).toBe(0)
    expect(await rowsOf('tick')).toHaveLength(0)
  })
})

describe('the Variants tick on a coordinate with no listing', () => {
  it('starts exactly the parent and the ticked variant; the others stay absent (excluded)', async () => {
    const first = await scoped(() => writeProjectionInclusion({ ...scope('tick'), expectedVersion: 0, changes: [{ id: ids.tickA, included: true }] }))
    let rows = await rowsOf('tick')
    expect(rows.map(row => row.productId).sort()).toEqual([ids.tick, ids.tickA].sort())
    for (const row of rows) expect(row).toMatchObject({ channelConnectionId: account, listingStatus: 'DRAFT', isPublished: false, syncPaused: true })
    expect(first.version).toBe(1)
    expect(first.results).toEqual([expect.objectContaining({ id: ids.tickA, included: true })])

    const second = await scoped(() => writeProjectionInclusion({ ...scope('tick'), expectedVersion: first.version, changes: [{ id: ids.tickB, included: true }] }))
    rows = await rowsOf('tick')
    expect(rows.map(row => row.productId).sort()).toEqual([ids.tick, ids.tickA, ids.tickB].sort())
    expect(second.version).toBe(2)
  })
})
