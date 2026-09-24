import { afterAll, beforeAll, expect, it, vi } from 'vitest'

/**
 * PLAN Step 3.6 as re-scoped by A-34 (R-32) — the GATE: the server is the one judge of a pasted or filled value.
 *
 * Measured first (`docs/product-cheat/tools/paste-validity.mts`, the local catalogue, rolled back): the sheet's own save
 * path refuses a value over its column's cap and a value off a closed list, per row, and saves the valid rows of the same
 * request. Nothing asserted it. These arms run the REAL path — `applyProductBulkEdits` → the real column builder reading a
 * cached Amazon·IT category schema — on an in-process PostgreSQL (PGlite): what is stored is the claim, not the response.
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
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('../pim/readiness-index.service.js', () => ({ produceReadiness: vi.fn() }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { applyProductBulkEdits } from './bulk-edit.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const text = (extra: Record<string, unknown>) => ({ type: 'array', maxItems: 1, selectors: ['marketplace_id'],
  items: { type: 'object', properties: { value: { type: 'string', ...extra }, marketplace_id: { const: 'APJ6JRA9NG5V4' } } } })
let account = ''
const ids: string[] = []

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'APJ6JRA9NG5V4' } as never })
  account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'paste-validity', isActive: true, externalAccountId: 'SELLER' } as never })).id
  await prisma.categorySchema.create({ data: { channel: 'AMAZON', marketplace: 'IT', productType: 'COAT', schemaVersion: 'v1', expiresAt: new Date(Date.now() + 86_400_000),
    schemaDefinition: { properties: { color: text({ maxLength: 5 }), voltage: text({ enum: ['A', 'B'] }) } } } })
  for (const sku of ['paste-a', 'paste-b']) {
    const product = await prisma.product.create({ data: { sku, name: sku, basePrice: 10, productType: 'COAT' } })
    await prisma.channelListing.create({ data: { productId: product.id, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU', channelConnectionId: account } })
    ids.push(product.id)
  }
}), 60_000)
afterAll(async () => { await state.db?.close() })

const save = (changes: Array<{ id: string; field: string; value: unknown }>) => scoped(async () => {
  const listings = await prisma.channelListing.findMany({ where: { productId: { in: changes.map(c => c.id) } } })
  try {
    return await applyProductBulkEdits({ changes: changes.map(c => ({ ...c, target: 'channel' })),
      marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT', accountId: account }], expectedVersion: listings[0].version } as never,
      { formulaCascade: false, logger: { warn: vi.fn(), error: vi.fn() } }) as any
  } catch (error: any) { return { refused: error?.statusCode, errors: error?.details?.errors } }
})
const stored = (id: string, key: string) => scoped(async () => ((await prisma.channelListing.findFirstOrThrow({ where: { productId: id } })).overrideData as any)?.[key])

it('🔴 a value over the column\'s cap is refused, named per row, and not stored', async () => {
  const result = await save([{ id: ids[0], field: 'attr_color', value: 'TOOLONG' }])
  expect(result.refused).toBe(400)
  expect(result.errors).toEqual([expect.objectContaining({ id: ids[0], field: 'attr_color', error: expect.stringContaining('at most 5 characters') })])
  expect(await stored(ids[0], 'color')).toBeUndefined()
})

it('🔴 a value off a closed list is refused, named per row, and not stored', async () => {
  const result = await save([{ id: ids[0], field: 'attr_voltage', value: 'C' }])
  expect(result.refused).toBe(400)
  expect(result.errors).toEqual([expect.objectContaining({ id: ids[0], field: 'attr_voltage', error: expect.stringContaining('is not one of the allowed values') })])
  expect(await stored(ids[0], 'voltage')).toBeUndefined()
})

it('control: a valid value is stored', async () => {
  expect(await save([{ id: ids[0], field: 'attr_color', value: 'Nero' }])).toMatchObject({ updated: 1 })
  expect(await stored(ids[0], 'color')).toBe('Nero')
})

it('🔴 a paste across rows is judged PER ROW: the valid row is stored, the bad row is refused by name and not stored', async () => {
  const result = await save([{ id: ids[1], field: 'attr_color', value: 'Blu' }, { id: ids[1], field: 'attr_voltage', value: 'C' }])
  expect(result).toMatchObject({ updated: 1, errors: [expect.objectContaining({ id: ids[1], field: 'attr_voltage' })] })
  expect(await stored(ids[1], 'color')).toBe('Blu')
  expect(await stored(ids[1], 'voltage')).toBeUndefined()
})
