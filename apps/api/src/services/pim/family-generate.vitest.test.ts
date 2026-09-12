import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshInTransaction: vi.fn() } }))

const { buildFamilyAxes } = await import('./family-projection.service.js')
const { GenerateRequestError, nearestSibling, renderSku, skuCode } = await import('./family-generate.service.js')

const AXES = buildFamilyAxes(['Colore', 'Taglia'], [{ categoryAttributes: { variations: { Color: 'Nero', Size: 'M' } }, variantAttributes: {} }])

describe('skuCode makes a value SKU-safe without losing which value it was', () => {
  it.each([
    ['Nero', 'NERO'],
    ['Taglia unica', 'TAGLIA-UNICA'],
    ['42.5', '42-5'],
    ['Blu / Verde', 'BLU-VERDE'],
    ['  Rosso  ', 'ROSSO'],
  ])('%s becomes %s', (input, expected) => {
    expect(skuCode(input)).toBe(expected)
  })

  it('keeps two different values different', () => {
    // The failure that matters: two values collapsing to one code would silently produce a SKU collision the
    // operator cannot explain from the values they typed.
    expect(skuCode('XS')).not.toBe(skuCode('XXS'))
  })
})

describe('renderSku', () => {
  it('fills {parent}, {axis} and {axis.code}', () => {
    expect(renderSku('{parent}-{Colore.code}-{Taglia.code}', 'GALE-JACKET', { Colore: 'Rosso', Taglia: 'XXS' }, AXES))
      .toBe('GALE-JACKET-ROSSO-XXS')
    expect(renderSku('{parent}/{Colore}', 'GALE-JACKET', { Colore: 'Rosso' }, AXES)).toBe('GALE-JACKET/Rosso')
  })

  it('accepts the axis under its stored spelling too, because both spellings exist on this catalogue', () => {
    expect(renderSku('{parent}-{Color.code}', 'GALE-JACKET', { Colore: 'Rosso' }, AXES)).toBe('GALE-JACKET-ROSSO')
  })

  it('REFUSES an unknown token by name instead of leaving it in the SKU', () => {
    // A SKU containing a literal `{materiale}` would be created, accepted, and found later by a marketplace.
    expect(() => renderSku('{parent}-{materiale}', 'GALE-JACKET', { Colore: 'Rosso' }, AXES))
      .toThrow(/\{materiale\}/)
    expect(() => renderSku('{parent}-{materiale}', 'GALE-JACKET', {}, AXES)).toThrow(GenerateRequestError)
  })

  /**
   * Found by this test rather than designed in: `{colour}` does NOT refuse, because `canonicalVariantAxis`
   * treats colour/color/farbe/couleur as one dimension, so the token resolves to the family's `Colore` axis.
   * That is the same synonym table the sheet, the eBay push and the coverage counts all match axes through,
   * so refusing it here would make the SKU pattern the one place in the studio where `colour` means nothing.
   * Pinned deliberately: if the synonym table stops resolving it, this fails and someone decides on purpose.
   */
  it('resolves a SYNONYM of an axis rather than refusing it — the one axis vocabulary, applied here too', () => {
    expect(renderSku('{parent}-{colour.code}', 'GALE-JACKET', { Colore: 'Rosso' }, AXES)).toBe('GALE-JACKET-ROSSO')
    expect(renderSku('{parent}-{size.code}', 'GALE-JACKET', { Taglia: 'XXS' }, AXES)).toBe('GALE-JACKET-XXS')
  })

  it('names every unknown token, not just the first', () => {
    try {
      renderSku('{a}-{b}', 'P', {}, AXES)
      throw new Error('should have refused')
    } catch (error) {
      expect((error as Error).message).toContain('{a}')
      expect((error as Error).message).toContain('{b}')
    }
  })
})

describe('nearestSibling', () => {
  const siblings = [
    { id: '1', sku: 'G-NERO-M', values: { Colore: 'Nero', Taglia: 'M' } },
    { id: '2', sku: 'G-NERO-L', values: { Colore: 'Nero', Taglia: 'L' } },
    { id: '3', sku: 'G-GIALLO-M', values: { Colore: 'Giallo', Taglia: 'M' } },
  ]

  it('prefers a match on the FIRST axis when the count of matches ties', () => {
    // Nero+XL matches axis 1 on two siblings and axis 2 on none, so the tie is broken by axis order, then SKU.
    expect(nearestSibling({ Colore: 'Nero', Taglia: 'XL' }, siblings, AXES)?.sku).toBe('G-NERO-L')
  })

  it('a first-axis match outranks a second-axis match', () => {
    const chosen = nearestSibling({ Colore: 'Nero', Taglia: 'XXX' }, siblings, AXES)
    expect(chosen?.values ?? chosen?.sku).toMatch(/NERO/)
  })

  it('is deterministic, so a dry run predicts the commit', () => {
    const a = nearestSibling({ Colore: 'Nero', Taglia: 'XL' }, siblings, AXES)
    const b = nearestSibling({ Colore: 'Nero', Taglia: 'XL' }, [...siblings].reverse(), AXES)
    expect(a?.id).toBe(b?.id)
  })

  it('falls back to the lowest SKU when nothing is in common, rather than to nothing', () => {
    expect(nearestSibling({ Colore: 'Viola', Taglia: 'XXX' }, siblings, AXES)?.sku).toBe('G-GIALLO-M')
  })

  it('returns null for an empty family instead of inventing a source', () => {
    expect(nearestSibling({ Colore: 'Nero' }, [], AXES)).toBeNull()
  })
})
