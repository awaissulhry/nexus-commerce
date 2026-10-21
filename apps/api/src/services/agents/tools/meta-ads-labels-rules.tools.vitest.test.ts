/**
 * Meta step 21 — set-meta-labels, set-meta-value-rules and create-meta-reach-frequency as the approval gate uses them (Meta,
 * the account and the live reads are stand-ins): the change contract of every Meta change tool; deletes only on explicit
 * ask; a preview from the live state (Meta never asked to check: no check is documented or used for these); what can make
 * the account spend more said (a booking names its amount); a run only as a request a person approved; each record's undo
 * asks the same tool with arguments its own input takes. Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown> | { refusal: string },
  labels: [] as Array<{ id: string; name: string | null }>,
  objects: new Map<string, { kind: 'campaign' | 'adset'; id: string; name: string | null; status: string | null; labels: Array<{ id: string; name: string | null }> }>(),
  sets: [] as unknown[],
  users: [] as unknown[],
  adSet: null as Record<string, unknown> | null,
  prediction: null as Record<string, unknown> | null,
  capabilities: ['CAN_USE_REACH_AND_FREQUENCY'] as string[] | null,
  check: vi.fn(),
  send: vi.fn(),
}))
vi.mock('../../marketing/meta-ads/change-account.js', () => ({ metaChangeAccount: vi.fn(async () => h.account) }))
vi.mock('../../marketing/meta-ads/live-labels-rules.js', () => ({
  liveAccountLabels: vi.fn(async () => ({ labels: structuredClone(h.labels), more: false })),
  liveLabelledObject: vi.fn(async (_t: unknown, kind: string, id: string) => structuredClone(h.objects.get(`${kind}:${id}`))),
  liveLabelCarriers: vi.fn(async () => ({ campaigns: [], adSets: [], ads: [], creatives: [], more: false })),
  liveValueRuleSets: vi.fn(async () => structuredClone(h.sets)),
  liveRuleSetUsers: vi.fn(async () => ({ users: structuredClone(h.users), more: false })),
  liveRulesAdSet: vi.fn(async () => structuredClone(h.adSet)),
  liveAdSetHasAds: vi.fn(async () => true),
  livePrediction: vi.fn(async () => structuredClone(h.prediction)),
}))
vi.mock('../../marketing/meta-ads/live-settings.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live-settings.js')>()),
  liveAccountCapabilities: vi.fn(async () => h.capabilities),
  liveCampaign: vi.fn(async () => ({ buyingType: 'RESERVED' })),
}))
vi.mock('../../marketing/meta-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live.js')>()),
  metaChosenAccount: vi.fn(async () => ({ pageId: '120000000000085', instagramId: null })),
}))
vi.mock('../../marketing/meta-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/write-client.js')>()),
  metaCheckChange: h.check,
  metaSendChange: h.send,
}))

import { META_ADS_LABELS_RULES_TOOLS } from './meta-ads-labels-rules.tools.js'
import { META_CHANGE_RULES } from './meta-ads-kit.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import type { AgentTool, ToolContext, ToolResult } from '../tool-types.js'

const [labelsTool, rulesTool, rfTool] = META_ADS_LABELS_RULES_TOOLS
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const preview = async (tool: AgentTool, args: Record<string, unknown>) => (await tool.handler(tool.input.parse(args) as Record<string, unknown>, asker)) as ToolResult & { preview: Record<string, any>; error?: string }
const run = async (tool: AgentTool, args: Record<string, unknown>, p: unknown) => (await tool.execute!(tool.input.parse(args) as Record<string, unknown>, approved(p))) as ToolResult & { data: Record<string, any>; change: { before: any; after: any } }
const undoOf = (tool: AgentTool, change: { before: unknown; after: unknown }) => {
  const request = tool.undo!.request(change)
  if (!('tool' in request)) throw new Error(request.refusal)
  const target = META_ADS_LABELS_RULES_TOOLS.find((t) => t.name === request.tool)!
  expect(target.input.safeParse(request.args).success).toBe(true)
  return request
}

const C = '120000000000001'
const S = '120000000000002'
const L1 = '120000000000070'
const L2 = '120000000000071'
const SET = '120000000000080'
const P = '120000000000090'
const R = '120000000000091'
const AD_SET = {
  id: S, name: 'Ad set B', status: 'ACTIVE', effectiveStatus: 'PAUSED', bidStrategy: 'LOWEST_COST_WITHOUT_CAP', legacyBidMultipliers: null, valueRuleSetId: null, valueRulesApplied: null, rfPredictionId: null,
  campaign: { id: C, name: 'Campaign A', status: 'PAUSED', buyingType: 'RESERVED', bidStrategy: null, specialAdCategories: [] },
}

beforeEach(() => {
  __metaObjectLimitsTest.useMemory()
  vi.unstubAllEnvs()
  vi.stubEnv('NEXUS_META_ADS_WRITES', 'on')
  h.check.mockReset(); h.send.mockReset()
  h.labels = [{ id: L1, name: 'Spring' }, { id: L2, name: 'Summer' }]
  h.objects = new Map([
    [`campaign:${C}`, { kind: 'campaign', id: C, name: 'Campaign A', status: 'ACTIVE', labels: [{ id: L1, name: 'Spring' }] }],
    [`adset:${S}`, { kind: 'adset', id: S, name: 'Ad set B', status: 'PAUSED', labels: [] }],
  ])
  h.sets = [{ id: SET, name: 'Set A', status: 'ACTIVE', productType: null, rules: [{ id: '120000000000082', name: 'Young', sign: 'INCREASE', percent: 20, status: 'ACTIVE', criteria: [{ id: '120000000000083', type: 'AGE', values: ['18-24'], valueTypes: ['NONE'] }] }] }]
  h.users = []
  h.adSet = structuredClone(AD_SET)
  h.prediction = { id: P, status: 1, predictionMode: 1, reservationStatus: 0, adSetId: null, campaignId: null, start: 4070908800, stop: 4072118400, expiration: null, budgetCents: 500000, reach: 1200000, impressions: 3600000, frequencyCap: 3, intervalFrequencyCap: null, intervalResetHours: null, destinationId: null, instagramDestinationId: null, unread: [] }
  h.capabilities = ['CAN_USE_REACH_AND_FREQUENCY']
})

describe('the change contract', () => {
  it('each: alwaysAsk at ask, high risk, open world, ads.campaigns.manage, the Meta rules line, material fields, an undo', () => {
    for (const tool of META_ADS_LABELS_RULES_TOOLS) {
      expect(tool).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, readOnly: false, category: 'advertising', reversibility: 'partial' })
      expect(tool.requires).toContain('ads.campaigns.manage')
      expect(tool.description.endsWith(META_CHANGE_RULES)).toBe(true)
      expect(MATERIAL_PREVIEW_FIELDS[tool.name]).toEqual(['basis', 'plan', 'reach'])
      expect(tool.undo).toBeDefined()
    }
    expect(META_ADS_LABELS_RULES_TOOLS.map((t) => t.name)).toEqual(['set-meta-labels', 'set-meta-value-rules', 'create-meta-reach-frequency'])
    // A booking quotes money: the adspend field guards it.
    expect(rfTool.requires).toContain('financials.adspend.view')
    expect(rfTool.restrictedFields).toMatchObject({ spendsMoneyBecause: 'financials.adspend.view', summary: 'financials.adspend.view' })
  })
  it('deletes only on explicit ask (confirmDelete literally true), and they have no undo', () => {
    expect(() => labelsTool.input.parse({ action: 'delete', labelId: L1, confirmDelete: false })).toThrow()
    expect(() => rulesTool.input.parse({ action: 'delete', ruleSetId: SET, confirmDelete: 'yes' })).toThrow()
    expect(labelsTool.consequencesFor!({ action: 'delete' })).toEqual({ reversibility: 'none' })
    expect(rulesTool.consequencesFor!({ action: 'delete' })).toEqual({ reversibility: 'none' })
    expect(rfTool.consequencesFor!({ action: 'predict' })).toEqual({ reversibility: 'none' })
    expect(labelsTool.consequencesFor!({ action: 'add' })).toBeNull()
    expect(labelsTool.description).toMatch(/only when the person explicitly asked to delete it: confirmDelete true/)
    expect(rulesTool.description).toMatch(/only on the person's explicit ask: confirmDelete true/)
  })
})

describe('set-meta-labels', () => {
  it('preview: a campaign by Meta\'s add edge, an ad set as its whole list; Meta never asked to check; nothing spends', async () => {
    const r = await preview(labelsTool, { action: 'add', objects: [{ kind: 'campaign', id: C }, { kind: 'adset', id: S }], labelIds: [L2] })
    expect(r.ok).toBe(true)
    expect(h.check).not.toHaveBeenCalled()
    expect(r.preview).toMatchObject({ spendsMoney: false, requests: [{ step: 1, metaCheck: 'not-used-yet' }, { step: 2, metaCheck: 'no-check' }] })
  })
  it('run: each object read back as a whole list and recorded; undo sets the earlier lists back through the same tool', async () => {
    const args = { action: 'add', objects: [{ kind: 'campaign', id: C }, { kind: 'adset', id: S }], labelIds: [L2] }
    const p = (await preview(labelsTool, args)).preview
    h.send.mockImplementationOnce(async () => ({ node: { success: true, id: C, adlabels: [{ id: L1, name: 'Spring' }, { id: L2, name: 'Summer' }] }, readBack: 'second-read', waitedMs: 0 }))
    h.send.mockImplementationOnce(async () => ({ node: { id: S, adlabels: [{ id: L2, name: 'Summer' }] }, readBack: 'second-read', waitedMs: 0 }))
    const r = await run(labelsTool, args, p)
    expect(r.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: C, kind: 'campaign', edge: 'adlabels', readBackObject: true, params: { adlabels: JSON.stringify([{ id: L2 }]) } })
    expect(h.send.mock.calls[1][1]).toMatchObject({ objectId: S, kind: 'adset', params: { adlabels: JSON.stringify([{ id: L2 }]) } })
    expect(r.data.steps.map((s: { outcome: string }) => s.outcome)).toEqual(['done', 'done'])
    expect(r.change.after).toMatchObject({ op: 'objects', objects: [{ id: C, labels: [{ id: L1 }, { id: L2 }] }, { id: S, labels: [{ id: L2 }] }], accountId: 'm-1', adAccountId: '1234567890' })
    const undo = undoOf(labelsTool, r.change)
    expect(undo).toMatchObject({ tool: 'set-meta-labels', args: { action: 'replace', sets: [{ kind: 'campaign', id: C, labelIds: [L1] }, { kind: 'adset', id: S, labelIds: [] }], connectionId: 'm-1' } })
  })
  it('a list read back otherwise is not confirmed (no record, no undo)', async () => {
    const args = { action: 'add', objects: [{ kind: 'adset', id: S }], labelIds: [L2] }
    const p = (await preview(labelsTool, args)).preview
    h.send.mockImplementationOnce(async () => ({ node: { id: S, adlabels: [{ id: L1, name: 'Spring' }] }, readBack: 'second-read', waitedMs: 0 }))
    const r = await run(labelsTool, args, p)
    expect(r).toMatchObject({ ok: false })
    expect(JSON.stringify(r)).toMatch(/not what was asked \(adlabels\)/)
  })
  it('create: the new label\'s id recorded; its undo deletes it (the person asked the undo: confirmDelete)', async () => {
    const p = (await preview(labelsTool, { action: 'create', name: 'Autumn' })).preview
    h.send.mockImplementationOnce(async () => ({ node: { id: '120000000000072', name: 'Autumn' }, readBack: 'same-request', waitedMs: 0 }))
    const r = await run(labelsTool, { action: 'create', name: 'Autumn' }, p)
    expect(r.change.after).toMatchObject({ op: 'create', label: { id: '120000000000072', name: 'Autumn' } })
    expect(undoOf(labelsTool, r.change)).toMatchObject({ args: { action: 'delete', labelId: '120000000000072', confirmDelete: true } })
    expect(labelsTool.undo!.request({ before: { op: 'delete' }, after: { op: 'delete', label: { id: L1, name: 'Spring' } } })).toMatchObject({ refusal: expect.stringMatching(/no way back/) })
  })
  it('a run only as a request a person approved', async () => {
    const args = { action: 'rename', labelId: L1, name: 'Spring sale' }
    const p = (await preview(labelsTool, args)).preview
    expect(await labelsTool.execute!(labelsTool.input.parse(args) as Record<string, unknown>, { ...approved(p), approvedByPerson: false })).toMatchObject({ ok: false })
    expect(await labelsTool.execute!(labelsTool.input.parse(args) as Record<string, unknown>, { ...approved(p), decidedVia: 'auto' })).toMatchObject({ ok: false })
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('set-meta-value-rules', () => {
  it('attach a set that raises to an ad set that is off: SPENDS MONEY, nothing spends yet; undo detaches', async () => {
    const args = { action: 'attach', adSetId: S, ruleSetId: SET }
    const r = await preview(rulesTool, args)
    expect(r.preview).toMatchObject({ spendsMoney: true, spendsMoneyBecause: [expect.stringMatching(/raises bids for some people: nothing spends yet/)] })
    expect(h.check).not.toHaveBeenCalled()
    h.send.mockImplementationOnce(async () => ({ node: { id: S, value_rule_set_id: SET }, readBack: 'second-read', waitedMs: 0 }))
    const done = await run(rulesTool, args, r.preview)
    expect(done.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: S, kind: 'adset', params: { value_rule_set_id: SET, value_rules_applied: 'true' } })
    expect(undoOf(rulesTool, done.change)).toMatchObject({ args: { action: 'detach', adSetId: S } })
  })
  it('create: the new set\'s id recorded, its undo deletes it; a change\'s undo sends the earlier rules', async () => {
    const rules = [{ name: 'Desktop', adjust: 'DECREASE', percent: 20, criteria: [{ type: 'DEVICE_PLATFORM', values: ['DESKTOP'] }] }]
    const p = (await preview(rulesTool, { action: 'create', name: 'Set B', rules })).preview
    h.send.mockImplementationOnce(async () => ({ node: { id: '120000000000081', name: 'Set B' }, readBack: 'second-read', waitedMs: 0 }))
    const made = await run(rulesTool, { action: 'create', name: 'Set B', rules }, p)
    expect(undoOf(rulesTool, made.change)).toMatchObject({ args: { action: 'delete', ruleSetId: '120000000000081', confirmDelete: true } })
    const change = { action: 'change', ruleSetId: SET, rules: [{ ruleId: '120000000000082', name: 'Young', adjust: 'INCREASE', percent: 40, criteria: [{ type: 'AGE', values: ['18-24'] }] }] }
    const q = (await preview(rulesTool, change)).preview
    h.send.mockImplementationOnce(async () => ({ node: { id: SET, name: 'Set A' }, readBack: 'second-read', waitedMs: 0 }))
    const changed = await run(rulesTool, change, q)
    expect(undoOf(rulesTool, changed.change)).toMatchObject({ args: { action: 'change', ruleSetId: SET, name: 'Set A', rules: [{ ruleId: '120000000000082', percent: 20 }] } })
  })
  it('translate: nothing made, the proposal answered; no undo', async () => {
    h.adSet = { ...AD_SET, legacyBidMultipliers: { age: { '18-24': 0.5 } } }
    const p = (await preview(rulesTool, { action: 'translate', adSetId: S })).preview
    expect(p.spendsMoney).toBe(false)
    h.send.mockImplementationOnce(async () => ({ node: { success: true, value_rule_set: { name: 'Migrated', rules: [] } }, readBack: 'none', waitedMs: 0 }))
    const r = await run(rulesTool, { action: 'translate', adSetId: S }, p)
    expect(r.data).toMatchObject({ translation: { name: 'Migrated' } })
    expect(rulesTool.undo!.request(r.change)).toMatchObject({ refusal: expect.stringMatching(/changes nothing/) })
  })
})

describe('create-meta-reach-frequency', () => {
  it('reserve: SPENDS MONEY with the amount and dates; the reservation id recorded; undo cancels it', async () => {
    const p = (await preview(rfTool, { action: 'reserve', predictionId: P })).preview
    expect(p).toMatchObject({ spendsMoney: true, spendsMoneyBecause: [expect.stringMatching(/agreeing to pay Meta's proposed costs: about 5000\.00 EUR/)] })
    h.send.mockImplementationOnce(async () => ({ node: { id: R, status: 2 }, readBack: 'second-read', waitedMs: 0 }))
    const r = await run(rfTool, { action: 'reserve', predictionId: P }, p)
    expect(r.data).toMatchObject({ reservationId: R })
    expect(r.data.steps[0].sentence).toMatch(/Meta made it\./)
    expect(undoOf(rfTool, r.change)).toMatchObject({ args: { action: 'cancel', predictionId: R } })
  })
  it('predict: a quote (nothing spends), the chosen Page as destination; its run has no undo', async () => {
    const args = { action: 'predict', mode: 'reach-from-budget', budgetCents: 500000, startTime: '2099-01-01T00:00:00Z', stopTime: '2099-01-10T00:00:00Z', frequencyCap: 2, targeting: { country: 'IT' } }
    // Meta's 8-week limit is from now: the made-up dates are far ahead, so the preview says so in words.
    expect(await preview(rfTool, args)).toMatchObject({ ok: false, error: expect.stringMatching(/8 weeks ahead/) })
    const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
    const later = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)
    const ok = await preview(rfTool, { ...args, startTime: `${soon}T00:00:00Z`, stopTime: `${later}T00:00:00Z` })
    expect(ok.preview).toMatchObject({ spendsMoney: false })
    expect(rfTool.undo!.request({ before: { op: 'predict' }, after: { op: 'predict', predictionId: P } })).toMatchObject({ refusal: expect.stringMatching(/books nothing/) })
  })
  it('attach: undo detaches; detach: undo attaches the reservation it had', () => {
    expect(undoOf(rfTool, { before: { op: 'attach', adSetId: S }, after: { op: 'attach', adSetId: S, adSetPrediction: R, accountId: 'm-1' } })).toMatchObject({ args: { action: 'detach', adSetId: S } })
    expect(undoOf(rfTool, { before: { op: 'detach', adSetId: S, adSetPrediction: R }, after: { op: 'detach', adSetId: S, adSetPrediction: null } })).toMatchObject({ args: { action: 'attach', adSetId: S, predictionId: R } })
  })
  it('no grant: refused in words before anything', async () => {
    h.capabilities = []
    expect(await preview(rfTool, { action: 'reserve', predictionId: P })).toMatchObject({ ok: false, error: expect.stringMatching(/has not granted reach and frequency/) })
  })
  it('Meta changes switched off: nothing is checked or sent, and the preview says so', async () => {
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'off')
    const r = await preview(rfTool, { action: 'cancel', predictionId: P })
    expect(r).toMatchObject({ ok: false })
    h.prediction = { ...h.prediction!, reservationStatus: 1 }
    const q = await preview(rfTool, { action: 'cancel', predictionId: P })
    expect(q.preview.metaCheck.sentence).toMatch(/switched off/)
    expect(h.check).not.toHaveBeenCalled()
  })
})
