import { describe, expect, it } from 'vitest'
import type { StudioPublicationStatus } from '@nexus/shared/studio-publication'
import { SHOW_ALL_ACTION, SHOW_REJECTED_ACTION, combinedPublicationMark, destinationLabel, eventListing, isSettled, listingPlace, publicationEventMatches, publicationEventOf, publicationMark, publicationOutcome, rejectedFilterMenuLabel, resultCounts, summaryCounts, watchedListings, withRejectedFilter } from './outcome'

const destination = { productIds: ['child', 'family'], channel: 'AMAZON', marketplace: 'IT', accountId: 'acc', aliasKey: '' }
const meta = { publicationId: 'pub', productId: 'family', channel: 'AMAZON', marketplace: 'IT', accountId: 'acc', aliasKey: '', status: 'PARTIAL', terminal: true, source: 'sse' }
const counts = (c: Partial<Record<'products' | 'accepted' | 'verified' | 'failed' | 'submitted', number>>) => ({ products: 0, accepted: 0, verified: 0, failed: 0, submitted: 0, needsCheck: false, ...c })

function read(over: Partial<StudioPublicationStatus>): StudioPublicationStatus {
  return { destination: { channel: 'AMAZON', marketplace: 'IT', accountId: 'acc', aliasKey: '' }, inFlight: null, latest: null, rows: [], readAt: '2026-10-02T10:00:00.000Z', ...over }
}

describe('publicationEventOf', () => {
  it('reads the bus payload from the invalidation meta', () => {
    expect(publicationEventOf({ id: 'pub', meta })).toEqual({ publicationId: 'pub', productId: 'family', channel: 'AMAZON', marketplace: 'IT', accountId: 'acc', aliasKey: '', status: 'PARTIAL', terminal: true })
  })
  it('refuses an event that does not name a destination or a status', () => {
    expect(publicationEventOf({ meta: { ...meta, accountId: undefined } })).toBeNull()
    expect(publicationEventOf({ meta: { ...meta, status: '' } })).toBeNull()
    expect(publicationEventOf(null)).toBeNull()
  })
  it('treats a missing terminal flag as not final', () => {
    expect(publicationEventOf({ meta: { ...meta, terminal: 'true' } })?.terminal).toBe(false)
  })
})

describe('publicationEventMatches', () => {
  const event = publicationEventOf({ meta })!
  it('matches the family on the exact destination', () => {
    expect(publicationEventMatches(event, destination)).toBe(true)
  })
  it('ignores another account, market, listing or product', () => {
    expect(publicationEventMatches({ ...event, accountId: 'other' }, destination)).toBe(false)
    expect(publicationEventMatches({ ...event, marketplace: 'DE' }, destination)).toBe(false)
    expect(publicationEventMatches({ ...event, aliasKey: 'alt' }, destination)).toBe(false)
    expect(publicationEventMatches({ ...event, productId: 'else' }, destination)).toBe(false)
  })
})

describe('publicationOutcome', () => {
  it('says every product went through', () => {
    expect(publicationOutcome('ACCEPTED', counts({ products: 21, accepted: 21 }), 'AMAZON', 'IT')).toEqual({ tone: 'info', message: 'Amazon · IT accepted all 21 products.' })
    expect(publicationOutcome('VERIFIED', counts({ products: 1, verified: 1 }), 'EBAY', 'IT')).toEqual({ tone: 'success', message: 'eBay · IT accepted the product.' })
    // Aliases (2026-10-05): the window's own name for a listing alias.
    expect(publicationOutcome('VERIFIED', counts({ products: 1, verified: 1 }), 'EBAY', 'IT', 'eBay · IT · ① Racing edition')?.message).toBe('eBay · IT · ① Racing edition accepted the product.')
  })
  it('counts a partial result', () => {
    expect(publicationOutcome('PARTIAL', counts({ products: 21, accepted: 19, failed: 2 }), 'AMAZON', 'IT'))
      .toEqual({ tone: 'warning', message: 'Amazon · IT accepted 19 of 21 products. 2 were rejected.' })
    expect(publicationOutcome('PARTIAL', counts({ products: 3, verified: 2, failed: 1 }), 'AMAZON', 'IT')?.message).toBe('Amazon · IT accepted 2 of 3 products. 1 was rejected.')
  })
  it('says nothing changed only when nothing was accepted', () => {
    expect(publicationOutcome('FAILED', counts({}), 'AMAZON', 'IT')).toEqual({ tone: 'danger', message: 'Amazon · IT rejected the upload. Nothing changed on Amazon.' })
    expect(publicationOutcome('FAILED', counts({ products: 4, failed: 4 }), 'AMAZON', 'IT')?.message).toBe('Amazon · IT rejected all 4 products. Nothing changed on Amazon.')
    expect(publicationOutcome('FAILED', counts({ products: 4, accepted: 1, failed: 3 }), 'AMAZON', 'IT')?.message).toBe('Amazon · IT accepted 1 of 4 products. 3 were rejected.')
  })
  it('warns when the channel never answered', () => {
    expect(publicationOutcome('UNVERIFIED', null, 'AMAZON', 'DE')).toEqual({ tone: 'warning', message: 'Not confirmed — Amazon · DE has not answered. It may have arrived. Check before you publish again.' })
  })
  it('has nothing to say while a publication is on its way', () => {
    expect(publicationOutcome('SUBMITTED', counts({ products: 5, submitted: 5 }), 'AMAZON', 'IT')).toBeNull()
    expect(publicationOutcome('PUBLISHING', null, 'AMAZON', 'IT')).toBeNull()
  })
})

describe('publicationMark', () => {
  const latest = (status: string, summary: Record<string, unknown> | null) => ({ publicationId: 'pub', status, at: '2026-10-01T20:00:00.000Z', completedAt: '2026-10-01T20:20:00.000Z', summary })
  it('shows nothing without a read, a publication, or after a clean one', () => {
    expect(publicationMark(null, 'AMAZON', 'IT')).toBeNull()
    expect(publicationMark(read({}), 'AMAZON', 'IT')).toBeNull()
    expect(publicationMark(read({ latest: latest('VERIFIED', { products: 3, verified: 3 }) }), 'AMAZON', 'IT')).toBeNull()
    expect(publicationMark(read({ latest: latest('ACCEPTED', { products: 3, accepted: 3 }) }), 'AMAZON', 'IT')).toBeNull()
  })
  it('counts the products of the publication on its way', () => {
    const mark = publicationMark(read({ inFlight: { publicationId: 'pub', status: 'SUBMITTED' }, latest: latest('SUBMITTED', { products: 21, submitted: 21 }) }), 'AMAZON', 'IT')
    expect(mark).toMatchObject({ tone: 'info', label: 'Amazon · IT is processing 21 products' })
    expect(mark?.detail).toContain('Nexus checks Amazon by itself')
    expect(mark?.onSelect).toBeUndefined()
  })
  it('does not borrow the counts of an older publication', () => {
    const mark = publicationMark(read({ inFlight: { publicationId: 'new', status: 'PUBLISHING' }, latest: latest('FAILED', { products: 21, failed: 21 }) }), 'AMAZON', 'IT')
    expect(mark?.label).toBe('Sending the last publish to Amazon · IT')
  })
  it('warns about an unconfirmed publication and one the sweep gave up on', () => {
    expect(publicationMark(read({ inFlight: { publicationId: 'pub', status: 'UNVERIFIED' } }), 'EBAY', 'IT')).toMatchObject({ tone: 'warning', label: 'Result unknown on eBay · IT' })
    const stale = publicationMark(read({ inFlight: { publicationId: 'pub', status: 'SUBMITTED' }, latest: latest('SUBMITTED', { products: 2, submitted: 2, needsCheck: true }) }), 'AMAZON', 'IT')
    expect(stale).toMatchObject({ tone: 'warning', label: 'Result unknown on Amazon · IT' })
    expect(stale?.detail).toContain('7 days')
  })
  it('counts the rejected products of the last publish', () => {
    const mark = publicationMark(read({ latest: latest('PARTIAL', { products: 21, accepted: 19, failed: 2 }) }), 'AMAZON', 'IT')
    expect(mark).toMatchObject({ tone: 'danger', label: '2 rejected on Amazon · IT' })
    expect(mark?.detail).toMatch(/^In the publish of .+, Amazon rejected 2 of 21 products\.$/)
    expect(publicationMark(read({ latest: latest('FAILED', null) }), 'AMAZON', 'IT')?.label).toBe('Last publish failed on Amazon · IT')
  })
})

describe('counts and labels', () => {
  it('reads a stored summary and ignores junk', () => {
    expect(summaryCounts({ products: 3, accepted: 2, failed: 1, verified: 'x', needsCheck: true })).toEqual({ products: 3, accepted: 2, verified: 0, failed: 1, submitted: 0, needsCheck: true })
    expect(summaryCounts(null)).toBeNull()
  })
  it('counts a dialog result by per-SKU status', () => {
    const results = [{ sku: 'A', status: 'ACCEPTED' }, { sku: 'B', status: 'FAILED' }, { sku: 'C', status: 'VERIFIED' }, { sku: 'D', status: 'SUBMITTED' }] as never
    expect(resultCounts({ results })).toEqual({ products: 4, accepted: 1, verified: 1, failed: 1, submitted: 1, needsCheck: false })
  })
  it('names a destination the way every message does', () => {
    expect(destinationLabel('EBAY', 'DE')).toBe('eBay · DE')
    // F4 (browser check 2026-10-05): a GLOBAL market reads as the channel's name alone.
    expect(destinationLabel('SHOPIFY', 'GLOBAL')).toBe('Shopify')
    expect(destinationLabel('ETSY', 'GLOBAL')).toBe('Etsy')
  })
  it('settles on a final status only', () => {
    expect(isSettled('PARTIAL')).toBe(true)
    expect(isSettled('VERIFIED')).toBe(true)
    expect(isSettled('SUBMITTED')).toBe(false)
    expect(isSettled('UNVERIFIED')).toBe(false)
    expect(isSettled(null)).toBe(false)
  })
})

describe('withRejectedFilter — the "N rejected" mark shows those rows (step 3)', () => {
  const rejected = { tone: 'danger' as const, label: '2 rejected on Amazon · IT', detail: 'In the publish of 1 Oct, 20:07, Amazon rejected 2 of 21 products.' }
  it('makes a rejection mark a toggle while some row can be shown', () => {
    const toggle = () => undefined
    expect(withRejectedFilter(rejected, 2, false, toggle)).toEqual({ ...rejected, onSelect: toggle, actionLabel: SHOW_REJECTED_ACTION, selected: false })
    expect(withRejectedFilter(rejected, 2, true, toggle)).toMatchObject({ actionLabel: SHOW_ALL_ACTION, selected: true })
  })
  it('leaves a mark that only reports alone: no rows to show, or not a rejection', () => {
    const toggle = () => undefined
    expect(withRejectedFilter(rejected, 0, false, toggle)).toBe(rejected)
    const processing = { tone: 'info' as const, label: 'Amazon · IT is processing 21 products' }
    expect(withRejectedFilter(processing, 3, false, toggle)).toBe(processing)
    expect(withRejectedFilter(null, 3, false, toggle)).toBeNull()
  })
  it('names the same filter in the ⋯ menu, where a folded mark cannot be pressed', () => {
    expect(rejectedFilterMenuLabel(2, false, 'AMAZON', 'IT')).toBe('Show the 2 rows rejected on Amazon · IT')
    expect(rejectedFilterMenuLabel(1, false, 'AMAZON', 'IT')).toBe('Show the row rejected on Amazon · IT')
    expect(rejectedFilterMenuLabel(2, true, 'AMAZON', 'IT')).toBe('Show all rows')
  })
})

describe('aliases (2026-10-05) — the mark and the toast cover every listing of the destination', () => {
  const aliases = [{ id: 'alias-1', label: 'sample-listing-ALT1', position: 1 }, { id: 'alias-2', label: 'sample-listing-ALT2', position: 2 }]
  const at = (minutes: number) => new Date(Date.parse('2026-10-05T10:00:00Z') + minutes * 60_000).toISOString()
  const latest = (status: string, summary: Record<string, unknown> | null, minutes = 0) => ({ publicationId: `pub-${status}-${minutes}`, status, at: at(minutes), completedAt: at(minutes), summary })
  const ebay = (over: Partial<StudioPublicationStatus>, aliasKey = '') => read({ destination: { channel: 'EBAY', marketplace: 'IT', accountId: 'acc', aliasKey }, ...over })

  it('watches the chosen listing alone, or the main listing and every alias when none is chosen', () => {
    expect(watchedListings('', aliases)).toEqual(['', 'alias-1', 'alias-2'])
    expect(watchedListings('alias-2', aliases)).toEqual(['alias-2'])
    expect(watchedListings('', [])).toEqual([''])
  })

  it('m5 — "Main listing" chosen is not "All listings": only the main listing is watched, and an alias event is not ours', () => {
    expect(watchedListings('', aliases, true)).toEqual([''])
    expect(watchedListings('', aliases, false)).toEqual(['', 'alias-1', 'alias-2'])
    const destination = { productIds: ['family'], channel: 'EBAY', marketplace: 'IT', accountId: 'acc', aliasKey: '' }
    const event = (aliasKey: string) => ({ publicationId: 'p', productId: 'family', channel: 'EBAY', marketplace: 'IT', accountId: 'acc', aliasKey, status: 'ACCEPTED', terminal: true })
    expect(eventListing(event('alias-1'), destination, [''], false)).toBeNull()
    expect(eventListing(event('alias-new'), destination, [''], false)).toBeNull()
    expect(eventListing(event(''), destination, [''], false)).toEqual({ aliasKey: '', known: true })
    // No listing chosen: an alias not read yet asks for the aliases again, as before.
    expect(eventListing(event('alias-new'), destination, [''], true)).toEqual({ aliasKey: 'alias-new', known: false })
  })

  it('m9 — until the aliases are read (or when that read fails), the main or chosen listing reads as before: "eBay · IT"', () => {
    expect(listingPlace('EBAY', 'IT', '', null)).toBe('eBay · IT')
    expect(listingPlace('EBAY', 'IT', 'alias-1', null, 'alias-1')).toBe('eBay · IT')
    // Read, but the chosen listing is not among the offered aliases (an archived one opened by an old link).
    expect(listingPlace('EBAY', 'IT', 'alias-9', aliases, 'alias-9')).toBe('eBay · IT')
    expect(publicationOutcome('ACCEPTED', counts({ products: 1, accepted: 1 }), 'EBAY', 'IT', listingPlace('EBAY', 'IT', '', null))?.message).toBe('eBay · IT accepted the product.')
    // Only another alias the read does not name is "Other listing".
    expect(listingPlace('EBAY', 'IT', 'alias-9', aliases, '')).toBe('eBay · IT · Other listing')
    // Read: the main listing of a market with aliases carries the one word.
    expect(listingPlace('EBAY', 'IT', '', aliases, '')).toBe('eBay · IT · ★ Main listing')
  })

  it('names each listing as the Publish window does', () => {
    expect(listingPlace('EBAY', 'IT', 'alias-1', aliases)).toBe('eBay · IT · ① sample-listing-ALT1')
    expect(listingPlace('EBAY', 'IT', '', aliases)).toBe('eBay · IT · ★ Main listing')
    expect(listingPlace('EBAY', 'IT', '', [])).toBe('eBay · IT')
    expect(listingPlace('EBAY', 'IT', 'alias-9', aliases)).toBe('eBay · IT · Other listing')
    expect(publicationOutcome('ACCEPTED', counts({ products: 4, accepted: 4 }), 'EBAY', 'IT', listingPlace('EBAY', 'IT', 'alias-1', aliases))?.message)
      .toBe('eBay · IT · ① sample-listing-ALT1 accepted all 4 products.')
  })

  it('shows the worst listing’s mark, the newest of equals, and names the others in its detail', () => {
    const main = ebay({ latest: latest('ACCEPTED', { products: 8, accepted: 8 }) })
    const alt1 = ebay({ inFlight: { publicationId: 'pub-SUBMITTED-5', status: 'SUBMITTED' }, latest: latest('SUBMITTED', { products: 8, submitted: 8 }, 5) }, 'alias-1')
    const alt2 = ebay({ latest: latest('PARTIAL', { products: 8, accepted: 4, failed: 4 }, 1) }, 'alias-2')
    const place = (key: string) => listingPlace('EBAY', 'IT', key, aliases)
    // Nothing to say about a clean main listing; the alias on its way is the mark.
    expect(combinedPublicationMark([{ read: main, place: place('') }, { read: alt1, place: place('alias-1') }], 'EBAY', 'IT'))
      .toMatchObject({ tone: 'info', label: 'eBay · IT · ① sample-listing-ALT1 is processing 8 products' })
    // A rejection outranks a publish on its way; the other mark is named, not dropped.
    const mark = combinedPublicationMark([{ read: main, place: place('') }, { read: alt1, place: place('alias-1') }, { read: alt2, place: place('alias-2') }], 'EBAY', 'IT')
    expect(mark).toMatchObject({ tone: 'danger', label: '4 rejected on eBay · IT · ② sample-listing-ALT2' })
    expect(mark?.detail).toMatch(/rejected 4 of 8 products\. Also: eBay · IT · ① sample-listing-ALT1 is processing 8 products\.$/)
    // Two rejections: the newer one leads.
    const older = ebay({ latest: latest('FAILED', null, -30) })
    expect(combinedPublicationMark([{ read: older, place: place('') }, { read: alt2, place: place('alias-2') }], 'EBAY', 'IT')?.label).toBe('4 rejected on eBay · IT · ② sample-listing-ALT2')
    expect(combinedPublicationMark([{ read: main, place: place('') }, { read: null, place: place('alias-1') }], 'EBAY', 'IT')).toBeNull()
    // One listing: exactly the single mark.
    expect(combinedPublicationMark([{ read: alt2, place: 'eBay · IT' }], 'EBAY', 'IT')).toEqual(publicationMark(alt2, 'EBAY', 'IT'))
  })

  it('routes an event to its listing; an alias not read yet asks for the aliases again; a chosen listing hears only itself', () => {
    const destination = { productIds: ['child', 'family'], channel: 'EBAY', marketplace: 'IT', accountId: 'acc', aliasKey: '' }
    const event = (aliasKey: string, over: Record<string, unknown> = {}) => ({ publicationId: 'p', productId: 'family', channel: 'EBAY', marketplace: 'IT', accountId: 'acc', aliasKey, status: 'ACCEPTED', terminal: true, ...over })
    const listings = watchedListings('', aliases)
    expect(eventListing(event('alias-1'), destination, listings)).toEqual({ aliasKey: 'alias-1', known: true })
    expect(eventListing(event(''), destination, listings)).toEqual({ aliasKey: '', known: true })
    expect(eventListing(event('alias-new'), destination, listings)).toEqual({ aliasKey: 'alias-new', known: false })
    expect(eventListing(event('alias-1', { marketplace: 'DE' }), destination, listings)).toBeNull()
    expect(eventListing(event('alias-1', { productId: 'other' }), destination, listings)).toBeNull()
    const chosen = { ...destination, aliasKey: 'alias-2' }
    expect(eventListing(event('alias-1'), chosen, watchedListings('alias-2', aliases))).toBeNull()
    expect(eventListing(event('alias-2'), chosen, watchedListings('alias-2', aliases))).toEqual({ aliasKey: 'alias-2', known: true })
  })
})
