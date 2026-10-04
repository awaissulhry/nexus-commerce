import { describe, expect, it } from 'vitest'
import type { PublicationBatchView, StudioPublishReview, StudioPublishScope } from '@nexus/shared/studio-publication'
import {
  EMPTY_ENTRY, batchCancellable, batchChildMeta, batchProgress, batchRequest, batchSentence, channelOptions, destinationState, destinationStateLabel,
  euRefusal, initialTicked, initialTicks, publishButtonText, publishPath, publishPlan, reviewRequestsText, selectAllText, withInitialOptions,
  type DestinationEntry, type DestinationState,
} from './destinations'
import { publicationDestinations, publicationScopeKey } from './model'

const NOW = Date.parse('2026-10-02T10:00:00Z')
const LATER = '2026-10-02T10:15:00Z'
const markets = ['IT', 'DE', 'FR', 'ES'].map(code => ({ id: code, channel: 'AMAZON', code, name: `Amazon ${code}`, accounts: [{ id: 'acc', label: 'Xavia' }] }))
  .concat([{ id: 'ebay-it', channel: 'EBAY', code: 'IT', name: 'eBay Italy', accounts: [{ id: 'ebay', label: 'Xavia eBay' }] }])
const options = publicationDestinations(markets)
const key = (channel: string, marketplace: string, accountId = channel === 'EBAY' ? 'ebay' : 'acc') => publicationScopeKey({ channel, marketplace, accountId })
const scopeOf = (k: string) => options.find(o => o.key === k)?.scope

const change = (id: string, over: Partial<NonNullable<StudioPublishReview['changes']>[number]> = {}) => ({
  id, productId: 'p', sku: 'SKU', field: id, label: id, status: 'SEND', selectable: true, selectedByDefault: true, reason: '',
  current: { state: 'value', value: 1 }, lastAccepted: { state: 'absent' }, channel: { state: 'value', value: 0 }, ...over,
}) as NonNullable<StudioPublishReview['changes']>[number]

const review = (scope: StudioPublishScope, over: Partial<StudioPublishReview> = {}): StudioPublishReview => ({
  id: `r-${scope.marketplace}`, productId: 'p', scope, accountLabel: 'Xavia', aliasLabel: 'Primary listing', mode: 'live', action: 'update',
  rows: [{ productId: 'p', sku: 'SKU', title: 'Jacket', existing: true }], excluded: 0, issues: [], expiresAt: LATER,
  changes: [change('title'), change('brand', { selectedByDefault: false, status: 'DIFFERS' }), change('size', { selectable: false, selectedByDefault: false, status: 'SAME' })], ...over,
})
const entry = (r: StudioPublishReview | null, over: Partial<DestinationEntry> = {}): DestinationEntry => ({ ...EMPTY_ENTRY, review: r, selectedIds: r ? initialTicks(r) : [], ...over })

describe('which destinations start ticked', () => {
  it('ticks the destination the surface asks for, and only that one', () => {
    expect(initialTicked(options, [{ channel: 'AMAZON', marketplace: 'IT', accountId: 'acc' }])).toEqual([key('AMAZON', 'IT')])
  })
  it('ticks the only destination there is when none is asked for, and nothing when there are several', () => {
    expect(initialTicked(options.slice(0, 1), [])).toEqual([key('AMAZON', 'IT')])
    expect(initialTicked(options, [])).toEqual([])
  })
  it('adds a retry destination on a non-primary listing as its own option, so it can start ticked', () => {
    const retry = { channel: 'AMAZON', marketplace: 'DE', accountId: 'acc', listingId: 'alias-2' }
    const extended = withInitialOptions(options, [retry])
    expect(extended).toHaveLength(options.length + 1)
    expect(initialTicked(extended, [retry])).toEqual([publicationScopeKey(retry)])
    expect(withInitialOptions(options, [{ channel: 'ETSY', marketplace: 'GLOBAL', accountId: 'x' }])).toHaveLength(options.length)
  })
  it('"Select all" covers every market of the channel on the account in use, once', () => {
    const twoAccounts = publicationDestinations(markets.map(m => m.channel === 'AMAZON' ? { ...m, accounts: [...m.accounts, { id: 'synthetic', label: 'Synthetic' }] } : m))
    expect(channelOptions(twoAccounts, 'AMAZON')).toHaveLength(8)
    const amazon = channelOptions(twoAccounts, 'AMAZON', 'acc')
    expect(amazon).toHaveLength(4)
    expect(selectAllText('AMAZON', amazon.length)).toBe('Select all Amazon markets (4)')
  })
})

describe('a destination’s state after its review', () => {
  const it_ = { channel: 'AMAZON', marketplace: 'IT', accountId: 'acc' }
  it('is checking while it loads, and not checked when it is not ticked', () => {
    expect(destinationState({ ...EMPTY_ENTRY, loading: true }, true, NOW).kind).toBe('checking')
    expect(destinationState(EMPTY_ENTRY, false, NOW).kind).toBe('not_checked')
    expect(destinationState(EMPTY_ENTRY, true, NOW).kind).toBe('checking')
  })
  it('counts only ticked, selectable changes as ready, and says when the request is not prepared yet', () => {
    const state = destinationState(entry(review(it_)), true, NOW)
    expect(state).toEqual({ kind: 'ready', changes: 1, whole: false, requestReady: false })
  })
  it('is blocked by an error issue, named with the number of problems', () => {
    const state = destinationState(entry(review(it_, { issues: [{ message: 'Brand is required', severity: 'error' }, { message: 'x', severity: 'error' }] })), true, NOW)
    expect(state).toEqual({ kind: 'blocked', problems: 2, reason: null })
    expect(destinationStateLabel(state).label).toBe('Fix 2 problems first')
  })
  it('is blocked when the review has no id (the publish gate refused it) even without a named problem', () => {
    expect(destinationState(entry(review(it_, { id: null })), true, NOW).kind).toBe('blocked')
  })
  it('expires after its review time, and offers Check again', () => {
    const state = destinationState(entry(review(it_, { expiresAt: '2026-10-02T09:59:00Z' })), true, NOW)
    expect(state.kind).toBe('expired')
    expect(destinationStateLabel(state).label).toBe('Review expired')
  })
  it('has nothing to send when no field differs, and says "No fields ticked" when the person unticked them', () => {
    expect(destinationState(entry(review(it_, { changes: [change('size', { selectable: false, selectedByDefault: false, status: 'SAME' })] })), true, NOW))
      .toEqual({ kind: 'nothing', reason: 'none' })
    expect(destinationState(entry(review(it_), { selectedIds: [] }), true, NOW)).toEqual({ kind: 'nothing', reason: 'unticked' })
  })
  it('waits on an earlier publish to the destination', () => {
    expect(destinationState(entry(review(it_, { previousPublicationId: 'pub-1' })), true, NOW)).toEqual({ kind: 'earlier', publicationId: 'pub-1' })
  })
  it('asks a Shopify review for its location and its overwrite confirmation before it is ready', () => {
    const shop = review({ channel: 'SHOPIFY', marketplace: 'GLOBAL', accountId: 'shop' }, { changes: undefined, locations: [{ id: 'l1', name: 'Main' }],
      overwrite: { requiresConfirmation: true, products: [] } as unknown as StudioPublishReview['overwrite'] })
    expect(destinationState(entry(shop), true, NOW)).toEqual({ kind: 'input', needs: 'location' })
    expect(destinationState(entry(shop, { locationId: 'l1' }), true, NOW)).toEqual({ kind: 'input', needs: 'overwrite' })
    expect(destinationState(entry(shop, { locationId: 'l1', confirmedReviewId: shop.id }), true, NOW)).toEqual({ kind: 'ready', changes: 1, whole: true, requestReady: true })
  })
})

describe('"Publish failed products again…" pre-ticks only the given fields', () => {
  it('ticks exactly the given ids that the new review can send, and nothing else', () => {
    const r = review({ channel: 'AMAZON', marketplace: 'IT', accountId: 'acc' })
    expect(initialTicks(r, { fieldIds: ['brand', 'size', 'gone'] })).toEqual(['brand'])
    expect(initialTicks(r)).toEqual(['title'])
  })
})

describe('the counted button and the send path', () => {
  const states: Record<string, DestinationState> = {
    [key('AMAZON', 'IT')]: { kind: 'ready', changes: 12, whole: false, requestReady: true },
    [key('AMAZON', 'DE')]: { kind: 'ready', changes: 9, whole: false, requestReady: true },
    [key('AMAZON', 'FR')]: { kind: 'blocked', problems: 2, reason: null },
    [key('AMAZON', 'ES')]: { kind: 'nothing', reason: 'none' },
  }
  const stateOf = (k: string) => states[k] ?? { kind: 'not_checked' as const }
  it('counts changes over the markets that send, and names the skipped ones', () => {
    const plan = publishPlan(Object.keys(states), stateOf)
    expect(plan).toMatchObject({ changes: 21, problems: 2, send: [key('AMAZON', 'IT'), key('AMAZON', 'DE')], skipped: [key('AMAZON', 'FR')], nothing: [key('AMAZON', 'ES')] })
    expect(publishButtonText(plan, scopeOf)).toBe('Publish 21 changes to 2 markets · skip 1 with problems')
    expect(publishPath(plan)).toBe('batch')
  })
  it('one ready destination takes the single path; none takes no path', () => {
    const one = publishPlan([key('AMAZON', 'IT'), key('AMAZON', 'FR')], stateOf)
    expect(publishPath(one)).toBe('single')
    expect(publishButtonText(one, scopeOf)).toBe('Publish 12 changes to 1 market · skip 1 with problems')
    expect(publishPath(publishPlan([key('AMAZON', 'FR')], stateOf))).toBe('none')
    expect(publishButtonText(publishPlan([key('AMAZON', 'FR')], stateOf), scopeOf)).toBe('Nothing to publish · 1 with problems')
  })
  it('says "destinations" when channels mix, and counts a new Shopify product', () => {
    const shopKey = publicationScopeKey({ channel: 'SHOPIFY', marketplace: 'GLOBAL', accountId: 'shop' })
    const mixed = publishPlan([key('AMAZON', 'IT'), key('EBAY', 'IT'), shopKey], k => k === shopKey ? { kind: 'ready', changes: 1, whole: true, requestReady: true }
      : { kind: 'ready', changes: 3, whole: false, requestReady: true })
    expect(publishButtonText(mixed, k => k === shopKey ? { channel: 'SHOPIFY', marketplace: 'GLOBAL', accountId: 'shop' } : scopeOf(k)))
      .toBe('Publish 6 changes and 1 new product to 3 destinations')
  })
  it('lists the sparse destinations whose request is not prepared, and waits while one is still checking', () => {
    const plan = publishPlan([key('AMAZON', 'IT'), key('AMAZON', 'DE')], k => k === key('AMAZON', 'IT') ? { kind: 'ready', changes: 2, whole: false, requestReady: false } : { kind: 'checking' })
    expect(plan.needsRequest).toEqual([key('AMAZON', 'IT')])
    expect(plan.pending).toEqual([key('AMAZON', 'DE')])
    expect(reviewRequestsText(2)).toBe('Review 2 requests')
  })
})

describe('the batch request and its destinations’ words', () => {
  it('sends each ready destination with its own token, confirmation and location', () => {
    const a = review({ channel: 'AMAZON', marketplace: 'IT', accountId: 'acc' })
    const s = review({ channel: 'SHOPIFY', marketplace: 'GLOBAL', accountId: 'shop' }, { id: 'r-shop', locations: [{ id: 'l1', name: 'Main' }] })
    const entries: Record<string, DestinationEntry> = {
      a: entry(a, { selection: { reviewId: a.id!, token: 'tok-a', selectedIds: ['title'], products: [], fieldCount: 1, payload: { format: 'json', content: '{}' } } }),
      s: entry(s, { locationId: 'l1', confirmedReviewId: 'r-shop' }),
    }
    expect(batchRequest(['a', 's'], k => entries[k])).toEqual({ reviews: [
      { reviewId: 'r-IT', selectionToken: 'tok-a' },
      { reviewId: 'r-shop', confirmOverwrite: true, locationId: 'l1' },
    ] })
  })
  it('uses the design-system words, and plain words for the two batch states the table lacks', () => {
    expect(batchChildMeta({ status: 'VERIFIED', checked: false }).label).toBe('Verified')
    expect(batchChildMeta({ status: 'NOT_SENT', checked: false }).label).toBe('Not sent')
    expect(batchChildMeta({ status: 'BLOCKED', checked: false }).label).toBe('Not sent')
    expect(batchChildMeta({ status: 'PREVIEW', checked: false }).label).toBe('Waiting its turn')
    expect(batchChildMeta({ status: 'CANCELLED', checked: false }).label).toBe('Cancelled')
  })
  it('counts progress, offers cancel only while destinations still wait, and says the outcome in one sentence', () => {
    const child = (status: string, terminal: boolean) => ({ publicationId: status, productId: 'p', channel: 'AMAZON', marketplace: 'IT', accountId: 'acc', aliasKey: '', status, terminal, checked: false, message: null, summary: null })
    const view: PublicationBatchView = { batchId: 'b', phase: 'RUNNING', createdAt: '', sentAt: null, cancelRequestedAt: null, done: false, outcome: 'IN_PROGRESS',
      counts: { total: 3, waiting: 1, sending: 1, awaitingChannel: 0, succeeded: 1, partial: 0, failed: 0, notSent: 0, cancelled: 0, blocked: 0, checked: 0 },
      children: [child('VERIFIED', true), child('PUBLISHING', false), child('PREVIEW', false)] }
    expect(batchProgress(view)).toEqual({ done: 1, total: 3 })
    expect(batchCancellable(view)).toBe(true)
    expect(batchSentence(view)).toBe('1 of 3 markets have a result.')
    const done: PublicationBatchView = { ...view, phase: 'SENT', done: true, outcome: 'PARTIAL', counts: { ...view.counts, waiting: 0, sending: 0, succeeded: 2, failed: 1 } }
    expect(batchCancellable(done)).toBe(false)
    expect(batchSentence(done)).toBe('All 3 markets have a result: 2 accepted, 1 failed.')
  })
})

describe('the Amazon EU quantity refusal', () => {
  it('turns the 422 into a banner that names each SKU and market on its own line', () => {
    const e = Object.assign(new Error('These new Amazon listings would send different quantities to markets that share one EU quantity. Nothing was sent.\nJACKET-M (DE, FR): 3 against 5.\nGive these SKUs the same quantity.'), { status: 422 })
    expect(euRefusal(e)).toEqual({ title: 'Different Amazon EU quantities', lines: [
      'These new Amazon listings would send different quantities to markets that share one EU quantity. Nothing was sent.',
      'JACKET-M (DE, FR): 3 against 5.', 'Give these SKUs the same quantity.'] })
    expect(euRefusal(Object.assign(new Error('x'), { status: 409 }))).toBeNull()
  })
})
