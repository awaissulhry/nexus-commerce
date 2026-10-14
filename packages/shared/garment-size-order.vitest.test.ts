import { describe, expect, it } from 'vitest'
import { compareGarmentSizes, garmentSizeRank, sortGarmentSizes } from './garment-size-order.js'

const sizes = (values: string[]) => sortGarmentSizes(values, (v) => v)

describe('garment size order', () => {
  it('puts the letter scale in wearing order, not A–Z (the GALE family\'s SKU order)', () => {
    expect(sizes(['3XL', '4XL', '5XL', 'L', 'M', 'S', 'XL', 'XS', 'XXL', 'XXS'])).toEqual(['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL'])
  })

  it('reads 2XL as XXL and XXXL as 3XL, in any case and with spaces', () => {
    expect(garmentSizeRank('2XL')).toBe(garmentSizeRank('XXL'))
    expect(garmentSizeRank('xxxl')).toBe(garmentSizeRank('3XL'))
    expect(garmentSizeRank(' m ')).toBe(garmentSizeRank('M'))
    expect(sizes(['3XL', 'XXL', 'XL'])).toEqual(['XL', 'XXL', '3XL'])
  })

  it('puts numeric sizes in ascending order, after the letters', () => {
    expect(sizes(['52', '44', '60', '46,5', '48'])).toEqual(['44', '46,5', '48', '52', '60'])
    expect(sizes(['46', 'M', '44', 'S'])).toEqual(['S', 'M', '44', '46'])
  })

  it('puts values the scale does not know last, in their first-seen order', () => {
    expect(sizes(['One size', 'M', 'L-T', 'S', 'Tall'])).toEqual(['S', 'M', 'One size', 'L-T', 'Tall'])
    expect(garmentSizeRank('Taglia unica')).toBeNull()
    expect(compareGarmentSizes('Tall', 'Short')).toBe(0)
  })

  it('orders lists of option values position by position', () => {
    const rows = [['M', 'Long'], ['S', 'Short'], ['M', 'Regular'], ['S', 'Long']]
    expect(sortGarmentSizes(rows, (r) => r)).toEqual([['S', 'Short'], ['S', 'Long'], ['M', 'Long'], ['M', 'Regular']])
  })

  it('returns a new array and leaves the input as it was', () => {
    const input = ['L', 'S']
    expect(sizes(input)).toEqual(['S', 'L'])
    expect(input).toEqual(['L', 'S'])
  })
})
