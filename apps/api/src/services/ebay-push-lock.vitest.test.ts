import { describe, expect, it } from 'vitest'
import { familyPushRefusal } from './ebay-push-lock.js'

// A still-draft: DRAFT, never published, no ItemID — paused so nothing sends it (ensureDraftListings).
const draft = (marketplace: string, extra: Record<string, unknown> = {}) => ({ marketplace, listingStatus: 'DRAFT', isPublished: false, externalListingId: null, syncPaused: true, ...extra })
const live = (marketplace: string, extra: Record<string, unknown> = {}) => ({ marketplace, listingStatus: 'ACTIVE', isPublished: true, externalListingId: '110000000001', syncPaused: false, ...extra })

describe('the eBay family push lock and Nexus drafts', () => {
  it('a still-draft on another site never blocks the push', () => {
    expect(familyPushRefusal([live('IT'), draft('DE')], 'IT')).toBeNull()
    expect(familyPushRefusal([live('IT'), draft('DE')], 'IT', true)).toBeNull()
  })

  it('a still-draft on the pushed site blocks a push that does not publish, and not a publish', () => {
    expect(familyPushRefusal([draft('DE')], 'DE')?.code).toBe('PUSH_SYNC_PAUSED')
    expect(familyPushRefusal([draft('DE')], 'DE', true)).toBeNull()
  })

  it('reads eBay UK stored as GB as the same site', () => {
    expect(familyPushRefusal([draft('GB')], 'UK')?.code).toBe('PUSH_SYNC_PAUSED')
    expect(familyPushRefusal([draft('UK')], 'GB')?.code).toBe('PUSH_SYNC_PAUSED')
    expect(familyPushRefusal([draft('GB')], 'IT')).toBeNull()
  })

  it('an operator pause on any live listing still blocks, on every site', () => {
    expect(familyPushRefusal([live('IT'), live('DE', { syncPaused: true })], 'IT', true)?.code).toBe('PUSH_SYNC_PAUSED')
  })

  it('a paused DRAFT row that is not a still-draft (published, or with an ItemID) still blocks', () => {
    expect(familyPushRefusal([live('IT'), draft('DE', { isPublished: true })], 'IT', true)?.code).toBe('PUSH_SYNC_PAUSED')
    expect(familyPushRefusal([live('IT'), draft('DE', { externalListingId: '110000000002' })], 'IT', true)?.code).toBe('PUSH_SYNC_PAUSED')
  })

  it('every other lock on a still-draft still holds', () => {
    expect(familyPushRefusal([draft('DE', { offerClosedAt: new Date() })], 'IT')?.code).toBe('PUSH_OFFER_CLOSED')
    expect(familyPushRefusal([draft('DE', { presenceIntent: 'HELD' })], 'DE', true)?.code).toBe('PUSH_INTENT_HELD')
  })
})
