import { describe, expect, it } from 'vitest'
import type { StudioPublishChange, StudioPublishReview } from '@nexus/shared/studio-publication'

import { amazonCheck, amazonOutcome, amazonSendNote, destinationsToCheck, ebayCheck, ebayOutcome, unsupportedReason, type AmazonRunLike } from './publishModel'

const change = (field: string, status: StudioPublishChange['status'], selectable = true, reason = ''): StudioPublishChange => ({
  id: JSON.stringify(['parent', field]), productId: 'parent', sku: 'GALE', field, label: field, current: { state: 'value', value: 'ours' },
  lastAccepted: { state: 'unknown', reason: 'No record' }, channel: { state: 'value', value: 'theirs' }, status, localChanged: null, channelChanged: null,
  selectable, selectedByDefault: false, reason, operation: 'replace' } as StudioPublishChange)
const review = (extra: Partial<StudioPublishReview>): StudioPublishReview => ({ id: 'review-1', productId: 'parent', scope: { channel: 'EBAY', marketplace: 'IT', accountId: 'acc' },
  accountLabel: 'xavia', aliasLabel: 'IT-GALE', mode: 'live', action: 'update', rows: [], excluded: 0, issues: [], expiresAt: '2026-09-28T10:00:00Z', ...extra })

describe('Review & publish photos', () => {
  it('eBay: selects only the photo rows that differ — the gallery here; never a title, and the same colour sets are left alone', () => {
    const check = ebayCheck(review({ changes: [change('title', 'DIFFERS'), change('pictures', 'DIFFERS'), change('Pictures', 'SAME')] }))
    expect(check).toMatchObject({ kind: 'ready', summary: 'Gallery: will be replaced · Colour sets: same on eBay', send: { reviewId: 'review-1', selectedIds: [JSON.stringify(['parent', 'pictures'])] } })
  })
  it('eBay: a photos-only review says why; all-same means nothing to send; a refused photo row blocks with its reason', () => {
    expect(ebayCheck(review({ photosOnly: true, changes: [change('pictures', 'DIFFERS')] }))).toMatchObject({ kind: 'ready', note: expect.stringContaining('only photos') })
    expect(ebayCheck(review({ changes: [change('pictures', 'SAME'), change('Pictures', 'SAME')] }))).toMatchObject({ kind: 'same' })
    expect(ebayCheck(review({ changes: [change('Pictures', 'DIFFERS', false, 'eBay allows 12 pictures per value.')] }))).toEqual({ kind: 'blocked', reason: 'eBay allows 12 pictures per value.' })
    expect(ebayCheck(review({ id: null, issues: [{ severity: 'error', message: 'Reconnect this account before publishing.' }] }))).toEqual({ kind: 'blocked', reason: 'Reconnect this account before publishing.' })
  })
  it('eBay: an unsaved review shows the error that names no field first — only that kind blocks a photos-only send', () => {
    const issues = [{ severity: 'error' as const, field: 'category', message: "Category: Field 'Category' is required." },
      { severity: 'error' as const, message: 'This listing alias uses the eBay Inventory API. … Nothing was sent.' }]
    expect(ebayCheck(review({ id: null, issues }))).toEqual({ kind: 'blocked', reason: 'This listing alias uses the eBay Inventory API. … Nothing was sent.' })
    expect(ebayCheck(review({ id: null, issues: issues.slice(0, 1) }))).toEqual({ kind: 'blocked', reason: "Category: Field 'Category' is required." })
  })
  it('opened from a channel view it checks that destination only; from the toolbar, every destination', () => {
    const all = [{ key: 'amazon' }, { key: 'ebay-main' }, { key: 'ebay-alias' }]
    expect(destinationsToCheck(all, 'ebay-alias')).toEqual([{ key: 'ebay-alias' }])
    expect(destinationsToCheck(all, null)).toEqual(all)
    // An eBay account and market with aliases: every listing the page shows, in the destinations' order.
    expect(destinationsToCheck(all, ['ebay-alias', 'ebay-main'])).toEqual([{ key: 'ebay-main' }, { key: 'ebay-alias' }])
    expect(destinationsToCheck(all, [])).toEqual(all)
  })
  it('Amazon: counts the SKUs and slots that change, blocks on any item problem, and reads the receipts', () => {
    const run: AmazonRunLike = { id: 'run-1', status: 'REVIEW', revision: 'r1', receipts: [],
      items: [{ sku: 'A', changes: [{ slot: 'MAIN' }, { slot: 'PT01' }], issues: [] }, { sku: 'B', changes: [], issues: [] }] }
    expect(amazonCheck(run, '/p')).toMatchObject({ kind: 'ready', summary: '1 SKU · 2 photo slots change', send: { channel: 'AMAZON', runId: 'run-1', revision: 'r1' } })
    expect(amazonCheck({ ...run, items: [{ sku: 'A', changes: [], issues: ['Image is not reachable'] }] }, '/p')).toEqual({ kind: 'blocked', reason: 'A: Image is not reachable' })
    expect(amazonCheck({ ...run, status: 'REVIEWING' }, '/p')).toEqual({ kind: 'checking' })
    expect(amazonOutcome({ ...run, status: 'COMPLETE', receipts: [{ listingId: 'a', status: 'ACCEPTED' }, { listingId: 'b', status: 'UNCHANGED' }] }))
      .toEqual({ tone: 'success', text: 'Sent — Amazon accepted 1 SKU (1 unchanged).', final: true })
  })
  it('this window never sends to Shopify (whole product) or Etsy, nor to a paused account', () => {
    expect(unsupportedReason({ channel: 'SHOPIFY', targetable: true, refusal: null, accountActive: true })).toMatch(/whole product/)
    expect(unsupportedReason({ channel: 'EBAY', targetable: true, refusal: null, accountActive: false })).toMatch(/paused/)
    expect(unsupportedReason({ channel: 'EBAY', targetable: true, refusal: null, accountActive: true })).toBeNull()
    expect(ebayOutcome({ id: 'x', status: 'FAILED', message: 'Failed', results: [{ sku: 'GALE', status: 'FAILED', message: 'eBay: invalid picture URL' }] }))
      .toEqual({ tone: 'danger', text: 'eBay: invalid picture URL', final: true })
  })
})

describe('Amazon: Publish photos sends All Amazon markets (2026-09-29, option 3)', () => {
  it('says what is sent, and names a market whose own photos go only by its ZIP', () => {
    expect(amazonSendNote(['IT', 'DE'], [])).toBe('Sends the All Amazon markets photos. Amazon keeps one photo set per ASIN for IT, DE.')
    expect(amazonSendNote(['IT', 'DE'], ['DE'])).toBe('Sends the All Amazon markets photos. Amazon keeps one photo set per ASIN for IT, DE. Amazon DE has own photos. '
      + 'They are not sent here: they reach Amazon only through its ZIP (Seller Central → Image Manager → Country-Specific Upload).')
    expect(amazonSendNote(['IT', 'DE', 'FR'], ['DE', 'FR'])).toMatch(/Amazon DE, Amazon FR have own photos\. .* through each market’s ZIP/)
  })
})
