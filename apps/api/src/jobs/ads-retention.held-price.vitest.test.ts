/**
 * Round 6 (2026-10-01) — the queue's retention sweep keeps a HELD price change, at any age.
 *
 * 🔴 WHAT THIS GUARDS. `runAdsRetentionOnce` deleted every SKIPPED queue row older than 30 days
 * (`outboundSyncQueue.settled`). A held price change is a SKIPPED PRICE_UPDATE (`pim/follower-price.ts`): the price a
 * paused listing (or a draft) is sent when it resumes or goes live. A listing paused for more than 30 days lost it again.
 * Now count, pick and delete all leave held rows out; every other settled row is pruned as before — including a SKIPPED
 * price row with no code or another code, and a paused QUANTITY row (not a held price).
 *
 * Real PostgreSQL in-process (PGlite). Every id is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => null) }))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { runAdsRetentionOnce } from './ads-retention.job.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const OLD = new Date(Date.now() - 45 * 86_400_000)
const ids: Record<string, string> = {}

beforeAll(() => scoped(async () => {
  const row = async (name: string, data: Record<string, unknown>) => {
    ids[name] = (await prisma.outboundSyncQueue.create({ data: { targetChannel: 'AMAZON', payload: {}, createdAt: OLD, ...data } as never })).id
  }
  await row('heldPaused', { syncType: 'PRICE_UPDATE', syncStatus: 'SKIPPED', errorCode: 'PUSH_SYNC_PAUSED' })
  await row('heldDraft', { syncType: 'PRICE_UPDATE', syncStatus: 'SKIPPED', errorCode: 'PRICE_HELD_DRAFT' })
  await row('skippedNoCode', { syncType: 'PRICE_UPDATE', syncStatus: 'SKIPPED', errorCode: null })
  await row('skippedOther', { syncType: 'PRICE_UPDATE', syncStatus: 'SKIPPED', errorCode: 'OUTBOUND_NOT_SENT' })
  await row('pausedQuantity', { syncType: 'QUANTITY_UPDATE', syncStatus: 'SKIPPED', errorCode: 'PUSH_SYNC_PAUSED' })
  // A held Amazon handling-time/restock change of a paused listing (amazon-fulfilment-settings): kept, like a held price.
  await row('heldFulfilment', { syncType: 'QUANTITY_UPDATE', syncStatus: 'SKIPPED', errorCode: 'FULFILMENT_HELD_PAUSED', payload: { source: 'AMAZON_FULFILMENT_SETTINGS' } })
  await row('success', { syncType: 'PRICE_UPDATE', syncStatus: 'SUCCESS' })
  await row('cancelled', { syncType: 'PRICE_UPDATE', syncStatus: 'CANCELLED' })
  // A recent settled row is inside the window: kept.
  await row('recent', { syncType: 'PRICE_UPDATE', syncStatus: 'SUCCESS', createdAt: new Date() })
}), 60_000)
afterAll(async () => { await state.db?.close() }, 60_000)

describe('🔴 retention keeps held price changes, prunes the rest', () => {
  it('the dry run counts the 5 prunable rows, not the 3 held ones', () => scoped(async () => {
    const r = await runAdsRetentionOnce({ dryRun: true })
    expect(r.deleted['outboundSyncQueue.settled']).toBe(5)
  }))

  it('the run deletes exactly those 5; the held rows (and the recent one) remain, at 45 days old', () => scoped(async () => {
    const r = await runAdsRetentionOnce({ dryRun: false })
    expect(r.deleted['outboundSyncQueue.settled']).toBe(5)
    const left = await prisma.outboundSyncQueue.findMany({ select: { id: true } })
    expect(left.map((row) => row.id).sort()).toEqual([ids.heldPaused, ids.heldDraft, ids.heldFulfilment, ids.recent].sort())
    // Run again: nothing more is prunable, and the held rows are still there.
    expect((await runAdsRetentionOnce({ dryRun: false })).deleted['outboundSyncQueue.settled']).toBe(0)
    expect(await prisma.outboundSyncQueue.count({ where: { id: { in: [ids.heldPaused, ids.heldDraft] } } })).toBe(2)
  }))
})
