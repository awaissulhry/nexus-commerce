import { describe, expect, it } from 'vitest'
import { cardProducts, cardsPlan, downloadHeld, familyWords, insertMarket, insertStartMarket, pickedWords, qrTarget, togglePick, type InsertProduct } from './insertsModel'

const PRODUCTS: InsertProduct[] = [
  { id: 'a', name: 'Touring jacket', sku: 'TJ', asin: 'B0A', childCount: 12, cards: 13 },
  { id: 'b', name: 'Racing gloves', sku: 'RG', asin: 'B0B', childCount: 4, cards: 4 },
  { id: 'c', name: 'Base layer', sku: 'BL', asin: null, childCount: 0, cards: 0 },
]

describe('package inserts', () => {
  it('counts cards and A4 sheets, four A6 cards per sheet', () => {
    expect(cardsPlan(5, 1)).toEqual({ products: 5, cards: 5, sheets: 2, words: '5 cards on 2 A4 sheets — print the PDF at 4 pages per sheet' })
    expect(cardsPlan(12, 2).words).toBe('24 cards on 6 A4 sheets — print the PDF 2 times, 4 pages per sheet')
    expect(cardsPlan(1, 0)).toMatchObject({ cards: 1, sheets: 1, words: '1 card on 1 A4 sheet — print the PDF at 4 pages per sheet' })
    expect(cardsPlan(900, 1).products).toBe(500)
  })

  it('holds the download until a product with an ASIN is picked', () => {
    expect(downloadHeld({ all: false, picked: [] }, PRODUCTS, 40)).toBe('Pick at least one product family.')
    expect(downloadHeld({ all: false, picked: ['c'] }, PRODUCTS, 40)).toBe('None of the picked families has an Amazon ASIN — they get no card.')
    expect(downloadHeld({ all: true, picked: [] }, PRODUCTS, 0)).toBe('No product has an Amazon ASIN yet — there is nothing to print.')
    expect(downloadHeld({ all: false, picked: ['a', 'c'] }, PRODUCTS, 40)).toBeNull()
  })

  it('counts only picked products with an ASIN, or all of them', () => {
    // A family prints its own card and each variation's: the rows add up as "every product" counts them (live audit A05).
    expect(cardProducts({ all: false, picked: ['a', 'c'] }, PRODUCTS, 40)).toBe(13)
    expect(cardProducts({ all: false, picked: ['a', 'b'] }, PRODUCTS, 40)).toBe(17)
    expect(familyWords(PRODUCTS[0])).toBe('12 variations · ASIN B0A · 13 cards')
    expect(familyWords(PRODUCTS[2])).toBe('no ASIN — no card')
    expect(familyWords({ id: 'd', name: 'Gloves', sku: 'G', asin: 'B0D', childCount: 0, cards: 1 })).toBe('ASIN B0D · 1 card')
    expect(cardProducts({ all: true, picked: [] }, PRODUCTS, 40)).toBe(40)
    expect(cardProducts({ all: true, picked: [] }, PRODUCTS, null)).toBeNull()
    expect(pickedWords({ all: false, picked: ['a', 'c'] }, PRODUCTS, 40)).toBe('2 of 3 picked · 1 without an ASIN gets no card')
    expect(pickedWords({ all: true, picked: [] }, PRODUCTS, 40)).toBe('Every product with an ASIN (40)')
  })

  it('leaves “All” when a product is picked, and points the QR code at Amazon’s own review page', () => {
    expect(togglePick({ all: true, picked: [] }, 'a')).toEqual({ all: false, picked: ['a'] })
    expect(togglePick({ all: false, picked: ['a'] }, 'a')).toEqual({ all: false, picked: [] })
    expect(qrTarget('DE', 'B0A')).toBe('amazon.de/review/create-review?asin=B0A')
    expect(insertMarket('XX').code).toBe('IT')
  })
})

describe('the market the window opens on (audit C5)', () => {
  it('is the page’s market when cards exist for it, Italy otherwise', () => {
    expect(insertStartMarket('DE')).toBe('DE')
    expect(insertStartMarket('gb')).toBe('UK')
    expect(insertStartMarket('NL')).toBe('IT')
    expect(insertStartMarket(null)).toBe('IT')
  })
})
