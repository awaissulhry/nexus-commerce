/**
 * Locks the axis-value lookup that silently sent the WRONG IMAGES to eBay.
 *
 * imageAxisPreference held English "Color" while rows carried aspect_Colore, so
 * `aspect_${axis}` matched nothing and every variant fell through to Amazon-CDN
 * fallback images. This class of bug never errors — it publishes a plausible
 * but wrong listing — so it must be held by tests.
 */
import { describe, it, expect } from 'vitest'
import { axisValueOfRow } from './ebay-variation-push.service.js'

describe('axisValueOfRow — synonym-aware image axis lookup', () => {
  it('THE REGRESSION: English axis name finds the Italian row key', () => {
    expect(axisValueOfRow({ aspect_Colore: 'Nero' }, 'Color')).toBe('nero')
  })
  it('and the reverse: Italian axis name finds an English row key', () => {
    expect(axisValueOfRow({ aspect_Color: 'Nero' }, 'Colore')).toBe('nero')
  })
  it('works for German and French spellings of the same dimension', () => {
    expect(axisValueOfRow({ aspect_Farbe: 'Schwarz' }, 'Colore')).toBe('schwarz')
    expect(axisValueOfRow({ aspect_Colore: 'Nero' }, 'Couleur')).toBe('nero')
  })
  it('resolves the SIZE dimension too (Taglia/Size/Größe)', () => {
    expect(axisValueOfRow({ aspect_Taglia: 'M' }, 'Size')).toBe('m')
    expect(axisValueOfRow({ aspect_Size: 'L' }, 'Taglia')).toBe('l')
  })
  it('exact-key fast path still wins and is unchanged', () => {
    expect(axisValueOfRow({ aspect_Colore: 'Nero', aspect_Color: 'Black' }, 'Colore')).toBe('nero')
  })
  it('handles multi-word axis names (spaces ↔ underscores)', () => {
    expect(axisValueOfRow({ aspect_Tipo_di_prodotto: 'Giacca' }, 'Tipo di prodotto')).toBe('giacca')
  })
  it('never matches a DIFFERENT dimension', () => {
    expect(axisValueOfRow({ aspect_Taglia: 'M' }, 'Colore')).toBe('')
    expect(axisValueOfRow({ aspect_Materiale: 'Pelle' }, 'Colore')).toBe('')
  })
  it('ignores blank values and a missing axis', () => {
    expect(axisValueOfRow({ aspect_Colore: '   ' }, 'Colore')).toBe('')
    expect(axisValueOfRow({}, 'Colore')).toBe('')
    expect(axisValueOfRow({ aspect_Colore: 'Nero' }, '')).toBe('')
  })
  it('preserves a PIPE-ENCODED value whole (Rosso | Uomo)', () => {
    expect(axisValueOfRow({ aspect_Colore: 'Rosso | Uomo' }, 'Color')).toBe('rosso | uomo')
  })
})
