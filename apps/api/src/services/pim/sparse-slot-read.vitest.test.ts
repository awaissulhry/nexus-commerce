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
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
vi.mock('./readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))
vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('provider calls are forbidden in this fixture') }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { applyProductBulkEdits } from '../products/bulk-edit.service.js'
import { getStudioSheet } from './studio-sheet.service.js'
import { resolveBatch } from './mapping/resolve-batch.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const context = { formulaCascade: false, contentPerRow: true, logger: { warn: vi.fn(), error: vi.fn() } }
let account = ''
let serial = 0
beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'APJ6JRA9NG5V4' } })
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'sparse-slot-fixture', isActive: true, externalAccountId: 'FAKE-SLOT-SELLER' } })).id
  await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'IT', productType: 'E2E_SLOT_COAT', schemaVersion: 'sparse-slots', expiresAt: new Date('2099-01-01'),
    schemaDefinition: { type: 'object', required: ['bullet_point'], properties: { bullet_point: { type: 'array', maxItems: 5, selectors: ['marketplace_id', 'language_tag'],
      items: { type: 'object', required: ['value'], properties: { value: { type: 'string', minLength: 1, maxLength: 100, enum: ['First', 'Second', 'Third'] }, language_tag: { type: 'string' }, marketplace_id: { const: 'APJ6JRA9NG5V4' } } } } } } } })
}), 60_000)
afterAll(async () => { vi.unstubAllGlobals(); await state.db?.close() })

async function product() {
  const row = await prisma.product.create({ data: { sku: `E2E-SPARSE-SLOT-${++serial}`, name: 'Sparse slot fixture', basePrice: 10, productType: 'E2E_SLOT_COAT', keywords: ['', '', 'Keyword'] } })
  await prisma.channelListing.create({ data: { productId: row.id, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU', channelConnectionId: account } })
  return row.id
}

async function writeSlot(id: string, index: number, value: string | null) {
  const row = await prisma.product.findUniqueOrThrow({ where: { id } })
  const answer = await applyProductBulkEdits({ changes: [{ id, field: `bulletPoints[${index}]`, value, contentAddress: { tier: 'source' } }],
    marketplaceContexts: [{ marketplace: 'IT', locale: 'it' }], expectedVersion: row.version }, context)
  expect(answer.errors ?? []).toEqual([])
}

async function readSlots(id: string, expected: Array<string | null>) {
  const sheet = await getStudioSheet({ productId: id, scope: 'channel', channel: 'AMAZON', market: 'IT', locale: 'it', accountId: account })
  expect(sheet.meta.mapping?.skippedReason).toBeNull()
  const row = sheet.rows.find(row => row.id === id)!
  expect(expected.map((_, index) => row.values[`bulletPoints_${index + 1}`].value)).toEqual(expected)
  for (let index = 1; index <= expected.length; index++) expect(row.values[`bulletPoints_${index}`].mapped?.errors ?? []).toEqual([])
}

it('keeps a first write to Bullet 3 in slot 3 after the real write and sheet read', () => scoped(async () => {
  const id = await product()
  await writeSlot(id, 3, 'Third')
  expect((await prisma.product.findUniqueOrThrow({ where: { id } })).bulletPoints).toEqual(['', '', 'Third'])
  await readSlots(id, [null, null, 'Third', null, null])
}))

it('keeps a later bullet in place after an earlier bullet is cleared and refilled', () => scoped(async () => {
  const id = await product()
  await writeSlot(id, 1, 'First')
  await writeSlot(id, 3, 'Third')
  await writeSlot(id, 1, null)
  expect((await prisma.product.findUniqueOrThrow({ where: { id } })).bulletPoints).toEqual(['', '', 'Third'])
  await readSlots(id, [null, null, 'Third', null, null])
  await writeSlot(id, 2, 'Second')
  expect((await prisma.product.findUniqueOrThrow({ where: { id } })).bulletPoints).toEqual(['', 'Second', 'Third'])
  await readSlots(id, [null, 'Second', 'Third', null, null])
}))

it('still removes empty members from the default publish resolver and non-slotted Shared view', () => scoped(async () => {
  const id = await product()
  await writeSlot(id, 3, 'Third')
  const resolved = await resolveBatch({ productIds: [id], channel: 'AMAZON', marketplace: 'IT', channelConnectionId: account, locale: 'it' })
  expect(resolved.products[0].cells.bullet_point.value).toEqual(['Third'])
  const shared = await getStudioSheet({ productId: id, scope: 'master', market: 'IT', locale: 'it' })
  expect(shared.rows.find(row => row.id === id)!.values.keywords.value).toEqual(['Keyword'])
  expect((await prisma.product.findUniqueOrThrow({ where: { id } })).bulletPoints).toEqual(['', '', 'Third'])
}))

it('keeps a corrected enum value in its original numbered position', () => scoped(async () => {
  const id = await product()
  await writeSlot(id, 3, 'third')
  expect((await prisma.product.findUniqueOrThrow({ where: { id } })).bulletPoints).toEqual(['', '', 'third'])
  await readSlots(id, [null, null, 'Third', null, null])
}))

it('still reports an actual off-list value without moving it or silently correcting it', () => scoped(async () => {
  const id = await product()
  await writeSlot(id, 3, 'Unknown')
  const sheet = await getStudioSheet({ productId: id, scope: 'channel', channel: 'AMAZON', market: 'IT', locale: 'it', accountId: account })
  const row = sheet.rows.find(row => row.id === id)!
  expect([1, 2, 3].map(index => row.values[`bulletPoints_${index}`].value)).toEqual([null, null, 'Unknown'])
  expect(row.values.bulletPoints_3.mapped?.errors.join(' ')).toMatch(/unaccepted|allowed|enum/i)
  expect((await prisma.product.findUniqueOrThrow({ where: { id } })).bulletPoints).toEqual(['', '', 'Unknown'])
}))

it('does not count a legacy list of empty positions as populated or satisfy its required rule', () => scoped(async () => {
  const id = await product()
  await prisma.product.update({ where: { id }, data: { bulletPoints: ['', '', ''] } })
  const input = { productIds: [id], channel: 'AMAZON', marketplace: 'IT', channelConnectionId: account, locale: 'it' }
  const published = (await resolveBatch(input)).products[0]
  const slotted = (await resolveBatch({ ...input, slotFieldKeys: ['bullet_point'] })).products[0]
  expect(slotted.cells.bullet_point.value).toEqual([])
  expect(slotted.counts).toEqual(published.counts)
  expect(slotted.readiness).toEqual(published.readiness)
  expect(slotted.counts.requiredMissing).toBeGreaterThan(0)
}))
