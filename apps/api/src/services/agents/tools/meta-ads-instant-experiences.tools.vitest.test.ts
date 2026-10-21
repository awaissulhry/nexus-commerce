/**
 * Meta step 27b — create-meta-instant-experience and set-meta-instant-experience as the approval gate uses them (Meta, the
 * account and the live reads are stand-ins): changes a person always approves; Meta has no check (said); nothing spends; a
 * run only as a request a person approved, request by request, the parts before the experience (each named at send time by
 * the id Meta answered, in ONE run); records that name the Page, the experience and its parts; undo hides an experience it
 * made, puts an edit back, shows a hidden one again, and never un-publishes. Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown> | { refusal: string },
  canvas: null as Record<string, unknown> | null,
  refs: null as string | null,
  pageRefusal: null as string | null,
  refsCalls: [] as unknown[],
  check: vi.fn(async () => undefined),
  send: vi.fn(),
}))
vi.mock('../../marketing/meta-ads/change-account.js', () => ({ metaChangeAccount: vi.fn(async () => h.account) }))
vi.mock('../../marketing/meta-ads/live-instant-experiences.js', async () => {
  const { MetaLiveRefusal } = await import('../../marketing/meta-ads/live.js')
  return {
    liveIxContext: vi.fn(async (connectionId: string) => { if (h.pageRefusal) throw new MetaLiveRefusal(h.pageRefusal); return { connectionId, pageId: '120000000000010', instagramId: '17841400000000001', adAccountId: '1234567890' } }),
    liveIxCanvas: vi.fn(async (_c: string, canvasId: string) => { if (!h.canvas || h.canvas.canvasId !== canvasId) throw new MetaLiveRefusal('That Instant Experience is not the chosen Facebook Page\'s, so it is not read.'); return structuredClone(h.canvas) }),
    liveIxRefsProblem: vi.fn(async (_c: string, refs: unknown) => { h.refsCalls.push(refs); return h.refs }),
  }
})
vi.mock('../../marketing/meta-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/write-client.js')>()),
  metaCheckChange: h.check,
  metaSendChange: h.send,
}))

import { META_ADS_INSTANT_EXPERIENCE_TOOLS } from './meta-ads-instant-experiences.tools.js'
import { META_CHANGE_RULES } from './meta-ads-kit.js'
import { MetaWriteError } from '../../marketing/meta-ads/write-client.js'
import { localFailure } from '../../marketing/meta-ads/errors.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import { META_IX_CREATE_TOOL, META_IX_SET_TOOL } from '../../gateway/account.js'
import type { ToolContext, ToolResult } from '../tool-types.js'

const PAGE = '120000000000010'
const CANVAS = '120000000000701'
const PART = '120000000000711'
const create = META_ADS_INSTANT_EXPERIENCE_TOOLS.find((t) => t.name === 'create-meta-instant-experience')!
const set = META_ADS_INSTANT_EXPERIENCE_TOOLS.find((t) => t.name === 'set-meta-instant-experience')!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const recheck: ToolContext = { can: () => true, via: 'system', approvalId: 'ap-1' }
const approved = (preview: unknown, extra: Partial<ToolContext> = {}): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview, ...extra })
type Out = ToolResult & { preview: Record<string, any>; data: Record<string, any>; error?: string }
const run = async (tool: typeof create, args: Record<string, unknown>) => {
  const parsed = tool.input.parse(args) as Record<string, unknown>
  const p = (await tool.handler(parsed, asker)) as Out
  if (!p.ok) return { preview: p, ran: null }
  return { preview: p, ran: (await tool.execute!(parsed, approved(p.preview))) as Out }
}
const CANVAS_STATE = { pageId: PAGE, canvasId: CANVAS, name: 'Experience A', published: false, hidden: false, backgroundColor: 'FFFFFFFF', elementIds: [PART], heroFacebookPostId: null, heroInstagramMediaId: null, templateId: null, link: `https://fb.com/canvas_doc/${CANVAS}` }
const CREATE = {
  name: 'Experience A',
  parts: [
    { type: 'photo', photoId: '800000000000001' },
    { type: 'footer', children: [{ type: 'button', text: 'Jetzt kaufen', buttonStyle: 'BUTTON_FILLED', link: 'https://www.example.com/shop' }] },
  ],
}
/** Meta's answers for each part in turn, then the experience itself. */
const madeInOrder = (ids: string[], canvas: Record<string, unknown> | null) => {
  for (const id of ids) h.send.mockImplementationOnce(async () => ({ node: { id }, readBack: 'none', waitedMs: 0 }))
  if (canvas) h.send.mockImplementationOnce(async () => ({ node: canvas, readBack: 'second-read', waitedMs: 0 }))
}

beforeEach(() => {
  __metaObjectLimitsTest.useMemory()
  vi.unstubAllEnvs()
  h.check.mockReset(); h.send.mockReset()
  h.account = { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' }
  h.canvas = structuredClone(CANVAS_STATE)
  h.refs = null
  h.pageRefusal = null
  h.refsCalls = []
})

describe('the tools', () => {
  it('are changes a person always approves (ask ceiling, open world, high risk), each with an undo, made as the Page', () => {
    expect(META_ADS_INSTANT_EXPERIENCE_TOOLS.map((t) => t.name)).toEqual([META_IX_CREATE_TOOL, META_IX_SET_TOOL])
    for (const tool of META_ADS_INSTANT_EXPERIENCE_TOOLS) {
      expect(tool).toMatchObject({ readOnly: false, alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, category: 'advertising', reversibility: 'partial', requires: ['ads.campaigns.manage'] })
      expect(tool.undo).toBeDefined()
      expect(tool.description.endsWith(META_CHANGE_RULES)).toBe(true)
      expect(tool.description).toMatch(/AS the Page|Every request goes AS the Page/)
      expect(tool.description).toMatch(/a token is never shown/)
      expect(MATERIAL_PREVIEW_FIELDS[tool.name]).toEqual(['basis', 'plan', 'reach'])
    }
    expect(create.description).toMatch(/always made UNPUBLISHED/)
    expect(create.description).toMatch(/Undo HIDES it \(Meta documents no delete/)
    expect(set.consequencesFor!({ action: 'publish', canvasId: CANVAS })).toEqual({ reversibility: 'none' })
    expect(set.consequencesFor!({ action: 'hide', canvasId: CANVAS })).toEqual({ reversibility: 'full' })
    expect(set.consequencesFor!({ action: 'edit', canvasId: CANVAS })).toBeNull()
    // Every list is bounded; a part is a flat object with its type.
    expect(() => create.input.parse({ ...CREATE, parts: Array.from({ length: 51 }, () => ({ type: 'text', text: 'x' })) })).toThrow()
    expect(() => create.input.parse({ ...CREATE, parts: [{ type: 'carousel', children: Array.from({ length: 11 }, () => ({ elementId: PART })) }] })).toThrow()
    expect(() => create.input.parse({ ...CREATE, backgroundColor: '#ffffff' })).toThrow()
    expect(() => set.input.parse({ action: 'publish', canvasId: CANVAS, confirmPublish: false })).toThrow()
  })
})

describe('create-meta-instant-experience', () => {
  it('preview: Meta has no check (none asked), the parts then the experience on the chosen Page, nothing spends; every id checked live; re-check stable', async () => {
    const p = (await create.handler(create.input.parse(CREATE) as Record<string, unknown>, asker)) as Out
    expect(p.ok, JSON.stringify(p)).toBe(true)
    expect(h.check).not.toHaveBeenCalled()
    expect(p.preview).toMatchObject({ spendsMoney: false, metaCheck: { checked: 'none', sentence: expect.stringMatching(/^Meta has no check for this change/) } })
    expect(p.preview.requests.map((r: { label: string }) => r.label)).toEqual([
      `Make part 1: photo on the Facebook Page ${PAGE}`,
      `Make part 2: button on the Facebook Page ${PAGE}`,
      `Make part 3: footer holding step 2 (button) on the Facebook Page ${PAGE}`,
      `Make the Instant Experience "Experience A" (UNPUBLISHED) on the Facebook Page ${PAGE} from step 1 (photo), step 3 (footer)`,
    ])
    expect(p.preview.warnings.join(' ')).toMatch(/Meta has no check \(validate_only\) for Instant Experiences/)
    // The kit says where Meta counts them: the PAGE's own rate limit, not the ad account's (no ad-account count for them).
    expect(p.preview.warnings.join(' ')).toMatch(/4 of its requests go AS the chosen Facebook Page .* PAGE's own rate limit \(80001/)
    expect(p.preview.warnings.join(' ')).not.toMatch(/an ad account takes about 20 changes/)
    expect(h.refsCalls[0]).toMatchObject({ photos: ['800000000000001'] })
    const again = (await create.handler(create.input.parse(CREATE) as Record<string, unknown>, recheck)) as Out
    expect([again.preview.basis, again.preview.plan]).toEqual([p.preview.basis, p.preview.plan])
  })
  it('refusals in words: an id that is not the business\'s own, no Page chosen, no ad account — nothing queued', async () => {
    h.refs = 'Photo 800000000000001 is not one the chosen Facebook Page posted.'
    expect(await create.handler(create.input.parse(CREATE) as Record<string, unknown>, asker)).toEqual({ ok: false, error: 'Nothing was asked of Meta: Photo 800000000000001 is not one the chosen Facebook Page posted.' })
    h.refs = null
    h.pageRefusal = 'No Facebook Page is chosen for this business yet.'
    expect(await create.handler(create.input.parse(CREATE) as Record<string, unknown>, asker)).toEqual({ ok: false, error: 'No Facebook Page is chosen for this business yet.' })
    h.account = { refusal: 'No Meta ad account is chosen for this business yet.' }
    expect(await create.handler(create.input.parse(CREATE) as Record<string, unknown>, asker)).toEqual({ ok: false, error: 'No Meta ad account is chosen for this business yet.' })
  })
  it('run: as the approving person, in ONE run — each container and the experience name the ids Meta answered; the record names them all', async () => {
    madeInOrder(['120000000000801', '120000000000802', '120000000000803'], { id: CANVAS, name: 'Experience A', is_published: false, is_hidden: false })
    const { ran } = await run(create, CREATE)
    expect(ran!.ok, JSON.stringify(ran)).toBe(true)
    const calls = h.send.mock.calls.map((c) => c[1])
    expect(calls.map((c) => [c.objectId, c.kind, c.edge, c.operation])).toEqual([
      [PAGE, 'page', 'canvas_elements', 'canvas.element.create'], [PAGE, 'page', 'canvas_elements', 'canvas.element.create'],
      [PAGE, 'page', 'canvas_elements', 'canvas.element.create'], [PAGE, 'page', 'canvases', 'canvas.create'],
    ])
    expect(calls[2].params).toEqual({ canvas_footer: JSON.stringify({ child_elements: ['120000000000802'] }) })
    expect(calls[3].params).toEqual({ name: 'Experience A', is_published: 'false', body_element_ids: JSON.stringify(['120000000000801', '120000000000803']) })
    // One run id for the whole change: the gateway lets the experience name only parts this same run made.
    expect(new Set(calls.map((c) => c.runId)).size).toBe(1)
    expect(calls[0].runId).toEqual(expect.any(String))
    expect(ran!.data).toMatchObject({ canvasId: CANVAS, link: `https://fb.com/canvas_doc/${CANVAS}`, elementIds: ['120000000000801', '120000000000802', '120000000000803'], published: false })
    expect(ran!.change).toEqual({
      before: { action: 'create', pageId: PAGE, canvasId: null, name: 'Experience A', elementIds: [], hidden: null, accountId: 'm-1', adAccountId: '1234567890' },
      after: { action: 'create', pageId: PAGE, canvasId: CANVAS, name: 'Experience A', elementIds: ['120000000000801', '120000000000802', '120000000000803'], hidden: false, accountId: 'm-1', adAccountId: '1234567890' },
    })
  })
  it('run: a part Meta refuses stops what holds it and the experience; the parts made are recorded and named; Meta\'s Page limit in words', async () => {
    h.send.mockImplementationOnce(async () => ({ node: { id: '120000000000801' }, readBack: 'none', waitedMs: 0 }))
    h.send.mockImplementationOnce(async () => { throw new MetaWriteError({ ...localFailure('Meta refused it (80001): There have been too many calls to this Page account.', '80001'), origin: 'meta' }, 'canvas.element.create', 'refused') })
    const { ran } = await run(create, CREATE)
    expect(ran!.ok).toBe(true)
    expect(h.send).toHaveBeenCalledTimes(2)
    expect(ran!.data.steps.map((s: { outcome: string }) => s.outcome)).toEqual(['done', 'refused', 'not_sent', 'not_sent'])
    expect(ran!.data.steps[1].sentence).toMatch(/80001.*counts against the Page|Meta allows only so many calls to one Page/)
    expect(ran!.data.steps[2].sentence).toMatch(/stands on step 2/)
    expect(ran!.data).toMatchObject({ canvasId: null, elementIds: ['120000000000801'] })
    expect(ran!.data.sentence).toMatch(/a part has no undo but a delete a person asks for/)
    expect(ran!.change!.after).toMatchObject({ canvasId: null, elementIds: ['120000000000801'] })
  })
  it('undo hides the experience it made (Meta deletes none), valid for set-meta-instant-experience; current() reads it; no experience: words', async () => {
    const change = {
      before: { action: 'create', pageId: PAGE, canvasId: null, name: 'Experience A', elementIds: [], hidden: null, accountId: 'm-1', adAccountId: '1234567890' },
      after: { action: 'create', pageId: PAGE, canvasId: CANVAS, name: 'Experience A', elementIds: [PART], hidden: false, accountId: 'm-1', adAccountId: '1234567890' },
    }
    const back = create.undo!.request(change)
    expect(back).toEqual({ tool: 'set-meta-instant-experience', args: { connectionId: 'm-1', action: 'hide', canvasId: CANVAS, why: expect.stringMatching(/hidden; its parts stay/) } })
    expect(() => set.input.parse((back as { args: unknown }).args)).not.toThrow()
    expect(await create.undo!.current(change)).toEqual(change.after)
    h.canvas = { ...CANVAS_STATE, hidden: true }
    expect(await create.undo!.current(change)).toMatchObject({ hidden: true })
    expect(create.undo!.request({ ...change, after: { ...change.after, canvasId: null } })).toEqual({ refusal: expect.stringMatching(/no Instant Experience.*remove-meta-ads-items/) })
  })
})

describe('set-meta-instant-experience', () => {
  it('edit: reads it first; refused in words when published; the new body in order with a new part made first; undo puts the old values back', async () => {
    h.canvas = { ...CANVAS_STATE, published: true }
    expect(await set.handler(set.input.parse({ action: 'edit', canvasId: CANVAS, name: 'B' }) as Record<string, unknown>, asker)).toEqual({ ok: false, error: expect.stringMatching(/is published: Meta says "You can only update an unpublished Instant Experience"/) })
    h.canvas = structuredClone(CANVAS_STATE)
    h.send.mockImplementationOnce(async () => ({ node: { id: '120000000000805' }, readBack: 'none', waitedMs: 0 }))
    h.send.mockImplementationOnce(async () => ({ node: { id: CANVAS, name: 'Experience B', is_published: false }, readBack: 'second-read', waitedMs: 0 }))
    const { preview, ran } = await run(set, { action: 'edit', canvasId: CANVAS, name: 'Experience B', parts: [{ elementId: PART }, { type: 'text', text: 'Neu' }] })
    expect(preview.ok, JSON.stringify(preview)).toBe(true)
    expect(ran!.ok, JSON.stringify(ran)).toBe(true)
    expect(h.send.mock.calls[1][1]).toMatchObject({ objectId: CANVAS, kind: 'canvas', operation: 'canvas.update', params: { name: 'Experience B', body_element_ids: JSON.stringify([PART, '120000000000805']) } })
    expect(ran!.change!.after).toMatchObject({ action: 'edit', fields: { name: 'Experience B', elementIds: [PART, '120000000000805'] }, madeElementIds: ['120000000000805'] })
    const change = ran!.change as { before: unknown; after: unknown }
    const back = set.undo!.request(change)
    expect(back).toEqual({ tool: 'set-meta-instant-experience', args: { connectionId: 'm-1', action: 'edit', canvasId: CANVAS, name: 'Experience A', parts: [{ elementId: PART }], why: expect.stringMatching(/only while it is unpublished/) } })
    expect(() => set.input.parse((back as { args: unknown }).args)).not.toThrow()
    h.canvas = { ...CANVAS_STATE, name: 'Experience B', elementIds: [PART, '120000000000805'] }
    expect(await set.undo!.current(change)).toEqual(change.after)
  })
  it('publish: needs confirmPublish; one way in words; its record has no undo', async () => {
    expect(await set.handler(set.input.parse({ action: 'publish', canvasId: CANVAS }) as Record<string, unknown>, asker)).toEqual({ ok: false, error: expect.stringMatching(/ONE way .* confirmPublish: true/) })
    h.send.mockImplementationOnce(async () => ({ node: { id: CANVAS, is_published: true }, readBack: 'second-read', waitedMs: 0 }))
    const { preview, ran } = await run(set, { action: 'publish', canvasId: CANVAS, confirmPublish: true })
    expect(preview.preview.warnings.join(' ')).toMatch(/Publishing is ONE WAY/)
    expect(preview.preview.spendsMoney).toBe(false)
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: CANVAS, kind: 'canvas', operation: 'canvas.publish', params: { is_published: 'true' } })
    expect(ran!.data).toMatchObject({ action: 'publish', published: true, link: `https://fb.com/canvas_doc/${CANVAS}` })
    expect(set.undo!.request(ran!.change as { before: unknown; after: unknown })).toEqual({ refusal: expect.stringMatching(/cannot be un-published or edited/) })
  })
  it('hide ⇄ show again are each other\'s undo; edit fields with another action are refused in words', async () => {
    h.send.mockImplementationOnce(async () => ({ node: { id: CANVAS, is_hidden: true }, readBack: 'second-read', waitedMs: 0 }))
    const { ran } = await run(set, { action: 'hide', canvasId: CANVAS })
    expect(ran!.data).toMatchObject({ action: 'hide', from: false, to: true })
    expect(set.undo!.request(ran!.change as { before: unknown; after: unknown })).toEqual({ tool: 'set-meta-instant-experience', args: { connectionId: 'm-1', action: 'unhide', canvasId: CANVAS, why: expect.any(String) } })
    h.canvas = { ...CANVAS_STATE, hidden: true }
    expect(await set.undo!.current(ran!.change as { before: unknown; after: unknown })).toEqual((ran!.change as { after: unknown }).after)
    expect(await set.handler(set.input.parse({ action: 'hide', canvasId: CANVAS, name: 'X' }) as Record<string, unknown>, asker)).toEqual({ ok: false, error: 'name is for action edit only.' })
    expect(await set.handler(set.input.parse({ action: 'edit', canvasId: CANVAS }) as Record<string, unknown>, asker)).toEqual({ ok: false, error: expect.stringMatching(/Name what the edit changes/) })
    expect(await set.handler(set.input.parse({ action: 'hide', canvasId: '120000000000799' }) as Record<string, unknown>, asker)).toEqual({ ok: false, error: expect.stringMatching(/not the chosen Facebook Page's/) })
  })
})
