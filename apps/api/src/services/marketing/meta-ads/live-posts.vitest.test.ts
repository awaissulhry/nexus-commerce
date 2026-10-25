/**
 * Meta step 24 — the live state the post tools read: a post of the chosen Page only (step 10's own check), its exact field
 * list, its sponsors when asked, whether Nexus made it; a container's status (none when Meta answers it no status to the
 * system user, an error when Meta did not answer); the creatives that show a post or a media; a collaborator checked by
 * step 16's Business Discovery read (an unknown or personal account is not another business's). Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const PAGE = '120000000000010'
const POST = `${PAGE}_500000000000001`
const h = vi.hoisted(() => ({
  reads: [] as Array<{ operation: string; path: string; query: Record<string, unknown> }>,
  bodies: {} as Record<string, Record<string, unknown> | Error>,
  lists: {} as Record<string, { rows: Array<Record<string, unknown>>; more: boolean } | Error>,
  made: new Set<string>(),
  postVideos: {} as Record<string, string>,
  discovered: null as { found: Record<string, unknown> | null; id: string | null; taken: boolean } | Error | null,
}))
vi.mock('./live.js', async (importActual) => ({
  ...(await importActual<typeof import('./live.js')>()),
  metaChosenAccount: vi.fn(async () => ({ connectionId: 'm-1', adAccountId: '1234567890', pageId: '120000000000010', instagramId: '170000000000010', businessId: null, name: null, currency: 'EUR', timeZone: null, connection: {} })),
}))
vi.mock('./read-client.js', () => ({
  metaReadOne: vi.fn(async (_t: unknown, input: { operation: string; path: string; query?: Record<string, unknown> }) => {
    h.reads.push({ operation: input.operation, path: input.path, query: input.query ?? {} })
    const body = h.bodies[input.path]
    if (body instanceof Error) throw body
    return { body: body ?? { id: input.path }, calls: 1 }
  }),
  metaReadAll: vi.fn(),
}))
vi.mock('./paging.js', async (importActual) => ({
  ...(await importActual<typeof import('./paging.js')>()),
  listPaged: vi.fn(async (_c: string, operation: string, path: string, query: Record<string, unknown>) => {
    h.reads.push({ operation, path, query })
    const list = h.lists[path]
    if (list instanceof Error) throw list
    return { ...(list ?? { rows: [], more: false }), totalCount: null }
  }),
}))
vi.mock('../../gateway/account.js', () => ({
  metaPostNexusMade: vi.fn(async (kind: string, id: string, owner: string) => h.made.has(`${kind}:${id}:${owner}`)),
  metaPagePostVideoOf: vi.fn(async (postId: string) => h.postVideos[postId] ?? null),
}))
vi.mock('./live-partners.js', () => ({
  discover: vi.fn(async () => {
    if (h.discovered instanceof Error) throw h.discovered
    if (!h.discovered) {
      const { MetaLiveRefusal } = await import('./live.js')
      throw new MetaLiveRefusal('Meta found no Instagram professional account with that username (personal and age-gated accounts are not returned).')
    }
    return h.discovered
  }),
}))

import { igUsernameTaken, liveCreativesUsing, liveIgContainer, livePagePost, liveVideoPost, PAGE_POST_STATE_FIELDS } from './live-posts.js'
import { MetaLiveRefusal } from './live.js'
import { MetaReadError } from './errors.js'

const metaError = (code: string, extra: Record<string, unknown> = {}) => new MetaReadError({ origin: 'meta', httpStatus: 400, code, sentence: `Meta refused it (${code}).`, authLost: false, throttled: false, notFound: false, transient: false, permissionDenied: false, ...extra } as never, 'x', 1)
beforeEach(() => { h.reads = []; h.bodies = {}; h.lists = {}; h.made.clear(); h.postVideos = {}; h.discovered = null })

describe('the live state of a post change', () => {
  it('a post of the chosen Page: its exact fields, who wrote it, its sponsors when asked, whether Nexus made it', async () => {
    h.bodies[POST] = { id: POST, message: 'Ciao', is_hidden: false, is_published: false, scheduled_publish_time: 1893456000, timeline_visibility: 'normal', permalink_url: 'https://www.facebook.com/x', from: { id: PAGE } }
    h.lists[`${POST}/sponsor_tags`] = { rows: [{ id: '130000000000001' }], more: false }
    h.made.add(`pagepost:${POST}:${PAGE}`)
    const s = await livePagePost('m-1', POST, { sponsors: true })
    expect(h.reads[0]).toMatchObject({ path: POST, query: { fields: PAGE_POST_STATE_FIELDS } })
    expect(s).toEqual({ pageId: PAGE, postId: POST, message: 'Ciao', hidden: false, published: false, scheduledAt: 1893456000, timelineVisibility: 'normal', permalink: 'https://www.facebook.com/x', byThePage: true, sponsorPageIds: ['130000000000001'], nexusMade: true, videoId: null })
    // Not asked: no sponsor read. A visitor's post: byThePage false. Meta's ISO time: Unix seconds.
    h.reads = []
    h.made.clear()
    h.bodies[POST] = { id: POST, scheduled_publish_time: '2030-01-01T00:00:00+0000', from: { id: '300000000000001' } }
    const visitor = await livePagePost('m-1', POST)
    expect(h.reads).toHaveLength(1)
    expect(visitor).toMatchObject({ byThePage: false, sponsorPageIds: null, scheduledAt: 1893456000, nexusMade: false })
  })
  it('another Page\'s post is refused before any read; one Meta answers as another post is refused after it', async () => {
    await expect(livePagePost('m-1', '120000000000099_500000000000001')).rejects.toBeInstanceOf(MetaLiveRefusal)
    expect(h.reads).toHaveLength(0)
    h.bodies[POST] = { id: '120000000000099_500000000000001' }
    await expect(livePagePost('m-1', POST)).rejects.toThrow(/not on the Facebook Page this business chose/)
  })
  it('a container\'s status; none when Meta answers no status to the system user; an error when Meta did not answer', async () => {
    h.bodies['180000000000001'] = { id: '180000000000001', status_code: 'IN_PROGRESS', status: null }
    expect(await liveIgContainer('m-1', '180000000000001')).toEqual({ containerId: '180000000000001', statusCode: 'IN_PROGRESS', status: null })
    expect(h.reads[0].query).toEqual({ fields: 'id,status_code,status' })
    h.bodies['180000000000002'] = metaError('10', { permissionDenied: true })
    expect(await liveIgContainer('m-1', '180000000000002')).toBeNull()
    h.bodies['180000000000003'] = metaError('190', { authLost: true, sentence: 'This method must be called with a User access token.' })
    expect(await liveIgContainer('m-1', '180000000000003')).toBeNull()
    h.bodies['180000000000004'] = metaError('4', { throttled: true })
    await expect(liveIgContainer('m-1', '180000000000004')).rejects.toBeInstanceOf(MetaReadError)
    h.bodies['180000000000005'] = metaError('190', { authLost: true, sentence: 'Meta no longer accepts the token.' })
    await expect(liveIgContainer('m-1', '180000000000005')).rejects.toBeInstanceOf(MetaReadError)
  })
  it('the creatives that show a post or a media, from the chosen ad account\'s first 500', async () => {
    h.lists['act_1234567890/adcreatives'] = { rows: [
      { id: '1', effective_object_story_id: POST }, { id: '2', object_story_id: `${PAGE}_500000000000009` },
      { id: '3', effective_instagram_media_id: '180000000000501' }, { id: '4', source_instagram_media_id: '180000000000501' },
    ], more: true }
    expect(await liveCreativesUsing({ connectionId: 'm-1', adAccountId: '1234567890' }, { postId: POST })).toEqual({ creativeIds: ['1'], complete: false })
    expect(await liveCreativesUsing({ connectionId: 'm-1', adAccountId: '1234567890' }, { mediaId: '180000000000501' })).toEqual({ creativeIds: ['3', '4'], complete: false })
    expect(h.reads[0]).toMatchObject({ path: 'act_1234567890/adcreatives', query: { fields: 'id,object_story_id,effective_object_story_id,effective_instagram_media_id,source_instagram_media_id,video_id' } })
    // Review B-F2 — a creative that shows a video post's video itself.
    h.lists['act_1234567890/adcreatives'] = { rows: [{ id: '5', video_id: '160000000000001' }], more: false }
    expect(await liveCreativesUsing({ connectionId: 'm-1', adAccountId: '1234567890' }, { postId: POST, videoId: '160000000000001' })).toEqual({ creativeIds: ['5'], complete: true })
  })
  it('review A-1 — an account: taken, or not; ONLY Meta\'s "user not found" (110/2207013) is "none" — every other answer fails closed', async () => {
    h.discovered = { found: null, id: '170000000000201', taken: true }
    expect(await igUsernameTaken('m-1', 'shop_b')).toBe(true)
    h.discovered = { found: { id: '170000000000202' }, id: '170000000000202', taken: false }
    expect(await igUsernameTaken('m-1', 'rider.one')).toBe(false)
    h.discovered = metaError('110/2207013', { sentence: 'The user with username: someone cannot be found.' })
    expect(await igUsernameTaken('m-1', 'someone')).toBe(false)
    // 100/33 — the system user cannot load the chosen account it asks on ("does not exist, cannot be loaded due to missing
    // permissions"), filed as not found: NOT "none" (it would invite another business's account unchecked).
    h.discovered = metaError('100/33', { notFound: true, sentence: 'Object with ID 170000000000010 does not exist, cannot be loaded due to missing permissions.' })
    await expect(igUsernameTaken('m-1', 'shop_c')).rejects.toBeInstanceOf(MetaReadError)
    h.discovered = metaError('110', { notFound: true, sentence: 'Invalid user id.' })
    await expect(igUsernameTaken('m-1', 'shop_c')).rejects.toBeInstanceOf(MetaReadError)
    // An empty answer and a refusal of the read: thrown too.
    h.discovered = null
    await expect(igUsernameTaken('m-1', 'someone')).rejects.toBeInstanceOf(MetaLiveRefusal)
    h.discovered = new MetaLiveRefusal('Meta does not let this system user read it. Meta documents this Instagram read with a Facebook User token.')
    await expect(igUsernameTaken('m-1', 'shop_c')).rejects.toBeInstanceOf(MetaLiveRefusal)
  })
  it('review B-F2 — a video post Nexus made whose record names only its video: found from the video\'s post_id', async () => {
    h.bodies['160000000000001'] = { id: '160000000000001', post_id: '500000000000001', from: { id: PAGE } }
    expect(await liveVideoPost('m-1', '160000000000001')).toEqual({ pageId: PAGE, videoId: '160000000000001', postId: POST })
    expect(h.reads[0].query).toEqual({ fields: 'id,post_id,from{id}' })
    h.bodies['160000000000002'] = { id: '160000000000002', from: { id: PAGE } }
    expect((await liveVideoPost('m-1', '160000000000002')).postId).toBeNull()
    h.bodies['160000000000003'] = { id: '160000000000003', post_id: '500000000000003', from: { id: '120000000000099' } }
    await expect(liveVideoPost('m-1', '160000000000003')).rejects.toThrow(/not one the Facebook Page this business chose posted/)
    // N4 — the post reads as Nexus's own through the video the caller names and a record names: ONE read of that video.
    h.made.add(`pagevideo:160000000000001:${PAGE}`)
    h.bodies[POST] = { id: POST, from: { id: PAGE } }
    h.reads = []
    expect(await livePagePost('m-1', POST, { videoId: '160000000000001' })).toMatchObject({ nexusMade: true, videoId: '160000000000001' })
    expect(h.reads.map((r) => r.path)).toEqual([POST, '160000000000001'])
    // No video named: no video is read, and the post is not Nexus's by record; a video no record names is not read either.
    h.reads = []
    expect(await livePagePost('m-1', POST)).toMatchObject({ nexusMade: false, videoId: null })
    expect(await livePagePost('m-1', POST, { videoId: '160000000000002' })).toMatchObject({ nexusMade: false, videoId: null })
    expect(h.reads.map((r) => r.path)).toEqual([POST, POST])
    // A read of the named video that Meta does not answer is said, never "not made".
    h.bodies['160000000000001'] = metaError('2', { transient: true })
    await expect(livePagePost('m-1', POST, { videoId: '160000000000001' })).rejects.toBeInstanceOf(MetaReadError)
  })
  it('re-review N1 — a video post whose record names the post: its video comes from the record, no video read', async () => {
    h.made.add(`pagepost:${POST}:${PAGE}`)
    h.postVideos[POST] = '160000000000001'
    h.bodies[POST] = { id: POST, from: { id: PAGE } }
    expect(await livePagePost('m-1', POST)).toMatchObject({ nexusMade: true, videoId: '160000000000001' })
    expect(h.reads.map((r) => r.path)).toEqual([POST])
  })
})
