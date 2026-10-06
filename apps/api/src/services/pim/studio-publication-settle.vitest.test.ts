/**
 * Sheet publish parity, step 2 — product sheet publications settle by themselves.
 *
 * The result sweep (`runPublicationSettleTick`) and the submitter's status read share one settle core. These cases pin:
 * only due rows the new code scheduled are swept; a claim is exclusive; a result is stored once (held prices once);
 * Amazon backs off 2/4/8/15/30 minutes and gives up after 7 days; eBay Trading reads back up to 12 times; the
 * 30-minute receipt deadline; issues land on the exact listings the publication journaled; and a status event is
 * published only when the status really changes.
 *
 * The database here is an in-memory stand-in for the BulkOperation rows; the column writes against PostgreSQL are
 * covered in studio-publication-database.vitest.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  rows: new Map<string, any>(),
  amazonStatus: vi.fn(),
  ebayStatus: vi.fn(),
  settleRecords: vi.fn(),
  snapshots: vi.fn(),
  findListings: vi.fn(),
  updateListings: vi.fn(),
  countListings: vi.fn(),
  held: vi.fn(),
  fill: vi.fn(),
  recordIssues: vi.fn(),
  resolveIssues: vi.fn(),
  published: [] as any[],
  /** S10 — the listing rows the eBay rename reads (by id), and the shared-listing memberships it moves. */
  listingById: new Map<string, any>(),
  memberships: [] as any[],
  /** Runs inside a claim, before it is applied — a second replica moving the row first. */
  beforeClaim: null as null | ((row: any) => void),
}))

const matches = (row: any, where: any = {}) =>
  (!where.id || (typeof where.id === 'string' ? row.id === where.id : row.id !== where.id.not))
  && (!Object.hasOwn(where, 'userId') || row.userId === where.userId)
  && (!where.kind || row.kind === where.kind)
  && (!where.status || (typeof where.status === 'string' ? row.status === where.status : where.status.in.includes(row.status)))
  && (!where.nextCheckAt || (row.nextCheckAt != null && row.nextCheckAt.getTime() <= where.nextCheckAt.lte.getTime()))

function apply(row: any, data: any) {
  const next = { ...row }
  for (const [key, value] of Object.entries(data)) {
    next[key] = value && typeof value === 'object' && 'increment' in (value as any) ? (row[key] ?? 0) + (value as any).increment : value
  }
  return next
}

vi.mock('../../db.js', () => {
  const db: any = {
    bulkOperation: {
      findFirst: async ({ where }: any) => structuredClone([...m.rows.values()].find(row => matches(row, where)) ?? null),
      findMany: async ({ where, take }: any) => structuredClone([...m.rows.values()].filter(row => matches(row, where))
        .sort((a, b) => a.nextCheckAt.getTime() - b.nextCheckAt.getTime()).slice(0, take)),
      updateMany: async ({ where, data }: any) => {
        if (data.checkCount && m.beforeClaim) for (const row of m.rows.values()) if (row.id === where.id) m.beforeClaim(row)
        const hits = [...m.rows.values()].filter(row => matches(row, where))
        for (const row of hits) m.rows.set(row.id, apply(row, data))
        return { count: hits.length }
      },
    },
    channelListingSnapshot: { findMany: m.snapshots },
    channelListing: { findMany: m.findListings, updateMany: m.updateListings, count: m.countListings,
      findUnique: async ({ where }: any) => structuredClone(m.listingById.get(where.id) ?? null) },
    sharedListingMembership: {
      findFirst: async ({ where }: any) => m.memberships.find(row => row.marketplace === where.marketplace && row.itemId === where.itemId && row.sku === where.sku) ?? null,
      updateMany: async ({ where, data }: any) => {
        const hits = m.memberships.filter(row => row.marketplace === where.marketplace && row.itemId === where.itemId && row.sku === where.sku
          && where.OR.some((or: any) => or.productId === row.productId))
        for (const row of hits) Object.assign(row, data)
        return { count: hits.length }
      },
    },
    $transaction: async (fn: any) => fn(db),
  }
  return { default: db }
})
vi.mock('./studio-publication-plan.js', () => ({ object: (value: any) => value && typeof value === 'object' ? value : {} }))
vi.mock('./studio-publication-amazon.js', () => ({ readAmazonPublication: m.amazonStatus }))
vi.mock('./studio-publication-ebay.js', () => ({ readEbayPublication: m.ebayStatus }))
vi.mock('./studio-publication-records.js', () => ({ settlePublicationRecords: m.settleRecords }))
vi.mock('./channel-price-write.service.js', () => ({ sendHeldPrices: m.held }))
vi.mock('../amazon/listing-asin-fill.service.js', () => ({ fillAmazonListingAsins: m.fill }))
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: (event: any) => m.published.push(event) }))
vi.mock('../listing-issue-recorder.service.js', () => ({ recordFeedReportIssues: m.recordIssues }))
vi.mock('../listing-issues.service.js', () => ({ resolveCarriedListingIssues: m.resolveIssues,
  fingerprintIssue: (code: string, names: string[] = []) => `${code}::${[...names].sort().join(',')}` }))
vi.mock('../channel-issue-attributes.js', () => ({ resolveIssueAttributes: (names: string[] = []) => names }))
vi.mock('../../lib/cron/clustered.js', () => ({ default: { schedule: vi.fn(), validate: () => true } }))
vi.mock('../../utils/cron-observability.js', () => ({ recordCronRun: async (_name: string, run: () => Promise<unknown>) => run() }))

import { nextPublicationCheck, settleStudioPublication, storeResult, AMAZON_CHECK_WINDOW_MS } from './studio-publication-settle.js'
import { runPublicationSettleTick } from '../../jobs/studio-publication-settle.job.js'

const MINUTE = 60_000
const T0 = new Date('2026-10-02T10:00:00.000Z')
const at = (minutes: number) => new Date(T0.getTime() + minutes * MINUTE)
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
/** The sweep at a moment: the clock the settle core reads and the tick's own `now` agree, as they do in production. */
const tickAt = (now: Date) => { vi.setSystemTime(now); return runPublicationSettleTick(now) }

/** A publication the new code sent: `checkCount` 0 and a first look. */
function amazonSubmitted(overrides: Record<string, any> = {}) {
  const id = overrides.id ?? 'pub-amazon'
  const row = {
    id, userId: 'submitter', kind: 'studio-publication', status: 'SUBMITTED', productId: 'family', channel: 'AMAZON', marketplace: 'IT',
    channelConnectionId: 'acct-a', aliasKey: '', batchId: null, checkCount: 0, submittedAt: T0, nextCheckAt: at(2), createdAt: T0, summary: null,
    changes: { kind: 'studio-publication', productId: 'family', captureVersion: 1, startedAt: T0.toISOString(),
      scope: { channel: 'AMAZON', marketplace: 'IT', accountId: 'acct-a' }, delivery: { productIds: ['family', 'child'], aliasKey: '' },
      result: { id, status: 'SUBMITTED', message: 'Submitted', results: [
        { sku: 'SELLER-PARENT', status: 'SUBMITTED', reference: 'feed-1', message: 'Awaiting' },
        { sku: 'SELLER-CHILD', status: 'SUBMITTED', reference: 'feed-1', message: 'Awaiting' }] } },
    ...overrides,
  }
  m.rows.set(id, row)
  return row
}

function ebayUnverified(overrides: Record<string, any> = {}) {
  const id = overrides.id ?? 'pub-ebay'
  const row = {
    id, userId: 'submitter', kind: 'studio-publication', status: 'UNVERIFIED', productId: 'family', channel: 'EBAY', marketplace: 'IT',
    channelConnectionId: 'ebay-a', aliasKey: '', batchId: null, checkCount: 0, submittedAt: T0, nextCheckAt: at(2), createdAt: T0, summary: null,
    changes: { kind: 'studio-publication', productId: 'family', captureVersion: 1, startedAt: T0.toISOString(), inventory: false,
      scope: { channel: 'EBAY', marketplace: 'IT', accountId: 'ebay-a' }, delivery: { productIds: ['family', 'child'], aliasKey: '' },
      result: { id, status: 'UNVERIFIED', message: 'Acknowledged', results: [
        { sku: 'SKU', status: 'ACCEPTED', reference: 'item-123', message: 'Acknowledged by eBay' },
        { sku: 'CHILD', status: 'ACCEPTED', reference: 'item-123', message: 'Acknowledged by eBay' }] } },
    ...overrides,
  }
  m.rows.set(id, row)
  return row
}

const report = (rows: Array<{ sku: string; failed: boolean; issues?: any[] }>) =>
  ({ failed: rows.every(r => r.failed), completedAt: at(3), results: rows.map(r => ({ message: r.failed ? 'Rejected' : 'Processed', issues: [], ...r })) })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  vi.resetAllMocks()
  m.rows.clear()
  m.published.length = 0
  m.listingById.clear()
  m.memberships = []
  m.beforeClaim = null
  m.amazonStatus.mockResolvedValue(null)
  m.snapshots.mockResolvedValue([])
  m.findListings.mockResolvedValue([])
  m.updateListings.mockResolvedValue({ count: 0 })
  m.countListings.mockResolvedValue(2)
  m.recordIssues.mockResolvedValue({ listings: 0, issues: 0, unmatchedSkus: [] })
  m.resolveIssues.mockResolvedValue(0)
})

afterEach(() => { vi.useRealTimers() })

describe('nextPublicationCheck — the schedule', () => {
  const base = { channel: 'AMAZON', status: 'SUBMITTED', inventory: false, reference: true, submittedAt: T0, now: T0 }
  it('backs an Amazon feed off 2, 4, 8, 15 minutes, then every 30', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(checkCount => (nextPublicationCheck({ ...base, checkCount }).nextCheckAt!.getTime() - T0.getTime()) / MINUTE))
      .toEqual([2, 4, 8, 15, 30, 30, 30])
  })
  it('gives an Amazon feed up after 7 days and says it needs a person', () => {
    expect(nextPublicationCheck({ ...base, checkCount: 300, now: new Date(T0.getTime() + AMAZON_CHECK_WINDOW_MS) })).toEqual({ nextCheckAt: null, needsCheck: true })
  })
  it('looks at a send with no receipt at its 30-minute deadline', () => {
    expect(nextPublicationCheck({ ...base, status: 'PUBLISHING', reference: false, checkCount: 0 }).nextCheckAt).toEqual(at(31))
  })
  it('never polls what needs a person: an eBay Inventory read-back, Shopify, an UNVERIFIED with no reference, a final result', () => {
    for (const input of [{ channel: 'EBAY', status: 'UNVERIFIED', inventory: true }, { channel: 'SHOPIFY', status: 'UNVERIFIED' },
      { channel: 'EBAY', status: 'UNVERIFIED', reference: false }, { channel: 'AMAZON', status: 'ACCEPTED' }])
      expect(nextPublicationCheck({ ...base, checkCount: 0, ...input })).toEqual({ nextCheckAt: null, needsCheck: false })
  })
})

describe('the result sweep', () => {
  it('settles a SUBMITTED Amazon publication when the feed is DONE', async () => {
    amazonSubmitted()
    m.amazonStatus.mockResolvedValue(report([{ sku: 'SELLER-PARENT', failed: false }, { sku: 'SELLER-CHILD', failed: false }]))
    expect(await tickAt(at(2))).toEqual({ due: 1, claimed: 1, settled: 1, failed: 0 })
    const row = m.rows.get('pub-amazon')
    expect(row).toMatchObject({ status: 'ACCEPTED', nextCheckAt: null, checkCount: 1, completedAt: expect.any(Date),
      summary: { products: 2, accepted: 2, failed: 0, submitted: 0, verified: 0 } })
    expect(m.amazonStatus).toHaveBeenCalledWith('feed-1', 'acct-a', ['SELLER-PARENT', 'SELLER-CHILD'])
    expect(m.settleRecords).toHaveBeenCalledOnce()
  })

  it('settles each publication of a shared feed from its own messages (step 6)', async () => {
    const shared = amazonSubmitted({ id: 'pub-shared' })
    shared.changes = { ...shared.changes, feedMessages: [{ messageId: 3, sku: 'SELLER-PARENT' }, { messageId: 4, sku: 'SELLER-CHILD' }], feedTotal: 7 }
    m.amazonStatus.mockResolvedValue(report([{ sku: 'SELLER-PARENT', failed: false }, { sku: 'SELLER-CHILD', failed: true }]))
    await tickAt(at(2))
    expect(m.amazonStatus).toHaveBeenCalledWith('feed-1', 'acct-a', ['SELLER-PARENT', 'SELLER-CHILD'],
      { messages: [{ messageId: 3, sku: 'SELLER-PARENT' }, { messageId: 4, sku: 'SELLER-CHILD' }], feedTotal: 7 })
    expect(m.rows.get('pub-shared')).toMatchObject({ status: 'PARTIAL' })
  })

  it('keeps a pending report SUBMITTED and backs the next look off: 4, 8, 15, 30, 30 minutes', async () => {
    amazonSubmitted()
    let now = at(2)
    const gaps: number[] = []
    for (let i = 0; i < 5; i++) {
      await tickAt(now)
      const next = m.rows.get('pub-amazon').nextCheckAt as Date
      gaps.push((next.getTime() - now.getTime()) / MINUTE)
      now = next
    }
    expect(gaps).toEqual([4, 8, 15, 30, 30])
    expect(m.rows.get('pub-amazon')).toMatchObject({ status: 'SUBMITTED', checkCount: 5 })
    expect(m.rows.get('pub-amazon').completedAt).toBeUndefined()
    expect(m.published).toEqual([]) // nothing changed, nothing announced
  })

  it('stops after 7 days with needsCheck and leaves the status as it is', async () => {
    amazonSubmitted({ nextCheckAt: new Date(T0.getTime() + AMAZON_CHECK_WINDOW_MS), checkCount: 340, summary: { products: 2, submitted: 2 } })
    await tickAt(new Date(T0.getTime() + AMAZON_CHECK_WINDOW_MS))
    expect(m.rows.get('pub-amazon')).toMatchObject({ status: 'SUBMITTED', nextCheckAt: null, summary: { products: 2, submitted: 2, needsCheck: true } })
    expect(await tickAt(new Date(T0.getTime() + 2 * AMAZON_CHECK_WINDOW_MS))).toMatchObject({ due: 0 })
  })

  it('never sweeps a row whose nextCheckAt is null — every publication made before this step', async () => {
    amazonSubmitted({ nextCheckAt: null, checkCount: null })
    expect(await tickAt(at(10_000))).toEqual({ due: 0, claimed: 0, settled: 0, failed: 0 })
    expect(m.amazonStatus).not.toHaveBeenCalled()
  })

  it('a losing claim makes no channel call', async () => {
    amazonSubmitted()
    // Another replica claimed it between the due read and this claim.
    m.beforeClaim = row => m.rows.set(row.id, { ...row, nextCheckAt: at(7), checkCount: 1 })
    expect(await tickAt(at(2))).toEqual({ due: 1, claimed: 0, settled: 0, failed: 0 })
    expect(m.amazonStatus).not.toHaveBeenCalled()
  })

  it('the sweep and the status read racing settle once — held prices are sent once', async () => {
    amazonSubmitted()
    m.amazonStatus.mockResolvedValue(report([{ sku: 'SELLER-PARENT', failed: false }, { sku: 'SELLER-CHILD', failed: false }]))
    // Both accepted rows are still drafts here, so the winner promotes them and sends their held prices.
    m.snapshots.mockResolvedValue([{ channelListingId: 'listing-parent', payload: { channelConnectionId: 'acct-a', sku: 'SELLER-PARENT', requests: [] } }])
    m.findListings.mockResolvedValue([{ id: 'listing-parent' }])
    m.updateListings.mockResolvedValue({ count: 1 })
    vi.setSystemTime(at(2))
    const [tick, read] = await Promise.all([runPublicationSettleTick(at(2)), settleStudioPublication('pub-amazon', { actorUserId: 'submitter' })])
    expect(tick.settled + (read?.stored ? 1 : 0)).toBe(1)
    expect(m.settleRecords).toHaveBeenCalledOnce()
    expect(m.held).toHaveBeenCalledOnce()
    expect(m.held).toHaveBeenCalledWith({ listingIds: ['listing-parent'], actor: 'submitter', cause: 'publish' })
    expect(m.rows.get('pub-amazon').status).toBe('ACCEPTED')
  })

  it('turns a PUBLISHING row with no receipt UNVERIFIED at its 30-minute deadline, and stops looking', async () => {
    const changes = { ...amazonSubmitted().changes }
    delete (changes as any).result
    m.rows.set('pub-amazon', { ...m.rows.get('pub-amazon'), status: 'PUBLISHING', nextCheckAt: at(31), changes })
    await tickAt(at(29))
    expect(m.rows.get('pub-amazon').status).toBe('PUBLISHING') // not due yet
    await tickAt(at(31))
    expect(m.rows.get('pub-amazon')).toMatchObject({ status: 'UNVERIFIED', nextCheckAt: null })
    await flush()
    expect(m.published).toEqual([expect.objectContaining({ type: 'publication.status_changed', publicationId: 'pub-amazon', status: 'UNVERIFIED', terminal: false })])
  })

  it('reads an eBay item back with GetItem and gives up after 12 tries with needsCheck', async () => {
    ebayUnverified()
    m.ebayStatus.mockResolvedValue({ reference: 'item-123', warnings: [], verified: false })
    let now = at(2)
    for (let i = 0; i < 12; i++) {
      await tickAt(now)
      const next = m.rows.get('pub-ebay').nextCheckAt as Date | null
      if (!next) break
      now = next
    }
    expect(m.ebayStatus).toHaveBeenCalledTimes(12)
    expect(m.rows.get('pub-ebay')).toMatchObject({ status: 'UNVERIFIED', checkCount: 12, nextCheckAt: null, summary: expect.objectContaining({ needsCheck: true }) })
    expect(await tickAt(at(100_000))).toMatchObject({ due: 0 })
    await flush()
    expect(m.published).toEqual([]) // UNVERIFIED all along: no status change, no event
  })

  it('settles an eBay item the read-back confirms', async () => {
    ebayUnverified()
    m.ebayStatus.mockResolvedValue({ reference: 'item-123', warnings: [], verified: true })
    await tickAt(at(2))
    expect(m.rows.get('pub-ebay')).toMatchObject({ status: 'ACCEPTED', nextCheckAt: null })
    await flush()
    expect(m.published).toEqual([expect.objectContaining({ status: 'ACCEPTED', terminal: true, channel: 'EBAY', accountId: 'ebay-a', productId: 'family' })])
  })

  it('a failed check is retried later, not lost', async () => {
    amazonSubmitted()
    m.amazonStatus.mockRejectedValue(new Error('Amazon unavailable'))
    expect(await tickAt(at(2))).toMatchObject({ claimed: 1, failed: 1 })
    expect(m.rows.get('pub-amazon')).toMatchObject({ status: 'SUBMITTED', nextCheckAt: at(6), checkCount: 1 })
  })
})

describe('issues on the exact listings', () => {
  const journal = [
    // The alias SKU this business sent — its own listing.
    { channelListingId: 'listing-alias', payload: { channelConnectionId: 'acct-a', sku: 'SELLER-PARENT',
      requests: [{ message: { operationType: 'PATCH', patches: [{ op: 'replace', path: '/attributes/item_name' }, { op: 'replace', path: '/attributes/closure' }] } }] } },
    { channelListingId: 'listing-child', payload: { channelConnectionId: 'acct-a', sku: 'SELLER-CHILD',
      requests: [{ message: { operationType: 'UPDATE', attributes: { item_name: [], outer: [] } } }] } },
    // Another account's journal row on the same coordinate is never used.
    { channelListingId: 'listing-other-account', payload: { channelConnectionId: 'acct-b', sku: 'SELLER-PARENT', requests: [] } },
  ]

  it('files the report on the listings this publication journaled, never by product SKU', async () => {
    amazonSubmitted()
    m.snapshots.mockResolvedValue(journal)
    const issue = { code: '90220', severity: 'error', message: 'outer missing', attributeNames: ['outer'] }
    m.amazonStatus.mockResolvedValue(report([{ sku: 'SELLER-PARENT', failed: false }, { sku: 'SELLER-CHILD', failed: true, issues: [issue] }]))
    await tickAt(at(2))
    expect(m.rows.get('pub-amazon').status).toBe('PARTIAL')
    expect(m.rows.get('pub-amazon').changes.result.results[1]).toMatchObject({ status: 'FAILED', issues: [issue] })
    expect(m.recordIssues).toHaveBeenCalledOnce()
    const args = m.recordIssues.mock.calls[0][0]
    expect([...args.listingIdsBySku.entries()]).toEqual([['SELLER-PARENT', ['listing-alias']], ['SELLER-CHILD', ['listing-child']]])
    expect(args).toMatchObject({ marketplace: 'IT', source: 'amazon-feed', channel: 'AMAZON', occurredAt: at(3) })
    expect(args.perSku).toEqual([{ sku: 'SELLER-PARENT', status: 'success', issues: [] }, { sku: 'SELLER-CHILD', status: 'error', issues: [issue] }])
  })

  it('an accepted SKU resolves the issues about attributes it carried; a rejected SKU resolves nothing', async () => {
    amazonSubmitted()
    m.snapshots.mockResolvedValue(journal)
    const warning = { code: '18', severity: 'warning', message: 'closure warning', attributeNames: ['closure'] }
    m.amazonStatus.mockResolvedValue(report([{ sku: 'SELLER-PARENT', failed: false, issues: [warning] }, { sku: 'SELLER-CHILD', failed: true, issues: [] }]))
    await tickAt(at(2))
    expect(m.resolveIssues).toHaveBeenCalledOnce()
    expect(m.resolveIssues).toHaveBeenCalledWith(expect.anything(), 'listing-alias', 'amazon-feed', ['item_name', 'closure'], ['18::closure'])
  })

  it('files nothing when the publication journaled no listing (a publication from before the journal)', async () => {
    amazonSubmitted()
    m.amazonStatus.mockResolvedValue(report([{ sku: 'SELLER-PARENT', failed: true, issues: [{ code: '1', severity: 'error', message: 'x', attributeNames: [] }] }, { sku: 'SELLER-CHILD', failed: false }]))
    await tickAt(at(2))
    expect(m.recordIssues).not.toHaveBeenCalled()
  })
})

describe('the status event', () => {
  it('is published once when a feed settles, with the destination, and not on a pending look', async () => {
    amazonSubmitted({ batchId: 'batch-1' })
    await tickAt(at(2))
    await flush()
    expect(m.published).toEqual([])
    m.amazonStatus.mockResolvedValue(report([{ sku: 'SELLER-PARENT', failed: false }, { sku: 'SELLER-CHILD', failed: true }]))
    await tickAt(at(6))
    await flush()
    expect(m.published).toEqual([{ type: 'publication.status_changed', publicationId: 'pub-amazon', batchId: 'batch-1', productId: 'family',
      channel: 'AMAZON', marketplace: 'IT', accountId: 'acct-a', aliasKey: '', status: 'PARTIAL', terminal: true, ts: expect.any(Number) }])
  })
})

/**
 * S3 (per-channel SKU) — an accepted Amazon publication records the seller SKU each journal names (the SKU that was
 * sent) as the SKU Amazon holds now (`liveChannelSku`), for every accepted row, live or draft. Nothing else is written
 * for it, and a publication on another channel records nothing here.
 */
describe('S3 — the accepted Amazon seller SKU is recorded as the live one', () => {
  const liveSkuWrites = () => m.updateListings.mock.calls.map(([args]) => args).filter((args: any) => 'liveChannelSku' in (args.data ?? {}))

  it('every accepted row of the publication: liveChannelSku = the journaled SKU (only when it differs)', async () => {
    amazonSubmitted()
    m.amazonStatus.mockResolvedValue(report([{ sku: 'SELLER-PARENT', failed: false }, { sku: 'SELLER-CHILD-IT', failed: false }]))
    m.snapshots.mockResolvedValue([
      { channelListingId: 'listing-parent', payload: { channelConnectionId: 'acct-a', sku: 'SELLER-PARENT', requests: [] } },
      { channelListingId: 'listing-child', payload: { channelConnectionId: 'acct-a', sku: 'SELLER-CHILD-IT', requests: [] } },
    ])
    await tickAt(at(2))
    expect(liveSkuWrites()).toEqual([
      { where: { id: 'listing-parent', OR: [{ liveChannelSku: null }, { liveChannelSku: { not: 'SELLER-PARENT' } }] }, data: { liveChannelSku: 'SELLER-PARENT' } },
      { where: { id: 'listing-child', OR: [{ liveChannelSku: null }, { liveChannelSku: { not: 'SELLER-CHILD-IT' } }] }, data: { liveChannelSku: 'SELLER-CHILD-IT' } },
    ])
    // It reads only the ACCEPTED rows of this publication, on its own account.
    expect(m.snapshots).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ publishEventId: 'pub-amazon', outcome: 'ACCEPTED', channel: 'AMAZON',
      payload: { path: ['channelConnectionId'], equals: 'acct-a' } }) }))
  })

  it('a journal with no SKU records nothing', async () => {
    amazonSubmitted()
    m.amazonStatus.mockResolvedValue(report([{ sku: 'SELLER-PARENT', failed: false }, { sku: 'SELLER-CHILD', failed: false }]))
    m.snapshots.mockResolvedValue([{ channelListingId: 'listing-parent', payload: { channelConnectionId: 'acct-a', requests: [] } }])
    await tickAt(at(2))
    expect(liveSkuWrites()).toEqual([])
  })
})

/**
 * S4 (per-channel SKU) — an accepted eBay publication records the SKU each journal names (the SKU the row was sent under)
 * as the SKU eBay holds now, read only from this publication's ACCEPTED rows on its own account.
 */
describe('S4 — the accepted eBay SKU is recorded as the live one', () => {
  const liveSkuWrites = () => m.updateListings.mock.calls.map(([args]) => args).filter((args: any) => 'liveChannelSku' in (args.data ?? {}))

  it('every accepted row: liveChannelSku = the journaled SKU; a journal with no SKU records nothing', async () => {
    ebayUnverified()
    m.ebayStatus.mockResolvedValue({ reference: 'item-123', warnings: [], verified: true })
    m.snapshots.mockResolvedValue([
      { channelListingId: 'listing-ebay-parent', payload: { channelConnectionId: 'ebay-a', sku: 'OWN-PARENT', requests: [] } },
      { channelListingId: 'listing-ebay-child', payload: { channelConnectionId: 'ebay-a', sku: 'CHILD', requests: [] } },
      { channelListingId: 'listing-ebay-blank', payload: { channelConnectionId: 'ebay-a', sku: '  ', requests: [] } },
    ])
    await tickAt(at(2))
    expect(m.rows.get('pub-ebay').status).toBe('ACCEPTED')
    expect(liveSkuWrites()).toEqual([
      { where: { id: 'listing-ebay-parent', OR: [{ liveChannelSku: null }, { liveChannelSku: { not: 'OWN-PARENT' } }] }, data: { liveChannelSku: 'OWN-PARENT' } },
      { where: { id: 'listing-ebay-child', OR: [{ liveChannelSku: null }, { liveChannelSku: { not: 'CHILD' } }] }, data: { liveChannelSku: 'CHILD' } },
    ])
    expect(m.snapshots).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ outcome: 'ACCEPTED', channel: 'EBAY',
      payload: { path: ['channelConnectionId'], equals: 'ebay-a' } }) }))
  })
})

/**
 * S10 (per-channel SKU) — an eBay row this publication RENAMED in place (eBay accepted it under its own SKU): its
 * shared-listing membership follows the new SKU before the SKU is recorded as live (the stock fan-out and order matching
 * read memberships by SKU). A membership already under the new SKU, and a row that did not change SKU, are left alone.
 */
describe('S10 — an accepted eBay rename moves the item\'s membership to the new SKU', () => {
  const liveRow = (id: string, productId: string, extra: Record<string, unknown> = {}) => ({ id, productId, channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'ebay-a',
    aliasKey: '', externalListingId: 'item-123', listingStatus: 'ACTIVE', isPublished: true, channelSku: null, liveChannelSku: null, platformAttributes: {}, flatFileSnapshot: null,
    overrideData: null, offers: [], alias: null, product: { sku: productId.toUpperCase(), deletedAt: null }, ...extra })

  it('the renamed row\'s membership takes the new SKU; an unchanged row\'s stays; an occupied new SKU is never overwritten', async () => {
    ebayUnverified()
    m.ebayStatus.mockResolvedValue({ reference: 'item-123', warnings: [], verified: true })
    m.listingById.set('listing-black', liveRow('listing-black', 'black', { channelSku: 'BLACK-EB' }))
    m.listingById.set('listing-red', liveRow('listing-red', 'red'))
    m.listingById.set('listing-blue', liveRow('listing-blue', 'blue', { channelSku: 'BLUE-EB' }))
    m.memberships = [
      { marketplace: 'IT', itemId: 'item-123', sku: 'BLACK', productId: 'black' },
      { marketplace: 'IT', itemId: 'item-123', sku: 'RED', productId: 'red' },
      { marketplace: 'IT', itemId: 'item-123', sku: 'BLUE', productId: 'blue' },
      { marketplace: 'IT', itemId: 'item-123', sku: 'BLUE-EB', productId: 'other' },
    ]
    m.snapshots.mockResolvedValue([
      { channelListingId: 'listing-black', payload: { channelConnectionId: 'ebay-a', sku: 'BLACK-EB', requests: [] } },
      { channelListingId: 'listing-red', payload: { channelConnectionId: 'ebay-a', sku: 'RED', requests: [] } },
      { channelListingId: 'listing-blue', payload: { channelConnectionId: 'ebay-a', sku: 'BLUE-EB', requests: [] } },
    ])
    await tickAt(at(2))
    expect(m.rows.get('pub-ebay').status).toBe('ACCEPTED')
    expect(m.memberships.map(row => [row.productId, row.sku])).toEqual([['black', 'BLACK-EB'], ['red', 'RED'], ['blue', 'BLUE'], ['other', 'BLUE-EB']])
  })
})

/**
 * S5 (per-channel SKU) — a Shopify studio publication is stored VERIFIED only after Shopify read every variant back with
 * the SKU the native publisher sent, and each journal names that SKU. So an accepted Shopify row records it as the SKU
 * Shopify holds (`liveChannelSku`) — only a row Shopify maps to a variant: a grouped family's main row holds no SKU there.
 */
describe('S5 — the accepted Shopify variant SKU is recorded as the live one', () => {
  const liveSkuWrites = () => m.updateListings.mock.calls.map(([args]) => args).filter((args: any) => 'liveChannelSku' in (args.data ?? {}))
  function shopifyPublishing() {
    const row = { id: 'pub-shopify', userId: 'submitter', kind: 'studio-publication', status: 'PUBLISHING', productId: 'family', channel: 'SHOPIFY', marketplace: 'GLOBAL',
      channelConnectionId: 'shop-a', aliasKey: '', batchId: null, checkCount: null, submittedAt: T0, nextCheckAt: null, createdAt: T0, summary: null, changes: {} }
    m.rows.set(row.id, row)
    const data = { kind: 'studio-publication', productId: 'family', captureVersion: 1, startedAt: T0.toISOString(),
      scope: { channel: 'SHOPIFY', marketplace: 'GLOBAL', accountId: 'shop-a' }, delivery: { productIds: ['family', 'child'], aliasKey: '' } }
    const result = { id: row.id, status: 'VERIFIED', message: 'Verified', results: [
      { sku: 'FAMILY', status: 'VERIFIED', message: 'Verified by Shopify', reference: 'gid://shopify/Product/1' },
      { sku: 'CHILD-OWN', status: 'VERIFIED', message: 'Verified by Shopify', reference: 'gid://shopify/Product/1' }] }
    return { data, result }
  }

  it('the variant rows: liveChannelSku = the journaled (sent and read back) SKU; the family\'s main row records nothing', async () => {
    const { data, result } = shopifyPublishing()
    m.snapshots.mockResolvedValue([
      { channelListingId: 'listing-family', payload: { channelConnectionId: 'shop-a', sku: 'FAMILY', requests: [] } },
      { channelListingId: 'listing-child', payload: { channelConnectionId: 'shop-a', sku: 'CHILD-OWN', requests: [] } },
    ])
    m.findListings.mockResolvedValue([{ id: 'listing-family', platformAttributes: { nexusFamilyId: 'family' } }, { id: 'listing-child', platformAttributes: { nexusFamilyId: 'family', variantId: '41' } }])
    await storeResult('pub-shopify', data, 'submitter', result as never, ['PUBLISHING'])
    expect(m.rows.get('pub-shopify').status).toBe('VERIFIED')
    expect(liveSkuWrites()).toEqual([
      { where: { id: 'listing-child', OR: [{ liveChannelSku: null }, { liveChannelSku: { not: 'CHILD-OWN' } }] }, data: { liveChannelSku: 'CHILD-OWN' } },
    ])
    expect(m.snapshots).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ publishEventId: 'pub-shopify', outcome: 'ACCEPTED', channel: 'SHOPIFY',
      payload: { path: ['channelConnectionId'], equals: 'shop-a' } }) }))
    // It asks only for the accepted rows' mapping.
    expect(m.findListings).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['listing-family', 'listing-child'] } } }))
  })

  it('nothing accepted: no read, no write', async () => {
    const { data, result } = shopifyPublishing()
    await storeResult('pub-shopify', data, 'submitter', result as never, ['PUBLISHING'])
    expect(m.findListings).not.toHaveBeenCalled()
    expect(liveSkuWrites()).toEqual([])
  })
})

/**
 * E2 — an Etsy send that ADDED a variation: the row joins the family's one Etsy listing (the id its live rows carry),
 * with the owner row's status and pause and its journal SKU, only under VERIFIED. No Amazon closed offer, no ASIN read.
 * §10.5 — a variation created Inactive joined hidden: it is held with the Etsy variation reason, and its prices stay held.
 */
describe('E2 — an accepted new Etsy variation joins its listing', () => {
  const LISTING = '9000000001'
  const destination = { channel: 'ETSY', marketplace: 'GLOBAL', channelConnectionId: 'etsy-a', aliasKey: '' }
  const promotions = () => m.updateListings.mock.calls.map(([args]) => args).filter((args: any) => args.data?.externalListingId !== undefined)
  function etsyPublishing(extra: Record<string, any> = {}) {
    const row = { id: 'pub-etsy', userId: 'submitter', kind: 'studio-publication', status: 'PUBLISHING', productId: 'family', channel: 'ETSY', marketplace: 'GLOBAL',
      channelConnectionId: 'etsy-a', aliasKey: '', batchId: null, checkCount: null, submittedAt: T0, nextCheckAt: null, createdAt: T0, summary: null, changes: {} }
    m.rows.set(row.id, row)
    const data = { kind: 'studio-publication', productId: 'family', captureVersion: 1, startedAt: T0.toISOString(),
      scope: { channel: 'ETSY', marketplace: 'GLOBAL', accountId: 'etsy-a' }, delivery: { productIds: ['family', 'child-1', 'child-new', 'child-hidden'], aliasKey: '' }, ...extra }
    const result = (status: string) => ({ id: row.id, status, message: status, results: [
      { sku: 'FAKE-SKU-1', status: status === 'VERIFIED' ? 'VERIFIED' : 'ACCEPTED', message: 'Read back from Etsy', reference: LISTING },
      { sku: 'FAKE-SKU-3', status: status === 'VERIFIED' ? 'VERIFIED' : 'ACCEPTED', message: 'Read back from Etsy', reference: LISTING }] })
    return { data, result }
  }
  /** The two reads the step makes: the accepted drafts (by id), then the family's live rows (externalListingId not null). */
  function listings(live: any[], drafts = [{ id: 'listing-new', productId: 'child-new' }]) {
    m.findListings.mockImplementation(async ({ where }: any) => where.externalListingId === null ? drafts.filter(d => where.id.in.includes(d.id)) : live)
    m.updateListings.mockResolvedValue({ count: 1 })
  }
  /** A freshly linked listing: ACTIVE on Etsy, its rows sync-paused (identity link), no hold. */
  const owner = { productId: 'family', externalListingId: LISTING, listingStatus: 'ACTIVE', syncPaused: true, offerClosedAt: null, offerCloseReason: null }
  const sibling = { productId: 'child-1', externalListingId: LISTING, listingStatus: 'ACTIVE', syncPaused: true, offerClosedAt: null, offerCloseReason: null }
  /** The listing paused as a whole (Pause offer: INACTIVE + the sheet-pause hold on every row). */
  const paused = (row: typeof owner) => ({ ...row, listingStatus: 'INACTIVE', offerClosedAt: new Date('2026-10-01T00:00:00Z'), offerCloseReason: 'sheet-pause' })

  it('VERIFIED: the accepted draft takes the listing id, the owner\'s status and sync pause, and its journal SKU; held prices once; no ASIN, no hold', async () => {
    const { data, result } = etsyPublishing()
    m.snapshots.mockResolvedValue([{ channelListingId: 'listing-new', payload: { channelConnectionId: 'etsy-a', sku: 'FAKE-SKU-3', requests: [] } }])
    listings([owner, sibling])
    await storeResult('pub-etsy', data, 'submitter', result('VERIFIED') as never, ['PUBLISHING'])
    await flush()
    expect(m.rows.get('pub-etsy').status).toBe('VERIFIED')
    expect(m.findListings).toHaveBeenCalledWith({ where: { id: { in: ['listing-new'] }, ...destination, listingStatus: 'DRAFT', isPublished: false, externalListingId: null },
      select: { id: true, productId: true } })
    expect(m.findListings).toHaveBeenCalledWith(expect.objectContaining({ where: { ...destination, productId: { in: data.delivery.productIds }, externalListingId: { not: null } } }))
    const writes = promotions()
    expect(writes).toHaveLength(1)
    expect(writes[0].where).toEqual({ id: 'listing-new', ...destination, listingStatus: 'DRAFT', isPublished: false, externalListingId: null })
    expect(writes[0].data).toEqual({ externalListingId: LISTING, isPublished: true, listingStatus: 'ACTIVE', syncPaused: true, liveChannelSku: 'FAKE-SKU-3',
      lastSyncedAt: expect.any(Date), lastSyncStatus: 'SUCCESS', version: { increment: 1 } })
    expect(writes[0].data).not.toHaveProperty('offerClosedAt')
    expect(writes[0].data).not.toHaveProperty('offerCloseReason')
    expect(m.held).toHaveBeenCalledTimes(1)
    expect(m.held).toHaveBeenCalledWith({ listingIds: ['listing-new'], actor: 'submitter', cause: 'publish' })
    expect(m.fill).not.toHaveBeenCalled()
  })

  it('an active, unpaused listing gives an active, unpaused row; with no owner row the draft keeps its own pause', async () => {
    const { data, result } = etsyPublishing()
    m.snapshots.mockResolvedValue([{ channelListingId: 'listing-new', payload: { channelConnectionId: 'etsy-a', sku: 'FAKE-SKU-3', requests: [] } }])
    listings([{ ...owner, listingStatus: 'ACTIVE', syncPaused: false }])
    await storeResult('pub-etsy', data, 'submitter', result('VERIFIED') as never, ['PUBLISHING'])
    expect(promotions()[0].data).toMatchObject({ listingStatus: 'ACTIVE', syncPaused: false })
    expect(promotions()[0].data).not.toHaveProperty('offerClosedAt')
    m.rows.clear(); m.updateListings.mockClear()
    const again = etsyPublishing()
    listings([sibling])
    await storeResult('pub-etsy', again.data, 'submitter', again.result('VERIFIED') as never, ['PUBLISHING'])
    expect(promotions()[0].data.listingStatus).toBe('ACTIVE')
    expect(promotions()[0].data).not.toHaveProperty('syncPaused')
  })

  it('m2: a listing paused as a whole — the promoted row gets the same listing-level hold (sheet-pause), and no held price goes', async () => {
    const { data, result } = etsyPublishing()
    m.snapshots.mockResolvedValue([{ channelListingId: 'listing-new', payload: { channelConnectionId: 'etsy-a', sku: 'FAKE-SKU-3', requests: [] } }])
    listings([paused(owner), paused(sibling)])
    await storeResult('pub-etsy', data, 'operator', result('VERIFIED') as never, ['PUBLISHING'])
    const [write] = promotions()
    expect(write.data).toEqual({ externalListingId: LISTING, isPublished: true, listingStatus: 'INACTIVE', syncPaused: true, liveChannelSku: 'FAKE-SKU-3',
      lastSyncedAt: expect.any(Date), lastSyncStatus: 'SUCCESS', version: { increment: 1 },
      offerClosedAt: expect.any(Date), offerClosedBy: 'operator', offerCloseReason: 'sheet-pause', offerActive: false,
      offerCloseSnapshot: { channel: 'ETSY', source: 'publish', listingPaused: true, publicationId: 'pub-etsy', etsyListingId: LISTING } })
    expect(m.held).not.toHaveBeenCalled()
  })

  it('m2: either sign of a listing-level pause is enough (INACTIVE alone — an older close — or the sheet-pause hold alone)', async () => {
    for (const live of [[{ ...owner, listingStatus: 'INACTIVE' }], [owner, { ...sibling, offerClosedAt: new Date('2026-10-01T00:00:00Z'), offerCloseReason: 'sheet-pause' }]]) {
      m.rows.clear(); m.updateListings.mockClear(); m.held.mockClear()
      const { data, result } = etsyPublishing()
      m.snapshots.mockResolvedValue([{ channelListingId: 'listing-new', payload: { channelConnectionId: 'etsy-a', sku: 'FAKE-SKU-3', requests: [] } }])
      listings(live)
      await storeResult('pub-etsy', data, 'submitter', result('VERIFIED') as never, ['PUBLISHING'])
      expect(promotions()[0].data.offerCloseReason).toBe('sheet-pause')
      expect(m.held).not.toHaveBeenCalled()
    }
  })

  it('m2: one HIDDEN sibling is not a listing-level pause — the new row joins shown, with no hold', async () => {
    const { data, result } = etsyPublishing()
    m.snapshots.mockResolvedValue([{ channelListingId: 'listing-new', payload: { channelConnectionId: 'etsy-a', sku: 'FAKE-SKU-3', requests: [] } }])
    listings([owner, { ...sibling, offerClosedAt: new Date('2026-10-01T00:00:00Z'), offerCloseReason: 'etsy-variation-hidden' }])
    await storeResult('pub-etsy', data, 'submitter', result('VERIFIED') as never, ['PUBLISHING'])
    expect(promotions()[0].data).not.toHaveProperty('offerClosedAt')
    expect(m.held).toHaveBeenCalledWith({ listingIds: ['listing-new'], actor: 'submitter', cause: 'publish' })
  })

  it('m2: created hidden on a paused listing — hidden wins (ETSY_VARIATION_HIDDEN_REASON), the shown sibling takes the listing-level hold', async () => {
    const { data, result } = etsyPublishing({ inactiveProductIds: ['child-hidden'] })
    m.snapshots.mockResolvedValue([
      { channelListingId: 'listing-new', payload: { channelConnectionId: 'etsy-a', sku: 'FAKE-SKU-3', requests: [] } },
      { channelListingId: 'listing-hidden', payload: { channelConnectionId: 'etsy-a', sku: 'FAKE-SKU-4', requests: [] } },
    ])
    listings([paused(owner)], [{ id: 'listing-new', productId: 'child-new' }, { id: 'listing-hidden', productId: 'child-hidden' }])
    await storeResult('pub-etsy', data, 'operator', result('VERIFIED') as never, ['PUBLISHING'])
    const writes = promotions()
    const hidden = writes.find((w: any) => w.where.id === 'listing-hidden')
    const joined = writes.find((w: any) => w.where.id === 'listing-new')
    expect(hidden.data).toMatchObject({ offerCloseReason: 'etsy-variation-hidden',
      offerCloseSnapshot: { channel: 'ETSY', source: 'publish', createdInactive: true, publicationId: 'pub-etsy', etsyListingId: LISTING } })
    expect(joined.data).toMatchObject({ offerCloseReason: 'sheet-pause', offerCloseSnapshot: { listingPaused: true } })
    expect(m.held).not.toHaveBeenCalled()
  })

  it('UNVERIFIED promotes nothing (and sends no held price)', async () => {
    const { data, result } = etsyPublishing()
    m.snapshots.mockResolvedValue([{ channelListingId: 'listing-new', payload: { channelConnectionId: 'etsy-a', sku: 'FAKE-SKU-3', requests: [] } }])
    listings([owner])
    await storeResult('pub-etsy', data, 'submitter', result('UNVERIFIED') as never, ['PUBLISHING'])
    expect(m.rows.get('pub-etsy').status).toBe('UNVERIFIED')
    expect(promotions()).toEqual([])
    expect(m.findListings).not.toHaveBeenCalled()
    expect(m.held).not.toHaveBeenCalled()
  })

  it('the family\'s live rows naming two Etsy listings: nothing is promoted (never a guess)', async () => {
    const { data, result } = etsyPublishing()
    m.snapshots.mockResolvedValue([{ channelListingId: 'listing-new', payload: { channelConnectionId: 'etsy-a', sku: 'FAKE-SKU-3', requests: [] } }])
    listings([owner, { ...sibling, externalListingId: '9000000002' }])
    await storeResult('pub-etsy', data, 'submitter', result('VERIFIED') as never, ['PUBLISHING'])
    expect(promotions()).toEqual([])
    expect(m.held).not.toHaveBeenCalled()
    // ...and none at all is the same answer.
    m.rows.clear()
    const again = etsyPublishing()
    listings([])
    await storeResult('pub-etsy', again.data, 'submitter', again.result('VERIFIED') as never, ['PUBLISHING'])
    expect(promotions()).toEqual([])
  })

  it('a row that is not a draft any more (or nothing accepted) is never touched', async () => {
    const { data, result } = etsyPublishing()
    m.snapshots.mockResolvedValue([{ channelListingId: 'listing-live', payload: { channelConnectionId: 'etsy-a', sku: 'FAKE-SKU-1', requests: [] } }])
    listings([owner], [])
    await storeResult('pub-etsy', data, 'submitter', result('VERIFIED') as never, ['PUBLISHING'])
    expect(promotions()).toEqual([])
    expect(m.held).not.toHaveBeenCalled()
  })

  it('§10.5: a variation created Inactive is held with the Etsy variation reason; its shown sibling is not, and only the sibling\'s prices go', async () => {
    const { data, result } = etsyPublishing({ inactiveProductIds: ['child-hidden'] })
    m.snapshots.mockResolvedValue([
      { channelListingId: 'listing-new', payload: { channelConnectionId: 'etsy-a', sku: 'FAKE-SKU-3', requests: [] } },
      { channelListingId: 'listing-hidden', payload: { channelConnectionId: 'etsy-a', sku: 'FAKE-SKU-4', requests: [] } },
    ])
    listings([{ ...owner, listingStatus: 'ACTIVE', syncPaused: false }], [{ id: 'listing-new', productId: 'child-new' }, { id: 'listing-hidden', productId: 'child-hidden' }])
    await storeResult('pub-etsy', data, 'operator', result('VERIFIED') as never, ['PUBLISHING'])
    const writes = promotions()
    expect(writes).toHaveLength(2)
    const shown = writes.find((w: any) => w.where.id === 'listing-new')
    const hidden = writes.find((w: any) => w.where.id === 'listing-hidden')
    expect(shown.data).not.toHaveProperty('offerClosedAt')
    expect(hidden.data).toEqual({ externalListingId: LISTING, isPublished: true, listingStatus: 'ACTIVE', syncPaused: false, liveChannelSku: 'FAKE-SKU-4',
      lastSyncedAt: expect.any(Date), lastSyncStatus: 'SUCCESS', version: { increment: 1 },
      offerClosedAt: expect.any(Date), offerClosedBy: 'operator', offerCloseReason: 'etsy-variation-hidden', offerActive: false,
      offerCloseSnapshot: { channel: 'ETSY', source: 'publish', createdInactive: true, publicationId: 'pub-etsy', etsyListingId: LISTING } })
    // Never Amazon's closed-offer fields.
    expect(JSON.stringify(hidden.data.offerCloseSnapshot)).not.toMatch(/purchasableOffer|productType/)
    expect(m.held).toHaveBeenCalledTimes(1)
    expect(m.held).toHaveBeenCalledWith({ listingIds: ['listing-new'], actor: 'operator', cause: 'publish' })
  })

  it('AMAZON and EBAY results never reach the Etsy step', async () => {
    m.snapshots.mockResolvedValue([{ channelListingId: 'listing-x', payload: { channelConnectionId: 'acct-a', sku: 'SELLER-PARENT', requests: [] } }])
    amazonSubmitted()
    await storeResult('pub-amazon', m.rows.get('pub-amazon').changes, 'submitter', { id: 'pub-amazon', status: 'ACCEPTED', message: 'ok',
      results: [{ sku: 'SELLER-PARENT', status: 'ACCEPTED', message: 'ok', reference: 'feed-1' }] } as never, ['SUBMITTED'])
    const ebayInventory = { id: 'pub-ebay-inv', userId: 'submitter', kind: 'studio-publication', status: 'PUBLISHING', productId: 'family', channel: 'EBAY', marketplace: 'IT',
      channelConnectionId: 'ebay-a', aliasKey: '', batchId: null, checkCount: null, submittedAt: T0, nextCheckAt: null, createdAt: T0, summary: null, changes: {} }
    m.rows.set(ebayInventory.id, ebayInventory)
    await storeResult('pub-ebay-inv', { kind: 'studio-publication', productId: 'family', captureVersion: 1, inventory: true, scope: { channel: 'EBAY', marketplace: 'IT', accountId: 'ebay-a' },
      delivery: { productIds: ['family'], aliasKey: '' } }, 'submitter', { id: 'pub-ebay-inv', status: 'VERIFIED', message: 'ok',
      results: [{ sku: 'SKU', status: 'VERIFIED', message: 'ok', reference: 'offer-1' }] } as never, ['PUBLISHING'])
    expect(m.findListings.mock.calls.some(([args]: any) => args?.where?.externalListingId && typeof args.where.externalListingId === 'object' && 'not' in args.where.externalListingId)).toBe(false)
    expect(m.updateListings.mock.calls.some(([args]: any) => args?.data?.lastSyncStatus === 'SUCCESS')).toBe(false)
  })
})

describe('E3 — a verified create of a new Etsy listing (settleEtsyCreate)', () => {
  const LISTING = '9000000001'
  const destination = { channel: 'ETSY', marketplace: 'GLOBAL', channelConnectionId: 'etsy-a', aliasKey: '' }
  /** A family created as one Etsy draft: the main row (the listing) and two variations (the inventory products). */
  function etsyCreate(extra: Record<string, any> = {}) {
    const row = { id: 'pub-etsy-create', userId: 'submitter', kind: 'studio-publication', status: 'PUBLISHING', productId: 'family', channel: 'ETSY', marketplace: 'GLOBAL',
      channelConnectionId: 'etsy-a', aliasKey: '', batchId: null, checkCount: null, submittedAt: T0, nextCheckAt: null, createdAt: T0, summary: null, changes: {} }
    m.rows.set(row.id, row)
    const data = { kind: 'studio-publication', productId: 'family', captureVersion: 1, startedAt: T0.toISOString(), etsyCreate: true,
      scope: { channel: 'ETSY', marketplace: 'GLOBAL', accountId: 'etsy-a' }, delivery: { productIds: ['family', 'child-1', 'child-2'], aliasKey: '' },
      changePlan: { publication: { ownerProductId: 'family', inventoryProducts: [{ productId: 'child-1', sku: 'FAKE-SKU-1' }, { productId: 'child-2', sku: 'FAKE-SKU-2' }] } },
      ...extra }
    const result = (status: string, reference: string | null = LISTING) => ({ id: row.id, status, message: status,
      results: ['FAKE-SKU-PARENT', 'FAKE-SKU-1', 'FAKE-SKU-2'].map(sku => ({ sku, status: status === 'VERIFIED' ? 'VERIFIED' : 'SUBMITTED', message: status,
        ...(reference ? { reference } : {}) })) })
    return { data, result }
  }
  const journal = (listingId: string, productId: string, sku: string) => ({ channelListingId: listingId, payload: { channelConnectionId: 'etsy-a', productId, sku, requests: [] } })
  const journals = () => [journal('listing-family', 'family', 'FAKE-SKU-PARENT'), journal('listing-1', 'child-1', 'FAKE-SKU-1'), journal('listing-2', 'child-2', 'FAKE-SKU-2')]
  /** The writes of this step: the SKU confirmations and the sync record, both on rows already on the created listing. */
  const createWrites = () => m.updateListings.mock.calls.map(([args]) => args).filter((args: any) => args.where?.externalListingId === LISTING)

  it('VERIFIED: the inventory rows record their journal SKU as the SKU Etsy holds; every delivered row on the listing records SUCCESS; no held price', async () => {
    const { data, result } = etsyCreate()
    m.snapshots.mockResolvedValue(journals())
    // promoteEtsyVariations finds no still-draft row: the 201's write already gave every family row the listing id.
    m.findListings.mockResolvedValue([])
    m.updateListings.mockResolvedValue({ count: 1 })
    await storeResult('pub-etsy-create', data, 'submitter', result('VERIFIED') as never, ['PUBLISHING'])
    await flush()
    expect(m.rows.get('pub-etsy-create').status).toBe('VERIFIED')
    const writes = createWrites()
    expect(writes).toEqual([
      { where: { id: 'listing-1', ...destination, externalListingId: LISTING }, data: { liveChannelSku: 'FAKE-SKU-1' } },
      { where: { id: 'listing-2', ...destination, externalListingId: LISTING }, data: { liveChannelSku: 'FAKE-SKU-2' } },
      { where: { ...destination, productId: { in: ['family', 'child-1', 'child-2'] }, externalListingId: LISTING },
        data: { lastSyncedAt: expect.any(Date), lastSyncStatus: 'SUCCESS', version: { increment: 1 } } },
    ])
    // The main row (the listing, not a variation) records no SKU.
    expect(writes.some((w: any) => w.where.id === 'listing-family')).toBe(false)
    // Only this destination's accepted journals were read.
    expect(m.snapshots).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ publishEventId: 'pub-etsy-create', outcome: 'ACCEPTED',
      channel: 'ETSY', marketplace: 'GLOBAL', aliasKey: '', payload: { path: ['channelConnectionId'], equals: 'etsy-a' } }) }))
    expect(m.held).not.toHaveBeenCalled()
    expect(m.fill).not.toHaveBeenCalled()
  })

  it('a single product (no variations) is its own inventory product: its row records its SKU', async () => {
    const { data, result } = etsyCreate({ delivery: { productIds: ['single'], aliasKey: '' },
      changePlan: { publication: { ownerProductId: 'single', inventoryProducts: [{ productId: 'single', sku: 'FAKE-SKU-1' }] } } })
    m.snapshots.mockResolvedValue([journal('listing-single', 'single', 'FAKE-SKU-1')])
    m.updateListings.mockResolvedValue({ count: 1 })
    await storeResult('pub-etsy-create', data, 'submitter', result('VERIFIED') as never, ['PUBLISHING'])
    expect(createWrites()).toEqual([
      { where: { id: 'listing-single', ...destination, externalListingId: LISTING }, data: { liveChannelSku: 'FAKE-SKU-1' } },
      { where: { ...destination, productId: { in: ['single'] }, externalListingId: LISTING }, data: { lastSyncedAt: expect.any(Date), lastSyncStatus: 'SUCCESS', version: { increment: 1 } } },
    ])
  })

  it('UNVERIFIED (Etsy made the draft, but not every part is confirmed, or its answer was lost): nothing is written here', async () => {
    const { data, result } = etsyCreate()
    m.snapshots.mockResolvedValue(journals())
    await storeResult('pub-etsy-create', data, 'submitter', result('UNVERIFIED') as never, ['PUBLISHING'])
    expect(m.rows.get('pub-etsy-create').status).toBe('UNVERIFIED')
    expect(createWrites()).toEqual([])
    m.rows.clear()
    const lost = etsyCreate()
    await storeResult('pub-etsy-create', lost.data, 'submitter', lost.result('UNVERIFIED', null) as never, ['PUBLISHING'])
    expect(createWrites()).toEqual([])
    expect(m.updateListings.mock.calls.some(([args]: any) => args?.data?.lastSyncStatus === 'SUCCESS')).toBe(false)
  })

  it('an E2 update (no etsyCreate), or a VERIFIED create whose results name no listing id, writes nothing here', async () => {
    const { data, result } = etsyCreate({ etsyCreate: undefined })
    m.snapshots.mockResolvedValue(journals())
    m.updateListings.mockResolvedValue({ count: 1 })
    await storeResult('pub-etsy-create', data, 'submitter', result('VERIFIED') as never, ['PUBLISHING'])
    expect(createWrites()).toEqual([])
    m.rows.clear()
    const nameless = etsyCreate()
    await storeResult('pub-etsy-create', nameless.data, 'submitter', nameless.result('VERIFIED', null) as never, ['PUBLISHING'])
    expect(m.updateListings.mock.calls.some(([args]: any) => args?.data?.lastSyncStatus === 'SUCCESS' || args?.data?.liveChannelSku)).toBe(false)
  })

  it('promoteEtsyVariations copies the owner row\'s isPublished: a variation joining an Etsy DRAFT stays unpublished, DRAFT and paused like its draft', async () => {
    const row = { id: 'pub-etsy', userId: 'submitter', kind: 'studio-publication', status: 'PUBLISHING', productId: 'family', channel: 'ETSY', marketplace: 'GLOBAL',
      channelConnectionId: 'etsy-a', aliasKey: '', batchId: null, checkCount: null, submittedAt: T0, nextCheckAt: null, createdAt: T0, summary: null, changes: {} }
    m.rows.set(row.id, row)
    const data = { kind: 'studio-publication', productId: 'family', captureVersion: 1, scope: { channel: 'ETSY', marketplace: 'GLOBAL', accountId: 'etsy-a' },
      delivery: { productIds: ['family', 'child-new'], aliasKey: '' } }
    m.snapshots.mockResolvedValue([{ channelListingId: 'listing-new', payload: { channelConnectionId: 'etsy-a', sku: 'FAKE-SKU-3', requests: [] } }])
    const draftOwner = { productId: 'family', externalListingId: LISTING, listingStatus: 'DRAFT', isPublished: false, syncPaused: true, offerClosedAt: null, offerCloseReason: null }
    m.findListings.mockImplementation(async ({ where }: any) => where.externalListingId === null ? [{ id: 'listing-new', productId: 'child-new' }] : [draftOwner])
    m.updateListings.mockResolvedValue({ count: 1 })
    await storeResult('pub-etsy', data, 'submitter', { id: 'pub-etsy', status: 'VERIFIED', message: 'ok',
      results: [{ sku: 'FAKE-SKU-3', status: 'VERIFIED', message: 'Read back from Etsy', reference: LISTING }] } as never, ['PUBLISHING'])
    const promoted = m.updateListings.mock.calls.map(([args]) => args).find((args: any) => args.data?.externalListingId === LISTING)
    expect(promoted.data).toMatchObject({ externalListingId: LISTING, isPublished: false, listingStatus: 'DRAFT', syncPaused: true, liveChannelSku: 'FAKE-SKU-3' })
    expect(m.findListings).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ isPublished: true }) }))
    // Its held prices go to the price door, which keeps them held while the row is paused (holdsCascadedPrice).
    expect(m.held).toHaveBeenCalledWith({ listingIds: ['listing-new'], actor: 'submitter', cause: 'publish' })
  })
})
