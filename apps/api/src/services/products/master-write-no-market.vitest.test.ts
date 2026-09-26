/**
 * P8 (docs/attributes/PLAN.md §4.5, §10.8) — a MASTER `attr_*` write needs no market when the business dictionary
 * defines the attribute for the product.
 *
 * Before P8 every `attr_*` write without `marketplaceContexts` was refused ("No marketplace context"), although the
 * Master contract takes its attribute columns from the family dictionary and never from a market's schema. Now:
 *
 *   · a family attribute or a saved attribute is checked by the SAME rules as with a market (a business-strict list
 *     refuses an off-list value, a number refuses text) and stored;
 *   · an attribute the dictionary does not define for this product (an Amazon-only attribute, or another family's)
 *     is still refused, and the message says why;
 *   · a product listed nowhere and a product listed on a market both work.
 *
 * Runs the real `applyProductBulkEdits` on PostgreSQL (PGlite) and reads what was STORED.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('../pim/readiness-index.service.js', async () => (await import('../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { applyProductBulkEdits } from './bulk-edit.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let unlisted = ''
let listed = ''

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'APJ6JRA9NG5V4' } as never })
  await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'no-market', isActive: true, externalAccountId: 'SELLER' } as never })
  const group = await prisma.attributeGroup.create({ data: { code: 'no-market', label: 'Specifications' } })
  const protection = await prisma.customAttribute.create({ data: { code: 'protection_level', label: 'Protection level', groupId: group.id, type: 'select', validation: { optionMode: 'strict' } } })
  const fit = await prisma.customAttribute.create({ data: { code: 'fit', label: 'Fit', groupId: group.id, type: 'select' } })
  const weight = await prisma.customAttribute.create({ data: { code: 'shell_weight', label: 'Shell weight', groupId: group.id, type: 'number' } })
  // In the dictionary, but only in ANOTHER family: not defined for these products.
  const visor = await prisma.customAttribute.create({ data: { code: 'visor_type', label: 'Visor type', groupId: group.id, type: 'text' } })
  for (const [attributeId, code] of [[protection.id, 'level_1'], [protection.id, 'level_2'], [fit.id, 'slim'], [fit.id, 'regular']]) {
    await prisma.attributeOption.create({ data: { attributeId, code, label: code } })
  }
  const jackets = await prisma.productFamily.create({ data: { code: 'no-market-jackets', label: 'Jackets' } })
  const helmets = await prisma.productFamily.create({ data: { code: 'no-market-helmets', label: 'Helmets' } })
  for (const attributeId of [protection.id, fit.id, weight.id]) await prisma.familyAttribute.create({ data: { familyId: jackets.id, attributeId, channels: [] } })
  await prisma.familyAttribute.create({ data: { familyId: helmets.id, attributeId: visor.id, channels: [] } })
  // A value saved outside the family template stays addressable (a "saved attribute").
  unlisted = (await prisma.product.create({ data: { sku: 'NO-MARKET-1', name: 'Unlisted jacket', basePrice: 10, familyId: jackets.id, categoryAttributes: { lining_note: 'Mesh' } } })).id
  listed = (await prisma.product.create({ data: { sku: 'NO-MARKET-2', name: 'Listed jacket', basePrice: 10, familyId: jackets.id } })).id
  await prisma.channelListing.create({ data: { productId: listed, channel: 'AMAZON', marketplace: 'IT', region: 'IT', channelMarket: 'AMAZON_IT' } as never })
}), 60_000)
afterAll(async () => { await state.db?.close() })

// No `marketplaceContexts` at all — the case P8 opens.
const save = (id: string, field: string, value: unknown) => scoped(async () => {
  try {
    return await applyProductBulkEdits({ changes: [{ id, field, value, target: 'master' }] } as never,
      { formulaCascade: false, logger: { warn: vi.fn(), error: vi.fn() } }) as any
  } catch (error: any) { return { refused: error?.statusCode, errors: error?.details?.errors, message: error?.details?.error } }
})
const stored = (id: string, key: string) => scoped(async () => ((await prisma.product.findUniqueOrThrow({ where: { id } })).categoryAttributes as any)?.[key])

it('stores a family attribute with no market, for a product listed nowhere', async () => {
  expect(await save(unlisted, 'attr_protection_level', 'level_2')).toMatchObject({ updated: 1 })
  expect(await stored(unlisted, 'protection_level')).toBe('level_2')
})

it('stores a family attribute with no market, for a product listed on a market', async () => {
  expect(await save(listed, 'attr_fit', 'slim')).toMatchObject({ updated: 1 })
  expect(await stored(listed, 'fit')).toBe('slim')
})

it('keeps the business-strict rule with no market: an off-list value is refused and nothing is stored', async () => {
  const result = await save(listed, 'attr_protection_level', 'level_9')
  expect(result.refused).toBe(400)
  expect(result.errors).toEqual([expect.objectContaining({ field: 'attr_protection_level', error: expect.stringContaining('"level_9" is not one of the allowed values') })])
  expect(await stored(listed, 'protection_level')).toBeUndefined()
})

it('keeps the open-list rule with no market: any value on a non-strict list is stored', async () => {
  expect(await save(unlisted, 'attr_fit', 'Relaxed athletic')).toMatchObject({ updated: 1 })
  expect(await stored(unlisted, 'fit')).toBe('Relaxed athletic')
})

it('keeps the shape rule with no market: text in a number attribute is refused', async () => {
  const result = await save(unlisted, 'attr_shell_weight', 'heavy')
  expect(result.refused).toBe(400)
  expect(result.errors).toEqual([expect.objectContaining({ field: 'attr_shell_weight' })])
  expect(await stored(unlisted, 'shell_weight')).toBeUndefined()
})

it('stores a saved attribute (outside the family template) with no market', async () => {
  expect(await save(unlisted, 'attr_lining_note', 'Quilted')).toMatchObject({ updated: 1 })
  expect(await stored(unlisted, 'lining_note')).toBe('Quilted')
})

it.each([
  ['an attribute no dictionary defines (an Amazon-only attribute)', 'attr_collar_style'],
  ["another family's attribute", 'attr_visor_type'],
])('still refuses %s with no market, and says why', async (_, field) => {
  const result = await save(unlisted, field, 'X')
  expect(result.refused).toBe(400)
  expect(result.errors).toEqual([expect.objectContaining({ field, error: expect.stringContaining('not in the business dictionary for this product') })])
  expect(await stored(unlisted, field.slice(5))).toBeUndefined()
})
