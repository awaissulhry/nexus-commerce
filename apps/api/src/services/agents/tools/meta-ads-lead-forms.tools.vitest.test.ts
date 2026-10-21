/**
 * Meta step 36 — create-meta-lead-form and set-meta-lead-form as the approval gate uses them (Meta, the account and the
 * live reads are stand-ins): a change a person always approves; the preview says Meta has no check; nothing spends; a run
 * only as a request a person approved, request by request (Meta's codes in plain words); the records hold the Page, the
 * form and the test lead ids; undo archives a form it made, flips archive ⇄ re-activate, deletes a test lead it made, and
 * never brings back a deleted one. Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown> | { refusal: string },
  page: { pageId: '120000000000010', termsAccepted: true } as Record<string, unknown>,
  form: null as Record<string, unknown> | null,
  testLeads: { ids: [] as string[] | null } as { ids: string[] | null; note?: string },
  nexusMade: [] as string[],
  pageRefusal: null as string | null,
  check: vi.fn(async () => undefined),
  send: vi.fn(),
}))
vi.mock('../../marketing/meta-ads/change-account.js', () => ({ metaChangeAccount: vi.fn(async () => h.account) }))
vi.mock('../../marketing/meta-ads/live-lead-forms.js', async () => {
  const { MetaLiveRefusal } = await import('../../marketing/meta-ads/live.js')
  return {
    liveLeadFormPage: vi.fn(async () => { if (h.pageRefusal) throw new MetaLiveRefusal(h.pageRefusal); return structuredClone(h.page) }),
    liveLeadFormState: vi.fn(async (_c: string, formId: string) => { if (!h.form || h.form.formId !== formId) throw new MetaLiveRefusal('That form is not one of the lead forms of the Facebook Page this business chose, so it is not read.'); return structuredClone(h.form) }),
    liveTestLeadIds: vi.fn(async () => structuredClone(h.testLeads)),
    nexusTestLeadsOf: vi.fn(async () => [...h.nexusMade]),
  }
})
vi.mock('../../marketing/meta-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/write-client.js')>()),
  metaCheckChange: h.check,
  metaSendChange: h.send,
}))

import { META_ADS_LEAD_FORMS_TOOLS } from './meta-ads-lead-forms.tools.js'
import { META_CHANGE_RULES, planOf } from './meta-ads-kit.js'
import { factHash } from '../tool-types.js'
import { META_LEAD_FORM_CREATE_TOOL, META_LEAD_FORM_SET_TOOL } from '../../gateway/account.js'
import { MetaWriteError } from '../../marketing/meta-ads/write-client.js'
import { localFailure } from '../../marketing/meta-ads/errors.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import type { ToolContext, ToolResult } from '../tool-types.js'

const create = META_ADS_LEAD_FORMS_TOOLS.find((t) => t.name === 'create-meta-lead-form')!
const set = META_ADS_LEAD_FORMS_TOOLS.find((t) => t.name === 'set-meta-lead-form')!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const recheck: ToolContext = { can: () => true, via: 'system', approvalId: 'ap-1' }
const approved = (preview: unknown, extra: Partial<ToolContext> = {}): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview, ...extra })
type Out = ToolResult & { preview: Record<string, any>; data: Record<string, any> }
const run = async (tool: typeof create, args: Record<string, unknown>) => {
  const parsed = tool.input.parse(args) as Record<string, unknown>
  const p = (await tool.handler(parsed, asker)) as Out
  if (!p.ok) return { preview: p, ran: null }
  return { preview: p, ran: (await tool.execute!(parsed, approved(p.preview))) as Out }
}
const FORM = { pageId: '120000000000010', formId: '600000000000001', name: 'Form A', status: 'ACTIVE', questions: [{ key: 'full_name', type: 'FULL_NAME', options: [] }, { key: 'email', type: 'EMAIL', options: [] }], checkboxKeys: [] as string[] }
const CREATE = { name: 'Form A', locale: 'IT_IT', questions: [{ type: 'FULL_NAME' }, { type: 'EMAIL' }], privacyPolicy: { url: 'https://example.com/privacy' } }

beforeEach(() => {
  __metaObjectLimitsTest.useMemory()
  vi.unstubAllEnvs()
  h.check.mockReset(); h.send.mockReset()
  h.account = { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' }
  h.page = { pageId: '120000000000010', termsAccepted: true }
  h.form = structuredClone(FORM)
  h.testLeads = { ids: [] }
  h.nexusMade = []
  h.pageRefusal = null
})

describe('the tools', () => {
  it('are changes a person always approves (ask ceiling, open world, high risk), each with an undo, the #691 truth and D4', () => {
    expect(META_ADS_LEAD_FORMS_TOOLS.map((t) => t.name)).toEqual([META_LEAD_FORM_CREATE_TOOL, META_LEAD_FORM_SET_TOOL])
    for (const tool of META_ADS_LEAD_FORMS_TOOLS) {
      expect(tool).toMatchObject({ readOnly: false, alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, category: 'advertising', reversibility: 'partial', requires: ['ads.campaigns.manage'] })
      expect(tool.undo).toBeDefined()
      expect(tool.description.endsWith(META_CHANGE_RULES)).toBe(true)
      expect(tool.description).toMatch(/AS the Page: Nexus's gateway reads the chosen Page's own token .* a token is never shown/)
      expect(tool.description).toMatch(/App Review/)
      expect(MATERIAL_PREVIEW_FIELDS[tool.name]).toEqual(['basis', 'plan', 'reach'])
    }
    expect(create.description).toMatch(/AI agent is always sent OFF/)
    expect(set.consequencesFor!({ action: 'archive', formId: '1' })).toEqual({ reversibility: 'full' })
    expect(set.consequencesFor!({ action: 'remove-test-lead', formId: '1' })).toEqual({ reversibility: 'none' })
    expect(set.consequencesFor!({ action: 'test-lead', formId: '1' })).toEqual({ reversibility: 'full' })
    expect(set.consequencesFor!({ action: 'test-lead', formId: '1', replaceTestLead: true })).toBeNull()
    // Every array is bounded; a slider or a national id is a sentence, not a schema error.
    expect(() => create.input.parse({ ...CREATE, questions: Array.from({ length: 31 }, () => ({ type: 'EMAIL' })) })).toThrow()
    expect(() => create.input.parse({ ...CREATE, questions: [{ type: 'SLIDER', key: 's' }] })).not.toThrow()
    expect(() => create.input.parse({ ...CREATE, privacyPolicy: { url: 'http://example.com' } })).toThrow()
  })
})

describe('create-meta-lead-form', () => {
  it('preview: Meta has no check (none asked), one request on the chosen Page, nothing spends; re-check stable', async () => {
    const p = (await create.handler(create.input.parse(CREATE) as Record<string, unknown>, asker)) as Out
    expect(p.ok).toBe(true)
    expect(h.check).not.toHaveBeenCalled()
    expect(p.preview).toMatchObject({ spendsMoney: false, metaCheck: { checked: 'none', sentence: expect.stringMatching(/^Meta has no check for this change/) }, requests: [{ step: 1, label: 'Create lead form "Form A" on the Facebook Page 120000000000010', metaCheck: 'no-check' }] })
    expect(p.preview.warnings.join(' ')).toMatch(/AI agent stays OFF/)
    const again = (await create.handler(create.input.parse(CREATE) as Record<string, unknown>, recheck)) as Out
    expect([again.preview.basis, again.preview.plan]).toEqual([p.preview.basis, p.preview.plan])
  })
  it('refusals in words: a slider, no Page chosen, no ad account', async () => {
    expect(await create.handler(create.input.parse({ ...CREATE, questions: [{ type: 'SLIDER', key: 's' }] }) as Record<string, unknown>, asker)).toEqual({ ok: false, error: expect.stringMatching(/no shape for a slider/) })
    h.pageRefusal = 'No Facebook Page is chosen for this business yet.'
    expect(await create.handler(create.input.parse(CREATE) as Record<string, unknown>, asker)).toEqual({ ok: false, error: 'No Facebook Page is chosen for this business yet.' })
    h.account = { refusal: 'No Meta ad account is chosen for this business yet.' }
    expect(await create.handler(create.input.parse(CREATE) as Record<string, unknown>, asker)).toEqual({ ok: false, error: 'No Meta ad account is chosen for this business yet.' })
  })
  it('run: as the approving person, the form id kept in the record (where undo and the gateway find it)', async () => {
    h.send.mockImplementationOnce(async () => ({ node: { id: '600000000000001', name: 'Form A', status: 'ACTIVE' }, readBack: 'second-read', waitedMs: 0 }))
    const { ran } = await run(create, CREATE)
    expect(ran!.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: '120000000000010', kind: 'page', edge: 'leadgen_forms', operation: 'leadform.create', readBackFields: 'id,name,status' })
    expect(ran!.data).toMatchObject({ formId: '600000000000001', pageId: '120000000000010', steps: [{ outcome: 'done', sentence: expect.stringMatching(/Meta made it\./) }] })
    expect(ran!.change).toEqual({
      before: { pageId: '120000000000010', formId: null, name: 'Form A', archived: null, accountId: 'm-1', adAccountId: '1234567890' },
      after: { pageId: '120000000000010', formId: '600000000000001', name: 'Form A', archived: false, accountId: 'm-1', adAccountId: '1234567890' },
    })
  })
  it('run: Meta\'s lead codes come back in plain words (80005 per Page, 368 policy), never sent again', async () => {
    h.send.mockImplementationOnce(async () => { throw new MetaWriteError({ ...localFailure('Meta asked Nexus to slow down (80005).', '80005'), origin: 'meta', throttled: true }, 'leadform.create', 'refused') })
    const { ran } = await run(create, CREATE)
    expect(ran).toEqual({ ok: false, error: expect.stringMatching(/slow down \(80005\)\. Meta allows only so many lead-form calls per Page/) })
    h.send.mockImplementationOnce(async () => { throw new MetaWriteError({ ...localFailure('Meta refused it (368): x. Nothing was changed.', '368'), origin: 'meta' }, 'leadform.create', 'refused') })
    const again = await run(create, CREATE)
    expect(again.ran).toEqual({ ok: false, error: expect.stringMatching(/Meta judged this request abusive or not allowed/) })
  })
  it('undo archives the form it made (Meta deletes no form), valid for set-meta-lead-form\'s input; current() reads the form', async () => {
    const change = {
      before: { pageId: '120000000000010', formId: null, name: 'Form A', archived: null, accountId: 'm-1', adAccountId: '1234567890' },
      after: { pageId: '120000000000010', formId: '600000000000001', name: 'Form A', archived: false, accountId: 'm-1', adAccountId: '1234567890' },
    }
    const back = create.undo!.request(change)
    expect(back).toEqual({ tool: 'set-meta-lead-form', args: { connectionId: 'm-1', action: 'archive', formId: '600000000000001', why: expect.stringMatching(/archived/) } })
    expect(() => set.input.parse((back as { args: unknown }).args)).not.toThrow()
    expect(await create.undo!.current(change)).toEqual(change.after)
    h.form = { ...FORM, status: 'ARCHIVED' }
    expect(await create.undo!.current(change)).not.toEqual(change.after)
    h.page = { pageId: '120000000000099', termsAccepted: true }
    expect(await create.undo!.current(change)).toBeNull()
  })
})

describe('set-meta-lead-form', () => {
  it('archive: one POST of the status, read back as asked; the record holds before → after', async () => {
    h.send.mockImplementationOnce(async () => ({ node: { id: FORM.formId, status: 'ARCHIVED' }, readBack: 'second-read', waitedMs: 0 }))
    const { preview, ran } = await run(set, { action: 'archive', formId: FORM.formId })
    expect(preview.preview.requests[0]).toMatchObject({ label: 'Archive lead form "Form A" (600000000000001)', metaCheck: 'no-check' })
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: FORM.formId, kind: 'leadform', params: { status: 'ARCHIVED' }, expect: { status: 'ARCHIVED' } })
    expect(ran!.data).toMatchObject({ from: 'ACTIVE', to: 'ARCHIVED', steps: [{ outcome: 'done', sentence: expect.stringMatching(/it now reads status ARCHIVED/) }] })
    expect((ran!.change!.after as Record<string, unknown>)).toMatchObject({ action: 'archive', status: 'ARCHIVED', formId: FORM.formId, pageId: FORM.pageId, accountId: 'm-1' })
    // Meta answered success but it reads back otherwise: not done, no record.
    h.send.mockImplementationOnce(async () => ({ node: { id: FORM.formId, status: 'ACTIVE' }, readBack: 'second-read', waitedMs: 0 }))
    const odd = await run(set, { action: 'archive', formId: FORM.formId })
    expect(odd.ran).toEqual({ ok: false, error: expect.stringMatching(/^Not confirmed: .*reads back status ACTIVE, not what was asked/) })
  })
  it('a form that is not the chosen Page\'s is refused before anything is sent', async () => {
    expect(await set.handler(set.input.parse({ action: 'archive', formId: '600000000000099' }) as Record<string, unknown>, asker)).toEqual({ ok: false, error: expect.stringMatching(/not one of the lead forms of the Facebook Page this business chose/) })
    expect(h.send).not.toHaveBeenCalled()
  })
  it('test lead: made with Nexus\'s answers, its id recorded; replaceTestLead deletes Nexus\'s old one first; undo deletes the new one', async () => {
    h.send.mockImplementationOnce(async () => ({ node: { id: '700000000000001' }, readBack: 'none', waitedMs: 0 }))
    const first = await run(set, { action: 'test-lead', formId: FORM.formId })
    expect(h.send.mock.calls[0][1]).toMatchObject({ kind: 'leadform', edge: 'test_leads', operation: 'testlead.create', skipReadBack: true })
    expect(first.ran!.data).toMatchObject({ testLeadId: '700000000000001', deletedFirst: [] })
    const change = first.ran!.change as { before: Record<string, unknown>; after: Record<string, unknown> }
    expect(change.after).toMatchObject({ action: 'test-lead', testLeadId: '700000000000001', formId: FORM.formId, pageId: FORM.pageId })
    const back = set.undo!.request(change)
    expect(back).toEqual({ tool: 'set-meta-lead-form', args: { connectionId: 'm-1', action: 'remove-test-lead', formId: FORM.formId, testLeadId: '700000000000001', confirmDelete: true, why: expect.any(String) } })
    expect(() => set.input.parse((back as { args: unknown }).args)).not.toThrow()
    h.testLeads = { ids: ['700000000000001'] }
    expect(await set.undo!.current(change)).toEqual(change.after)
    h.testLeads = { ids: [] }
    expect(await set.undo!.current(change)).not.toEqual(change.after)
    // A second test lead: refused unless replaceTestLead; then Nexus's own old one is deleted first.
    h.testLeads = { ids: ['700000000000001'] }
    h.nexusMade = ['700000000000001']
    expect(await set.handler(set.input.parse({ action: 'test-lead', formId: FORM.formId }) as Record<string, unknown>, asker)).toEqual({ ok: false, error: expect.stringMatching(/already has a test lead/) })
    h.send.mockReset()
    h.send.mockImplementationOnce(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 })).mockImplementationOnce(async () => ({ node: { id: '700000000000002' }, readBack: 'none', waitedMs: 0 }))
    const replaced = await run(set, { action: 'test-lead', formId: FORM.formId, replaceTestLead: true })
    expect(h.send.mock.calls.map((c) => [c[1].operation, c[1].objectId, c[1].method ?? 'POST'])).toEqual([['testlead.delete', '700000000000001', 'DELETE'], ['testlead.create', FORM.formId, 'POST']])
    expect(replaced.ran!.data).toMatchObject({ testLeadId: '700000000000002', deletedFirst: ['700000000000001'] })
    expect((replaced.ran!.change!.after as Record<string, unknown>)).toMatchObject({ testLeadId: '700000000000002', replaced: ['700000000000001'] })
  })
  it('remove-test-lead: only on an explicit ask, only a test lead Nexus made; a deleted one has no undo', async () => {
    const ask = (args: Record<string, unknown>) => set.handler(set.input.parse({ action: 'remove-test-lead', formId: FORM.formId, ...args }) as Record<string, unknown>, asker)
    expect(await ask({ testLeadId: '700000000000001' })).toEqual({ ok: false, error: expect.stringMatching(/explicit ask: name testLeadId and confirmDelete: true/) })
    h.testLeads = { ids: ['700000000000009'] }
    expect(await ask({ testLeadId: '700000000000009', confirmDelete: true })).toEqual({ ok: false, error: expect.stringMatching(/never a real lead/) })
    h.testLeads = { ids: ['700000000000001'] }
    h.nexusMade = ['700000000000001']
    h.send.mockImplementationOnce(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 }))
    const { ran } = await run(set, { action: 'remove-test-lead', formId: FORM.formId, testLeadId: '700000000000001', confirmDelete: true })
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: '700000000000001', kind: 'testlead', method: 'DELETE', params: {} })
    expect(ran!.data).toMatchObject({ deleted: ['700000000000001'], steps: [{ outcome: 'done', sentence: expect.stringMatching(/Meta confirmed it/) }] })
    expect(set.undo!.request(ran!.change as { before: unknown; after: unknown })).toEqual({ refusal: expect.stringMatching(/cannot come back/) })
    expect(() => set.input.parse({ action: 'remove-test-lead', formId: FORM.formId, testLeadId: '1', confirmDelete: false })).toThrow()
  })
  it('archive ⇄ re-activate undo each other', () => {
    const rec = (action: string, status: string) => ({ action, pageId: FORM.pageId, formId: FORM.formId, name: 'Form A', status, accountId: 'm-1', adAccountId: '1234567890' })
    expect(set.undo!.request({ before: rec('archive', 'ACTIVE'), after: rec('archive', 'ARCHIVED') })).toMatchObject({ tool: 'set-meta-lead-form', args: { action: 'activate', formId: FORM.formId } })
    expect(set.undo!.request({ before: rec('activate', 'ARCHIVED'), after: rec('activate', 'ACTIVE') })).toMatchObject({ tool: 'set-meta-lead-form', args: { action: 'archive', formId: FORM.formId } })
  })
})

describe('review round 1', () => {
  it('A3 — the plan hash names method, edge and kind only when a request sets them: a status change\'s hash is step 17\'s, byte for byte', () => {
    const status = { step: 1, label: 'Pause', kind: 'campaign' as const, objectId: '120000000000001', params: { status: 'PAUSED' }, check: 'meta' as const, raisesSpend: false, readBackInPost: true, budget: false, undoable: true }
    const draft = (requests: unknown[]) => ({ summary: '', changes: {}, totals: {}, warnings: [], spendsMoney: [], skipped: [], requests, stands: null, before: null, after: null }) as never
    expect(planOf(draft([status]))).toBe(factHash([{ objectId: '120000000000001', params: { status: 'PAUSED' } }]))
    const del = { ...status, kind: undefined, objectKind: 'testlead', method: 'DELETE', params: {} }
    const post = { ...del, method: undefined, edge: 'test_leads', objectKind: 'leadform' }
    expect(planOf(draft([del]))).not.toBe(planOf(draft([{ ...del, method: undefined }])))
    expect(planOf(draft([post]))).not.toBe(planOf(draft([{ ...post, edge: undefined }])))
  })
  it('A4 — re-activating a form is marked SPENDS MONEY in the preview', async () => {
    h.form = { ...FORM, status: 'ARCHIVED' }
    const p = (await set.handler(set.input.parse({ action: 'activate', formId: FORM.formId }) as Record<string, unknown>, asker)) as Out
    expect(p.preview.spendsMoney).toBe(true)
    expect(p.preview.warnings[0]).toMatch(/^SPENDS MONEY \(your decision\): an ad that uses this form may deliver again/)
  })
  it('B2 — a file the person gives is not uploaded: the tool says so and where to add it', () => {
    expect(create.description).toMatch(/Nexus does not upload a file you give .*Meta's Forms library/)
  })
})
