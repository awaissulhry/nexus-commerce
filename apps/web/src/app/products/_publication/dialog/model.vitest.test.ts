import { expect, it } from 'vitest'
import { MAIN_LISTING_LABEL, leftOutCount, listingDisplayLabel, problemCount, problemCountWords, problemGroups, publicationDestinations, matchesPublicationReview, retainPublicationReceipt, publicationOverwriteAcknowledged, matchesPublicationSelection, publicationProblems, optionListingLabel, publicationScopeKey } from './model'
import type { StudioPublishResult, StudioPublishReview } from '@nexus/shared/studio-publication'

const market = { id: 'a', channel: 'AMAZON', code: 'IT', name: 'Amazon Italy', language: 'it', accounts: [{ id: 'one', label: 'One', primary: true }, { id: 'two', label: 'Two', primary: false }] }
it('binds a selection response to the exact current review, eligible fields and product set', () => {
  const review = { id: 'review-a', rows: [{ productId: 'p' }, { productId: 'other' }], changes: [{ id: 'title', selectable: true, productId: 'p', sku: 'SELLER-SKU' }, { id: 'brand', selectable: true, productId: 'p', sku: 'SELLER-SKU' }, { id: 'same', selectable: false }] } as StudioPublishReview
  const response = { reviewId: 'review-a', token: 'choice-1', selectedIds: ['title', 'brand'], fieldCount: 2,
    products: [{ productId: 'p', sku: 'SELLER-SKU' }], payload: { format: 'json', content: '{"messages":[]}' } }
  expect(matchesPublicationSelection(response, review, ['brand', 'title'])).toBe(true)
  for (const patch of [{ reviewId: 'review-old' }, { token: '' }, { selectedIds: ['title'] }, { selectedIds: ['title', 'title'] }, { fieldCount: 1 }, { products: [{ productId: 'foreign', sku: 'OTHER' }] }, { payload: null }])
    expect(matchesPublicationSelection({ ...response, ...patch }, review, ['title', 'brand'])).toBe(false)
  expect(matchesPublicationSelection(response, { ...review, changes: undefined }, ['title', 'brand'])).toBe(false)
  expect(matchesPublicationSelection({ ...response, selectedIds: ['same'], fieldCount: 1 }, review, ['same'])).toBe(false)
  expect(matchesPublicationSelection(response, review, ['title'])).toBe(false)
  for (const patch of [{ products: [] }, { products: [{ productId: 'other', sku: 'OTHER' }] }, { products: [{ productId: 'p', sku: 'WRONG' }] }, { payload: { format: 'json', content: ' ' } }])
    expect(matchesPublicationSelection({ ...response, ...patch }, review, ['title', 'brand'])).toBe(false)
  expect(matchesPublicationSelection({ ...response, products: [...response.products, { productId: 'other', sku: 'OTHER' }] }, review, ['title', 'brand'])).toBe(true)
})
it('requires overwrite confirmation for the exact current review and refuses missing warning evidence', () => {
  const review: StudioPublishReview = { id: 'review-a', productId: 'p', scope: { channel: 'AMAZON', marketplace: 'IT', accountId: 'one' },
    accountLabel: 'One', aliasLabel: 'Primary', mode: 'live', action: 'update', rows: [{ productId: 'p', sku: 'P', title: 'Product', existing: true }],
    excluded: 0, issues: [], expiresAt: '2026-09-25T12:00:00Z', overwrite: { requiresConfirmation: true, products: [] } }
  expect(publicationOverwriteAcknowledged(review, null)).toBe(false)
  expect(publicationOverwriteAcknowledged(review, 'review-b')).toBe(false)
  expect(publicationOverwriteAcknowledged(review, 'review-a')).toBe(true)
  expect(publicationOverwriteAcknowledged({ ...review, id: 'review-b' }, 'review-a')).toBe(false)
  expect(publicationOverwriteAcknowledged({ ...review, overwrite: undefined }, 'review-a')).toBe(false)
  expect(publicationOverwriteAcknowledged({ ...review, overwrite: undefined, rows: review.rows.map(r => ({ ...r, existing: false })) }, null)).toBe(true)
})
it('keeps a selected listing only in its exact account and marketplace, after its market’s main listing, which it never replaces', () => {
  const current = { channel: 'AMAZON', marketplace: 'IT', accountId: 'two', listingId: 'alias' }
  const options = publicationDestinations([market, { ...market, id: 'de', code: 'DE' }], current)
  expect(options.map(o => [o.scope.accountId, o.scope.marketplace, o.scope.listingId])).toEqual([
    ['one', 'IT', undefined], ['two', 'IT', undefined], ['two', 'IT', 'alias'], ['one', 'DE', undefined], ['two', 'DE', undefined]])
  expect(new Set(options.map(o => o.key)).size).toBe(5)
  expect(options.map(optionListingLabel)).toEqual([null, '★ Main listing', 'Selected listing', null, null])
})
it('offers every alias of a market after its main listing, by position, keyed by the alias id', () => {
  const aliases = [
    { channel: 'AMAZON', marketplace: 'IT', accountId: 'two', id: 'a2', label: 'Racing edition', position: 2 },
    { channel: 'AMAZON', marketplace: 'IT', accountId: 'two', id: 'a1', label: 'Touring edition', position: 1 },
    { channel: 'AMAZON', marketplace: 'IT', accountId: 'gone', id: 'x', label: 'Other account', position: 1 },
  ]
  // The studio's current listing is a known alias: no extra option.
  const options = publicationDestinations([market], { channel: 'AMAZON', marketplace: 'IT', accountId: 'two', listingId: 'a2' }, aliases)
  expect(options.map(o => o.scope.listingId ?? null)).toEqual([null, null, 'a1', 'a2'])
  expect(options.map(o => o.alias ?? null)).toEqual([null, null, { id: 'a1', label: 'Touring edition', position: 1 }, { id: 'a2', label: 'Racing edition', position: 2 }])
  expect(options.map(o => o.listings)).toEqual([1, 3, 3, 3])
  expect(options.map(optionListingLabel)).toEqual([null, '★ Main listing', '① Touring edition', '② Racing edition'])
  // One word for the main listing everywhere (review 2026-10-05, m3): the studio's listing picker says "Main listing" too.
  expect(MAIN_LISTING_LABEL).toBe('Main listing')
  expect(options[2].key).toBe(publicationScopeKey({ channel: 'AMAZON', marketplace: 'IT', accountId: 'two', listingId: 'a1' }))
})
it('excludes disconnected destinations and deduplicates discovery rows', () => {
  expect(publicationDestinations([market, market, { ...market, id: 'de', code: 'DE', connected: false }])).toHaveLength(2)
})
it('rejects stale replies from another product, account, market or listing', () => {
  const scope = { channel: 'AMAZON', marketplace: 'IT', accountId: 'two', listingId: 'alias' }
  const review = { id: 'r', productId: 'p', scope, rows: [], issues: [], expiresAt: '2026-09-13T23:00:00Z' }
  expect(matchesPublicationReview(review, 'p', scope)).toBe(true)
  for (const wrong of [{ ...scope, accountId: 'one' }, { ...scope, marketplace: 'DE' }, { ...scope, listingId: 'different' }]) expect(matchesPublicationReview(review, 'p', wrong)).toBe(false)
  expect(matchesPublicationReview(review, 'other', scope)).toBe(false)
})

it('keeps an acknowledged receipt visible when status has not recorded it yet', () => {
  const receipt: StudioPublishResult = { id: 'publish-1', status: 'UNVERIFIED', message: 'Keep this reference.', warnings: ['Channel warning'],
    results: [{ sku: 'A', status: 'ACCEPTED', reference: '123', message: 'Acknowledged' }] }
  for (const status of ['PUBLISHING', 'UNVERIFIED'] as const) {
    const next: StudioPublishResult = { id: receipt.id, status, message: 'Check again.', results: [] }
    const retained = retainPublicationReceipt(receipt, next)
    expect(retained).toMatchObject({ status, results: receipt.results, warnings: receipt.warnings })
    expect(retained.message).toContain('123')
  }
  const processed: StudioPublishResult = { id: receipt.id, status: 'FAILED', message: 'Rejected', results: [{ sku: 'A', status: 'FAILED', message: 'Invalid field', reference: '123' }] }
  expect(retainPublicationReceipt(receipt, processed)).toBe(processed)
  const different = { ...processed, id: 'publish-2', results: [] }
  expect(retainPublicationReceipt(receipt, different)).toBe(different)
})

// Audit D4 — problems in one table (SKU · what to fix), notes apart; the channel's own words ride along as a detail.
it('lists the review\'s problems as table rows and its warnings as notes', () => {
  const { problems, notes } = publicationProblems([
    { severity: 'error', sku: 'FAM', field: 'videoId', message: 'Video id: Nexus cannot send a video with a new eBay listing yet.' },
    { severity: 'error', sku: 'FAM-L', message: 'FAM-L: Size is empty. Fill it in on this row.' },
    { severity: 'error', field: 'itemPostalCode', message: 'Item location postal code: eBay says this is missing or not valid.', detail: 'Input data for tag <Item.PostalCode> is invalid. (eBay code 37)' },
    { severity: 'warning', message: 'Condition is empty, so Nexus sends New.' },
    { severity: 'warning', sku: 'FAM', message: 'Title: the Italian text is shown on DE.' },
    { severity: 'warning', message: 'Condition is empty, so Nexus sends New.' },
  ])
  expect(problems).toEqual([
    { id: '0', sku: 'FAM', message: 'Video id: Nexus cannot send a video with a new eBay listing yet.' },
    { id: '1', sku: 'FAM-L', message: 'Size is empty. Fill it in on this row.' },
    { id: '2', sku: 'Whole listing', message: 'Item location postal code: eBay says this is missing or not valid.', detail: 'Input data for tag <Item.PostalCode> is invalid. (eBay code 37)' },
  ])
  expect(notes).toEqual(['Condition is empty, so Nexus sends New.', 'FAM: Title: the Italian text is shown on DE.'])
})

// Owner audit 2026-10-19 — one rule for every number: a problem is counted once however many SKUs it is on, "on N SKUs".
it('counts distinct problems and the SKUs they are on, the same way everywhere', () => {
  const issues = [
    { severity: 'error' as const, productId: 'p-m', sku: 'FAM-M', field: 'item_package_dimensions', message: 'FAM-M: Item package height is required.' },
    { severity: 'error' as const, productId: 'p-l', sku: 'FAM-L', field: 'item_package_dimensions', message: 'FAM-L: Item package height is required.' },
    { severity: 'error' as const, sku: 'FAM-L', message: 'FAM-L: Size is empty.' },
    { severity: 'error' as const, message: 'Reconnect this account.' },
    { severity: 'warning' as const, sku: 'FAM-S', message: 'FAM-S: A note.' },
  ]
  expect(problemCount(issues)).toEqual({ problems: 3, skus: 2 })
  expect(problemCountWords(problemCount(issues))).toBe('3 problems on 2 SKUs')
  expect(problemCountWords({ problems: 1, skus: 1 })).toBe('1 problem on 1 SKU')
  expect(problemCountWords({ problems: 1, skus: 0 })).toBe('1 problem')
  // The first product a problem names, and its field: where "Show in sheet" lands.
  expect(problemGroups(issues)[0]).toMatchObject({ skus: ['FAM-M', 'FAM-L'], productId: 'p-m', field: 'item_package_dimensions' })
  expect(problemGroups(issues)[2]).toMatchObject({ skus: [], productId: null, field: null })
})

it('counts the changes a problem leaves out as the table lists them (a field that changes), and the problems behind them', () => {
  const change = (id: string, field: string, status: 'SEND' | 'SAME' = 'SEND') => ({ id, productId: 'p', sku: 'S', field, label: field, status, selectable: true, selectedByDefault: true,
    reason: '', current: { state: 'value' as const, value: 1 }, lastAccepted: { state: 'absent' as const }, channel: { state: 'value' as const, value: 0 },
    localChanged: true, channelChanged: false, operation: 'replace' as const })
  const review = { scope: { channel: 'EBAY', marketplace: 'IT', accountId: 'e' },
    changes: [change('t', 'title'), change('d', 'description'), change('same', 'title', 'SAME')],
    issues: [{ severity: 'error' as const, productId: 'p', sku: 'S', field: 'title', message: 'S: Title is too long.' }] }
  expect(leftOutCount(review)).toEqual({ changes: 1, problems: 1 })
  expect(leftOutCount({ ...review, issues: [] })).toEqual({ changes: 0, problems: 0 })
})

// m3 (review 2026-10-05): one word for the main listing on screen; display only, other names untouched.
it('shows the server\'s older names for the main listing as "Main listing", and every other name as it is', () => {
  expect(['Primary listing', 'Primary', ' Primary ', 'ALT1', 'Primary edition', ''].map(listingDisplayLabel))
    .toEqual([MAIN_LISTING_LABEL, MAIN_LISTING_LABEL, MAIN_LISTING_LABEL, 'ALT1', 'Primary edition', ''])
})
