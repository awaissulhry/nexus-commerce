/**
 * P6 (docs/attributes/PLAN.md §4.4) — the save rule for a business attribute's list.
 *
 *   · the business made the list strict (`validation.optionMode: 'strict'`) → an off-list value is REFUSED, named;
 *   · the business did not (the default) → any value is stored: the options are suggestions, the dropdown is open.
 *
 * The other half (a CHANNEL's closed list never blocks a save) is `paste-validity.vitest.test.ts`. Both run the real
 * `applyProductBulkEdits` on PostgreSQL and read what was STORED.
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
let productId = ''

beforeAll(() => scoped(async () => {
  // A master `attr_*` write still names the market whose sheet it came from (every caller sends it today; PLAN §4.5
  // removes that need later). The market has no category schema, so only the family dictionary defines the columns.
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'APJ6JRA9NG5V4' } as never })
  await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'save-rule', isActive: true, externalAccountId: 'SELLER' } as never })
  const group = await prisma.attributeGroup.create({ data: { code: 'save-rule', label: 'Specifications' } })
  const protection = await prisma.customAttribute.create({ data: { code: 'protection_level', label: 'Protection level', groupId: group.id, type: 'select', validation: { optionMode: 'strict' } } })
  const fit = await prisma.customAttribute.create({ data: { code: 'fit', label: 'Fit', groupId: group.id, type: 'select' } })
  for (const [attributeId, code] of [[protection.id, 'level_1'], [protection.id, 'level_2'], [fit.id, 'slim'], [fit.id, 'regular']]) {
    await prisma.attributeOption.create({ data: { attributeId, code, label: code } })
  }
  const family = await prisma.productFamily.create({ data: { code: 'save-rule-jackets', label: 'Jackets' } })
  await prisma.familyAttribute.create({ data: { familyId: family.id, attributeId: protection.id, channels: [] } })
  await prisma.familyAttribute.create({ data: { familyId: family.id, attributeId: fit.id, channels: [] } })
  productId = (await prisma.product.create({ data: { sku: 'SAVE-RULE', name: 'Save rule', basePrice: 10, familyId: family.id } })).id
}), 60_000)
afterAll(async () => { await state.db?.close() })

const save = (field: string, value: unknown) => scoped(async () => {
  try {
    return await applyProductBulkEdits({ changes: [{ id: productId, field, value, target: 'master' }], marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT' }] } as never,
      { formulaCascade: false, logger: { warn: vi.fn(), error: vi.fn() } }) as any
  } catch (error: any) { return { refused: error?.statusCode, errors: error?.details?.errors, message: error?.details?.error } }
})
const stored = (key: string) => scoped(async () => ((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).categoryAttributes as any)?.[key])

it('refuses a value off a list the BUSINESS made strict, and stores nothing', async () => {
  const result = await save('attr_protection_level', 'level_9')
  expect(result.refused).toBe(400)
  expect(result.errors).toEqual([expect.objectContaining({ field: 'attr_protection_level', error: expect.stringContaining('"level_9" is not one of the allowed values') })])
  expect(await stored('protection_level')).toBeUndefined()
})

it('control: a value on the strict list is stored', async () => {
  expect(await save('attr_protection_level', 'level_1')).toMatchObject({ updated: 1 })
  expect(await stored('protection_level')).toBe('level_1')
})

it('stores ANY value on a list the business did not make strict — the options are suggestions (the default)', async () => {
  expect(await save('attr_fit', 'Relaxed athletic')).toMatchObject({ updated: 1 })
  expect(await stored('fit')).toBe('Relaxed athletic')
})
