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
import { BATCH_HEARTBEAT_MS, BATCH_KIND, defaultBatchSelection, runPublicationBatch, statusPairKey } from './publication-batch.processor.js'
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

/** One-click O5 — every family listed in every market (the real presence read has its own tests below). */
const listedEverywhere = async (families: string[], destinations: StudioPublishScope[] | null) => ({
  pairs: new Map(families.flatMap(family => (destinations ?? []).map(d => [statusPairKey(family, d), { presence: 'listed' as const, familySku: 'X' }]))),
  destinations: destinations ?? [] })

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

// The database closes once every block below has run (the O5 block uses it too).
afterAll(async () => { await fixture.database?.close?.() })

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
  afterAll(() => { delete process.env.ENABLE_QUEUE_WORKERS })
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
      if (family === ids.boot) return [change('b-same', 'SAME', false), change('b-cannot', 'CANNOT_COMPARE', false)] // nothing to send
      return [change(`${family}-send`, 'SEND', true), change(`${family}-differs`, 'DIFFERS', false), change(`${family}-same`, 'SAME', false)]
    })
    const { select, calls: selections } = fakeSelect()
    const summary = await runPublicationBatch(batchId, { presence: listedEverywhere, preview, select })
    expect(summary).toMatchObject({ claimed: true, reviewed: 5 })
    expect(calls).toHaveLength(6)
    // Nexus wins (One-click O5): the fields that differ on the channel are ticked too.
    expect(selections.map(s => s.ids.join()).sort()).toEqual([`${ids.coat}-send,${ids.coat}-differs`, `${ids.coat}-send,${ids.coat}-differs`, `${ids.glove}-send,${ids.glove}-differs`].sort())
    const header = await prisma.bulkOperation.findUnique({ where: { id: batchId } })
    expect(header).toMatchObject({ status: 'REVIEWED', nextCheckAt: null })
    const view = await readPublicationBatch(batchId, USER)
    expect(view.phase).toBe('REVIEWED')
    const row = (family: string, channel: string) => view.children.find(c => c.productId === family && c.channel === channel)!
    expect(row(ids.coat, 'AMAZON')).toMatchObject({ status: 'PREVIEW', familySku: 'COAT', familyTitle: 'Winter coat', selectedCount: 2, problems: { errors: 0, warnings: 1 },
      differs: { total: 1, ticked: 1 } })
    expect(view.request?.options).toEqual({ keepChannelValues: false, status: null, content: true, startAs: null })
    expect(row(ids.glove, 'EBAY')).toMatchObject({ status: 'BLOCKED', problems: { errors: 1, warnings: 0, messages: ['Choose a category first.'] } })
    expect(row(ids.boot, 'EBAY')).toMatchObject({ status: 'NOT_SENT', message: expect.stringContaining('cannot get a draft') })
    expect(row(ids.boot, 'AMAZON')).toMatchObject({ status: 'NOT_SENT', nothingToSend: true })
    expect(view.estimate?.seconds).toBeGreaterThan(0)
  }))

  it('Nexus wins: ticks the fields that differ on the channel too, unless Keep channel values (a Full update row stays whole)', () => scoped(async () => {
    const changes = [change('a', 'SEND', true), change('b', 'DIFFERS', false), change('c', 'SAME', false), change('d', 'CANNOT_COMPARE', false),
      { ...change('e', 'DIFFERS', false), selectable: false }]
    expect(defaultBatchSelection({ changes }, false)).toEqual(['a', 'b'])
    // O1's server default also ticks DIFFERS: Keep channel values still leaves them out.
    expect(defaultBatchSelection({ changes: [change('a', 'SEND', true), change('b', 'DIFFERS', true)] }, true)).toEqual(['a'])
    expect(defaultBatchSelection({ changes }, true)).toEqual(['a'])
    // A Full update row's locked fields go whole, Keep channel values or not.
    expect(defaultBatchSelection({ changes: [{ ...change('f', 'DIFFERS', true), locked: true }, { ...change('g', 'SEND', true), locked: true }] }, true)).toEqual(['f', 'g'])
    expect(defaultBatchSelection({ changes: [change('["p","photos"]', 'SEND', true), change('["p","title"]', 'SEND', true)], photosOnly: true }, false)).toEqual([])
  }))

  it('Keep channel values: the request carries it, the review leaves the differing fields out, the view echoes it', () => scoped(async () => {
    await expect(createPublicationBatch({ productIds: [ids.glove], destinations: [AMAZON_IT], options: { keepChannelValues: 'yes' } }, USER)).rejects.toMatchObject({ statusCode: 400 })
    const { batchId } = await createPublicationBatch({ productIds: [ids.glove, ids.boot], destinations: [AMAZON_IT], options: { keepChannelValues: true } }, USER)
    expect((await prisma.bulkOperation.findUniqueOrThrow({ where: { id: batchId } })).changes).toMatchObject({ request: { options: { keepChannelValues: true, content: true } } })
    const { select, calls } = fakeSelect()
    await runPublicationBatch(batchId, { presence: listedEverywhere, select, preview: fakePreview(family => family === ids.boot
      ? [change('only-differs', 'DIFFERS', true)] : [change('g-send', 'SEND', true), change('g-differs', 'DIFFERS', true)]).preview })
    expect(calls.map(c => c.ids)).toEqual([['g-send']])
    const view = await readPublicationBatch(batchId, USER)
    expect(view.request?.options).toMatchObject({ keepChannelValues: true })
    expect(view.children.find(c => c.productId === ids.glove)).toMatchObject({ selectedCount: 1, differs: { total: 1, ticked: 0 } })
    expect(view.children.find(c => c.productId === ids.boot)).toMatchObject({ status: 'NOT_SENT', nothingToSend: true, message: expect.stringContaining('Keep channel values is on') })
    // The older wire word: replaceDiffers false = keep the channel's values; absent = Nexus wins.
    const older = await createPublicationBatch({ productIds: [ids.glove], destinations: [AMAZON_IT], options: { replaceDiffers: false } }, USER)
    expect((await prisma.bulkOperation.findUniqueOrThrow({ where: { id: older.batchId } })).changes).toMatchObject({ request: { options: { keepChannelValues: true } } })
  }))

  it('a resumed review makes only the reviews still missing', () => scoped(async () => {
    const batchId = await reviewingBatch([ids.coat, ids.glove], [AMAZON_IT])
    const first = fakePreview(() => [change('x', 'SEND', true)])
    let made = 0
    // The first run stops after one review (the worker died): the header stays RUNNING with a stale heartbeat.
    await runPublicationBatch(batchId, { presence: listedEverywhere, preview: async (...args) => { made += 1; const review = await first.preview(...args)
      if (made === 1) await prisma.bulkOperation.update({ where: { id: batchId }, data: { status: 'CANCELLING' } })
      return review }, select: fakeSelect().select })
    await prisma.bulkOperation.update({ where: { id: batchId }, data: { status: 'RUNNING', nextCheckAt: new Date(Date.now() - 1), completedAt: null } })
    const second = fakePreview(() => [change('x', 'SEND', true)])
    await runPublicationBatch(batchId, { presence: listedEverywhere, preview: second.preview, select: fakeSelect().select })
    expect(second.calls.map(c => c.familyId)).toEqual([ids.glove])
    expect((await prisma.bulkOperation.findUnique({ where: { id: batchId } }))?.status).toBe('REVIEWED')
  }))

  it('submit: sends the current ticks, marks an expired review and one with nothing ticked NOT_SENT, and queues the send', () => scoped(async () => {
    const batchId = await reviewingBatch([ids.coat, ids.glove, ids.boot], [AMAZON_IT])
    const { select } = fakeSelect()
    await runPublicationBatch(batchId, { presence: listedEverywhere, preview: fakePreview(() => [change('x', 'SEND', true)]).preview, select })
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
    await runPublicationBatch(batchId, { presence: listedEverywhere, preview: fakePreview(() => [change('x', 'SEND', true)]).preview, select: fakeSelect().select })
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
  // New listings (ND4 B) — "New listings start as".
  it('New listings start as: every review of the batch is made with it, and the view says what each one creates; a wrong value or no content is refused', () => scoped(async () => {
    await expect(createPublicationBatch({ productIds: [ids.coat], destinations: [AMAZON_IT], options: { startAs: 'ended' } }, USER)).rejects.toMatchObject({ statusCode: 400 })
    await expect(createPublicationBatch({ productIds: [ids.coat], destinations: [AMAZON_IT], options: { status: 'active', startAs: 'inactive' } }, USER))
      .rejects.toMatchObject({ statusCode: 400, message: 'New listings start as applies to the listings the changes create. Choose Send changes too.' })
    const { batchId } = await createPublicationBatch({ productIds: [ids.coatS], destinations: [AMAZON_IT], options: { startAs: 'inactive' } }, USER)
    expect((await prisma.bulkOperation.findUniqueOrThrow({ where: { id: batchId } })).changes).toMatchObject({ request: { options: { startAs: 'inactive', content: true } } })
    const seen: unknown[] = []
    const base = fakePreview(() => [change('x', 'SEND', true)])
    await runPublicationBatch(batchId, { select: fakeSelect().select, preview: async (familyId, scope, userId, options) => {
      seen.push(options)
      const review = await base.preview(familyId, scope, userId, options)
      const row = await prisma.bulkOperation.findUniqueOrThrow({ where: { id: review.id! } })
      await prisma.bulkOperation.update({ where: { id: review.id! }, data: { changes: { ...(row.changes as object),
        creates: [{ productId: ids.coatS, sku: 'COAT-S', startsAs: 'inactive' }] } as never } })
      return review
    } })
    expect(seen).toEqual([expect.objectContaining({ batchId, startAs: 'inactive' })])
    const view = await readPublicationBatch(batchId, USER)
    expect(view.children).toEqual([expect.objectContaining({ kind: 'content', creates: [{ productId: ids.coatS, sku: 'COAT-S', startsAs: 'inactive' }] })])
  }))
})

/**
 * One-click O5 (OD3 A) — where the chosen families are listed, read from the real listing rows: the window starts with
 * those markets, and a family not listed in a market is skipped (not reviewed as a new listing) unless "New listings
 * start as" was chosen or one of its rows there has its own Status choice Active or Inactive.
 */
describe('listed markets and families not listed there (One-click O5)', () => {
  const P: Record<string, string> = {}
  let amazon = '', ebay = ''
  const scope = (channel: 'AMAZON' | 'EBAY', marketplace: string): StudioPublishScope => ({ channel, marketplace, accountId: channel === 'AMAZON' ? amazon : ebay })
  const listing = (productId: string, channel: 'AMAZON' | 'EBAY', marketplace: string, data: Record<string, unknown>) => prisma.channelListing.create({ data: {
    productId, channel, marketplace, channelMarket: `${channel}_${marketplace}`, region: marketplace, channelConnectionId: channel === 'AMAZON' ? amazon : ebay, ...data } as never })

  beforeAll(async () => {
    await scoped(async () => {
      amazon = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'o5 amazon', isActive: true, externalAccountId: 'O5SELLER',
        authStatus: 'connected', managedBy: 'oauth', region: 'EU' } as never })).id
      ebay = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'o5 ebay', isActive: true, externalAccountId: 'O5EBAY',
        authStatus: 'connected', managedBy: 'oauth', region: 'IT' } as never })).id
      const product = async (key: string, sku: string, parentId?: string) => { P[key] = (await prisma.product.create({ data: { sku, name: sku, basePrice: 10,
        ...(parentId ? { parentId } : { isParent: key === 'jacket' }) } as never })).id }
      await product('jacket', 'PJACKET'); await product('jacketS', 'PJACKET-S', P.jacket); await product('jacketM', 'PJACKET-M', P.jacket)
      await product('glove', 'PGLOVE'); await product('boot', 'PBOOT'); await product('hat', 'PHAT')
      // PJACKET: Active in IT, Inactive in DE (this market's offer removed), only drafts in FR.
      for (const key of ['jacketS', 'jacketM']) {
        await listing(P[key], 'AMAZON', 'IT', { externalListingId: `ASIN-${key}`, listingStatus: 'ACTIVE' })
        await listing(P[key], 'AMAZON', 'DE', { externalListingId: `ASIN-${key}`, listingStatus: 'ACTIVE', offerClosedAt: new Date() })
        await listing(P[key], 'AMAZON', 'FR', { listingStatus: 'DRAFT', isPublished: false })
      }
      // PGLOVE: not on Amazon IT yet, but its row's Status was set Active in the sheet (a new listing someone chose).
      await listing(P.glove, 'AMAZON', 'IT', { listingStatus: 'DRAFT', isPublished: false, sellingTarget: 'ACTIVE' })
      // PBOOT: ended on eBay (reviewed as before). PHAT: no listing anywhere.
      await listing(P.boot, 'EBAY', 'IT', { externalListingId: '1234', listingStatus: 'ENDED' })
    })
  }, 120_000)

  it('reads each family × market: listed (Active, Inactive), chosen, not listed (drafts, no row), other (Ended)', () => scoped(async () => {
    const { readFamilyPresence } = await import('./publication-batch.processor.js')
    const markets = [scope('AMAZON', 'IT'), scope('AMAZON', 'DE'), scope('AMAZON', 'FR'), scope('EBAY', 'IT')]
    const { pairs } = await readFamilyPresence([P.jacket, P.glove, P.boot, P.hat], markets)
    const of = (family: string, at: StudioPublishScope) => pairs.get(statusPairKey(family, at))?.presence
    expect(markets.map(at => of(P.jacket, at))).toEqual(['listed', 'listed', 'not_listed', 'not_listed'])
    expect(of(P.glove, scope('AMAZON', 'IT'))).toBe('chosen')
    expect(of(P.boot, scope('EBAY', 'IT'))).toBe('other')
    expect(markets.map(at => of(P.hat, at))).toEqual(['not_listed', 'not_listed', 'not_listed', 'not_listed'])
    expect(pairs.get(statusPairKey(P.jacket, scope('AMAZON', 'IT')))?.familySku).toBe('PJACKET')
  }))

  it('listed markets: every market where a chosen family is Active or Inactive, with how many families (a variation means its family)', () => scoped(async () => {
    const { listedMarkets } = await import('./publication-batch.service.js')
    expect(await listedMarkets({ productIds: [P.jacketS, P.glove, P.boot, P.hat] })).toEqual({ families: 4, markets: [
      { channel: 'AMAZON', marketplace: 'DE', accountId: amazon, families: 1 },
      { channel: 'AMAZON', marketplace: 'IT', accountId: amazon, families: 1 },
    ] })
    expect(await listedMarkets({ productIds: [P.hat] })).toEqual({ families: 1, markets: [] })
    await expect(listedMarkets({ productIds: [] })).rejects.toMatchObject({ statusCode: 400 })
    await expect(listedMarkets({ productIds: [P.hat, 'not-a-product'] })).rejects.toMatchObject({ statusCode: 404 })
  }))

  it('skips a family not listed in a market with the reason; reviews it when New listings start as is chosen', () => scoped(async () => {
    const markets = [scope('AMAZON', 'IT'), scope('AMAZON', 'FR')]
    const { batchId } = await createPublicationBatch({ productIds: [P.jacket, P.glove, P.hat], destinations: markets }, USER)
    const { preview, calls } = fakePreview(() => [change('x', 'SEND', true)])
    const summary = await runPublicationBatch(batchId, { preview, select: fakeSelect().select })
    expect(calls.map(c => `${c.familyId}:${c.scope.marketplace}`).sort()).toEqual([`${P.jacket}:IT`, `${P.glove}:IT`].sort())
    expect(summary).toMatchObject({ reviewed: 2, notListed: 4 })
    const view = await readPublicationBatch(batchId, USER)
    expect(view.phase).toBe('REVIEWED')
    const row = (family: string, market: string) => view.children.find(c => c.productId === family && c.marketplace === market)!
    expect(row(P.jacket, 'FR')).toMatchObject({ status: 'NOT_SENT', notListed: true, familySku: 'PJACKET',
      message: 'Skipped PJACKET on Amazon · FR: not listed there. Choose “New listings start as” to create it.' })
    expect(row(P.hat, 'IT')).toMatchObject({ status: 'NOT_SENT', notListed: true })
    expect(row(P.jacket, 'IT')).toMatchObject({ status: 'PREVIEW', selectedCount: 1 })
    expect(row(P.jacket, 'IT').notListed).toBeUndefined()
    expect(view.request).toMatchObject({ reviews: 6, reviewed: 6 })
    // With "New listings start as", a family not listed there is reviewed (its review creates it).
    const created = await createPublicationBatch({ productIds: [P.jacket, P.hat], destinations: markets, options: { startAs: 'inactive' } }, USER)
    const second = fakePreview(() => [change('x', 'SEND', true)])
    await runPublicationBatch(created.batchId, { preview: second.preview, select: fakeSelect().select })
    expect(second.calls).toHaveLength(4)
  }))
})

describe('EU quantity at submit skips only the reviews that conflict (OD4 A)', () => {
  it('names every review that creates a SKU with two EU quantities, and none other', async () => {
    const { euSkipped } = await import('./publication-batch.service.js')
    const { batchEuQuantityConflicts } = await import('./publication-batch-eu-quantity.js')
    const create = (sku: string, quantity: number) => ({ sku, operationType: 'UPDATE', attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity }] } })
    const sends = [
      { reviewId: 'r-it', marketplace: 'IT', accountId: 'a', messages: [create('GALE-M', 3), create('GALE-L', 1)] },
      { reviewId: 'r-de', marketplace: 'DE', accountId: 'a', messages: [create('GALE-M', 5)] },
      { reviewId: 'r-fr', marketplace: 'FR', accountId: 'a', messages: [create('GALE-L', 1)] },
      { reviewId: 'r-other', marketplace: 'ES', accountId: 'b', messages: [create('GALE-M', 9)] },
    ]
    const skipped = euSkipped(sends, batchEuQuantityConflicts(sends))
    expect([...skipped.keys()].sort()).toEqual(['r-de', 'r-it'])
    expect(skipped.get('r-it')).toContain('GALE-M (DE, IT)')
    expect(euSkipped(sends, [])).toEqual(new Map())
  })
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
