/**
 * Meta step 31 — create-meta-audience, set-meta-audience, set-meta-audience-members, set-meta-audience-sharing and
 * remove-meta-audience as the approval gate uses them (Meta, the account and the live reads are stand-ins): the change
 * contract of every Meta change tool; previews built from the live state (terms signed first, every id the business's
 * own, the WHOLE existing-customer list read first, the ads a delete or unshare stops listed); D8 — nobody is added,
 * opt-outs go out as hashes only and no hash reaches a preview, an answer or a record; runs only as a request a person
 * approved; undo deletes what a create made, puts back what a change replaced, and is none where Meta has none.
 * Made-up ids, example.com addresses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown>,
  terms: { signed: true, signLink: 'https://business.facebook.com/ads/manage/customaudiences/tos/?act=1234567890', existingCustomers: [] as string[] | null, existingProblem: null as string | null },
  audiences: {} as Record<string, Record<string, unknown>>,
  use: { ads: [] as Array<Record<string, unknown>>, activeAds: 0, otherAccounts: [] as Array<Record<string, unknown>>, more: false },
  sharing: { accounts: [] as string[], problem: null as string | null },
  tags: null as Record<string, string> | null,
  idProblems: [] as string[],
  sameName: { ids: [] as string[], checked: true },
  people: { hashes: [] as string[], skipped: 0 },
  existingUsers: { adSets: [] as Array<Record<string, unknown>>, problem: null as string | null },
  termsRead: vi.fn(),
  send: vi.fn(),
  check: vi.fn(async () => undefined),
}))
vi.mock('../../marketing/meta-ads/change-account.js', () => ({ metaChangeAccount: vi.fn(async () => h.account) }))
vi.mock('../../marketing/meta-ads/live-audience-change.js', async () => {
  const { MetaLiveRefusal } = await import('../../marketing/meta-ads/live.js')
  const detail = (id: string) => {
    const a = h.audiences[id]
    if (!a) throw new MetaLiveRefusal('That audience is not the chosen ad account\'s, nor shared with it, so it is not read.')
    if (a.sharedIn) throw new MetaLiveRefusal(`Audience ${id} is shared with the chosen ad account by its owner: Nexus never changes an audience another account owns (its owner changes it).`)
    return structuredClone(a)
  }
  return {
    chosenOf: vi.fn(async () => ({ connectionId: 'm-1', adAccountId: '1234567890', pageId: '120000000000080', instagramId: '170000000000001', businessId: '120000000000090' })),
    liveTerms: vi.fn(async () => { h.termsRead(); return structuredClone(h.terms) }),
    liveAudienceDetail: vi.fn(async (_a: unknown, id: string) => detail(id)),
    changeableAudience: vi.fn(async (_a: unknown, id: string) => {
      const audience = detail(id)
      if (h.sharing.problem) throw new MetaLiveRefusal(h.sharing.problem)
      return { audience, sharing: structuredClone(h.sharing) }
    }),
    liveAudienceSharing: vi.fn(async () => structuredClone(h.sharing)),
    liveAudienceUse: vi.fn(async () => structuredClone(h.use)),
    liveAudienceTypeTags: vi.fn(async () => (h.tags ? { ...h.tags } : null)),
    liveAudiencesNamed: vi.fn(async () => structuredClone(h.sameName)),
    liveIdProblems: vi.fn(async () => [...h.idProblems]),
    liveExistingCustomerUsers: vi.fn(async () => structuredClone(h.existingUsers)),
  }
})
vi.mock('../../marketing/meta-ads/audience-members.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/audience-members.js')>()),
  optedOutPeople: vi.fn(async () => structuredClone(h.people)),
}))
vi.mock('../../marketing/meta-ads/live-audiences.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live-audiences.js')>()),
  ownAudience: vi.fn(async (_a: unknown, id: string) => {
    if (!h.audiences[id]) { const { MetaLiveRefusal } = await import('../../marketing/meta-ads/live.js'); throw new MetaLiveRefusal('not the account\'s') }
    return { audienceId: id, sharedIn: false }
  }),
}))
vi.mock('../../marketing/meta-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/write-client.js')>()),
  metaCheckChange: h.check,
  metaSendChange: h.send,
}))

import { createHash } from 'node:crypto'
import { META_ADS_AUDIENCE_CHANGES_TOOLS } from './meta-ads-audience-changes.tools.js'
import { META_CHANGE_RULES } from './meta-ads-kit.js'
import { NO_CONSENT } from '../../marketing/meta-ads/audience-members.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import type { AgentTool, ToolContext, ToolResult } from '../tool-types.js'

const tool = (name: string) => META_ADS_AUDIENCE_CHANGES_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const ask = (t: AgentTool, args: Record<string, unknown>) => t.input.parse(args) as Record<string, unknown>
const preview = async (name: string, args: Record<string, unknown>, ctx = asker) => (await tool(name).handler(ask(tool(name), args), ctx)) as ToolResult & { preview: Record<string, any> }
const run = async (name: string, args: Record<string, unknown>, p: unknown) => (await tool(name).execute!(ask(tool(name), args), approved(p))) as ToolResult & { data: Record<string, any> }
const hash = (email: string) => createHash('sha256').update(email).digest('hex')

const A = '120000000000040'
const L = '120000000000041'
const PIXEL = '120000000000050'
const LIST = {
  id: A, name: 'List A', subtype: 'CUSTOM', description: null, rule: null, lookalikeSpec: null, lookalikeIds: [] as string[], optOutLink: null,
  customerFileSource: 'USER_PROVIDED_ONLY', retentionDays: 30, isValueBased: false, labels: null, operationCode: 200, flagged: false, flaggedFields: [], deliveryCode: 200,
}
const WEBSITE_RULE = { inclusions: { operator: 'or', rules: [{ event_sources: [{ id: PIXEL, type: 'pixel' }], retention_seconds: 2592000, filter: { operator: 'and', filters: [{ field: 'url', operator: 'i_contains', value: 'helmets' }] } }] } }
const VISITORS = { ...LIST, id: '120000000000042', name: 'Visitors A', subtype: 'WEBSITE', rule: JSON.stringify(WEBSITE_RULE), customerFileSource: null, retentionDays: null }

beforeEach(() => {
  __metaObjectLimitsTest.useMemory()
  vi.unstubAllEnvs()
  vi.stubEnv('NEXUS_META_ADS_WRITES', 'on')
  h.send.mockReset(); h.termsRead.mockReset(); h.check.mockReset()
  h.terms = { signed: true, signLink: 'https://business.facebook.com/ads/manage/customaudiences/tos/?act=1234567890', existingCustomers: [], existingProblem: null }
  h.audiences = { [A]: structuredClone(LIST), [VISITORS.id]: structuredClone(VISITORS) }
  h.use = { ads: [], activeAds: 0, otherAccounts: [], more: false }
  h.sharing = { accounts: [], problem: null }
  h.tags = null
  h.idProblems = []
  h.sameName = { ids: [], checked: true }
  h.people = { hashes: [], skipped: 0 }
  h.existingUsers = { adSets: [], problem: null }
})

describe('the tools', () => {
  it('each is a change a person always approves, ending with the #691 truth, with its MATERIAL fields', () => {
    expect(META_ADS_AUDIENCE_CHANGES_TOOLS.map((t) => t.name)).toEqual(['create-meta-audience', 'set-meta-audience', 'set-meta-audience-members', 'set-meta-audience-sharing', 'remove-meta-audience'])
    for (const t of META_ADS_AUDIENCE_CHANGES_TOOLS) {
      expect(t, t.name).toMatchObject({ readOnly: false, alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, category: 'advertising' })
      expect(t.description.endsWith(META_CHANGE_RULES), t.name).toBe(true)
      expect(MATERIAL_PREVIEW_FIELDS[t.name], t.name).toEqual(['basis', 'plan', 'reach'])
      expect(t.requires[0]).toBe('ads.campaigns.manage')
    }
    expect(Object.fromEntries(META_ADS_AUDIENCE_CHANGES_TOOLS.map((t) => [t.name, t.reversibility]))).toEqual({
      'create-meta-audience': 'full', 'set-meta-audience': 'partial', 'set-meta-audience-members': 'none', 'set-meta-audience-sharing': 'partial', 'remove-meta-audience': 'none',
    })
    expect(tool('set-meta-audience-members').requires).toEqual(['ads.campaigns.manage', 'customers.export'])
    expect(tool('set-meta-audience-members').undo).toBeUndefined()
    expect(tool('remove-meta-audience').undo).toBeUndefined()
    // Delete only on the person's explicit ask.
    expect(() => tool('remove-meta-audience').input.parse({ audienceIds: [A] })).toThrow()
    expect(() => tool('remove-meta-audience').input.parse({ audienceIds: [A], confirmDelete: false })).toThrow()
    expect(tool('set-meta-audience-sharing').consequencesFor!({ action: 'share' })).toEqual({ reversibility: 'full' })
    // A rule key Meta does not document is refused at the door (strict), so undo never drops one silently.
    expect(() => tool('create-meta-audience').input.parse({ kind: 'website', name: 'x', rule: { ...WEBSITE_RULE, template: 'X' } })).toThrow()
    expect(() => tool('create-meta-audience').input.parse({ kind: 'customer_list', name: 'List ‮A' })).toThrow()
  })
})

describe('create-meta-audience', () => {
  it('refused until a person signs the Custom Audience terms (the link is in the answer)', async () => {
    h.terms.signed = false
    const out = await preview('create-meta-audience', { kind: 'customer_list', name: 'List A' })
    expect(out).toEqual({ ok: false, error: expect.stringMatching(/terms are not signed .*business\.facebook\.com\/ads\/manage\/customaudiences\/tos\/\?act=1234567890/) })
    expect(h.send).not.toHaveBeenCalled()
  })
  it('a customer list is made EMPTY (D8 said), paused nowhere, no money; it runs, and undo deletes what it made', async () => {
    const out = await preview('create-meta-audience', { kind: 'customer_list', name: 'List A', retentionDays: 90 })
    expect(out.ok).toBe(true)
    expect(out.preview).toMatchObject({ spendsMoney: false, metaCheck: { checked: 'none' }, requests: [{ step: 1, metaCheck: 'no-check' }] })
    expect(out.preview.warnings.join(' ')).toMatch(/EMPTY and Nexus adds nobody/)
    expect(out.preview.warnings.join(' ')).toMatch(/enable_fetch_or_create/)
    h.send.mockImplementationOnce(async () => ({ node: { id: '120000000000049', name: 'List A' }, readBack: 'second-read', waitedMs: 0 }))
    const ran = await run('create-meta-audience', { kind: 'customer_list', name: 'List A', retentionDays: 90 }, out.preview)
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toEqual({
      objectId: 'act_1234567890', kind: 'adaccount', params: { name: 'List A', subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY', retention_days: '90' },
      operation: 'audience.create', budget: false, readBackInPost: false, expect: { name: 'List A' }, readBackFields: 'id,name', edge: 'customaudiences',
    })
    expect(ran.change!.after).toEqual({ created: [{ audienceId: '120000000000049', name: 'List A', kind: 'customer_list' }], accountId: 'm-1', adAccountId: '1234567890' })
    const back = tool('create-meta-audience').undo!.request(ran.change!)
    expect(back).toEqual({ tool: 'remove-meta-audience', args: { connectionId: 'm-1', audienceIds: ['120000000000049'], confirmDelete: true, why: expect.any(String) } })
    expect(tool('remove-meta-audience').input.safeParse((back as { args: unknown }).args).success).toBe(true)
  })
  it('a website audience: its pixel must be the account\'s own (the problem in words), the rule sent in one spelling', async () => {
    h.idProblems = ['That pixel is not on the ad account this business chose, so it is not read.']
    expect(await preview('create-meta-audience', { kind: 'website', name: 'Visitors B', rule: WEBSITE_RULE })).toEqual({ ok: false, error: expect.stringMatching(/^Not built: That pixel is not on the ad account/) })
    h.idProblems = []
    const out = await preview('create-meta-audience', { kind: 'website', name: 'Visitors B', rule: WEBSITE_RULE, prefill: true })
    expect(out.ok).toBe(true)
    // An engagement source in a website rule, a website retention past 365 days: refused in words.
    const page = { inclusions: { operator: 'or', rules: [{ event_sources: [{ id: '120000000000080', type: 'page' }], retention_seconds: 86400, filter: { operator: 'and', filters: [{ field: 'event', operator: 'eq', value: 'page_engaged' }] } }] } }
    expect(await preview('create-meta-audience', { kind: 'website', name: 'x', rule: page })).toEqual({ ok: false, error: expect.stringMatching(/event sources of type pixel only/) })
    const long = { inclusions: { operator: 'or', rules: [{ ...WEBSITE_RULE.inclusions.rules[0], retention_seconds: 400 * 86400 }] } }
    expect(await preview('create-meta-audience', { kind: 'website', name: 'x', rule: long })).toEqual({ ok: false, error: expect.stringMatching(/at most 365 days/) })
    expect(await preview('create-meta-audience', { kind: 'customer_list', name: 'x', rule: WEBSITE_RULE })).toEqual({ ok: false, error: expect.stringMatching(/takes customerFileSource/) })
  })
  it('lookalike tiers: one request each, a seed of the account, never a country; a flagged seed refused', async () => {
    h.audiences[A] = { ...LIST, deliveryCode: 200 }
    const out = await preview('create-meta-audience', { kind: 'lookalike', name: 'Look A', lookalike: { seedAudienceId: A, tiers: [{ fromPercent: 0, toPercent: 1 }, { fromPercent: 1, toPercent: 3 }] } })
    expect(out.ok).toBe(true)
    expect(out.preview.requests.map((r: any) => r.label)).toEqual(['Create the lookalike audience "Look A 0-1%"', 'Create the lookalike audience "Look A 1-3%"'])
    h.send.mockImplementation(async () => ({ node: { id: '120000000000048', name: 'x' }, readBack: 'second-read', waitedMs: 0 }))
    await run('create-meta-audience', { kind: 'lookalike', name: 'Look A', lookalike: { seedAudienceId: A, tiers: [{ fromPercent: 0, toPercent: 1 }, { fromPercent: 1, toPercent: 3 }] } }, out.preview)
    const specs = h.send.mock.calls.map((c) => JSON.parse(c[1].params.lookalike_spec))
    expect(specs).toEqual([{ ratio: 0.01 }, { ratio: 0.03, starting_ratio: 0.01 }])
    expect(h.send.mock.calls[0][1].params.origin_audience_id).toBe(A)
    expect(JSON.stringify(h.send.mock.calls)).not.toMatch(/country|location_spec/)
    h.audiences[A] = { ...LIST, flagged: true, operationCode: 471 }
    expect(await preview('create-meta-audience', { kind: 'lookalike', name: 'Look A', lookalike: { seedAudienceId: A, type: 'similarity' } })).toEqual({ ok: false, error: expect.stringMatching(/flagged for integrity.*1713232/) })
    expect(await preview('create-meta-audience', { kind: 'lookalike', name: 'Look A', lookalike: { seedAudienceId: A, pageFans: true, type: 'similarity' } })).toEqual({ ok: false, error: expect.stringMatching(/ONE source/) })
  })
  it('page fans and campaign converters: the spec names the chosen Page or the campaigns', async () => {
    const fans = await preview('create-meta-audience', { kind: 'lookalike', name: 'Fans look', lookalike: { pageFans: true, percent: 2 } })
    expect(fans.ok).toBe(true)
    h.send.mockImplementation(async () => ({ node: { id: '120000000000047', name: 'Fans look' }, readBack: 'second-read', waitedMs: 0 }))
    await run('create-meta-audience', { kind: 'lookalike', name: 'Fans look', lookalike: { pageFans: true, percent: 2 } }, fans.preview)
    expect(JSON.parse(h.send.mock.calls[0][1].params.lookalike_spec)).toEqual({ ratio: 0.02, conversion_type: 'page_like', page_id: '120000000000080' })
  })
})

describe('set-meta-audience', () => {
  it('a rename: the name read back, undo puts the old one back (read live first)', async () => {
    const out = await preview('set-meta-audience', { audienceId: A, name: 'List B' })
    expect(out.ok).toBe(true)
    expect(out.preview.changes).toEqual({ 'audience "List A" (120000000000040): name': { from: 'List A', to: 'List B' } })
    h.send.mockImplementationOnce(async () => ({ node: { id: A, name: 'List B' }, readBack: 'second-read', waitedMs: 0 }))
    const ran = await run('set-meta-audience', { audienceId: A, name: 'List B' }, out.preview)
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: A, kind: 'customaudience', params: { name: 'List B' }, operation: 'audience.update', expect: { name: 'List B' }, readBackFields: 'id,name' })
    h.audiences[A] = { ...LIST, name: 'List B' }
    const t = tool('set-meta-audience')
    expect(await t.undo!.current(ran.change!)).toEqual(ran.change!.after)
    h.audiences[A] = { ...LIST, name: 'List C' }
    expect(await t.undo!.current(ran.change!)).not.toEqual(ran.change!.after)
    const back = t.undo!.request(ran.change!)
    expect(back).toEqual({ tool: 'set-meta-audience', args: { connectionId: 'm-1', audienceId: A, name: 'List A', why: 'undo of an earlier Meta audience change' } })
    expect(t.input.safeParse((back as { args: unknown }).args).success).toBe(true)
  })
  it('a rule change of an audience active ads use: SPENDS MONEY said; the old rule is the undo', async () => {
    h.use = { ads: [{ adId: '120000000000003', name: 'Ad A', adSetId: '120000000000002', campaignId: '120000000000001', effectiveStatus: 'ACTIVE' }], activeAds: 1, otherAccounts: [], more: false }
    const wider = { inclusions: { operator: 'or', rules: [{ ...WEBSITE_RULE.inclusions.rules[0], retention_seconds: 5184000 }] } }
    const out = await preview('set-meta-audience', { audienceId: VISITORS.id, rule: wider })
    expect(out.ok).toBe(true)
    expect(out.preview.spendsMoney).toBe(true)
    expect(out.preview.spendsMoneyBecause[0]).toMatch(/used by 1 active ad: a new rule changes who is in it/)
    h.send.mockImplementationOnce(async () => ({ node: { id: VISITORS.id }, readBack: 'second-read', waitedMs: 0 }))
    const ran = await run('set-meta-audience', { audienceId: VISITORS.id, rule: wider }, out.preview)
    expect(ran.change!.before).toMatchObject({ undo: { audienceId: VISITORS.id, rule: WEBSITE_RULE } })
    const back = tool('set-meta-audience').undo!.request(ran.change!) as { args: unknown }
    expect(tool('set-meta-audience').input.safeParse(back.args).success).toBe(true)
  })
  it('a shared-in audience, one shared with another business\'s account, a flagged list: never changed', async () => {
    h.audiences['120000000000043'] = { ...LIST, id: '120000000000043', sharedIn: true }
    expect(await preview('set-meta-audience', { audienceId: '120000000000043', name: 'x' })).toEqual({ ok: false, error: expect.stringMatching(/never changes an audience another account owns/) })
    h.sharing.problem = 'The audience is shared with an ad account another business in Nexus uses, so it is also that business\'s: Nexus never changes it (its owner changes it in Meta\'s Audiences).'
    expect(await preview('set-meta-audience', { audienceId: A, name: 'x' })).toEqual({ ok: false, error: expect.stringMatching(/another business in Nexus uses/) })
    h.sharing.problem = null
    h.audiences[A] = { ...LIST, flagged: true, operationCode: 471 }
    expect(await preview('set-meta-audience', { audienceId: A, name: 'x' })).toEqual({ ok: false, error: expect.stringMatching(/1713228/) })
  })
  it('the account\'s existing customers: the WHOLE list read first (unread: refused), from → to, undo puts it back', async () => {
    h.terms.existingCustomers = null
    h.terms.existingProblem = 'Meta did not answer it'
    expect(await preview('set-meta-audience', { existingCustomers: [A] })).toEqual({ ok: false, error: expect.stringMatching(/read first for the undo/) })
    h.terms.existingCustomers = ['120000000000044']
    // Review A3 — active ad sets that read the list are named, and the change is SPENDS MONEY.
    h.existingUsers = { adSets: [{ id: '120000000000002', name: 'Ad set B', campaignId: '120000000000001' }], problem: null }
    const spends = await preview('set-meta-audience', { existingCustomers: [A] })
    expect(spends.preview.spendsMoneyBecause[0]).toMatch(/"Ad set B" \(120000000000002/)
    h.existingUsers = { adSets: [], problem: null }
    const out = await preview('set-meta-audience', { existingCustomers: [A] })
    expect(out.preview.changes).toEqual({ 'The ad account\'s existing-customer audiences (the whole list)': { from: '120000000000044', to: A } })
    h.send.mockImplementationOnce(async () => ({ node: { id: 'act_1234567890' }, readBack: 'second-read', waitedMs: 0 }))
    const ran = await run('set-meta-audience', { existingCustomers: [A] }, out.preview)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: 'act_1234567890', kind: 'adaccount', params: { existing_customers: `["${A}"]` }, operation: 'adaccount.audiences' })
    expect(tool('set-meta-audience').undo!.request(ran.change!)).toMatchObject({ tool: 'set-meta-audience', args: { existingCustomers: ['120000000000044'] } })
    h.terms.existingCustomers = [A]
    expect(await tool('set-meta-audience').undo!.current(ran.change!)).toEqual(ran.change!.after)
  })
})

describe('set-meta-audience-members (D8)', () => {
  it('add and replace are refused before anything is read: no consent field', async () => {
    for (const mode of ['add', 'replace']) {
      expect(await preview('set-meta-audience-members', { mode, audienceId: A })).toEqual({ ok: false, error: NO_CONSENT })
    }
    expect(h.termsRead).not.toHaveBeenCalled()
  })
  it('remove: the opted-out people as hashes in DELETE requests; no hash in the preview, the answer or the record', async () => {
    h.people = { hashes: [hash('a@example.com'), hash('b@example.com')].sort(), skipped: 1 }
    h.terms.signed = false
    expect(await preview('set-meta-audience-members', { mode: 'remove', audienceId: A })).toEqual({ ok: false, error: expect.stringMatching(/terms are not signed/) })
    h.terms.signed = true
    expect(await preview('set-meta-audience-members', { mode: 'remove', audienceId: VISITORS.id })).toEqual({ ok: false, error: expect.stringMatching(/not a customer list/) })
    const out = await preview('set-meta-audience-members', { mode: 'remove', audienceId: A })
    expect(out.ok).toBe(true)
    expect(out.preview).toMatchObject({ spendsMoney: false, totals: { people: 2, requests: 1, withoutEmail: 1 } })
    expect(JSON.stringify(out)).not.toContain(hash('a@example.com'))
    h.send.mockImplementationOnce(async () => ({ node: { audience_id: A, session_id: '1', num_received: 2, num_invalid_entries: 0, invalid_entry_samples: { [hash('a@example.com')]: 'x' } }, readBack: 'none', waitedMs: 0 }))
    const ran = await run('set-meta-audience-members', { mode: 'remove', audienceId: A }, out.preview)
    expect(ran.ok).toBe(true)
    const sent = h.send.mock.calls[0][1]
    expect(sent).toMatchObject({ objectId: A, kind: 'customaudience', method: 'DELETE', edge: 'users', operation: 'audience.users.remove' })
    expect(JSON.parse(sent.params.payload)).toEqual({ schema: 'EMAIL_SHA256', data: h.people.hashes })
    // Review B1 — no session on the DELETE: a second run with the same people sends no repeated id.
    expect(Object.keys(sent.params)).toEqual(['payload'])
    expect(out.preview.spendsMoney).toBe(false)
    expect(ran.data).toMatchObject({ received: 2, invalidEntries: 0, people: 2 })
    const kept = JSON.stringify({ data: ran.data, change: ran.change })
    expect(kept).not.toContain(hash('a@example.com'))
    expect(kept).not.toContain('example.com')
  })
  it('opt out everywhere goes to the ad account itself; it names no audience; nobody to take out is said', async () => {
    expect(await preview('set-meta-audience-members', { mode: 'opt_out_everywhere' })).toEqual({ ok: false, error: expect.stringMatching(/Nobody to take out/) })
    expect(await preview('set-meta-audience-members', { mode: 'opt_out_everywhere', audienceId: A })).toEqual({ ok: false, error: expect.stringMatching(/names no audience/) })
    h.people = { hashes: [hash('a@example.com')], skipped: 0 }
    const out = await preview('set-meta-audience-members', { mode: 'opt_out_everywhere', since: '2026-10-01' })
    h.send.mockImplementationOnce(async () => ({ node: { num_received: 1, num_invalid_entries: 0 }, readBack: 'none', waitedMs: 0 }))
    const ran = await run('set-meta-audience-members', { mode: 'opt_out_everywhere', since: '2026-10-01' }, out.preview)
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: 'act_1234567890', kind: 'adaccount', method: 'DELETE', edge: 'usersofanyaudience' })
    expect(await preview('set-meta-audience-members', { mode: 'opt_out_everywhere', since: '2026-02-30' })).toEqual({ ok: false, error: expect.stringMatching(/real day/) })
  })
})

describe('set-meta-audience-sharing', () => {
  it('share: only accounts not shared yet; a recipient another business uses refused; undo stops the share again', async () => {
    h.sharing.accounts = ['1234567892']
    h.idProblems = ['ad account 1234567891 is one another business in Nexus uses: an audience is never shared across Nexus businesses.']
    expect(await preview('set-meta-audience-sharing', { audienceId: A, action: 'share', adAccountIds: ['1234567891'] })).toEqual({ ok: false, error: expect.stringMatching(/never shared across Nexus businesses/) })
    h.idProblems = []
    const out = await preview('set-meta-audience-sharing', { audienceId: A, action: 'share', adAccountIds: ['1234567891', '1234567892'], permissions: 'targeting' })
    expect(out.preview.skipped).toEqual(['It is already shared with ad account 1234567892.'])
    h.send.mockImplementationOnce(async () => ({ node: { success: true, sharing_data: [{ ad_acct_id: 'act_1234567891', audience_share_status: 'SHARED', errors: [] }] }, readBack: 'none', waitedMs: 0 }))
    const ran = await run('set-meta-audience-sharing', { audienceId: A, action: 'share', adAccountIds: ['1234567891', '1234567892'], permissions: 'targeting' }, out.preview)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: A, kind: 'customaudience', edge: 'ad_accounts', params: { adaccounts: '["1234567891"]', permissions: 'targeting' } })
    expect(ran.data.sharing).toEqual([{ adAccountId: '1234567891', status: 'SHARED', errors: [] }])
    const back = tool('set-meta-audience-sharing').undo!.request(ran.change!)
    expect(back).toMatchObject({ tool: 'set-meta-audience-sharing', args: { audienceId: A, action: 'unshare', adAccountIds: ['1234567891'] } })
    h.sharing.accounts = ['1234567891', '1234567892']
    expect(await tool('set-meta-audience-sharing').undo!.current(ran.change!)).toEqual(ran.change!.after)
  })
  it('unshare: the recipients\' ads stop for good (said, with how many)', async () => {
    h.sharing.accounts = ['1234567891']
    h.use = { ads: [], activeAds: 0, otherAccounts: [{ adAccountId: '1234567891', ads: 3, takenByAnotherBusiness: false }], more: false }
    const out = await preview('set-meta-audience-sharing', { audienceId: A, action: 'unshare', adAccountIds: ['1234567891'] })
    expect(out.preview.warnings[0]).toMatch(/NEVER be restarted .*3 ads of 1 ad account/)
  })
})

describe('re-review follow-ups', () => {
  it('N2 — approved as "no SPENDS MONEY", refused at run when a shared account\'s ads started using it', async () => {
    const out = await preview('set-meta-audience', { audienceId: A, retentionDays: 10 })
    expect(out.preview.spendsMoney).toBe(false)
    h.use = { ...h.use, otherAccounts: [{ adAccountId: '1234567891', ads: 3, takenByAnotherBusiness: false }] }
    const ran = await run('set-meta-audience', { audienceId: A, retentionDays: 10 }, out.preview)
    expect(ran).toEqual({ ok: false, error: expect.stringMatching(/^Not run: the Meta ad account changed since this was approved/) })
    expect(h.send).not.toHaveBeenCalled()
  })
  it('N2 — existingCustomers approved with none reading it, refused at run once an active ad set reads it', async () => {
    h.terms.existingCustomers = ['120000000000044']
    const out = await preview('set-meta-audience', { existingCustomers: [A] })
    expect(out.preview.spendsMoney).toBe(false)
    h.existingUsers = { adSets: [{ id: '120000000000002', name: 'Ad set B', campaignId: '120000000000001' }], problem: null }
    const ran = await run('set-meta-audience', { existingCustomers: [A] }, out.preview)
    expect(ran).toEqual({ ok: false, error: expect.stringMatching(/^Not run: the Meta ad account changed since this was approved/) })
    expect(h.send).not.toHaveBeenCalled()
  })
  it('N1 — an unshare when who it is shared with could not be read: the read problem, never "not shared"', async () => {
    h.sharing = { accounts: null as unknown as string[], problem: 'Nexus could not read who the audience is shared with (Meta refused), so it changes nothing of it.' }
    expect(await preview('set-meta-audience-sharing', { audienceId: A, action: 'unshare', adAccountIds: ['1234567891'] })).toEqual({ ok: false, error: expect.stringMatching(/could not read who the audience is shared with/) })
  })
  it('M5 — an unshare from an account another business uses goes through (no recipient check); a share of that audience is refused', async () => {
    h.sharing = { accounts: ['1234567891'], problem: 'The audience is shared with an ad account another business in Nexus uses, so it is also that business\'s.' }
    h.idProblems = ['ad account 1234567891 is one another business in Nexus uses: an audience is never shared across Nexus businesses.']
    const out = await preview('set-meta-audience-sharing', { audienceId: A, action: 'unshare', adAccountIds: ['1234567891'] })
    expect(out.ok).toBe(true)
    expect(out.preview.requests).toHaveLength(1)
    expect(await preview('set-meta-audience-sharing', { audienceId: A, action: 'share', adAccountIds: ['1234567892'] })).toEqual({ ok: false, error: expect.stringMatching(/another business in Nexus uses/) })
  })
})

describe('remove-meta-audience', () => {
  it('a seed with lookalikes: refused unless they go first; the ads that stop are listed; no undo', async () => {
    h.audiences[A] = { ...LIST, lookalikeIds: [L] }
    h.audiences[L] = { ...LIST, id: L, name: 'Look A', subtype: 'LOOKALIKE' }
    h.use = { ads: [{ adId: '120000000000003', name: 'Ad A', adSetId: '120000000000002', campaignId: '120000000000001', effectiveStatus: 'ACTIVE' }], activeAds: 1, otherAccounts: [], more: false }
    expect(await preview('remove-meta-audience', { audienceIds: [A], confirmDelete: true })).toEqual({ ok: false, error: expect.stringMatching(/has 1 lookalike .*2656.*includeLookalikes/) })
    const out = await preview('remove-meta-audience', { audienceIds: [A], confirmDelete: true, includeLookalikes: true })
    expect(out.ok).toBe(true)
    expect(out.preview.requests.map((r: any) => r.label)).toEqual([`Delete audience "Look A" (${L}) (lookalike first)`, `Delete audience "List A" (${A})`])
    expect(out.preview.warnings.join(' ')).toMatch(/FOR GOOD.*NEVER be restarted/)
    expect(out.preview.warnings.join(' ')).toMatch(/"Ad A" \(120000000000003, ACTIVE\)/)
    h.send.mockImplementation(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 }))
    const ran = await run('remove-meta-audience', { audienceIds: [A], confirmDelete: true, includeLookalikes: true }, out.preview)
    expect(h.send.mock.calls.map((c) => [c[1].objectId, c[1].method, c[1].kind])).toEqual([[L, 'DELETE', 'customaudience'], [A, 'DELETE', 'customaudience']])
    expect(ran.data.deleted).toEqual([L, A])
  })
})
