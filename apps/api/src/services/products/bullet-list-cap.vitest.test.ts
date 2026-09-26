import { afterAll, beforeAll, expect, it, vi } from 'vitest'

/**
 * R-57 (A-46) — the per-bullet length cap on bullet WRITES, measured on the REAL save path (`applyProductBulkEdits` → the
 * real column builder over a cached Amazon·IT schema whose `bullet_point` items cap at 20) on PGlite.
 *
 * Measured (B1, 2026-09-23): every bullets change is localizable content, so it leaves `applyProductBulkEdits` for
 * `applyContentBulk` (`bulk-edit.service.ts:592`) and is judged by `coerceForShape(column, value)`
 * (`content-bulk-write.ts:68`) — the legacy whole-list branches (`:851`, `:990`) and the slot cap (`:767`) are never
 * reached by a bullets write (a probe over 23 files: 544 changes through that loop, 0 bullets).
 *   · CHANNEL scope: a slot over the cap is refused per row (the slot column carries the schema's cap); a whole list is
 *     refused as a shape (`Bullet 1 takes ONE value`), so it cannot bypass the cap.
 *   · MASTER (Shared) scope: the list column carries NO cap (`maxLength` absent, `channels: {}`), so an over-long bullet
 *     was STORED on both the whole-list and the slot write.
 * R-58 (A-47): a master bullet may not exceed the TIGHTEST bullet cap of the coordinates the product (or a child) is listed
 * on, read from each coordinate's own column contract; listed nowhere → no cap; the refusal names the bullet's own number.
 * Fixture caps: Amazon·IT 20, Amazon·DE 30.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn(), { reconcileFamilyReadiness: vi.fn() }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { applyProductBulkEdits } from './bulk-edit.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const CAP = 20
const DE_CAP = 30
const LONG = 'x'.repeat(CAP + 5)
const context = { formulaCascade: false, logger: { warn: vi.fn(), error: vi.fn() } }
let account = ''
let id = ''
const other: Record<'two' | 'de' | 'none' | 'parent', string> = { two: '', de: '', none: '', parent: '' }

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'APJ6JRA9NG5V4' } as never })
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'DE', name: 'Germany', currency: 'EUR', region: 'EU', language: 'de', languages: ['de'], marketplaceId: 'A1PA6795UKMFR9' } as never })
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'bullet-cap', isActive: true, externalAccountId: 'SELLER' } as never })).id
  await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'IT', productType: 'COAT', schemaVersion: 'v1', expiresAt: new Date(Date.now() + 86_400_000),
    schemaDefinition: { properties: { bullet_point: { type: 'array', maxItems: 5, selectors: ['marketplace_id', 'language_tag'],
      items: { type: 'object', properties: { value: { type: 'string', maxLength: CAP }, language_tag: { type: 'string' }, marketplace_id: { const: 'APJ6JRA9NG5V4' } } } } } } } })
  await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'DE', productType: 'COAT', schemaVersion: 'v1', expiresAt: new Date(Date.now() + 86_400_000),
    schemaDefinition: { properties: { bullet_point: { type: 'array', maxItems: 5, selectors: ['marketplace_id', 'language_tag'],
      items: { type: 'object', properties: { value: { type: 'string', maxLength: DE_CAP }, language_tag: { type: 'string' }, marketplace_id: { const: 'A1PA6795UKMFR9' } } } } } } } })
  const listed = async (sku: string, markets: string[]) => {
    const product = await prisma.product.create({ data: { sku, name: sku, basePrice: 10, productType: 'COAT' } })
    for (const market of markets) await prisma.channelListing.create({ data: { productId: product.id, channel: 'AMAZON', marketplace: market, channelMarket: `AMAZON_${market}`, region: 'EU', channelConnectionId: account } })
    return product.id
  }
  id = await listed('bullet-cap', ['IT'])
  other.two = await listed('bullet-two', ['IT', 'DE'])
  other.de = await listed('bullet-de', ['DE'])
  other.none = await listed('bullet-none', [])
  other.parent = (await prisma.product.create({ data: { sku: 'bullet-parent', name: 'bullet-parent', basePrice: 10, productType: 'COAT', isParent: true } })).id
  const child = await prisma.product.create({ data: { sku: 'bullet-child', name: 'bullet-child', basePrice: 10, productType: 'COAT', parentId: other.parent } })
  await prisma.channelListing.create({ data: { productId: child.id, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU', channelConnectionId: account } })
}), 60_000)
afterAll(async () => { await state.db?.close() })

const pin = () => ({ tier: 'pin', language: 'it', coordinate: { channel: 'AMAZON', market: 'IT', accountId: account } })
const channelSave = (field: string, value: unknown) => scoped(async () => {
  const listing = await prisma.channelListing.findFirstOrThrow({ where: { productId: id } })
  return applyProductBulkEdits({ changes: [{ id, field, value, target: 'channel', contentAddress: pin(), contentAcknowledged: true }],
    marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT', accountId: account, locale: 'it' }], expectedVersion: listing.version } as never, context) as Promise<any>
})
const masterSave = (field: string, value: unknown, productId = id) => scoped(async () => {
  const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
  return applyProductBulkEdits({ changes: [{ id: productId, field, value, contentAddress: { tier: 'source' } }],
    marketplaceContexts: [{ marketplace: 'IT', locale: 'it' }], expectedVersion: product.version } as never, context) as Promise<any>
})
const channelBullets = () => scoped(async () => {
  const listing = await prisma.channelListing.findFirstOrThrow({ where: { productId: id }, include: { translations: true } })
  return { override: listing.bulletPointsOverride, translated: listing.translations.flatMap(t => t.bulletPoints) }
})
const masterBullets = (productId = id) => scoped(async () => (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).bulletPoints)

it('channel: a bullet over the schema cap is refused, named, and nothing is stored', async () => {
  const before = await channelBullets()
  const result = await channelSave('bulletPoints[2]', LONG)
  expect(result.updated).toBe(0)
  expect(result.errors).toEqual([expect.objectContaining({ id, field: 'bulletPoints[2]', error: expect.stringContaining(`at most ${CAP} characters`) })])
  expect(await channelBullets()).toEqual(before)
})

it('channel: the refusal names the slot that was written (Bullet 4, not Bullet 1)', async () => {
  const result = await channelSave('bulletPoints[4]', LONG)
  expect(result.updated).toBe(0)
  expect(result.errors).toEqual([expect.objectContaining({ field: 'bulletPoints[4]', error: expect.stringMatching(/^Bullet 4 takes at most 20 characters/) })])
})

it('channel: a whole list cannot bypass the cap — it is refused as a shape, and nothing is stored', async () => {
  const before = await channelBullets()
  const result = await channelSave('amazon_bulletPoints', ['ok', LONG])
  expect(result.updated).toBe(0)
  expect(result.errors).toEqual([expect.objectContaining({ id, field: 'amazon_bulletPoints', error: expect.stringContaining('takes ONE value') })])
  expect(await channelBullets()).toEqual(before)
})

it('control: a channel bullet AT the cap is stored', async () => {
  const atCap = 'y'.repeat(CAP)
  const result = await channelSave('bulletPoints[2]', atCap)
  expect(result.errors).toEqual([])
  expect((await channelBullets()).translated).toContain(atCap)
})

it('R-58: a master whole list over the listed channel cap is refused, naming the right bullet, and nothing is stored', async () => {
  const before = await masterBullets()
  const result = await masterSave('bulletPoints', ['ok', LONG])
  expect(result.updated).toBe(0)
  expect(result.errors).toEqual([expect.objectContaining({ id, field: 'bulletPoints', error: expect.stringMatching(/^Bullet 2 takes at most 20 characters/) })])
  expect(await masterBullets()).toEqual(before)
})

it('R-58: a master bullet slot over the cap is refused and names its own number', async () => {
  const before = await masterBullets()
  const result = await masterSave('bulletPoints[4]', LONG)
  expect(result.updated).toBe(0)
  expect(result.errors).toEqual([expect.objectContaining({ field: 'bulletPoints[4]', error: expect.stringMatching(/^Bullet 4 takes at most 20 characters/) })])
  expect(await masterBullets()).toEqual(before)
})

it('R-58: listed on IT (20) and DE (30), the TIGHTER cap wins — 25 characters are refused, and the message names Amazon IT', async () => {
  const result = await masterSave('bulletPoints', ['x'.repeat(25)], other.two)
  expect(result.updated).toBe(0)
  expect(result.errors[0].error).toMatch(/takes at most 20 characters — the .*IT.* cap/)
  expect(await masterBullets(other.two)).not.toContain('x'.repeat(25))
})

it('R-58 control: at the tightest cap the master bullet is stored', async () => {
  const atCap = 'y'.repeat(CAP)
  const result = await masterSave('bulletPoints', [atCap], other.two)
  expect(result.errors).toEqual([])
  expect(await masterBullets(other.two)).toEqual([atCap])
})

it('R-58: listed on DE only, the DE cap (30) is read — 25 stored, 31 refused', async () => {
  expect((await masterSave('bulletPoints', ['z'.repeat(25)], other.de)).errors).toEqual([])
  const over = await masterSave('bulletPoints', ['z'.repeat(DE_CAP + 1)], other.de)
  expect(over.errors[0].error).toMatch(/^Bullet 1 takes at most 30 characters/)
  expect(await masterBullets(other.de)).toEqual(['z'.repeat(25)])
})

it('R-58: a parent listed nowhere takes the cap of the child that inherits its bullets (child on Amazon·IT, 20)', async () => {
  const result = await masterSave('bulletPoints', [LONG], other.parent)
  expect(result.updated).toBe(0)
  expect(result.errors[0].error).toMatch(/^Bullet 1 takes at most 20 characters/)
  expect(await masterBullets(other.parent)).toEqual([])
})

it('R-58: a product listed nowhere keeps no cap', async () => {
  const long = 'n'.repeat(900)
  expect((await masterSave('bulletPoints', [long], other.none)).errors).toEqual([])
  expect(await masterBullets(other.none)).toEqual([long])
})
