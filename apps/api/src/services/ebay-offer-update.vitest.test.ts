/**
 * Plan F item 3 (2026-10-05) — the pure offer bodies of the eBay variation push (`ebay-offer-update.ts`).
 *
 * updateOffer REPLACES the whole offer, so the update starts from the offer eBay holds and puts ours on top: everything
 * Nexus does not set (VAT, store categories, second category, product safety data, original retail price, eBay Plus, …)
 * goes back to eBay unchanged. A new offer is ours only, the shape the push has always sent.
 *
 * Every value here is synthetic.
 */
import { describe, expect, it } from 'vitest'
import { newOfferBody, offerUpdateBody, type VariationOfferOurs } from './ebay-offer-update.js'

const ours = (over: Partial<VariationOfferOurs> = {}): VariationOfferOurs => ({
  sku: 'FIXTURE-S', marketplaceId: 'EBAY_IT', format: 'FIXED_PRICE', categoryId: '1000', subtitle: 'Our subtitle',
  availableQuantity: 3, price: { value: '49.90', currency: 'EUR' },
  policies: { fulfillmentPolicyId: 'our-fulfil', paymentPolicyId: 'our-pay', returnPolicyId: 'our-return' },
  merchantLocationKey: 'our-location', quantityLimitPerBuyer: null, ...over,
})

/** eBay's getOffer answer for a published group member, with the values a thin body used to delete. */
const live = () => ({
  offerId: 'fp-fixture', sku: 'FIXTURE-S', marketplaceId: 'EBAY_IT', format: 'FIXED_PRICE', status: 'PUBLISHED',
  listing: { listingId: '100000000001', listingStatus: 'ACTIVE', soldQuantity: 2 },
  listingDescription: '<p>eBay holds the group description</p>',
  availableQuantity: 9, categoryId: '2000', secondaryCategoryId: '3000', subtitle: 'eBay subtitle',
  listingDuration: 'GTC', includeCatalogProductDetails: true, hideBuyerDetails: true, lotSize: 2,
  merchantLocationKey: 'ebay-location', quantityLimitPerBuyer: 4,
  storeCategoryNames: ['/Fixture store/Helmets'],
  tax: { vatPercentage: 22, applyTax: true, thirdPartyTaxCategory: 'FIXTURE_TAX' },
  pricingSummary: {
    price: { value: '59.90', currency: 'EUR' },
    originalRetailPrice: { value: '79.90', currency: 'EUR' },
    minimumAdvertisedPrice: { value: '55.00', currency: 'EUR' },
    pricingVisibility: 'PRE_CHECKOUT',
  },
  listingPolicies: {
    fulfillmentPolicyId: 'ebay-fulfil', paymentPolicyId: 'ebay-pay', returnPolicyId: 'ebay-return',
    eBayPlusIfEligible: true,
    shippingCostOverrides: [{ priority: 1, shippingServiceType: 'DOMESTIC', shippingCost: { value: '0.00', currency: 'EUR' } }],
    bestOfferTerms: { bestOfferEnabled: false },
  },
  regulatory: { manufacturer: { companyName: 'Fixture Maker' }, productSafety: { statements: ['fixture-statement'] } },
  charity: { charityId: 'fixture-charity', donationPercentage: '10' },
  extendedProducerResponsibility: { ecoParticipationFee: { value: '0.10', currency: 'EUR' } },
})

describe('offerUpdateBody — eBay\'s offer with ours on top', () => {
  it('keeps what Nexus does not set: VAT, store categories, second category, product safety, original retail price and MAP, eBay Plus, lot size, charity', () => {
    const body = offerUpdateBody(live(), ours())
    expect(body.tax).toEqual({ vatPercentage: 22, applyTax: true, thirdPartyTaxCategory: 'FIXTURE_TAX' })
    expect(body.storeCategoryNames).toEqual(['/Fixture store/Helmets'])
    expect(body.secondaryCategoryId).toBe('3000')
    expect(body.regulatory).toEqual(live().regulatory)
    expect(body.pricingSummary).toEqual({
      price: { value: '49.90', currency: 'EUR' },
      originalRetailPrice: { value: '79.90', currency: 'EUR' },
      minimumAdvertisedPrice: { value: '55.00', currency: 'EUR' },
      pricingVisibility: 'PRE_CHECKOUT',
    })
    expect(body.listingPolicies).toEqual({
      fulfillmentPolicyId: 'our-fulfil', paymentPolicyId: 'our-pay', returnPolicyId: 'our-return',
      eBayPlusIfEligible: true, shippingCostOverrides: live().listingPolicies.shippingCostOverrides,
    })
    expect(body).toMatchObject({ lotSize: 2, hideBuyerDetails: true, listingDuration: 'GTC', includeCatalogProductDetails: true,
      charity: live().charity, extendedProducerResponsibility: live().extendedProducerResponsibility })
  })

  it('drops what getOffer returns but updateOffer does not take: offerId, status, listing, the description, Best Offer', () => {
    const body = offerUpdateBody(live(), ours())
    for (const key of ['offerId', 'status', 'listing', 'listingDescription']) expect(key in body, key).toBe(false)
    expect('bestOfferTerms' in (body.listingPolicies as object)).toBe(false)
  })

  it('ours replace eBay\'s: quantity, price, policy ids, location, category, subtitle, Max per buyer', () => {
    const body = offerUpdateBody(live(), ours({ quantityLimitPerBuyer: 2 }))
    expect(body).toMatchObject({
      sku: 'FIXTURE-S', marketplaceId: 'EBAY_IT', format: 'FIXED_PRICE', availableQuantity: 3, categoryId: '1000',
      subtitle: 'Our subtitle', merchantLocationKey: 'our-location', quantityLimitPerBuyer: 2,
    })
    expect((body.pricingSummary as { price: unknown }).price).toEqual({ value: '49.90', currency: 'EUR' })
  })

  it('quantity 0 is sent as 0 (a deactivate), not left to eBay', () => {
    expect(offerUpdateBody(live(), ours({ availableQuantity: 0 })).availableQuantity).toBe(0)
  })

  it('a blank subtitle, category, policy id or location keeps eBay\'s', () => {
    const body = offerUpdateBody(live(), ours({ subtitle: '   ', categoryId: '', merchantLocationKey: null, policies: { fulfillmentPolicyId: 'our-fulfil' } }))
    expect(body).toMatchObject({ subtitle: 'eBay subtitle', categoryId: '2000', merchantLocationKey: 'ebay-location' })
    expect(body.listingPolicies).toMatchObject({ fulfillmentPolicyId: 'our-fulfil', paymentPolicyId: 'ebay-pay', returnPolicyId: 'ebay-return' })
  })

  it('a blank Max per buyer keeps eBay\'s; eBay holding none (or one it cannot take back) sends none', () => {
    expect(offerUpdateBody(live(), ours()).quantityLimitPerBuyer).toBe(4)
    const { quantityLimitPerBuyer: _none, ...withoutLimit } = live()
    expect('quantityLimitPerBuyer' in offerUpdateBody(withoutLimit, ours())).toBe(false)
    expect('quantityLimitPerBuyer' in offerUpdateBody({ ...live(), quantityLimitPerBuyer: 0 }, ours())).toBe(false)
  })

  it('VAT is always eBay\'s: none held → none sent (Nexus invents nothing)', () => {
    const { tax: _tax, ...noTax } = live()
    expect('tax' in offerUpdateBody(noTax, ours())).toBe(false)
  })

  it('never changes eBay\'s answer it was given', () => {
    const answer = live()
    offerUpdateBody(answer, ours({ quantityLimitPerBuyer: 2 }))
    expect(answer).toEqual(live())
  })
})

describe('newOfferBody — a new offer is ours only, as before', () => {
  it('the shape the push has always sent: no description, no Best Offer, no VAT; blank parts left out', () => {
    expect(newOfferBody(ours())).toEqual({
      sku: 'FIXTURE-S', marketplaceId: 'EBAY_IT', format: 'FIXED_PRICE', categoryId: '1000', subtitle: 'Our subtitle',
      availableQuantity: 3, pricingSummary: { price: { value: '49.90', currency: 'EUR' } },
      listingPolicies: { fulfillmentPolicyId: 'our-fulfil', paymentPolicyId: 'our-pay', returnPolicyId: 'our-return' },
      merchantLocationKey: 'our-location',
    })
    expect(newOfferBody(ours({ subtitle: ' ', categoryId: '', policies: {}, merchantLocationKey: undefined }))).toEqual({
      sku: 'FIXTURE-S', marketplaceId: 'EBAY_IT', format: 'FIXED_PRICE', availableQuantity: 3,
      pricingSummary: { price: { value: '49.90', currency: 'EUR' } }, listingPolicies: {},
    })
  })
  it('Max per buyer only when ours is set', () => {
    expect(newOfferBody(ours({ quantityLimitPerBuyer: 5 })).quantityLimitPerBuyer).toBe(5)
    expect('quantityLimitPerBuyer' in newOfferBody(ours())).toBe(false)
  })
})
