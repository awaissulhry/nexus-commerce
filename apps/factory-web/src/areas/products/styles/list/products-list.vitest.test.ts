import { describe, expect, it } from 'vitest'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { BRANDS, GRAINS, ROWS } from '../demo/fixtures'
import type { LooksState } from '../gallery/gallery-model'
import { agreedText, familyWords, marginHintKey, productCardOf, productColumns, protectionWords, sizesWords, thingsBefore, typeWords, whoChoiceOf, whoQuery, withWhoChoice } from './list-model'
import { PHONE_LIST_QUERY } from './use-phone'

/**
 * owb-pd4 step 4.1 (design § 5q "Office › Products", prototype prod.js prodList) — the Products list's pure rules: the columns per
 * money grain (no agreed price without the price grain, no margin without the margin grain — pd1 marks it money.margin), the family words, and the phone card at
 * 375 px (one card per product, money only with its grain).
 */

const row = (over: Partial<(typeof ROWS)[number]> = {}) => ({ ...ROWS[0]!, ...over })

describe('the columns follow the money grains', () => {
  it('the picture first; the agreed price only with the price grain; the margin only with the margin grain', () => {
    expect(productColumns({ price: true, margin: true })).toEqual(['picture', 'product', 'type', 'status', 'revision', 'sizes', 'protection', 'orders', 'price', 'margin', 'more'])
    expect(productColumns({ price: true, margin: false })).not.toContain('margin')
    expect(productColumns({ price: false, margin: true })).not.toContain('price')
    const none = productColumns({ price: false, margin: false })
    expect(none).not.toContain('price')
    expect(none).not.toContain('margin')
    expect(none[0]).toBe('picture')
  })
  it('a cost grain alone (the product office) gives no margin; sales (price + margin grains) reads both; the production manager neither', () => {
    expect(productColumns(GRAINS.product)).not.toContain('margin')
    expect(productColumns(GRAINS.sales)).toEqual(expect.arrayContaining(['price', 'margin']))
    expect(productColumns(GRAINS.production)).not.toContain('price')
    expect(productColumns(GRAINS.production)).not.toContain('margin')
  })
})

describe('the family and the type in words', () => {
  it('"Our range" without a customer, "Made for ⟨customer⟩" with one; the API family wins', () => {
    expect(familyWords(row({ brand: null, family: undefined }))).toEqual({ key: 'family.ourRange' })
    expect(familyWords(row({ brand: { id: BRANDS[0]!.id, code: 'BR-DEMO', name: 'Brand Alpha' }, family: undefined }))).toEqual({ key: 'family.madeFor', params: { customer: 'Brand Alpha' } })
    expect(familyWords(row({ brand: null, family: 'OUR_RANGE' }))).toEqual({ key: 'family.ourRange' })
  })
  it('the type profile\'s name when set (S4 settle 1), else the kind\'s word', () => {
    expect(typeWords(row({ typeName: 'Hoodie', productType: 'OTHER' }))).toEqual({ text: 'Hoodie' })
    expect(typeWords(row({ typeName: null, productType: 'GLOVES' }))).toEqual({ key: 'productType.GLOVES' })
    expect(typeWords(row({ typeName: '  ', productType: 'SUIT' }))).toEqual({ key: 'productType.SUIT' })
  })
  it('sizes, protection, the agreed range and where the margin comes from', () => {
    expect(sizesWords(row({ sizes: ['S', 'M', 'L', 'XL'] }))).toEqual({ text: 'S–XL' })
    expect(sizesWords(row({ sizes: [], mtmAllowed: true }))).toEqual({ key: 'list.mtm' })
    expect(protectionWords(row({ ppeCategory: 'NOT_PPE' }))).toBeNull()
    expect(protectionWords(row({ ppeCategory: 'CATEGORY_II', ppeClass: 'AA' }))).toEqual({ key: 'list.protection.ce', params: { class: 'AA' } })
    expect(protectionWords(row({ ppeCategory: 'CATEGORY_II', ppeClass: null }))).toEqual({ key: 'list.protection.noClass' })
    expect(agreedText({ low: '120', high: '120', count: 1, currency: 'EUR' }, 'en')).toBe('€120.00')
    expect(agreedText({ low: '120', high: '180', count: 2, currency: 'EUR' }, 'en')).toBe('€120.00 – €180.00')
    expect(agreedText(null, 'en')).toBeNull()
    expect(marginHintKey(row({ marginPct: asMoney('margin', '35'), marginFrom: asMoney('margin', 'KEPT' as const) }))).toBe('list.margin.fromKept')
    expect(marginHintKey(row({ marginPct: asMoney('margin', '35'), marginFrom: asMoney('margin', 'KIND' as const) }))).toBe('list.margin.fromKind')
    expect(marginHintKey(row({ marginPct: asMoney('margin', null) }))).toBeNull()
  })
  it('"n things before release" only for a draft the gate checked', () => {
    const gate = { state: 'ready' as const, byStyle: { [ROWS[0]!.id]: { styleId: ROWS[0]!.id, code: 'X', revision: { id: 'r3', revision: 3, status: 'DRAFT' as const }, checked: true, completenessPct: '80', blockers: 2, warnings: 1, first: null, open: 3 } } }
    expect(thingsBefore(row({ draftRevision: 3 }), gate)).toBe(2)
    expect(thingsBefore(row({ draftRevision: null }), gate)).toBeNull()
    expect(thingsBefore(row({ draftRevision: 3 }), undefined)).toBeNull()
  })
})

describe('the phone cards at 375 px', () => {
  const looks: LooksState = { status: 'ready', at: '2026-11-28T08:00:00.000Z', byStyle: {} }
  it('the card list is drawn under 720 px, so a 375 px phone gets cards, never the grid', () => {
    expect(PHONE_LIST_QUERY).toBe('(max-width: 719px)')
    expect(375).toBeLessThan(720)
  })
  it('a card holds no money without its grain', () => {
    const card = productCardOf(row(), { grains: GRAINS.production, looks, locale: 'en' })
    expect(card.price).toBeNull()
    expect(card.margin).toBeNull()
    expect(JSON.stringify(card)).not.toContain('€')
  })
  it('a card shows the agreed price with the price grain and the margin with the margin grain', () => {
    const card = productCardOf(row({ agreedRange: asMoney('price', { low: '250', high: '315', count: 2, currency: 'EUR' as const }), marginPct: asMoney('margin', '31'), marginFrom: asMoney('margin', 'KEPT' as const) }), { grains: GRAINS.owner, looks, locale: 'en' })
    expect(card.price).toBe('€250.00 – €315.00')
    expect(card.margin).toEqual({ pct: '31', hint: 'list.margin.fromKept' })
    expect(card.picture).toBeNull()
    expect(card.family).toEqual({ key: 'family.ourRange' })
  })
  it('the main picture comes from the looks read (the API path through this app)', () => {
    const withPicture: LooksState = { status: 'ready', at: '2026-11-28T08:00:00.000Z', byStyle: { [ROWS[0]!.id]: { styleId: ROWS[0]!.id, picture: { id: 'p1', kind: 'PHOTO', caption: null, look: { url: '/files/f1/look' } }, pictures: 1, colourways: [] } as never } }
    expect(productCardOf(row(), { grains: GRAINS.production, looks: withPicture, locale: 'en' }).picture).toBe('/api/files/f1/look')
  })
})

// ---- owb-pd5 step 5.0 (pd4s s.1): "Our range" / "Made for a customer" send `family=`; one customer sends `brandPartyId` ----
describe('step 5.0 — the family filter is sent to the list read', () => {
  const none = { view: 'open' as const, q: '', type: '', ppe: '', brand: '', family: '' as const }
  it('"Our range" sends family=OUR_RANGE; "Made for a customer" family=FOR_CUSTOMER; one customer only its brandPartyId', () => {
    expect(whoQuery(withWhoChoice(none, 'family:OUR_RANGE'))).toEqual({ family: 'OUR_RANGE' })
    expect(whoQuery(withWhoChoice(none, 'family:FOR_CUSTOMER'))).toEqual({ family: 'FOR_CUSTOMER' })
    expect(whoQuery(withWhoChoice(none, 'brand:p1'))).toEqual({ brandPartyId: 'p1' })
    expect(whoQuery(withWhoChoice(none, ''))).toEqual({})
    expect(whoQuery(withWhoChoice(none, 'family:NOPE'))).toEqual({})
  })
  it('the select shows the choice back; a customer replaces the family (never both sent)', () => {
    expect(whoChoiceOf(withWhoChoice(none, 'family:OUR_RANGE'))).toBe('family:OUR_RANGE')
    const both = withWhoChoice(withWhoChoice(none, 'family:FOR_CUSTOMER'), 'brand:p1')
    expect(both).toMatchObject({ brand: 'p1', family: '' })
    expect(whoChoiceOf(both)).toBe('brand:p1')
  })
})
