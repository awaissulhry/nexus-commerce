/**
 * Keyword Harvest page — the harvest routes (routes/advertising-harvest.routes.ts) over the engine as a stub: each route
 * parses what it takes (400 in words otherwise), answers with no-store, hands the engine exactly the request (bulk ids,
 * the person), turns the engine's refusal into its status, answers 202 with the change set for apply and undo (a request,
 * never a direct write), refuses a request with no signed-in person (403), and strips exactly the money keys for a person
 * without financials.adspend.view. The engine itself is tested on a real database (harvest/engine-postgres). Values are
 * made up (public repo).
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIELDS } from '@nexus/shared/permissions'
import type { ResolvedPermissions } from '../lib/auth/rbac.js'

const h = vi.hoisted(() => ({ calls: [] as Array<[string, unknown[]]> }))
const rec = (name: string, answer: unknown) => vi.fn(async (...args: unknown[]) => { h.calls.push([name, args]); return typeof answer === 'function' ? (answer as (...a: unknown[]) => unknown)(...args) : answer })

vi.mock('../lib/queue.js', () => {
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
vi.mock('../services/advertising/harvest/index.js', async () => {
  const { FIELDS: F } = await import('@nexus/shared/permissions')
  const { z } = await import('zod')
  const money = Object.fromEntries(['spendCents', 'salesCents', 'acosPct', 'cpcCents', 'bidCents', 'startBidCents', 'dailyBudgetCents', 'capMonthlyCents', 'maxAcosPct', 'fromCents', 'toCents', 'money'].map((k) => [k, F.financialsAdspendView]))
  const row = { id: 'IT|p1|touring jacket', term: 'touring jacket', state: 'READY', metrics: { orders: 4, clicks: 100, spendCents: 2000, salesCents: 30_000, acosPct: 6.7, cpcCents: 20 }, startBidCents: 35 }
  return {
    HARVEST_MONEY: money, MAX_ITEMS: 200,
    // The body shapes, as the engine declares them (preview.ts), kept to what the routes parse.
    ITEM_INPUT: z.object({ candidateId: z.string().min(5), to: z.unknown().optional(), match: z.enum(['EXACT', 'PHRASE']).optional(), bidCents: z.number().int().optional(), negateSource: z.boolean().optional(), funnel: z.boolean().optional() }),
    NEW_CAMPAIGN_INPUT: z.object({ key: z.string(), productId: z.string() }).passthrough(),
    NEW_PORTFOLIO_INPUT: z.object({ key: z.string(), name: z.string() }).passthrough(),
    harvestCandidates: rec('harvestCandidates', (q: { market: string }) => (q.market === 'XX' ? { error: 'market: XX is not a market code', status: 400 } : { data: { markets: ['IT'], rows: [row], total: 1, totals: { ready: 1 } } })),
    harvestDestinations: rec('harvestDestinations', { data: { market: 'IT', portfolios: [] } }),
    previewChangeSet: rec('previewChangeSet', { data: { steps: [{ i: 0, kind: 'keyword', bidCents: 35 }], planHash: 'hash-1234567890' }, plan: {} }),
    requestHarvestTool: rec('requestHarvestTool', (args: Record<string, unknown>) => (args.planHash === 'moved-hash-0000' ? { error: 'Not queued: the plan moved since your review.', status: 409 } : { data: { changeSetId: 'ap1', status: 'queued', expiresAt: null } })),
    skipCandidates: rec('skipCandidates', { changed: 1, until: null, forGood: true, ids: ['IT|p1|touring jacket'], refused: [] }),
    unskipCandidates: rec('unskipCandidates', { changed: 1, ids: ['IT|p1|touring jacket'], refused: [] }),
    unknownHarvests: rec('unknownHarvests', (ids: string[]) => ids.filter((id) => id.startsWith('foreign'))),
    decideHarvestRequests: rec('decideHarvestRequests', { results: [{ approvalId: 'ap1', ok: true, status: 'scheduled' }] }),
    marketsOf: rec('marketsOf', (m: string) => (m === 'XX' ? { error: 'market: XX is not a market code' } : [m])),
    harvestHistory: rec('harvestHistory', { data: { rows: [], totals: { harvested: 0 } } }),
    listHarvestRules: rec('listHarvestRules', { market: 'IT', rules: [{ id: 'brain' }], totals: {} }),
    harvestRuleHistory: rec('harvestRuleHistory', (id: string) => (id === 'nope' ? { error: 'No harvest rule nope in this business.', status: 404 } : { data: { id, harvests: [] } })),
    previewHarvestRule: rec('previewHarvestRule', { data: { wouldHarvest: 1 } }),
    setHarvestRuleArchived: rec('setHarvestRuleArchived', (id: string, archived: boolean) => ({ data: { id, archived } })),
    setHarvestRulesMode: rec('setHarvestRulesMode', { results: [{ id: 'r1', ok: true }] }),
    harvestSources: rec('harvestSources', { data: { market: 'IT', rows: [] } }),
    assignSources: rec('assignSources', (ruleId: string) => (ruleId === 'scoped' ? { id: ruleId, ok: false, changed: 0, error: 'reaches its sources by its scope' } : { id: ruleId, ok: true, changed: 2 })),
    detachSources: rec('detachSources', { results: [] }),
    pauseSources: rec('pauseSources', { paused: ['g1'], already: [], notFound: [] }),
    resumeSources: rec('resumeSources', { resumed: 1 }),
  }
})
vi.mock('../services/agents/call-tool.js', async (original) => {
  const real = await original<typeof import('../services/agents/call-tool.js')>()
  return {
    ...real,
    requestPrincipal: vi.fn(async (request: { headers: Record<string, unknown> }) => {
      if (!request.headers['x-user']) throw new real.ToolAccessError('forbidden', 'A signed-in user is required to use the assistant.', 403)
      return { kind: 'user', userId: String(request.headers['x-user']), label: 'Owner', permissions: { isOwner: true, permissions: new Set() }, via: 'app' }
    }),
  }
})

let app: FastifyInstance
let permissions: ResolvedPermissions = { isOwner: true, permissions: new Set() }
const get = (url: string) => app.inject({ method: 'GET', url })
const post = (url: string, payload: object, user = 'owner-1') => app.inject({ method: 'POST', url, payload, headers: user ? { 'x-user': user, 'x-actor-id': user } : {} })
const last = (name: string) => [...h.calls].reverse().find(([n]) => n === name)?.[1]

beforeAll(async () => {
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  const { default: routes } = await import('./advertising-harvest.routes.js')
  app = Fastify()
  app.addHook('preHandler', (request, _reply, done) => { request.__rbacResolved = permissions; done() })
  await app.register(routes, { prefix: '/api' })
  await app.ready()
}, 120_000)
afterAll(async () => { vi.unstubAllEnvs(); await app?.close() })
beforeEach(() => { h.calls = []; permissions = { isOwner: true, permissions: new Set() } })

describe('reads', () => {
  it('candidates: the query as the engine takes it (states and owner), no-store; a bad market is the engine\'s 400', async () => {
    const r = await get('/api/advertising/harvest/candidates?market=IT&state=READY,WAITING&owner=brain&pageSize=20&sort=-acos')
    expect(r.statusCode).toBe(200)
    expect(r.headers['cache-control']).toBe('no-store')
    expect(last('harvestCandidates')?.[0]).toMatchObject({ market: 'IT', state: ['READY', 'WAITING'], owner: 'BRAIN', pageSize: 20, sort: '-acos' })
    expect(r.json()).toMatchObject({ rows: [{ id: 'IT|p1|touring jacket', startBidCents: 35 }] })
    expect((await get('/api/advertising/harvest/candidates?market=XX')).statusCode).toBe(400)
    expect((await get('/api/advertising/harvest/candidates')).json()).toMatchObject({ error: expect.stringMatching(/^market:/) })
  })

  it('candidates: the scope filter\'s lists (2026-10-12) — trimmed, empty parts dropped, an id once, beside the singulars; 501 is a 400', async () => {
    const r = await get('/api/advertising/harvest/candidates?market=IT&campaignIds=c1,%20c2,,c1&portfolioIds=PF-1&adGroupIds=g1&productId=p1&productIds=p2,p3')
    expect(r.statusCode).toBe(200)
    expect(last('harvestCandidates')?.[0]).toMatchObject({ market: 'IT', campaignIds: ['c1', 'c2'], portfolioIds: ['PF-1'], adGroupIds: ['g1'], productId: 'p1', productIds: ['p2', 'p3'] })
    h.calls = []
    const over = await get(`/api/advertising/harvest/candidates?market=IT&productIds=${Array.from({ length: 501 }, (_, i) => `p${i}`).join(',')}`)
    expect(over.statusCode).toBe(400)
    expect(over.json()).toMatchObject({ code: 'too_many', max: 500, path: 'productIds' })
    expect(last('harvestCandidates')).toBeUndefined()
    expect((await get(`/api/advertising/harvest/candidates?market=IT&productIds=${Array.from({ length: 500 }, (_, i) => `p${i}`).join(',')}`)).statusCode).toBe(200)
  })

  it('destinations need the product (or a candidate)', async () => {
    expect((await get('/api/advertising/harvest/destinations?market=IT')).statusCode).toBe(400)
    expect((await get('/api/advertising/harvest/destinations?market=IT&productId=p1&match=PHRASE')).statusCode).toBe(200)
    expect(last('harvestDestinations')?.[0]).toMatchObject({ market: 'IT', productId: 'p1', match: 'PHRASE' })
  })

  it('history, rules, a rule\'s history (404 when not one), sources', async () => {
    expect((await get('/api/advertising/harvest/history?market=IT&days=30&verdict=worse')).statusCode).toBe(200)
    expect(last('harvestHistory')?.[0]).toMatchObject({ market: ['IT'], days: 30, verdict: 'worse' })
    expect((await get('/api/advertising/harvest/history?market=XX')).statusCode).toBe(400)
    expect((await get('/api/advertising/harvest/rules?market=IT')).json()).toMatchObject({ rules: [{ id: 'brain' }] })
    expect((await get('/api/advertising/harvest/rules/nope/history')).statusCode).toBe(404)
    expect((await get('/api/advertising/harvest/sources?market=IT')).statusCode).toBe(200)
  })

  it('money: a person without ad-spend money gets the answer minus exactly the money keys', async () => {
    permissions = { isOwner: false, permissions: new Set(['ads.view']) }
    const r = (await get('/api/advertising/harvest/candidates?market=IT')).json()
    expect(r.rows[0]).toEqual({ id: 'IT|p1|touring jacket', term: 'touring jacket', state: 'READY', metrics: { orders: 4, clicks: 100 } })
    permissions = { isOwner: false, permissions: new Set(['ads.view', FIELDS.financialsAdspendView]) }
    expect((await get('/api/advertising/harvest/candidates?market=IT')).json().rows[0].startBidCents).toBe(35)
  })
})

describe('writes', () => {
  const item = { candidateId: 'IT|p1|touring jacket' }

  it('preview writes nothing and needs a person; a body it does not take is 400', async () => {
    expect((await post('/api/advertising/harvest/preview', { items: [item] })).json()).toMatchObject({ planHash: 'hash-1234567890' })
    expect(last('previewChangeSet')?.[1]).toMatchObject({ actor: 'PERSON', who: { actor: 'user:owner-1', manual: true } })
    expect((await post('/api/advertising/harvest/preview', { items: [item] }, '')).statusCode).toBe(403)
    expect((await post('/api/advertising/harvest/preview', { items: [] })).statusCode).toBe(400)
    expect((await post('/api/advertising/harvest/preview', { items: [{ ...item, match: 'BROAD' }] })).statusCode).toBe(400)
  })

  it('apply: ONE apply-harvest request (202 with its change set), approve in the same click passed on; a moved plan is 409', async () => {
    const r = await post('/api/advertising/harvest/apply', { items: [item], planHash: 'hash-1234567890', approve: true })
    expect(r.statusCode).toBe(202)
    expect(r.json()).toEqual({ changeSetId: 'ap1', status: 'queued', expiresAt: null })
    const [args, person, opts] = last('requestHarvestTool') as [Record<string, unknown>, { userId: string }, { approve: boolean }]
    expect(args).toEqual({ op: 'harvest', items: [item], planHash: 'hash-1234567890' })
    expect(person.userId).toBe('owner-1')
    expect(opts).toMatchObject({ approve: true })
    expect((await post('/api/advertising/harvest/apply', { items: [item], planHash: 'moved-hash-0000' })).statusCode).toBe(409)
    expect((await post('/api/advertising/harvest/apply', { items: [item] })).statusCode).toBe(400)
    expect((await post('/api/advertising/harvest/apply', { items: [item], planHash: 'hash-1234567890' }, '')).statusCode).toBe(403)
  })

  it('undo: ONE request (op undo) for many harvests; another business\'s harvest is 404 and nothing is asked', async () => {
    const r = await post('/api/advertising/harvest/undo', { harvestIds: ['h1', 'h2'] })
    expect(r.statusCode).toBe(202)
    expect(last('requestHarvestTool')?.[0]).toEqual({ op: 'undo', harvestIds: ['h1', 'h2'] })
    expect((await post('/api/advertising/harvest/undo', { harvestIds: [] })).statusCode).toBe(400)
    h.calls = []
    expect((await post('/api/advertising/harvest/undo', { harvestIds: ['h1', 'foreign-1'] })).statusCode).toBe(404)
    expect(last('requestHarvestTool')).toBeUndefined()
  })

  it('L6 — skip, rules and sources take the signed-in person as the actor, never a header: no person is 403', async () => {
    const anon = (url: string, payload: object) => app.inject({ method: 'POST', url, payload, headers: { 'x-actor-id': 'spoofed' } })
    expect((await anon('/api/advertising/harvest/skip', { ids: ['IT|p1|touring jacket'], days: 7 })).statusCode).toBe(403)
    expect((await anon('/api/advertising/harvest/rules/mode', { ids: ['r1'], mode: 'OFF' })).statusCode).toBe(403)
    expect((await anon('/api/advertising/harvest/sources/pause', { adGroupIds: ['g1'] })).statusCode).toBe(403)
    expect(last('skipCandidates')).toBeUndefined()
  })

  it('skip 7 / 30 / for good and unskip (bulk ids), Nexus only; another number of days is 400', async () => {
    expect((await post('/api/advertising/harvest/skip', { ids: [item.candidateId], days: null })).statusCode).toBe(200)
    expect(last('skipCandidates')).toEqual([[item.candidateId], null, 'user:owner-1'])
    expect((await post('/api/advertising/harvest/skip', { ids: [item.candidateId], days: 14 })).statusCode).toBe(400)
    expect((await post('/api/advertising/harvest/unskip', { ids: [item.candidateId] })).json()).toMatchObject({ changed: 1 })
  })

  it('waiting/decide: each decision through the engine as this person', async () => {
    const r = await post('/api/advertising/harvest/waiting/decide', { decisions: [{ approvalId: 'ap1', decide: 'approve' }, { approvalId: 'ap2', decide: 'reject' }], reason: 'not now' })
    expect(r.json()).toMatchObject({ results: [{ approvalId: 'ap1', ok: true }] })
    expect(last('decideHarvestRequests')?.[0]).toEqual([{ approvalId: 'ap1', decide: 'approve' }, { approvalId: 'ap2', decide: 'reject' }])
    expect((await post('/api/advertising/harvest/waiting/decide', { decisions: [{ approvalId: 'ap1', decide: 'maybe' }] })).statusCode).toBe(400)
  })

  it('rules: mode of many, archive / unarchive, preview; sources: assign (a scoped rule refused 400), detach, pause, resume', async () => {
    expect((await post('/api/advertising/harvest/rules/mode', { ids: ['r1', 'brain'], mode: 'AUTO' })).statusCode).toBe(200)
    expect(last('setHarvestRulesMode')).toEqual([['r1', 'brain'], 'AUTO', 'user:owner-1', {}])
    // RS4 — an Undo names the belt to put back (null: the rule had none).
    expect((await post('/api/advertising/harvest/rules/mode', { ids: ['r1'], mode: 'WATCH', belt: null })).statusCode).toBe(200)
    expect(last('setHarvestRulesMode')).toEqual([['r1'], 'WATCH', 'user:owner-1', { belt: null }])
    // Delta review D1 — and the harvest Auto mark as it was (`before.marked`): false never sets one.
    expect((await post('/api/advertising/harvest/rules/mode', { ids: ['r1'], mode: 'AUTO', belt: null, marked: false })).statusCode).toBe(200)
    expect(last('setHarvestRulesMode')).toEqual([['r1'], 'AUTO', 'user:owner-1', { belt: null, marked: false }])
    // R6 — a list past its cap: a 400 the page splits on (code too_many, max, path).
    const over = await post('/api/advertising/harvest/undo', { harvestIds: Array.from({ length: 201 }, (_, i) => `h${i}`) })
    expect(over.statusCode).toBe(400)
    expect(over.json()).toMatchObject({ code: 'too_many', max: 200, path: 'harvestIds' })
    expect((await post('/api/advertising/harvest/waiting/decide', { decisions: Array.from({ length: 500 }, (_, i) => ({ approvalId: `a${i}`, decide: 'reject' })) })).statusCode).toBe(200)
    expect((await post('/api/advertising/harvest/rules/mode', { ids: ['r1'], mode: 'LOUD' })).statusCode).toBe(400)
    expect((await post('/api/advertising/harvest/rules/r1/archive', {})).json()).toEqual({ id: 'r1', archived: true })
    expect((await post('/api/advertising/harvest/rules/r1/unarchive', {})).json()).toEqual({ id: 'r1', archived: false })
    expect((await post('/api/advertising/harvest/rules/preview', { ruleId: 'r1' })).json()).toEqual({ wouldHarvest: 1 })
    expect((await post('/api/advertising/harvest/sources/assign', { ruleId: 'r1', adGroupIds: ['g1', 'g2'] })).json()).toMatchObject({ ok: true, changed: 2 })
    expect((await post('/api/advertising/harvest/sources/assign', { ruleId: 'scoped', adGroupIds: ['g1'] })).statusCode).toBe(400)
    expect((await post('/api/advertising/harvest/sources/detach', { adGroupIds: ['g1'] })).statusCode).toBe(200)
    expect(last('detachSources')).toEqual([null, ['g1'], 'user:owner-1'])
    expect((await post('/api/advertising/harvest/sources/pause', { adGroupIds: ['g1'], reason: 'brand only' })).json()).toMatchObject({ paused: ['g1'] })
    expect((await post('/api/advertising/harvest/sources/resume', { adGroupIds: ['g1'] })).json()).toEqual({ resumed: 1 })
  })
})
