/**
 * Reviews PR I — the Etsy and Shopify pages' pure rules: tiles (the reply tiles are the Inbox's own counts —
 * review-channel-reply-tiles.vitest.test.ts proves them against real SQL), each Etsy review's reply window from the
 * buyer's last edit, the media Nexus stored, and whether Etsy is read, in words (never a setting name).
 */
import { describe, expect, it } from 'vitest'
import { etsySource, etsyTiles, etsyWindow, shopifyTiles, storedMediaOf, type TileFacts } from './review-shop-channel-math.js'

const NOW = new Date('2026-10-27T12:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000)
const fact = (over: Partial<TileFacts> = {}): TileFacts => ({ rating: 5, postedAt: daysAgo(5), hasPhoto: false, ...over })

describe('Etsy tiles', () => {
  it('average, new and with a photo from the reviews; the three reply tiles are the Inbox’s counts, as given', () => {
    const tiles = etsyTiles([
      fact({ postedAt: daysAgo(2), hasPhoto: true }),
      fact({ postedAt: daysAgo(3) }),
      fact({ postedAt: daysAgo(4) }),
      fact({ postedAt: daysAgo(5) }),
      fact({ postedAt: daysAgo(40), rating: 3 }), // previous 30 days
    ], NOW, { notReplied: 2, closing: 1, closed: 4 })
    expect(tiles).toMatchObject({ reviews: 5, notReplied: 2, closing: 1, closed: 4, withPhoto: 1, newReviews: 4, newDelta: 3 })
    expect(tiles.average).toBeCloseTo(4.6, 1)
  })
  it('the window itself: day and days left', () => {
    expect(etsyWindow({ postedAt: daysAgo(150), editedAt: daysAgo(1) }, NOW)).toMatchObject({ day: 2, daysLeft: 99, closed: false })
    expect(etsyWindow({ postedAt: daysAgo(96), editedAt: null }, NOW)).toMatchObject({ day: 97, daysLeft: 4, closed: false })
  })
  it('no reviews: no average, nothing waits', () => {
    expect(etsyTiles([], NOW, { notReplied: 0, closing: 0, closed: 0 })).toMatchObject({ average: null, reviews: 0, newDelta: null, notReplied: 0, closed: 0 })
  })
})

describe('Shopify tiles', () => {
  it('photo or video, videos; needs a reply and how long the oldest of those waits, from the Inbox’s count', () => {
    const tiles = shopifyTiles([
      fact({ postedAt: new Date(NOW.getTime() - 6 * 60 * 60 * 1000), hasPhoto: true }),
      fact({ postedAt: daysAgo(1), hasVideo: true }),
      fact({ postedAt: daysAgo(2), hasPhoto: true, hasVideo: true }),
    ], NOW, { needReply: 1, oldestPostedAt: daysAgo(1) })
    expect(tiles).toMatchObject({ reviews: 3, withMedia: 3, videos: 2, needReply: 1, oldestWaitHours: 24 })
    expect(shopifyTiles([], NOW, { needReply: 0, oldestPostedAt: null })).toMatchObject({ needReply: 0, oldestWaitHours: null })
  })
})

describe('media from what Nexus stored', () => {
  const image = (url: string, position: number) => ({ url, type: 'image', position })
  it('Etsy’s one photo: the stored media, https images only', () => {
    expect(storedMediaOf([image('https://i.etsystatic.com/x.jpg', 0)], { image_url_fullxfull: 'https://i.etsystatic.com/x.jpg' }))
      .toEqual({ photos: [{ url: 'https://i.etsystatic.com/x.jpg', thumb: 'https://i.etsystatic.com/x.jpg' }], hasVideo: false })
    expect(storedMediaOf([image('javascript:alert(1)', 0)], null).photos).toEqual([])
    expect(storedMediaOf(null, null)).toEqual({ photos: [], hasVideo: false })
  })
  it('Judge.me photos in order with Judge.me’s thumbnails, and the video mark (no video URL, so never media)', () => {
    const raw = { photos: [{ url: 'https://img.judge.me/o.jpg', thumb: 'https://img.judge.me/c.jpg' }, { url: 'data:x' }], hasVideo: true }
    expect(storedMediaOf([image('https://img.judge.me/p.jpg', 1), image('https://img.judge.me/o.jpg', 0), { url: 'https://v.example/v.mp4', type: 'video', position: 2 }], raw))
      .toEqual({ photos: [{ url: 'https://img.judge.me/o.jpg', thumb: 'https://img.judge.me/c.jpg' }, { url: 'https://img.judge.me/p.jpg', thumb: 'https://img.judge.me/p.jpg' }], hasVideo: true })
    // Photos come only from the stored media: rawPayload alone shows none.
    expect(storedMediaOf([], raw)).toEqual({ photos: [], hasVideo: true })
  })
})

describe('is Etsy read?', () => {
  const conn = (authStatus = 'connected', isActive = true) => ({ id: 'e1', isActive, authStatus, shopName: 'Shop' })
  const base = { connections: [conn()], readOn: true, lastRun: null, lastOkAt: null, reviews: 0 }
  it('each state in words, never a setting name', () => {
    const states = [
      etsySource({ ...base, connections: [] }),
      etsySource({ ...base, connections: [conn('needs_reauth')] }),
      etsySource({ ...base, readOn: false }),
      etsySource({ ...base, lastRun: { status: 'FAILED', startedAt: daysAgo(0), errorMessage: 'HTTP 500' } }),
      etsySource(base),
      etsySource({ ...base, lastRun: { status: 'SUCCESS', startedAt: daysAgo(0), errorMessage: null }, lastOkAt: daysAgo(0), reviews: 96 }),
    ]
    expect(states.map((s) => s.state)).toEqual(['not_connected', 'needs_fix', 'off', 'failed', 'waiting', 'ok'])
    expect(states[0].reconnectHref).toBe('/settings/channels/etsy')
    expect(states[5].words).toBe('Read every 30 minutes · 96 reviews read.')
    for (const s of states) expect(`${s.words} ${s.stateWords}`).not.toMatch(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/)
  })
})
