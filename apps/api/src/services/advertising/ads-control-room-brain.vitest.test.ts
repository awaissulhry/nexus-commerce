/**
 * Ads brain page A4 — the brain on the Control Room's engine board, on a real PostgreSQL (PGlite) with the production
 * schema:
 *
 *   rows       one row per brain writer, family 'brain', no switch of an engine's, no Run now; the writers' keys are the
 *              actor map's (ads-engine-actors.ts), so their 7-day writes and activity are counted
 *   mode       the env from each writer's own reader, bounded by what the brain really does across the enrolled products
 *              (lever-state.ts): a product's state lever at AUTO under the live switch acts; its negatives inside their
 *              shadow days do not; the bid brain from the campaigns it owns, a kill on their bids takes it back to shadow
 *   halt       measured and pinned: a writer whose run reads the posture honours the dial (its words under a halt), the
 *              others are gated (refused at the gate), the three that write nothing by themselves are exempt
 *   drawer     the six writers' evidence by their actors; the three others say why their list is empty
 *   setup      the map's setup view keeps listing the engines only (the brain has its own part there)
 *
 * Values are made up (public repo).
 */
import { readFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})

import { getEngineLevers, type EngineLever } from './ads-control-room.service.js'
import { getEngineDetail } from './ads-control-room-detail.service.js'
import { BRAIN_WRITERS } from './brain/engine-levers.js'
import { ENGINE_ACTORS } from './ads-engine-actors.js'
import { forgetKills } from './brain/kill-switch.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const P = 'a4-jacket'
const DAY = 86_400_000
const BRAIN_KEYS = ['bid-brain', 'brain-money', 'brain-state', 'brain-negatives', 'brain-harvest', 'brain-strategy', 'brain-hours', 'brain-structure', 'brain-cycle']
const board = async () => {
  forgetKills()
  const { levers } = await inside(() => getEngineLevers())
  return new Map(levers.map((l) => [l.key, l]))
}
const brainRows = (levers: Map<string, EngineLever>) => [...levers.values()].filter((l) => l.family === 'brain')

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const c = database.client
    await c.adsAutomationState.create({ data: { id: 'singleton', autonomy: 'AUTO' } })
    await c.product.create({ data: { id: P, sku: 'A4-JACKET', name: 'Jacket', basePrice: '80.00', isParent: true } })
    await c.campaign.create({ data: { id: 'a4-c-live', name: 'Jacket exact', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true } })
    await c.adGroup.create({ data: { id: 'a4-g-live', campaignId: 'a4-c-live', name: 'group' } })
    await c.adProductAd.create({ data: { adGroupId: 'a4-g-live', productId: P, sku: 'A4-JACKET' } })
    await c.bidBrainEnrollment.create({ data: { campaignId: 'a4-c-live', marketplace: 'IT', mode: 'LIVE', enrolledBy: 'user:owner' } })
    await c.adsBrainEnrollment.create({ data: { productId: P, marketplace: 'IT', enrolledBy: 'user:owner', updatedBy: 'user:owner', createdAt: new Date(Date.now() - 3 * DAY) } })
    for (const [key, value] of [['state', 'AUTO'], ['negatives', 'AUTO']] as const) {
      await c.adsBrainOverride.create({ data: { productId: P, marketplace: 'IT', scope: 'PRODUCT', kind: 'LEVEL', key, value, by: 'user:owner' } })
    }
    // One write by the brain's negatives writer in the last 7 days: counted on its row.
    await c.advertisingActionLog.create({ data: { userId: 'automation:ads-brain-negatives', actionType: 'create_negative_keyword', entityType: 'AD_TARGET', entityId: 'a4-neg', payloadBefore: {}, payloadAfter: {} } as never })
  })
}, 180_000)

afterEach(() => {
  for (const k of ['NEXUS_BID_BRAIN_MODE', 'NEXUS_ADS_BRAIN_CYCLE', 'NEXUS_ADS_AUTOMATION_KILL']) vi.stubEnv(k, '')
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('A4 — the brain\'s writers on the engine board', () => {
  it('one row per writer, family brain, no engine switch and no Run now; the writers\' keys are the actor map\'s and their writes count', async () => {
    const levers = await board()
    const rows = brainRows(levers)
    expect(rows.map((l) => l.key)).toEqual(BRAIN_KEYS)
    for (const l of rows) expect(l.control, l.key).toMatchObject({ switch: null, switchable: false, levels: [], ceiling: null })
    const actorKeys = new Set(ENGINE_ACTORS.map((d) => d.key as string))
    for (const w of BRAIN_WRITERS) expect(actorKeys.has(w.key), w.key).toBe(w.writesOnOwn)
    expect(levers.get('brain-negatives')).toMatchObject({ writes7d: 1, activity: 'acted' })
    // Today's server: the brain in shadow — its writers held by their switch, nothing written by them.
    expect(levers.get('brain-state')).toMatchObject({ mode: 'OBSERVE', exposure: { group: 'server-off' }, control: { env: { mode: 'OBSERVE', reason: expect.stringContaining('NEXUS_BID_BRAIN_MODE is shadow') } } })
    const detail = await inside(() => getEngineDetail('brain-state'))
    expect(detail!.run).toMatchObject({ available: false })
  })

  it('under the live switch: the state lever at AUTO acts; the negatives inside their shadow days do not; the bid brain writes the campaign it owns', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    const levers = await board()
    expect(levers.get('brain-state')).toMatchObject({ mode: 'AUTO', exposure: { group: 'acts' }, scope: '1 of 1 enrolled products acting now', modeReason: expect.stringContaining(`${P} in IT (state): AUTO: the brain pauses`) })
    expect(levers.get('brain-negatives')).toMatchObject({ mode: 'OBSERVE', exposure: { group: 'ready' }, modeReason: expect.stringContaining('14 days in shadow first') })
    expect(levers.get('bid-brain')).toMatchObject({ mode: 'AUTO', exposure: { group: 'acts' }, scope: '1 of 1 LIVE / HELD campaigns acting now' })
    // The bidding strategy runs only in the product cycle.
    expect(levers.get('brain-strategy')).toMatchObject({ mode: 'OFF', modeReason: expect.stringContaining('NEXUS_ADS_BRAIN_CYCLE is off') })
    vi.stubEnv('NEXUS_ADS_BRAIN_CYCLE', 'on')
    expect((await board()).get('brain-cycle')).toMatchObject({ mode: 'AUTO', writesOnOwn: false, exposure: { group: 'never' } })
  })

  it('the Owner\'s kill switch on the bids of the campaign it owns: the bid brain is back to shadow on the board', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    const kill = await inside(() => database.client.adsBrainOverride.create({ data: { productId: P, marketplace: 'IT', scope: 'KILL', kind: 'KILL', key: 'bids', value: { products: 'one' } as never, by: 'user:owner', reason: 'a made-up stop' } }))
    try {
      expect((await board()).get('bid-brain')).toMatchObject({ mode: 'OBSERVE', modeReason: expect.stringContaining('kill switch'), scope: '0 of 1 LIVE / HELD campaigns acting now' })
    } finally {
      await inside(() => database.client.adsBrainOverride.update({ where: { id: kill.id }, data: { endedAt: new Date(), endedBy: 'user:owner' } }))
    }
  })

  it('a halt: the writers that read the dial say what they still do; the others are refused at the gate', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    const dial = (data: Record<string, unknown>) => inside(() => database.client.adsAutomationState.update({ where: { id: 'singleton' }, data }))
    await dial({ halted: true, haltReason: 'a made-up test halt' })
    try {
      const levers = await board()
      // The state writer reads the dial itself: the brain only watches the lever (lever-state.ts), the row is off, the halt says why.
      expect(levers.get('brain-state')).toMatchObject({ haltBehaviour: 'honours', mode: 'OFF', modeReason: 'Halted: a made-up test halt', exposure: { group: 'held' } })
      // The negatives writer does not: still evaluating, its writes refused at the gate.
      expect(levers.get('brain-negatives')).toMatchObject({ haltBehaviour: 'gated', mode: 'OFF', warning: 'Still evaluating while stopped — its writes are refused at the gate' })
      expect(levers.get('brain-hours')).toMatchObject({ haltBehaviour: 'exempt' })
    } finally {
      await dial({ halted: false, haltReason: null })
    }
  })

  it('haltBehaviour is measured: a writer honours the dial exactly when its run reads the posture', () => {
    for (const w of BRAIN_WRITERS) {
      if (!w.writesOnOwn) { expect(w.haltBehaviour, w.key).toBe('exempt'); continue }
      const source = w.runs.map((f) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')).join('\n')
      const reads = /\breadEnginePosture\b|\bopenEngineGuard\b/.test(source)
      expect(w.haltBehaviour, `${w.key}: ${w.runs.join(', ')}`).toBe(reads ? 'honours' : 'gated')
    }
  })

  it('the drawer: a writer\'s evidence by its actor; a writer that writes nothing by itself says why', async () => {
    const neg = await inside(() => getEngineDetail('brain-negatives'))
    expect(neg).toMatchObject({ writesEntities: true, evidence: [expect.objectContaining({ actionType: 'create_negative_keyword', entityId: 'a4-neg' })] })
    const hours = await inside(() => getEngineDetail('brain-hours'))
    expect(hours).toMatchObject({ writesEntities: false, evidence: [], evidenceNote: expect.stringContaining('a request a person approves') })
  })

  it('the map\'s setup view lists the engines only: the brain\'s rows are its own part', async () => {
    const { brainSetup } = await import('./brain/read-map.js')
    const out = await inside(() => brainSetup({ market: 'IT' })) as { data: { tools: Array<{ tool: string }> } }
    expect(out.data.tools.map((t) => t.tool)).not.toEqual(expect.arrayContaining(['Bid brain']))
    expect(out.data.tools.some((t) => t.tool.startsWith('Brain '))).toBe(false)
  })
})
