/**
 * Round 6 (2026-10-01) — the outbound queue's Retry never re-sends a HELD price change by hand.
 *
 * 🔴 WHAT THIS GUARDS. `POST /api/outbound-queue/:id/retry` and `bulk-retry` with ids reset ANY row to PENDING. A held
 * price change (`pim/follower-price.ts`: a SKIPPED PRICE_UPDATE kept while its listing is paused or a draft) would then
 * be dispatched with the number it recorded — possibly stale — and lose its held code, so the resume would no longer send
 * it. It waits for the resume or the publish instead: Retry answers 409 `PRICE_HELD` in plain words; a bulk retry leaves
 * it out and says so. An ordinary failed row is still retried; Cancel still cancels a held row (an operator's choice).
 *
 * Real PostgreSQL in-process (PGlite); the routes through Fastify. Every id is invented.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, adsSyncQueue: { add: vi.fn(async () => null) }, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => null) }))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

const A = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const scoped = <T>(work: () => Promise<T>) => withWorkspace(A, work)
let app: FastifyInstance
const ids: Record<string, string> = {}

beforeAll(async () => {
  await scoped(async () => {
    const row = async (name: string, data: Record<string, unknown>) => {
      ids[name] = (await prisma.outboundSyncQueue.create({ data: { targetChannel: 'AMAZON', syncType: 'PRICE_UPDATE', payload: { price: 21 }, ...data } as never })).id
    }
    await row('held', { syncStatus: 'SKIPPED', errorCode: 'PUSH_SYNC_PAUSED', errorMessage: 'Kept in Nexus while this listing’s sync is paused.' })
    await row('heldDraft', { syncStatus: 'SKIPPED', errorCode: 'PRICE_HELD_DRAFT' })
    await row('failed', { syncStatus: 'FAILED', errorCode: 'AMAZON_TRANSIENT' })
    await row('heldToCancel', { syncStatus: 'SKIPPED', errorCode: 'PUSH_SYNC_PAUSED' })
  })
  const { default: routes } = await import('./outbound-queue.routes.js')
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(A, done) })
  await app.register(routes)
  await app.ready()
}, 120_000)
afterAll(async () => { await app?.close(); await state.db?.close() }, 60_000)

const row = (id: string) => scoped(() => prisma.outboundSyncQueue.findUniqueOrThrow({ where: { id } }))

describe('🔴 a held price change is not retried by hand', () => {
  it('Retry on a held row: 409 PRICE_HELD in plain words; the row is untouched', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/outbound-queue/${ids.held}/retry` })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ code: 'PRICE_HELD', error: 'This price is kept in Nexus while the listing is paused or still a draft. It is sent when the listing resumes or is published. Resume the listing to send it now.' })
    expect(await row(ids.held)).toMatchObject({ syncStatus: 'SKIPPED', errorCode: 'PUSH_SYNC_PAUSED' })
  })

  it('a bulk retry by ids retries the failed row and leaves the held ones, saying so', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/outbound-queue/bulk-retry', payload: { ids: [ids.held, ids.heldDraft, ids.failed] } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, count: 1, heldSkipped: 2, note: '2 held price changes were not retried: they are sent when the listing resumes or is published.' })
    expect(await row(ids.failed)).toMatchObject({ syncStatus: 'PENDING', errorCode: null })
    expect(await row(ids.held)).toMatchObject({ syncStatus: 'SKIPPED', errorCode: 'PUSH_SYNC_PAUSED' })
    expect(await row(ids.heldDraft)).toMatchObject({ syncStatus: 'SKIPPED', errorCode: 'PRICE_HELD_DRAFT' })
  })

  it('Cancel on a held row still cancels it: dropping a held change is the operator\'s own choice', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/outbound-queue/${ids.heldToCancel}/cancel` })
    expect(res.statusCode).toBe(200)
    expect((await row(ids.heldToCancel)).syncStatus).toBe('CANCELLED')
  })
})
