/**
 * Meta step 40 — set-meta-account-settings, set-meta-spend-cap and set-meta-insights-features as the approval gate uses
 * them (Meta, the account and the live reads are stand-ins): the change contract of every Meta change tool; a preview from
 * the live state (SPENDS MONEY on a raise, a removal and a reset; "Meta has no check"); the brake; a run only as a request a
 * person approved, the request sent as the kit builds it; a disabled ad account refused at the preview AND at the run;
 * Meta's 10-a-day limit in plain words, never sent again; undo reads the account live and puts back what was replaced
 * through the same tool; no undo where Meta has none (a reset, an insights feature). Made-up ids and names.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown> | { refusal: string },
  state: {} as Record<string, unknown>,
  agency: { declaration: {} } as unknown,
  tracking: [] as unknown[],
  feature: { name: 'impression_device', offered: true, enabled: false, dataFrom: null } as Record<string, unknown>,
  send: vi.fn(),
  stateReads: 0,
}))
vi.mock('../../marketing/meta-ads/change-account.js', () => ({ metaChangeAccount: vi.fn(async () => h.account) }))
vi.mock('../../marketing/meta-ads/live-account-settings.js', () => ({
  liveAccountState: vi.fn(async () => { h.stateReads += 1; return structuredClone(h.state) }),
  liveAgencyDeclaration: vi.fn(async () => structuredClone(h.agency)),
  liveTrackingSpecs: vi.fn(async () => structuredClone(h.tracking)),
  liveInsightsFeature: vi.fn(async () => structuredClone(h.feature)),
}))
vi.mock('../../marketing/meta-ads/live-settings.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live-settings.js')>()),
  liveAccountPixels: vi.fn(async () => new Set(['120000000000050'])),
}))
vi.mock('../../marketing/meta-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/write-client.js')>()),
  metaSendChange: h.send,
}))

import { META_ADS_ACCOUNT_SETTINGS_TOOLS } from './meta-ads-account-settings.tools.js'
import { META_CHANGE_RULES } from './meta-ads-kit.js'
import { MetaWriteError } from '../../marketing/meta-ads/write-client.js'
import { liveTrackingSpecs } from '../../marketing/meta-ads/live-account-settings.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import type { AgentTool, ToolContext, ToolResult } from '../tool-types.js'

const tool = (name: string) => META_ADS_ACCOUNT_SETTINGS_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown, extra: Partial<ToolContext> = {}): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview, ...extra })
const ask = (t: AgentTool, args: Record<string, unknown>) => t.input.parse(args) as Record<string, unknown>
const preview = async (name: string, args: Record<string, unknown>, ctx = asker) => (await tool(name).handler(ask(tool(name), args), ctx)) as ToolResult & { preview: Record<string, any> }
const run = async (name: string, args: Record<string, unknown>, p: unknown, extra: Partial<ToolContext> = {}) => (await tool(name).execute!(ask(tool(name), args), approved(p, extra))) as ToolResult & { data: Record<string, any> }

const PAGE = '120000000000080'
const PIXEL = '120000000000050'
const STATE = {
  adAccountId: '1234567890', status: 1, disableReason: 0, currency: 'EUR', name: 'Shop A ads',
  businessInfo: { business_name: 'Shop A', business_street: 'Via A 1', business_street2: null, business_city: 'Città A', business_state: null, business_zip: '00100', business_country_code: 'IT' },
  businessUse: true, dsa: { payor: null, beneficiary: null }, notifications: true,
  parties: { end_advertiser: null, media_agency: 'NONE', partner: 'UNFOUND' }, spendCap: '50000', amountSpent: '12000', pageId: PAGE,
}

beforeEach(() => {
  __metaObjectLimitsTest.useMemory()
  vi.unstubAllEnvs()
  h.send.mockReset()
  h.account = { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' }
  h.state = structuredClone(STATE)
  h.agency = { declaration: {} }
  h.tracking = []
  h.feature = { name: 'impression_device', offered: true, enabled: false, dataFrom: null }
  h.stateReads = 0
})

describe('the tools', () => {
  it('each is a change a person always approves, the #691 truth, its MATERIAL fields, the right undo / reversibility', () => {
    for (const name of ['set-meta-account-settings', 'set-meta-spend-cap', 'set-meta-insights-features']) {
      const t = tool(name)
      expect(t, name).toMatchObject({ readOnly: false, alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, category: 'advertising' })
      expect(t.description.endsWith(META_CHANGE_RULES), name).toBe(true)
      expect(t.description, name).toMatch(/disabled, risk-reviewed, closing, closed or compromised/)
      expect(MATERIAL_PREVIEW_FIELDS[name], name).toEqual(['basis', 'plan', 'reach'])
    }
    expect(tool('set-meta-account-settings')).toMatchObject({ reversibility: 'partial', requires: ['ads.campaigns.manage'] })
    expect(tool('set-meta-spend-cap')).toMatchObject({ reversibility: 'partial', requires: ['ads.campaigns.manage', 'financials.adspend.view'] })
    expect(tool('set-meta-spend-cap').restrictedFields).toMatchObject({ changes: 'financials.adspend.view', spendsMoneyBecause: 'financials.adspend.view', steps: 'financials.adspend.view', fromCents: 'financials.adspend.view' })
    expect(tool('set-meta-insights-features')).toMatchObject({ reversibility: 'none' })
    expect(tool('set-meta-insights-features').undo).toBeUndefined()
    expect(tool('set-meta-spend-cap').consequencesFor!({ action: 'reset' })).toEqual({ reversibility: 'none' })
    expect(tool('set-meta-spend-cap').consequencesFor!({ action: 'raise', capCents: 1 })).toEqual({ reversibility: 'full' })
    expect(tool('set-meta-account-settings').consequencesFor!({ endAdvertiser: 'chosen-page' })).toEqual({ reversibility: 'none' })
    expect(tool('set-meta-account-settings').consequencesFor!({ endAdvertiser: 'chosen-page', name: 'Shop B' })).toBeNull()
    // The words the leader asked for: the system user's own notifications; AS-108 deprecated; a reset has no undo.
    expect(tool('set-meta-account-settings').description).toMatch(/SYSTEM USER's own notifications, NOT the Owner's/)
    expect(tool('set-meta-account-settings').description).toMatch(/set attribution per ad set \(set-meta-ad-set attribution\)/)
    expect(tool('set-meta-spend-cap').description).toMatch(/a RESET has NO undo/)
    expect(tool('set-meta-insights-features').description).toMatch(/THIS CANNOT BE UNDONE/)
    // Text a person types: no format character; a spend cap of 0 is not even an argument; never currency or time zone.
    expect(() => tool('set-meta-account-settings').input.parse({ name: 'Shop ‮A' })).toThrow()
    expect(() => tool('set-meta-account-settings').input.parse({ dsa: { payor: 'Shop A' } })).toThrow()
    expect(() => tool('set-meta-account-settings').input.parse({ endAdvertiser: '120000000000081' })).toThrow()
    expect(() => tool('set-meta-spend-cap').input.parse({ action: 'set', capCents: 0 })).toThrow()
    expect(tool('set-meta-account-settings').input.parse({ trackingSpecs: [] })).toEqual({ trackingSpecs: [] })
    // Last pass — any limit Nexus can read is a limit its undo can set again (IDR, VND, KRW limits are large).
    expect(tool('set-meta-spend-cap').input.safeParse({ action: 'set', capCents: 9_000_000_000_000_000 }).success).toBe(true)
    expect(tool('set-meta-spend-cap').input.safeParse({ action: 'set', capCents: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false)
    expect(Object.keys(tool('set-meta-account-settings').input.parse({ currency: 'USD', timezoneId: 1, attributionSpec: [] }) as object)).toEqual([])
  })
})

describe('set-meta-spend-cap', () => {
  it('a raise: SPENDS MONEY, the standard string with the currency, Meta has no check, basis and plan stable', async () => {
    const out = await preview('set-meta-spend-cap', { action: 'raise', capCents: 75000 })
    expect(out.ok).toBe(true)
    expect(out.preview).toMatchObject({ spendsMoney: true, requests: [{ step: 1, metaCheck: 'no-check' }], metaCheck: { checked: 'none' } })
    expect(out.preview.warnings[0]).toMatch(/^SPENDS MONEY \(your decision\): The spending limit goes up from 500\.00 EUR to 750\.00 EUR/)
    expect(Object.values(out.preview.changes)[0]).toMatchObject({ to: expect.stringMatching(/^"750\.00" EUR — Nexus counted 75000 minor units in 2 decimals/) })
    const again = await preview('set-meta-spend-cap', { action: 'raise', capCents: 75000 }, { ...asker, approvalId: 'ap-1' })
    expect([again.preview.basis, again.preview.plan]).toEqual([out.preview.basis, out.preview.plan])
    expect(h.send).not.toHaveBeenCalled()
  })
  it('the brake: with Meta changes switched off the preview says so and the run sends nothing', async () => {
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'off')
    const p = (await preview('set-meta-spend-cap', { action: 'lower', capCents: 40000 })).preview
    expect(p.warnings.join(' ')).toMatch(/NEXUS_META_ADS_WRITES=off/)
    const ran = await run('set-meta-spend-cap', { action: 'lower', capCents: 40000 }, p)
    expect(ran).toEqual({ ok: false, error: expect.stringMatching(/switched off in Nexus/) })
    expect(h.send).not.toHaveBeenCalled()
  })
  it('runs as approved: the request as the kit builds it, read back, recorded; undo reads the limit live and sets the old one again', async () => {
    const p = (await preview('set-meta-spend-cap', { action: 'raise', capCents: 75000 })).preview
    h.send.mockImplementationOnce(async () => ({ node: { id: 'act_1234567890', spend_cap: '75000', amount_spent: '12000', currency: 'EUR' }, readBack: 'same-request', waitedMs: 0 }))
    const ran = await run('set-meta-spend-cap', { action: 'raise', capCents: 75000 }, p)
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toEqual({
      objectId: 'act_1234567890', kind: 'adaccount', params: { spend_cap: '750.00' }, operation: 'account.spendCap', budget: false, readBackInPost: true,
      expect: { spend_cap: '75000', currency: 'EUR' }, readBackFields: 'id,spend_cap,amount_spent,currency',
    })
    expect(ran.data).toMatchObject({ fromCents: 50000, toCents: 75000, amountSpentCents: 12000, steps: [{ outcome: 'done', sentence: expect.stringMatching(/it now reads spend_cap 75000/) }] })
    expect(ran.change!.after).toEqual({ kind: 'spendcap', id: '1234567890', action: 'raise', fields: { spend_cap: '75000' }, accountId: 'm-1', adAccountId: '1234567890' })
    const t = tool('set-meta-spend-cap')
    h.state = { ...STATE, spendCap: '75000' }
    expect(await t.undo!.current(ran.change!)).toEqual(ran.change!.after)
    h.state = { ...STATE, spendCap: '80000' }
    expect(await t.undo!.current(ran.change!)).not.toEqual(ran.change!.after)
    const back = t.undo!.request(ran.change!)
    expect(back).toEqual({ tool: 'set-meta-spend-cap', args: { connectionId: 'm-1', action: 'set', capCents: 50000, why: 'undo of an earlier change of the Meta spending limit' } })
    expect(t.input.safeParse((back as { args: unknown }).args).success).toBe(true)
  })
  it('Meta said success but reads back another limit: not recorded as done, never sent again', async () => {
    const p = (await preview('set-meta-spend-cap', { action: 'raise', capCents: 75000 })).preview
    h.send.mockImplementationOnce(async () => ({ node: { id: 'act_1234567890', spend_cap: '50000' }, readBack: 'same-request', waitedMs: 0 }))
    const ran = await run('set-meta-spend-cap', { action: 'raise', capCents: 75000 }, p)
    expect(ran).toEqual({ ok: false, error: expect.stringMatching(/^Not confirmed: 1\. .*reads back spend_cap 50000, currency \(not sent back\), not what was asked \(spend_cap\)/) })
    expect(h.send).toHaveBeenCalledTimes(1)
  })
  it('fix round 1 (A-F6) — the currency is read back and judged: a limit in another currency is never recorded as done', async () => {
    const p = (await preview('set-meta-spend-cap', { action: 'raise', capCents: 75000 })).preview
    h.send.mockImplementationOnce(async () => ({ node: { id: 'act_1234567890', spend_cap: '75000', currency: 'USD' }, readBack: 'same-request', waitedMs: 0 }))
    const ran = await run('set-meta-spend-cap', { action: 'raise', capCents: 75000 }, p)
    expect(ran).toEqual({ ok: false, error: expect.stringMatching(/^Not confirmed: 1\. .*not what was asked \(currency\)/) })
  })
  it('Meta\'s 10 changes a day (17/1885172): said in plain words, never retried', async () => {
    const p = (await preview('set-meta-spend-cap', { action: 'remove' })).preview
    h.send.mockImplementationOnce(async () => { throw new MetaWriteError({ origin: 'meta', httpStatus: 400, code: '17/1885172', authLost: false, throttled: true, permissionDenied: false, notFound: false, sentence: 'Meta asked Nexus to slow down (17/1885172).' }, 'account.spendCap', 'refused') })
    const ran = await run('set-meta-spend-cap', { action: 'remove' }, p)
    expect(ran).toEqual({ ok: false, error: expect.stringMatching(/Meta allows 10 changes of an ad account's spending limit a day .* Nexus does not try again — ask again tomorrow/) })
    // Fix round 1 (B-1) — a daily count, not a throttle: the step says Meta refused it (it was sent), not "not sent".
    expect(ran.error).toMatch(/^Not run: Meta changed nothing\. 1\./)
    expect(h.send).toHaveBeenCalledTimes(1)
  })
  it('a reset: SPENDS MONEY, no undo — the run says so and undo refuses', async () => {
    const p = (await preview('set-meta-spend-cap', { action: 'reset' })).preview
    expect(p.spendsMoney).toBe(true)
    expect(p.warnings.join(' ')).toMatch(/NO undo/)
    h.send.mockImplementationOnce(async () => ({ node: { id: 'act_1234567890', spend_cap: '50000', amount_spent: '0' }, readBack: 'same-request', waitedMs: 0 }))
    const ran = await run('set-meta-spend-cap', { action: 'reset' }, p)
    expect(ran.data.steps[0]).toMatchObject({ outcome: 'done', sentence: expect.stringMatching(/amount spent now reads 0\.00 EUR/) })
    expect(tool('set-meta-spend-cap').undo!.request(ran.change!)).toEqual({ refusal: expect.stringMatching(/Meta has no way to put the old amount spent back/) })
  })
  it('a disabled ad account: refused at the preview; one disabled between the approval and the run: refused, nothing sent', async () => {
    h.state = { ...STATE, status: 2, disableReason: 1 }
    expect(await preview('set-meta-spend-cap', { action: 'lower', capCents: 40000 })).toEqual({ ok: false, error: expect.stringMatching(/ad account 1234567890 is disabled .*Nexus changes nothing on an ad account Meta has disabled/) })
    h.state = structuredClone(STATE)
    const p = (await preview('set-meta-spend-cap', { action: 'lower', capCents: 40000 })).preview
    h.state = { ...STATE, status: 101 }
    const ran = await run('set-meta-spend-cap', { action: 'lower', capCents: 40000 }, p)
    expect(ran).toEqual({ ok: false, error: expect.stringMatching(/^Not run: Nothing was asked of Meta: ad account 1234567890 is closed/) })
    expect(h.send).not.toHaveBeenCalled()
    // One read before the preview, one at the run: the status is read each time.
    expect(h.stateReads).toBe(3)
  })
  it('never by a rule: a request decided automatically does not run', async () => {
    const p = (await preview('set-meta-spend-cap', { action: 'lower', capCents: 40000 })).preview
    const ran = await run('set-meta-spend-cap', { action: 'lower', capCents: 40000 }, p, { decidedVia: 'auto' })
    expect(ran.ok).toBe(false)
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('set-meta-account-settings', () => {
  it('a rename and tracking specs: two requests in order, read back; the record and undo put back both', async () => {
    h.tracking = []
    const args = { name: 'Shop B ads', trackingSpecs: [{ kind: 'pixel', pixelId: PIXEL }] }
    const out = await preview('set-meta-account-settings', args)
    expect(out.ok).toBe(true)
    expect(out.preview).toMatchObject({ spendsMoney: false, requests: [{ step: 1, metaCheck: 'no-check' }, { step: 2, metaCheck: 'no-check' }] })
    h.send.mockImplementationOnce(async () => ({ node: { id: 'act_1234567890', name: 'Shop B ads' }, readBack: 'same-request', waitedMs: 0 }))
    h.send.mockImplementationOnce(async () => { h.tracking = [{ 'action.type': ['offsite_conversion'], fb_pixel: [PIXEL] }]; return { node: { success: true }, readBack: 'none', waitedMs: 31_000 } })
    const ran = await run('set-meta-account-settings', args, out.preview)
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls.map((c) => [c[1].operation, c[1].objectId, c[1].edge ?? null, c[1].params])).toEqual([
      ['account.settings', 'act_1234567890', null, { name: 'Shop B ads' }],
      ['account.tracking', 'act_1234567890', 'tracking', { tracking_specs: `[{"action.type":["offsite_conversion"],"fb_pixel":["${PIXEL}"]}]` }],
    ])
    expect(ran.data.steps[1]).toMatchObject({ outcome: 'done', sentence: expect.stringMatching(/now holds 1 tracking spec: exactly the list asked/) })
    expect(ran.change!.after).toMatchObject({ kind: 'adaccount', id: '1234567890', fields: { name: 'Shop B ads', tracking_specs: expect.any(String) }, accountId: 'm-1' })
    const t = tool('set-meta-account-settings')
    h.state = { ...STATE, name: 'Shop B ads' }
    expect(await t.undo!.current(ran.change!)).toEqual(ran.change!.after)
    const back = t.undo!.request(ran.change!)
    // Fix round 1 (B-3) — the account had no specs: no undo would send an empty list (the new spec may stay for good, said).
    expect(back).toEqual({ tool: 'set-meta-account-settings', args: expect.objectContaining({ connectionId: 'm-1', name: 'Shop A ads' }) })
    expect((back as { args: Record<string, unknown> }).args.trackingSpecs).toBeUndefined()
    expect(out.preview.warnings.join(' ')).toMatch(/may stay FOR GOOD/)
    expect(t.input.safeParse((back as { args: unknown }).args).success).toBe(true)
  })
  it('a partial run: the settings made, the tracking specs refused — the record and its undo hold only the settings', async () => {
    // The account holds a spec already, so the change has a tracking undo — which must go when its step did not happen.
    h.tracking = [{ 'action.type': ['like'], page: [PAGE] }]
    const args = { name: 'Shop B ads', trackingSpecs: [{ kind: 'pixel', pixelId: PIXEL }] }
    const p = (await preview('set-meta-account-settings', args)).preview
    h.send.mockImplementationOnce(async () => ({ node: { id: 'act_1234567890', name: 'Shop B ads' }, readBack: 'same-request', waitedMs: 0 }))
    h.send.mockImplementationOnce(async () => { throw new MetaWriteError({ origin: 'meta', httpStatus: 400, code: '100', authLost: false, throttled: false, permissionDenied: false, notFound: false, sentence: 'Meta refused it (100). Nothing was changed.' }, 'account.tracking', 'refused') })
    const ran = await run('set-meta-account-settings', args, p)
    expect(ran.ok).toBe(true)
    expect(ran.data.steps.map((s: { outcome: string }) => s.outcome)).toEqual(['done', 'refused'])
    expect(ran.change!.after).toMatchObject({ fields: { name: 'Shop B ads' } })
    expect(Object.keys((ran.change!.after as { fields: object }).fields)).toEqual(['name'])
    expect((ran.change!.before as { undo: Record<string, unknown> }).undo).toEqual({ name: 'Shop A ads' })
  })
  it('a tracking POST Meta answered success but whose read-back lacks the spec asked: not recorded as done', async () => {
    const args = { trackingSpecs: [{ kind: 'pixel', pixelId: PIXEL }] }
    const p = (await preview('set-meta-account-settings', args)).preview
    h.send.mockImplementationOnce(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 }))
    const ran = await run('set-meta-account-settings', args, p)
    expect(ran).toEqual({ ok: false, error: expect.stringMatching(/^Not confirmed: 1\. .*reads back .*asked_specs missing/) })
  })
  it('a tracking POST Meta ADDED to (the old specs stay): said, and still done', async () => {
    h.tracking = [{ 'action.type': ['like'], page: [PAGE] }]
    const args = { trackingSpecs: [{ kind: 'pixel', pixelId: PIXEL }] }
    const p = (await preview('set-meta-account-settings', args)).preview
    h.send.mockImplementationOnce(async () => { h.tracking = [{ 'action.type': ['like'], page: [PAGE] }, { 'action.type': ['offsite_conversion'], fb_pixel: [PIXEL] }]; return { node: { success: true }, readBack: 'none', waitedMs: 0 } })
    const ran = await run('set-meta-account-settings', args, p)
    expect(ran.data.steps[0].sentence).toMatch(/the list asked and 1 more \(Meta ADDED to the list/)
  })
  it('a rename that does not read back as asked: not recorded as done, never sent again', async () => {
    const args = { name: 'Shop B ads', notifications: false }
    const p = (await preview('set-meta-account-settings', args)).preview
    expect(p.warnings.join(' ')).toMatch(/SYSTEM USER's own notifications/)
    h.send.mockImplementationOnce(async () => ({ node: { id: 'act_1234567890', name: 'Shop A ads', is_notifications_enabled: false }, readBack: 'same-request', waitedMs: 0 }))
    const ran = await run('set-meta-account-settings', args, p)
    expect(ran).toEqual({ ok: false, error: expect.stringMatching(/^Not confirmed: 1\. .*reads back name Shop A ads/) })
  })
  it('an end advertiser set to the chosen Page: FOR GOOD — the preview says so, the record has no undo', async () => {
    const p = (await preview('set-meta-account-settings', { endAdvertiser: 'chosen-page' })).preview
    expect(p.warnings.join(' ')).toMatch(/one-way/)
    h.send.mockImplementationOnce(async () => ({ node: { id: 'act_1234567890', end_advertiser: PAGE }, readBack: 'same-request', waitedMs: 0 }))
    const ran = await run('set-meta-account-settings', { endAdvertiser: 'chosen-page' }, p)
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls[0][1].params).toEqual({ end_advertiser: PAGE })
    expect(tool('set-meta-account-settings').undo!.request(ran.change!)).toEqual({ refusal: expect.stringMatching(/FOR GOOD/) })
  })
  it('the agency declaration is read back after the POST and judged; the e-mail is never sent', async () => {
    h.agency = { declaration: { client_name: 'Client A' } }
    const args = { agencyDeclaration: { confirmAgency: true, clientName: 'Client B' } }
    const p = (await preview('set-meta-account-settings', args)).preview
    h.send.mockImplementationOnce(async () => { h.agency = { declaration: { client_name: 'Client B' } }; return { node: { id: 'act_1234567890' }, readBack: 'same-request', waitedMs: 0 } })
    const ran = await run('set-meta-account-settings', args, p)
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls[0][1].params).toEqual({ agency_client_declaration: '{"client_name":"Client B"}' })
    expect(ran.change!.after).toMatchObject({ fields: { agency_client_declaration: '{"client_name":"Client B"}' } })
    expect(tool('set-meta-account-settings').undo!.request(ran.change!)).toMatchObject({ args: { agencyDeclaration: { confirmAgency: true, clientName: 'Client A' } } })
  })
  it('last pass (B-4) — a business key sent that Meta leaves out of the read-back is not as asked; one sent empty may be left out', async () => {
    const args = { businessInfo: { city: 'Città B', zip: null } }
    const p = (await preview('set-meta-account-settings', args)).preview
    h.send.mockImplementationOnce(async () => ({ node: { id: 'act_1234567890', business_name: 'Shop A', business_city: 'Città B', business_country_code: 'IT' }, readBack: 'same-request', waitedMs: 0 }))
    const ran = await run('set-meta-account-settings', args, p)
    expect(ran).toEqual({ ok: false, error: expect.stringMatching(/^Not confirmed: 1\. .*business_street \(not sent back\).*not what was asked \(business_street\)/) })
    h.send.mockImplementationOnce(async () => ({ node: { id: 'act_1234567890', business_name: 'Shop A', business_street: 'Via A 1', business_city: 'Città B', business_country_code: 'IT' }, readBack: 'same-request', waitedMs: 31_000 }))
    const ok = await run('set-meta-account-settings', args, p)
    expect(ok.ok).toBe(true)
    expect(ok.change!.after).toMatchObject({ fields: { business_city: 'Città B', business_zip: null } })
  })
  it('last pass — undo of a tracking change refuses when Meta holds a list Nexus cannot read in full', async () => {
    h.tracking = [{ 'action.type': ['like'], page: [PAGE] }]
    const args = { trackingSpecs: [{ kind: 'pixel', pixelId: PIXEL }] }
    const p = (await preview('set-meta-account-settings', args)).preview
    h.send.mockImplementationOnce(async () => { h.tracking = [{ 'action.type': ['offsite_conversion'], fb_pixel: [PIXEL] }]; return { node: { success: true }, readBack: 'none', waitedMs: 0 } })
    const ran = await run('set-meta-account-settings', args, p)
    expect(ran.ok).toBe(true)
    const { MetaLiveRefusal } = await import('../../marketing/meta-ads/live.js')
    vi.mocked(liveTrackingSpecs).mockImplementationOnce(async () => { throw new MetaLiveRefusal('more than 20') })
    expect(await tool('set-meta-account-settings').undo!.current(ran.change!)).toBeNull()
  })
  it('a disabled ad account: refused before anything else is read', async () => {
    h.state = { ...STATE, status: 7 }
    vi.mocked(liveTrackingSpecs).mockClear()
    expect(await preview('set-meta-account-settings', { name: 'Shop B ads', trackingSpecs: [] })).toEqual({ ok: false, error: expect.stringMatching(/pending risk review/) })
    expect(h.send).not.toHaveBeenCalled()
    expect(liveTrackingSpecs).not.toHaveBeenCalled()
  })
})

describe('set-meta-insights-features', () => {
  it('one-way: the preview says it cannot be undone; the run reads the features back; no undo', async () => {
    const out = await preview('set-meta-insights-features', { feature: 'impression_device' })
    expect(out.ok).toBe(true)
    expect(out.preview.warnings.join(' ')).toMatch(/CANNOT BE UNDONE/)
    h.send.mockImplementationOnce(async () => { h.feature = { ...h.feature, enabled: true, dataFrom: '2026-10-22' }; return { node: { id: 'act_1234567890' }, readBack: 'none', waitedMs: 0 } })
    const ran = await run('set-meta-insights-features', { feature: 'impression_device' }, out.preview)
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: 'act_1234567890', kind: 'adaccount', edge: 'insights/feature-settings', params: { feature_name: 'impression_device' } })
    expect(ran.data.steps[0].sentence).toMatch(/Meta switched it on; data from 2026-10-22/)
  })
  it('already on: refused, nothing sent', async () => {
    h.feature = { ...h.feature, enabled: true, dataFrom: '2026-07-15' }
    expect(await preview('set-meta-insights-features', { feature: 'impression_device' })).toEqual({ ok: false, error: expect.stringMatching(/already switched on/) })
    expect(h.send).not.toHaveBeenCalled()
  })
})
