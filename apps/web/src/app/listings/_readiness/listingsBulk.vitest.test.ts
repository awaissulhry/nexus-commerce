import { describe, expect, it, vi } from 'vitest'
import type { ReadinessChip, ReadinessDestination, ReadinessFamilyRow, ReadinessMemberRow } from '@nexus/shared/listing-readiness'
import { canConfirmAction } from '@/design-system/components/ActionConfirm'
import {
  BULK_LISTINGS_MAX, BUSY_REASON, PRICE_PERMISSION_REASON, bulkSelection, chipLinks, destinationsInScope, followHeld, followMasterConfirm,
  isSelectableRow, jobFinished, jobOutcome, jobProgress, jobStillRunning, menuDestination, placeWords, priceDestinations, priceText, publishHeld,
  publishKeys, reachBody, reachCurrency, reachWords, rowMenuItems, selectionKey, setPriceConfirm, setPriceHeld, translateSelectedScope,
  type ListingReach, type ReachState,
} from './listingsBulk'
import { familyFooter } from './readinessRows'

const key = (c: (string | null)[]) => JSON.stringify(c)
const dest = (channel: string, marketplace: string, accountId: string | null = 'a1', aliasKey = '', label?: string): ReadinessDestination => ({
  key: channel === 'SHARED' ? key([null, null, null, null]) : key([channel, marketplace, accountId, aliasKey || null]),
  channel, marketplace, accountId: channel === 'SHARED' ? null : accountId, aliasKey,
  label: label ?? (channel === 'SHARED' ? 'Shared' : `${channel === 'EBAY' ? 'eBay' : channel.charAt(0) + channel.slice(1).toLowerCase()} ${marketplace}`.trim()),
})
const SHARED = dest('SHARED', '')
const AMZ_DE = dest('AMAZON', 'DE')
const AMZ_IT = dest('AMAZON', 'IT')
const AMZ_UK = dest('AMAZON', 'UK')
const EBAY_IT = dest('EBAY', 'IT', 'e1')
const EBAY_IT_2 = dest('EBAY', 'IT', 'e2', '', 'eBay IT · motovento')
const EBAY_IT_ALIAS = dest('EBAY', 'IT', 'e1', 'al1', 'eBay IT · second')
const ALL = [SHARED, AMZ_IT, AMZ_DE, AMZ_UK, EBAY_IT, EBAY_IT_2, EBAY_IT_ALIAS]

const counts = { blocked: 0, warn: 0, notComputed: 0, absent: 0, ready: 1 }
const chip = (destinationKey: string, over: Partial<ReadinessChip> = {}): ReadinessChip =>
  ({ destinationKey, state: 'ready', counts, issueCount: 0, pending: false, computedAt: null, ...over })
const family = (id: string, over: Partial<ReadinessFamilyRow> = {}): ReadinessFamilyRow => ({
  id, sku: id.toUpperCase(), name: null, imageUrl: null, photoCount: 0, state: 'ready', chips: [chip(AMZ_DE.key)], nextStep: null, computedAt: null,
  pending: false, editorHref: `/products/${id}/edit/studio`, isParent: true, variantCount: 3, matchingCount: 3, ...over,
})
const member = (id: string, parentId: string | null, over: Partial<ReadinessMemberRow> = {}): ReadinessMemberRow => ({
  id, sku: id.toUpperCase(), name: null, imageUrl: null, photoCount: 0, state: 'ready', chips: [chip(AMZ_DE.key)], nextStep: null, computedAt: null,
  pending: false, editorHref: `/products/${id}/edit/studio`, parentId, isParentListing: false, ...over,
})
const reach = (over: Partial<ListingReach> = {}): ListingReach =>
  ({ listingIds: ['l1', 'l2'], products: 2, missing: 0, aliases: 0, currencies: ['EUR'], productIds: ['p1', 'p2'], ...over })
const counted = (over: Partial<ListingReach> = {}): ReachState => ({ kind: 'counted', reach: reach(over) })

describe('ticking rows', () => {
  it('a product or family can be ticked; not the footer, not a family’s own parent listing', () => {
    expect(isSelectableRow(family('f1'))).toBe(true)
    expect(isSelectableRow(member('v1', 'f1'))).toBe(true)
    expect(isSelectableRow(member('f1', null, { isParentListing: true }))).toBe(false)
    expect(isSelectableRow(familyFooter('f1', 10, 20))).toBe(false)
    expect(isSelectableRow(null)).toBe(false)
  })
  it('a family counts once; a variation of a ticked family is in it already; a lone variation counts on its own', () => {
    const s = bulkSelection([family('f1'), member('v1', 'f1'), member('v9', 'f2'), family('solo', { isParent: false, variantCount: 0 })])
    expect(s.productIds).toEqual(['f1', 'v9', 'solo'])
    expect(s.count).toBe(3)
    expect(s.families).toBe(3) // f1, f2 (through v9), solo
    expect(selectionKey(s)).toBe('f1\nv9\nsolo')
    expect(bulkSelection([])).toEqual({ productIds: [], count: 0, families: 0 })
  })
})

describe('the destinations in scope', () => {
  it('everything in view on /listings; the Channel, Market and Store filters narrow it', () => {
    expect(destinationsInScope(ALL, {})).toEqual(ALL)
    expect(destinationsInScope(ALL, { channel: 'AMAZON' })).toEqual([AMZ_IT, AMZ_DE, AMZ_UK])
    expect(destinationsInScope(ALL, { channel: 'SHARED' })).toEqual([SHARED])
    // GB is the UK; a market filter leaves Shared out (it has no market).
    expect(destinationsInScope(ALL, { marketplace: 'gb' })).toEqual([AMZ_UK])
    expect(destinationsInScope(ALL, { channel: 'EBAY', marketplace: 'IT', accountId: 'e2' })).toEqual([EBAY_IT_2])
  })
  it('a market page: its own destination(s) — the lock is the filter', () => {
    expect(destinationsInScope(ALL, { channel: 'EBAY', marketplace: 'IT' })).toEqual([EBAY_IT, EBAY_IT_2, EBAY_IT_ALIAS])
  })
  it('once each', () => {
    expect(destinationsInScope([AMZ_DE, AMZ_DE], {})).toEqual([AMZ_DE])
  })
  it('a price action never lands on Shared or a second (alias) listing; Publish starts on every store destination', () => {
    expect(priceDestinations(ALL)).toEqual([AMZ_IT, AMZ_DE, AMZ_UK, EBAY_IT, EBAY_IT_2])
    expect(publishKeys([SHARED, AMZ_DE, EBAY_IT_ALIAS])).toEqual([key(['AMAZON', 'DE', 'a1', null]), key(['EBAY', 'IT', 'e1', 'al1'])])
    expect(reachBody({ productIds: ['f1'], count: 1, families: 1 }, ALL)).toEqual({
      productIds: ['f1'], destinationKeys: [AMZ_IT.key, AMZ_DE.key, AMZ_UK.key, EBAY_IT.key, EBAY_IT_2.key],
    })
  })
  it('says where in words', () => {
    expect(placeWords([AMZ_DE])).toBe('Amazon DE')
    expect(placeWords([SHARED, AMZ_DE])).toBe('Amazon DE')
    expect(placeWords([EBAY_IT, EBAY_IT_2])).toBe('eBay IT (2 stores)')
    expect(placeWords([AMZ_IT, AMZ_DE, AMZ_UK])).toBe('3 Amazon markets')
    expect(placeWords([AMZ_IT, AMZ_DE, EBAY_IT, EBAY_IT_2])).toBe('3 markets')
    expect(placeWords([SHARED])).toBe('no store')
  })
})

describe('the reach, before anything runs', () => {
  it('reaches N listings on the place; products not listed there and second listings left out are said', () => {
    expect(reachWords(counted({ listingIds: Array.from({ length: 214 }, (_, i) => `l${i}`) }), [AMZ_DE])).toBe('reaches 214 listings on Amazon DE')
    expect(reachWords(counted({ missing: 6 }), [AMZ_DE])).toBe('reaches 2 listings on Amazon DE · 6 products not listed there')
    expect(reachWords(counted({ missing: 1, aliases: 1 }), [AMZ_IT, AMZ_DE])).toBe('reaches 2 listings on 2 Amazon markets · not listed in 1 place · 1 second listing left out')
    expect(reachWords({ kind: 'counting' }, [AMZ_DE])).toBe('counting the listings on Amazon DE…')
    expect(reachWords({ kind: 'failed', error: 'Access denied (products.view)' }, [AMZ_DE])).toBe('the listings on Amazon DE could not be counted: Access denied (products.view)')
    // Only Shared in scope: no listing to reach, nothing to say.
    expect(reachWords(counted(), [SHARED])).toBeNull()
  })
})

describe('why an action is held', () => {
  const base = { state: counted(), destinations: [AMZ_DE], canEditPrice: true, busy: false }
  const lock = { channel: 'AMAZON' as const, marketplace: 'DE' }
  it('Follow master and Stop following master: free when listings are reached, within the route’s 1,000', () => {
    expect(followHeld(base)).toBeNull()
    expect(followHeld({ ...base, busy: true })).toBe(BUSY_REASON)
    expect(followHeld({ ...base, canEditPrice: false })).toBe(PRICE_PERMISSION_REASON)
    expect(followHeld({ ...base, destinations: [SHARED] })).toBe('Shared has no listings: choose a store or market in Filters.')
    expect(followHeld({ ...base, state: { kind: 'counting' } })).toBe('Counting the listings…')
    expect(followHeld({ ...base, state: null })).toBe('Counting the listings…')
    expect(followHeld({ ...base, state: { kind: 'failed', error: 'Network down' } })).toBe('The listings could not be counted: Network down')
    expect(followHeld({ ...base, state: counted({ listingIds: [] }) })).toBe('None of the selected products is listed here.')
    const many = Array.from({ length: BULK_LISTINGS_MAX + 1 }, (_, i) => `l${i}`)
    expect(followHeld({ ...base, state: counted({ listingIds: many }) })).toBe('One bulk change reaches at most 1,000 listings; this one would reach 1,001. Select fewer products.')
    expect(followHeld({ ...base, state: counted({ listingIds: many.slice(1) }) })).toBeNull()
  })
  it('Set price: only on a store or market page, and only in one currency', () => {
    expect(setPriceHeld({ ...base, lock })).toBeNull()
    expect(setPriceHeld({ ...base, lock: null })).toBe('Set a price on a store or market page (the Listings menu).')
    expect(setPriceHeld({ ...base, lock, state: counted({ currencies: ['EUR', 'GBP'] }) })).toBe('Prices differ by market: open one market.')
    expect(setPriceHeld({ ...base, lock, state: counted({ currencies: [null] }) })).toBe('Nexus has no currency for this market: set the price in the Listing window.')
    expect(setPriceHeld({ ...base, lock, state: counted({ currencies: ['EUR', null] }) })).toBe('Prices differ by market: open one market.')
    // The other holds come first, in the same words.
    expect(setPriceHeld({ ...base, lock: null, canEditPrice: false })).toBe(PRICE_PERMISSION_REASON)
    expect(setPriceHeld({ ...base, lock, state: counted({ listingIds: [] }) })).toBe('None of the selected products is listed here.')
    expect(reachCurrency(counted())).toBe('EUR')
    expect(reachCurrency(counted({ currencies: ['EUR', 'GBP'] }))).toBeNull()
    expect(reachCurrency({ kind: 'counting' })).toBeNull()
  })
  it('Publish takes 200 products at once', () => {
    expect(publishHeld({ productIds: [], count: 200, families: 200 }, false)).toBeNull()
    expect(publishHeld({ productIds: [], count: 201, families: 201 }, false)).toBe('Select 200 or fewer products to publish.')
    expect(publishHeld({ productIds: [], count: 1, families: 1 }, true)).toBe(BUSY_REASON)
  })
  it('Translate selected: a language, and at most 200 products with their variations', () => {
    expect(translateSelectedScope(counted(), 'de')).toEqual({ ok: true, query: { productIds: 'p1,p2', language: 'de' } })
    expect(translateSelectedScope(counted(), '')).toEqual({ ok: false, reason: 'Choose a language in Filters first: Translate writes one language.' })
    // As Translate filtered products: held while a column filter or the problem chip narrows the page.
    expect(translateSelectedScope(counted(), 'de', { columnFilters: 1 })).toEqual({ ok: false, reason: 'Translate cannot narrow by the column filters. Clear them first.' })
    expect(translateSelectedScope(counted(), 'de', { problem: true })).toEqual({ ok: false, reason: 'Translate cannot narrow to one problem. Remove the problem chip first.' })
    expect(translateSelectedScope(counted(), 'de', { columnFilters: 0, problem: false })).toMatchObject({ ok: true })
    expect(translateSelectedScope({ kind: 'counting' }, 'de')).toEqual({ ok: false, reason: 'Counting the products…' })
    expect(translateSelectedScope(counted({ productIds: [] }), 'de')).toEqual({ ok: false, reason: 'None of the selected products is in Nexus any more.' })
    const ids = Array.from({ length: 201 }, (_, i) => `p${i}`)
    expect(translateSelectedScope(counted({ productIds: ids }), 'de')).toEqual({
      ok: false, reason: 'Translate takes at most 200 products at once; this selection covers 201 with its variations. Select fewer.',
    })
  })
})

describe('the confirms say what they reach, what they send and that there is no undo', () => {
  it('Set price', () => {
    const impact = setPriceConfirm(reach({ listingIds: ['l1', 'l2', 'l3'], products: 3 }), 'Amazon DE', 49.9, 'EUR')
    expect(impact.title).toBe('Set €49.90 on 3 listings?')
    expect(impact.confirmLabel).toBe('Set €49.90')
    expect(impact.consequences[0]).toBe('3 listings of 3 products on Amazon DE.')
    expect(impact.consequences.some((c) => c.includes('30-second hold'))).toBe(true)
    expect(impact.consequences.at(-1)).toMatch(/^There is no undo/)
    expect(canConfirmAction(impact, '', false)).toBe(true)
  })
  it('Follow master', () => {
    const impact = followMasterConfirm(reach({ listingIds: ['l1'], products: 1 }), 'eBay IT')
    expect(impact.title).toBe('Follow the master on 1 listing?')
    expect(impact.consequences[0]).toBe('1 listing of 1 product on eBay IT.')
    expect(impact.consequences.join(' ')).toContain('FBA quantity is never changed')
    expect(impact.consequences.at(-1)).toMatch(/^There is no undo/)
    expect(canConfirmAction(impact, '', false)).toBe(true)
  })
  it('a price in its currency, or the bare number', () => {
    expect(priceText(49.9, 'GBP')).toBe('£49.90')
    expect(priceText(10, null)).toBe('10.00')
    expect(priceText(10, 'XX1')).toBe('10.00 XX1')
  })
})

describe('the job, as the bar reports it', () => {
  it('knows when it finished, and says its progress', () => {
    expect(jobFinished({ status: 'COMPLETED' })).toBe(true)
    expect(jobFinished({ status: 'PARTIALLY_COMPLETED' })).toBe(true)
    expect(jobFinished({ status: 'FAILED' })).toBe(true)
    expect(jobFinished({ status: 'IN_PROGRESS' })).toBe(false)
    expect(jobFinished(null)).toBe(false)
    expect(jobProgress('set-price', { processed: 40, total: 214 })).toBe('Setting prices: 40 of 214')
    expect(jobProgress('unfollow-master', null)).toBe('Stopping following the master…')
    expect(jobStillRunning('follow-master', { processed: 3, total: 9 })).toBe('Following the master: 3 of 9 — still running after a minute. The page updates when it finishes.')
  })
  it('one sentence: what it did, the first failure word for word, the first note', () => {
    const job = { status: 'COMPLETED', total: 3, processed: 3, succeeded: 3, failed: 0, errors: [] }
    expect(jobOutcome('set-price', job)).toEqual({ tone: 'success', text: 'Price set on 3 listings. Nexus sends the prices after a 30-second hold.' })
    expect(jobOutcome('unfollow-master', job)).toEqual({ tone: 'success', text: 'Stopped following the master on 3 listings.' })
    const mixed = {
      status: 'PARTIALLY_COMPLETED', total: 3, processed: 3, succeeded: 2, failed: 1,
      errors: [{ listingId: 'l3', reason: 'Below the floor price (20.00)' }, { listingId: 'l2', reason: 'Quantity not changed: Amazon manages this quantity (FBA)' }],
    }
    expect(jobOutcome('follow-master', mixed)).toEqual({
      tone: 'warning',
      text: 'Following the master on 2 listings · 1 failed: Below the floor price (20.00) · 1 note: Quantity not changed: Amazon manages this quantity (FBA). Nexus sends the prices after a 30-second hold.',
    })
    expect(jobOutcome('set-price', { status: 'FAILED', total: 1, processed: 1, succeeded: 0, failed: 1, errors: [{ listingId: 'l1', reason: 'Listing not found' }] }))
      .toEqual({ tone: 'danger', text: 'Price set on 0 listings · 1 failed: Listing not found.' })
  })
})

describe('one row’s menu (⋯ and right-click read the same list)', () => {
  const live = { url: 'https://www.amazon.de/dp/B0PARENT', externalId: 'B0PARENT' }
  const withLive = family('f1', {
    chips: [chip(AMZ_DE.key, { live: { ...live, state: 'active', listed: 1, notListed: 0, byState: {}, externalId: live.externalId, priceMin: null, priceMax: null, currency: null, quantity: null, fulfillment: null, channelErrorCount: 0, suppressedCount: 0, outOfSyncCount: 0, syncFailedCount: 0, lastSyncedAt: null, duplicates: 0 } }), chip(SHARED.key)],
  })
  const deps = () => ({
    destination: (k: string) => ALL.find((d) => d.key === k) ?? SHARED,
    openListing: vi.fn(), edit: vi.fn(), publish: vi.fn(), copy: vi.fn(),
  })
  it('Open listing · Edit in studio · Open on Amazon · Publish… · Copy SKU · Copy Parent ASIN', () => {
    const d = deps()
    const items = rowMenuItems(withLive, AMZ_DE.key, d)
    expect(items.map((i) => i.label)).toEqual(['Open listing', 'Edit in studio', 'Open on Amazon', 'Publish…', 'Copy SKU', 'Copy Parent ASIN'])
    expect(items.find((i) => i.id === 'channel')).toMatchObject({ href: live.url, target: '_blank' })
    items.find((i) => i.id === 'open')?.onSelect?.()
    expect(d.openListing).toHaveBeenCalledWith(withLive, AMZ_DE.key)
    items.find((i) => i.id === 'publish')?.onSelect?.()
    expect(d.publish).toHaveBeenCalledWith(withLive, AMZ_DE.key)
    items.find((i) => i.id === 'copy-sku')?.onSelect?.()
    expect(d.copy).toHaveBeenCalledWith('F1', 'SKU')
    items.find((i) => i.id === 'copy-id')?.onSelect?.()
    expect(d.copy).toHaveBeenCalledWith('B0PARENT', 'Parent ASIN')
  })
  it('no link and no channel id: those two items are not offered (Shared, or no live data)', () => {
    expect(rowMenuItems(withLive, SHARED.key, deps()).map((i) => i.id)).toEqual(['open', 'edit', 'publish', 'copy-sku'])
    expect(rowMenuItems(family('f2'), AMZ_DE.key, deps()).map((i) => i.id)).toEqual(['open', 'edit', 'publish', 'copy-sku'])
  })
  it('a variation’s own listing wins; its channel id is an ASIN, not a parent ASIN', () => {
    const v = member('v1', 'f1', { chips: [chip(AMZ_DE.key, { listing: { listingId: 'l1', url: 'https://www.amazon.de/dp/B0CHILD', externalId: 'B0CHILD' } as never, live: { url: live.url, externalId: live.externalId } as never })] })
    expect(chipLinks(v.chips[0])).toEqual({ url: 'https://www.amazon.de/dp/B0CHILD', externalId: 'B0CHILD' })
    expect(rowMenuItems(v, AMZ_DE.key, deps()).find((i) => i.id === 'copy-id')?.label).toBe('Copy ASIN')
  })
  it('a row with no chip: Open listing is held and says why', () => {
    const items = rowMenuItems(family('f3', { chips: [] }), null, deps())
    expect(items[0]).toMatchObject({ id: 'open', disabled: true, description: 'Nothing to open: this product has no listing here.' })
  })
  it('acts on the chip under the pointer when the row has it, else where Open opens', () => {
    expect(menuDestination(withLive, SHARED.key, AMZ_DE.key)).toBe(SHARED.key)
    expect(menuDestination(withLive, EBAY_IT.key, AMZ_DE.key)).toBe(AMZ_DE.key)
    expect(menuDestination(withLive, null, null)).toBeNull()
  })
})
