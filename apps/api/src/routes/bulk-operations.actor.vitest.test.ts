/**
 * Who changed the price (2026-09-30, "Get everything fixed").
 *
 * 🔴 WHAT THIS GUARDS. `POST /api/bulk-operations` took `createdBy` from the request BODY, and a bulk price override
 * records that job actor on the listing (`lastOverrideBy`), the override audit row, the price timeline and the queue
 * row. So a price change was recorded under any name the caller typed — and the web typed none, so every one read
 * "bulk-action". Templates, schedules, automation rules and approvals took their person from the body the same way.
 *
 * Now every entry point names who acts from the session (`bulk-action-actor.ts`): the signed-in person, an API key, the
 * person who scheduled a run (checked to be a real person), or a plain system name. These arms drive the real routes
 * over a real PostgreSQL in-process (PGlite); the pre-handler stands in for the session hook, which sets
 * `request.authUser` from the cookie in production.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../services/outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, bulkJobQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../services/product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../services/product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import bulkOperationsRoutes from './bulk-operations.routes.js'
import scheduledBulkActionRoutes from './scheduled-bulk-actions.routes.js'
import bulkActionTemplateRoutes from './bulk-action-templates.routes.js'
import bulkAutomationRulesRoutes from './bulk-automation-rules.routes.js'
import bulkAutomationApprovalsRoutes from './bulk-automation-approvals.routes.js'
import { runScheduledBulkActionTickOnce } from '../jobs/scheduled-bulk-action.job.js'

const BUSINESS = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const scoped = <T>(work: () => Promise<T>) => withWorkspace(BUSINESS, work)
const PEOPLE = { a: 'person-a', b: 'person-b', s: 'person-s', t: 'person-t' } as const

let app: FastifyInstance
let account = ''
beforeAll(async () => {
  app = Fastify()
  // Production: the session hook sets `authUser` from the cookie, the API-key hook sets `apiKey`, the workspace hook
  // enters the business. Here a header names the person (or key) so each arm chooses who is signed in.
  app.addHook('preHandler', (request, _reply, done) => {
    const person = request.headers['x-test-person']
    if (typeof person === 'string') Object.assign(request, { authUser: { id: person, email: `${person}@example.test`, displayName: person, status: 'active', mfaRequired: false, twoFactorEnabledAt: null, permissionsVersion: 1, roleKeys: [] } })
    const key = request.headers['x-test-api-key']
    if (typeof key === 'string') Object.assign(request, { apiKey: { id: key, label: 'test key', scopes: [] } })
    withWorkspace(BUSINESS, done)
  })
  await app.register(bulkOperationsRoutes, { prefix: '/api' })
  await app.register(scheduledBulkActionRoutes, { prefix: '/api' })
  await app.register(bulkActionTemplateRoutes, { prefix: '/api' })
  await app.register(bulkAutomationRulesRoutes, { prefix: '/api' })
  await app.register(bulkAutomationApprovalsRoutes, { prefix: '/api' })
  await app.ready()
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
    account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'actor-test', isActive: true } })).id
    for (const [key, id] of Object.entries(PEOPLE)) {
      await prisma.userProfile.create({ data: { id, email: `${id}@example.test`, displayName: `Person ${key.toUpperCase()}` } })
    }
  })
}, 120_000)
afterAll(async () => { await app?.close(); await state.db?.close() }, 60_000)

async function seedListing(id: string) {
  return scoped(async () => {
    await prisma.product.create({ data: { id, sku: id.toUpperCase(), name: id, basePrice: 10 } })
    return prisma.channelListing.create({ data: { productId: id, channel: 'AMAZON', channelConnectionId: account, channelMarket: 'AMAZON_IT', marketplace: 'IT', region: 'EU', price: 10, followMasterPrice: true } })
  })
}
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: payload as never, headers })
const as = (person: string) => ({ 'x-test-person': person })
async function finished(jobId: string) {
  for (let i = 0; i < 100; i++) {
    const job = await scoped(() => prisma.bulkActionJob.findUniqueOrThrow({ where: { id: jobId } }))
    if (['COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) return job
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`job ${jobId} did not finish`)
}
/** Every place the price write records who acted, for one listing. */
const recordedActors = (listingId: string) => scoped(async () => {
  const listing = await prisma.channelListing.findUniqueOrThrow({ where: { id: listingId } })
  const audit = await prisma.channelListingOverride.findMany({ where: { channelListingId: listingId } })
  const timeline = await prisma.priceChangeEvent.findMany({ where: { productId: listing.productId } })
  const queue = await prisma.outboundSyncQueue.findMany({ where: { channelListingId: listingId } })
  return {
    lastOverrideBy: listing.lastOverrideBy,
    audit: audit.map((a) => a.changedBy),
    timeline: timeline.map((e) => e.actor),
    queue: queue.map((q) => (q.payload as { actor?: string }).actor),
  }
})
const override = (productId: string, extra: Record<string, unknown> = {}) => ({
  jobName: 'actor test', actionType: 'MARKETPLACE_OVERRIDE_UPDATE', channel: 'AMAZON', targetProductIds: [productId], actionPayload: { priceOverride: 12.5 }, ...extra,
})

describe('who changed the price — a bulk job acts for the signed-in person', () => {
  it('🔴 a body `createdBy` is ignored; the listing, audit, timeline and queue row all name the session person', async () => {
    const l = await seedListing('actor-rest')
    const created = await post('/api/bulk-operations', override('actor-rest', { createdBy: 'forged-name' }), as(PEOPLE.a))
    expect(created.statusCode, created.body).toBe(201)
    const job = created.json().job
    expect(job.createdBy).toBe(PEOPLE.a)
    expect((await post(`/api/bulk-operations/${job.id}/process`, {}, as(PEOPLE.a))).statusCode).toBe(200)
    expect(await finished(job.id)).toMatchObject({ status: 'COMPLETED', processedItems: 1 })
    expect(await recordedActors(l.id)).toEqual({ lastOverrideBy: PEOPLE.a, audit: [PEOPLE.a], timeline: [PEOPLE.a], queue: [PEOPLE.a] })
  }, 60_000)

  it('the history names who ran each job — a person by display name, a system actor by a plain label, a stored free-text name not at all', async () => {
    await scoped(async () => {
      for (const [jobName, createdBy] of [['by automation', 'automation:rule-1'], ['by old free text', 'someone-typed-this'], ['by nobody', null]] as const) {
        await prisma.bulkActionJob.create({ data: { jobName, actionType: 'STATUS_UPDATE', targetProductIds: [], targetVariationIds: [], actionPayload: {}, status: 'COMPLETED', totalItems: 0, createdBy } })
      }
    })
    const response = await app.inject({ method: 'GET', url: '/api/bulk-operations/history?limit=100', headers: as(PEOPLE.a) })
    expect(response.statusCode).toBe(200)
    const byName = new Map(response.json().jobs.map((j: { jobName: string; createdBy: string | null; createdByName: string | null }) => [j.jobName, [j.createdBy, j.createdByName]]))
    expect(byName.get('actor test')).toEqual([PEOPLE.a, 'Person A'])
    expect(byName.get('by automation')).toEqual(['automation:rule-1', 'Automation rule'])
    expect(byName.get('by old free text')).toEqual(['someone-typed-this', null])
    expect(byName.get('by nobody')).toEqual([null, null])
  }, 60_000)

  it('an API key with no session acts as api-key:<id>; neither a session nor a key leaves no name — never the body\'s', async () => {
    await seedListing('actor-key')
    const byKey = await post('/api/bulk-operations', override('actor-key', { createdBy: 'forged-name' }), { 'x-test-api-key': 'key-1' })
    expect(byKey.json().job.createdBy).toBe('api-key:key-1')
    const anonymous = await post('/api/bulk-operations', override('actor-key', { createdBy: 'forged-name', jobName: 'anonymous', force: true }))
    expect(anonymous.statusCode, anonymous.body).toBe(201)
    expect(anonymous.json().job.createdBy).toBeNull()
  }, 60_000)

  it('🔴 a retry of failed rows acts for the person who retried, not for whoever ran the original', async () => {
    await seedListing('actor-retry')
    // A row that fails, so there is a failed row to retry: master +50% (15.00) is above the product's own ceiling, so the
    // price door refuses that listing. (It used to be a percent of 5000 failing in the 5,2 column; since 2026-10-01 such a
    // payload is refused before a job exists, and a retry of it would be refused the same way.)
    await scoped(() => prisma.product.update({ where: { id: 'actor-retry' }, data: { maxPrice: 10.5 } }))
    const original = await scoped(() => prisma.bulkActionJob.create({ data: { jobName: 'to retry', actionType: 'MARKETPLACE_OVERRIDE_UPDATE', channel: 'AMAZON', targetProductIds: ['actor-retry'], targetVariationIds: [], actionPayload: { pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 50 }, status: 'PENDING', totalItems: 1, createdBy: PEOPLE.a } }))
    await post(`/api/bulk-operations/${original.id}/process`, {}, as(PEOPLE.a))
    expect(await finished(original.id)).toMatchObject({ status: 'FAILED' })
    const retry = await post(`/api/bulk-operations/${original.id}/retry-failed`, { createdBy: 'forged-name' }, as(PEOPLE.b))
    expect(retry.statusCode, retry.body).toBe(201)
    expect(retry.json().job.createdBy).toBe(PEOPLE.b)
  }, 60_000)
})

describe('a scheduled run names its scheduler', () => {
  it('🔴 the schedule records the session person (not the body), and its run\'s price change names them', async () => {
    const l = await seedListing('actor-schedule')
    const created = await post('/api/scheduled-bulk-actions', {
      name: 'nightly price', actionType: 'MARKETPLACE_OVERRIDE_UPDATE', channel: 'AMAZON', targetProductIds: ['actor-schedule'],
      actionPayload: { priceOverride: 14 }, scheduledFor: new Date(Date.now() + 3_600_000).toISOString(), createdBy: 'forged-name',
    }, as(PEOPLE.s))
    expect(created.statusCode, created.body).toBe(201)
    const schedule = created.json().schedule
    expect(schedule.createdBy).toBe(PEOPLE.s)
    // Time passes: the schedule is due.
    await scoped(() => prisma.scheduledBulkAction.update({ where: { id: schedule.id }, data: { nextRunAt: new Date(Date.now() - 60_000) } }))
    expect(await scoped(() => runScheduledBulkActionTickOnce())).toMatchObject({ fired: 1, failed: 0 })
    const run = await scoped(() => prisma.scheduledBulkAction.findUniqueOrThrow({ where: { id: schedule.id } }))
    const job = await finished(run.lastJobId!)
    expect(job).toMatchObject({ createdBy: PEOPLE.s, status: 'COMPLETED' })
    expect(await recordedActors(l.id)).toEqual({ lastOverrideBy: PEOPLE.s, audit: [PEOPLE.s], timeline: [PEOPLE.s], queue: [PEOPLE.s] })
  }, 60_000)

  it('a schedule saved with a typed-in name (before this change) runs as schedule:<id>, never as that name', async () => {
    const l = await seedListing('actor-legacy-schedule')
    const legacy = await scoped(() => prisma.scheduledBulkAction.create({ data: {
      name: 'old schedule', actionType: 'MARKETPLACE_OVERRIDE_UPDATE', channel: 'AMAZON', targetProductIds: ['actor-legacy-schedule'],
      actionPayload: { priceOverride: 15 }, scheduledFor: new Date(), nextRunAt: new Date(Date.now() - 60_000), createdBy: 'someone-typed-this',
    } }))
    expect(await scoped(() => runScheduledBulkActionTickOnce())).toMatchObject({ fired: 1 })
    const run = await scoped(() => prisma.scheduledBulkAction.findUniqueOrThrow({ where: { id: legacy.id } }))
    expect(await finished(run.lastJobId!)).toMatchObject({ createdBy: `schedule:${legacy.id}` })
    expect((await recordedActors(l.id)).audit).toEqual([`schedule:${legacy.id}`])
  }, 60_000)
})

describe('a template names the person who saved it and the person who applied it', () => {
  it('🔴 neither `createdBy` in the body counts', async () => {
    await seedListing('actor-template')
    const saved = await post('/api/bulk-action-templates', { name: 'pin at 16', actionType: 'MARKETPLACE_OVERRIDE_UPDATE', channel: 'AMAZON', actionPayload: { priceOverride: 16 }, createdBy: 'forged-name' }, as(PEOPLE.t))
    expect(saved.statusCode, saved.body).toBe(201)
    expect(saved.json().template.createdBy).toBe(PEOPLE.t)
    const applied = await post(`/api/bulk-action-templates/${saved.json().template.id}/apply`, { targetProductIds: ['actor-template'], createdBy: 'forged-name' }, as(PEOPLE.a))
    expect(applied.statusCode, applied.body).toBe(201)
    expect(applied.json().job.createdBy).toBe(PEOPLE.a)
  }, 60_000)
})

describe('automation: a rule and an approval name the signed-in person; the rule\'s jobs act as automation:<rule id>', () => {
  it('🔴 a rule records who created it, and an approval or rejection records who decided — never the body\'s name', async () => {
    const rule = await post('/api/bulk-automation-rules', { name: 'log on completion', trigger: 'bulk_job_completed', actions: [{ type: 'log_only' }], createdBy: 'forged-name' }, as(PEOPLE.a))
    expect(rule.statusCode, rule.body).toBe(201)
    expect(rule.json().rule.createdBy).toBe(PEOPLE.a)

    const pending = () => scoped(() => prisma.bulkAutomationApproval.create({ data: {
      ruleId: rule.json().rule.id, ruleName: 'log on completion', triggerPayload: {}, actionPlan: [], threshold: 'test', expiresAt: new Date(Date.now() + 3_600_000),
    } }))
    const [toApprove, toReject] = [await pending(), await pending()]
    const approved = await post(`/api/bulk-automation-approvals/${toApprove.id}/approve`, { approvedBy: 'forged-name' }, as(PEOPLE.b))
    expect(approved.statusCode, approved.body).toBe(200)
    expect(approved.json().approval.approvedBy).toBe(PEOPLE.b)
    const rejected = await post(`/api/bulk-automation-approvals/${toReject.id}/reject`, { rejectedBy: 'forged-name', reason: 'not now' }, as(PEOPLE.b))
    expect(rejected.statusCode, rejected.body).toBe(200)
    expect(rejected.json().approval.rejectedBy).toBe(PEOPLE.b)
  }, 60_000)
})
