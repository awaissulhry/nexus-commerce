import { describe, expect, it } from 'vitest'
import { identityHeld, isAsinPending, sellingRisk } from './listing-risk.js'

describe('identityHeld — unchanged isLiveOnChannel predicate', () => {
  it.each(['DRAFT', 'ENDED', 'ACTIVE', null])('retains an external identity regardless of %s status or isPublished', listingStatus => {
    const row = { externalListingId: ' 256789012345 ', listingStatus, isPublished: false }
    expect(identityHeld(row)).toBe(true)
  })
  it.each([undefined, null, '', '   '])('does not invent identity for %j', externalListingId => {
    expect(identityHeld({ externalListingId })).toBe(false)
  })
  it('holds a published Amazon listing whose ASIN is pending', () => {
    expect(identityHeld({ channel: 'AMAZON', isPublished: true, listingStatus: 'ACTIVE', externalListingId: null })).toBe(true)
    expect(sellingRisk({ channel: 'AMAZON', isPublished: true, listingStatus: 'BUYABLE', externalListingId: null })).toBe(true)
  })
  it('keeps eBay and unpublished rows on the id rule alone', () => {
    expect(identityHeld({ channel: 'EBAY', isPublished: true, listingStatus: 'ACTIVE', externalListingId: null })).toBe(false)
    expect(identityHeld({ channel: 'AMAZON', isPublished: false, listingStatus: 'ACTIVE', externalListingId: null })).toBe(false)
  })
})

describe('isAsinPending', () => {
  it.each(['ACTIVE', 'BUYABLE', 'DISCOVERABLE', ' buyable '])('a published Amazon row in %j with no ASIN is pending', listingStatus => {
    expect(isAsinPending({ channel: 'AMAZON', isPublished: true, listingStatus, externalListingId: null })).toBe(true)
    expect(isAsinPending({ channel: 'amazon', isPublished: true, listingStatus, externalListingId: '  ' })).toBe(true)
  })
  it.each([
    ['an ASIN is recorded', { channel: 'AMAZON', isPublished: true, listingStatus: 'ACTIVE', externalListingId: 'B0TEST0001' }],
    ['it is not published', { channel: 'AMAZON', isPublished: false, listingStatus: 'ACTIVE', externalListingId: null }],
    ['publication is not reported', { channel: 'AMAZON', listingStatus: 'ACTIVE', externalListingId: null }],
    ['it is still a DRAFT', { channel: 'AMAZON', isPublished: true, listingStatus: 'DRAFT', externalListingId: null }],
    ['it ended', { channel: 'AMAZON', isPublished: true, listingStatus: 'ENDED', externalListingId: null }],
    ['it is eBay', { channel: 'EBAY', isPublished: true, listingStatus: 'ACTIVE', externalListingId: null }],
    ['the channel is not reported', { isPublished: true, listingStatus: 'ACTIVE', externalListingId: null }],
  ])('not pending when %s', (_why, row) => {
    expect(isAsinPending(row)).toBe(false)
  })
  it('refuses a missing row', () => {
    expect(isAsinPending(null)).toBe(false)
    expect(isAsinPending(undefined)).toBe(false)
  })
})
describe('sellingRisk', () => {
  it.each(['ENDED', 'DISCONTINUED', 'RELEASED'])('terminal %s suppresses inferred selling but cannot overrule SELLING fact', presenceIntent => {
    expect(sellingRisk({ externalListingId: 'id', presenceIntent })).toBe(false)
    expect(sellingRisk({ externalListingId: 'id', presenceIntent, channelFact: 'NOT_SELLING' })).toBe(false)
    expect(sellingRisk({ externalListingId: 'id', presenceIntent, channelFact: 'SELLING' })).toBe(true)
    expect(identityHeld({ externalListingId: 'id' })).toBe(true)
  })
  it.each([null, undefined, 'DRAFT', 'LIVE', 'HELD', 'WITHDRAWN'])('retains risk with optional/nonterminal intent %j', presenceIntent => {
    expect(sellingRisk({ externalListingId: 'id', presenceIntent })).toBe(true)
    expect(sellingRisk({ externalListingId: null, presenceIntent })).toBe(false)
  })
  it('SELLING fact remains a risk even when the local identity is missing', () => {
    expect(sellingRisk({ externalListingId: null, presenceIntent: 'RELEASED', channelFact: 'SELLING' })).toBe(true)
    expect(sellingRisk({ channelFact: 'UNKNOWN' })).toBe(false)
  })
})
