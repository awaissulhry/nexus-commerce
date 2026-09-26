/**
 * CHMAP M7 (B1) — the flat-file feed sends a sale the way Amazon's schema has it: `discounted_price` with a start, an end
 * and the value (the same shape as the Listings PATCH), never the unknown `sale_price`, and never without both dates.
 */
import { expect, it } from 'vitest'
import { AmazonFlatFileService } from './flat-file.service.js'
import { amazonDiscountedPrice } from './discounted-price.js'

const svc = new AmazonFlatFileService({} as any, {} as any)
const offerOf = (extra: Record<string, string>) => JSON.parse(svc.buildJsonFeedBody([{ item_sku: 'S1', product_type: 'COAT', purchasable_offer__our_price: '120', purchasable_offer__currency: 'EUR', ...extra } as any], 'IT', 'SELLER'))
  .messages[0].attributes.purchasable_offer[0]

it('sends a dated sale as discounted_price, next to the price, and never as sale_price', () => {
  const offer = offerOf({ purchasable_offer__sale_price: '99.5', purchasable_offer__sale_from_date: '2026-10-01', purchasable_offer__sale_end_date: '2026-10-31' })
  expect(offer.discounted_price).toEqual([{ schedule: [{ start_at: '2026-10-01', end_at: '2026-10-31', value_with_tax: 99.5 }] }])
  expect(offer.our_price).toEqual([{ schedule: [{ value_with_tax: 120 }] }])
  expect(offer).not.toHaveProperty('sale_price')
})

it('leaves out a sale without both dates (Amazon refuses it) and still sends the price', () => {
  for (const dates of [{}, { purchasable_offer__sale_from_date: '2026-10-01' }, { purchasable_offer__sale_end_date: '2026-10-31' }]) {
    const offer = offerOf({ purchasable_offer__sale_price: '99', ...dates })
    expect(offer).not.toHaveProperty('discounted_price'); expect(offer).not.toHaveProperty('sale_price')
    expect(offer.our_price).toEqual([{ schedule: [{ value_with_tax: 120 }] }])
  }
})

it('one shape for every path: the helper the Listings PATCH also uses', () => {
  expect(amazonDiscountedPrice(10, '2026-10-01', '2026-10-31')).toEqual([{ schedule: [{ start_at: '2026-10-01', end_at: '2026-10-31', value_with_tax: 10 }] }])
  expect(amazonDiscountedPrice(10, '2026-10-01', null)).toBeNull()
  expect(amazonDiscountedPrice(null, '2026-10-01', '2026-10-31')).toBeNull()
})

it('CHMAP M7 (B2): the market passed by the caller wins over the five-market maps, which fall back to Italy', () => {
  const attrsOf = (hints?: object) => JSON.stringify(JSON.parse(svc.buildJsonFeedBody([{ item_sku: 'S1', product_type: 'COAT', item_name: 'Jas', purchasable_offer__our_price: '120', purchasable_offer__currency: 'EUR' } as any], 'NL', 'SELLER', {}, hints as any)).messages[0].attributes)
  const nl = attrsOf({ market: { marketplaceId: 'A1805IZSGTT6HS', languageTag: 'nl_NL' } })
  expect(nl).toContain('A1805IZSGTT6HS'); expect(nl).toContain('nl_NL'); expect(nl).not.toContain('APJ6JRA9NG5V4'); expect(nl).not.toContain('it_IT')
  // Without it (the flat-file page serves IT, DE, FR, ES and UK only), the old fallback stands.
  expect(attrsOf()).toContain('APJ6JRA9NG5V4')
})
