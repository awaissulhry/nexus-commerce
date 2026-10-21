/**
 * Meta step 29 — set-meta-ad-rule and remove-meta-ad-rule as the approval gate uses them (Meta, the account and the live
 * reads are stand-ins): the change contract of every Meta change tool; a preview from the live rule that says SPENDS
 * MONEY and that Meta has no check; a run only as a request a person approved, sent as the kit builds it (the rule
 * library, the rule, its run, its delete — each its own gateway operation); a new rule Meta reads back ON when it was
 * asked OFF is never recorded as done; a run whose matching objects moved is not sent; Meta's 2703 in plain words; undo
 * reads the rule live, deletes a new rule, puts a change back, makes a deleted rule again — each request parses as the
 * tool it names. Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown>,
  live: null as Record<string, unknown> | null,
  gone: false as boolean | null,
  preview: { read: true, objects: [{ id: '120000000000002', name: 'Ad set B' }], more: false, sentence: 'Meta\'s preview: the rule would act on 1 object now ("Ad set B" (120000000000002)).' } as Record<string, unknown>,
  previews: 0,
  check: vi.fn(async () => undefined),
  send: vi.fn(),
}))
vi.mock('../../marketing/meta-ads/change-account.js', () => ({ metaChangeAccount: vi.fn(async () => h.account) }))
vi.mock('../../marketing/meta-ads/live-rules.js', async () => {
  const { mapRule } = await import('../../marketing/meta-ads/live-optimize.js')
  const { MetaLiveRefusal } = await import('../../marketing/meta-ads/live.js')
  const chosen = { connection: { systemUser: { id: '100009' } }, connectionId: 'm-1', adAccountId: '1234567890', currency: 'EUR' } as never
  const words = (raw: Record<string, unknown>) => mapRule(raw, chosen)
  return {
    ruleWordsFor: vi.fn(async () => words),
    liveRule: vi.fn(async () => {
      if (!h.live) throw new MetaLiveRefusal('That is not a rule of the ad account this business chose (Meta does not show it as one), so it is not read.')
      const l = structuredClone(h.live) as Record<string, any>
      return { ...l, words: words({ name: l.name, status: l.status, evaluation_spec: l.specs.evaluation, execution_spec: l.specs.execution, schedule_spec: l.specs.schedule }) }
    }),
    liveRuleGone: vi.fn(async () => h.gone),
    liveRulePreview: vi.fn(async () => { h.previews++; return structuredClone(h.preview) }),
  }
})
vi.mock('../../marketing/meta-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/write-client.js')>()),
  metaCheckChange: h.check,
  metaSendChange: h.send,
}))

import { META_ADS_RULES_TOOLS } from './meta-ads-rules.tools.js'
import { META_CHANGE_RULES } from './meta-ads-kit.js'
import { MetaWriteError } from '../../marketing/meta-ads/write-client.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import type { AgentTool, ToolContext, ToolResult } from '../tool-types.js'

const tool = (name: string) => META_ADS_RULES_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const ask = (t: AgentTool, args: Record<string, unknown>) => t.input.parse(args) as Record<string, unknown>
const preview = async (name: string, args: Record<string, unknown>) => (await tool(name).handler(ask(tool(name), args), asker)) as ToolResult & { preview: Record<string, any> }
const run = async (name: string, args: Record<string, unknown>, p: unknown) => (await tool(name).execute!(ask(tool(name), args), approved(p))) as ToolResult & { data: Record<string, any> }

const RULE = '120000000000101'
const NEW_RULE = '120000000000102'
const EVAL = { evaluation_type: 'SCHEDULE', filters: [{ field: 'entity_type', value: 'ADSET', operator: 'EQUAL' }, { field: 'time_preset', value: 'LAST_7D', operator: 'EQUAL' }, { field: 'cost_per_purchase_fb', value: 2500, operator: 'GREATER_THAN' }] }
const PAUSE = { execution_type: 'PAUSE' }
const RAISE = { execution_type: 'CHANGE_BUDGET', execution_options: [{ field: 'change_spec', value: { amount: 20, unit: 'PERCENTAGE' }, operator: 'EQUAL' }] }
const LIVE = { id: RULE, name: 'Rule A', status: 'ENABLED', disableErrorCode: null, specs: { evaluation: EVAL, execution: PAUSE, schedule: { schedule_type: 'DAILY' } } }
const createArgs = {
  action: 'create', name: 'Pause costly ad sets',
  evaluation: { type: 'SCHEDULE', filters: [{ field: 'entity_type', operator: 'EQUAL', value: 'ADSET' }, { field: 'time_preset', operator: 'EQUAL', value: 'LAST_7D' }, { field: 'spent', operator: 'GREATER_THAN', valueCents: 5000 }] },
  execution: { type: 'PAUSE', notifyUserIds: ['100001'] },
  schedule: { type: 'DAILY' },
}
const readBack = (o: Record<string, unknown>) => ({ node: { id: RULE, name: 'Rule A', status: 'ENABLED', evaluation_spec: EVAL, execution_spec: PAUSE, schedule_spec: { schedule_type: 'DAILY' }, ...o }, readBack: 'second-read', waitedMs: 0 })

beforeEach(() => {
  __metaObjectLimitsTest.useMemory()
  vi.unstubAllEnvs()
  h.check.mockReset(); h.send.mockReset()
  h.live = structuredClone(LIVE)
  h.gone = false
  h.previews = 0
  h.preview = { read: true, objects: [{ id: '120000000000002', name: 'Ad set B' }], more: false, sentence: 'Meta\'s preview: the rule would act on 1 object now ("Ad set B" (120000000000002)).' }
})

describe('the tools', () => {
  it('each is a change a person always approves, with an undo, the #691 truth, money keys and its MATERIAL fields', () => {
    for (const name of ['set-meta-ad-rule', 'remove-meta-ad-rule']) {
      const t = tool(name)
      expect(t, name).toMatchObject({ readOnly: false, alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, reversibility: 'partial', category: 'advertising' })
      expect(t.requires).toEqual(['ads.campaigns.manage', 'financials.adspend.view'])
      expect(t.undo, name).toBeDefined()
      expect(t.description.endsWith(META_CHANGE_RULES), name).toBe(true)
      expect(t.description, name).toMatch(/SPENDS MONEY/)
      expect(t.restrictedFields, name).toMatchObject({ changes: 'financials.adspend.view', spendsMoneyBecause: 'financials.adspend.view', steps: 'financials.adspend.view', valueCents: 'financials.adspend.view' })
      expect(MATERIAL_PREVIEW_FIELDS[name], name).toEqual(['basis', 'plan', 'reach'])
    }
    expect(tool('set-meta-ad-rule').consequencesFor!({ action: 'run' })).toEqual({ reversibility: 'none' })
    expect(tool('set-meta-ad-rule').consequencesFor!({ action: 'status' })).toBeNull()
    expect(() => tool('remove-meta-ad-rule').input.parse({ ruleId: RULE, confirmDelete: false })).toThrow()
    expect(() => tool('remove-meta-ad-rule').input.parse({ ruleId: RULE })).toThrow()
    expect(() => tool('set-meta-ad-rule').input.parse({ action: 'create', name: 'Rule ‮A' })).toThrow()
    expect(tool('set-meta-ad-rule').description).toMatch(/recommended_rule_key: Meta documents no value/)
  })
})

describe('set-meta-ad-rule', () => {
  it('create: a preview made OFF, Meta has no check (none asked), basis and plan stable', async () => {
    const a = await preview('set-meta-ad-rule', createArgs)
    expect(a.ok).toBe(true)
    expect(a.preview).toMatchObject({ spendsMoney: false, metaCheck: { checked: 'none', sentence: expect.stringMatching(/Meta has no check/) } })
    expect(a.preview.changes.Status).toEqual({ from: null, to: 'off (DISABLED)' })
    expect(h.check).not.toHaveBeenCalled()
    const b = await preview('set-meta-ad-rule', createArgs)
    expect([b.preview.basis, b.preview.plan]).toEqual([a.preview.basis, a.preview.plan])
    const on = await preview('set-meta-ad-rule', { ...createArgs, execution: { type: 'UNPAUSE' }, enable: true })
    expect(on.preview.spendsMoney).toBe(true)
    expect(on.preview.plan).not.toBe(a.preview.plan)
  })
  it('create: the run sends ONE request on the rule library and records the new rule; undo deletes exactly it', async () => {
    const p = await preview('set-meta-ad-rule', createArgs)
    h.send.mockImplementation(async () => readBack({ id: NEW_RULE, name: 'Pause costly ad sets', status: 'DISABLED' }))
    const out = await run('set-meta-ad-rule', createArgs, p.preview)
    expect(out.ok).toBe(true)
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: 'act_1234567890', kind: 'adaccount', edge: 'adrules_library', operation: 'adRule.create', expect: { status: 'DISABLED' } })
    expect(out.data).toMatchObject({ ruleId: NEW_RULE, status: 'DISABLED' })
    const change = out.change!
    expect(change.after).toMatchObject({ id: NEW_RULE, exists: 'yes', accountId: 'm-1', adAccountId: '1234567890' })
    const undo = tool('set-meta-ad-rule').undo!.request(change)
    expect(undo).toMatchObject({ tool: 'remove-meta-ad-rule', args: { ruleId: NEW_RULE, confirmDelete: true, connectionId: 'm-1' } })
    expect(tool('remove-meta-ad-rule').input.safeParse((undo as { args: unknown }).args).success).toBe(true)
  })
  it('review A3 — a new rule Meta reads back ON although it was asked OFF is recorded (it exists), named, and its undo deletes it', async () => {
    const p = await preview('set-meta-ad-rule', createArgs)
    h.send.mockImplementation(async () => readBack({ id: NEW_RULE, status: 'ENABLED' }))
    const out = await run('set-meta-ad-rule', createArgs, p.preview)
    expect(out.ok).toBe(true)
    expect(out.data.warning).toMatch(new RegExp(`Meta made rule ${NEW_RULE} but reads it back ENABLED, not DISABLED .*it can act now.*remove-meta-ad-rule`))
    expect(out.change!.after).toMatchObject({ id: NEW_RULE, exists: 'yes' })
    expect(tool('set-meta-ad-rule').undo!.request(out.change!)).toMatchObject({ tool: 'remove-meta-ad-rule', args: { ruleId: NEW_RULE, confirmDelete: true } })
  })
  it('status on: Meta\'s preview of the rule in the preview, SPENDS MONEY for a raise; the run sends only the status; undo switches it back', async () => {
    h.live = { ...structuredClone(LIVE), status: 'DISABLED', specs: { ...LIVE.specs, execution: RAISE } }
    const p = await preview('set-meta-ad-rule', { action: 'status', ruleId: RULE, enabled: true })
    expect(h.previews).toBe(1)
    expect(p.preview.spendsMoney).toBe(true)
    expect(p.preview.warnings.join(' ')).toMatch(/Meta's preview: the rule would act on 1 object/)
    expect(p.preview.totals).toMatchObject({ objectsMatchingNow: 1 })
    h.send.mockImplementation(async () => readBack({ status: 'ENABLED', execution_spec: RAISE }))
    const out = await run('set-meta-ad-rule', { action: 'status', ruleId: RULE, enabled: true }, p.preview)
    expect(out.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: RULE, kind: 'adrule', params: { status: 'ENABLED' }, operation: 'adRule.status' })
    expect(tool('set-meta-ad-rule').undo!.request(out.change!)).toMatchObject({ tool: 'set-meta-ad-rule', args: { action: 'status', ruleId: RULE, enabled: false } })
    // undo's "now" is the record's after while the rule is as the change left it.
    h.live = { ...structuredClone(LIVE), status: 'ENABLED', specs: { ...LIVE.specs, execution: RAISE } }
    expect(JSON.stringify(await tool('set-meta-ad-rule').undo!.current(out.change!))).toBe(JSON.stringify(out.change!.after))
    h.live = { ...h.live, status: 'DISABLED' }
    expect(JSON.stringify(await tool('set-meta-ad-rule').undo!.current(out.change!))).not.toBe(JSON.stringify(out.change!.after))
  })
  it('run: Meta\'s preview objects are what it stands on — moved since approval, nothing is sent; a trigger rule is refused', async () => {
    const p = await preview('set-meta-ad-rule', { action: 'run', ruleId: RULE })
    expect(p.ok).toBe(true)
    h.preview = { ...h.preview, objects: [{ id: '120000000000002', name: null }, { id: '120000000000004', name: null }] }
    const moved = await run('set-meta-ad-rule', { action: 'run', ruleId: RULE }, p.preview)
    expect(moved.ok).toBe(false)
    expect(moved.error).toMatch(/changed since this was approved/)
    expect(h.send).not.toHaveBeenCalled()
    h.preview = { ...h.preview, objects: [{ id: '120000000000002', name: 'Ad set B' }] }
    h.send.mockImplementation(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 }))
    const ok = await run('set-meta-ad-rule', { action: 'run', ruleId: RULE }, p.preview)
    expect(ok.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: RULE, kind: 'adrule', edge: 'execute', params: {}, operation: 'adRule.run' })
    expect(ok.data).toMatchObject({ ran: true })
    expect(tool('set-meta-ad-rule').undo!.request(ok.change!)).toEqual({ refusal: expect.stringMatching(/view history/) })
    h.live = { ...structuredClone(LIVE), specs: { evaluation: { evaluation_type: 'TRIGGER', filters: [{ field: 'entity_type', value: 'AD', operator: 'EQUAL' }], trigger: { type: 'METADATA_CREATION' } }, execution: { execution_type: 'NOTIFICATION' }, schedule: null } }
    expect((await preview('set-meta-ad-rule', { action: 'run', ruleId: RULE })).error).toMatch(/trigger rule/)
  })
  it('Meta\'s 2703 is said in plain words; a rule of another account is refused in words', async () => {
    const p = await preview('set-meta-ad-rule', createArgs)
    h.send.mockImplementation(async () => { throw new MetaWriteError({ origin: 'meta', httpStatus: 400, code: '100/2703', authLost: false, throttled: false, permissionDenied: false, notFound: false, sentence: 'Meta refused it (100/2703): Rules that turn off ads can\'t have cost conditions. Nothing was changed.' }, 'adRule.create', 'refused') })
    const out = await run('set-meta-ad-rule', createArgs, p.preview)
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/In plain words: Meta does not take a rule that turns ads off together with a spend or cost condition/)
    h.live = null
    expect((await preview('set-meta-ad-rule', { action: 'status', ruleId: RULE, enabled: false })).error).toMatch(/not a rule of the ad account/)
  })
  it('update: undo puts the old parts back through the same tool, and its request parses', async () => {
    const args = { action: 'update', ruleId: RULE, execution: { type: 'NOTIFICATION', notifyUserIds: ['100001'] } }
    const p = await preview('set-meta-ad-rule', args)
    expect(p.preview.spendsMoney).toBe(true) // a pause rule that is on, changed: what it stops may keep spending
    h.send.mockImplementation(async () => readBack({ execution_spec: { execution_type: 'NOTIFICATION', execution_options: [{ field: 'user_ids', value: ['100001'], operator: 'EQUAL' }] } }))
    const out = await run('set-meta-ad-rule', args, p.preview)
    expect(out.ok).toBe(true)
    const undo = tool('set-meta-ad-rule').undo!.request(out.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo).toMatchObject({ tool: 'set-meta-ad-rule', args: { action: 'update', ruleId: RULE, execution: { type: 'PAUSE' }, schedule: { type: 'DAILY' } } })
    expect(tool('set-meta-ad-rule').input.safeParse(undo.args).success).toBe(true)
  })
})

describe('remove-meta-ad-rule', () => {
  it('a DELETE of the rule; deleting a pause rule that is on is SPENDS MONEY; undo makes it again (ON) and its request parses', async () => {
    const p = await preview('remove-meta-ad-rule', { ruleId: RULE, confirmDelete: true })
    expect(p.ok).toBe(true)
    expect(p.preview.spendsMoney).toBe(true)
    expect(p.preview.warnings.join(' ')).toMatch(/for good on Meta: undo makes a NEW rule/)
    h.send.mockImplementation(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 }))
    const out = await run('remove-meta-ad-rule', { ruleId: RULE, confirmDelete: true }, p.preview)
    expect(out.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: RULE, kind: 'adrule', method: 'DELETE', operation: 'adRule.delete' })
    const undo = tool('remove-meta-ad-rule').undo!.request(out.change!) as { tool: string; args: Record<string, unknown> }
    expect(undo).toMatchObject({ tool: 'set-meta-ad-rule', args: { action: 'create', name: 'Rule A', enable: true, execution: { type: 'PAUSE' } } })
    expect(tool('set-meta-ad-rule').input.safeParse(undo.args).success).toBe(true)
    h.gone = true
    expect(JSON.stringify(await tool('remove-meta-ad-rule').undo!.current(out.change!))).toBe(JSON.stringify(out.change!.after))
    h.gone = false
    expect(JSON.stringify(await tool('remove-meta-ad-rule').undo!.current(out.change!))).not.toBe(JSON.stringify(out.change!.after))
  })
})
