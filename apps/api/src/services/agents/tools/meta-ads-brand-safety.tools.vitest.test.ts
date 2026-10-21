/**
 * Meta step 39 — set-meta-brand-safety, set-meta-block-list and remove-meta-block-list as the approval gate uses them
 * (Meta, the account and the live reads are stand-ins; the drafts, the kit and the registration are real): each is a
 * change a person always approves; Meta has no check for any of them (said, never asked); a looser setting on an ad set
 * that is on is SPENDS MONEY; a run happens only as an approved request, request by request, judged by its own read-back;
 * a list made from a draft takes the draft id Meta answered and waits for it; Meta refusing for its capability grant
 * answers with the no-grant controls (D6); undo asks for the opposite change through a tool that parses it. Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const TARGETING = { geo_locations: { countries: ['IT'] }, age_min: 18, brand_safety_content_filter_levels: ['FEED_STANDARD'] }
const h = vi.hoisted(() => ({
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown> | { refusal: string },
  adSet: null as Record<string, unknown> | Error | null,
  accountLevels: [] as string[],
  delivering: true as boolean | null,
  safety: {} as Record<string, unknown>,
  send: vi.fn(),
  check: vi.fn(async () => undefined),
  wait: vi.fn(async () => undefined),
}))
vi.mock('../../marketing/meta-ads/change-account.js', () => ({ metaChangeAccount: vi.fn(async () => h.account) }))
vi.mock('../../marketing/meta-ads/live-brand-safety.js', async () => {
  const { MetaLiveRefusal } = await import('../../marketing/meta-ads/live.js')
  return {
    liveAdSetSafety: vi.fn(async (_a: unknown, id: string) => {
      if (h.adSet instanceof Error) throw h.adSet
      if (!h.adSet) throw new MetaLiveRefusal(`Ad set ${id} does not belong to the ad account this business chose, so Nexus changes nothing on it.`)
      return structuredClone(h.adSet)
    }),
    liveAccountFilter: vi.fn(async () => h.accountLevels),
    accountDelivering: vi.fn(async () => h.delivering),
    ownPortfolio: vi.fn(async () => '9876543210'),
    waitForBlockListDraft: h.wait,
  }
})
vi.mock('../../marketing/meta-ads/live-safety.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live-safety.js')>()),
  liveSafety: vi.fn(async (input: { view: string }) => structuredClone(h.safety[input.view] ?? {})),
}))
vi.mock('../../marketing/meta-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live.js')>()),
  metaChosenAccount: vi.fn(async () => ({ connectionId: 'm-1', adAccountId: '1234567890', businessId: '9876543210' })),
}))
vi.mock('../../marketing/meta-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/write-client.js')>()),
  metaCheckChange: h.check,
  metaSendChange: h.send,
}))

import { META_ADS_BRAND_SAFETY_TOOLS } from './meta-ads-brand-safety.tools.js'
import { META_CHANGE_RULES } from './meta-ads-kit.js'
import { MetaWriteError } from '../../marketing/meta-ads/write-client.js'
import { localFailure } from '../../marketing/meta-ads/errors.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import type { ToolContext, ToolResult } from '../tool-types.js'

const tool = (name: string) => META_ADS_BRAND_SAFETY_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview })
const ask = (name: string, args: Record<string, unknown>) => tool(name).input.parse(args) as Record<string, unknown>
const preview = async (name: string, args: Record<string, unknown>, ctx = asker) => (await tool(name).handler(ask(name, args), ctx)) as ToolResult & { preview: Record<string, any> }
const run = async (name: string, args: Record<string, unknown>) => {
  const p = await preview(name, args)
  expect(p.ok, p.error).toBe(true)
  return (await tool(name).execute!(ask(name, args), approved(p.preview))) as ToolResult & { data: Record<string, any> }
}
const AD_SET = { id: '120000000000002', name: 'Ad set B', status: 'ACTIVE', campaign: { id: '120000000000001', name: 'Campaign A', status: 'ACTIVE' }, targeting: TARGETING }
const LIST = { blockList: { blockListId: '120000000000601', name: 'List A', items: 1, ownerAdAccountId: '1234567890', ownerBusinessId: null }, sharedWithBusinesses: [], peopleRoles: null, peopleRolesNotRead: 'not asked', appliedToAdAccounts: [] }

beforeEach(() => {
  __metaObjectLimitsTest.useMemory()
  vi.unstubAllEnvs()
  h.send.mockReset(); h.check.mockClear(); h.wait.mockClear()
  h.account = { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' }
  h.adSet = structuredClone(AD_SET)
  h.accountLevels = []
  h.delivering = true
  h.safety = { 'block-list': structuredClone(LIST), 'block-lists': { items: [{ blockListId: '120000000000601', name: 'List A' }] } }
})

describe('the tools', () => {
  it('each is a change a person always approves (ask ceiling, open world, high risk), registered for the re-check, with its undo or none', () => {
    for (const t of META_ADS_BRAND_SAFETY_TOOLS) {
      expect(t, t.name).toMatchObject({ readOnly: false, alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, requires: ['ads.campaigns.manage'], category: 'advertising' })
      expect(t.description.endsWith(META_CHANGE_RULES), t.name).toBe(true)
      expect(t.description, t.name).toMatch(/Meta has no check for this change/)
      expect(MATERIAL_PREVIEW_FIELDS[t.name]).toEqual(['basis', 'plan', 'reach'])
    }
    expect(tool('set-meta-brand-safety').undo).toBeDefined()
    expect(tool('set-meta-block-list').undo).toBeDefined()
    expect(tool('remove-meta-block-list')).toMatchObject({ reversibility: 'none' })
    expect(tool('remove-meta-block-list').undo).toBeUndefined()
    expect(() => tool('remove-meta-block-list').input.parse({ kind: 'publisher', blockListId: '1' })).toThrow()
    expect(() => tool('set-meta-block-list').input.parse({ action: 'create', name: 'A', urls: Array.from({ length: 251 }, (_, i) => `s${i}.example.com`) })).toThrow()
    expect(() => tool('set-meta-brand-safety').input.parse({ adSets: Array.from({ length: 7 }, (_, i) => ({ adSetId: String(i + 1), addCategories: ['dating'] })) })).toThrow()
    expect(() => tool('set-meta-brand-safety').input.parse({ adSets: [{ adSetId: '1', addCategories: ['news'] }] })).toThrow()
  })
})

describe('set-meta-brand-safety', () => {
  it('the preview: built from the live state, Meta never asked to check (it has none); stricter spends nothing; looser on an ad set that is on is SPENDS MONEY first', async () => {
    const strict = await preview('set-meta-brand-safety', { adSets: [{ adSetId: AD_SET.id, filterLevels: { feed: 'LIMITED' }, addCategories: ['gambling'] }] })
    expect(strict.ok).toBe(true)
    expect(h.check).not.toHaveBeenCalled()
    expect(strict.preview).toMatchObject({ spendsMoney: false, metaCheck: { checked: 'none', sentence: expect.stringMatching(/^Meta has no check for this change/) }, requests: [{ step: 1, metaCheck: 'no-check' }] })
    const loose = await preview('set-meta-brand-safety', { adSets: [{ adSetId: AD_SET.id, filterLevels: { feed: 'EXPANDED' } }] })
    expect(loose.preview.spendsMoney).toBe(true)
    expect(loose.preview.warnings[0]).toMatch(/^SPENDS MONEY \(your decision\): ad set "Ad set B" \(120000000000002\) is on: the feeds inventory filter from Moderate to Expanded/)
  })
  it('refused in words: both or neither of adSets and account, an ad set of another account, a level looser than the account\'s', async () => {
    expect(await preview('set-meta-brand-safety', { adSets: [{ adSetId: AD_SET.id, addCategories: ['dating'] }], account: { filterLevels: { feed: 'LIMITED' } } })).toEqual({ ok: false, error: expect.stringMatching(/one of them/) })
    h.adSet = null
    expect(await preview('set-meta-brand-safety', { adSets: [{ adSetId: AD_SET.id, addCategories: ['dating'] }] })).toEqual({ ok: false, error: expect.stringMatching(/does not belong to the ad account/) })
    h.adSet = structuredClone(AD_SET)
    h.accountLevels = ['FEED_STRICT']
    expect(await preview('set-meta-brand-safety', { adSets: [{ adSetId: AD_SET.id, filterLevels: { feed: 'EXPANDED' } }] })).toEqual({ ok: false, error: expect.stringMatching(/looser than the ad account's own/) })
  })
  it('the run: the whole spec, judged by its read-back; before → after recorded on its own account; a read-back that does not show it = not confirmed', async () => {
    h.send.mockImplementation(async () => ({ node: { id: AD_SET.id, targeting: { ...TARGETING, excluded_publisher_categories: ['gambling'] } }, readBack: 'second-read', waitedMs: 0 }))
    const ran = await run('set-meta-brand-safety', { adSets: [{ adSetId: AD_SET.id, addCategories: ['gambling'] }] })
    expect(ran.ok).toBe(true)
    const [, change] = h.send.mock.calls[0]
    expect(change).toMatchObject({ objectId: AD_SET.id, kind: 'adsettargeting', operation: 'adset.brandSafety', readBackFields: 'id,targeting', params: { targeting: JSON.stringify({ ...TARGETING, excluded_publisher_categories: ['gambling'] }) } })
    expect(typeof change.judge).toBe('function')
    expect(ran.data.steps[0]).toMatchObject({ outcome: 'done', sentence: expect.stringMatching(/Meta made it; it now reads excluded_publisher_categories \[gambling\]/) })
    expect(ran.change).toMatchObject({ before: { adSets: [{ id: AD_SET.id, safety: { excluded_publisher_categories: [] } }], accountId: 'm-1', adAccountId: '1234567890' }, after: { adSets: [{ id: AD_SET.id, safety: { excluded_publisher_categories: ['gambling'] } }] } })
    h.send.mockReset()
    h.send.mockImplementation(async () => ({ node: { id: AD_SET.id, targeting: TARGETING }, readBack: 'second-read', waitedMs: 0 }))
    const moved = await run('set-meta-brand-safety', { adSets: [{ adSetId: AD_SET.id, addCategories: ['gambling'] }] })
    expect(moved).toEqual({ ok: false, error: expect.stringMatching(/^Not confirmed: 1\. .*reads back excluded_publisher_categories none, not what was asked/) })
  })
  it('review A5 — undo\'s "has it moved?" does not depend on the order Meta answers a list in (ad set and account)', async () => {
    h.send.mockImplementation(async () => ({ node: { id: AD_SET.id, targeting: { ...TARGETING, excluded_publisher_categories: ['gambling', 'dating'] } }, readBack: 'second-read', waitedMs: 0 }))
    const ran = await run('set-meta-brand-safety', { adSets: [{ adSetId: AD_SET.id, addCategories: ['gambling', 'dating'] }] })
    expect((ran.change!.after as { adSets: Array<{ safety: Record<string, string[]> }> }).adSets[0].safety.excluded_publisher_categories).toEqual(['dating', 'gambling'])
    h.adSet = { ...AD_SET, targeting: { ...TARGETING, excluded_publisher_categories: ['gambling', 'dating'] } }
    expect(await tool('set-meta-brand-safety').undo!.current(ran.change!)).toEqual(ran.change!.after)
    h.accountLevels = ['FEED_STANDARD']
    h.send.mockReset()
    h.send.mockImplementation(async () => ({ node: { id: 'act_1234567890', brand_safety_content_filter_levels: ['FEED_STANDARD', 'AN_STRICT'] }, readBack: 'second-read', waitedMs: 0 }))
    const acc = await run('set-meta-brand-safety', { account: { filterLevels: { audienceNetwork: 'LIMITED' } } })
    expect(acc.change!.after).toMatchObject({ account: { levels: ['AN_STRICT', 'FEED_STANDARD'] } })
    h.accountLevels = ['FEED_STANDARD', 'AN_STRICT']
    expect(await tool('set-meta-brand-safety').undo!.current(acc.change!)).toEqual(acc.change!.after)
  })
  it('the ad account\'s filter: one request on act_<id>, read back from the account', async () => {
    h.accountLevels = ['FEED_STANDARD']
    h.send.mockImplementation(async () => ({ node: { id: 'act_1234567890', brand_safety_content_filter_levels: ['FEED_STRICT'] }, readBack: 'second-read', waitedMs: 0 }))
    const ran = await run('set-meta-brand-safety', { account: { filterLevels: { feed: 'LIMITED' } } })
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: 'act_1234567890', kind: 'adaccount', edge: 'brand_safety_content_filter_levels', readBackOf: 'act_1234567890', params: { brand_safety_content_filter_levels: '["FEED_STRICT"]' } })
    expect(tool('set-meta-brand-safety').undo!.request(ran.change!)).toEqual({ tool: 'set-meta-brand-safety', args: { connectionId: 'm-1', account: { filterLevels: { feed: 'MODERATE' } }, why: 'undo of an earlier Meta brand-safety change' } })
  })
  it('undo: the old keys back through the same tool (its arguments parse); current() equals the record while nothing moved', async () => {
    h.send.mockImplementation(async () => ({ node: { id: AD_SET.id, targeting: { ...TARGETING, brand_safety_content_filter_levels: ['FEED_STRICT'], excluded_publisher_categories: ['gambling'] } }, readBack: 'second-read', waitedMs: 0 }))
    const ran = await run('set-meta-brand-safety', { adSets: [{ adSetId: AD_SET.id, addCategories: ['gambling'], filterLevels: { feed: 'LIMITED' } }] })
    const back = tool('set-meta-brand-safety').undo!.request(ran.change!) as { tool: string; args: Record<string, unknown> }
    expect(back).toEqual({ tool: 'set-meta-brand-safety', args: { connectionId: 'm-1', adSets: [{ adSetId: AD_SET.id, filterLevels: { feed: 'MODERATE' }, removeCategories: ['gambling'] }], why: 'undo of an earlier Meta brand-safety change' } })
    expect(() => tool('set-meta-brand-safety').input.parse(back.args)).not.toThrow()
    h.adSet = { ...AD_SET, targeting: { ...TARGETING, brand_safety_content_filter_levels: ['FEED_STRICT'], excluded_publisher_categories: ['gambling'] } }
    expect(await tool('set-meta-brand-safety').undo!.current(ran.change!)).toEqual(ran.change!.after)
    h.adSet = structuredClone(AD_SET)
    expect(await tool('set-meta-brand-safety').undo!.current(ran.change!)).not.toEqual(ran.change!.after)
  })
})

describe('set-meta-block-list', () => {
  it('create: the draft (the file Nexus wrote), then the list made from the draft id Meta answered, after Meta read it; no undo (review A3)', async () => {
    h.send
      .mockImplementationOnce(async () => ({ node: { id: '120000000000801', async_job_status: 'scheduled' }, readBack: 'second-read', waitedMs: 0 }))
      .mockImplementationOnce(async () => ({ node: { id: '120000000000602', name: 'List B' }, readBack: 'second-read', waitedMs: 0 }))
    const ran = await run('set-meta-block-list', { action: 'create', name: 'List B', urls: ['example.com', 'https://www.facebook.com/a-page'] })
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls.map((c) => [c[1].objectId, c[1].edge, c[1].params])).toEqual([
      ['9876543210', 'block_list_drafts', { publisher_urls_file: 'example.com\nhttps://www.facebook.com/a-page', publisher_urls_file_name: 'publisher_urls.txt' }],
      ['9876543210', 'publisher_block_lists', { name: 'List B', draft_id: '120000000000801' }],
    ])
    expect(h.wait).toHaveBeenCalledWith('m-1', '120000000000801')
    expect(ran.change!.after).toMatchObject({ action: 'create', blockListId: '120000000000602', name: 'List B' })
    // Meta answers "a newly created or updated" list: it may be an older same-name list the ad account cannot see.
    expect(tool('set-meta-block-list').undo!.request(ran.change!)).toEqual({ refusal: expect.stringMatching(/cannot undo this create: Meta may have replaced an older list .* ask remove-meta-block-list/) })
    expect(tool('set-meta-block-list').consequencesFor!({ action: 'create' })).toEqual({ reversibility: 'none' })
    expect(h.send.mock.calls[1][1].runId).toBe(h.send.mock.calls[0][1].runId)
    expect(h.send.mock.calls[0][1].runId).toMatch(/^[0-9a-f-]{36}$/)
  })
  it('review A3 — the name check reads every page of the ad account\'s lists; a replace\'s new name may not be another list\'s', async () => {
    const pages: Record<string, unknown> = {}
    h.safety['block-lists'] = { items: [{ blockListId: '120000000000601', name: 'List A' }], nextAfter: 'p2' }
    const { liveSafety } = await import('../../marketing/meta-ads/live-safety.js')
    vi.mocked(liveSafety).mockImplementation(async (input) => structuredClone(input.view === 'block-lists'
      ? (input.after === 'p2' ? { items: [{ blockListId: '120000000000603', name: 'List C' }], nextAfter: null } : h.safety['block-lists'])
      : (h.safety[input.view] ?? pages)) as never)
    expect(await preview('set-meta-block-list', { action: 'create', name: 'List C', urls: ['example.com'] })).toEqual({ ok: false, error: expect.stringMatching(/named "List C" exists \(120000000000603\)/) })
    expect(await preview('set-meta-block-list', { action: 'replace', blockListId: '120000000000601', name: 'List C', urls: ['example.com'] })).toEqual({ ok: false, error: expect.stringMatching(/Another block list is named "List C"/) })
    h.safety['block-lists'] = { items: [], nextAfter: 'again' }
    vi.mocked(liveSafety).mockImplementation(async (input) => structuredClone(input.view === 'block-lists' ? { items: [], nextAfter: 'again' } : (h.safety[input.view] ?? {})) as never)
    expect(await preview('set-meta-block-list', { action: 'create', name: 'List D', urls: ['example.com'] })).toEqual({ ok: false, error: expect.stringMatching(/could not check all their names/) })
    vi.mocked(liveSafety).mockImplementation(async (input: { view: string }) => structuredClone(h.safety[input.view] ?? {}) as never)
  })
  it('a draft Meta could not read stops before the list: the draft is all that was made, and undo has nothing to put back', async () => {
    h.send.mockImplementationOnce(async () => ({ node: { id: '120000000000801' }, readBack: 'second-read', waitedMs: 0 }))
    h.wait.mockImplementationOnce(async () => { throw new MetaWriteError(localFailure('Meta could not read the uploaded file (the draft failed), so no list was made from it.', 'BLOCK_LIST_DRAFT_FAILED'), 'blockList.draftStatus', 'not_sent') })
    const ran = await run('set-meta-block-list', { action: 'create', name: 'List B', urls: ['example.com'] })
    expect(ran.data.steps.map((s: { outcome: string }) => s.outcome)).toEqual(['done', 'not_sent'])
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(ran.data.steps[1].sentence).not.toMatch(/gave no id/)
    expect(tool('set-meta-block-list').undo!.request(ran.change!)).toEqual({ refusal: expect.stringMatching(/cannot undo this create/) })
  })
  it('D6 — Meta refusing for its capability grant: the step names the grant and the no-grant controls', async () => {
    h.send.mockImplementationOnce(async () => { throw new MetaWriteError({ ...localFailure('Meta does not let this system user change this: (#200) Permissions error.', 'X'), origin: 'meta', permissionDenied: true }, 'blockList.applyAccount', 'refused') })
    const ran = await run('set-meta-block-list', { action: 'apply-account', blockListId: '120000000000601' })
    expect(ran).toEqual({ ok: false, error: expect.stringMatching(/Meta has not granted this capability: the app needs Meta's block_list_management_v2_api_access grant\. Meta: .*The no-grant controls are the inventory filter/) })
  })
  it('create-account-list: undo deletes only a list still empty and still the chosen ad account\'s own (never one Meta replaced by name)', async () => {
    h.safety['block-lists'] = { items: [] }
    h.send.mockImplementationOnce(async () => ({ node: { id: '120000000000604', name: 'List E' }, readBack: 'second-read', waitedMs: 0 }))
    const ran = await run('set-meta-block-list', { action: 'create-account-list', name: 'List E' })
    expect(ran.change!.after).toMatchObject({ action: 'create-account-list', blockListId: '120000000000604', items: 0, ownerAdAccountId: '1234567890' })
    const list = (blockList: Record<string, unknown>) => ({ ...structuredClone(LIST), blockList: { ...LIST.blockList, blockListId: '120000000000604', name: 'List E', ...blockList } })
    h.safety['block-list'] = list({ items: 0 })
    expect(await tool('set-meta-block-list').undo!.current(ran.change!)).toEqual(ran.change!.after)
    const back = tool('set-meta-block-list').undo!.request(ran.change!) as { tool: string; args: Record<string, unknown> }
    expect(back).toMatchObject({ tool: 'remove-meta-block-list', args: { kind: 'publisher', blockListId: '120000000000604', confirmDelete: true } })
    expect(() => tool('remove-meta-block-list').input.parse(back.args)).not.toThrow()
    // It has entries now: moved since → undo refused (change-record compares current() with the record).
    h.safety['block-list'] = list({ items: 3 })
    expect(await tool('set-meta-block-list').undo!.current(ran.change!)).toMatchObject({ items: 3 })
    // An older portfolio list Meta replaced by name: owned by the portfolio, not the ad account → refused too.
    h.safety['block-list'] = list({ items: 0, ownerAdAccountId: null, ownerBusinessId: '9876543210' })
    expect(await tool('set-meta-block-list').undo!.current(ran.change!)).toMatchObject({ ownerAdAccountId: null })
    expect(await tool('set-meta-block-list').undo!.current(ran.change!)).not.toEqual(ran.change!.after)
    // A record that does not show an empty list of the ad account's own asks nothing.
    expect(tool('set-meta-block-list').undo!.request({ before: ran.change!.before, after: { ...(ran.change!.after as object), items: 3 } })).toEqual({ refusal: expect.stringMatching(/only an empty list the chosen ad account itself owns/) })
    expect(tool('set-meta-block-list').undo!.request({ before: ran.change!.before, after: { ...(ran.change!.after as object), ownerAdAccountId: null } })).toEqual({ refusal: expect.stringMatching(/only an empty list/) })
  })
  it('a person\'s role needs Team & access; a share names the business and is undone by an unshare that parses', async () => {
    const noTeam: ToolContext = { ...asker, can: (p) => p !== 'users.manage' }
    expect(await tool('set-meta-block-list').handler(ask('set-meta-block-list', { action: 'assign-user', blockListId: '120000000000601', userId: '100000000000001', role: 'APPLY_BLOCK_LIST' }), noTeam)).toEqual({ ok: false, error: expect.stringMatching(/Team & access/) })
    h.send.mockImplementationOnce(async () => ({ node: { data: [{ id: '5550000002' }] }, readBack: 'second-read', waitedMs: 0 }))
    const ran = await run('set-meta-block-list', { action: 'share', blockListId: '120000000000601', agencyId: '5550000002', role: 'APPLY_BLOCK_LIST' })
    expect(ran.ok).toBe(true)
    const back = tool('set-meta-block-list').undo!.request(ran.change!) as { tool: string; args: Record<string, unknown> }
    expect(back).toEqual({ tool: 'set-meta-block-list', args: { connectionId: 'm-1', action: 'unshare', blockListId: '120000000000601', agencyId: '5550000002', role: 'APPLY_BLOCK_LIST', why: 'undo of an earlier Meta block-list change' } })
    expect(() => tool('set-meta-block-list').input.parse(back.args)).not.toThrow()
    // current(): shared now, as the record says; unshared since → it moved.
    h.safety['block-list'] = { ...structuredClone(LIST), sharedWithBusinesses: [{ businessId: '5550000002' }] }
    expect(await tool('set-meta-block-list').undo!.current(ran.change!)).toEqual(ran.change!.after)
    h.safety['block-list'] = structuredClone(LIST)
    expect(await tool('set-meta-block-list').undo!.current(ran.change!)).not.toEqual(ran.change!.after)
  })
  it('a list another business in Nexus owns is refused in words; nothing is sent', async () => {
    h.safety['block-list'] = { blockListId: '120000000000601', takenByAnotherBusiness: true }
    expect(await preview('set-meta-block-list', { action: 'apply-account', blockListId: '120000000000601' })).toEqual({ ok: false, error: expect.stringMatching(/another business in Nexus uses/) })
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('remove-meta-block-list', () => {
  it('only on an explicit ask, only a list of the account or its portfolio, only once unshared and unapplied; one DELETE', async () => {
    h.safety['block-list'] = { ...structuredClone(LIST), sharedWithBusinesses: [{ businessId: '5550000002' }] }
    expect(await preview('remove-meta-block-list', { kind: 'publisher', blockListId: '120000000000601', confirmDelete: true })).toEqual({ ok: false, error: expect.stringMatching(/still shared/) })
    h.safety['block-list'] = { ...structuredClone(LIST), blockList: { ...LIST.blockList, ownerAdAccountId: '5555555555', ownerBusinessId: '5550000002' } }
    expect(await preview('remove-meta-block-list', { kind: 'publisher', blockListId: '120000000000601', confirmDelete: true })).toEqual({ ok: false, error: expect.stringMatching(/not owned by the chosen ad account or its business portfolio/) })
    h.safety['block-list'] = structuredClone(LIST)
    h.send.mockImplementationOnce(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 }))
    const ran = await run('remove-meta-block-list', { kind: 'publisher', blockListId: '120000000000601', confirmDelete: true })
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: '120000000000601', kind: 'publisherblocklist', method: 'DELETE', params: {} })
    expect(ran.data.steps[0].sentence).toMatch(/Meta confirmed it/)
  })
})
