import { describe, expect, it } from 'vitest'
import { assertPushAllowed } from './push-lock.js'

describe('assertPushAllowed', () => {
  it('refuses paused sync', () => {
    expect(assertPushAllowed({ syncPaused: true })?.code).toBe('PUSH_SYNC_PAUSED')
  })
  it.each([new Date('2026-09-13T12:00:00Z'), '2026-09-13T12:00:00Z'])('refuses a closed offer (%s)', offerClosedAt => {
    expect(assertPushAllowed({ offerClosedAt })?.code).toBe('PUSH_OFFER_CLOSED')
  })
  it.each(['HELD', 'WITHDRAWN', 'ENDED', 'DISCONTINUED', 'RELEASED'])('refuses explicit %s intent even with the legacy flags clear', presenceIntent => {
    expect(assertPushAllowed({ presenceIntent, syncPaused: false, offerClosedAt: null })).toEqual({
      code: `PUSH_INTENT_${presenceIntent}`, sentence: expect.any(String),
    })
  })
  it.each([undefined, null, 'NONE', 'DRAFT', 'LIVE'])('allows an unlocked listing with optional intent %s', presenceIntent => {
    expect(assertPushAllowed({ presenceIntent, syncPaused: false, offerClosedAt: null })).toBeNull()
  })
  it.each(['ENDED', 'ended', ' Ended '])('P1.7 — refuses a listing whose status is %s', listingStatus => {
    expect(assertPushAllowed({ listingStatus })).toEqual({ code: 'PUSH_LISTING_ENDED', sentence: expect.any(String) })
  })
  it.each(['DRAFT', 'ACTIVE', 'INACTIVE', 'ERROR', '', null, undefined])('P1.7 — allows status %s', listingStatus => {
    expect(assertPushAllowed({ listingStatus })).toBeNull()
  })
  it('P1.7 — honours endedAt the day the Presence migration adds it', () => {
    expect(assertPushAllowed({ endedAt: new Date(), listingStatus: 'ACTIVE' })?.code).toBe('PUSH_LISTING_ENDED')
  })
  it('preserves the dispatch precedence when multiple locks apply', () => {
    expect(assertPushAllowed({ syncPaused: true, offerClosedAt: new Date(), presenceIntent: 'ENDED' })?.code).toBe('PUSH_SYNC_PAUSED')
    expect(assertPushAllowed({ offerClosedAt: new Date(), presenceIntent: 'ENDED' })?.code).toBe('PUSH_OFFER_CLOSED')
    // the deliberate intent is a more precise sentence than the channel's own status
    expect(assertPushAllowed({ presenceIntent: 'ENDED', listingStatus: 'ENDED' })?.code).toBe('PUSH_INTENT_ENDED')
  })
  it('has no schema or row-existence dependency (callers own coordinate validation)', () => {
    expect(assertPushAllowed(undefined)).toBeNull()
    expect(assertPushAllowed(null)).toBeNull()
  })
})
