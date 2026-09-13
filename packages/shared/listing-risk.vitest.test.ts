import { describe, expect, it } from 'vitest'
import { identityHeld, sellingRisk } from './listing-risk.js'

describe('identityHeld — unchanged isLiveOnChannel predicate', () => {
  it.each(['DRAFT', 'ENDED', 'ACTIVE', null])('retains an external identity regardless of %s status or isPublished', listingStatus => {
    const row = { externalListingId: ' 256789012345 ', listingStatus, isPublished: false }
    expect(identityHeld(row)).toBe(true)
  })
  it.each([undefined, null, '', '   '])('does not invent identity for %j', externalListingId => {
    expect(identityHeld({ externalListingId })).toBe(false)
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
