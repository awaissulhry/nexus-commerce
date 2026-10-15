/**
 * Google on the gateway: reads, and one kind of change (a Google Ads mutate, 2026-10-15), the account's Bearer token, the
 * optional headers only when they apply, one ledger row per call (refusals included), a rate bucket per
 * Google API, and Google's error envelope classified.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response> }))
vi.mock('./account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'google-access-token') }))
vi.mock('../cx/deprecation-watch.service.js', () => ({ watchForDeprecation: vi.fn(async () => undefined) }))

import { gatewayAccounts, gatewayGoogleUnlinked, gatewayLedger } from '../../test-support/gateway-stubs.js'
import { __rateTest, defaultsFor, GOOGLE_BUCKETS, bucketKey } from './rate.js'
import { gatewayCall, GatewayRefusal } from './gateway.js'
import { googleCall, googleKind } from './google.js'
import { apiVersionOf, bucketGroupOf, GOOGLE_ADS_MUTATE_KINDS, googleAdsExperimentCall, googleMutateBodyOf, publishModeOf } from './channels.js'
import { GOOGLE_ACCOUNT_CALL_PATHS, GOOGLE_ACCOUNT_CHECKABLE } from './google-account-calls.js'
import { classifyChannelAnswer } from './vocabulary.js'
import { ledgerSafeBody } from './redact.js'
import { googleRateReading } from '../cx/rate-readings.js'
import { GOOGLE_ADS_API_BASE, GOOGLE_ADS_API_VERSION } from '../google/api-version.js'

const SEARCH = `${GOOGLE_ADS_API_BASE}/customers/1234567890/googleAds:search`
const MUTATE = `${GOOGLE_ADS_API_BASE}/customers/1234567890/googleAds:mutate`
const OPS = [{ campaignBudgetOperation: { update: { resourceName: 'customers/1234567890/campaignBudgets/1', amountMicros: '10000' }, updateMask: 'amount_micros' } }]
const headersOf = (i = 0) => h.calls[i].init.headers as Record<string, string>

beforeEach(() => {
  __rateTest.useMemory()
  h.calls = []; h.answers = []; gatewayLedger.length = 0; gatewayGoogleUnlinked.clear()
  for (const id of Object.keys(gatewayAccounts)) delete gatewayAccounts[id]
  vi.stubEnv('GOOGLE_ADS_DEVELOPER_TOKEN', '')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ results: [] }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset() })

describe('Google: reads, and Google Ads mutates only', () => {
  it('a GAQL search (POST …:search) is a read: sent once, Bearer token, JSON body, one GOOGLE ledger row', async () => {
    const res = await googleCall({ connectionId: 'g-1', operation: 'ads.search', method: 'POST', url: SEARCH, body: { query: 'SELECT customer.id FROM customer' } })
    expect(res.status).toBe(200)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].init.method).toBe('POST')
    expect(headersOf()).toMatchObject({ Authorization: 'Bearer google-access-token', 'Content-Type': 'application/json' })
    expect(h.calls[0].init.body).toBe('{"query":"SELECT customer.id FROM customer"}')
    expect(gatewayLedger).toEqual([expect.objectContaining({ channel: 'GOOGLE', connectionId: 'g-1', operation: 'ads.search', outcome: 'sent', success: true, apiVersion: GOOGLE_ADS_API_VERSION })])
  })

  it('GoogleAdsService.Mutate is a write: sent once (never retried), its ledger row, under the publish mode', async () => {
    h.answers.push(() => new Response('{}', { status: 503 }))
    const res = await googleCall({ connectionId: 'g-1', operation: 'ads.mutate', method: 'POST', url: MUTATE, body: { mutateOperations: OPS } })
    expect(res.status).toBe(503)
    expect(h.calls).toHaveLength(1)
    expect(gatewayLedger).toEqual([expect.objectContaining({ channel: 'GOOGLE', operation: 'ads.mutate', outcome: 'sent', success: false })])
    expect(publishModeOf('GOOGLE')).toBe('live')
  })

  it('NEXUS_GOOGLE_ADS_WRITES=off: a real mutate is refused before anything is sent; a validate-only check still goes', async () => {
    vi.stubEnv('NEXUS_GOOGLE_ADS_WRITES', 'off')
    expect(publishModeOf('GOOGLE')).toBe('gated')
    const err = await googleCall({ connectionId: 'g-1', operation: 'ads.mutate', method: 'POST', url: MUTATE, body: { mutateOperations: OPS } }).catch((e) => e)
    expect(err).toBeInstanceOf(GatewayRefusal)
    expect(err).toMatchObject({ outcome: 'gated', code: 'PUBLISH_GATED' })
    expect(h.calls).toHaveLength(0)
    const check = await googleCall({ connectionId: 'g-1', operation: 'ads.mutate.check', method: 'POST', url: MUTATE, body: { mutateOperations: OPS, validateOnly: true } })
    expect(check.status).toBe(200)
    expect(h.calls).toHaveLength(1)
    expect(gatewayLedger.map((r) => r.outcome)).toEqual(['gated', 'sent'])
  })

  it('an ad edited in place (adOperation: AdService, v25 MutateOperation.ad_operation) goes, check and change; the kinds are exactly what the tools send', async () => {
    const AD_EDIT = [{ adOperation: { update: { resourceName: 'customers/1234567890/ads/701', finalUrls: ['https://shop.example/a'] }, updateMask: 'final_urls' } }]
    const check = await googleCall({ connectionId: 'g-1', operation: 'ads.mutate.check', method: 'POST', url: MUTATE, body: { mutateOperations: AD_EDIT, validateOnly: true } })
    expect(check.status).toBe(200)
    const run = await googleCall({ connectionId: 'g-1', operation: 'ads.mutate', method: 'POST', url: MUTATE, body: { mutateOperations: AD_EDIT } })
    expect(run.status).toBe(200)
    expect(h.calls.map((c) => JSON.parse(String(c.init.body)))).toEqual([{ mutateOperations: AD_EDIT, validateOnly: true }, { mutateOperations: AD_EDIT }])
    expect(gatewayLedger.map((r) => r.outcome)).toEqual(['sent', 'sent'])
    expect([...GOOGLE_ADS_MUTATE_KINDS].sort()).toEqual([
      'adGroupAdLabelOperation', 'adGroupAdOperation', 'adGroupAssetOperation', 'adGroupBidModifierOperation', 'adGroupCriterionLabelOperation',
      'adGroupCriterionOperation', 'adGroupLabelOperation', 'adGroupOperation', 'adOperation', 'assetOperation',
      'biddingStrategyOperation', 'campaignAssetOperation', 'campaignBudgetOperation', 'campaignCriterionOperation',
      'campaignDraftOperation', 'campaignLabelOperation', 'campaignOperation', 'campaignSharedSetOperation',
      'customerAssetOperation', 'customerNegativeCriterionOperation', 'customerOperation', 'experimentArmOperation',
      'experimentOperation', 'labelOperation',
      'recommendationSubscriptionOperation', 'sharedCriterionOperation', 'sharedSetOperation',
    ])
    // Its neighbours stay refused: an ad parameter (AdService's family), a customer operation that is not exactly an
    // update of the account's settings (G8b: google-account-calls.vitest.test.ts).
    for (const op of [{ adParameterOperation: { create: {} } }, { customerOperation: { update: {} } }]) {
      const err = await googleCall({ connectionId: 'g-1', operation: 'ads.mutate', method: 'POST', url: MUTATE, body: { mutateOperations: [op], validateOnly: true } }).catch((e) => e)
      expect(err).toMatchObject({ outcome: 'refused', code: 'GOOGLE_READ_ONLY' })
    }
    expect(h.calls).toHaveLength(2)
  })

  it('the Google Ads methods besides Mutate that Nexus sends (G8b: the account\'s users, links, billing) are exactly these', () => {
    // Bodies, customers and refusals: google-account-calls.vitest.test.ts. A new method is a new line here, on purpose.
    expect([...GOOGLE_ACCOUNT_CALL_PATHS].sort()).toEqual([
      'accountBudgetProposals:mutate', 'billingSetups:mutate', 'customerUserAccessInvitations:mutate', 'customerUserAccesses:mutate',
      'dataLinks:create', 'dataLinks:remove', 'dataLinks:update', 'productLinkInvitations:remove', 'productLinkInvitations:update',
      'productLinks:create', 'productLinks:remove',
    ])
    // Only these two have validate_only (v25 RemoveProductLinkRequest, MutateAccountBudgetProposalRequest).
    expect([...GOOGLE_ACCOUNT_CHECKABLE].sort()).toEqual(['accountBudgetProposals:mutate', 'productLinks:remove'])
  })

  it('G6: an asset linked at an ad group or at the account (adGroupAssetOperation, customerAssetOperation) goes, check and change; asset set links stay refused', async () => {
    const LINKS = [
      { adGroupAssetOperation: { create: { adGroup: 'customers/1234567890/adGroups/51', asset: 'customers/1234567890/assets/301', fieldType: 'CALLOUT' } } },
      { customerAssetOperation: { update: { resourceName: 'customers/1234567890/customerAssets/302~CALL', status: 'PAUSED' }, updateMask: 'status' } },
    ]
    const check = await googleCall({ connectionId: 'g-1', operation: 'ads.mutate.check', method: 'POST', url: MUTATE, body: { mutateOperations: LINKS, validateOnly: true } })
    expect(check.status).toBe(200)
    const run = await googleCall({ connectionId: 'g-1', operation: 'ads.mutate', method: 'POST', url: MUTATE, body: { mutateOperations: LINKS } })
    expect(run.status).toBe(200)
    expect(h.calls).toHaveLength(2)
    // Nexus sends no asset set (location) operation: refused before anything is sent.
    for (const op of [{ assetSetOperation: { create: {} } }, { campaignAssetSetOperation: { create: {} } }]) {
      const err = await googleCall({ connectionId: 'g-1', operation: 'ads.mutate', method: 'POST', url: MUTATE, body: { mutateOperations: [op], validateOnly: true } }).catch((e) => e)
      expect(err).toMatchObject({ outcome: 'refused', code: 'GOOGLE_READ_ONLY' })
    }
    expect(h.calls).toHaveLength(2)
  })

  it('what is sent is the body as judged: a duplicate key collapses before sending', async () => {
    const raw = `{"validateOnly":false,"mutateOperations":${JSON.stringify(OPS)},"validateOnly":true}`
    await gatewayCall({ channel: 'GOOGLE', operation: 'ads.mutate.check', kind: 'read', connectionId: 'g-1', url: MUTATE, method: 'POST', body: raw })
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual({ mutateOperations: OPS, validateOnly: true })
    expect(String(h.calls[0].init.body).match(/validateOnly/g)).toHaveLength(1)
  })

  it('every other Google change is refused before anything is sent, with its one ledger row', async () => {
    const tries = [
      // another Google API
      googleCall({ connectionId: 'g-1', operation: 'merchant.registerGcp', method: 'POST', url: 'https://merchantapi.googleapis.com/accounts/v1/accounts/1/developerRegistration:registerGcp', body: {} }),
      // another Google Ads service: a new account (CustomerService.CreateCustomerClient) is never sent
      googleCall({ connectionId: 'g-1', operation: 'ads.x', method: 'POST', url: `${GOOGLE_ADS_API_BASE}/customers/1234567890:createCustomerClient`, body: { customerClient: { descriptiveName: 'Shop B' } } }),
      googleCall({ connectionId: 'g-1', operation: 'ads.x', method: 'POST', url: `${GOOGLE_ADS_API_BASE}/customers/1234567890/campaigns:mutate`, body: { operations: [] } }),
      // a kind of operation Nexus never sends (a customer create: CustomerOperation has no create)
      googleCall({ connectionId: 'g-1', operation: 'ads.mutate', method: 'POST', url: MUTATE, body: { mutateOperations: [{ customerOperation: { create: { descriptiveName: 'Shop B' } } }] } }),
      // snake_case Google also reads
      googleCall({ connectionId: 'g-1', operation: 'ads.mutate', method: 'POST', url: MUTATE, body: { mutateOperations: OPS, validateOnly: true, validate_only: false } }),
      // a query string
      googleCall({ connectionId: 'g-1', operation: 'ads.mutate', method: 'POST', url: `${MUTATE}?x=1`, body: { mutateOperations: OPS } }),
    ]
    for (const t of tries) expect(await t.catch((e) => e)).toMatchObject({ outcome: 'refused', code: 'GOOGLE_READ_ONLY', statusCode: 403 })
    expect(h.calls).toHaveLength(0)
    expect(gatewayLedger).toEqual(tries.map(() => expect.objectContaining({ channel: 'GOOGLE', outcome: 'refused', errorCode: 'GOOGLE_READ_ONLY', success: false, statusCode: null })))
  })

  it('an ad group\'s device bid adjustment (adGroupBidModifierOperation) is a kind Nexus sends; a campaign bid modifier is not', () => {
    const device = [{ adGroupBidModifierOperation: { create: { adGroup: 'customers/1234567890/adGroups/51', device: { type: 'MOBILE' }, bidModifier: 1.2 } } }]
    expect(googleMutateBodyOf(JSON.stringify({ mutateOperations: device, validateOnly: true }))).toMatchObject({ check: true })
    expect(googleKind('POST', MUTATE, { mutateOperations: device, validateOnly: true })).toBe('read')
    expect(googleMutateBodyOf(JSON.stringify({ mutateOperations: [{ campaignBidModifierOperation: { create: {} } }] }))).toEqual({ refusal: 'it holds an operation Nexus does not send (campaignBidModifierOperation)' })
  })

  it('G7: the account\'s exclusions (customerNegativeCriterionOperation) go through a mutate; a bare customer operation does not', () => {
    const exclude = [{ customerNegativeCriterionOperation: { create: { placementList: { sharedSet: 'customers/1234567890/sharedSets/41' } } } }]
    expect(googleKind('POST', MUTATE, { mutateOperations: exclude, validateOnly: true })).toBe('read')
    expect(googleKind('POST', MUTATE, { mutateOperations: exclude })).toBe('write')
    // G8b allows only an update of the account's own settings fields (google-account-calls.ts); a bare one is refused.
    expect(googleMutateBodyOf(JSON.stringify({ mutateOperations: [{ customerOperation: { update: {} } }] }))).toEqual({ refusal: 'the customer update does not name this account' })
  })

  it('G7: Google Ads\' brand lookup (…/customers/{id}:suggestBrands) is a read; nothing else of its shape is', async () => {
    const SUGGEST = `${GOOGLE_ADS_API_BASE}/customers/1234567890:suggestBrands`
    expect(googleKind('POST', SUGGEST, { brandPrefix: 'Brand' })).toBe('read')
    h.answers.push(() => new Response(JSON.stringify({ brands: [] }), { status: 200 }))
    const res = await googleCall({ connectionId: 'g-1', operation: 'ads.suggestBrands', method: 'POST', url: SUGGEST, body: { brandPrefix: 'Brand' } })
    expect(res.status).toBe(200)
    expect(h.calls.map((c) => c.url)).toEqual([SUGGEST])
    for (const url of [
      `${GOOGLE_ADS_API_BASE}/customers/1234567890:suggestSomething`, `${GOOGLE_ADS_API_BASE}/customers/1234567890/x:suggestBrands`,
      `${SUGGEST}?alt=json`, 'https://example.com/v25/customers/1234567890:suggestBrands',
    ]) expect(googleKind('POST', url, {}), url).toBe('action')
    expect(googleKind('PATCH', SUGGEST, {})).toBe('action')
  })

  it('a Google Ads account the business did not choose through this connection is refused, check or change', async () => {
    gatewayGoogleUnlinked.add('g-1:1234567890')
    for (const body of [{ mutateOperations: OPS }, { mutateOperations: OPS, validateOnly: true }]) {
      const err = await googleCall({ connectionId: 'g-1', operation: 'ads.mutate', method: 'POST', url: MUTATE, body }).catch((e) => e)
      expect(err).toMatchObject({ outcome: 'refused', code: 'GOOGLE_ACCOUNT_NOT_CHOSEN' })
    }
    expect(h.calls).toHaveLength(0)
  })

  it('a change declared as a read is still refused (the gateway checks the method, path and body too)', async () => {
    const err = await gatewayCall({ channel: 'GOOGLE', operation: 'ads.sneaky', kind: 'read', connectionId: 'g-1', url: MUTATE, method: 'POST', body: JSON.stringify({ mutateOperations: OPS }) }).catch((e) => e)
    expect(err).toMatchObject({ code: 'GOOGLE_READ_ONLY' })
    const notReallyCheck = await gatewayCall({ channel: 'GOOGLE', operation: 'ads.sneaky', kind: 'read', connectionId: 'g-1', url: MUTATE, method: 'POST', body: JSON.stringify({ mutateOperations: OPS, validateOnly: 'true' }) }).catch((e) => e)
    expect(notReallyCheck).toMatchObject({ code: 'GOOGLE_READ_ONLY' })
    const put = await gatewayCall({ channel: 'GOOGLE', operation: 'merchant.put', kind: 'read', connectionId: 'g-1', url: 'https://merchantapi.googleapis.com/accounts/v1/accounts/1', method: 'PATCH', body: '{}' }).catch((e) => e)
    expect(put).toMatchObject({ code: 'GOOGLE_READ_ONLY' })
    const writeSearch = await gatewayCall({ channel: 'GOOGLE', operation: 'ads.search', kind: 'write', connectionId: 'g-1', url: SEARCH, method: 'POST', body: '{}' }).catch((e) => e)
    expect(writeSearch).toMatchObject({ code: 'GOOGLE_READ_ONLY' })
    expect(h.calls).toHaveLength(0)
    expect(gatewayLedger.map((r) => r.errorCode)).toEqual(['GOOGLE_READ_ONLY', 'GOOGLE_READ_ONLY', 'GOOGLE_READ_ONLY', 'GOOGLE_READ_ONLY'])
  })

  it('googleKind: GET, …:search / …:searchStream and a validate-only Ads mutate read; a real Ads mutate writes; the rest is refused', () => {
    expect(googleKind('GET', `${GOOGLE_ADS_API_BASE}/customers:listAccessibleCustomers`)).toBe('read')
    expect(googleKind('POST', SEARCH)).toBe('read')
    expect(googleKind('POST', `${GOOGLE_ADS_API_BASE}/customers/1/googleAds:searchStream`)).toBe('read')
    expect(googleKind('POST', 'https://merchantapi.googleapis.com/reports/v1/accounts/1/reports:search')).toBe('read')
    expect(googleKind('POST', MUTATE, { mutateOperations: OPS })).toBe('write')
    expect(googleKind('POST', MUTATE, { mutateOperations: OPS, validateOnly: true })).toBe('read')
    expect(googleKind('POST', `${GOOGLE_ADS_API_BASE}/customers/1/campaigns:mutate`, { operations: [] })).toBe('action')
    expect(googleKind('POST', `${GOOGLE_ADS_API_BASE}/customers/abc/googleAds:mutate`)).toBe('action')
    expect(googleKind('POST', `${SEARCH}x`)).toBe('action')
    expect(googleKind('DELETE', SEARCH)).toBe('action')
  })

  it('an account that needs sign-in is held, not called', async () => {
    gatewayAccounts['g-2'] = { authStatus: 'needs_reauth', isActive: true, displayName: 'Google' }
    const err = await googleCall({ connectionId: 'g-2', operation: 'ads.search', method: 'POST', url: SEARCH, body: {} }).catch((e) => e)
    expect(err).toMatchObject({ outcome: 'held', code: 'ACCOUNT_NEEDS_SIGNIN' })
    expect(h.calls).toHaveLength(0)
  })
})

describe('Google Ads G5: the new mutate kinds, and applying / dismissing recommendations', () => {
  const APPLY = `${GOOGLE_ADS_API_BASE}/customers/1234567890/recommendations:apply`
  const DISMISS = `${GOOGLE_ADS_API_BASE}/customers/1234567890/recommendations:dismiss`
  const REC = 'customers/1234567890/recommendations/r-1'

  it('labels, their links, portfolio bid strategies and auto-apply settings go through a mutate (check and change)', async () => {
    const ops = [
      { labelOperation: { create: { resourceName: 'customers/1234567890/labels/-1', name: 'Label A' } } },
      { campaignLabelOperation: { create: { campaign: 'customers/1234567890/campaigns/21', label: 'customers/1234567890/labels/-1' } } },
      { adGroupLabelOperation: { remove: 'customers/1234567890/adGroupLabels/51~61' } },
      { adGroupAdLabelOperation: { remove: 'customers/1234567890/adGroupAdLabels/51~701~61' } },
      { adGroupCriterionLabelOperation: { remove: 'customers/1234567890/adGroupCriterionLabels/51~601~61' } },
      { biddingStrategyOperation: { create: { name: 'Strategy A', targetSpend: {} } } },
      { recommendationSubscriptionOperation: { create: { type: 'KEYWORD', status: 'PAUSED' } } },
    ]
    await googleCall({ connectionId: 'g-1', operation: 'ads.mutate.check', method: 'POST', url: MUTATE, body: { mutateOperations: ops, validateOnly: true } })
    await googleCall({ connectionId: 'g-1', operation: 'ads.mutate', method: 'POST', url: MUTATE, body: { mutateOperations: ops } })
    expect(h.calls).toHaveLength(2)
    expect(gatewayLedger.map((r) => r.outcome)).toEqual(['sent', 'sent'])
  })

  it('an apply and a dismiss are writes (Google has no check for them): sent once, the body as judged, their ledger rows', async () => {
    expect(googleKind('POST', APPLY, { operations: [{ resourceName: REC }] })).toBe('write')
    expect(googleKind('POST', DISMISS, { operations: [{ resourceName: REC }] })).toBe('write')
    h.answers.push(() => new Response('{}', { status: 503 }))
    const res = await googleCall({ connectionId: 'g-1', operation: 'ads.recommendations.apply', method: 'POST', url: APPLY, body: { operations: [{ resourceName: REC, campaignBudget: { newBudgetAmountMicros: '15000000' } }], partialFailure: false } })
    expect(res.status).toBe(503)
    await googleCall({ connectionId: 'g-1', operation: 'ads.recommendations.dismiss', method: 'POST', url: DISMISS, body: { operations: [{ resourceName: REC }] } })
    expect(h.calls).toHaveLength(2)
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual({ operations: [{ resourceName: REC, campaignBudget: { newBudgetAmountMicros: '15000000' } }], partialFailure: false })
    expect(gatewayLedger).toEqual([
      expect.objectContaining({ channel: 'GOOGLE', operation: 'ads.recommendations.apply', outcome: 'sent', success: false }),
      expect.objectContaining({ channel: 'GOOGLE', operation: 'ads.recommendations.dismiss', outcome: 'sent', success: true }),
    ])
  })

  it('NEXUS_GOOGLE_ADS_WRITES=off: an apply is refused before anything is sent', async () => {
    vi.stubEnv('NEXUS_GOOGLE_ADS_WRITES', 'off')
    const err = await googleCall({ connectionId: 'g-1', operation: 'ads.recommendations.apply', method: 'POST', url: APPLY, body: { operations: [{ resourceName: REC }] } }).catch((e) => e)
    expect(err).toMatchObject({ outcome: 'gated', code: 'PUBLISH_GATED' })
    expect(h.calls).toHaveLength(0)
  })

  it('every other apply / dismiss body, path or declared kind is refused before anything is sent', async () => {
    const tries = [
      // another customer's recommendation
      googleCall({ connectionId: 'g-1', operation: 'ads.recommendations.apply', method: 'POST', url: APPLY, body: { operations: [{ resourceName: 'customers/999/recommendations/r-1' }] } }),
      // a parameter Nexus never sends, two parameters, a dismiss with a parameter
      googleCall({ connectionId: 'g-1', operation: 'ads.recommendations.apply', method: 'POST', url: APPLY, body: { operations: [{ resourceName: REC, sitelinkAsset: {} }] } }),
      googleCall({ connectionId: 'g-1', operation: 'ads.recommendations.apply', method: 'POST', url: APPLY, body: { operations: [{ resourceName: REC, keyword: {}, campaignBudget: {} }] } }),
      googleCall({ connectionId: 'g-1', operation: 'ads.recommendations.dismiss', method: 'POST', url: DISMISS, body: { operations: [{ resourceName: REC, campaignBudget: {} }] } }),
      // a "check" Google does not have, partial failure, snake_case, no operations, more than 100
      googleCall({ connectionId: 'g-1', operation: 'ads.recommendations.apply', method: 'POST', url: APPLY, body: { operations: [{ resourceName: REC }], validateOnly: true } }),
      googleCall({ connectionId: 'g-1', operation: 'ads.recommendations.apply', method: 'POST', url: APPLY, body: { operations: [{ resourceName: REC }], partialFailure: true } }),
      googleCall({ connectionId: 'g-1', operation: 'ads.recommendations.apply', method: 'POST', url: APPLY, body: { operations: [{ resource_name: REC }] } }),
      googleCall({ connectionId: 'g-1', operation: 'ads.recommendations.apply', method: 'POST', url: APPLY, body: { operations: [] } }),
      googleCall({ connectionId: 'g-1', operation: 'ads.recommendations.apply', method: 'POST', url: APPLY, body: { operations: Array.from({ length: 101 }, (_, i) => ({ resourceName: `${REC}${i}` })) } }),
      // another RecommendationService method, a query string
      googleCall({ connectionId: 'g-1', operation: 'ads.x', method: 'POST', url: `${GOOGLE_ADS_API_BASE}/customers/1234567890/recommendations:generate`, body: {} }),
      googleCall({ connectionId: 'g-1', operation: 'ads.recommendations.apply', method: 'POST', url: `${APPLY}?x=1`, body: { operations: [{ resourceName: REC }] } }),
      // an apply declared as a read
      gatewayCall({ channel: 'GOOGLE', operation: 'ads.sneaky', kind: 'read', connectionId: 'g-1', url: APPLY, method: 'POST', body: JSON.stringify({ operations: [{ resourceName: REC }] }) }),
    ]
    for (const t of tries) expect(await t.catch((e) => e)).toMatchObject({ outcome: 'refused', code: 'GOOGLE_READ_ONLY' })
    expect(h.calls).toHaveLength(0)
  })

  it('an apply for an account the business did not choose through this connection is refused', async () => {
    gatewayGoogleUnlinked.add('g-1:1234567890')
    const err = await googleCall({ connectionId: 'g-1', operation: 'ads.recommendations.apply', method: 'POST', url: APPLY, body: { operations: [{ resourceName: REC }] } }).catch((e) => e)
    expect(err).toMatchObject({ outcome: 'refused', code: 'GOOGLE_ACCOUNT_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(0)
  })
})

describe('Google Ads G9: experiments, their arms and campaign drafts (a mutate), and the experiment / draft actions', () => {
  const EXP = `${GOOGLE_ADS_API_BASE}/customers/1234567890/experiments/11`
  const DRAFT = `${GOOGLE_ADS_API_BASE}/customers/1234567890/campaignDrafts/21~3`
  const MAPPING = { experimentCampaign: 'customers/1234567890/campaigns/23', campaignBudget: 'customers/1234567890/campaignBudgets/14' }

  it('an experiment with its arms and a campaign draft go through a mutate (check and change)', async () => {
    const ops = [
      { experimentOperation: { create: { resourceName: 'customers/1234567890/experiments/-1', name: 'Test A', type: 'SEARCH_CUSTOM', status: 'SETUP', suffix: ' [experiment]' } } },
      { experimentArmOperation: { create: { experiment: 'customers/1234567890/experiments/-1', name: 'Control', control: true, trafficSplit: 50, campaigns: ['customers/1234567890/campaigns/21'] } } },
      { experimentArmOperation: { create: { experiment: 'customers/1234567890/experiments/-1', name: 'Treatment', control: false, trafficSplit: 50 } } },
      { campaignDraftOperation: { create: { baseCampaign: 'customers/1234567890/campaigns/21', name: 'Draft A' } } },
    ]
    await googleCall({ connectionId: 'g-1', operation: 'ads.mutate.check', method: 'POST', url: MUTATE, body: { mutateOperations: ops, validateOnly: true } })
    await googleCall({ connectionId: 'g-1', operation: 'ads.mutate', method: 'POST', url: MUTATE, body: { mutateOperations: ops } })
    expect(h.calls).toHaveLength(2)
    expect(gatewayLedger.map((r) => r.outcome)).toEqual(['sent', 'sent'])
  })

  it('schedule / end / promote / graduate and a draft\'s promote: a check (validateOnly) is a read, a real one a write, each on its exact path', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      [`${EXP}:scheduleExperiment`, {}], [`${EXP}:endExperiment`, {}], [`${EXP}:promoteExperiment`, {}],
      [`${EXP}:graduateExperiment`, { campaignBudgetMappings: [MAPPING] }], [`${DRAFT}:promote`, {}],
    ]
    for (const [url, body] of calls) {
      expect(googleKind('POST', url, { ...body, validateOnly: true })).toBe('read')
      expect(googleKind('POST', url, { ...body, validateOnly: false })).toBe('write')
      expect(googleKind('POST', url, body)).toBe('write')
      await googleCall({ connectionId: 'g-1', operation: 'ads.experiments.check', method: 'POST', url, body: { ...body, validateOnly: true } })
      await googleCall({ connectionId: 'g-1', operation: 'ads.experiments.action', method: 'POST', url, body: { ...body, validateOnly: false } })
    }
    expect(h.calls.map((c) => c.url)).toEqual(calls.flatMap(([url]) => [url, url]))
    expect(JSON.parse(String(h.calls[7].init.body))).toEqual({ campaignBudgetMappings: [MAPPING], validateOnly: false })
    expect(gatewayLedger.every((r) => r.outcome === 'sent')).toBe(true)
    expect(googleAdsExperimentCall('POST', `${DRAFT}:promote`)).toEqual({ customer: '1234567890', action: 'promoteCampaignDraft' })
  })

  it('NEXUS_GOOGLE_ADS_WRITES=off: a real action is refused before anything is sent; Google\'s check still goes', async () => {
    vi.stubEnv('NEXUS_GOOGLE_ADS_WRITES', 'off')
    const err = await googleCall({ connectionId: 'g-1', operation: 'ads.experiments.scheduleExperiment', method: 'POST', url: `${EXP}:scheduleExperiment`, body: { validateOnly: false } }).catch((e) => e)
    expect(err).toMatchObject({ outcome: 'gated', code: 'PUBLISH_GATED' })
    expect(h.calls).toHaveLength(0)
    const check = await googleCall({ connectionId: 'g-1', operation: 'ads.experiments.scheduleExperiment.check', method: 'POST', url: `${EXP}:scheduleExperiment`, body: { validateOnly: true } })
    expect(check.status).toBe(200)
    expect(h.calls).toHaveLength(1)
  })

  it('every other experiment / draft body, path or declared kind is refused before anything is sent', async () => {
    const tries = [
      // a field Nexus never sends, snake_case, a non-boolean check, mappings on another action
      googleCall({ connectionId: 'g-1', operation: 'ads.x', method: 'POST', url: `${EXP}:endExperiment`, body: { validateOnly: false, experiment: 'customers/1/experiments/11' } }),
      googleCall({ connectionId: 'g-1', operation: 'ads.x', method: 'POST', url: `${EXP}:endExperiment`, body: { validate_only: true } }),
      googleCall({ connectionId: 'g-1', operation: 'ads.x', method: 'POST', url: `${EXP}:promoteExperiment`, body: { validateOnly: 'true' } }),
      googleCall({ connectionId: 'g-1', operation: 'ads.x', method: 'POST', url: `${EXP}:scheduleExperiment`, body: { campaignBudgetMappings: [MAPPING] } }),
      // a graduate with no mapping, two mappings (Google: at most one), another customer's campaign or budget, an extra key
      googleCall({ connectionId: 'g-1', operation: 'ads.x', method: 'POST', url: `${EXP}:graduateExperiment`, body: { campaignBudgetMappings: [] } }),
      googleCall({ connectionId: 'g-1', operation: 'ads.x', method: 'POST', url: `${EXP}:graduateExperiment`, body: { campaignBudgetMappings: [MAPPING, MAPPING] } }),
      googleCall({ connectionId: 'g-1', operation: 'ads.x', method: 'POST', url: `${EXP}:graduateExperiment`, body: { campaignBudgetMappings: [{ ...MAPPING, experimentCampaign: 'customers/999/campaigns/23' }] } }),
      googleCall({ connectionId: 'g-1', operation: 'ads.x', method: 'POST', url: `${EXP}:graduateExperiment`, body: { campaignBudgetMappings: [{ ...MAPPING, campaignBudget: 'customers/999/campaignBudgets/14' }] } }),
      googleCall({ connectionId: 'g-1', operation: 'ads.x', method: 'POST', url: `${EXP}:graduateExperiment`, body: { campaignBudgetMappings: [{ ...MAPPING, x: 1 }] } }),
      // other ExperimentService / CampaignDraftService / Operations methods, a query string, a non-numeric id
      googleCall({ connectionId: 'g-1', operation: 'ads.x', method: 'POST', url: `${GOOGLE_ADS_API_BASE}/customers/1234567890/experiments:mutate`, body: { operations: [] } }),
      googleCall({ connectionId: 'g-1', operation: 'ads.x', method: 'POST', url: `${GOOGLE_ADS_API_BASE}/customers/1234567890/campaignDrafts:mutate`, body: { operations: [] } }),
      googleCall({ connectionId: 'g-1', operation: 'ads.x', method: 'POST', url: `${GOOGLE_ADS_API_BASE}/customers/1234567890/operations/op-1:cancel`, body: {} }),
      googleCall({ connectionId: 'g-1', operation: 'ads.x', method: 'DELETE', url: `${GOOGLE_ADS_API_BASE}/customers/1234567890/operations/op-1` }),
      googleCall({ connectionId: 'g-1', operation: 'ads.x', method: 'POST', url: `${EXP}:endExperiment?x=1`, body: { validateOnly: false } }),
      googleCall({ connectionId: 'g-1', operation: 'ads.x', method: 'POST', url: `${GOOGLE_ADS_API_BASE}/customers/1234567890/experiments/abc:endExperiment`, body: { validateOnly: false } }),
      googleCall({ connectionId: 'g-1', operation: 'ads.x', method: 'POST', url: `${GOOGLE_ADS_API_BASE}/customers/1234567890/campaignDrafts/3:promote`, body: { validateOnly: false } }),
      // a real action declared as a read, a check declared as a write
      gatewayCall({ channel: 'GOOGLE', operation: 'ads.sneaky', kind: 'read', connectionId: 'g-1', url: `${EXP}:endExperiment`, method: 'POST', body: JSON.stringify({ validateOnly: false }) }),
      gatewayCall({ channel: 'GOOGLE', operation: 'ads.sneaky', kind: 'write', connectionId: 'g-1', url: `${EXP}:endExperiment`, method: 'POST', body: JSON.stringify({ validateOnly: true }) }),
    ]
    for (const t of tries) expect(await t.catch((e) => e)).toMatchObject({ outcome: 'refused', code: 'GOOGLE_READ_ONLY' })
    expect(h.calls).toHaveLength(0)
  })

  it('an action on an account the business did not choose through this connection is refused, check or change', async () => {
    gatewayGoogleUnlinked.add('g-1:1234567890')
    for (const body of [{ validateOnly: true }, { validateOnly: false }]) {
      const err = await googleCall({ connectionId: 'g-1', operation: 'ads.x', method: 'POST', url: `${EXP}:endExperiment`, body }).catch((e) => e)
      expect(err).toMatchObject({ outcome: 'refused', code: 'GOOGLE_ACCOUNT_NOT_CHOSEN' })
    }
    expect(h.calls).toHaveLength(0)
  })

  it('the long-running operation and the async errors are GETs: reads', async () => {
    expect(googleKind('GET', `${GOOGLE_ADS_API_BASE}/customers/1234567890/operations/op-1`)).toBe('read')
    expect(googleKind('GET', `${EXP}:listExperimentAsyncErrors`)).toBe('read')
    expect(googleKind('GET', `${DRAFT}:listAsyncErrors`)).toBe('read')
    await googleCall({ connectionId: 'g-1', operation: 'ads.operations.get', method: 'GET', url: `${GOOGLE_ADS_API_BASE}/customers/1234567890/operations/op-1` })
    expect(gatewayLedger).toEqual([expect.objectContaining({ operation: 'ads.operations.get', outcome: 'sent', success: true })])
  })
})

describe('Google headers', () => {
  it('no developer-token and no login-customer-id unless they apply', async () => {
    await googleCall({ connectionId: 'g-1', operation: 'ads.listAccessibleCustomers', method: 'GET', url: `${GOOGLE_ADS_API_BASE}/customers:listAccessibleCustomers` })
    const names = Object.keys(headersOf()).map((k) => k.toLowerCase())
    expect(names).not.toContain('developer-token')
    expect(names).not.toContain('login-customer-id')
    expect(names).not.toContain('content-type')
  })

  it('developer-token only when GOOGLE_ADS_DEVELOPER_TOKEN is set, and only to the Google Ads host', async () => {
    vi.stubEnv('GOOGLE_ADS_DEVELOPER_TOKEN', 'dev-token-fixture')
    await googleCall({ connectionId: 'g-1', operation: 'ads.search', method: 'POST', url: SEARCH, body: {} })
    await googleCall({ connectionId: 'g-1', operation: 'merchant.accounts.list', method: 'GET', url: 'https://merchantapi.googleapis.com/accounts/v1/accounts' })
    expect(headersOf(0)['developer-token']).toBe('dev-token-fixture')
    expect(headersOf(1)['developer-token']).toBeUndefined()
  })

  it('login-customer-id when given: digits only (dashes dropped); a malformed id is refused before sending', async () => {
    await googleCall({ connectionId: 'g-1', operation: 'ads.search', method: 'POST', url: SEARCH, body: {}, loginCustomerId: '111-222-3333' })
    expect(headersOf()['login-customer-id']).toBe('1112223333')
    await googleCall({ connectionId: 'g-1', operation: 'ads.search', method: 'POST', url: SEARCH, body: {}, loginCustomerId: null })
    expect(headersOf(1)['login-customer-id']).toBeUndefined()
    await expect(googleCall({ connectionId: 'g-1', operation: 'ads.search', method: 'POST', url: SEARCH, body: {}, loginCustomerId: '12; drop' })).rejects.toThrow(/digits only/)
    expect(h.calls).toHaveLength(2)
  })

  it('the ledger keeps the host and path, never the query string', async () => {
    await googleCall({ connectionId: 'g-1', operation: 'analytics.accountSummaries.list', method: 'GET', url: 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200&pageToken=secret-ish' })
    expect(gatewayLedger[0]).toMatchObject({ endpoint: 'analyticsadmin.googleapis.com/v1beta/accountSummaries', apiVersion: 'v1beta' })
    expect(JSON.stringify(gatewayLedger[0])).not.toMatch(/pageToken/)
  })
})

describe('Google rate buckets: one per API (host)', () => {
  it('groups by host and starts each with its own defaults', () => {
    expect(bucketGroupOf('GOOGLE', 'POST', SEARCH)).toBe('ads')
    expect(bucketGroupOf('GOOGLE', 'GET', 'https://merchantapi.googleapis.com/accounts/v1/accounts')).toBe('merchant')
    expect(bucketGroupOf('GOOGLE', 'GET', 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries')).toBe('analytics')
    expect(bucketGroupOf('GOOGLE', 'GET', 'https://openidconnect.googleapis.com/v1/userinfo')).toBe('identity')
    expect(defaultsFor('GOOGLE', bucketKey('GOOGLE', 'g-1', 'ads'))).toEqual(GOOGLE_BUCKETS.ads)
    expect(GOOGLE_BUCKETS.ads).toEqual({ capacity: 60, refillPerSec: 1 / 30 })
    expect(defaultsFor('GOOGLE', bucketKey('GOOGLE', 'g-1', 'merchant'))).toEqual({ capacity: 10, refillPerSec: 2 })
    expect(defaultsFor('GOOGLE', bucketKey('GOOGLE', 'g-1', 'analytics'))).toEqual({ capacity: 10, refillPerSec: 1 })
    expect(defaultsFor('GOOGLE', bucketKey('GOOGLE', 'g-1', 'identity'))).toEqual({ capacity: 5, refillPerSec: 1 })
  })

  it('a 429 is retried once by default (not twice), and reads its Retry-After', async () => {
    h.answers.push(
      () => new Response('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"slow down"}}', { status: 429, headers: { 'retry-after': '0' } }),
      () => new Response('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"slow down"}}', { status: 429, headers: { 'retry-after': '0' } }),
      () => new Response('{}', { status: 200 }),
    )
    const res = await googleCall({ connectionId: 'g-1', operation: 'merchant.accounts.list', method: 'GET', url: 'https://merchantapi.googleapis.com/accounts/v1/accounts' })
    expect(res.status).toBe(429)
    expect(h.calls).toHaveLength(2)
    expect(gatewayLedger[0]).toMatchObject({ success: false, errorClass: 'rate_limited', errorCode: 'RESOURCE_EXHAUSTED', attempts: 2 })
    expect(googleRateReading(new Headers({ 'retry-after': '7' }), 429)).toEqual({ model: 'token_bucket', retryAfterSec: 7 })
    expect(googleRateReading(new Headers(), 200)).toBeNull()
  })
})

describe('Google error classes', () => {
  const adsFailure = (status: number, googleStatus: string, errorCode: Record<string, string>, message = 'm') => JSON.stringify({
    error: { code: status, status: googleStatus, message: 'outer', details: [{ '@type': `type.googleapis.com/google.ads.googleads.${GOOGLE_ADS_API_VERSION}.errors.GoogleAdsFailure`, errors: [{ errorCode, message }] }] },
  })
  it.each([
    [403, adsFailure(403, 'PERMISSION_DENIED', { authorizationError: 'USER_PERMISSION_DENIED' }, 'no access'), 'forbidden', 'USER_PERMISSION_DENIED'],
    [403, adsFailure(403, 'PERMISSION_DENIED', { authorizationError: 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION' }), 'configuration', 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION'],
    [401, adsFailure(401, 'UNAUTHENTICATED', { authenticationError: 'NOT_ADS_USER' }), 'auth_expired', 'NOT_ADS_USER'],
    [400, adsFailure(400, 'INVALID_ARGUMENT', { queryError: 'UNRECOGNIZED_FIELD' }), 'validation', 'UNRECOGNIZED_FIELD'],
    [429, adsFailure(429, 'RESOURCE_EXHAUSTED', { quotaError: 'RESOURCE_EXHAUSTED' }), 'rate_limited', 'RESOURCE_EXHAUSTED'],
    [401, JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'GCP project with id p and number 1 is not registered with the merchant account.' } }), 'configuration', 'UNAUTHENTICATED'],
    [403, JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'API not used', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED' }] } }), 'configuration', 'SERVICE_DISABLED'],
    [403, JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'scopes', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }), 'forbidden', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'],
    [400, JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), 'auth_revoked', 'invalid_grant'],
    [503, JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'try later' } }), 'transient', 'UNAVAILABLE'],
  ])('%i → %s (%s)', (status, body, cls, code) => {
    const v = classifyChannelAnswer('GOOGLE', status, body)
    expect(v).toMatchObject({ errorClass: cls, channelCode: code })
  })
  it('keeps the Google Ads error sentence, not the outer wrapper', () => {
    expect(classifyChannelAnswer('GOOGLE', 403, adsFailure(403, 'PERMISSION_DENIED', { authorizationError: 'USER_PERMISSION_DENIED' }, "User doesn't have permission")).channelMessage).toBe("User doesn't have permission")
  })
})

describe('ledger redaction of form-encoded credentials', () => {
  it('masks token, secret and code values; keeps the rest', () => {
    const safe = ledgerSafeBody('grant_type=refresh_token&refresh_token=fixture-refresh-value&client_id=abc.apps.googleusercontent.com&client_secret=fixture-client-secret&code=fixture-code&code_verifier=verif&postal_code=20100')
    expect(safe).toBe('grant_type=refresh_token&refresh_token=[redacted]&client_id=abc.apps.googleusercontent.com&client_secret=[redacted]&code=[redacted]&code_verifier=[redacted]&postal_code=20100')
    expect(ledgerSafeBody('access_token=fixture.x&id_token=eyJ.y&token_type=Bearer')).toBe('access_token=[redacted]&id_token=[redacted]&token_type=Bearer')
  })
  it('api version: v25 for Google Ads, v1 for Merchant, v1beta for Analytics Admin', () => {
    expect(apiVersionOf('GOOGLE', SEARCH)).toBe('v25')
    expect(apiVersionOf('GOOGLE', 'https://merchantapi.googleapis.com/accounts/v1/accounts')).toBe('v1')
    expect(apiVersionOf('GOOGLE', 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries')).toBe('v1beta')
  })
})
