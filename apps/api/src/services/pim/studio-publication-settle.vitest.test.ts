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
    channelListing: { findMany: m.findListings, updateMany: m.updateListings, count: m.countListings },
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

import { nextPublicationCheck, settleStudioPublication, AMAZON_CHECK_WINDOW_MS } from './studio-publication-settle.js'
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
