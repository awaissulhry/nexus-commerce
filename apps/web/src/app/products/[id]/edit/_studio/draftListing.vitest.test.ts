/**
 * Product-sheet create path, step 6 — the operator's copy for a market with no listing, the still-draft rule the header
 * chip reads, and the media galleries' gate. Pure logic: the sheet and the galleries render exactly these answers.
 */
import { describe, expect, it } from 'vitest'
import * as pushLock from '@nexus/shared/push-lock'

import {
  connectAccountSentence, coordinateListingState, DRAFT_CHIP_LABEL, draftChipDetail, draftStartedMessage, isStillDraftListing,
  mediaDestinationGate, mediaDraftStartedMessage, mediaDraftStartSentence, notListedSentence,
} from './draftListing'
import { startedDraftListing } from './sheet/channel/useChannelSheet'

const draft = { listingStatus: 'DRAFT', isPublished: false, externalListingId: null }
const live = { listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'B0TEST' }

describe('the still-draft rule is the shared one, not a copy', () => {
  it('is the very function Publish and the API promotion use (`packages/shared/push-lock.ts`)', () => {
    expect(isStillDraftListing).toBe(pushLock.isStillDraftListing)
  })

  it('reads the listing a save started (as the sheet adopts it) as a still-draft, field for field', () => {
    const started = startedDraftListing('l-1', 2)
    expect(isStillDraftListing(started)).toBe(true)
    expect({ listingStatus: started.listingStatus, isPublished: started.isPublished, externalListingId: started.externalListingId })
      .toEqual(pushLock.STILL_DRAFT_LISTING)
    // Inert, as the API's one creator makes it.
    expect(started.syncPaused).toBe(true)
  })
})

describe('what the family holds on the coordinate', () => {
  it('says nothing before there are rows to judge', () => {
    expect(coordinateListingState([])).toBeNull()
  })

  it('none — no row has a listing: the first edit starts the draft', () => {
    expect(coordinateListingState([{ listing: null }, { listing: null }, {}])).toBe('none')
  })

  it('draft — every listing here is still a Nexus draft (rows without one do not change that)', () => {
    expect(coordinateListingState([{ listing: draft }, { listing: draft }, { listing: null }])).toBe('draft')
  })

  it.each([
    ['one live listing among drafts', [{ listing: draft }, { listing: live }]],
    // Step 1's correction: an accepted Amazon row is published and ACTIVE with no ASIN yet — published, not a draft.
    ['a promoted Amazon row with no ASIN', [{ listing: { listingStatus: 'ACTIVE', isPublished: true, externalListingId: null } }]],
    // A creator that left `isPublished` TRUE on a DRAFT row: the shared rule does not call it a still-draft.
    ['a DRAFT row marked published', [{ listing: { listingStatus: 'DRAFT', isPublished: true, externalListingId: null } }]],
    // A draft that already carries a channel id has reached the channel.
    ['a DRAFT row with a channel id', [{ listing: { listingStatus: 'DRAFT', isPublished: false, externalListingId: '1234' } }]],
    // Known only from a version-0 conflict (status not recorded yet): no draft claim is made about it.
    ['a listing whose status is not recorded', [{ listing: { listingStatus: '', isPublished: false, externalListingId: null } }]],
  ])('listed — %s', (_, rows) => {
    expect(coordinateListingState(rows)).toBe('listed')
  })
})

describe('the header and the chip', () => {
  it('names the market, what the first edit does, and that nothing is sent', () => {
    expect(notListedSentence('AMAZON', 'SE')).toBe('Not listed on Amazon · SE yet. Your first edit here starts a draft. Nothing is sent to Amazon until you publish.')
    expect(notListedSentence('EBAY', 'DE')).toBe('Not listed on eBay · DE yet. Your first edit here starts a draft. Nothing is sent to eBay until you publish.')
  })

  it('with no account says the API\'s own refusal, word for word', () => {
    // `ensureDraftListings` / `VT_COPY.connectAccount` — the refused cell and the header must agree.
    expect(connectAccountSentence('AMAZON', 'SE')).toBe('Connect an Amazon account before listing on SE.')
    expect(connectAccountSentence('EBAY', 'DE')).toBe('Connect an eBay account before listing on DE.')
    expect(connectAccountSentence('SHOPIFY', 'GLOBAL')).toBe('Connect a Shopify account before listing on GLOBAL.')
  })

  it('the chip says draft and not published, and why nothing went out', () => {
    expect(DRAFT_CHIP_LABEL).toBe('Draft · not published')
    expect(draftChipDetail('AMAZON', 'SE')).toBe('The listing on Amazon · SE is a Nexus draft. Nothing is sent to Amazon until you publish.')
  })
})

describe('the toast after the save that started the draft', () => {
  const variants = (n: number) => Array.from({ length: n }, (_, i) => ({ productId: `v${i}` }))
  const base = { rootSku: 'GALE-JACKET', familyId: 'root', channel: 'AMAZON', market: 'SE' }

  it('counts the parent and the variants the server started', () => {
    expect(draftStartedMessage({ ...base, created: [{ productId: 'root' }, ...variants(20)] }))
      .toBe('Started a draft of GALE-JACKET on Amazon · SE (parent + 20 variants). Nothing was sent to Amazon.')
    expect(draftStartedMessage({ ...base, created: [{ productId: 'root' }, ...variants(1)] }))
      .toBe('Started a draft of GALE-JACKET on Amazon · SE (parent + 1 variant). Nothing was sent to Amazon.')
  })

  it('a product with no variants is just the draft; variants alone are counted as such', () => {
    expect(draftStartedMessage({ ...base, rootSku: 'SOLO-1', familyId: 'solo', created: [{ productId: 'solo' }] }))
      .toBe('Started a draft of SOLO-1 on Amazon · SE. Nothing was sent to Amazon.')
    expect(draftStartedMessage({ ...base, created: variants(2) }))
      .toBe('Started a draft of GALE-JACKET on Amazon · SE (2 variants). Nothing was sent to Amazon.')
  })

  it('counts a product once however often it is reported', () => {
    expect(draftStartedMessage({ ...base, channel: 'EBAY', market: 'DE', created: [{ productId: 'root' }, { productId: 'v1' }, { productId: 'v1' }] }))
      .toBe('Started a draft of GALE-JACKET on eBay · DE (parent + 1 variant). Nothing was sent to eBay.')
  })
})

describe('the media galleries on a market with no listing', () => {
  it('edits the selected listing as before', () => {
    expect(mediaDestinationGate({ listingId: 'l-1', aliasKey: '', accountId: 'a' })).toBe('listing')
    expect(mediaDestinationGate({ listingId: 'l-2', aliasKey: 'alias-2', accountId: 'a' })).toBe('listing')
  })

  it('with no listing on the primary destination and an account, stays editable: the first save starts the draft', () => {
    expect(mediaDestinationGate({ listingId: null, aliasKey: null, accountId: 'a' })).toBe('starts-draft')
    expect(mediaDestinationGate({ listingId: null, aliasKey: '', accountId: 'a' })).toBe('starts-draft')
  })

  it('never starts an alias listing, and never starts a draft without an account', () => {
    expect(mediaDestinationGate({ listingId: null, aliasKey: 'alias-2', accountId: 'a' })).toBe('choose-listing')
    expect(mediaDestinationGate({ listingId: null, aliasKey: '', accountId: null })).toBe('no-account')
    expect(mediaDestinationGate({ listingId: null, aliasKey: '', accountId: '' })).toBe('no-account')
  })

  it('says what the first save does, and what it did', () => {
    expect(mediaDraftStartSentence('EBAY', 'DE')).toBe('Your first save here starts a draft on eBay · DE. Nothing is sent to eBay until you publish.')
    expect(mediaDraftStartSentence('AMAZON', 'SE')).toBe('Your first save here starts a draft on Amazon · SE. Nothing is sent to Amazon until you publish.')
    expect(mediaDraftStartedMessage('EBAY', 'DE')).toBe('Started a draft on eBay · DE and saved this gallery to it. Nothing was sent to eBay.')
  })
})
