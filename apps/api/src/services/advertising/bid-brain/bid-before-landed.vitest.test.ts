/**
 * Review fix 10-10 (3) — the bid before a floor is the newest bid that LANDED.
 *
 * A LIVE write that did not land (refused at the gate, deferred by the caps, would-apply under SUGGEST) counted with the
 * bid it found: after a Min-bid hour, a money-brake step 2¢ → 13¢ that the caps deferred recorded the 2¢ floor as "the
 * bid before", and every give-back after it went back near the floor, for days. Now such a write is skipped and the newest
 * decision whose bid landed is the bid before; a give-back that did not land is the bid before IT (its goal raise never
 * landed), given back again. Re-review minor — a queued write that failed later in the queue (its typed mutation FAILED,
 * CANCELLED or replaced) did not land either.
 *
 * PGlite (the production schema, business profiles ON). Values are made up (public repo).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'
import { decide, type TargetFacts } from './decide.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => Reflect.get(database.client, key) }) }))
const { loadLowered, previousDecisions } = await import('./load.js')

const DAY = '2026-10-01'
const W = 'bidpage_bid_before_landed'
const inside = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: W, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const row = (targetId: string, at: string, layer: string, action: string, currentCents: number, decidedCents: number, evidence: Record<string, unknown>) => ({
  runId: `run-${at}`, mode: 'LIVE', kind: 'change', marketplace: 'IT', campaignId: 'c-1', adGroupId: 'g-1', targetId, action, layer,
  currentCents, decidedCents, dataDay: new Date(`${DAY}T00:00:00Z`), why: layer, evidence: evidence as never, createdAt: new Date(at),
})
const read = (ids: string[]) => inside(async () => loadLowered(await previousDecisions(ids, new Date('2026-10-10T06:05:00Z'))))
const lightFacts = (current: number, restore: TargetFacts['restore']): TargetFacts => ({
  targetId: 'kw', currentCents: current, dataDay: DAY, chain: [], goal: { target: { kind: 'ACOS', pct: 20 }, band: null, phase: 'PROFIT' },
  limits: { maxBidCents: 80, maxChangePct: 25 }, restore,
})

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [W])
}, 120_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)

describe('the bid before a floor', () => {
  it('a money step from the floor the caps deferred is skipped: the bid before is the goal\'s 15¢ that landed, not the 2¢ floor', async () => {
    await inside(() => database.client.bidBrainDecision.createMany({
      data: [
        row('kw-money', '2026-10-09T06:45:00Z', 'goal', 'write', 10, 15, { sent: { sent: 'queued' } }),
        row('kw-money', '2026-10-09T22:00:00Z', 'min_bid_hour', 'write', 15, 2, { sent: { sent: 'queued' } }),
        row('kw-money', '2026-10-10T06:00:00Z', 'money', 'write', 2, 13, { sent: { sent: 'deferred', why: 'the bid brain\'s caps for this run are used' } }),
        row('kw-money', '2026-10-10T22:00:00Z', 'min_bid_hour', 'hold', 2, 2, {}),
      ],
    }))
    const lowered = (await read(['kw-money'])).get('kw-money')!
    expect(lowered).toMatchObject({ layer: 'min_bid_hour', beforeCents: 15, wrote: true, foundCents: 15 })
    expect(decide(lightFacts(2, lowered)).bidCents).toBe(15)
  })

  it('a give-back that did not land: the bid before IT, never its goal raise', async () => {
    await inside(() => database.client.bidBrainDecision.createMany({
      data: [
        row('kw-back', '2026-10-09T06:45:00Z', 'goal', 'write', 10, 12, { sent: { sent: 'queued' } }),
        row('kw-back', '2026-10-09T22:00:00Z', 'min_bid_hour', 'write', 12, 2, { sent: { sent: 'queued' } }),
        row('kw-back', '2026-10-10T06:00:00Z', 'restore', 'write', 2, 15, { restoreBefore: 12, sent: { sent: 'deferred', why: 'the account ads automation is stopped' } }),
      ],
    }))
    const lowered = (await read(['kw-back'])).get('kw-back')!
    expect(lowered).toMatchObject({ layer: 'restore', heldCents: 2, beforeCents: 12 })
    const d = decide(lightFacts(2, lowered))
    expect([d.layer, d.bidCents, d.restoreBeforeCents]).toEqual(['restore', 12, 12])
  })

  it('a queued write that failed later in the queue is skipped too; a give-back that failed is the bid before it', async () => {
    const mutation = (targetId: string, queueId: string, state: string) => ({ entityType: 'AD_TARGET', entityId: targetId, field: 'bid', state, actor: 'automation:bid-brain', outboundQueueId: queueId })
    await inside(async () => {
      await database.client.bidBrainDecision.createMany({
        data: [
          row('kw-failed', '2026-10-09T00:45:00Z', 'goal', 'write', 8, 10, { sent: { sent: 'queued', outboundQueueId: 'q-ok' } }),
          row('kw-failed', '2026-10-09T06:45:00Z', 'goal', 'write', 10, 15, { sent: { sent: 'queued', outboundQueueId: 'q-failed' } }),
          row('kw-failed', '2026-10-09T22:00:00Z', 'min_bid_hour', 'write', 10, 2, { sent: { sent: 'queued', outboundQueueId: 'q-floor' } }),
          row('kw-rfail', '2026-10-09T06:45:00Z', 'goal', 'write', 10, 12, { sent: { sent: 'queued', outboundQueueId: 'q-r1' } }),
          row('kw-rfail', '2026-10-09T22:00:00Z', 'min_bid_hour', 'write', 12, 2, { sent: { sent: 'queued', outboundQueueId: 'q-r2' } }),
          row('kw-rfail', '2026-10-10T06:00:00Z', 'restore', 'write', 2, 15, { restoreBefore: 12, sent: { sent: 'queued', outboundQueueId: 'q-r3' } }),
        ],
      })
      await database.client.adMutation.createMany({ data: [mutation('kw-failed', 'q-ok', 'APPLIED'), mutation('kw-failed', 'q-failed', 'FAILED'), mutation('kw-rfail', 'q-r3', 'CANCELLED')] })
    })
    const lowered = await read(['kw-failed', 'kw-rfail'])
    expect(lowered.get('kw-failed')).toMatchObject({ beforeCents: 10 })
    expect(lowered.get('kw-rfail')).toMatchObject({ layer: 'restore', beforeCents: 12 })
  })
})

