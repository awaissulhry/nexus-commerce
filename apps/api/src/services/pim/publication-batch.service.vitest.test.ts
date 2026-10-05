import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Sheet publish parity, step 5 (item 3) — a publication batch on the real schema and tenant policies.
 *
 * Creating one checks every review in one transaction (the caller's, still PREVIEW, not expired, a current selection
 * token on Amazon and eBay, not in another batch, one review per destination, no destination still waiting for an
 * earlier result, Amazon's one EU quantity) and either stamps them all and queues the batch, or changes nothing.
 * Reading derives every count from the children. Cancelling stops what has not started.
 */
const fixture = vi.hoisted(() => ({ database: null as any, run: vi.fn(async () => ({ claimed: true, submitted: 0, notSent: 0, skipped: 0, cancelled: 0 })), published: [] as any[] }))

vi.mock('@nexus/database', async () => {
  const { concurrentDatabase, concurrentDatabaseUrl } = await import('../../test-support/concurrent-database.js')
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  fixture.database = concurrentDatabaseUrl() ? await concurrentDatabase() : await formulaDatabase()
  return { default: fixture.database.client }
})
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: (event: unknown) => { fixture.published.push(event) } }))
// The sender is tested on its own (publication-batch.processor.vitest.test.ts); here a queued batch is only recorded.
vi.mock('./publication-batch.processor.js', async original => ({ ...await original<any>(), runPublicationBatch: fixture.run }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { ALIAS_FROM_OWN_WINDOW, batchView, cancelPublicationBatch, createPublicationBatch, readPublicationBatch } from './publication-batch.service.js'
import { batchEuQuantityConflicts, createdQuantity } from './publication-batch-eu-quantity.js'
import { BATCH_KIND, BATCH_REVIEW_TTL_MS } from './publication-batch.processor.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const USER = 'batch-user'
const OTHER = 'batch-other-user'
const FAMILY = 'batch-family'
let counter = 0
const nextTick = () => new Promise(resolve => setImmediate(resolve))

/** A new-listing Amazon plan whose saved selection compiles to one UPDATE message per SKU with `quantity`. */
function amazonPlan(market: string, skus: Array<{ productId: string; sku: string; quantity: number }>) {
  const messages = skus.map((p, i) => ({ messageId: i + 1, sku: p.sku, operationType: 'UPDATE', productType: 'COAT', requirements: 'LISTING',
    attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: p.quantity }] } }))
  return {
    kind: 'amazon-changes', remoteRevision: `remote-${market}`,
    publication: { kind: 'amazon', sellerId: 'seller-a', marketplaceId: `market-${market}`, products: skus.map(p => ({ productId: p.productId, sku: p.sku })),
      feed: { header: { sellerId: 'seller-a', version: '2.0' }, messages } },
    products: skus.map(p => ({ productId: p.productId, sku: p.sku, newListing: true, content: {}, patches: {}, contentRoots: {} })),
    changes: skus.map(p => ({ id: JSON.stringify([p.productId, '$create']), productId: p.productId, sku: p.sku, field: '$create', label: 'Complete new listing',
      current: { state: 'value', value: true }, lastAccepted: { state: 'unknown', reason: 'New' }, channel: { state: 'unknown', reason: 'New' },
      status: 'SEND', localChanged: true, channelChanged: null, selectable: true, selectedByDefault: true, reason: 'New listing', operation: 'replace' })),
  }
}

/** A saved review shaped as `previewStudioPublication` writes it, with a saved selection when the channel is sparse. */
async function review(input: { channel?: string; market?: string; account?: string; userId?: string; status?: string; expiresInMs?: number
  batchId?: string | null; token?: string | null; plan?: unknown; key?: string }) {
  const id = `review-${++counter}`
  const channel = input.channel ?? 'EBAY'
  const market = input.market ?? 'IT'
  const account = input.account ?? `${channel.toLowerCase()}-account`
  const token = input.token === undefined ? `token-${id}` : input.token
  const plan = input.plan ?? (channel === 'SHOPIFY' ? null : { kind: 'ebay-changes', changes: [] })
  await prisma.bulkOperation.create({ data: {
    id, userId: input.userId ?? USER, status: input.status ?? 'PREVIEW', productCount: 2, changeCount: 3,
    kind: 'studio-publication', productId: FAMILY, channel, marketplace: market, channelConnectionId: account, aliasKey: '', batchId: input.batchId ?? null,
    expiresAt: new Date(Date.now() + (input.expiresInMs ?? 15 * 60_000)),
    changes: { kind: 'studio-publication', publicationKey: input.key ?? `key-${channel}-${account}-${market}-${id}`, productId: FAMILY,
      scope: { channel, marketplace: market, accountId: account }, revision: 'rev-1', changeVersion: plan ? 1 : null, changePlan: plan,
      ...(token ? { selection: { token, selectedIds: (plan as any)?.changes?.map((c: any) => c.id) ?? [] } } : {}) },
  } as never })
  return { id, token: token ?? undefined }
}

const rowOf = (id: string) => prisma.bulkOperation.findUnique({ where: { id } })

describe('publication batches', () => {
  beforeAll(async () => { await scoped(() => prisma.bulkOperation.count()) }, 120_000)
  afterAll(async () => { await fixture.database?.close?.() })
  beforeEach(() => { fixture.run.mockClear(); fixture.published.length = 0 })

  it('stamps every review with the batch, lets the batch own their lifetime, and queues it once', () => scoped(async () => {
    const it1 = await review({ channel: 'EBAY', market: 'IT' })
    const de = await review({ channel: 'EBAY', market: 'DE' })
    const shop = await review({ channel: 'SHOPIFY', market: 'GLOBAL', token: null })
    const before = Date.now()
    const { batchId } = await createPublicationBatch({ reviews: [
      { reviewId: it1.id, selectionToken: it1.token }, { reviewId: de.id, selectionToken: de.token }, { reviewId: shop.id, confirmOverwrite: true, locationId: 'loc-1' }] }, USER)
    const header = await rowOf(batchId)
    expect(header).toMatchObject({ kind: BATCH_KIND, status: 'QUEUED', userId: USER, productCount: 3, changeCount: 9, productId: FAMILY, checkCount: 0 })
    expect((header!.changes as any).children).toEqual([it1.id, de.id, shop.id])
    for (const child of [it1, de, shop]) {
      const row = await rowOf(child.id)
      expect(row).toMatchObject({ status: 'PREVIEW', batchId })
      expect(row!.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + BATCH_REVIEW_TTL_MS - 1_000)
    }
    expect(((await rowOf(it1.id))!.changes as any).batch).toEqual({ batchId, body: { selectionToken: it1.token } })
    expect(((await rowOf(shop.id))!.changes as any).batch.body).toEqual({ confirmOverwrite: true, locationId: 'loc-1' })
    await nextTick()
    expect(fixture.run).toHaveBeenCalledTimes(1)
    expect(fixture.run).toHaveBeenCalledWith(batchId)
  }))

  it.each([
    ['a review of another person', async () => { const r = await review({ userId: OTHER }); return { reviews: [{ reviewId: r.id, selectionToken: r.token }] } }, 404, /not found/],
    ['a review already sent', async () => { const r = await review({ status: 'SUBMITTED' }); return { reviews: [{ reviewId: r.id, selectionToken: r.token }] } }, 409, /already sent/],
    ['a review a batch closed without sending', async () => { const r = await review({ status: 'NOT_SENT' }); return { reviews: [{ reviewId: r.id, selectionToken: r.token }] } }, 409, /not sent and is closed/],
    ['an expired review', async () => { const r = await review({ expiresInMs: -1_000 }); return { reviews: [{ reviewId: r.id, selectionToken: r.token }] } }, 409, /expired/],
    ['a stale selection token', async () => { const r = await review({}); return { reviews: [{ reviewId: r.id, selectionToken: 'stale' }] } }, 400, /selection token/],
    ['a missing selection token on eBay', async () => { const r = await review({}); return { reviews: [{ reviewId: r.id }] } }, 400, /selection token/],
    ['a review in another batch', async () => { const r = await review({ batchId: 'other-batch' }); return { reviews: [{ reviewId: r.id, selectionToken: r.token }] } }, 409, /another batch/],
    ['two reviews of one destination', async () => {
      const a = await review({ key: 'same-destination' }), b = await review({ key: 'same-destination' })
      return { reviews: [{ reviewId: a.id, selectionToken: a.token }, { reviewId: b.id, selectionToken: b.token }] } }, 400, /same listing/],
    ['a destination still waiting for an earlier result', async () => {
      const waiting = await review({ status: 'SUBMITTED', key: 'waiting-destination' })
      await prisma.bulkOperation.update({ where: { id: waiting.id }, data: { status: 'SUBMITTED' } })
      const r = await review({ key: 'waiting-destination' })
      return { reviews: [{ reviewId: r.id, selectionToken: r.token }] } }, 409, /still needs a result/],
  ])('refuses %s and changes nothing', (_name, build, status, message) => scoped(async () => {
    const ok = await review({ market: 'FR' })
    const body = await build()
    const reviews = [{ reviewId: ok.id, selectionToken: ok.token }, ...body.reviews]
    const before = await prisma.bulkOperation.count({ where: { kind: BATCH_KIND } })
    await expect(createPublicationBatch({ reviews }, USER)).rejects.toMatchObject({ statusCode: status, message: expect.stringMatching(message) })
    expect(await prisma.bulkOperation.count({ where: { kind: BATCH_KIND } })).toBe(before)
    expect(await rowOf(ok.id)).toMatchObject({ batchId: null })
    await nextTick()
    expect(fixture.run).not.toHaveBeenCalled()
  }))

  it('refuses a malformed request', () => scoped(async () => {
    await expect(createPublicationBatch({}, USER)).rejects.toMatchObject({ statusCode: 400 })
    await expect(createPublicationBatch({ reviews: [] }, USER)).rejects.toMatchObject({ statusCode: 400 })
    await expect(createPublicationBatch({ reviews: [{ reviewId: 'x' }, { reviewId: 'x' }] }, USER)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/twice/) })
    await expect(createPublicationBatch({ reviews: Array.from({ length: 26 }, (_, i) => ({ reviewId: `r${i}` })) }, USER)).rejects.toMatchObject({ statusCode: 400 })
  }))

  it('the products list never names a listing: an alias is refused (it would act on the main listing), nothing is queued (Owner 2026-10-05)', () => scoped(async () => {
    const before = await prisma.bulkOperation.count({ where: { kind: BATCH_KIND } })
    const destination = { channel: 'EBAY', marketplace: 'IT', accountId: 'ebay-account' }
    for (const listingId of ['alias-1', ''])
      await expect(createPublicationBatch({ productIds: ['p-1'], destinations: [destination, { ...destination, listingId }], options: { content: true } }, USER))
        .rejects.toMatchObject({ statusCode: 400, message: ALIAS_FROM_OWN_WINDOW })
    expect(ALIAS_FROM_OWN_WINDOW).toBe('Aliases are published from each product\'s own Publish window.')
    expect(await prisma.bulkOperation.count({ where: { kind: BATCH_KIND } })).toBe(before)
    expect(fixture.run).not.toHaveBeenCalled()
  }))

  it('refuses a batch whose new Amazon listings send two EU markets two quantities, naming the SKU and the markets', () => scoped(async () => {
    const it1 = await review({ channel: 'AMAZON', market: 'IT', account: 'amazon-eu', plan: amazonPlan('IT', [{ productId: 'p-s', sku: 'COAT-S', quantity: 5 }, { productId: 'p-m', sku: 'COAT-M', quantity: 2 }]) })
    const de = await review({ channel: 'AMAZON', market: 'DE', account: 'amazon-eu', plan: amazonPlan('DE', [{ productId: 'p-s', sku: 'COAT-S', quantity: 3 }, { productId: 'p-m', sku: 'COAT-M', quantity: 2 }]) })
    const error = await createPublicationBatch({ reviews: [{ reviewId: it1.id, selectionToken: it1.token }, { reviewId: de.id, selectionToken: de.token }] }, USER).catch(e => e)
    expect(error).toMatchObject({ statusCode: 422 })
    expect(error.message).toMatch(/COAT-S \(DE, IT\)/)
    expect(error.message).not.toMatch(/COAT-M/)
    expect(error.message).toMatch(/Nothing was sent/)
    expect(await rowOf(it1.id)).toMatchObject({ batchId: null })
  }))

  it('accepts the same quantity in every EU market, and a UK market beside them', () => scoped(async () => {
    const it1 = await review({ channel: 'AMAZON', market: 'IT', account: 'amazon-same', plan: amazonPlan('IT', [{ productId: 'p-s', sku: 'JACKET-S', quantity: 4 }]) })
    const de = await review({ channel: 'AMAZON', market: 'DE', account: 'amazon-same', plan: amazonPlan('DE', [{ productId: 'p-s', sku: 'JACKET-S', quantity: 4 }]) })
    const uk = await review({ channel: 'AMAZON', market: 'UK', account: 'amazon-same', plan: amazonPlan('UK', [{ productId: 'p-s', sku: 'JACKET-S', quantity: 9 }]) })
    const { batchId } = await createPublicationBatch({ reviews: [it1, de, uk].map(r => ({ reviewId: r.id, selectionToken: r.token })) }, USER)
    expect(await rowOf(batchId)).toMatchObject({ status: 'QUEUED' })
  }))

  it('reads the phase and every destination, in the order chosen, only for the person who started it', () => scoped(async () => {
    const a = await review({ market: 'ES' }), b = await review({ market: 'NL' })
    const { batchId } = await createPublicationBatch({ reviews: [b, a].map(r => ({ reviewId: r.id, selectionToken: r.token })) }, USER)
    await prisma.bulkOperation.update({ where: { id: a.id }, data: { status: 'ACCEPTED', summary: { message: 'eBay accepted item 1.' } } })
    const view = await readPublicationBatch(batchId, USER)
    expect(view.children.map(c => c.publicationId)).toEqual([b.id, a.id])
    expect(view).toMatchObject({ phase: 'QUEUED', done: false, outcome: 'IN_PROGRESS', counts: { total: 2, waiting: 1, succeeded: 1 } })
    expect(view.children[1]).toMatchObject({ status: 'ACCEPTED', terminal: true, message: 'eBay accepted item 1.', channel: 'EBAY', marketplace: 'ES' })
    await expect(readPublicationBatch(batchId, OTHER)).rejects.toMatchObject({ statusCode: 404 })
  }))

  it('cancels a queued batch at once: every destination not started is CANCELLED and announced', () => scoped(async () => {
    const a = await review({ market: 'BE' }), b = await review({ market: 'PL' })
    const { batchId } = await createPublicationBatch({ reviews: [a, b].map(r => ({ reviewId: r.id, selectionToken: r.token })) }, USER)
    fixture.published.length = 0
    const view = await cancelPublicationBatch(batchId, USER)
    expect(view).toMatchObject({ phase: 'CANCELLED', done: true, outcome: 'CANCELLED', counts: { cancelled: 2 } })
    expect(view.cancelRequestedAt).toEqual(expect.any(String))
    expect(fixture.published.map(e => [e.publicationId, e.status, e.terminal, e.batchId])).toEqual([[a.id, 'CANCELLED', true, batchId], [b.id, 'CANCELLED', true, batchId]])
    await expect(cancelPublicationBatch(batchId, USER)).rejects.toMatchObject({ statusCode: 409 })
  }))

  it('asks a sending batch to stop before its next destination, and never touches one already sent', () => scoped(async () => {
    const a = await review({ market: 'SE' }), b = await review({ market: 'IE' })
    const { batchId } = await createPublicationBatch({ reviews: [a, b].map(r => ({ reviewId: r.id, selectionToken: r.token })) }, USER)
    await prisma.bulkOperation.update({ where: { id: batchId }, data: { status: 'RUNNING' } })
    await prisma.bulkOperation.update({ where: { id: a.id }, data: { status: 'PUBLISHING' } })
    const view = await cancelPublicationBatch(batchId, USER)
    expect(view.phase).toBe('CANCELLING')
    expect(view.children.map(c => c.status)).toEqual(['PUBLISHING', 'PREVIEW'])
  }))
})

describe('batch view (derived, never stored twice)', () => {
  const header = (status: string, children: string[]) => ({ id: 'b1', status, createdAt: new Date('2026-10-02T10:00:00Z'), completedAt: new Date('2026-10-02T10:05:00Z'), changes: { children } })
  const child = (id: string, status: string, summary: Record<string, unknown> | null = null) => ({ id, status, productId: 'f', channel: 'AMAZON',
    marketplace: id, channelConnectionId: 'acc', aliasKey: '', completedAt: null, summary })

  it('is done only when the batch finished sending and every destination is final', () => {
    expect(batchView(header('SENT', ['IT', 'DE']), [child('IT', 'ACCEPTED'), child('DE', 'SUBMITTED')])).toMatchObject({ done: false, outcome: 'IN_PROGRESS', counts: { succeeded: 1, awaitingChannel: 1 } })
    expect(batchView(header('RUNNING', ['IT']), [child('IT', 'ACCEPTED')])).toMatchObject({ done: false, sentAt: null })
    expect(batchView(header('SENT', ['IT', 'DE']), [child('IT', 'ACCEPTED'), child('DE', 'VERIFIED')])).toMatchObject({ done: true, outcome: 'SUCCEEDED', sentAt: '2026-10-02T10:05:00.000Z' })
  })

  it('counts every destination by what became of it', () => {
    const view = batchView(header('SENT', []), [child('A', 'PREVIEW'), child('B', 'PUBLISHING'), child('C', 'UNVERIFIED'), child('D', 'PARTIAL'), child('E', 'FAILED'),
      child('F', 'NOT_SENT', { message: 'Nothing was sent. Live publishing is disabled.' }), child('G', 'CANCELLED'), child('H', 'BLOCKED'),
      child('I', 'SUBMITTED', { checkedAt: '2026-10-02T11:00:00Z', checkedBy: 'u' })])
    expect(view.counts).toEqual({ total: 9, waiting: 1, sending: 1, awaitingChannel: 1, succeeded: 0, partial: 1, failed: 1, notSent: 1, cancelled: 1, blocked: 1, checked: 1, unknown: 0 })
    expect(view.children.find(c => c.publicationId === 'I')).toMatchObject({ checked: true, terminal: true })
    expect(view.children.find(c => c.publicationId === 'F')).toMatchObject({ terminal: true, message: 'Nothing was sent. Live publishing is disabled.' })
  })

  it('says FAILED when nothing went through, PARTIAL when some did, CANCELLED when every destination was cancelled', () => {
    expect(batchView(header('SENT', []), [child('A', 'FAILED'), child('B', 'NOT_SENT')]).outcome).toBe('FAILED')
    expect(batchView(header('SENT', []), [child('A', 'ACCEPTED'), child('B', 'NOT_SENT')]).outcome).toBe('PARTIAL')
    expect(batchView(header('SENT', []), [child('A', 'SUBMITTED', { checkedAt: 'x' }), child('B', 'FAILED')]).outcome).toBe('PARTIAL')
    expect(batchView(header('CANCELLED', []), [child('A', 'CANCELLED'), child('B', 'CANCELLED')]).outcome).toBe('CANCELLED')
    expect(batchView(header('CANCELLED', []), [child('A', 'ACCEPTED'), child('B', 'CANCELLED')]).outcome).toBe('PARTIAL')
    expect(batchView(header('CANCELLED', []), [child('A', 'NOT_SENT'), child('B', 'CANCELLED')]).outcome).toBe('CANCELLED')
  })
})

describe('Amazon EU quantity inside a batch (pure)', () => {
  const send = (marketplace: string, accountId: string, quantity: number, extra: Record<string, unknown> = {}) => ({ reviewId: marketplace, marketplace, accountId,
    messages: [{ sku: 'S', operationType: 'UPDATE', attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity, ...extra }] } }] })

  it('reads the quantity of a new listing only', () => {
    expect(createdQuantity({ sku: 'S', operationType: 'PATCH', attributes: { fulfillment_availability: [{ quantity: 3 }] } })).toBeNull()
    expect(createdQuantity({ sku: 'S', operationType: 'UPDATE', attributes: {} })).toBeNull()
    expect(createdQuantity({ sku: 'S', operationType: 'UPDATE', attributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU' }] } })).toEqual({ quantity: 0, fba: true })
    expect(createdQuantity({ sku: 'S', operationType: 'UPDATE', attributes: { fulfillment_availability: [{ quantity: 0 }] } })).toEqual({ quantity: 0, fba: false })
  })

  it('flags two EU markets of one account with two quantities, and nothing else', () => {
    expect(batchEuQuantityConflicts([send('IT', 'a', 5), send('DE', 'a', 3)])).toEqual([expect.objectContaining({ sku: 'S', accountId: 'a', markets: ['DE', 'IT'] })])
    expect(batchEuQuantityConflicts([send('IT', 'a', 5), send('DE', 'a', 5)])).toEqual([])
    expect(batchEuQuantityConflicts([send('IT', 'a', 5), send('DE', 'b', 3)])).toEqual([])
    expect(batchEuQuantityConflicts([send('IT', 'a', 5), send('UK', 'a', 3)])).toEqual([])
    expect(batchEuQuantityConflicts([send('IT', 'a', 5), send('DE', 'a', 0, { fulfillment_channel_code: 'AMAZON_EU' })])).toEqual([])
  })
})
