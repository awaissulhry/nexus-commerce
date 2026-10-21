/**
 * Meta step 37 — set-meta-comments as the approval gate uses it (Meta, the account and the live reads are stand-ins): a
 * change a person always approves; the preview says Meta has no check, shows the exact words of a reply and never a
 * person's id; nothing spends; a run only as a request a person approved; the records hold ids only; undo flips hide ⇄
 * unhide, like ⇄ unlike, block ⇄ unblock, comments off ⇄ on, writes an edit's old words back and deletes a reply Nexus made
 * — and refuses what Meta cannot take back (a delete, a Threads reply, a reply on another account's media). Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const PAGE = '120000000000010'
const POST = `${PAGE}_500000000000001`
const COMMENT = '500000000000001_900000000000001'
const PERSON = '300000000000001'
const h = vi.hoisted(() => ({
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown> | { refusal: string },
  fb: null as Record<string, unknown> | null,
  ig: null as Record<string, unknown> | null,
  media: null as Record<string, unknown> | null,
  threads: null as Record<string, unknown> | null,
  blocked: { pageId: '120000000000010', blocked: false } as Record<string, unknown>,
  refusal: null as string | null,
  check: vi.fn(async () => undefined),
  send: vi.fn(),
}))
vi.mock('../../marketing/meta-ads/change-account.js', () => ({ metaChangeAccount: vi.fn(async () => h.account) }))
vi.mock('../../marketing/meta-ads/live-comments.js', async () => {
  const { MetaLiveRefusal } = await import('../../marketing/meta-ads/live.js')
  const or = <T>(v: T) => { if (h.refusal) throw new MetaLiveRefusal(h.refusal); if (!v) throw new MetaLiveRefusal('That comment is not on that post of the Facebook Page this business chose, so it is not read.'); return structuredClone(v) }
  return {
    liveCommentAccount: vi.fn(async () => ({ connectionId: 'm-1', pageId: '120000000000010', instagramId: '170000000000010' })),
    liveFacebookPost: vi.fn(async (_c: string, input: { postId?: string | null }) => or({ pageId: '120000000000010', postId: input.postId ?? '120000000000010_500000000000001' })),
    liveFacebookComment: vi.fn(async (_c: string, input: { commentId: string }) => or(h.fb && (h.fb.commentId === input.commentId ? h.fb : null))),
    liveBrandedComment: vi.fn(async () => or({ pageId: '120000000000010', brandedPostId: '130000000000001_600000000000001', commentId: '600000000000001_900000000000001', hidden: false, canHide: true })),
    liveInstagramComment: vi.fn(async (_c: string, id: string) => or(h.ig && (h.ig.commentId === id ? h.ig : null))),
    liveInstagramMedia: vi.fn(async () => or(h.media)),
    liveInstagramMention: vi.fn(async (_c: string, input: { mediaId: string; commentId?: string | null }) => or({ instagramId: '170000000000010', mediaId: input.mediaId, commentId: input.commentId ?? null })),
    liveThreadsReply: vi.fn(async (_c: string, input: { adId: string; replyId?: string | null }) => or({ ...(h.threads ?? {}), adId: input.adId, replyId: input.replyId ?? null })),
    livePageBlocked: vi.fn(async () => structuredClone(h.blocked)),
  }
})
vi.mock('../../marketing/meta-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/write-client.js')>()),
  metaCheckChange: h.check,
  metaSendChange: h.send,
}))

import { META_ADS_COMMENTS_TOOLS } from './meta-ads-comments.tools.js'
import { META_CHANGE_RULES, metaChangePreview, runMetaChange, type MetaDraftBuilder } from './meta-ads-kit.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import { MetaWriteError } from '../../marketing/meta-ads/write-client.js'
import { localFailure } from '../../marketing/meta-ads/errors.js'
import { ADVANTAGE_CATALOG } from '../../marketing/meta-ads/change-comments.js'
import type { ToolContext, ToolResult } from '../tool-types.js'

const tool = META_ADS_COMMENTS_TOOLS[0]
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown, extra: Partial<ToolContext> = {}): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview, ...extra })
type Out = ToolResult & { preview: Record<string, any>; data: Record<string, any>; error?: string }
const preview = async (args: Record<string, unknown>) => (await tool.handler(tool.input.parse(args) as Record<string, unknown>, asker)) as Out
const run = async (args: Record<string, unknown>) => {
  const parsed = tool.input.parse(args) as Record<string, unknown>
  const p = (await tool.handler(parsed, asker)) as Out
  if (!p.ok) return { preview: p, ran: null as Out | null }
  return { preview: p, ran: (await tool.execute!(parsed, approved(p.preview))) as Out }
}
/** The preview a person approved for a hand-made draft (the kit's own dry run). */
const previewOf = async (build: MetaDraftBuilder) => ((await metaChangePreview({}, asker, build)) as Out).preview
const FB = { pageId: PAGE, postId: POST, commentId: COMMENT, hidden: false, canHide: true, canRemove: true, canReply: true, byThePage: false, pageText: null, authorId: PERSON }
const IG = { instagramId: '170000000000010', mediaId: '180000000000001', commentId: '190000000000001', hidden: false, isReply: false, byTheAccount: false, productType: 'FEED' }
const MEDIA = { instagramId: '170000000000010', mediaId: '180000000000001', commentsEnabled: true, productType: 'FEED', mediaType: 'IMAGE' }

beforeEach(() => {
  __metaObjectLimitsTest.useMemory()
  vi.unstubAllEnvs()
  h.check.mockReset(); h.send.mockReset()
  h.account = { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' }
  h.fb = structuredClone(FB); h.ig = structuredClone(IG); h.media = structuredClone(MEDIA)
  h.threads = { threadsMediaId: '210000000000001', hidden: false }
  h.blocked = { pageId: PAGE, blocked: false }
  h.refusal = null
})

describe('the tool', () => {
  it('is a change a person always approves (ask ceiling, open world, high risk), with an undo, the #691 truth and the buyer-message permission', () => {
    expect(tool).toMatchObject({ name: 'set-meta-comments', readOnly: false, alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, category: 'advertising', reversibility: 'partial' })
    expect(tool.requires).toEqual(['ads.campaigns.manage', 'orders.edit'])
    expect(tool.undo).toBeDefined()
    expect(tool.description.endsWith(META_CHANGE_RULES)).toBe(true)
    expect(tool.description).toMatch(/PUBLIC at once and speaks as the business/)
    expect(tool.description).toMatch(/Nexus does not moderate comments on Advantage\+ catalog ads \(Meta documents none on Instagram and Threads\)/)
    expect(tool.description).toMatch(/Nexus keeps no person's words or name\. An id you name for a block is kept in the change record, for its undo\./)
    expect(tool.description).not.toMatch(/Meta has no delete/)
    expect(MATERIAL_PREVIEW_FIELDS['set-meta-comments']).toEqual(['basis', 'plan', 'reach'])
    expect(tool.consequencesFor!({ action: 'hide' })).toEqual({ reversibility: 'full' })
    expect(tool.consequencesFor!({ action: 'delete' })).toEqual({ reversibility: 'none' })
    expect(tool.consequencesFor!({ action: 'reply', platform: 'threads' })).toEqual({ reversibility: 'none' })
    expect(tool.consequencesFor!({ action: 'reply-to-mention' })).toEqual({ reversibility: 'none' })
    expect(tool.consequencesFor!({ action: 'edit', imageUrl: 'https://example.com/a.jpg' })).toEqual({ reversibility: 'partial' })
    expect(tool.consequencesFor!({ action: 'edit', message: 'x' })).toEqual({ reversibility: 'partial' })
    expect(tool.consequencesFor!({ action: 'reply', platform: 'facebook' })).toEqual({ reversibility: 'partial' })
    expect(tool.consequencesFor!({ action: 'unblock' })).toEqual({ reversibility: 'partial' })
  })
  it('refuses arguments an action does not take, and what Meta has no API for, before any read', async () => {
    const said = async (args: Record<string, unknown>) => (await preview(args)).error
    expect(await said({ action: 'hide', platform: 'facebook', postId: POST, commentId: COMMENT, message: 'x' })).toMatch(/message is for reply/)
    expect(await said({ action: 'delete', platform: 'facebook', postId: POST, commentId: COMMENT })).toMatch(/explicit ask: confirmDelete/)
    expect(await said({ action: 'reply', platform: 'instagram', commentId: '190000000000001', message: 'x', imageUrl: 'https://example.com/a.jpg' })).toMatch(/text only/)
    expect(await said({ action: 'reply', platform: 'facebook', postId: POST, commentId: COMMENT })).toMatch(/give message/)
    expect(await said({ action: 'edit', platform: 'instagram', commentId: '190000000000001', message: 'x' })).toMatch(/no edit for an Instagram comment/)
    expect(await said({ action: 'delete', platform: 'threads', adId: '120000000000003', commentId: '210000000000002', confirmDelete: true })).toMatch(/Threads API deletes only with a Threads login token and threads_delete/)
    expect(await said({ action: 'block', platform: 'instagram', commentId: '190000000000001' })).toMatch(/Facebook Page only/)
    expect(await said({ action: 'comments-off', platform: 'facebook', postId: POST })).toMatch(/one Instagram media/)
    expect(await said({ action: 'unhide', platform: 'instagram', commentId: '190000000000001', brandedPostId: '130000000000001_600000000000001' })).toMatch(/brandedPostId is for a Facebook/)
    expect(() => tool.input.parse({ action: 'reply', platform: 'facebook', message: 'Ciao‮' })).toThrow()
    expect(h.send).not.toHaveBeenCalled()
  })
  it('an ad with no post behind it says Advantage+ catalog ads have no comment moderation', async () => {
    h.refusal = 'Meta names no Facebook post behind that ad (an Instagram-only or catalog ad): try view instagram with the adId.'
    expect((await preview({ action: 'comment', platform: 'facebook', adId: '120000000000003', message: 'Ciao' })).error).toContain(ADVANTAGE_CATALOG.facebook)
    expect(ADVANTAGE_CATALOG.facebook).toMatch(/^Nexus does not moderate comments on Advantage\+ catalog ads/)
    h.refusal = 'Meta names no Instagram media behind that ad (Meta gives none for Advantage+ catalog ads): try view post with the adId.'
    expect((await preview({ action: 'comment', platform: 'instagram', adId: '120000000000003', message: 'Ciao' })).error).toContain(ADVANTAGE_CATALOG.instagram)
    expect(ADVANTAGE_CATALOG.instagram).toMatch(/^Meta documents no comment moderation for Advantage\+ catalog ads on Instagram/)
  })
})

describe('a run', () => {
  it('hide: previewed without Meta\'s check, run as the approving person, read back, recorded by ids; undo shows it again', async () => {
    h.send.mockResolvedValue({ node: { id: COMMENT, is_hidden: true }, readBack: 'second-read', waitedMs: 0 })
    const { preview: p, ran } = await run({ action: 'hide', platform: 'facebook', postId: POST, commentId: COMMENT })
    expect(p.preview.metaCheck).toMatchObject({ checked: 'none', sentence: expect.stringMatching(/no check/) })
    expect(p.preview.spendsMoney).toBe(false)
    expect(h.check).not.toHaveBeenCalled()
    expect(h.send).toHaveBeenCalledWith({ connectionId: 'm-1', adAccountId: '1234567890' }, expect.objectContaining({ objectId: COMMENT, kind: 'fbcomment', operation: 'fbcomment.hide', params: { is_hidden: 'true' }, expect: { is_hidden: 'true' } }))
    expect(ran!.ok).toBe(true)
    expect(ran!.data.steps[0]).toMatchObject({ outcome: 'done', sentence: expect.stringMatching(/is_hidden true/) })
    const after = ran!.change!.after as Record<string, unknown>
    expect(after).toMatchObject({ action: 'hide', platform: 'facebook', postId: POST, commentId: COMMENT, hidden: true, accountId: 'm-1', adAccountId: '1234567890' })
    // Undo: what is there now equals what it wrote; the request flips it.
    h.fb = { ...FB, hidden: true }
    expect(await tool.undo!.current(ran!.change!)).toEqual(after)
    expect(tool.undo!.request(ran!.change!)).toEqual({ tool: 'set-meta-comments', args: { connectionId: 'm-1', platform: 'facebook', action: 'unhide', postId: POST, commentId: COMMENT, why: expect.any(String) } })
    // Someone showed it again meanwhile: current differs (undo refused upstream as "changed since").
    h.fb = { ...FB, hidden: false }
    expect(await tool.undo!.current(ran!.change!)).not.toEqual(after)
  })
  it('never runs by a rule, nor without what was approved', async () => {
    const parsed = tool.input.parse({ action: 'hide', platform: 'facebook', postId: POST, commentId: COMMENT }) as Record<string, unknown>
    const p = (await tool.handler(parsed, asker)) as Out
    expect(((await tool.execute!(parsed, approved(p.preview, { decidedVia: 'auto' }))) as Out).ok).toBe(false)
    expect(((await tool.execute!(parsed, approved({})) as Out)).ok).toBe(false)
    expect(h.send).not.toHaveBeenCalled()
  })
  it('a reply: the exact words in the preview; Meta\'s new id recorded; its undo deletes exactly it', async () => {
    h.send.mockResolvedValue({ node: { id: '500000000000001_900000000000077' }, readBack: 'second-read', waitedMs: 0 })
    const words = 'Grazie per il messaggio!\nVi scriviamo in privato.'
    const { preview: p, ran } = await run({ action: 'reply', platform: 'facebook', postId: POST, commentId: COMMENT, message: words })
    expect(JSON.stringify(p.preview.changes)).toContain(JSON.stringify(`"${words}"`).slice(1, -1))
    expect(p.preview.warnings.join(' ')).toMatch(/PUBLIC at once/)
    expect(ran!.data).toMatchObject({ replyId: '500000000000001_900000000000077' })
    const after = ran!.change!.after as Record<string, unknown>
    expect(after).toMatchObject({ action: 'reply', replyId: '500000000000001_900000000000077', message: words })
    expect(tool.undo!.request(ran!.change!)).toEqual({ tool: 'set-meta-comments', args: { connectionId: 'm-1', platform: 'facebook', action: 'delete', postId: POST, commentId: '500000000000001_900000000000077', confirmDelete: true, why: expect.stringMatching(/deletes the reply Nexus made/) } })
    h.fb = { ...FB, commentId: '500000000000001_900000000000077' }
    expect(await tool.undo!.current(ran!.change!)).toEqual(after)
    h.fb = null
    expect(await tool.undo!.current(ran!.change!)).toMatchObject({ replyId: null })
  })
  it('a block by a comment: the author\'s id goes to Meta only — not in the preview, the steps or the record; undo unblocks the same comment\'s author', async () => {
    h.send.mockResolvedValue({ node: { [PERSON]: true }, readBack: 'none', waitedMs: 0 })
    const { preview: p, ran } = await run({ action: 'block', platform: 'facebook', postId: POST, commentId: COMMENT })
    expect(h.send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ objectId: PAGE, kind: 'page', edge: 'blocked', params: { psid: `["${PERSON}"]` }, operation: 'pageblock.create' }))
    expect(JSON.stringify(p.preview)).not.toContain(PERSON)
    expect(JSON.stringify([ran!.data, ran!.change])).not.toContain(PERSON)
    expect(ran!.data.steps[0].sentence).toMatch(/Meta confirmed it\./)
    expect(tool.undo!.request(ran!.change!)).toEqual({ tool: 'set-meta-comments', args: { connectionId: 'm-1', platform: 'facebook', action: 'unblock', postId: POST, commentId: COMMENT, why: expect.any(String) } })
    // The Page's own comment, or one Meta names no author of: refused in words.
    h.fb = { ...FB, authorId: null }
    expect((await preview({ action: 'block', platform: 'facebook', postId: POST, commentId: COMMENT })).error).toMatch(/does not say who wrote/)
  })
  it('a refused request changes nothing and says Meta\'s words with the code in plain words', async () => {
    h.send.mockRejectedValue(new MetaWriteError({ ...localFailure('Meta refused it (3801): limit reached. Nothing was changed.', '3801'), origin: 'meta', code: '3801' } as never, 'pageblock.create', 'refused'))
    const { ran } = await run({ action: 'block', platform: 'facebook', personId: PERSON })
    expect(ran!.ok).toBe(false)
    expect(JSON.stringify(ran)).toMatch(/blocked as many people as Meta allows/)
  })
  it('review fix A3 — an id a person names for a block is kept in the record, and its undo unblocks that same psid', async () => {
    h.send.mockResolvedValue({ node: { [PERSON]: true }, readBack: 'none', waitedMs: 0 })
    const { ran } = await run({ action: 'block', platform: 'facebook', personId: PERSON })
    expect(ran!.change!.after).toMatchObject({ action: 'block', via: 'id', personId: PERSON, blocked: true })
    expect(tool.undo!.request(ran!.change!)).toEqual({ tool: 'set-meta-comments', args: { connectionId: 'm-1', platform: 'facebook', action: 'unblock', personId: PERSON, why: expect.any(String) } })
  })
  it('Instagram comments off: read back is_comment_enabled; undo switches them on again', async () => {
    h.send.mockResolvedValue({ node: { id: '180000000000001', is_comment_enabled: false }, readBack: 'second-read', waitedMs: 0 })
    const { ran } = await run({ action: 'comments-off', platform: 'instagram', mediaId: '180000000000001' })
    expect(ran!.change!.after).toMatchObject({ action: 'comments-off', mediaId: '180000000000001', commentsEnabled: false })
    expect(tool.undo!.request(ran!.change!)).toEqual({ tool: 'set-meta-comments', args: { connectionId: 'm-1', platform: 'instagram', action: 'comments-on', mediaId: '180000000000001', why: expect.any(String) } })
  })
  it('what Meta cannot take back has no undo request: a delete, a Threads reply, a reply on another account\'s media', async () => {
    h.send.mockResolvedValue({ node: { success: true }, readBack: 'none', waitedMs: 0 })
    const del = (await run({ action: 'delete', platform: 'instagram', commentId: '190000000000001', confirmDelete: true })).ran!
    expect(tool.undo!.request(del.change!)).toEqual({ refusal: expect.stringMatching(/cannot come back/) })
    h.send.mockResolvedValue({ node: { id: '210000000000099' }, readBack: 'none', waitedMs: 0 })
    const threads = (await run({ action: 'comment', platform: 'threads', adId: '120000000000003', message: 'Thanks!' })).ran!
    expect(threads.change!.after).toMatchObject({ platform: 'threads', replyId: '210000000000099' })
    expect(tool.undo!.request(threads.change!)).toEqual({ refusal: expect.stringMatching(/Threads ad cannot be deleted/) })
    h.send.mockResolvedValue({ node: { id: '190000000000088' }, readBack: 'none', waitedMs: 0 })
    const mention = (await run({ action: 'reply-to-mention', platform: 'instagram', mediaId: '180000000000009', message: 'Grazie' })).ran!
    expect(tool.undo!.request(mention.change!)).toEqual({ refusal: expect.stringMatching(/only the media's owner/) })
  })
  it('an edit of the Page\'s own comment writes the old words back on undo', async () => {
    h.fb = { ...FB, byThePage: true, pageText: 'Vecchio', authorId: PAGE }
    h.send.mockResolvedValue({ node: { id: COMMENT, message: 'Nuovo' }, readBack: 'second-read', waitedMs: 0 })
    const { ran } = await run({ action: 'edit', platform: 'facebook', postId: POST, commentId: COMMENT, message: 'Nuovo' })
    expect(ran!.change!.after).toMatchObject({ message: 'Nuovo', oldMessage: 'Vecchio' })
    expect(tool.undo!.request(ran!.change!)).toEqual({ tool: 'set-meta-comments', args: { connectionId: 'm-1', platform: 'facebook', action: 'edit', postId: POST, commentId: COMMENT, message: 'Vecchio', why: expect.any(String) } })
    h.fb = { ...FB, byThePage: true, pageText: 'Nuovo', authorId: PAGE }
    expect(await tool.undo!.current(ran!.change!)).toEqual(ran!.change!.after)
  })
  it('review fix A2 — an edit whose old words cannot be sent again has no undo: the preview says so, the request refuses', async () => {
    for (const old of ['', 'Ciao\u200Bx']) {
      h.fb = { ...FB, byThePage: true, pageText: old, authorId: PAGE }
      h.send.mockResolvedValue({ node: { id: COMMENT, message: 'Nuovo' }, readBack: 'second-read', waitedMs: 0 })
      const { preview: p, ran } = await run({ action: 'edit', platform: 'facebook', postId: POST, commentId: COMMENT, message: 'Nuovo' })
      expect(p.preview.warnings.join(' ')).toMatch(/This edit has NO undo/)
      expect(ran!.change!.after).toMatchObject({ oldMessage: null })
      expect(tool.undo!.request(ran!.change!)).toEqual({ refusal: expect.stringMatching(/This edit has no undo/) })
      // A record that names bad old words anyway is refused by the same rule.
      expect(tool.undo!.request({ before: null, after: { ...(ran!.change!.after as object), oldMessage: 'Ciao\rx' } })).toEqual({ refusal: expect.stringMatching(/no undo/) })
    }
  })
  it('review fix A6 — "Meta confirmed it." only for a comment request whose answer is all; step 36\'s test lead without an id reads as before', async () => {
    const draft = (extra: Record<string, unknown>) => async () => ({
      summary: 's', changes: {}, totals: {}, warnings: [], spendsMoney: [], skipped: [], stands: {}, before: {}, after: {},
      requests: [{ step: 1, label: 'Make a test lead', objectId: '600000000000001', objectKind: 'leadform' as const, edge: 'test_leads' as const, operation: 'testlead.create', params: { field_data: '[]' }, check: 'none' as const, raisesSpend: false, readBackInPost: false, budget: false, undoable: false, skipReadBack: true as const, ...extra }],
    })
    h.send.mockResolvedValue({ node: { success: true }, readBack: 'none', waitedMs: 0 })
    const finish = () => ({ data: {}, before: {}, after: {} })
    const ctx = approved({ reach: { mode: 'live', accountId: 'm-1', adAccountId: '1234567890' }, basis: 'x', plan: 'x' })
    const testLead = await runMetaChange({}, { ...ctx, approvedPreview: await previewOf(draft({})) }, draft({}), finish) as Out
    expect(testLead.data.steps[0].sentence).toBe('Make a test lead: Meta confirmed it; Nexus could not read it back (meta-ads-live shows it).')
    const liked = await runMetaChange({}, { ...ctx, approvedPreview: await previewOf(draft({ answerOnly: true })) }, draft({ answerOnly: true }), finish) as Out
    expect(liked.data.steps[0].sentence).toBe('Make a test lead: Meta confirmed it.')
  })
})
