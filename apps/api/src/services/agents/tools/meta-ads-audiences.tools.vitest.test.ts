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
  taken: [] as Array<{ id: string }>,
}))
vi.mock('../../meta/meta-accounts.service.js', () => ({ listMetaConnections: vi.fn(async () => h.connections) }))
vi.mock('../../marketing/meta-ads/read-client.js', async () => ({
  metaReadOne: vi.fn(async (_t: unknown, req: Req) => {
    h.calls.push(req)
    const body = h.answer?.(req)
    if (body instanceof Error) throw body
    return { body: body ?? {}, calls: 1 }
  }),
  metaReadAll: vi.fn(async (_t: unknown, req: Req, onRows: (rows: Record<string, unknown>[]) => void) => {
    h.calls.push(req)
    const rows = h.rowsFor?.(req) ?? []
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
    $queryRaw: vi.fn(async () => h.taken),
  },
}))

import { META_ADS_AUDIENCES_TOOLS } from './meta-ads-audiences.tools.js'
import { AUDIENCE_VIEWS, audienceSize } from '../../marketing/meta-ads/live-audiences.js'
import { MetaReadError, type MetaFailure } from '../../marketing/meta-ads/errors.js'
import { metaUrl } from '../../gateway/meta.js'
import { metaReadOnlyProblem } from '../../gateway/meta-calls.js'

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
  h.connections = [CHOSEN]; h.calls.length = 0; h.taken = []
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
  it('Meta\'s "reduce the amount of data" (error 1) is asked again with pages of 20', async () => {
    h.rowsFor = (req) => (req.query?.limit === 50 ? metaError('1/99') : [audience(AUD)])
    const res = await run({ view: 'list' })
    expect(res.ok).toBe(true)
    expect(h.calls.map((c) => c.query?.limit)).toEqual([50, 20])
  })
})

describe('only the chosen account\'s audiences and pixels', () => {
  it('its own audience is read plainly; a shared-in one as the chosen account sees it, with its own labels', async () => {
    await run({ view: 'detail', audienceId: AUD })
    expect(h.calls.find((c) => c.operation === 'audiences.detail')?.query).not.toHaveProperty('ad_account_id')
    h.calls.length = 0
    const res = data(await run({ view: 'detail', audienceId: SHARED }))
    expect(h.calls.find((c) => c.operation === 'audiences.detail')?.query).toMatchObject({ ad_account_id: OWN, acting_account_id: OWN })
    expect(res.audience).toMatchObject({ labelsOf: 'the chosen ad account (acting_account_id)' })
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
    expect(res.otherAccounts).toEqual([{ adAccountId: OTHER_ACCOUNT, ads: 1, takenByAnotherBusiness: true }])
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
  it('business-sharing needs the chosen account\'s business portfolio', async () => {
    h.connections = [{ ...CHOSEN, adAccount: { ...CHOSEN.adAccount, businessId: null } }]
    expect((await run({ view: 'business-sharing' })).error).toMatch(/no business portfolio/)
  })
})
