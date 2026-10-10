/**
 * Ads brain page A3 — the switchboard (brain/switchboard.ts) on a real PostgreSQL (PGlite), business profiles ON:
 *
 *   server   only the allowlisted switches, each with its value, what its own reader makes of it, its default and its
 *            reader; a matrix of server settings (vi.stubEnv) moves exactly what the readers say
 *   account  the dial, a halt with who and why, and the posture every engine reads
 *   engines  the engine board as the Control Room reads it
 *   brain    each enrolled product's levers: level, source, lock, and what really acts now — negatives at AUTO watch inside
 *            their shadow days and act after, harvest watches under its own switch, a kill makes its lever watch; the
 *            kills in the scope; a product of another business is not found
 *
 * Values are made up (public repo).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../../../lib/queue.js', () => {
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

const A = 'a3_switchboard_alpha'
const B = 'a3_switchboard_beta'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(business(A), work)
const P = 'a3-jacket'
const OTHER = 'a3-helmet-elsewhere'
const DAY = 86_400_000
const SWITCHES = [
  'NEXUS_BID_BRAIN_MODE', 'NEXUS_ADS_BRAIN_CYCLE', 'NEXUS_ADS_BRAIN_HARVEST_MODE', 'NEXUS_ADS_BRAIN_STRUCTURE_MODE', 'NEXUS_ADS_BRAIN_RETIRE',
  'NEXUS_ADS_BRAIN_HOURS', 'NEXUS_BID_BRAIN_NOWCAST', 'NEXUS_BID_BRAIN_INTRADAY', 'NEXUS_BID_BRAIN_EXPLORE', 'NEXUS_BID_BRAIN_HOUR_FACTORS',
  'NEXUS_BID_BRAIN_PROBES', 'NEXUS_BID_BRAIN_RESPONSE', 'NEXUS_ENABLE_AMAZON_ADS_CRON', 'NEXUS_ADS_AUTOMATION_KILL', 'NEXUS_AMAZON_ADS_MODE',
]

const { brainSwitchboard } = await import('./switchboard.js')
const { forgetKills } = await import('./kill-switch.js')
type Data = Record<string, any>
const board = async (args: Record<string, string> = {}) => {
  forgetKills()
  const out = await inA(() => brainSwitchboard(args))
  if ('error' in out) throw new Error(out.error)
  return out.data as Data
}
const level = (key: string, value: unknown, kind = 'LEVEL') => inA(() => database.client.adsBrainOverride.create({ data: { productId: P, marketplace: 'IT', scope: 'PRODUCT', kind, key, value: value as never, by: 'user:owner' } }))

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  for (const w of [A, B]) await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [w])
  await inA(async () => {
    const c = database.client
    await c.adsAutomationState.create({ data: { id: 'singleton', autonomy: 'AUTO' } })
    await c.product.create({ data: { id: P, sku: 'A3-JACKET', name: 'Jacket', basePrice: '80.00', isParent: true } })
    // Enrolled 3 days ago: the negatives lever's 14 shadow days are not run yet.
    await c.adsBrainEnrollment.create({ data: { productId: P, marketplace: 'IT', enrolledBy: 'user:owner', updatedBy: 'user:owner', createdAt: new Date(Date.now() - 3 * DAY) } })
  })
  await level('negatives', 'AUTO')
  await level('harvest', 'AUTO')
  await level('budgets', { dailyBudgetCents: 2000 }, 'LOCK')
  await withWorkspace(business(B), () => database.client.product.create({ data: { id: OTHER, sku: 'A3-HELMET', name: 'Helmet', basePrice: '50.00', isParent: true } }))
}, 120_000)

afterEach(() => {
  for (const name of SWITCHES) vi.stubEnv(name, '')
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('server switches', () => {
  it('only the allowlisted names, each with its value, its reader\'s answer, its default and its reader', async () => {
    vi.stubEnv('NEXUS_A3_SECRET_THING', 'never-shown')
    const server: Data[] = (await board()).server
    expect(server.map((s) => s.name)).toEqual(SWITCHES)
    expect(JSON.stringify(server)).not.toContain('never-shown')
    expect(server.find((s) => s.name === 'NEXUS_BID_BRAIN_MODE')).toEqual({ name: 'NEXUS_BID_BRAIN_MODE', value: null, effective: 'shadow', default: 'shadow', meaning: expect.any(String), reader: 'bid-brain/shadow.ts bidBrainMode' })
    expect(server.find((s) => s.name === 'NEXUS_ADS_BRAIN_HOURS')).toMatchObject({ value: null, effective: 'on', default: 'on' })
  })

  it.each([
    [{ NEXUS_BID_BRAIN_MODE: 'live' }, { NEXUS_BID_BRAIN_MODE: 'live', NEXUS_ADS_BRAIN_HARVEST_MODE: 'shadow' }],
    [{ NEXUS_BID_BRAIN_MODE: 'live', NEXUS_ADS_BRAIN_HARVEST_MODE: 'live' }, { NEXUS_ADS_BRAIN_HARVEST_MODE: 'live', NEXUS_ADS_BRAIN_STRUCTURE_MODE: 'shadow' }],
    [{ NEXUS_ADS_BRAIN_HARVEST_MODE: 'live' }, { NEXUS_BID_BRAIN_MODE: 'shadow', NEXUS_ADS_BRAIN_HARVEST_MODE: 'shadow' }],
    [{ NEXUS_ADS_BRAIN_CYCLE: 'on', NEXUS_ADS_BRAIN_HOURS: '0', NEXUS_BID_BRAIN_PROBES: 'on' }, { NEXUS_ADS_BRAIN_CYCLE: 'on', NEXUS_ADS_BRAIN_HOURS: 'off', NEXUS_BID_BRAIN_PROBES: 'on' }],
    [{ NEXUS_ADS_AUTOMATION_KILL: '1', NEXUS_AMAZON_ADS_MODE: 'live', NEXUS_ENABLE_AMAZON_ADS_CRON: '1' }, { NEXUS_ADS_AUTOMATION_KILL: 'on', NEXUS_AMAZON_ADS_MODE: 'live', NEXUS_ENABLE_AMAZON_ADS_CRON: 'on' }],
  ])('%o reads as %o', async (env, effective) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
    const server = Object.fromEntries(((await board()).server as Data[]).map((s) => [s.name, s]))
    for (const [k, v] of Object.entries(effective)) expect(server[k].effective, k).toBe(v)
    for (const [k, v] of Object.entries(env)) expect(server[k].value, k).toBe(v)
  })
})

describe('the account and the engines', () => {
  it('the dial, a halt with who and why, the posture every engine reads; the engine board as the Control Room reads it', async () => {
    await inA(() => database.client.adsAutomationState.update({ where: { id: 'singleton' }, data: { halted: true, haltReason: 'a made-up test halt', haltedBy: 'user:owner', haltedAt: new Date() } }))
    try {
      const d = await board()
      expect(d.account).toMatchObject({ autonomy: 'AUTO', halted: true, haltedBy: 'user:owner', haltReason: 'a made-up test halt', envKill: false, degraded: false, posture: 'stopped', postureWhy: expect.stringContaining('a made-up test halt') })
      expect((d.engines as Data[]).map((e) => e.key)).toEqual(expect.arrayContaining(['rank-defend', 'auto-bid', 'anomaly-guard']))
      expect((d.engines as Data[]).find((e) => e.key === 'auto-bid')).toMatchObject({ mode: 'OFF', group: expect.any(String), haltBehaviour: 'honours' })
    } finally {
      await inA(() => database.client.adsAutomationState.update({ where: { id: 'singleton' }, data: { halted: false, haltReason: null, haltedBy: null, haltedAt: null } }))
    }
  })
})

describe('the brain\'s products', () => {
  it('each lever: level, source, the Owner\'s lock, and what really acts now', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    const d = await board({ market: 'IT' })
    const [p] = d.brain.products as Data[]
    expect(p).toMatchObject({ productId: P, market: 'IT' })
    // Negatives at AUTO, 3 of 14 shadow days run: it watches and says so.
    expect(p.levers.negatives).toMatchObject({ level: 'AUTO', effective: 'AUTO', source: 'product', by: 'user:owner', acting: { state: 'watches', why: expect.stringContaining('14 days in shadow first') } })
    // Harvest at AUTO under its own shadow switch: it watches, naming the switch.
    expect(p.levers.harvest.acting).toMatchObject({ state: 'watches', why: expect.stringContaining('NEXUS_ADS_BRAIN_HARVEST_MODE') })
    // The budgets lever is locked at his value: the brain does nothing there.
    expect(p.levers.budgets).toMatchObject({ effective: 'LOCKED', lock: { value: { dailyBudgetCents: 2000 }, by: 'user:owner' }, acting: { state: 'off' } })
    expect(p.levers.state).toMatchObject({ level: 'OBSERVE', source: 'default', acting: { state: 'watches' } })
    expect(d.brain).toMatchObject({ ceiling: 'live', cycle: 'off', kills: [] })
  })

  it('the Owner\'s shadow days to 0: the negatives act; a kill on them: they watch, in his words, and the kill is listed', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    await level('negativesShadowDays', 0, 'VALUE')
    expect((await board({ market: 'IT' })).brain.products[0].levers.negatives.acting).toMatchObject({ state: 'acts' })
    await inA(() => database.client.adsBrainOverride.create({ data: { productId: P, marketplace: 'IT', scope: 'KILL', kind: 'KILL', key: 'negatives', value: { products: 'one' } as never, by: 'user:owner', reason: 'a made-up stop' } }))
    const d = await board({ market: 'IT', productId: P })
    expect(d.brain.products[0].levers.negatives).toMatchObject({ killed: { lever: 'negatives', by: 'user:owner' }, acting: { state: 'watches', why: expect.stringContaining('a made-up stop') } })
    expect(d.brain.kills).toEqual([expect.objectContaining({ lever: 'negatives', productId: P, reason: 'a made-up stop' })])
    // Another market's view: nothing enrolled there, and the product's kill is not in its scope.
    const de = await board({ market: 'DE' })
    expect(de.brain).toMatchObject({ products: [], kills: [], note: expect.stringContaining('No product is enrolled in the brain in DE') })
  })

  it('a product of another business is not found; a market that is not one is refused', async () => {
    expect(await inA(() => brainSwitchboard({ productId: OTHER }))).toEqual({ error: 'Product not found' })
    expect(await inA(() => brainSwitchboard({ market: 'X1' }))).toEqual({ error: 'X1 is not a market code' })
  })
})
