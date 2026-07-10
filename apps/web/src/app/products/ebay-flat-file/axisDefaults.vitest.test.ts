import { describe, it, expect } from 'vitest'
import { localizedAxisName, marketplaceDefaultAxes } from './axisDefaults.pure'

describe('localizedAxisName', () => {
  it('prefers the localized name over the English gloss', () => {
    expect(localizedAxisName('Colore (Color)')).toBe('Colore')
    expect(localizedAxisName('Taglia (Size)')).toBe('Taglia')
  })

  it('passes a custom axis with no gloss through unchanged', () => {
    expect(localizedAxisName('Tipo di prodotto')).toBe('Tipo di prodotto')
  })

  it('leaves an already-English label unchanged', () => {
    expect(localizedAxisName('Color')).toBe('Color')
  })

  it('strips only the trailing parenthetical, preserving internal text', () => {
    expect(localizedAxisName('Materiale principale (Main Material)')).toBe('Materiale principale')
  })

  it('trims surrounding whitespace', () => {
    expect(localizedAxisName('  Colore (Color)  ')).toBe('Colore')
  })

  it('falls back to the raw label when stripping empties it', () => {
    expect(localizedAxisName('(Color)')).toBe('(Color)')
  })

  it('handles empty / nullish input safely', () => {
    expect(localizedAxisName('')).toBe('')
    expect(localizedAxisName(undefined as unknown as string)).toBe('')
  })
})

describe('marketplaceDefaultAxes', () => {
  it('returns Italian defaults for IT', () => {
    expect(marketplaceDefaultAxes('IT')).toEqual(['Colore', 'Taglia'])
  })

  it('accepts the EBAY_ prefix and mixed case', () => {
    expect(marketplaceDefaultAxes('EBAY_IT')).toEqual(['Colore', 'Taglia'])
    expect(marketplaceDefaultAxes('it')).toEqual(['Colore', 'Taglia'])
  })

  it('returns localized defaults for other EU markets', () => {
    expect(marketplaceDefaultAxes('DE')).toEqual(['Farbe', 'Größe'])
    expect(marketplaceDefaultAxes('FR')).toEqual(['Couleur', 'Taille'])
    expect(marketplaceDefaultAxes('ES')).toEqual(['Color', 'Talla'])
  })

  it('falls back to English for unknown / missing marketplace', () => {
    expect(marketplaceDefaultAxes('US')).toEqual(['Color', 'Size'])
    expect(marketplaceDefaultAxes(undefined)).toEqual(['Color', 'Size'])
    expect(marketplaceDefaultAxes('')).toEqual(['Color', 'Size'])
  })

  it('returns a fresh array (no shared mutable reference)', () => {
    const a = marketplaceDefaultAxes('IT')
    a.push('Mutated')
    expect(marketplaceDefaultAxes('IT')).toEqual(['Colore', 'Taglia'])
  })
})
