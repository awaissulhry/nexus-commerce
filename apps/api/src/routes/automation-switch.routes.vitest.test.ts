/**
 * R16 (lead review) — a person sets an engine's per-business switch from the Control Room, on a real PostgreSQL (PGlite).
 *
 * Proven: down is instant (the switch row, its audit row, and the engine's next tick reads it); up never goes past the
 * server env and needs the page's confirmation; the env is never written; an unknown engine or level is refused; the
 * lever then says env AND switch; one business's switch never reaches another.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

const A = LEGACY_WORKSPACE_ID
const OTHER = 'ws_r16_switch_other'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const ENV = ['NEXUS_ENABLE_AMAZON_ADS_CRON', 'NEXUS_AMAZON_ADS_MODE', 'NEXUS_ENABLE_RANK_DEFEND', 'NEXUS_ADS_AUTOMATION_KILL'] as const
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]))
let app: FastifyInstance
let workspaceOfRequest = A

beforeAll(async () => {
  database = await formulaDatabase()
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`, [OTHER])
  const { default: automationSwitchRoutes } = await import('./automation-switch.routes.js')
  app = Fastify()
  app.addHook('preHandler', (request, _reply, done) => {
    (request as { authUser?: { id: string } }).authUser = { id: 'u-owner' }
    withWorkspace(business(workspaceOfRequest), done)
  })
  await app.register(automationSwitchRoutes, { prefix: '/api' })
  await app.ready()
}, 180_000)
afterEach(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  workspaceOfRequest = A
  await inside(() => database.client.automationSwitch.deleteMany({}))
  await inside(() => database.client.automationSwitch.deleteMany({}), OTHER)
})
afterAll(async () => {
  await app?.close()
  await database?.close()
}, 30_000)

const press = (key: string, body: object) => app.inject({ method: 'POST', url: `/api/advertising/automation/engine-switch/${key}`, payload: body })
const armRankDefend = () => Object.assign(process.env, { NEXUS_ENABLE_AMAZON_ADS_CRON: '1', NEXUS_AMAZON_ADS_MODE: 'live', NEXUS_ENABLE_RANK_DEFEND: '1' })

describe('R16 — a person sets an engine switch in the Control Room', () => {
  it('down is instant: the row, the audit row, the engine reads it; the lever says env AND switch', async () => {
    armRankDefend()
    const res = await press('rank-defend', { mode: 'OFF', reason: 'holiday' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, key: 'rank-defend', from: 'AUTO', mode: 'OFF', env: { ceiling: 'AUTO' } })
    expect(await inside(() => database.client.automationSwitch.findFirst({ where: { key: 'rank-defend' }, select: { mode: true, setBy: true, reason: true } }))).toEqual({ mode: 'OFF', setBy: 'user:u-owner', reason: 'holiday' })
    expect(await inside(() => database.client.auditLog.findFirst({ where: { entityType: 'AutomationSwitch', entityId: 'rank-defend' }, select: { action: true, userId: true, before: true, after: true } })))
      .toEqual({ action: 'set_engine_switch', userId: 'u-owner', before: { mode: 'AUTO' }, after: { mode: 'OFF', reason: 'holiday' } })
    const { engineMode } = await import('../services/automation/engine-switch.service.js')
    expect((await inside(() => engineMode('rank-defend', 'AUTO'))).mode).toBe('OFF')
    // Another business is untouched.
    expect((await inside(() => engineMode('rank-defend', 'AUTO'), OTHER)).mode).toBe('AUTO')
    expect(process.env.NEXUS_ENABLE_RANK_DEFEND).toBe('1') // the env is never written
  })

  it('up: only with the confirmation, and never past the env', async () => {
    armRankDefend()
    await press('rank-defend', { mode: 'OFF' })
    const unconfirmed = await press('rank-defend', { mode: 'AUTO' })
    expect([unconfirmed.statusCode, unconfirmed.json()]).toEqual([400, { error: 'Turning Rank-defend up needs a confirmation (confirm: true).' }])
    delete process.env.NEXUS_ENABLE_RANK_DEFEND
    const pastEnv = await press('rank-defend', { mode: 'AUTO', confirm: true })
    expect(pastEnv.statusCode).toBe(409)
    expect(pastEnv.json().error).toMatch(/^The server env lets Rank-defend go no higher than OFF \(NEXUS_ENABLE_RANK_DEFEND is not 1/)
    armRankDefend()
    const up = await press('rank-defend', { mode: 'AUTO', confirm: true })
    expect(up.json()).toMatchObject({ ok: true, from: 'OFF', mode: 'AUTO' })
    // The top level removes the row: the env alone decides again.
    expect(await inside(() => database.client.automationSwitch.count())).toBe(0)
  })

  it('an unknown engine, a level it does not have, or no change is refused', async () => {
    expect((await press('repricer', { mode: 'OFF' })).statusCode).toBe(404) // not a Control Room engine
    expect((await press('nope', { mode: 'OFF' })).statusCode).toBe(404)
    expect((await press('fleet-analysts', { mode: 'AUTO', confirm: true })).json()).toEqual({ error: 'Analyst fleet sweep can be OFF, OBSERVE — not AUTO.' })
    expect((await press('auto-bid', {})).statusCode).toBe(400)
    expect((await press('auto-bid', { mode: 'AUTO', confirm: true })).json()).toEqual({ error: 'Auto-bid is already AUTO for this business.' })
  })

  it('one business at a time: a switch set in the other business stays there', async () => {
    workspaceOfRequest = OTHER
    expect((await press('budget-enforce', { mode: 'OBSERVE' })).statusCode).toBe(200)
    const { readEngineSwitch } = await import('../services/automation/engine-switch.service.js')
    expect(await inside(() => readEngineSwitch('budget-enforce'))).toBeNull()
    expect(await inside(() => readEngineSwitch('budget-enforce'), OTHER)).toMatchObject({ mode: 'OBSERVE', setBy: 'user:u-owner' })
  })
})
