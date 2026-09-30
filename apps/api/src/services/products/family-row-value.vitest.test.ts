/**
 * P1 (report 2 I-11) — the FAMILY row holds a per-variant attribute's value for its variations, unless it is a variation
 * axis. The studio sheet unlocks that cell (`columnEditableOnRow`), and the Master write contract must accept it by the
 * same rule, or the family row would be editable and every save refused ("Unknown or read-only category attribute").
 *
 * Runs the real `applyProductBulkEdits` on PostgreSQL (PGlite) and reads what was STORED (harness of
 * `master-write-no-market.vitest.test.ts`).
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
let parent = ''
let child = ''

beforeAll(() => scoped(async () => {
  const group = await prisma.attributeGroup.create({ data: { code: 'family-row', label: 'Specifications' } })
  const neckline = await prisma.customAttribute.create({ data: { code: 'neckline', label: 'Neckline', groupId: group.id, type: 'text', scope: 'per_variant' } })
  const colour = await prisma.customAttribute.create({ data: { code: 'color', label: 'Colour', groupId: group.id, type: 'text', scope: 'per_variant' } })
  const jackets = await prisma.productFamily.create({ data: { code: 'family-row-jackets', label: 'Jackets' } })
  for (const attributeId of [neckline.id, colour.id]) await prisma.familyAttribute.create({ data: { familyId: jackets.id, attributeId, channels: [] } })
  parent = (await prisma.product.create({ data: { sku: 'FAMILY-ROW', name: 'Jacket', basePrice: 10, familyId: jackets.id, isParent: true, variationAxes: ['Colore'] } as never })).id
  child = (await prisma.product.create({ data: { sku: 'FAMILY-ROW-BLACK', name: 'Jacket', basePrice: 10, familyId: jackets.id, parentId: parent, categoryAttributes: { variations: { Colore: 'Nero' } } } as never })).id
}), 60_000)
afterAll(async () => { await state.db?.close() })

const save = (id: string, field: string, value: unknown) => scoped(async () => {
  try {
    return await applyProductBulkEdits({ changes: [{ id, field, value, target: 'master' }] } as never,
      { formulaCascade: false, logger: { warn: vi.fn(), error: vi.fn() } }) as any
  } catch (error: any) { return { refused: error?.statusCode, errors: error?.details?.errors, message: error?.details?.error } }
})
const stored = (id: string, key: string) => scoped(async () => ((await prisma.product.findUniqueOrThrow({ where: { id } })).categoryAttributes as any)?.[key])

it('stores the family row’s value of a per-variant attribute that is not an axis', async () => {
  expect(await save(parent, 'attr_neckline', 'Collo alto')).toMatchObject({ updated: 1 })
  expect(await stored(parent, 'neckline')).toBe('Collo alto')
})

it('still refuses the family row a variation axis, and a variation keeps writing its own value', async () => {
  const refused = await save(parent, 'attr_color', 'Nero')
  expect(JSON.stringify(refused)).toContain('Unknown or read-only category attribute')
  expect(await save(child, 'attr_neckline', 'Girocollo')).toMatchObject({ updated: 1 })
  expect(await stored(child, 'neckline')).toBe('Girocollo')
})
