import { describe, expect, it } from 'vitest'
import { newProductWords } from './reviewWords'

/* Wave 2 D4 (Owner decision 10) — the Media tab's review says what "Create reviewed product" creates: the Status column's choice. */
describe('the new product line of the Shopify review', () => {
  it('names the create status in words and where it comes from; Not listed creates nothing', () => {
    expect(newProductWords('ACTIVE')).toBe("Active (the Status column's choice)")
    expect(newProductWords('DRAFT')).toBe("Draft (the Status column's choice)")
    expect(newProductWords(null)).toBe('not created: its Status is Not listed')
  })
})
