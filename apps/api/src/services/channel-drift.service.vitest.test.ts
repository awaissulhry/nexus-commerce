import { afterAll, beforeAll, expect, it, vi } from 'vitest'

/**
 * PLAN Step 3.5a (A-36, R-36) — the ONE writer of ChannelDrift, on an in-process PostgreSQL (PGlite): what is STORED is
 * the claim. A source replaces what it compared (differences stored, matches cleared), leaves another source's entries,
 * keeps a checked-and-clean row, and the product list's filter finds a drifted child AND its parent.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { DRIFT_FIELD_CAP, mergeDrift, productIdsWithChannelDrift, recordChannelReadback } from './channel-drift.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids = { parent: '', child: '', childListing: '', other: '', otherListing: '' }
const row = (listingId: string) => scoped(() => prisma.channelDrift.findFirst({ where: { channelListingId: listingId } }))

beforeAll(() => scoped(async () => {
  ids.parent = (await prisma.product.create({ data: { sku: 'drift-parent', name: 'Parent', basePrice: 10, isParent: true } })).id
  ids.child = (await prisma.product.create({ data: { sku: 'drift-child', name: 'Child', basePrice: 10, parentId: ids.parent } })).id
  ids.other = (await prisma.product.create({ data: { sku: 'drift-other', name: 'Other', basePrice: 10 } })).id
  ids.childListing = (await prisma.channelListing.create({ data: { productId: ids.child, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU' } })).id
  ids.otherListing = (await prisma.channelListing.create({ data: { productId: ids.other, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU' } })).id
}), 60_000)
afterAll(async () => { await state.db?.close() })

it('🔴 a difference is stored for its listing; a later read that matches CLEARS it and keeps the row (checked and clean)', async () => {
  await scoped(() => recordChannelReadback({ channelListingId: ids.childListing, channel: 'AMAZON', marketplace: 'IT', source: 'report',
    compared: ['quantity', 'price'], differing: [{ field: 'quantity', ours: 5, theirs: 0 }] }))
  expect(await row(ids.childListing)).toMatchObject({ driftCount: 1, channel: 'AMAZON', marketplace: 'IT',
    driftedFields: [expect.objectContaining({ field: 'quantity', ours: 5, theirs: 0, source: 'report' })] })
  await scoped(() => recordChannelReadback({ channelListingId: ids.childListing, channel: 'AMAZON', marketplace: 'IT', source: 'report',
    compared: ['quantity', 'price'], differing: [] }))
  expect(await row(ids.childListing)).toMatchObject({ driftCount: 0, driftedFields: [] })
})

it('🔴 a source replaces only what IT compared — another source\'s entry, and a field it did not compare, stay', async () => {
  await scoped(() => recordChannelReadback({ channelListingId: ids.childListing, channel: 'AMAZON', marketplace: 'IT', source: 'content',
    compared: ['title'], differing: [{ field: 'title', ours: 'A', theirs: 'B' }] }))
  await scoped(() => recordChannelReadback({ channelListingId: ids.childListing, channel: 'AMAZON', marketplace: 'IT', source: 'report',
    compared: ['price'], differing: [{ field: 'price', ours: 10, theirs: 12 }] }))
  const stored = (await row(ids.childListing))!
  expect(stored.driftCount).toBe(2)
  expect((stored.driftedFields as any[]).map(e => `${e.source}:${e.field}`).sort()).toEqual(['content:title', 'report:price'])
})

it('🔴 the "differs on the channel" filter finds the drifted child AND its parent, and not a clean product', async () => {
  await scoped(() => recordChannelReadback({ channelListingId: ids.otherListing, channel: 'AMAZON', marketplace: 'IT', source: 'report', compared: ['quantity'], differing: [] }))
  const found = await scoped(() => productIdsWithChannelDrift())
  expect(found.sort()).toEqual([ids.parent, ids.child].sort())
})

it('pure: the entries are capped, and a "differing" field that was not compared is ignored', () => {
  const many = Array.from({ length: DRIFT_FIELD_CAP + 7 }, (_, i) => ({ field: `f${i}`, ours: 1, theirs: 2 }))
  expect(mergeDrift([], 's', many.map(f => f.field), many, new Date())).toHaveLength(DRIFT_FIELD_CAP)
  expect(mergeDrift([], 's', ['a'], [{ field: 'b', ours: 1, theirs: 2 }], new Date())).toEqual([])
})
