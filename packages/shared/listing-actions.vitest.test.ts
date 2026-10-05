import { describe, expect, it } from 'vitest'
import {
  ACTION_TARGET_STATE, actionsFor, agoText, AMAZON_FBA_DELETE_WARNING, deleteDoneSentence, deletedOn, deletedPublishSkip, deleteOffered,
  familySellingState, fbaDeleteWarning, LISTING_ACTION_PERMISSION, listingActionCapability, SELLING_STATE_LABEL, sellingStateOf,
  SHEET_PAUSE_REASON, statusChangeAction, statusOptionsFor, type ListingDeletion,
  EBAY_NEW_INACTIVE_CHECK, EBAY_NEW_INACTIVE_OOS_OFF, EBAY_NEW_INACTIVE_OOS_UNKNOWN, ETSY_NEW_ACTIVE_NEEDS_PHOTO, ETSY_NEW_DRAFT, ETSY_NEW_ROW_SENTENCE,
  ETSY_NEW_VARIATION_ACTIVE, ETSY_NEW_VARIATION_INACTIVE, ETSY_VARIATION_HIDDEN_REASON, NEW_LISTING_ALIAS, NEW_LISTING_SENTENCE,
  newListingChoice, newListingDefault, newListingOptions, NOT_LISTED_MAIN_WARNING, SHOPIFY_LINKED_REFUSED, SHOPIFY_NEW_VARIATION, STATUS_TARGET_LABEL,
  AMAZON_REMOVED_ELSEWHERE, deletedShort, isNewListingRow, newListingSentence, NOT_ON_CHANNEL_KEEPS_NUMBER, RELIST_SENTENCE,
  ETSY_PUBLISHING_OFF, ETSY_DRAFT_STATE, ETSY_DRAFT_NO_LIVE, ETSY_DRAFT_NO_PAUSE, holdStatusChanges, etsyCreateState, shopifyCreateStatus, SHOPIFY_STATUS_FROM_STATUS_COLUMN, SHOPIFY_CREATE_NOT_LISTED,
  ALREADY_UNLINKED, alreadyRemoved, deletedStatusReason, removedMark, setBeforeRemoval, sharedRemovedRefusal, UNLINKED_NOT_LISTED, unlinkWords,
} from './listing-actions.js'

/** Sheet publish parity, step 7 — the capability table, the selling state, and which changes a row offers. */
describe('capability table', () => {
  it('Amazon pauses and resumes per row (FBA too, with a warning), never ends, and deletes FBA with a warning', () => {
    expect(listingActionCapability('amazon', 'pause')).toMatchObject({ offered: true, reach: 'row', warning: null })
    expect(listingActionCapability('amazon', 'pause', { isFba: true })).toMatchObject({ offered: true, warning: expect.stringMatching(/Pan-European FBA/) })
    expect(listingActionCapability('amazon', 'resume', { isFba: true })).toMatchObject({ offered: true, warning: null })
    expect(listingActionCapability('amazon', 'end').reason).toMatch(/Amazon has no End/)
    expect(listingActionCapability('amazon', 'relist').offered).toBe(false)
    expect(listingActionCapability('amazon', 'delete')).toMatchObject({ offered: true, reach: 'row' })
    expect(listingActionCapability('amazon', 'delete')).toMatchObject({ warning: null })
    expect(listingActionCapability('amazon', 'delete', { isFba: true })).toMatchObject({ offered: true, reach: 'row', warning: AMAZON_FBA_DELETE_WARNING })
  })
  it('eBay Trading pauses per row (checked at send), ends and relists the whole listing', () => {
    expect(listingActionCapability('ebay-trading', 'pause')).toMatchObject({ offered: true, reach: 'row' })
    expect(listingActionCapability('ebay-trading', 'pause').checkedAtSend).toMatch(/out-of-stock control/)
    expect(listingActionCapability('ebay-trading', 'end')).toMatchObject({ offered: true, reach: 'listing' })
    expect(listingActionCapability('ebay-trading', 'relist')).toMatchObject({ offered: true, reach: 'listing' })
  })
  it('eBay Inventory pause needs the account preference: OFF and UNKNOWN refuse, ON or not yet read is offered', () => {
    expect(listingActionCapability('ebay-inventory', 'pause', { ebayOutOfStockPreference: 'OFF' }).offered).toBe(false)
    expect(listingActionCapability('ebay-inventory', 'pause', { ebayOutOfStockPreference: 'UNKNOWN' }).offered).toBe(false)
    expect(listingActionCapability('ebay-inventory', 'pause', { ebayOutOfStockPreference: 'ON' })).toMatchObject({ offered: true, checkedAtSend: null })
    expect(listingActionCapability('ebay-inventory', 'pause').offered).toBe(true)
  })
  it('Shopify pauses per variant (quantity 0, checked at send), ends and deletes the whole product, refuses colour products', () => {
    expect(listingActionCapability('shopify', 'pause')).toMatchObject({ offered: true, reach: 'row', checkedAtSend: expect.stringMatching(/Continue selling/) })
    expect(listingActionCapability('shopify', 'end')).toMatchObject({ offered: true, reach: 'product' })
    expect(listingActionCapability('shopify', 'delete')).toMatchObject({ offered: true, reach: 'product' })
    expect(listingActionCapability('shopify', 'pause', { shopifyLinked: true }).offered).toBe(false)
  })
  it('Etsy pauses and resumes the listing (never quantity 0), has no End, and cannot delete yet', () => {
    expect(listingActionCapability('etsy', 'pause')).toMatchObject({ offered: true, reach: 'listing' })
    expect(listingActionCapability('etsy', 'end').reason).toMatch(/Etsy has no End/)
    expect(listingActionCapability('etsy', 'delete').offered).toBe(false)
  })
  it('Etsy (D6): a variation pauses and resumes only its own row (its offering); the main row keeps the whole listing', () => {
    expect(listingActionCapability('etsy', 'pause', { isVariation: true })).toMatchObject({ offered: true, reach: 'row' })
    expect(listingActionCapability('etsy', 'resume', { isVariation: true })).toMatchObject({ offered: true, reach: 'row' })
    expect(listingActionCapability('etsy', 'resume')).toMatchObject({ offered: true, reach: 'listing' })
    expect(listingActionCapability('etsy', 'pause', { isMain: true })).toMatchObject({ offered: true, reach: 'listing' })
    expect(listingActionCapability('etsy', 'end', { isVariation: true }).offered).toBe(false)
    expect(listingActionCapability('etsy', 'delete', { isVariation: true }).offered).toBe(false)
    // Every other channel keeps its own reach for a variation.
    expect(listingActionCapability('ebay-trading', 'end', { isVariation: true })).toMatchObject({ reach: 'listing' })
  })
  it('Etsy (E3): a listing that is a draft on Etsy cannot be set live from Nexus yet and has nothing to pause — a variation too; other channels ignore the fact', () => {
    expect(ETSY_DRAFT_NO_PAUSE).toBe('A draft on Etsy is not visible to buyers, so there is nothing to pause.')
    // Review MINOR-4 — true for a draft made on etsy.com too (it may have photos): no claim about photos.
    expect(ETSY_DRAFT_NO_LIVE).toBe('Nexus cannot set an Etsy draft live yet; going live comes in a later Nexus update.')
    expect(ETSY_DRAFT_NO_LIVE).not.toMatch(/photo/i)
    expect(listingActionCapability('etsy', 'resume', { etsyDraft: true })).toMatchObject({ offered: false, reason: ETSY_DRAFT_NO_LIVE })
    expect(listingActionCapability('etsy', 'pause', { etsyDraft: true })).toMatchObject({ offered: false, reason: ETSY_DRAFT_NO_PAUSE })
    expect(listingActionCapability('etsy', 'resume', { etsyDraft: true, isVariation: true })).toMatchObject({ offered: false, reason: ETSY_DRAFT_NO_LIVE })
    expect(listingActionCapability('etsy', 'pause', { etsyDraft: true, isVariation: true })).toMatchObject({ offered: false, reason: ETSY_DRAFT_NO_PAUSE })
    expect(listingActionCapability('etsy', 'end', { etsyDraft: true }).reason).toMatch(/Etsy has no End/)
    expect(listingActionCapability('etsy', 'resume', { etsyDraft: false })).toMatchObject({ offered: true, reach: 'listing' })
    expect(listingActionCapability('ebay-trading', 'resume', { etsyDraft: true })).toEqual(listingActionCapability('ebay-trading', 'resume'))
    expect(listingActionCapability('amazon', 'pause', { etsyDraft: true })).toEqual(listingActionCapability('amazon', 'pause'))
    // The Status column of a draft: Inactive is its current value; Active is refused (Nexus cannot set a draft live yet).
    expect(statusOptionsFor('paused', 'etsy', { etsyDraft: true }).map(o => [o.target, o.offered, o.reason]))
      .toEqual([['active', false, ETSY_DRAFT_NO_LIVE], ['inactive', true, null]])
    expect(actionsFor('paused', 'etsy', { etsyDraft: true })).toEqual([])
  })
  it('WooCommerce says why not', () => {
    expect(listingActionCapability('unsupported', 'pause', {}, 'WooCommerce').reason).toBe('Changing the status of WooCommerce listings from Nexus is not available yet.')
  })
  it('ending and deleting need the delete right; the other changes are publishing', () => {
    expect(LISTING_ACTION_PERMISSION).toEqual({ pause: 'products.publish', resume: 'products.publish', relist: 'products.publish', end: 'products.delete', delete: 'products.delete' })
  })
  it('one set of words: Active, Inactive, Not listed, Ended, Mixed (a draft reads Not listed)', () => {
    expect(SELLING_STATE_LABEL).toMatchObject({ active: 'Active', paused: 'Inactive', not_listed: 'Not listed', ended: 'Ended', mixed: 'Mixed', draft: 'Not listed' })
  })
})

describe('selling state', () => {
  const base = { channel: 'AMAZON', listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'B0X', offerClosedAt: null }
  it('reads a never-published draft as Draft', () => {
    expect(sellingStateOf({ ...base, listingStatus: 'DRAFT', isPublished: false, externalListingId: null }).state).toBe('draft')
  })
  it('reads a closed Amazon offer and an eBay hold as Paused', () => {
    expect(sellingStateOf({ ...base, offerClosedAt: new Date() }).state).toBe('paused')
    expect(sellingStateOf({ ...base, channel: 'EBAY', externalListingId: '123', offerClosedAt: new Date(), offerCloseReason: SHEET_PAUSE_REASON }))
      .toMatchObject({ state: 'paused', reason: expect.stringMatching(/quantity 0/) })
  })
  it('reads ENDED as Ended only where the channel ends (eBay); Amazon never reads Ended; an old Nexus-only INACTIVE honestly as Unknown', () => {
    expect(sellingStateOf({ ...base, channel: 'EBAY', externalListingId: '123', listingStatus: 'ENDED' }).state).toBe('ended')
    expect(sellingStateOf({ ...base, listingStatus: 'ENDED' })).toEqual({ state: 'not_listed', reason: AMAZON_REMOVED_ELSEWHERE })
    expect(sellingStateOf({ ...base, channel: 'ETSY', listingStatus: 'ENDED' }).state).toBe('not_listed')
    expect(sellingStateOf({ ...base, listingStatus: 'INACTIVE' })).toMatchObject({ state: 'unknown', reason: expect.stringMatching(/never told/) })
  })
  it('Etsy (D6): an inactive listing and a listing-level hold read Inactive on Etsy; one hidden variation says the rest of the listing sells', () => {
    const etsy = { ...base, channel: 'ETSY', externalListingId: '9000000001' }
    const inactive = 'Inactive on Etsy: buyers cannot find or buy it.'
    expect(sellingStateOf({ ...etsy, listingStatus: 'INACTIVE' })).toEqual({ state: 'paused', reason: inactive })
    expect(sellingStateOf({ ...etsy, offerClosedAt: new Date(), offerCloseReason: SHEET_PAUSE_REASON })).toEqual({ state: 'paused', reason: inactive })
    expect(ETSY_VARIATION_HIDDEN_REASON).toBe('etsy-variation-hidden')
    expect(sellingStateOf({ ...etsy, offerClosedAt: new Date(), offerCloseReason: ETSY_VARIATION_HIDDEN_REASON }))
      .toEqual({ state: 'paused', reason: 'Hidden on Etsy: buyers cannot buy this variation; the rest of the listing sells.' })
    // E3 — a listing with a number that Nexus marks DRAFT is a draft on Etsy: Inactive (not Active), with the draft sentence.
    expect(ETSY_DRAFT_STATE).toBe('A draft on Etsy: buyers cannot see it. Nexus cannot set an Etsy draft live yet; going live comes in a later Nexus update.')
    expect(ETSY_DRAFT_STATE).not.toMatch(/photo/i)
    expect(sellingStateOf({ ...etsy, listingStatus: 'DRAFT', isPublished: false })).toEqual({ state: 'paused', reason: ETSY_DRAFT_STATE })
    expect(sellingStateOf({ ...etsy, listingStatus: 'draft', isPublished: true })).toEqual({ state: 'paused', reason: ETSY_DRAFT_STATE })
    // Without a listing number it is still a row in Nexus only; the main row of a created draft reads Inactive.
    expect(sellingStateOf({ ...etsy, listingStatus: 'DRAFT', isPublished: false, externalListingId: null }).state).toBe('draft')
    expect(familySellingState(['paused', 'paused'])).toEqual({ state: 'paused', reason: null })
    // A whole listing set inactive wins over a variation's own hold.
    expect(sellingStateOf({ ...etsy, listingStatus: 'INACTIVE', offerClosedAt: new Date(), offerCloseReason: ETSY_VARIATION_HIDDEN_REASON }))
      .toEqual({ state: 'paused', reason: inactive })
    // The main row of a family with one variation hidden reads Mixed.
    expect(familySellingState(['active', 'paused']).state).toBe('mixed')
  })
  it('reads Amazon\'s own words like the Matrix: BUYABLE and DISCOVERABLE are on the channel, and so is a DRAFT with a channel number', () => {
    expect(sellingStateOf({ ...base, listingStatus: 'BUYABLE' })).toEqual({ state: 'active', reason: null })
    expect(sellingStateOf({ ...base, listingStatus: 'DISCOVERABLE' })).toMatchObject({ state: 'active', reason: expect.stringMatching(/not buyable/) })
    expect(sellingStateOf({ ...base, channel: 'EBAY', listingStatus: 'DRAFT', externalListingId: '123' })).toMatchObject({ state: 'active', reason: expect.stringMatching(/channel number/) })
  })
  it('a Nexus-only offerActive mark does not claim the channel stopped', () => {
    expect(sellingStateOf({ ...base, offerActive: false })).toMatchObject({ state: 'active', reason: expect.stringMatching(/channel still sells/) })
  })
  it('reads Shopify from the product status', () => {
    const shopify = { ...base, channel: 'SHOPIFY', externalListingId: '9001' }
    expect(sellingStateOf({ ...shopify, shopifyStatus: 'DRAFT' }).state).toBe('paused')
    expect(sellingStateOf({ ...shopify, shopifyStatus: 'ARCHIVED' }).state).toBe('ended')
    expect(sellingStateOf({ ...shopify, shopifyStatus: 'ACTIVE' }).state).toBe('active')
  })
  it('a main product with variations in two states reads Partly paused', () => {
    expect(familySellingState(['active', 'paused', 'paused'])).toEqual({ state: 'mixed', reason: '2 of 3 variations are inactive.' })
    expect(familySellingState(['paused', 'paused', 'not_listed', 'draft'])).toEqual({ state: 'paused', reason: null })
    expect(familySellingState(['not_listed']).state).toBe('not_listed')
    expect(familySellingState(['draft', 'not_listed']).state).toBe('draft')
  })
})

describe('actions a row offers', () => {
  it('state AND channel decide', () => {
    expect(actionsFor('active', 'amazon')).toEqual(['pause'])
    expect(actionsFor('active', 'amazon', { isFba: true })).toEqual(['pause'])
    expect(actionsFor('active', 'etsy')).toEqual(['pause'])
    expect(actionsFor('draft', 'ebay-trading')).toEqual([])
    expect(actionsFor('paused', 'ebay-trading')).toEqual(['resume', 'end'])
    expect(actionsFor('ended', 'ebay-trading')).toEqual(['relist'])
    expect(actionsFor('ended', 'amazon')).toEqual([])
    expect(actionsFor('not_listed', 'shopify')).toEqual([])
    expect(actionsFor('unknown', 'ebay-trading')).toEqual(['pause', 'end'])
  })
})

describe('the Status column', () => {
  it('maps a target to the action that reaches it, or none when it is already there', () => {
    expect(statusChangeAction('active', 'inactive')).toBe('pause')
    expect(statusChangeAction('paused', 'active')).toBe('resume')
    expect(statusChangeAction('ended', 'active')).toBe('relist')
    expect(statusChangeAction('paused', 'ended')).toBe('end')
    expect(statusChangeAction('active', 'active')).toBeNull()
    expect(statusChangeAction('unknown', 'active')).toBeNull()
    expect(statusChangeAction('ended', 'inactive')).toBeNull()
  })
  it('offers each target with its reason; Amazon and Etsy never offer Ended; a draft offers the new-listing choices', () => {
    const amazon = statusOptionsFor('active', 'amazon')
    expect(amazon.map(o => [o.target, o.offered, o.action])).toEqual([['active', true, null], ['inactive', true, 'pause']])
    expect(statusOptionsFor('active', 'etsy').map(o => o.target)).toEqual(['active', 'inactive'])
    expect(statusOptionsFor('active', 'ebay-trading').map(o => o.target)).toEqual(['active', 'inactive', 'ended'])
    // An Amazon row removed outside the sheet (Nexus still holds its ASIN) reads Not listed and says why it cannot change.
    expect(statusOptionsFor('not_listed', 'amazon', { onChannel: true }).every(o => !o.offered && o.reason === NOT_ON_CHANNEL_KEEPS_NUMBER)).toBe(true)
    // A draft is a new listing: Active, Inactive, Not listed (New listings, Owner 2026-10-04).
    expect(statusOptionsFor('draft', 'ebay-trading').map(o => o.target)).toEqual(['active', 'inactive', 'not_listed'])
    expect(statusOptionsFor('ended', 'ebay-trading').find(o => o.target === 'active')).toMatchObject({ offered: true, action: 'relist' })
  })
  // Wave 2 D13 (decision 12) — Etsy publishing off: every change is held with the reason; the current value stays.
  it('holds every Status change with the reason, keeps the current value and what was refused already', () => {
    expect(ETSY_PUBLISHING_OFF).toBe('Sending to Etsy is not live on this server, so Publish cannot change this. Change it in Etsy.')
    expect(holdStatusChanges(statusOptionsFor('active', 'etsy'), ETSY_PUBLISHING_OFF).map(o => [o.target, o.offered, o.reason])).toEqual([
      ['active', true, null], ['inactive', false, ETSY_PUBLISHING_OFF]])
    expect(holdStatusChanges(statusOptionsFor('paused', 'etsy'), ETSY_PUBLISHING_OFF).map(o => [o.target, o.offered, o.reason])).toEqual([
      ['active', false, ETSY_PUBLISHING_OFF], ['inactive', true, null]])
    // A row not on Etsy: its choices change no Status (Publish creates the listing), so none is held.
    const fresh = statusOptionsFor('draft', 'etsy')
    expect(holdStatusChanges(fresh, ETSY_PUBLISHING_OFF)).toEqual(fresh)
  })
  it('Delete needs a listing on the channel', () => {
    expect(deleteOffered('draft', 'amazon').offered).toBe(false)
    expect(deleteOffered('active', 'amazon').offered).toBe(true)
    expect(deleteOffered('ended', 'ebay-trading')).toMatchObject({ offered: true, reach: 'listing' })
  })
})

/** Delete and relist (simplify, Owner 2026-10-04) — a deleted row is a row not on the channel: Not listed; the FBA delete warning. */
describe('delete and relist: a deleted row reads Not listed', () => {
  const now = Date.parse('2026-10-04T15:00:00Z')
  const deletion: ListingDeletion = { at: '2026-10-04T12:00:00.000Z', where: 'Amazon · IT', oldReference: 'B0OLD00001', relistChosenAt: null }
  const drafted = { channel: 'AMAZON', listingStatus: 'DRAFT', isPublished: false, externalListingId: null, offerClosedAt: null }

  it('a deleted row still in its draft shape reads Not listed with the delete\'s words; listed again it reads Active by itself', () => {
    expect(sellingStateOf({ ...drafted, deletion })).toEqual({ state: 'not_listed', deleted: deletion,
      reason: 'Deleted on Amazon · IT on 4 Oct. To list it again, set Status to Active and Publish.' })
    expect(sellingStateOf(drafted).state).toBe('draft')
    // Amazon promotes the accepted relist (ACTIVE, published) before its ASIN is read back: Active.
    expect(sellingStateOf({ ...drafted, listingStatus: 'ACTIVE', isPublished: true, deletion })).toEqual({ state: 'active', reason: null })
    expect(sellingStateOf({ ...drafted, channel: 'SHOPIFY', deletion }).state).toBe('not_listed')
    expect(ACTION_TARGET_STATE.delete).toBe('not_listed')
  })

  it('a deleted row is a row not on the channel: its Status offers the new-row choices (Active, Inactive, Not listed); no selling change, no delete', () => {
    expect(isNewListingRow('not_listed', { deleted: deletion })).toBe(true)
    const options = statusOptionsFor('not_listed', 'amazon', { deleted: deletion })
    expect(options.map(o => [o.target, o.offered])).toEqual([['active', true], ['inactive', true], ['not_listed', true]])
    expect(options.find(o => o.target === 'active')!.sentence).toBe(RELIST_SENTENCE.active)
    expect(statusOptionsFor('not_listed', 'shopify', { deleted: deletion, isVariation: true }).every(o => !o.offered && o.reason === SHOPIFY_NEW_VARIATION)).toBe(true)
    expect(actionsFor('not_listed', 'ebay-trading', { deleted: deletion })).toEqual([])
    expect(deleteOffered('not_listed', 'amazon', { deleted: deletion })).toMatchObject({ offered: false, reason: 'Already deleted on Amazon · IT. To keep it off, leave its Status Not listed.' })
    expect(listingActionCapability('ebay-trading', 'relist', { deleted: deletion }).offered).toBe(false)
  })

  it('its choice: Not listed by default, its own Active or Inactive, or its main row\'s; the sentence speaks of listing it again', () => {
    const base = { channel: 'AMAZON', own: null, main: null, isVariation: false, includedByDefault: true, deleted: true }
    expect(newListingChoice(base)).toEqual({ target: 'not_listed', source: 'default' })
    expect(newListingChoice({ ...base, own: 'active' })).toEqual({ target: 'active', source: 'own' })
    expect(newListingChoice({ ...base, isVariation: true, main: 'inactive' })).toEqual({ target: 'inactive', source: 'main' })
    expect(newListingSentence({ target: 'not_listed', source: 'default' }, { deleted: deletion, now }))
      .toBe('Deleted on Amazon · IT on 4 Oct. To list it again, set Status to Active and Publish.')
    expect(newListingSentence({ target: 'active', source: 'own' }, { deleted: deletion, now })).toBe('Publish lists it again, whole, and it sells.')
  })

  it('words: the date, the skip, the result, how long ago', () => {
    expect(deletedOn('2026-10-04T23:30:00Z', now)).toBe('4 Oct')
    expect(deletedOn('2025-12-31T10:00:00Z', now)).toBe('31 Dec 2025')
    expect(deletedShort(deletion, now)).toBe('Deleted on Amazon · IT on 4 Oct.')
    expect(deletedPublishSkip(deletion, now)).toBe('Deleted on Amazon · IT on 4 Oct. To list it again, set Status to Active.')
    expect(deleteDoneSentence('Amazon · IT')).toBe('Deleted on Amazon · IT. To list it again, set Status to Active and Publish.')
    expect([agoText(new Date(now - 30_000), now), agoText(new Date(now - 12 * 60_000), now), agoText(new Date(now - 2 * 3_600_000), now), agoText(new Date(now - 3 * 86_400_000), now)])
      .toEqual(['just now', '12 minutes ago', '2 hours ago', '3 days ago'])
  })

  it('the FBA delete warning names Amazon\'s unit count and when Nexus read it', () => {
    expect(fbaDeleteWarning({ sellable: 12, inbound: 2, reserved: 0, other: 0, readAt: '2026-10-04T13:00:00Z' }, now))
      .toBe('Amazon holds 14 FBA units for this SKU here (12 sellable, 2 on the way), read 2 hours ago. They cannot sell until you list this SKU here again, and Amazon still charges storage.')
    expect(fbaDeleteWarning({ sellable: 1, inbound: 0, reserved: 1, other: 2, readAt: null }, now))
      .toBe('Amazon holds 4 FBA units for this SKU here (1 sellable, 1 reserved, 2 not sellable). They cannot sell until you list this SKU here again, and Amazon still charges storage.')
    expect(fbaDeleteWarning(null)).toBe(AMAZON_FBA_DELETE_WARNING)
    expect(fbaDeleteWarning({ sellable: 0, inbound: 0, reserved: 0, other: 0, readAt: null })).toMatch(/^Nexus read 0 FBA units/)
  })
})

/** New listings (Owner 2026-10-04) — a row not on the channel chooses Active, Inactive or Not listed, per channel. */
describe('New listings: the Status of a row not on the channel', () => {
  const choices = (options: ReturnType<typeof newListingOptions>) => Object.fromEntries(options.map(o => [o.target, o.offered ? 'ok' : o.reason]))
  it('words: what each choice makes Publish do', () => {
    expect(NEW_LISTING_SENTENCE).toEqual({
      active: 'Publish creates it and it sells.',
      inactive: 'Publish creates it, but buyers cannot buy it yet. Set Active and Publish when you are ready.',
      not_listed: 'Publish leaves it out. It stays in Nexus only.',
    })
    expect(STATUS_TARGET_LABEL.not_listed).toBe('Not listed')
    expect(statusChangeAction('draft', 'not_listed')).toBeNull()
    expect(statusChangeAction('active', 'not_listed')).toBeNull()
  })
  it('Amazon offers all three; the main row\'s Not listed warns that its variations need it', () => {
    expect(choices(newListingOptions('amazon'))).toEqual({ active: 'ok', inactive: 'ok', not_listed: 'ok' })
    expect(newListingOptions('amazon', { isMain: true }).find(o => o.target === 'not_listed')!.warning).toBe(NOT_LISTED_MAIN_WARNING)
    expect(newListingOptions('amazon').find(o => o.target === 'inactive')!.sentence).toBe(NEW_LISTING_SENTENCE.inactive)
  })
  it('eBay Inactive only while the account\'s out-of-stock option is on', () => {
    expect(newListingOptions('ebay-trading').find(o => o.target === 'inactive')).toMatchObject({ offered: true, checkedAtSend: EBAY_NEW_INACTIVE_CHECK })
    expect(newListingOptions('ebay-trading', { ebayOutOfStockPreference: 'ON' }).find(o => o.target === 'inactive')).toMatchObject({ offered: true, checkedAtSend: null })
    expect(choices(newListingOptions('ebay-trading', { ebayOutOfStockPreference: 'OFF' }))).toEqual({ active: 'ok', inactive: EBAY_NEW_INACTIVE_OOS_OFF, not_listed: 'ok' })
    expect(EBAY_NEW_INACTIVE_OOS_OFF).toBe('This eBay account\'s out-of-stock option is off, so eBay cannot hold a new listing at 0. Turn it on in eBay, or choose Active or Not listed.')
    expect(newListingOptions('ebay-inventory', { ebayOutOfStockPreference: 'UNKNOWN' }).find(o => o.target === 'inactive')!.reason).toBe(EBAY_NEW_INACTIVE_OOS_UNKNOWN)
  })
  it('Shopify: the main row chooses the product\'s status; a variation follows it; a colour-split family is refused', () => {
    expect(choices(newListingOptions('shopify', { isMain: true }))).toEqual({ active: 'ok', inactive: 'ok', not_listed: 'ok' })
    expect(choices(newListingOptions('shopify', { isVariation: true }))).toEqual({ active: SHOPIFY_NEW_VARIATION, inactive: SHOPIFY_NEW_VARIATION, not_listed: SHOPIFY_NEW_VARIATION })
    expect(newListingOptions('shopify', { shopifyLinked: true }).every(o => !o.offered && o.reason === SHOPIFY_LINKED_REFUSED)).toBe(true)
  })
  it('Etsy (E1, Owner D1 = A), a listing not on Etsy yet: Inactive creates an Etsy draft, Not listed; Active waits for photos', () => {
    expect(choices(newListingOptions('etsy'))).toEqual({ active: ETSY_NEW_ACTIVE_NEEDS_PHOTO, inactive: 'ok', not_listed: 'ok' })
    expect(newListingOptions('etsy').find(o => o.target === 'inactive')!.sentence).toBe(ETSY_NEW_DRAFT)
    expect(newListingOptions('etsy', { isMain: true }).find(o => o.target === 'not_listed')!.warning).toBe(NOT_LISTED_MAIN_WARNING)
    expect(ETSY_NEW_ACTIVE_NEEDS_PHOTO).toBe('Etsy needs at least 1 photo to go live; photos come in a later Nexus update.')
    expect(ETSY_NEW_DRAFT).toBe('Starts on Etsy as a draft when Publish sends it: buyers cannot buy a draft.')
    expect(newListingOptions('etsy', { noRecord: true, alias: true }).every(o => !o.offered && o.reason === NEW_LISTING_ALIAS)).toBe(true)
  })
  it('Etsy, a new variation of a listing already on Etsy: Active joins the listing for sale, Inactive joins it hidden (D6) — never the photo refusal', () => {
    const variation = newListingOptions('etsy', { isVariation: true, listingOnChannel: true })
    expect(choices(variation)).toEqual({ active: 'ok', inactive: 'ok', not_listed: 'ok' })
    expect(variation.find(o => o.target === 'active')!.sentence).toBe(ETSY_NEW_VARIATION_ACTIVE)
    expect(variation.find(o => o.target === 'inactive')!.sentence).toBe(ETSY_NEW_VARIATION_INACTIVE)
    expect(ETSY_NEW_VARIATION_ACTIVE).toBe('Joins the Etsy listing when Publish sends it; it sells while the listing is active.')
    expect(ETSY_NEW_VARIATION_INACTIVE).toBe('Joins the Etsy listing hidden when Publish sends it: buyers cannot buy this variation until you set it Active.')
    // The fact is Etsy's: another channel's choices do not change with it.
    expect(newListingOptions('amazon', { listingOnChannel: true })).toEqual(newListingOptions('amazon'))
  })
  it('a row with no listing in an alias destination refuses every choice; a row with one there does not', () => {
    expect(newListingOptions('amazon', { noRecord: true, alias: true }).every(o => !o.offered && o.reason === NEW_LISTING_ALIAS)).toBe(true)
    expect(newListingOptions('amazon', { alias: true }).every(o => o.offered)).toBe(true)
  })
  it('statusOptionsFor gives a draft, not-listed or deleted row the new-listing choices', () => {
    expect(statusOptionsFor('not_listed', 'amazon').map(o => [o.target, o.offered, o.action])).toEqual([['active', true, null], ['inactive', true, null], ['not_listed', true, null]])
    const deleted = { at: '2026-10-04T10:00:00.000Z', where: 'Amazon · IT', oldReference: null, relistChosenAt: null }
    expect(statusOptionsFor('not_listed', 'amazon', { deleted }).map(o => o.target)).toEqual(['active', 'inactive', 'not_listed'])
  })
  it('ND2 A defaults: Amazon and eBay Active, Shopify Inactive (unless its Shopify status is ACTIVE), Etsy Inactive (a new variation of a listing on Etsy: Active), other channels Not listed', () => {
    expect(newListingDefault('AMAZON')).toBe('active')
    expect(newListingDefault('EBAY')).toBe('active')
    expect(newListingDefault('SHOPIFY')).toBe('inactive')
    expect(newListingDefault('SHOPIFY', { shopifyActive: true })).toBe('active')
    expect(newListingDefault('ETSY')).toBe('inactive')
    expect(newListingDefault('ETSY', { listingOnChannel: true })).toBe('active')
    expect(newListingDefault('AMAZON', { listingOnChannel: false })).toBe('active')
    expect(newListingDefault('WOOCOMMERCE')).toBe('not_listed')
    // Through the choice: a variation of a listing on Etsy nobody chose for joins it for sale; a new Etsy listing is a draft.
    const etsy = { channel: 'ETSY', own: null, main: null, isVariation: true, includedByDefault: true }
    expect(newListingChoice({ ...etsy, listingOnChannel: true })).toEqual({ target: 'active', source: 'default' })
    expect(newListingChoice(etsy)).toEqual({ target: 'inactive', source: 'default' })
  })
  it('Etsy\'s cell sentence: a listing not on Etsy says Publish creates it as a draft (E3, one constant); a new variation of a listing on Etsy says how it joins; Not listed and every other channel keep theirs', () => {
    expect(ETSY_NEW_ROW_SENTENCE).toBe('Not on Etsy yet. Publish creates it on Etsy as a draft: buyers cannot see a draft.')
    expect(newListingSentence({ target: 'inactive', source: 'default' }, { channel: 'ETSY' })).toBe(ETSY_NEW_ROW_SENTENCE)
    // Review NIT-4 — an Active stored earlier on a listing not on Etsy reads the refusal the review gives, never "creates it as a draft".
    expect(newListingSentence({ target: 'active', source: 'own' }, { channel: 'ETSY' })).toBe(ETSY_NEW_ACTIVE_NEEDS_PHOTO)
    expect(newListingSentence({ target: 'active', source: 'main' }, { channel: 'ETSY' })).toBe(`${ETSY_NEW_ACTIVE_NEEDS_PHOTO} (It follows the main product's choice; set this row to choose for it.)`)
    expect(newListingSentence({ target: 'inactive', source: 'main' }, { channel: 'ETSY' })).toBe(`${ETSY_NEW_ROW_SENTENCE} (It follows the main product's choice; set this row to choose for it.)`)
    expect(newListingSentence({ target: 'active', source: 'default' }, { channel: 'ETSY', listingOnChannel: true })).toBe(ETSY_NEW_VARIATION_ACTIVE)
    expect(newListingSentence({ target: 'inactive', source: 'own' }, { channel: 'ETSY', listingOnChannel: true })).toBe(ETSY_NEW_VARIATION_INACTIVE)
    expect(newListingSentence({ target: 'not_listed', source: 'own' }, { channel: 'ETSY', listingOnChannel: true })).toBe(NEW_LISTING_SENTENCE.not_listed)
    expect(newListingSentence({ target: 'inactive', source: 'default' }, { channel: 'AMAZON', listingOnChannel: true })).toBe(NEW_LISTING_SENTENCE.inactive)
    expect(newListingSentence({ target: 'not_listed', source: 'own' }, { channel: 'ETSY' })).toBe(NEW_LISTING_SENTENCE.not_listed)
    expect(newListingSentence({ target: 'inactive', source: 'default' }, { channel: 'AMAZON' })).toBe(NEW_LISTING_SENTENCE.inactive)
    expect(newListingSentence({ target: 'inactive', source: 'default' })).toBe(NEW_LISTING_SENTENCE.inactive)
  })
  it('the choice: own, else the main row\'s for a variation, else not listed when Publish would leave it out, else the default', () => {
    const base = { channel: 'AMAZON', own: null, main: null, isVariation: true, includedByDefault: true }
    expect(newListingChoice(base)).toEqual({ target: 'active', source: 'default' })
    expect(newListingChoice({ ...base, main: 'inactive' })).toEqual({ target: 'inactive', source: 'main' })
    expect(newListingChoice({ ...base, main: 'inactive', own: 'active' })).toEqual({ target: 'active', source: 'own' })
    expect(newListingChoice({ ...base, includedByDefault: false })).toEqual({ target: 'not_listed', source: 'default' })
    expect(newListingChoice({ ...base, isVariation: false, main: 'not_listed' })).toEqual({ target: 'active', source: 'default' })
    expect(newListingChoice({ ...base, channel: 'SHOPIFY', isVariation: false })).toEqual({ target: 'inactive', source: 'default' })
  })
})

describe('New listings: a main product on the channel whose variations are not', () => {
  it('is no new listing itself: its Status offers nothing, with why', () => {
    expect(statusOptionsFor('draft', 'amazon', { onChannel: true }).every(o => !o.offered && o.reason === 'Its variations are not on the channel yet. Publish creates them.')).toBe(true)
    expect(statusOptionsFor('draft', 'amazon').every(o => o.offered)).toBe(true)
  })
})

/* Wave 2 D4 (Owner decisions 9, 10) — one rule: a new Shopify product is created with the Status column's choice. */
describe('the status a new Shopify product is created with', () => {
  it('Active → ACTIVE, Inactive → DRAFT, Not listed (or no choice) → nothing is created', () => {
    expect(shopifyCreateStatus('active')).toBe('ACTIVE')
    expect(shopifyCreateStatus('inactive')).toBe('DRAFT')
    expect(shopifyCreateStatus('not_listed')).toBeNull()
    expect(shopifyCreateStatus(null)).toBeNull()
    expect(shopifyCreateStatus(undefined)).toBeNull()
  })
  it('says where the choice is made, and why nothing is created', () => {
    expect(SHOPIFY_STATUS_FROM_STATUS_COLUMN).toBe('A product not on Shopify yet is created with the Status column\'s choice. Change it there.')
    expect(SHOPIFY_CREATE_NOT_LISTED).toBe('This product\'s Status is Not listed for this Shopify store, so Nexus does not create it. Set its Status to Active or Inactive first.')
  })
})

/* Etsy (E1, Owner D1 = A) — the same rule for a new Etsy listing: the main row's Inactive creates an Etsy draft. */
describe('how a new Etsy listing starts', () => {
  it('Inactive → draft, Active → active (refused by Publish until photos are sent), Not listed (or no choice) → nothing is created', () => {
    expect(etsyCreateState('inactive')).toBe('draft')
    expect(etsyCreateState('active')).toBe('active')
    expect(etsyCreateState('not_listed')).toBeNull()
    expect(etsyCreateState(null)).toBeNull()
    expect(etsyCreateState(undefined)).toBeNull()
  })
})

/**
 * Item ID control (2026-10-05) — an UNLINKED row is not a deleted one: nothing was removed on the channel, the listing may
 * still be live there, and Nexus no longer updates it. It must never read "set Status to Active and Publish" (that made a
 * second eBay item), and its Status never offers Active or Inactive as a new listing.
 */
describe('an unlinked row: the unlink\'s own words, never listed as new', () => {
  const now = Date.parse('2026-10-05T15:00:00Z')
  const unlinked: ListingDeletion = { at: '2026-10-05T09:00:00.000Z', where: 'eBay · IT', oldReference: '520000000001', relistChosenAt: null, sku: null, unlinked: true }
  const drafted = { channel: 'EBAY', listingStatus: 'DRAFT', isPublished: false, externalListingId: null, offerClosedAt: null }
  const EBAY = 'Unlinked from eBay · IT on 5 Oct: the item may still be live there, and Nexus no longer updates it.'

  it('the cell, the skip, the mark and the delete refusal say the truth, per channel', () => {
    expect(deletedShort(unlinked, now)).toBe(EBAY)
    expect(deletedStatusReason(unlinked, now)).toBe(`${EBAY} Link its Item ID again on the main row; listing it as new makes a second item.`)
    expect(deletedPublishSkip(unlinked, now)).toBe(`${EBAY} Publish leaves it out: link its Item ID again on the main row; listing it as new makes a second item.`)
    expect(removedMark(unlinked, now)).toBe('unlinked 5 Oct')
    expect(removedMark({ ...unlinked, unlinked: undefined }, now)).toBe('deleted 5 Oct')
    expect(setBeforeRemoval(unlinked, now)).toBe('Set before the unlink on 5 Oct. Link its Item ID again on the main row; listing it as new makes a second item.')
    expect(ALREADY_UNLINKED('eBay · IT')).toBe('Unlinked from eBay · IT: Nexus no longer holds its Item ID, so it cannot delete it. Link its Item ID again on the main row first, or delete it in eBay.')
    expect(alreadyRemoved(unlinked)).toBe(ALREADY_UNLINKED('eBay · IT'))
    expect(alreadyRemoved({ ...unlinked, unlinked: undefined })).toBe('Already deleted on eBay · IT. To keep it off, leave its Status Not listed.')
    expect(sharedRemovedRefusal(unlinked)).toBe('Unlinked from eBay · IT: the item may still be live there, and Nexus no longer updates it. Link its Item ID again in the eBay · IT sheet.')
    expect(sharedRemovedRefusal({ where: 'Amazon · IT' })).toBe('Deleted on Amazon · IT. To list it again, set its Status in the Amazon · IT sheet.')
    // Amazon keys a listing by its seller SKU: a create there is no second listing, so none is claimed.
    expect(deletedStatusReason({ ...unlinked, where: 'Amazon · IT' }, now))
      .toBe('Unlinked from Amazon · IT on 5 Oct: the listing may still be live there, and Nexus no longer updates it. Link its ASIN again on this row to update it from Nexus.')
    expect(deletedStatusReason({ ...unlinked, where: 'Shopify' }, now))
      .toBe('Unlinked from Shopify on 5 Oct: the product may still be live there, and Nexus no longer updates it. Link its Product ID again on the main row; listing it as new makes a second product.')
    expect(unlinkWords('Etsy · GLOBAL')).toMatchObject({ id: 'Listing ID', second: 'listing' })
    // A deleted row keeps its words.
    expect(deletedStatusReason({ ...unlinked, unlinked: undefined }, now)).toBe('Deleted on eBay · IT on 5 Oct. To list it again, set Status to Active and Publish.')
  })

  it('it reads Not listed with the unlink\'s reason; Status offers only Not listed; nothing can be deleted or changed', () => {
    expect(sellingStateOf({ ...drafted, deletion: unlinked })).toEqual({ state: 'not_listed', deleted: unlinked,
      reason: `${EBAY.replace('5 Oct', deletedOnToday(unlinked.at))} Link its Item ID again on the main row; listing it as new makes a second item.` })
    const options = statusOptionsFor('not_listed', 'ebay-trading', { deleted: unlinked })
    expect(options.map(o => [o.target, o.offered])).toEqual([['active', false], ['inactive', false], ['not_listed', true]])
    expect(options[0].reason).toBe(deletedStatusReason(unlinked))
    expect(options[2].sentence).toBe(UNLINKED_NOT_LISTED)
    expect(deleteOffered('not_listed', 'ebay-trading', { deleted: unlinked })).toMatchObject({ offered: false, reason: ALREADY_UNLINKED('eBay · IT') })
    expect(actionsFor('not_listed', 'ebay-trading', { deleted: unlinked })).toEqual([])
  })

  it('its choice\'s sentence never says Publish lists it again', () => {
    expect(newListingSentence({ target: 'not_listed', source: 'default' }, { deleted: unlinked, now })).toBe(deletedStatusReason(unlinked, now))
    expect(newListingSentence({ target: 'active', source: 'own' }, { deleted: unlinked, now })).toBe(deletedPublishSkip(unlinked, now))
    expect(newListingSentence({ target: 'inactive', source: 'main' }, { deleted: unlinked, now })).toBe(deletedPublishSkip(unlinked, now))
  })
})

/** `deletedOn` against the real clock (sellingStateOf reads no `now`). */
function deletedOnToday(at: string) {
  const date = new Date(at)
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getUTCMonth()]
  return `${date.getUTCDate()} ${month}${date.getUTCFullYear() !== new Date().getUTCFullYear() ? ` ${date.getUTCFullYear()}` : ''}`
}
