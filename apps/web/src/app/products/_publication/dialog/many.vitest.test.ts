import { describe, expect, it } from 'vitest'
import type { PublicationBatchChild } from '@nexus/shared/studio-publication'
import type { PublishPlanBatchChild } from '@nexus/shared/publish-plan'
import { publicationStatusMeta } from '@/design-system/grid/renderers/publishStatus'
import {
  MAX_BATCH_PRODUCTS, estimateText, manyActionOptions, manyCapMessage, manyCheckButtonText, manyDestinationLabel, manyDestinationOptions, manyMarketName, manyPlan,
  manyCreatesSummary, manyStartAsHint, manyStartAsLine, manyStartAsOptions, START_AS_EACH_ROW, START_AS_EACH_ROW_HINT,
  manyPublishButtonText, manyRequest, manyReviewPaths, manyRowEditable, manyRowLabel, manyRowState, manyStatusButtonText, manyStatusMarketSummary, manyStatusPlan,
  manyStatusRowLabel, manyStatusRows, manyStatusSummary, manyStatusTabWords, manyStudioHref, reviewProgress, tickKey,
} from './many'
import {
  KEEP_CHANNEL_VALUES_HINT, KEEP_CHANNEL_VALUES_LABEL, keepChannelValuesState, manyBatchOptions, manyCheckingText, manyDiffersSummary, manyListedNote, manyListedSet,
  manyMarketTabWords, manyNotListedSummary, manyPlanSummary, manyRowSkipReason,
} from './many'
import { initialChoice, refillChoice } from './pickers'
import { batchChildMeta, limitOneAccountPerChannel } from './destinations'
import { publicationDestinations, publicationScopeKey } from './model'
import { joinMarketsAndConnections } from './useBusinessDestinations'

/** A row as the window reads it: the shared batch child's O5 facts (`notListed`, `differs`) on a content child. */
type ManyRowChild = PublicationBatchChild & Pick<PublishPlanBatchChild, 'notListed' | 'differs'>
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
    expect(plan).toEqual({ listings: 2, changes: 8, problems: 1, expired: 1, nothing: 1, problemCount: 1, markets: 1, notListed: 0 })
    // One-click O5 — the studio's words: changes to markets.
    expect(manyPublishButtonText(plan)).toBe('Publish 8 changes to 1 market · skip 1 with problems · 1 expired')
    expect(manyPublishButtonText(manyPlan([child()], NOW))).toBe('Publish 3 changes to 1 market')
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
    // One-click O5 — Keep channel values on: sent as replaceDiffers false (off = Nexus wins = true).
    expect(manyRequest(['x'], [{ channel: 'AMAZON', marketplace: 'IT', accountId: 'a', listingId: 'l' }], true))
      .toEqual({ productIds: ['x'], destinations: [{ channel: 'AMAZON', marketplace: 'IT', accountId: 'a' }], options: { replaceDiffers: false } })
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

/** Build shape v2 (P11) — the Action picker: one Status for many products × markets. */
describe('a Status for many products', () => {
  type Child = import('@nexus/shared/publish-plan').PublishPlanBatchChild
  const life = (over: Partial<Child> = {}): Child => ({
    ...child({ selectedCount: null, nothingToSend: false }), kind: 'lifecycle', action: 'pause', step: 'pause', rows: null, sendCount: 2,
    planRows: [
      { productId: 'v1', listingId: 'l1', sku: 'GALE-S', plan: 'send', sentence: 'Paused on Amazon · DE.' },
      { productId: 'v2', listingId: 'l2', sku: 'GALE-M', plan: 'send', sentence: 'Paused on Amazon · DE.' },
      { productId: 'v3', listingId: 'l3', sku: 'GALE-L', plan: 'refused', sentence: 'Amazon holds FBA units for this offer.' },
    ], marketplace: 'DE', ...over,
  } as Child)

  it('offers Send changes and the three Status targets; Ended only with permission to delete', () => {
    expect(manyActionOptions(true).map(o => o.label)).toEqual(['Send changes', 'Set Active', 'Set Inactive', 'Set Ended'])
    expect(manyActionOptions(false).find(o => o.value === 'ended')).toMatchObject({ disabled: true })
  })

  it('reaches every channel for a Status, and asks for the Status alone', () => {
    const markets = [
      { channel: 'AMAZON', code: 'DE', name: 'Amazon Germany', accounts: [{ id: 'a', label: 'Xavia' }] },
      { channel: 'SHOPIFY', code: 'GLOBAL', name: 'Shopify', accounts: [{ id: 's', label: 'Store' }] },
    ]
    expect(manyDestinationOptions(publicationDestinations(markets), 'inactive').map(o => o.scope.channel)).toEqual(['AMAZON', 'SHOPIFY'])
    expect(manyRequest(['x'], [{ channel: 'AMAZON', marketplace: 'DE', accountId: 'a' }], true, 'inactive').options).toEqual({ status: 'inactive', content: false })
  })

  it('merges a product × market into one row, counts what changes and what cannot, and writes the counted button', () => {
    const rows = manyStatusRows([
      life(),
      life({ publicationId: 'p2', productId: 'fam2', familySku: 'NOVA', sendCount: 0, nothingToSend: true, message: 'Nothing to change: every listing here is already inactive, or not on the channel.',
        planRows: [{ productId: 'n1', listingId: 'n1', sku: 'NOVA-S', plan: 'skip', sentence: 'Already inactive.' }] }),
      life({ publicationId: 'p3', marketplace: 'IT', sendCount: 3, planRows: [] }),
      { ...child({ publicationId: 'p4', productId: 'fam3', marketplace: 'DE', status: 'NOT_SENT', message: 'Nothing was sent. The channel could not be read.' }), kind: 'content', action: null, step: 'content', rows: null } as Child,
    ], NOW)
    expect(rows.map(r => r.state)).toEqual(['ready', 'nothing', 'ready', 'not_checked'])
    expect(rows[0]).toMatchObject({ send: 2, refused: 1 })
    expect(rows[3].reason).toBe('The channel could not be read.')
    const plan = manyStatusPlan(rows, NOW)
    expect(plan).toMatchObject({ listings: 5, markets: 2, refused: 1, nothing: 1, notChecked: 1, ending: 0 })
    expect(manyStatusButtonText(plan, 'inactive')).toBe('Set 5 listings inactive on 2 markets')
    expect(manyStatusSummary(plan, 'inactive')).toBe('5 listings to set inactive in 2 markets · 1 cannot · 1 with nothing to change · 1 not checked')
    const de = rows.filter(r => r.marketplace === 'DE')
    expect(manyStatusMarketSummary(de, 'inactive', 'Amazon · DE')).toEqual({
      line: 'Inactive on Amazon · DE: 2 listings · 1 cannot · 1 product with nothing to change · 1 not checked',
      reasons: ['1 listing: Amazon holds FBA units for this offer.'],
    })
    expect(manyStatusTabWords(de, 'reviewed')).toBe('2 listings')
    expect(manyStatusRowLabel(rows[0], 'inactive')).toMatchObject({ label: 'Set Inactive', tone: 'warning' })
    expect(manyStatusButtonText({ listings: 0, markets: 0 }, 'active')).toBe('Nothing to change')
    expect(manyStatusButtonText({ listings: 36, markets: 2 }, 'ended')).toBe('End 36 listings on 2 markets')
    // A product × market where every listing is refused counts under "cannot", not "nothing to change".
    const refusedOnly = manyStatusRows([life({ sendCount: 0, nothingToSend: true, message: 'Not possible here: Amazon has no End.',
      planRows: [{ productId: 'v1', listingId: 'l1', sku: 'GALE-S', plan: 'refused', sentence: 'Amazon has no End.' }] })], NOW)
    expect(refusedOnly[0]).toMatchObject({ state: 'refused', reason: 'Not possible here: Amazon has no End.' })
    expect(manyStatusPlan(refusedOnly, NOW)).toMatchObject({ refused: 1, nothing: 0 })
  })

  it('Ended asks for the count the server checks: waiting End children not expired', () => {
    const rows = manyStatusRows([life({ action: 'end', step: 'end', sendCount: 30 }), life({ publicationId: 'p2', productId: 'fam2', action: 'end', step: 'end', sendCount: 6 }),
      life({ publicationId: 'p3', productId: 'fam3', action: 'end', step: 'end', sendCount: 4, expiresAt: EARLIER })], NOW)
    expect(rows.map(r => r.state)).toEqual(['ready', 'ready', 'expired'])
    expect(manyStatusPlan(rows, NOW).ending).toBe(36)
    expect(manyMarketName({ channel: 'AMAZON', marketplace: 'DE' })).toBe('Amazon · DE')
    expect(manyMarketName({ channel: 'SHOPIFY', marketplace: 'GLOBAL' })).toBe('Shopify')
  })
})

describe('new listings start as (ND4 B)', () => {
  it('offers As each row says · Active · Inactive, each with what it does', () => {
    expect(manyStartAsOptions().map(o => [o.value, o.label])).toEqual([['', START_AS_EACH_ROW], ['active', 'Active'], ['inactive', 'Inactive']])
    expect(manyStartAsHint(null)).toBe(START_AS_EACH_ROW_HINT)
    expect(manyStartAsHint('inactive')).toMatch(/^Every listing these changes create waits, not selling/)
    expect(manyStartAsLine('inactive')).toBe('New listings start as: Inactive')
    expect(manyStartAsLine(null)).toBeNull()
  })

  it('sends startAs only with the changes, and only when chosen', () => {
    const scope = [{ channel: 'AMAZON', marketplace: 'IT', accountId: 'a' }]
    expect(manyRequest(['x'], scope, false, 'content', 'inactive').options).toEqual({ replaceDiffers: true, startAs: 'inactive' })
    expect(manyRequest(['x'], scope, false, 'content', null).options).toEqual({ replaceDiffers: true })
    expect(manyRequest(['x'], scope, false, 'active', 'inactive').options).toEqual({ status: 'active', content: false })
  })

  it('counts what the ready rows create for the summary line', () => {
    const rows = [
      child({ creates: [{ productId: 'm', sku: 'GALE-M', startsAs: 'inactive' }, { productId: 'l', sku: 'GALE-L', startsAs: 'inactive' }] }),
      child({ publicationId: 'p2', creates: [{ productId: 'n', sku: 'NOVA', startsAs: 'active' }] }),
      child({ publicationId: 'p3', status: 'BLOCKED', creates: [{ productId: 'z', sku: 'ZED', startsAs: 'active' }] }),
    ]
    expect(manyCreatesSummary(rows, NOW)).toBe('3 new listings (2 inactive)')
    expect(manyCreatesSummary([rows[0]], NOW)).toBe('2 new listings (all inactive)')
    expect(manyCreatesSummary([child()], NOW)).toBeNull()
  })
})

describe('the studio window\'s rules in the products list (One-click O5)', () => {
  const notListed = (over: Partial<ManyRowChild> = {}): ManyRowChild => ({ ...child({ publicationId: 'nl', status: 'NOT_SENT', selectedCount: null,
    message: 'Skipped GALE on Amazon · DE: not listed there. Choose “New listings start as” to create it.', summary: { notReviewed: true, notListed: true } }),
    notListed: true, ...over } as ManyRowChild)
  const markets = [
    { channel: 'AMAZON', code: 'IT', name: 'Amazon Italy', accounts: [{ id: 'a', label: 'Xavia' }] },
    { channel: 'AMAZON', code: 'DE', name: 'Amazon Germany', accounts: [{ id: 'a', label: 'Xavia' }] },
    { channel: 'AMAZON', code: 'FR', name: 'Amazon France', accounts: [{ id: 'a', label: 'Xavia' }] },
    { channel: 'EBAY', code: 'IT', name: 'eBay Italy', accounts: [{ id: 'e', label: 'Xavia' }] },
  ]
  const options = publicationDestinations(markets)
  const keyOf = (channel: string, marketplace: string, accountId: string) => publicationScopeKey({ channel, marketplace, accountId })

  it('starts with every market of the first channel and account where a ticked product is listed; another channel refills the same way', () => {
    const listed = { families: 3, markets: [{ channel: 'AMAZON', marketplace: 'DE', accountId: 'a', families: 1 }, { channel: 'AMAZON', marketplace: 'IT', accountId: 'a', families: 2 },
      { channel: 'EBAY', marketplace: 'IT', accountId: 'e', families: 1 }] }
    const set = manyListedSet(listed)!
    const first = initialChoice(options, [], set)
    expect(first).toEqual({ channel: 'AMAZON', accountId: 'a', keys: [keyOf('AMAZON', 'IT', 'a'), keyOf('AMAZON', 'DE', 'a')] })
    expect(refillChoice(options, first, { channel: 'EBAY', accountId: 'e', keys: [] }, set).keys).toEqual([keyOf('EBAY', 'IT', 'e')])
    expect(manyListedNote(2, listed)).toBe('Chosen: the 2 markets where these products are listed (Active or Inactive). Remove any you do not want.')
    expect(manyListedNote(0, { families: 1, markets: [] })).toContain('not listed (Active or Inactive) in any market yet')
    expect(manyListedNote(2, null)).toBeNull()
    expect(manyListedSet(null)).toBeNull()
  })

  it('Keep channel values: off by default means Nexus wins; the words say both sides', () => {
    expect(KEEP_CHANNEL_VALUES_LABEL).toBe('Keep channel values')
    expect(KEEP_CHANNEL_VALUES_HINT).toBe('Leave values changed on the channel as they are.')
    expect(keepChannelValuesState(false)).toMatch(/^Off: Nexus wins/)
    expect(keepChannelValuesState(true)).toMatch(/^On: only what Nexus changed is sent/)
    expect(manyBatchOptions({ request: { families: 1, destinations: 1, reviews: 1, reviewed: 1, options: { keepChannelValues: true, startAs: 'inactive', status: null, content: true } } },
      { keepChannelValues: false, startAs: null })).toEqual({ keepChannelValues: true, startAs: 'inactive' })
    expect(manyBatchOptions(null, { keepChannelValues: false, startAs: null })).toEqual({ keepChannelValues: false, startAs: null })
  })

  it('a family not listed in a market is skipped there with its reason, not counted as a problem', () => {
    expect(manyRowState(notListed(), NOW)).toEqual({ kind: 'not_listed', reason: expect.stringContaining('Skipped GALE on Amazon · DE: not listed there') })
    expect(manyRowLabel(manyRowState(notListed(), NOW))).toMatchObject({ label: 'Not listed', tone: 'neutral' })
    const plan = manyPlan([child(), notListed(), child({ publicationId: 'p3', status: 'BLOCKED' })], NOW)
    expect(plan).toMatchObject({ listings: 1, notListed: 1, problems: 1, markets: 1 })
    expect(manyPublishButtonText(plan)).toBe('Publish 3 changes to 1 market · skip 1 with problems')
    expect(manyPlanSummary(plan)).toBe('1 product ready in 1 market · 3 changes · 1 with problems · 1 not listed there')
    expect(manyNotListedSummary([notListed(), notListed({ publicationId: 'nl2' }), child()], 'Amazon · DE', NOW))
      .toBe('2 products are not listed on Amazon · DE, so they are skipped. Choose “New listings start as” to create them.')
    expect(manyNotListedSummary([child()], 'Amazon · DE', NOW)).toBeNull()
    expect(manyRowSkipReason(notListed())).toContain('not listed there')
    expect(manyRowSkipReason(child({ status: 'NOT_SENT', message: 'Nothing was sent. No Amazon draft here.', summary: { notReviewed: true } }))).toBe('No Amazon draft here.')
    expect(manyRowSkipReason(child())).toBeNull()
    expect(manyRowSkipReason(child({ status: 'NOT_SENT', nothingToSend: true, summary: { nothingToSend: true } }))).toBeNull()
  })

  it('counts markets for the one button, and says how far the check is', () => {
    const de = { channel: 'AMAZON', marketplace: 'DE', accountId: 'acc' }
    const rows = [child(), child({ publicationId: 'p2', productId: 'fam2', selectedCount: 4 }), child({ publicationId: 'p3', ...de, selectedCount: 2 })]
    expect(manyPublishButtonText(manyPlan(rows, NOW))).toBe('Publish 9 changes to 2 markets')
    const keys = [keyOf('AMAZON', 'IT', 'acc'), keyOf('AMAZON', 'DE', 'acc'), keyOf('AMAZON', 'FR', 'acc')]
    expect(manyCheckingText(rows, keys, 2)).toBe('Checking 2 of 3 markets…')
    expect(manyCheckingText([], keys, 2)).toBe('Checking 1 of 3 markets…')
    expect(manyMarketTabWords(rows.slice(2), 'reviewing', 2, NOW)).toBe('checking…')
    expect(manyMarketTabWords(rows.slice(0, 2), 'reviewing', 2, NOW)).toBe('7 changes')
    expect(manyMarketTabWords([notListed(), notListed({ publicationId: 'x', productId: 'fam2' })], 'reviewed', 2, NOW)).toBe('not listed')
    expect(manyMarketTabWords([child({ status: 'BLOCKED' })], 'reviewed', 1, NOW)).toBe('1 with problems')
  })

  it('each market tab says how many values differ from Nexus, and whether Publish replaces them (O1\'s words)', () => {
    const differs = (total: number, ticked: number, over: Partial<ManyRowChild> = {}) => child({ differs: { total, ticked }, ...over } as Partial<ManyRowChild>)
    expect(manyDiffersSummary([differs(7, 7), differs(5, 5, { publicationId: 'p2' })], 'Amazon · IT', NOW)).toBe('12 values on Amazon · IT differ from Nexus. Publish replaces them.')
    expect(manyDiffersSummary([differs(1, 1)], 'Amazon · IT', NOW)).toBe('1 value on Amazon · IT differs from Nexus. Publish replaces it.')
    expect(manyDiffersSummary([differs(3, 0)], 'eBay · IT', NOW)).toBe('3 values on eBay · IT differ from Nexus. Publish keeps them.')
    expect(manyDiffersSummary([differs(3, 2)], 'eBay · IT', NOW)).toBe('3 values on eBay · IT differ from Nexus. Publish replaces 2 of them.')
    // Only rows ready to send count; none differing → no line.
    expect(manyDiffersSummary([differs(4, 4, { status: 'BLOCKED' })], 'Amazon · IT', NOW)).toBeNull()
    expect(manyDiffersSummary([child()], 'Amazon · IT', NOW)).toBeNull()
  })
})
