/**
 * CHMAP M7 (B3) — the Best Offer labels say what the push does with each price: the floor is eBay's autoDeclinePrice,
 * the ceiling its autoAcceptPrice (`ebay-variation-push.service.ts`). They were the wrong way round (a money risk).
 */
import { expect, it } from 'vitest'
import { ebaySpecFromCache } from './ebay.js'

it('labels the floor as auto-decline and the ceiling as auto-accept, in both languages', () => {
  const spec = ebaySpecFromCache({ marketplace: 'IT', categoryId: '177104', aspects: [] })
  const field = (key: string) => spec.fields.find(f => f.key === key)!
  expect(field('bestOfferFloor')).toMatchObject({ englishLabel: 'Best offer auto-decline below', label: 'Rifiuto automatico sotto' })
  expect(field('bestOfferCeiling')).toMatchObject({ englishLabel: 'Best offer auto-accept from', label: 'Accettazione automatica da' })
  expect(field('bestOfferFloor').helpText).toContain('autoDeclinePrice')
  expect(field('bestOfferCeiling').helpText).toContain('autoAcceptPrice')
})
