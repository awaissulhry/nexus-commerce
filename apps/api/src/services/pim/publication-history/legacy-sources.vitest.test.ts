import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

/**
 * Sheet publish parity, step 4 — the old Amazon flat-file uploads, the old eBay flat-file pushes and the photo runs in
 * the publish history (Owner D1 = A), on the real schema and tenant policies.
 *
 * Each source in every state it can be in (including the ones nobody will look at again), its filters (a family by any
 * SKU it sent; no account or person where the source keeps none), one run in full, the merge with product sheet runs
 * at the same instant (paging never repeats or skips a run), another business's runs, and plain words only.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { concurrentDatabase, concurrentDatabaseUrl } = await import('../../../test-support/concurrent-database.js')
  const { formulaDatabase } = await import('../../../test-support/formula-database.js')
  state.db = concurrentDatabaseUrl() ? await concurrentDatabase() : await formulaDatabase()
  return { default: state.db.client }
})

import prisma from '../../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import { countPublicationHistory, listPublicationHistory, parseHistoryQuery, publicationRunDetail, publicationRunRequest } from '../publication-history.service.js'

const scoped = <T>(work: () => Promise<T>, workspaceId = LEGACY_WORKSPACE_ID) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const OTHER_BUSINESS = `other-${randomUUID()}`
const NOW = new Date(Date.UTC(2026, 9, 1, 12, 0))
const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 10, minute))
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000)
/** The instant every source shares in the merge case. */
const SAME = at(0)
const ids: Record<string, string> = {}

const list = async (raw: Record<string, unknown> = {}) => scoped(async () => listPublicationHistory(await parseHistoryQuery(raw), { now: NOW }))
const runsOf = async (raw: Record<string, unknown> = {}) => (await list({ limit: 100, ...raw })).runs
const idsOf = async (raw: Record<string, unknown> = {}) => (await runsOf(raw)).map(run => run.id)
const detailOf = (id: string) => scoped(() => publicationRunDetail(id, { now: NOW }))
const totals = async (raw: Record<string, unknown> = {}, now = NOW, workspaceId = LEGACY_WORKSPACE_ID) =>
  scoped(async () => countPublicationHistory(await parseHistoryQuery(raw), { now }), workspaceId)
/** Every run the merged list returns for this query, paged to the end. */
async function everyRun(raw: Record<string, unknown>, now = NOW) {
  const runs: Array<{ id: string }> = []
  let cursor: string | undefined
  for (let page = 0; page < 100; page++) {
    const result = await scoped(async () => listPublicationHistory(await parseHistoryQuery({ ...raw, limit: 7, ...(cursor ? { cursor } : {}) }), { now }))
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

async function amazonJob(id: string, input: { status: string; submittedAt: Date; skus?: string[]; perSku?: unknown[]; summary?: Record<string, unknown>; error?: string; completedAt?: Date | null; marketplace?: string }) {
  await prisma.amazonFlatFileFeedJob.create({ data: { id, feedId: `FEED-${id}`, marketplace: input.marketplace ?? 'IT', status: input.status, skuCount: input.skus?.length ?? 0,
    skus: input.skus ?? [], perSkuResults: input.perSku as never, resultSummary: input.summary as never, errorMessage: input.error ?? null,
    submittedAt: input.submittedAt, completedAt: input.completedAt ?? null } as never })
}

async function ebayJob(id: string, input: { status: string; submittedAt: Date; results?: unknown[]; markets?: string[]; mode?: string; taskId?: string; error?: string; skuCount?: number }) {
  await prisma.ebayPushJob.create({ data: { id, mode: input.mode ?? 'api', taskId: input.taskId ?? null, markets: input.markets ?? ['IT'], skuCount: input.skuCount ?? input.results?.length ?? 0,
    status: input.status, perSkuResults: input.results as never, errorMessage: input.error ?? null, submittedAt: input.submittedAt,
    completedAt: ['DONE', 'PARTIAL', 'FATAL'].includes(input.status) ? new Date(input.submittedAt.getTime() + 60_000) : null } as never })
}

async function mediaRun(id: string, input: { status: string; createdAt: Date; receipts: Array<{ listingId: string; status: string; message?: string }>; actorId?: string | null }) {
  await prisma.amazonMediaRun.create({ data: { id, productId: ids.root, listingId: ids.listingS, accountId: ids.account, marketplace: 'IT', revision: 'r1', status: input.status,
    plan: input.receipts.map(r => ({ listingId: r.listingId, sku: r.listingId === ids.listingS ? 'COAT-S' : 'COAT-M', asin: r.listingId === ids.listingS ? 'ASIN-S' : 'ASIN-M', productType: 'COAT',
      desired: {}, before: {}, patches: [], changes: [], issues: [] })),
    receipts: input.receipts, actorId: input.actorId ?? null, createdAt: input.createdAt } as never })
}

const RAW_WORDS = /\b(FATAL|POOL|FAMILY|api)\b/

beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon IT', region: 'EU', currency: 'EUR', language: 'it', languages: ['it'] } as never })
    ids.user = (await prisma.userProfile.create({ data: { displayName: 'Photo Person', email: `p-${randomUUID()}@example.test` } as never })).id
    ids.account = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'Account A', isActive: true, externalAccountId: 'SELLER-A', authStatus: 'connected', managedBy: 'oauth', region: 'EU' } as never })).id
    ids.root = (await prisma.product.create({ data: { sku: 'COAT', name: 'Winter coat', basePrice: 10, isParent: true } as never })).id
    ids.s = (await prisma.product.create({ data: { sku: 'COAT-S', name: 'Coat S', basePrice: 10, parentId: ids.root, variantAttributes: { Colore: 'Nero', Taglia: 'S' } } as never })).id
    ids.m = (await prisma.product.create({ data: { sku: 'COAT-M', name: 'Coat M', basePrice: 10, parentId: ids.root, variantAttributes: { Colore: 'Nero', Taglia: 'M' } } as never })).id
    ids.glove = (await prisma.product.create({ data: { sku: 'GLOVE', name: 'Glove', basePrice: 10 } as never })).id
    ids.listingS = (await prisma.channelListing.create({ data: { productId: ids.s, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU',
      channelConnectionId: ids.account, externalListingId: 'ASIN-S' } as never })).id
    ids.listingM = (await prisma.channelListing.create({ data: { productId: ids.m, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU',
      channelConnectionId: ids.account } as never })).id

    // ── Amazon flat file ──
    await amazonJob('a-partial', { status: 'DONE', submittedAt: at(10), completedAt: at(12), skus: ['COAT-S', 'COAT-M', 'COAT'],
      perSku: [
        { sku: 'COAT-S', status: 'error', code: '8541', message: 'legacy text', issues: [{ code: '8541', severity: 'error', message: 'Not an allowed colour.', attributeNames: ['color'] }] },
        { sku: 'COAT-M', status: 'success', issues: [] },
      ] })
    await amazonJob('a-all-refused', { status: 'DONE', submittedAt: at(11), completedAt: at(13), skus: ['GLOVE'], perSku: [{ sku: 'GLOVE', status: 'error', code: '90220', message: 'Required attribute missing.', fields: ['outer'] }] })
    await amazonJob('a-accepted', { status: 'DONE', submittedAt: at(12), completedAt: at(14), skus: ['GLOVE'], perSku: [{ sku: 'GLOVE', status: 'warning', issues: [{ code: '1', severity: 'warning', message: 'A recommended attribute is empty.', attributeNames: [] }] }] })
    await amazonJob('a-summary-only', { status: 'DONE', submittedAt: at(13), completedAt: at(15), skus: ['GLOVE'], summary: { messagesProcessed: 1, messagesSuccessful: 1, messagesWithError: 0, messagesWithWarning: 0 } })
    await amazonJob('a-no-report', { status: 'DONE', submittedAt: at(14), completedAt: at(16), skus: ['GLOVE'], error: 'Amazon marked the feed complete but its processing report was unavailable after repeated attempts — verify the result in Seller Central.' })
    await amazonJob('a-fatal', { status: 'FATAL', submittedAt: at(15), completedAt: at(16), skus: ['GLOVE'], error: 'The feed could not be read.' })
    await amazonJob('a-cancelled', { status: 'CANCELLED', submittedAt: at(16), completedAt: at(17), skus: ['GLOVE'] })
    await amazonJob('a-processing', { status: 'IN_PROGRESS', submittedAt: minutesAgo(30), skus: ['GLOVE'], marketplace: 'DE' })
    await amazonJob('a-processing-for-days', { status: 'IN_PROGRESS', submittedAt: new Date(NOW.getTime() - 8 * 24 * 60 * 60_000), skus: ['GLOVE'] })

    // ── eBay flat file ──
    await ebayJob('e-done', { status: 'DONE', submittedAt: at(20), markets: ['IT'], results: [
      { sku: 'COAT-S', market: 'IT', status: 'PUSHED', message: 'pushed as variation group', itemId: '1111', listingId: 'L-S' },
      { sku: 'COAT-M', market: 'IT', status: 'PUSHED', message: 'pushed as variation group', itemId: '1111' },
      { sku: 'COAT', market: 'IT', status: 'FAMILY', message: 'family header — variations push individually' },
      { sku: 'GLOVE', market: 'IT', status: 'POOL', message: 'adopted row — price/quantity managed via the pool fan-out' },
    ] })
    await ebayJob('e-partial', { status: 'PARTIAL', submittedAt: at(21), markets: ['IT', 'DE'], results: [
      { sku: 'COAT-S', market: 'IT', status: 'PUSHED', message: 'pushed', itemId: '2222' },
      { sku: 'COAT-S', market: 'DE', status: 'ERROR', message: 'eBay refused: the category needs a brand.' },
    ] })
    await ebayJob('e-fatal', { status: 'FATAL', submittedAt: at(22), results: [{ sku: 'GLOVE', market: 'IT', status: 'ERROR', message: 'Out of stock — the shared pool has 0 available.' }] })
    await ebayJob('e-crashed', { status: 'FATAL', submittedAt: at(23), skuCount: 4, error: 'Background push crashed.' })
    await ebayJob('e-running', { status: 'RUNNING', submittedAt: minutesAgo(5), skuCount: 3 })
    await ebayJob('e-stopped', { status: 'RUNNING', submittedAt: minutesAgo(20), skuCount: 3 })
    await ebayJob('e-feed', { status: 'SUBMITTED', mode: 'feed', taskId: 'TASK-9', submittedAt: at(24), skuCount: 2 })

    // ── Photos ──
    await mediaRun('m-review', { status: 'REVIEW', createdAt: at(30), receipts: [{ listingId: ids.listingS, status: 'NOT_SENT' }] })
    await mediaRun('m-complete', { status: 'COMPLETE', createdAt: at(31), actorId: ids.user, receipts: [{ listingId: ids.listingS, status: 'ACCEPTED' }, { listingId: ids.listingM, status: 'UNCHANGED' }] })
    await mediaRun('m-partial', { status: 'COMPLETE', createdAt: at(32), receipts: [{ listingId: ids.listingS, status: 'ACCEPTED' }, { listingId: ids.listingM, status: 'REJECTED', message: 'Amazon refused the image.' }] })
    await mediaRun('m-unknown', { status: 'UNKNOWN', createdAt: at(33), receipts: [{ listingId: ids.listingS, status: 'UNKNOWN', message: 'No answer.' }] })
    await mediaRun('m-sending', { status: 'SUBMITTING', createdAt: minutesAgo(10), receipts: [{ listingId: ids.listingS, status: 'SENDING' }] })
    await mediaRun('m-lost', { status: 'QUEUED', createdAt: minutesAgo(100), receipts: [{ listingId: ids.listingS, status: 'NOT_SENT' }] })
    await prisma.amazonImageFeedJob.create({ data: { id: 'f-done', productId: ids.s, marketplace: 'IT', feedId: 'IMG-FEED-1', status: 'DONE', skus: ['COAT-S', 'COAT-M'], submittedAt: at(34), completedAt: at(35),
      resultSummary: { perSku: [{ sku: 'COAT-S', asin: 'ASIN-S', accepted: true, errors: [] }, { sku: 'COAT-M', asin: 'ASIN-M', accepted: false, errors: [{ code: '18027', message: 'Image too small.' }] }] } } as never })
    await prisma.amazonImageFeedJob.create({ data: { id: 'f-nothing', productId: ids.s, marketplace: 'IT', status: 'DONE', skus: [], submittedAt: at(35), errorMessage: 'No variants with ASINs + images found.' } as never })
    await prisma.amazonImageFeedJob.create({ data: { id: 'f-forgotten', productId: ids.s, marketplace: 'IT', feedId: 'IMG-FEED-2', status: 'IN_PROGRESS', skus: ['COAT-S'], submittedAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60_000) } as never })
    await prisma.channelImagePublishJob.create({ data: { id: 'c-done', productId: ids.root, channel: 'EBAY', marketplace: 'IT', status: 'DONE', vendorEntityId: '110000000001', submittedAt: at(36), completedAt: at(36),
      response: { results: [{ sku: '110000000001', market: 'IT', status: 'PUSHED', message: 'gallery 2 + 2 Colore sets' }], warnings: [] } } as never })
    await prisma.channelImagePublishJob.create({ data: { id: 'c-fatal', productId: ids.glove, channel: 'SHOPIFY', status: 'FATAL', submittedAt: at(37), completedAt: at(37), errorMessage: 'Shopify refused the image.' } as never })
    await prisma.channelImagePublishJob.create({ data: { id: 'c-cancelled', productId: ids.glove, channel: 'EBAY', marketplace: 'IT', status: 'CANCELLED', submittedAt: at(38), completedAt: at(39) } as never })
    await prisma.channelImagePublishJob.create({ data: { id: 'c-stuck', productId: ids.glove, channel: 'EBAY', marketplace: 'IT', status: 'SUBMITTING', submittedAt: minutesAgo(60) } as never })

    // ── One run per source at the same instant (and a product sheet run) for the merge ──
    await prisma.bulkOperation.create({ data: { id: 'same-studio', userId: null, productCount: 1, changeCount: 1, status: 'VERIFIED', changes: { kind: 'studio-publication', review: { action: 'update', rows: [] } },
      kind: 'studio-publication', productId: ids.glove, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: ids.account, aliasKey: '', submittedAt: SAME, createdAt: SAME, completedAt: SAME,
      summary: { products: 1, verified: 1, accepted: 0, failed: 0, submitted: 0, message: 'ok' } } as never })
    await amazonJob('same-a1', { status: 'DONE', submittedAt: SAME, completedAt: SAME, skus: ['GLOVE'], perSku: [{ sku: 'GLOVE', status: 'success' }] })
    await amazonJob('same-a2', { status: 'DONE', submittedAt: SAME, completedAt: SAME, skus: ['GLOVE'], perSku: [{ sku: 'GLOVE', status: 'success' }] })
    await ebayJob('same-e', { status: 'DONE', submittedAt: SAME, results: [{ sku: 'GLOVE', market: 'IT', status: 'PUSHED', message: 'pushed' }] })
    await prisma.channelImagePublishJob.create({ data: { id: 'same-c', productId: ids.glove, channel: 'EBAY', marketplace: 'IT', status: 'DONE', submittedAt: SAME, completedAt: SAME,
      response: { results: [{ sku: 'GLOVE', market: 'IT', status: 'PUSHED', message: 'gallery 1' }] } } as never })
  })

  const owner = await prisma.userProfile.create({ data: { email: `o-${randomUUID()}@example.test`, status: 'active' } as never })
  await prisma.workspace.create({ data: { id: OTHER_BUSINESS, name: 'Other business', createdByUserId: owner.id, creationKey: randomUUID() } as never })
  await scoped(async () => {
    await amazonJob('x-amazon', { status: 'DONE', submittedAt: at(50), skus: ['COAT-S'], perSku: [{ sku: 'COAT-S', status: 'success' }] })
    await ebayJob('x-ebay', { status: 'DONE', submittedAt: at(50), results: [{ sku: 'COAT-S', market: 'IT', status: 'PUSHED', message: 'pushed' }] })
    const other = await prisma.product.create({ data: { sku: 'COAT-S', name: 'Their coat', basePrice: 10 } as never })
    await prisma.channelImagePublishJob.create({ data: { id: 'x-photo', productId: other.id, channel: 'EBAY', status: 'DONE', submittedAt: at(50) } as never })
  }, OTHER_BUSINESS)
}, 180_000)

afterAll(async () => {
  await state.db?.close?.()
})

describe('old Amazon flat-file uploads', () => {
  it('decides each state, including a report that never came and a feed still processing after a week', async () => {
    const runs = new Map((await runsOf({ source: 'amazon-flat-file' })).map(run => [run.id, run]))
    expect(Object.fromEntries([...runs].filter(([id]) => !id.includes('same-')).map(([id, run]) => [id, run.state]))).toEqual({
      'amazon-flat-file:a-processing': 'in_progress', 'amazon-flat-file:a-cancelled': 'failed', 'amazon-flat-file:a-fatal': 'failed',
      'amazon-flat-file:a-no-report': 'needs_check', 'amazon-flat-file:a-summary-only': 'succeeded', 'amazon-flat-file:a-accepted': 'succeeded',
      'amazon-flat-file:a-all-refused': 'failed', 'amazon-flat-file:a-partial': 'partial', 'amazon-flat-file:a-processing-for-days': 'needs_check',
    })
    expect(runs.get('amazon-flat-file:a-partial')).toMatchObject({ source: 'amazon-flat-file', channel: 'AMAZON', marketplace: 'IT', kind: 'update', reference: 'FEED-a-partial',
      productId: ids.root, familySku: 'COAT', familyTitle: 'Winter coat', accountId: null, userId: null, finishedAt: at(12).toISOString(), message: 'Amazon refused 1 of 2.',
      counts: { accepted: 1, verified: 0, failed: 1, waiting: 0, notSent: 0, skipped: 0, unknown: 1 }, productCount: 3 })
    expect(runs.get('amazon-flat-file:a-processing')).toMatchObject({ finishedAt: null, counts: { waiting: 1 } })
    expect(runs.get('amazon-flat-file:a-no-report')).toMatchObject({ needsCheck: true, finishedAt: null })
  })

  it('a family matches by any SKU it sent; account and person filters find nothing here', async () => {
    expect(await idsOf({ source: 'amazon-flat-file', productId: ids.m })).toEqual(['amazon-flat-file:a-partial'])
    expect(await idsOf({ source: 'amazon-flat-file', marketplace: 'de' })).toEqual(['amazon-flat-file:a-processing'])
    expect(await idsOf({ source: 'amazon-flat-file', accountId: ids.account })).toEqual([])
    expect(await idsOf({ source: 'amazon-flat-file', userId: ids.user })).toEqual([])
    expect(await idsOf({ source: 'amazon-flat-file', channel: 'EBAY' })).toEqual([])
    expect(await idsOf({ source: 'amazon-flat-file', q: 'FEED-a-fatal' })).toEqual(['amazon-flat-file:a-fatal'])
    expect(await idsOf({ source: 'amazon-flat-file', q: 'winter' })).toEqual(['amazon-flat-file:a-partial'])
  })

  it('a run in full: refused first, Amazon\'s issues and the field they name, the listing, no request kept', async () => {
    const detail = await detailOf('amazon-flat-file:a-partial')
    expect(detail.products.map(p => [p.sku, p.result])).toEqual([['COAT-S', 'FAILED'], ['COAT', 'UNKNOWN'], ['COAT-M', 'ACCEPTED']])
    expect(detail.products[0]).toMatchObject({ productId: ids.s, variationLabel: 'Nero · S', message: 'Not an allowed colour.', code: '8541', fieldLabel: 'color',
      listingId: ids.listingS, externalId: 'ASIN-S', sentFields: [] })
    expect(detail.steps.map(s => s.key)).toEqual(['sent', 'received', 'processed'])
    expect(detail.steps[2]).toMatchObject({ label: 'Amazon refused 1 of 2', tone: 'warning' })
    expect(detail.hasRequest).toBe(false)
    const legacy = await detailOf('amazon-flat-file:a-all-refused')
    expect(legacy.products[0]).toMatchObject({ result: 'FAILED', code: '90220', fieldLabel: 'outer', message: 'Required attribute missing.' })
    await expect(scoped(() => publicationRunRequest('amazon-flat-file:a-partial', ids.listingS))).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('old eBay flat-file pushes', () => {
  it('decides each state: a push that stopped, a file nobody reads, a crash before eBay', async () => {
    const runs = new Map((await runsOf({ source: 'ebay-flat-file' })).map(run => [run.id, run]))
    expect(Object.fromEntries([...runs].filter(([id]) => !id.includes('same-')).map(([id, run]) => [id, run.state]))).toEqual({
      'ebay-flat-file:e-running': 'in_progress', 'ebay-flat-file:e-stopped': 'needs_check', 'ebay-flat-file:e-feed': 'needs_check',
      'ebay-flat-file:e-crashed': 'failed', 'ebay-flat-file:e-fatal': 'failed', 'ebay-flat-file:e-partial': 'partial', 'ebay-flat-file:e-done': 'succeeded',
    })
    // It named SKUs of two families (the coat, and the glove it left to shared stock): no single family.
    expect(runs.get('ebay-flat-file:e-done')).toMatchObject({ productId: null, familySku: null, reference: '1111', marketplace: 'IT', message: 'eBay accepted all 2.',
      counts: { accepted: 2, failed: 0, skipped: 2, notSent: 0, unknown: 0, waiting: 0, verified: 0 } })
    expect(runs.get('ebay-flat-file:e-partial')).toMatchObject({ marketplace: 'IT, DE', message: 'eBay refused 1 of 2.', productId: ids.root })
    expect(runs.get('ebay-flat-file:e-crashed')).toMatchObject({ message: 'Background push crashed.', counts: { notSent: 4 } })
    expect(runs.get('ebay-flat-file:e-running')).toMatchObject({ counts: { waiting: 3 }, finishedAt: null })
    expect(runs.get('ebay-flat-file:e-feed')).toMatchObject({ reference: 'TASK-9', needsCheck: true })
  })

  it('filters by market (any market of the push), family (any SKU it named), and never by account or person', async () => {
    expect(await idsOf({ source: 'ebay-flat-file', marketplace: 'DE' })).toEqual(['ebay-flat-file:e-partial'])
    expect((await idsOf({ source: 'ebay-flat-file', productId: ids.s })).sort()).toEqual(['ebay-flat-file:e-done', 'ebay-flat-file:e-partial'])
    expect(await idsOf({ source: 'ebay-flat-file', accountId: ids.account })).toEqual([])
    expect(await idsOf({ source: 'ebay-flat-file', userId: ids.user })).toEqual([])
    expect(await idsOf({ source: 'ebay-flat-file', q: '2222' })).toEqual(['ebay-flat-file:e-partial'])
    expect(await idsOf({ source: 'ebay-flat-file', state: 'needs_check' })).toEqual(['ebay-flat-file:e-stopped', 'ebay-flat-file:e-feed'])
  })

  it('a run in full: refused first, plain reasons for rows it did not send, the market when there are several', async () => {
    const done = await detailOf('ebay-flat-file:e-done')
    expect(done.products.map(p => [p.sku, p.result])).toEqual([['COAT-M', 'ACCEPTED'], ['COAT-S', 'ACCEPTED'], ['COAT', 'SKIPPED'], ['GLOVE', 'SKIPPED']])
    expect(done.products.find(p => p.sku === 'COAT-S')).toMatchObject({ message: 'Sent to eBay.', externalId: '1111', listingId: 'L-S', variationLabel: 'Nero · S' })
    expect(done.products.find(p => p.sku === 'GLOVE')!.message).toMatch(/follows shared stock/)
    expect(done.products.find(p => p.sku === 'COAT')!.message).toMatch(/main product of a family/)
    const partial = await detailOf('ebay-flat-file:e-partial')
    expect(partial.products[0]).toMatchObject({ result: 'FAILED', variationLabel: 'Nero · S · DE', message: 'eBay refused: the category needs a brand.' })
    expect(partial.steps.map(s => s.key)).toEqual(['sent', 'processed'])
    const stopped = await detailOf('ebay-flat-file:e-stopped')
    expect(stopped.steps.map(s => s.key)).toEqual(['sent', 'needs_check'])
  })
})

describe('photo runs', () => {
  it('lists sent runs from the three stores with their states (a review never sent is not a run)', async () => {
    const runs = new Map((await runsOf({ source: 'photos' })).map(run => [run.id, run]))
    expect(runs.has('photos:amazon-media.m-review')).toBe(false)
    expect(Object.fromEntries([...runs].filter(([id]) => !id.includes('same-')).map(([id, run]) => [id, run.state]))).toEqual({
      'photos:amazon-media.m-sending': 'in_progress', 'photos:channel.c-stuck': 'needs_check', 'photos:amazon-media.m-lost': 'needs_check',
      'photos:channel.c-cancelled': 'failed', 'photos:channel.c-fatal': 'failed', 'photos:channel.c-done': 'succeeded',
      'photos:amazon-feed.f-nothing': 'failed', 'photos:amazon-feed.f-done': 'partial', 'photos:amazon-media.m-unknown': 'needs_check',
      'photos:amazon-media.m-partial': 'partial', 'photos:amazon-media.m-complete': 'succeeded', 'photos:amazon-feed.f-forgotten': 'needs_check',
    })
    expect(runs.get('photos:amazon-media.m-complete')).toMatchObject({ kind: 'photos', userName: 'Photo Person', accountLabel: 'Account A', accountId: ids.account,
      productId: ids.root, familySku: 'COAT', counts: { accepted: 1, skipped: 1, failed: 0 } })
    expect(runs.get('photos:channel.c-cancelled')!.message).toBe('Replaced by a later attempt.')
    expect(runs.get('photos:amazon-feed.f-nothing')!.message).toBe('No variants with ASINs + images found.')
  })

  it('only the Media page run answers the account and person filters; a family matches its members\' runs', async () => {
    expect(await idsOf({ source: 'photos', userId: ids.user })).toEqual(['photos:amazon-media.m-complete'])
    expect((await idsOf({ source: 'photos', accountId: ids.account })).every(id => id.startsWith('photos:amazon-media.'))).toBe(true)
    expect(await idsOf({ source: 'photos', productId: ids.glove })).not.toContain('photos:channel.c-done')
    expect(await idsOf({ source: 'photos', productId: ids.m })).toContain('photos:amazon-feed.f-done')
    expect(await idsOf({ source: 'photos', channel: 'SHOPIFY' })).toEqual(['photos:channel.c-fatal'])
  })

  it('a run in full, per store', async () => {
    const media = await detailOf('photos:amazon-media.m-partial')
    expect(media.products.map(p => [p.sku, p.result, p.externalId])).toEqual([['COAT-M', 'FAILED', 'ASIN-M'], ['COAT-S', 'ACCEPTED', 'ASIN-S']])
    expect(media.products[0].message).toBe('Amazon refused the image.')
    const feed = await detailOf('photos:amazon-feed.f-done')
    expect(feed.products[0]).toMatchObject({ sku: 'COAT-M', result: 'FAILED', code: '18027', message: 'Image too small.' })
    const nothing = await detailOf('photos:amazon-feed.f-nothing')
    expect(nothing.steps.map(s => s.key)).toEqual(['not_sent'])
    const channel = await detailOf('photos:channel.c-done')
    expect(channel.products[0]).toMatchObject({ result: 'ACCEPTED', externalId: '110000000001', variationLabel: null, message: 'Photos sent: gallery 2 + 2 Colore sets.' })
  })
})

describe('the merged history', () => {
  it('orders every source at one instant by rank, and pages without repeating or skipping a run', async () => {
    const same = (await runsOf({ from: SAME.toISOString(), to: SAME.toISOString() })).map(run => run.id)
    expect(same).toEqual(['same-studio', 'amazon-flat-file:same-a2', 'amazon-flat-file:same-a1', 'ebay-flat-file:same-e', 'photos:channel.same-c'])
    const all = await idsOf()
    expect(new Set(all).size).toBe(all.length)
    for (const size of [1, 2, 3]) {
      const seen: string[] = []
      let cursor: string | undefined
      for (let page = 0; page < 100; page++) {
        const result = await list({ limit: size, ...(cursor ? { cursor } : {}) })
        seen.push(...result.runs.map(run => run.id))
        if (!result.nextCursor) break
        cursor = result.nextCursor
      }
      expect(seen).toEqual(all)
    }
  })

  it('never shows another business\'s runs', async () => {
    const all = await idsOf()
    expect(all.some(id => id.startsWith('x-') || id.includes(':x-') || id.includes('.x-'))).toBe(false)
    const theirs = await scoped(async () => (await listPublicationHistory(await parseHistoryQuery({ limit: 100 }), { now: NOW })).runs.map(run => run.id), OTHER_BUSINESS)
    expect(theirs.sort()).toEqual(['amazon-flat-file:x-amazon', 'ebay-flat-file:x-ebay', 'photos:channel.x-photo'])
    await expect(detailOf('amazon-flat-file:x-amazon')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('every source is covered, since its oldest run', async () => {
    const coverage = (await list()).coverage
    expect(coverage.map(c => [c.source, c.included])).toEqual([['studio', true], ['amazon-flat-file', true], ['ebay-flat-file', true], ['photos', true]])
    expect(coverage.find(c => c.source === 'ebay-flat-file')!.since).toBe(SAME.toISOString())
  })

  it('speaks in plain words: no flat-file codes in any message, step or product line', async () => {
    const runs = await runsOf()
    const words: string[] = runs.map(run => run.message ?? '')
    for (const run of runs.filter(r => r.source !== 'studio')) {
      const detail = await detailOf(run.id)
      words.push(...detail.steps.flatMap(s => [s.label, s.detail ?? '']), ...detail.products.map(p => p.message ?? ''))
    }
    expect(words.filter(word => RAW_WORDS.test(word))).toEqual([])
  })
})

describe('exact counts and Show in sheet support, across every source', () => {
  it('equal the length of the list each tile opens, for every filter and source', async () => {
    const combos: Array<Record<string, unknown>> = [{}, { source: 'amazon-flat-file' }, { source: 'ebay-flat-file' }, { source: 'photos' }, { source: 'studio,photos' },
      { channel: 'AMAZON' }, { channel: 'EBAY' }, { channel: 'SHOPIFY' }, { marketplace: 'IT' }, { marketplace: 'DE' }, { accountId: ids.account }, { userId: ids.user },
      { productId: ids.s }, { productId: ids.glove }, { from: at(11).toISOString(), to: at(33).toISOString() }, { q: 'GLOVE' }, { q: 'winter' }, { q: 'FEED-a-fatal' }]
    for (const filters of combos) await expectCountsMatchList(filters)
    // Later on, every finished run is older than the window, and the time-bound states (still running, still processing) move on.
    const later = new Date(NOW.getTime() + 8 * 24 * 60 * 60_000)
    const moved = await expectCountsMatchList({}, later)
    expect(moved).toMatchObject({ doneLast7Days: 0, inProgress: 0 })
  })

  it('no older source has a run marked as checked, so a checked filter finds none of theirs', async () => {
    const counted = await totals()
    expect(counted.checked).toBe(0)
    expect(counted.needsAttention).toBe(counted.byState.failed + counted.byState.partial + counted.byState.needs_check)
    expect(await idsOf({ checked: 'true' })).toEqual([])
    expect((await idsOf({ checked: 'false' })).length).toBe(counted.total)
  })

  it('count only this business', async () => {
    expect(await totals({}, NOW, OTHER_BUSINESS)).toMatchObject({ total: 3, byState: { succeeded: 3 } })
  })

  it('older runs do not know their listing alias; their products name the attributes the channel flagged', async () => {
    const runs = await runsOf()
    expect(runs.filter(run => run.source !== 'studio').every(run => run.aliasKey === null)).toBe(true)
    expect(runs.find(run => run.id === 'same-studio')!.aliasKey).toBe('')
    const amazon = await detailOf('amazon-flat-file:a-partial')
    expect(amazon.products.find(p => p.sku === 'COAT-S')).toMatchObject({ columnHint: ['color'], listingId: ids.listingS })
    expect((await detailOf('amazon-flat-file:a-all-refused')).products[0].columnHint).toEqual(['outer'])
    expect((await detailOf('ebay-flat-file:e-done')).products.every(p => Array.isArray(p.columnHint))).toBe(true)
    expect((await detailOf('photos:amazon-media.m-partial')).products.every(p => p.columnHint.length === 0)).toBe(true)
  })
})
