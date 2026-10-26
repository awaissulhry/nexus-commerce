import { describe, expect, it } from 'vitest'
import { REVIEW_EVENT_TYPES, parseReviewEvent, reconnectDelay } from './useReviewEvents'

describe('review events', () => {
  it('waits longer after each closed stream, up to a minute', () => {
    expect([0, 1, 2, 3].map(reconnectDelay)).toEqual([2_000, 4_000, 8_000, 16_000])
    expect(reconnectDelay(10)).toBe(60_000)
    expect(reconnectDelay(-1)).toBe(2_000)
  })

  it('passes on only the review events asked for', () => {
    expect(parseReviewEvent('review.created', '{"ts":5,"reviewId":"r1"}', REVIEW_EVENT_TYPES)).toEqual({ type: 'review.created', ts: 5, reviewId: 'r1' })
    expect(parseReviewEvent('review.spike.detected', '{"ts":5}', REVIEW_EVENT_TYPES)).toBeNull()
    expect(parseReviewEvent('review.negative', 'not json', REVIEW_EVENT_TYPES)).toBeNull()
    expect(parseReviewEvent('review.responded', 'null', ['review.responded'])).toBeNull()
    expect(parseReviewEvent('review.responded', '{}', ['review.responded'])?.ts).toEqual(expect.any(Number))
  })
})
