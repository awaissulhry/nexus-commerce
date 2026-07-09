/**
 * EFX P4 — required-aspect push preflight (pure helper).
 */
import { describe, it, expect } from 'vitest'
import { findMissingRequiredAspects, aspectDisplayName, type AspectRequirement } from './ebay-aspect-preflight.js'

const req = (id: string, label?: string): AspectRequirement => ({ id, label, required: true })

describe('findMissingRequiredAspects', () => {
  it('reports a required aspect with no value, naming it', () => {
    const missing = findMissingRequiredAspects(
      { sku: 'A1', aspect_Colore: 'Nero' },
      [req('aspect_Colore', 'Colore (Color)'), req('aspect_Taglia', 'Taglia (Size)')],
    )
    expect(missing).toEqual(['Taglia (Size)'])
  })

  it('matches aspect keys case-insensitively (dual-cased buildFlatRow keys)', () => {
    expect(findMissingRequiredAspects(
      { aspect_colore: 'Nero' },
      [req('aspect_Colore', 'Colore')],
    )).toEqual([])
    expect(findMissingRequiredAspects(
      { aspect_COLORE: 'Nero' },
      [req('aspect_colore', 'colore')],
    )).toEqual([])
  })

  it('treats empty / whitespace / null values as missing', () => {
    expect(findMissingRequiredAspects({ aspect_Colore: '' }, [req('aspect_Colore', 'Colore')])).toEqual(['Colore'])
    expect(findMissingRequiredAspects({ aspect_Colore: '   ' }, [req('aspect_Colore', 'Colore')])).toEqual(['Colore'])
    expect(findMissingRequiredAspects({ aspect_Colore: null }, [req('aspect_Colore', 'Colore')])).toEqual(['Colore'])
  })

  it('ignores non-required aspects', () => {
    expect(findMissingRequiredAspects({}, [{ id: 'aspect_Stagione', required: false }])).toEqual([])
  })

  it('honors push-time injections: brand from _brand, EAN from ean, MPN from mpn', () => {
    expect(findMissingRequiredAspects(
      { _brand: 'Xavia' },
      [req('aspect_Marca', 'Marca')],
    )).toEqual([])
    expect(findMissingRequiredAspects(
      { ean: '1234567890123', mpn: 'MPN-1' },
      [req('aspect_EAN', 'EAN'), req('aspect_MPN', 'MPN')],
    )).toEqual([])
    // But a missing brand with NO _brand fallback is still reported.
    expect(findMissingRequiredAspects({}, [req('aspect_Marca', 'Marca')])).toEqual(['Marca'])
  })

  it('reports multiple missing aspects in schema order', () => {
    const missing = findMissingRequiredAspects({}, [
      req('aspect_Colore', 'Colore (Color)'),
      req('aspect_Taglia', 'Taglia (Size)'),
    ])
    expect(missing).toEqual(['Colore (Color)', 'Taglia (Size)'])
  })
})

describe('aspectDisplayName', () => {
  it('prefers the label, falling back to a name derived from the id', () => {
    expect(aspectDisplayName({ id: 'aspect_Marca', label: 'Marca (Brand)' })).toBe('Marca (Brand)')
    expect(aspectDisplayName({ id: 'aspect_Numero_di_pezzi' })).toBe('Numero di pezzi')
  })
})
