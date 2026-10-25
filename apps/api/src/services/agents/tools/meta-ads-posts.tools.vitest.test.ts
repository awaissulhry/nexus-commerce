/**
 * Meta step 24 — the post tools as the approval gate uses them (Meta, the account and the live reads are stand-ins):
 * changes a person always approves; the preview says Meta has no check, shows the exact text, says who sees it (dark /
 * PUBLIC at once / scheduled) and that nothing spends; a run only as a request a person approved, request by request (the
 * photos before the post that attaches them, the containers before the publish, a container waited for until Meta finished
 * it); the records hold ids; undo deletes a post only while it is unpublished, writes an edit's old values back, and the
 * delete and Instagram tools have none. Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const PAGE = '120000000000010'
const POST = `${PAGE}_500000000000001`
const IG = '170000000000010'
const h = vi.hoisted(() => ({
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown> | { refusal: string },
  post: null as Record<string, unknown> | null,
  media: null as Record<string, unknown> | null,
  uses: { creativeIds: [] as string[], complete: true },
  quota: { usage: 3, total: 50, durationSec: 86400 } as Record<string, unknown> | null,
  container: { containerId: '180000000000001', statusCode: 'FINISHED', status: null } as Record<string, unknown> | null,
  containerMade: true,
  takenUsers: new Set<string>(),
  unreadableUser: null as string | null,
  videoPost: { pageId: '120000000000010', videoId: '160000000000001', postId: null as string | null },
  usesError: false,
  check: vi.fn(async () => undefined),
  send: vi.fn(),
}))
vi.mock('../../gateway/account.js', () => import('../../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('../../marketing/meta-ads/change-account.js', () => ({ metaChangeAccount: vi.fn(async () => h.account) }))
vi.mock('../../marketing/google-ads/asset-images.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/google-ads/asset-images.js')>()),
  libraryImageLink: vi.fn(async (id: string) => (id === 'da_img1' ? { url: 'https://res.cloudinary.example-cdn.com/shop-a/img1.jpg', label: 'Giacca' } : { problem: `library image ${id} is not an image of this business's image library (image-library lists them)` })),
}))
vi.mock('../../marketing/meta-ads/change-media.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/change-media.js')>()),
  libraryVideoLink: vi.fn(async (id: string) => (id === 'da_vid1' ? { url: 'https://res.cloudinary.example-cdn.com/shop-a/vid1.mp4', label: 'Reel' } : { problem: `library video ${id} is not a video of this business's image library` })),
}))
vi.mock('../../marketing/meta-ads/live-posts.js', async () => {
  const { MetaLiveRefusal } = await import('../../marketing/meta-ads/live.js')
  return {
    livePostAccount: vi.fn(async () => ({ connectionId: 'm-1', adAccountId: '1234567890', pageId: '120000000000010', instagramId: '170000000000010' })),
    // A named video Meta ties to the post is its video (live-posts.ts pagePostMadeBy); else the post's own (h.post.videoId).
    livePagePost: vi.fn(async (_c: string, postId: string, opts: { videoId?: string } = {}) => {
      if (!h.post || h.post.postId !== postId) throw new MetaLiveRefusal('That post is not on the Facebook Page this business chose, so it is not read.')
      return { videoId: null, ...structuredClone(h.post), ...(opts.videoId ? { videoId: opts.videoId } : {}) }
    }),
    liveIgMedia: vi.fn(async (_c: string, mediaId: string) => {
      if (!h.media || h.media.mediaId !== mediaId) throw new MetaLiveRefusal('That Instagram media is not the chosen Instagram account\'s, so it is not read.')
      return structuredClone(h.media)
    }),
    liveCreativesUsing: vi.fn(async () => {
      if (h.usesError) {
        const { MetaReadError } = await import('../../marketing/meta-ads/errors.js')
        throw new MetaReadError({ origin: 'meta', httpStatus: 500, code: '2', sentence: 'Meta failed on its side.', authLost: false, throttled: false, notFound: false, transient: true, permissionDenied: false } as never, 'posts.creativesUsing', 1)
      }
      return structuredClone(h.uses)
    }),
    liveVideoPost: vi.fn(async (_c: string, videoId: string) => ({ ...structuredClone(h.videoPost), videoId })),
    liveIgQuota: vi.fn(async () => (h.quota ? structuredClone(h.quota) : null)),
    liveIgContainer: vi.fn(async (_c: string, containerId: string) => (h.container ? { ...structuredClone(h.container), containerId } : null)),
    igContainerNexusMade: vi.fn(async () => ({ instagramId: '170000000000010', made: h.containerMade })),
    igUsernameTaken: vi.fn(async (_c: string, name: string) => {
      if (h.unreadableUser === name) {
        const { MetaReadError } = await import('../../marketing/meta-ads/errors.js')
        throw new MetaReadError({ origin: 'meta', httpStatus: 400, code: '100/33', sentence: 'Meta refused it (100/33): Object does not exist, cannot be loaded due to missing permissions.', authLost: false, throttled: false, notFound: true, transient: false, permissionDenied: false } as never, 'posts.instagramAccountCheck', 1)
      }
      return h.takenUsers.has(name)
    }),
  }
})
vi.mock('../../marketing/meta-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/write-client.js')>()),
  metaCheckChange: h.check,
  metaSendChange: h.send,
}))

import { META_ADS_POSTS_TOOLS } from './meta-ads-posts.tools.js'
import { META_CHANGE_RULES } from './meta-ads-kit.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import { gatewayMetaTakenLinks } from '../../../test-support/gateway-stubs.js'
import { MetaWriteError } from '../../marketing/meta-ads/write-client.js'
import { localFailure } from '../../marketing/meta-ads/errors.js'
import { __postTiming } from '../../marketing/meta-ads/change-posts.js'
import { igUsernameTaken, liveCreativesUsing } from '../../marketing/meta-ads/live-posts.js'
import type { AgentTool, ToolContext, ToolResult } from '../tool-types.js'

const byName = (name: string) => META_ADS_POSTS_TOOLS.find((t) => t.name === name)!
const pageTool = byName('create-meta-page-post')
const editTool = byName('set-meta-page-post')
const removeTool = byName('remove-meta-page-post')
const igTool = byName('create-meta-instagram-post')
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown, extra: Partial<ToolContext> = {}): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview, ...extra })
type Out = ToolResult & { preview: Record<string, any>; data: Record<string, any>; error?: string }
const preview = async (tool: AgentTool, args: Record<string, unknown>) => (await tool.handler(tool.input.parse(args) as Record<string, unknown>, asker)) as Out
const run = async (tool: AgentTool, args: Record<string, unknown>) => {
  const parsed = tool.input.parse(args) as Record<string, unknown>
  const p = (await tool.handler(parsed, asker)) as Out
  if (!p.ok) return { preview: p, ran: null as Out | null }
  return { preview: p, ran: (await tool.execute!(parsed, approved(p.preview))) as Out }
}
const sentParams = (i: number) => (h.send.mock.calls[i][1] as { params: Record<string, string> }).params
const sentChange = (i: number) => h.send.mock.calls[i][1] as Record<string, unknown>
const inHours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString()
const POST_STATE = { pageId: PAGE, postId: POST, message: 'Vecchio testo', hidden: false, published: false, scheduledAt: null, timelineVisibility: 'normal', permalink: null, byThePage: true, sponsorPageIds: [], nexusMade: true }

beforeEach(() => {
  __metaObjectLimitsTest.useMemory()
  vi.unstubAllEnvs()
  h.check.mockReset(); h.send.mockReset()
  h.account = { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' }
  h.post = structuredClone(POST_STATE)
  h.media = { instagramId: IG, mediaId: '180000000000501', productType: 'FEED', nexusMade: true }
  h.uses = { creativeIds: [], complete: true }
  h.quota = { usage: 3, total: 50, durationSec: 86400 }
  h.container = { containerId: '180000000000001', statusCode: 'FINISHED', status: null }
  h.containerMade = true
  h.takenUsers.clear()
  h.unreadableUser = null
  h.videoPost = { pageId: PAGE, videoId: '160000000000001', postId: null }
  h.usesError = false
  gatewayMetaTakenLinks.clear()
  __postTiming.sleep = async () => undefined
})

describe('the tools', () => {
  it('are changes a person always approves (ask ceiling, open world, high risk), each with the #691 truth and its material fields', () => {
    expect(META_ADS_POSTS_TOOLS.map((t) => t.name)).toEqual(['create-meta-page-post', 'set-meta-page-post', 'remove-meta-page-post', 'create-meta-instagram-post'])
    for (const tool of META_ADS_POSTS_TOOLS) {
      expect(tool, tool.name).toMatchObject({ readOnly: false, alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, category: 'advertising' })
      expect(tool.requires).toEqual(['ads.campaigns.manage'])
      expect(tool.description.endsWith(META_CHANGE_RULES), tool.name).toBe(true)
      expect(MATERIAL_PREVIEW_FIELDS[tool.name]).toEqual(['basis', 'plan', 'reach'])
    }
    expect(pageTool.reversibility).toBe('partial')
    expect(pageTool.undo).toBeDefined()
    expect(pageTool.consequencesFor!({ publish: 'now' })).toEqual({ reversibility: 'none' })
    expect(pageTool.consequencesFor!({ publish: 'dark' })).toEqual({ reversibility: 'partial' })
    expect(editTool.consequencesFor!({ postId: POST, publishNow: true })).toEqual({ reversibility: 'none' })
    expect(editTool.consequencesFor!({ postId: POST, message: 'x' })).toEqual({ reversibility: 'partial' })
    expect(editTool.consequencesFor!({ postId: POST, sponsorPageId: '130000000000001', sponsorCanBoost: true })).toEqual({ reversibility: 'none' })
    expect(editTool.consequencesFor!({ postId: POST, sponsorPageId: '130000000000001' })).toEqual({ reversibility: 'partial' })
    // A delete is final, an Instagram post public with no edit: neither has an undo.
    expect(removeTool).toMatchObject({ reversibility: 'none' })
    expect(removeTool.undo).toBeUndefined()
    expect(igTool).toMatchObject({ reversibility: 'none' })
    expect(igTool.undo).toBeUndefined()
    expect(pageTool.description).toMatch(/PUBLIC at once/)
    expect(removeTool.description).toMatch(/Only select developers can perform this operation using the API/)
    expect(igTool.description).toMatch(/Product tags are not set here yet/)
  })
  it('refuse what the arguments do not take, before any read', async () => {
    expect((await preview(pageTool, { format: 'text', publish: 'dark', message: 'x', link: 'https://example-shop.com/' })).error).toMatch(/link is not part of a text post/)
    expect((await preview(pageTool, { format: 'text', publish: 'schedule', message: 'x' })).error).toMatch(/names scheduledAt/)
    expect((await preview(pageTool, { format: 'video', publish: 'now', video: { videoUrl: 'https://cdn.example-shop.com/v.mp4' }, callToAction: { type: 'GET_DIRECTIONS', latitude: 45, longitude: 9, address: 'Via Roma 1' } })).error).toMatch(/goes on a dark post only/)
    expect((await preview(pageTool, { format: 'video', publish: 'dark', video: { videoUrl: 'https://cdn.example-shop.com/v.mp4' }, callToAction: { type: 'MESSAGE_PAGE' } })).error).toMatch(/takes only GET_DIRECTIONS, on an unpublished video/)
    // Review B-F5 / B-F6 — a dark photo post waits for its live check; a local button only on a dark post.
    expect((await preview(pageTool, { format: 'photos', publish: 'dark', photos: [{ imageUrl: 'https://cdn.example-shop.com/1.jpg' }] })).error).toMatch(/waits for a live check .* create-meta-creative/)
    expect((await preview(pageTool, { format: 'link', publish: 'now', callToAction: { type: 'CALL_NOW', phone: '+390212345678' } })).error).toMatch(/goes on a dark post only/)
    // Review B-F7 — a link button takes no link of its own.
    expect(() => pageTool.input.parse({ format: 'link', publish: 'dark', link: 'https://example-shop.com/', callToAction: { type: 'SHOP_NOW', link: 'https://example-shop.com/x' } })).toThrow()
    expect((await preview(igTool, { kind: 'story', image: { imageUrl: 'https://cdn.example-shop.com/s.jpg' }, caption: 'x' })).error).toMatch(/caption is not part of an Instagram story \(Meta takes no caption on a story\)/)
    expect((await preview(igTool, { kind: 'reel', video: { videoUrl: 'https://cdn.example-shop.com/r.mp4' }, altText: 'x' })).error).toMatch(/alt text on images only/)
    expect(() => pageTool.input.parse({ format: 'text', publish: 'dark', message: 'Ciao‮' })).toThrow()
    expect(() => removeTool.input.parse({ platform: 'facebook', postId: POST })).toThrow()
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('create-meta-page-post', () => {
  it('a dark text post: no check, nothing spends, seen by no one; run as the approving person; the post id recorded; undo deletes it while unpublished', async () => {
    h.send.mockResolvedValue({ node: { id: POST }, readBack: 'none', waitedMs: 0 })
    const { preview: p, ran } = await run(pageTool, { format: 'text', publish: 'dark', message: 'Nuova collezione\nin negozio' })
    expect(p.preview.metaCheck).toMatchObject({ checked: 'none', sentence: expect.stringMatching(/no check/) })
    expect(p.preview.spendsMoney).toBe(false)
    expect(p.preview.warnings.join(' ')).toMatch(/UNPUBLISHED \(a "dark" post\)/)
    expect(p.preview.warnings.join(' ')).toMatch(/Nothing spends: an organic post is not an ad/)
    expect(p.preview.warnings.join(' ')).toMatch(/AS the chosen Facebook Page/)
    expect(JSON.stringify(p.preview.changes)).toContain(JSON.stringify('Nuova collezione\nin negozio'))
    expect(h.check).not.toHaveBeenCalled()
    expect(h.send).toHaveBeenCalledWith({ connectionId: 'm-1', adAccountId: '1234567890' }, expect.objectContaining({ objectId: PAGE, kind: 'postpage', edge: 'feed', operation: 'pagepost.feed', params: { published: 'false', message: 'Nuova collezione\nin negozio' } }))
    expect(ran!.ok).toBe(true)
    const after = ran!.change!.after as Record<string, unknown>
    expect(after).toMatchObject({ action: 'create', platform: 'facebook', format: 'text', pageId: PAGE, postId: POST, publish: 'dark', accountId: 'm-1', adAccountId: '1234567890' })
    expect(ran!.data.steps[0].sentence).toMatch(new RegExp(`Meta made it — ${POST} \\(unpublished\\)`))
    // Undo: still unpublished → the delete of exactly that post, which parses as remove-meta-page-post's arguments.
    expect(await pageTool.undo!.current(ran!.change!)).toEqual(after)
    const undo = pageTool.undo!.request(ran!.change!)
    expect(undo).toEqual({ tool: 'remove-meta-page-post', args: { connectionId: 'm-1', platform: 'facebook', postId: POST, confirmDelete: true, why: expect.any(String) } })
    expect(removeTool.input.safeParse((undo as { args: unknown }).args).success).toBe(true)
    // Published meanwhile: no longer what it made — the undo machinery sees the move and deletes nothing.
    h.post = { ...POST_STATE, published: true }
    expect(await pageTool.undo!.current(ran!.change!)).toMatchObject({ publish: 'now' })
  })
  it('PUBLIC at once: said plainly, no undo; a schedule says when it goes public and refuses a time too close or too far', async () => {
    const now = await preview(pageTool, { format: 'text', publish: 'now', message: 'Aperti!' })
    expect(now.preview.warnings.join(' ')).toMatch(/PUBLIC AT ONCE: .* buyers see it\. No undo/)
    expect(pageTool.undo!.request({ before: {}, after: { publish: 'now', postId: POST } })).toEqual({ refusal: expect.stringMatching(/no undo/) })
    const at = inHours(2)
    h.send.mockResolvedValue({ node: { id: POST }, readBack: 'none', waitedMs: 0 })
    const { preview: p } = await run(pageTool, { format: 'text', publish: 'schedule', scheduledAt: at, message: 'Domani' })
    expect(p.preview.warnings.join(' ')).toMatch(/SCHEDULED: Meta publishes it by itself at .* from then it is PUBLIC/)
    expect(sentParams(0)).toEqual({ published: 'false', message: 'Domani', scheduled_publish_time: String(Math.floor(Date.parse(at) / 1000)) })
    expect((await preview(pageTool, { format: 'text', publish: 'schedule', scheduledAt: new Date(Date.now() + 5 * 60_000).toISOString(), message: 'x' })).error).toMatch(/at least 11 minutes ahead/)
    expect((await preview(pageTool, { format: 'text', publish: 'schedule', scheduledAt: inHours(24 * 31), message: 'x' })).error).toMatch(/at most 30 days ahead/)
  })
  it('a link post: its own preview warns of link ownership (MD-140); a call to action in Meta\'s shape; app buttons refused in words', async () => {
    h.send.mockResolvedValue({ node: { id: POST }, readBack: 'none', waitedMs: 0 })
    const { preview: p } = await run(pageTool, { format: 'link', publish: 'dark', link: 'https://example-shop.com', name: 'Giacca', image: { libraryImageId: 'da_img1' }, callToAction: { type: 'SHOP_NOW' } })
    expect(p.preview.warnings.join(' ')).toMatch(/owns the link: the shop's domain verified .* Meta refuses the post in its own words/)
    // Review A-2 — the public text under the link, exactly as sent.
    expect(p.preview.changes['Link title (exactly as sent)']).toEqual({ from: null, to: 'Giacca' })
    expect(sentParams(0)).toEqual({
      published: 'false', link: 'https://example-shop.com/', name: 'Giacca', picture: 'https://res.cloudinary.example-cdn.com/shop-a/img1.jpg',
      call_to_action: JSON.stringify({ type: 'SHOP_NOW', value: { link: 'https://example-shop.com/' } }),
    })
    // Meta's 100 on a custom preview is answered with the link-ownership rule in the step's words.
    h.send.mockReset()
    h.send.mockRejectedValue(new MetaWriteError({ ...localFailure('Meta refused it (100): Invalid parameter. Nothing was changed.', '100'), origin: 'meta', code: '100' } as never, 'pagepost.feed', 'refused'))
    const refused = await run(pageTool, { format: 'link', publish: 'dark', link: 'https://example-shop.com', name: 'Giacca' })
    expect(JSON.stringify(refused.ran)).toMatch(/domain verified for the business in Meta Business Manager/)
    expect((await preview(pageTool, { format: 'link', publish: 'dark', link: 'https://example-shop.com/', callToAction: { type: 'INSTALL_APP' } })).error).toMatch(/does not send the call to action INSTALL_APP: it installs an app, and the business has no app/)
    expect((await preview(pageTool, { format: 'link', publish: 'dark', link: 'https://example-shop.com/', image: { libraryImageId: 'da_other' } })).error).toMatch(/not an image of this business's image library/)
    expect((await preview(pageTool, { format: 'link', publish: 'dark', link: 'https://example-shop.com/', image: { imageUrl: 'https://cdn.example-shop.com/a.jpg?signature=abc' } })).error).toMatch(/no key, signature or sign-in/)
  })
  it('a local call to action (CR-256): the post links to the Page itself, with the ad\'s rules said', async () => {
    h.send.mockResolvedValue({ node: { id: POST }, readBack: 'none', waitedMs: 0 })
    const { preview: p } = await run(pageTool, { format: 'link', publish: 'dark', message: 'Vieni a trovarci', callToAction: { type: 'CALL_NOW', phone: '+390212345678' } })
    expect(sentParams(0)).toMatchObject({ link: `https://www.facebook.com/${PAGE}`, call_to_action: JSON.stringify({ type: 'CALL_NOW', value: { link: 'tel:+390212345678' } }) })
    expect(p.preview.warnings.join(' ')).toMatch(/OUTCOME_AWARENESS, optimization REACH.* 18 or older/)
    expect((await preview(pageTool, { format: 'link', publish: 'dark', link: 'https://example-shop.com/', callToAction: { type: 'GET_DIRECTIONS', latitude: 45.4642, longitude: 9.19, address: 'Via Roma 1, Milano' } })).error).toMatch(/the post's link is the Page's own URL/)
    h.send.mockClear()
    await run(pageTool, { format: 'link', publish: 'dark', callToAction: { type: 'GET_DIRECTIONS', latitude: 45.4642, longitude: 9.19, address: 'Via Roma 1, Milano' } })
    expect(JSON.parse(sentParams(0).call_to_action)).toEqual({ type: 'GET_DIRECTIONS', value: { link: 'fbgeo://45.4642, 9.19, "Via Roma 1, Milano"' } })
  })
  it('a carousel: Meta\'s card reordering sent OFF unless asked (and named); 6 cards only when reordered', async () => {
    h.send.mockResolvedValue({ node: { id: POST }, readBack: 'none', waitedMs: 0 })
    const cards = (n: number) => Array.from({ length: n }, (_, i) => ({ link: `https://example-shop.com/p/${i}`, name: `Card ${i}`, image: { imageHash: `hash${i}` } }))
    const { preview: p } = await run(pageTool, { format: 'carousel', publish: 'dark', link: 'https://example-shop.com/', cards: cards(3) })
    expect(sentParams(0)).toMatchObject({ multi_share_optimized: 'false', multi_share_end_card: 'true' })
    expect(JSON.parse(sentParams(0).child_attachments)).toEqual(cards(3).map((c, i) => ({ link: c.link, name: c.name, image_hash: `hash${i}` })))
    expect(p.preview.warnings.join(' ')).toMatch(/Meta's default is ON: Nexus sends it OFF/)
    expect((await preview(pageTool, { format: 'carousel', publish: 'dark', link: 'https://example-shop.com/', cards: cards(6) })).error).toMatch(/2 to 5 cards/)
    expect((await preview(pageTool, { format: 'carousel', publish: 'dark', link: 'https://example-shop.com/', cards: cards(6), reorderCards: true })).ok).toBe(true)
  })
  it('a photo post: the photos UNPUBLISHED first, then the post attaches the ids Meta answered; a photo Meta refused stops the post', async () => {
    h.send.mockImplementation(async (_t: unknown, change: { operation: string; params: Record<string, string> }) => (change.operation === 'pagepost.photo'
      ? { node: { id: change.params.url.endsWith('1.jpg') ? '140000000000001' : '140000000000002', post_id: 'x' }, readBack: 'same-request', waitedMs: 0 }
      : { node: { id: POST }, readBack: 'none', waitedMs: 0 }))
    const { preview: p, ran } = await run(pageTool, { format: 'photos', publish: 'now', message: 'Due foto', photos: [{ imageUrl: 'https://cdn.example-shop.com/1.jpg', altText: 'Uno' }, { imageUrl: 'https://cdn.example-shop.com/2.jpg' }] })
    expect(p.preview.requests.map((r: { step: number }) => r.step)).toEqual([1, 2, 3])
    expect(sentParams(0)).toEqual({ url: 'https://cdn.example-shop.com/1.jpg', published: 'false', alt_text_custom: 'Uno' })
    expect(sentParams(2)).toEqual({ published: 'true', message: 'Due foto', attached_media: JSON.stringify([{ media_fbid: '140000000000001' }, { media_fbid: '140000000000002' }]) })
    // The same run id rides on every request (the gateway lets the post name only photos this run made).
    const runIds = h.send.mock.calls.map((c) => (c[1] as { runId?: string }).runId)
    expect(new Set(runIds).size).toBe(1)
    expect(runIds[0]).toEqual(expect.any(String))
    expect(ran!.change!.after).toMatchObject({ postId: POST, photoIds: ['140000000000001', '140000000000002'] })
    // Photo 2 refused: the post is not sent (it stands on it), and the record says no post.
    h.send.mockReset()
    h.send.mockImplementation(async (_t: unknown, change: { operation: string; params: Record<string, string> }) => {
      if (change.params.url?.endsWith('2.jpg')) throw new MetaWriteError({ ...localFailure('Meta refused it (324): Missing or invalid image file. Nothing was changed.', '324'), origin: 'meta', code: '324' } as never, 'pagepost.photo', 'refused')
      return { node: { id: '140000000000001' }, readBack: 'same-request', waitedMs: 0 }
    })
    const failed = await run(pageTool, { format: 'photos', publish: 'schedule', scheduledAt: inHours(2), photos: [{ imageUrl: 'https://cdn.example-shop.com/1.jpg' }, { imageUrl: 'https://cdn.example-shop.com/2.jpg' }] })
    expect(h.send).toHaveBeenCalledTimes(2)
    expect(failed.ran!.data.steps[2]).toMatchObject({ outcome: 'not_sent', sentence: expect.stringMatching(/stands on step 2/) })
    expect(JSON.stringify(failed.ran!.data.steps[1])).toMatch(/JPEG, PNG, GIF, BMP or TIFF of at most 10 MB/)
    expect(failed.ran!.change!.after).toMatchObject({ postId: null, photoIds: ['140000000000001'] })
    expect(pageTool.undo!.request(failed.ran!.change!)).toEqual({ refusal: expect.stringMatching(/nothing to delete/) })
  })
  it('a video post: Meta fetches the library video; dark = ADS_POST; its post id recorded from Meta\'s post_id', async () => {
    h.send.mockResolvedValue({ node: { id: '160000000000001', post_id: '500000000000009', published: false }, readBack: 'second-read', waitedMs: 0 })
    const { ran } = await run(pageTool, { format: 'video', publish: 'dark', message: 'Il nuovo casco', video: { libraryVideoId: 'da_vid1', title: 'Casco' } })
    expect(sentChange(0)).toMatchObject({ edge: 'videos', operation: 'pagepost.video', readBackFields: 'id,post_id,published' })
    expect(sentParams(0)).toEqual({ file_url: 'https://res.cloudinary.example-cdn.com/shop-a/vid1.mp4', published: 'false', title: 'Casco', description: 'Il nuovo casco', unpublished_content_type: 'ADS_POST' })
    expect(ran!.change!.after).toMatchObject({ videoId: '160000000000001', postId: `${PAGE}_500000000000009` })
    expect((await preview(pageTool, { format: 'video', publish: 'dark', video: { libraryVideoId: 'da_vid1' }, audience: { countries: ['IT'] } })).error).toMatch(/audience on a text, link, carousel or photo post only/)
  })
  it('never runs by a rule, nor without what was approved', async () => {
    const parsed = pageTool.input.parse({ format: 'text', publish: 'dark', message: 'x' }) as Record<string, unknown>
    const p = (await pageTool.handler(parsed, asker)) as Out
    expect(((await pageTool.execute!(parsed, approved(p.preview, { decidedVia: 'auto' }))) as Out).ok).toBe(false)
    expect(((await pageTool.execute!(parsed, approved({}))) as Out).ok).toBe(false)
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('set-meta-page-post', () => {
  it('an edit of the text: from → to with the exact words, the ads that show the post named; undo writes the old text back', async () => {
    h.uses = { creativeIds: ['120000000000301'], complete: true }
    h.send.mockResolvedValue({ node: { id: POST, message: 'Nuovo testo' }, readBack: 'second-read', waitedMs: 0 })
    const { preview: p, ran } = await run(editTool, { postId: POST, message: 'Nuovo testo', hidden: true })
    expect(p.preview.changes['Text (exactly as sent)']).toEqual({ from: 'Vecchio testo', to: 'Nuovo testo' })
    expect(p.preview.warnings.join(' ')).toMatch(/1 creative of the chosen ad account shows this post \(120000000000301\): their ads show the new text at once/)
    expect(sentChange(0)).toMatchObject({ objectId: POST, kind: 'pagepostedit', operation: 'pagepost.update', params: { message: 'Nuovo testo', is_hidden: 'true' }, expect: { message: 'Nuovo testo', is_hidden: 'true' } })
    const after = ran!.change!.after as Record<string, unknown>
    expect(after).toMatchObject({ action: 'edit', postId: POST, fields: { message: 'Nuovo testo', hidden: true } })
    h.post = { ...POST_STATE, message: 'Nuovo testo', hidden: true }
    expect(await editTool.undo!.current(ran!.change!)).toEqual(after)
    const undo = editTool.undo!.request(ran!.change!)
    expect(undo).toEqual({ tool: 'set-meta-page-post', args: { connectionId: 'm-1', postId: POST, message: 'Vecchio testo', hidden: false, why: expect.any(String) } })
    expect(editTool.input.safeParse((undo as { args: unknown }).args).success).toBe(true)
  })
  it('publish now: PUBLIC at once, one way; a visitor\'s post, an unknown change and a sponsor of another business are refused in words', async () => {
    const p = await preview(editTool, { postId: POST, publishNow: true })
    expect(p.preview.warnings.join(' ')).toMatch(/PUBLIC AT ONCE: .* ONE WAY/)
    expect(p.preview.requests).toHaveLength(1)
    h.post = { ...POST_STATE, byThePage: false }
    expect((await preview(editTool, { postId: POST, message: 'x' })).error).toMatch(/not written by the chosen Facebook Page/)
    h.post = structuredClone(POST_STATE)
    expect((await preview(editTool, { postId: POST, message: 'Vecchio testo' })).error).toMatch(/Nothing to change: The text already reads so/)
    gatewayMetaTakenLinks.add('PAGE:130000000000001')
    expect((await preview(editTool, { postId: POST, sponsorPageId: '130000000000001' })).error).toMatch(/another business in Nexus uses/)
    expect((await preview(editTool, { postId: POST, sponsorPageId: PAGE })).error).toMatch(/never the chosen Page itself/)
    // A schedule only on an unpublished post.
    h.post = { ...POST_STATE, published: true }
    expect((await preview(editTool, { postId: POST, scheduledAt: inHours(3) })).error).toMatch(/already published/)
  })
  it('a first sponsor has no undo (Meta documents no removal); a post Nexus did not make is warned about', async () => {
    h.post = { ...POST_STATE, nexusMade: false }
    h.send.mockResolvedValue({ node: { id: POST }, readBack: 'second-read', waitedMs: 0 })
    const { preview: p, ran } = await run(editTool, { postId: POST, sponsorPageId: '130000000000001', sponsorCanBoost: true })
    expect(sentParams(0)).toEqual({ sponsor_id: '130000000000001', direct_share_status: '1' })
    expect(p.preview.warnings.join(' ')).toMatch(/Meta lets an app change only the posts it made/)
    expect(p.preview.warnings.join(' ')).toMatch(/no removal of a paid-partner tag/)
    expect(editTool.undo!.request(ran!.change!)).toEqual({ refusal: expect.stringMatching(/no removal of a first paid-partner tag/) })
  })
})

describe('remove-meta-page-post', () => {
  it('a Facebook post Nexus made and no ad shows: ONE DELETE, final, with Meta\'s "select developers" rule said', async () => {
    h.send.mockResolvedValue({ node: { success: true }, readBack: 'none', waitedMs: 0 })
    const { preview: p, ran } = await run(removeTool, { platform: 'facebook', postId: POST, confirmDelete: true })
    expect(p.preview.warnings.join(' ')).toMatch(/FINAL: a deleted post cannot come back/)
    expect(p.preview.warnings.join(' ')).toMatch(/Only select developers can perform this operation using the API/)
    expect(sentChange(0)).toMatchObject({ objectId: POST, kind: 'pagepostmade', operation: 'pagepost.delete', method: 'DELETE', params: {} })
    expect(ran!.change!.after).toMatchObject({ action: 'remove', platform: 'facebook', postId: POST, deleted: true })
  })
  it('Meta refusing the delete ("select developers") changes nothing, and the step says a person deletes it in Meta Business Suite', async () => {
    h.send.mockRejectedValue(new MetaWriteError({ ...localFailure('Meta refused it (200): Permissions error. Nothing was changed.', '200'), origin: 'meta', code: '200' } as never, 'pagepost.delete', 'refused'))
    const { ran } = await run(removeTool, { platform: 'facebook', postId: POST, confirmDelete: true })
    expect(ran!.ok).toBe(false)
    expect(JSON.stringify(ran)).toMatch(/Only select developers can perform this operation using the API.*Meta Business Suite/)
  })
  it('refuses a post Nexus did not make, one an ad shows, and one it cannot confirm no ad shows', async () => {
    h.post = { ...POST_STATE, nexusMade: false }
    expect((await preview(removeTool, { platform: 'facebook', postId: POST, confirmDelete: true })).error).toMatch(/not one Nexus made/)
    h.post = structuredClone(POST_STATE)
    h.uses = { creativeIds: ['120000000000301'], complete: true }
    expect((await preview(removeTool, { platform: 'facebook', postId: POST, confirmDelete: true })).error).toMatch(/shown by 1 creative .* never deletes what an ad shows/)
    h.uses = { creativeIds: [], complete: false }
    expect((await preview(removeTool, { platform: 'facebook', postId: POST, confirmDelete: true })).error).toMatch(/could not read them all/)
    expect((await preview(removeTool, { platform: 'facebook', mediaId: '180000000000501', confirmDelete: true })).error).toMatch(/named by postId/)
    expect(h.send).not.toHaveBeenCalled()
  })
  it('an Instagram media Nexus published: ONE DELETE; an ad\'s media or another account\'s is refused', async () => {
    h.send.mockResolvedValue({ node: { success: true, deleted_id: '180000000000501' }, readBack: 'none', waitedMs: 0 })
    const { ran } = await run(removeTool, { platform: 'instagram', mediaId: '180000000000501', confirmDelete: true })
    expect(sentChange(0)).toMatchObject({ objectId: '180000000000501', kind: 'igmediamade', operation: 'igmedia.delete', method: 'DELETE' })
    expect(ran!.change!.after).toMatchObject({ platform: 'instagram', mediaId: '180000000000501', deleted: true })
    h.media = { instagramId: IG, mediaId: '180000000000501', productType: 'AD', nexusMade: true }
    expect((await preview(removeTool, { platform: 'instagram', mediaId: '180000000000501', confirmDelete: true })).error).toMatch(/an ad's media/)
    expect((await preview(removeTool, { platform: 'instagram', mediaId: '180000000000777', confirmDelete: true })).error).toMatch(/not the chosen Instagram account's/)
  })
})

describe('create-meta-instagram-post', () => {
  it('an image: the container, then — once Meta says FINISHED — the publish of exactly that container; PUBLIC, no undo', async () => {
    h.send.mockImplementation(async (_t: unknown, change: { operation: string }) => (change.operation === 'igmedia.container'
      ? { node: { id: '180000000000001', status_code: 'FINISHED' }, readBack: 'second-read', waitedMs: 0 }
      : { node: { id: '180000000000501', permalink: 'https://www.instagram.com/p/ABCDE12345/' }, readBack: 'second-read', waitedMs: 0 }))
    const { preview: p, ran } = await run(igTool, {
      kind: 'image', image: { libraryImageId: 'da_img1' }, altText: 'Giacca nera', caption: 'Nuova! #moto', collaborators: ['shop_b'],
      userTags: [{ username: 'rider.one', x: 0.5, y: 0.5 }], sponsorInstagramIds: ['170000000000201'],
    })
    expect(p.preview.warnings.join(' ')).toMatch(/PUBLIC AT ONCE: once Meta publishes it/)
    expect(p.preview.warnings.join(' ')).toMatch(/3 of 50 API posts used/)
    expect(p.preview.warnings.join(' ')).toMatch(/no edit of a published Instagram post by API/)
    expect(sentChange(0)).toMatchObject({ objectId: IG, kind: 'postig', edge: 'media', operation: 'igmedia.container' })
    expect(sentParams(0)).toEqual({
      image_url: 'https://res.cloudinary.example-cdn.com/shop-a/img1.jpg', caption: 'Nuova! #moto', collaborators: '["shop_b"]',
      branded_content_sponsor_ids: '[170000000000201]', alt_text: 'Giacca nera', user_tags: JSON.stringify([{ username: 'rider.one', x: 0.5, y: 0.5 }]),
    })
    expect(sentChange(1)).toMatchObject({ edge: 'media_publish', operation: 'igmedia.publish', params: { creation_id: '180000000000001' } })
    expect(ran!.change!.after).toMatchObject({ kind: 'image', instagramId: IG, containerId: '180000000000001', mediaId: '180000000000501' })
    expect(ran!.data.steps[1].sentence).toMatch(/PUBLIC now/)
  })
  it('a reel Meta is still preparing after a minute: nothing is public, the container is recorded, kind publish-container publishes it later', async () => {
    h.container = { containerId: '180000000000001', statusCode: 'IN_PROGRESS', status: null }
    h.send.mockResolvedValue({ node: { id: '180000000000001', status_code: 'IN_PROGRESS' }, readBack: 'second-read', waitedMs: 0 })
    const { ran } = await run(igTool, { kind: 'reel', video: { videoUrl: 'https://cdn.example-shop.com/r.mp4' }, caption: 'Reel', shareToFeed: true, trial: 'MANUAL' })
    expect(sentParams(0)).toMatchObject({ media_type: 'REELS', video_url: 'https://cdn.example-shop.com/r.mp4', share_to_feed: 'true', trial_params: '{"graduation_strategy":"MANUAL"}' })
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(ran!.data.steps[1]).toMatchObject({ outcome: 'not_sent', sentence: expect.stringMatching(/still preparing container 180000000000001 .* kind publish-container/) })
    expect(ran!.change!.after).toMatchObject({ containerId: '180000000000001', mediaId: null })
    expect(ran!.data.note).toMatch(/Nothing is public/)
    // Later: the recorded container, FINISHED now — its publish.
    h.container = { containerId: '180000000000001', statusCode: 'FINISHED', status: null }
    h.send.mockReset()
    h.send.mockResolvedValue({ node: { id: '180000000000501' }, readBack: 'second-read', waitedMs: 0 })
    const later = await run(igTool, { kind: 'publish-container', containerId: '180000000000001' })
    expect(sentChange(0)).toMatchObject({ edge: 'media_publish', params: { creation_id: '180000000000001' } })
    expect(later.ran!.change!.after).toMatchObject({ kind: 'publish-container', containerId: '180000000000001', mediaId: '180000000000501' })
    h.containerMade = false
    expect((await preview(igTool, { kind: 'publish-container', containerId: '180000000000002' })).error).toMatch(/publishes only its own containers/)
    h.containerMade = true
    h.container = { containerId: '180000000000003', statusCode: 'EXPIRED', status: null }
    expect((await preview(igTool, { kind: 'publish-container', containerId: '180000000000003' })).error).toMatch(/expired/)
  })
  it('a carousel: one container per item, the carousel from the ids Meta answered (a video item waited for), then its publish', async () => {
    let n = 0
    h.send.mockImplementation(async (_t: unknown, change: { operation: string; params: Record<string, string> }) => {
      if (change.operation === 'igmedia.container') return { node: { id: String(180000000000011 + n++) }, readBack: 'second-read', waitedMs: 0 }
      return { node: { id: '180000000000501' }, readBack: 'second-read', waitedMs: 0 }
    })
    const { preview: p, ran } = await run(igTool, { kind: 'carousel', caption: 'Tre', items: [{ image: { imageUrl: 'https://cdn.example-shop.com/1.jpg' }, altText: 'Uno' }, { video: { videoUrl: 'https://cdn.example-shop.com/2.mp4' } }] })
    expect(p.preview.requests).toHaveLength(4)
    expect(sentParams(0)).toEqual({ image_url: 'https://cdn.example-shop.com/1.jpg', is_carousel_item: 'true', alt_text: 'Uno' })
    expect(sentParams(1)).toEqual({ media_type: 'VIDEO', video_url: 'https://cdn.example-shop.com/2.mp4', is_carousel_item: 'true' })
    expect(sentParams(2)).toEqual({ media_type: 'CAROUSEL', caption: 'Tre', children: '180000000000011,180000000000012' })
    expect(sentParams(3)).toEqual({ creation_id: '180000000000013' })
    expect(ran!.change!.after).toMatchObject({ containerId: '180000000000013', itemContainerIds: ['180000000000011', '180000000000012'], mediaId: '180000000000501' })
  })
  it('Instagram\'s limit read first; a sponsor of another business, the account itself, and a JPEG warning', async () => {
    h.quota = { usage: 50, total: 50, durationSec: 86400 }
    expect((await preview(igTool, { kind: 'image', image: { imageUrl: 'https://cdn.example-shop.com/a.jpg' } })).error).toMatch(/used Instagram's limit of 50 API posts/)
    h.quota = null
    expect((await preview(igTool, { kind: 'image', image: { imageUrl: 'https://cdn.example-shop.com/a.png' } })).preview.warnings.join(' ')).toMatch(/could not read Instagram's publishing limit.*JPEG images only|JPEG images only.*could not read/s)
    gatewayMetaTakenLinks.add('INSTAGRAM:170000000000201')
    expect((await preview(igTool, { kind: 'image', image: { imageUrl: 'https://cdn.example-shop.com/a.jpg' }, sponsorInstagramIds: ['170000000000201'] })).error).toMatch(/another business in Nexus uses/)
    expect((await preview(igTool, { kind: 'image', image: { imageUrl: 'https://cdn.example-shop.com/a.jpg' }, sponsorInstagramIds: [IG] })).error).toMatch(/Cannot tag yourself as sponsor/)
    // A collaborator is invited to co-own the post: never an account another Nexus business chose.
    h.takenUsers.add('shop_b')
    expect((await preview(igTool, { kind: 'image', image: { imageUrl: 'https://cdn.example-shop.com/a.jpg' }, collaborators: ['rider.one', 'shop_b'] })).error).toMatch(/shop_b is one another business in Nexus uses, so no post of this business invites or tags it/)
    // Review A-1 — a tagged account is checked the same way; a check Meta does not answer as "not found" refuses in words.
    expect((await preview(igTool, { kind: 'image', image: { imageUrl: 'https://cdn.example-shop.com/a.jpg' }, userTags: [{ username: 'shop_b', x: 0.5, y: 0.5 }] })).error).toMatch(/shop_b is one another business/)
    expect((await preview(igTool, { kind: 'carousel', items: [{ image: { imageUrl: 'https://cdn.example-shop.com/1.jpg' }, userTags: [{ username: 'SHOP_B', x: 0.1, y: 0.1 }] }, { image: { imageUrl: 'https://cdn.example-shop.com/2.jpg' } }] })).error).toMatch(/shop_b is one another business/)
    h.unreadableUser = 'rider.two'
    expect((await preview(igTool, { kind: 'image', image: { imageUrl: 'https://cdn.example-shop.com/a.jpg' }, collaborators: ['rider.two'] })).error).toMatch(/could not check whether Instagram account rider\.two is one another business in Nexus uses \(.*100\/33.*\), so nothing was asked of Meta/)
  })
  it('an upcoming event: ONE request, Meta\'s time spelling; no delete exists (said)', async () => {
    h.send.mockResolvedValue({ node: { id: '190000000000001', title: 'Saldi' }, readBack: 'second-read', waitedMs: 0 })
    const start = new Date(Math.ceil((Date.now() + 2 * 86_400_000) / 1000) * 1000)
    const { preview: p, ran } = await run(igTool, { kind: 'upcoming-event', event: { title: 'Saldi', startTime: start.toISOString(), notifications: ['EVENT_START', 'BEFORE_EVENT_1DAY', 'BEFORE_EVENT_15MIN'] } })
    expect(sentParams(0)).toEqual({ title: 'Saldi', start_time: `${start.toISOString().slice(0, 19)}+0000`, notification_subtypes: '["EVENT_START","BEFORE_EVENT_1DAY","BEFORE_EVENT_15MIN"]' })
    expect(p.preview.warnings.join(' ')).toMatch(/no delete of an upcoming event/)
    expect(ran!.change!.after).toMatchObject({ kind: 'upcoming-event', eventId: '190000000000001' })
    expect((await preview(igTool, { kind: 'upcoming-event', event: { title: 'x', startTime: new Date(Date.now() - 60_000).toISOString() } })).error).toMatch(/in the future/)
  })
})

describe('review fixes', () => {
  it('A-2 — every public text and tag is in the preview exactly as sent (cards, reel audio / cover / frame, carousel tags)', async () => {
    const carousel = await preview(pageTool, { format: 'carousel', publish: 'dark', link: 'https://example-shop.com/', cards: [{ link: 'https://example-shop.com/a', name: 'Uno', description: 'Prezzo speciale', image: { imageHash: 'h1' } }, { link: 'https://example-shop.com/b', image: { imageHash: 'h2' } }] })
    expect(carousel.preview.changes['Cards (exactly as sent)'].to).toEqual([{ card: 1, link: 'https://example-shop.com/a', name: 'Uno', description: 'Prezzo speciale', image: 'library image h1' }, { card: 2, link: 'https://example-shop.com/b', image: 'library image h2' }])
    const reel = await preview(igTool, { kind: 'reel', video: { videoUrl: 'https://cdn.example-shop.com/r.mp4' }, audioName: 'Suono originale', cover: { imageUrl: 'https://cdn.example-shop.com/c.jpg' }, thumbOffsetMs: 1500 })
    expect(reel.preview.changes['Audio name (exactly as sent)']).toEqual({ from: null, to: 'Suono originale' })
    expect(reel.preview.changes['Cover picture'].to).toBe('https://cdn.example-shop.com/c.jpg')
    expect(reel.preview.changes['Thumbnail frame'].to).toMatch(/1500 ms .*cover instead/)
    const items = await preview(igTool, { kind: 'carousel', items: [{ image: { imageUrl: 'https://cdn.example-shop.com/1.jpg' }, altText: 'Uno', userTags: [{ username: 'rider.one', x: 0.2, y: 0.3 }] }, { video: { videoUrl: 'https://cdn.example-shop.com/2.mp4' } }] })
    expect(items.preview.changes['Items (exactly as sent)'].to).toEqual([
      { item: 1, kind: 'image', source: 'https://cdn.example-shop.com/1.jpg', altText: 'Uno', peopleTagged: [{ username: 'rider.one', x: 0.2, y: 0.3 }] },
      { item: 2, kind: 'video', source: 'https://cdn.example-shop.com/2.mp4' },
    ])
  })
  it('A-3 — an edit whose old text cannot be sent again says "No undo" in its preview; a dark post\'s undo is not over-promised', async () => {
    h.post = { ...POST_STATE, message: null }
    const p = await preview(editTool, { postId: POST, message: 'Primo testo' })
    expect(p.preview.warnings.join(' ')).toMatch(/No undo for this edit: the old text is not one Nexus can send again/)
    const dark = await preview(pageTool, { format: 'text', publish: 'dark', message: 'x' })
    expect(dark.preview.warnings.join(' ')).toMatch(/Its undo deletes it only while it is still unpublished and no ad shows it, and Meta may refuse a delete by API/)
  })
  it('A-4 — publish now and a new schedule name the ads that show the post; a read Meta did not answer is said', async () => {
    h.uses = { creativeIds: ['120000000000301', '120000000000302'], complete: true }
    expect((await preview(editTool, { postId: POST, publishNow: true })).preview.warnings.join(' ')).toMatch(/2 creatives of the chosen ad account show this post \(120000000000301, 120000000000302\): their ads show a post that is PUBLIC on the Page/)
    expect((await preview(editTool, { postId: POST, scheduledAt: inHours(3) })).preview.warnings.join(' ')).toMatch(/2 creatives .* PUBLIC on the Page/)
    h.usesError = true
    expect((await preview(editTool, { postId: POST, message: 'Altro' })).preview.warnings.join(' ')).toMatch(/could not read which ads show this post/)
    // A hide alone reads no creatives.
    h.usesError = false
    expect((await preview(editTool, { postId: POST, hidden: true })).preview.warnings.join(' ')).not.toMatch(/of the chosen ad account show|could not read which ads/)
  })
  it('M36 — a place another Nexus business uses is refused before anything is queued', async () => {
    gatewayMetaTakenLinks.add('PAGE:110000000000001')
    expect((await preview(pageTool, { format: 'text', publish: 'dark', message: 'x', placeId: '110000000000001' })).error).toMatch(/one another business in Nexus uses, so no post of this business tags it as its place/)
    gatewayMetaTakenLinks.clear()
    expect((await preview(pageTool, { format: 'text', publish: 'dark', message: 'x', placeId: '110000000000001' })).preview.changes.Place).toEqual({ from: null, to: 'Page 110000000000001' })
  })
  it('B-F1 / B-F2 — a video post goes to the video host; with no post id yet it keeps its video, and its undo and the delete find the post from it', async () => {
    h.send.mockResolvedValue({ node: { id: '160000000000001' }, readBack: 'none', waitedMs: 0 })
    const { ran } = await run(pageTool, { format: 'video', publish: 'dark', video: { videoUrl: 'https://cdn.example-shop.com/v.mp4' } })
    expect(sentChange(0)).toMatchObject({ videoHost: true, edge: 'videos' })
    expect(ran!.change!.after).toMatchObject({ videoId: '160000000000001', postId: null })
    expect(ran!.data.note).toMatch(/The video post exists \(video 160000000000001\)/)
    expect(ran!.data.sentence).not.toMatch(/No post was made/)
    // Undo: still unpublished (Meta has named the post now) → the delete by its video.
    h.videoPost = { pageId: PAGE, videoId: '160000000000001', postId: POST }
    expect(await pageTool.undo!.current(ran!.change!)).toEqual(ran!.change!.after)
    const undo = pageTool.undo!.request(ran!.change!)
    expect(undo).toEqual({ tool: 'remove-meta-page-post', args: { connectionId: 'm-1', platform: 'facebook', videoId: '160000000000001', confirmDelete: true, why: expect.any(String) } })
    expect(removeTool.input.safeParse((undo as { args: unknown }).args).success).toBe(true)
    // The delete by video id: the post Meta names now, its creatives checked by post AND video.
    h.send.mockReset()
    h.send.mockResolvedValue({ node: { success: true }, readBack: 'none', waitedMs: 0 })
    const removed = await run(removeTool, { platform: 'facebook', videoId: '160000000000001', confirmDelete: true })
    expect(sentChange(0)).toMatchObject({ objectId: POST, kind: 'pagepostmade', method: 'DELETE' })
    expect(removed.ran!.change!.after).toMatchObject({ postId: POST, videoId: '160000000000001', deleted: true })
    h.videoPost = { pageId: PAGE, videoId: '160000000000001', postId: null }
    expect((await preview(removeTool, { platform: 'facebook', videoId: '160000000000001', confirmDelete: true })).error).toMatch(/has not named the post of video 160000000000001 yet/)
    expect((await preview(removeTool, { platform: 'facebook', postId: POST, videoId: '160000000000001', confirmDelete: true })).error).toMatch(/one of them/)
  })
  it('B-F12 — a carousel whose own container failed says nothing was published', async () => {
    let n = 0
    h.send.mockImplementation(async (_t: unknown, change: { operation: string; params: Record<string, string> }) => {
      if (change.params.media_type === 'CAROUSEL') throw new MetaWriteError({ ...localFailure('Meta refused it (100): Invalid parameter. Nothing was changed.', '100'), origin: 'meta', code: '100' } as never, 'igmedia.container', 'refused')
      return { node: { id: String(180000000000011 + n++) }, readBack: 'second-read', waitedMs: 0 }
    })
    const { ran } = await run(igTool, { kind: 'carousel', items: [{ image: { imageUrl: 'https://cdn.example-shop.com/1.jpg' } }, { image: { imageUrl: 'https://cdn.example-shop.com/2.jpg' } }] })
    expect(ran!.data.sentence).toMatch(/Nothing was published, so nothing needs undoing/)
    expect(JSON.stringify(ran!.data.steps)).toMatch(/2 to 20 items/)
  })
})

describe('re-review fixes', () => {
  it('N1 — a delete by post id of a video post Nexus made checks the creatives by its video too, and names the video to the gateway', async () => {
    const VIDEO = '160000000000001'
    h.post = { ...POST_STATE, videoId: VIDEO }
    vi.mocked(liveCreativesUsing).mockClear()
    h.send.mockResolvedValue({ node: { success: true }, readBack: 'none', waitedMs: 0 })
    const { ran } = await run(removeTool, { platform: 'facebook', postId: POST, confirmDelete: true })
    expect(vi.mocked(liveCreativesUsing).mock.calls[0][1]).toEqual({ postId: POST, videoId: VIDEO })
    expect(sentChange(0)).toMatchObject({ objectId: POST, kind: 'pagepostmade', method: 'DELETE', parent: { kind: 'pagevideo', id: VIDEO } })
    expect(ran!.change!.after).toMatchObject({ postId: POST, videoId: VIDEO, deleted: true })
    // A creative that shows the video (by video_id): refused, nothing asked of Meta.
    h.send.mockReset()
    h.uses = { creativeIds: ['120000000000301'], complete: true }
    expect((await preview(removeTool, { platform: 'facebook', postId: POST, confirmDelete: true })).error).toMatch(/shown by 1 creative .*120000000000301.*never deletes what an ad shows/)
    // A post that is no video post names no video.
    h.uses = { creativeIds: [], complete: true }
    h.post = structuredClone(POST_STATE)
    vi.mocked(liveCreativesUsing).mockClear()
    h.send.mockResolvedValue({ node: { success: true }, readBack: 'none', waitedMs: 0 })
    await run(removeTool, { platform: 'facebook', postId: POST, confirmDelete: true })
    expect(vi.mocked(liveCreativesUsing).mock.calls[0][1]).toEqual({ postId: POST })
    expect(sentChange(0)).not.toHaveProperty('parent')
  })
  it('N2 — at most 30 different Instagram accounts are invited or tagged: a 31st is refused before any check', async () => {
    const tags = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ username: `rider_${from + i}`, x: 0.5, y: 0.5 }))
    const carousel = (second: number) => ({ kind: 'carousel', items: [{ image: { imageUrl: 'https://cdn.example-shop.com/1.jpg' }, userTags: tags(1, 20) }, { image: { imageUrl: 'https://cdn.example-shop.com/2.jpg' }, userTags: tags(21, second) }] })
    vi.mocked(igUsernameTaken).mockClear()
    expect((await preview(igTool, carousel(11))).error).toMatch(/at most 30 different Instagram accounts/)
    expect(igUsernameTaken).not.toHaveBeenCalled()
    expect((await preview(igTool, carousel(10))).error ?? '').not.toMatch(/at most 30/)
    expect(igUsernameTaken).toHaveBeenCalledTimes(30)
  })
  it('N3 — a caption that @mentions an account says plainly that mentions are not checked', async () => {
    const mentioned = await preview(igTool, { kind: 'image', image: { imageUrl: 'https://cdn.example-shop.com/a.jpg' }, caption: 'Grazie @rider.one' })
    expect(mentioned.preview.warnings.join(' ')).toMatch(/does NOT check @mentions against the accounts other businesses in Nexus use/)
    const plain = await preview(igTool, { kind: 'image', image: { imageUrl: 'https://cdn.example-shop.com/a.jpg' }, caption: 'Grazie' })
    expect(plain.preview.warnings.join(' ')).not.toMatch(/@mentions/)
  })
})
