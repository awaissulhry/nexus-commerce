/**
 * Reviews PR I — the Etsy and Shopify pages' pure rules: tiles (reply windows from the buyer's last edit: not replied
 * yet, closing in ≤ 10 days, closed), the media Nexus stored, and whether Etsy is read, in words (never a setting name).
 */
import { describe, expect, it } from 'vitest'
import { appMediaOf, etsyPhotoOf, etsySource, etsyTiles, etsyWindow, shopifyTiles, type TileFacts } from './review-shop-channel-math.js'

const NOW = new Date('2026-10-27T12:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000)
const fact = (over: Partial<TileFacts> = {}): TileFacts => ({ rating: 5, postedAt: daysAgo(5), editedAt: null, status: null, sentReplies: 0, hasPhoto: false, ...over })

describe('Etsy tiles', () => {
  it('windows from the last edit: open, closing (≤ 10 days left), closed; answered and closed-by-a-person rows do not count', () => {
    const tiles = etsyTiles([
      fact({ postedAt: daysAgo(2), hasPhoto: true }), // day 3 of 100 — not replied yet
      fact({ postedAt: daysAgo(200), editedAt: daysAgo(95) }), // edited 95 days ago — 5 days left: closing
      fact({ postedAt: daysAgo(120) }), // never edited, 120 days — closed
      fact({ postedAt: daysAgo(3), status: 'RESPONDED' }), // marked as responded
      fact({ postedAt: daysAgo(4), sentReplies: 1 }), // a reply recorded
      fact({ postedAt: daysAgo(4), status: 'IGNORED' }), // a person said no reply is needed
      fact({ postedAt: daysAgo(40), rating: 3 }), // previous 30 days
    ], NOW)
    expect(tiles).toMatchObject({ reviews: 7, notReplied: 3, closing: 1, closed: 1, withPhoto: 1, newReviews: 4, newDelta: 3 })
    expect(tiles.average).toBeCloseTo(4.7, 1)
  })
  it('the window itself: day and days left', () => {
    expect(etsyWindow({ postedAt: daysAgo(150), editedAt: daysAgo(1) }, NOW)).toMatchObject({ day: 2, daysLeft: 99, closed: false })
    expect(etsyWindow({ postedAt: daysAgo(96), editedAt: null }, NOW)).toMatchObject({ day: 97, daysLeft: 4, closed: false })
  })
  it('no reviews: no average, nothing waits', () => {
    expect(etsyTiles([], NOW)).toMatchObject({ average: null, reviews: 0, newDelta: null, notReplied: 0 })
  })
})

describe('Shopify tiles', () => {
  it('photo or video, videos, needs a reply and how long the oldest waits', () => {
    const tiles = shopifyTiles([
      fact({ postedAt: new Date(NOW.getTime() - 6 * 60 * 60 * 1000), hasPhoto: true }),
      fact({ postedAt: daysAgo(1), hasVideo: true }),
      fact({ postedAt: daysAgo(2), status: 'RESPONDED', hasPhoto: true, hasVideo: true }),
    ], NOW)
    expect(tiles).toMatchObject({ reviews: 3, withMedia: 3, videos: 2, needReply: 2, oldestWaitHours: 24 })
  })
})

describe('media from what Nexus stored', () => {
  it('Etsy’s one photo, https only', () => {
    expect(etsyPhotoOf({ image_url_fullxfull: 'https://i.etsystatic.com/x.jpg' })).toBe('https://i.etsystatic.com/x.jpg')
    expect(etsyPhotoOf({ image_url_fullxfull: 'javascript:alert(1)' })).toBeNull()
    expect(etsyPhotoOf(null)).toBeNull()
  })
  it('Judge.me photos and the video mark', () => {
    expect(appMediaOf({ photos: [{ url: 'https://img.judge.me/o.jpg', thumb: 'https://img.judge.me/c.jpg' }, { url: 'data:x' }], hasVideo: true }))
      .toEqual({ photos: [{ url: 'https://img.judge.me/o.jpg', thumb: 'https://img.judge.me/c.jpg' }], hasVideo: true })
    expect(appMediaOf(undefined)).toEqual({ photos: [], hasVideo: false })
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
