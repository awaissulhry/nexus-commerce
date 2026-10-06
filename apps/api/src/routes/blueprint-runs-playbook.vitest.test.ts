/**
 * PB-5a — a playbook's build runs are the playbook's, not Replicate's (B-3: nor a one-off SP Super Wizard set's): the
 * Replicate runs list leaves them out, and its
 * raise-bids and rollback refuse them (a playbook run starts with the playbook's START and is undone with archive-ads
 * buildRunId). A Replicate run is listed and raised as before (control). Through the real routes, on PGlite (production
 * schema). Values are made up.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: null,
  }
})

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client
let app: FastifyInstance
const ids = { replicate: '', playbook: '', replicateCampaign: '', playbookCampaign: '' }

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const campaign = (name: string) => db().campaign.create({ data: { name, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', dailyBudget: '5.00', startDate: new Date(), externalCampaignId: `EXT-${name}` } })
    ids.replicateCampaign = (await campaign('TEST replicate campaign')).id
    ids.playbookCampaign = (await campaign('TEST playbook campaign')).id
    ids.replicate = (await db().adBlueprintApplication.create({ data: { productToken: 'TESTREP', marketplace: 'IT', status: 'APPLIED', plan: {}, launchMode: 'floor', createdCampaignIds: [ids.replicateCampaign] } })).id
    ids.playbook = (await db().adBlueprintApplication.create({ data: { productToken: 'TESTPBR', marketplace: 'IT', status: 'APPLIED', plan: {}, launchMode: 'floor', playbookId: 'pb-test-row', createdCampaignIds: [ids.playbookCampaign] } })).id
    // B-3 — a one-off SP Super Wizard set Claude asked for keeps its run here too, and is not Replicate's either.
    await db().adBlueprintApplication.create({ data: { productToken: 'TESTSPW', marketplace: 'IT', status: 'APPLIED', plan: {}, launchMode: 'floor', options: { source: 'sp-wizard', changeSetId: 'ap-test' } } })
  })
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => { withWorkspace(business, done) })
  const { default: routes } = await import('./advertising.routes.js')
  await app.register(routes)
  await app.ready()
}, 180_000)
afterAll(async () => { await app?.close(); await database?.close() }, 30_000)

describe('the Replicate runs leave a playbook\'s build runs alone', () => {
  it('the runs list shows Replicate\'s runs only', async () => {
    const res = await app.inject({ method: 'GET', url: '/advertising/blueprint-applications' })
    expect(res.statusCode).toBe(200)
    expect((JSON.parse(res.payload).items as Array<{ id: string }>).map((r) => r.id)).toEqual([ids.replicate])
  })

  it('raise-bids and rollback refuse a playbook run, and change nothing', async () => {
    for (const action of ['raise-bids', 'rollback']) {
      const res = await app.inject({ method: 'POST', url: `/advertising/blueprint-applications/${ids.playbook}/${action}` })
      expect(res.statusCode, action).toBe(400)
      expect(JSON.parse(res.payload).error, action).toMatch(/^This run built an ads playbook: it is started, stopped and undone only through the playbook/)
    }
    const run = await inside(() => db().adBlueprintApplication.findUniqueOrThrow({ where: { id: ids.playbook }, select: { status: true, launchMode: true, rolledBackAt: true } }))
    expect(run).toEqual({ status: 'APPLIED', launchMode: 'floor', rolledBackAt: null })
    expect((await inside(() => db().campaign.findUniqueOrThrow({ where: { id: ids.playbookCampaign }, select: { status: true } }))).status).toBe('ENABLED')
  })

  it('control: a Replicate run is raised as before', async () => {
    const res = await app.inject({ method: 'POST', url: `/advertising/blueprint-applications/${ids.replicate}/raise-bids` })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toMatchObject({ campaigns: 1 })
    expect((await inside(() => db().adBlueprintApplication.findUniqueOrThrow({ where: { id: ids.replicate }, select: { launchMode: true } }))).launchMode).toBe('live')
  })
})
