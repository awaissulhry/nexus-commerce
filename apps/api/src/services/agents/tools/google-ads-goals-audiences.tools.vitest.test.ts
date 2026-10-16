/**
 * Google Ads programme 2, G14a (2026-10-16) — the custom goal and audience tools as the approval gate uses them (Google,
 * the account and the live reads are stand-ins): each preview is built on Google's own check (validate_only for a
 * mutate, CustomAudienceService's validateOnly for custom segments); the run is ONE request of an approved change, as a
 * person, never by a rule; undo asks for the opposite through a registered tool. Ids, names and values are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  check: vi.fn(),
  send: vi.fn(),
  enqueue: vi.fn(async () => ({ queued: true, reason: null })),
  live: {
    goals: [] as unknown[], customAudiences: [] as unknown[], audiences: [] as unknown[], lists: [] as unknown[], uses: [] as unknown[],
    actions: [] as unknown[], campaignGoals: [] as unknown[], accountGoals: [] as unknown[], campaigns: [] as unknown[],
  },
}))
vi.mock('../../marketing/google-ads/change-account.js', () => ({
  googleChangeAccount: vi.fn(async () => ({
    target: { connectionId: 'g-1', customerId: '1234567890', loginCustomerId: null }, accountId: 'g-1', customerId: '1234567890', name: 'Shop', currency: 'EUR', timeZone: 'Europe/Rome',
  })),
}))
vi.mock('../../marketing/google-ads/live-goals-audiences.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-goals-audiences.js')>()),
  liveCustomGoals: vi.fn(async () => structuredClone(h.live.goals)),
  liveCustomAudiences: vi.fn(async () => structuredClone(h.live.customAudiences)),
  liveReusableAudiences: vi.fn(async () => structuredClone(h.live.audiences)),
  liveUserLists: vi.fn(async () => structuredClone(h.live.lists)),
  liveAudienceUses: vi.fn(async () => structuredClone(h.live.uses)),
  liveDetailedDemographicNames: vi.fn(async (_t: unknown, ids: string[]) => Object.fromEntries(ids.filter((id) => id === '90').map((id) => [id, 'Homeowners']))),
}))
vi.mock('../../marketing/google-ads/live-account.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-account.js')>()),
  liveConversions: vi.fn(async () => ({ actions: structuredClone(h.live.actions), accountGoals: structuredClone(h.live.accountGoals), campaigns: structuredClone(h.live.campaignGoals), notRead: [] })),
  liveAccountSettings: vi.fn(async () => ({ conversionTracking: { conversionCustomerId: '1234567890', acceptedCustomerDataTerms: true } })),
}))
vi.mock('../../marketing/google-ads/live-conversions.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-conversions.js')>()),
  liveBiddingCampaigns: vi.fn(async () => structuredClone(h.live.campaigns)),
  liveConversionActions: vi.fn(async () => structuredClone(h.live.actions)),
}))
vi.mock('../../marketing/google-ads/live-targeting.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/live-targeting.js')>()),
  liveSegmentNames: vi.fn(async (_t: unknown, refs: Array<{ kind: string; id: string }>) =>
    Object.fromEntries(refs.filter((r) => ['51', '52', '80101'].includes(r.id)).map((r) => [`${r.kind}|${r.id}`, { name: `Segment ${r.id}`, status: 'OPEN' }]))),
}))
vi.mock('../../marketing/google-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/write-client.js')>()),
  mutateGoogleAds: h.mutate,
}))
vi.mock('../../marketing/google-ads/account-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/account-client.js')>()),
  checkAccountOperations: h.check,
  sendAccountOperations: h.send,
}))
vi.mock('../../marketing/google-ads/enqueue.js', () => ({ enqueueGoogleAdsSync: h.enqueue }))

import { GOOGLE_ADS_GOALS_AUDIENCES_TOOLS } from './google-ads-goals-audiences.tools.js'
import { GOOGLE_ADS_CONVERSIONS_TOOLS } from './google-ads-conversions.tools.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { listTools } from '../tool-registry.js'
import type { ToolContext } from '../tool-types.js'

const tool = (name: string) => [...GOOGLE_ADS_GOALS_AUDIENCES_TOOLS, ...GOOGLE_ADS_CONVERSIONS_TOOLS].find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const parses = (request: unknown) => {
  const r = request as { tool: string; args: unknown }
  return listTools().find((t) => t.name === r.tool)!.input.safeParse(r.args).success
}
const C = 'customers/1234567890'
const ACTION = {
  conversionActionId: '71', name: 'Purchase A', status: 'ENABLED', type: 'WEBPAGE', category: 'PURCHASE', origin: 'WEBSITE', primary: true, includeInConversions: true,
  counting: 'MANY_PER_CLICK', clickWindowDays: 30, viewWindowDays: 1, defaultValueCents: null, defaultValueCurrency: null, alwaysUseDefaultValue: false,
  attribution: null, dataDrivenStatus: null, ownerCustomerId: '1234567890', ga4: null,
}
const CART = { ...ACTION, conversionActionId: '72', name: 'Cart A', category: 'ADD_TO_CART', primary: false }
const VISITORS = { operator: 'AND', include: [{ anyOf: [{ allOf: [{ parameter: 'url__', operator: 'CONTAINS', text: '/jackets' }] }], lookbackDays: 30 }], exclude: [] }
const LIST = {
  userListId: '51', name: 'Visitors', description: null, type: 'RULE_BASED', membershipStatus: 'CLOSED', membershipDays: null, readOnly: false, accessReason: 'OWNED',
  eligibleForSearch: true, eligibleForDisplay: true, sizeForSearch: null, sizeForDisplay: null, visitors: VISITORS, prepopulation: null, combination: null, actions: null, lookalike: null,
}

beforeEach(() => {
  for (const f of [h.mutate, h.check, h.send]) f.mockReset()
  h.enqueue.mockClear()
  h.live.goals = [{ customGoalId: '31', name: 'Goal A', status: 'ENABLED', conversionActionIds: ['71'] }]
  h.live.customAudiences = [{ customAudienceId: '41', name: 'Riders', description: null, type: 'AUTO', members: [{ type: 'KEYWORD', value: 'moto jacket' }] }]
  h.live.audiences = []
  h.live.lists = [LIST]
  h.live.uses = []
  h.live.actions = [ACTION, CART]
  h.live.accountGoals = [{ goal: 'PURCHASE/WEBSITE', category: 'PURCHASE', origin: 'WEBSITE', biddable: true }]
  h.live.campaignGoals = [{ campaignId: '21', name: 'Shop A', status: 'ENABLED', goalsFrom: 'CUSTOMER', customGoalId: null, biddableGoals: ['PURCHASE/WEBSITE'], differsFromAccount: false }]
  h.live.campaigns = [{ campaignId: '21', name: 'Shop A', status: 'ENABLED', bidding: 'MAXIMIZE_CONVERSIONS' }]
})
afterEach(() => { vi.useRealTimers() })

describe('every G14a tool', () => {
  it('is a Nexus change a person approves: alwaysAsk, ask at most, reaches Google, its re-check fields declared, an undo', () => {
    expect(GOOGLE_ADS_GOALS_AUDIENCES_TOOLS.map((t) => t.name)).toEqual(['set-google-custom-goals', 'set-google-custom-audiences', 'set-google-user-lists', 'set-google-reusable-audiences'])
    for (const t of GOOGLE_ADS_GOALS_AUDIENCES_TOOLS) {
      expect(t).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', openWorld: true, readOnly: false, riskTier: 'high', requiresApprovalDefault: true, reversibility: 'partial' })
      expect(MATERIAL_PREVIEW_FIELDS[t.name]).toEqual(['basis', 'plan', 'reach'])
      expect(t.undo).toBeDefined()
      expect(listTools().some((r) => r.name === t.name)).toBe(true)
    }
  })

  it('a removal needs confirmRemove: refused before anything is read or sent', async () => {
    for (const name of ['set-google-custom-goals', 'set-google-custom-audiences', 'set-google-user-lists']) {
      const out = await tool(name).handler({ remove: ['31'] }, asker)
      expect(out.error, name).toMatch(/confirmRemove/)
    }
    expect(h.mutate).not.toHaveBeenCalled()
    expect(h.check).not.toHaveBeenCalled()
  })
})

describe('set-google-custom-goals', () => {
  it('preview on Google\'s check; more actions for a Smart Bidding campaign is SPENDS MONEY; ONE request; undo puts back and removes what it made', async () => {
    h.live.campaignGoals = [{ ...h.live.campaignGoals[0] as object, goalsFrom: 'CAMPAIGN', customGoalId: '31' }]
    h.mutate.mockResolvedValue({ responses: [], ops: 2, requestId: null })
    const ask = { create: [{ name: 'Goal B', conversionActionIds: ['72'] }], change: [{ customGoalId: '31', conversionActionIds: ['71', '72'] }] }
    const out = await tool('set-google-custom-goals').handler(ask, asker)
    expect(out.ok).toBe(true)
    expect(h.mutate.mock.calls[0][2]).toEqual({ validateOnly: true })
    expect(out.preview).toMatchObject({ spendsMoney: true, operations: 2 })
    h.mutate.mockReset()
    h.mutate.mockResolvedValue({ responses: [{ customConversionGoalResult: { resourceName: `${C}/customConversionGoals/32` } }, { customConversionGoalResult: { resourceName: `${C}/customConversionGoals/31` } }], ops: 2, requestId: 'r' })
    const run = await tool('set-google-custom-goals').execute!(ask, approved(out.preview))
    expect(run.ok).toBe(true)
    expect(h.mutate).toHaveBeenCalledTimes(1)
    expect(run.data).toMatchObject({ created: [{ customGoalId: '32', name: 'Goal B' }], changed: 1 })
    h.live.goals = [{ customGoalId: '31', name: 'Goal A', status: 'ENABLED', conversionActionIds: ['71', '72'] }, { customGoalId: '32', name: 'Goal B', status: 'ENABLED', conversionActionIds: ['72'] }]
    expect(await tool('set-google-custom-goals').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('set-google-custom-goals').undo!.request(run.change!)
    expect(undo).toEqual({ tool: 'set-google-custom-goals', args: { accountId: 'g-1', change: [{ customGoalId: '31', conversionActionIds: ['71'] }], remove: ['32'], confirmRemove: true, why: 'undo of an earlier custom goal change' } })
    expect(parses(undo)).toBe(true)
  })

  it('never by a rule', async () => {
    h.mutate.mockResolvedValue({ responses: [], ops: 1, requestId: null })
    const ask = { create: [{ name: 'Goal B', conversionActionIds: ['72'] }] }
    const preview = (await tool('set-google-custom-goals').handler(ask, asker)).preview
    h.mutate.mockClear()
    const byRule = await tool('set-google-custom-goals').execute!(ask, { ...approved(preview), approvedByPerson: false, decidedVia: 'auto' })
    expect(byRule.error).toMatch(/never by a rule/)
    expect(h.mutate).not.toHaveBeenCalled()
  })
})

describe('set-google-conversion-goals customGoals', () => {
  it('a campaign\'s custom goal: Google checks it, the actions it adds are SPENDS MONEY; undo puts the campaign back on the account\'s goals', async () => {
    h.live.goals = [{ customGoalId: '31', name: 'Goal A', status: 'ENABLED', conversionActionIds: ['71', '72'] }]
    h.mutate.mockResolvedValue({ responses: [{}], ops: 1, requestId: null })
    const ask = { customGoals: [{ campaignId: '21', customGoalId: '31' }] }
    const out = await tool('set-google-conversion-goals').handler(ask, asker)
    expect(out.preview).toMatchObject({ spendsMoney: true, operations: 1 })
    expect((out.preview as { spendsMoneyBecause: string[] }).spendsMoneyBecause[0]).toMatch(/"Cart A"/)
    const run = await tool('set-google-conversion-goals').execute!(ask, approved(out.preview))
    expect(run.ok).toBe(true)
    h.live.campaignGoals = [{ campaignId: '21', name: 'Shop A', status: 'ENABLED', goalsFrom: 'CAMPAIGN', customGoalId: '31', biddableGoals: ['PURCHASE/WEBSITE'], differsFromAccount: true }]
    expect(await tool('set-google-conversion-goals').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('set-google-conversion-goals').undo!.request(run.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo).toEqual({ tool: 'set-google-conversion-goals', args: { accountId: 'g-1', useAccountGoals: ['21'], why: 'undo of an earlier conversion goal change' } })
    expect(parses(undo)).toBe(true)
    // The undo takes the custom goal off in the same operation: it cannot come back when the campaign gets goals of its own.
    h.mutate.mockClear()
    const back = await tool('set-google-conversion-goals').handler(undo.args, asker)
    expect(back.ok).toBe(true)
    expect(h.mutate.mock.calls[0][1]).toEqual([{ conversionGoalCampaignConfigOperation: { update: { resourceName: `${C}/conversionGoalCampaignConfigs/21`, goalConfigLevel: 'CUSTOMER' }, updateMask: 'goal_config_level,custom_conversion_goal' } }])
    h.live.campaignGoals = [{ campaignId: '21', name: 'Shop A', status: 'ENABLED', goalsFrom: 'CUSTOMER', customGoalId: null, biddableGoals: ['PURCHASE/WEBSITE'], differsFromAccount: false }]
    expect(await tool('set-google-conversion-goals').undo!.current(run.change!)).not.toEqual(run.change!.after)
  })

  it('a campaign on its own goals that loses its custom goal gets it back on undo', () => {
    const change = {
      before: { account: [], campaigns: [], levels: [{ campaignId: '21', goalsFrom: 'CAMPAIGN', customGoalId: '31' }], accountId: 'g-1' },
      after: { account: [], campaigns: [], levels: [{ campaignId: '21', goalsFrom: 'CAMPAIGN', customGoalId: null }], accountId: 'g-1', customerId: '1234567890' },
    }
    const undo = tool('set-google-conversion-goals').undo!.request(change)
    expect(undo).toEqual({ tool: 'set-google-conversion-goals', args: { accountId: 'g-1', customGoals: [{ campaignId: '21', customGoalId: '31' }], why: 'undo of an earlier conversion goal change' } })
    expect(parses(undo)).toBe(true)
  })
})

describe('set-google-custom-audiences', () => {
  it('CustomAudienceService checks it (its validateOnly), ONE call runs it; undo puts members back and removes the new one', async () => {
    h.check.mockResolvedValue({ resourceName: null, review: null, resourceNames: [] })
    const ask = { create: [{ name: 'Tourers', members: [{ type: 'KEYWORD', value: 'touring boots' }] }], change: [{ customAudienceId: '41', addMembers: [{ type: 'URL', value: 'https://example.com/jackets' }] }] }
    const out = await tool('set-google-custom-audiences').handler(ask, asker)
    expect(out.ok).toBe(true)
    expect(h.check).toHaveBeenCalledTimes(1)
    expect(h.check.mock.calls[0][1]).toEqual([{ accountCall: { path: 'customAudiences:mutate', body: { operations: expect.any(Array) } } }])
    expect(out.preview).toMatchObject({ spendsMoney: false, operations: 1 })
    h.send.mockResolvedValue({ responses: [{ accountResult: { resourceName: `${C}/customAudiences/43` } }, { accountResult: { resourceName: `${C}/customAudiences/41` } }] })
    const run = await tool('set-google-custom-audiences').execute!(ask, approved(out.preview))
    expect(run.ok).toBe(true)
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.mutate).not.toHaveBeenCalled()
    expect(run.data).toMatchObject({ created: [{ customAudienceId: '43', name: 'Tourers' }], changed: 1 })
    h.live.customAudiences = [
      { customAudienceId: '41', name: 'Riders', description: null, type: 'AUTO', members: [{ type: 'KEYWORD', value: 'moto jacket' }, { type: 'URL', value: 'https://example.com/jackets' }] },
      { customAudienceId: '43', name: 'Tourers', description: null, type: 'AUTO', members: [{ type: 'KEYWORD', value: 'touring boots' }] },
    ]
    expect(await tool('set-google-custom-audiences').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('set-google-custom-audiences').undo!.request(run.change!)
    expect(undo).toEqual({ tool: 'set-google-custom-audiences', args: { accountId: 'g-1', change: [{ customAudienceId: '41', members: [{ type: 'KEYWORD', value: 'moto jacket' }] }], remove: ['43'], confirmRemove: true, why: 'undo of an earlier custom segment change' } })
    expect(parses(undo)).toBe(true)
  })
})

describe('undo: Google writes text back in its own case; what Nexus cannot send back is said', () => {
  it('a keyword Google lowercases still counts as the change that stands', async () => {
    h.check.mockResolvedValue({ resourceName: null, review: null, resourceNames: [] })
    const ask = { change: [{ customAudienceId: '41', addMembers: [{ type: 'KEYWORD', value: 'Moto Gloves' }] }] }
    const out = await tool('set-google-custom-audiences').handler(ask, asker)
    h.send.mockResolvedValue({ responses: [{ accountResult: { resourceName: `${C}/customAudiences/41` } }] })
    const run = await tool('set-google-custom-audiences').execute!(ask, approved(out.preview))
    expect(run.ok).toBe(true)
    h.live.customAudiences = [{ customAudienceId: '41', name: 'Riders', description: null, type: 'AUTO', members: [{ type: 'KEYWORD', value: 'moto gloves' }, { type: 'KEYWORD', value: 'moto jacket' }] }]
    expect(await tool('set-google-custom-audiences').undo!.current(run.change!)).toEqual(run.change!.after)
  })

  it('more than 250 members, or rules beyond what one change sends: the undo says so instead of a request the tool refuses', () => {
    const members = Array.from({ length: 251 }, (_, i) => ({ type: 'KEYWORD', value: `term ${i}` }))
    const many = tool('set-google-custom-audiences').undo!.request({ before: { audiences: [{ customAudienceId: '41', members }], created: [], removed: [] }, after: { audiences: [{ customAudienceId: '41', members: [] }], created: [], removed: [], accountId: 'g-1' } })
    expect(many).toMatchObject({ refusal: expect.stringMatching(/251 members.*at most 250/) })
    const groups = Array.from({ length: 11 }, (_, i) => ({ allOf: [{ parameter: 'url__', operator: 'CONTAINS', text: `/p${i}` }] }))
    const rules = tool('set-google-user-lists').undo!.request({
      before: { lists: [{ userListId: '51', visitors: { operator: 'AND', include: [{ anyOf: groups, lookbackDays: null }], exclude: [] } }], created: [], removed: [] },
      after: { lists: [{ userListId: '51', visitors: VISITORS }], created: [], removed: [], accountId: 'g-1' },
    })
    expect(rules).toMatchObject({ refusal: expect.stringMatching(/Undo cannot send the old lists and rules back.*anyOf/) })
    const nameless = tool('set-google-user-lists').undo!.request({
      before: { lists: [{ userListId: '51', visitors: { operator: 'AND', include: [{ anyOf: [{ allOf: [{ parameter: '', operator: 'CONTAINS', text: '/a' }] }], lookbackDays: null }], exclude: [] } }], created: [], removed: [] },
      after: { lists: [{ userListId: '51', visitors: VISITORS }], created: [], removed: [], accountId: 'g-1' },
    })
    expect(nameless).toHaveProperty('refusal')
  })
})

describe('set-google-user-lists', () => {
  it('open again where a serving campaign targets it is SPENDS MONEY; a new visitors list; undo closes it again and removes the new one', async () => {
    h.live.uses = [{ kind: 'USER_LIST', id: '51', campaignId: '21', campaignName: 'Shop A', campaignStatus: 'ENABLED', channel: 'SEARCH', level: 'campaign', levelStatus: null, status: 'ENABLED', negative: false }]
    h.mutate.mockResolvedValue({ responses: [], ops: 2, requestId: null })
    const ask = {
      create: [{ name: 'Checkout', visitors: { include: [{ anyOf: [{ allOf: [{ operator: 'CONTAINS', text: '/checkout' }] }] }] } }],
      change: [{ userListId: '51', membershipStatus: 'OPEN' }],
    }
    const out = await tool('set-google-user-lists').handler(ask, asker)
    expect(out.ok).toBe(true)
    expect(out.preview).toMatchObject({ spendsMoney: true, operations: 2 })
    h.mutate.mockReset()
    h.mutate.mockResolvedValue({ responses: [{ userListResult: { resourceName: `${C}/userLists/54` } }, { userListResult: { resourceName: `${C}/userLists/51` } }], ops: 2, requestId: 'r' })
    const run = await tool('set-google-user-lists').execute!(ask, approved(out.preview))
    expect(run.ok).toBe(true)
    expect(run.data).toMatchObject({ created: [{ userListId: '54', name: 'Checkout', kind: 'visitors' }], changed: 1 })
    h.live.lists = [{ ...LIST, membershipStatus: 'OPEN' }, { ...LIST, userListId: '54', name: 'Checkout' }]
    expect(await tool('set-google-user-lists').undo!.current(run.change!)).toEqual(run.change!.after)
    const undo = tool('set-google-user-lists').undo!.request(run.change!)
    expect(undo).toEqual({ tool: 'set-google-user-lists', args: { accountId: 'g-1', change: [{ userListId: '51', membershipStatus: 'CLOSED' }], remove: ['54'], confirmRemove: true, why: 'undo of an earlier user list change' } })
    expect(parses(undo)).toBe(true)
  })

  it('new rules: undo sends the old rules back, and they parse', async () => {
    h.mutate.mockResolvedValue({ responses: [{}], ops: 1, requestId: null })
    const ask = { change: [{ userListId: '51', visitors: { include: [{ anyOf: [{ allOf: [{ operator: 'CONTAINS', text: '/helmets' }] }], lookbackDays: 60 }] } }] }
    const out = await tool('set-google-user-lists').handler(ask, asker)
    const run = await tool('set-google-user-lists').execute!(ask, approved(out.preview))
    expect(run.ok).toBe(true)
    const undo = tool('set-google-user-lists').undo!.request(run.change!) as { tool: string; args: { change: unknown[] } }
    expect(undo.args.change).toEqual([{ userListId: '51', visitors: { operator: 'AND', include: [{ anyOf: [{ allOf: [{ parameter: 'url__', operator: 'CONTAINS', text: '/jackets' }] }], lookbackDays: 30 }] } }])
    expect(parses(undo)).toBe(true)
  })
})

describe('set-google-reusable-audiences', () => {
  it('a new audience and a change; undo puts the change back, and says a new one stays (Google has no remove)', async () => {
    h.live.audiences = [{ audienceId: '61', name: 'Riders', description: null, scope: 'CUSTOMER', assetGroupId: null, definition: { segments: [{ kind: 'USER_LIST', id: '51' }], ages: null, genders: { values: ['MALE'], includeUndetermined: false }, incomes: null, parental: null, excludeUserLists: [], other: [] } }]
    h.mutate.mockResolvedValue({ responses: [], ops: 2, requestId: null })
    const ask = { create: [{ name: 'Fans', segments: [{ kind: 'USER_INTEREST', id: '80101' }, { kind: 'DETAILED_DEMOGRAPHIC', id: '90' }] }], change: [{ audienceId: '61', genders: null }] }
    const out = await tool('set-google-reusable-audiences').handler(ask, asker)
    expect(out.ok).toBe(true)
    expect(out.preview).toMatchObject({ operations: 2, spendsMoney: false })
    h.mutate.mockReset()
    h.mutate.mockResolvedValue({ responses: [{ audienceResult: { resourceName: `${C}/audiences/62` } }, { audienceResult: { resourceName: `${C}/audiences/61` } }], ops: 2, requestId: 'r' })
    const run = await tool('set-google-reusable-audiences').execute!(ask, approved(out.preview))
    expect(run.ok).toBe(true)
    expect(run.data).toMatchObject({ created: [{ audienceId: '62', name: 'Fans' }], changed: 1 })
    const undo = tool('set-google-reusable-audiences').undo!.request(run.change!) as { tool: string; args: { change: unknown[]; why: string } }
    expect(undo.args.change).toEqual([{ audienceId: '61', segments: [{ kind: 'USER_LIST', id: '51' }], ages: null, genders: { values: ['MALE'], includeUndetermined: false }, incomes: null, parental: null, excludeUserLists: [] }])
    expect(undo.args.why).toMatch(/cannot remove an audience/)
    expect(parses(undo)).toBe(true)
    expect(tool('set-google-reusable-audiences').undo!.request({ before: { audiences: [], created: [] }, after: { audiences: [], created: [{ audienceId: '62', name: 'Fans' }] } })).toMatchObject({ refusal: expect.stringMatching(/no way to remove/) })
  })
})
