/**
 * Bid-page fix 10-10 — the why view says what became of a bid the brain sent, NOW. The decision stores `sent: queued` when
 * it sends the write; the view showed "queued" for bids Amazon had taken hours before (ad-changes: APPLIED).
 *
 *   sentNow    a queued write reads its delivery state: applied, sending, failed (with Amazon's answer), cancelled,
 *              replaced; its typed mutation first, else its action log; refused / deferred / unknown stay as stored
 *   why view   each LIVE decision's `sent` read through it (PGlite, the production schema, business profiles ON)
 *
 * Values are made up (public repo).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => Reflect.get(database.client, key) }) }))
const { readBidBrain, sentNow } = await import('./read.js')

const queued = { sent: 'queued', actionLogId: 'log-1', outboundQueueId: 'q-1' }

describe('sentNow — a queued write as it stands now', () => {
  it('its mutation\'s state names it; a failed one carries Amazon\'s answer', () => {
    expect(sentNow(queued, { state: 'APPLIED', lastError: null }, null)).toEqual({ ...queued, sent: 'applied', delivery: 'APPLIED' })
    expect(sentNow(queued, { state: 'PENDING', lastError: null }, null)).toEqual({ ...queued, sent: 'queued', delivery: 'PENDING' })
    expect(sentNow(queued, { state: 'IN_FLIGHT', lastError: null }, null)).toMatchObject({ sent: 'sending' })
    expect(sentNow(queued, { state: 'FAILED', lastError: 'bid below the minimum' }, null)).toMatchObject({ sent: 'failed', delivery: 'FAILED', error: 'bid below the minimum' })
    expect(sentNow(queued, { state: 'SUPERSEDED', lastError: null }, null)).toMatchObject({ sent: 'replaced' })
  })
  it('no mutation: its action log (SUCCESS → applied, SKIPPED → cancelled); nothing known → as stored', () => {
    expect(sentNow(queued, null, 'SUCCESS')).toMatchObject({ sent: 'applied', delivery: 'APPLIED' })
    expect(sentNow(queued, null, 'SKIPPED')).toMatchObject({ sent: 'cancelled' })
    expect(sentNow(queued, null, null)).toBe(queued)
    // Review fix 10-10 (4) — every other log status as ads-changes reads it: a cancelled write never reads "queued".
    expect(sentNow(queued, null, 'CANCELLED')).toMatchObject({ sent: 'cancelled', delivery: 'CANCELLED' })
    expect(sentNow(queued, null, 'SUPERSEDED')).toMatchObject({ sent: 'replaced', delivery: 'SUPERSEDED' })
    expect(sentNow(queued, null, 'PENDING')).toMatchObject({ sent: 'queued', delivery: 'PENDING' })
  })
  it('a write that was never queued (refused, deferred) is left as stored', () => {
    const refused = { sent: 'refused', reason: 'the gate' }
    expect(sentNow(refused, { state: 'APPLIED', lastError: null }, 'SUCCESS')).toBe(refused)
  })
})

const W = 'bidpage_why_sent'
const NOW = new Date('2026-10-10T08:00:00Z')
const inside = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: W, actorUserId: null, membershipId: null, roleKeys: [] }, work)

describe('the why view reads it', () => {
  beforeAll(async () => {
    database = await formulaDatabase()
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [W])
  }, 120_000)
  afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)

  it('a restore Amazon took reads applied; one still waiting reads queued; a refused one as it was', async () => {
    const decision = (targetId: string, sent: Record<string, unknown>) => ({
      runId: 'run-1', mode: 'LIVE', kind: 'change', marketplace: 'IT', campaignId: 'c-1', adGroupId: 'g-1', targetId, action: 'write', layer: 'restore',
      currentCents: 2, decidedCents: 15, dataDay: new Date('2026-10-02T00:00:00Z'), why: 'restore: test', evidence: { sent } as never, createdAt: new Date('2026-10-10T06:00:00Z'),
    })
    const mutation = (targetId: string, queueId: string, state: string) => ({
      entityType: 'AD_TARGET', entityId: targetId, field: 'bid', intendedValue: '15', previousValue: '2', state, actor: 'automation:bid-brain', outboundQueueId: queueId,
    })
    await inside(async () => {
      await database.client.bidBrainDecision.createMany({
        data: [
          decision('kw-applied', { sent: 'queued', actionLogId: 'log-a', outboundQueueId: 'q-a' }),
          decision('kw-waiting', { sent: 'queued', actionLogId: 'log-w', outboundQueueId: 'q-w' }),
          decision('kw-refused', { sent: 'refused', reason: 'the gate refused it' }),
        ],
      })
      await database.client.adMutation.createMany({ data: [mutation('kw-applied', 'q-a', 'APPLIED'), mutation('kw-waiting', 'q-w', 'PENDING')] })
    })
    const why = await inside(() => readBidBrain({ view: 'why', market: 'IT' }, { now: NOW })) as { data: { decisions: Array<{ targetId: string; sent?: Record<string, unknown> }>; note: string } }
    const sent = Object.fromEntries(why.data.decisions.map((d) => [d.targetId, d.sent]))
    expect(sent['kw-applied']).toEqual({ sent: 'applied', delivery: 'APPLIED', actionLogId: 'log-a', outboundQueueId: 'q-a' })
    expect(sent['kw-waiting']).toEqual({ sent: 'queued', delivery: 'PENDING', actionLogId: 'log-w', outboundQueueId: 'q-w' })
    expect(sent['kw-refused']).toEqual({ sent: 'refused', reason: 'the gate refused it' })
    expect(why.data.note).toMatch(/applied — Amazon took it/)
  })
})
