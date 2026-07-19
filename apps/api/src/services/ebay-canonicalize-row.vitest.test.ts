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
  it('unmapped keys keep their NAME but normalize casing (Body Type stays ghosted, one key)', () => {
    const row: Record<string, unknown> = { aspect_body_type: 'Slim', aspect_marca: 'XAVIA' }
    const n = canonicalizeRowAspects(row)
    expect(row.aspect_Body_type).toBe('Slim')     // unmapped ghost, sentence-cased key
    expect(row.aspect_body_type).toBeUndefined()
    expect(row.aspect_Marca).toBe('XAVIA')        // known key normalizes to displayed casing
    expect(n).toBe(2)
  })
  it('brand twin folds into marca', () => {
    const row: Record<string, unknown> = { aspect_brand: 'XAVIA', aspect_marca: '' }
    canonicalizeRowAspects(row)
    expect(row.aspect_Marca).toBe('XAVIA')
    expect(row.aspect_brand).toBeUndefined()
    expect(row.aspect_marca).toBeUndefined()
  })
})

describe('incident #36b — unmapped case-twins fold to the sentence-cased key', () => {
  it('aspect_chiusura folds into aspect_Chiusura (value preserved, no dupes)', () => {
    const row: Record<string, unknown> = { aspect_Chiusura: 'Zip', aspect_chiusura: 'Zip' }
    canonicalizeRowAspects(row)
    expect(row.aspect_Chiusura).toBe('Zip')
    expect(row.aspect_chiusura).toBeUndefined()
    const only: Record<string, unknown> = { aspect_team_name: 'XAVIA' }
    canonicalizeRowAspects(only)
    expect(only.aspect_Team_name).toBe('XAVIA')
    expect(only.aspect_team_name).toBeUndefined()
  })
})
