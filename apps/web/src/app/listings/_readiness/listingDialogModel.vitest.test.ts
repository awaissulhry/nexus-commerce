import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ReadinessChannelListing, ReadinessChannelSection, ReadinessChip, ReadinessDestination, ReadinessLive, ReadinessLiveSummary, ReadinessMemberRow, ReadinessProblem,
} from '@nexus/shared/listing-readiness'
import { canConfirmAction } from '@/design-system/components/ActionConfirm'
import {
  AMAZON_EU_SHARED_MARKETS, amazonNowLine, amazonNowTitle, amazonStatusWords, channelIdLabel, destinationForRow, detailPath, diagnoseConfirm, emptyWords, errorText, followConfirm, followMasterBody,
  historyRows, inBusiness, initialFocus, lastPushOf, listingTotal, listingWords, matrixHref, moneyWords, moreWords, navIds, openDestination,
  openHeldReason, parsePinPrice, pinPriceBody, priceActions, priceWords, PROBLEM_KIND_LABELS, problemKindLabel, problemSentence, productTitle,
  nexusNowLine, publishOutcomeMeta, publishStartKey, pushOutcomeMeta, pushWords, quantityNote, readOutcomeMeta, refreshFailureTone, refreshHeldReason, refusalText,
  requiredByWords, resolveConfirm, salesHref, sentOnlyNote,
  shownTab, stateLine, stateParts, statusSentence, syncActivityHref, syncAttemptRows, syncedWords, tabCount, tabForChip, tabLabel, windowTabs, windowTitle,
} from './listingDialogModel'

const counts = (over: Partial<Record<'blocked' | 'warn' | 'notComputed' | 'absent' | 'ready', number>> = {}) =>
  ({ blocked: 0, warn: 0, notComputed: 0, absent: 0, ready: 0, ...over })
const problem = (over: Partial<ReadinessProblem> = {}): ReadinessProblem =>
  ({ field: 'size_chart', label: 'Size chart', kind: 'required', message: 'Add a size chart.', requiredBy: [], languages: ['it'], products: [], productCount: 0, href: null, ...over })

describe('the Readiness tab words (the Fix window’s, kept)', () => {
  it('names each kind of problem in plain words', () => {
    expect(PROBLEM_KIND_LABELS).toEqual({ required: 'Required', translation: 'Translation', setup: 'Setup', rule: 'Rule', check: 'Check' })
    expect(problemKindLabel('translation')).toBe('Translation')
    // A kind the page does not know is shown as it came, not as one of ours.
    expect(problemKindLabel('novel' as never)).toBe('novel')
  })
  it('counts listings, singular for one', () => {
    expect(listingWords(1)).toBe('1 product')
    expect(listingWords(20)).toBe('20 products')
    expect(listingWords(1240)).toBe('1,240 products')
  })
  it('says how many listings were left out of the list, and nothing when none were', () => {
    expect(moreWords(50, 80)).toBe('and 30 more')
    expect(moreWords(50, 1050)).toBe('and 1,000 more')
    expect(moreWords(3, 3)).toBeNull()
  })
  it('names who requires the field, or nothing', () => {
    expect(requiredByWords(['Amazon category JACKET', 'eBay item specifics'])).toBe('Required by Amazon category JACKET, eBay item specifics')
    expect(requiredByWords([])).toBeNull()
    expect(requiredByWords(['  '])).toBeNull()
  })
  it('lists listings by state worst first, only the states that have any, in the DS readiness words', () => {
    expect(stateParts(counts({ ready: 17, blocked: 3 })).map((part) => part.text)).toEqual(['3 blocked', '17 ready'])
    expect(stateParts(counts({ warn: 2, absent: 1, notComputed: 4 })).map((part) => [part.text, part.tone])).toEqual([
      ['2 warnings', 'warning'], ['4 not computed', 'neutral'], ['1 not set up', 'neutral'],
    ])
    expect(stateParts(counts())).toEqual([])
    expect(listingTotal(counts({ ready: 17, blocked: 3, absent: 1 }))).toBe(21)
  })
  it('titles the window product · destination', () => {
    expect(windowTitle('GALE-JACKET', 'Amazon DE')).toBe('GALE-JACKET · Amazon DE')
  })
  it('takes the title name from the caller, else the product itself among the listings, never another product', () => {
    const detail = { productId: 'p1', problems: [problem({ products: [{ id: 'v2', sku: 'GALE-M', name: 'Gale M' }] }), problem({ products: [{ id: 'p1', sku: 'GALE', name: null }] })] }
    expect(productTitle('Gale jacket', detail, true)).toBe('Gale jacket')
    expect(productTitle(null, detail, true)).toBe('GALE')
    expect(productTitle('  ', { productId: 'p1', problems: [problem({ products: [{ id: 'v2', sku: 'GALE-M', name: 'Gale M' }] })] }, true)).toBe('This family')
    expect(productTitle(undefined, null, false)).toBe('This product')
  })
  it('says "Nothing to fix" only when the check says Ready', () => {
    expect(emptyWords('ready', 'Amazon DE')).toEqual({ title: 'Nothing to fix on Amazon DE', description: null })
    expect(emptyWords('notComputed', 'eBay IT').title).toBe('Not computed on eBay IT')
    expect(emptyWords('notComputed', 'eBay IT').description).toMatch(/not a score of zero/)
    expect(emptyWords('absent', 'Shopify').title).toBe('Not set up on Shopify')
    expect(emptyWords('blocked', 'Amazon DE')).toEqual({ title: 'Blocked on Amazon DE', description: 'The check named no fields here. Open the studio to see its checks.' })
  })
})

describe('the window’s read', () => {
  it('passes the page filters on, drops paging, and its own keys win', () => {
    const path = detailPath({ channel: 'AMAZON', search: 'gale', page: '3', pageSize: '100', state: 'blocked', destination: 'old', language: '' }, { productId: 'p1', family: true, destinationKey: '["AMAZON","DE",null,""]' })
    const [base, search] = path.split('?')
    expect(base).toBe('catalog-transfer/readiness/detail')
    expect(Object.fromEntries(new URLSearchParams(search))).toEqual({ channel: 'AMAZON', search: 'gale', state: 'blocked', destination: '["AMAZON","DE",null,""]', productId: 'p1', family: '1' })
  })
  it('a single product asks for family=0', () => {
    expect(new URLSearchParams(detailPath({}, { productId: 'p9', family: false, destinationKey: 'k' }).split('?')[1]).get('family')).toBe('0')
    // Step 4's order is the page's: never sent with the window's read.
    const sorted = new URLSearchParams(detailPath({ sort: 'price', dir: 'desc', priceMin: '20' }, { productId: 'p9', family: false, destinationKey: 'k' }).split('?')[1])
    expect([sorted.get('sort'), sorted.get('dir'), sorted.get('priceMin')]).toEqual([null, null, '20'])
  })
})

describe('the window’s studio links', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })
  it('keeps a bare studio path as it is when business profiles are off', () => {
    expect(inBusiness('/products/p1/edit/studio?scope=AMAZON', 'ws_12345678')).toBe('/products/p1/edit/studio?scope=AMAZON')
  })
  it('puts a bare studio path inside the current business, once', async () => {
    vi.stubEnv('NEXT_PUBLIC_WORKSPACES_ENABLED', '1')
    vi.resetModules()
    const { inBusiness: scoped } = await import('./listingDialogModel')
    expect(scoped('/products/p1/edit/studio?rec=p1&cell=name', 'ws_12345678')).toBe('/w/ws_12345678/products/p1/edit/studio?rec=p1&cell=name')
    expect(scoped('/w/ws_12345678/products/p1/edit/studio', 'ws_12345678')).toBe('/w/ws_12345678/products/p1/edit/studio')
    expect(scoped('/products/p1/edit/studio', null)).toBe('/products/p1/edit/studio')
  })
})

describe('the summary’s listings line', () => {
  const c = (over: Partial<Record<'blocked' | 'warn' | 'notComputed' | 'absent' | 'ready', number>>) => ({ blocked: 0, warn: 0, notComputed: 0, absent: 0, ready: 0, ...over })
  it('says "all" when every listing has one state, and lists the states otherwise', () => {
    expect(stateLine(c({ blocked: 21 }))).toBe('21 products, all blocked')
    expect(stateLine(c({ blocked: 18, ready: 3 }))).toBe('21 products: 18 blocked · 3 ready')
    expect(stateLine(c({ ready: 1 }))).toBe('1 product, ready')
  })
})

/* ── The Listing window (step 5 of docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md) ────────────────────────────── */

const summary = (over: Partial<ReadinessLiveSummary> = {}): ReadinessLiveSummary => ({
  state: 'active', listed: 1, notListed: 0, byState: { active: 1 }, externalId: null, url: null, priceMin: null, priceMax: null, currency: null,
  quantity: null, fulfillment: null, channelErrorCount: 0, suppressedCount: 0, outOfSyncCount: 0, syncFailedCount: 0, lastSyncedAt: null, duplicates: 0, ...over,
})
const live = (listingId: string, over: Partial<ReadinessLive> = {}): ReadinessLive => ({
  listingId, state: 'active', reason: null, externalId: null, externalParentId: null, url: null, price: null, salePrice: null, currency: null, quantity: null,
  fulfillment: null, syncStatus: 'SYNCED', lastSyncedAt: null, lastSyncError: null, channelErrorCount: 0, channelWarningCount: 0, suppressed: false,
  outOfSync: [], held: false, ...over,
})
const listing = (id: string, over: Partial<ReadinessChannelListing> = {}, liveOver: Partial<ReadinessLive> = {}): ReadinessChannelListing => ({
  productId: `p-${id}`, sku: `SKU-${id}`, live: live(id, liveOver), messages: [], suppressions: [], differs: [], lastPublish: null, ...over,
})
const section = (listings: ReadinessChannelListing[], over: Partial<ReadinessLiveSummary> = {}): ReadinessChannelSection => ({ summary: summary(over), listings, readAt: '2026-10-25T10:00:00Z' })
const liveChip = (destinationKey: string, liveOver: Partial<ReadinessLiveSummary> | null, over: Partial<ReadinessChip> = {}): ReadinessChip => ({
  destinationKey, state: 'ready', counts: { blocked: 0, warn: 0, notComputed: 0, absent: 0, ready: 1 }, issueCount: 0, pending: false, computedAt: null,
  live: liveOver ? summary(liveOver) : null, ...over,
})
const memberRow = (id: string, chips: ReadinessChip[], nextStep: ReadinessMemberRow['nextStep'] = null): ReadinessMemberRow => ({
  id, sku: id, name: null, imageUrl: null, photoCount: 0, state: 'ready', chips, nextStep, computedAt: null, pending: false, editorHref: `/products/${id}/edit/studio`,
  parentId: null, isParentListing: false,
})
const destination = (over: Partial<ReadinessDestination> = {}): ReadinessDestination => ({ key: 'k', channel: 'AMAZON', marketplace: 'DE', accountId: 'acc1', aliasKey: '', label: 'Amazon DE', ...over })

describe('the tabs', () => {
  it('without what the channel says (an older API, Shared, no listings.view) the window is the Fix window: Readiness only', () => {
    expect(windowTabs(null)).toEqual(['readiness'])
    expect(windowTabs({})).toEqual(['readiness'])
    expect(windowTabs({ channel: null })).toEqual(['readiness'])
    expect(windowTabs({ channel: section([]) })).toEqual(['readiness', 'channel', 'price', 'history'])
  })
  it('shows the tab asked for when it is there, else Readiness', () => {
    expect(shownTab('channel', ['readiness', 'channel', 'price', 'history'])).toBe('channel')
    expect(shownTab('channel', ['readiness'])).toBe('readiness')
    expect(shownTab(null, ['readiness', 'channel'])).toBe('readiness')
  })
  it('a ▲ chip opens On the channel; every other chip Readiness', () => {
    expect(tabForChip(liveChip('k', { suppressedCount: 1 }))).toBe('channel')
    expect(tabForChip(liveChip('k', { syncFailedCount: 1 }))).toBe('channel')
    expect(tabForChip(liveChip('k', { channelErrorCount: 2, state: 'mixed' }))).toBe('channel')
    expect(tabForChip(liveChip('k', { state: 'mixed' }))).toBe('readiness')
    expect(tabForChip(liveChip('k', null))).toBe('readiness')
    expect(tabForChip(undefined)).toBe('readiness')
  })
  it('names each tab in the channel’s word, and counts problems and channel messages', () => {
    expect(tabLabel('channel', 'AMAZON')).toBe('On Amazon')
    expect(tabLabel('channel', 'EBAY')).toBe('On eBay')
    expect(['readiness', 'price', 'history'].map((t) => tabLabel(t as never, 'AMAZON'))).toEqual(['Readiness', 'Price & stock', 'History'])
    const msg = { code: '90220', severity: 'error' as const, message: 'x', attributeNames: [], source: 'push', firstSeenAt: null, lastSeenAt: null }
    const sup = { id: 'sup-1', reasonCode: null, reasonText: 'Missing main image', severity: 'ERROR', source: 'report', suppressedAt: null }
    const detail = { problems: [{} as never, {} as never, {} as never], channel: section([listing('a', { messages: [msg], suppressions: [sup] }), listing('b')]) }
    expect(tabCount('readiness', detail)).toBe(3)
    expect(tabCount('channel', detail)).toBe(2)
    expect(tabCount('price', detail)).toBeNull()
    expect(tabCount('channel', { problems: [], channel: section([listing('a')]) })).toBeNull()
    expect(tabCount('readiness', { problems: [] })).toBeNull()
  })
})

describe('Open, and Prev / Next over the rows in view', () => {
  const step = { destinationKey: 'next', field: 'sizeChart', label: 'Size chart', message: 'm', kind: 'required' as const, affected: 1, productId: 'p', locale: 'de', href: '/x' }
  it('Open opens on the next step, else a ▲ chip, else the chip needing attention first', () => {
    expect(openDestination({ nextStep: step, chips: [liveChip('a', { suppressedCount: 1 })] })).toBe('next')
    expect(openDestination({ nextStep: null, chips: [liveChip('ok', {}, { state: 'warn' }), liveChip('bad', { suppressedCount: 1 })] })).toBe('bad')
    expect(openDestination({ nextStep: null, chips: [liveChip('r', null), liveChip('w', null, { state: 'warn' })] })).toBe('w')
    expect(openDestination({ nextStep: null, chips: [] })).toBeNull()
  })
  it('Open is held only on a row without any chip (a Ready row still shows what is live)', () => {
    expect(openHeldReason({ chips: [] })).toContain('no listing')
    expect(openHeldReason({ chips: [liveChip('r', null)] })).toBeNull()
  })
  it('walks rows with chips, in the grid’s order, once each', () => {
    const rows = [
      { id: 'r1', data: memberRow('a', [liveChip('k', null)]) },
      { id: 'r2', data: memberRow('b', []) },
      { id: 'r3', data: memberRow('c', [liveChip('k', null)]) },
      { id: 'r1', data: memberRow('a', [liveChip('k', null)]) },
    ]
    expect(navIds(rows)).toEqual(['r1', 'r3'])
  })
  it('keeps the destination on show when the next row has it, else opens it as Open would', () => {
    const row = memberRow('a', [liveChip('de', null), liveChip('it', null, { state: 'blocked' })])
    expect(destinationForRow(row, 'de')).toBe('de')
    expect(destinationForRow(row, 'fr')).toBe('it')
    expect(destinationForRow(memberRow('b', []), 'de')).toBeNull()
  })
})

describe('the header and On the channel', () => {
  it('says how the destination sells, in the DS words', () => {
    expect(statusSentence(summary({ state: 'mixed', listed: 18, notListed: 2, byState: { active: 18 } }))).toBe('Mixed (18 Active · 2 Not listed)')
    expect(statusSentence(summary({ state: 'active', listed: 20, byState: { active: 20 } }))).toBe('20 Active')
    expect(statusSentence(summary({ state: 'active', listed: 1, byState: { active: 1 } }))).toBe('Active')
    expect(statusSentence(summary({ state: 'not_listed', listed: 0, notListed: 1, byState: {} }))).toBe('Not listed')
    expect(statusSentence(summary({ state: 'paused', listed: 1, byState: { paused: 1 } }))).toBe('Inactive')
  })
  it('names the problems on the channel, or nothing', () => {
    expect(problemSentence(summary({ suppressedCount: 1, syncFailedCount: 1 }))).toBe('1 Suppressed · 1 Push failed')
    expect(problemSentence(summary())).toBeNull()
  })
  it('says when Nexus last synced with the channel', () => {
    const now = Date.parse('2026-10-25T12:00:00Z')
    expect(syncedWords('2026-10-25T11:00:00Z', 'AMAZON', now)).toBe('Synced with Amazon 1 h ago')
    expect(syncedWords(null, 'EBAY', now)).toBe('Not synced with eBay yet')
  })
  it('calls the channel id by the channel’s own name', () => {
    expect(channelIdLabel('AMAZON', true)).toBe('Parent ASIN')
    expect(channelIdLabel('AMAZON', false)).toBe('ASIN')
    expect(channelIdLabel('EBAY', true)).toBe('Item ID')
    expect(channelIdLabel('SHOPIFY', false)).toBe('Product ID')
    expect(channelIdLabel('ETSY', false)).toBe('Listing ID')
  })
  it('the last push is the newest of the listings’, with its SKU', () => {
    const listings = [
      listing('a', { lastPublish: { at: '2026-10-24T10:00:00Z', outcome: 'ACCEPTED', message: null } }),
      listing('b', { lastPublish: { at: '2026-10-25T10:42:00Z', outcome: 'FAILED', message: 'Bad size' } }),
      listing('c'),
    ]
    expect(lastPushOf(listings)).toMatchObject({ sku: 'SKU-b', outcome: 'FAILED', message: 'Bad size' })
    expect(lastPushOf([listing('c')])).toBeNull()
    expect(pushWords({ at: '2026-10-25T10:42:00', outcome: 'FAILED' }, Date.parse('2026-10-26T09:00:00'))).toBe('Failed 25 Oct, 10:42')
  })
  it('a listing’s own result in its last publish, in the DS words for one product (step 3’s outcomes)', () => {
    expect(publishOutcomeMeta('SUBMITTED')).toEqual({ label: 'Waiting', tone: 'info' })
    expect(publishOutcomeMeta('ACCEPTED')).toEqual({ label: 'Accepted', tone: 'info' })
    expect(publishOutcomeMeta('VERIFIED')).toEqual({ label: 'Verified', tone: 'success' })
    expect(publishOutcomeMeta('FAILED')).toEqual({ label: 'Failed', tone: 'danger' })
    expect(publishOutcomeMeta('UNKNOWN')).toEqual({ label: 'Result unknown', tone: 'warning' })
  })
  it('a push outcome in honest words: success is Accepted, never live; what never left Nexus says so', () => {
    expect(pushOutcomeMeta('success')).toEqual({ label: 'Accepted', tone: 'info' })
    expect(pushOutcomeMeta('SUCCESS').label).toBe('Accepted')
    expect(pushOutcomeMeta('failed')).toEqual({ label: 'Failed', tone: 'danger' })
    expect(pushOutcomeMeta('gated').label).toBe('Not sent: publishing is off')
    expect(pushOutcomeMeta('rate-limited').label).toBe('Not sent: rate limit')
    expect(pushOutcomeMeta('VERIFIED').label).toBe('Verified')
    expect(pushOutcomeMeta('teleported').label).toBe('teleported')
  })
})

describe('History', () => {
  it('pushes and reads in one list, newest first, in words', () => {
    const rows = historyRows(
      [{ id: 's1', attemptedAt: '2026-10-25T09:00:00Z', status: 'SUCCESS', source: 'manual', durationMs: 900, error: null },
        { id: 's2', attemptedAt: '2026-10-25T11:00:00Z', status: 'NOT_IMPLEMENTED', source: 'cron', durationMs: 1, error: 'Resync is not yet implemented' }],
      [{ id: 'p1', attemptedAt: '2026-10-25T10:00:00Z', mode: 'live', outcome: 'failed', errorMessage: 'The value is not allowed.', errorCode: '90220' },
        { id: 'p2', attemptedAt: '2026-10-24T10:00:00Z', mode: 'dry-run', outcome: 'success', errorMessage: null, errorCode: null }],
      'AMAZON',
    )
    expect(rows.map((r) => [r.id, r.what, r.result.label, r.message])).toEqual([
      ['read:s2', 'Read from Amazon (cron)', 'Not read: not supported on this channel', 'Resync is not yet implemented'],
      ['push:p1', 'Push to Amazon', 'Failed', '90220 The value is not allowed.'],
      ['read:s1', 'Read from Amazon', 'Read', null],
      ['push:p2', 'Push to Amazon (dry run)', 'Accepted', null],
    ])
    expect(readOutcomeMeta('TIMEOUT').label).toBe('No answer in time')
    // Refresh from Amazon: Amazon has no listing for the seller SKU.
    expect(readOutcomeMeta('NOT_FOUND')).toEqual({ label: 'Not found on the channel', tone: 'warning' })
    expect(historyRows([], [], 'EBAY')).toEqual([])
  })
  it('the reads the window’s data carries become History rows', () => {
    const rows = syncAttemptRows('l1', [{ at: '2026-10-25T09:00:00Z', status: 'FAILED', source: 'cron', durationMs: 40, error: 'Throttled' }])
    expect(rows).toEqual([{ id: 'l1:0', attemptedAt: '2026-10-25T09:00:00Z', status: 'FAILED', source: 'cron', durationMs: 40, error: 'Throttled' }])
    expect(historyRows(rows, [], 'AMAZON').map((r) => [r.what, r.result.label, r.message])).toEqual([['Read from Amazon (cron)', 'Failed', 'Throttled']])
  })
})

describe('Price & stock', () => {
  it('the quantity note: FBA is Amazon’s; Amazon EU is one number for its markets; elsewhere none', () => {
    expect(quantityNote('AMAZON', 'DE', 'FBA')).toMatch(/Amazon manages this quantity \(FBA\)\. Nexus never changes it\./)
    expect(quantityNote('AMAZON', 'it', 'FBM')).toBe(`Amazon EU keeps one quantity per SKU for ${AMAZON_EU_SHARED_MARKETS.join(' ')}: it is the same number on each of them.`)
    expect(quantityNote('AMAZON', 'UK', 'FBM')).toBeNull()
    expect(quantityNote('EBAY', 'DE', null)).toBeNull()
  })
  it('a value the channel never reports back says it is as sent by Nexus', () => {
    expect(sentOnlyNote('EBAY', 'price')).toBe('As sent by Nexus: eBay does not report its price back.')
    expect(sentOnlyNote('ETSY', 'quantity')).toBe('As sent by Nexus: Etsy does not report its quantity back.')
    expect(sentOnlyNote('AMAZON', 'price')).toBeNull()
    expect(sentOnlyNote('EBAY', 'quantity')).toBeNull()
  })
  it('prices in their own currency, never added up', () => {
    expect(moneyWords(49.9, 'EUR')).toBe('49.90 EUR')
    expect(moneyWords(1234.5, null)).toBe('1,234.50')
    expect(moneyWords(null, 'EUR')).toBe('—')
    expect(priceWords({ price: 49.9, salePrice: 39.9, currency: 'EUR' })).toBe('49.90 EUR (sale 39.90 EUR)')
    expect(priceWords({ price: null, salePrice: null, currency: null })).toBe('—')
  })
  it('Pin price… takes a price above 0 with at most two decimals, a comma too', () => {
    expect(parsePinPrice('49.90')).toEqual({ ok: true, value: 49.9 })
    expect(parsePinPrice(' 49,9 ')).toEqual({ ok: true, value: 49.9 })
    expect(parsePinPrice('')).toEqual({ ok: false, reason: 'Type a price.' })
    expect(parsePinPrice('0')).toEqual({ ok: false, reason: 'The price must be above 0.' })
    expect(parsePinPrice('12.345').ok).toBe(false)
    expect(parsePinPrice('-3').ok).toBe(false)
    expect(parsePinPrice('abc').ok).toBe(false)
  })
  it('the two edits are the price door’s own bodies: a pin, or follow the master again', () => {
    expect(pinPriceBody(49.9)).toEqual({ priceOverride: 49.9 })
    expect(followMasterBody()).toEqual({ followMasterPrice: true })
  })
  it('Pin is always offered on a read listing; Follow master only when it does not follow now', () => {
    expect(priceActions({ followMasterPrice: false })).toEqual({ pin: true, follow: true })
    expect(priceActions({ followMasterPrice: true })).toEqual({ pin: true, follow: false })
    expect(priceActions(null)).toEqual({ pin: false, follow: false })
    // Before the listing's own read: the window's data says (step 4); the read wins once it is there.
    expect(priceActions(null, { followsMasterPrice: false })).toEqual({ pin: true, follow: true })
    expect(priceActions(null, {})).toEqual({ pin: false, follow: false })
    expect(priceActions({ followMasterPrice: true }, { followsMasterPrice: false })).toEqual({ pin: true, follow: false })
  })
  it('opens on the listing the link names, else the first with a problem, else the first', () => {
    const listings = [listing('a'), listing('b', {}, { suppressed: true }), listing('c', {}, { syncStatus: 'FAILED' })]
    expect(initialFocus(listings, 'c')).toBe('c')
    expect(initialFocus(listings, 'gone')).toBe('b')
    expect(initialFocus([listing('a'), listing('x', {}, { outOfSync: ['channel-differs'] })])).toBe('x')
    expect(initialFocus([listing('a'), listing('z')])).toBe('a')
    expect(initialFocus([])).toBeNull()
  })
})

describe('the footer’s links', () => {
  it('Sync activity: the API calls log for this listing', () => {
    expect(syncActivityHref('cl 1')).toBe('/sync-logs/api-calls?listingId=cl+1&since=30d')
  })
  it('Sales: Insights on this channel and market; none where Insights has no such channel', () => {
    expect(salesHref({ channel: 'AMAZON', marketplace: 'DE' })).toBe('/insights/products?channels=AMAZON&markets=DE')
    expect(salesHref({ channel: 'SHOPIFY', marketplace: 'GLOBAL' })).toBe('/insights/products?channels=SHOPIFY')
    expect(salesHref({ channel: 'ETSY', marketplace: 'GLOBAL' })).toBeNull()
    expect(salesHref({ channel: 'SHARED', marketplace: '' })).toBeNull()
  })
  it('the studio Matrix on this destination', () => {
    expect(matrixHref('p1', destination({ aliasKey: 'al1' }))).toBe('/products/p1/edit/studio?tab=matrix&scope=AMAZON&market=DE&account=acc1&alias=al1')
    expect(matrixHref('p 2', destination({ channel: 'SHARED', marketplace: '', accountId: null }))).toBe('/products/p%202/edit/studio?tab=matrix')
  })
  it('Publish… starts on this destination’s option key; none on Shared', () => {
    expect(publishStartKey(destination())).toBe('["AMAZON","DE","acc1",null]')
    expect(publishStartKey(destination({ aliasKey: 'al1' }))).toBe('["AMAZON","DE","acc1","al1"]')
    expect(publishStartKey(destination({ channel: 'SHARED', marketplace: '', accountId: null }))).toBeNull()
  })
})

describe('writes', () => {
  it('a 403 holds the button with the API’s own words; any other answer does not', () => {
    expect(refusalText(403, { error: 'Access denied', code: 'forbidden', required: 'listings.edit' })).toBe('Access denied (listings.edit)')
    expect(refusalText(403, { error: 'You may not change prices here.' })).toBe('You may not change prices here.')
    expect(refusalText(403, null)).toBe('Access denied')
    expect(refusalText(409, { error: 'Version conflict' })).toBeNull()
    expect(errorText(502, { detail: 'Amazon said no' })).toBe('Amazon said no')
    expect(errorText(500, {})).toBe('Request failed (500)')
  })
  it('each confirm is a valid DS confirmation that says what it costs and what it does not touch', () => {
    const diagnose = diagnoseConfirm('GAL-M', 'Amazon DE')
    expect(diagnose.confirmLabel).toBe('Diagnose (costs money)')
    expect(diagnose.consequences.join(' ')).toMatch(/costs money/)
    const resolve = resolveConfirm('GAL-M', 'Amazon DE', 'AMAZON')
    expect(resolve.consequences[0]).toBe('Amazon is not told: this changes Nexus only.')
    const follow = followConfirm('GAL-M', 'Amazon DE')
    for (const impact of [diagnose, resolve, follow]) expect(canConfirmAction(impact, '', false)).toBe(true)
  })
})

describe('the title', () => {
  it('falls back to the product’s own listing SKU on the channel, never another product’s', () => {
    expect(productTitle(null, { productId: 'p-b', problems: [], channel: section([listing('a'), listing('b')]) }, false)).toBe('SKU-b')
    expect(productTitle(null, { productId: 'p-z', problems: [], channel: section([listing('a')]) }, true)).toBe('This family')
  })
})

describe('Refresh from Amazon', () => {
  const amazonNow = { status: 'BUYABLE', asin: 'B0TESTAS01', price: 99, currency: 'EUR', quantity: 24, fulfillment: 'FBM' as const, issues: [] }
  it('the panel: "Amazon now (read 10:42)" and Amazon’s status, ASIN, price, quantity and messages in one line', () => {
    expect(amazonNowTitle('2026-10-26T08:42:10Z', 'UTC')).toBe('Amazon now (read 08:42)')
    expect(amazonNowTitle('2026-10-26T08:42:10Z', 'Europe/Rome')).toBe('Amazon now (read 09:42)')
    expect(amazonNowLine(amazonNow)).toBe('Active · ASIN B0TESTAS01 · 99.00 EUR · Qty 24 · 0 messages')
    const issue = { code: '90220', message: 'item_name is required but missing.', severity: 'ERROR', attributeNames: ['item_name'] }
    expect(amazonNowLine({ ...amazonNow, issues: [issue] })).toBe('Active · ASIN B0TESTAS01 · 99.00 EUR · Qty 24 · 1 message')
    expect(amazonNowLine({ ...amazonNow, issues: [issue, issue] })).toMatch(/· 2 messages$/)
  })
  it('FBA stock is never reported by Amazon’s Listings API: the panel says so instead of a number', () => {
    expect(amazonNowLine({ ...amazonNow, quantity: null, fulfillment: 'FBA' })).toBe('Active · ASIN B0TESTAS01 · 99.00 EUR · FBA: not reported by Amazon · 0 messages')
    expect(amazonNowLine({ ...amazonNow, quantity: null, fulfillment: null, asin: null, price: null })).toBe('Active · No ASIN · No price · Qty not reported · 0 messages')
  })
  it('Amazon’s status in the window’s words, anything unknown as Amazon wrote it', () => {
    expect(amazonStatusWords('BUYABLE')).toBe('Active')
    expect(amazonStatusWords('DISCOVERABLE')).toBe('Active, not buyable')
    expect(amazonStatusWords('SUPPRESSED')).toBe('SUPPRESSED')
    expect(amazonStatusWords(null)).toBe('No status reported')
  })
  it('Nexus’s own price and quantity, beside Amazon’s', () => {
    expect(nexusNowLine(live('l1', { price: 89.9, currency: 'EUR', quantity: 3, fulfillment: 'FBM' }))).toBe('In Nexus: 89.90 EUR · Qty 3')
    expect(nexusNowLine(live('l1', { price: 89.9, salePrice: 79.9, currency: 'EUR', quantity: 12, fulfillment: 'FBA' }))).toBe('In Nexus: 89.90 EUR (sale 79.90 EUR) · Qty 12 (FBA)')
    expect(nexusNowLine(live('l1', { price: null, currency: null, quantity: null }))).toBe('In Nexus: — · Qty —')
  })
  it('the button is held by the API’s own 403 first, then a read in flight, no listing, and no Amazon account', () => {
    const ready = { listingId: 'l1', accountId: 'acc1' }
    expect(refreshHeldReason(ready)).toBeNull()
    expect(refreshHeldReason({ ...ready, refused: 'Access denied (listings.edit)', busy: true })).toBe('Access denied (listings.edit)')
    expect(refreshHeldReason({ ...ready, busy: true })).toBe('Reading Amazon…')
    expect(refreshHeldReason({ ...ready, listingId: null })).toBe('Choose a listing first.')
    expect(refreshHeldReason({ ...ready, accountId: null })).toBe('This listing has no Amazon account. Link it to an account first.')
  })
  it('a refresh that did not read: the API’s words as they came; Amazon’s 404 and a refusal warn, a failed read is an error', () => {
    expect(errorText(404, { error: 'Amazon has no listing with seller SKU GAL-M in Italy.' })).toBe('Amazon has no listing with seller SKU GAL-M in Italy.')
    expect(errorText(504, { error: 'Amazon did not answer in time (10 s). Nothing was changed.' })).toBe('Amazon did not answer in time (10 s). Nothing was changed.')
    expect([404, 409, 502, 504, 0].map(refreshFailureTone)).toEqual(['warning', 'warning', 'danger', 'danger', 'danger'])
  })
})
