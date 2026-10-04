import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Sheet publish parity, step 6 (item 6) — many families from the products list, on the real schema and tenant policies.
 *
 * The request: a selected variation means its family, a product of another business is not found, at most 200
 * products. The review stage: every family × destination is reviewed with the default ticks (SEND only; DIFFERS only on
 * request); a family the preview cannot review, and a review with nothing to send, become NOT_SENT with the reason; a
 * resumed run makes only the reviews still missing; then the batch waits (REVIEWED). The submit: an expired review and
 * one with nothing ticked are NOT_SENT; the others are stamped with their CURRENT ticks and the batch is queued. The
 * send: Amazon families of one account and market go to one shared send; every other destination through the normal
 * submit. The view: one row per family × destination with the family's SKU, ticks and problems, and a time estimate.
 */
const fixture = vi.hoisted(() => ({ database: null as any, published: [] as any[], queued: [] as unknown[] }))

vi.mock('@nexus/database', async () => {
  const { concurrentDatabase, concurrentDatabaseUrl } = await import('../../test-support/concurrent-database.js')
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  fixture.database = concurrentDatabaseUrl() ? await concurrentDatabase() : await formulaDatabase()
  return { default: fixture.database.client }
})
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: (event: unknown) => { fixture.published.push(event) } }))
vi.mock('../../lib/queue.js', () => ({ publicationBatchQueue: { add: async (_name: string, data: unknown) => { fixture.queued.push(data) } } }))

import type { StudioPublishChange, StudioPublishReview, StudioPublishScope } from '@nexus/shared/studio-publication'
import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { BATCH_HEARTBEAT_MS, BATCH_KIND, defaultBatchSelection, runPublicationBatch } from './publication-batch.processor.js'
import { batchEstimate, cancelPublicationBatch, createPublicationBatch, readPublicationBatch, submitReviewedBatch } from './publication-batch.service.js'
import { WorkspaceScopeError } from './workspace-destination.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const USER = 'families-user'
const ids: Record<string, string> = {}
const AMAZON_IT: StudioPublishScope = { channel: 'AMAZON', marketplace: 'IT', accountId: 'amazon-a' }
const AMAZON_DE: StudioPublishScope = { channel: 'AMAZON', marketplace: 'DE', accountId: 'amazon-a' }
const EBAY_IT: StudioPublishScope = { channel: 'EBAY', marketplace: 'IT', accountId: 'ebay-a' }

const change = (id: string, status: StudioPublishChange['status'], selectedByDefault: boolean): StudioPublishChange =>
  ({ id, status, selectable: status !== 'SAME', selectedByDefault } as StudioPublishChange)

/**
 * A preview that saves its review the way the real one does (PREVIEW, or BLOCKED with the reason, tied to the batch).
 * `plan` decides per family: throw, blocked, or which changes the review offers.
 */
function fakePreview(plan: (familyId: string, scope: StudioPublishScope) => 'throw' | 'blocked' | StudioPublishChange[]) {
  const calls: Array<{ familyId: string; scope: StudioPublishScope }> = []
  const preview = async (familyId: string, scope: StudioPublishScope, userId: string | null, options: { batchId: string; expiresInMs: number }) => {
    calls.push({ familyId, scope })
    const what = plan(familyId, scope)
    if (what === 'throw') throw new WorkspaceScopeError('This family has no listing on this destination and cannot get a draft here.')
    const id = `review-${calls.length}-${familyId}-${scope.marketplace}-${Math.random().toString(36).slice(2, 8)}`
    const review = { id, productId: familyId, scope, rows: [{ productId: familyId, sku: 'X', title: 'X', existing: true }],
      issues: what === 'blocked' ? [{ severity: 'error', message: 'Choose a category first.' }] : [{ severity: 'warning', message: 'A recommended field is empty.' }],
      changes: what === 'blocked' ? [] : what, expiresAt: new Date(Date.now() + options.expiresInMs).toISOString() } as unknown as StudioPublishReview
    await prisma.bulkOperation.create({ data: { id, userId, status: what === 'blocked' ? 'BLOCKED' : 'PREVIEW', productCount: 3, changeCount: 0,
      kind: 'studio-publication', productId: familyId, channel: scope.channel, marketplace: scope.marketplace, channelConnectionId: scope.accountId, aliasKey: '',
      batchId: options.batchId, expiresAt: new Date(Date.now() + options.expiresInMs),
      changes: { kind: 'studio-publication', productId: familyId, scope, publicationKey: id, changeVersion: what === 'blocked' ? null : 1, changePlan: what === 'blocked' ? null : { kind: 'amazon-changes' }, review } as never } as never })
    return review
  }
  return { preview, calls }
}

/** A selection like the real one: stores the ticks and a token on the review. */
function fakeSelect() {
  const calls: Array<{ id: string; ids: string[] }> = []
  const select = async (_familyId: string, id: string, body: unknown) => {
    const selectedIds = (body as { selectedIds: string[] }).selectedIds
    calls.push({ id, ids: selectedIds })
    const row = await prisma.bulkOperation.findFirst({ where: { id } })
    const token = `token-${id}`
    await prisma.bulkOperation.update({ where: { id }, data: { changeCount: selectedIds.length,
      changes: { ...(row!.changes as object), selection: { reviewId: id, selectedIds, fieldCount: selectedIds.length, products: [], token } } as never } })
    return { reviewId: id, selectedIds, fieldCount: selectedIds.length, products: [], token } as never
  }
  return { select, calls }
}

async function reviewingBatch(productIds: string[], destinations: StudioPublishScope[], options?: { replaceDiffers?: boolean }) {
  const { batchId } = await createPublicationBatch({ productIds, destinations, ...(options ? { options } : {}) }, USER)
  return batchId
}

describe('many families in one batch', () => {
  beforeAll(async () => {
    await scoped(async () => {
      ids.coat = (await prisma.product.create({ data: { sku: 'COAT', name: 'Winter coat', basePrice: 10, isParent: true } as never })).id
      ids.coatS = (await prisma.product.create({ data: { sku: 'COAT-S', name: 'Coat S', basePrice: 10, parentId: ids.coat } as never })).id
      ids.coatM = (await prisma.product.create({ data: { sku: 'COAT-M', name: 'Coat M', basePrice: 10, parentId: ids.coat } as never })).id
      ids.glove = (await prisma.product.create({ data: { sku: 'GLOVE', name: 'Glove', basePrice: 10 } as never })).id
      ids.boot = (await prisma.product.create({ data: { sku: 'BOOT', name: 'Boot', basePrice: 10 } as never })).id
    })
    process.env.ENABLE_QUEUE_WORKERS = '1'
  }, 120_000)
  afterAll(async () => { delete process.env.ENABLE_QUEUE_WORKERS; await fixture.database?.close?.() })
  beforeEach(() => { fixture.published.length = 0; fixture.queued.length = 0 })

  it('a selected variation means its family; families are counted once; the batch is queued to review', () => scoped(async () => {
    const batchId = await reviewingBatch([ids.coatS, ids.coat, ids.coatM, ids.glove], [AMAZON_IT, EBAY_IT])
    const header = await prisma.bulkOperation.findUnique({ where: { id: batchId } })
    expect(header).toMatchObject({ kind: BATCH_KIND, status: 'QUEUED', productCount: 2 })
    expect((header!.changes as any).stage).toBe('review')
    expect((header!.changes as any).request.families).toEqual([ids.coat, ids.glove])
    expect(fixture.queued).toEqual([{ batchId }])
    const view = await readPublicationBatch(batchId, USER)
    expect(view).toMatchObject({ phase: 'REVIEWING', stage: 'review', request: { families: 2, destinations: 2, reviews: 4, reviewed: 0 } })
    expect(view.estimate?.minutes).toBeGreaterThanOrEqual(1)
  }))

  it('refuses unknown products, more than 200 products, and a destination twice', () => scoped(async () => {
    await expect(createPublicationBatch({ productIds: [ids.glove, 'not-a-product'], destinations: [AMAZON_IT] }, USER)).rejects.toMatchObject({ statusCode: 404 })
    await expect(createPublicationBatch({ productIds: Array.from({ length: 201 }, (_, i) => `p-${i}`), destinations: [AMAZON_IT] }, USER)).rejects.toMatchObject({ statusCode: 400 })
    await expect(createPublicationBatch({ productIds: [ids.glove], destinations: [AMAZON_IT, { ...AMAZON_IT }] }, USER)).rejects.toMatchObject({ statusCode: 400 })
    await expect(createPublicationBatch({ productIds: [ids.glove], destinations: [AMAZON_IT], reviews: [] }, USER)).rejects.toMatchObject({ statusCode: 400 })
  }))

  it('reviews every family × destination with the default ticks, then waits for the person', () => scoped(async () => {
    const batchId = await reviewingBatch([ids.coat, ids.glove, ids.boot], [AMAZON_IT, EBAY_IT])
    const { preview, calls } = fakePreview((family, scope) => {
      if (family === ids.boot && scope.channel === 'EBAY') return 'throw'
      if (family === ids.glove && scope.channel === 'EBAY') return 'blocked'
      if (family === ids.boot) return [change('b-same', 'SAME', false), change('b-differs', 'DIFFERS', false)] // nothing to send by default
      return [change(`${family}-send`, 'SEND', true), change(`${family}-differs`, 'DIFFERS', false), change(`${family}-same`, 'SAME', false)]
    })
    const { select, calls: selections } = fakeSelect()
    const summary = await runPublicationBatch(batchId, { preview, select })
    expect(summary).toMatchObject({ claimed: true, reviewed: 5 })
    expect(calls).toHaveLength(6)
    expect(selections.map(s => s.ids.join()).sort()).toEqual([`${ids.coat}-send`, `${ids.coat}-send`, `${ids.glove}-send`].sort())
    const header = await prisma.bulkOperation.findUnique({ where: { id: batchId } })
    expect(header).toMatchObject({ status: 'REVIEWED', nextCheckAt: null })
    const view = await readPublicationBatch(batchId, USER)
    expect(view.phase).toBe('REVIEWED')
    const row = (family: string, channel: string) => view.children.find(c => c.productId === family && c.channel === channel)!
    expect(row(ids.coat, 'AMAZON')).toMatchObject({ status: 'PREVIEW', familySku: 'COAT', familyTitle: 'Winter coat', selectedCount: 1, problems: { errors: 0, warnings: 1 } })
    expect(row(ids.glove, 'EBAY')).toMatchObject({ status: 'BLOCKED', problems: { errors: 1, warnings: 0, messages: ['Choose a category first.'] } })
    expect(row(ids.boot, 'EBAY')).toMatchObject({ status: 'NOT_SENT', message: expect.stringContaining('cannot get a draft') })
    expect(row(ids.boot, 'AMAZON')).toMatchObject({ status: 'NOT_SENT', nothingToSend: true })
    expect(view.estimate?.seconds).toBeGreaterThan(0)
  }))

  it('ticks fields the channel holds differently only when the person asked to replace them', () => scoped(async () => {
    expect(defaultBatchSelection({ changes: [change('a', 'SEND', true), change('b', 'DIFFERS', false), change('c', 'SAME', false)] }, false)).toEqual(['a'])
    expect(defaultBatchSelection({ changes: [change('a', 'SEND', true), change('b', 'DIFFERS', false), change('c', 'SAME', false)] }, true)).toEqual(['a', 'b'])
    expect(defaultBatchSelection({ changes: [change('["p","photos"]', 'SEND', true), change('["p","title"]', 'SEND', true)], photosOnly: true }, false)).toEqual([])
  }))

  it('a resumed review makes only the reviews still missing', () => scoped(async () => {
    const batchId = await reviewingBatch([ids.coat, ids.glove], [AMAZON_IT])
    const first = fakePreview(() => [change('x', 'SEND', true)])
    let made = 0
    // The first run stops after one review (the worker died): the header stays RUNNING with a stale heartbeat.
    await runPublicationBatch(batchId, { preview: async (...args) => { made += 1; const review = await first.preview(...args)
      if (made === 1) await prisma.bulkOperation.update({ where: { id: batchId }, data: { status: 'CANCELLING' } })
      return review }, select: fakeSelect().select })
    await prisma.bulkOperation.update({ where: { id: batchId }, data: { status: 'RUNNING', nextCheckAt: new Date(Date.now() - 1), completedAt: null } })
    const second = fakePreview(() => [change('x', 'SEND', true)])
    await runPublicationBatch(batchId, { preview: second.preview, select: fakeSelect().select })
    expect(second.calls.map(c => c.familyId)).toEqual([ids.glove])
    expect((await prisma.bulkOperation.findUnique({ where: { id: batchId } }))?.status).toBe('REVIEWED')
  }))

  it('submit: sends the current ticks, marks an expired review and one with nothing ticked NOT_SENT, and queues the send', () => scoped(async () => {
    const batchId = await reviewingBatch([ids.coat, ids.glove, ids.boot], [AMAZON_IT])
    const { select } = fakeSelect()
    await runPublicationBatch(batchId, { preview: fakePreview(() => [change('x', 'SEND', true)]).preview, select })
    const children = await prisma.bulkOperation.findMany({ where: { batchId, kind: 'studio-publication' } })
    const of = (family: string) => children.find(c => c.productId === family)!
    await prisma.bulkOperation.update({ where: { id: of(ids.glove).id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    const noTicks = of(ids.boot)
    await prisma.bulkOperation.update({ where: { id: noTicks.id }, data: { changes: { ...(noTicks.changes as any), selection: undefined } as never } })
    // The person changed the coat's ticks after the review: the submit sends the new token.
    await select(ids.coat, of(ids.coat).id, { selectedIds: ['x', 'y'] })
    await expect(submitReviewedBatch(batchId, { confirmOverwrite: 'nope' }, USER)).rejects.toMatchObject({ statusCode: 400 })
    const view = await submitReviewedBatch(batchId, {}, USER)
    expect(view.phase).toBe('QUEUED')
    const after = await prisma.bulkOperation.findMany({ where: { batchId, kind: 'studio-publication' } })
    const status = (family: string) => after.find(c => c.productId === family)!
    expect(status(ids.glove)).toMatchObject({ status: 'NOT_SENT', summary: expect.objectContaining({ message: expect.stringContaining('expired') }) })
    expect(status(ids.boot)).toMatchObject({ status: 'NOT_SENT', summary: expect.objectContaining({ message: expect.stringContaining('No fields are ticked') }) })
    expect((status(ids.coat).changes as any).batch).toEqual({ batchId, body: { selectionToken: `token-${of(ids.coat).id}` } })
    const header = await prisma.bulkOperation.findUnique({ where: { id: batchId } })
    expect((header!.changes as any)).toMatchObject({ stage: 'send', children: [of(ids.coat).id] })
    expect(fixture.queued).toEqual([{ batchId }, { batchId }])
    await expect(submitReviewedBatch(batchId, {}, USER)).rejects.toMatchObject({ statusCode: 409 })
  }))

  it('a reviewed batch can be cancelled: nothing it reviewed is sent', () => scoped(async () => {
    const batchId = await reviewingBatch([ids.coat], [AMAZON_IT, AMAZON_DE])
    await runPublicationBatch(batchId, { preview: fakePreview(() => [change('x', 'SEND', true)]).preview, select: fakeSelect().select })
    const view = await cancelPublicationBatch(batchId, USER)
    expect(view).toMatchObject({ phase: 'CANCELLED', counts: { cancelled: 2 } })
  }))

  it('sends Amazon families of one market together, and every other destination through the normal submit', () => scoped(async () => {
    const batchId = `send-${Date.now()}`
    const child = async (id: string, family: string, scope: StudioPublishScope) => prisma.bulkOperation.create({ data: { id, userId: USER, status: 'PREVIEW', productCount: 2, changeCount: 1,
      kind: 'studio-publication', productId: family, channel: scope.channel, marketplace: scope.marketplace, channelConnectionId: scope.accountId, aliasKey: '', batchId,
      expiresAt: new Date(Date.now() + 3_600_000), changes: { kind: 'studio-publication', productId: family, scope, publicationKey: id, batch: { batchId, body: { selectionToken: `t-${id}` } } } as never } as never })
    await child(`${batchId}-a`, ids.coat, AMAZON_IT)
    await child(`${batchId}-b`, ids.glove, AMAZON_IT)
    await child(`${batchId}-c`, ids.boot, AMAZON_DE)
    await child(`${batchId}-d`, ids.coat, EBAY_IT)
    await prisma.bulkOperation.create({ data: { id: batchId, userId: USER, status: 'QUEUED', kind: BATCH_KIND, productCount: 4, changeCount: 0, checkCount: 0,
      nextCheckAt: new Date(Date.now() + BATCH_HEARTBEAT_MS), changes: { kind: BATCH_KIND, stage: 'send', children: [`${batchId}-a`, `${batchId}-b`, `${batchId}-c`, `${batchId}-d`] } } as never })
    const claimed: string[] = [], merged: string[][] = [], submitted: string[] = []
    const summary = await runPublicationBatch(batchId, {
      claim: async (_p, id) => { claimed.push(id); await prisma.bulkOperation.update({ where: { id }, data: { status: 'PUBLISHING' } }); return { claim: { id } as never } },
      sendMerged: async claims => { merged.push(claims.map(c => c.id)); return [] },
      submit: async (_p, id) => { submitted.push(id); await prisma.bulkOperation.update({ where: { id }, data: { status: 'ACCEPTED' } }); return {} },
    })
    expect(claimed).toEqual([`${batchId}-a`, `${batchId}-b`])
    expect(merged).toEqual([[`${batchId}-a`, `${batchId}-b`]])
    expect(submitted.sort()).toEqual([`${batchId}-c`, `${batchId}-d`].sort())
    expect(summary).toMatchObject({ submitted: 4, merged: 2 })
    expect((await prisma.bulkOperation.findUnique({ where: { id: batchId } }))?.status).toBe('SENT')
  }))
})

describe('batchEstimate', () => {
  it('uses the channels\' rates per account, two accounts side by side', () => {
    expect(batchEstimate([])).toMatchObject({ seconds: null, minutes: null })
    // 100 Amazon products reviewed: 100 / 5 + 1 s overhead = 21 s.
    expect(batchEstimate([{ kind: 'review', channel: 'AMAZON', accountId: 'a', marketplace: 'IT', products: 100 }])).toMatchObject({ seconds: 21, minutes: 1 })
    // eBay: 3 calls × 1.5 s per family.
    expect(batchEstimate([{ kind: 'send', channel: 'EBAY', accountId: 'e', marketplace: 'IT', products: 20 }]).seconds).toBe(5)
    // Amazon: 20 lone families in 20 feeds = 5 feeds over the burst of 15 → 10 minutes, plus 20 products of dry runs.
    const lone = Array.from({ length: 20 }, (_, i) => ({ kind: 'send' as const, channel: 'AMAZON', accountId: 'a', marketplace: `M${i}`, products: 1 }))
    expect(batchEstimate(lone).seconds).toBe(Math.ceil(20 / 5 + 5 * 120))
    // The same 20 families in one market share one feed.
    expect(batchEstimate(lone.map(item => ({ ...item, marketplace: 'IT' }))).seconds).toBe(4)
  })
})
