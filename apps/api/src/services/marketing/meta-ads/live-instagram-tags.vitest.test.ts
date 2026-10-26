/**
 * Meta step 35 — what the Instagram tag tool reads live (review A-F5 M7, A-N1, A-N2, B-F6): the posts Nexus tagged in the last
 * 24 hours, counted per Instagram account from its own records (newest first); an appeal judged only by the product's own
 * row; a carousel's slides read up to Meta's 20, and nothing tagged past them. Meta and the records are stand-ins; made-up
 * ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  rows: [] as Array<{ after: unknown }>,
  findMany: vi.fn(),
  pages: new Map<string, { rows: Array<Record<string, unknown>>; more: boolean }>(),
  bodies: new Map<string, Record<string, unknown>>(),
}))
vi.mock('../../../db.js', () => ({ default: { agentChange: { findMany: h.findMany } } }))
vi.mock('./paging.js', () => ({ listPaged: vi.fn(async (_c: string, _o: string, path: string) => h.pages.get(path) ?? { rows: [], more: false }) }))
vi.mock('./read-client.js', () => ({ metaReadOne: vi.fn(async (_c: unknown, req: { path: string }) => ({ body: h.bodies.get(req.path) ?? {} })) }))
vi.mock('./live-media.js', () => ({
  instagramOf: vi.fn(() => '170000000000000'),
  ownMedia: vi.fn(async (_a: unknown, mediaId: string) => ({ mediaId, productType: 'FEED' })),
}))

import { liveIgAppealState, liveIgTagPost, taggedPostsLastDay } from './live-instagram-tags.js'
import { MetaLiveRefusal, type MetaChosenAccount } from './live.js'

const account = { connectionId: 'm-1', adAccountId: '1234567890', instagramId: '170000000000000' } as unknown as MetaChosenAccount
const IG = '170000000000000'
const ALBUM = '170000000000010'

beforeEach(() => {
  h.rows = []; h.pages = new Map(); h.bodies = new Map()
  h.findMany.mockReset()
  h.findMany.mockImplementation(async () => h.rows)
})

describe('taggedPostsLastDay — this Instagram account\'s tagged posts of the last 24 hours (its own records)', () => {
  it('counts each post once, only tag changes that added a tag, only this account; newest first', async () => {
    h.rows = [
      { after: { op: 'tag', instagramId: IG, mediaId: '170000000000001', added: ['120000000000120'] } },
      { after: { op: 'tag', instagramId: IG, mediaId: '170000000000001', added: ['120000000000121'] } },
      { after: { op: 'tag', instagramId: IG, mediaId: '170000000000002', added: ['120000000000120'] } },
      { after: { op: 'tag', instagramId: IG, mediaId: '170000000000003', added: [] } },
      { after: { op: 'tag', instagramId: '170000000000099', mediaId: '170000000000004', added: ['120000000000120'] } },
      { after: { op: 'appeal', instagramId: IG, mediaId: '170000000000005', added: ['120000000000120'] } },
      // A post published with product tags counts (create-meta-instagram-post); one without, or of another account, not.
      { after: { action: 'create', platform: 'instagram', instagramId: IG, mediaId: '170000000000006', productTagged: true } },
      { after: { action: 'create', platform: 'instagram', instagramId: IG, mediaId: '170000000000007' } },
      { after: { action: 'create', platform: 'instagram', instagramId: '170000000000099', mediaId: '170000000000008', productTagged: true } },
    ]
    expect(await taggedPostsLastDay(IG, Date.parse('2026-10-26T12:00:00Z'))).toBe(3)
    expect(h.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { toolName: { in: ['set-meta-instagram-product-tags', 'create-meta-instagram-post'] }, executedAt: { gte: new Date('2026-10-25T12:00:00Z') } },
      orderBy: { executedAt: 'desc' },
    }))
  })
})

describe('liveIgAppealState — only the product\'s own row', () => {
  it('judges the named product; another product\'s row never stands in (it refuses)', async () => {
    h.pages.set(`${IG}/product_appeal`, { rows: [{ product_id: 120000000000121, review_status: 'approved', eligible_for_appeal: false }], more: false })
    await expect(liveIgAppealState(account, '120000000000120')).rejects.toBeInstanceOf(MetaLiveRefusal)
    h.pages.set(`${IG}/product_appeal`, { rows: [{ product_id: 120000000000121, review_status: 'approved' }, { product_id: '120000000000120', review_status: 'rejected', eligible_for_appeal: true }], more: false })
    expect(await liveIgAppealState(account, '120000000000120')).toEqual({ eligible: true, reviewStatus: 'rejected' })
  })
})

describe('liveIgTagPost — a carousel\'s slides up to Meta\'s 20', () => {
  it('finds slide 20 among the children; refuses when Meta lists more than 20', async () => {
    h.bodies.set(ALBUM, { id: ALBUM, media_type: 'CAROUSEL_ALBUM', media_product_type: 'FEED' })
    const slides = Array.from({ length: 20 }, (_, i) => ({ id: `1700000000001${String(i).padStart(2, '0')}`, media_type: 'IMAGE' }))
    h.pages.set(`${ALBUM}/children`, { rows: slides, more: false })
    const post = await liveIgTagPost(account, ALBUM, slides[19].id as string)
    expect(post).toMatchObject({ mediaId: ALBUM, targetId: slides[19].id, target: 'carousel-image', otherSlidesTagged: 0 })
    h.pages.set(`${ALBUM}/children`, { rows: slides, more: true })
    await expect(liveIgTagPost(account, ALBUM, slides[0].id as string)).rejects.toThrow(/more than 20 slides/)
  })
})
