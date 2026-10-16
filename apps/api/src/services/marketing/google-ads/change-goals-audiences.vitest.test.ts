/**
 * Google Ads programme 2, G14a — the pure builders of custom conversion goals, a campaign's custom goal, custom segments,
 * user lists and reusable audiences, and the live mappers they stand on: operations as Google's v25 JSON takes them,
 * SPENDS MONEY where a serving campaign would reach more people or Smart Bidding would chase more, refusals in words.
 * Ids, names and values are made up.
 */
import { describe, expect, it } from 'vitest'
import { customGoalDraft, customGoalRecordAfterRun, type CustomGoalLive } from './change-custom-goals.js'
import { campaignChasedActions, goalChangeDraft, type BiddingContext } from './change-conversions.js'
import { customAudienceDraft, customAudienceRecordAfterRun } from './change-custom-audiences.js'
import { definitionFrom, reusableAudienceDraft, widenReasons, type ReusableAudienceLive } from './change-reusable-audiences.js'
import { userListDraft, type UserListLive } from './change-user-lists.js'
import {
  customAudienceOf, customGoalOf, definitionJson, definitionOf, reusableAudienceOf, userListOf, usesOf,
  type AudienceUse, type LiveReusableAudience, type LiveUserList,
} from './live-goals-audiences.js'
import type { LiveConversionAction } from './live-account.js'

const C = 'customers/1234567890'
const ACTION = (id: string, over: Partial<LiveConversionAction> = {}): LiveConversionAction => ({
  conversionActionId: id, name: `Action ${id}`, status: 'ENABLED', type: 'WEBPAGE', category: 'PURCHASE', origin: 'WEBSITE', primary: true, includeInConversions: true,
  counting: 'MANY_PER_CLICK', clickWindowDays: 30, viewWindowDays: 1, defaultValueCents: null, defaultValueCurrency: null, alwaysUseDefaultValue: false,
  attribution: null, dataDrivenStatus: null, ownerCustomerId: '1234567890', ga4: null, ...over,
})
const CAMPAIGN = { campaignId: '21', name: 'Shop A', status: 'ENABLED', bidding: 'MAXIMIZE_CONVERSIONS' }
const USE = (over: Partial<AudienceUse>): AudienceUse => ({
  kind: 'USER_LIST', id: '51', campaignId: '21', campaignName: 'Shop A', campaignStatus: 'ENABLED', channel: 'SEARCH', level: 'campaign', levelStatus: null, status: 'ENABLED', negative: false, ...over,
})

describe('custom conversion goals', () => {
  const live = (over: Partial<CustomGoalLive> = {}): CustomGoalLive => ({
    customerId: '1234567890',
    conversionCustomerId: '1234567890',
    goals: [{ customGoalId: '31', name: 'Goal A', status: 'ENABLED', conversionActionIds: ['71'] }],
    actions: [ACTION('71'), ACTION('72', { primary: false, category: 'ADD_TO_CART' })],
    campaignGoals: [{ campaignId: '21', name: 'Shop A', status: 'ENABLED', goalsFrom: 'CAMPAIGN', customGoalId: '31', biddableGoals: ['PURCHASE/WEBSITE'], differsFromAccount: true }],
    campaigns: [CAMPAIGN],
    ...over,
  })

  it('a new goal: one create, nothing spends (no campaign uses it yet)', () => {
    const d = customGoalDraft(C, { create: [{ name: 'Goal B', conversionActionIds: ['72', '71'] }] }, live())
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{ customConversionGoalOperation: { create: { name: 'Goal B', conversionActions: [`${C}/conversionActions/71`, `${C}/conversionActions/72`], status: 'ENABLED' } } }])
    expect(d.spendsMoney).toEqual([])
    expect(customGoalRecordAfterRun(d.after as never, [{ customConversionGoalResult: { resourceName: `${C}/customConversionGoals/33` } }]).created[0].customGoalId).toBe('33')
  })

  it('more actions in a goal an enabled Smart Bidding campaign uses: SPENDS MONEY, naming it; the list is written whole', () => {
    const d = customGoalDraft(C, { change: [{ customGoalId: '31', conversionActionIds: ['71', '72'] }] }, live())
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{ customConversionGoalOperation: { update: { resourceName: `${C}/customConversionGoals/31`, conversionActions: [`${C}/conversionActions/71`, `${C}/conversionActions/72`] }, updateMask: 'conversion_actions' } }])
    expect(d.spendsMoney[0]).toMatch(/"Shop A"/)
    expect(d.before).toEqual({ goals: [{ customGoalId: '31', conversionActionIds: ['71'] }], created: [], removed: [] })
  })

  it('refuses another account\'s conversions, an unknown action, and warns on a removal used by a campaign', () => {
    expect(customGoalDraft(C, { create: [{ name: 'G', conversionActionIds: ['71'] }] }, live({ conversionCustomerId: '999' }))).toMatchObject({ refusal: expect.stringMatching(/cross-account/) })
    expect(customGoalDraft(C, { create: [{ name: 'G', conversionActionIds: ['79'] }] }, live())).toMatchObject({ refusal: expect.stringMatching(/79/) })
    const d = customGoalDraft(C, { remove: ['31'] }, live())
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{ customConversionGoalOperation: { remove: `${C}/customConversionGoals/31` } }])
    expect(d.warnings.join(' ')).toMatch(/"Shop A"/)
  })
})

describe('a campaign\'s custom goal (set-google-conversion-goals customGoals)', () => {
  const bidding: BiddingContext = {
    campaigns: [CAMPAIGN],
    goals: {
      accountGoals: [{ goal: 'PURCHASE/WEBSITE', category: 'PURCHASE', origin: 'WEBSITE', biddable: true }],
      campaigns: [{ campaignId: '21', name: 'Shop A', status: 'ENABLED', goalsFrom: 'CUSTOMER', customGoalId: null, biddableGoals: ['PURCHASE/WEBSITE'], differsFromAccount: false }],
    },
  }
  const customGoals = [{ customGoalId: '31', name: 'Goal A', status: 'ENABLED', conversionActionIds: ['71', '72'] }]
  const actions = [ACTION('71'), ACTION('72', { primary: false, category: 'ADD_TO_CART' })]

  it('setting one: the config with custom_conversion_goal; actions it adds are SPENDS MONEY; undo has what it used', () => {
    expect([...campaignChasedActions('21', { goals: bidding.goals, actions, customGoals })]).toEqual(['71'])
    const d = goalChangeDraft(C, { customGoals: [{ campaignId: '21', customGoalId: '31' }] }, { bidding, customGoals, actions })
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{ conversionGoalCampaignConfigOperation: { update: { resourceName: `${C}/conversionGoalCampaignConfigs/21`, customConversionGoal: `${C}/customConversionGoals/31` }, updateMask: 'custom_conversion_goal' } }])
    expect(d.spendsMoney).toHaveLength(1)
    expect(d.spendsMoney[0]).toMatch(/1 more conversion action .*"Action 72"/)
    expect(d.before).toMatchObject({ levels: [{ campaignId: '21', goalsFrom: 'CUSTOMER', customGoalId: null }] })
    expect(d.after).toMatchObject({ levels: [{ campaignId: '21', goalsFrom: 'CAMPAIGN', customGoalId: '31' }] })
  })

  it('clearing one: the mask with no value, a warning for what bidding stops counting; with useAccountGoals for the same campaign: refused', () => {
    const own = { ...bidding, goals: { ...bidding.goals, campaigns: [{ ...bidding.goals.campaigns[0], goalsFrom: 'CAMPAIGN', customGoalId: '31' }] } }
    const d = goalChangeDraft(C, { customGoals: [{ campaignId: '21', customGoalId: null }] }, { bidding: own, customGoals, actions })
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{ conversionGoalCampaignConfigOperation: { update: { resourceName: `${C}/conversionGoalCampaignConfigs/21` }, updateMask: 'custom_conversion_goal' } }])
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings.join(' ')).toMatch(/stops bidding for "Action 72"/)
    expect(goalChangeDraft(C, { customGoals: [{ campaignId: '21', customGoalId: null }], useAccountGoals: ['21'] }, { bidding: own, customGoals, actions })).toMatchObject({ refusal: expect.stringMatching(/one or the other/i) })
    // Back to the account's goals: the custom goal it used is recorded for undo.
    const back = goalChangeDraft(C, { useAccountGoals: ['21'] }, { bidding: own })
    if ('refusal' in back) throw new Error(back.refusal)
    expect(back.before).toMatchObject({ levels: [{ campaignId: '21', goalsFrom: 'CAMPAIGN', customGoalId: '31' }] })
  })
})

describe('custom segments', () => {
  const AUD = { customAudienceId: '41', name: 'Riders', description: null, type: 'AUTO', members: [{ type: 'KEYWORD' as const, value: 'moto jacket' }] }

  it('a new one: ONE CustomAudienceService call; members once each', () => {
    const d = customAudienceDraft(C, { create: [{ name: 'Tourers', members: [{ type: 'KEYWORD', value: 'touring boots' }, { type: 'KEYWORD', value: 'Touring boots' }, { type: 'URL', value: 'https://example.com/touring' }] }] }, { customAudiences: [AUD] })
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{ accountCall: { path: 'customAudiences:mutate', body: { operations: [{ create: { name: 'Tourers', type: 'AUTO', members: [{ memberType: 'KEYWORD', keyword: 'touring boots' }, { memberType: 'URL', url: 'https://example.com/touring' }] } }] } } }])
    expect(customAudienceRecordAfterRun(d.after as never, [{ accountResult: { resourceName: `${C}/customAudiences/43` } }]).created[0].customAudienceId).toBe('43')
  })

  it('new members where a serving campaign uses it: SPENDS MONEY; paused only: a warning; in use: no removal', () => {
    const ask = { change: [{ customAudienceId: '41', addMembers: [{ type: 'APP' as const, value: 'com.example.ride' }] }] }
    const d = customAudienceDraft(C, ask, { customAudiences: [AUD], uses: [USE({ kind: 'CUSTOM_AUDIENCE', id: '41', channel: 'DISPLAY' })], audiences: [] })
    if ('refusal' in d) throw new Error(d.refusal)
    const body = (d.operations[0] as { accountCall: { body: { operations: unknown[] } } }).accountCall.body
    expect(body.operations).toEqual([{ update: { resourceName: `${C}/customAudiences/41`, members: [{ memberType: 'APP', app: 'com.example.ride' }, { memberType: 'KEYWORD', keyword: 'moto jacket' }] }, updateMask: 'members' }])
    expect(d.spendsMoney[0]).toMatch(/"Shop A"/)
    const paused = customAudienceDraft(C, ask, { customAudiences: [AUD], uses: [USE({ kind: 'CUSTOM_AUDIENCE', id: '41', campaignStatus: 'PAUSED' })], audiences: [] })
    expect(paused).toMatchObject({ spendsMoney: [], warnings: expect.arrayContaining([expect.stringMatching(/paused/)]) })
    expect(customAudienceDraft(C, { remove: ['41'] }, { customAudiences: [AUD], uses: [USE({ kind: 'CUSTOM_AUDIENCE', id: '41' })], audiences: [] })).toMatchObject({ refusal: expect.stringMatching(/CANNOT_REMOVE_WHILE_IN_USE/) })
    expect(customAudienceDraft(C, { create: [{ name: 'X', members: [{ type: 'URL', value: 'example.com' }] }] }, { customAudiences: [] })).toMatchObject({ refusal: expect.stringMatching(/https/) })
    expect(customAudienceDraft(C, { create: [{ name: 'riders', members: [{ type: 'KEYWORD', value: 'x' }] }] }, { customAudiences: [AUD] })).toMatchObject({ refusal: expect.stringMatching(/ignoring case/) })
  })
})

describe('reusable audiences', () => {
  const A: LiveReusableAudience = {
    audienceId: '61', name: 'Riders 25+', description: null, scope: 'CUSTOMER', assetGroupId: null,
    definition: { segments: [{ kind: 'USER_LIST', id: '51' }], ages: { ranges: [{ min: 25, max: 34 }], includeUndetermined: false }, genders: { values: ['MALE'], includeUndetermined: false }, incomes: null, parental: null, excludeUserLists: [], other: [] },
  }
  const live = (over: Partial<ReusableAudienceLive> = {}): ReusableAudienceLive => ({
    audiences: [A], uses: [], segmentNames: { 'USER_LIST|51': 'Visitors', 'USER_LIST|52': 'Buyers', 'USER_INTEREST|80101': 'Motorcycles', 'DETAILED_DEMOGRAPHIC|90': 'Homeowners' }, ...over,
  })

  it('a new one: the dimensions and exclusion as Google takes them', () => {
    const d = reusableAudienceDraft(C, { create: [{ name: 'Fans', segments: [{ kind: 'USER_INTEREST', id: '80101' }, { kind: 'DETAILED_DEMOGRAPHIC', id: '90' }], ages: { ranges: [{ min: 18, max: 24 }, { min: 65, max: null }] }, excludeUserLists: ['52'] }] }, live())
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{ audienceOperation: { create: {
      name: 'Fans',
      dimensions: [
        { audienceSegments: { segments: [{ detailedDemographic: { detailedDemographic: `${C}/detailedDemographics/90` } }, { userInterest: { userInterestCategory: `${C}/userInterests/80101` } }] } },
        { age: { ageRanges: [{ minAge: 18, maxAge: 24 }, { minAge: 65 }], includeUndetermined: false } },
      ],
      exclusionDimension: { exclusions: [{ userList: { userList: `${C}/userLists/52` } }] },
    } } }])
    expect(d.warnings.join(' ')).toMatch(/no way to remove/)
  })

  it('a change that widens one a serving Demand Gen ad group targets: SPENDS MONEY; Google\'s rules refused in words', () => {
    const uses = [USE({ kind: 'AUDIENCE', id: '61', level: 'ad-group', levelStatus: 'ENABLED', channel: 'DEMAND_GEN' })]
    const d = reusableAudienceDraft(C, { change: [{ audienceId: '61', genders: null }] }, live({ uses }))
    if ('refusal' in d) throw new Error(d.refusal)
    expect((d.operations[0] as { audienceOperation: { updateMask: string } }).audienceOperation.updateMask).toBe('dimensions')
    expect(d.spendsMoney[0]).toMatch(/drops its gender dimension/)
    const narrower = reusableAudienceDraft(C, { change: [{ audienceId: '61', ages: { ranges: [{ min: 25, max: 34 }] }, genders: { values: ['MALE'] }, segments: [{ kind: 'USER_LIST', id: '51' }] , excludeUserLists: ['52'] }] }, live({ uses }))
    expect(narrower).toMatchObject({ spendsMoney: [] })
    expect(reusableAudienceDraft(C, { create: [{ name: 'X', ages: { ranges: [{ min: 20, max: 30 }] } }] }, live())).toMatchObject({ refusal: expect.stringMatching(/18, 25, 35/) })
    expect(reusableAudienceDraft(C, { create: [{ name: 'X', segments: [{ kind: 'USER_LIST', id: '59' }] }] }, live())).toMatchObject({ refusal: expect.stringMatching(/59/) })
    expect(reusableAudienceDraft(C, { create: [{ name: 'riders 25+', genders: { values: ['FEMALE'] } }] }, live())).toMatchObject({ refusal: expect.stringMatching(/unique/) })
  })

  it('widenReasons: added ages, lifted exclusions', () => {
    const d = definitionFrom({ ages: { ranges: [{ min: 25, max: 44 }] }, excludeUserLists: [] }, { ...A.definition, excludeUserLists: ['52'] })
    if ('problem' in d) throw new Error(d.problem)
    expect(widenReasons({ ...A.definition, excludeUserLists: ['52'] }, d)).toEqual(['takes in more ages', 'no longer leaves out 1 user list'])
  })
})

describe('user lists', () => {
  const OWN = (over: Partial<LiveUserList>): LiveUserList => ({
    userListId: '51', name: 'Visitors', description: null, type: 'RULE_BASED', membershipStatus: 'OPEN', membershipDays: null, readOnly: false, accessReason: 'OWNED',
    eligibleForSearch: true, eligibleForDisplay: true, sizeForSearch: null, sizeForDisplay: null,
    visitors: { operator: 'AND', include: [{ anyOf: [{ allOf: [{ parameter: 'url__', operator: 'CONTAINS', text: '/jackets' }] }], lookbackDays: 30 }], exclude: [] },
    prepopulation: null, combination: null, actions: null, lookalike: null, ...over,
  })
  const live = (over: Partial<UserListLive> = {}): UserListLive => ({
    lists: [OWN({}), OWN({ userListId: '52', name: 'Combo', type: 'LOGICAL', visitors: null, combination: [{ operator: 'ANY', userListIds: ['51'] }] }), OWN({ userListId: '53', name: 'Shared', accessReason: 'SHARED', readOnly: true })],
    actions: [ACTION('71')], uses: [], audiences: [], ...over,
  })

  it('a new visitors list: the flexible rule as Google takes it', () => {
    const d = userListDraft(C, { create: [{ name: 'Checkout', prepopulate: true, visitors: { include: [{ anyOf: [{ allOf: [{ operator: 'CONTAINS', text: '/checkout' }] }], lookbackDays: 14 }], exclude: [{ anyOf: [{ allOf: [{ operator: 'CONTAINS', text: '/thank-you' }] }] }] } }] }, live())
    if ('refusal' in d) throw new Error(d.refusal)
    expect(d.operations).toEqual([{ userListOperation: { create: {
      name: 'Checkout', membershipStatus: 'OPEN',
      ruleBasedUserList: { prepopulationStatus: 'REQUESTED', flexibleRuleUserList: {
        inclusiveRuleOperator: 'AND',
        inclusiveOperands: [{ rule: { ruleItemGroups: [{ ruleItems: [{ name: 'url__', stringRuleItem: { operator: 'CONTAINS', value: '/checkout' } }] }] }, lookbackWindowDays: '14' }],
        exclusiveOperands: [{ rule: { ruleItemGroups: [{ ruleItems: [{ name: 'url__', stringRuleItem: { operator: 'CONTAINS', value: '/thank-you' } }] }] } }],
      } },
    } } }])
    expect(d.spendsMoney).toEqual([])
  })

  it('refuses Google\'s own rules in words: two kinds, a combination of a combination, a shared list, a life span on a rule list', () => {
    expect(userListDraft(C, { create: [{ name: 'X', converters: { conversionActionIds: ['71'] }, combination: [{ operator: 'ANY', userListIds: ['51'] }] }] }, live())).toMatchObject({ refusal: expect.stringMatching(/exactly ONE/) })
    expect(userListDraft(C, { create: [{ name: 'X', combination: [{ operator: 'ALL', userListIds: ['52'] }] }] }, live())).toMatchObject({ refusal: expect.stringMatching(/CAN_NOT_ADD_LOGICAL_LIST/) })
    expect(userListDraft(C, { change: [{ userListId: '53', name: 'Y' }] }, live())).toMatchObject({ refusal: expect.stringMatching(/not this account's own/) })
    expect(userListDraft(C, { change: [{ userListId: '51', membershipDays: 30 }] }, live())).toMatchObject({ refusal: expect.stringMatching(/ignores the membership life span/) })
    expect(userListDraft(C, { create: [{ name: 'X', visitors: { include: [{ anyOf: [{ allOf: [{ operator: 'CONTAINS', text: '/a b' }] }] }] } }] }, live())).toMatchObject({ refusal: expect.stringMatching(/space, quote/) })
  })

  it('open again where a serving campaign targets it, closed where one excludes it: SPENDS MONEY each', () => {
    const closed = live({ lists: [OWN({ membershipStatus: 'CLOSED' })], uses: [USE({})] })
    const open = userListDraft(C, { change: [{ userListId: '51', membershipStatus: 'OPEN' }] }, closed)
    if ('refusal' in open) throw new Error(open.refusal)
    expect(open.operations).toEqual([{ userListOperation: { update: { resourceName: `${C}/userLists/51`, membershipStatus: 'OPEN' }, updateMask: 'membership_status' } }])
    expect(open.spendsMoney[0]).toMatch(/open again.*"Shop A"/)
    const excluded = userListDraft(C, { change: [{ userListId: '51', membershipStatus: 'CLOSED' }] }, live({ uses: [USE({ negative: true })] }))
    if ('refusal' in excluded) throw new Error(excluded.refusal)
    expect(excluded.spendsMoney[0]).toMatch(/an exclusion/)
    // Through a reusable audience a Demand Gen ad group targets.
    const viaAudience = live({
      lists: [OWN({ membershipStatus: 'CLOSED' })],
      uses: [USE({ kind: 'AUDIENCE', id: '61', level: 'ad-group', levelStatus: 'ENABLED' })],
      audiences: [{ audienceId: '61', name: 'A', description: null, scope: 'CUSTOMER', assetGroupId: null, definition: { segments: [{ kind: 'USER_LIST', id: '51' }], ages: null, genders: null, incomes: null, parental: null, excludeUserLists: [], other: [] } }],
    })
    const d = userListDraft(C, { change: [{ userListId: '51', membershipStatus: 'OPEN' }] }, viaAudience)
    expect(d).toMatchObject({ spendsMoney: [expect.stringMatching(/"Shop A"/)] })
  })
})

describe('live mappers', () => {
  it('reads what Google sends: goals, segments with members, audiences (definition round trip), user lists, uses', () => {
    expect(customGoalOf({ customConversionGoal: { id: '31', name: 'Goal A', status: 'ENABLED', conversionActions: [`${C}/conversionActions/72`, `${C}/conversionActions/71`] } }))
      .toEqual({ customGoalId: '31', name: 'Goal A', status: 'ENABLED', conversionActionIds: ['71', '72'] })
    expect(customAudienceOf({ customAudience: { id: '41', name: 'S', type: 'AUTO', status: 'ENABLED', members: [{ memberType: 'KEYWORD', keyword: 'k' }, { memberType: 'PLACE_CATEGORY', placeCategory: '123' }] } }).members)
      .toEqual([{ type: 'KEYWORD', value: 'k' }, { type: 'PLACE_CATEGORY', value: '123' }])
    const dims = [
      { audienceSegments: { segments: [{ userList: { userList: `${C}/userLists/51` } }, { lifeEvent: { lifeEvent: `${C}/lifeEvents/7` } }] } },
      { gender: { genders: ['FEMALE'], includeUndetermined: true } },
      { householdIncome: { incomeRanges: ['INCOME_RANGE_90_UP'] } },
    ]
    const a = reusableAudienceOf({ audience: { id: '61', name: 'A', status: 'ENABLED', scope: 'CUSTOMER', dimensions: dims, exclusionDimension: { exclusions: [{ userList: { userList: `${C}/userLists/52` } }] } } })
    expect(a.definition).toMatchObject({ segments: [{ kind: 'LIFE_EVENT', id: '7' }, { kind: 'USER_LIST', id: '51' }], genders: { values: ['FEMALE'], includeUndetermined: true }, excludeUserLists: ['52'] })
    expect(definitionOf(definitionJson(C, a.definition).dimensions, definitionJson(C, a.definition).exclusionDimension)).toEqual(a.definition)
    const u = userListOf({ userList: { id: '51', name: 'V', type: 'RULE_BASED', readOnly: false, accessReason: 'OWNED', membershipStatus: 'OPEN', ruleBasedUserList: { flexibleRuleUserList: { inclusiveRuleOperator: 'OR', inclusiveOperands: [{ rule: { ruleItemGroups: [{ ruleItems: [{ name: 'ecomm_totalvalue', numberRuleItem: { operator: 'GREATER_THAN', value: 100 } }] }] }, lookbackWindowDays: '30' }] } } } })
    expect(u.visitors).toEqual({ operator: 'OR', include: [{ anyOf: [{ allOf: [{ parameter: 'ecomm_totalvalue', operator: 'GREATER_THAN', number: 100 }] }], lookbackDays: 30 }], exclude: [] })
    expect(usesOf({
      campaign: [{ campaign: { id: '21', name: 'Shop A', status: 'ENABLED', advertisingChannelType: 'SEARCH' }, campaignCriterion: { negative: true, status: 'ENABLED', userList: { userList: `${C}/userLists/51` } } }],
      adGroup: [{ campaign: { id: '22', name: 'DG', status: 'PAUSED' }, adGroup: { id: '81', status: 'ENABLED' }, adGroupCriterion: { status: 'ENABLED', audience: { audience: `${C}/audiences/61` } } }],
      signal: [{ campaign: { id: '23', name: 'PM', status: 'ENABLED' }, assetGroup: { id: '91', status: 'ENABLED' }, assetGroupSignal: { searchTheme: { text: 'x' } } }],
    })).toEqual([
      { kind: 'USER_LIST', id: '51', campaignId: '21', campaignName: 'Shop A', campaignStatus: 'ENABLED', channel: 'SEARCH', level: 'campaign', levelStatus: null, status: 'ENABLED', negative: true },
      { kind: 'AUDIENCE', id: '61', campaignId: '22', campaignName: 'DG', campaignStatus: 'PAUSED', channel: null, level: 'ad-group', levelStatus: 'ENABLED', status: 'ENABLED', negative: false },
    ])
  })
})
