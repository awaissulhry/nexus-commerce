import { describe, expect, it } from 'vitest'
import { isListingShell, LISTING_SHELL_TYPE, readinessDestinationAllowed, type ListingPlace } from './listing-readiness.js'

// 2026-10-25 — an old eBay listing shell (`AIREON-ALT1`, …) showed on the Amazon Italy Listings page. It belongs only to
// its own eBay listing (docs/listings/READINESS-LISTING-SHELLS-2026-10-25.md).
const place = (channel: string | null, market: string | null, accountId: string | null = null): ListingPlace => ({ channel, market, accountId })
const shell = { productType: LISTING_SHELL_TYPE, ownListings: [place('EBAY', 'IT', 'ebay-1')] }

describe('readinessDestinationAllowed', () => {
  it('a shell: Shared and its own eBay listing only', () => {
    expect(readinessDestinationAllowed(shell, place(null, null))).toBe(true)
    expect(readinessDestinationAllowed(shell, place('EBAY', 'IT', 'ebay-1'))).toBe(true)
    for (const other of [place('AMAZON', 'IT', 'amazon-1'), place('SHOPIFY', 'GLOBAL', 'shop-1'), place('ETSY', 'GLOBAL', 'etsy-1'),
      place('EBAY', 'DE', 'ebay-1'), place('EBAY', 'IT', 'ebay-2')]) {
      expect(readinessDestinationAllowed(shell, other)).toBe(false)
    }
  })

  it('a shell with no listing has no channel destination at all', () => {
    expect(readinessDestinationAllowed({ productType: LISTING_SHELL_TYPE, ownListings: [] }, place('EBAY', 'IT', 'ebay-1'))).toBe(false)
    expect(readinessDestinationAllowed({ productType: LISTING_SHELL_TYPE, ownListings: [] }, place(null, null))).toBe(true)
  })

  it('a listing with no account matches any account of its market; GB is the UK', () => {
    const noAccount = { productType: LISTING_SHELL_TYPE, ownListings: [place('EBAY', 'GB')] }
    expect(readinessDestinationAllowed(noAccount, place('EBAY', 'UK', 'ebay-1'))).toBe(true)
    expect(readinessDestinationAllowed(noAccount, place('EBAY', 'IT', 'ebay-1'))).toBe(false)
  })

  it('every other product: every destination', () => {
    for (const productType of [null, undefined, 'OUTERWEAR']) {
      expect(readinessDestinationAllowed({ productType, ownListings: [] }, place('AMAZON', 'IT', 'amazon-1'))).toBe(true)
    }
  })

  it('isListingShell names the shell type only', () => {
    expect(isListingShell('EBAY_LISTING_SHELL')).toBe(true)
    for (const other of [null, undefined, '', 'OUTERWEAR', 'ebay_listing_shell']) expect(isListingShell(other)).toBe(false)
  })
})
