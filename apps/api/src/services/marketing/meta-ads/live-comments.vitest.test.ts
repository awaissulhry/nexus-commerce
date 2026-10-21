/**
 * Meta step 37 — the live state a comment change reads: step 14's owner checks first (never copied), then fixed field
 * lists; a Facebook comment's words are asked only for an edit and kept only when the Page wrote them; a Threads reply
 * must be a direct reply of the ad's post; Meta not listing the blocked people is "unknown", not "not blocked". Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  reads: [] as Array<{ operation: string; path: string; query: Record<string, unknown> }>,
  bodies: {} as Record<string, Record<string, unknown>>,
  lists: {} as Record<string, { rows: Array<Record<string, unknown>>; more: boolean } | Error>,
  refuseCan: false,
}))
vi.mock('./live.js', async (importActual) => ({
  ...(await importActual<typeof import('./live.js')>()),
  metaChosenAccount: vi.fn(async () => ({ connectionId: 'm-1', adAccountId: '1234567890', pageId: '120000000000010', instagramId: '170000000000010', businessId: null, name: null, currency: 'EUR', timeZone: null, connection: {} })),
}))
vi.mock('./live-engagement.js', () => ({
  postOf: vi.fn(async (_a: unknown, input: { postId?: string | null }) => input.postId ?? '120000000000010_500000000000001'),
  ownFacebookComment: vi.fn(async (_a: unknown, postId: string, commentId: string) => ({ postId, commentId, prefixes: [] })),
  ownInstagramComment: vi.fn(async (_a: unknown, id: string) => ({ commentId: id, mediaId: '180000000000001' })),
  mediaOf: vi.fn(async (_a: unknown, input: { mediaId?: string | null }) => input.mediaId ?? '180000000000001'),
  threadsMediaOf: vi.fn(async () => '210000000000001'),
  liveComments: vi.fn(),
}))
vi.mock('./read-client.js', () => ({
  metaReadOne: vi.fn(async (_t: unknown, input: { operation: string; path: string; query?: Record<string, unknown> }) => {
    h.reads.push({ operation: input.operation, path: input.path, query: input.query ?? {} })
    if (h.refuseCan && String(input.query?.fields ?? '').includes('can_hide')) {
      const { MetaReadError } = await import('./errors.js')
      throw new MetaReadError({ origin: 'meta', code: '100', sentence: 'Meta refused it (100): Tried accessing nonexisting field (can_hide).', authLost: false, throttled: false, notFound: false, transient: false, permissionDenied: false } as never, input.operation, 1)
    }
    return { body: h.bodies[input.path] ?? { id: input.path }, calls: 1 }
  }),
}))
vi.mock('./live-objects.js', async (importActual) => ({
  fieldRefused: (await importActual<typeof import('./live-objects.js')>()).fieldRefused,
  listPaged: vi.fn(async (_c: string, operation: string, path: string, query: Record<string, unknown>) => {
    h.reads.push({ operation, path, query })
    const list = h.lists[path]
    if (list instanceof Error) throw list
    return { ...(list ?? { rows: [], more: false }), totalCount: null }
  }),
}))

import { liveFacebookComment, liveInstagramComment, livePageBlocked, liveThreadsReply } from './live-comments.js'
import { MetaLiveRefusal } from './live.js'

const COMMENT = '500000000000001_900000000000001'
beforeEach(() => { h.reads = []; h.bodies = {}; h.lists = {}; h.refuseCan = false })

describe('the live state of a comment change', () => {
  it('a person\'s Facebook comment: never its words; its author only in memory', async () => {
    h.bodies[COMMENT] = { id: COMMENT, is_hidden: false, can_hide: true, can_remove: true, can_comment: true, from: { id: '300000000000001' }, message: 'a person\'s words' }
    const s = await liveFacebookComment('m-1', { postId: '120000000000010_500000000000001', commentId: COMMENT })
    expect(h.reads[0].query).toEqual({ fields: 'id,is_hidden,can_hide,can_remove,can_comment,from{id}' })
    expect(s).toMatchObject({ commentId: COMMENT, hidden: false, byThePage: false, pageText: null, authorId: '300000000000001' })
    expect(JSON.stringify(s)).not.toContain('a person')
  })
  it('review fix B4 — Meta refusing the viewer\'s can_* fields: the comment is read without them (they only warn)', async () => {
    h.refuseCan = true
    h.bodies[COMMENT] = { id: COMMENT, is_hidden: true, from: { id: '300000000000001' } }
    expect(await liveFacebookComment('m-1', { commentId: COMMENT })).toMatchObject({ hidden: true, canHide: null, canRemove: null, canReply: null })
    expect(h.reads.map((r) => r.query.fields)).toEqual(['id,is_hidden,can_hide,can_remove,can_comment,from{id}', 'id,is_hidden,from{id}'])
  })
  it('an edit asks the words, and keeps them only when the Page wrote them', async () => {
    h.bodies[COMMENT] = { id: COMMENT, from: { id: '120000000000010' }, message: 'Le parole della Pagina' }
    expect(await liveFacebookComment('m-1', { commentId: COMMENT, pageText: true })).toMatchObject({ byThePage: true, pageText: 'Le parole della Pagina' })
    expect(h.reads[0].query).toEqual({ fields: 'id,is_hidden,can_hide,can_remove,can_comment,from{id},message' })
    h.bodies[COMMENT] = { id: COMMENT, from: { id: '300000000000001' }, message: 'a person\'s words' }
    expect((await liveFacebookComment('m-1', { commentId: COMMENT, pageText: true })).pageText).toBeNull()
    h.bodies[COMMENT] = { id: '500000000000001_999' }
    await expect(liveFacebookComment('m-1', { commentId: COMMENT })).rejects.toBeInstanceOf(MetaLiveRefusal)
  })
  it('an Instagram comment: hidden, a reply or not, the account\'s own by its `user` (never the commenter\'s IGSID) — no words, no username', async () => {
    h.bodies['190000000000001'] = { id: '190000000000001', hidden: true, parent_id: '190000000000000', user: { id: '170000000000010' }, media: { id: '180000000000001', media_product_type: 'FEED' } }
    expect(await liveInstagramComment('m-1', '190000000000001')).toEqual({ instagramId: '170000000000010', mediaId: '180000000000001', commentId: '190000000000001', hidden: true, isReply: true, byTheAccount: true, productType: 'FEED' })
    expect(h.reads[0].query).toEqual({ fields: 'id,hidden,parent_id,user,media{id,media_product_type}' })
    // Review fix B3 — a `from.id` (IGSID) equal to the account's id proves nothing. Re-review B: Meta answers `user` only for
    // the app user's own comment ("otherwise username"): an answer without it is someone else's comment.
    h.bodies['190000000000002'] = { id: '190000000000002', hidden: false, from: { id: '170000000000010' }, username: 'person_a', media: { id: '180000000000001' } }
    expect((await liveInstagramComment('m-1', '190000000000002')).byTheAccount).toBe(false)
    // `user` came back in a form Nexus cannot read: unknown (the preview warns).
    h.bodies['190000000000004'] = { id: '190000000000004', user: {}, media: { id: '180000000000001' } }
    expect((await liveInstagramComment('m-1', '190000000000004')).byTheAccount).toBeNull()
    h.bodies['190000000000003'] = { id: '190000000000003', user: { id: '170000000000099' }, media: { id: '180000000000001' } }
    expect((await liveInstagramComment('m-1', '190000000000003')).byTheAccount).toBe(false)
  })
  it('a Threads reply must be a direct reply of the ad\'s post; its hide status read as hidden / shown', async () => {
    h.lists['210000000000001/replies'] = { rows: [{ id: '210000000000002', hide_status: 'HUSHED' }], more: false }
    expect(await liveThreadsReply('m-1', { adId: '120000000000003', replyId: '210000000000002' })).toEqual({ adId: '120000000000003', threadsMediaId: '210000000000001', replyId: '210000000000002', hidden: true })
    expect(h.reads[0].query).toEqual({ fields: 'id,hide_status' })
    await expect(liveThreadsReply('m-1', { adId: '120000000000003', replyId: '210000000000009' })).rejects.toThrow(/not a direct reply/)
  })
  it('the blocked list: listed → blocked; not listed → not blocked; Meta refusing it → unknown with its words', async () => {
    h.lists['120000000000010/blocked'] = { rows: [{ id: '300000000000001' }], more: false }
    expect(await livePageBlocked('m-1', '300000000000001')).toEqual({ pageId: '120000000000010', blocked: true })
    expect(await livePageBlocked('m-1', '300000000000002')).toEqual({ pageId: '120000000000010', blocked: false })
    h.lists['120000000000010/blocked'] = new MetaLiveRefusal('Meta answers this read only to the Page\'s own access token.')
    expect(await livePageBlocked('m-1', '300000000000001')).toEqual({ pageId: '120000000000010', blocked: null, note: expect.stringMatching(/Page's own access token/) })
  })
})
