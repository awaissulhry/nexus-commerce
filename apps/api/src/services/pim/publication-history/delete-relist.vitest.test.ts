import { afterAll, beforeAll, expect, it, vi } from 'vitest'

/**
 * Delete and relist, S5 (Owner 2026-10-04) — the publish history shows a Delete and the later relist as TWO runs: the
 * Delete is one Publish (a publication batch whose part is the listing-action engine's Delete), the relist is a later
 * Publish of the content (a studio publication that creates the listing again). Written as the engines leave them, on
 * the real schema; nothing in the history source changed for it.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})

import prisma from '../../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import { listPublicationHistory, parseHistoryQuery } from '../publication-history.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const NOW = new Date(Date.UTC(2026, 9, 4, 18, 0))
const at = (hour: number) => new Date(Date.UTC(2026, 9, 4, hour, 0))
const ids: Record<string, string> = {}

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon IT', region: 'EU', currency: 'EUR', language: 'it', languages: ['it'] } as never })
  ids.user = (await prisma.userProfile.create({ data: { displayName: 'Seller', email: 'seller@delete-relist.test' } as never })).id
  ids.a = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'Amazon A', isActive: true, externalAccountId: 'SELLER-A', authStatus: 'connected', managedBy: 'oauth', region: 'EU' } as never })).id
  ids.root = (await prisma.product.create({ data: { sku: 'GALE', name: 'Gale jacket', basePrice: 10, isParent: true } as never })).id
  ids.m = (await prisma.product.create({ data: { sku: 'GALE-M', name: 'Gale M', basePrice: 10, parentId: ids.root } as never })).id
  ids.listing = (await prisma.channelListing.create({ data: { productId: ids.m, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU',
    channelConnectionId: ids.a, externalListingId: null, listingStatus: 'ACTIVE', isPublished: true } as never })).id
  const destination = { productId: ids.root, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: ids.a, aliasKey: '' }
  // 10:00 — Publish with Action = Delete: one batch, its Delete part done.
  await prisma.bulkOperation.create({ data: { id: 'batch-delete', userId: ids.user, productCount: 1, changeCount: 0, status: 'SENT', kind: 'publication-batch', productId: ids.root,
    createdAt: at(10), changes: { kind: 'publication-batch', children: [] } } as never })
  await prisma.bulkOperation.create({ data: { id: 'la-delete', userId: ids.user, productCount: 2, changeCount: 1, status: 'DONE', kind: 'listing-action', batchId: 'batch-delete',
    ...destination, createdAt: at(10), submittedAt: at(10), completedAt: at(10), summary: { message: '1 of 1 deleted on Amazon · IT.', done: 1, failed: 0, unknown: 0, skipped: 0, notSent: 0 },
    changes: { kind: 'listing-action', action: 'delete', requested: [ids.m], preview: { rows: [{ productId: ids.m, listingId: ids.listing, sku: 'GALE-M', plan: 'send', sentence: 'Deleted.' }] },
      result: { previewId: 'la-delete', action: 'delete', status: 'DONE', message: 'done', rows: [{ productId: ids.m, listingId: ids.listing, sku: 'GALE-M', outcome: 'DONE', message: 'Deleted on Amazon · IT.' }] } } } as never })
  // 15:00 — Action set to Partial update, Publish: the content review creates the listing again.
  await prisma.bulkOperation.create({ data: { id: 'p-relist', userId: ids.user, productCount: 1, changeCount: 1, status: 'ACCEPTED', kind: 'studio-publication', ...destination,
    createdAt: at(15), submittedAt: at(15), completedAt: at(15),
    summary: { products: 1, verified: 0, accepted: 1, failed: 0, submitted: 0, message: 'Amazon processed the feed.' },
    changes: { kind: 'studio-publication', relistProductIds: [ids.m], review: { action: 'create', rows: [{ productId: ids.m, sku: 'GALE-M', title: 'M', existing: false,
      relist: { deletedAt: at(10).toISOString(), oldReference: 'B0OLD00001', asin: null, sentence: 'Lists GALE-M again.', warning: null } }] },
      result: { id: 'p-relist', status: 'ACCEPTED', message: 'stored', results: [{ sku: 'GALE-M', status: 'ACCEPTED' }] } } } as never })
}), 180_000)
afterAll(async () => { await state.db?.close() })

it('a Delete and the later relist are two runs: the Delete Publish, then the create', () => scoped(async () => {
  const { runs } = await listPublicationHistory(await parseHistoryQuery({ limit: 50 }), { now: NOW })
  expect(runs.map(run => [run.id, run.kind, run.state])).toEqual([['p-relist', 'create', 'succeeded'], ['listing-action:batch:batch-delete', 'delete', 'succeeded']])
}))
