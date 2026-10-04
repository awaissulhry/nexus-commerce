import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'

/**
 * Build shape v2 (P7) — selling changes in the publish history, on the real schema and tenant policies, through the core
 * and the real routes.
 *
 * One family (a parent and two sizes) on Amazon IT and eBay IT. Selling changes in every state, written as the
 * listing-action engine leaves them; three publication batches: one Publish with content AND selling parts (finished),
 * one still sending, and one with content only; one more whose content part a person marked checked. The cases pin:
 * a preview is not a run; each state (an all-skipped run succeeded, a gated one failed, a stale RUNNING needs a check);
 * one Publish with selling parts is ONE run (its content part leaves the product sheet source) and a content-only batch
 * is listed as before; the "What" filter; every other filter; paging over equal timestamps; exact counts; the detail of
 * a selling change, of a Publish (its parts in send order, its products tagged with their part) and of a part by its own
 * id; another business never shows.
 */
const state = vi.hoisted(() => ({ db: null as any, raw: [] as Array<{ sql: string; result: unknown }> }))
vi.mock('@nexus/database', async () => {
  const { concurrentDatabase, concurrentDatabaseUrl } = await import('../../../test-support/concurrent-database.js')
  const { formulaDatabase } = await import('../../../test-support/formula-database.js')
  state.db = concurrentDatabaseUrl() ? await concurrentDatabase() : await formulaDatabase()
  const client = state.db.client
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
import { countPublicationHistory, listPublicationHistory, parseHistoryQuery, publicationRunDetail } from '../publication-history.service.js'
import { sellingCounts } from './listing-action.js'

const scoped = <T>(work: () => Promise<T>, workspaceId = LEGACY_WORKSPACE_ID) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
/** Sits in every stored preview and change plan: a LIST read must never load it. */
const MARKER = 'STORED-PLAN-MUST-NOT-BE-READ'
const OTHER_BUSINESS = `other-${randomUUID()}`
const NOW = new Date(Date.UTC(2026, 9, 1, 12, 0))
const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 10, minute))
const ids: Record<string, string> = {}
const listing: Record<string, string> = {}
let app: FastifyInstance

interface SellingRow { key: 's' | 'm'; outcome: string; message: string }
async function selling(id: string, input: { status: string; action: string; minute: number | Date; channel?: string; batchId?: string; userId?: string | null
  summary?: Record<string, unknown> | null; rows?: SellingRow[]; sendCount?: number }) {
  const time = input.minute instanceof Date ? input.minute : at(input.minute)
  const channel = input.channel ?? 'AMAZON'
  const sku = (key: 's' | 'm') => (key === 's' ? 'COAT-S' : 'COAT-M')
  const lid = (key: 's' | 'm') => listing[`${key}${channel === 'EBAY' ? 'E' : ''}`]
  const pid = (key: 's' | 'm') => ids[key]
  const sent = input.status !== 'PREVIEW' && input.status !== 'RUNNING'
  await prisma.bulkOperation.create({ data: {
    id, userId: input.userId ?? ids.user, productCount: 3, changeCount: input.sendCount ?? input.rows?.length ?? 2, status: input.status, kind: 'listing-action',
    productId: ids.root, channel, marketplace: 'IT', channelConnectionId: channel === 'EBAY' ? ids.e : ids.a, aliasKey: '', batchId: input.batchId ?? null,
    createdAt: time, submittedAt: sent ? time : null, completedAt: sent ? time : null,
    summary: input.summary === null ? undefined : (input.summary ?? (input.rows ? {
      message: `${input.rows.filter(r => r.outcome === 'DONE').length} of ${input.rows.length} done.`,
      done: input.rows.filter(r => r.outcome === 'DONE').length, failed: input.rows.filter(r => r.outcome === 'FAILED').length,
      unknown: input.rows.filter(r => r.outcome === 'UNKNOWN').length, skipped: input.rows.filter(r => r.outcome === 'SKIPPED').length,
      notSent: input.rows.filter(r => r.outcome === 'NOT_SENT').length } : undefined)),
    changes: { kind: 'listing-action', action: input.action, requested: null,
      preview: { note: MARKER, rows: (['s', 'm'] as const).map(key => ({ productId: pid(key), listingId: lid(key), sku: sku(key), plan: 'send', sentence: 'Stops selling here.' })) },
      ...(input.rows ? { result: { previewId: id, action: input.action, status: input.status, message: 'stored',
        rows: input.rows.map(r => ({ productId: pid(r.key), listingId: lid(r.key), sku: sku(r.key), outcome: r.outcome, message: r.message })) } } : {}) },
  } as never })
}

async function publication(id: string, input: { status: string; minute: number; batchId?: string; summary?: Record<string, unknown>; completedAt?: Date | null
  review?: Record<string, unknown>; results?: Array<Record<string, unknown>> }) {
  await prisma.bulkOperation.create({ data: {
    id, userId: ids.user, productCount: 2, changeCount: 3, status: input.status, kind: 'studio-publication', batchId: input.batchId ?? null,
    changes: { kind: 'studio-publication', changePlan: { note: MARKER }, review: { action: 'update', rows: [{ productId: ids.s, sku: 'COAT-S', title: 'S', existing: true },
      { productId: ids.m, sku: 'COAT-M', title: 'M', existing: true }], ...input.review },
      result: { id, status: input.status, message: 'stored', results: input.results ?? [{ sku: 'COAT-S', status: 'VERIFIED' }, { sku: 'COAT-M', status: 'VERIFIED' }] } },
    productId: ids.root, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: ids.a, aliasKey: '',
    submittedAt: at(input.minute), createdAt: at(input.minute), completedAt: input.completedAt === undefined ? at(input.minute + 1) : input.completedAt,
    summary: input.summary ?? { products: 2, verified: 2, accepted: 0, failed: 0, submitted: 0, message: `${input.status} message` },
  } as never })
}

const header = (id: string, status: string, minute: number) => prisma.bulkOperation.create({ data: {
  id, userId: ids.user, productCount: 2, changeCount: 0, status, kind: 'publication-batch', productId: ids.root, createdAt: at(minute),
  changes: { kind: 'publication-batch', children: [] } } as never })

const list = async (raw: Record<string, unknown> = {}, now = NOW) => scoped(async () => listPublicationHistory(await parseHistoryQuery(raw), { now }))
const totals = async (raw: Record<string, unknown> = {}, now = NOW, workspaceId = LEGACY_WORKSPACE_ID) =>
  scoped(async () => countPublicationHistory(await parseHistoryQuery(raw), { now }), workspaceId)
const idsOf = async (raw: Record<string, unknown> = {}) => (await list({ limit: 100, ...raw })).runs.map(run => run.id)
const runsOf = async (raw: Record<string, unknown> = {}) => new Map((await list({ limit: 100, ...raw })).runs.map(run => [run.id, run]))
const detailOf = (runId: string) => scoped(() => publicationRunDetail(runId, { now: NOW }))
async function everyRun(raw: Record<string, unknown>, now = NOW, size = 3) {
  const runs: Array<{ id: string }> = []
  let cursor: string | undefined
  for (let page = 0; page < 60; page++) {
    const result = await list({ ...raw, limit: size, ...(cursor ? { cursor } : {}) }, now)
    runs.push(...result.runs)
    if (!result.nextCursor) return runs
    cursor = result.nextCursor
  }
  throw new Error('the list did not end')
}
async function expectCountsMatchList(filters: Record<string, unknown>) {
  const counted = await totals(filters)
  const length = async (extra: Record<string, unknown>) => (await everyRun({ ...filters, ...extra })).length
  expect(counted.total).toBe(await length({}))
  for (const s of ['in_progress', 'succeeded', 'partial', 'failed', 'needs_check']) expect(counted.byState[s as 'failed']).toBe(await length({ state: s }))
  expect(counted.needsAttention).toBe(await length({ state: 'failed,partial,needs_check', checked: 'false' }))
  expect(counted.checked).toBe(await length({ checked: 'true' }))
  expect(counted.doneLast7Days).toBe(await length({ state: 'succeeded,partial,failed', from: [filters.from, counted.recentSince].filter(Boolean).sort().at(-1) }))
  return counted
}

beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon IT', region: 'EU', currency: 'EUR', language: 'it', languages: ['it'] } as never })
    ids.user = (await prisma.userProfile.create({ data: { displayName: 'Seller Person', email: `s-${randomUUID()}@example.test` } as never })).id
    ids.checker = (await prisma.userProfile.create({ data: { displayName: 'Checker Person', email: `c-${randomUUID()}@example.test` } as never })).id
    ids.a = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'Amazon A', isActive: true, externalAccountId: 'SELLER-A', authStatus: 'connected', managedBy: 'oauth', region: 'EU' } as never })).id
    ids.e = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'eBay E', isActive: true, externalAccountId: 'EBAY-E', authStatus: 'connected', managedBy: 'oauth', region: 'EU' } as never })).id
    ids.root = (await prisma.product.create({ data: { sku: 'COAT', name: 'Winter coat', basePrice: 10, isParent: true } as never })).id
    ids.s = (await prisma.product.create({ data: { sku: 'COAT-S', name: 'Coat S', basePrice: 10, parentId: ids.root, variantAttributes: { Taglia: 'S' } } as never })).id
    ids.m = (await prisma.product.create({ data: { sku: 'COAT-M', name: 'Coat M', basePrice: 10, parentId: ids.root, variantAttributes: { Taglia: 'M' } } as never })).id
    for (const [key, productId] of [['s', ids.s], ['m', ids.m]] as const) {
      listing[key] = (await prisma.channelListing.create({ data: { productId, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU', channelConnectionId: ids.a,
        externalListingId: `ASIN-${key.toUpperCase()}` } as never })).id
      listing[`${key}E`] = (await prisma.channelListing.create({ data: { productId, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'EU', channelConnectionId: ids.e } as never })).id
    }

    // Selling changes on their own (the Matrix, Claude, a direct run).
    await selling('la-done', { status: 'DONE', action: 'pause', minute: 10, rows: [{ key: 's', outcome: 'DONE', message: 'Paused.' }, { key: 'm', outcome: 'DONE', message: 'Paused.' }] })
    await selling('la-partial', { status: 'PARTIAL', action: 'resume', minute: 12, rows: [{ key: 's', outcome: 'DONE', message: 'Resumed.' }, { key: 'm', outcome: 'FAILED', message: 'Amazon refused the offer.' }] })
    await selling('la-failed', { status: 'FAILED', action: 'relist', minute: 14, channel: 'EBAY', rows: [{ key: 's', outcome: 'FAILED', message: 'eBay refused the relist.' }] })
    await selling('la-skipped', { status: 'NOT_SENT', action: 'pause', minute: 16, rows: [{ key: 's', outcome: 'SKIPPED', message: 'Changed since the preview: Already inactive.' }, { key: 'm', outcome: 'SKIPPED', message: 'Changed since the preview: Already inactive.' }] })
    await selling('la-gated', { status: 'NOT_SENT', action: 'pause', minute: 17, rows: [{ key: 's', outcome: 'NOT_SENT', message: 'Amazon changes are switched off.' }] })
    await selling('la-running', { status: 'RUNNING', action: 'end', minute: new Date(NOW.getTime() - 5 * 60_000), channel: 'EBAY', summary: null })
    await selling('la-stuck', { status: 'RUNNING', action: 'end', minute: 20, channel: 'EBAY', summary: null })
    await selling('la-unknown', { status: 'UNKNOWN', action: 'delete', minute: 22, rows: [{ key: 's', outcome: 'UNKNOWN', message: 'The change stopped unexpectedly.' }] })
    await selling('la-preview', { status: 'PREVIEW', action: 'pause', minute: 23, summary: null })
    // A product sheet run at the same instant as a selling change: paging must keep their order.
    await publication('p-same', { status: 'VERIFIED', minute: 10 })

    // One Publish with content and selling parts, finished; its never-sent Delete part waits no more.
    await header('batch-1', 'SENT', 30)
    await publication('p-b1', { status: 'VERIFIED', minute: 31, batchId: 'batch-1' })
    await selling('la-b1-pause', { status: 'DONE', action: 'pause', minute: 32, batchId: 'batch-1', rows: [{ key: 's', outcome: 'DONE', message: 'Paused.' }] })
    await selling('la-b1-delete', { status: 'PREVIEW', action: 'delete', minute: 30, batchId: 'batch-1', summary: null })
    // One still sending: the content went, the Pause waits its turn.
    await header('batch-2', 'RUNNING', 40)
    await publication('p-b2', { status: 'VERIFIED', minute: 40, batchId: 'batch-2' })
    await selling('la-b2-pause', { status: 'PREVIEW', action: 'pause', minute: 40, batchId: 'batch-2', summary: null })
    // Content only (many markets): listed by the product sheet source, as before.
    await header('batch-3', 'SENT', 45)
    await publication('p-b3', { status: 'VERIFIED', minute: 45, batchId: 'batch-3' })
    // Content with no answer that a person marked checked, and an accepted Resume.
    await header('batch-4', 'SENT', 50)
    await publication('p-b4', { status: 'UNVERIFIED', minute: 50, batchId: 'batch-4', completedAt: at(55),
      summary: { products: 2, message: 'No answer.', checkedAt: at(55).toISOString(), checkedBy: ids.checker } })
    await selling('la-b4-resume', { status: 'DONE', action: 'resume', minute: 51, batchId: 'batch-4', rows: [{ key: 's', outcome: 'DONE', message: 'Resumed.' }] })
  })
  const owner = await prisma.userProfile.create({ data: { email: `o-${randomUUID()}@example.test`, status: 'active' } as never })
  await prisma.workspace.create({ data: { id: OTHER_BUSINESS, name: 'Other business', createdByUserId: owner.id, creationKey: randomUUID() } as never })
  await scoped(async () => {
    await prisma.bulkOperation.create({ data: { id: 'la-other-business', userId: null, productCount: 1, changeCount: 1, status: 'DONE', kind: 'listing-action',
      changes: { kind: 'listing-action', action: 'pause' }, productId: 'x', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'x', aliasKey: '',
      submittedAt: at(59), createdAt: at(59), summary: { done: 1 } } as never })
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

const ALL = ['listing-action:la-running', 'listing-action:batch:batch-4', 'p-b3', 'listing-action:batch:batch-2', 'listing-action:batch:batch-1',
  'listing-action:la-unknown', 'listing-action:la-stuck', 'listing-action:la-gated', 'listing-action:la-skipped', 'listing-action:la-failed',
  'listing-action:la-partial', 'p-same', 'listing-action:la-done']

describe('selling changes in the publish history', () => {
  it('lists sent selling changes and ONE run per Publish with selling parts, newest first; a preview is not a run', async () => {
    expect(await idsOf()).toEqual(ALL)
    // The content parts of a Publish with selling parts are not runs of their own; a content-only batch still is.
    expect(await idsOf({ source: 'studio' })).toEqual(['p-b3', 'p-same'])
  })

  it('decides each state, kind and count', async () => {
    const runs = await runsOf()
    expect(Object.fromEntries([...runs].map(([id, run]) => [id, run.state]))).toMatchObject({
      'listing-action:la-done': 'succeeded', 'listing-action:la-partial': 'partial', 'listing-action:la-failed': 'failed',
      'listing-action:la-skipped': 'succeeded', 'listing-action:la-gated': 'failed', 'listing-action:la-running': 'in_progress',
      'listing-action:la-stuck': 'needs_check', 'listing-action:la-unknown': 'needs_check',
      'listing-action:batch:batch-1': 'succeeded', 'listing-action:batch:batch-2': 'in_progress', 'listing-action:batch:batch-4': 'needs_check',
    })
    expect(runs.get('listing-action:la-done')).toMatchObject({ source: 'listing-action', kind: 'pause', batchId: null, status: 'DONE', familySku: 'COAT',
      familyTitle: 'Winter coat', channel: 'AMAZON', marketplace: 'IT', accountLabel: 'Amazon A', aliasKey: '', aliasLabel: null, userName: 'Seller Person',
      productCount: 2, counts: { accepted: 2, verified: 0, failed: 0, waiting: 0, notSent: 0, skipped: 0, unknown: 0 }, message: '2 of 2 done.',
      startedAt: at(10).toISOString(), finishedAt: at(10).toISOString(), fieldCount: null, needsCheck: false })
    expect(runs.get('listing-action:la-done')).not.toHaveProperty('kinds')
    expect(runs.get('listing-action:la-partial')!.counts).toMatchObject({ accepted: 1, failed: 1 })
    expect(runs.get('listing-action:la-skipped')!.counts).toMatchObject({ skipped: 2, accepted: 0 })
    expect(runs.get('listing-action:la-gated')!.counts).toMatchObject({ notSent: 1 })
    expect(runs.get('listing-action:la-running')).toMatchObject({ kind: 'end', channel: 'EBAY', counts: { waiting: 2 }, finishedAt: null })
    expect(runs.get('listing-action:la-stuck')).toMatchObject({ needsCheck: true, counts: { unknown: 2 } })
    // One Publish: its parts' kinds in send order, its parts' counts, its own time (the first part sent).
    expect(runs.get('listing-action:batch:batch-1')).toMatchObject({ kind: 'update', kinds: ['update', 'pause'], batchId: 'batch-1', status: 'SENT',
      familySku: 'COAT', channel: 'AMAZON', marketplace: 'IT', productCount: 3, counts: { verified: 2, accepted: 1 }, fieldCount: 3,
      startedAt: at(31).toISOString(), finishedAt: at(32).toISOString(), userName: 'Seller Person' })
    expect(runs.get('listing-action:batch:batch-2')).toMatchObject({ kinds: ['update'], status: 'RUNNING', finishedAt: null })
    // A part a person marked checked: the Publish needs no more checking, and says who checked it.
    expect(runs.get('listing-action:batch:batch-4')).toMatchObject({ kinds: ['resume', 'update'], kind: 'resume', needsCheck: false,
      checkedAt: at(55).toISOString(), checkedBy: 'Checker Person', finishedAt: null })
  })

  it('"What": updates, selling changes, deletes, photos — a Publish shows when one of its sent parts matches', async () => {
    expect(await idsOf({ what: 'selling' })).toEqual(['listing-action:la-running', 'listing-action:batch:batch-4', 'listing-action:batch:batch-1',
      'listing-action:la-stuck', 'listing-action:la-gated', 'listing-action:la-skipped', 'listing-action:la-failed', 'listing-action:la-partial', 'listing-action:la-done'])
    // The never-sent Delete of batch-1 is no part of what was sent.
    expect(await idsOf({ what: 'deletes' })).toEqual(['listing-action:la-unknown'])
    expect(await idsOf({ what: 'updates' })).toEqual(['listing-action:batch:batch-4', 'p-b3', 'listing-action:batch:batch-2', 'listing-action:batch:batch-1', 'p-same'])
    expect(await idsOf({ what: 'photos' })).toEqual([])
    expect(await idsOf({ what: 'updates,selling,deletes,photos' })).toEqual(ALL)
  })

  it('filters by channel, account, family, user, time and text', async () => {
    expect(await idsOf({ channel: 'ebay' })).toEqual(['listing-action:la-running', 'listing-action:la-stuck', 'listing-action:la-failed'])
    expect(await idsOf({ accountId: ids.e, source: 'listing-action' })).toEqual(['listing-action:la-running', 'listing-action:la-stuck', 'listing-action:la-failed'])
    expect(await idsOf({ productId: ids.m })).toEqual(ALL)
    expect(await idsOf({ userId: ids.checker })).toEqual([])
    expect(await idsOf({ from: at(30).toISOString(), to: at(45).toISOString(), source: 'listing-action' })).toEqual(['listing-action:batch:batch-2', 'listing-action:batch:batch-1'])
    expect(await idsOf({ q: 'batch-1' })).toEqual(['listing-action:batch:batch-1'])
    expect(await idsOf({ q: 'la-gated' })).toEqual(['listing-action:la-gated'])
    expect(await idsOf({ q: 'coat-m', source: 'listing-action', state: 'partial' })).toEqual(['listing-action:la-partial'])
    expect(await idsOf({ state: 'needs_check', checked: 'true' })).toEqual(['listing-action:batch:batch-4'])
  })

  it('pages over equal timestamps without repeating or skipping a run', async () => {
    for (const size of [1, 2, 3, 5]) expect((await everyRun({}, NOW, size)).map(run => run.id)).toEqual(ALL)
    expect((await everyRun({ what: 'selling' }, NOW, 2)).map(run => run.id)).toEqual(await idsOf({ what: 'selling' }))
  })

  it('a list never reads a stored preview or change plan', async () => {
    state.raw.length = 0
    await list({ limit: 100 })
    await list({ limit: 100, what: 'updates' })
    await list({ limit: 100, q: 'COAT' })
    expect(state.raw.length).toBeGreaterThan(3)
    expect(JSON.stringify(state.raw.map(entry => entry.result))).not.toContain(MARKER)
    for (const entry of state.raw) expect(entry.sql).not.toMatch(/b\.changes\s*(,|AS\b|FROM\b|\))/i)
  })

  it('counts equal the length of the list each tile opens, for every filter', async () => {
    const combos: Array<Record<string, unknown>> = [{}, { what: 'selling' }, { what: 'updates' }, { what: 'deletes' }, { what: 'selling,deletes' }, { channel: 'EBAY' },
      { source: 'listing-action' }, { source: 'studio' }, { productId: ids.s }, { q: 'COAT' }, { from: at(15).toISOString(), to: at(45).toISOString() }]
    for (const filters of combos) await expectCountsMatchList(filters)
    expect(await totals({ source: 'listing-action' })).toMatchObject({ total: 11, inProgress: 2, checked: 1,
      byState: { in_progress: 2, succeeded: 3, partial: 1, failed: 2, needs_check: 3 } })
    expect((await totals({}, NOW, OTHER_BUSINESS)).total).toBe(1)
  })

  it('a selling change in full: its rows, results first by trouble, and plain steps', async () => {
    const detail = await detailOf('listing-action:la-partial')
    expect(detail.run).toMatchObject({ id: 'listing-action:la-partial', kind: 'resume', state: 'partial' })
    expect(detail.products.map(p => [p.sku, p.result, p.message])).toEqual([['COAT-M', 'FAILED', 'Amazon refused the offer.'], ['COAT-S', 'ACCEPTED', 'Resumed.']])
    expect(detail.products[0]).toMatchObject({ variationLabel: 'M', listingId: listing.m, externalId: 'ASIN-M', sentFields: [] })
    expect(detail.products[0]).not.toHaveProperty('runId')
    expect(detail.steps.map(s => [s.key, s.label])).toEqual([['reviewed', 'Reviewed'], ['sent', 'Sent to Amazon · IT'], ['processed', 'Amazon refused 1 of 2']])
    expect(detail.hasRequest).toBe(false)
    const skipped = await detailOf('listing-action:la-skipped')
    expect(skipped.steps.map(s => s.key)).toEqual(['reviewed', 'not_sent'])
    // Still running: the rows its preview sends wait.
    const running = await detailOf('listing-action:la-running')
    expect(running.products.map(p => p.result)).toEqual(['WAITING', 'WAITING'])
    expect(running.steps.map(s => s.key)).toEqual(['reviewed', 'sent', 'waiting'])
    expect((await detailOf('listing-action:la-stuck')).steps.map(s => s.key)).toContain('needs_check')
  })

  it('one Publish in full: its parts in send order, and every product tagged with its part', async () => {
    const detail = await detailOf('listing-action:batch:batch-1')
    expect(detail.run).toMatchObject({ id: 'listing-action:batch:batch-1', kinds: ['update', 'pause'], state: 'succeeded' })
    expect(detail.children!.map(child => [child.id, child.kind, child.state])).toEqual([['p-b1', 'update', 'succeeded'], ['listing-action:la-b1-pause', 'pause', 'succeeded']])
    expect(detail.children!.every(child => child.batchId === 'batch-1')).toBe(true)
    expect(detail.products.map(p => [p.sku, p.result, p.kind, p.runId])).toEqual([
      ['COAT-S', 'ACCEPTED', 'pause', 'listing-action:la-b1-pause'], ['COAT-M', 'VERIFIED', 'update', 'p-b1'], ['COAT-S', 'VERIFIED', 'update', 'p-b1']])
    expect(detail.steps.find(s => s.key === 'reviewed')).toMatchObject({ at: at(30).toISOString(), detail: '2 parts' })
    // Each part opens by its own id.
    expect((await detailOf('listing-action:la-b1-pause')).run).toMatchObject({ kind: 'pause', batchId: 'batch-1', state: 'succeeded' })
    expect((await detailOf('p-b1')).run).toMatchObject({ id: 'p-b1', batchId: 'batch-1' })
    await expect(detailOf('listing-action:la-preview')).rejects.toMatchObject({ statusCode: 404 })
    await expect(detailOf('listing-action:batch:batch-3')).rejects.toMatchObject({ statusCode: 404 })
    await expect(detailOf('listing-action:la-other-business')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('the routes take "what", and refuse a wrong one with a 400', async () => {
    const page = await app.inject({ method: 'GET', url: '/api/publications?what=deletes&limit=10' })
    expect(page.statusCode).toBe(200)
    expect(page.json().runs.map((run: { id: string }) => run.id)).toEqual(['listing-action:la-unknown'])
    const counts = await app.inject({ method: 'GET', url: `/api/products/${ids.s}/publications/counts?what=selling` })
    expect(counts.json().total).toBe((await idsOf({ what: 'selling' })).length)
    expect((await app.inject({ method: 'GET', url: '/api/publications/listing-action:batch:batch-1' })).json().children).toHaveLength(2)
    expect((await app.inject({ method: 'GET', url: '/api/publications?what=prices' })).statusCode).toBe(400)
  })
})

describe('selling counts', () => {
  it('are disjoint, and a run with no row result yet waits, sent none, or is unknown', () => {
    expect(sellingCounts('PARTIAL', { done: 1, failed: 1, skipped: 1 }, 3)).toEqual({ accepted: 1, verified: 0, failed: 1, waiting: 0, notSent: 0, skipped: 1, unknown: 0 })
    expect(sellingCounts('RUNNING', null, 4)).toMatchObject({ waiting: 4 })
    expect(sellingCounts('NOT_SENT', { notSent: true, message: 'Refused.' }, 2)).toMatchObject({ notSent: 2 })
    expect(sellingCounts('UNKNOWN', null, 2)).toMatchObject({ unknown: 2 })
  })
})
