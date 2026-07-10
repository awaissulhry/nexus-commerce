import { describe, it, expect } from 'vitest'
import {
  aspectKeyToAxisName,
  intersectPickedWithResolved,
  mapResolvedToObservedKeys,
  resolvedAxisFor,
  buildImageBuckets,
  unionThemeOptions,
  type ResolvedAxis,
} from './resolvedAxes.pure'

const R = (name: string, key: string, values: string[]): ResolvedAxis => ({ name, key, values })

describe('aspectKeyToAxisName', () => {
  it('strips the aspect_ prefix and un-underscores', () => {
    expect(aspectKeyToAxisName('aspect_Tipo_di_prodotto')).toBe('Tipo di prodotto')
    expect(aspectKeyToAxisName('aspect_Color')).toBe('Color')
  })
  it('passes through a bare name unchanged', () => {
    expect(aspectKeyToAxisName('Colore')).toBe('Colore')
  })
})

describe('intersectPickedWithResolved (task 1 — modal axis order seed)', () => {
  const resolved = [
    R('Tipo di prodotto', 'tipo di prodotto', ['Giacca', 'Pantaloni']),
    R('Color', '__dim0__', ['Crema e Vino', 'Nero Neo']),
    R('Size', '__dim1__', ['S', 'M', 'L']),
  ]

  it('orders resolved axes by the stored picked sequence', () => {
    // operator saved Size-first, then Color, then Tipo
    const picked = ['Size', 'Color', 'Tipo di prodotto']
    expect(intersectPickedWithResolved(picked, resolved)).toEqual(['Size', 'Color', 'Tipo di prodotto'])
  })

  it('drops a ghost picked axis (Team Name) — it can never re-appear', () => {
    const picked = ['Team Name', 'Color', 'Size']
    // Team Name has no resolved match → excluded; ranked axes keep picked order,
    // unranked (Tipo) appended in resolved order.
    expect(intersectPickedWithResolved(picked, resolved)).toEqual(['Color', 'Size', 'Tipo di prodotto'])
  })

  it('matches picked names to resolved via synonym key (Colore → Color)', () => {
    const picked = ['Colore', 'Taglia']
    expect(intersectPickedWithResolved(picked, resolved)).toEqual(['Color', 'Size', 'Tipo di prodotto'])
  })

  it('empty picked → resolved order preserved', () => {
    expect(intersectPickedWithResolved([], resolved)).toEqual(['Tipo di prodotto', 'Color', 'Size'])
  })
})

describe('mapResolvedToObservedKeys (task 2 — cockpit matrix)', () => {
  it('returns observed keys in resolved order, dropping ghosts', () => {
    const resolved = [
      R('Color', '__dim0__', ['A', 'B']),
      R('Size', '__dim1__', ['S', 'M']),
    ]
    // cells store Italian keys + a ghost "Team Name"
    const observed = ['Team Name', 'Colore', 'Taglia']
    expect(mapResolvedToObservedKeys(resolved, observed)).toEqual(['Colore', 'Taglia'])
  })

  it('drops a resolved axis that has no observed cell key', () => {
    const resolved = [
      R('Tipo di prodotto', 'tipo di prodotto', ['Giacca']),
      R('Color', '__dim0__', ['A', 'B']),
    ]
    const observed = ['Colore'] // no Tipo di prodotto in cells
    expect(mapResolvedToObservedKeys(resolved, observed)).toEqual(['Colore'])
  })

  it('does not reuse the same observed key for two resolved axes', () => {
    const resolved = [R('Color', '__dim0__', ['A']), R('Colour', '__dim0__', ['A'])]
    const observed = ['Colore']
    expect(mapResolvedToObservedKeys(resolved, observed)).toEqual(['Colore'])
  })
})

describe('resolvedAxisFor', () => {
  const resolved = [R('Color', '__dim0__', ['A', 'B']), R('Size', '__dim1__', ['S'])]
  it('finds by synonym key across spellings', () => {
    expect(resolvedAxisFor(resolved, 'Colore')?.name).toBe('Color')
    expect(resolvedAxisFor(resolved, 'Taglia')?.name).toBe('Size')
  })
  it('returns null when absent', () => {
    expect(resolvedAxisFor(resolved, 'Team Name')).toBeNull()
  })
})

describe('buildImageBuckets (task 3 — SAFETY: never hide a saved bucket)', () => {
  it('clean resolved values only when storage agrees', () => {
    const { values, unmatched } = buildImageBuckets(
      ['Crema e Vino', 'Nero Neo'],
      ['Crema e Vino', 'Nero Neo'],
      ['Crema e Vino', 'Nero Neo'],
    )
    expect(values).toEqual(['Crema e Vino', 'Nero Neo'])
    expect(unmatched).toEqual([])
  })

  it('keeps a polluted stored value visible AND flags it unmatched', () => {
    // resolved is the clean 2; storage has 4 polluted variants
    const { values, unmatched } = buildImageBuckets(
      ['Crema e Vino', 'Nero Neo'],
      ['Crema e Vino - Giacca', 'Nero Neo - Pantaloni'],
      [],
    )
    expect(values).toEqual(['Crema e Vino', 'Nero Neo', 'Crema e Vino - Giacca', 'Nero Neo - Pantaloni'])
    expect(unmatched).toEqual(['Crema e Vino - Giacca', 'Nero Neo - Pantaloni'])
  })

  it('de-dupes case-insensitively but keeps the storage spelling', () => {
    const { values } = buildImageBuckets(['Crema e Vino'], ['crema e vino'], [])
    expect(values).toEqual(['Crema e Vino'])
  })

  it('fallback (no resolved) = observed values, no warnings', () => {
    const { values, unmatched } = buildImageBuckets(null, ['ignored'], ['A', 'B', 'A'])
    expect(values).toEqual(['A', 'B'])
    expect(unmatched).toEqual([])
  })
})

describe('unionThemeOptions (task 4 — theme combobox)', () => {
  it('unions schema axes with observed aspect keys, synonym-deduped', () => {
    const opts = unionThemeOptions(
      ['Colore', 'Taglia'],                       // schema variant-eligible
      ['aspect_Tipo_di_prodotto', 'aspect_Color'], // observed on rows (Color folds to Colore)
    )
    expect(opts).toEqual(['Colore', 'Taglia', 'Tipo di prodotto'])
  })

  it('prefers candidates first when provided', () => {
    const opts = unionThemeOptions(['Colore'], ['aspect_Scollatura'], ['Colore', 'Taglia', 'Scollatura'])
    expect(opts).toEqual(['Colore', 'Taglia', 'Scollatura'])
  })

  it('keeps the first-seen spelling for a folded dimension', () => {
    const opts = unionThemeOptions(['Color'], ['aspect_Colore'])
    expect(opts).toEqual(['Color'])
  })
})
