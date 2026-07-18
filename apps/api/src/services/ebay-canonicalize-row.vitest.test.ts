// Incident #20 — legacy language-twin aspect keys fold into localized columns.
import { describe, it, expect } from 'vitest'
import { canonicalizeRowAspects } from './ebay-theme-axes.js'

describe('canonicalizeRowAspects', () => {
  it('folds English twins into the localized column (Italian value wins)', () => {
    const row: Record<string, unknown> = { aspect_colore: 'Nero', aspect_Color: 'Black', aspect_size: 'M', sku: 'X' }
    const n = canonicalizeRowAspects(row)
    expect(row.aspect_Colore).toBe('Nero')       // Italian wins (displayed key)
    expect(row.aspect_Taglia).toBe('M')          // English-only value preserved
    expect(row.aspect_Color).toBeUndefined()
    expect(row.aspect_size).toBeUndefined()
    expect(n).toBe(3) // colore→Colore + Color twin + size→Taglia
  })
  it('keeps the displayed sentence-cased key; lowercase twins fold INTO it (incident #34)', () => {
    const row: Record<string, unknown> = { aspect_taglia: 'L' }
    canonicalizeRowAspects(row)
    expect(row.aspect_Taglia).toBe('L')
    expect(row.aspect_taglia).toBeUndefined()
    const untouched: Record<string, unknown> = { aspect_Taglia: 'M' }
    expect(canonicalizeRowAspects(untouched)).toBe(0)
    expect(untouched.aspect_Taglia).toBe('M')
  })
  it('folds condition-group aspects into the structured condition field', () => {
    const row: Record<string, unknown> = { aspect_condizione: 'Nuovo con etichette', condition: '' }
    canonicalizeRowAspects(row)
    expect(row.condition).toBe('Nuovo con etichette')
    expect(row.aspect_condizione).toBeUndefined()
    const row2: Record<string, unknown> = { aspect_condition: 'NEW', condition: 'NEW_WITH_TAGS' }
    canonicalizeRowAspects(row2)
    expect(row2.condition).toBe('NEW_WITH_TAGS') // structured field wins
    expect(row2.aspect_condition).toBeUndefined()
  })
  it('leaves unmapped keys untouched (Body Type stays ghosted by design)', () => {
    const row: Record<string, unknown> = { aspect_body_type: 'Slim', aspect_marca: 'XAVIA' }
    const n = canonicalizeRowAspects(row)
    expect(row.aspect_body_type).toBe('Slim')     // unmapped ghost untouched
    expect(row.aspect_Marca).toBe('XAVIA')        // known key normalizes to displayed casing
    expect(n).toBe(1)
  })
  it('brand twin folds into marca', () => {
    const row: Record<string, unknown> = { aspect_brand: 'XAVIA', aspect_marca: '' }
    canonicalizeRowAspects(row)
    expect(row.aspect_Marca).toBe('XAVIA')
    expect(row.aspect_brand).toBeUndefined()
    expect(row.aspect_marca).toBeUndefined()
  })
})
