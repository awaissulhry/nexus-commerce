import { afterAll, beforeAll, expect, it, vi } from 'vitest'

/**
 * PLAN A-39 (R-41) — the ONE drift writer's two changes, on an in-process PostgreSQL (PGlite): what is STORED is the claim.
 *   · the TRUE count: a read with 60 differing fields stores 50 and says 60; this read's entries are the ones kept;
 *   · the per-source clock (`checkedBySource`): every write stamps its source; a NOT-COMPARED write moves the clock,
 *     keeps the entries, and does not make the row read as checked.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { DRIFT_FIELD_CAP, recordChannelReadback } from './channel-drift.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const row = (listingId: string) => scoped(() => prisma.channelDrift.findFirst({ where: { channelListingId: listingId } }))
const ids = { a: '', b: '' }
const write = (listingId: string, source: string, compared: string[], differing: Array<{ field: string; ours: unknown; theirs: unknown }>, extra: Record<string, unknown> = {}) =>
  scoped(() => recordChannelReadback({ channelListingId: listingId, channel: 'AMAZON', marketplace: 'DE', source, compared, differing, ...extra }))

beforeAll(() => scoped(async () => {
  for (const key of ['a', 'b'] as const) {
    const productId = (await prisma.product.create({ data: { sku: `clock-${key}`, name: key, basePrice: 10 } })).id
    ids[key] = (await prisma.channelListing.create({ data: { productId, channel: 'AMAZON', marketplace: 'DE', channelMarket: 'AMAZON_DE', region: 'EU' } })).id
  }
}), 60_000)
afterAll(async () => { await state.db?.close() })

it('🔴 60 differing fields → driftCount 60, 50 stored — and this read\'s entries are kept over an older source\'s', async () => {
  await write(ids.a, 'report', ['quantity'], [{ field: 'quantity', ours: 5, theirs: 0 }])
  const many = Array.from({ length: 60 }, (_, i) => ({ field: `f${String(i).padStart(2, '0')}`, ours: 'x', theirs: 'y' }))
  const result = await write(ids.a, 'amazon-content', many.map(f => f.field), many)
  const stored = (await row(ids.a))!
  expect(result.driftCount).toBe(61)
  expect(stored.driftCount).toBe(61)
  expect((stored.driftedFields as any[]).length).toBe(DRIFT_FIELD_CAP)
  // Fresh first: the 50 stored are this read's own; the old 'report' entry gave way. Its COUNT is kept by its clock.
  expect((stored.driftedFields as any[]).every(e => e.source === 'amazon-content')).toBe(true)
  expect((stored.checkedBySource as any)['amazon-content']).toMatchObject({ outcome: 'compared', differing: 60 })
  expect((stored.checkedBySource as any).report).toMatchObject({ outcome: 'compared', differing: 1 })
})

it('🔴 another source\'s entry survives a content write, and both counts add up', async () => {
  await write(ids.b, 'report', ['price'], [{ field: 'price', ours: 10, theirs: 12 }])
  await write(ids.b, 'amazon-content', ['item_name[de_DE]'], [{ field: 'item_name[de_DE]', ours: 'A', theirs: 'B' }])
  const stored = (await row(ids.b))!
  expect(stored.driftCount).toBe(2)
  expect((stored.driftedFields as any[]).map(e => `${e.source}:${e.field}`).sort()).toEqual(['amazon-content:item_name[de_DE]', 'report:price'])
})

it('🔴 NOT COMPARED: the clock moves with the reason; entries stay; lastCheckedAt does not advance', async () => {
  const before = (await row(ids.b))!
  const later = new Date(before.lastCheckedAt.getTime() + 86_400_000)
  await write(ids.b, 'amazon-content', ['item_name[de_DE]'], [], { outcome: 'not_compared', reason: 'Amazon answered 404 — no listing', checkedAt: later })
  const after = (await row(ids.b))!
  expect(after.driftCount).toBe(2)
  expect((after.driftedFields as any[]).length).toBe(2)
  expect(after.lastCheckedAt.getTime()).toBe(before.lastCheckedAt.getTime())
  expect((after.checkedBySource as any)['amazon-content']).toMatchObject({ at: later.toISOString(), outcome: 'not_compared', reason: 'Amazon answered 404 — no listing', differing: 1 })
})

it('a compared write that now matches clears its own entry and its count', async () => {
  await write(ids.b, 'amazon-content', ['item_name[de_DE]'], [])
  const stored = (await row(ids.b))!
  expect(stored.driftCount).toBe(1)
  expect((stored.checkedBySource as any)['amazon-content']).toMatchObject({ outcome: 'compared', differing: 0 })
})
