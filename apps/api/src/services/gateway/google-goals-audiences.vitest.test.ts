/**
 * Google Ads programme 2, G14a — custom conversion goals and new audiences on the gateway: the custom goal, user list and
 * audience operations of GoogleAdsService.Mutate (only what the tools send: never a Customer Match list, never an
 * audience removed), and CustomAudienceService's own path (exactly the bodies set-google-custom-audiences sends;
 * validate_only a check). Everything else stays refused. Ids are made up.
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
const CUSTOM = `${BASE}/customAudiences:mutate`

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

const VISITORS = { inclusiveRuleOperator: 'AND', inclusiveOperands: [{ rule: { ruleItemGroups: [{ ruleItems: [{ name: 'url__', stringRuleItem: { operator: 'CONTAINS', value: '/jackets' } }] }] }, lookbackWindowDays: '30' }] }

/** What the G14a mutate tools send (change-custom-goals.ts, change-user-lists.ts, change-reusable-audiences.ts, change-conversions.ts). */
const SENT = [
  { customConversionGoalOperation: { create: { name: 'Goal Z', conversionActions: [`${C}/conversionActions/71`], status: 'ENABLED' } } },
  { customConversionGoalOperation: { update: { resourceName: `${C}/customConversionGoals/31`, conversionActions: [`${C}/conversionActions/72`] }, updateMask: 'conversion_actions' } },
  { customConversionGoalOperation: { remove: `${C}/customConversionGoals/32` } },
  { conversionGoalCampaignConfigOperation: { update: { resourceName: `${C}/conversionGoalCampaignConfigs/21`, customConversionGoal: `${C}/customConversionGoals/31` }, updateMask: 'custom_conversion_goal' } },
  { userListOperation: { create: { name: 'Visitors Z', membershipStatus: 'OPEN', ruleBasedUserList: { prepopulationStatus: 'REQUESTED', flexibleRuleUserList: VISITORS } } } },
  { userListOperation: { create: { name: 'Combo Z', membershipStatus: 'OPEN', logicalUserList: { rules: [{ operator: 'ANY', ruleOperands: [{ userList: `${C}/userLists/51` }] }] } } } },
  { userListOperation: { create: { name: 'Buyers Z', membershipStatus: 'OPEN', membershipLifeSpan: '90', basicUserList: { actions: [{ conversionAction: `${C}/conversionActions/71` }] } } } },
  { userListOperation: { create: { name: 'Look Z', lookalikeUserList: { seedUserListIds: ['51'], expansionLevel: 'NARROW', countryCodes: ['IT'] } } } },
  { userListOperation: { update: { resourceName: `${C}/userLists/51`, membershipStatus: 'CLOSED', ruleBasedUserList: { flexibleRuleUserList: VISITORS } }, updateMask: 'membership_status,rule_based_user_list.flexible_rule_user_list' } },
  { userListOperation: { remove: `${C}/userLists/53` } },
  { audienceOperation: { create: { name: 'Audience Z', dimensions: [{ gender: { genders: ['MALE'], includeUndetermined: false } }] } } },
  { audienceOperation: { update: { resourceName: `${C}/audiences/61`, name: 'Audience Y' }, updateMask: 'name' } },
]

describe('G14a mutate kinds', () => {
  it('every operation the tools send goes: its check as a read, then the change once', async () => {
    expect(googleKind('POST', MUTATE, { mutateOperations: SENT, validateOnly: true })).toBe('read')
    expect(googleKind('POST', MUTATE, { mutateOperations: SENT })).toBe('write')
    await googleCall({ connectionId: 'g-1', operation: 'ads.mutate', method: 'POST', url: MUTATE, body: { mutateOperations: SENT, validateOnly: true } })
    await googleCall({ connectionId: 'g-1', operation: 'ads.mutate', method: 'POST', url: MUTATE, body: { mutateOperations: SENT } })
    expect(h.calls).toHaveLength(2)
    expect(JSON.parse(String(h.calls[1].init.body))).toEqual({ mutateOperations: SENT })
  })

  it('never a Customer Match list, a list of another account, a lookalike changed or an audience removed', async () => {
    const bad = [
      { userListOperation: { create: { name: 'CRM', crmBasedUserList: { uploadKeyType: 'CONTACT_INFO' } } } },
      { userListOperation: { create: { name: 'Two', ruleBasedUserList: { flexibleRuleUserList: VISITORS }, logicalUserList: { rules: [] } } } },
      { userListOperation: { create: { name: 'None' } } },
      { userListOperation: { update: { resourceName: `${C}/userLists/51`, crmBasedUserList: {} }, updateMask: 'crm_based_user_list' } },
      { userListOperation: { update: { resourceName: `${C}/userLists/51`, integrationCode: 'x' }, updateMask: 'integration_code' } },
      { userListOperation: { update: { resourceName: `${C}/userLists/51`, lookalikeUserList: { expansionLevel: 'BROAD' } }, updateMask: 'lookalike_user_list.expansion_level' } },
      { userListOperation: { update: { resourceName: 'customers/999/userLists/51', name: 'X' }, updateMask: 'name' } },
      { userListOperation: { remove: 'customers/999/userLists/51' } },
      { audienceOperation: { remove: `${C}/audiences/61` } },
    ]
    for (const op of bad) {
      expect(googleMutateBodyOf(JSON.stringify({ mutateOperations: [op] }), '1234567890'), JSON.stringify(op)).toHaveProperty('refusal')
      const err = await googleCall({ connectionId: 'g-1', operation: 'ads.mutate', method: 'POST', url: MUTATE, body: { mutateOperations: [op], validateOnly: true } }).catch((e) => e)
      expect(err, JSON.stringify(op)).toMatchObject({ outcome: 'refused', code: 'GOOGLE_READ_ONLY' })
    }
    expect(h.calls).toHaveLength(0)
  })
})

const MEMBERS = [{ memberType: 'KEYWORD', keyword: 'moto jacket' }, { memberType: 'URL', url: 'https://example.com/jackets' }, { memberType: 'APP', app: 'com.example.app' }]
/** What set-google-custom-audiences sends (change-custom-audiences.ts): one call, its operations. */
const CUSTOM_BODY = {
  operations: [
    { create: { name: 'Segment Z', description: 'riders', type: 'AUTO', members: MEMBERS } },
    { update: { resourceName: `${C}/customAudiences/41`, name: 'Segment Y', members: [...MEMBERS, { memberType: 'PLACE_CATEGORY', placeCategory: '123' }] }, updateMask: 'name,members' },
    { remove: `${C}/customAudiences/42` },
  ],
}

describe('G14a CustomAudienceService', () => {
  it('the body the tool sends goes once as a write, and its validate_only check as a read', async () => {
    expect(googleKind('POST', CUSTOM, CUSTOM_BODY)).toBe('write')
    expect(googleKind('POST', CUSTOM, { ...CUSTOM_BODY, validateOnly: true })).toBe('read')
    await googleCall({ connectionId: 'g-1', operation: 'ads.account.customAudiences.check', method: 'POST', url: CUSTOM, body: { ...CUSTOM_BODY, validateOnly: true } })
    const res = await googleCall({ connectionId: 'g-1', operation: 'ads.account.customAudiences.mutate', method: 'POST', url: CUSTOM, body: CUSTOM_BODY })
    expect(res.status).toBe(200)
    expect(h.calls.map((c) => c.url)).toEqual([CUSTOM, CUSTOM])
    expect(JSON.parse(String(h.calls[1].init.body))).toEqual(CUSTOM_BODY)
  })

  it('every other body, customer or path is refused before anything is sent', async () => {
    const tries: Array<[string, unknown]> = [
      [CUSTOM, { operations: [{ create: { name: 'S', type: 'INTEREST', members: MEMBERS } }] }],
      [CUSTOM, { operations: [{ create: { name: 'S', type: 'AUTO', status: 'ENABLED', members: MEMBERS } }] }],
      [CUSTOM, { operations: [{ create: { name: 'S', type: 'AUTO', members: [] } }] }],
      [CUSTOM, { operations: [{ create: { name: 'S', members: [{ memberType: 'KEYWORD', url: 'https://example.com' }] } }] }],
      [CUSTOM, { operations: [{ update: { resourceName: 'customers/999/customAudiences/41', name: 'X' }, updateMask: 'name' }] }],
      [CUSTOM, { operations: [{ update: { resourceName: `${C}/customAudiences/41`, status: 'REMOVED' }, updateMask: 'status' }] }],
      [CUSTOM, { operations: [{ remove: 'customers/999/customAudiences/42' }] }],
      [CUSTOM, { operations: [{ remove: `${C}/customAudiences/42` }], partialFailure: true }],
      [CUSTOM, { operations: [] }],
      [`${BASE}/customaudiences:mutate`, CUSTOM_BODY],
      [`${BASE}/combinedAudiences:mutate`, { operations: [{ create: { name: 'C' } }] }],
      [`${BASE}/offlineUserDataJobs:create`, { job: { type: 'CUSTOMER_MATCH_USER_LIST' } }],
    ]
    for (const [url, body] of tries) {
      const err = await googleCall({ connectionId: 'g-1', operation: 'ads.account', method: 'POST', url, body }).catch((e) => e)
      expect(err, `${url} ${JSON.stringify(body)}`).toMatchObject({ outcome: 'refused', code: 'GOOGLE_READ_ONLY' })
    }
    expect(h.calls).toHaveLength(0)
  })

  it('an account the business did not choose through this connection is refused', async () => {
    gatewayGoogleUnlinked.add('g-1:1234567890')
    const err = await googleCall({ connectionId: 'g-1', operation: 'ads.account', method: 'POST', url: CUSTOM, body: CUSTOM_BODY }).catch((e) => e)
    expect(err).toMatchObject({ outcome: 'refused', code: 'GOOGLE_ACCOUNT_NOT_CHOSEN' })
    expect(h.calls).toHaveLength(0)
  })
})
