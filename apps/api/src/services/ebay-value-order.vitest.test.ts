// Incident #39 — deterministic value ordering, one authority for all consumers.
import { describe, it, expect } from 'vitest'
import { orderAxisValues } from './ebay-value-order.js'

describe('orderAxisValues', () => {
  it('sizes order canonically (wearing order), not alphabetically', () => {
    expect(orderAxisValues('Taglia', ['3XL', '4XL', '5XL', 'L', 'M', 'S', 'XL', 'XS', 'XXL', 'XXS']))
      .toEqual(['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL'])
  })
  it('size synonym spellings hit the same ranking (Size == Taglia dimension)', () => {
    expect(orderAxisValues('Size', ['L', 'XS', 'M'])).toEqual(['XS', 'M', 'L'])
  })
  it('operator stored order ALWAYS wins, unknowns after, alphabetical', () => {
    expect(orderAxisValues('Taglia', ['S', 'M', 'L', 'Speciale'], ['L', 'M', 'S']))
      .toEqual(['L', 'M', 'S', 'Speciale'])
  })
  it('numeric sizes rank numerically after the letter scale', () => {
    expect(orderAxisValues('Taglia', ['50', '46', 'XL', '48', 'S']))
      .toEqual(['S', 'XL', '46', '48', '50'])
  })
  it('non-size axes are locale-stable alphabetical', () => {
    expect(orderAxisValues('Colore', ['Verde', 'Grigio', 'Nero'])).toEqual(['Grigio', 'Nero', 'Verde'])
  })
  it('idempotent: ordering an ordered list is a no-op (no oscillation)', () => {
    const once = orderAxisValues('Taglia', ['XXS', 'M', '3XL'])
    expect(orderAxisValues('Taglia', once)).toEqual(once)
  })
  it('dedupes case-insensitively, first spelling wins', () => {
    expect(orderAxisValues('Colore', ['Nero', 'NERO', 'Verde'])).toEqual(['Nero', 'Verde'])
  })
})
