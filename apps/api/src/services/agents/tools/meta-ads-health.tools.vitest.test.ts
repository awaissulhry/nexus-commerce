/**
 * Meta ads step 5 — meta-account-health and meta-activity-log. Every view asks Meta only with fixed field lists and only
 * what the real gateway lets through; only the chosen ad account, its own campaigns / ad sets / ads (checked BEFORE the
 * history is read), its conversions and pixels and the chosen Page are read; a pixel of a portfolio another business uses is
 * its id and a flag; who made a change is named only for Nexus's own system user (and the chosen Page); a person's role
 * change keeps no name or details; budget / bid / billing details are money (metaRaw). Meta and the database are stubbed;
 * made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Req = { operation: string; path: string; query?: Record<string, unknown> }
const h = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ operation: string; path: string; query?: Record<string, unknown> }>,
  answer: null as null | ((req: { operation: string; path: string; query?: Record<string, unknown> }) => unknown),
  taken: [] as Array<{ product: string; id: string }>,
  stored: { campaign: [] as string[], adset: [] as string[], ad: [] as string[] },
  children: { adSets: [] as string[], ads: [] as string[] },
  account: null as null | Record<string, unknown>,
  ledger: [] as Array<{ connectionId: string | null; errorCode: string | null; _count: { _all: number }; _max: { createdAt: Date | null } }>,
  notices: [] as Array<{ entityId: string }>,
  live: null as null | Record<string, unknown>,
}))
vi.mock('../../meta/meta-accounts.service.js', () => ({ listMetaConnections: vi.fn(async () => h.connections) }))
vi.mock('../../meta/meta-connection-live.js', () => ({ liveConnectionCheck: vi.fn(async () => h.live) }))
vi.mock('../../marketing/meta-ads/read-client.js', async () => {
  const answerOf = (req: Req) => {
    h.calls.push(req)
    const out = h.answer?.(req)
    if (out instanceof Error) throw out
    return (out ?? { data: [] }) as Record<string, unknown>
  }
  return {
    metaReadOne: vi.fn(async (_t: unknown, req: Req) => ({ body: answerOf(req), calls: 1 })),
    metaReadAll: vi.fn(async (_t: unknown, req: Req, onRows: (rows: unknown[]) => void) => {
      const body = answerOf(req)
      const rows = Array.isArray(body.data) ? body.data : []
      onRows(rows)
      return { rows: rows.length, calls: 1, truncated: false }
    }),
  }
})
vi.mock('../../../db.js', () => {
  return {
    default: {
      metaAdsCampaign: { findFirst: vi.fn(async (a: { where: Record<string, unknown> }) => (h.stored.campaign.includes(String(a.where.campaignId)) ? { id: 'row' } : null)), groupBy: vi.fn(async () => [{ effectiveStatus: 'WITH_ISSUES', _count: { _all: 1 } }]) },
      metaAdsAdSet: {
        findFirst: vi.fn(async (a: { where: Record<string, unknown> }) => (h.stored.adset.includes(String(a.where.adSetId)) ? { id: 'row' } : null)),
        findMany: vi.fn(async () => h.children.adSets.map((adSetId) => ({ adSetId }))),
        groupBy: vi.fn(async () => []),
      },
      metaAdsAd: {
        findFirst: vi.fn(async (a: { where: Record<string, unknown> }) => (a.where.adId !== undefined ? (h.stored.ad.includes(String(a.where.adId)) ? { id: 'row' } : null) : null)),
        findMany: vi.fn(async () => h.children.ads.map((adId) => ({ adId }))),
        groupBy: vi.fn(async () => [{ effectiveStatus: 'DISAPPROVED', _count: { _all: 2 } }, { effectiveStatus: 'PENDING_BILLING_INFO', _count: { _all: 1 } }]),
      },
      metaAdAccount: {
        findMany: vi.fn(async () => (h.account ? [h.account] : [])),
        findFirst: vi.fn(async () => h.account),
      },
      outboundApiCallLog: {
        groupBy: vi.fn(async (a: { by: string[] }) => (a.by.includes('errorCode') ? h.ledger.map((r) => (a.by.includes('connectionId') ? r : { errorCode: r.errorCode, _count: r._count, _max: r._max })) : [{ connectionId: 'conn-1', _count: { _all: 40 } }])),
        count: vi.fn(async () => 40),
      },
      notification: { findMany: vi.fn(async () => h.notices) },
      // nexus_meta_links_taken(product, ids): the ids of that product another business picked.
      $queryRaw: vi.fn(async (_s: unknown, product: string, ids: string[]) => h.taken.filter((t) => t.product === product && ids.includes(t.id)).map((t) => ({ id: t.id }))),
    },
  }
})

import { META_ADS_HEALTH_TOOLS } from './meta-ads-health.tools.js'
import { MetaReadError, failureOfAnswer } from '../../marketing/meta-ads/errors.js'
import { ACTIVITY_CATEGORIES, activityDetailsOf, throttleWords, HEALTH_VIEWS } from '../../marketing/meta-ads/live-health.js'
import { META_ACTIVITY_CATEGORIES } from '../../gateway/meta-calls.js'
import { metaUrl } from '../../gateway/meta.js'
import { metaReadOnlyProblem } from '../../gateway/meta-calls.js'
import { financialPayloadCopy } from '../../../lib/auth/field-filter.js'

const tool = (name: string) => META_ADS_HEALTH_TOOLS.find((t) => t.name === name)!
const ctx = { can: () => true, via: 'claude' as const }
const run = (name: string, args: Record<string, unknown>) => tool(name).handler(tool(name).input.parse(args), ctx as never)
const refusedByMeta = (words: string, code = '100', errorClass = 'validation') => new MetaReadError(failureOfAnswer({ status: 400, verdict: { errorClass, channelCode: code, channelMessage: words } as never }), 'x', 1)
const fieldsOf = (req: Req) => String(req.query?.fields ?? '')
const data = (res: { ok: boolean; data?: unknown; error?: string }) => { if (!res.ok) throw new Error(res.error); return res.data as Record<string, any> }

const ACCOUNT = '1234567890'
const PORTFOLIO = '9876543210'
const OTHER_PORTFOLIO = '9000000000001'
const SYSTEM_USER = '100000000000001'
const PERSON = '100000000000002'
const APP = '300000000000009'
const PAGE = '120000000000010'
const CAMPAIGN = '120000000000001'
const ADSET = '120000000000002'
const AD = '120000000000003'
const CHILD_AD = '120000000000004'
const PIXEL = '400000000000001'
const PIXEL_OTHER = '400000000000002'
const CONVERSION = '410000000000001'
const NOW = Date.now()
const isoAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString()
const CHOSEN = {
  connectionId: 'conn-1', label: 'Meta — Shop A', state: 'ok', stateText: 'Nexus reads “Shop A ads” once a day (read only).', authStatus: 'ok',
  systemUser: { id: SYSTEM_USER, name: 'Nexus system user' }, appId: APP,
  token: { checkedAt: isoAgo(3), isValid: true, expiresAt: new Date(NOW + 50 * 86_400_000).toISOString(), neverExpires: false, dataAccessExpiresAt: null, renewsFrom: null, lastRenewedAt: null, type: 'SYSTEM_USER', typeText: 'system user', scopes: ['ads_read'], missing: [], problem: null },
  adAccount: { adAccountId: ACCOUNT, name: 'Shop A ads', currency: 'EUR', timeZone: 'Europe/Rome', statusText: 'Active', businessId: PORTFOLIO },
  page: { pageId: PAGE, name: 'Shop A' }, instagram: null, lastError: null,
  read: { lastReadAt: isoAgo(5), lastDataDay: '2026-10-20', nextReadAt: null, lastStatus: 'SUCCESS', lastError: null },
}

const activity = (over: Record<string, unknown>) => ({
  event_time: '2026-10-20T10:00:00+0000', date_time_in_timezone: '20/10/2026 at 12:00', event_type: 'update_campaign_run_status', translated_event_type: 'Campaign status updated',
  actor_id: PERSON, actor_name: 'Person A', application_id: null, application_name: null, object_id: CAMPAIGN, object_name: 'Campaign A', object_type: 'CAMPAIGN',
  extra_data: '{"old_value":"Active","new_value":"Paused","type":"run_status"}', ...over,
})
const ACTIVITIES = [
  activity({}),
  activity({ event_type: 'update_ad_set_budget', translated_event_type: 'Ad set budget updated', actor_id: SYSTEM_USER, actor_name: 'Nexus system user', application_id: APP, application_name: 'Nexus app', object_id: ADSET, object_name: 'Ad set A', object_type: 'ADSET', extra_data: '{"old_value":{"value":2000,"currency":"EUR"},"new_value":{"value":3000,"currency":"EUR"},"type":"payment_amount","targeting":{"geo":{"countries":["IT"]}}}' }),
  activity({ event_type: 'ad_account_add_user_to_role', translated_event_type: 'Person added to account', object_id: '100000000000003', object_name: 'Person B', object_type: 'USER', extra_data: '{"new_value":"Person B","old_value":"someone@example.com","type":"ADVERTISER"}' }),
  activity({ event_type: 'account_spending_limit_reached', translated_event_type: 'Account spending limit reached', actor_id: '0', actor_name: 'Meta', object_id: ACCOUNT, object_name: 'Shop A ads', object_type: 'ACCOUNT', extra_data: '{}' }),
  activity({ event_type: 'ad_review_declined', translated_event_type: 'Ad not approved', actor_id: PAGE, actor_name: 'Shop A', object_id: AD, object_name: 'Ad A', object_type: 'AD', extra_data: '{"reason":"Policy","value":"x@y.example.com"}' }),
  activity({ event_type: 'update_ad_run_status', object_id: CHILD_AD, object_name: 'Ad B', object_type: 'ADGROUP', extra_data: 'not json' }),
  activity({ event_type: 'update_campaign_name', object_id: '120000000000099', object_name: 'Someone', object_type: 'THING' }),
]

/** Made-up answers for every read of the step. */
function answers(req: Req): unknown {
  const f = fieldsOf(req)
  if (req.path === `act_${ACCOUNT}` && f === 'account_status,disable_reason,failed_delivery_checks') {
    return { account_status: 3, disable_reason: 0, failed_delivery_checks: [{ check_name: 'page_status', summary: 'The Page is restricted', description: 'Fix the Page' }] }
  }
  if (req.path === `act_${ACCOUNT}` && f.startsWith('failed_delivery_checks{')) {
    return { failed_delivery_checks: [{ check_name: 'page_status', summary: 'The Page is restricted', description: 'Fix the Page', extra_info: { adgroup_ids: [AD], campaign_ids: [CAMPAIGN], countries: ['IT'] } }] }
  }
  if (req.path === `act_${ACCOUNT}` && f === 'account_status,disable_reason') return { account_status: 9, disable_reason: 0 }
  if (req.path === `act_${ACCOUNT}` && f.includes('funding_source,')) return { funding_source: null, is_prepay_account: false }
  if (req.path === `act_${ACCOUNT}` && f.includes('funding_source_details')) return {}
  if (req.path === `act_${ACCOUNT}/campaigns`) {
    const st = JSON.stringify(req.query?.effective_status)
    return st.includes('IN_PROCESS') ? { data: [{ id: '120000000000011', name: 'New campaign', effective_status: 'IN_PROCESS' }] } : { data: [{ id: CAMPAIGN, name: 'Campaign A', effective_status: 'WITH_ISSUES', issues_info: [{ level: 'CAMPAIGN', error_code: 2460004, error_summary: 'Flagged custom conversion' }] }] }
  }
  if (req.path === `act_${ACCOUNT}/adsets`) return JSON.stringify(req.query?.effective_status).includes('IN_PROCESS') ? { data: [] } : { data: [] }
  if (req.path === `act_${ACCOUNT}/ads`) {
    if (JSON.stringify(req.query?.effective_status) === '["PENDING_BILLING_INFO"]') return { data: [{ id: AD, name: 'Ad A', adset_id: ADSET, effective_status: 'PENDING_BILLING_INFO' }] }
    return { data: [{ id: AD, name: 'Ad A', campaign_id: CAMPAIGN, adset_id: ADSET, effective_status: 'DISAPPROVED', issues_info: [], ad_review_feedback: { global: { POLICY: 'words' } } }] }
  }
  if (req.path === `act_${ACCOUNT}/ads_volume`) return { data: [{ actor_id: PAGE, ads_running_or_in_review_count: 248, limit_on_ads_running_or_in_review: 250 }] }
  if (req.path === `act_${ACCOUNT}/adcreatives`) return { data: [{ id: '700000000000001', name: 'Creative A', status: 'IN_PROCESS' }, { id: '700000000000002', name: 'Creative B', status: 'ACTIVE' }] }
  if (req.path === `act_${ACCOUNT}/customconversions`) return { data: [{ id: CONVERSION, name: 'Purchase 50+', custom_event_type: 'PURCHASE', is_archived: false, is_unavailable: true, last_fired_time: '2026-10-19T00:00:00+0000' }] }
  if (req.path === `act_${ACCOUNT}/adspixels`) return { data: [{ id: PIXEL, name: 'Shop A pixel', is_unavailable: true, owner_business: { id: PORTFOLIO } }, { id: PIXEL_OTHER, name: 'Other pixel', is_unavailable: false, owner_business: { id: OTHER_PORTFOLIO } }] }
  if (req.path === `${PAGE}/page_status`) {
    return {
      id: PAGE, timestamp: 1763665904, status: 'restricted',
      violations: [{ type: 'SPAM', description: 'Spam', url: 'https://www.facebook.com/policy/spam' }],
      restrictions: [{ feature: 'page_messaging_api', description: 'No messages for 3 days', status: 'RESTRICTED', applied_time: 1763665904, expiration_time: 1763675775, violation_type: ['SPAM'] }],
      recommended_actions: [{ action_type: 'FILE_APPEAL', url: 'https://www.facebook.com/help/contact/appeal', violation_type: ['SPAM'] }, { action_type: 'LEARN_MORE', url: 'https://evil.example.com/x' }],
      actions_events: [{ type: 'FILE_APPEAL', status: 'OPEN', created_time: 1763666000, updated_time: 1763667000 }],
    }
  }
  if (req.path.endsWith('/activities')) {
    if (req.operation === 'billing.events' || req.operation === 'billing.eventsAll') return { data: [{ event_type: 'ad_account_billing_charge_failed', event_time: '2026-10-19T00:00:00+0000', translated_event_type: 'Charge failed', actor_name: 'Person A', extra_data: '{"amount":"12.00"}' }] }
    return { data: ACTIVITIES }
  }
  return { data: [] }
}

beforeEach(() => {
  h.connections = [CHOSEN]; h.calls.length = 0; h.answer = answers; h.taken = []
  h.stored = { campaign: [CAMPAIGN], adset: [ADSET], ad: [AD] }
  h.children = { adSets: [ADSET], ads: [CHILD_AD] }
  h.account = { adAccountId: ACCOUNT, accountStatus: 1, disableReason: 0, lastSuccessAt: new Date(NOW - 5 * 3_600_000), lastSyncAt: new Date(NOW - 5 * 3_600_000), settingsReadAt: new Date(NOW - 5 * 3_600_000), settings: { failed_delivery_checks: [], adsVolume: [{ ads_running_or_in_review_count: 12, limit_on_ads_running_or_in_review: 250 }] } }
  h.ledger = []; h.notices = []
  h.live = {
    token: { checkedAt: new Date(NOW).toISOString(), isValid: true, appId: APP, appMatches: true, type: 'SYSTEM_USER', userId: SYSTEM_USER, expiresAt: new Date(NOW + 10 * 86_400_000).toISOString(), neverExpires: false, dataAccessExpiresAt: null, scopes: ['ads_read'], missing: [], problem: null },
    tokenError: null,
    usage: { businessUseCase: [{ businessId: PORTFOLIO, type: 'ads_management', callCountPct: 80, cpuTimePct: 3, totalTimePct: 2, regainAccessMinutes: 0, tier: 'development_access' }], adAccount: { usedPct: 10, resetSeconds: 0, tier: null }, insights: null, app: null, tier: 'development_access', versionWarning: 'The call has been auto-upgraded to v26.0 as v20.0 has been deprecated.' },
    usageReadOn: 'the chosen ad account', usageError: null, apiVersion: 'v26.0',
  }
})

describe('the two tools are reads of Meta', () => {
  it('read only, open world, ads.view; the history\'s budget and billing details are money', () => {
    expect(META_ADS_HEALTH_TOOLS.map((t) => t.name)).toEqual(['meta-account-health', 'meta-activity-log'])
    for (const t of META_ADS_HEALTH_TOOLS) {
      expect({ readOnly: t.readOnly, openWorld: t.openWorld, execute: t.execute, riskTier: t.riskTier, requires: t.requires, surfaces: t.surfaces }).toEqual({ readOnly: true, openWorld: true, execute: undefined, riskTier: 'low', requires: ['ads.view'], surfaces: undefined })
    }
    expect(tool('meta-activity-log').restrictedFields).toEqual({ metaRaw: 'financials.adspend.view' })
    expect(tool('meta-account-health').restrictedFields).toBeUndefined()
    // One list of Meta's categories: the gateway's.
    expect(ACTIVITY_CATEGORIES).toBe(META_ACTIVITY_CATEGORIES)
  })
})

describe('every view asks only what the real gateway lets through, and only the chosen assets', () => {
  it('all views, with made-up answers', async () => {
    const views: Array<[string, Record<string, unknown>]> = [
      ...HEALTH_VIEWS.map((view) => ['meta-account-health', { view }] as [string, Record<string, unknown>]),
      ['meta-account-health', { view: 'problems', includePausedByParent: true }],
      ['meta-activity-log', {}], ['meta-activity-log', { from: '2026-10-01', to: '2026-10-20', category: 'budget', actorId: SYSTEM_USER }],
      ['meta-activity-log', { scope: 'campaign', id: CAMPAIGN }], ['meta-activity-log', { scope: 'campaign', id: CAMPAIGN, withChildren: false }],
      ['meta-activity-log', { scope: 'adset', id: ADSET, category: 'AD_SET' }], ['meta-activity-log', { scope: 'ad', id: AD, topic: 'review' }],
    ]
    const failed: unknown[] = []
    for (const [name, args] of views) {
      const res = await run(name, args)
      if (!res.ok) failed.push([name, args, res.error])
    }
    expect(failed).toEqual([])
    const refused = h.calls.map((c) => [c.operation, c.path, metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' })]).filter(([, , problem]) => problem)
    expect(refused).toEqual([])
    expect(h.calls.map((c) => fieldsOf(c)).join(' ')).not.toMatch(/email|token|preview|phone/)
    const roots = new Set(h.calls.map((c) => c.path.split('/')[0]))
    expect([...roots].sort()).toEqual([`act_${ACCOUNT}`, ADSET, PAGE].sort())
  })
})

describe('meta-account-health', () => {
  it('summary: Nexus\'s own records, no Meta call — status, the account as last read, problem objects, throttles in words', async () => {
    h.ledger = [{ connectionId: 'conn-1', errorCode: '613/1487632', _count: { _all: 2 }, _max: { createdAt: new Date(NOW - 3_600_000) } }, { connectionId: 'conn-1', errorCode: 'RATE_LIMITED_LOCAL', _count: { _all: 7 }, _max: { createdAt: new Date(NOW) } }]
    const out = data(await run('meta-account-health', {}))
    expect(h.calls).toHaveLength(0)
    expect(out.status).toBe('ok')
    expect(out.account).toMatchObject({ adAccountId: ACCOUNT, statusText: 'Active', adsCanRun: true, failedDeliveryChecks: [] })
    expect(out.objectsAsOfLastRead).toEqual({ campaigns: { WITH_ISSUES: 1 }, adSets: {}, ads: { DISAPPROVED: 2, PENDING_BILLING_INFO: 1 } })
    expect(out.adsVolumeAsOfLastRead).toEqual({ adsRunningOrInReview: 12, limit: 250 })
    expect(out.throttlesLast24h[0]).toMatchObject({ code: 'RATE_LIMITED_LOCAL', calls: 7, byNexus: true })
    expect(out.throttlesLast24h[1]).toMatchObject({ code: '613/1487632', what: expect.stringMatching(/4 times in the last hour/) })
  })
  it('summary: a disabled, compromised account and a token Meta refused during the read fail, in words', async () => {
    h.account = { ...h.account!, accountStatus: 2, disableReason: 15 }
    h.connections = [{ ...CHOSEN, state: 'read_failed', stateText: 'The last read of “Shop A ads” stopped because Meta refused the token then; the token has been checked valid since.', read: { ...CHOSEN.read, lastStatus: 'AUTH_LOST' } }]
    const out = data(await run('meta-account-health', { view: 'summary' }))
    expect(out.status).toBe('fail')
    expect(out.message).toMatch(/refused the token/)
    expect(out.message).toMatch(/Disabled: no ad runs/)
    expect(out.account).toMatchObject({ adsCanRun: false, disableReasonText: 'Compromised ad account', stopChanges: expect.stringMatching(/make no Meta change/) })
  })
  it('summary: no Meta connection says so (no call)', async () => {
    h.connections = []
    expect(data(await run('meta-account-health', {}))).toMatchObject({ connected: false, status: 'ok' })
    expect(h.calls).toHaveLength(0)
  })
  it('account: status and reason in words; the checks\' ads, campaigns and countries in a read of their own', async () => {
    const out = data(await run('meta-account-health', { view: 'account' }))
    expect(out).toMatchObject({ status: 3, statusText: 'Unsettled (a payment is due)', adsCanRun: false, everyCheckPassed: false })
    expect(out.failedDeliveryChecks).toEqual([{ checkName: 'page_status', summary: 'The Page is restricted', description: 'Fix the Page', adIds: [AD], campaignIds: [CAMPAIGN], countries: ['IT'] }])
    // Meta refusing the SDK-only sub-fields costs only them.
    h.calls.length = 0
    h.answer = (req) => (fieldsOf(req).startsWith('failed_delivery_checks{') ? refusedByMeta('(#100) Tried accessing nonexisting field (extra_info)') : answers(req))
    const refused = data(await run('meta-account-health', { view: 'account' }))
    expect(refused.failedDeliveryChecks).toEqual([{ checkName: 'page_status', summary: 'The Page is restricted', description: 'Fix the Page' }])
    expect(refused.missing).toEqual([{ part: 'checkDetails', sentence: expect.stringMatching(/nonexisting field/) }])
  })
  it('problems: step 6\'s sweep, plus what Meta still processes and a Page at its ad limit', async () => {
    const out = data(await run('meta-account-health', { view: 'problems' }))
    expect(h.calls.map((c) => c.operation)).toEqual(expect.arrayContaining(['objects.problems.account', 'objects.problems.campaigns', 'objects.problems.ads', 'health.processing.campaigns', 'health.processing.creatives']))
    expect(out.problems.map((p: { level: string; id: string }) => [p.level, p.id])).toEqual([['campaign', CAMPAIGN], ['ad', AD]])
    expect(out.processing.map((p: { level: string; id: string }) => [p.level, p.id])).toEqual([['campaign', '120000000000011'], ['creative', '700000000000001']])
    expect(out.pagesNearAdLimit).toEqual([expect.objectContaining({ pageId: PAGE, adsRunningOrInReview: 248, limit: 250, sentence: expect.stringMatching(/248 of its 250/) })])
  })
  it('payment: the trouble in words, without who made a charge or its amount', async () => {
    const out = data(await run('meta-account-health', { view: 'payment', days: 30 }))
    expect(out.trouble).toBe(true)
    expect(out.problems.join(' ')).toMatch(/grace period/)
    expect(out.problems.join(' ')).toMatch(/no payment method/)
    expect(out.adsWaitingForBilling).toEqual([{ adId: AD, name: 'Ad A', adSetId: ADSET }])
    expect(out.troubleEvents).toEqual([{ time: expect.any(String), type: 'ad_account_billing_charge_failed', typeText: 'Charge failed' }])
    expect(JSON.stringify(out)).not.toMatch(/Person A|12\.00/)
  })
  it('signals: flagged conversions and unavailable pixels; a pixel of another business\'s portfolio is its id and a flag', async () => {
    h.taken = [{ product: 'PORTFOLIO', id: OTHER_PORTFOLIO }]
    const out = data(await run('meta-account-health', { view: 'signals' }))
    expect(out.flaggedCustomConversions).toEqual([expect.objectContaining({ customConversionId: CONVERSION, flagged: true })])
    expect(out.unavailablePixels).toEqual([expect.objectContaining({ pixelId: PIXEL, unavailable: true })])
    expect(out.pixels[1]).toEqual({ pixelId: PIXEL_OTHER, takenByAnotherBusiness: true })
    expect(JSON.stringify(out)).not.toMatch(/Other pixel/)
  })
  it('page: the chosen Page\'s integrity in words; only Meta\'s own links; no Page chosen is refused before a call', async () => {
    const out = data(await run('meta-account-health', { view: 'page' }))
    expect(out).toMatchObject({ pageId: PAGE, status: 'restricted', statusText: expect.stringMatching(/Restricted/) })
    expect(out.restrictions[0]).toMatchObject({ featureText: expect.stringMatching(/Messenger Platform API/), expiresAt: new Date(1763675775 * 1000).toISOString() })
    expect(out.recommendedActions.map((a: { link: string | null }) => a.link)).toEqual(['https://www.facebook.com/help/contact/appeal', null])
    expect(h.calls.find((c) => c.path === `${PAGE}/page_status`)?.query).toEqual({})
    h.calls.length = 0
    h.connections = [{ ...CHOSEN, page: null }]
    expect((await run('meta-account-health', { view: 'page' })).error).toMatch(/No Facebook Page is chosen/)
    expect(h.calls).toHaveLength(0)
  })
  it('page: Meta asking for the Page\'s own token is said plainly', async () => {
    h.answer = (req) => (req.path.endsWith('/page_status') ? refusedByMeta('(#190) This method must be called with a Page Access Token', '190', 'auth_revoked') : answers(req))
    expect((await run('meta-account-health', { view: 'page' })).error).toMatch(/Page's own access token/)
  })
  it('connection: the token now, usage, version and throttles in words', async () => {
    h.ledger = [{ connectionId: 'conn-1', errorCode: '17/2446079', _count: { _all: 3 }, _max: { createdAt: new Date(NOW) } }]
    const out = data(await run('meta-account-health', { view: 'connection', hours: 48 }))
    expect(out.healthy).toBe(false)
    expect(out.problems.join(' ')).toMatch(/expires in \d+ days/)
    expect(out.problems.join(' ')).toMatch(/80 % of a rate limit/)
    expect(out.problems.join(' ')).toMatch(/expired API version/)
    expect(out.problems.join(' ')).toMatch(/throttled 3 calls in the last 48 hours/)
    expect(out.ledger.throttles[0]).toMatchObject({ code: '17/2446079', what: expect.stringMatching(/call score/) })
  })
  it('connection: still answers when Meta refused the token (that is what it is for); the live views say the state instead', async () => {
    h.connections = [{ ...CHOSEN, state: 'sign_in_needed', stateText: 'Meta no longer accepts this business\'s system-user token.' }]
    h.live = { ...h.live!, token: { ...(h.live!.token as object), isValid: false, problem: 'Error validating access token' } }
    const out = data(await run('meta-account-health', { view: 'connection' }))
    expect(out).toMatchObject({ healthy: false, state: 'sign_in_needed' })
    expect(out.problems.join(' ')).toMatch(/not valid: Error validating access token/)
    expect((await run('meta-account-health', { view: 'account' })).error).toMatch(/no longer accepts/)
  })
})

describe('meta-activity-log', () => {
  it('account: the days always sent; Nexus named, anyone else by id; a role change keeps no name or details; money under metaRaw', async () => {
    const out = data(await run('meta-activity-log', { from: '2026-10-14', to: '2026-10-20', category: 'status' }))
    const req = h.calls.find((c) => c.operation === 'activity.account')!
    expect(req.path).toBe(`act_${ACCOUNT}/activities`)
    expect(req.query).toMatchObject({ since: Date.UTC(2026, 9, 14) / 1000, until: Date.UTC(2026, 9, 21) / 1000, category: 'STATUS' })
    expect(req.query).not.toHaveProperty('business_id')
    const [statusEvent, budget, role, limit, review, , unknownObject] = out.events
    expect(statusEvent.by).toEqual({ madeByNexus: false, who: 'someone else (a person, an agency or Meta)', actorId: PERSON, app: null })
    expect(statusEvent.change).toEqual({ old_value: 'Active', new_value: 'Paused', type: 'run_status' })
    expect(budget.by).toMatchObject({ madeByNexus: true, who: 'Nexus\'s own system user', actorName: 'Nexus system user', app: { appId: APP, nexusApp: true } })
    expect(budget.metaRaw).toEqual({ old_value: { value: 2000, currency: 'EUR' }, new_value: { value: 3000, currency: 'EUR' }, type: 'payment_amount' })
    expect(budget.leftOutKeys).toEqual(['targeting'])
    expect(budget).not.toHaveProperty('change')
    expect(role.object).toEqual({ id: '100000000000003', type: 'USER', nameLeftOut: true })
    expect(role).not.toHaveProperty('change')
    expect(role).not.toHaveProperty('metaRaw')
    expect(review.by).toMatchObject({ who: 'the chosen Facebook Page', actorName: 'Shop A' })
    expect(review.change).toEqual({ reason: 'Policy' })
    expect(unknownObject.object).toEqual({ id: '120000000000099', type: 'THING', nameLeftOut: true })
    // A Page or another ad account by name: never (only the chosen account and Page, and the account's own ad objects).
    h.answer = (req) => (req.path.endsWith('/activities') ? { data: [activity({ object_id: '120000000000098', object_type: 'PAGE', object_name: 'Other Page' }), activity({ object_id: '5550001112', object_type: 'AD_ACCOUNT', object_name: 'Other ads' })] } : answers(req))
    const masked = data(await run('meta-activity-log', {}))
    expect(masked.events.map((e: { object: unknown }) => e.object)).toEqual([{ id: '120000000000098', type: 'PAGE', nameLeftOut: true }, { id: '5550001112', type: 'AD_ACCOUNT', nameLeftOut: true }])
    expect(JSON.stringify(out)).not.toMatch(/Person A|Person B|someone@example\.com|x@y\.example\.com/)
    expect(out.whyItStopped.map((w: { type: string }) => w.type)).toEqual(['account_spending_limit_reached', 'ad_review_declined'])
    expect(limit.object.name).toBe('Shop A ads')
  })
  it('a person without the ad-spend permission gets no budget or billing details', async () => {
    const out = data(await run('meta-activity-log', {}))
    const seen = financialPayloadCopy(out, { isOwner: false, permissions: new Set(['ads.view']) } as never, tool('meta-activity-log').restrictedFields) as Record<string, any>
    expect(JSON.stringify(seen)).not.toMatch(/payment_amount|"value":3000/)
    expect(JSON.stringify(out)).toMatch(/payment_amount/)
    expect(seen.events[0].change).toEqual({ old_value: 'Active', new_value: 'Paused', type: 'run_status' })
  })
  it('campaign: checked to be the chosen account\'s BEFORE any history; Meta\'s object filter with its ad sets and ads', async () => {
    expect((await run('meta-activity-log', { scope: 'campaign', id: '120000000000555' })).error).toMatch(/does not belong|not read/)
    expect(h.calls.some((c) => c.path.endsWith('/activities'))).toBe(false)
    h.calls.length = 0
    await run('meta-activity-log', { scope: 'campaign', id: CAMPAIGN })
    expect(h.calls.find((c) => c.operation === 'activity.campaign')?.query).toMatchObject({ oid: CAMPAIGN, add_children: true })
    expect((await run('meta-activity-log', { scope: 'adset', id: CAMPAIGN })).error).toMatch(/campaign of this ad account, not an ad set/)
  })
  it('campaign: when Meta refuses the object filter, the account\'s log is read once and kept to the campaign and its children', async () => {
    h.answer = (req) => (req.query?.oid ? refusedByMeta('(#100) Invalid parameter oid') : answers(req))
    const out = data(await run('meta-activity-log', { scope: 'campaign', id: CAMPAIGN }))
    expect(out.answeredBy).toMatch(/kept to this object by Nexus/)
    expect(out.objectFilterRefused).toMatch(/Invalid parameter/)
    expect(new Set(out.events.map((e: { object: { id: string } }) => e.object.id))).toEqual(new Set([CAMPAIGN, ADSET, CHILD_AD]))
    // A throttle is never "refused filter": it ends the read.
    h.answer = (req) => (req.query?.oid ? refusedByMeta('(#17) User request limit reached', '17/2446079', 'rate_limited') : answers(req))
    expect((await run('meta-activity-log', { scope: 'campaign', id: CAMPAIGN })).error).toMatch(/slow down/)
  })
  it('ad set: its own edge, with the portfolio Meta requires', async () => {
    await run('meta-activity-log', { scope: 'adset', id: ADSET })
    const req = h.calls.find((c) => c.operation === 'activity.adset')!
    expect(req.path).toBe(`${ADSET}/activities`)
    expect(req.query).toMatchObject({ business_id: PORTFOLIO })
  })
  it('filters: topic, event types, made by, actor', async () => {
    expect(data(await run('meta-activity-log', { topic: 'account' })).events.map((e: { type: string }) => e.type)).toEqual(['ad_account_add_user_to_role', 'account_spending_limit_reached'])
    expect(data(await run('meta-activity-log', { topic: 'review' })).events.map((e: { type: string }) => e.type)).toEqual(['ad_review_declined'])
    expect(data(await run('meta-activity-log', { madeBy: 'nexus' })).events.map((e: { type: string }) => e.type)).toEqual(['update_ad_set_budget'])
    expect(data(await run('meta-activity-log', { madeBy: 'others' })).events).toHaveLength(ACTIVITIES.length - 1)
    expect(data(await run('meta-activity-log', { eventTypes: ['update_ad_run_status'] })).events.map((e: { object: { id: string } }) => e.object.id)).toEqual([CHILD_AD])
    h.calls.length = 0
    await run('meta-activity-log', { actorId: PERSON, topic: 'review' })
    // A local filter reads up to 500 entries; the actor is Meta's own filter.
    expect(h.calls[0].query).toMatchObject({ uid: PERSON })
  })
  it('refuses a future day, days the wrong way round, an id on the account scope and a missing id, before any call', async () => {
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)
    expect((await run('meta-activity-log', { to: future })).error).toMatch(/future/)
    expect((await run('meta-activity-log', { from: '2026-10-20', to: '2026-10-01' })).error).toMatch(/after to/)
    expect((await run('meta-activity-log', { from: '2026-02-30', to: '2026-03-01' })).error).toMatch(/calendar days/)
    expect((await run('meta-activity-log', { id: CAMPAIGN })).error).toMatch(/leave id out/)
    expect((await run('meta-activity-log', { scope: 'ad' })).error).toMatch(/Name the ad/)
    expect(h.calls).toHaveLength(0)
    expect(() => tool('meta-activity-log').input.parse({ category: 'BILLING' })).toThrow()
    expect(() => tool('meta-activity-log').input.parse({ eventTypes: ['made_up_event'] })).toThrow()
  })
})

describe('pure helpers', () => {
  it('activityDetailsOf keeps plain known keys one level deep and names the rest; never an e-mail', () => {
    expect(activityDetailsOf('{"old_value":"a","new_value":{"value":1,"deep":{"x":1}},"secret":"s","value":"me@example.com"}')).toEqual({
      kept: { old_value: 'a', new_value: { value: 1 } }, leftOut: 3, leftOutKeys: ['new_value_deep', 'secret', 'value'],
    })
    expect(activityDetailsOf('nope')).toEqual({ kept: null, leftOut: 1, leftOutKeys: [] })
    expect(activityDetailsOf(null)).toEqual({ kept: null, leftOut: 0, leftOutKeys: [] })
  })
  it('throttleWords: the exact code, else the code alone, else a plain fallback', () => {
    expect(throttleWords('613/4841018').what).toMatch(/30 seconds/)
    expect(throttleWords('613/9999999').what).toMatch(/abuse protection/)
    expect(throttleWords('80004').what).toMatch(/ads management/)
    expect(throttleWords('99').what).toMatch(/\(99\)/)
  })
})
