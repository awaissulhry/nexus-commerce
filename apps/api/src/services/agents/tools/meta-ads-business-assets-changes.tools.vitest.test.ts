/**
 * Meta step 43 — create-meta-backed-account as the approval gate uses it (Meta, the account and the reads are stand-ins): the
 * change contract of every Meta change tool; a preview from the live state ("Meta has no check"); refused — nothing queued —
 * when it would do nothing (an account that exists), when Nexus cannot tell, or when the account could run no ad; a run only
 * as a request a person approved, the request sent as the kit builds it; no undo (Meta has no delete). Invoice groups are a
 * read-only guide now (set-meta-billing: meta-ads-business-assets.tools test). Made-up ids and names.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Req = { operation: string; path: string; query?: Record<string, unknown> }
const h = vi.hoisted(() => ({
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown> | { refusal: string },
  answer: null as null | ((req: Req) => unknown),
  calls: [] as Req[],
  send: vi.fn(),
}))
vi.mock('../../marketing/meta-ads/change-account.js', () => ({ metaChangeAccount: vi.fn(async () => h.account) }))
vi.mock('../../marketing/meta-ads/live-access-change.js', () => ({
  accessAccount: vi.fn(async () => ({ connectionId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', pageId: '120000000000010', instagramId: '17840000000000001', businessId: '9876543210', connection: { systemUser: { id: '120000000000001', name: 'Nexus' } } })),
}))
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
import { MetaReadError, failureOfAnswer } from '../../marketing/meta-ads/errors.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import type { AgentTool, ToolContext, ToolResult } from '../tool-types.js'

const tool = (name: string) => META_ADS_BUSINESS_ASSET_CHANGE_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const ask = (t: AgentTool, args: Record<string, unknown>) => t.input.parse(args) as Record<string, unknown>
const preview = async (name: string, args: Record<string, unknown>) => (await tool(name).handler(ask(tool(name), args), asker)) as ToolResult & { preview: Record<string, any>; error?: string }
const run = async (name: string, args: Record<string, unknown>, p: unknown) => (await tool(name).execute!(ask(tool(name), args), approved(p))) as ToolResult & { data: Record<string, any>; error?: string }

const PAGE = '120000000000010'
const IG = '17840000000000001'

let pageBacked: string | null = null
function answers(req: Req): unknown {
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
  h.answer = answers
  h.calls.length = 0
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
    expect(META_ADS_BUSINESS_ASSET_CHANGE_TOOLS.map((t) => t.name)).toEqual(['create-meta-backed-account'])
    // reversibility none: never in a bulk approve.
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
  it('review N1 — a Page-backed Threads account: refused while the Page has no Page-backed Instagram account, or when that read fails', async () => {
    expect((await preview('create-meta-backed-account', { kind: 'threads-for-page' })).error).toMatch(/has no Page-backed Instagram account/)
    pageBacked = '17840000000000050'
    expect((await preview('create-meta-backed-account', { kind: 'threads-for-page' })).preview.warnings.join(' ')).toMatch(/pages_read_engagement/)
    h.answer = (req) => (req.path === `${PAGE}/page_backed_instagram_accounts` ? new MetaReadError(failureOfAnswer({ status: 400, verdict: { errorClass: 'forbidden', channelCode: '200', channelMessage: 'Permissions error' } as never }), 'x', 1) : answers(req))
    expect((await preview('create-meta-backed-account', { kind: 'threads-for-page' })).error).toMatch(/Nexus cannot tell whether the chosen Page/)
    expect(h.send).not.toHaveBeenCalled()
  })
  it('review N2 — the Page\'s connected Instagram account is read and Meta\'s restriction named', async () => {
    h.answer = (req) => (req.path === PAGE && String(req.query?.fields).includes('instagram_business_account') ? { id: PAGE, instagram_business_account: { id: '17840000000000077' } } : answers(req))
    expect((await preview('create-meta-backed-account', { kind: 'instagram-for-page' })).preview.warnings.join(' ')).toMatch(/connected Instagram account \(17840000000000077\)/)
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
