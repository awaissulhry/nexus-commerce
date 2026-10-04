import { describe, expect, it } from 'vitest'
import type { PublicationBatchChild } from '@nexus/shared/studio-publication'
import { publicationStatusMeta } from '@/design-system/grid/renderers/publishStatus'
import {
  MAX_BATCH_PRODUCTS, estimateText, manyCapMessage, manyCheckButtonText, manyDestinationLabel, manyDestinationOptions, manyPlan, manyPublishButtonText,
  manyRequest, manyReviewPaths, manyRowEditable, manyRowLabel, manyRowState, manyStudioHref, reviewProgress, tickKey,
} from './many'
import { batchChildMeta, limitOneAccountPerChannel } from './destinations'
import { publicationDestinations } from './model'
import { joinMarketsAndConnections } from './useBusinessDestinations'

const NOW = Date.parse('2026-10-02T10:00:00Z')
const LATER = '2026-10-02T12:00:00Z'
const EARLIER = '2026-10-02T09:00:00Z'
const child = (over: Partial<PublicationBatchChild> = {}): PublicationBatchChild => ({
  publicationId: 'p1', productId: 'fam', channel: 'AMAZON', marketplace: 'IT', accountId: 'acc', aliasKey: '', status: 'PREVIEW', terminal: false,
  checked: false, message: null, summary: null, familySku: 'GALE', familyTitle: 'Gale jacket', productCount: 21, selectedCount: 3,
  problems: { errors: 0, warnings: 0, messages: [] }, expiresAt: LATER, nothingToSend: false, ...over,
})

describe('many-product rows', () => {
  it('reads each reviewed row: ready, nothing to send, problems, expired, not sent', () => {
    expect(manyRowState(child(), NOW)).toEqual({ kind: 'ready', changes: 3 })
    expect(manyRowState(child({ selectedCount: 0 }), NOW).kind).toBe('nothing')
    expect(manyRowState(child({ status: 'NOT_SENT', nothingToSend: true }), NOW).kind).toBe('nothing')
    expect(manyRowState(child({ status: 'BLOCKED', problems: { errors: 2, warnings: 1, messages: ['a', 'b'] } }), NOW)).toMatchObject({ kind: 'problems', problems: 2 })
    expect(manyRowState(child({ expiresAt: EARLIER }), NOW).kind).toBe('expired')
    expect(manyRowState(child({ status: 'NOT_SENT', message: 'No Amazon listing.' }), NOW)).toEqual({ kind: 'not_sent', reason: 'No Amazon listing.' })
    expect(manyRowLabel({ kind: 'problems', problems: 2, reason: null }).label).toBe('Fix 2 problems first')
    expect(manyRowLabel({ kind: 'expired' }).label).toBe('Review expired')
  })

  it('counts the plan and writes the counted button', () => {
    const rows = [child(), child({ publicationId: 'p2', selectedCount: 5 }), child({ publicationId: 'p3', status: 'BLOCKED', problems: { errors: 1, warnings: 0, messages: [] } }),
      child({ publicationId: 'p4', status: 'NOT_SENT', nothingToSend: true }), child({ publicationId: 'p5', expiresAt: EARLIER })]
    const plan = manyPlan(rows, NOW)
    expect(plan).toEqual({ listings: 2, changes: 8, problems: 1, expired: 1, nothing: 1, problemCount: 1 })
    expect(manyPublishButtonText(plan)).toBe('Publish 8 changes to 2 listings · skip 1 with problems · 1 expired')
    expect(manyPublishButtonText(manyPlan([child()], NOW))).toBe('Publish 3 changes to 1 listing')
    expect(manyPublishButtonText(manyPlan([child({ status: 'BLOCKED' })], NOW))).toBe('Nothing to publish · skip 1 with problems')
    expect(manyPublishButtonText(manyPlan([], NOW))).toBe('Nothing to publish')
  })

  it('refuses a selection the server would refuse, before asking it', () => {
    expect(manyCapMessage(MAX_BATCH_PRODUCTS + 1, 10, 1)).toContain('Select 200 or fewer products')
    expect(manyCapMessage(200, 100, 11)).toContain('1,100 reviews')
    expect(manyCapMessage(200, 100, 10)).toBeNull()
    expect(manyCheckButtonText(12, 3)).toBe('Check 12 products in 3 markets')
    expect(manyCheckButtonText(1, 1)).toBe('Check 1 product in 1 market')
    expect(manyCheckButtonText(2, 0)).toBe('Choose a market to check 2 products')
  })

  it('offers only Amazon and eBay markets, and sends only channel, market and account', () => {
    const markets = [
      { channel: 'AMAZON', code: 'IT', name: 'Amazon Italy', accounts: [{ id: 'a', label: 'Xavia' }] },
      { channel: 'SHOPIFY', code: 'GLOBAL', name: 'Shopify', accounts: [{ id: 's', label: 'Store' }] },
      { channel: 'EBAY', code: 'IT', name: 'eBay Italy', accounts: [{ id: 'e', label: 'Xavia' }] },
    ]
    expect(manyDestinationOptions(publicationDestinations(markets)).map(o => o.scope.channel)).toEqual(['AMAZON', 'EBAY'])
    expect(manyRequest(['x'], [{ channel: 'AMAZON', marketplace: 'IT', accountId: 'a', listingId: 'l' }], true))
      .toEqual({ productIds: ['x'], destinations: [{ channel: 'AMAZON', marketplace: 'IT', accountId: 'a' }], options: { replaceDiffers: true } })
    expect(manyDestinationLabel(child({ accountId: 'a' }), publicationDestinations(markets))).toBe('Amazon Italy · Xavia')
    expect(manyStudioHref(child())).toBe('/products/fam/edit/studio?scope=AMAZON&market=IT&account=acc')
  })

  it('states time and review progress from the server', () => {
    expect(estimateText({ estimate: { seconds: 540, minutes: 9, basis: '' } })).toBe('about 9 minutes')
    expect(estimateText({ estimate: { seconds: 20, minutes: 1, basis: '' } })).toBe('about a minute')
    expect(estimateText({ estimate: { seconds: null, minutes: null, basis: '' } })).toBeNull()
    expect(reviewProgress({ request: { families: 3, destinations: 2, reviews: 6, reviewed: 4 } })).toEqual({ done: 4, total: 6 })
  })
})

describe('batch words come from the design system', () => {
  it('names waiting and cancelled destinations with the DS table, not local words', () => {
    expect(batchChildMeta({ status: 'PREVIEW', checked: false })).toEqual(publicationStatusMeta('QUEUED'))
    expect(batchChildMeta({ status: 'CANCELLED', checked: false })).toEqual(publicationStatusMeta('CANCELLED'))
    expect(batchChildMeta({ status: 'BLOCKED', checked: false })).toEqual(publicationStatusMeta('NOT_SENT'))
  })
})

describe('ticking many markets at once keeps one account per channel', () => {
  const options = publicationDestinations([
    { channel: 'AMAZON', code: 'IT', name: 'Amazon IT', accounts: [{ id: 'a1', label: 'One' }, { id: 'a2', label: 'Two' }] },
    { channel: 'AMAZON', code: 'DE', name: 'Amazon DE', accounts: [{ id: 'a1', label: 'One' }, { id: 'a2', label: 'Two' }] },
    { channel: 'EBAY', code: 'IT', name: 'eBay IT', accounts: [{ id: 'e1', label: 'Shop' }] },
  ])
  const all = new Set(options.map(o => o.key))
  it('keeps the first account per channel when nothing was ticked', () => {
    const kept = limitOneAccountPerChannel(all, new Set(), options)
    expect(options.filter(o => kept.has(o.key)).map(o => `${o.scope.marketplace}:${o.scope.accountId}`)).toEqual(['IT:a1', 'DE:a1', 'IT:e1'])
  })
  it('keeps the account already ticked on that channel', () => {
    const it2 = options.find(o => o.scope.marketplace === 'IT' && o.scope.accountId === 'a2')!.key
    const kept = limitOneAccountPerChannel(all, new Set([it2]), options)
    expect(options.filter(o => kept.has(o.key) && o.scope.channel === 'AMAZON').map(o => o.scope.accountId)).toEqual(['a2', 'a2'])
  })
  it('never changes a single click', () => {
    const one = options.find(o => o.scope.accountId === 'a2')!.key
    const first = options.find(o => o.scope.accountId === 'a1')!.key
    expect([...limitOneAccountPerChannel(new Set([first, one]), new Set([first]), options)]).toEqual([first, one])
  })
})

describe('business destinations without a studio', () => {
  it('lists each market through the healthy accounts of its channel', () => {
    const grouped = { AMAZON: [{ id: 'm1', channel: 'AMAZON', code: 'IT', name: 'Amazon Italy', language: 'it' }], EBAY: [{ id: 'm2', channel: 'EBAY', code: 'IT', name: 'eBay Italy', language: 'it' }] }
    const connections = { connections: [
      { id: 'a', channel: 'AMAZON', accountLabel: 'Xavia', isActive: true, authStatus: 'connected' },
      { id: 'e', channel: 'EBAY', accountLabel: 'Old', isActive: false },
      { id: 'p', channel: 'AMAZON', isManagedBy: 'pending' },
    ] }
    const markets = joinMarketsAndConnections(grouped, connections, NOW)
    expect(markets.find(m => m.channel === 'AMAZON')).toMatchObject({ connected: true, accounts: [{ id: 'a', label: 'Xavia' }] })
    expect(markets.find(m => m.channel === 'EBAY')).toMatchObject({ connected: false, accounts: [] })
    expect(() => joinMarketsAndConnections(grouped, {}, NOW)).toThrow()
  })
})

describe('a reviewed row opened (T1 follow-up)', () => {
  it('reads its saved review and saves its ticks on that review only', () => {
    expect(manyReviewPaths(child({ publicationId: 'rev/1', productId: 'fam 1' }))).toEqual({
      review: '/api/products/fam%201/studio-publication/rev%2F1/review', selection: '/api/products/fam%201/studio-publication/rev%2F1/selection' })
    expect(manyReviewPaths(child({ productId: null }))).toBeNull()
  })
  it('lets the ticks change only while the review waits and nothing is being sent', () => {
    expect(manyRowEditable({ editable: true }, false)).toBe(true)
    expect(manyRowEditable({ editable: true }, true)).toBe(false)
    expect(manyRowEditable({ editable: false }, false)).toBe(false)
    expect(manyRowEditable(null, false)).toBe(false)
  })
  it('compares ticks regardless of order, so an unchanged choice is not saved again', () => {
    expect(tickKey(['b', 'a'])).toBe(tickKey(['a', 'b']))
    expect(tickKey(['a'])).not.toBe(tickKey(['a', 'b']))
    expect(tickKey(null)).toBe(tickKey([]))
  })
  it('says a ready row can be opened to change its ticks', () => {
    expect(manyRowLabel({ kind: 'ready', changes: 3 }).hint).toBe('Open the row to see or change the ticked fields.')
  })
})

describe('the products list joins markets and accounts with the studio rule', () => {
  it('keeps only healthy accounts, and refuses an unreadable inventory', () => {
    const grouped = { AMAZON: [{ id: 'm1', channel: 'AMAZON', code: 'DE', name: 'Amazon Germany', language: 'de' }] }
    const connections = { connections: [
      { id: 'ok', channel: 'AMAZON', accountLabel: 'Healthy', isActive: true, authStatus: 'connected' },
      { id: 'old', channel: 'AMAZON', accountLabel: 'Revoked', isActive: false },
    ] }
    const [market] = joinMarketsAndConnections(grouped, connections, NOW)
    expect(market).toMatchObject({ connected: true, accounts: [{ id: 'ok', label: 'Healthy' }] })
    expect(() => joinMarketsAndConnections(grouped, { connections: [{ channel: 'AMAZON' }] }, NOW)).toThrow()
  })
})
