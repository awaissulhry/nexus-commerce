/**
 * Meta step 17 — set-meta-status as the approval gate uses it (Meta, the account and the live reads are stand-ins): the
 * preview is built on Meta's check where Meta has one (campaigns) and says "Meta has no check" where it has none; every
 * switch-on is SPENDS MONEY; a change Meta would refuse is never queued; the re-check reads again without asking Meta to
 * check twice; a run happens only as a request a person approved (in Nexus, or by the "Claude's changes need no
 * approval" switch in that person's name — never by a rule), only when nothing it stands on moved, request by request
 * with a step-by-step report; undo puts back the statuses it replaced (never an archive). Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  live: new Map<string, Record<string, unknown>>(),
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown> | { refusal: string },
  check: vi.fn(async () => undefined),
  send: vi.fn(),
  readBack: vi.fn(async () => 1),
}))
vi.mock('../../marketing/meta-ads/change-account.js', () => ({ metaChangeAccount: vi.fn(async () => h.account) }))
vi.mock('../../marketing/meta-ads/live-status.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live-status.js')>()),
  liveStatusObjects: vi.fn(async (_target: unknown, items: Array<{ kind: string; id: string }>) => {
    const objects = new Map<string, unknown>()
    for (const item of items) { const o = h.live.get(`${item.kind}:${item.id}`); if (o) objects.set(`${item.kind}:${item.id}`, structuredClone(o)) }
    return { objects, problems: [] }
  }),
}))
vi.mock('../../marketing/meta-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/write-client.js')>()),
  metaCheckChange: h.check,
  metaSendChange: h.send,
}))
vi.mock('../../marketing/meta-ads/store.js', () => ({ recordStatusReadBack: h.readBack }))

import { META_ADS_STATUS_TOOLS } from './meta-ads-status.tools.js'
import { META_CHANGE_RULES } from './meta-ads-kit.js'
import { MetaWriteError, META_UNKNOWN_OUTCOME } from '../../marketing/meta-ads/write-client.js'
import { localFailure } from '../../marketing/meta-ads/errors.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import type { ToolContext, ToolResult } from '../tool-types.js'

const tool = META_ADS_STATUS_TOOLS.find((t) => t.name === 'set-meta-status')!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const recheck: ToolContext = { can: () => true, via: 'system', approvalId: 'ap-1' }
const approved = (preview: unknown, extra: Partial<ToolContext> = {}): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview, ...extra })
const ask = (args: Record<string, unknown>) => tool.input.parse(args) as Record<string, unknown>
const preview = async (args: Record<string, unknown>, ctx = asker) => (await tool.handler(ask(args), ctx)) as ToolResult & { preview: Record<string, any> }

const CAMPAIGN = { kind: 'campaign', id: '120000000000001', name: 'Campaign A', adAccountId: '1234567890', status: 'ACTIVE', effectiveStatus: 'ACTIVE', objective: 'OUTCOME_SALES', smartPromotionType: null, endTime: null, campaign: null, adSet: null }
const AD_SET = { kind: 'adset', id: '120000000000002', name: 'Ad set B', adAccountId: '1234567890', status: 'PAUSED', effectiveStatus: 'PAUSED', objective: null, smartPromotionType: null, endTime: null, campaign: { id: '120000000000001', name: 'Campaign A', status: 'ACTIVE', effectiveStatus: 'ACTIVE' }, adSet: null }
const done = (status: string) => async () => ({ node: { id: 'x', status, effective_status: status }, readBack: 'same-request', waitedMs: 0 })

beforeEach(() => {
  __metaObjectLimitsTest.useMemory()
  vi.unstubAllEnvs()
  h.check.mockReset(); h.check.mockImplementation(async () => undefined)
  h.send.mockReset()
  h.readBack.mockClear()
  h.account = { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' }
  h.live = new Map([[`campaign:${CAMPAIGN.id}`, CAMPAIGN], [`adset:${AD_SET.id}`, AD_SET]])
})

describe('the tool', () => {
  it('is a change a person always approves (ask ceiling, open world, high risk), with an undo and the #691 truth', () => {
    expect(tool).toMatchObject({ readOnly: false, alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, reversibility: 'partial', requires: ['ads.campaigns.manage'] })
    expect(tool.undo).toBeDefined()
    expect(tool.description.endsWith(META_CHANGE_RULES)).toBe(true)
    expect(tool.description).toMatch(/"Claude's changes need no approval" switch is on, it runs 20 s after the request unless stopped/)
    expect(tool.description).toMatch(/never by a rule of its own/)
    expect(tool.description).toMatch(/SPENDS MONEY/)
    expect(MATERIAL_PREVIEW_FIELDS['set-meta-status']).toEqual(['basis', 'plan', 'reach'])
    expect(tool.consequencesFor!({ items: [{ kind: 'campaign', id: '1' }], status: 'PAUSED' })).toEqual({ reversibility: 'full' })
    expect(tool.consequencesFor!({ items: [{ kind: 'campaign', id: '1', status: 'ARCHIVED' }] })).toEqual({ reversibility: 'none' })
    expect(tool.consequencesFor!({ items: [{ kind: 'campaign', id: '1', status: 'ARCHIVED' }, { kind: 'ad', id: '2', status: 'PAUSED' }] })).toBeNull()
    expect(() => tool.input.parse({ items: [{ kind: 'campaign', id: '1' }], status: 'DELETED' })).toThrow()
    // Review fix A4 — at most 8 items (Meta's Limited access tier), said in the description.
    expect(() => tool.input.parse({ items: Array.from({ length: 8 }, (_, i) => ({ kind: 'ad', id: String(i + 1) })), status: 'PAUSED' })).not.toThrow()
    expect(() => tool.input.parse({ items: Array.from({ length: 9 }, (_, i) => ({ kind: 'ad', id: String(i + 1) })), status: 'PAUSED' })).toThrow()
    expect(tool.description).toMatch(/At most 8 items .*about 3 reads and a change/)
    expect(tool.description).toMatch(/Meta does not list a status change among its ad review triggers/)
  })
})

describe('the preview', () => {
  it('a campaign pause: Meta checks it (validate_only), nothing spends, one request', async () => {
    const out = await preview({ items: [{ kind: 'campaign', id: CAMPAIGN.id }], status: 'PAUSED' })
    expect(out.ok).toBe(true)
    expect(h.check).toHaveBeenCalledTimes(1)
    expect(h.check).toHaveBeenCalledWith({ connectionId: 'm-1', adAccountId: '1234567890' }, { objectId: CAMPAIGN.id, kind: 'campaign', params: { status: 'PAUSED' }, operation: 'campaign.status' })
    expect(out.preview).toMatchObject({ spendsMoney: false, metaCheck: { checked: 'all' }, requests: [{ step: 1, label: 'Pause campaign "Campaign A" (120000000000001)', metaCheck: 'accepted' }], reach: { mode: 'live', accountId: 'm-1', adAccountId: '1234567890' } })
    expect(out.preview.warnings.join(' ')).toMatch(/Its undo changes the same objects again: Meta takes that only 30 s after this change/)
    expect(out.preview.basis).toMatch(/\w+/)
    expect(out.preview.plan).toMatch(/\w+/)
  })
  it('an ad set switched on: Meta has no check for it (said so), SPENDS MONEY first in the warnings', async () => {
    const out = await preview({ items: [{ kind: 'adset', id: AD_SET.id }], status: 'ACTIVE' })
    expect(h.check).not.toHaveBeenCalled()
    expect(out.preview.metaCheck).toEqual({ checked: 'none', sentence: expect.stringMatching(/^Meta has no check for this change/) })
    expect(out.preview.requests[0].metaCheck).toBe('no-check')
    expect(out.preview.spendsMoney).toBe(true)
    expect(out.preview.spendsMoneyBecause[0]).toMatch(/start delivering and spending .*campaign "Campaign A".* is on/)
    expect(out.preview.warnings[0]).toMatch(/^SPENDS MONEY \(your decision\): /)
  })
  it('a campaign and an ad set together: Meta checked "some"; Meta refusing a check queues nothing; a check not made either', async () => {
    const both = await preview({ items: [{ kind: 'campaign', id: CAMPAIGN.id, status: 'PAUSED' }, { kind: 'adset', id: AD_SET.id, status: 'ACTIVE' }] })
    expect(both.preview.metaCheck.checked).toBe('some')
    h.check.mockImplementationOnce(async () => { throw new MetaWriteError(localFailure('Meta refused it (100): Invalid parameter. Nothing was changed.', 'X'), 'c', 'refused') })
    const refused = await preview({ items: [{ kind: 'campaign', id: CAMPAIGN.id }], status: 'PAUSED' })
    expect(refused).toEqual({ ok: false, error: expect.stringMatching(/^Meta would refuse step 1 \(Pause campaign "Campaign A".*Invalid parameter.*Nothing was queued\.$/) })
    h.check.mockImplementationOnce(async () => { throw new MetaWriteError(localFailure('Meta did not answer.', 'X'), 'c', 'not_sent') })
    expect(await preview({ items: [{ kind: 'campaign', id: '120000000000001' }], status: 'PAUSED' })).toEqual({ ok: false, error: expect.stringMatching(/^Not queued: Meta could not check step 1/) })
  })
  it('review fix A2 — until LIVE-PROBE ST17-01 Meta checks only a pause: a campaign archived or switched on is previewed without it, and says so', async () => {
    const archive = await preview({ items: [{ kind: 'campaign', id: CAMPAIGN.id }], status: 'ARCHIVED' })
    expect(h.check).not.toHaveBeenCalled()
    expect(archive.preview.requests[0].metaCheck).toBe('not-used-yet')
    expect(archive.preview.metaCheck).toEqual({ checked: 'none', sentence: expect.stringMatching(/Meta's check is not used for this change yet for 1 request: Nexus asks it only of a pause/) })
    h.live.set(`campaign:${CAMPAIGN.id}`, { ...CAMPAIGN, status: 'PAUSED' })
    const on = await preview({ items: [{ kind: 'campaign', id: CAMPAIGN.id }], status: 'ACTIVE' })
    expect(h.check).not.toHaveBeenCalled()
    expect(on.preview.requests[0].metaCheck).toBe('not-used-yet')
  })
  it('the re-check reads the live state again without asking Meta to check twice: same basis and plan', async () => {
    const first = await preview({ items: [{ kind: 'campaign', id: CAMPAIGN.id }], status: 'PAUSED' })
    h.check.mockClear()
    const again = await preview({ items: [{ kind: 'campaign', id: CAMPAIGN.id }], status: 'PAUSED' }, recheck)
    expect(h.check).not.toHaveBeenCalled()
    expect(again.preview.metaCheck.sentence).toMatch(/Re-check/)
    expect([again.preview.basis, again.preview.plan, again.preview.reach]).toEqual([first.preview.basis, first.preview.plan, first.preview.reach])
  })
  it('says so when writes are switched off; no Meta account chosen = a refusal in words', async () => {
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'off')
    const off = await preview({ items: [{ kind: 'campaign', id: CAMPAIGN.id }], status: 'PAUSED' })
    expect(off.preview.reach.mode).toBe('off')
    expect(off.preview.warnings.join(' ')).toMatch(/NEXUS_META_ADS_WRITES=off/)
    // Review fix A2: no check is sent with Meta changes switched off.
    expect(h.check).not.toHaveBeenCalled()
    expect(off.preview.metaCheck.sentence).toMatch(/switched off in Nexus .*Meta was not asked to check it/)
    expect(off.preview.requests[0].metaCheck).toBe('writes-off')
    h.account = { refusal: 'No Meta ad account is chosen for this business yet.' }
    expect(await preview({ items: [{ kind: 'campaign', id: CAMPAIGN.id }], status: 'PAUSED' })).toEqual({ ok: false, error: 'No Meta ad account is chosen for this business yet.' })
  })
})

describe('the run', () => {
  const args = { items: [{ kind: 'campaign', id: CAMPAIGN.id, status: 'PAUSED' }, { kind: 'adset', id: AD_SET.id, status: 'ACTIVE' }] }
  it('only as a request a PERSON approved — in Nexus or by the no-approval switch in that person\'s name, never by a rule', async () => {
    const p = (await preview(args)).preview
    expect(await tool.execute!(ask(args), { ...approved(p), approvedByPerson: false, decidedVia: 'auto' })).toEqual({ ok: false, error: expect.stringMatching(/never by a rule/) })
    expect(await tool.execute!(ask(args), { ...approved(p), approvedByPerson: false })).toEqual({ ok: false, error: expect.stringMatching(/never by a rule/) })
    expect(await tool.execute!(ask(args), { ...approved(p), approvalId: undefined })).toEqual({ ok: false, error: expect.stringMatching(/only as an approved request/) })
    expect(h.send).not.toHaveBeenCalled()
    // #691: the business's "Claude's changes need no approval" switch approves in the asker's name (decidedVia claude).
    h.send.mockImplementationOnce(done('PAUSED')).mockImplementationOnce(done('ACTIVE'))
    const ran = await tool.execute!(ask(args), approved(p, { decidedVia: 'claude', userId: 'u-claude-user' }))
    expect(ran.ok).toBe(true)
  })
  it('sends request by request in order (the pause first), reads back, records before → after on its own account', async () => {
    const p = (await preview(args)).preview
    h.send.mockImplementationOnce(done('PAUSED')).mockImplementationOnce(done('ACTIVE'))
    const ran = await tool.execute!(ask(args), approved(p)) as ToolResult & { data: Record<string, any> }
    expect(h.send.mock.calls.map((c) => [c[1].objectId, c[1].kind, c[1].params.status, c[1].readBackInPost])).toEqual([[CAMPAIGN.id, 'campaign', 'PAUSED', true], [AD_SET.id, 'adset', 'ACTIVE', false]])
    expect(ran.data).toMatchObject({ done: 2, of: 2, sentence: 'Meta made all 2 requests.', steps: [{ step: 1, outcome: 'done' }, { step: 2, outcome: 'done' }], changeSetId: 'ap-1' })
    expect(ran.change).toEqual({
      before: { items: [{ kind: 'campaign', id: CAMPAIGN.id, name: 'Campaign A', status: 'ACTIVE' }, { kind: 'adset', id: AD_SET.id, name: 'Ad set B', status: 'PAUSED' }], accountId: 'm-1', adAccountId: '1234567890' },
      after: { items: [{ kind: 'campaign', id: CAMPAIGN.id, status: 'PAUSED' }, { kind: 'adset', id: AD_SET.id, status: 'ACTIVE' }], accountId: 'm-1', adAccountId: '1234567890' },
    })
    expect(h.readBack).toHaveBeenCalledWith('1234567890', [{ kind: 'campaign', id: CAMPAIGN.id, status: 'PAUSED', effectiveStatus: 'PAUSED' }, { kind: 'adset', id: AD_SET.id, status: 'ACTIVE', effectiveStatus: 'ACTIVE' }])
  })
  it('nothing sent when what it stands on moved, the requests differ, or writes are off', async () => {
    const p = (await preview(args)).preview
    h.live.set(`adset:${AD_SET.id}`, { ...AD_SET, campaign: { ...AD_SET.campaign, status: 'PAUSED' } })
    expect(await tool.execute!(ask(args), approved(p))).toEqual({ ok: false, error: expect.stringMatching(/changed since this was approved/) })
    h.live.set(`adset:${AD_SET.id}`, AD_SET)
    expect(await tool.execute!(ask({ ...args, items: [args.items[0]] }), approved(p))).toEqual({ ok: false, error: expect.stringMatching(/changed since this was approved/) })
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'off')
    expect(await tool.execute!(ask(args), approved(p))).toEqual({ ok: false, error: expect.stringMatching(/approved for Meta .* nowhere \(writes off\)/) })
    expect(h.send).not.toHaveBeenCalled()
  })
  it('review fix A1 — a switch-on is never sent after a step that did not happen (its "nothing spends yet" may rest on it)', async () => {
    const p = (await preview(args)).preview
    // Step 1 (pausing the campaign) is refused: the ad set's switch-on said "its campaign is on" — but it is not sent at all.
    h.send.mockImplementationOnce(async () => { throw new MetaWriteError(localFailure('Meta refused it (100): x. Nothing was changed.', 'X'), 'w', 'refused') })
    const ran = await tool.execute!(ask(args), approved(p))
    expect(ran).toEqual({ ok: false, error: expect.stringMatching(/^Not run: Meta changed nothing\. 1\. Pause campaign .*refused.* 2\. Switch on ad set .*not sent — step 1 did not happen/) })
    expect(h.send).toHaveBeenCalledTimes(1)
  })
  it('re-review — Meta answers success but it reads back another status: not done (no record, no undo), and no later switch-on is sent', async () => {
    const p = (await preview(args)).preview
    h.send.mockImplementationOnce(async () => ({ node: { id: CAMPAIGN.id, status: 'ACTIVE', effective_status: 'ACTIVE' }, readBack: 'same-request', waitedMs: 0 }))
    const ran = await tool.execute!(ask(args), approved(p))
    expect(ran).toEqual({ ok: false, error: expect.stringMatching(/^Not confirmed: 1\. Pause campaign .*Meta answered success but it reads back ACTIVE \(ACTIVE\), not PAUSED.* 2\. Switch on ad set .*not sent — step 1 did not happen/) })
    expect(ran.change).toBeUndefined()
    expect(h.send).toHaveBeenCalledTimes(1)
  })
  it('NOT atomic: Meta refusing step 1 does not stop a later pause or archive; the record holds only what Meta made', async () => {
    const twoStops = { items: [{ kind: 'campaign', id: CAMPAIGN.id, status: 'PAUSED' }, { kind: 'adset', id: AD_SET.id, status: 'ARCHIVED' }] }
    const p = (await preview(twoStops)).preview
    // Children first: the ad set's archive is step 1, the campaign's pause step 2.
    h.send.mockImplementationOnce(async () => { throw new MetaWriteError(localFailure('Meta refused it (100): x. Nothing was changed.', 'X'), 'w', 'refused') }).mockImplementationOnce(done('PAUSED'))
    const ran = await tool.execute!(ask(twoStops), approved(p)) as ToolResult & { data: Record<string, any> }
    expect(ran.ok).toBe(true)
    expect(ran.data.steps.map((s: { label: string; outcome: string }) => [s.label.split(' ')[0], s.outcome])).toEqual([['Archive', 'refused'], ['Pause', 'done']])
    expect(ran.data.sentence).toMatch(/Meta made 1 of 2 requests/)
    expect((ran.change!.after as { items: unknown[] }).items).toEqual([{ kind: 'campaign', id: CAMPAIGN.id, status: 'PAUSED' }])
  })
  it('review fix A3 — any error of a request (the database too) ends in a not-sent step: what was done keeps its record and undo', async () => {
    const twoStops = { items: [{ kind: 'campaign', id: CAMPAIGN.id, status: 'PAUSED' }, { kind: 'adset', id: AD_SET.id, status: 'ARCHIVED' }] }
    const p = (await preview(twoStops)).preview
    h.send.mockImplementationOnce(done('ARCHIVED')).mockImplementationOnce(async () => { throw new Error('connection to the database lost') })
    const ran = await tool.execute!(ask(twoStops), approved(p)) as ToolResult & { data: Record<string, any> }
    expect(ran.ok).toBe(true)
    expect(ran.data.steps).toEqual([
      expect.objectContaining({ step: 1, outcome: 'done' }),
      expect.objectContaining({ step: 2, outcome: 'not_sent', sentence: expect.stringMatching(/problem of its own \(connection to the database lost\)/) }),
    ])
    expect(ran.change).toEqual({
      before: { items: [{ kind: 'adset', id: AD_SET.id, name: 'Ad set B', status: 'PAUSED' }], accountId: 'm-1', adAccountId: '1234567890' },
      after: { items: [{ kind: 'adset', id: AD_SET.id, status: 'ARCHIVED' }], accountId: 'm-1', adAccountId: '1234567890' },
    })
  })
  it('Meta\'s answer was not a success but the object reads as asked: done, in words', async () => {
    const p = (await preview({ items: [args.items[0]] })).preview
    h.send.mockImplementationOnce(async () => ({ node: { id: CAMPAIGN.id, status: 'PAUSED' }, readBack: 'second-read', waitedMs: 0, afterError: 'Meta refused it (1): An unknown error occurred. Nothing was changed.' }))
    const ran = await tool.execute!(ask({ items: [args.items[0]] }), approved(p)) as ToolResult & { data: Record<string, any> }
    expect(ran.data.steps[0]).toMatchObject({ outcome: 'done', sentence: expect.stringMatching(/not a success .*read it back as PAUSED: Meta made it/) })
  })
  it('a request Meta did not confirm stops the rest (never sent again); nothing made = not run, in words', async () => {
    const p = (await preview(args)).preview
    h.send.mockImplementationOnce(async () => { throw new MetaWriteError(localFailure(META_UNKNOWN_OUTCOME, 'X'), 'w', 'unknown') })
    const ran = await tool.execute!(ask(args), approved(p))
    expect(ran).toEqual({ ok: false, error: expect.stringMatching(/^Not confirmed: 1\. Pause campaign .*did not confirm.* 2\. Switch on ad set .*not sent — Nexus stopped after step 1\./) })
    expect(h.send).toHaveBeenCalledTimes(1)
    h.send.mockReset()
    h.send.mockImplementation(async () => { throw new MetaWriteError(localFailure('Meta asked Nexus to slow down.', 'X'), 'w', 'refused') })
    // A throttle is not one object's problem: Nexus stops at once.
    ;(h.send as any).mockImplementationOnce(async () => { const e = new MetaWriteError({ ...localFailure('Meta asked Nexus to slow down (17).', 'X'), throttled: true }, 'w', 'refused'); throw e })
    const slow = await tool.execute!(ask(args), approved(p))
    expect(slow).toEqual({ ok: false, error: expect.stringMatching(/^Not run: Meta changed nothing\..*slow down.*not sent — Nexus stopped after step 1/) })
    expect(h.send).toHaveBeenCalledTimes(1)
  })
})

describe('undo', () => {
  const change = {
    before: { items: [{ kind: 'campaign', id: CAMPAIGN.id, name: 'Campaign A', status: 'ACTIVE' }, { kind: 'adset', id: AD_SET.id, name: 'Ad set B', status: 'PAUSED' }], accountId: 'm-1', adAccountId: '1234567890' },
    after: { items: [{ kind: 'campaign', id: CAMPAIGN.id, status: 'PAUSED' }, { kind: 'adset', id: AD_SET.id, status: 'ACTIVE' }], accountId: 'm-1', adAccountId: '1234567890' },
  }
  it('current() equals change.after when nothing moved, and differs when it did; another account = null', async () => {
    h.live.set(`campaign:${CAMPAIGN.id}`, { ...CAMPAIGN, status: 'PAUSED' })
    h.live.set(`adset:${AD_SET.id}`, { ...AD_SET, status: 'ACTIVE' })
    expect(await tool.undo!.current(change)).toEqual(change.after)
    h.live.set(`adset:${AD_SET.id}`, { ...AD_SET, status: 'PAUSED' })
    expect(await tool.undo!.current(change)).not.toEqual(change.after)
    h.account = { target: { connectionId: 'm-1', adAccountId: '1234567891' }, accountId: 'm-1', adAccountId: '1234567891', name: null, currency: 'EUR' }
    expect(await tool.undo!.current(change)).toBeNull()
  })
  it('request() puts the old statuses back through set-meta-status, valid for its own input; an archive stays', () => {
    const back = tool.undo!.request(change)
    expect(back).toEqual({ tool: 'set-meta-status', args: { connectionId: 'm-1', items: [{ kind: 'campaign', id: CAMPAIGN.id, status: 'ACTIVE' }, { kind: 'adset', id: AD_SET.id, status: 'PAUSED' }], why: 'undo of an earlier Meta status change' } })
    expect(() => tool.input.parse((back as { args: unknown }).args)).not.toThrow()
    const mixed = tool.undo!.request({ before: change.before, after: { ...change.after, items: [{ kind: 'campaign', id: CAMPAIGN.id, status: 'ARCHIVED' }, change.after.items[1]] } })
    expect(mixed).toMatchObject({ args: { items: [{ kind: 'adset', id: AD_SET.id, status: 'PAUSED' }], why: expect.stringMatching(/archived stays archived/) } })
    expect(tool.undo!.request({ before: { items: [change.before.items[0]] }, after: { items: [{ kind: 'campaign', id: CAMPAIGN.id, status: 'ARCHIVED' }] } })).toEqual({ refusal: expect.stringMatching(/only be deleted/) })
  })
})
