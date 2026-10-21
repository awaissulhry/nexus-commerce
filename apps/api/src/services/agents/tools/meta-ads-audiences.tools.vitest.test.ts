/**
 * Meta ads step 11 — meta-audiences. Every view sends a fixed request the real gateway lets through (its query-key
 * allow-list); every audience a caller names is the chosen ad account's own or one Meta lists as shared with it; every
 * pixel is the chosen account's; an ad account another business in Nexus uses is its id and the flag only; sizes are
 * Meta's ranges (never one number; -1 is "no size"); customer-list members are never asked for; a refused part of a
 * view is said in words while the rest answers. Meta and the database are stubbed; made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Req = { operation: string; path: string; query?: Record<string, unknown> }
const h = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ operation: string; path: string; query?: Record<string, unknown> }>,
  answer: null as null | ((req: { operation: string; path: string; query?: Record<string, unknown> }) => unknown),
  rowsFor: null as null | ((req: { operation: string; path: string; query?: Record<string, unknown> }) => unknown),
  /** Pages of a list read page by page (scanRows): the page for a request's `after` cursor. */
  pageFor: null as null | ((req: { operation: string; path: string; query?: Record<string, unknown> }) => unknown),
  taken: [] as Array<{ id: string }>,
  /** The pixel check (review A-N1): its owner portfolio, its ad accounts in a portfolio, its partner portfolios. */
  ownerFor: null as null | ((req: { path: string }) => unknown),
  sharedAccountsFor: null as null | ((req: { path: string; query?: Record<string, unknown> }) => unknown),
  agenciesFor: null as null | ((req: { path: string }) => unknown),
}))
vi.mock('../../meta/meta-accounts.service.js', () => ({ listMetaConnections: vi.fn(async () => h.connections) }))
vi.mock('../../marketing/meta-ads/read-client.js', async () => ({
  metaReadOne: vi.fn(async (_t: unknown, req: Req) => {
    h.calls.push(req)
    if (req.operation === 'datasets.pixelOwner') {
      const owner = h.ownerFor?.(req) ?? { owner_business: { id: '9876543210' } }
      if (owner instanceof Error) throw owner
      return { body: owner, calls: 1 }
    }
    // A filtered audience list is read page by page (scanRows): one page of rowsFor, unless pageFor pages it.
    if (req.path.endsWith('/customaudiences')) {
      const page = h.pageFor?.(req) ?? { data: h.rowsFor?.(req) ?? [] }
      if (page instanceof Error || (page as { data?: unknown }).data instanceof Error) throw page instanceof Error ? page : (page as { data: Error }).data
      return { body: page, calls: 1 }
    }
    const body = h.answer?.(req)
    if (body instanceof Error) throw body
    return { body: body ?? {}, calls: 1 }
  }),
  metaReadAll: vi.fn(async (_t: unknown, req: Req, onRows: (rows: Record<string, unknown>[]) => void) => {
    h.calls.push(req)
    const custom = h.rowsFor?.(req)
    // By default a pixel is the chosen portfolio's, connected to the chosen ad account only, shared with no partner.
    const rows = req.path.endsWith('/shared_accounts') && !(custom instanceof Error) && !(Array.isArray(custom) && custom.length)
      ? (h.sharedAccountsFor?.(req) ?? [{ account_id: '1234567890', name: 'Shop A ads' }])
      : req.path.endsWith('/shared_agencies') && !(custom instanceof Error) && !(Array.isArray(custom) && custom.length)
        ? (h.agenciesFor?.(req) ?? [])
        : custom ?? []
    if (rows instanceof Error) throw rows
    onRows(rows as Record<string, unknown>[])
    return { rows: (rows as unknown[]).length, calls: 1, truncated: false }
  }),
}))
vi.mock('../../../db.js', () => ({
  default: {
    metaAdsCampaign: { findFirst: vi.fn(async () => null) },
    metaAdsAdSet: { findFirst: vi.fn(async () => null) },
    metaAdsAd: { findFirst: vi.fn(async () => null) },
    // nexus_meta_links_taken answers only the ids asked (taken.ts passes them as the template's second value).
    $queryRaw: vi.fn(async (_sql: unknown, _product: unknown, ids: string[]) => h.taken.filter((t) => ids.includes(t.id))),
  },
}))

import { META_ADS_AUDIENCES_TOOLS } from './meta-ads-audiences.tools.js'
import { AUDIENCE_VIEWS, audienceSize } from '../../marketing/meta-ads/live-audiences.js'
import { MetaReadError, type MetaFailure } from '../../marketing/meta-ads/errors.js'
import { metaUrl } from '../../gateway/meta.js'
import { metaReadOnlyProblem } from '../../gateway/meta-calls.js'
import { graphParamAllowed, type GraphNode } from '../../marketing/meta-ads/graph-allow.js'

const tool = META_ADS_AUDIENCES_TOOLS[0]
const ctx = { can: () => true, via: 'claude' as const }
const run = (args: Record<string, unknown>) => tool.handler(tool.input.parse(args), ctx as never)
const data = (res: { data?: unknown }) => res.data as Record<string, any>
const OWN = '1234567890'
const CHOSEN = {
  connectionId: 'conn-1', state: 'ok', stateText: 'ok',
  adAccount: { adAccountId: OWN, name: 'Shop A ads', currency: 'EUR', timeZone: 'Europe/Rome', businessId: '9876543210' },
  page: { pageId: '120000000000010' }, instagram: { instagramId: '170000000000001' }, read: {},
}
const AUD = '120000000000401'
const SHARED = '120000000000402'
const PIXEL = '120000000000501'
const OTHER_ACCOUNT = '5555555555'
const metaError = (code: string, extra: Partial<MetaFailure> = {}) => new MetaReadError({
  origin: 'meta', httpStatus: 400, code, authLost: false, throttled: false, permissionDenied: false, notFound: false, sentence: `Meta refused the read (${code}).`, ...extra,
}, 'test')
/** Every call the gateway would refuse (none may be). */
const refusedCalls = () => h.calls
  .map((c) => [c.path, metaReadOnlyProblem({ method: 'GET', url: metaUrl(c.path, (c.query ?? {}) as never), kind: 'read' })])
  .filter(([, problem]) => problem)
const audience = (id: string, extra: Record<string, unknown> = {}) => ({
  id, account_id: OWN, name: `Audience ${id.slice(-3)}`, subtype: 'CUSTOM', approximate_count_lower_bound: 1000, approximate_count_upper_bound: 1200,
  delivery_status: { code: 200, description: 'ready' }, operation_status: { code: 200, description: 'Normal' }, time_created: 1760000000, ...extra,
})

beforeEach(() => {
  h.connections = [CHOSEN]; h.calls.length = 0; h.taken = []; h.ownerFor = null; h.sharedAccountsFor = null; h.agenciesFor = null; h.pageFor = null
  h.answer = (req) => (req.operation === 'audiences.ownerCheck' ? { account_id: req.path === AUD ? OWN : OTHER_ACCOUNT, subtype: 'CUSTOM' } : { id: req.path, ...audience(req.path) })
  h.rowsFor = (req) => {
    if (req.path === `act_${OWN}/customaudiences`) return [audience(AUD), audience(SHARED, { account_id: OTHER_ACCOUNT })]
    if (req.path === `act_${OWN}/adspixels`) return [{ id: PIXEL }]
    if (req.path === `act_${OWN}/saved_audiences`) return [{ id: '120000000000601', name: 'Saved A', approximate_count_lower_bound: 10, approximate_count_upper_bound: 20 }]
    return []
  }
})

describe('the tool is a read', () => {
  it('read only, open world (it calls Meta), ads.view; the value data is money-restricted', () => {
    expect([tool.name, tool.readOnly, tool.openWorld, tool.execute, tool.requires]).toEqual(['meta-audiences', true, true, undefined, ['ads.view']])
    expect(tool.restrictedFields).toEqual({ valueHealth: 'financials.adspend.view' })
  })
  it('a business without Meta, or without a chosen account, is told who sets it up — before any call', async () => {
    h.connections = []
    expect((await run({ view: 'list' })).error).toMatch(/Settings › Channels › Meta/)
    h.connections = [{ ...CHOSEN, adAccount: null }]
    expect((await run({ view: 'terms' })).error).toMatch(/No Meta ad account is chosen/)
    expect(h.calls).toHaveLength(0)
  })
})

describe('every view — only what the real gateway lets through, never a member of a customer list', () => {
  const VIEWS: Array<[string, Record<string, unknown>, string]> = [
    ['list', { subtype: 'website', pixelId: PIXEL }, `act_${OWN}/customaudiences`],
    ['detail', { audienceId: AUD }, `${AUD}/capabilities`],
    ['expiring', {}, `act_${OWN}/customaudiences`],
    ['flagged', {}, `act_${OWN}/customaudiences`],
    ['lookalikes', {}, `act_${OWN}/customaudiences`],
    ['ads-using', { audienceId: AUD }, `${AUD}/ads`],
    ['sessions', { audienceId: AUD, sessionId: '7' }, `${AUD}/sessions`],
    ['health', { audienceId: AUD, calculatedDate: '2026-10-01', processedDate: '2026-10-02' }, `${AUD}/health`],
    ['sharing', { audienceId: AUD, permissions: 'targeting' }, `${AUD}/adaccounts`],
    ['business-sharing', { requestStatus: 'pending', partnerBusinessId: '1111111111' }, '9876543210/received_audience_permissions'],
    ['saved', { savedAudienceId: '120000000000601' }, '120000000000601'],
    ['terms', {}, `act_${OWN}/customaudiencestos`],
  ]
  it('covers every view', () => { expect(VIEWS.map(([v]) => v).sort()).toEqual([...AUDIENCE_VIEWS].sort()) })
  it.each(VIEWS)('view %s', async (view, args, path) => {
    const res = await run({ view, ...args })
    expect(res.ok, String(res.error)).toBe(true)
    expect(h.calls.map((c) => c.path)).toContain(path)
    expect(refusedCalls()).toEqual([])
    expect(h.calls.some((c) => /\/(users|usersreplace|salts)$/.test(c.path))).toBe(false)
  })
})

describe('sizes are Meta\'s ranges', () => {
  it('a range stays a range; -1 or nothing is "no size" with the reason, never 0 or one number', () => {
    expect(audienceSize(1000, 1200)).toEqual({ size: { lowerBound: 1000, upperBound: 1200 }, sizeNote: 'A range from Meta, never an exact count.' })
    expect(audienceSize(-1, -1).size).toBeNull()
    expect(audienceSize(-1, -1).sizeNote).toMatch(/lookalike/)
    expect(audienceSize(undefined, 5).size).toBeNull()
  })
  it('list answers sizes, delivery and status in words; a shared-in audience of another business\'s account names only that id', async () => {
    h.taken = [{ id: OTHER_ACCOUNT }]
    const res = data(await run({ view: 'list' }))
    expect(res.items[0]).toMatchObject({ audienceId: AUD, sharedIn: false, ownerAdAccount: null, size: { lowerBound: 1000, upperBound: 1200 }, delivery: { code: 200, usableInAds: true } })
    expect(res.items[1]).toMatchObject({ audienceId: SHARED, sharedIn: true, ownerAdAccount: { adAccountId: OTHER_ACCOUNT, takenByAnotherBusiness: true } })
    expect(JSON.stringify(res)).not.toMatch(/approximate_count/)
  })
  it('subtype, flagged and lookalikes filter the rows read; expiring sends Meta\'s own filter', async () => {
    h.rowsFor = (req) => (req.path === `act_${OWN}/customaudiences` ? [
      audience(AUD), audience('120000000000403', { subtype: 'LOOKALIKE', approximate_count_lower_bound: -1, approximate_count_upper_bound: -1, lookalike_spec: { ratio: 0.01, country: 'IT' } }),
      audience('120000000000404', { operation_status: { code: 471, description: 'flagged' }, fields_violating_integrity_policy: ['name'] }),
    ] : [])
    expect(data(await run({ view: 'list', subtype: 'LOOKALIKE' })).items.map((r: any) => r.audienceId)).toEqual(['120000000000403'])
    const lookalikes = data(await run({ view: 'lookalikes' }))
    expect(lookalikes.items).toHaveLength(1)
    expect(lookalikes.items[0]).toMatchObject({ size: null, lookalikeSpec: { ratio: 0.01, country: 'IT' } })
    expect(data(await run({ view: 'flagged' })).items).toEqual([expect.objectContaining({ audienceId: '120000000000404', flagged: true, flaggedFields: ['name'] })])
    h.calls.length = 0
    await run({ view: 'expiring' })
    expect(h.calls[0].query?.filtering).toEqual([{ field: 'delete_time', operator: 'GREATER_THAN', value: 0 }])
  })
  it('a filtered view reads on page by page until it has its matches, and says when the page cap stopped it', async () => {
    h.pageFor = (req) => (!req.query?.after
      ? { data: [audience(AUD)], paging: { cursors: { after: 'p2' }, next: 'https://graph.facebook.com/next' } }
      : { data: [audience('120000000000403', { subtype: 'LOOKALIKE' })] })
    const found = data(await run({ view: 'lookalikes' }))
    expect(found.items.map((r: any) => r.audienceId)).toEqual(['120000000000403'])
    expect(found).not.toHaveProperty('stoppedAtPageCap')
    expect(h.calls.filter((c) => c.path === `act_${OWN}/customaudiences`).map((c) => c.query?.after ?? null)).toEqual([null, 'p2'])
    h.pageFor = () => ({ data: [audience(AUD)], paging: { cursors: { after: 'more' }, next: 'https://graph.facebook.com/next' } })
    const capped = data(await run({ view: 'lookalikes' }))
    expect(capped.items).toEqual([])
    expect(capped.stoppedAtPageCap).toMatch(/stopped there: more may match/)
  })
  it('Meta\'s "reduce the amount of data" (error 1) is asked again with pages of 20', async () => {
    h.rowsFor = (req) => (req.query?.limit === 50 ? metaError('1/99') : [audience(AUD)])
    const res = await run({ view: 'list' })
    expect(res.ok).toBe(true)
    expect(h.calls.map((c) => c.query?.limit)).toEqual([50, 20])
  })
})

describe('only the chosen account\'s audiences and pixels', () => {
  it('its own audience is read in full (capabilities: fields=capabilities); a shared-in one only as far as the chosen account needs', async () => {
    await run({ view: 'detail', audienceId: AUD })
    expect(h.calls.find((c) => c.operation === 'audiences.detail')?.query).not.toHaveProperty('ad_account_id')
    expect(h.calls.find((c) => c.operation === 'audiences.capabilities')?.query).toMatchObject({ fields: 'capabilities' })
    h.calls.length = 0
    h.answer = (req) => (req.operation === 'audiences.ownerCheck' ? { account_id: OTHER_ACCOUNT, subtype: 'LOOKALIKE' }
      : { ...audience(SHARED, { account_id: OTHER_ACCOUNT, subtype: 'LOOKALIKE' }), rule: '{"url":"x"}', lookalike_spec: { origin: [{ id: '1' }] }, description: 'theirs', pixel_id: '9', opt_out_link: 'https://x', audience_labels: ['HIGH_VALUE_CUSTOMERS'] })
    const res = data(await run({ view: 'detail', audienceId: SHARED }))
    const detail = h.calls.find((c) => c.operation === 'audiences.detail')!
    expect(detail.query).toMatchObject({ ad_account_id: OWN, acting_account_id: OWN })
    expect(String(detail.query?.fields)).not.toMatch(/rule|lookalike|opt_out|pixel_id|data_source|customer_file_source|description/)
    expect(Object.keys(res.audience).sort()).toEqual(['audienceId', 'delivery', 'expiring', 'flagged', 'labels', 'labelsOf', 'name', 'operation', 'ownerAdAccount', 'sharedIn', 'size', 'sizeNote', 'subtype'])
    expect(res.audience).toMatchObject({ labels: ['HIGH_VALUE_CUSTOMERS'], labelsOf: 'the chosen ad account (acting_account_id)' })
    expect(h.calls.some((c) => c.operation === 'audiences.capabilities')).toBe(false)
  })
  it.each(['sessions', 'health', 'sharing'])('view %s of a shared-in audience is refused before any read of it', async (view) => {
    const res = await run({ view, audienceId: SHARED })
    expect(res.error).toMatch(/belong to its owner/)
    expect(h.calls.some((c) => c.path.startsWith(`${SHARED}/`))).toBe(false)
  })
  it('a shared-in row of the list keeps only its name, type, size and status', async () => {
    h.rowsFor = (req) => (req.path === `act_${OWN}/customaudiences` ? [audience(SHARED, { account_id: OTHER_ACCOUNT, description: 'theirs', pixel_id: '9', data_source: { type: 'X' }, customer_file_source: 'USER_PROVIDED_ONLY' })] : [])
    const row = data(await run({ view: 'list' })).items[0]
    expect(row).not.toHaveProperty('description')
    expect(row).not.toHaveProperty('pixelId')
    expect(row).not.toHaveProperty('dataSource')
    expect(row).toMatchObject({ audienceId: SHARED, sharedIn: true, size: { lowerBound: 1000, upperBound: 1200 } })
  })
  it('an audience neither the account\'s nor shared with it is refused before it is read', async () => {
    const res = await run({ view: 'detail', audienceId: '120000000000499' })
    expect(res.error).toMatch(/not the chosen ad account's, nor shared with it/)
    expect(h.calls.some((c) => c.operation === 'audiences.detail')).toBe(false)
  })
  it('a campaign id of the account is not taken for an audience (Meta refuses `subtype` on it)', async () => {
    h.answer = (req) => (req.operation === 'audiences.ownerCheck' ? metaError('100') : {})
    expect((await run({ view: 'ads-using', audienceId: '120000000000101' })).error).toMatch(/not the chosen ad account's/)
  })
  it('review A8 — the recipient keys go only on the shared-in audience read; meta-ads-graph-read never sends them', () => {
    const url = (fields: string) => metaUrl(SHARED, { fields, ad_account_id: OWN, acting_account_id: OWN })
    expect(metaReadOnlyProblem({ method: 'GET', url: url('id,name,audience_labels'), kind: 'read' })).toBeNull()
    expect(metaReadOnlyProblem({ method: 'GET', url: url('id,name,status'), kind: 'read' })).toMatch(/"ad_account_id" is not one/)
    for (const node of [null, 'Campaign', 'AdSet', 'Ad', 'AdCreative', 'AdsInsights', 'AdAccount'] as Array<GraphNode | null>) {
      expect(graphParamAllowed(node, 'ad_account_id')).toBe(false)
      expect(graphParamAllowed(node, 'acting_account_id')).toBe(false)
    }
  })
  it('a pixel that is not on the chosen ad account is refused', async () => {
    expect((await run({ view: 'list', pixelId: '120000000000599' })).error).toMatch(/not on the ad account this business chose/)
  })
  it('a saved audience comes with its whole targeting (interests inside flexible_spec too) and its size range', async () => {
    h.answer = () => ({ id: '120000000000601', name: 'Saved A', approximate_count_lower_bound: 10, approximate_count_upper_bound: 20, targeting: { geo_locations: { countries: ['IT'] }, flexible_spec: [{ interests: [{ id: '6003000000001', name: 'Motorcycles' }] }] } })
    const res = data(await run({ view: 'saved', savedAudienceId: '120000000000601' }))
    expect(res.savedAudience).toMatchObject({ size: { lowerBound: 10, upperBound: 20 }, targeting: { geoLocations: { countries: ['IT'] }, flexibleSpec: [{ interests: [{ id: '6003000000001', name: 'Motorcycles' }] }] } })
  })
  it('a saved audience of another account is refused', async () => {
    expect((await run({ view: 'saved', savedAudienceId: '120000000000699' })).error).toMatch(/not the chosen ad account's/)
  })
})

describe('what an audience touches', () => {
  it('ads-using groups the account\'s ads by ad set; another account\'s ads are a count, another business\'s account its id and flag', async () => {
    h.taken = [{ id: OTHER_ACCOUNT }]
    h.rowsFor = (req) => (req.path === `${AUD}/ads` ? [
      { id: '1', name: 'Ad A', account_id: OWN, adset_id: '20', campaign_id: '10', effective_status: 'ACTIVE' },
      { id: '2', name: 'Ad B', account_id: OWN, adset_id: '20', campaign_id: '10', effective_status: 'PAUSED' },
      { id: '3', name: 'Their ad', account_id: OTHER_ACCOUNT, adset_id: '30', campaign_id: '31', effective_status: 'ACTIVE' },
    ] : [])
    const res = data(await run({ view: 'ads-using', audienceId: AUD }))
    expect(res.adSets).toEqual([{ adSetId: '20', campaignId: '10', ads: 2, activeAds: 1, adIds: ['1', '2'] }])
    expect(res.otherAccounts).toEqual([{ adAccountId: OTHER_ACCOUNT, takenByAnotherBusiness: true }])
    expect(JSON.stringify(res)).not.toMatch(/Their ad/)
  })
  it('sharing: a recipient account another business in Nexus uses is its id and the flag only', async () => {
    h.taken = [{ id: OTHER_ACCOUNT }]
    h.rowsFor = (req) => {
      if (req.path === `${AUD}/shared_account_info`) return [{ account_id: OTHER_ACCOUNT, account_name: 'Shop B ads', business_id: '2', business_name: 'Shop B', sharing_status: { code: 200 } }, { account_id: '4444444444', account_name: 'Agency X ads', business_id: '3' }]
      if (req.path === `${AUD}/adaccounts`) return [{ id: OTHER_ACCOUNT }]
      return []
    }
    const res = data(await run({ view: 'sharing', audienceId: AUD }))
    expect(res.recipients).toEqual([{ adAccountId: OTHER_ACCOUNT, takenByAnotherBusiness: true }, expect.objectContaining({ adAccountId: '4444444444', accountName: 'Agency X ads', takenByAnotherBusiness: false })])
    expect(res.sharedWithAdAccounts).toEqual([{ adAccountId: OTHER_ACCOUNT, takenByAnotherBusiness: true }])
    expect(JSON.stringify(res)).not.toMatch(/Shop B/)
  })
  it('one refused part is said in words while the rest answers; a lost token ends the view', async () => {
    h.rowsFor = (req) => (req.path === `${AUD}/shared_account_campaign_info` ? metaError('100') : [])
    const res = data(await run({ view: 'sharing', audienceId: AUD }))
    expect(res.recipientCampaigns).toEqual({ refused: 'Meta refused the read (100).' })
    expect(res.recipients).toEqual([])
    h.rowsFor = (req) => (req.path === `${AUD}/shared_account_campaign_info` ? metaError('190', { authLost: true, sentence: 'token gone' }) : [])
    expect((await run({ view: 'sharing', audienceId: AUD })).error).toBe('token gone')
  })
  it('terms: signed or not, the person-only answer refused in words, the existing-customers list', async () => {
    h.answer = (req) => (req.operation === 'audiences.userTerms' ? metaError('100') : req.operation === 'audiences.existingCustomers' ? { existing_customers: [AUD] } : { tos_accepted: { custom_audience_tos: 1 } })
    const res = data(await run({ view: 'terms' }))
    expect(res).toMatchObject({ customAudienceTermsSigned: true, existingCustomerAudienceIds: [AUD], personTermsAccepted: { refused: 'Meta refused the read (100).' } })
    expect(res.signLink).toBe(`https://business.facebook.com/ads/manage/customaudiences/tos/?act=${OWN}`)
  })
  it('business-sharing: another account\'s audience is its id (and the flag); a received request offers audience ids only', async () => {
    h.taken = [{ id: OTHER_ACCOUNT }, { id: '2222222222' }]
    h.rowsFor = (req) => {
      if (req.path === '9876543210/shared_audience_permissions') {
        return [
          { audience: { id: AUD, name: 'Ours', account_id: OWN }, share_account_id: '4444444444', share_account_name: 'Agency X ads' },
          { audience: { id: SHARED, name: 'Theirs', account_id: OTHER_ACCOUNT }, share_account_id: '4444444444' },
          { audience: { id: '120000000000405', name: 'Elsewhere', account_id: '3333333333' }, share_account_id: '4444444444' },
        ]
      }
      if (req.path === '9876543210/received_audience_sharing_requests') return [{ id: '77', request_status: 'PENDING', custom_audiences: [{ id: '120000000000406', name: 'Offered' }] }]
      if (req.path === '9876543210/initiated_audience_sharing_requests') return [{ id: '78', request_status: 'PENDING', initiator: { id: '9876543210', name: 'Shop A portfolio' }, recipient: { id: '2222222222', name: 'Shop B portfolio' }, custom_audiences: [{ id: AUD, name: 'Sent audience' }] }]
      return []
    }
    const res = data(await run({ view: 'business-sharing' }))
    expect(res.permissionsShared).toEqual([
      { adAccountId: '4444444444', accountName: 'Agency X ads', audience: { audienceId: AUD, name: 'Ours' }, takenByAnotherBusiness: false },
      { audience: { audienceId: SHARED, takenByAnotherBusiness: true } },
      { audience: { audienceId: '120000000000405' } },
    ])
    expect(res.requestsReceived[0].customAudiences).toEqual([{ audienceId: '120000000000406' }])
    expect(res.requestsSent[0].customAudiences).toEqual([{ audienceId: AUD }])
    // Review A-N7 — a portfolio another business in Nexus uses is its id and the flag.
    expect(res.requestsSent[0]).toMatchObject({ initiator: { id: '9876543210', name: 'Shop A portfolio', takenByAnotherBusiness: false }, recipient: { id: '2222222222', takenByAnotherBusiness: true } })
    expect(JSON.stringify(res)).not.toMatch(/Theirs|Elsewhere|Offered|Sent audience|Shop B/)
    expect(h.calls.find((c) => c.path === '9876543210/shared_audience_permissions')?.query?.fields).toBe('audience{id,name,account_id},share_account_id,share_account_name')
  })
  it('business-sharing needs the chosen account\'s business portfolio', async () => {
    h.connections = [{ ...CHOSEN, adAccount: { ...CHOSEN.adAccount, businessId: null } }]
    expect((await run({ view: 'business-sharing' })).error).toMatch(/no business portfolio/)
  })
})
