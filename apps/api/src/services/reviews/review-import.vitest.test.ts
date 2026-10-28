/**
 * Reviews Inbox — file import: a buyer's e-mail and IP address are never imported, `.tsv` is read, every import is one
 * batch (`batchId`), rows that cannot import say why in words, and "Undo this import" keeps the rows a person already
 * worked on. The database and the ingest pipeline are mocked: nothing is written.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  existingIds: [] as string[],
  knownSkus: [] as string[],
}))
vi.mock('../../db.js', () => ({
  default: {
    review: {
      findMany: vi.fn(async () => db.existingIds.map((externalReviewId) => ({ externalReviewId }))),
    },
    product: {
      findMany: vi.fn(async (args: { where: { sku?: { in: string[] } } }) =>
        args.where.sku ? db.knownSkus.filter((s) => args.where.sku!.in.includes(s)).map((sku) => ({ sku })) : []),
    },
  },
}))
const ingest = vi.hoisted(() => ({ calls: [] as { raws: Array<Record<string, unknown>>; opts: Record<string, unknown> }[] }))
vi.mock('./review-ingest.service.js', () => ({
  ingestRawReviews: vi.fn(async (raws: Array<Record<string, unknown>>, opts: Record<string, unknown>) => {
    ingest.calls.push({ raws, opts })
    return {
      mode: 'sandbox', marketplaces: [], reviewsSeen: raws.length, reviewsInserted: raws.length, reviewsSkippedExisting: 0,
      sentimentExtracted: raws.length, sentimentSkipped: 0, errors: [], notes: [],
    }
  }),
  removeFromCategoryRates: vi.fn(async () => {}),
}))

import {
  applyReviewImport,
  autodetectMapping,
  importChannel,
  isPrivateColumn,
  parseRating,
  parseReviewDate,
  planImportUndo,
  previewReviewImport,
  UNKNOWN_PRODUCT_WARNING,
  type UndoCandidate,
} from './review-import.service.js'

const TSV = [
  ['review_id', 'rating', 'title', 'body', 'reviewer_name', 'reviewer_email', 'ip_address', 'date', 'sku'].join('\t'),
  ['r1', '5', 'Great', 'Fits well', 'Reviewer A', 'reviewer-a@example.com', '203.0.113.7', '2026-10-20', 'SKU-KNOWN'].join('\t'),
  ['r2', '2', '', 'Runs small', 'reviewer-b@example.com', 'reviewer-b@example.com', '203.0.113.8', '21/10/2026', 'SKU-NEW'].join('\t'),
  ['r3', '4,5', '', 'Ok', 'Reviewer C', '', '', '2026-10-22', ''].join('\t'),
  ['r4', '3', '', '', 'Reviewer D', '', '', '2026-10-22', ''].join('\t'),
  ['r5', '', '', 'Fine', 'Reviewer E', '', '', '31/09/2026', ''].join('\t'),
].join('\n')

beforeEach(() => {
  db.existingIds = []
  db.knownSkus = ['SKU-KNOWN']
  ingest.calls = []
})

describe('e-mail and IP addresses are never imported', () => {
  it('those columns are named as dropped, left out of the columns and the mapping — even when mapped by hand', async () => {
    const preview = await previewReviewImport({
      text: TSV, fileKind: 'tsv', source: 'shopify_app',
      columnMapping: { authorName: 'reviewer_email' },
    })
    expect(preview.droppedColumns).toEqual(['reviewer_email', 'ip_address'])
    expect(preview.headers).not.toContain('reviewer_email')
    expect(preview.headers).not.toContain('ip_address')
    expect(Object.values(preview.appliedMapping)).not.toContain('reviewer_email')
    expect(preview.appliedMapping.authorName).toBe('reviewer_name')
  })

  it('the stored row has no e-mail or IP, and a reviewer name that is an e-mail address is dropped', async () => {
    await applyReviewImport({ text: TSV, fileKind: 'tsv', source: 'shopify_app' })
    const raws = ingest.calls[0].raws
    const stored = JSON.stringify(raws)
    expect(stored).not.toContain('@example.com')
    expect(stored).not.toContain('203.0.113')
    const r2 = raws.find((r) => r.externalReviewId === 'r2')!
    expect(r2.authorName).toBeUndefined()
    expect((r2.rawPayload as { importedRow: Record<string, unknown> }).importedRow).not.toHaveProperty('reviewer_email')
  })

  it('which headers count as private', () => {
    for (const h of ['Email', 'reviewer_email', 'E-Mail Address', 'IP', 'ip_address', 'Remote IP', 'customer_ip']) expect(isPrivateColumn(h)).toBe(true)
    for (const h of ['body', 'review_id', 'ship', 'zip', 'description', 'sku']) expect(isPrivateColumn(h)).toBe(false)
  })
})

describe('.tsv, source and the reasons a row cannot import', () => {
  it('tab-separated rows are read; the source sets the channel', async () => {
    const preview = await previewReviewImport({ text: TSV, fileKind: 'tsv', source: 'etsy' })
    expect(preview.totalRows).toBe(5)
    expect(preview.channel).toBe('ETSY')
    expect(preview.source).toBe('etsy')
    expect(importChannel('amazon', 'EBAY')).toBe('AMAZON')
    expect(importChannel('other', 'ebay')).toBe('EBAY')
    expect(importChannel(undefined, undefined)).toBe('AMAZON')
  })

  it('cannot import: words and the line in the file (header = line 1)', async () => {
    const preview = await previewReviewImport({ text: TSV, fileKind: 'tsv', source: 'other', channel: 'SHOPIFY' })
    expect(preview.rejected).toEqual([
      { line: 4, reasons: ['Stars is “4,5”: use a whole number from 1 to 5'] },
      { line: 5, reasons: ['No review text'] },
      { line: 6, reasons: ['Stars is empty', 'Date “31/09/2026” does not exist'] },
    ])
    expect(preview.validRows).toBe(2)
  })

  it('a SKU the catalog does not know imports without a product link, unless the person leaves those out', async () => {
    const preview = await previewReviewImport({ text: TSV, fileKind: 'tsv', source: 'shopify_app' })
    expect(preview.unknownProductRows).toBe(1)
    expect(preview.unknownProductExamples).toEqual(['SKU-NEW'])
    expect(preview.sample.find((s) => s.body === 'Runs small')?.warnings).toContain(UNKNOWN_PRODUCT_WARNING)
    // The Match step shows the SKU it read, as it shows the text fields.
    expect(preview.sample.find((s) => s.body === 'Runs small')?.sku).toBe('SKU-NEW')
    expect(preview.willInsert).toBe(2)
    const without = await applyReviewImport({ text: TSV, fileKind: 'tsv', source: 'shopify_app', includeUnlinked: false })
    expect(without.skippedUnlinked).toBe(1)
    expect(ingest.calls[0].raws.map((r) => r.externalReviewId)).toEqual(['r1'])
  })

  it('a review already in Nexus is skipped', async () => {
    db.existingIds = ['r1']
    const preview = await previewReviewImport({ text: TSV, fileKind: 'tsv', source: 'shopify_app' })
    expect(preview.duplicateExisting).toBe(1)
    expect(preview.willInsert).toBe(1)
  })

  it('stars and dates', () => {
    expect(parseRating('5.0 out of 5 stars')).toBe(5)
    expect(parseRating('Positive')).toBe(5)
    expect(parseRating('negative')).toBe(1)
    expect(parseRating('4,5')).toBeNull()
    expect(parseRating('6')).toBeNull()
    expect(parseRating(' ')).toBeUndefined()
    expect(parseReviewDate('21/10/2026')?.toISOString()).toBe('2026-10-21T00:00:00.000Z')
    expect(parseReviewDate('21.10.2026 14:30')?.toISOString()).toBe('2026-10-21T14:30:00.000Z')
    expect(parseReviewDate('31/09/2026')).toBeNull()
    expect(parseReviewDate('2026-02-30')).toBeNull()
    expect(parseReviewDate('2026-10-20T08:00:00Z')?.toISOString()).toBe('2026-10-20T08:00:00.000Z')
  })
})

describe('the Shopify review apps’ own exports', () => {
  it('Yotpo, Okendo and Loox columns match on their own (as their docs list them); their e-mail columns never import', async () => {
    // Yotpo's export columns, in its documented order (the first ones).
    const yotpo = ['app_key', 'Review ID', 'Review Creation Date', 'Review Type', 'Review Status', 'Status Details', 'Review Source', 'Review Score', 'Review Title', 'Review Content', 'Sentiment Score', 'Profanity Flag', 'Published Image URL', 'Unpublished Image URL', 'Published Video URL', 'Unpublished Video URL', 'Comment Date', 'Comment Content', 'Comment Public', 'Review Tags', 'Thumbs Up', 'Thumbs Down', 'Order ID', 'Order Date', 'Pushed to Social', 'Reviewer Display Name', 'Reviewer Email', 'Reviewer Type', 'Reviewer Country', 'Product ID', 'Product Title', 'Product SKU']
    expect(autodetectMapping(yotpo)).toMatchObject({ externalReviewId: 'Review ID', postedAt: 'Review Creation Date', rating: 'Review Score', title: 'Review Title', body: 'Review Content', helpfulVotes: 'Thumbs Up', authorName: 'Reviewer Display Name', sku: 'Product SKU' })
    const okendo = ['hash', 'body', 'countryCode', 'dateCreated', 'email', 'handle', 'imageCount', 'imageUrls', 'isApproved', 'isRecommended', 'isVerifiedBuyer', 'name', 'productId', 'productName', 'rating', 'rejectedImageUrls', 'reply', 'replyDateCreated', 'replyIsPublic', 'sentiment', 'sku', 'source', 'status', 'syndicated', 'title', 'variantId', 'videoCount', 'videoUrls', 'tags', 'upvotes', 'downvotes']
    expect(autodetectMapping(okendo)).toMatchObject({ body: 'body', postedAt: 'dateCreated', verifiedPurchase: 'isVerifiedBuyer', authorName: 'name', rating: 'rating', sku: 'sku', title: 'title', helpfulVotes: 'upvotes' })
    const looxCsv = ['product_handle,product_Id,rating,author,email,body,created_at,photo_url,reply,replied_at,verified_purchase', 'gloves,7891234567890,5,John D.,john@example.com,"Great, warm",2026-10-20,,,,true'].join('\n')
    const preview = await previewReviewImport({ text: looxCsv, fileKind: 'csv', source: 'shopify_app' })
    expect(preview).toMatchObject({ channel: 'SHOPIFY', validRows: 1, droppedColumns: ['email'], appliedMapping: { rating: 'rating', authorName: 'author', body: 'body', postedAt: 'created_at', verifiedPurchase: 'verified_purchase' } })
    expect(preview.sample[0]).toMatchObject({ body: 'Great, warm', rating: 5, authorName: 'John D.', verifiedPurchase: true })
    expect(JSON.stringify(preview)).not.toContain('john@example.com')
  })
})

describe('one import = one batch', () => {
  it('apply returns a batchId and every new row is stored under it', async () => {
    const result = await applyReviewImport({ text: TSV, fileKind: 'tsv', source: 'amazon', marketplace: 'de' })
    expect(result.batchId).toMatch(/^import_[0-9a-f-]{36}$/)
    expect(result.imported).toBe(2)
    expect(ingest.calls).toHaveLength(1)
    expect(ingest.calls[0].opts).toMatchObject({ ingestSource: 'IMPORT_CSV', importBatchId: result.batchId })
    expect(ingest.calls[0].raws.every((r) => r.channel === 'AMAZON' && r.marketplace === 'DE')).toBe(true)
    const again = await applyReviewImport({ text: TSV, fileKind: 'tsv', source: 'amazon' })
    expect(again.batchId).not.toBe(result.batchId)
  })
})

describe('Undo this import keeps the rows a person worked on', () => {
  const row = (id: string, over: Partial<UndoCandidate> = {}): UndoCandidate => ({
    id, triageStatus: null, assignee: null, triageTags: [], triageNote: null, triageUpdatedAt: null, sentimentEditedAt: null,
    replyStatuses: [], ...over,
  })
  it('untouched rows go; replied, drafted, triaged or re-labelled rows stay, each with its reason', () => {
    const plan = planImportUndo([
      row('untouched'),
      row('failed-reply', { replyStatuses: ['FAILED'] }),
      row('replied', { replyStatuses: ['DRAFT', 'SENT'] }),
      row('drafted', { replyStatuses: ['DRAFT'] }),
      row('resolved', { triageStatus: 'RESOLVED', triageUpdatedAt: new Date() }),
      row('tagged', { triageTags: ['size chart'] }),
      row('assigned', { assignee: 'owner-a' }),
      row('relabelled', { sentimentEditedAt: new Date() }),
    ])
    expect(plan.remove).toEqual(['untouched', 'failed-reply'])
    expect(plan.kept).toEqual([
      { id: 'replied', reason: 'A reply was sent.' },
      { id: 'drafted', reason: 'A reply draft is saved.' },
      { id: 'resolved', reason: 'Its status, owner, tags or note were changed.' },
      { id: 'tagged', reason: 'Its status, owner, tags or note were changed.' },
      { id: 'assigned', reason: 'Its status, owner, tags or note were changed.' },
      { id: 'relabelled', reason: 'Its mood or themes were changed by a person.' },
    ])
  })
})
