/**
 * Google Ads step 1b, WB — the campaign window's tabs and the grain grids: which tabs a campaign has, Google's words,
 * "Not read yet" (never 0, never an empty list), and the grids' columns (words, then the nine metric columns, totals
 * from the sums). Made-up values only.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { GoogleCampaignAutomation, GoogleMetrics, GoogleNegative, GoogleNegativeList, GoogleOutsideChange, GoogleRead } from '@/lib/google-ads/contract'
import { METRIC_COLUMN_KEYS, metricColumns } from './googleAds'
import {
  accountListNote, activeNegatives, listScopes, adGroupTypeLabel, adStrengthWord, brandKey, brandLabel, brandRuleText, CAMPAIGN_NOT_HERE, campaignOutsideChanges, campaignTabOf,
  campaignTabs, campaignWindowBody,
  emptyText, finalUrlText, flagsOnCount, flagWord, grainView, keywordWord, lastTryText, matchTypeLabel, negativeLevelText, negativeListRows,
  negativeMatchLabel, negativesMissingText, negativesRead, negativeText, notReadText, NOUN, primaryWord, productIssuesText, productStatusWord,
  readNoteText,
} from './googleGrains'
import { adGroupColumns } from './GoogleAdGroupsTab'
import { assetGroupColumns } from './GoogleAssetGroupsTab'
import { keywordAdGroupOptions, keywordColumns } from './GoogleKeywordsTab'
import { productColumns } from './GoogleProductsGrid'
import { searchTermColumns } from './GoogleSearchTermsGrid'

const read = (over: Partial<GoogleRead> = {}): GoogleRead => ({
  resource: 'KEYWORDS', readAt: '2026-10-12T06:30:00Z', lastAttemptAt: '2026-10-12T06:30:00Z', lastStatus: 'SUCCESS', lastError: null, ...over,
})
const never = (over: Partial<GoogleRead> = {}) => read({ readAt: null, lastAttemptAt: null, lastStatus: null, ...over })
const metrics = (over: Partial<GoogleMetrics> = {}): GoogleMetrics => ({
  impressions: 1000, clicks: 50, spendCents: 2500, conversions: 2, conversionValueCents: 10000, ctr: 0.05, avgCpcCents: 50, roas: 4, costPerConversionCents: 1250, ...over,
})

describe('campaignTabs — a tab that does not apply is absent', () => {
  it('Search, Shopping, Performance Max and other types', () => {
    expect(campaignTabs('SEARCH', 'ENABLED')).toEqual(['overview', 'ad-groups', 'keywords', 'negatives', 'search-terms', 'on-its-own', 'changes'])
    expect(campaignTabs('SHOPPING', 'ENABLED')).toEqual(['overview', 'ad-groups', 'products', 'negatives', 'search-terms', 'on-its-own', 'changes'])
    expect(campaignTabs('PERFORMANCE_MAX', 'PAUSED')).toEqual(['overview', 'asset-groups', 'products', 'negatives', 'search-terms', 'on-its-own', 'changes'])
    expect(campaignTabs('DISPLAY', 'ENABLED')).toEqual(['overview', 'ad-groups', 'on-its-own', 'changes'])
    expect(campaignTabs('DEMAND_GEN', 'REMOVED')).toEqual(['overview', 'ad-groups', 'on-its-own', 'changes'])
  })

  it('settings not read yet (no status, or type UNKNOWN): only what Nexus knows — its days and its changes', () => {
    expect(campaignTabs('SEARCH', null)).toEqual(['overview', 'changes'])
    expect(campaignTabs('UNKNOWN', 'ENABLED')).toEqual(['overview', 'changes'])
    expect(campaignTabs('', 'ENABLED')).toEqual(['overview', 'changes'])
  })

  it('the address picks the tab only when the campaign has it', () => {
    const tabs = campaignTabs('SHOPPING', 'ENABLED')
    expect(campaignTabOf('products', tabs)).toBe('products')
    expect(campaignTabOf('keywords', tabs)).toBe('overview')
    expect(campaignTabOf('nonsense', tabs)).toBe('overview')
    expect(campaignTabOf(null, tabs)).toBe('overview')
  })
})

describe('campaignWindowBody — an address with a campaign that is not in this business', () => {
  it('404: a notice in plain words, never an error with Try again', () => {
    expect(campaignWindowBody({ hasCampaign: false, loading: false, status: 404 })).toBe('not_here')
    expect(CAMPAIGN_NOT_HERE).toBe('This campaign is not in this business’s Google Ads account.')
  })

  it('any other failure (or an answer without the campaign) keeps Try again; reading shows as reading', () => {
    expect(campaignWindowBody({ hasCampaign: false, loading: false, status: 500 })).toBe('error')
    expect(campaignWindowBody({ hasCampaign: false, loading: false, status: 403 })).toBe('error')
    expect(campaignWindowBody({ hasCampaign: false, loading: false, status: null })).toBe('error')
    expect(campaignWindowBody({ hasCampaign: false, loading: true, status: null })).toBe('loading')
  })

  it('a campaign on hand (the grid row) shows at once, whatever its days read did', () => {
    expect(campaignWindowBody({ hasCampaign: true, loading: true, status: null })).toBe('campaign')
    expect(campaignWindowBody({ hasCampaign: true, loading: false, status: 404 })).toBe('campaign')
  })
})

describe('Not read yet — never an empty list, never 0', () => {
  const base = { noun: NOUN.keyword, scope: 'campaign' as const, windowed: true, nextReadAt: '2026-10-14T06:25:00Z', timeZone: 'UTC' }

  it('a list never read says so, with the next read, and shows no grid', () => {
    const v = grainView({ ...base, read: never(), count: 0 })
    expect(v.kind).toBe('not_read')
    expect(v.text).toBe('Nexus has not read this campaign’s keywords from Google yet. It reads them in the next daily read (next: 14 Oct 2026, 06:25).')
  })

  it('never read, even when the server sent rows: still not read', () => {
    expect(grainView({ ...base, read: never(), count: 3 }).kind).toBe('not_read')
    expect(grainView({ ...base, read: null, count: 3 }).kind).toBe('not_read')
  })

  it('a first read that failed says why; one put off for the daily allowance says that', () => {
    expect(grainView({ ...base, read: never({ lastStatus: 'FAILED', lastError: 'Google answered 500.' }), count: 0 }).text).toMatch(/The last try failed: Google answered 500\.$/)
    expect(notReadText(NOUN.product, 'account', never({ lastStatus: 'SKIPPED_BUDGET' }), null)).toBe(
      'Nexus has not read the products of this account from Google yet. It reads them in the next daily read. The last read was put off: Nexus had used its daily allowance of Google requests.',
    )
  })

  it('read with nothing in it: Google reported none (an empty list is only an answer)', () => {
    const v = grainView({ ...base, read: read(), count: 0 })
    expect(v.kind).toBe('empty')
    expect(v.text).toBe('Google reported no keywords for this campaign in these days.')
    expect(emptyText(NOUN.negative, 'campaign', false)).toBe('Google reported no negative keywords for this campaign.')
    expect(emptyText(NOUN.searchTerm, 'account', true)).toBe('Google reported no search terms for this account in these days.')
  })

  it('a later read that failed keeps the earlier one, and says which read is shown', () => {
    const v = grainView({ ...base, read: read({ lastStatus: 'FAILED', lastError: 'Timed out.' }), count: 4 })
    expect(v.kind).toBe('ok')
    expect(v.notes[0]).toEqual({ tone: 'warning', text: 'The last try failed: Timed out. This shows the read of 12 Oct 2026, 06:30.' })
  })

  it('a good read that read fewer days says so as information, never as a failure — the list\'s own read and its numbers\' read', () => {
    const fewer = 'Google sent more than 200,000 rows of daily numbers for the first 90 days, so Nexus read the last 45 days instead. Older days are not read.'
    expect(readNoteText(read({ lastError: fewer }))).toBe(fewer)
    expect(readNoteText(read({ lastError: '  ' }))).toBeNull()
    expect(readNoteText(read({ lastStatus: 'FAILED', lastError: 'Timed out.' }))).toBeNull()
    expect(lastTryText(read({ lastError: fewer }))).toBeNull()
    // Search terms: the list is its numbers.
    expect(grainView({ ...base, read: read({ resource: 'SEARCH_TERM_DAYS', lastError: fewer }), count: 4 }).notes).toEqual([{ tone: 'info', text: fewer }])
    // Over an empty list too.
    expect(grainView({ ...base, read: read({ lastError: fewer }), count: 0 })).toMatchObject({ kind: 'empty', notes: [{ tone: 'info', text: fewer }] })
    // Keywords: the numbers come from another read; the same sentence twice is said once (products' list read can be its numbers).
    const numbers = read({ resource: 'KEYWORD_DAYS', lastError: fewer })
    expect(grainView({ ...base, read: read(), numbersRead: numbers, count: 4 }).notes).toEqual([{ tone: 'info', text: fewer }])
    expect(grainView({ ...base, read: numbers, numbersRead: numbers, count: 4 }).notes).toEqual([{ tone: 'info', text: fewer }])
    // A failed later read still warns first; the note of an earlier good read is not on the state any more.
    expect(grainView({ ...base, read: read({ lastStatus: 'FAILED', lastError: 'Timed out.' }), numbersRead: numbers, count: 4 }).notes.map((n) => n.tone)).toEqual(['warning', 'info'])
  })

  it('numbers not read: said once, and no day-gap note (there are no days to miss)', () => {
    const v = grainView({ ...base, read: read(), numbersRead: never(), coverage: { daysInWindow: 30, daysRead: 0, missingDays: ['2026-10-01'] }, count: 4 })
    expect(v.notes).toEqual([{ tone: 'info', text: 'Nexus has not read the numbers of these keywords yet. They show as — until it does.' }])
  })

  it('days not read at this grain: the step-1a words; a list cut at its cap says so', () => {
    const v = grainView({ ...base, read: read(), numbersRead: read(), coverage: { daysInWindow: 30, daysRead: 28, missingDays: ['2026-10-03', '2026-10-04'] }, count: 500, truncated: true })
    expect(v.notes.map((n) => n.text)).toEqual([
      'No Google numbers for 3 Oct – 4 Oct 2026; totals leave them out.',
      'There are more keywords than this window loads at once. The list and its totals show the first 500.',
    ])
  })

  it('negatives: three reads as one; a part not read is named', () => {
    const r = { adGroup: read({ resource: 'KEYWORDS' }), campaign: read({ resource: 'CAMPAIGN_NEGATIVES' }), lists: never({ resource: 'NEGATIVE_LISTS' }) }
    const s = negativesRead(r)
    expect(s.read.readAt).not.toBeNull()
    expect(negativesMissingText(s.missing)).toBe('Nexus has not read the negative keyword lists yet, so they are not in this list.')
    const none = negativesRead({ adGroup: never(), campaign: never(), lists: never() })
    expect(none.read.readAt).toBeNull()
    expect(negativesMissingText(none.missing)).toBeNull()
  })
})

describe('Google’s words', () => {
  it('match types', () => {
    expect([matchTypeLabel('EXACT'), matchTypeLabel('PHRASE'), matchTypeLabel('BROAD'), matchTypeLabel(null)]).toEqual(['Exact', 'Phrase', 'Broad', '—'])
  })

  it('what stops a keyword showing: Disapproved, Under review, Rarely shown; nothing for a removed one', () => {
    const k = { status: 'ENABLED' as const, approvalStatus: 'APPROVED', servingStatus: 'ELIGIBLE', primaryStatus: 'ELIGIBLE' }
    expect(keywordWord(k)).toBeNull()
    expect(keywordWord({ ...k, approvalStatus: 'DISAPPROVED' })).toEqual({ text: 'Disapproved', tone: 'danger' })
    expect(keywordWord({ ...k, approvalStatus: 'UNDER_REVIEW' })).toEqual({ text: 'Under review', tone: 'warning' })
    expect(keywordWord({ ...k, servingStatus: 'RARELY_SERVED' })).toEqual({ text: 'Rarely shown', tone: 'warning' })
    expect(keywordWord({ ...k, primaryStatus: 'LIMITED' })).toEqual({ text: 'Limited', tone: 'warning' })
    expect(keywordWord({ ...k, status: 'REMOVED', approvalStatus: 'DISAPPROVED' })).toBeNull()
    expect(keywordWord({ ...k, status: null, approvalStatus: 'DISAPPROVED' })).toBeNull()
  })

  it('serving beyond the status', () => {
    expect(primaryWord({ status: 'ENABLED', primaryStatus: 'NOT_ELIGIBLE' })).toEqual({ text: 'Not eligible', tone: 'danger' })
    expect(primaryWord({ status: 'ENABLED', primaryStatus: 'ELIGIBLE' })).toBeNull()
    expect(primaryWord({ status: 'ENABLED', primaryStatus: 'SOMETHING_NEW' })).toEqual({ text: 'Something new', tone: 'neutral' })
  })

  it('ad group types, ad strength, final URLs', () => {
    expect(adGroupTypeLabel('SEARCH_STANDARD')).toBe('Standard')
    expect(adGroupTypeLabel('VIDEO_TRUE_VIEW_IN_STREAM')).toBe('Video')
    expect(adGroupTypeLabel(null)).toBe('—')
    expect(adStrengthWord('EXCELLENT')).toEqual({ text: 'Excellent', tone: 'success' })
    expect(adStrengthWord('POOR')).toEqual({ text: 'Poor', tone: 'danger' })
    expect(adStrengthWord(null).text).toBe('—')
    expect(finalUrlText(['https://shop.example/helmets/', 'https://shop.example/a', 'https://shop.example/b'])).toBe('shop.example/helmets +2')
    expect(finalUrlText([])).toBe('—')
  })

  it('product status: "Not read yet" when Nexus has not read it — never "Eligible"; issues in Google’s words, worst first', () => {
    expect(productStatusWord(null)).toEqual({ text: 'Not read yet', tone: 'neutral' })
    expect(productStatusWord('not_eligible')).toEqual({ text: 'Not eligible', tone: 'danger' })
    expect(productStatusWord('no_issue').text).toBe('Eligible')
    const issue = (severity: string, text: string) => ({ code: 'x', severity, text, explanation: null, helpUrl: null, regions: [] })
    expect(productIssuesText({ issues: [issue('WARNING', 'Image too small'), issue('DISAPPROVED', 'Missing price')] })).toBe('Missing price\nImage too small')
    expect(productIssuesText({ issues: [] })).toBeNull()
  })

  it('brand: no brand words → "—" for every term, never "Not brand"', () => {
    expect([brandLabel(true), brandLabel(false), brandLabel(null)]).toEqual(['Brand', 'Not brand', '—'])
    expect([brandKey(true), brandKey(false), brandKey(null)]).toEqual(['brand', 'non_brand', ''])
    expect(brandRuleText([])).toBe('Nexus does not know the brand words (your protected terms) yet, so it cannot split brand searches from the rest.')
    expect(brandRuleText(['acme', ' acme moto '])).toBe('A search counts as brand when it matches one of the brand words (your protected terms): “acme”, “acme moto”.')
    expect(brandRuleText(['a', 'b', 'c'], 2)).toBe('A search counts as brand when it matches one of the brand words (your protected terms): “a”, “b” and 1 more.')
  })

  it('one word for brand on the search terms tab: "brand words (your protected terms)" in its sentence, then "brand words"', () => {
    const tip = searchTermColumns('EUR', true).find((c) => c.key === 'brand')!.tip!
    expect(tip).toBe('Brand when the search matches one of the brand words; “—” when Nexus does not know them.')
    // The tab's own words (the sentence, the column tip, the tiles, the link) name them one way.
    const tab = readFileSync(fileURLToPath(new URL('./GoogleSearchTermsGrid.tsx', import.meta.url)), 'utf8')
    const shown = [brandRuleText([]), brandRuleText(['acme']), tip, ...[...tab.matchAll(/'([^'\n]*brand[^'\n]*)'/gi)].map((m) => m[1])]
    for (const words of shown) expect({ words, protectedOutsideTheName: /protected term/i.test(words.replace('brand words (your protected terms)', '')) }).toEqual({ words, protectedOutsideTheName: false })
    expect(shown.filter((w) => /brand names/i.test(w))).toEqual([])
  })

  it('negatives: the words, the match type, where they are set; removed ones left out, A→Z', () => {
    const n = (over: Partial<GoogleNegative>): GoogleNegative => ({
      negativeId: 'n1', level: 'campaign', kind: 'keyword', text: 'free', matchType: 'PHRASE', campaignId: 'c1', externalCampaignId: '111', campaignName: 'Shop',
      adGroupId: null, adGroupName: null, listId: null, listName: null, status: 'ENABLED', seenAt: '2026-10-12T06:30:00Z', ...over,
    })
    expect(negativeText(n({}))).toBe('free')
    expect(negativeText(n({ kind: 'brand_list', text: null, listName: 'Other brands' }))).toBe('Other brands')
    expect(negativeMatchLabel(n({ kind: 'brand_list' }))).toBe('Brand list')
    expect(negativeLevelText(n({ level: 'ad_group', adGroupName: 'Helmets' }))).toBe('Ad group: Helmets')
    expect(negativeLevelText(n({ level: 'list', listName: 'Account-wide' }))).toBe('List: Account-wide')
    expect(negativeLevelText(n({}))).toBe('Campaign')
    // The account-level list: "Whole account" only when Google applies it; not in use, or not read yet, in words.
    const scopes = listScopes([
      { listId: 'l9', accountLevel: true, appliesToAccount: true }, { listId: 'l8', accountLevel: true, appliesToAccount: false },
      { listId: 'l7', accountLevel: true, appliesToAccount: null }, { listId: 'l2', accountLevel: false, appliesToAccount: false },
      { listId: 'l3', accountLevel: null, appliesToAccount: null },
    ])
    const setOn = (listId: string) => negativeLevelText(n({ level: 'list', listId, listName: `Test ${listId}` }), scopes)
    expect(['l9', 'l8', 'l7', 'l2', 'l3'].map(setOn)).toEqual([
      'Whole account: Test l9', 'Account-level list, not in use: Test l8', 'Account-level list: Test l7', 'List: Test l2', 'List: Test l3',
    ])
    const state = (accountLevel: boolean | null, appliesToAccount: boolean | null, status = 'ENABLED') => ({ accountLevel, appliesToAccount, status })
    expect(accountListNote([state(true, true)])).toBe('Whole account: Google applies this list to every campaign that shows on Google Search or Shopping.')
    expect(accountListNote([state(true, false)])).toBe('Not in use: Google does not apply this account-level list, so it blocks nothing.')
    expect(accountListNote([state(true, null), state(false, false)])).toBe('Nexus has not read yet whether the account-level list is in use.')
    expect(accountListNote([state(false, false), state(null, null), state(true, true, 'REMOVED')])).toBeNull()
    expect(activeNegatives([n({ negativeId: 'a', text: 'used' }), n({ negativeId: 'b', text: 'Cheap' }), n({ negativeId: 'c', text: 'gone', status: 'REMOVED' })]).map((x) => x.negativeId)).toEqual(['b', 'a'])
    const list = (listId: string, name: string, accountLevel: boolean | null, appliesToAccount: boolean | null, over: Partial<GoogleNegativeList> = {}): GoogleNegativeList =>
      ({ listId, externalListId: listId, name, status: 'ENABLED', memberCount: 3, accountLevel, appliesToAccount, campaigns: [], seenAt: '', ...over })
    expect(negativeListRows([
      list('l2', 'Jobs', false, false, { memberCount: 12, campaigns: [{ campaignId: 'c1', externalCampaignId: '111', name: 'Shop' }] }),
      list('l1', 'Free', null, null, { memberCount: null }),
      list('l3', 'Old', false, false, { status: 'REMOVED' }),
      list('l9', 'Account negatives', true, true),
      list('l8', 'Account spare', true, false),
      list('l7', 'Account unread', true, null),
    ])).toEqual([
      { id: 'l9', cells: ['Account negatives', '3', 'Whole account'] },
      { id: 'l8', cells: ['Account spare', '3', 'Not in use'] },
      { id: 'l7', cells: ['Account unread', '3', 'Account-level list'] },
      { id: 'l1', cells: ['Free', '—', '0 campaigns'] },
      { id: 'l2', cells: ['Jobs', '12', '1 campaign'] },
    ])
  })

  it('flags: null is "Not read yet", never "Off"; the count of settings on is null when none was read', () => {
    expect([flagWord('on').text, flagWord('off').text, flagWord('not_applicable').text, flagWord(null).text]).toEqual(['On', 'Off', '—', 'Not read yet'])
    const flags: Pick<GoogleCampaignAutomation, 'aiMax' | 'campaignBroadMatch' | 'finalUrlExpansion' | 'textCustomization' | 'searchPartners' | 'displayExpansion' | 'dynamicSearchAds'> = {
      aiMax: 'on', campaignBroadMatch: 'off', finalUrlExpansion: 'on', textCustomization: 'not_applicable', searchPartners: null, displayExpansion: 'off', dynamicSearchAds: null,
    }
    expect(flagsOnCount(flags)).toBe(2)
    expect(flagsOnCount({ ...flags, aiMax: null, campaignBroadMatch: null, finalUrlExpansion: null, textCustomization: null, displayExpansion: null })).toBeNull()
  })

  it('one campaign’s changes made outside Nexus: its own only, newest first, who in words, never an e-mail', () => {
    const ch = (over: Partial<GoogleOutsideChange>): GoogleOutsideChange => ({
      changedAt: '2026-10-10T08:00:00Z', campaignId: 'c1', externalCampaignId: '111', campaignName: 'Shop', resourceType: 'CAMPAIGN', operation: 'UPDATE',
      changedFields: [], source: 'google_ads_web', sourceText: 'Google Ads website', who: 'person', watched: false, summary: 'Budget changed', ...over,
    })
    const rows = campaignOutsideChanges([
      ch({ changedAt: '2026-10-09T08:00:00Z', summary: 'Changed by someone@example.com' }),
      ch({ changedAt: '2026-10-11T08:00:00Z', who: 'google_auto_apply', source: 'google_automatic' }),
      ch({ externalCampaignId: '222' }),
    ], '111', 'UTC')
    expect(rows.map((r) => r.cells)).toEqual([
      ['11 Oct 2026, 08:00', 'Google, by auto-apply', 'Budget changed'],
      ['9 Oct 2026, 08:00', 'A person in Google Ads', 'Changed by a person'],
    ])
  })
})

describe('the grids: words left, then the nine metric columns, totals from the sums', () => {
  const metricKeys = [...METRIC_COLUMN_KEYS]
  const keysOf = (cols: Array<{ key: string }>) => cols.map((c) => c.key)

  it('every grid’s numbers start with metricColumns, after its words', () => {
    expect(keysOf(adGroupColumns('EUR'))).toEqual(['status', 'type', ...metricKeys, 'bid', 'target'])
    expect(keysOf(keywordColumns('EUR'))).toEqual(['match', 'adGroup', 'status', ...metricKeys, 'quality', 'bid', 'effectiveBid'])
    expect(keysOf(assetGroupColumns('EUR'))).toEqual(['status', 'strength', 'url', ...metricKeys])
    expect(keysOf(searchTermColumns('EUR', false))).toEqual(['brand', ...metricKeys])
    expect(keysOf(searchTermColumns('EUR', true))).toEqual(['brand', 'campaign', 'type', ...metricKeys])
    expect(keysOf(productColumns('EUR', false))).toEqual(['nexus', 'status', ...metricKeys])
    expect(keysOf(productColumns('EUR', true))).toEqual(['nexus', 'status', 'campaign', 'type', ...metricKeys])
  })

  it('word columns sit left (metric: false); the numbers and bids sit right', () => {
    for (const cols of [adGroupColumns('EUR'), keywordColumns('EUR'), assetGroupColumns('EUR'), searchTermColumns('EUR', true), productColumns('EUR', true)]) {
      const words = cols.filter((c) => !(METRIC_COLUMN_KEYS as readonly string[]).includes(c.key) && !['bid', 'target', 'quality', 'effectiveBid'].includes(c.key))
      expect(words.every((c) => c.metric === false)).toBe(true)
      expect(cols.filter((c) => (METRIC_COLUMN_KEYS as readonly string[]).includes(c.key)).every((c) => c.metric !== false)).toBe(true)
    }
  })

  it('totals come from the sums of the rows shown; a row Nexus has no numbers for is "—" and left out — never 0', () => {
    type Row = { m: GoogleMetrics | null }
    const cols = metricColumns<Row>((r) => r.m, 'EUR')
    const by = (k: string) => cols.find((c) => c.key === k)!
    const rows: Row[] = [
      { m: metrics({ spendCents: 1000, conversionValueCents: 1000, clicks: 10 }) },
      { m: metrics({ spendCents: 3000, conversionValueCents: 9000, clicks: 30 }) },
      { m: null },
    ]
    const total = (k: string) => (by(k).total as (vr: Row[]) => unknown)(rows)
    expect(total('cost')).toBe('€40.00')
    // 10 000 ÷ 4 000 = 2.50 — not the mean of 1.00 and 3.00 (2.00).
    expect(total('roas')).toBe('2.50')
    expect(total('cpc')).toBe('€1.00')
    expect(by('cost').render(rows[2]!)).toBe('—')
    expect(by('clicks').render(rows[2]!)).toBe('—')
    expect((by('cost').total as (vr: Row[]) => unknown)([{ m: null }])).toBe('—')
  })

  it('money hidden for the role is "—", in the cells, the bids and the totals', () => {
    const k = { metrics: metrics({ spendCents: undefined, conversionValueCents: undefined, avgCpcCents: undefined, costPerConversionCents: undefined, roas: undefined }), cpcBidCents: undefined, effectiveCpcBidCents: undefined }
    const cols = keywordColumns('EUR')
    const cell = (key: string) => cols.find((c) => c.key === key)!.render(k as never)
    expect([cell('cost'), cell('value'), cell('roas'), cell('cpc'), cell('bid'), cell('effectiveBid')]).toEqual(['—', '—', '—', '—', '—', '—'])
    expect(cell('clicks')).toBe('50')
  })

  it('the Ad group filter offers every ad group the keywords sit in, by name', () => {
    const kw = (ext: string, name: string | null) => ({ externalAdGroupId: ext, adGroupName: name }) as never
    expect(keywordAdGroupOptions([kw('2', 'Jackets'), kw('1', 'Boots'), kw('2', 'Jackets'), kw('3', null)])).toEqual([
      { value: '3', label: '—' }, { value: '1', label: 'Boots' }, { value: '2', label: 'Jackets' },
    ])
  })
})

describe('read only, plain words, the DS grid', () => {
  const FILES = [
    './GoogleCampaignModal.tsx', './GoogleAdGroupsTab.tsx', './GoogleKeywordsTab.tsx', './GoogleNegativesTab.tsx', './GoogleAssetGroupsTab.tsx',
    './GoogleSearchTermsGrid.tsx', './GoogleProductsGrid.tsx', './GoogleCampaignActsTab.tsx', './GoogleGrainState.tsx', './googleGrains.ts',
  ]
  const src = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')

  it.each(FILES)('%s: no write control, no write route', (file) => {
    const s = file.endsWith('.ts') ? src(file).replace(/PAUSED/g, '') : src(file)
    expect(s).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'|\/mutate|\/budget|Pause|Resume|Enable campaign|requestGoogleRead/)
  })

  it.each(FILES)('%s: no emoji, no help cursor, no Amazon words', (file) => {
    const s = src(file)
    expect(s).not.toMatch(/\p{Extended_Pictographic}/u)
    expect(s).not.toMatch(/cursor:\s*help/)
    expect(s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')).not.toMatch(/\b(ACoS|ACOS|Sales|Orders|Live)\b/)
  })

  it('every grid: no row checkboxes, its own column key, no sticky header', () => {
    for (const file of FILES.filter((f) => /Tab\.tsx$|Grid\.tsx$/.test(f) && f !== './GoogleCampaignActsTab.tsx')) {
      const s = src(file)
      expect(s).toMatch(/selectable=\{false\}/)
      expect(s).toMatch(/h10-google-[a-z-]+-cols/)
      expect(s).not.toMatch(/selectionActions|sticky/)
    }
  })

  it('negatives have no totals; the other grids total at the bottom', () => {
    expect(src('./GoogleNegativesTab.tsx')).not.toMatch(/showTotal/)
    for (const file of ['./GoogleAdGroupsTab.tsx', './GoogleKeywordsTab.tsx', './GoogleAssetGroupsTab.tsx', './GoogleSearchTermsGrid.tsx', './GoogleProductsGrid.tsx']) {
      expect(src(file)).toMatch(/showTotal/)
    }
  })

  it('the modal is the DS DetailModal, opened through the address (`?campaign=&tab=`), with the step-1a day table kept', () => {
    const s = src('./GoogleCampaignModal.tsx')
    expect(s).toMatch(/<DetailModal/)
    expect(s).not.toMatch(/<Modal\b/)
    expect(s).toMatch(/useDetailParam\(GOOGLE_CAMPAIGN_PARAM\)/)
    expect(s).toMatch(/key: 'campaign', tabKey: 'tab'/)
    expect(s).toMatch(/className="gads-table gads-days"[^>]*aria-label="Days table"/)
  })

  it('googleModal.css uses design tokens only', () => {
    const css = src('./googleModal.css')
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i)
    expect(css).not.toMatch(/--nds-(grey|blue|red|green|amber)-\d/)
  })
})
