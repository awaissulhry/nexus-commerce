/**
 * Google Ads programme 2, G8b — the account changes on the gateway: the account's own settings (a customerOperation
 * UPDATE in a mutate, never a create), and the account calls of its users, links and billing (each its own method, an
 * exact path, exactly the bodies the account tools send, ONE customer the business chose). Everything else stays refused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }> }))
vi.mock('./account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'google-access-token') }))
vi.mock('../cx/deprecation-watch.service.js', () => ({ watchForDeprecation: vi.fn(async () => undefined) }))

import { gatewayAccounts, gatewayGoogleUnlinked, gatewayLedger } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { gatewayCall } from './gateway.js'
import { googleCall, googleKind } from './google.js'
import { googleMutateBodyOf } from './channels.js'
import { customerOperationProblem, googleAccountCallBodyOf, googleAdsAccountCall } from './google-account-calls.js'
import { GOOGLE_ADS_API_BASE } from '../google/api-version.js'

const C = 'customers/1234567890'
const BASE = `${GOOGLE_ADS_API_BASE}/${C}`
const MUTATE = `${BASE}/googleAds:mutate`
const SETTINGS = { customerOperation: { update: { resourceName: C, autoTaggingEnabled: false, trackingUrlTemplate: '{lpurl}?src=a' }, updateMask: 'auto_tagging_enabled,tracking_url_template' } }

beforeEach(() => {
  __rateTest.useMemory()
  h.calls = []; gatewayLedger.length = 0; gatewayGoogleUnlinked.clear()
  for (const id of Object.keys(gatewayAccounts)) delete gatewayAccounts[id]
  vi.stubEnv('GOOGLE_ADS_DEVELOPER_TOKEN', '')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return new Response('{}', { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset() })

/** Every body the account tools send, by path (google-ads-account.tools.ts). */
const SENT: Array<[string, Record<string, unknown>]> = [
  ['customerUserAccessInvitations:mutate', { operation: { create: { emailAddress: 'person@example.com', accessRole: 'STANDARD' } } }],
  ['customerUserAccessInvitations:mutate', { operation: { remove: `${C}/customerUserAccessInvitations/71` } }],
  ['customerUserAccesses:mutate', { operation: { update: { resourceName: `${C}/customerUserAccesses/61`, accessRole: 'READ_ONLY' }, updateMask: 'access_role' } }],
  ['customerUserAccesses:mutate', { operation: { remove: `${C}/customerUserAccesses/61` } }],
  ['productLinks:create', { productLink: { merchantCenter: { merchantCenterId: '555' } } }],
  ['productLinks:remove', { resourceName: `${C}/productLinks/41` }],
  ['productLinkInvitations:update', { resourceName: `${C}/productLinkInvitations/42`, productLinkInvitationStatus: 'ACCEPTED' }],
  ['productLinkInvitations:remove', { resourceName: `${C}/productLinkInvitations/42` }],
  ['dataLinks:create', { dataLink: { youtubeVideo: { channelId: 'UCabcdefghijklmnopqrstuv', videoId: 'abcdefghijk' } } }],
  ['dataLinks:update', { resourceName: `${C}/dataLinks/43~44`, dataLinkStatus: 'REVOKED' }],
  ['dataLinks:remove', { resourceName: `${C}/dataLinks/43~44` }],
  ['billingSetups:mutate', { operation: { create: { paymentsAccount: `${C}/paymentsAccounts/1111-2222-3333-4444`, startTimeType: 'NOW' } } }],
  ['billingSetups:mutate', { operation: { remove: `${C}/billingSetups/81` } }],
  ['accountBudgetProposals:mutate', { operation: { create: { proposalType: 'CREATE', billingSetup: `${C}/billingSetups/81`, proposedName: 'Budget A', proposedStartTimeType: 'NOW', proposedEndTimeType: 'FOREVER', proposedSpendingLimitMicros: '500000000' } } }],
  ['accountBudgetProposals:mutate', { operation: { create: { proposalType: 'UPDATE', accountBudget: `${C}/accountBudgets/91`, proposedSpendingLimitMicros: '600000000' }, updateMask: 'proposed_spending_limit_micros' } }],
  ['accountBudgetProposals:mutate', { operation: { create: { proposalType: 'END', accountBudget: `${C}/accountBudgets/91` } } }],
  ['accountBudgetProposals:mutate', { operation: { remove: `${C}/accountBudgetProposals/95` } }],
]

describe('the account\'s own settings: a customerOperation UPDATE in a mutate', () => {
  it('goes as a check and as a change, the body as judged', async () => {
    const check = await googleCall({ connectionId: 'g-1', operation: 'ads.mutate.check', method: 'POST', url: MUTATE, body: { mutateOperations: [SETTINGS], validateOnly: true } })
    expect(check.status).toBe(200)
    await googleCall({ connectionId: 'g-1', operation: 'ads.mutate', method: 'POST', url: MUTATE, body: { mutateOperations: [SETTINGS] } })
    expect(h.calls).toHaveLength(2)
    expect(JSON.parse(String(h.calls[1].init.body))).toEqual({ mutateOperations: [SETTINGS] })
    expect(gatewayLedger.map((r) => r.outcome)).toEqual(['sent', 'sent'])
  })

  it('never a customer create or remove, another customer, another field or a mask Nexus does not send', async () => {
    const bad = [
      { create: { descriptiveName: 'Shop B' } },
      { remove: C },
      { update: { resourceName: 'customers/999', autoTaggingEnabled: true }, updateMask: 'auto_tagging_enabled' },
      { update: { resourceName: C, currencyCode: 'USD' }, updateMask: 'currency_code' },
      { update: { resourceName: C, autoTaggingEnabled: true }, updateMask: 'auto_tagging_enabled,time_zone' },
      { update: { resourceName: C, callReportingSetting: { callReportingEnabled: true, extra: 1 } }, updateMask: 'call_reporting_setting.call_reporting_enabled' },
      { update: { resourceName: C, autoTaggingEnabled: true } },
      { update: { resourceName: C, autoTaggingEnabled: true }, updateMask: 'auto_tagging_enabled', create: {} },
    ]
    for (const op of bad) {
      const err = await googleCall({ connectionId: 'g-1', operation: 'ads.mutate', method: 'POST', url: MUTATE, body: { mutateOperations: [{ customerOperation: op }], validateOnly: true } }).catch((e) => e)
      expect(err, JSON.stringify(op)).toMatchObject({ outcome: 'refused', code: 'GOOGLE_READ_ONLY' })
    }
    expect(h.calls).toHaveLength(0)
    expect(customerOperationProblem({ create: {} })).toMatch(/no create, no remove/)
    // Judged without the URL (googleKind), only the shape: the gateway adds the URL's customer.
    expect(googleMutateBodyOf(JSON.stringify({ mutateOperations: [SETTINGS] }))).toMatchObject({ check: false })
    expect(googleMutateBodyOf(JSON.stringify({ mutateOperations: [SETTINGS] }), '999')).toEqual({ refusal: 'the customer update does not name this account' })
  })

  it('a new account (CustomerService.CreateCustomerClient) is never sent', async () => {
    const err = await googleCall({ connectionId: 'g-1', operation: 'ads.x', method: 'POST', url: `${GOOGLE_ADS_API_BASE}/${C}:createCustomerClient`, body: { customerClient: { descriptiveName: 'Shop B' } } }).catch((e) => e)
    expect(err).toMatchObject({ outcome: 'refused', code: 'GOOGLE_READ_ONLY' })
    expect(h.calls).toHaveLength(0)
  })
})

describe('the account calls: users, links and billing', () => {
  it('every body the tools send goes, once, as a write (never retried), with its ledger row', async () => {
    for (const [path, body] of SENT) {
      expect(googleKind('POST', `${BASE}/${path}`, body), path).toBe('write')
      const res = await googleCall({ connectionId: 'g-1', operation: `ads.account.${path}`, method: 'POST', url: `${BASE}/${path}`, body })
      expect(res.status, path).toBe(200)
    }
    expect(h.calls).toHaveLength(SENT.length)
    expect(h.calls.map((c) => c.url)).toEqual(SENT.map(([path]) => `${BASE}/${path}`))
    expect(gatewayLedger.every((r) => r.channel === 'GOOGLE' && r.outcome === 'sent')).toBe(true)
  })

  it('validate_only on the two methods that have it is a check (a read): it still goes with writes switched off', async () => {
    vi.stubEnv('NEXUS_GOOGLE_ADS_WRITES', 'off')
    for (const [path, body] of SENT.filter(([p]) => p === 'productLinks:remove' || p === 'accountBudgetProposals:mutate')) {
      expect(googleKind('POST', `${BASE}/${path}`, { ...body, validateOnly: true })).toBe('read')
      const ok = await googleCall({ connectionId: 'g-1', operation: 'ads.account.check', method: 'POST', url: `${BASE}/${path}`, body: { ...body, validateOnly: true } })
      expect(ok.status).toBe(200)
      const real = await googleCall({ connectionId: 'g-1', operation: 'ads.account', method: 'POST', url: `${BASE}/${path}`, body }).catch((e) => e)
      expect(real).toMatchObject({ outcome: 'gated', code: 'PUBLISH_GATED' })
    }
    // The others have no check: a validateOnly there is refused (it would read as a check Google does not make).
    const err = await googleCall({ connectionId: 'g-1', operation: 'ads.account', method: 'POST', url: `${BASE}/customerUserAccesses:mutate`, body: { ...SENT[3][1], validateOnly: true } }).catch((e) => e)
    expect(err).toMatchObject({ outcome: 'refused', code: 'GOOGLE_READ_ONLY' })
  })

  it('every other body, path, customer or declared kind is refused before anything is sent', async () => {
    const tries: Array<[string, unknown]> = [
      // another customer's resources
      ['customerUserAccessInvitations:mutate', { operation: { remove: 'customers/999/customerUserAccessInvitations/71' } }],
      ['customerUserAccesses:mutate', { operation: { remove: 'customers/999/customerUserAccesses/61' } }],
      ['productLinks:remove', { resourceName: 'customers/999/productLinks/41' }],
      ['billingSetups:mutate', { operation: { create: { paymentsAccount: 'customers/999/paymentsAccounts/1111-2222-3333-4444', startTimeType: 'NOW' } } }],
      ['accountBudgetProposals:mutate', { operation: { create: { proposalType: 'END', accountBudget: 'customers/999/accountBudgets/91' } } }],
      // more than the tools send
      ['customerUserAccessInvitations:mutate', { operation: { create: { emailAddress: 'person@example.com', accessRole: 'STANDARD', extra: 1 } } }],
      ['customerUserAccessInvitations:mutate', { operation: { create: { emailAddress: 'not an address', accessRole: 'STANDARD' } } }],
      ['customerUserAccessInvitations:mutate', { operation: { create: { emailAddress: 'person@example.com', accessRole: 'OWNER' } } }],
      ['customerUserAccesses:mutate', { operation: { update: { resourceName: `${C}/customerUserAccesses/61`, accessRole: 'ADMIN', emailAddress: 'x@example.com' }, updateMask: 'access_role,email_address' } }],
      ['customerUserAccesses:mutate', { operations: [{ remove: `${C}/customerUserAccesses/61` }] }],
      ['productLinks:create', { productLink: { dataPartner: { dataPartnerId: '1' } } }],
      ['productLinkInvitations:update', { resourceName: `${C}/productLinkInvitations/42`, productLinkInvitationStatus: 'REVOKED' }],
      ['dataLinks:create', { dataLink: { youtubeVideo: { channelId: 'not-a-channel', videoId: 'abcdefghijk' } } }],
      ['dataLinks:update', { resourceName: `${C}/dataLinks/43`, dataLinkStatus: 'ENABLED' }],
      ['billingSetups:mutate', { operation: { create: { paymentsAccountInfo: { paymentsAccountName: 'New', paymentsProfileId: '1111-2222-3333' }, startTimeType: 'NOW' } } }],
      ['accountBudgetProposals:mutate', { operation: { create: { proposalType: 'REMOVE', accountBudget: `${C}/accountBudgets/91` } } }],
      ['accountBudgetProposals:mutate', { operation: { create: { proposalType: 'UPDATE', accountBudget: `${C}/accountBudgets/91`, proposedSpendingLimitMicros: '600000000' } } }],
      ['accountBudgetProposals:mutate', { operation: { create: { proposalType: 'UPDATE', accountBudget: `${C}/accountBudgets/91`, proposedNotes: 'x' }, updateMask: 'proposed_notes' } }],
      ['accountBudgetProposals:mutate', { operation: { create: { proposalType: 'CREATE', billingSetup: `${C}/billingSetups/81`, proposedName: 'Budget A', proposedStartTimeType: 'NOW', proposedEndTimeType: 'FOREVER', proposedSpendingLimitMicros: '5000001' } } }],
      ['accountBudgetProposals:mutate', { operation: { remove: `${C}/accountBudgetProposals/95` }, partial_failure: true }],
      // a method Nexus never calls
      ['productLinkInvitations:create', { productLinkInvitation: { merchantCenter: { merchantCenterId: '555' } } }],
      ['paymentsAccounts', {}],
    ]
    for (const [path, body] of tries) {
      const err = await googleCall({ connectionId: 'g-1', operation: 'ads.account', method: 'POST', url: `${BASE}/${path}`, body }).catch((e) => e)
      expect(err, `${path} ${JSON.stringify(body)}`).toMatchObject({ outcome: 'refused', code: 'GOOGLE_READ_ONLY' })
    }
    // A query string; a change declared as a read.
    const query = await googleCall({ connectionId: 'g-1', operation: 'ads.account', method: 'POST', url: `${BASE}/${SENT[0][0]}?x=1`, body: SENT[0][1] }).catch((e) => e)
    expect(query).toMatchObject({ code: 'GOOGLE_READ_ONLY' })
    const sneaky = await gatewayCall({ channel: 'GOOGLE', operation: 'ads.sneaky', kind: 'read', connectionId: 'g-1', url: `${BASE}/${SENT[3][0]}`, method: 'POST', body: JSON.stringify(SENT[3][1]) }).catch((e) => e)
    expect(sneaky).toMatchObject({ code: 'GOOGLE_READ_ONLY' })
    expect(h.calls).toHaveLength(0)
  })

  it('an account the business did not choose through this connection is refused', async () => {
    gatewayGoogleUnlinked.add('g-1:1234567890')
    const err = await googleCall({ connectionId: 'g-1', operation: 'ads.account', method: 'POST', url: `${BASE}/${SENT[0][0]}`, body: SENT[0][1] }).catch((e) => e)
    expect(err).toMatchObject({ outcome: 'refused', code: 'GOOGLE_ACCOUNT_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(0)
  })

  it('the path check: exact methods, POST only, the Google Ads host only', () => {
    expect(googleAdsAccountCall('POST', `${BASE}/customerUserAccesses:mutate`)).toEqual({ customer: '1234567890', path: 'customerUserAccesses:mutate' })
    expect(googleAdsAccountCall('GET', `${BASE}/customerUserAccesses:mutate`)).toBeNull()
    expect(googleAdsAccountCall('POST', `https://example.com/v25/${C}/customerUserAccesses:mutate`)).toBeNull()
    expect(googleAdsAccountCall('POST', `${BASE}/customerUserAccesses:mutatex`)).toBeNull()
    expect(googleAccountCallBodyOf({ customer: '1234567890', path: 'productLinks:remove' }, JSON.stringify({ resource_name: `${C}/productLinks/41` }))).toEqual({ refusal: 'the body names a field in snake_case' })
  })
})
