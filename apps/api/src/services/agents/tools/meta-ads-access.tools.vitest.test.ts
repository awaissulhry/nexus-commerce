/**
 * Meta step 41 — set-meta-user-access and set-meta-partner-access as the approval gate uses them (Meta, the account and the
 * live reads are stand-ins): the change contract of every Meta change tool; a preview from the live state with the Full
 * access tier named and "Meta has no check"; the leader's hard floors refused before anything is sent (the last admin,
 * Nexus's own system user, only people and partners named); the brake; a run only as a request a person approved, the
 * request sent as the kit builds it and read back; a disabled ad account refused at the run; Meta's refusal in plain words
 * with what it needs; undo reads the asset live and puts back what was changed through the same tool; an ended
 * relationship has none. Made-up ids and names.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown> | { refusal: string },
  state: {} as Record<string, unknown>,
  assigned: new Map<string, { id: string; name: string | null; tasks: string[] }>(),
  partners: new Map<string, { id: string; name: string | null; tasks: string[]; accessStatus: string | null; takenByAnotherBusiness: boolean }>(),
  relationships: new Map<string, unknown>(),
  people: new Map<string, { name: string | null; kind: 'person' | 'system user' }>(),
  taken: new Set<string>(),
  owned: { page: true as boolean | 'none', instagram: 'none' as boolean | 'none' },
  ownAssets: { adAccounts: ['1234567890'] as string[] | null, pages: ['120000000000080'] as string[] | null, instagram: [] as string[] | null },
  clientInstagram: [] as string[] | null,
  peopleMore: false,
  send: vi.fn(),
  serverEvents: new Map<string, { id: string; name: string | null; takenByAnotherBusiness: boolean }>(),
  afterSend: null as null | (() => void),
}))
vi.mock('../../marketing/meta-ads/change-account.js', () => ({ metaChangeAccount: vi.fn(async () => h.account) }))
vi.mock('../../marketing/meta-ads/live-access-change.js', () => ({
  accessAccount: vi.fn(async () => ({ connectionId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', pageId: '120000000000080', instagramId: null, businessId: '9876543210', connection: { systemUser: { id: '120000000000001', name: 'Nexus' } } })),
  liveAccessState: vi.fn(async () => structuredClone(h.state)),
  liveAccessAsset: vi.fn(async (_a: unknown, asset: string, _p: string, pixelId?: string | null) => (asset === 'ad-account'
    ? { asset, nodeId: 'act_1234567890', label: 'ad account 1234567890 ("Shop A ads")' }
    : asset === 'page' ? { asset, nodeId: '120000000000080', label: 'Facebook Page 120000000000080' }
      : asset === 'pixel' ? { asset, nodeId: pixelId, label: `dataset ${pixelId}` } : { asset, nodeId: '120000000000090', label: 'Instagram account (17840000000000001; its business asset 120000000000090)' })),
  liveServerEventBusinesses: vi.fn(async () => ({ businesses: new Map(h.serverEvents), more: false })),
  liveAssignees: vi.fn(async () => ({ people: new Map(h.assigned), more: false })),
  liveAssetPartners: vi.fn(async () => ({ partners: new Map(h.partners), more: false })),
  livePortfolioRelationships: vi.fn(async () => ({ partners: new Map(h.relationships), more: false, sharesNote: null })),
  liveChosenAssetsOwned: vi.fn(async () => ({ ...h.owned })),
  liveClientInstagramIds: vi.fn(async () => h.clientInstagram),
  livePortfolioOwnAssets: vi.fn(async () => ({ ...h.ownAssets })),
}))
vi.mock('../../marketing/meta-ads/live-catalog-admin.js', () => ({
  liveNexusSystemUser: vi.fn(async () => '120000000000001'),
  livePortfolioPeople: vi.fn(async () => ({ people: new Map(h.people), more: h.peopleMore })),
}))
vi.mock('../../marketing/meta-ads/taken.js', () => ({ takenIds: vi.fn(async (_p: string, ids: string[]) => new Set(ids.filter((id) => h.taken.has(id)))) }))
vi.mock('../../marketing/meta-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/write-client.js')>()),
  metaSendChange: h.send,
}))

import { META_ADS_ACCESS_TOOLS } from './meta-ads-access.tools.js'
import { META_CHANGE_RULES } from './meta-ads-kit.js'
import { MetaWriteError } from '../../marketing/meta-ads/write-client.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { missingPermissions } from '../call-tool.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import type { AgentTool, ToolContext, ToolResult } from '../tool-types.js'

const tool = (name: string) => META_ADS_ACCESS_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown, extra: Partial<ToolContext> = {}): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview, ...extra })
const ask = (t: AgentTool, args: Record<string, unknown>) => t.input.parse(args) as Record<string, unknown>
const preview = async (name: string, args: Record<string, unknown>, ctx = asker) => (await tool(name).handler(ask(tool(name), args), ctx)) as ToolResult & { preview: Record<string, any>; error?: string }
const run = async (name: string, args: Record<string, unknown>, p: unknown, extra: Partial<ToolContext> = {}) => (await tool(name).execute!(ask(tool(name), args), approved(p, extra))) as ToolResult & { data: Record<string, any>; error?: string }

const ME = '120000000000001'
const PERSON = '120000000000002'
const OWNER = '120000000000003'
const PARTNER = '120000000000070'
const STATE = { adAccountId: '1234567890', name: 'Shop A ads', status: 1, disableReason: 0, portfolioId: '9876543210', tier: 'development_access' }
const SET = { asset: 'ad-account', action: 'set', personId: PERSON, tasks: ['ADVERTISE', 'ANALYZE'] }

beforeEach(() => {
  __metaObjectLimitsTest.useMemory()
  vi.unstubAllEnvs()
  h.send.mockReset()
  h.account = { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' }
  h.state = structuredClone(STATE)
  h.assigned = new Map([
    [OWNER, { id: OWNER, name: 'Person B', tasks: ['ADVERTISE', 'ANALYZE', 'MANAGE'] }],
    [PERSON, { id: PERSON, name: 'Person A', tasks: ['ANALYZE'] }],
    [ME, { id: ME, name: 'Nexus', tasks: ['ADVERTISE', 'ANALYZE', 'MANAGE'] }],
  ])
  h.partners = new Map()
  h.relationships = new Map()
  h.people = new Map([[PERSON, { name: 'Person A', kind: 'person' }], [OWNER, { name: 'Person B', kind: 'person' }], [ME, { name: 'Nexus', kind: 'system user' }]])
  h.taken = new Set()
  h.owned = { page: true, instagram: 'none' }
  h.ownAssets = { adAccounts: ['1234567890'], pages: ['120000000000080'], instagram: [] }
  h.clientInstagram = []
  h.peopleMore = false
  h.serverEvents = new Map()
})

describe('the tools', () => {
  it('each is a change a person always approves, the #691 truth, its MATERIAL fields, its permission, its reversibility', () => {
    for (const name of ['set-meta-user-access', 'set-meta-partner-access']) {
      const t = tool(name)
      // Owner option 1 (2026-10-26) — people and connections, exactly as set-google-user-access.
      expect(t, name).toMatchObject({ readOnly: false, alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, category: 'advertising', reversibility: 'partial', requires: ['users.manage', 'ads.connect'] })
      // The person who approves needs them too: the approval gate re-checks the approver with missingPermissions.
      const asApprover = (held: string[]) => missingPermissions({ kind: 'user', userId: 'u-1', label: 'Person A', via: 'app', workspace: null, permissions: { isOwner: false, permissions: new Set(['ai.run', ...held]) } } as never, t)
      expect(asApprover(['ads.campaigns.manage'])).toEqual(['users.manage', 'ads.connect'])
      expect(asApprover(['users.manage', 'ads.connect'])).toEqual([])
      expect(t.description.endsWith(META_CHANGE_RULES), name).toBe(true)
      expect(t.description, name).toMatch(/FULL Marketing API access tier/)
      expect(t.description, name).toMatch(/disabled, risk-reviewed, closing, closed or compromised/)
      expect(MATERIAL_PREVIEW_FIELDS[name], name).toEqual(['basis', 'plan', 'reach'])
    }
    expect(tool('set-meta-user-access').description).toMatch(/never the LAST admin/)
    expect(tool('set-meta-user-access').description).toMatch(/never Nexus's own system user/)
    expect(tool('set-meta-partner-access').consequencesFor!({ action: 'end-relationship' })).toEqual({ reversibility: 'none' })
    expect(tool('set-meta-partner-access').consequencesFor!({ action: 'share' })).toBeNull()
    // A person or partner is always named by id; a removal needs confirmRemove: true literally; no task outside Meta's lists.
    expect(() => tool('set-meta-user-access').input.parse({ asset: 'ad-account', action: 'set', tasks: ['ANALYZE'] })).toThrow()
    expect(() => tool('set-meta-user-access').input.parse({ ...SET, personId: 'everyone' })).toThrow()
    expect(() => tool('set-meta-user-access').input.parse({ ...SET, tasks: ['OWNER'] })).toThrow()
    expect(() => tool('set-meta-user-access').input.parse({ asset: 'ad-account', action: 'remove', personId: PERSON, confirmRemove: false })).toThrow()
    expect(() => tool('set-meta-partner-access').input.parse({ action: 'share', asset: 'business', partnerBusinessId: PARTNER, permittedTasks: ['ANALYZE'] })).toThrow()
  })
})

describe('set-meta-user-access', () => {
  it('a preview: from → to, the tier Meta named, Meta has no check, basis and plan stable on the re-check; nothing sent', async () => {
    const out = await preview('set-meta-user-access', SET)
    expect(out.ok).toBe(true)
    expect(out.preview).toMatchObject({ spendsMoney: false, requests: [{ step: 1, metaCheck: 'no-check' }], metaCheck: { checked: 'none' } })
    expect(out.preview.warnings.join(' ')).toMatch(/development_access \(Limited\)/)
    expect(Object.values(out.preview.changes)[0]).toMatchObject({ from: 'ANALYZE' })
    const again = await preview('set-meta-user-access', SET, { ...asker, approvalId: 'ap-1' })
    expect([again.preview.basis, again.preview.plan]).toEqual([out.preview.basis, out.preview.plan])
    expect(h.send).not.toHaveBeenCalled()
  })
  it('the hard floors refuse before anything is sent: Nexus\'s own system user, the last admin, a stray argument, a removal without confirmRemove', async () => {
    expect((await preview('set-meta-user-access', { ...SET, personId: ME })).error).toMatch(/Nexus's own system user/)
    expect((await preview('set-meta-user-access', { asset: 'ad-account', action: 'remove', personId: OWNER, confirmRemove: true })).error).toMatch(/last person who is an admin/)
    expect((await preview('set-meta-user-access', { asset: 'ad-account', action: 'remove', personId: PERSON })).error).toMatch(/confirmRemove: true/)
    expect((await preview('set-meta-user-access', { ...SET, confirmRemove: true })).error).toMatch(/confirmRemove is not an argument of action set/)
    expect(h.send).not.toHaveBeenCalled()
  })
  it('the brake: with Meta changes switched off the preview says so and the run sends nothing', async () => {
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'off')
    const p = (await preview('set-meta-user-access', SET)).preview
    expect(p.warnings.join(' ')).toMatch(/NEXUS_META_ADS_WRITES=off/)
    expect(await run('set-meta-user-access', SET, p)).toEqual({ ok: false, error: expect.stringMatching(/switched off in Nexus/) })
    expect(h.send).not.toHaveBeenCalled()
  })
  it('runs as approved: the request as the kit builds it, read back from the asset\'s people, recorded; undo reads it live and gives the old tasks back', async () => {
    const p = (await preview('set-meta-user-access', SET)).preview
    h.send.mockImplementationOnce(async () => {
      h.assigned.set(PERSON, { id: PERSON, name: 'Person A', tasks: ['ADVERTISE', 'ANALYZE', 'DRAFT'] })
      return { node: { success: true }, readBack: 'none', waitedMs: 0 }
    })
    const ran = await run('set-meta-user-access', SET, p)
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({
      objectId: 'act_1234567890', kind: 'accessadaccount', params: { user: PERSON, tasks: '["ADVERTISE","ANALYZE"]' }, operation: 'access.accessadaccount.user.set', edge: 'assigned_users', budget: false, readBackInPost: false,
    })
    expect(h.send.mock.calls[0][1].judge).toBeUndefined()
    expect(ran.data.steps).toEqual([expect.objectContaining({ outcome: 'done', sentence: expect.stringMatching(/it now reads tasks ADVERTISE, ANALYZE, DRAFT/) })])
    // The record keeps what Meta read right after (its unpacked tasks), so undo compares like with like.
    expect(ran.change!.after).toEqual({ op: 'set', asset: 'ad-account', nodeId: 'act_1234567890', personId: PERSON, assigned: true, tasks: ['ADVERTISE', 'ANALYZE', 'DRAFT'], accountId: 'm-1', adAccountId: '1234567890' })
    const t = tool('set-meta-user-access')
    expect(await t.undo!.current(ran.change!)).toEqual(ran.change!.after)
    const back = t.undo!.request(ran.change!) as { tool: string; args: Record<string, unknown> }
    expect(back).toMatchObject({ tool: 'set-meta-user-access', args: { connectionId: 'm-1', asset: 'ad-account', action: 'set', personId: PERSON, tasks: ['ANALYZE'] } })
    expect(() => t.input.parse(back.args)).not.toThrow()
  })
  it('not as asked: Meta answered success but the person holds an admin task not asked — not recorded, said', async () => {
    const p = (await preview('set-meta-user-access', SET)).preview
    h.send.mockImplementationOnce(async () => {
      h.assigned.set(PERSON, { id: PERSON, name: 'Person A', tasks: ['ADVERTISE', 'ANALYZE', 'MANAGE'] })
      return { node: { success: true }, readBack: 'none', waitedMs: 0 }
    })
    const ran = await run('set-meta-user-access', SET, p)
    expect(ran.ok).toBe(false)
    expect(ran.error).toMatch(/Not confirmed: .* reads back tasks ADVERTISE, ANALYZE, MANAGE/)
  })
  it('a move since approval is never sent: the person\'s tasks changed, or the account was disabled', async () => {
    const p = (await preview('set-meta-user-access', SET)).preview
    h.assigned.set(PERSON, { id: PERSON, name: 'Person A', tasks: ['ADVERTISE'] })
    expect((await run('set-meta-user-access', SET, p)).error).toMatch(/changed since this was approved/)
    h.assigned.set(PERSON, { id: PERSON, name: 'Person A', tasks: ['ANALYZE'] })
    h.state = { ...STATE, status: 101 }
    expect((await run('set-meta-user-access', SET, p)).error).toMatch(/Nexus changes nothing on an ad account Meta has disabled/)
    expect(h.send).not.toHaveBeenCalled()
  })
  it('Meta refuses at the Limited tier: the step says so in Meta\'s words and what it needs; nothing recorded', async () => {
    const p = (await preview('set-meta-user-access', SET)).preview
    h.send.mockImplementationOnce(async () => {
      throw new MetaWriteError({ origin: 'meta', httpStatus: 400, code: '200', authLost: false, throttled: false, permissionDenied: true, notFound: false, sentence: 'Meta does not let this system user change this: (#200) Permissions error.' }, 'access.accessadaccount.user.set', 'refused')
    })
    const ran = await run('set-meta-user-access', SET, p)
    expect(ran.ok).toBe(false)
    expect(ran.error).toMatch(/Permissions error\. Meta says permissions error: people and partner access need the Full Marketing API access tier/)
  })
  it('a removal: DELETE with the user, confirmed; undo gives the old tasks back', async () => {
    const args = { asset: 'ad-account', action: 'remove', personId: PERSON, confirmRemove: true }
    const p = (await preview('set-meta-user-access', args)).preview
    h.send.mockImplementationOnce(async () => { h.assigned.delete(PERSON); return { node: { success: true }, readBack: 'none', waitedMs: 0 } })
    const ran = await run('set-meta-user-access', args, p)
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ method: 'DELETE', params: { user: PERSON } })
    expect(ran.change!.after).toMatchObject({ assigned: false, tasks: null })
    expect(tool('set-meta-user-access').undo!.request(ran.change!)).toMatchObject({ args: { action: 'set', personId: PERSON, tasks: ['ANALYZE'] } })
  })
})

describe('set-meta-user-access: review fix round 1', () => {
  it('A-SF1 (M43) — the portfolio shared, or its ad accounts unreadable: no system user is given access (a person still is)', async () => {
    h.people.set('120000000000004', { name: 'Tool B', kind: 'system user' })
    const systemUser = { ...SET, personId: '120000000000004', tasks: ['ANALYZE'] }
    expect((await preview('set-meta-user-access', systemUser)).ok).toBe(true)
    h.taken.add('9876543210')
    expect((await preview('set-meta-user-access', systemUser)).error).toMatch(/cannot tell whose system user/)
    h.taken.clear()
    // A-N3 — another business chose one of the portfolio's own ad accounts (its link names no portfolio).
    h.ownAssets = { ...h.ownAssets, adAccounts: ['1234567890', '1234567892'] }
    h.taken.add('1234567892')
    expect((await preview('set-meta-user-access', systemUser)).error).toMatch(/cannot tell whose system user/)
    h.taken.clear()
    h.ownAssets = { ...h.ownAssets, adAccounts: null }
    expect((await preview('set-meta-user-access', systemUser)).error).toMatch(/could not tell that none does/)
    expect((await preview('set-meta-user-access', SET)).ok).toBe(true)
  })
  it('B-F4 — an ad account takes only Meta\'s combinations; undo of an unpacked read-back sends the preset (re-review T9)', async () => {
    expect((await preview('set-meta-user-access', { ...SET, tasks: ['ANALYZE', 'DRAFT'] })).error).toMatch(/only Meta's task combinations/)
    // The person holds General as Meta reads it (unpacked, with DRAFT) and is lowered to Reporting: undo asks General back.
    h.assigned.set(PERSON, { id: PERSON, name: 'Person A', tasks: ['ADVERTISE', 'ANALYZE', 'DRAFT'] })
    const lower = { ...SET, tasks: ['ANALYZE'] }
    const p = (await preview('set-meta-user-access', lower)).preview
    h.send.mockImplementationOnce(async () => { h.assigned.set(PERSON, { id: PERSON, name: 'Person A', tasks: ['ANALYZE'] }); return { node: { success: true }, readBack: 'none', waitedMs: 0 } })
    const ran = await run('set-meta-user-access', lower, p)
    expect(ran.ok).toBe(true)
    const back = tool('set-meta-user-access').undo!.request(ran.change!) as { tool: string; args: Record<string, unknown> }
    expect(back).toMatchObject({ tool: 'set-meta-user-access', args: { action: 'set', personId: PERSON, tasks: ['ADVERTISE', 'ANALYZE'] } })
    expect(() => tool('set-meta-user-access').input.parse(back.args)).not.toThrow()
  })
})

describe('set-meta-partner-access', () => {
  const SHARE = { action: 'share', asset: 'ad-account', partnerBusinessId: PARTNER, permittedTasks: ['ADVERTISE', 'ANALYZE'] }
  it('a share: the partner\'s tasks always sent, read back from the asset\'s partners; undo takes it back (confirmRemove)', async () => {
    const p = (await preview('set-meta-partner-access', SHARE)).preview
    expect(p.warnings.join(' ')).toMatch(/SDK only/)
    h.send.mockImplementationOnce(async () => {
      h.partners.set(PARTNER, { id: PARTNER, name: 'Agency A', tasks: ['ADVERTISE', 'ANALYZE'], accessStatus: 'PENDING', takenByAnotherBusiness: false })
      return { node: { success: true }, readBack: 'none', waitedMs: 0 }
    })
    const ran = await run('set-meta-partner-access', SHARE, p)
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: 'act_1234567890', kind: 'accessadaccount', edge: 'agencies', params: { business: PARTNER, permitted_tasks: '["ADVERTISE","ANALYZE"]' } })
    expect(ran.data.steps[0].sentence).toMatch(/shared: ADVERTISE, ANALYZE \(PENDING\)/)
    const t = tool('set-meta-partner-access')
    expect(await t.undo!.current(ran.change!)).toEqual(ran.change!.after)
    const back = t.undo!.request(ran.change!) as { args: Record<string, unknown> }
    expect(back.args).toMatchObject({ action: 'remove', asset: 'ad-account', partnerBusinessId: PARTNER, confirmRemove: true })
    expect(() => t.input.parse(back.args)).not.toThrow()
  })
  it('the floors: never the portfolio itself or another Nexus business\'s; a removal only when Nexus\'s system user is the portfolio\'s own', async () => {
    expect((await preview('set-meta-partner-access', { ...SHARE, partnerBusinessId: '9876543210' })).error).toMatch(/own business portfolio/)
    h.taken.add(PARTNER)
    expect((await preview('set-meta-partner-access', SHARE)).error).toMatch(/another business in Nexus/)
    h.taken.clear()
    h.partners.set(PARTNER, { id: PARTNER, name: 'Agency A', tasks: ['ANALYZE'], accessStatus: 'CONFIRMED', takenByAnotherBusiness: false })
    const remove = { action: 'remove', asset: 'ad-account', partnerBusinessId: PARTNER, confirmRemove: true }
    expect((await preview('set-meta-partner-access', remove)).ok).toBe(true)
    h.people.delete(ME)
    expect((await preview('set-meta-partner-access', remove)).error).toMatch(/may come through a partner/)
    expect((await preview('set-meta-partner-access', { ...remove, confirmRemove: undefined })).error).toMatch(/confirmRemove: true/)
    // A-SF1 (M32) — a system-user list cut short that does not show Nexus's own: refused (never "not there").
    h.people.set(ME, { name: 'Nexus', kind: 'system user' })
    h.peopleMore = true
    expect((await preview('set-meta-partner-access', remove)).ok).toBe(true)
    h.people.delete(ME)
    expect((await preview('set-meta-partner-access', remove)).error).toMatch(/could not read the business portfolio's system users in full/)
    h.peopleMore = false
    // A-SF1 (M33) — step 40's rule at tool level too.
    h.people.set(ME, { name: 'Nexus', kind: 'system user' })
    h.state = { ...STATE, status: 2 }
    expect((await preview('set-meta-partner-access', remove)).error).toMatch(/Nexus changes nothing on an ad account Meta has disabled/)
    expect(h.send).not.toHaveBeenCalled()
  })
  it('re-review T10 — a partner taken off with Meta\'s unpacked tasks: undo shares it again with the preset', async () => {
    h.partners.set(PARTNER, { id: PARTNER, name: 'Agency A', tasks: ['ADVERTISE', 'ANALYZE', 'DRAFT'], accessStatus: 'CONFIRMED', takenByAnotherBusiness: false })
    const remove = { action: 'remove', asset: 'ad-account', partnerBusinessId: PARTNER, confirmRemove: true }
    const p = (await preview('set-meta-partner-access', remove)).preview
    h.send.mockImplementationOnce(async () => { h.partners.delete(PARTNER); return { node: { success: true }, readBack: 'none', waitedMs: 0 } })
    const ran = await run('set-meta-partner-access', remove, p)
    expect(ran.ok).toBe(true)
    const back = tool('set-meta-partner-access').undo!.request(ran.change!) as { tool: string; args: Record<string, unknown> }
    expect(back).toMatchObject({ tool: 'set-meta-partner-access', args: { action: 'share', asset: 'ad-account', partnerBusinessId: PARTNER, permittedTasks: ['ADVERTISE', 'ANALYZE'] } })
    expect(() => tool('set-meta-partner-access').input.parse(back.args)).not.toThrow()
  })
  it('re-review R-1 — an AGENCY end is refused when another business in Nexus chose one of the portfolio\'s own Pages or Instagram accounts (or they cannot be read)', async () => {
    const end = { action: 'end-relationship', relationship: 'agency', partnerBusinessId: PARTNER, confirmRemove: true }
    h.relationships.set(PARTNER, { id: PARTNER, name: 'Agency A', takenByAnotherBusiness: false, shares: { adAccounts: [], pages: [], catalogs: [], apps: [] } })
    expect((await preview('set-meta-partner-access', end)).ok).toBe(true)
    h.ownAssets = { ...h.ownAssets, instagram: ['17840000000000003'] }
    h.taken.add('17840000000000003')
    expect((await preview('set-meta-partner-access', end)).error).toMatch(/could not tell that none does|ends none/)
    h.taken.clear()
    h.ownAssets = { ...h.ownAssets, pages: ['120000000000080', '120000000000083'] }
    h.taken.add('120000000000083')
    expect((await preview('set-meta-partner-access', end)).error).toMatch(/ends none/)
    h.taken.clear()
    h.ownAssets = { ...h.ownAssets, instagram: null }
    expect((await preview('set-meta-partner-access', end)).error).toMatch(/could not tell that none does/)
    expect(h.send).not.toHaveBeenCalled()
  })
  it('A-MF1 — an end is refused when the relationship holds a Page (or ad account) another business in Nexus uses, or Meta lists none readably', async () => {
    const end = { action: 'end-relationship', relationship: 'agency', partnerBusinessId: PARTNER, confirmRemove: true }
    h.relationships.set(PARTNER, { id: PARTNER, name: 'Agency A', takenByAnotherBusiness: false, shares: { adAccounts: [], pages: ['120000000000082'], catalogs: [], apps: [] } })
    expect((await preview('set-meta-partner-access', end)).ok).toBe(true)
    h.taken.add('120000000000082')
    expect((await preview('set-meta-partner-access', end)).error).toMatch(/holds an ad account or Page another business in Nexus uses/)
    h.taken.clear()
    h.relationships.set(PARTNER, { id: PARTNER, name: 'Agency A', takenByAnotherBusiness: false, shares: null })
    expect((await preview('set-meta-partner-access', end)).error).toMatch(/did not list the ad accounts and Pages/)
    // A-SF1 (M43) — the portfolio shared in Nexus: nothing ends.
    h.relationships.set(PARTNER, { id: PARTNER, name: 'Agency A', takenByAnotherBusiness: false, shares: { adAccounts: [], pages: [], catalogs: [], apps: [] } })
    h.taken.add('9876543210')
    expect((await preview('set-meta-partner-access', end)).error).toMatch(/ends none/)
    h.taken.clear()
    // A client end: every Instagram account the portfolio holds as a client is looked at; unreadable refuses.
    h.clientInstagram = ['17840000000000002']
    h.taken.add('17840000000000002')
    expect((await preview('set-meta-partner-access', { ...end, relationship: 'client' })).error).toMatch(/as a client, an Instagram account/)
    h.taken.clear()
    h.clientInstagram = null
    expect((await preview('set-meta-partner-access', { ...end, relationship: 'client' })).error).toMatch(/could not read in full the Instagram accounts/)
    expect(h.send).not.toHaveBeenCalled()
  })
  it('ending a relationship: confirmRemove, the whole of it said, no undo', async () => {
    h.relationships.set(PARTNER, { id: PARTNER, name: 'Agency A', takenByAnotherBusiness: false, shares: { adAccounts: ['1234567891'], pages: [], catalogs: [], apps: [] } })
    const end = { action: 'end-relationship', relationship: 'agency', partnerBusinessId: PARTNER, confirmRemove: true }
    const p = (await preview('set-meta-partner-access', end)).preview
    expect(p.warnings[0]).toMatch(/WHOLE agency relationship.*NO UNDO/)
    h.send.mockImplementationOnce(async () => { h.relationships.delete(PARTNER); return { node: { success: true }, readBack: 'none', waitedMs: 0 } })
    const ran = await run('set-meta-partner-access', end, p)
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: '9876543210', kind: 'accessportfolio', edge: 'agencies', method: 'DELETE', params: { business: PARTNER } })
    expect(ran.data.sentence).toMatch(/Meta made all 1 request/)
    const t = tool('set-meta-partner-access')
    expect(await t.undo!.current(ran.change!)).toBeNull()
    expect(t.undo!.request(ran.change!)).toEqual({ refusal: expect.stringMatching(/no undo/) })
    // A client relationship only when the chosen Page and Instagram account are the portfolio's own.
    h.owned = { page: false, instagram: 'none' }
    h.relationships.set(PARTNER, { id: PARTNER, name: 'Client A', takenByAnotherBusiness: false, shares: { adAccounts: [], pages: [], catalogs: [], apps: [] } })
    expect((await preview('set-meta-partner-access', { ...end, relationship: 'client' })).error).toMatch(/chosen Facebook Page is not the business portfolio's own/)
  })
})

describe('a dataset (Owner option 1)', () => {
  const PIXEL = '120000000000050'
  const PIXEL_SET = { asset: 'pixel', pixelId: PIXEL, action: 'set', personId: PERSON, tasks: ['ANALYZE', 'UPLOAD'] }
  it('a person: named with pixelId; no removal; a first grant runs and its undo says Meta has no way back', async () => {
    expect((await preview('set-meta-user-access', { ...PIXEL_SET, pixelId: undefined })).error).toMatch(/Name the dataset: pixelId/)
    expect((await preview('set-meta-user-access', { ...SET, pixelId: PIXEL })).error).toMatch(/pixelId goes only with asset pixel/)
    expect((await preview('set-meta-user-access', { asset: 'pixel', pixelId: PIXEL, action: 'remove', personId: PERSON, confirmRemove: true })).error).toMatch(/no way to take a person's tasks on a dataset back by API/)
    h.assigned = new Map([[OWNER, { id: OWNER, name: 'Person B', tasks: ['ADVERTISE', 'ANALYZE', 'EDIT'] }]])
    const p = (await preview('set-meta-user-access', PIXEL_SET)).preview
    expect(p.warnings.join(' ')).toMatch(/No undo: Meta has no way to take these tasks back by API/)
    h.send.mockImplementationOnce(async () => { h.assigned.set(PERSON, { id: PERSON, name: 'Person A', tasks: ['ANALYZE', 'UPLOAD'] }); return { node: { success: true }, readBack: 'none', waitedMs: 0 } })
    const ran = await run('set-meta-user-access', PIXEL_SET, p)
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: PIXEL, kind: 'accesspixel', edge: 'assigned_users', params: { user: PERSON, tasks: '["ANALYZE","UPLOAD"]' } })
    expect(tool('set-meta-user-access').undo!.request(ran.change!)).toEqual({ refusal: expect.stringMatching(/no way to take a person's tasks on a dataset back by API/) })
  })
  it('a partner off a dataset goes on the query; its undo shares it again, naming the dataset', async () => {
    h.partners.set(PARTNER, { id: PARTNER, name: 'Agency A', tasks: ['ANALYZE', 'UPLOAD'], accessStatus: null, takenByAnotherBusiness: false })
    const remove = { action: 'remove', asset: 'pixel', pixelId: PIXEL, partnerBusinessId: PARTNER, confirmRemove: true }
    const p = (await preview('set-meta-partner-access', remove)).preview
    h.send.mockImplementationOnce(async () => { h.partners.delete(PARTNER); return { node: { success: true }, readBack: 'none', waitedMs: 0 } })
    const ran = await run('set-meta-partner-access', remove, p)
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: PIXEL, kind: 'accesspixel', edge: 'agencies', method: 'DELETE', params: {}, via: { query: { business: PARTNER } } })
    const back = tool('set-meta-partner-access').undo!.request(ran.change!) as { args: Record<string, unknown> }
    expect(back.args).toMatchObject({ action: 'share', asset: 'pixel', pixelId: PIXEL, partnerBusinessId: PARTNER, permittedTasks: ['ANALYZE', 'UPLOAD'] })
    expect(() => tool('set-meta-partner-access').input.parse(back.args)).not.toThrow()
  })
  it('a share that waits for the partner: Meta\'s pending request is said, the step done', async () => {
    const share = { action: 'share', asset: 'pixel', pixelId: PIXEL, partnerBusinessId: PARTNER, permittedTasks: ['ANALYZE'] }
    const p = (await preview('set-meta-partner-access', share)).preview
    h.send.mockImplementationOnce(async () => ({ node: { success: true, pending_request_id: '120000000000099' }, readBack: 'none', waitedMs: 0 }))
    const ran = await run('set-meta-partner-access', share, p)
    expect(ran.ok).toBe(true)
    expect(ran.data.steps[0]).toMatchObject({ outcome: 'done', sentence: expect.stringMatching(/pending: Meta answered a sharing request the partner must accept first/) })
  })
  it('server events: read first, the WHOLE list sent, read back; undo sends the old list', async () => {
    h.serverEvents = new Map([['120000000000071', { id: '120000000000071', name: 'Partner A', takenByAnotherBusiness: false }]])
    const ev = { action: 'server-events', asset: 'pixel', pixelId: PIXEL, businessIds: ['120000000000072', '120000000000071'] }
    expect((await preview('set-meta-partner-access', { ...ev, asset: 'ad-account', pixelId: undefined })).error).toMatch(/server-events is a dataset's/)
    const p = (await preview('set-meta-partner-access', ev)).preview
    expect(p.warnings[0]).toMatch(/WHOLE list/)
    h.send.mockImplementationOnce(async () => {
      h.serverEvents.set('120000000000072', { id: '120000000000072', name: null, takenByAnotherBusiness: false })
      return { node: { success: true }, readBack: 'none', waitedMs: 0 }
    })
    const ran = await run('set-meta-partner-access', ev, p)
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: PIXEL, kind: 'accesspixel', params: { server_events_business_ids: '["120000000000071","120000000000072"]' }, operation: 'access.accesspixel.server_events', via: {}, expectedIds: ['120000000000071'] })
    expect(ran.data).toMatchObject({ businesses: ['120000000000071', '120000000000072'] })
    const t = tool('set-meta-partner-access')
    expect(await t.undo!.current(ran.change!)).toEqual(ran.change!.after)
    const back = t.undo!.request(ran.change!) as { args: Record<string, unknown> }
    // The undo takes 120000000000072 off again: a removal, so it carries confirmRemove.
    expect(back.args).toMatchObject({ action: 'server-events', asset: 'pixel', pixelId: PIXEL, businessIds: ['120000000000071'], confirmRemove: true })
    expect(() => t.input.parse(back.args)).not.toThrow()
    // Option-1 review SF3 (P-T1) — a business added in Meta after the preview: the run reads it, refuses, sends nothing.
    h.send.mockReset()
    h.serverEvents = new Map([['120000000000071', { id: '120000000000071', name: 'Partner A', takenByAnotherBusiness: false }]])
    // confirmRemove so the rebuilt draft stands and only the changed basis (the list as read) stops the run.
    const evC = { ...ev, confirmRemove: true }
    const p2 = (await preview('set-meta-partner-access', evC)).preview
    h.serverEvents.set('120000000000074', { id: '120000000000074', name: null, takenByAnotherBusiness: false })
    const stale = await run('set-meta-partner-access', evC, p2)
    expect(stale).toEqual({ ok: false, error: expect.stringMatching(/changed since this was approved/) })
    expect(h.send).not.toHaveBeenCalled()
    // Another Nexus business's portfolio is never asked for.
    h.taken.add('120000000000073')
    expect((await preview('set-meta-partner-access', { ...ev, businessIds: ['120000000000073'] })).error).toMatch(/another business in Nexus uses/)
  })
})
