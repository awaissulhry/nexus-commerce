/**
 * Field stamps on the product sheet (2026-10-13, `sheet-stamp-door.ts`): a sheet write whose row moved goes ahead when
 * the fields it edits did not; a moved field still refuses, with the field as it is now; a text row someone drafted
 * since the read is never marked reviewed; a write without stamps is checked on the version alone, as before.
 *
 * Runs the real door, the real row writer (`applyProductBulkEdits`) and the real sheet read (`getStudioSheet`) on
 * PostgreSQL (PGlite). Every stamp is taken from the sheet read, as the page takes it, and every claim is what was STORED.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as Awaited<ReturnType<typeof import('../../test-support/formula-database.js').formulaDatabase>> | null }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(async () => []), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn(), { reconcileFamilyReadiness: vi.fn() }))
vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('provider calls are forbidden in this fixture') }))

import { sheetCellStamp } from '@nexus/shared/sheet-stamp'
import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { getStudioSheet } from '../pim/studio-sheet.service.js'
import { writeTranslation } from '../pim/translation-write.js'
import { applyProductBulkEdits, type ProductBulkInput } from './bulk-edit.service.js'
import { applyProductBulkSave } from './bulk-save.service.js'
import { applySheetBulkEdits, DRAFT_SINCE_READ } from './sheet-stamp-door.js'

vi.setConfig({ testTimeout: 60_000 })
const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const context = { formulaCascade: false, contentPerRow: true, logger: { warn: vi.fn(), error: vi.fn() } }
const SHARED_IT = [{ marketplace: 'IT', locale: 'it' }]
const SHARED_DE = [{ marketplace: 'IT', locale: 'de' }]
let account = ''
let serial = 0

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'MKT-STAMP-IT' } as never })
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'stamp-door', isActive: true, externalAccountId: 'SELLER-STAMP' } as never })).id
  await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'IT', productType: 'COAT', schemaVersion: 'v1', expiresAt: new Date(Date.now() + 86_400_000),
    schemaDefinition: { properties: { item_name: { type: 'array', maxItems: 1, selectors: ['marketplace_id', 'language_tag'], items: { type: 'object',
      properties: { value: { type: 'string', maxLength: 200 }, language_tag: { type: 'string' }, marketplace_id: { const: 'MKT-STAMP-IT' } } } } } } } })
}), 120_000)
afterAll(async () => { await state.db?.close() }, 30_000)

/** A product (and a variation that inherits its brand), at version 1. */
const family = () => scoped(async () => {
  const n = ++serial
  const parent = await prisma.product.create({ data: { sku: `STAMP-${n}`, name: 'Giacca', description: 'Descrizione', brand: 'Brand P', basePrice: 10, isParent: true, productType: 'COAT' } as never })
  const child = await prisma.product.create({ data: { sku: `STAMP-${n}-S`, name: 'Giacca S', basePrice: 10, parentId: parent.id, productType: 'COAT' } as never })
  return { parent: parent.id, child: child.id }
})
/** The Shared sheet as the page reads it. */
const sharedSheet = (productId: string, locale = 'it') => scoped(() => getStudioSheet({ productId, scope: 'master', market: 'IT', locale }))
const cellOf = (sheet: Awaited<ReturnType<typeof sharedSheet>>, productId: string, key: string) => sheet.rows.find(row => row.id === productId)!.values[key]
/** A change the way the page sends it: its write field, and the stamp of the cell the person edited. */
const stamped = (sheet: Awaited<ReturnType<typeof sharedSheet>>, productId: string, key: string, value: unknown, extra: Record<string, unknown> = {}) => {
  const cell = cellOf(sheet, productId, key)
  return { id: productId, field: cell.writeField, value, column: key, expected: sheetCellStamp(cell), ...(cell.contentAddress ? { contentAddress: cell.contentAddress } : {}),
    ...(cell.contentVersion !== undefined ? { contentVersion: cell.contentVersion } : {}), ...extra }
}
const save = (input: ProductBulkInput) => scoped(async () => {
  try { return { status: 200, body: await applySheetBulkEdits(input, context) as any } }
  catch (error: any) { return { status: error?.statusCode ?? 500, body: error?.details ?? { error: String(error) } } }
})
/** Someone else's own write through the same writer (another tab, another person), at the version they read. */
const otherPerson = (input: ProductBulkInput) => scoped(() => applyProductBulkEdits(input, context))
const product = (id: string) => scoped(() => prisma.product.findUniqueOrThrow({ where: { id }, select: { version: true, brand: true, name: true, description: true } }))
const german = (productId: string) => scoped(() => prisma.productTranslation.findFirstOrThrow({ where: { productId, language: 'de' } }))
const seedGerman = (productId: string) => scoped(() => prisma.productTranslation.create({ data: { productId, language: 'de', name: 'Jacke', description: 'Beschreibung', source: 'manual', reviewedAt: new Date(), version: 1 } as never }))

it('a sale or a cascade moving the row does not refuse an edit of a field it did not touch', async () => {
  const { parent } = await family()
  const sheet = await sharedSheet(parent)
  // The row moves under the page: a stock change, a cascade — no field the person edits.
  await scoped(() => prisma.product.update({ where: { id: parent }, data: { version: { increment: 1 }, totalStock: 7 } }))
  const answer = await save({ changes: [stamped(sheet, parent, 'brand', 'Brand Q')], marketplaceContexts: SHARED_IT, expectedVersion: 1 } as never)
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  expect(answer.body).toMatchObject({ updated: 1, writtenAt: 2, currentVersion: 3, versionOf: 'product' })
  expect(await product(parent)).toMatchObject({ brand: 'Brand Q', version: 3 })
})

it('another person editing field A does not refuse my edit of field B in the same row, and keeps their A', async () => {
  const { parent } = await family()
  const sheet = await sharedSheet(parent)
  await otherPerson({ changes: [{ id: parent, field: 'brand', value: 'Brand X' }], marketplaceContexts: SHARED_IT, expectedVersion: 1 } as never)
  // My title (a text cell: the Shared product's own Italian text) was read at version 1, like their brand.
  const answer = await save({ changes: [stamped(sheet, parent, 'name', 'Giacca nuova')], marketplaceContexts: SHARED_IT, expectedVersion: 1 } as never)
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  expect(answer.body.writtenAt).toBe(2)
  expect(await product(parent)).toMatchObject({ brand: 'Brand X', name: 'Giacca nuova' })
})

it('my edit of field A is refused when A moved, with A as it is now, and their value stays', async () => {
  const { parent } = await family()
  const sheet = await sharedSheet(parent)
  await otherPerson({ changes: [{ id: parent, field: 'brand', value: 'Brand X' }], marketplaceContexts: SHARED_IT, expectedVersion: 1 } as never)
  const answer = await save({ changes: [stamped(sheet, parent, 'brand', 'Brand Mine')], marketplaceContexts: SHARED_IT, expectedVersion: 1 } as never)
  expect(answer.status).toBe(409)
  expect(answer.body).toMatchObject({ code: 'VERSION_CONFLICT', current: { brand: { value: 'Brand X' } } })
  expect(await product(parent)).toMatchObject({ brand: 'Brand X', version: 2 })
})

it('a value the variation inherited that is now its own on the server refuses — even the same text', async () => {
  const { parent, child } = await family()
  const sheet = await sharedSheet(parent)
  expect(cellOf(sheet, child, 'brand')).toMatchObject({ value: 'Brand P', inherited: true })
  // Another person gives the variation its own brand, the same text it showed: the cell is no longer inherited.
  await otherPerson({ changes: [{ id: child, field: 'brand', value: 'Brand P' }], marketplaceContexts: SHARED_IT, expectedVersion: 1 } as never)
  const answer = await save({ changes: [stamped(sheet, child, 'brand', 'Brand C')], marketplaceContexts: SHARED_IT, expectedVersion: 1 } as never)
  expect(answer.status).toBe(409)
  expect(answer.body.current.brand).toMatchObject({ value: 'Brand P', from: { inherited: false } })
  expect(await product(child)).toMatchObject({ brand: 'Brand P' })
})

it('an AI draft of another field written after the read is never marked reviewed by my write', async () => {
  const { parent } = await family()
  await seedGerman(parent)
  const sheet = await sharedSheet(parent, 'de')
  // The AI translator drafts the German description after the page read the row (as `catalog-translate.ts` writes it).
  await scoped(() => writeTranslation({ productId: parent, locale: 'de', address: { tier: 'language', language: 'de' }, values: { description: 'KI Entwurf' },
    state: 'draft', expectedVersion: 1, expectedTranslationVersion: 1, label: 'Translation draft' }))
  expect((await german(parent)).reviewedAt).toBeNull()
  // My German title still holds its stamp, but saving it would mark the AI's description reviewed.
  const answer = await save({ changes: [stamped(sheet, parent, 'name', 'Jacke neu')], marketplaceContexts: SHARED_DE, expectedVersion: 1 } as never)
  expect(answer.status).toBe(409)
  expect(answer.body).toMatchObject({ error: DRAFT_SINCE_READ, current: {} })
  const stored = await german(parent)
  expect(stored).toMatchObject({ name: 'Jacke', description: 'KI Entwurf', source: 'ai', reviewedAt: null })
})

it('another person’s reviewed edit of one German field does not refuse my edit of another', async () => {
  const { parent } = await family()
  await seedGerman(parent)
  const sheet = await sharedSheet(parent, 'de')
  await scoped(() => writeTranslation({ productId: parent, locale: 'de', address: { tier: 'language', language: 'de' }, values: { description: 'Neue Beschreibung' },
    state: 'reviewed', expectedVersion: 1, expectedTranslationVersion: 1, label: 'Description' }))
  const answer = await save({ changes: [stamped(sheet, parent, 'name', 'Jacke neu')], marketplaceContexts: SHARED_DE, expectedVersion: 1 } as never)
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  const stored = await german(parent)
  expect(stored).toMatchObject({ name: 'Jacke neu', description: 'Neue Beschreibung', source: 'manual' })
  expect(stored.reviewedAt).not.toBeNull()
})

it('a write without stamps is checked on the version alone, as before', async () => {
  const { parent } = await family()
  await scoped(() => prisma.product.update({ where: { id: parent }, data: { version: { increment: 1 } } }))
  const answer = await save({ changes: [{ id: parent, field: 'brand', value: 'Brand Q' }], marketplaceContexts: SHARED_IT, expectedVersion: 1 } as never)
  expect(answer.status).toBe(409)
  expect(answer.body).toMatchObject({ code: 'VERSION_CONFLICT', currentVersion: 2 })
  expect(answer.body.current).toBeUndefined()
  expect(await product(parent)).toMatchObject({ brand: 'Brand P', version: 2 })
})

it('a sheet operation (one bulk save) writes every row whose stamps hold, and refuses only the row whose field moved', async () => {
  const a = await family(), b = await family()
  const sheetA = await sharedSheet(a.parent), sheetB = await sharedSheet(b.parent)
  await scoped(() => prisma.product.update({ where: { id: a.parent }, data: { version: { increment: 1 } } }))
  await otherPerson({ changes: [{ id: b.parent, field: 'brand', value: 'Brand X' }], marketplaceContexts: SHARED_IT, expectedVersion: 1 } as never)
  const answer = await scoped(() => applyProductBulkSave({ units: [
    { key: 'a', changes: [stamped(sheetA, a.parent, 'brand', 'Brand A')], marketplaceContexts: SHARED_IT, expectedVersion: 1 },
    { key: 'b', changes: [stamped(sheetB, b.parent, 'brand', 'Brand B')], marketplaceContexts: SHARED_IT, expectedVersion: 1 },
  ] as never }, context))
  expect(answer.units.map(unit => [unit.key, unit.status])).toEqual([['a', 200], ['b', 409]])
  expect(answer.units[0].body).toMatchObject({ writtenAt: 2 })
  expect(answer.units[1].body).toMatchObject({ current: { brand: { value: 'Brand X' } } })
  expect(await product(a.parent)).toMatchObject({ brand: 'Brand A' })
  expect(await product(b.parent)).toMatchObject({ brand: 'Brand X' })
})

it('a listing whose version moved takes an edit of its pinned title; a listing that moved the title refuses it', async () => {
  const ids = await scoped(async () => {
    const n = ++serial
    const own = await prisma.product.create({ data: { sku: `STAMP-L-${n}`, name: 'Giacca', basePrice: 10, productType: 'COAT' } as never })
    const listing = await prisma.channelListing.create({ data: { productId: own.id, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU', channelConnectionId: account } as never })
    await prisma.channelListingTranslation.create({ data: { channelListingId: listing.id, language: 'it', name: 'Titolo pin', source: 'manual', reviewedAt: new Date(), version: 1 } as never })
    return { product: own.id, listing: listing.id }
  })
  const read = () => scoped(() => getStudioSheet({ productId: ids.product, scope: 'channel', channel: 'AMAZON', market: 'IT', locale: 'it', accountId: account }))
  const sheet = await read()
  const contexts = [{ channel: 'AMAZON', marketplace: 'IT', accountId: account, locale: 'it', aliasKey: '' }]
  const title = (value: string) => ({ ...stamped(sheet, ids.product, 'name', value), target: 'channel' })
  expect(cellOf(sheet, ids.product, 'name')).toMatchObject({ tier: 'pin', contentVersion: 1 })
  // A stock sync moves the listing's version; the pinned title is untouched.
  await scoped(() => prisma.channelListing.update({ where: { id: ids.listing }, data: { version: { increment: 1 } } }))
  const answer = await save({ changes: [title('Titolo nuovo')], marketplaceContexts: contexts, expectedVersion: 1, expectedListingId: ids.listing } as never)
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  expect(answer.body).toMatchObject({ writtenAt: 2, versionOf: 'channelListing' })
  const pinned = await scoped(() => prisma.channelListingTranslation.findFirstOrThrow({ where: { channelListingId: ids.listing, language: 'it' } }))
  expect(pinned.name).toBe('Titolo nuovo')
  // The same edit again, from the same (now old) read: the title moved — by this very write — so it is refused.
  const again = await save({ changes: [title('Titolo altro')], marketplaceContexts: contexts, expectedVersion: 1, expectedListingId: ids.listing } as never)
  expect(again.status).toBe(409)
  // Another listing on the coordinate is not the one the page read.
  const elsewhere = await save({ changes: [title('Titolo altro')], marketplaceContexts: contexts, expectedVersion: 1, expectedListingId: 'another-listing' } as never)
  expect(elsewhere.status).toBe(409)
  expect((await scoped(() => prisma.channelListingTranslation.findFirstOrThrow({ where: { channelListingId: ids.listing, language: 'it' } }))).name).toBe('Titolo nuovo')
})
