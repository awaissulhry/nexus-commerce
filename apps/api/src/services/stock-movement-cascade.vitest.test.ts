/**
 * AS.5 — cascade-side fulfillment resolution: dispatch-guard alignment.
 *
 * outbound-sync's isFbaListing is fail-closed on ANY FBA signal; the cascade
 * used the plain resolver (explicit listing method wins), so an AMAZON
 * listing marked FBM on a product with FBA signals enqueued rows the
 * dispatcher guard-skipped forever — churn + fba-flip-guard false-alarm feed.
 */
import { describe, it, expect } from 'vitest'
import {
  resolveListingFulfillmentMethod,
  resolveCascadePushMethod,
} from './stock-movement.service.js'

describe('AS.5 — resolveCascadePushMethod', () => {
  it('vetoes AMAZON explicit-FBM when the product is FBA (the GALE residual shape)', () => {
    const args = {
      listingFulfillmentMethod: 'FBM',
      channel: 'AMAZON',
      fbaBucket: 0,
      productFulfillmentMethod: 'FBA',
    }
    expect(resolveListingFulfillmentMethod(args)).toBe('FBM') // plain resolver: listing wins
    expect(resolveCascadePushMethod(args)).toBe('FBA') // cascade: aligned with dispatch guard
  })

  it('vetoes AMAZON explicit-FBM when FBA stock is on hand', () => {
    expect(
      resolveCascadePushMethod({
        listingFulfillmentMethod: 'FBM',
        channel: 'AMAZON',
        fbaBucket: 5,
        productFulfillmentMethod: null,
      }),
    ).toBe('FBA')
  })

  it('clean AMAZON FBM listings are unaffected', () => {
    expect(
      resolveCascadePushMethod({
        listingFulfillmentMethod: 'FBM',
        channel: 'AMAZON',
        fbaBucket: 0,
        productFulfillmentMethod: 'FBM',
      }),
    ).toBe('FBM')
  })

  it('merchant channels never get the veto (eBay listing on an FBA-signal product still follows the pool)', () => {
    expect(
      resolveCascadePushMethod({
        listingFulfillmentMethod: null,
        channel: 'EBAY',
        fbaBucket: 5,
        productFulfillmentMethod: 'FBA',
      }),
    ).toBe('FBM')
  })

  it('explicit FBA stays FBA everywhere', () => {
    expect(
      resolveCascadePushMethod({
        listingFulfillmentMethod: 'FBA',
        channel: 'AMAZON',
        fbaBucket: 0,
        productFulfillmentMethod: null,
      }),
    ).toBe('FBA')
  })
})
