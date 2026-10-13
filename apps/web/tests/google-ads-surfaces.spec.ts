/**
 * Google Ads (steps 1a + 1b) in a real browser, with EVERY API call answered by `page.route` from made-up fixtures shaped
 * like the contract (`src/lib/google-ads/contract.ts`, PLAN-1B "API contract"). No API, no database, no Google account
 * and no login are needed: the web runs with business profiles off and auth not enforced, and `/api/auth/me` is mocked.
 * A call the spec does not know fails the test (`unmocked`), so a new call on these screens cannot reach a real server.
 *
 * What it holds, at 1440 and 390 px, light and dark:
 *   - the page: both cards ("Needs a look", "Google acts on its own") and the six tabs; no sideways page scroll;
 *   - keyboard: Tab reaches the tab bar, the arrows switch tabs and `?view=` follows; Enter on a campaign row opens the
 *     centred campaign window with `?campaign=`; Esc closes it and the focus goes back to the grid; Back closes it too;
 *   - the window's tabs per campaign type (Search; Performance Max: no Keywords; settings not read: Overview + Changes);
 *     a click on an ad group opens Keywords filtered to it; a day not read shows "Not read", never a 0;
 *   - an address with a campaign that is not in this business: a notice and Close, no Try again; any other failure keeps
 *     Try again, and Try again shows "Reading…" at once (the old error leaves the screen) for every part on that read;
 *   - no write control anywhere, no write call, no console error.
 * Once (1440, light): the five states without numbers show no amount and no currency; the account picker by keyboard.
 *
 * Run it against a LOCAL web dev server whose API address is a dead port (every call must be mocked):
 *   cd apps/web && NEXT_PUBLIC_API_URL=http://127.0.0.1:9 npx next dev -p 3000 -H 127.0.0.1
 *   cd apps/web && PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 npx playwright test google-ads-surfaces
 * It refuses any base URL that is not local. Fixtures are made up: no business names, numbers or ids (the repo is public).
 */
import { expect, test, type Page, type Route } from '@playwright/test'

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000'
const LOCAL = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url)
const PAGE = '/marketing/ads/google'

// ─── Fixtures (made up) ─────────────────────────────────────────────────

const READ_AT = '2026-10-13T06:30:00.000Z'
const WINDOW = { from: '2026-10-10', to: '2026-10-12', provisionalFrom: '2026-10-12' }
const COVERAGE = { daysInWindow: 3, daysRead: 2, missingDays: ['2026-10-11'] }

type Resource = 'AD_GROUPS' | 'KEYWORDS' | 'CAMPAIGN_NEGATIVES' | 'NEGATIVE_LISTS' | 'ASSET_GROUPS' | 'CAMPAIGN_SETTINGS' | 'AD_POLICY'
  | 'PRODUCT_STATUS' | 'AUTO_APPLY' | 'RECOMMENDATIONS' | 'AD_GROUP_DAYS' | 'KEYWORD_DAYS' | 'ASSET_GROUP_DAYS' | 'PRODUCT_DAYS' | 'SEARCH_TERM_DAYS'
const read = (resource: Resource, readAt: string | null = READ_AT) =>
  ({ resource, readAt, lastAttemptAt: readAt, lastStatus: readAt ? 'SUCCESS' : null, lastError: null })

const metrics = (spendCents: number, clicks = 50) => ({
  impressions: clicks * 20, clicks, spendCents, conversions: 2.5, conversionValueCents: spendCents * 4, ctr: 0.05,
  avgCpcCents: Math.round(spendCents / clicks), roas: 4, costPerConversionCents: Math.round(spendCents / 2.5),
})
const NO_NUMBERS = { impressions: null, clicks: null, spendCents: null, conversions: null, conversionValueCents: null, ctr: null, avgCpcCents: null, roas: null, costPerConversionCents: null }
const DAYS = [
  { date: '2026-10-10', provisional: false, read: true, ...metrics(3000) },
  { date: '2026-10-11', provisional: false, read: false, ...NO_NUMBERS },
  { date: '2026-10-12', provisional: true, read: true, ...metrics(3000) },
]

const ADS = { customerId: '1112223333', name: 'Test Shop Ads', currency: 'EUR', timeZone: 'Europe/Rome', isTest: true }

function googleAccount(state: string, withAds = true) {
  return {
    connectionId: 'conn_google_1',
    label: 'Google sign-in',
    state,
    stateText: '',
    authStatus: state === 'sign_in_needed' ? 'needs_reauth' : 'connected',
    missingProducts: state === 'permission_missing' ? ['ads'] : [],
    ads: withAds ? ADS : null,
    manager: null,
    merchantCenter: null,
    analytics: null,
    read: {
      lastReadAt: state === 'ok' ? READ_AT : null,
      lastDataDay: state === 'ok' ? '2026-10-12' : null,
      nextReadAt: '2026-10-14T06:25:00.000Z',
      lastError: state === 'read_failed' ? 'Google did not answer.' : null,
    },
  }
}

const SEARCH = {
  campaignId: 'cmp_search', externalCampaignId: '900001', name: 'Test search campaign', status: 'ENABLED', servingStatus: 'SERVING',
  primaryStatus: 'ELIGIBLE', type: 'SEARCH', biddingStrategy: 'MAXIMIZE_CONVERSIONS', dailyBudgetCents: 5000, budgetShared: false,
  startDate: '2026-01-01', endDate: null, settingsReadAt: READ_AT, metrics: metrics(6000),
}
const PMAX = {
  ...SEARCH, campaignId: 'cmp_pmax', externalCampaignId: '900002', name: 'Test performance max campaign', type: 'PERFORMANCE_MAX',
  biddingStrategy: 'MAXIMIZE_CONVERSION_VALUE', dailyBudgetCents: 3000, metrics: metrics(3000, 30),
}
// Numbers seen, settings never read: no status, no type.
const NEW = {
  campaignId: 'cmp_new', externalCampaignId: '900003', name: 'Test campaign not read yet', status: null, servingStatus: null, primaryStatus: null,
  type: 'UNKNOWN', biddingStrategy: null, dailyBudgetCents: null, budgetShared: false, startDate: null, endDate: null, settingsReadAt: null,
  metrics: metrics(500, 5),
}
// Not in the campaigns list: reached only by its address (the window's Try again test).
const FLAKY = { ...SEARCH, campaignId: 'cmp_flaky', externalCampaignId: '900004', name: 'Test flaky campaign' }
const CAMPAIGNS = [SEARCH, PMAX, NEW]
const BY_ID: Record<string, typeof SEARCH | typeof NEW> = { cmp_search: SEARCH, cmp_pmax: PMAX, cmp_new: NEW, cmp_flaky: FLAKY }

const ref = (c: { campaignId: string; externalCampaignId: string; name: string; type: string }) =>
  ({ campaignId: c.campaignId, externalCampaignId: c.externalCampaignId, campaignName: c.name, campaignType: c.type })

const AD_GROUPS = [
  { ...ref(SEARCH), adGroupId: 'ag_1', externalAdGroupId: '7001', name: 'Test ad group one', status: 'ENABLED', primaryStatus: 'ELIGIBLE', primaryStatusReasons: [], type: 'SEARCH_STANDARD', cpcBidCents: 80, targetCpaCents: null, targetRoas: null, searchTermMatching: 'on', settingsReadAt: READ_AT, metrics: metrics(4000) },
  { ...ref(SEARCH), adGroupId: 'ag_2', externalAdGroupId: '7002', name: 'Test ad group two', status: 'ENABLED', primaryStatus: 'ELIGIBLE', primaryStatusReasons: [], type: 'SEARCH_STANDARD', cpcBidCents: 60, targetCpaCents: null, targetRoas: null, searchTermMatching: 'on', settingsReadAt: READ_AT, metrics: metrics(2000) },
]
const keyword = (id: string, text: string, adGroup: (typeof AD_GROUPS)[number], matchType: string, spendCents: number, approvalStatus = 'APPROVED') => ({
  ...ref(SEARCH), keywordId: id, externalCriterionId: `c${id}`, adGroupId: adGroup.adGroupId, externalAdGroupId: adGroup.externalAdGroupId,
  adGroupName: adGroup.name, text, matchType, status: 'ENABLED', servingStatus: 'ELIGIBLE', approvalStatus, primaryStatus: 'ELIGIBLE',
  qualityScore: 7, cpcBidCents: 90, effectiveCpcBidCents: 90, settingsReadAt: READ_AT, metrics: metrics(spendCents),
})
const KEYWORDS = [
  keyword('kw_1', 'made up boots', AD_GROUPS[0]!, 'EXACT', 2500),
  keyword('kw_2', 'made up boots for rain', AD_GROUPS[0]!, 'PHRASE', 1500),
  keyword('kw_3', 'made up sandals', AD_GROUPS[1]!, 'BROAD', 2000, 'DISAPPROVED'),
]
const ASSET_GROUPS = [
  { ...ref(PMAX), assetGroupId: 'asg_1', externalAssetGroupId: '8001', name: 'Test asset group', status: 'ENABLED', primaryStatus: 'ELIGIBLE', primaryStatusReasons: [], adStrength: 'GOOD', finalUrls: ['https://example.com/jackets'], settingsReadAt: READ_AT, metrics: metrics(3000, 30) },
]
const NEGATIVES = {
  read: { adGroup: read('KEYWORDS'), campaign: read('CAMPAIGN_NEGATIVES'), lists: read('NEGATIVE_LISTS') },
  items: [{ negativeId: 'neg_1', level: 'campaign', kind: 'keyword', text: 'made up free', matchType: 'BROAD', campaignId: 'cmp_search', externalCampaignId: '900001', campaignName: SEARCH.name, adGroupId: null, adGroupName: null, listId: null, listName: null, status: 'ENABLED', seenAt: READ_AT }],
  lists: [], nextCursor: null, total: 1,
}
const BRAND_TERMS = { terms: ['testbrand'], source: 'protected_terms', editHref: '/marketing/ads/rules-automation/control-room?tab=limits&view=terms' }
const TERMS = [
  { ...ref(SEARCH), termId: 'st_1', term: 'testbrand boots', brand: true, metrics: metrics(1000, 20) },
  { ...ref(SEARCH), termId: 'st_2', term: 'cheap made up boots', brand: false, metrics: metrics(2000, 25) },
]
const PRODUCTS = [
  { productKey: 'pk_1', itemId: 'TEST-ITEM-1', title: 'Made-up jacket', ...ref(PMAX), status: 'no_issue', issues: [], nexusProduct: null, metrics: metrics(3000, 30) },
]
const AUTOMATION = (c: typeof SEARCH | typeof NEW, readAt: string | null) => ({
  campaignId: c.campaignId, externalCampaignId: c.externalCampaignId, name: c.name, type: c.type, status: c.status,
  aiMax: readAt ? 'off' : null, campaignBroadMatch: readAt ? 'on' : null, searchPartners: readAt ? 'off' : null, displayExpansion: readAt ? 'off' : null,
  finalUrlExpansion: readAt ? 'not_applicable' : null, finalUrlExpansionByDefault: false, textCustomization: readAt ? 'off' : null,
  dynamicSearchAds: readAt ? 'off' : null, brandExclusions: readAt ? 0 : null, adGroupsWithoutSearchTermMatching: readAt ? 0 : null,
  movedToAiMaxAt: null, flagsReadAt: readAt,
})
const CHANGE = {
  changedAt: '2026-10-05T10:00:00.000Z', resourceType: 'CAMPAIGN', operation: 'UPDATE', changedFields: ['campaign.status'],
  source: 'google_automatic', sourceText: 'Google, automatically', summary: 'Status changed',
}
const ACTS = {
  read: { autoApply: read('AUTO_APPLY'), settings: read('CAMPAIGN_SETTINGS'), adGroups: read('AD_GROUPS'), campaignNegatives: read('CAMPAIGN_NEGATIVES') },
  autoApply: { enabled: [{ type: 'KEYWORD', typeText: 'Add new keywords', since: '2026-09-01', changedAt: '2026-09-01T08:00:00.000Z' }], paused: [] },
  campaigns: [AUTOMATION(SEARCH, READ_AT), AUTOMATION(PMAX, READ_AT), AUTOMATION(NEW, null)],
  outsideChanges: {
    nexusWrites: 0, coveredFrom: '2026-09-13T22:00:00.000Z', coveredThrough: READ_AT,
    bySource: [{ source: 'google_automatic', sourceText: 'Google, automatically', count: 1 }],
    items: [{ ...CHANGE, campaignId: 'cmp_search', externalCampaignId: '900001', campaignName: SEARCH.name, who: 'google_auto_apply', watched: true }],
  },
}
const RECOMMENDATIONS = {
  read: read('RECOMMENDATIONS'), currency: 'EUR', writes: { mode: 'none' },
  items: [{
    recommendationId: 'rec_1', type: 'KEYWORD', typeText: 'Add new keywords', explanation: 'Made-up explanation of the suggestion.',
    campaignId: 'cmp_search', externalCampaignId: '900001', campaignName: SEARCH.name, adGroupName: null, autoApplied: true,
    impact: {
      base: { impressions: 1000, clicks: 50, spendCents: 6000, conversions: 2, conversionValueCents: 20000 },
      potential: { impressions: 1400, clicks: 70, spendCents: 7500, conversions: 3, conversionValueCents: 28000 },
    },
  }],
  byType: [{ type: 'KEYWORD', typeText: 'Add new keywords', count: 1 }],
}
const ALERTS = {
  checkedAt: READ_AT,
  items: [{
    alertId: 'al_1', kind: 'spend_pace', severity: 'warn', title: 'Over the daily budget', body: 'The campaign cost more than its daily budget on its last day.',
    campaignId: 'cmp_search', externalCampaignId: '900001', campaignName: SEARCH.name, since: '2026-10-12',
    numbers: { spendCents: 9500, dailyBudgetCents: 5000 }, href: '/marketing/ads/google?campaign=cmp_search',
  }],
  notChecked: [],
}
const DISAPPROVALS = {
  read: { ads: read('AD_POLICY'), products: read('PRODUCT_STATUS') },
  ads: [{
    adId: 'ad_1', externalAdId: '55501', adType: 'RESPONSIVE_SEARCH_AD', campaignId: 'cmp_search', campaignName: SEARCH.name, adGroupId: 'ag_1',
    adGroupName: 'Test ad group one', status: 'DISAPPROVED', reviewStatus: 'REVIEWED', reasons: ['DESTINATION_NOT_WORKING'], since: '2026-10-11',
  }],
  products: [],
  truncated: false,
}
const CHOICES = {
  missingProducts: [],
  ads: {
    customers: [
      { customerId: '1112223333', name: 'Test Shop Ads', currency: 'EUR', timeZone: 'Europe/Rome', isTest: true, direct: true, managers: [] },
      { customerId: '4445556666', name: 'Second Test Account', currency: 'EUR', timeZone: 'Europe/Rome', isTest: true, direct: true, managers: [] },
    ],
    error: null,
  },
  merchantCenter: { accounts: [], error: { code: 'not_registered', message: 'Not registered.' } },
  analytics: { properties: [{ propertyId: '321', name: 'Test property', accountName: 'Test analytics' }], error: null },
}

function overview(state: string) {
  const account = googleAccount(state, state !== 'choose_account')
  const ok = state === 'ok'
  return {
    accounts: state === 'not_connected' ? [] : [account],
    account: state === 'not_connected' ? null : account,
    window: WINDOW,
    currency: ok ? 'EUR' : null,
    timeZone: ok ? 'Europe/Rome' : null,
    dataAsOf: ok ? READ_AT : null,
    coverage: ok ? COVERAGE : { daysInWindow: 3, daysRead: 0, missingDays: [] },
    totals: ok ? { ...metrics(9500), impressions: 2000, clicks: 100 } : null,
    previous: null,
    days: ok ? DAYS : [],
    reads: ok ? [read('AD_GROUPS'), read('KEYWORDS'), read('SEARCH_TERM_DAYS')] : [],
  }
}

const listBase = (resource: Resource, numbers: Resource) =>
  ({ window: WINDOW, currency: 'EUR', dataAsOf: READ_AT, read: read(resource), numbersRead: read(numbers), coverage: COVERAGE, nextCursor: null })

// ─── The mock API ───────────────────────────────────────────────────────

type Answer = { status?: number; body: unknown; delayMs?: number }
/** A test's own answer for one call (return undefined to fall through to the fixtures); `n` counts that path's calls. */
type Override = (path: string, q: URLSearchParams, n: number) => Answer | undefined

interface Mock {
  /** Calls the spec has no answer for (the test fails on any). */
  unmocked: string[]
  /** Anything but GET to /api/google-ads (the test fails on any, except the picker's own Save). */
  writes: string[]
  /** C3 bodies the picker sent. */
  saved: unknown[]
  /** How many times each path was asked. */
  calls: Map<string, number>
}

function answerFor(path: string, q: URLSearchParams, state: string): Answer | undefined {
  const campaignId = q.get('campaignId')
  let m: RegExpMatchArray | null
  switch (path) {
    // The app shell, the ads sidebar and the bell.
    case '/api/auth/csrf': return { body: { csrfToken: 'test-csrf-token' } }
    case '/api/auth/me': return { body: { user: { id: 'user_test', email: 'tester@example.com', displayName: 'Test Person', roleKeys: ['owner'], mfaEnabled: false, mfaRequired: false }, isOwner: true, permissions: [] } }
    case '/api/notifications': return { body: { rows: [], unreadCount: 0 } }
    case '/api/advertising/suggestions/count': return { body: { pending: 0 } }
    case '/api/advertising/connections': return { body: { items: [], markets: { markets: [] } } }
    case '/api/connections': return { body: { connections: [] } }
    case '/api/sidebar/counts': return { body: {} }
    case '/api/admin/push-health': return { body: { summary: { dlqDepth: 0 } } }
    // Google (R1–R15, C1–C2).
    case '/api/google-ads/overview': return { body: overview(state) }
    case '/api/google-ads/campaigns': return { body: { window: WINDOW, currency: 'EUR', dataAsOf: READ_AT, coverage: COVERAGE, items: CAMPAIGNS, nextCursor: null, total: CAMPAIGNS.length } }
    case '/api/google-ads/ad-groups': {
      const items = AD_GROUPS.filter((a) => !campaignId || a.campaignId === campaignId)
      return { body: { ...listBase('AD_GROUPS', 'AD_GROUP_DAYS'), items, total: items.length } }
    }
    case '/api/google-ads/keywords': {
      const items = KEYWORDS.filter((k) => !campaignId || k.campaignId === campaignId)
      return { body: { ...listBase('KEYWORDS', 'KEYWORD_DAYS'), items, total: items.length } }
    }
    case '/api/google-ads/negatives': return { body: campaignId === 'cmp_search' ? NEGATIVES : { ...NEGATIVES, items: [], total: 0 } }
    case '/api/google-ads/asset-groups': {
      const items = ASSET_GROUPS.filter((a) => !campaignId || a.campaignId === campaignId)
      return { body: { ...listBase('ASSET_GROUPS', 'ASSET_GROUP_DAYS'), items, total: items.length } }
    }
    case '/api/google-ads/search-terms': {
      const items = TERMS.filter((t) => !campaignId || t.campaignId === campaignId)
      return { body: { window: WINDOW, currency: 'EUR', dataAsOf: READ_AT, read: read('SEARCH_TERM_DAYS'), coverage: COVERAGE, scope: 'terms_with_clicks', brandTerms: BRAND_TERMS, items, nextCursor: null, total: items.length } }
    }
    case '/api/google-ads/brand-split': return { body: {
      window: WINDOW, currency: 'EUR', dataAsOf: READ_AT, read: read('SEARCH_TERM_DAYS'), coverage: COVERAGE, brandTerms: BRAND_TERMS,
      rows: [{ campaignType: 'ALL', total: metrics(9500), brand: metrics(1000, 20), nonBrand: metrics(2000, 25), notInSearchTerms: metrics(6500, 55) }],
    } }
    case '/api/google-ads/products': {
      const items = PRODUCTS.filter((p) => !campaignId || p.campaignId === campaignId)
      return { body: { window: WINDOW, currency: 'EUR', dataAsOf: READ_AT, numbersRead: read('PRODUCT_DAYS'), statusRead: read('PRODUCT_STATUS'), coverage: COVERAGE, items, nextCursor: null, total: items.length } }
    }
    case '/api/google-ads/acts-on-its-own': return { body: ACTS }
    case '/api/google-ads/recommendations': return { body: RECOMMENDATIONS }
    case '/api/google-ads/alerts': return { body: ALERTS }
    case '/api/google-ads/disapprovals': return { body: DISAPPROVALS }
    case '/api/google-ads/connections': return { body: { items: state === 'not_connected' ? [] : [googleAccount(state, state !== 'choose_account')] } }
    // Settings › Channels (the picker test).
    case '/api/cx/channels': return { body: { channels: [{
      key: 'GOOGLE', channelType: 'GOOGLE', displayName: 'Google', available: true, authMode: 'oauth2', connectMode: 'website_oauth',
      permissionModel: 'oauth_scopes', requiredScopes: ['https://www.googleapis.com/auth/adwords', 'https://www.googleapis.com/auth/content', 'https://www.googleapis.com/auth/analytics.readonly'],
      reviewGatedScopes: [], regions: [], defaultRegion: null, refreshTokenLifetimeSec: null, rotatesRefreshToken: false, webhooks: null, sandbox: null, connectException: null, apiVersion: 'v25',
    }] } }
    case '/api/accounts': return { body: { accounts: state === 'not_connected' ? [] : [{
      id: 'conn_google_1', channel: 'GOOGLE', managedBy: 'oauth', label: 'Google sign-in', labelSource: 'signInName', labelIsPlaceholder: false, markets: [],
      health: 'ok', healthReason: null, isPrimary: true, isActive: true, tokenExpiresAt: null, lastSyncAt: null, lastSyncStatus: null, lastSyncError: null, authStatus: 'connected',
    }], notConnected: [] } }
  }
  if ((m = path.match(/^\/api\/google-ads\/campaigns\/([^/]+)\/days$/))) {
    const c = BY_ID[decodeURIComponent(m[1]!)]
    return c ? { body: { campaign: c, currency: 'EUR', window: WINDOW, coverage: COVERAGE, days: DAYS } } : { status: 404, body: { error: 'Campaign not found' } }
  }
  if ((m = path.match(/^\/api\/google-ads\/campaigns\/([^/]+)\/changes$/))) {
    return BY_ID[decodeURIComponent(m[1]!)]
      ? { body: { items: [CHANGE], coveredFrom: '2026-09-13T22:00:00.000Z', coveredThrough: READ_AT } }
      : { status: 404, body: { error: 'Campaign not found' } }
  }
  if (/^\/api\/google-ads\/connections\/[^/]+\/choices$/.test(path)) return { body: CHOICES }
  return undefined
}

/** Answers every `/api/*` (and `/backend/api/*`) call from the fixtures, on whatever host the web was built to call. */
async function mockApi(page: Page, state = 'ok', override?: Override): Promise<Mock> {
  const mock: Mock = { unmocked: [], writes: [], saved: [], calls: new Map() }
  await page.route((url) => /^\/(backend\/)?api\//.test(url.pathname), async (route: Route) => {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname.replace(/^\/backend/, '')
    const n = (mock.calls.get(path) ?? 0) + 1
    mock.calls.set(path, n)
    const method = req.method()
    if (method === 'PUT' && /^\/api\/google-ads\/connections\/[^/]+\/selection$/.test(path)) {
      mock.saved.push(req.postDataJSON())
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ account: googleAccount('first_read_pending') }) })
    }
    if (method !== 'GET' && method !== 'HEAD') {
      if (path.startsWith('/api/google-ads')) mock.writes.push(`${method} ${path}`)
      else mock.unmocked.push(`${method} ${path}`)
      return route.fulfill({ status: 405, contentType: 'application/json', body: JSON.stringify({ error: 'Not in this test.' }) })
    }
    const answer = override?.(path, url.searchParams, n) ?? answerFor(path, url.searchParams, state)
    if (!answer) {
      mock.unmocked.push(`${method} ${path}`)
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not mocked.' }) })
    }
    if (answer.delayMs) await new Promise((resolve) => setTimeout(resolve, answer.delayMs))
    return route.fulfill({ status: answer.status ?? 200, contentType: 'application/json', body: JSON.stringify(answer.body) })
  })
  return mock
}

/**
 * AG Grid warnings this spec knows about, each with where it comes from. Remove a line when its cause is fixed.
 *  - #27 `getGridOption`: a WorkspaceGrid that mounts WITH its totals row asks `api.getGridOption('headerHeight')` from
 *    `getRowHeight` (design-system/grid/workspace/WorkspaceGrid.tsx) before AG has registered its API; the totals row
 *    then gets the row height instead of the header's. A DS defect, reported to the DS lane on 2026-10-13.
 */
const KNOWN_AG_WARNINGS = [/warning #27 API function `getGridOption` not registered to module `CommunityCore`/]

/**
 * Every console error, uncaught page error and AG Grid warning (dev builds name a grid's problems in the console). Nothing
 * else is filtered: every call is mocked, so none may fail.
 */
function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
    else if (m.type() === 'warning' && /^AG Grid\b/.test(m.text()) && !KNOWN_AG_WARNINGS.some((known) => known.test(m.text()))) errors.push(`AG Grid: ${m.text()}`)
  })
  return errors
}

/** The page's own content (the app shell has an outer `<main>` too). */
const content = (page: Page) => page.locator('main.h10-main')
/** The tab panel under the page's tab bar (the cards above may name the same campaigns). */
const view = (page: Page) => content(page).locator('.gads-view')
const campaignDialog = (page: Page, name: string | RegExp) => page.getByRole('dialog', { name })

/** Presses Tab until `test()` holds for the focused element (at most `max` presses). */
async function tabUntil(page: Page, test: () => Promise<boolean>, max = 40): Promise<boolean> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab')
    if (await test()) return true
  }
  return false
}

/**
 * Clicks a tab of a strip that scrolls. Focus first: at phone width a press on a tab under the strip's edge fade is
 * lost — the DS Tabs scrolls the strip on focus, between the press and the release, so the release lands on the next
 * tab (design-system/components/Tabs.tsx `onFocus` → `revealInStrip`; reported to the DS lane on 2026-10-13).
 */
async function pickTab(tab: ReturnType<Page['locator']>) {
  await tab.focus()
  await tab.click()
}

/** Closes AG Grid's dev-build warning panel (see KNOWN_AG_WARNINGS), which at phone width covers the grid's rows. */
async function closeAgDevPanels(scope: ReturnType<Page['locator']>) {
  const dismiss = scope.locator('.ag-overlay-error-panel .ag-overlay-error-dismiss')
  for (let i = await dismiss.count(); i > 0; i--) await dismiss.first().click()
}

/** The names of a tab list's tabs, without their counts. */
async function tabNames(scope: ReturnType<Page['locator']>): Promise<string[]> {
  return (await scope.getByRole('tab').allInnerTexts()).map((t) => t.replace(/\s*\d[\d,.]*\s*$/, '').trim())
}

/** A button that would change Google Ads (or anything else): none may exist on these read-only screens. */
const WRITE_VERB = /^(pause|enable|resume|remove|delete|apply|dismiss|edit|save|create|add|raise|lower|increase|decrease|set|change|update|publish|send|approve)\b/i

async function writeButtons(scope: ReturnType<Page['locator']>): Promise<string[]> {
  const names = await scope.getByRole('button').evaluateAll((els) => els
    // Shown, and not AG Grid's own dev-build warning panel (its "Dismiss" closes the panel).
    .filter((el) => (el as HTMLElement).offsetParent !== null && !el.closest('.ag-overlay-error-panel'))
    .map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim()))
  return names.filter((n) => WRITE_VERB.test(n))
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0)
}

test.skip(!LOCAL(BASE), 'runs only against a local web server, with every API call mocked')

// The dev server compiles the page on its first visit.
test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000)
  await request.get(PAGE, { timeout: 230_000 })
})

const LOOKS = [
  { name: '1440 light', viewport: { width: 1440, height: 900 }, colorScheme: 'light' },
  { name: '1440 dark', viewport: { width: 1440, height: 900 }, colorScheme: 'dark' },
  { name: '390 light', viewport: { width: 390, height: 844 }, colorScheme: 'light' },
  { name: '390 dark', viewport: { width: 390, height: 844 }, colorScheme: 'dark' },
] as const

for (const look of LOOKS) {
  test.describe(`Ads › Google, ${look.name}`, () => {
    test.use({ viewport: look.viewport, colorScheme: look.colorScheme })
    const phone = look.viewport.width < 600

    test.beforeEach(async ({ page }) => {
      // The app's theme follows the OS unless a person chose one: make the look explicit.
      await page.addInitScript((mode) => { try { window.localStorage.setItem('nexus:theme', mode) } catch { /* private mode */ } }, look.colorScheme)
    })

    test('the page: both cards and the six tabs, read only, no sideways scroll', async ({ page }) => {
      const errors = watchErrors(page)
      const mock = await mockApi(page)
      await page.goto(PAGE)
      const main = content(page)
      await expect(main.getByRole('heading', { name: 'Google Ads' })).toBeVisible()
      await expect(main.getByRole('heading', { name: 'Needs a look' })).toBeVisible()
      await expect(main.getByRole('heading', { name: 'Google acts on its own', level: 2 })).toBeVisible()
      await expect(main.getByText('Over the daily budget')).toBeVisible()
      const views = main.getByRole('tablist', { name: 'Google Ads views' })
      await expect(views.getByRole('tab')).toHaveCount(6)
      expect(await tabNames(views)).toEqual(['Campaigns', 'Search terms', 'Products', 'Disapprovals', 'Google acts on its own', 'Google’s recommendations'])
      await expect(views.getByRole('tab', { name: /^Campaigns/ })).toHaveAttribute('aria-selected', 'true')
      await expect(view(page).getByText('Test search campaign')).toBeVisible()
      if (look.colorScheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
      else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
      await noSidewaysScroll(page)
      expect(await writeButtons(main)).toEqual([])
      expect(mock.unmocked).toEqual([])
      expect(mock.writes).toEqual([])
      expect(errors).toEqual([])
    })

    test('keyboard: Tab reaches the tab bar, the arrows switch tabs and ?view= follows', async ({ page }) => {
      const errors = watchErrors(page)
      const mock = await mockApi(page)
      await page.goto(PAGE)
      const main = content(page)
      const views = main.getByRole('tablist', { name: 'Google Ads views' })
      await expect(view(page).getByText('Test search campaign')).toBeVisible()
      await main.locator('.gads-cards').getByRole('button', { name: 'See all' }).focus()
      const onTabs = () => views.evaluate((el) => el.contains(document.activeElement))
      expect(await tabUntil(page, onTabs), 'Tab never reached the tab bar').toBe(true)
      await expect(views.getByRole('tab', { name: /^Campaigns/ })).toBeFocused()

      await page.keyboard.press('ArrowRight')
      await expect(views.getByRole('tab', { name: /^Search terms/ })).toBeFocused()
      await expect(views.getByRole('tab', { name: /^Search terms/ })).toHaveAttribute('aria-selected', 'true')
      await expect(page).toHaveURL(/[?&]view=search-terms\b/)
      await expect(view(page).getByText('cheap made up boots')).toBeVisible()

      await page.keyboard.press('End')
      await expect(page).toHaveURL(/[?&]view=recommendations\b/)
      await expect(view(page).getByText('Add new keywords').first()).toBeVisible()
      await page.keyboard.press('ArrowLeft')
      await expect(page).toHaveURL(/[?&]view=on-its-own\b/)
      await page.keyboard.press('Home')
      await expect(views.getByRole('tab', { name: /^Campaigns/ })).toHaveAttribute('aria-selected', 'true')
      await expect(page).not.toHaveURL(/[?&]view=/)
      expect(mock.unmocked).toEqual([])
      expect(errors).toEqual([])
    })

    test('keyboard: Enter on a campaign row opens the centred window; Esc closes it and the focus goes back to the grid', async ({ page }) => {
      const errors = watchErrors(page)
      const mock = await mockApi(page)
      await page.goto(PAGE)
      const main = content(page)
      await expect(view(page).getByText('Test search campaign')).toBeVisible()
      const panel = main.locator('.gads-view')
      const inGrid = () => panel.evaluate((el) => !!document.activeElement?.closest('.ag-root') && el.contains(document.activeElement))
      await main.getByRole('tablist', { name: 'Google Ads views' }).getByRole('tab', { name: /^Campaigns/ }).focus()
      expect(await tabUntil(page, inGrid), 'Tab never reached the campaigns grid').toBe(true)
      // Into the first row (the header is the grid's tab stop); the most costly enabled campaign is first.
      await page.keyboard.press('ArrowDown')
      await expect(panel.locator('.ag-cell:focus')).toHaveCount(1)
      await page.keyboard.press('Enter')

      const dialog = campaignDialog(page, 'Test search campaign')
      await expect(dialog).toBeVisible()
      await expect(page).toHaveURL(/[?&]campaign=cmp_search\b/)
      const box = (await dialog.boundingBox())!
      if (phone) {
        // A full-screen sheet on a phone.
        expect(Math.round(box.width)).toBeGreaterThanOrEqual(look.viewport.width - 1)
      } else {
        // Centred: the same room on the left and the right.
        expect(Math.abs(box.x + box.width / 2 - look.viewport.width / 2)).toBeLessThanOrEqual(2)
      }
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await expect(page).not.toHaveURL(/[?&]campaign=/)
      await expect.poll(inGrid, { message: 'the focus did not go back to the grid' }).toBe(true)
      await noSidewaysScroll(page)
      expect(mock.unmocked).toEqual([])
      expect(errors).toEqual([])
    })

    test('a click opens a campaign; the browser Back closes it', async ({ page }) => {
      const errors = watchErrors(page)
      const mock = await mockApi(page)
      await page.goto(PAGE)
      const main = content(page)
      await view(page).getByText('Test performance max campaign').click()
      const dialog = campaignDialog(page, 'Test performance max campaign')
      await expect(dialog).toBeVisible()
      await expect(page).toHaveURL(/[?&]campaign=cmp_pmax\b/)
      await page.goBack()
      await expect(dialog).toBeHidden()
      await expect(page).not.toHaveURL(/[?&]campaign=/)
      await expect(view(page).getByText('Test search campaign')).toBeVisible()
      expect(mock.unmocked).toEqual([])
      expect(errors).toEqual([])
    })

    test('the window’s tabs follow the campaign type; a day not read shows no 0', async ({ page }) => {
      const errors = watchErrors(page)
      const mock = await mockApi(page)

      await page.goto(`${PAGE}?campaign=cmp_search`)
      let dialog = campaignDialog(page, 'Test search campaign')
      await expect(dialog).toBeVisible()
      const tabs = dialog.getByRole('tablist', { name: 'Campaign' })
      expect(await tabNames(tabs)).toEqual(['Overview', 'Ad groups', 'Keywords', 'Negatives', 'Search terms', 'Google acts on its own', 'Changes'])
      // Overview: the day Nexus has not read says "Not read" and shows no number at all — never a 0.
      const unread = dialog.locator('.gads-days tr', { hasText: 'Not read' })
      await expect(unread).toHaveCount(1)
      const cells = await unread.locator('td, th').allInnerTexts()
      expect(cells[0]).toMatch(/11 Oct/)
      expect(cells.slice(1).join(' ')).not.toMatch(/\d/)
      await expect(dialog.getByText('No Google numbers for 11 Oct', { exact: false })).toBeVisible()
      expect(await writeButtons(dialog)).toEqual([])

      await page.goto(`${PAGE}?campaign=cmp_pmax`)
      dialog = campaignDialog(page, 'Test performance max campaign')
      await expect(dialog).toBeVisible()
      expect(await tabNames(dialog.getByRole('tablist', { name: 'Campaign' }))).toEqual(['Overview', 'Asset groups', 'Products', 'Negatives', 'Search terms', 'Google acts on its own', 'Changes'])

      await page.goto(`${PAGE}?campaign=cmp_new`)
      dialog = campaignDialog(page, 'Test campaign not read yet')
      await expect(dialog).toBeVisible()
      expect(await tabNames(dialog.getByRole('tablist', { name: 'Campaign' }))).toEqual(['Overview', 'Changes'])
      await expect(dialog.getByText('Not read yet').first()).toBeVisible()
      expect(mock.unmocked).toEqual([])
      expect(errors).toEqual([])
    })

    test('a click on an ad group opens Keywords filtered to it', async ({ page }) => {
      const errors = watchErrors(page)
      const mock = await mockApi(page)
      await page.goto(`${PAGE}?campaign=cmp_search&tab=ad-groups`)
      const dialog = campaignDialog(page, 'Test search campaign')
      await expect(dialog.getByRole('tab', { name: /^Ad groups/ })).toHaveAttribute('aria-selected', 'true')
      await expect(dialog.getByText('Test ad group one')).toBeVisible()
      await closeAgDevPanels(dialog)
      await dialog.getByText('Test ad group one').click()
      await expect(page).toHaveURL(/[?&]tab=keywords\b/)
      await expect(dialog.getByRole('tab', { name: /^Keywords/ })).toHaveAttribute('aria-selected', 'true')
      await expect(dialog.getByText('made up boots', { exact: true })).toBeVisible()
      await expect(dialog.getByText('made up boots for rain', { exact: true })).toBeVisible()
      await expect(dialog.getByText('made up sandals', { exact: true })).toHaveCount(0)
      // The Keywords tab itself (not from an ad group) shows every keyword.
      await pickTab(dialog.getByRole('tab', { name: /^Negatives/ }))
      await pickTab(dialog.getByRole('tab', { name: /^Keywords/ }))
      await expect(dialog.getByText('made up sandals', { exact: true })).toBeVisible()
      await noSidewaysScroll(page)
      expect(mock.unmocked).toEqual([])
      expect(errors).toEqual([])
    })

    test('every view and every window tab: no write control, no write call, no console error', async ({ page }) => {
      test.setTimeout(90_000)
      const errors = watchErrors(page)
      const mock = await mockApi(page)
      await page.goto(PAGE)
      const main = content(page)
      const views = main.getByRole('tablist', { name: 'Google Ads views' })
      await expect(view(page).getByText('Test search campaign')).toBeVisible()
      for (const [tab, shows] of [
        ['Search terms', 'cheap made up boots'], ['Products', 'Made-up jacket'], ['Disapprovals', 'Destination not working'],
        ['Google acts on its own', 'Changes made outside Nexus'], ['Google’s recommendations', 'Made-up explanation of the suggestion.'],
      ] as const) {
        await pickTab(views.getByRole('tab', { name: new RegExp(`^${tab}`) }))
        await expect(view(page).getByText(shows).first()).toBeVisible()
        expect(await writeButtons(main), `a write control on ${tab}`).toEqual([])
        await noSidewaysScroll(page)
      }
      await page.goto(`${PAGE}?campaign=cmp_search`)
      const dialog = campaignDialog(page, 'Test search campaign')
      for (const [tab, shows] of [
        ['Ad groups', 'Test ad group two'], ['Keywords', 'made up sandals'], ['Negatives', 'made up free'], ['Search terms', 'testbrand boots'],
        ['Google acts on its own', 'Settings that widen where the ads show'], ['Changes', 'Status changed'],
      ] as const) {
        await pickTab(dialog.getByRole('tab', { name: new RegExp(`^${tab}`) }))
        await expect(dialog.getByText(shows).first()).toBeVisible()
        expect(await writeButtons(dialog), `a write control on the window's ${tab}`).toEqual([])
      }
      expect(mock.unmocked).toEqual([])
      expect(mock.writes).toEqual([])
      expect(errors).toEqual([])
    })

    test('a campaign that is not in this business: a notice and Close, no Try again', async ({ page }) => {
      const errors = watchErrors(page)
      const mock = await mockApi(page)
      await page.goto(`${PAGE}?campaign=cmp_elsewhere`)
      const dialog = campaignDialog(page, 'Google campaign')
      await expect(dialog.getByText(/^This campaign is not in this business[’']s Google Ads account\.$/)).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Try again' })).toHaveCount(0)
      await expect(dialog.getByText('Campaign not found')).toHaveCount(0)
      await dialog.getByRole('button', { name: 'Close' }).click()
      await expect(dialog).toBeHidden()
      await expect(page).not.toHaveURL(/[?&]campaign=/)
      await expect(view(page).getByText('Test search campaign')).toBeVisible()
      expect(mock.unmocked).toEqual([])
      // The 404 itself is the browser's "Failed to load resource" line: the one error this test expects.
      expect(errors.filter((e) => !/status of 404/.test(e))).toEqual([])
    })

    test('any other failure keeps Try again, and Try again shows "Reading…" at once', async ({ page }) => {
      const errors = watchErrors(page)
      const mock = await mockApi(page, 'ok', (path, _q, n) => {
        if (path !== '/api/google-ads/campaigns/cmp_flaky/days') return undefined
        return n === 1
          ? { status: 500, body: { error: 'Google Ads did not answer in time.' } }
          : { body: { campaign: FLAKY, currency: 'EUR', window: WINDOW, coverage: COVERAGE, days: DAYS }, delayMs: 1500 }
      })
      await page.goto(`${PAGE}?campaign=cmp_flaky`)
      const dialog = campaignDialog(page, /^(Google campaign|Test flaky campaign)$/)
      await expect(dialog.getByText('Google Ads did not answer in time.')).toBeVisible()
      await dialog.getByRole('button', { name: 'Try again' }).click()
      // The old error leaves at once; the window says it is reading until the answer comes.
      await expect(dialog.getByText('Google Ads did not answer in time.')).toHaveCount(0)
      await expect(dialog.getByText('Reading…')).toBeVisible()
      await expect(campaignDialog(page, 'Test flaky campaign')).toBeVisible()
      expect(mock.calls.get('/api/google-ads/campaigns/cmp_flaky/days')).toBe(2)
      expect(mock.unmocked).toEqual([])
      expect(errors.filter((e) => !/status of 500/.test(e))).toEqual([])
    })

    test('Try again on one part reads again for every part on that read (the card and the tab)', async ({ page }) => {
      const errors = watchErrors(page)
      const mock = await mockApi(page, 'ok', (path, _q, n) =>
        path === '/api/google-ads/acts-on-its-own' && n === 1 ? { status: 500, body: { error: 'Google Ads did not answer in time.' } } : undefined)
      await page.goto(`${PAGE}?view=on-its-own`)
      const main = content(page)
      await expect(main.getByText('This could not be loaded')).toHaveCount(2)
      await main.locator('.gads-view').getByRole('button', { name: 'Try again' }).click()
      await expect(main.getByText('Changes made outside Nexus')).toBeVisible()
      await expect(main.getByText('This could not be loaded')).toHaveCount(0)
      await expect(main.locator('.gads-cards').getByText('On for 1 kind of recommendation')).toBeVisible()
      // One request for both, each time.
      expect(mock.calls.get('/api/google-ads/acts-on-its-own')).toBe(2)
      expect(mock.unmocked).toEqual([])
      expect(errors.filter((e) => !/status of 500/.test(e))).toEqual([])
    })
  })
}

test.describe('Ads › Google, honest states (1440, light)', () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })

  test('the campaigns fail to load: the reason and Try again, never "Google reported no campaigns"', async ({ page }) => {
    const errors = watchErrors(page)
    const mock = await mockApi(page, 'ok', (path, _q, n) =>
      path === '/api/google-ads/campaigns' && n === 1 ? { status: 500, body: { error: 'Google Ads did not answer in time.' } } : undefined)
    await page.goto(PAGE)
    const panel = view(page)
    await expect(panel.getByText('The campaigns could not be loaded')).toBeVisible()
    await expect(panel.getByText('Google Ads did not answer in time.')).toBeVisible()
    await expect(panel.getByText('Google reported no campaigns for this account.')).toHaveCount(0)
    await panel.getByRole('button', { name: 'Try again' }).click()
    await expect(panel.getByText('Test search campaign')).toBeVisible()
    await expect(panel.getByText('The campaigns could not be loaded')).toHaveCount(0)
    expect(mock.unmocked).toEqual([])
    expect(errors.filter((e) => !/status of 500/.test(e))).toEqual([])
  })

  test('brand split with no day read: the tiles say so, never "No brand words yet" when there are brand words', async ({ page }) => {
    const errors = watchErrors(page)
    const mock = await mockApi(page, 'ok', (path) => path === '/api/google-ads/brand-split' ? { body: {
      window: WINDOW, currency: 'EUR', dataAsOf: READ_AT, read: read('SEARCH_TERM_DAYS'), coverage: { daysInWindow: 3, daysRead: 0, missingDays: ['2026-10-10', '2026-10-11', '2026-10-12'] },
      brandTerms: BRAND_TERMS, rows: [{ campaignType: 'ALL', total: null, brand: null, nonBrand: null, notInSearchTerms: null }],
    } } : undefined)
    await page.goto(`${PAGE}?view=search-terms`)
    const panel = view(page)
    await expect(panel.getByText('cheap made up boots')).toBeVisible()
    await expect(panel.getByText('Not read for these days')).toHaveCount(3)
    await expect(panel.getByText('No brand words yet')).toHaveCount(0)
    expect(mock.unmocked).toEqual([])
    expect(errors).toEqual([])
  })

  for (const state of ['not_connected', 'sign_in_needed', 'permission_missing', 'choose_account', 'first_read_pending']) {
    test(`no amount and no currency when ${state}`, async ({ page }) => {
      const errors = watchErrors(page)
      const mock = await mockApi(page, state)
      await page.goto(PAGE)
      const main = content(page)
      await expect(main.getByRole('heading', { name: 'Google Ads' })).toBeVisible()
      await expect(main.locator('.nds-empty')).toBeVisible()
      expect(await main.innerText()).not.toMatch(/€|\bEUR\b|\d+\.\d{2}\b/)
      await expect(main.locator('.nds-metrics')).toHaveCount(0)
      await expect(main.locator('.recharts-wrapper')).toHaveCount(0)
      await expect(main.getByRole('tablist', { name: 'Google Ads views' })).toHaveCount(0)
      expect(mock.unmocked).toEqual([])
      expect(errors).toEqual([])
    })
  }
})

test.describe('Settings › Channels: the Google account picker (1440, light)', () => {
  test.use({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })

  test('works by keyboard and sends the C3 body', async ({ page }) => {
    test.setTimeout(120_000)
    const errors = watchErrors(page)
    const mock = await mockApi(page, 'choose_account')
    await page.goto('/settings/channels?tab=connect', { timeout: 110_000 })
    await page.getByRole('button', { name: 'Choose accounts' }).click()
    const dialog = page.getByRole('dialog', { name: 'Choose Google accounts' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Google has not registered Nexus with this Merchant Center account yet.')).toBeVisible()
    // Save is held until an account is chosen.
    await expect(dialog.getByRole('button', { name: 'Save and start reading' })).toHaveAttribute('aria-disabled', 'true')
    const adsPicker = dialog.getByLabel('Google Ads account')
    await adsPicker.focus()
    await page.keyboard.press('Enter')
    // Sorted by name: "Second Test Account", then "Test Shop Ads". Nothing is highlighted until a key moves.
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(adsPicker).toContainText('Test Shop Ads')
    await dialog.getByRole('button', { name: 'Save and start reading' }).focus()
    await page.keyboard.press('Enter')
    await expect(dialog).toBeHidden()
    expect(mock.saved).toEqual([{ adsCustomerId: '1112223333', managerCustomerId: null, merchantCenterId: null, analyticsPropertyId: null }])
    await expect(page.getByText('Google accounts saved.')).toBeVisible()
    expect(mock.unmocked).toEqual([])
    expect(errors).toEqual([])
  })
})
