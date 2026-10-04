import { describe, expect, it } from 'vitest'
import { assertPublishAllowed, assertPushAllowed, isOldClosePause, isStillDraftListing, sellingPaused, SELLING_PAUSED_SENTENCE, STILL_DRAFT_LISTING } from './push-lock.js'

const draft = { listingStatus: 'DRAFT', isPublished: false, externalListingId: null }
const live = { listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'LIVE-ID' }

describe('isStillDraftListing — the one still-draft rule', () => {
  it('is DRAFT, never published and without a channel id — the database filter says the same', () => {
    expect(isStillDraftListing(draft)).toBe(true)
    expect(isStillDraftListing({ ...draft, externalListingId: undefined })).toBe(true)
    expect(STILL_DRAFT_LISTING).toEqual(draft)
  })
  it.each([
    ['a live listing', live],
    ['a DRAFT row a creator left published', { ...draft, isPublished: true }],
    ['a DRAFT row with a channel id', { ...draft, externalListingId: 'CHANNEL-ID' }],
    ['an INACTIVE unpublished row', { ...draft, listingStatus: 'INACTIVE' }],
    ['a row whose published flag was not read', { listingStatus: 'DRAFT', externalListingId: null }],
    ['no row', null],
  ])('is not %s', (_, listing) => {
    expect(isStillDraftListing(listing as never)).toBe(false)
  })
})

describe('assertPublishAllowed — the lock Publish uses', () => {
  const PAUSED = 'Listing sync is paused. Resume sync before sending changes.'
  it('lets Publish send a paused still-draft — its pause is the draft being inert, not a hold', () => {
    expect(assertPublishAllowed({ ...draft, syncPaused: true })).toBeNull()
    // Dispatch keeps refusing the same row.
    expect(assertPushAllowed({ ...draft, syncPaused: true })?.code).toBe('PUSH_SYNC_PAUSED')
  })
  it.each([
    ['an operator-paused live listing', live],
    ['a paused DRAFT row a creator left published', { ...draft, isPublished: true }],
    ['a paused row whose draft facts were not read', {}],
  ])('refuses %s exactly as assertPushAllowed does', (_, listing) => {
    expect(assertPublishAllowed({ ...listing, syncPaused: true })).toEqual({ code: 'PUSH_SYNC_PAUSED', sentence: PAUSED })
  })
  it.each([
    [{ offerClosedAt: new Date() }, 'PUSH_OFFER_CLOSED'],
    [{ presenceIntent: 'HELD' }, 'PUSH_INTENT_HELD'],
    [{ presenceIntent: 'ENDED' }, 'PUSH_INTENT_ENDED'],
  ])('still refuses a paused still-draft for every other lock (%j)', (lock, code) => {
    expect(assertPublishAllowed({ ...draft, syncPaused: true, ...lock })?.code).toBe(code)
  })
  it('answers like assertPushAllowed for an unpaused or missing listing', () => {
    expect(assertPublishAllowed({ ...live, syncPaused: false })).toBeNull()
    expect(assertPublishAllowed(null)).toBeNull()
  })
})

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

describe('a listing whose selling is paused (Inactive) gets no quantity', () => {
  const sheetPause = { offerClosedAt: new Date('2026-10-04T10:00:00Z'), offerCloseReason: 'sheet-pause' }
  it('is any row with offerClosedAt: the sheet\'s Pause offer (eBay, Shopify, Etsy) and Amazon\'s market close alike', () => {
    expect(sellingPaused(sheetPause)).toBe(true)
    expect(sellingPaused({ offerClosedAt: '2026-10-04T10:00:00Z' })).toBe(true)
    expect(sellingPaused({ offerClosedAt: null })).toBe(false)
    expect(sellingPaused(null)).toBe(false)
  })
  it('is refused by the push lock in plain words that point to the Status column', () => {
    expect(assertPushAllowed(sheetPause)).toEqual({ code: 'PUSH_OFFER_CLOSED', sentence: expect.stringContaining('Status column') })
    expect(assertPushAllowed(sheetPause)?.sentence).not.toMatch(/Restore the offer|Sync Control/)
    expect(SELLING_PAUSED_SENTENCE).toMatch(/^Inactive here .*Status column\.$/)
  })
})

describe('isOldClosePause — an eBay listing the OLD close-listing paused (pin at 0 + endedAt, no hold)', () => {
  const old = { channel: 'EBAY', listingStatus: 'ACTIVE', offerClosedAt: null, followMasterQuantity: false, quantityOverride: 0, quantity: 0, endedAt: new Date(), endedReason: 'too many returns' }
  it('recognises the shape the old close wrote, with or without a reason', () => {
    expect(isOldClosePause(old)).toBe(true)
    expect(isOldClosePause({ ...old, endedReason: null })).toBe(true)
    expect(isOldClosePause({ ...old, quantityOverride: null })).toBe(true)
  })
  it.each([
    ['another channel', { channel: 'AMAZON' }],
    ['no presence mark', { endedAt: null }],
    ['a channel-file delete', { endedReason: 'channel-file-delete' }],
    ['a listing held by the sheet\'s own Pause', { offerClosedAt: new Date() }],
    ['a listing the channel ended', { listingStatus: 'ENDED' }],
    ['a pin changed later to a number', { quantityOverride: 3, quantity: 3 }],
    ['a listing that follows the stock again', { followMasterQuantity: true }],
  ])('is not %s', (_, change) => {
    expect(isOldClosePause({ ...old, ...change })).toBe(false)
  })
})
