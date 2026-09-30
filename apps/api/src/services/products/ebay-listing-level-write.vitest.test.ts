/**
 * P1 of fix/product-sheet-editing (report 5 I-1) — eBay takes ONE value per listing for every item specific that is not
 * a variation axis, from the parent listing (`buildSharedListingInput`). A value written on a VARIATION row used to land
 * on the variation's own listing: stored, shown as saved, and never sent. It is now saved where eBay reads it — the
 * parent listing — and the row's own copy is removed. An axis (Colore) stays on its row.
 *
 * On an in-process PostgreSQL (PGlite) with the generated schema, the real column contract read from a cached eBay
 * category, and the real writer. Every id is invented. Run with and without NEXUS_WORKSPACES_ENABLED=1.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 60_000 })
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(async () => []), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))
/** P1 review (10) — the real projection loads, watched: how many run at once. */
const axesCalls = vi.hoisted(() => ({ inFlight: 0, max: 0 }))
vi.mock('../pim/ebay-listing-level.js', async original => {
  const real = await original<typeof import('../pim/ebay-listing-level.js')>()
  return { ...real, loadEbayListingAxes: async (input: Parameters<typeof real.loadEbayListingAxes>[0]) => {
    axesCalls.inFlight++; axesCalls.max = Math.max(axesCalls.max, axesCalls.inFlight)
    try { await new Promise(resolve => setTimeout(resolve, 20)); return await real.loadEbayListingAxes(input) } finally { axesCalls.inFlight-- }
  } }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { applyProductBulkEdits, ProductBulkError } from './bulk-edit.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const context = { formulaCascade: false, contentPerRow: true, logger: { warn: vi.fn(), error: vi.fn() } }
const ids: Record<string, string> = {}
let account = ''
const ebayIT = () => ({ channel: 'EBAY' as const, marketplace: 'IT', accountId: account, locale: 'it', aliasKey: '' })
const listing = (productId: string) => scoped(() => prisma.channelListing.findFirstOrThrow({ where: { productId, channel: 'EBAY', marketplace: 'IT' } }))
const specifics = async (productId: string) => ((await listing(productId)).platformAttributes as { itemSpecifics?: Record<string, unknown> }).itemSpecifics ?? {}
const save = (id: string, change: Record<string, unknown>, expectedVersion?: number) => scoped(async () => {
  try {
    return await applyProductBulkEdits({ changes: [{ id, target: 'channel', intent: 'set', ...change }] as never, marketplaceContexts: [ebayIT()],
      expectedVersion: expectedVersion ?? (await listing(id)).version }, context) as any
  } catch (error) {
    if (error instanceof ProductBulkError) return { status: error.statusCode, ...error.details }
    throw error
  }
})

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } as never })
  account = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'listing-level', isActive: true, isPrimary: true, externalAccountId: 'FAKE-EBAY' } as never })).id
  await prisma.categorySchema.create({ data: { channel: 'EBAY', marketplace: 'IT', productType: '177104', schemaVersion: 'fixture', expiresAt: new Date('2099-01-01'), schemaDefinition: { aspects: [
    { id: 'aspect_Paese di origine', kind: 'enum', label: 'Paese di origine', localizedName: 'Paese di origine', options: ['Pakistan', 'Cina', 'Italia'], enumMode: 'strict', cardinality: 'SINGLE' },
    { id: 'aspect_Color', kind: 'text', label: 'Colore', localizedName: 'Colore', englishName: 'Color', cardinality: 'SINGLE', variantEligible: true },
  ] } as never } })
  ids.parent = (await prisma.product.create({ data: { sku: 'LL-FAM', name: 'Family', basePrice: 10, isParent: true, variationAxes: ['Colore', 'Taglia'] } as never })).id
  for (const key of ['A', 'B']) ids[key] = (await prisma.product.create({ data: { sku: `LL-FAM-${key}`, name: key, basePrice: 10, parentId: ids.parent } as never })).id
  const create = (productId: string, itemSpecifics: Record<string, unknown>) => prisma.channelListing.create({ data: { productId, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'IT',
    channelConnectionId: account, platformAttributes: { categoryId: '177104', itemSpecifics } as never } })
  await create(ids.parent, { 'Paese di origine': 'Pakistan', 'Team name': 'Giacca' })
  await create(ids.A, { 'Paese di origine': 'Cina', Colore: 'Rosso', Genere: 'Uomo' })
  await create(ids.B, { Colore: 'Giallo', Genere: 'Donna' })
  // P1 review (1): a family whose parent has NO eBay listing here, and (5): one whose parent stores '' while a variation
  // supplies the value; (10): two families saved in one request.
  for (const family of ['NOPARENT', 'BLANK']) {
    ids[family] = (await prisma.product.create({ data: { sku: `LL-${family}`, name: family, basePrice: 10, isParent: true, variationAxes: ['Colore'] } as never })).id
    for (const key of ['A', 'B']) ids[`${family}${key}`] = (await prisma.product.create({ data: { sku: `LL-${family}-${key}`, name: key, basePrice: 10, parentId: ids[family] } as never })).id
  }
  await create(ids.NOPARENTA, { 'Paese di origine': 'Cina', Colore: 'Rosso' })
  await create(ids.NOPARENTB, { Colore: 'Giallo' })
  await create(ids.BLANK, { 'Paese di origine': '' })
  await create(ids.BLANKA, { 'Paese di origine': 'Cina', Colore: 'Rosso' })
  await create(ids.BLANKB, { Colore: 'Giallo' })
}), 120_000)
afterAll(async () => { await state.db?.close() }, 30_000)

describe('a listing-level eBay value written on a variation row', () => {
  it('lands on the parent listing, the row\'s own copy is removed, and the answer keeps the row\'s own token', async () => {
    const before = { parent: await listing(ids.parent), a: await listing(ids.A) }
    const result = await save(ids.A, { field: 'attr_paese_di_origine', value: 'Italia' })
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, updated: 1 })
    expect(await specifics(ids.parent)).toMatchObject({ 'Paese di origine': 'Italia' })
    expect(await specifics(ids.A)).not.toHaveProperty('Paese di origine')
    expect(await specifics(ids.A)).toMatchObject({ Colore: 'Rosso' })
    const after = { parent: await listing(ids.parent), a: await listing(ids.A) }
    expect(result).toMatchObject({ currentVersion: after.a.version, versionOf: 'channelListing' })
    expect(after.a.version).toBe(before.a.version + 1)
    expect(result.familyListings).toEqual([{ productId: ids.parent, listingId: after.parent.id, version: after.parent.version }])
    expect(after.parent.version).toBe(before.parent.version + 1)
  })
  it('a value the parent already holds, on a row with no copy of its own, is a no-op (nothing moves)', async () => {
    const before = { parent: await listing(ids.parent), b: await listing(ids.B) }
    const result = await save(ids.B, { field: 'attr_paese_di_origine', value: 'Italia' })
    expect(result).toMatchObject({ success: true, updated: 0 })
    expect((await listing(ids.parent)).version).toBe(before.parent.version)
    expect((await listing(ids.B)).version).toBe(before.b.version)
  })
  it('a reset on a variation row resets the listing\'s value (the parent\'s), where eBay reads it', async () => {
    const result = await save(ids.B, { field: 'attr_paese_di_origine', value: null, intent: 'reset' })
    expect(result, JSON.stringify(result)).toMatchObject({ success: true })
    expect(await specifics(ids.parent)).not.toHaveProperty('Paese di origine')
  })
  it('control: a variation AXIS (Colore) stays on its own row', async () => {
    const parentBefore = await listing(ids.parent)
    const result = await save(ids.B, { field: 'attr_color', value: 'Verde' })
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, updated: 1 })
    expect(await specifics(ids.B)).toMatchObject({ Colore: 'Verde' })
    expect(await specifics(ids.parent)).not.toHaveProperty('Colore')
    expect((await listing(ids.parent)).version).toBe(parentBefore.version)
  })
  it('control: a stale token on the row is still refused (409), and nothing moves on the parent either', async () => {
    const parentBefore = await listing(ids.parent)
    const result = await save(ids.A, { field: 'attr_paese_di_origine', value: 'Cina' }, (await listing(ids.A)).version - 1)
    expect(result.status).toBe(409)
    expect((await listing(ids.parent)).version).toBe(parentBefore.version)
  })
  it('control: on the parent row itself it is an ordinary write', async () => {
    const result = await save(ids.parent, { field: 'attr_paese_di_origine', value: 'Pakistan' })
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, updated: 1 })
    expect(result.familyListings).toBeUndefined()
    expect(await specifics(ids.parent)).toMatchObject({ 'Paese di origine': 'Pakistan' })
  })
})

// P1 item 3 (report 3 I-3.4) — a stored item specific that is not in the category (Genere, Team name) is published; it is a
// column now, so it can be edited and removed. eBay takes one value per listing for it too.
describe('a stored item specific with no category column', () => {
  it('is editable: written on the parent row it lands on the parent listing', async () => {
    const result = await save(ids.parent, { field: 'attr_other_specific_team_name', value: 'Giubbotto' })
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, updated: 1 })
    expect(await specifics(ids.parent)).toMatchObject({ 'Team name': 'Giubbotto' })
  })
  it('is removable: a clear on a variation row empties the listing\'s value on every row, so eBay no longer receives it', async () => {
    const result = await save(ids.B, { field: 'attr_other_specific_genere', value: null })
    expect(result, JSON.stringify(result)).toMatchObject({ success: true })
    for (const id of [ids.parent, ids.A, ids.B]) expect((await specifics(id)).Genere ?? null).toBeNull()
    expect(result.familyListings.map((row: { productId: string }) => row.productId).sort()).toEqual([ids.parent, ids.A].sort())
  })
  it('control: an axis value on the other rows survives the clear', async () => {
    expect(await specifics(ids.A)).toMatchObject({ Colore: 'Rosso' })
  })
})

describe('P1 review', () => {
  it('(1) the parent has no eBay listing here: the value stays on the variation\'s own listing (eBay reads it there) and is never lost', async () => {
    const result = await save(ids.NOPARENTA, { field: 'attr_paese_di_origine', value: 'Italia' })
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, updated: 1 })
    expect(result.errors ?? []).toEqual([])
    expect(await specifics(ids.NOPARENTA)).toMatchObject({ 'Paese di origine': 'Italia', Colore: 'Rosso' })
    expect(result.familyListings).toBeUndefined()
  })
  it('(5) the parent stores \'\' and a variation supplies the value: a clear on the parent row is not a no-op; every copy goes', async () => {
    const result = await save(ids.BLANK, { field: 'attr_paese_di_origine', value: null })
    expect(result, JSON.stringify(result)).toMatchObject({ success: true })
    expect(result.unchanged ?? 0).toBe(0)
    expect((await specifics(ids.BLANKA))['Paese di origine'] ?? null).toBeNull()
    expect(await specifics(ids.BLANKA)).toMatchObject({ Colore: 'Rosso' })
  })
  it('(5b) a clear where no row of the family stores a value is still WRITTEN: the shown value may come from a mapping, and only a stored blank stops it (review 2026-09-30)', async () => {
    const before = await listing(ids.BLANK)
    const result = await save(ids.BLANKB, { field: 'attr_paese_di_origine', value: null })
    expect(result, JSON.stringify(result)).toMatchObject({ success: true })
    expect(result.unchanged ?? 0).toBe(0)
    expect((await listing(ids.BLANK)).version).toBeGreaterThan(before.version)
    expect(await specifics(ids.BLANK)).toHaveProperty('Paese di origine')
  })
  it('(10) two families in one save load their variation projections at the same time', async () => {
    axesCalls.max = 0
    const result = await scoped(async () => applyProductBulkEdits({ changes: [
      { id: ids.A, field: 'attr_paese_di_origine', value: 'Cina', target: 'channel', intent: 'set' },
      { id: ids.BLANKB, field: 'attr_paese_di_origine', value: 'Italia', target: 'channel', intent: 'set' },
    ] as never, marketplaceContexts: [ebayIT()] }, context) as Promise<any>)
    expect(result, JSON.stringify(result)).toMatchObject({ success: true })
    expect(axesCalls.max).toBe(2)
  })
})
