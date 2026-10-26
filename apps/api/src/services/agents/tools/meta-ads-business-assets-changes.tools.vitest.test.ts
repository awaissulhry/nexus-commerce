/**
 * Meta step 43 — create-meta-backed-account and set-meta-billing as the approval gate uses them (Meta, the account and the
 * reads are stand-ins): the change contract of every Meta change tool; a preview from the live state ("Meta has no check");
 * refused — nothing queued — when it would do nothing (an account that exists, a name the group has) or when Nexus cannot
 * tell; the floors before anything is sent (a shared portfolio, a disabled ad account, confirmDelete); a run only as a
 * request a person approved, the request sent as the kit builds it; undo reads the group live and puts back what was
 * changed through the same tool; a backed account and a delete have none. Made-up ids and names.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Req = { operation: string; path: string; query?: Record<string, unknown> }
const h = vi.hoisted(() => ({
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown> | { refusal: string },
  state: {} as Record<string, unknown>,
  ownAssets: { adAccounts: ['1234567890'] as string[] | null, pages: ['120000000000010'] as string[] | null, instagram: [] as string[] | null },
  taken: new Set<string>(),
  answer: null as null | ((req: Req) => unknown),
  calls: [] as Req[],
  send: vi.fn(),
}))
vi.mock('../../marketing/meta-ads/change-account.js', () => ({ metaChangeAccount: vi.fn(async () => h.account) }))
vi.mock('../../marketing/meta-ads/live-access-change.js', () => ({
  accessAccount: vi.fn(async () => ({ connectionId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', pageId: '120000000000010', instagramId: '17840000000000001', businessId: '9876543210', connection: { systemUser: { id: '120000000000001', name: 'Nexus' } } })),
  liveAccessState: vi.fn(async () => structuredClone(h.state)),
  livePortfolioOwnAssets: vi.fn(async () => structuredClone(h.ownAssets)),
}))
vi.mock('../../marketing/meta-ads/taken.js', () => ({ takenIds: vi.fn(async (_p: string, ids: string[]) => new Set(ids.filter((id) => h.taken.has(id)))) }))
vi.mock('../../marketing/meta-ads/read-client.js', () => ({
  metaReadOne: vi.fn(async (_t: unknown, req: Req) => {
    h.calls.push(req)
    const out = h.answer?.(req)
    if (out instanceof Error) throw out
    return { body: out ?? { data: [] }, calls: 1 }
  }),
  metaReadAll: vi.fn(async () => ({ rows: 0, calls: 1, truncated: false })),
}))
vi.mock('../../marketing/meta-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/write-client.js')>()),
  metaSendChange: h.send,
}))

import { META_ADS_BUSINESS_ASSET_CHANGE_TOOLS } from './meta-ads-business-assets-changes.tools.js'
import { META_CHANGE_RULES } from './meta-ads-kit.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { bulkApproveRefusal } from '../../agent-fleet/bulk-approve-policy.js'
import { BILLING_SHARED } from '../../marketing/meta-ads/live-business-assets-change.js'
import { MetaReadError, failureOfAnswer } from '../../marketing/meta-ads/errors.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import type { AgentTool, ToolContext, ToolResult } from '../tool-types.js'

const tool = (name: string) => META_ADS_BUSINESS_ASSET_CHANGE_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const ask = (t: AgentTool, args: Record<string, unknown>) => t.input.parse(args) as Record<string, unknown>
const preview = async (name: string, args: Record<string, unknown>) => (await tool(name).handler(ask(tool(name), args), asker)) as ToolResult & { preview: Record<string, any>; error?: string }
const run = async (name: string, args: Record<string, unknown>, p: unknown) => (await tool(name).execute!(ask(tool(name), args), approved(p))) as ToolResult & { data: Record<string, any>; error?: string }

const PORTFOLIO = '9876543210'
const PAGE = '120000000000010'
const IG = '17840000000000001'
const LINE = '120000000000300'
const GROUP_A = '120000000000310'
const GROUP_B = '120000000000311'
const MADE = '120000000000320'
const STATE = { adAccountId: '1234567890', name: 'Shop A ads', status: 1, disableReason: 0, portfolioId: PORTFOLIO, tier: 'development_access' }

let groups: Array<{ id: string; name: string; accounts: string[] }> = []
let pageBacked: string | null = null
function answers(req: Req): unknown {
  if (req.path === `${PORTFOLIO}/extendedcredits`) return { data: [{ id: LINE, owner_business: { id: PORTFOLIO } }] }
  if (req.path === `${LINE}/extended_credit_invoice_groups`) return { data: groups.map((g) => ({ id: g.id, name: g.name })) }
  const group = groups.find((g) => req.path === `${g.id}/ad_accounts`)
  if (group) return { data: group.accounts.map((a) => ({ account_id: a })) }
  if (req.path === `${PAGE}/page_backed_instagram_accounts`) return { data: pageBacked ? [{ id: pageBacked }] : [] }
  if (req.path === `${IG}/instagram_backed_threads_user`) return { data: [] }
  if (req.path === `${IG}/connected_threads_user`) return { data: [] }
  if (req.path === PAGE) return { id: PAGE }
  return { data: [] }
}

beforeEach(() => {
  __metaObjectLimitsTest.useMemory()
  vi.unstubAllEnvs()
  h.send.mockReset()
  h.account = { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' }
  h.state = structuredClone(STATE)
  h.ownAssets = { adAccounts: ['1234567890'], pages: [PAGE], instagram: [] }
  h.taken = new Set()
  h.answer = answers
  h.calls.length = 0
  groups = [{ id: GROUP_A, name: 'Group A', accounts: ['1234567890'] }, { id: GROUP_B, name: 'Group B', accounts: [] }]
  pageBacked = null
})

describe('the tools', () => {
  it('each is a change a person always approves, the #691 truth, its MATERIAL fields, its permissions, its reversibility', () => {
    for (const t of META_ADS_BUSINESS_ASSET_CHANGE_TOOLS) {
      expect(t, t.name).toMatchObject({ readOnly: false, alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, category: 'advertising' })
      expect(t.description.endsWith(META_CHANGE_RULES), t.name).toBe(true)
      expect(MATERIAL_PREVIEW_FIELDS[t.name]).toEqual(['basis', 'plan', 'reach'])
    }
    expect(tool('create-meta-backed-account')).toMatchObject({ reversibility: 'none', requires: ['ads.campaigns.manage'] })
    expect(tool('create-meta-backed-account').undo).toBeUndefined()
    expect(tool('set-meta-billing')).toMatchObject({ reversibility: 'partial', requires: ['ads.budgets.edit', 'financials.adspend.view'] })
    expect(tool('set-meta-billing').consequencesFor!({ action: 'delete-group' })).toEqual({ reversibility: 'none' })
    expect(tool('set-meta-billing').consequencesFor!({ action: 'rename-group' })).toEqual({ reversibility: 'full' })
    expect(bulkApproveRefusal('set-meta-billing')).toMatch(/approved on its own/)
    expect(bulkApproveRefusal('create-meta-backed-account')).toBeTruthy()
  })
})

describe('create-meta-backed-account', () => {
  it('preview: one POST on the chosen Page\'s edge, no body, Meta has no check, nothing spends', async () => {
    const p = (await preview('create-meta-backed-account', { kind: 'instagram-for-page' })).preview
    expect(p.requests).toEqual([{ step: 1, label: `Make a Page-backed Instagram account for the chosen Page ${PAGE}`, metaCheck: 'no-check' }])
    expect(p.spendsMoney).toBe(false)
    expect(p.warnings.join(' ')).toMatch(/Meta documents no delete/)
    expect(h.send).not.toHaveBeenCalled()
  })
  it('one exists: refused, nothing queued (Meta would only answer it)', async () => {
    pageBacked = '17840000000000050'
    expect((await preview('create-meta-backed-account', { kind: 'instagram-for-page' })).error).toMatch(/already \(id 17840000000000050\)/)
  })
  it('the Page read refused: refused (Nexus asks for nothing it cannot check)', async () => {
    h.answer = (req) => (req.path === `${PAGE}/page_backed_instagram_accounts` ? new MetaReadError(failureOfAnswer({ status: 400, verdict: { errorClass: 'forbidden', channelCode: '200', channelMessage: 'Permissions error' } as never }), 'x', 1) : answers(req))
    expect((await preview('create-meta-backed-account', { kind: 'instagram-for-page' })).error).toMatch(/could not read whether the chosen Page has/)
  })
  it('runs as approved: the request as built, Meta\'s new id recorded, no undo', async () => {
    const p = (await preview('create-meta-backed-account', { kind: 'threads-for-instagram' })).preview
    h.send.mockImplementationOnce(async () => ({ node: { id: '900000000000005' }, readBack: 'none', waitedMs: 0 }))
    const ran = await run('create-meta-backed-account', { kind: 'threads-for-instagram' }, p)
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: IG, kind: 'backedinstagram', edge: 'instagram_backed_threads_user', params: {}, operation: 'assets.backed.threads-for-instagram', skipReadBack: true })
    expect(ran.data).toMatchObject({ madeId: '900000000000005', sentence: 'Meta made all 1 request.' })
    expect(ran.data.steps[0].sentence).toMatch(/Meta made it \(id 900000000000005\)/)
    expect(ran.change!.after).toMatchObject({ kind: 'threads-for-instagram', objectId: IG, madeId: '900000000000005' })
  })
})

describe('set-meta-billing', () => {
  it('rename-group: preview, run, undo reads the group and renames it back through the same tool', async () => {
    const args = { action: 'rename-group', invoiceGroupId: GROUP_A, name: 'Group C' }
    const p = (await preview('set-meta-billing', args)).preview
    expect(p.changes).toEqual({ name: { from: 'Group A', to: 'Group C' } })
    h.send.mockImplementationOnce(async () => { groups[0].name = 'Group C'; return { node: { id: GROUP_A, name: 'Group C' }, readBack: 'second-read', waitedMs: 0 } })
    const ran = await run('set-meta-billing', args, p)
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: GROUP_A, kind: 'invoicegroup', params: { name: 'Group C' }, operation: 'billing.invoiceGroup.rename' })
    const t = tool('set-meta-billing')
    expect(await t.undo!.current(ran.change!)).toEqual(ran.change!.after)
    const back = t.undo!.request(ran.change!) as { tool: string; args: Record<string, unknown> }
    expect(back).toMatchObject({ tool: 'set-meta-billing', args: { connectionId: 'm-1', action: 'rename-group', invoiceGroupId: GROUP_A, name: 'Group A' } })
    expect(() => t.input.parse(back.args)).not.toThrow()
  })
  it('create-group: Meta\'s new id recorded; its undo deletes exactly that group (confirmDelete), and only while it is empty', async () => {
    const args = { action: 'create-group', name: 'Group D' }
    const p = (await preview('set-meta-billing', args)).preview
    h.send.mockImplementationOnce(async () => { groups.push({ id: MADE, name: 'Group D', accounts: [] }); return { node: { id: MADE, name: 'Group D' }, readBack: 'second-read', waitedMs: 0 } })
    const ran = await run('set-meta-billing', args, p)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: LINE, kind: 'creditline', edge: 'extended_credit_invoice_groups', params: { name: 'Group D' } })
    expect(ran.change!.after).toMatchObject({ op: 'create-group', groupId: MADE, exists: true })
    const t = tool('set-meta-billing')
    expect(await t.undo!.current(ran.change!)).toEqual(ran.change!.after)
    const back = t.undo!.request(ran.change!) as { tool: string; args: Record<string, unknown> }
    expect(back.args).toMatchObject({ action: 'delete-group', invoiceGroupId: MADE, confirmDelete: true })
    expect(() => t.input.parse(back.args)).not.toThrow()
  })
  it('add-account: BILLING said plainly; the undo moves the chosen ad account back to the group that billed it', async () => {
    const args = { action: 'add-account', invoiceGroupId: GROUP_B }
    const p = (await preview('set-meta-billing', args)).preview
    expect(p.warnings[0]).toMatch(/^BILLING \(money, your decision\)/)
    expect(p.spendsMoney).toBe(false)
    h.send.mockImplementationOnce(async () => { groups[0].accounts = []; groups[1].accounts = ['1234567890']; return { node: { data: [{ account_id: '1234567890' }] }, readBack: 'second-read', waitedMs: 0 } })
    const ran = await run('set-meta-billing', args, p)
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: GROUP_B, edge: 'ad_accounts', params: { ad_account_id: 'act_1234567890' }, readBackOf: `${GROUP_B}/ad_accounts` })
    const t = tool('set-meta-billing')
    expect(await t.undo!.current(ran.change!)).toEqual(ran.change!.after)
    expect(t.undo!.request(ran.change!)).toMatchObject({ args: { action: 'add-account', invoiceGroupId: GROUP_A } })
  })
  it('the floors: a shared portfolio, a disabled ad account, a group that bills another business, a delete without confirmDelete or of a group that bills — nothing sent', async () => {
    h.taken = new Set([PORTFOLIO])
    expect((await preview('set-meta-billing', { action: 'rename-group', invoiceGroupId: GROUP_A, name: 'Group C' })).error).toBe(BILLING_SHARED)
    h.taken = new Set(['120000000000099'])
    h.ownAssets = { adAccounts: ['1234567890'], pages: ['120000000000099'], instagram: [] }
    expect((await preview('set-meta-billing', { action: 'rename-group', invoiceGroupId: GROUP_A, name: 'Group C' })).error).toBe(BILLING_SHARED)
    h.taken = new Set(); h.ownAssets = { adAccounts: ['1234567890'], pages: [PAGE], instagram: [] }
    h.state = { ...STATE, status: 2, disableReason: 1 }
    expect((await preview('set-meta-billing', { action: 'rename-group', invoiceGroupId: GROUP_A, name: 'Group C' })).error).toMatch(/Nexus changes nothing on an ad account Meta has disabled/)
    h.state = structuredClone(STATE)
    groups[1].accounts = ['1234567891']; h.taken = new Set(['1234567891'])
    expect((await preview('set-meta-billing', { action: 'rename-group', invoiceGroupId: GROUP_B, name: 'Group C' })).error).toMatch(/another business in Nexus uses \(act_1234567891\)/)
    h.taken = new Set()
    expect((await preview('set-meta-billing', { action: 'delete-group', invoiceGroupId: GROUP_B })).error).toMatch(/takes confirmDelete: true/)
    expect((await preview('set-meta-billing', { action: 'delete-group', invoiceGroupId: GROUP_A, confirmDelete: true })).error).toMatch(/still bills 1 ad account/)
    expect(h.send).not.toHaveBeenCalled()
  })
  it('the brake: with Meta changes switched off the preview says so and the run sends nothing', async () => {
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'off')
    const p = (await preview('set-meta-billing', { action: 'rename-group', invoiceGroupId: GROUP_A, name: 'Group C' })).preview
    expect(p.warnings.join(' ')).toMatch(/NEXUS_META_ADS_WRITES=off/)
    expect(await run('set-meta-billing', { action: 'rename-group', invoiceGroupId: GROUP_A, name: 'Group C' }, p)).toEqual({ ok: false, error: expect.stringMatching(/switched off in Nexus/) })
    expect(h.send).not.toHaveBeenCalled()
  })
  it('the invoice e-mails are never asked of Meta', async () => {
    await preview('set-meta-billing', { action: 'rename-group', invoiceGroupId: GROUP_A, name: 'Group C' })
    expect(h.calls.map((c) => String(c.query?.fields ?? '')).join(' ')).not.toMatch(/email/)
  })
})
