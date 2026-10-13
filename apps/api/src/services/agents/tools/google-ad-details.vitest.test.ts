/**
 * Google Ads step 1b — google-ad-details: the rest of the Google Ads page, one view at a time, read through the one door
 * (call-tool.ts) on a real PostgreSQL with the production schema and the business-isolation policies (PGlite).
 *
 * The page's read services (google-ads/read-detail, read-search-terms, read-acts and alerts services, R5–R15) are stood
 * in here with answers in their own shapes (read-types.ts): their rows, windows and money are theirs to prove
 * (their own tests, and the real-PostgreSQL MCP suite runs them for every view). What this file proves is the tool's:
 * every view answers for the business's chosen Google Ads account and names it; a list is read whole from its service
 * (following the service's own pages) and paged here, each row once, in the service's order (by cost for keywords,
 * search terms and products), with a cursor that carries a name or a place and never an amount; a filter a view does
 * not take is refused, never ignored; no Google, no account chosen and "not read yet" are said in words, never as 0;
 * another business's account or campaign is not found; a person without the ad-spend money permission gets the same
 * answer minus exactly the money keys (bids, targets, impact and an alert's numbers too); no tool changes Google Ads.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID } from '../../../lib/workspace-context.js'
import { RESTRICTED_FIELDS } from '../../../lib/auth/financial-fields.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_t, p) => Reflect.get(database.client, p) }) }))
vi.mock('../../advertising/ads-cache.js', () => ({
  cached: async (_key: string, _ttl: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined,
}))
vi.mock('../../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})

const A = LEGACY_WORKSPACE_ID
const OTHER = 'ws_google_ad_details_other'

/** The stand-in read services: each business's rows, the calls made, and how many rows a service gives per page. */
const g = vi.hoisted(() => {
  type Row = Record<string, any>
  const READ_AT = '2026-10-12T06:30:00.000Z'
  const read = (resource: string, readAt: string | null = READ_AT, lastStatus: string | null = 'SUCCESS', lastError: string | null = null) =>
    ({ resource, readAt, lastAttemptAt: readAt, lastStatus, lastError })
  const metrics = (spendCents: number, clicks: number, conversions: number, conversionValueCents: number) => ({
    impressions: clicks * 20, clicks, spendCents, conversions, conversionValueCents, ctr: 0.05,
    avgCpcCents: clicks ? Math.round(spendCents / clicks) : null, roas: spendCents ? conversionValueCents / spendCents : null,
    costPerConversionCents: conversions ? Math.round(spendCents / conversions) : null,
  })
  const window = { from: '2026-09-13', to: '2026-10-12', provisionalFrom: '2026-09-29' }
  const coverage = { daysInWindow: 30, daysRead: 30, missingDays: [] as string[] }
  const brandTerms = (terms: string[]) => ({ terms, source: 'protected_terms' as const, editHref: '/marketing/ads/rules?tab=control-room' })

  function business(mark: string, campaigns: Row[]) {
    const [c1, c2] = campaigns
    const c2Ref = c2 ?? c1
    return {
      campaigns,
      adGroups: [
        { ...c1, adGroupId: `${mark}-ag-3`, externalAdGroupId: '3003', name: `${mark} Charlie gloves`, status: 'ENABLED', primaryStatus: 'ELIGIBLE', primaryStatusReasons: [], type: 'SEARCH_STANDARD', cpcBidCents: 87, targetCpaCents: null, targetRoas: null, searchTermMatching: 'on', settingsReadAt: READ_AT, metrics: metrics(4321, 41, 2, 9753) },
        { ...c1, adGroupId: `${mark}-ag-1`, externalAdGroupId: '3001', name: `${mark} Alpha boots`, status: 'PAUSED', primaryStatus: 'PAUSED', primaryStatusReasons: ['AD_GROUP_PAUSED'], type: 'SEARCH_STANDARD', cpcBidCents: 65, targetCpaCents: 1234, targetRoas: 3.75, searchTermMatching: null, settingsReadAt: READ_AT, metrics: null },
        { ...c2Ref, adGroupId: `${mark}-ag-2`, externalAdGroupId: '3002', name: `${mark} Bravo jackets`, status: 'ENABLED', primaryStatus: 'ELIGIBLE', primaryStatusReasons: [], type: 'SHOPPING_PRODUCT_ADS', cpcBidCents: null, targetCpaCents: null, targetRoas: null, searchTermMatching: 'not_applicable', settingsReadAt: READ_AT, metrics: metrics(2468, 19, 1, 3579) },
      ],
      keywords: [
        ['kw-1', 'race jacket', 'EXACT', 1357], ['kw-2', 'winter gloves', 'PHRASE', 4321], ['kw-3', 'rain boots', 'BROAD', 2468],
        ['kw-4', 'touring helmet', 'EXACT', 0], ['kw-5', 'leather trousers', 'PHRASE', 3579],
      ].map(([id, text, matchType, spend]) => ({
        ...c1, keywordId: `${mark}-${id}`, externalCriterionId: `4${String(id).slice(-1)}`, adGroupId: `${mark}-ag-3`, externalAdGroupId: '3003', adGroupName: `${mark} Charlie gloves`,
        text: `${mark === 'other' ? 'OTHERCANARY ' : ''}${text}`, matchType, status: 'ENABLED', servingStatus: 'ELIGIBLE', approvalStatus: 'APPROVED', primaryStatus: 'ELIGIBLE',
        qualityScore: 7, cpcBidCents: 91, effectiveCpcBidCents: 92, settingsReadAt: READ_AT, metrics: metrics(Number(spend), 9, 0, 0),
      })),
      negatives: [
        { negativeId: `${mark}-neg-1`, level: 'ad_group', kind: 'keyword', text: 'free', matchType: 'BROAD', campaignId: c1.campaignId, externalCampaignId: c1.externalCampaignId, campaignName: c1.campaignName, adGroupId: `${mark}-ag-3`, adGroupName: `${mark} Charlie gloves`, listId: null, listName: null, status: 'ENABLED', seenAt: READ_AT },
        { negativeId: `${mark}-neg-2`, level: 'campaign', kind: 'brand_list', text: null, matchType: null, campaignId: c1.campaignId, externalCampaignId: c1.externalCampaignId, campaignName: c1.campaignName, adGroupId: null, adGroupName: null, listId: null, listName: null, status: 'ENABLED', seenAt: READ_AT },
        { negativeId: `${mark}-neg-3`, level: 'list', kind: 'keyword', text: 'cheap', matchType: 'PHRASE', campaignId: null, externalCampaignId: null, campaignName: null, adGroupId: null, adGroupName: null, listId: `${mark}-list-1`, listName: 'Shared negatives', status: null, seenAt: READ_AT },
      ],
      negativeLists: [
        // The account-level list: Google applies it to the whole account, never through a campaign.
        { listId: `${mark}-list-2`, externalListId: '5002', name: 'Account negatives', status: 'ENABLED', memberCount: 0, accountLevel: true, appliesToAccount: true, campaigns: [], seenAt: READ_AT },
        { listId: `${mark}-list-1`, externalListId: '5001', name: 'Shared negatives', status: 'ENABLED', memberCount: 1, accountLevel: false, appliesToAccount: false, campaigns: [{ campaignId: c1.campaignId, externalCampaignId: c1.externalCampaignId, name: c1.campaignName }], seenAt: READ_AT },
      ],
      searchTerms: [
        ['st-1', 'acme race jacket', true, 2468], ['st-2', 'cheap jacket', false, 4321], ['st-3', 'acme boots', true, 1357], ['st-4', 'gloves for winter', false, 3579],
      ].map(([id, term, brand, spend]) => ({ ...c1, termId: `${mark}-${id}`, term, brand, metrics: metrics(Number(spend), 7, 0, 0) })),
      brandSplit: (['ALL', 'SEARCH', 'SHOPPING', 'PERFORMANCE_MAX'] as const).map((campaignType, i) => ({
        campaignType, total: metrics(8642 - i, 30, 3, 9753), brand: metrics(3825, 14, 2, 6420), nonBrand: metrics(4321, 12, 1, 3333), notInSearchTerms: metrics(496 - i, 4, 0, 0),
      })),
      assetGroups: [
        { ...c2Ref, assetGroupId: `${mark}-asg-2`, externalAssetGroupId: '6002', name: `${mark} Spring`, status: 'ENABLED', primaryStatus: 'ELIGIBLE', primaryStatusReasons: [], adStrength: 'GOOD', finalUrls: ['https://shop.example.test/spring'], settingsReadAt: READ_AT, metrics: metrics(1357, 11, 1, 2468) },
        { ...c2Ref, assetGroupId: `${mark}-asg-1`, externalAssetGroupId: '6001', name: `${mark} Autumn`, status: 'PAUSED', primaryStatus: 'PAUSED', primaryStatusReasons: [], adStrength: 'POOR', finalUrls: [], settingsReadAt: READ_AT, metrics: null },
      ],
      products: [
        ['p-1', 'sku-a1', 'Test jacket', 'no_issue', 2468], ['p-2', 'sku-a2', 'Test gloves', 'not_eligible', 4321], ['p-3', 'sku-a3', 'Test boots', 'limited', 0],
      ].map(([key, itemId, title, status, spend]) => ({
        productKey: `${mark}-${key}`, itemId, title, campaignId: c2Ref.campaignId, externalCampaignId: c2Ref.externalCampaignId, campaignName: c2Ref.campaignName, campaignType: 'SHOPPING',
        status, issues: status === 'not_eligible' ? [{ code: 'missing_gtin', severity: 'DISAPPROVED', text: 'Missing GTIN', explanation: 'Add the product\'s barcode.', helpUrl: null, regions: ['IT'] }] : [],
        nexusProduct: itemId === 'sku-a1' ? { productId: `${mark}-prod-1`, sku: 'SKU-A1', name: 'Test jacket' } : null, metrics: metrics(Number(spend), 5, 0, 0),
      })),
      acts: {
        autoApply: { enabled: [{ type: 'KEYWORD', typeText: 'Add keywords', since: '2026-09-01T00:00:00.000Z', changedAt: null }], paused: [] },
        campaigns: [{ campaignId: c1.campaignId, externalCampaignId: c1.externalCampaignId, name: c1.campaignName, type: 'SEARCH', status: 'ENABLED', aiMax: 'off', campaignBroadMatch: 'on', searchPartners: 'on', displayExpansion: 'off', finalUrlExpansion: null, finalUrlExpansionByDefault: false, textCustomization: 'off', dynamicSearchAds: 'off', brandExclusions: 0, adGroupsWithoutSearchTermMatching: 1, movedToAiMaxAt: null, flagsReadAt: READ_AT }],
        changes: ['2026-10-11T09:00:00.000Z', '2026-10-12T05:00:00.000Z', '2026-10-10T12:00:00.000Z'].map((changedAt, i) => ({
          changedAt, campaignId: c1.campaignId, externalCampaignId: c1.externalCampaignId, campaignName: c1.campaignName, resourceType: 'AD_GROUP_CRITERION', operation: 'CREATE', changedFields: [],
          source: 'google_automatic', sourceText: 'Google, on its own', who: i === 0 ? 'google_auto_apply' : 'person', watched: false, summary: 'Ad group keyword or targeting added. Google did it on its own.',
        })),
      },
      recommendations: [
        { recommendationId: `${mark}-rec-2`, type: 'KEYWORD', typeText: 'Add keywords', explanation: 'Google suggests new keywords.', ...c1, adGroupName: null, autoApplied: true, impact: { base: { impressions: 100, clicks: 5, spendCents: 5555, conversions: 1, conversionValueCents: 6666 }, potential: { impressions: 150, clicks: 8, spendCents: 7171, conversions: 2, conversionValueCents: 8181 } } },
        { recommendationId: `${mark}-rec-1`, type: 'CAMPAIGN_BUDGET', typeText: 'Raise the budget', explanation: 'Google suggests a larger budget.', ...c1, adGroupName: null, autoApplied: false, impact: null },
      ].map(({ campaignType: _type, ...rec }) => rec),
      alerts: {
        checkedAt: READ_AT,
        items: [{ alertId: `${mark}-al-1`, kind: 'spend_pace', severity: 'warn', title: 'Spent ahead of its budget', body: 'Yesterday this campaign spent well above its daily budget.', campaignId: c1.campaignId, externalCampaignId: c1.externalCampaignId, campaignName: c1.campaignName, since: '2026-10-12', numbers: { spendCents: 7777, dailyBudgetCents: 3333 }, href: '/marketing/ads/google?view=campaigns' }],
        notChecked: [{ kind: 'month_pace', reason: 'Not every day of this month is read yet.' }],
      },
      disapprovals: {
        ads: [{ adId: `${mark}-ad-1`, externalAdId: '7001', adType: 'RESPONSIVE_SEARCH_AD', campaignId: c1.campaignId, campaignName: c1.campaignName, adGroupId: `${mark}-ag-3`, adGroupName: `${mark} Charlie gloves`, status: 'DISAPPROVED', reviewStatus: 'REVIEWED', reasons: ['Destination not working'], since: READ_AT }],
        products: [{ itemId: 'sku-a2', title: 'Test gloves', status: 'not_eligible', issues: [], since: READ_AT }],
      },
    }
  }
  const campaign = (campaignId: string, externalCampaignId: string, campaignName: string, campaignType: string) => ({ campaignId, externalCampaignId, campaignName, campaignType })
  const rows: Record<string, ReturnType<typeof business>> = {
    a: business('a', [campaign('gc-a1', '701', 'Test search campaign', 'SEARCH'), campaign('gc-a2', '702', 'Test shopping campaign', 'SHOPPING')]),
    other: business('other', [campaign('gc-other', '799', 'OTHERCANARY campaign', 'SEARCH')]),
  }
  return {
    READ_AT, read, window, coverage, brandTerms, rows,
    /** Google sign-ins per business (google-accounts.service.ts). */
    accounts: {} as Record<string, unknown[]>,
    calls: [] as Array<{ fn: string; input: Record<string, any> }>,
    /** The most rows a service gives per call (the real ones allow more; small here, so the tool must follow them). */
    servicePage: 2,
    /** A read state to answer instead of the ordinary one, per service. */
    unread: {} as Record<string, ReturnType<typeof read>>,
    /** Extra synthetic ad groups (the read cap). */
    extraAdGroups: 0,
  }
})

// The read services, stood in (see the header). Another business's campaign is not found, as the real ones answer.
vi.mock('../../google/google-accounts.service.js', async () => {
  const { workspaceIdForQuery } = await import('../../../lib/workspace-context.js')
  return { listGoogleAccounts: async () => g.accounts[workspaceIdForQuery()] ?? [] }
})
async function serviceTools() {
  const { workspaceIdForQuery } = await import('../../../lib/workspace-context.js')
  const { GoogleAdsReadError } = await import('../../marketing/google-ads/read.service.js')
  type Row = Record<string, any>
  const mine = () => (workspaceIdForQuery() === OTHER ? g.rows.other : g.rows.a)
  const record = (fn: string, input: Record<string, any>) => {
    g.calls.push({ fn, input })
    const own = mine()
    if (input.campaignId && !own.campaigns.some((c) => c.campaignId === input.campaignId)) throw new GoogleAdsReadError(404, 'Campaign not found')
    return own
  }
  const readOf = (fn: string, resource: string) => g.unread[fn] ?? g.read(resource)
  function list(rows: Row[], input: Record<string, any>, text: (row: Row) => string) {
    let out = rows.filter((row) => !input.campaignId || row.campaignId === input.campaignId)
    if (input.search) out = out.filter((row) => text(row).toLowerCase().includes(String(input.search).toLowerCase()))
    if (input.sort === 'spend') out = [...out].sort((x, y) => (y.metrics?.spendCents ?? -1) - (x.metrics?.spendCents ?? -1))
    const from = Number(input.cursor ?? 0)
    const size = Math.min(Number(input.limit ?? 100), g.servicePage)
    return { items: out.slice(from, from + size), nextCursor: from + size < out.length ? String(from + size) : null, total: out.length }
  }
  const numbersBase = (fn: string, structure: string, numbers: string) =>
    ({ window: g.window, currency: 'EUR', dataAsOf: g.READ_AT, read: readOf(fn, structure), numbersRead: g.unread[`${fn}:numbers`] ?? g.read(numbers), coverage: g.coverage })
  const synthetic = (n: number) => Array.from({ length: n }, (_, i) => ({ ...g.rows.a.adGroups[0], adGroupId: `syn-${String(i).padStart(4, '0')}`, name: `Synthetic ${String(i).padStart(4, '0')}` }))
  return { record, list, readOf, numbersBase, synthetic }
}
vi.mock('../../marketing/google-ads/read-detail.service.js', async (importOriginal) => {
  const s = await serviceTools()
  return {
    ...(await importOriginal<object>()),
    googleAdsAdGroups: async (input: Record<string, any>) => {
      const own = s.record('googleAdsAdGroups', input)
      const rows = [...own.adGroups, ...s.synthetic(g.extraAdGroups)].sort((x, y) => (x.name < y.name ? -1 : 1))
      return { ...s.numbersBase('googleAdsAdGroups', 'AD_GROUPS', 'AD_GROUP_DAYS'), ...s.list(rows, input, (r) => r.name) }
    },
    googleAdsKeywords: async (input: Record<string, any>) => {
      const own = s.record('googleAdsKeywords', input)
      return { ...s.numbersBase('googleAdsKeywords', 'KEYWORDS', 'KEYWORD_DAYS'), ...s.list(own.keywords, input, (r) => r.text) }
    },
    googleAdsNegatives: async (input: Record<string, any>) => {
      const own = s.record('googleAdsNegatives', input)
      return {
        read: { adGroup: s.readOf('googleAdsNegatives', 'KEYWORDS'), campaign: s.readOf('googleAdsNegatives', 'CAMPAIGN_NEGATIVES'), lists: s.readOf('googleAdsNegatives', 'NEGATIVE_LISTS') },
        lists: own.negativeLists, ...s.list(own.negatives, input, (r) => r.text ?? ''),
      }
    },
    googleAdsAssetGroups: async (input: Record<string, any>) => {
      const own = s.record('googleAdsAssetGroups', input)
      return { ...s.numbersBase('googleAdsAssetGroups', 'ASSET_GROUPS', 'ASSET_GROUP_DAYS'), ...s.list([...own.assetGroups].reverse(), input, (r) => r.name) }
    },
    googleAdsProducts: async (input: Record<string, any>) => {
      const own = s.record('googleAdsProducts', input)
      return {
        window: g.window, currency: 'EUR', dataAsOf: g.READ_AT, numbersRead: s.readOf('googleAdsProducts', 'PRODUCT_DAYS'), statusRead: g.unread['googleAdsProducts:status'] ?? g.read('PRODUCT_STATUS'),
        coverage: g.coverage, ...s.list(own.products, input, (r) => `${r.title} ${r.itemId}`),
      }
    },
    googleAdsDisapprovals: async (input: Record<string, any>) => {
      const own = s.record('googleAdsDisapprovals', input)
      return { read: { ads: s.readOf('googleAdsDisapprovals', 'AD_POLICY'), products: g.read('PRODUCT_STATUS') }, ...own.disapprovals, truncated: false }
    },
  }
})
vi.mock('../../marketing/google-ads/read-search-terms.service.js', async (importOriginal) => {
  const s = await serviceTools()
  return {
    ...(await importOriginal<object>()),
    googleAdsSearchTerms: async (input: Record<string, any>) => {
      const own = s.record('googleAdsSearchTerms', input)
      return {
        window: g.window, currency: 'EUR', dataAsOf: g.READ_AT, read: s.readOf('googleAdsSearchTerms', 'SEARCH_TERM_DAYS'), coverage: g.coverage,
        scope: 'terms_with_clicks', brandTerms: g.brandTerms(['acme']), ...s.list(own.searchTerms, input, (r) => r.term),
      }
    },
    googleAdsBrandSplit: async (input: Record<string, any>) => {
      const own = s.record('googleAdsBrandSplit', input)
      return { window: g.window, currency: 'EUR', dataAsOf: g.READ_AT, read: s.readOf('googleAdsBrandSplit', 'SEARCH_TERM_DAYS'), coverage: g.coverage, brandTerms: g.brandTerms([]), rows: own.brandSplit }
    },
  }
})
vi.mock('../../marketing/google-ads/read-acts.service.js', async (importOriginal) => {
  const s = await serviceTools()
  return {
    ...(await importOriginal<object>()),
    googleAdsActsOnItsOwn: async (input: Record<string, any>) => {
      const own = s.record('googleAdsActsOnItsOwn', input)
      const changes = [...own.acts.changes].sort((x, y) => (x.changedAt < y.changedAt ? 1 : -1))
      return {
        read: { autoApply: g.read('AUTO_APPLY'), settings: g.read('CAMPAIGN_SETTINGS'), adGroups: g.read('AD_GROUPS'), campaignNegatives: g.read('CAMPAIGN_NEGATIVES') },
        autoApply: own.acts.autoApply, campaigns: own.acts.campaigns,
        outsideChanges: { nexusWrites: 0, coveredFrom: '2026-09-14T00:00:00.000Z', coveredThrough: g.READ_AT, bySource: [{ source: 'google_automatic', sourceText: 'Google, on its own', count: 3 }], items: changes },
      }
    },
    googleAdsRecommendations: async (input: Record<string, any>) => {
      const own = s.record('googleAdsRecommendations', input)
      return { read: g.read('RECOMMENDATIONS'), currency: 'EUR', writes: { mode: 'none' }, items: own.recommendations, byType: [{ type: 'KEYWORD', typeText: 'Add keywords', count: 1 }, { type: 'CAMPAIGN_BUDGET', typeText: 'Raise the budget', count: 1 }] }
    },
  }
})
vi.mock('../../marketing/google-ads/alerts.service.js', async (importOriginal) => {
  const s = await serviceTools()
  return {
    ...(await importOriginal<object>()),
    googleAdsAlerts: async (input: Record<string, any>) => s.record('googleAdsAlerts', input).alerts,
  }
})

import { callTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'

const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
function principal(workspaceId: string, permissions: string[]): UserPrincipal {
  return {
    kind: 'user',
    userId: 'u-google-details',
    label: 'Google details test',
    permissions: { isOwner: false, permissions: new Set(permissions) },
    workspace: business(workspaceId),
    via: 'claude',
  }
}
/** Sees every money field. */
const cleared = (workspaceId = A) => principal(workspaceId, [...Object.values(FEATURES), ...Object.values(FIELDS)])
/** May read ads, sees no money. */
const operator = (workspaceId = A) => principal(workspaceId, [FEATURES.aiRun, FEATURES.adsView])

type Row = Record<string, any>
interface Answer { ok: boolean; error?: string; data?: Row }
async function call(args: Record<string, unknown>, who: UserPrincipal = cleared()): Promise<Answer> {
  return (await callTool(who, 'google-ad-details', args)).visible as Answer
}
async function walk(args: Record<string, unknown>, limit: number) {
  const items: Row[] = []
  const cursors: string[] = []
  let cursor: string | null = null
  let pages = 0
  do {
    const answer: Answer = await call({ ...args, limit, ...(cursor ? { cursor } : {}) })
    expect(answer.ok, answer.error).toBe(true)
    expect(answer.data!.items.length).toBeLessThanOrEqual(limit)
    items.push(...answer.data!.items)
    cursor = answer.data!.nextCursor
    if (cursor) cursors.push(cursor)
    pages++
  } while (cursor && pages < 60)
  return { items, cursors }
}
const pick = (items: Row[], key: string) => items.map((item) => item[key])
/** What a cursor holds: its sort values. */
const cursorValues = (cursor: string) => (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { k: unknown[] }).k

function googleAccount(connectionId: string, customerId: string, name: string) {
  return {
    connectionId, label: 'Test Google sign-in', state: 'ok', stateText: 'Nexus reads this account once a day.', authStatus: 'connected', missingProducts: [],
    ads: { customerId, name, currency: 'EUR', timeZone: 'Europe/Rome', isTest: false }, manager: null, merchantCenter: null, analytics: null,
    read: { lastReadAt: g.READ_AT, lastDataDay: '2026-10-11', nextReadAt: null, lastError: null },
  }
}

beforeAll(async () => {
  database = await formulaDatabase()
}, 180_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

beforeEach(() => {
  g.accounts[A] = [googleAccount('conn-g-a', '9080706050', 'Test Google advertiser')]
  g.accounts[OTHER] = [googleAccount('conn-g-other', '9080706051', 'OTHERCANARY advertiser')]
  g.calls.length = 0
  g.unread = {}
  g.extraAdGroups = 0
  g.servicePage = 2
})

const VIEWS = ['ad-groups', 'keywords', 'negatives', 'search-terms', 'brand-split', 'asset-groups', 'products', 'acts-on-its-own', 'recommendations', 'alerts', 'disapprovals']
const SERVICE: Record<string, string> = {
  'ad-groups': 'googleAdsAdGroups', keywords: 'googleAdsKeywords', negatives: 'googleAdsNegatives', 'search-terms': 'googleAdsSearchTerms',
  'brand-split': 'googleAdsBrandSplit', 'asset-groups': 'googleAdsAssetGroups', products: 'googleAdsProducts', 'acts-on-its-own': 'googleAdsActsOnItsOwn',
  recommendations: 'googleAdsRecommendations', alerts: 'googleAdsAlerts', disapprovals: 'googleAdsDisapprovals',
}
const WINDOWED = ['ad-groups', 'keywords', 'search-terms', 'brand-split', 'asset-groups', 'products']

// ── every view ───────────────────────────────────────────────────────────────────────────────────────

describe('Google Ads 1b — google-ad-details: every view, from the page\'s own read services', () => {
  it('each view answers for the chosen account, names it, reads only through its service, and changes nothing', async () => {
    const view = getTool('google-ad-details')!.input.shape.view
    for (const name of VIEWS) expect(view.safeParse(name).success, name).toBe(true)
    for (const name of VIEWS) {
      g.calls.length = 0
      const answer = await call({ view: name })
      expect(answer.ok, `${name}: ${answer.error}`).toBe(true)
      expect(answer.data).toMatchObject({
        channel: 'google', view: name, writes: { mode: 'none', text: expect.stringContaining('a person makes every change in Google Ads') },
        account: { accountId: 'conn-g-a', name: 'Test Google advertiser', googleAdsAccount: { customerId: '9080706050', currency: 'EUR' } },
      })
      expect(answer.data!.empty, name).toBeUndefined()
      // Only the view's own service, for the chosen account, and the window's days where it has one (30 by default).
      expect([...new Set(g.calls.map((c) => c.fn))], name).toEqual([SERVICE[name]])
      for (const { input } of g.calls) {
        expect(input.connectionId, name).toBe('conn-g-a')
        expect(input.days, name).toBe(WINDOWED.includes(name) ? 30 : undefined)
      }
      if (WINDOWED.includes(name)) {
        expect(answer.data, name).toMatchObject({ currency: 'EUR', window: { from: '2026-09-13', to: '2026-10-12', days: 30, provisionalFrom: '2026-09-29' }, counting: expect.stringContaining('as Google counts them') })
      }
    }
  })

  it('what each view holds, under the page\'s own names', async () => {
    const terms = (await call({ view: 'search-terms' })).data!
    expect(terms).toMatchObject({ scope: 'terms_with_clicks', scopeText: expect.stringContaining('at least one click'), brandTerms: { terms: ['acme'] }, brandText: expect.stringContaining('protected terms') })
    expect(terms.items[0]).toMatchObject({ termId: 'a-st-2', term: 'cheap jacket', brand: false, campaignId: 'gc-a1' })
    // No brand terms: brand is null, never "not brand", and the answer says so.
    expect((await call({ view: 'brand-split' })).data).toMatchObject({ brandTerms: { terms: [] }, brandText: expect.stringContaining('brand null, never "not brand"'), rows: expect.arrayContaining([expect.objectContaining({ campaignType: 'ALL' })]) })
    const negatives = (await call({ view: 'negatives' })).data!
    expect(negatives.lists).toEqual(g.rows.a.negativeLists)
    expect(negatives.lists.map((l: { name: string; accountLevel: boolean | null; appliesToAccount: boolean | null }) => [l.name, l.accountLevel, l.appliesToAccount]))
      .toEqual([['Account negatives', true, true], ['Shared negatives', false, false]])
    expect(pick(negatives.items, 'level').sort()).toEqual(['ad_group', 'campaign', 'list'])
    const acts = (await call({ view: 'acts-on-its-own' })).data!
    expect(acts).toMatchObject({ autoApply: { enabled: [{ type: 'KEYWORD' }] }, campaigns: [{ campaignId: 'gc-a1', aiMax: 'off', finalUrlExpansion: null }], outsideChanges: { nexusWrites: 0, bySource: [{ source: 'google_automatic', count: 3 }] }, unseen: expect.stringContaining('Google Ads Editor') })
    expect(pick(acts.items, 'changedAt')).toEqual(['2026-10-12T05:00:00.000Z', '2026-10-11T09:00:00.000Z', '2026-10-10T12:00:00.000Z']) // newest first
    const recs = (await call({ view: 'recommendations' })).data!
    expect(recs).toMatchObject({ byType: [{ type: 'KEYWORD' }, { type: 'CAMPAIGN_BUDGET' }], recommendationsText: expect.stringContaining('applies and dismisses none') })
    expect(pick(recs.items, 'recommendationId')).toEqual(['a-rec-2', 'a-rec-1']) // by type in words
    const alerts = (await call({ view: 'alerts' })).data!
    expect(alerts).toMatchObject({ checkedAt: g.READ_AT, items: [{ kind: 'spend_pace', title: 'Spent ahead of its budget' }], notChecked: [{ kind: 'month_pace' }] })
    const issues = (await call({ view: 'disapprovals' })).data!
    expect(issues.items.map((r: Row) => `${r.kind} ${r.adId ?? r.itemId}`)).toEqual(['ad a-ad-1', 'product sku-a2'])
    expect((await call({ view: 'products' })).data!.items[0]).toMatchObject({ productKey: 'a-p-2', status: 'not_eligible', issues: [{ text: 'Missing GTIN' }] })
  })
})

// ── lists and cursors ────────────────────────────────────────────────────────────────────────────────

describe('Google Ads 1b — google-ad-details pages each list whole, never by an amount', () => {
  it('reads the service whole (its own pages followed) and pages here: each row once, in the service\'s order', async () => {
    const order: Record<string, [string, string[]]> = {
      'ad-groups': ['adGroupId', ['a-ag-1', 'a-ag-2', 'a-ag-3']], // by name
      keywords: ['keywordId', ['a-kw-2', 'a-kw-5', 'a-kw-3', 'a-kw-1', 'a-kw-4']], // by cost, highest first
      'search-terms': ['termId', ['a-st-2', 'a-st-4', 'a-st-1', 'a-st-3']],
      products: ['productKey', ['a-p-2', 'a-p-1', 'a-p-3']],
      'asset-groups': ['assetGroupId', ['a-asg-1', 'a-asg-2']],
      negatives: ['negativeId', ['a-neg-1', 'a-neg-2', 'a-neg-3']],
      recommendations: ['recommendationId', ['a-rec-2', 'a-rec-1']],
    }
    for (const [view, [key, expected]] of Object.entries(order)) {
      g.calls.length = 0
      const whole = (await call({ view, limit: 100 })).data!
      expect({ view, rows: pick(whole.items, key) }).toEqual({ view, rows: expected })
      expect(whole).toMatchObject({ total: expected.length, nextCursor: null })
      // The service gives 2 rows a call here: the tool followed its cursor to the end.
      const asked = g.calls.filter((c) => c.fn === SERVICE[view])
      if (expected.length > 2 && view !== 'recommendations') expect(asked.map((c) => c.input.cursor ?? null), view).toEqual([null, '2', ...(expected.length > 4 ? ['4'] : [])])
      const { items, cursors } = await walk({ view }, 1)
      expect({ view, rows: pick(items, key) }).toEqual({ view, rows: expected })
      // A ranked list's cursor holds only a place; a keyset cursor holds names and dates. Never an amount.
      for (const cursor of cursors) {
        const values = cursorValues(cursor)
        if (['keywords', 'search-terms', 'products'].includes(view)) expect({ view, values: values.map((v) => typeof v) }).toEqual({ view, values: ['number'] })
        else expect({ view, values: values.map((v) => typeof v) }).toEqual({ view, values: values.map(() => 'string') })
      }
    }
    // Ranked by cost: keywords, search terms and products ask their service for that order.
    g.calls.length = 0
    for (const view of ['keywords', 'search-terms', 'products']) await call({ view })
    expect(g.calls.length).toBeGreaterThan(3)
    expect([...new Set(g.calls.map((c) => c.input.sort))]).toEqual(['spend'])
  })

  it('the outside changes, the disapprovals and the recommendations page too', async () => {
    const { items } = await walk({ view: 'acts-on-its-own' }, 2)
    expect(pick(items, 'changedAt')).toEqual(['2026-10-12T05:00:00.000Z', '2026-10-11T09:00:00.000Z', '2026-10-10T12:00:00.000Z'])
    const issues = await walk({ view: 'disapprovals' }, 1)
    expect(issues.items.map((r) => r.kind)).toEqual(['ad', 'product'])
  })

  it('a cursor belongs to one view, one set of filters and one business', async () => {
    const cursor = (await call({ view: 'ad-groups', limit: 1 })).data!.nextCursor as string
    expect(cursor).toBeTruthy()
    const refused = (answer: Answer) => expect(answer).toMatchObject({ ok: false, error: expect.stringContaining('cursor') })
    refused(await call({ view: 'asset-groups', limit: 1, cursor }))
    refused(await call({ view: 'ad-groups', limit: 1, search: 'alpha', cursor }))
    refused(await call({ view: 'ad-groups', limit: 1, days: 7, cursor }))
    refused(await call({ view: 'ad-groups', limit: 1, cursor }, cleared(OTHER)))
    expect((await call({ view: 'ad-groups', limit: 1, cursor })).ok).toBe(true)
  })

  it('a list longer than the read cap says how many rows it left out', async () => {
    g.extraAdGroups = 2100
    g.servicePage = 500
    const page = (await call({ view: 'ad-groups', limit: 5 })).data!
    expect(page).toMatchObject({ total: 2103, truncated: 'Only the first 2000 of 2103 rows were read: narrow with campaignId or search.' })
    expect(page.items).toHaveLength(5)
  }, 60_000)
})

// ── filters, refusals, words ─────────────────────────────────────────────────────────────────────────

describe('Google Ads 1b — google-ad-details filters and words', () => {
  it('passes the filters a view takes to its service, and refuses one it does not take', async () => {
    await call({ view: 'keywords', campaignId: 'gc-a1', search: 'jacket', days: 7 })
    expect(g.calls[0]).toMatchObject({ fn: 'googleAdsKeywords', input: { connectionId: 'conn-g-a', campaignId: 'gc-a1', search: 'jacket', days: 7, sort: 'spend' } })
    expect(pick((await call({ view: 'keywords', search: 'JACKET' })).data!.items, 'keywordId')).toEqual(['a-kw-1'])
    expect((await call({ view: 'ad-groups', campaignId: 'gc-a2' })).data!.items.map((r: Row) => r.adGroupId)).toEqual(['a-ag-2'])
    expect(await call({ view: 'alerts', campaignId: 'gc-a1' })).toEqual({ ok: false, error: 'View alerts reads the whole account: leave campaignId out.' })
    expect(await call({ view: 'brand-split', campaignId: 'gc-a1' })).toEqual({ ok: false, error: 'View brand-split reads the whole account: leave campaignId out.' })
    expect(await call({ view: 'negatives', days: 7 })).toEqual({ ok: false, error: 'View negatives has no window of days: leave days out.' })
    expect(await call({ view: 'asset-groups', search: 'spring' })).toEqual({ ok: false, error: 'View asset-groups takes no search: leave search out.' })
    expect(await call({ view: 'brand-split', limit: 5 })).toEqual({ ok: false, error: 'View brand-split is one short answer with no pages: leave limit and cursor out.' })
    // The view is named, always.
    await expect(callTool(cleared(), 'google-ad-details', {})).rejects.toMatchObject({ code: 'invalid_arguments' })
    await expect(callTool(cleared(), 'google-ad-details', { view: 'campaigns' })).rejects.toMatchObject({ code: 'invalid_arguments' })
  })

  it('no Google, or no Google Ads account chosen: the reason in words, and no service is asked', async () => {
    g.accounts[A] = []
    expect((await call({ view: 'keywords' })).data).toMatchObject({ account: null, items: [], total: 0, empty: expect.stringMatching(/^Google is not connected for this business/) })
    g.accounts[A] = [{ ...googleAccount('conn-g-a', '9080706050', 'Test Google advertiser'), ads: null, state: 'choose_account' }]
    const split = (await call({ view: 'brand-split' })).data!
    expect(split).toMatchObject({ empty: expect.stringMatching(/^No Google Ads account is chosen/) })
    expect(split.rows).toBeUndefined()
    expect(g.calls).toEqual([])
  })

  it('a part Nexus has not read yet says so, with why the last try did not read it; numbers not read are null, never 0', async () => {
    g.unread.googleAdsAdGroups = g.read('AD_GROUPS', null, 'FAILED', 'Google refused the read: try again later.')
    expect((await call({ view: 'ad-groups' })).data!.empty).toBe('Nexus has not read the ad groups from Google yet. The last try failed: Google refused the read: try again later.')
    g.unread.googleAdsSearchTerms = g.read('SEARCH_TERM_DAYS', null, 'SKIPPED_BUDGET')
    expect((await call({ view: 'search-terms' })).data!.empty).toMatch(/^Nexus has not read the search terms from Google yet\. The last read left it out/)
    g.unread['googleAdsKeywords:numbers'] = g.read('KEYWORD_DAYS', null, null)
    const keywords = (await call({ view: 'keywords' })).data!
    expect(keywords.numbersNotRead).toBe('Nexus has not read the keywords\' numbers from Google yet. Their metrics are null (not read), never 0.')
    expect(keywords.empty).toBeUndefined()
    expect((await call({ view: 'keywords', search: 'nothing like it' })).data!.empty).toBe('No keyword matches these filters.')
  })
})

// ── one business ─────────────────────────────────────────────────────────────────────────────────────

describe('Google Ads 1b — google-ad-details reads only its own business', () => {
  it('another business\'s account and campaign are not found; inside that business they read (control)', async () => {
    expect(await call({ view: 'ad-groups', accountId: 'conn-g-other' })).toEqual({ ok: false, error: 'Google account not found' })
    for (const view of ['ad-groups', 'keywords', 'search-terms', 'products', 'recommendations', 'disapprovals', 'negatives', 'asset-groups']) {
      expect(await call({ view, campaignId: 'gc-other' }), view).toEqual({ ok: false, error: 'Campaign not found' })
    }
    for (const view of VIEWS) expect(JSON.stringify(await call({ view }))).not.toContain('OTHERCANARY')
    const theirs = await call({ view: 'keywords', campaignId: 'gc-other' }, cleared(OTHER))
    expect(theirs.data!.account).toMatchObject({ accountId: 'conn-g-other' })
    expect(JSON.stringify(theirs)).toContain('OTHERCANARY')
  })
})

// ── money ────────────────────────────────────────────────────────────────────────────────────────────

describe('Google Ads 1b — money a person may not see never comes back', () => {
  const restricted = (key: string) =>
    Object.prototype.hasOwnProperty.call(RESTRICTED_FIELDS, key) || Object.prototype.hasOwnProperty.call(getTool('google-ad-details')!.restrictedFields ?? {}, key)
  function keysOf(value: unknown, out = new Set<string>()): Set<string> {
    if (Array.isArray(value)) value.forEach((v) => keysOf(v, out))
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); keysOf(v, out) }
    return out
  }

  it('a person without the ad-spend permission gets the same answer minus exactly the money keys, every view', async () => {
    for (const view of VIEWS) {
      const full = await call({ view }, cleared())
      const partial = await call({ view }, operator())
      expect(full.ok, `${view}: ${full.error}`).toBe(true)
      expect(partial.ok, `${view}: ${partial.error}`).toBe(true)
      const stripped = JSON.parse(JSON.stringify(full, (key, value) => (key && restricted(key) ? undefined : value)))
      expect({ view, answer: partial }).toEqual({ view, answer: stripped })
      expect({ view, leaked: [...keysOf(partial)].filter(restricted) }).toEqual({ view, leaked: [] })
      // Positive control: the money-cleared answer really carries money keys (negatives, disapprovals and what Google
      // does on its own hold none).
      if (!['negatives', 'disapprovals', 'acts-on-its-own'].includes(view)) expect({ view, money: [...keysOf(full)].some(restricted) }).toEqual({ view, money: true })
    }
  })

  it('bids, targets, a recommendation\'s impact and an alert\'s numbers are money; no amount reaches the operator', async () => {
    for (const key of ['cpcBidCents', 'effectiveCpcBidCents', 'targetCpaCents', 'targetRoas', 'impact', 'numbers', 'dailyBudgetCents']) expect(restricted(key), key).toBe(true)
    const amounts = ['4321', '2468', '9753', '1357', '3579', '1234', '3.75', '5555', '7171', '7777', '3333', '8642']
    for (const view of VIEWS) {
      const text = JSON.stringify(await call({ view }, operator()))
      expect({ view, found: amounts.filter((amount) => text.includes(amount)) }).toEqual({ view, found: [] })
    }
    // The cleared person does see them (the list above is not empty by mistake).
    const seen = JSON.stringify(await Promise.all(VIEWS.map((view) => call({ view }))))
    expect(amounts.filter((amount) => !seen.includes(amount))).toEqual([])
  })

  it('a reader needs ads.view: without it the read is refused', async () => {
    await expect(callTool(principal(A, [FEATURES.aiRun]), 'google-ad-details', { view: 'alerts' })).rejects.toMatchObject({ code: 'forbidden' })
  })
})
