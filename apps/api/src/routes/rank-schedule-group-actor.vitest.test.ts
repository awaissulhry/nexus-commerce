/**
 * CC-28 — a person's save of an hourly plan names that person. Every route that saves a plan (create, the full and the
 * lightweight PATCH, add campaigns, apply a template, merge hours, restore a version) writes its version row with
 * `changedBy` = the signed-in user, never the body's `userId`, and a body cannot pass itself off as a Claude request
 * (`changeSetId`, `alwaysVersion`). The delete leaves one audit row naming them (none when there was no plan).
 * C — a save that does not say `enabled` keeps a plan as it is (an OFF plan stays off) without writing it, so a Pause
 * landing during the save stands — also through the routes that read a plan and save it again (they send no `enabled`);
 * a new plan is born switched off; the answer says whether the plan is on.
 * 6a — the coverage list offers Sponsored Products campaigns only, adding campaigns answers how many really joined, and a
 * save that would leave a plan with no Sponsored Products campaign is a 400 with the reason, with nothing written.
 *
 * On a real PostgreSQL (PGlite) with the real advertising routes. The signed-in person is named in a header and set as
 * `authUser`, as auth sets it (ads-undo-changed-since.vitest.test.ts). Every id and name is made up.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
/**
 * A write that lands inside a save (C): when armed, the next `rankScheduleGroup.update` first runs this racing write, once.
 * Every such update's `data` is kept, so a test reads what a save writes.
 */
const race = vi.hoisted(() => ({ write: null as null | (() => Promise<unknown>), updates: [] as Array<Record<string, unknown>> }))
vi.mock('../db.js', () => ({
  default: new Proxy({}, {
    get: (_target, property) => {
      const value = Reflect.get(database.client, property)
      if (property !== 'rankScheduleGroup') return value
      return new Proxy(value as object, {
        get: (model, method) => {
          const fn = Reflect.get(model, method) as (...a: unknown[]) => unknown
          if (method !== 'update') return typeof fn === 'function' ? fn.bind(model) : fn
          return async (args: { data: Record<string, unknown> }) => {
            race.updates.push(args.data)
            const w = race.write; race.write = null
            if (w) await w()
            return fn.call(model, args)
          }
        },
      })
    },
  }),
}))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }),
    resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
vi.mock('../services/advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined,
  putCached: () => undefined,
  flushAdsCache: async () => undefined,
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client as any

const OWNER = 'user:u-owner'
const WEEK = [{ days: [1, 2, 3, 4, 5], startHour: 18, endHour: 22, targetKey: 'own-top' }]
// In the key order PostgreSQL stores them (jsonb), so the same plan saved again compares as unchanged.
const EVENING = [{ days: [6], endHour: 12, startHour: 9, targetKey: 'own-top' }]
const NIGHT = [{ days: [0], startHour: 1, endHour: 5, targetKey: 'own-top' }]
let app: FastifyInstance
let planId = ''
let firstVersionId = ''
let templateId = ''

/** The routes as the signed-in person `u-owner` calls them (no `x-actor-id`: the web never sends it). */
const send = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => {
  const res = await app.inject({ method, url: `/api/advertising/rank-schedule-groups${url}`, ...(payload ? { payload } : {}), headers: { 'x-test-user': 'u-owner' } })
  return { status: res.statusCode, body: res.json() as Record<string, any> }
}
const versionIds = async (groupId: string) => new Set((await inside(() => db().rankScheduleVersion.findMany({ where: { groupId }, select: { id: true } }))).map((v: { id: string }) => v.id))
/** The version rows a call wrote: those that were not there before it. */
const written = async (groupId: string, before: Set<string>) =>
  (await inside(() => db().rankScheduleVersion.findMany({ where: { groupId }, select: { id: true, changedBy: true, enabled: true } }))).filter((v: { id: string }) => !before.has(v.id))
/** The list's Pause (the plan and its members off), as a racing write the hook runs inside the next plan update. */
const pause = (groupId: string) => () => inside(async () => {
  await db().rankScheduleGroup.updateMany({ where: { id: groupId }, data: { enabled: false } })
  await db().adSchedule.updateMany({ where: { groupId }, data: { enabled: false } })
})
const switches = (groupId: string) => inside(async () => ({
  group: (await db().rankScheduleGroup.findUnique({ where: { id: groupId }, select: { enabled: true } })).enabled,
  members: (await db().adSchedule.findMany({ where: { groupId }, orderBy: { campaignId: 'asc' }, select: { enabled: true } })).map((m: { enabled: boolean }) => m.enabled),
}))

beforeAll(async () => {
  database = await formulaDatabase()
  const { default: advertisingRoutes } = await import('./advertising.routes.js')
  app = Fastify()
  // A signed-in person, as auth sets it (personActor reads `authUser`): the test names him in a header.
  app.addHook('preHandler', (request, _reply, done) => {
    const who = request.headers['x-test-user']
    if (typeof who === 'string') (request as unknown as { authUser: { id: string } }).authUser = { id: who }
    done()
  })
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(business, done))
  await app.register(advertisingRoutes, { prefix: '/api' })
  await app.ready()
  await inside(async () => {
    const campaign = (id: string, product: Record<string, unknown> = { type: 'SP', adProduct: 'SPONSORED_PRODUCTS' }) =>
      db().campaign.create({ data: { id, name: `ACTOR ${id}`, ...product, dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), marketplace: 'IT', externalCampaignId: `TEST-${id}`, status: 'ENABLED' } })
    for (const id of ['act-a', 'act-b', 'act-c', 'act-d', 'act-e', 'act-f', 'act-g', 'act-h', 'act-i', 'act-j', 'act-k', 'act-l', 'act-m', 'act-n', 'act-free']) await campaign(id)
    await campaign('act-sd', { type: 'SD', adProduct: 'SPONSORED_DISPLAY' })
    await campaign('act-sd2', { type: 'SD', adProduct: 'SPONSORED_DISPLAY' })
    await campaign('act-sb', { type: 'SB', adProduct: 'SPONSORED_BRANDS' })
    await db().rankTarget.create({ data: { key: 'own-top', name: 'Own top', biasPct: 50 } })
    await db().rankTarget.create({ data: { key: 'rest-of-search', name: 'Rest of search', biasPct: 0 } })
    templateId = (await db().rankScheduleTemplate.create({ data: { name: 'ACTOR template', windows: NIGHT, defaultTargetKey: 'rest-of-search' } })).id
  })
}, 180_000)
afterAll(async () => {
  await app?.close()
  await database?.close()
}, 30_000)

describe('CC-28 — every save of a plan names the signed-in person', () => {
  it('create: the version row and the plan name the person, not the body\'s userId', async () => {
    const res = await send('POST', '', { name: 'ACTOR plan', campaignIds: ['act-a'], windows: WEEK, defaultTargetKey: 'rest-of-search', enabled: true, userId: 'user:spoof', changeSetId: 'forged' })
    expect(res.status).toBe(200)
    planId = res.body.id
    const versions = await inside(() => db().rankScheduleVersion.findMany({ where: { groupId: planId }, select: { id: true, changedBy: true } }))
    firstVersionId = versions[0]?.id ?? ''
    expect(versions).toEqual([{ id: expect.any(String), changedBy: OWNER }])
    expect(await inside(() => db().rankScheduleGroup.findUnique({ where: { id: planId }, select: { createdBy: true } }))).toEqual({ createdBy: OWNER })
  })

  it('full PATCH: the version row names the person; a body\'s alwaysVersion is not a Claude request\'s', async () => {
    const before = await versionIds(planId)
    const body = { name: 'ACTOR plan', campaignIds: ['act-a'], windows: EVENING, defaultTargetKey: 'rest-of-search', enabled: true, userId: 'user:spoof' }
    expect((await send('PATCH', `/${planId}`, body)).status).toBe(200)
    expect(await written(planId, before)).toEqual([expect.objectContaining({ changedBy: OWNER })])
    // The same plan again: nothing meaningful changed, so no version row, whatever the body says.
    const again = await versionIds(planId)
    expect((await send('PATCH', `/${planId}`, { ...body, alwaysVersion: true, changeSetId: 'forged' })).status).toBe(200)
    expect(await written(planId, again)).toEqual([])
  })

  it('lightweight PATCH (the list\'s Pause), with no x-actor-id: the version row names the person', async () => {
    const before = await versionIds(planId)
    expect((await send('PATCH', `/${planId}`, { enabled: false })).status).toBe(200)
    expect(await written(planId, before)).toEqual([expect.objectContaining({ changedBy: OWNER })])
  })

  it.each([
    ['add campaigns', () => send('POST', `/${planId}/campaigns`, { campaignIds: ['act-b'] })],
    ['apply a template', () => send('POST', '/apply-template', { templateId, groupIds: [planId] })],
    ['merge hours', () => send('POST', `/${planId}/merge-windows`, { windows: [{ days: [3], startHour: 6, endHour: 8, targetKey: 'own-top' }] })],
    ['restore a version', () => send('POST', `/${planId}/restore-version`, { versionId: firstVersionId, userId: 'user:spoof' })],
  ] as Array<[string, () => ReturnType<typeof send>]>)('%s: the version row names the person', async (_route, call) => {
    const before = await versionIds(planId)
    const res = await call()
    expect(res.status).toBe(200)
    expect(await written(planId, before)).toEqual([expect.objectContaining({ changedBy: OWNER })])
  })

  it('delete: one audit row names the person', async () => {
    expect((await send('DELETE', `/${planId}`)).status).toBe(200)
    const rows = await inside(() => db().advertisingActionLog.findMany({ where: { entityId: planId }, select: { userId: true, actionType: true, entityType: true, entityId: true, payloadBefore: true, payloadAfter: true } }))
    expect(rows).toEqual([{
      userId: OWNER, actionType: 'rank_schedule_group_delete', entityType: 'RANK_SCHEDULE_GROUP', entityId: planId,
      payloadBefore: { name: 'ACTOR plan', enabled: false, campaigns: expect.arrayContaining(['act-a', 'act-b']) },
      payloadAfter: { deleted: true, restored: 0, deferred: 0, failed: 0 },
    }])
  })

  it('delete of a plan that is not there: nothing was deleted, so no audit row', async () => {
    expect((await send('DELETE', '/act-no-such-plan')).status).toBe(200)
    expect(await inside(() => db().advertisingActionLog.count({ where: { entityId: 'act-no-such-plan' } }))).toBe(0)
  })
})

describe('C — a save that does not say `enabled` never switches a plan', () => {
  it('a full PATCH of an OFF plan without `enabled` keeps it and its members off; an ON plan stays on', async () => {
    const made = await send('POST', '', { name: 'ACTOR off plan', campaignIds: ['act-c'], windows: WEEK, defaultTargetKey: 'rest-of-search', enabled: false })
    const id = made.body.id as string
    expect(await switches(id)).toEqual({ group: false, members: [false] })
    expect((await send('PATCH', `/${id}`, { name: 'ACTOR off plan', campaignIds: ['act-c', 'act-d'], windows: EVENING, defaultTargetKey: 'rest-of-search' })).status).toBe(200)
    expect(await switches(id)).toEqual({ group: false, members: [false, false] })
    // Switched on by the list, then saved again without `enabled`: it stays on.
    await send('PATCH', `/${id}`, { enabled: true })
    expect((await send('PATCH', `/${id}`, { name: 'ACTOR off plan', campaignIds: ['act-c', 'act-d'], windows: WEEK, defaultTargetKey: 'rest-of-search' })).status).toBe(200)
    expect(await switches(id)).toEqual({ group: true, members: [true, true] })
  })

  it('a new plan saved without `enabled` is born switched off', async () => {
    const made = await send('POST', '', { name: 'ACTOR born plan', campaignIds: ['act-e'], windows: WEEK, defaultTargetKey: 'rest-of-search' })
    expect(made.status).toBe(200)
    expect(await switches(made.body.id)).toEqual({ group: false, members: [false] })
  })

  it('a save that does not say `enabled` writes none: the list\'s Pause landing during the save stands; members, version row and answer follow it', async () => {
    const made = await send('POST', '', { name: 'ACTOR race plan', campaignIds: ['act-f'], windows: WEEK, defaultTargetKey: 'rest-of-search', enabled: true })
    const id = made.body.id as string
    const before = await versionIds(id)
    // The Pause, landing after anything the save could read and before it writes the plan.
    race.write = pause(id)
    race.updates = []
    const saved = await send('PATCH', `/${id}`, { name: 'ACTOR race plan', campaignIds: ['act-f'], windows: EVENING, defaultTargetKey: 'rest-of-search' })
    expect(saved.status).toBe(200)
    expect(race.updates).toHaveLength(1)
    expect(race.updates[0]).not.toHaveProperty('enabled')
    expect(saved.body.enabled).toBe(false)
    expect(await switches(id)).toEqual({ group: false, members: [false] })
    expect(await written(id, before)).toEqual([expect.objectContaining({ changedBy: OWNER, enabled: false })])
  })

  it('the answer says whether the plan is on as it now stands (the screen shows it): born off, then kept on', async () => {
    const made = await send('POST', '', { name: 'ACTOR answer plan', campaignIds: ['act-g'], windows: WEEK, defaultTargetKey: 'rest-of-search' })
    expect(made.body).toMatchObject({ members: 1, enabled: false })
    await send('PATCH', `/${made.body.id}`, { enabled: true })
    const saved = await send('PATCH', `/${made.body.id}`, { name: 'ACTOR answer plan', campaignIds: ['act-g'], windows: EVENING, defaultTargetKey: 'rest-of-search' })
    expect(saved.body).toMatchObject({ members: 1, enabled: true })
  })
})

describe('6a — a person adds Sponsored Products campaigns only', () => {
  it('the coverage list offers only Sponsored Products campaigns a plan can take in', async () => {
    const res = await send('GET', '/coverage?marketplace=IT&limit=200')
    expect(res.status).toBe(200)
    const listed = (res.body.items as Array<{ id: string }>).map((i) => i.id)
    expect(listed).toContain('act-free')
    expect(listed).not.toContain('act-sd')
    expect(listed).not.toContain('act-sb')
  })

  it('adding campaigns answers how many really joined, and names the ones left out', async () => {
    const made = await send('POST', '', { name: 'ACTOR add plan', campaignIds: ['act-h'], windows: WEEK, defaultTargetKey: 'rest-of-search', enabled: false })
    const res = await send('POST', `/${made.body.id}/campaigns`, { campaignIds: ['act-h', 'act-sd', 'act-i', 'act-i'] })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ members: 2, added: 1, notSponsoredProducts: [{ id: 'act-sd', name: 'ACTOR act-sd' }] })
  })
})

describe('6a — a save that would leave a plan with no Sponsored Products campaign: 400 with the reason, nothing written', () => {
  const ONE = 'The campaign is not Sponsored Products: an hourly plan holds those only.'
  let display = ''
  let displayVersion = ''
  beforeAll(async () => {
    // A plan of one Sponsored Display campaign, as a save before 6a could leave it.
    await inside(async () => {
      const g = await db().rankScheduleGroup.create({ data: { name: 'ACTOR display plan', marketplace: 'IT', windows: WEEK, defaultTargetKey: 'rest-of-search', enabled: false } })
      display = g.id
      await db().adSchedule.create({ data: { campaignId: 'act-sd2', name: 'ACTOR act-sd2 — ACTOR display plan', windows: WEEK, defaultTargetKey: 'rest-of-search', enabled: false, groupId: g.id } })
      displayVersion = (await db().rankScheduleVersion.create({ data: { groupId: g.id, name: g.name, windows: NIGHT, defaultTargetKey: 'rest-of-search', campaignCount: 1, enabled: false, changedBy: 'user:someone' } })).id
    })
  })
  const displayHolds = async () => {
    const [members, group] = await inside(() => Promise.all([
      db().adSchedule.findMany({ where: { groupId: display }, select: { campaignId: true } }),
      db().rankScheduleGroup.findUnique({ where: { id: display }, select: { windows: true } }),
    ]))
    expect(members.map((m: { campaignId: string }) => m.campaignId)).toEqual(['act-sd2'])
    expect(group.windows).toEqual(WEEK)
  }

  it('create: 400, and no plan is made', async () => {
    const res = await send('POST', '', { name: 'ACTOR display only', campaignIds: ['act-sd'], windows: WEEK, defaultTargetKey: 'rest-of-search' })
    expect(res).toEqual({ status: 400, body: { error: `${ONE} Choose Sponsored Products campaigns.` } })
    expect(await inside(() => db().rankScheduleGroup.count({ where: { name: 'ACTOR display only' } }))).toBe(0)
  })

  it('full PATCH: 400, and the plan keeps its campaign and its hours', async () => {
    const id = (await send('POST', '', { name: 'ACTOR sp plan', campaignIds: ['act-j'], windows: WEEK, defaultTargetKey: 'rest-of-search' })).body.id as string
    const res = await send('PATCH', `/${id}`, { name: 'ACTOR sp plan', campaignIds: ['act-sd'], windows: EVENING, defaultTargetKey: 'rest-of-search' })
    expect(res).toEqual({ status: 400, body: { error: `${ONE} Delete the plan instead.` } })
    const [members, group] = await inside(() => Promise.all([
      db().adSchedule.findMany({ where: { groupId: id }, select: { campaignId: true } }),
      db().rankScheduleGroup.findUnique({ where: { id }, select: { windows: true } }),
    ]))
    expect(members.map((m: { campaignId: string }) => m.campaignId)).toEqual(['act-j'])
    expect(group.windows).toEqual(WEEK)
  })

  it.each([
    ['add campaigns', () => send('POST', `/${display}/campaigns`, { campaignIds: ['act-sb'] }), 'None of the 2 campaigns is Sponsored Products: an hourly plan holds those only. Delete the plan instead.'],
    ['merge hours', () => send('POST', `/${display}/merge-windows`, { windows: [{ days: [3], startHour: 6, endHour: 8, targetKey: 'own-top' }] }), `${ONE} Delete the plan instead.`],
    ['restore a version', () => send('POST', `/${display}/restore-version`, { versionId: displayVersion }), `${ONE} Delete the plan instead.`],
  ] as Array<[string, () => ReturnType<typeof send>, string]>)('%s on it: 400 with the reason, nothing written', async (_route, call, error) => {
    expect(await call()).toEqual({ status: 400, body: { error } })
    await displayHolds()
  })

  it('apply a template to it: its failed entry carries the reason, nothing written', async () => {
    const res = await send('POST', '/apply-template', { templateId, groupIds: [display] })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ applied: 0, failed: [{ id: display, error: `${ONE} Delete the plan instead.` }] })
    await displayHolds()
  })
})

describe('C — the routes that read a plan and save it send no `enabled`: a Pause landing between the two stands', () => {
  it.each([
    ['add campaigns', 'act-k', (id: string) => send('POST', `/${id}/campaigns`, { campaignIds: ['act-n'] }), (b: Record<string, any>) => b.enabled],
    ['merge hours', 'act-l', (id: string) => send('POST', `/${id}/merge-windows`, { windows: [{ days: [3], startHour: 6, endHour: 8, targetKey: 'own-top' }] }), (b: Record<string, any>) => b.group.enabled],
    ['restore a version', 'act-m', async (id: string) => send('POST', `/${id}/restore-version`, { versionId: (await inside(() => db().rankScheduleVersion.findFirst({ where: { groupId: id }, select: { id: true } }))).id }), (b: Record<string, any>) => b.armed],
  ] as Array<[string, string, (id: string) => ReturnType<typeof send>, (b: Record<string, any>) => unknown]>)('%s: the plan and its members stay paused, and the answer says off', async (route, campaignId, call, answered) => {
    const id = (await send('POST', '', { name: `ACTOR race ${route}`, campaignIds: [campaignId], windows: WEEK, defaultTargetKey: 'rest-of-search', enabled: true })).body.id as string
    race.write = pause(id)
    race.updates = []
    const res = await call(id)
    expect(res.status).toBe(200)
    expect(race.updates).toHaveLength(1)
    expect(race.updates[0]).not.toHaveProperty('enabled')
    expect(answered(res.body)).toBe(false)
    const now = await switches(id)
    expect(now.group).toBe(false)
    expect(now.members.every((on: boolean) => !on)).toBe(true)
  })
})
