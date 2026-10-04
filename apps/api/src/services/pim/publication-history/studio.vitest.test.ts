import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'

/**
 * Sheet publish parity, step 4 — product sheet publications in the publish history, on the real schema and tenant
 * policies, through the real routes.
 *
 * One family (a parent and two sizes) and one other product; publications in every state, written as the publish path
 * leaves them. The cases pin: reviews that were never sent are not runs; another business's runs never show; the
 * state of each run (including a sweep that gave up, a publication from before the sweep, a send still inside its
 * receipt window, and one a person marked checked — still needs_check, but no finish time and nobody left to check it); every filter; paging over equal timestamps; the list never reads
 * the stored change plan; a run's detail (failed first, the variation, the fields sent, the channel's issues, the
 * steps); and the exact request is served per listing.
 */
const state = vi.hoisted(() => ({ db: null as any, raw: [] as Array<{ sql: string; result: unknown }> }))
vi.mock('@nexus/database', async () => {
  const { concurrentDatabase, concurrentDatabaseUrl } = await import('../../../test-support/concurrent-database.js')
  const { formulaDatabase } = await import('../../../test-support/formula-database.js')
  state.db = concurrentDatabaseUrl() ? await concurrentDatabase() : await formulaDatabase()
  const client = state.db.client
  // Every raw statement and what it returned, so a case can prove what was (not) read out of the database.
  return { default: new Proxy(client, { get(target, prop) {
    if (prop === '$queryRaw') return async (query: { strings: string[] }, ...rest: unknown[]) => {
      const result = await target.$queryRaw(query, ...rest)
      state.raw.push({ sql: query.strings.join('?'), result })
      return result
    }
    const value = Reflect.get(target, prop, target)
    return typeof value === 'function' ? value.bind(target) : value
  } }) }
})

import prisma from '../../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import { countPublicationHistory, listPublicationHistory, parseHistoryQuery, publicationRunDetail, publicationRunRequest } from '../publication-history.service.js'
import { permissionForRoute } from '../../../lib/auth/permissions-manifest.js'
import { countsOf } from './studio.js'

const scoped = <T>(work: () => Promise<T>, workspaceId = LEGACY_WORKSPACE_ID) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
/** Sits in every stored change plan: if it ever comes out of the database in a LIST read, the list loaded too much. */
const MARKER = 'CHANGE-PLAN-MUST-NOT-BE-READ'
const OTHER_BUSINESS = `other-${randomUUID()}`
const NOW = new Date(Date.UTC(2026, 9, 1, 12, 0))
const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 10, minute))
const ids: Record<string, string> = {}
const listing: Record<string, string> = {}
let app: FastifyInstance

async function publication(id: string, input: { status: string; minute: number | Date; channel?: string; account?: string; product?: string; userId?: string | null
  summary?: Record<string, unknown>; results?: Array<Record<string, unknown>>; nextCheckAt?: Date | null; checkCount?: number | null; review?: Record<string, unknown>
  selection?: Record<string, unknown>; delivery?: Record<string, unknown>; changeCount?: number; productCount?: number; completedAt?: Date | null; aliasKey?: string }) {
  const time = input.minute instanceof Date ? input.minute : at(input.minute)
  await prisma.bulkOperation.create({ data: {
    id, userId: input.userId ?? null, productCount: input.productCount ?? 3, changeCount: input.changeCount ?? 2, status: input.status,
    changes: { kind: 'studio-publication', changePlan: { note: MARKER }, review: { action: 'update', rows: [], ...input.review },
      ...(input.selection ? { selection: input.selection } : {}), ...(input.delivery ? { delivery: input.delivery } : {}),
      ...(input.results ? { result: { id, status: input.status, message: 'stored', results: input.results } } : {}) },
    kind: 'studio-publication', productId: input.product ?? ids.root, channel: input.channel ?? 'AMAZON', marketplace: 'IT',
    channelConnectionId: input.account ?? ids.a, aliasKey: input.aliasKey ?? '',
    submittedAt: input.status === 'PREVIEW' ? null : time, createdAt: time, completedAt: input.completedAt ?? null,
    nextCheckAt: input.nextCheckAt ?? null, checkCount: input.checkCount ?? null,
    summary: input.status === 'PREVIEW' ? undefined : (input.summary ?? { products: 3, verified: 3, accepted: 0, failed: 0, submitted: 0, message: `${input.status} message` }),
  } as never })
}

async function journal(listingId: string, publicationId: string, input: { sku: string; productId: string; fields?: string[]; create?: boolean }) {
  const request = input.create
    ? { message: { sku: input.sku, operationType: 'UPDATE' }, intentVersion: 1, writes: [{ field: 'item_name' }] }
    : { message: { sku: input.sku, operationType: 'PATCH' }, intentVersion: 1, writes: (input.fields ?? []).map(field => ({ field, value: { state: 'value', value: 'x' } })) }
  await prisma.channelListingSnapshot.create({ data: {
    channelListingId: listingId, channel: 'AMAZON', marketplace: 'IT', aliasKey: '', reason: 'publish', publishEventId: publicationId, outcome: 'UNACCEPTED',
    payload: { schemaVersion: 1, kind: 'studio-publication', productId: input.productId, channelConnectionId: ids.a, sku: input.sku, requests: [request] },
  } as never })
}

const list = async (raw: Record<string, unknown> = {}, now = NOW) => scoped(async () => listPublicationHistory(await parseHistoryQuery(raw), { now }))
const totals = async (raw: Record<string, unknown> = {}, now = NOW, workspaceId = LEGACY_WORKSPACE_ID) =>
  scoped(async () => countPublicationHistory(await parseHistoryQuery(raw), { now }), workspaceId)
/** Every run the list returns for this query, paged to the end. */
async function everyRun(raw: Record<string, unknown>, now = NOW) {
  const runs: Array<{ id: string; state: string; checkedAt: string | null }> = []
  let cursor: string | undefined
  for (let page = 0; page < 50; page++) {
    const result = await list({ ...raw, limit: 3, ...(cursor ? { cursor } : {}) }, now)
    runs.push(...result.runs)
    if (!result.nextCursor) return runs
    cursor = result.nextCursor
  }
  throw new Error('the list did not end')
}
/** Each count equals the length of the list its tile opens, for the same filters. */
async function expectCountsMatchList(filters: Record<string, unknown>, now = NOW) {
  const counted = await totals(filters, now)
  const length = async (extra: Record<string, unknown>) => (await everyRun({ ...filters, ...extra }, now)).length
  const latest = (...isos: Array<unknown>) => isos.filter((v): v is string => typeof v === 'string').sort().at(-1)
  expect(counted.total).toBe(await length({}))
  for (const state of ['in_progress', 'succeeded', 'partial', 'failed', 'needs_check']) expect(counted.byState[state as 'failed']).toBe(await length({ state }))
  expect(counted.needsAttention).toBe(await length({ state: 'failed,partial,needs_check', checked: 'false' }))
  expect(counted.inProgress).toBe(await length({ state: 'in_progress' }))
  expect(counted.doneLast7Days).toBe(await length({ state: 'succeeded,partial,failed', from: latest(filters.from, counted.recentSince) }))
  expect(counted.checked).toBe(await length({ checked: 'true' }))
  return counted
}
const idsOf = async (raw: Record<string, unknown> = {}) => (await list({ limit: 100, ...raw })).runs.map(run => run.id)

beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon IT', region: 'EU', currency: 'EUR', language: 'it', languages: ['it'] } as never })
    ids.user = (await prisma.userProfile.create({ data: { displayName: 'Publisher Person', email: `p-${randomUUID()}@example.test` } as never })).id
    ids.checker = (await prisma.userProfile.create({ data: { displayName: 'Checker Person', email: `c-${randomUUID()}@example.test` } as never })).id
    ids.a = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'Account A', isActive: true, externalAccountId: 'SELLER-A', authStatus: 'connected', managedBy: 'oauth', region: 'EU' } as never })).id
    ids.root = (await prisma.product.create({ data: { sku: 'COAT', name: 'Winter coat', basePrice: 10, isParent: true } as never })).id
    ids.s = (await prisma.product.create({ data: { sku: 'COAT-S', name: 'Coat S', basePrice: 10, parentId: ids.root, variantAttributes: { Colore: 'Nero', Taglia: 'S' } } as never })).id
    ids.m = (await prisma.product.create({ data: { sku: 'COAT-M', name: 'Coat M', basePrice: 10, parentId: ids.root, variantAttributes: { Colore: 'Nero', Taglia: 'M' } } as never })).id
    ids.other = (await prisma.product.create({ data: { sku: 'GLOVE', name: 'Glove', basePrice: 10 } as never })).id
    for (const [key, productId] of [['root', ids.root], ['s', ids.s], ['m', ids.m]] as const)
      listing[key] = (await prisma.channelListing.create({ data: { productId, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU',
        channelConnectionId: ids.a, ...(key === 's' ? { externalListingId: 'ASIN-S' } : {}) } as never })).id

    await publication('p-verified', { status: 'VERIFIED', minute: 10, userId: ids.user, completedAt: at(12),
      results: [{ sku: 'COAT', status: 'VERIFIED', message: 'Verified', reference: 'FEED-1' }] })
    await publication('p-other-same-time', { status: 'VERIFIED', minute: 10, product: ids.other })
    await publication('p-partial', { status: 'PARTIAL', minute: 20, userId: ids.user, completedAt: at(25), changeCount: 3,
      summary: { products: 3, accepted: 2, verified: 0, failed: 1, submitted: 0, message: 'Amazon refused 1 of 3.' },
      review: { action: 'update', rows: [{ productId: ids.root, sku: 'COAT', title: 'Coat', existing: true }, { productId: ids.s, sku: 'COAT-S', title: 'Coat S', existing: true },
        { productId: ids.m, sku: 'COAT-M', title: 'Coat M', existing: true }],
      changes: [{ id: 'chg-s-colour', productId: ids.s, sku: 'COAT-S', field: 'color', label: 'Colour', status: 'SEND' }, { id: 'chg-m-size', productId: ids.m, sku: 'COAT-M', field: 'size', label: 'Size', status: 'SEND' }] },
      selection: { selectedIds: ['chg-s-colour'] }, delivery: { productIds: [ids.root, ids.s, ids.m] },
      results: [{ sku: 'COAT', status: 'ACCEPTED', message: 'Accepted', reference: 'FEED-2' },
        { sku: 'COAT-S', status: 'FAILED', message: 'Amazon refused the colour.', reference: 'FEED-2', issues: [{ code: '8541', severity: 'error', message: 'Not an allowed value.', attributeNames: ['color'] }] },
        { sku: 'COAT-M', status: 'ACCEPTED', message: 'Accepted', reference: 'FEED-2' }] })
    await journal(listing.root, 'p-partial', { sku: 'COAT', productId: ids.root, fields: ['item_name'] })
    await journal(listing.s, 'p-partial', { sku: 'COAT-S', productId: ids.s, fields: ['color', 'color'] })
    await journal(listing.m, 'p-partial', { sku: 'COAT-M', productId: ids.m, create: true })
    await publication('p-not-sent', { status: 'FAILED', minute: 30, results: [], summary: { products: 0, accepted: 0, verified: 0, failed: 0, submitted: 0, message: 'Nothing was submitted.' } })
    await publication('p-sweeping', { status: 'SUBMITTED', minute: 40, nextCheckAt: at(42), checkCount: 1, summary: { products: 3, submitted: 3 } })
    // The sweep's own word wins even over a lease it left behind (a claim's nextCheckAt), so a gave-up run never reads as in progress.
    await publication('p-gave-up', { status: 'SUBMITTED', minute: 40, nextCheckAt: at(45), checkCount: 9, summary: { products: 3, submitted: 3, needsCheck: true } })
    await publication('p-before-sweep', { status: 'SUBMITTED', minute: 41, summary: { products: 3, submitted: 3 } })
    await publication('p-sending', { status: 'PUBLISHING', minute: new Date(NOW.getTime() - 5 * 60_000) })
    await publication('p-stuck-sending', { status: 'PUBLISHING', minute: 50 })
    await publication('p-checked', { status: 'UNVERIFIED', minute: 55, channel: 'EBAY', completedAt: at(58),
      summary: { products: 3, message: 'No answer.', checkedAt: at(58).toISOString(), checkedBy: ids.checker, checkedNote: 'Live on eBay.' } })
    await publication('p-review-only', { status: 'PREVIEW', minute: 59 })
    await prisma.bulkOperation.create({ data: { id: 'bulk-edit', userId: null, productCount: 1, changeCount: 1, status: 'SUCCESS', changes: [] } as never })
  })
  const owner = await prisma.userProfile.create({ data: { email: `o-${randomUUID()}@example.test`, status: 'active' } as never })
  await prisma.workspace.create({ data: { id: OTHER_BUSINESS, name: 'Other business', createdByUserId: owner.id, creationKey: randomUUID() } as never })
  await scoped(async () => {
    await prisma.bulkOperation.create({ data: { id: 'p-other-business', userId: null, productCount: 1, changeCount: 1, status: 'VERIFIED', changes: {},
      kind: 'studio-publication', productId: 'x', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'x', aliasKey: '', submittedAt: at(59), createdAt: at(59) } as never })
  }, OTHER_BUSINESS)

  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => {
    withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }, done)
  })
  const { default: routes } = await import('../../../routes/publication-history.routes.js')
  await app.register(routes, { prefix: '/api' })
  await app.ready()
}, 180_000)

afterAll(async () => {
  await app?.close()
  await state.db?.close?.()
})

describe('product sheet publications in the publish history', () => {
  it('lists sent runs only, newest first, in this business only', async () => {
    expect(await idsOf()).toEqual(['p-sending', 'p-checked', 'p-stuck-sending', 'p-before-sweep', 'p-sweeping', 'p-gave-up', 'p-not-sent', 'p-partial', 'p-verified', 'p-other-same-time'])
  })

  it('decides each state, including a gave-up sweep, a run from before the sweep, the receipt window and a person\'s check', async () => {
    const runs = new Map((await list({ limit: 100 })).runs.map(run => [run.id, run]))
    expect(Object.fromEntries([...runs].map(([id, run]) => [id, run.state]))).toEqual({
      'p-sending': 'in_progress', 'p-checked': 'needs_check', 'p-stuck-sending': 'needs_check', 'p-before-sweep': 'needs_check', 'p-sweeping': 'in_progress',
      'p-gave-up': 'needs_check', 'p-not-sent': 'failed', 'p-partial': 'partial', 'p-verified': 'succeeded', 'p-other-same-time': 'succeeded',
    })
    expect(runs.get('p-gave-up')!.needsCheck).toBe(true)
    // A person's check keeps the result unknown: still needs_check, but nobody has to check it again, and the check time is no finish time.
    expect(runs.get('p-checked')).toMatchObject({ checkedAt: at(58).toISOString(), checkedBy: 'Checker Person', status: 'UNVERIFIED', needsCheck: false, finishedAt: null })
    expect(runs.get('p-partial')).toMatchObject({ familySku: 'COAT', familyTitle: 'Winter coat', accountLabel: 'Account A', aliasLabel: null, fieldCount: 3,
      reference: 'FEED-2', userName: 'Publisher Person', kind: 'update', message: 'Amazon refused 1 of 3.', finishedAt: at(25).toISOString(),
      counts: { accepted: 2, verified: 0, failed: 1, waiting: 0, notSent: 0, skipped: 0, unknown: 0 } })
    expect(runs.get('p-not-sent')!.counts.notSent).toBe(3)
    expect(runs.get('p-sweeping')!.counts.waiting).toBe(3)
  })

  it('filters by state, channel, account, family (asked by any member), user, time and text', async () => {
    expect(await idsOf({ state: 'needs_check' })).toEqual(['p-checked', 'p-stuck-sending', 'p-before-sweep', 'p-gave-up'])
    expect(await idsOf({ state: 'in_progress,failed' })).toEqual(['p-sending', 'p-sweeping', 'p-not-sent'])
    expect(await idsOf({ channel: 'ebay' })).toEqual(['p-checked'])
    expect(await idsOf({ accountId: 'nobody' })).toEqual([])
    expect(await idsOf({ productId: ids.s })).not.toContain('p-other-same-time')
    expect(await idsOf({ productId: ids.other })).toEqual(['p-other-same-time'])
    expect(await idsOf({ userId: ids.user })).toEqual(['p-partial', 'p-verified'])
    expect(await idsOf({ from: at(20).toISOString(), to: at(30).toISOString() })).toEqual(['p-not-sent', 'p-partial'])
    expect(await idsOf({ q: 'glove' })).toEqual(['p-other-same-time'])
    expect(await idsOf({ q: 'COAT-M', state: 'succeeded' })).toEqual(['p-verified'])
    expect(await idsOf({ q: 'FEED-2' })).toEqual(['p-partial'])
    expect(await idsOf({ q: 'p-not-sent' })).toEqual(['p-not-sent'])
  })

  it('pages over equal timestamps without repeating or skipping a run', async () => {
    const all = await idsOf()
    for (const size of [1, 2, 3]) {
      const seen: string[] = []
      let cursor: string | undefined
      for (let page = 0; page < 20; page++) {
        const result = await list({ limit: size, ...(cursor ? { cursor } : {}) })
        seen.push(...result.runs.map(run => run.id))
        if (!result.nextCursor) break
        cursor = result.nextCursor
      }
      expect(seen).toEqual(all)
    }
  })

  it('a list never reads the stored change plan', async () => {
    state.raw.length = 0
    await list({ limit: 100 })
    await list({ limit: 100, q: 'FEED-2' })
    expect(state.raw.length).toBeGreaterThan(0)
    expect(JSON.stringify(state.raw.map(entry => entry.result))).not.toContain(MARKER)
    for (const entry of state.raw) expect(entry.sql).not.toMatch(/b\.changes\s*(,|AS\b|FROM\b)|SELECT\s+\*/i)
  })

  it('says the product sheet is covered, and every other source too (none has runs here)', async () => {
    const coverage = (await list()).coverage
    expect(coverage.find(c => c.source === 'studio')).toMatchObject({ included: true, since: at(10).toISOString() })
    expect(coverage.filter(c => c.source !== 'studio')).toEqual([
      { source: 'listing-action', included: true, since: null, note: null },
      { source: 'amazon-flat-file', included: true, since: null, note: null },
      { source: 'ebay-flat-file', included: true, since: null, note: null },
      { source: 'photos', included: true, since: null, note: null },
    ])
  })

  it('a run in full: failed first, variations, fields sent, chosen changes, channel issues and steps', async () => {
    const detail = await scoped(() => publicationRunDetail('p-partial', { now: NOW }))
    expect(detail.products.map(p => [p.sku, p.result])).toEqual([['COAT-S', 'FAILED'], ['COAT', 'ACCEPTED'], ['COAT-M', 'ACCEPTED']])
    expect(detail.products[0]).toMatchObject({ variationLabel: 'Nero · S', message: 'Amazon refused the colour.', code: '8541', fieldLabel: 'color',
      listingId: listing.s, externalId: 'ASIN-S', sentFields: ['color'], changes: [{ id: 'chg-s-colour' }] })
    expect(detail.products[0].issues).toEqual([{ code: '8541', severity: 'error', message: 'Not an allowed value.', attributeNames: ['color'] }])
    expect(detail.products.find(p => p.sku === 'COAT-M')).toMatchObject({ sentFields: ['$create'], variationLabel: 'Nero · M' })
    expect(detail.products.find(p => p.sku === 'COAT-M')).not.toHaveProperty('changes')
    expect(detail.steps.map(s => s.key)).toEqual(['reviewed', 'sent', 'received', 'processed'])
    expect(detail.steps.find(s => s.key === 'processed')).toMatchObject({ label: 'Amazon refused 1 of 3', tone: 'warning', at: at(25).toISOString() })
    expect(detail.hasRequest).toBe(true)
    expect(JSON.stringify(detail)).not.toContain(MARKER)
  })

  it('a refused send says nothing was sent; a checked run says who checked it', async () => {
    const notSent = await scoped(() => publicationRunDetail('p-not-sent', { now: NOW }))
    expect(notSent.steps.map(s => s.key)).toEqual(['reviewed', 'not_sent'])
    const checked = await scoped(() => publicationRunDetail('p-checked', { now: NOW }))
    expect(checked.steps.at(-1)).toMatchObject({ key: 'checked', label: 'Marked as checked by Checker Person', detail: 'Live on eBay.' })
    expect(checked.steps.map(s => s.key)).not.toContain('needs_check')
    const gaveUp = await scoped(() => publicationRunDetail('p-gave-up', { now: NOW }))
    expect(gaveUp.steps.map(s => s.key)).toContain('needs_check')
  })

  it('serves the exact request per listing, and refuses one that was not kept', async () => {
    const found = await scoped(() => publicationRunRequest('p-partial', listing.s))
    expect(found).toMatchObject({ sku: 'COAT-S', requests: [{ message: { sku: 'COAT-S' } }] })
    await expect(scoped(() => publicationRunRequest('p-verified', listing.s))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('the routes answer, refuse a wrong query with a 400, and a missing run with a 404', async () => {
    const page = await app.inject({ method: 'GET', url: '/api/publications?limit=2' })
    expect(page.statusCode).toBe(200)
    expect(page.headers['cache-control']).toBe('no-store')
    expect(page.json().runs).toHaveLength(2)
    expect(page.json().nextCursor).toEqual(expect.any(String))
    const family = await app.inject({ method: 'GET', url: `/api/products/${ids.m}/publications?limit=100` })
    expect(family.json().runs.map((run: { id: string }) => run.id)).not.toContain('p-other-same-time')
    expect((await app.inject({ method: 'GET', url: '/api/publications?state=done' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/products/nobody/publications' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/publications/p-partial' })).json().products).toHaveLength(3)
    expect((await app.inject({ method: 'GET', url: '/api/publications/p-review-only' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/publications/p-other-business' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/api/publications/p-partial/listings/${listing.m}/request` })).statusCode).toBe(200)
  })
})

describe('exact counts and Show in sheet support', () => {
  it('equal the length of the list each tile opens, for every filter', async () => {
    const combos: Array<Record<string, unknown>> = [{}, { channel: 'AMAZON' }, { channel: 'EBAY' }, { marketplace: 'IT' }, { accountId: ids.a }, { accountId: 'nobody' },
      { productId: ids.s }, { productId: ids.other }, { userId: ids.user }, { from: at(20).toISOString(), to: at(45).toISOString() }, { q: 'COAT' }, { q: 'FEED-2' },
      { source: 'studio' }, { source: 'photos' }]
    for (const filters of combos) await expectCountsMatchList(filters)
    // A week later every run here is older than the window: nothing is "done lately", and states move on with the clock.
    const later = new Date(NOW.getTime() + 8 * 24 * 60 * 60_000)
    expect((await expectCountsMatchList({}, later)).doneLast7Days).toBe(0)
  })

  it('leave a run marked as checked out of "needs attention", and count it as checked', async () => {
    const counted = await totals()
    expect(counted).toMatchObject({ total: 10, inProgress: 2, checked: 1, doneLast7Days: 4,
      byState: { in_progress: 2, succeeded: 2, partial: 1, failed: 1, needs_check: 4 } })
    expect(counted.needsAttention).toBe(1 + 1 + 4 - 1)
    expect(await idsOf({ checked: 'true' })).toEqual(['p-checked'])
    expect(await idsOf({ state: 'needs_check', checked: 'false' })).toEqual(['p-stuck-sending', 'p-before-sweep', 'p-gave-up'])
    // The query's own state and checked never narrow a count.
    expect(await totals({ state: 'failed', checked: 'true' })).toEqual(counted)
  })

  it('count only this business', async () => {
    expect((await totals({}, NOW, OTHER_BUSINESS)).total).toBe(1)
    expect((await totals()).total).toBe((await idsOf()).length)
  })

  it('a run says which listing it went to; a product names every attribute the channel flagged', async () => {
    const runs = new Map((await list({ limit: 100 })).runs.map(run => [run.id, run]))
    expect(runs.get('p-partial')!.aliasKey).toBe('')
    const detail = await scoped(() => publicationRunDetail('p-partial', { now: NOW }))
    expect(detail.run.aliasKey).toBe('')
    expect(detail.products.find(p => p.sku === 'COAT-S')).toMatchObject({ columnHint: ['color'], listingId: listing.s })
    expect(detail.products.find(p => p.sku === 'COAT')).toMatchObject({ columnHint: [], listingId: listing.root })
  })

  it('a product the journal does not name still finds its listing on the run\'s exact destination', async () => {
    await scoped(async () => {
      await publication('p-no-journal', { status: 'PARTIAL', minute: 5, completedAt: at(6),
        summary: { products: 2, accepted: 1, verified: 0, failed: 1, submitted: 0, message: 'Amazon refused 1 of 2.' },
        review: { action: 'update', rows: [{ productId: ids.s, sku: 'COAT-S', title: 'Coat S', existing: true }, { productId: ids.m, sku: 'COAT-M', title: 'Coat M', existing: true }] },
        results: [{ sku: 'COAT-S', status: 'FAILED', message: 'Refused.', issues: [{ code: '1', severity: 'error', message: 'Bad size.', attributeNames: ['size', 'size_map', 'size'] }] },
          { sku: 'COAT-M', status: 'ACCEPTED', message: 'Accepted' }] })
      try {
        const detail = await publicationRunDetail('p-no-journal', { now: NOW })
        expect(detail.products.find(p => p.sku === 'COAT-S')).toMatchObject({ listingId: listing.s, externalId: 'ASIN-S', columnHint: ['size', 'size_map'] })
        expect(detail.products.find(p => p.sku === 'COAT-M')).toMatchObject({ listingId: listing.m, columnHint: [] })
        // Another listing of that account is not this run's destination.
        await prisma.bulkOperation.update({ where: { id: 'p-no-journal' }, data: { aliasKey: 'some-other-listing' } as never })
        const elsewhere = await publicationRunDetail('p-no-journal', { now: NOW })
        expect(elsewhere.products.map(p => p.listingId)).toEqual([null, null])
      } finally {
        await prisma.bulkOperation.delete({ where: { id: 'p-no-journal' } })
      }
    })
  })

  it('the count routes answer with the same permission as the list, and refuse a wrong query', async () => {
    const all = await app.inject({ method: 'GET', url: '/api/publications/counts?state=failed&limit=1' })
    expect(all.statusCode).toBe(200)
    expect(all.headers['cache-control']).toBe('no-store')
    // The route uses the real clock, so only what no time window moves is pinned; the rest must add up.
    const body = all.json()
    expect(body).toMatchObject({ total: 10, checked: 1, byState: { succeeded: 2, partial: 1, failed: 1 } })
    expect(body.byState.in_progress + body.byState.needs_check).toBe(6)
    expect(body.needsAttention).toBe(body.byState.failed + body.byState.partial + body.byState.needs_check - body.checked)
    expect(body.inProgress).toBe(body.byState.in_progress)
    expect(Date.parse(body.recentSince)).toBeGreaterThan(Date.now() - 7 * 24 * 60 * 60_000 - 60_000)
    const family = await app.inject({ method: 'GET', url: `/api/products/${ids.other}/publications/counts` })
    expect(family.json()).toMatchObject({ total: 1, byState: { succeeded: 1 } })
    expect((await app.inject({ method: 'GET', url: '/api/publications/counts?checked=maybe' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/products/nobody/publications/counts' })).statusCode).toBe(404)
    expect(permissionForRoute('GET', '/api/publications/counts')).toBe('products.view')
    expect(permissionForRoute('GET', '/api/products/:id/publications/counts')).toBe('products.view')
  })
})

describe('counts', () => {
  it('are disjoint and add up to the product count', () => {
    expect(countsOf('PARTIAL', { accepted: 2, failed: 1 }, 4)).toEqual({ accepted: 2, verified: 0, failed: 1, waiting: 0, notSent: 0, skipped: 0, unknown: 1 })
    expect(countsOf('PUBLISHING', null, 3)).toMatchObject({ waiting: 3, unknown: 0 })
    expect(countsOf('UNVERIFIED', {}, 3)).toMatchObject({ unknown: 3 })
    expect(countsOf('FAILED', { failed: 0 }, 2)).toMatchObject({ notSent: 2 })
  })
})
