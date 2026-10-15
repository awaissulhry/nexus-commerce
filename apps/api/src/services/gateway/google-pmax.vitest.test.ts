/**
 * Google Ads programme 2, G10 — Performance Max on the gateway: the asset group, asset group asset, listing group filter,
 * signal and audience operations a Performance Max change sends (each only with the actions the tools send), and the
 * customer acquisition calls (Goals / CampaignGoalConfigs: exact paths, exactly the bodies set-google-customer-acquisition
 * sends, validate_only a check). Everything else stays refused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }> }))
vi.mock('./account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'google-access-token') }))
vi.mock('../cx/deprecation-watch.service.js', () => ({ watchForDeprecation: vi.fn(async () => undefined) }))

import { gatewayAccounts, gatewayGoogleUnlinked, gatewayLedger } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { googleCall, googleKind } from './google.js'
import { googleMutateBodyOf } from './channels.js'
import { GOOGLE_ADS_API_BASE } from '../google/api-version.js'

const C = 'customers/1234567890'
const BASE = `${GOOGLE_ADS_API_BASE}/${C}`
const MUTATE = `${BASE}/googleAds:mutate`

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

/** What a Performance Max change sends (change-pmax.ts / build-pmax.ts). */
const PMAX_OPS = [
  { assetOperation: { create: { resourceName: `${C}/assets/-1`, textAsset: { text: 'Fast delivery' } } } },
  { audienceOperation: { create: { resourceName: `${C}/audiences/-2`, name: 'Audience Z', dimensions: [{ audienceSegments: { segments: [{ userList: { userList: `${C}/userLists/301` } }] } }] } } },
  { assetGroupOperation: { create: { resourceName: `${C}/assetGroups/-3`, campaign: `${C}/campaigns/21`, name: 'Group Z', finalUrls: ['https://shop.example/'], status: 'PAUSED' } } },
  { assetGroupOperation: { update: { resourceName: `${C}/assetGroups/41`, status: 'PAUSED' }, updateMask: 'status' } },
  { assetGroupAssetOperation: { remove: `${C}/assetGroupAssets/41~301~HEADLINE` } },
  { assetGroupAssetOperation: { create: { assetGroup: `${C}/assetGroups/41`, asset: `${C}/assets/-1`, fieldType: 'HEADLINE' } } },
  { assetGroupListingGroupFilterOperation: { remove: `${C}/assetGroupListingGroupFilters/41~601` } },
  { assetGroupListingGroupFilterOperation: { create: { resourceName: `${C}/assetGroupListingGroupFilters/41~-4`, assetGroup: `${C}/assetGroups/41`, type: 'UNIT_INCLUDED', listingSource: 'SHOPPING' } } },
  { assetGroupSignalOperation: { remove: `${C}/assetGroupSignals/41~701` } },
  { assetGroupSignalOperation: { create: { assetGroup: `${C}/assetGroups/41`, searchTheme: { text: 'moto jacket' } } } },
]

describe('Performance Max operations in a mutate', () => {
  it('go as a check and as a change, the body as judged', async () => {
    const check = await googleCall({ connectionId: 'g-1', operation: 'ads.mutate.check', method: 'POST', url: MUTATE, body: { mutateOperations: PMAX_OPS, validateOnly: true } })
    expect(check.status).toBe(200)
    expect(googleKind('POST', MUTATE, { mutateOperations: PMAX_OPS, validateOnly: true })).toBe('read')
    await googleCall({ connectionId: 'g-1', operation: 'ads.mutate', method: 'POST', url: MUTATE, body: { mutateOperations: PMAX_OPS } })
    expect(h.calls).toHaveLength(2)
    expect(JSON.parse(String(h.calls[1].init.body))).toEqual({ mutateOperations: PMAX_OPS })
    expect(gatewayLedger.map((r) => r.outcome)).toEqual(['sent', 'sent'])
  })

  it('only the actions the tools send: no asset group removed, no audience changed, no filter or signal updated', async () => {
    const bad = [
      { assetGroupOperation: { remove: `${C}/assetGroups/41` } },
      { audienceOperation: { update: { resourceName: `${C}/audiences/5`, name: 'X' }, updateMask: 'name' } },
      { assetGroupListingGroupFilterOperation: { update: { resourceName: `${C}/assetGroupListingGroupFilters/41~601`, caseValue: {} }, updateMask: 'case_value' } },
      { assetGroupSignalOperation: { create: { assetGroup: `${C}/assetGroups/41`, searchTheme: { text: 'x' } }, exemptPolicyViolationKeys: [] } },
      { assetGroupAssetOperation: {} },
    ]
    for (const op of bad) {
      expect(googleMutateBodyOf(JSON.stringify({ mutateOperations: [op] })), JSON.stringify(op)).toMatchObject({ refusal: expect.stringContaining('Nexus sends') })
      const err = await googleCall({ connectionId: 'g-1', operation: 'ads.mutate', method: 'POST', url: MUTATE, body: { mutateOperations: [op], validateOnly: true } }).catch((e) => e)
      expect(err, JSON.stringify(op)).toMatchObject({ outcome: 'refused', code: 'GOOGLE_READ_ONLY' })
    }
    expect(h.calls).toHaveLength(0)
  })
})

/** Every body set-google-customer-acquisition sends (change-acquisition.ts). */
const SENT: Array<[string, Record<string, unknown>]> = [
  ['Goals:mutate', { operations: [{ create: { newCustomerAcquisitionGoalSettings: { valueSettings: { additionalValue: 5, additionalHighLifetimeValue: 12.5 } } } }] }],
  ['Goals:mutate', { operations: [{ update: { resourceName: `${C}/goals/81`, newCustomerAcquisitionGoalSettings: { valueSettings: { additionalValue: 6 } } }, updateMask: 'new_customer_acquisition_goal_settings.value_settings.additional_value' }] }],
  ['CampaignGoalConfigs:mutate', { operations: [{ create: { campaign: `${C}/campaigns/21`, goal: `${C}/goals/81`, campaignNewCustomerAcquisitionSettings: { targetOption: 'TARGET_ALL', valueSettingsOverride: { additionalValue: 7 } } } }] }],
  ['CampaignGoalConfigs:mutate', { operations: [{ update: { resourceName: `${C}/campaignGoalConfigs/21~81`, campaignNewCustomerAcquisitionSettings: { targetOption: 'TARGET_SPECIFIC' } }, updateMask: 'campaign_new_customer_acquisition_settings.target_option,campaign_new_customer_acquisition_settings.value_settings_override.additional_value,campaign_new_customer_acquisition_settings.value_settings_override.additional_high_lifetime_value' }] }],
  ['CampaignGoalConfigs:mutate', { operations: [{ remove: `${C}/campaignGoalConfigs/21~81` }] }],
]

describe('customer acquisition: Goals and CampaignGoalConfigs', () => {
  it('every body the tool sends goes once as a write, and its validate_only check as a read (also with writes off)', async () => {
    for (const [path, body] of SENT) {
      expect(googleKind('POST', `${BASE}/${path}`, body), path).toBe('write')
      expect(googleKind('POST', `${BASE}/${path}`, { ...body, validateOnly: true }), path).toBe('read')
      const res = await googleCall({ connectionId: 'g-1', operation: `ads.account.${path}`, method: 'POST', url: `${BASE}/${path}`, body })
      expect(res.status, path).toBe(200)
    }
    expect(h.calls.map((c) => c.url)).toEqual(SENT.map(([path]) => `${BASE}/${path}`))
    vi.stubEnv('NEXUS_GOOGLE_ADS_WRITES', 'off')
    const ok = await googleCall({ connectionId: 'g-1', operation: 'ads.account.check', method: 'POST', url: `${BASE}/${SENT[2][0]}`, body: { ...SENT[2][1], validateOnly: true } })
    expect(ok.status).toBe(200)
    const real = await googleCall({ connectionId: 'g-1', operation: 'ads.account', method: 'POST', url: `${BASE}/${SENT[2][0]}`, body: SENT[2][1] }).catch((e) => e)
    expect(real).toMatchObject({ outcome: 'gated', code: 'PUBLISH_GATED' })
  })

  it('every other body, customer or path is refused before anything is sent', async () => {
    const tries: Array<[string, unknown]> = [
      ['Goals:mutate', { operations: [{ create: { retentionGoalSettings: { valueSettings: { additionalValue: 5 } } } }] }],
      ['Goals:mutate', { operations: [{ create: { newCustomerAcquisitionGoalSettings: { valueSettings: { valueMultiplier: 2 } } } }] }],
      ['Goals:mutate', { operations: [{ update: { resourceName: 'customers/999/goals/81', newCustomerAcquisitionGoalSettings: { valueSettings: { additionalValue: 6 } } }, updateMask: 'new_customer_acquisition_goal_settings.value_settings.additional_value' }] }],
      ['Goals:mutate', { operations: [{ update: { resourceName: `${C}/goals/81`, newCustomerAcquisitionGoalSettings: { valueSettings: { additionalValue: 6 } } }, updateMask: 'goal_type' }] }],
      ['Goals:mutate', { operations: [{ remove: `${C}/goals/81` }] }],
      ['Goals:mutate', { operations: [{ create: { newCustomerAcquisitionGoalSettings: { valueSettings: { additionalValue: 5 } } } }, { create: { newCustomerAcquisitionGoalSettings: { valueSettings: { additionalValue: 6 } } } }] }],
      ['Goals:mutate', { operations: [{ create: { newCustomerAcquisitionGoalSettings: { valueSettings: { additionalValue: -1 } } } }] }],
      ['CampaignGoalConfigs:mutate', { operations: [{ create: { campaign: 'customers/999/campaigns/21', goal: `${C}/goals/81`, campaignNewCustomerAcquisitionSettings: { targetOption: 'TARGET_ALL' } } }] }],
      ['CampaignGoalConfigs:mutate', { operations: [{ create: { campaign: `${C}/campaigns/21`, goal: `${C}/goals/81`, campaignRetentionSettings: { targetOption: 'TARGET_ALL' } } }] }],
      ['CampaignGoalConfigs:mutate', { operations: [{ create: { campaign: `${C}/campaigns/21`, goal: `${C}/goals/81`, campaignNewCustomerAcquisitionSettings: { targetOption: 'TARGET_NONE' } } }] }],
      ['CampaignGoalConfigs:mutate', { operations: [{ update: { resourceName: `${C}/campaignGoalConfigs/21~81`, campaignNewCustomerAcquisitionSettings: { targetOption: 'TARGET_ALL' } }, updateMask: 'goal' }] }],
      ['CampaignGoalConfigs:mutate', { operations: [{ remove: 'customers/999/campaignGoalConfigs/21~81' }] }],
      ['CampaignGoalConfigs:mutate', { operations: [{ remove: `${C}/campaignGoalConfigs/21~81` }], partialFailure: true }],
      ['goals:mutate', SENT[0][1]],
    ]
    for (const [path, body] of tries) {
      const err = await googleCall({ connectionId: 'g-1', operation: 'ads.account', method: 'POST', url: `${BASE}/${path}`, body }).catch((e) => e)
      expect(err, `${path} ${JSON.stringify(body)}`).toMatchObject({ outcome: 'refused', code: 'GOOGLE_READ_ONLY' })
    }
    expect(h.calls).toHaveLength(0)
  })

  it('an account the business did not choose through this connection is refused', async () => {
    gatewayGoogleUnlinked.add('g-1:1234567890')
    const err = await googleCall({ connectionId: 'g-1', operation: 'ads.account', method: 'POST', url: `${BASE}/${SENT[0][0]}`, body: SENT[0][1] }).catch((e) => e)
    expect(err).toMatchObject({ outcome: 'refused', code: 'GOOGLE_ACCOUNT_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(0)
  })
})
