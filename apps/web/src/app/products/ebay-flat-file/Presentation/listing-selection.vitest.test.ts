import { describe, expect, it } from 'vitest'
import { presentationListing } from './listing-selection'

const rows = [
  { id: 'family', aliasId: null, listing: { id: 'primary-id', externalListingId: '100' } },
  { id: 'family', aliasId: 'alternate', listing: { id: 'alternate-id', externalListingId: '200' } },
  { id: 'child', aliasId: 'alternate', listing: { id: 'child-id', externalListingId: '200' } },
]
describe('Presentation listing identity in the loaded destination', () => {
  it('resolves Primary only when no explicit listing is requested', () => {
    expect(presentationListing(rows, 'family', null)).toBe(rows[0])
    expect(presentationListing(rows, 'family', 'foreign')).toBeUndefined()
    expect(presentationListing([], 'family', 'alternate')).toBeUndefined()
  })
  it('resolves alias IDs, ChannelListing IDs and ItemIDs to the same family row', () => {
    for (const id of ['alternate', 'alternate-id', '200']) expect(presentationListing(rows, 'family', id)).toBe(rows[1])
    expect(presentationListing(rows, 'family', 'child-id')).toBeUndefined()
  })
  it('refuses ambiguous ItemIDs rather than choosing the first alias', () => {
    expect(presentationListing([...rows, { ...rows[1], aliasId: 'second' }], 'family', '200')).toBeUndefined()
  })
})
