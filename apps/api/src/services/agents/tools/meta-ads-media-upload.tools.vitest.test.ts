/**
 * Meta step 23 — create-meta-media as the approval gate uses it (Meta, the account, Nexus's library and the fetch are
 * stand-ins): every upload spends nothing and Meta has no check for it (the preview says both); an image's bytes come only
 * from this business's library or a public link through the safe fetch, are planned exactly and never shown; "was it new?"
 * is read before the upload (Meta gives the same picture the same hash) and only what an upload made new is ever taken
 * back; a video's link is fetched by Meta (Nexus relays no byte), through advideos or Meta's video-ads upload, or comes from
 * the chosen Instagram account (music swap); a folder only in the chosen account's own unshared portfolio; captions (an
 * SRT text) only onto a library video, a locale once, with an undo that takes only that locale off; thumbnails, playables,
 * chunked bytes and copies from another account are answered in words. Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import sharp from 'sharp'

const h = vi.hoisted(() => ({
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown> | { refusal: string },
  chosen: { connectionId: 'm-1', adAccountId: '1234567890', businessId: '9876543210', pageId: null, instagramId: '17841400000000001' } as Record<string, unknown>,
  library: new Map<string, { url: string; label: string | null }>(),
  videos: new Map<string, { url: string; label: string | null }>(),
  files: new Map<string, { buffer: Buffer; mimeType: string }>(),
  records: [] as Array<{ id: string; after: unknown }>,
  /** listPaged's answers by path (rows; `more` when the path is in `longer`). */
  lists: new Map<string, Array<Record<string, unknown>>>(),
  longer: new Set<string>(),
  read: vi.fn(),
  listPaged: vi.fn(),
  send: vi.fn(),
  rupload: vi.fn(),
  ownMedia: vi.fn(),
  taken: vi.fn(async () => new Set<string>()),
  fetchPhoto: vi.fn(),
}))
vi.mock('../../marketing/meta-ads/change-account.js', () => ({ metaChangeAccount: vi.fn(async () => h.account) }))
vi.mock('../../marketing/meta-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live.js')>()),
  metaChosenAccount: vi.fn(async () => h.chosen),
}))
vi.mock('../../marketing/meta-ads/live-media.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live-media.js')>()),
  ownMedia: h.ownMedia,
}))
vi.mock('../../marketing/meta-ads/live-objects.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live-objects.js')>()),
  listPaged: h.listPaged,
}))
vi.mock('../../marketing/meta-ads/read-client.js', () => ({ metaReadOne: h.read }))
vi.mock('../../marketing/meta-ads/taken.js', () => ({ takenIds: h.taken }))
vi.mock('../../marketing/meta-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/write-client.js')>()),
  metaSendChange: h.send,
  metaSendRupload: h.rupload,
}))
vi.mock('../../marketing/google-ads/asset-images.js', () => ({
  libraryImageLink: vi.fn(async (id: string) => h.library.get(id) ?? { problem: `library image ${id} is not an image of this business's image library (image-library lists them)` }),
}))
vi.mock('../../images/photo-from-url.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../../images/photo-from-url.service.js')>()),
  fetchPhoto: h.fetchPhoto,
}))
vi.mock('../../../db.js', () => ({
  default: {
    digitalAsset: { findFirst: vi.fn(async ({ where }: { where: { id: string } }) => h.videos.get(`da_${where.id}`) ?? null) },
    agentChange: {
      findMany: vi.fn(async ({ where }: { where: { after: { array_contains: Array<Record<string, unknown>> } } }) => {
        const wanted = where.after.array_contains[0]
        return h.records.filter((r) => ((r.after as { items?: Array<Record<string, unknown>> }).items ?? []).some((i) => Object.entries(wanted).every(([k, v]) => i[k] === v)))
      }),
    },
  },
}))

import { META_ADS_MEDIA_UPLOAD_TOOLS } from './meta-ads-media-upload.tools.js'
import { META_CHANGE_RULES } from './meta-ads-kit.js'
import { __mediaTiming, CHUNKED_ANSWER, COPY_ANSWER, FOLDER_TAKEN, OWNER_UPLOAD_STEPS, PLAYABLE_ANSWER, THUMBNAIL_ANSWER } from '../../marketing/meta-ads/change-media.js'
import { MetaWriteError } from '../../marketing/meta-ads/write-client.js'
import { localFailure } from '../../marketing/meta-ads/errors.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import type { ToolContext, ToolResult } from '../tool-types.js'

const tool = META_ADS_MEDIA_UPLOAD_TOOLS.find((t) => t.name === 'create-meta-media')!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const recheck: ToolContext = { can: () => true, via: 'system', approvalId: 'ap-1' }
const approved = (preview: unknown, extra: Partial<ToolContext> = {}): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview, ...extra })
const ask = (args: Record<string, unknown>) => tool.input.parse(args) as Record<string, unknown>
const preview = async (args: Record<string, unknown>, ctx = asker) => (await tool.handler(ask(args), ctx)) as ToolResult & { preview: Record<string, any> }
const run = async (args: Record<string, unknown>) => {
  const p = await preview(args)
  expect(p.ok, JSON.stringify(p)).toBe(true)
  return (await tool.execute!(ask(args), approved(p.preview))) as ToolResult & { data: Record<string, any> }
}

const ACT = 'act_1234567890'
let PNG: Buffer
let PNG2: Buffer
const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex')
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
/** A Meta list answer for the image check: `hashes` holds these. */
const imagesHolding = (...hashes: string[]) => ({ body: { data: hashes.map((hash) => ({ hash })) }, calls: 1 })
const uploaded = (hash: string) => async () => ({ node: { images: { bytes: { hash, url: 'https://scontent.example.com/t', width: 4, height: 3 } } }, readBack: 'none', waitedMs: 0 })

beforeEach(async () => {
  __metaObjectLimitsTest.useMemory()
  vi.unstubAllEnvs()
  PNG ??= await sharp({ create: { width: 4, height: 3, channels: 3, background: { r: 200, g: 10, b: 10 } } }).png().toBuffer()
  PNG2 ??= await sharp({ create: { width: 6, height: 6, channels: 3, background: { r: 10, g: 200, b: 10 } } }).png().toBuffer()
  __mediaTiming.sleep = async () => undefined
  __mediaTiming.polls = 3
  h.account = { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' }
  h.chosen = { connectionId: 'm-1', adAccountId: '1234567890', businessId: '9876543210', pageId: null, instagramId: '17841400000000001' }
  h.library = new Map([['da_hero', { url: 'https://res.example.com/hero.png', label: 'Hero A' }], ['pi_front', { url: 'https://res.example.com/front.png', label: 'Front' }]])
  h.videos = new Map([['da_clip', { url: 'https://res.example.com/video/upload/clip-a.mp4', label: 'Clip A' }]])
  h.files = new Map([['https://res.example.com/hero.png', { buffer: PNG, mimeType: 'image/png' }], ['https://res.example.com/front.png', { buffer: PNG2, mimeType: 'image/png' }], ['https://cdn.example.com/given.png', { buffer: PNG2, mimeType: 'image/png' }]])
  h.records = []
  h.fetchPhoto.mockReset()
  h.fetchPhoto.mockImplementation(async (link: string) => {
    const file = h.files.get(link)
    if (!file) throw new Error(`no such file ${link}`)
    return { buffer: file.buffer, mimeType: file.mimeType, bytes: file.buffer.length, contentHash: sha(file.buffer), host: new URL(link).hostname, url: new URL(link).toString() }
  })
  h.read.mockReset(); h.read.mockImplementation(async () => imagesHolding())
  h.lists = new Map(); h.longer = new Set()
  // Like listPaged: at most `max` rows, `more` when the list goes on (or the path is in `longer`).
  h.listPaged.mockReset(); h.listPaged.mockImplementation(async (_c: string, _op: string, path: string, _q: unknown, max: number) => {
    const all = h.lists.get(path) ?? []
    return { rows: all.slice(0, max), more: all.length > max || h.longer.has(path), totalCount: null }
  })
  h.send.mockReset(); h.rupload.mockReset(); h.ownMedia.mockReset()
  h.taken.mockReset(); h.taken.mockImplementation(async () => new Set<string>())
})

describe('the tool', () => {
  it('is a change a person always approves (ask ceiling, open world, high risk), with an undo, saying it spends nothing', () => {
    expect(tool).toMatchObject({ readOnly: false, alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, reversibility: 'partial', requires: ['ads.campaigns.manage'] })
    expect(tool.undo).toBeDefined()
    expect(tool.description.endsWith(META_CHANGE_RULES)).toBe(true)
    expect(tool.description).toMatch(/SPENDS NOTHING/)
    expect(tool.description).toMatch(/Meta has no check for it/)
    expect(MATERIAL_PREVIEW_FIELDS['create-meta-media']).toEqual(['basis', 'plan', 'reach'])
    expect(tool.consequencesFor!({ kind: 'folder' })).toEqual({ reversibility: 'none' })
    expect(tool.consequencesFor!({ kind: 'undo' })).toEqual({ reversibility: 'none' })
    expect(tool.consequencesFor!({ kind: 'image' })).toEqual({ reversibility: 'partial' })
    expect(() => ask({ kind: 'image', images: Array.from({ length: 6 }, () => ({ libraryImageId: 'da_hero' })) })).toThrow()
    expect(() => ask({ kind: 'video', video: { videoUrl: 'http://cdn.example.com/v.mp4' } })).toThrow()
    expect(() => ask({ kind: 'undo', uploads: [{ kind: 'image' }] })).toThrow()
    expect(() => ask({ kind: 'undo', uploads: [{ kind: 'video', hash: 'abc' }] })).toThrow()
  })
  it('thumbnail, playable, chunked bytes and a copy from another account: plain answers, nothing read or sent', async () => {
    for (const [args, words] of [
      [{ kind: 'thumbnail' }, THUMBNAIL_ANSWER], [{ kind: 'playable' }, PLAYABLE_ANSWER],
      [{ kind: 'video', video: { videoUrl: 'https://cdn.example.com/v.mp4', method: 'chunked' } }, CHUNKED_ANSWER],
      [{ kind: 'image', images: [{ libraryImageId: 'da_hero' }], copyFromAccount: { sourceAccountId: '5555555555', hash: 'abc' } }, COPY_ANSWER],
    ] as Array<[Record<string, unknown>, string]>) {
      expect(await tool.handler(ask(args), asker)).toEqual({ ok: false, error: words })
      expect(await tool.execute!(ask(args), approved({}))).toEqual({ ok: false, error: `Not run: ${words}` })
    }
    expect(THUMBNAIL_ANSWER).toMatch(/Thumbnails can only be created on Videos that have been associated with a Page.*step 24/)
    expect(PLAYABLE_ANSWER).toBe('Nexus holds no HTML5 playable files (its media library takes images and videos only), so it uploads no playable.')
    expect(h.fetchPhoto).not.toHaveBeenCalled()
    expect(h.read).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('images', () => {
  it('the preview: this business\'s library image, fetched safely (8 MB cap), "was it new?" read, spends nothing, Meta has no check, no byte shown', async () => {
    const out = await preview({ kind: 'image', images: [{ libraryImageId: 'da_hero' }, { imageUrl: 'https://cdn.example.com/given.png' }] })
    expect(out.ok).toBe(true)
    expect(h.fetchPhoto.mock.calls.map((c) => c.slice(0, 2))).toEqual([['https://res.example.com/hero.png', 8 * 1024 * 1024], ['https://cdn.example.com/given.png', 8 * 1024 * 1024]])
    expect(h.read.mock.calls.map((c) => [c[1].path, c[1].query])).toEqual([[`${ACT}/adimages`, { hashes: [md5(PNG)], fields: 'hash' }], [`${ACT}/adimages`, { hashes: [md5(PNG2)], fields: 'hash' }]])
    expect(out.preview).toMatchObject({ spendsMoney: false, metaCheck: { checked: 'none', sentence: expect.stringMatching(/^Meta has no check for this change/) }, requests: [{ step: 1, metaCheck: 'no-check' }, { step: 2, metaCheck: 'no-check' }] })
    expect(out.preview.requests[0].label).toBe(`Upload image "Hero A" (da_hero; 4×3, 1 KB) to ad account ${ACT}`)
    expect(out.preview.warnings.join(' ')).toMatch(/Meta has no check for an upload/)
    expect(out.preview.warnings.join(' ')).toMatch(/An uploaded image spends nothing/)
    expect(out.preview.warnings.join(' ')).toMatch(/undo removes only an image this upload made new, and only while no creative uses it/)
    expect(JSON.stringify(out.preview)).not.toContain(PNG.toString('base64').slice(0, 24))
    // The re-check reads again and finds the same plan; other bytes are another plan.
    const again = await preview({ kind: 'image', images: [{ libraryImageId: 'da_hero' }, { imageUrl: 'https://cdn.example.com/given.png' }] }, recheck)
    expect([again.preview.basis, again.preview.plan]).toEqual([out.preview.basis, out.preview.plan])
    h.files.set('https://res.example.com/hero.png', { buffer: PNG2, mimeType: 'image/png' })
    const moved = await preview({ kind: 'image', images: [{ libraryImageId: 'da_hero' }] }, recheck)
    expect(moved.preview.plan).not.toBe(out.preview.plan)
  })
  it('refused in words: another business\'s or no library image, a WebP, the same picture twice, a link the safe fetch refuses', async () => {
    expect(await preview({ kind: 'image', images: [{ libraryImageId: 'da_other' }] })).toEqual({ ok: false, error: expect.stringMatching(/^Nothing was asked of Meta: library image da_other is not an image of this business's image library/) })
    h.files.set('https://res.example.com/hero.png', { buffer: PNG, mimeType: 'image/webp' })
    expect(await preview({ kind: 'image', images: [{ libraryImageId: 'da_hero' }] })).toEqual({ ok: false, error: expect.stringMatching(/image\/webp: Meta's ads take JPG or PNG images/) })
    h.files.set('https://res.example.com/hero.png', { buffer: PNG2, mimeType: 'image/png' })
    expect(await preview({ kind: 'image', images: [{ libraryImageId: 'da_hero' }, { libraryImageId: 'pi_front' }] })).toEqual({ ok: false, error: expect.stringMatching(/same picture as another image/) })
    const { PhotoUrlError } = await import('../../images/photo-from-url.service.js')
    h.fetchPhoto.mockImplementationOnce(async () => { throw new PhotoUrlError('The address is not a public internet address.', 400) })
    expect(await preview({ kind: 'image', images: [{ imageUrl: 'https://cdn.example.com/given.png' }] })).toEqual({ ok: false, error: expect.stringMatching(/the link: The address is not a public internet address/) })
    expect(await preview({ kind: 'image', images: [{ libraryImageId: 'da_hero', imageUrl: 'https://cdn.example.com/given.png' }] })).toEqual({ ok: false, error: expect.stringMatching(/one of them/) })
    // Review A3 — a link with a key or a signature is refused before any fetch (it would be recorded), like a video's.
    h.fetchPhoto.mockClear()
    expect(await preview({ kind: 'image', images: [{ imageUrl: 'https://cdn.example.com/given.png?X-Amz-Signature=abc&X-Amz-Expires=60' }] })).toEqual({ ok: false, error: expect.stringMatching(/the link carries no key, signature or sign-in/) })
    expect(h.fetchPhoto).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
    h.account = { refusal: 'No Meta ad account is chosen for this business yet.' }
    expect(await preview({ kind: 'image', images: [{ libraryImageId: 'da_hero' }] })).toEqual({ ok: false, error: 'No Meta ad account is chosen for this business yet.' })
  })
  it('the run: the exact bytes to the account\'s adimages edge; Meta\'s hash = the MD5 and not there before → new, recorded', async () => {
    h.send.mockImplementationOnce(uploaded(md5(PNG)))
    const ran = await run({ kind: 'image', images: [{ libraryImageId: 'da_hero' }] })
    expect(ran.ok).toBe(true)
    expect(h.send.mock.calls[0][1]).toEqual({ objectId: ACT, kind: 'adaccount', params: { bytes: PNG.toString('base64') }, operation: 'media.imageUpload', edge: 'adimages', timeoutMs: 120_000 })
    expect(ran.data.steps[0]).toMatchObject({ outcome: 'done', sentence: expect.stringMatching(/Meta made it; hash [0-9a-f]{32}, new in the ad account/) })
    expect(ran.change).toEqual({
      before: { kind: 'image', items: [{ kind: 'image', source: 'da_hero', inLibrary: false }], accountId: 'm-1', adAccountId: '1234567890' },
      after: { kind: 'image', items: [{ kind: 'image', source: 'da_hero', hash: md5(PNG), new: true }], accountId: 'm-1', adAccountId: '1234567890' },
    })
    expect(JSON.stringify(ran)).not.toContain(PNG.toString('base64').slice(0, 24))
  })
  it('"was it new?": already in the library → not new; a hash that is not the MD5 → not proven (older than the send → not new)', async () => {
    h.read.mockImplementation(async () => imagesHolding(md5(PNG)))
    h.send.mockImplementationOnce(uploaded(md5(PNG)))
    const there = await run({ kind: 'image', images: [{ libraryImageId: 'da_hero' }] })
    expect((there.change!.after as { items: Array<{ new: unknown }> }).items[0].new).toBe(false)
    expect(there.data.steps[0].sentence).toMatch(/already in the ad account/)
    h.read.mockReset()
    h.read.mockImplementation(async (_t: unknown, input: { query: { fields: string } }) => (input.query.fields === 'hash,created_time' ? { body: { data: [{ hash: 'abcabcabcabcabcabcabcabcabcabcab', created_time: '2026-01-01T00:00:00+0000' }] }, calls: 1 } : imagesHolding()))
    h.send.mockImplementationOnce(uploaded('abcabcabcabcabcabcabcabcabcabcab'))
    const older = await run({ kind: 'image', images: [{ libraryImageId: 'da_hero' }] })
    expect((older.change!.after as { items: Array<{ new: unknown }> }).items[0].new).toBe(false)
    h.read.mockReset()
    h.read.mockImplementation(async (_t: unknown, input: { query: { fields: string } }) => (input.query.fields === 'hash,created_time' ? { body: { data: [{ hash: 'abcabcabcabcabcabcabcabcabcabcab', created_time: new Date().toISOString() }] }, calls: 1 } : imagesHolding()))
    h.send.mockImplementationOnce(uploaded('abcabcabcabcabcabcabcabcabcabcab'))
    const unproven = await run({ kind: 'image', images: [{ libraryImageId: 'da_hero' }] })
    expect((unproven.change!.after as { items: Array<{ new: unknown }> }).items[0].new).toBeNull()
    expect(unproven.data.steps[0].sentence).toMatch(/not proven new \(its undo never removes it\)/)
    // An answer with no single hash: Meta may have made it — not confirmed, no record.
    h.send.mockImplementationOnce(async () => ({ node: { images: {} }, readBack: 'none', waitedMs: 0 }))
    const blind = await run({ kind: 'image', images: [{ libraryImageId: 'da_hero' }] })
    expect(blind).toEqual({ ok: false, error: expect.stringMatching(/^Not confirmed: .*without one image hash/) })
  })
})

describe('images — the approved picture only', () => {
  it('IMAGE_MOVED: bytes that are not the approved picture are never sent', async () => {
    // The fetch hands bytes whose sha256 is not the one the plan holds (the file changed between the read and the send).
    h.fetchPhoto.mockImplementation(async (link: string) => ({ buffer: PNG, mimeType: 'image/png', bytes: PNG.length, contentHash: 'f'.repeat(64), host: new URL(link).hostname, url: link }))
    const ran = await run({ kind: 'image', images: [{ libraryImageId: 'da_hero' }] })
    expect(ran).toEqual({ ok: false, error: expect.stringMatching(/^Not run: Meta changed nothing\..*"Hero A" is not the picture that was approved; nothing was sent/) })
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('videos', () => {
  it('by its link (Nexus\'s library video): Meta fetches it on advideos; the run reads its status; new by its own clock', async () => {
    const out = await preview({ kind: 'video', video: { libraryVideoId: 'da_clip', name: 'Clip A' } })
    expect(out.preview.requests[0].label).toBe(`Upload video "Clip A" (da_clip) to ad account ${ACT}: Meta fetches it from res.example.com`)
    expect(out.preview.warnings.join(' ')).toMatch(/Nexus sends no byte of it/)
    expect(out.preview.spendsMoney).toBe(false)
    h.send.mockImplementationOnce(async () => ({ node: { id: '120000000000501', created_time: new Date().toISOString(), status: { video_status: 'processing', processing_progress: 40 } }, readBack: 'second-read', waitedMs: 0 }))
    h.read.mockImplementation(async () => ({ body: { id: '120000000000501', created_time: new Date().toISOString(), status: { video_status: 'ready' } }, calls: 1 }))
    const ran = await run({ kind: 'video', video: { libraryVideoId: 'da_clip', name: 'Clip A' } })
    expect(h.send.mock.calls[0][1]).toEqual({ objectId: ACT, kind: 'adaccount', params: { file_url: 'https://res.example.com/video/upload/clip-a.mp4', name: 'Clip A' }, operation: 'media.videoUpload', edge: 'advideos', readBackFields: 'id,created_time,status', timeoutMs: 120_000 })
    expect(ran.data.steps[0].sentence).toMatch(/video 120000000000501, ready: a creative can use it; new in the ad account/)
    expect(ran.change!.after).toEqual({ kind: 'video', items: [{ kind: 'video', source: 'da_clip', videoId: '120000000000501', method: 'advideos', new: true }], accountId: 'm-1', adAccountId: '1234567890' })
  })
  it('a link a person gives: refused when it signs in or is no public address; never fetched by Nexus', async () => {
    expect(await preview({ kind: 'video', video: { videoUrl: 'https://cdn.example.com/v.mp4?X-Amz-Signature=abc' } })).toEqual({ ok: false, error: expect.stringMatching(/no key, signature or sign-in/) })
    expect(await preview({ kind: 'video', video: { videoUrl: 'https://192.168.1.5/v.mp4' } })).toEqual({ ok: false, error: expect.stringMatching(/by its name/) })
    expect(await preview({ kind: 'video', video: { libraryVideoId: 'da_other' } })).toEqual({ ok: false, error: expect.stringMatching(/not a video of this business's image library/) })
    expect(await preview({ kind: 'video', video: { videoUrl: 'https://cdn.example.com/v.mp4', libraryVideoId: 'da_clip' } })).toEqual({ ok: false, error: expect.stringMatching(/exactly one of/) })
    expect(h.fetchPhoto).not.toHaveBeenCalled()
  })
  it('Meta\'s video-ads upload: start → the link on the upload host → finish, one step; a failed link leaves nothing in the library', async () => {
    h.send
      .mockImplementationOnce(async () => ({ node: { video_id: '120000000000502', upload_url: 'https://rupload.facebook.com/video-ads-upload/v26.0/120000000000502' }, readBack: 'none', waitedMs: 0 }))
      .mockImplementationOnce(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 }))
    h.rupload.mockImplementationOnce(async () => ({ node: { success: true } }))
    h.read.mockImplementation(async (_t: unknown, input: { query: { fields: string } }) => ({ body: { id: '120000000000502', status: { video_status: input.query.fields === 'id,status' ? 'processing' : 'ready', uploading_phase: { status: 'complete' } } }, calls: 1 }))
    const ran = await run({ kind: 'video', video: { videoUrl: 'https://cdn.example.com/v.mp4', method: 'video_ads' } })
    expect(h.send.mock.calls.map((c) => [c[1].edge, c[1].params])).toEqual([['video_ads', { upload_phase: 'start' }], ['video_ads', { upload_phase: 'finish', video_id: '120000000000502' }]])
    expect(h.rupload.mock.calls[0][1]).toEqual({ videoId: '120000000000502', fileUrl: 'https://cdn.example.com/v.mp4', operation: 'media.videoAdsUpload' })
    expect(ran.change!.after).toEqual({ kind: 'video', items: [{ kind: 'video', source: 'https://cdn.example.com/v.mp4', videoId: '120000000000502', method: 'video_ads', new: true }], accountId: 'm-1', adAccountId: '1234567890' })
    h.send.mockReset()
    h.send.mockImplementationOnce(async () => ({ node: { video_id: '120000000000503' }, readBack: 'none', waitedMs: 0 }))
    h.rupload.mockImplementationOnce(async () => { throw new MetaWriteError(localFailure('Meta refused it (389): Unable to fetch video file from URL. Nothing was changed.', 'X'), 'up', 'refused') })
    const failed = await run({ kind: 'video', video: { videoUrl: 'https://cdn.example.com/v.mp4', method: 'video_ads' } })
    expect(failed).toEqual({ ok: false, error: expect.stringMatching(/Unable to fetch video file from URL.*left unfinished and expires; nothing was added/) })
    expect(h.send).toHaveBeenCalledTimes(1)
  })
  it('D3 B step 3 — Meta refuses the system user: the answer says how the Owner uploads it in Meta\'s screens', async () => {
    h.send.mockImplementationOnce(async () => { throw new MetaWriteError({ ...localFailure('Meta does not let this system user change this: Uploading videos to business accounts is not yet supported.', '200'), permissionDenied: true }, 'media.videoUpload', 'refused') })
    const ran = await run({ kind: 'video', video: { libraryVideoId: 'da_clip' } })
    expect(ran).toEqual({ ok: false, error: expect.stringContaining(OWNER_UPLOAD_STEPS) })
  })
  it('B6 — an unknown music-swap word keeps the run polling until its time limit (only SUCCESSFUL or a failure word ends it)', async () => {
    h.ownMedia.mockImplementation(async (_a: unknown, id: string) => ({ mediaId: id, productType: 'REELS' }))
    h.send.mockImplementationOnce(async () => ({ node: { id: '120000000000505', created_time: new Date().toISOString(), status: { video_status: 'ready' }, replace_audio_status: 'QUEUED_FOR_MIX' }, readBack: 'second-read', waitedMs: 0 }))
    h.read.mockImplementation(async () => ({ body: { id: '120000000000505', status: { video_status: 'ready' }, replace_audio_status: 'QUEUED_FOR_MIX' }, calls: 1 }))
    const ran = await run({ kind: 'video', video: { instagramMediaId: '17900000000000001', swapAudioAssetId: '1234567' } })
    expect(h.read.mock.calls.filter((c) => c[1].path === '120000000000505')).toHaveLength(__mediaTiming.polls)
    expect(ran.data.steps[0].sentence).toMatch(/music swap: QUEUED_FOR_MIX/)
  })
  it('the chosen Instagram account\'s video, its music swapped (exact JSON); another account\'s media and odd combinations refused', async () => {
    h.ownMedia.mockImplementation(async (_a: unknown, id: string) => ({ mediaId: id, productType: 'REELS' }))
    h.send.mockImplementationOnce(async () => ({ node: { id: '120000000000504', created_time: new Date().toISOString(), status: { video_status: 'ready' }, replace_audio_status: 'SUCCESSFUL' }, readBack: 'second-read', waitedMs: 0 }))
    const ran = await run({ kind: 'video', video: { instagramMediaId: '17900000000000001', swapAudioAssetId: '1234567' } })
    expect(h.send.mock.calls[0][1]).toMatchObject({ params: { source_instagram_media_id: '17900000000000001', selected_audio_spec: '{"audio_asset_id":"1234567"}' }, edge: 'advideos', readBackFields: 'id,created_time,status,replace_audio_status,selected_audio_spec' })
    expect(ran.data.steps[0].sentence).toMatch(/music swap: SUCCESSFUL/)
    const { MetaLiveRefusal } = await import('../../marketing/meta-ads/live.js')
    h.ownMedia.mockImplementationOnce(async () => { throw new MetaLiveRefusal('That Instagram media is not the chosen Instagram account\'s, so it is not read.') })
    expect(await preview({ kind: 'video', video: { instagramMediaId: '17900000000000009' } })).toEqual({ ok: false, error: expect.stringMatching(/not the chosen Instagram account's/) })
    expect(await preview({ kind: 'video', video: { libraryVideoId: 'da_clip', swapAudioAssetId: '1234567' } })).toEqual({ ok: false, error: expect.stringMatching(/swaps the music only of an Instagram Reel/) })
    expect(await preview({ kind: 'video', video: { instagramMediaId: '17900000000000001', method: 'video_ads' } })).toEqual({ ok: false, error: expect.stringMatching(/not an Instagram media/) })
  })
})

describe('videos — review fixes', () => {
  it('B4: video_ads takes only the video — a name, title or description is refused in words, never dropped; A6: text checked', async () => {
    expect(await preview({ kind: 'video', video: { videoUrl: 'https://cdn.example.com/v.mp4', method: 'video_ads', title: 'Spot A' } })).toEqual({ ok: false, error: expect.stringMatching(/video_ads finish takes only the video.*Use method advideos/) })
    expect(await preview({ kind: 'video', video: { libraryVideoId: 'da_clip', name: '\u3164\u2800' } })).toEqual({ ok: false, error: expect.stringMatching(/name has at least one visible character/) })
    expect(await preview({ kind: 'video', video: { libraryVideoId: 'da_clip', name: '\u200B\u200B' } })).toEqual({ ok: false, error: expect.stringMatching(/name carries no control or format character/) })
    expect(await preview({ kind: 'video', video: { libraryVideoId: 'da_clip', title: 'Spot \u202Eabc' } })).toEqual({ ok: false, error: expect.stringMatching(/bidirectional control/) })
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('captions (MD-026)', () => {
  const SRT = '1\n00:00:01,000 --> 00:00:03,500\nCiao!\n\n2\n00:00:04,000 --> 00:00:06,000\nSpedizione gratuita'
  const VIDEO = '120000000000501'
  it('onto a library video only, a locale once, the SRT checked; the file goes once, never shown', async () => {
    expect(await preview({ kind: 'captions', captions: { videoId: VIDEO, locale: 'it_IT', srt: SRT } })).toEqual({ ok: false, error: expect.stringMatching(/not one Nexus can confirm in the chosen ad account's video library/) })
    h.lists.set(`${ACT}/video_ads`, [{ id: VIDEO }])
    h.lists.set(`${VIDEO}/captions`, [{ locale: 'en_US', is_default: true }])
    expect(await preview({ kind: 'captions', captions: { videoId: VIDEO, locale: 'en_US', srt: SRT } })).toEqual({ ok: false, error: expect.stringMatching(/already has captions in en_US, and Meta takes a locale only once/) })
    expect(await preview({ kind: 'captions', captions: { videoId: VIDEO, locale: 'it_IT', srt: 'just words' } })).toEqual({ ok: false, error: expect.stringMatching(/SubRip/) })
    expect(await preview({ kind: 'captions', captions: { videoId: VIDEO, locale: 'it_IT', srt: SRT, defaultLocale: 'de_DE' } })).toEqual({ ok: false, error: expect.stringMatching(/default caption locale is none, it_IT/) })
    const out = await preview({ kind: 'captions', captions: { videoId: VIDEO, locale: 'it_IT', srt: SRT, fileName: 'Spot A', defaultLocale: 'it_IT' } })
    expect(out.preview).toMatchObject({ spendsMoney: false, metaCheck: { checked: 'none' }, changes: { [`Video ${VIDEO} captions`]: { from: 'en_US', to: 'en_US, it_IT' }, [`Video ${VIDEO} default caption`]: { from: 'en_US', to: 'it_IT' } } })
    expect(out.preview.requests[0].label).toMatch(/Add it_IT captions \(spot-a\.it_IT\.srt, 1 KB\) to video 120000000000501/)
    expect(out.preview.warnings.join(' ')).toMatch(/puts the default caption back to en_US/)
    expect(JSON.stringify(out.preview)).not.toContain('Ciao')
    h.send.mockImplementationOnce(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 }))
    const ran = await tool.execute!(ask({ kind: 'captions', captions: { videoId: VIDEO, locale: 'it_IT', srt: SRT, fileName: 'Spot A', defaultLocale: 'it_IT' } }), approved(out.preview)) as ToolResult & { data: Record<string, any> }
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: VIDEO, kind: 'libraryvideo', edge: 'captions', operation: 'media.captionsUpload', params: { captions_file: SRT, captions_file_name: 'spot-a.it_IT.srt', default_locale: 'it_IT' } })
    expect(ran.change!.after).toEqual({ kind: 'captions', items: [{ kind: 'captions', videoId: VIDEO, locale: 'it_IT', new: true, setDefault: 'it_IT', defaultBefore: 'en_US' }], accountId: 'm-1', adAccountId: '1234567890' })
    expect(JSON.stringify(ran)).not.toContain('Ciao')
    // Its undo: the locale off again, the default back — through kind undo, valid for the tool's own input.
    const back = tool.undo!.request(ran.change!)
    expect(back).toEqual({ tool: 'create-meta-media', args: { connectionId: 'm-1', kind: 'undo', uploads: [{ kind: 'captions', videoId: VIDEO, locale: 'it_IT', restoreDefault: 'en_US' }], why: expect.any(String) } })
    expect(() => ask((back as { args: Record<string, unknown> }).args)).not.toThrow()
  })
  it('the undo takes only the locale its record added, with only the default it replaced', async () => {
    h.lists.set(`${ACT}/advideos`, [{ id: VIDEO }])
    h.lists.set(`${VIDEO}/captions`, [{ locale: 'it_IT', is_default: true }, { locale: 'en_US' }])
    h.records = [{ id: 'c-2', after: { kind: 'captions', items: [{ kind: 'captions', videoId: VIDEO, locale: 'it_IT', new: true, setDefault: 'it_IT', defaultBefore: 'en_US' }], accountId: 'm-1', adAccountId: '1234567890' } }]
    expect(await preview({ kind: 'undo', uploads: [{ kind: 'captions', videoId: VIDEO, locale: 'en_US' }] })).toEqual({ ok: false, error: expect.stringMatching(/the en_US captions of video .* not one a create-meta-media upload/) })
    expect(await preview({ kind: 'undo', uploads: [{ kind: 'captions', videoId: VIDEO, locale: 'it_IT', restoreDefault: 'none' }] })).toEqual({ ok: false, error: expect.stringMatching(/with default none/) })
    const args = { kind: 'undo', uploads: [{ kind: 'captions', videoId: VIDEO, locale: 'it_IT', restoreDefault: 'en_US' }] }
    const out = await preview(args)
    h.send.mockImplementationOnce(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 }))
    const ran = await tool.execute!(ask(args), approved(out.preview)) as ToolResult & { data: Record<string, any> }
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: VIDEO, kind: 'libraryvideo', edge: 'captions', operation: 'media.captionsRemove', params: { locales_to_delete: '["it_IT"]', default_locale: 'en_US' } })
    expect(ran.change!.after).toEqual({ kind: 'undo', items: [{ kind: 'captions', videoId: VIDEO, locale: 'it_IT', removed: true }], accountId: 'm-1', adAccountId: '1234567890' })
  })
})

describe('folders', () => {
  it('review round 2 — the same 500 rows as the gateway: a parent in row 450 of a 600-row list passes, one in row 550 is refused', async () => {
    h.listPaged.mockImplementation(async (_c: string, _op: string, _path: string, _q: unknown, max: number) => {
      const all = Array.from({ length: 600 }, (_, i) => ({ id: String(120000000001000 + i + 1), name: `F${i + 1}`, parent_folder_id: null }))
      return { rows: all.slice(0, max), more: all.length > max, totalCount: null }
    })
    const at450 = await preview({ kind: 'folder', folder: { name: 'Inner', parentFolderId: String(120000000001000 + 450) } })
    expect(at450.ok).toBe(true)
    expect(await preview({ kind: 'folder', folder: { name: 'Inner', parentFolderId: String(120000000001000 + 550) } })).toEqual({ ok: false, error: expect.stringMatching(/not one of the portfolio's media-library folders Nexus can read \(it reads the first 500\)/) })
  })
  it('only in the chosen account\'s own portfolio, never a shared one; its parent must be the portfolio\'s; no undo', async () => {
    h.taken.mockImplementationOnce(async () => new Set(['9876543210']))
    expect(await preview({ kind: 'folder', folder: { name: 'Spring 2026' } })).toEqual({ ok: false, error: FOLDER_TAKEN })
    h.listPaged.mockImplementation(async () => ({ rows: [{ id: '120000000000701', name: 'Spring 2026', parent_folder_id: null }], more: false, totalCount: null }))
    expect(await preview({ kind: 'folder', folder: { name: 'Inner', parentFolderId: '120000000000799' } })).toEqual({ ok: false, error: expect.stringMatching(/folder 120000000000799 is not one of the portfolio's media-library folders/) })
    const twin = await preview({ kind: 'folder', folder: { name: 'spring 2026' } })
    expect(twin.preview.warnings.join(' ')).toMatch(/already has a folder named "spring 2026"/)
    expect(twin.preview.warnings.join(' ')).toMatch(/no API to rename or delete/)
    h.send.mockImplementationOnce(async () => ({ node: { id: '120000000000702', name: 'Inner' }, readBack: 'second-read', waitedMs: 0 }))
    const ran = await run({ kind: 'folder', folder: { name: 'Inner', parentFolderId: '120000000000701' } })
    expect(h.send.mock.calls[0][1]).toEqual({ objectId: '9876543210', kind: 'portfolio', params: { name: 'Inner', parent_folder_id: '120000000000701' }, operation: 'media.folderCreate', edge: 'creative_folders', readBackFields: 'id,name,creation_time' })
    expect(ran.change!.after).toEqual({ kind: 'folder', items: [{ kind: 'folder', folderId: '120000000000702', name: 'Inner', portfolioId: '9876543210' }], accountId: 'm-1', adAccountId: '1234567890' })
    expect(tool.undo!.request(ran.change!)).toEqual({ refusal: expect.stringMatching(/no API to delete or rename/) })
  })
})

describe('undo', () => {
  const after = (items: unknown[]) => ({ kind: 'image', items, accountId: 'm-1', adAccountId: '1234567890' })
  it('request(): only what the upload made new, through kind undo, valid for the tool\'s own input', () => {
    const change = { before: { kind: 'image', items: [] }, after: { kind: 'video', items: [{ kind: 'video', source: 'da_clip', videoId: '120000000000501', method: 'advideos', new: true }], accountId: 'm-1', adAccountId: '1234567890' } }
    const back = tool.undo!.request(change)
    expect(back).toEqual({ tool: 'create-meta-media', args: { connectionId: 'm-1', kind: 'undo', uploads: [{ kind: 'video', videoId: '120000000000501' }], why: expect.stringMatching(/only what it made new/) } })
    expect(() => ask((back as { args: Record<string, unknown> }).args)).not.toThrow()
    expect(tool.undo!.request({ before: {}, after: after([{ kind: 'image', source: 'da_hero', hash: 'a1', new: false }, { kind: 'image', source: 'pi_front', hash: 'b2', new: null }]) })).toEqual({ refusal: expect.stringMatching(/made nothing new/) })
    expect(tool.undo!.request({ before: {}, after: { kind: 'undo', items: [] } })).toEqual({ refusal: expect.stringMatching(/cannot put a removed image, video or caption back/) })
  })
  it('current(): what is there now, equal to the record when nothing moved', async () => {
    const record = after([{ kind: 'image', source: 'da_hero', hash: 'a1', new: true }, { kind: 'image', source: 'pi_front', hash: 'b2', new: false }])
    h.read.mockImplementation(async () => ({ body: { data: [{ hash: 'a1', status: 'ACTIVE' }] }, calls: 1 }))
    expect(await tool.undo!.current({ before: {}, after: record })).toEqual(record)
    h.read.mockImplementation(async () => ({ body: { data: [] }, calls: 1 }))
    expect(await tool.undo!.current({ before: {}, after: record })).not.toEqual(record)
  })
  it('review A1 / B3 — a video comes out only when no creative of the account uses it; the library is read on advideos AND video_ads', async () => {
    const used = '120000000000511'
    const free = '120000000000512'
    h.records = [{ id: 'c-3', after: { kind: 'video', items: [{ kind: 'video', source: 'da_clip', videoId: used, method: 'advideos', new: true }, { kind: 'video', source: 'https://cdn.example.com/v.mp4', videoId: free, method: 'video_ads', new: true }], accountId: 'm-1', adAccountId: '1234567890' } }]
    h.lists.set(`${ACT}/advideos`, [{ id: used }])
    h.lists.set(`${ACT}/video_ads`, [{ id: free }])
    h.lists.set(`${ACT}/adcreatives`, [{ id: '120000000000801', object_story_spec: { page_id: '1', video_data: { video_id: used, image_hash: 'a1' } } }, { id: '120000000000802', asset_feed_spec: { videos: [{ video_id: '120000000000599' }] } }])
    const args = { kind: 'undo', uploads: [{ kind: 'video', videoId: used }, { kind: 'video', videoId: free }] }
    const out = await preview(args)
    expect(h.listPaged.mock.calls.map((c) => c[2])).toEqual(expect.arrayContaining([`${ACT}/advideos`, `${ACT}/video_ads`, `${ACT}/adcreatives`]))
    expect(out.preview.requests.map((r: { label: string }) => r.label)).toEqual([`Remove video ${free} (uploaded by Nexus) from ad account ${ACT}`])
    expect(out.preview.skipped[0]).toMatch(/Video 120000000000511 stays: creative 120000000000801 uses it, and an ad would lose its video/)
    expect(out.preview.warnings.join(' ')).toMatch(/A video a creative of this account uses stays/)
    // More creatives than Nexus reads: not confirmed unused, so it stays.
    h.longer.add(`${ACT}/adcreatives`)
    const longer = await preview({ kind: 'undo', uploads: [{ kind: 'video', videoId: free }] })
    expect(longer).toEqual({ ok: false, error: expect.stringMatching(/more than 500 creatives, so Nexus cannot confirm no ad uses it/) })
    // current(): a video-ads upload listed only on video_ads counts as there.
    const record = h.records[0].after as Record<string, unknown>
    expect(await tool.undo!.current({ before: {}, after: record })).toEqual(record)
  })
  it('kind undo: only an upload a record of this business made new here; an image a creative uses stays; DELETE with its key', async () => {
    expect(await preview({ kind: 'undo', uploads: [{ kind: 'image', hash: 'a1' }] })).toEqual({ ok: false, error: expect.stringMatching(/not one a create-meta-media upload of this business made new in ad account act_1234567890/) })
    h.records = [{ id: 'c-1', after: after([{ kind: 'image', source: 'da_hero', hash: 'a1', new: true }, { kind: 'image', source: 'pi_front', hash: 'b2', new: true }]) }]
    // A record of ANOTHER ad account of this business does not count.
    h.account = { target: { connectionId: 'm-1', adAccountId: '1234567891' }, accountId: 'm-1', adAccountId: '1234567891', name: null, currency: 'EUR' }
    expect(await preview({ kind: 'undo', uploads: [{ kind: 'image', hash: 'a1' }] })).toEqual({ ok: false, error: expect.stringMatching(/not one a create-meta-media upload/) })
    h.account = { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' }
    h.read.mockImplementation(async () => ({ body: { data: [{ hash: 'a1', status: 'ACTIVE', creatives: [] }, { hash: 'b2', status: 'ACTIVE', creatives: ['120000000000801'] }] }, calls: 1 }))
    const out = await preview({ kind: 'undo', uploads: [{ kind: 'image', hash: 'a1' }, { kind: 'image', hash: 'b2' }] })
    expect(out.preview.requests.map((r: { label: string }) => r.label)).toEqual([`Remove image a1 (uploaded new by Nexus) from ad account ${ACT}`])
    expect(out.preview.skipped[0]).toMatch(/Image b2 stays: creative 120000000000801 uses it, and Meta deletes an image only while no creative uses it/)
    h.send.mockImplementationOnce(async () => ({ node: { success: true }, readBack: 'none', waitedMs: 0 }))
    const ran = await tool.execute!(ask({ kind: 'undo', uploads: [{ kind: 'image', hash: 'a1' }, { kind: 'image', hash: 'b2' }] }), approved(out.preview)) as ToolResult & { data: Record<string, any> }
    expect(h.send.mock.calls[0][1]).toMatchObject({ objectId: ACT, kind: 'adaccount', params: { hash: 'a1' }, edge: 'adimages', method: 'DELETE', operation: 'media.imageRemove' })
    expect(ran.change!.after).toEqual({ kind: 'undo', items: [{ kind: 'image', hash: 'a1', removed: true }], accountId: 'm-1', adAccountId: '1234567890' })
    expect(tool.undo!.request(ran.change!)).toEqual({ refusal: expect.any(String) })
  })
})
