/**
 * Unit tests for dedupeSpecsByValueFingerprint — the variation-axis collision
 * resolver. Guards the AIREON "missing Team Name" bug: a stray aspect that
 * duplicates a real axis's value set (Team Name = Tipo di prodotto = {Giacca,
 * Pantaloni}) must NOT win over the axis present on more variants, or every
 * variant lacking the stray gets blocked by the missing-axis pre-flight.
 */

import { describe, it, expect } from 'vitest'
import { dedupeSpecsByValueFingerprint } from './ebay-variation-push.service.js'

const spec = (name: string, values: string[], coverage: number) => ({
  name,
  values: new Set(values),
  coverage,
})

describe('dedupeSpecsByValueFingerprint', () => {
  it('keeps the higher-coverage axis when two share a value set (the Team Name bug)', () => {
    // Team Name (stray) on 24 variants; Tipo di prodotto (real) on all 40.
    const out = dedupeSpecsByValueFingerprint([
      spec('Team Name', ['Giacca', 'Pantaloni'], 24),
      spec('Tipo di prodotto', ['Giacca', 'Pantaloni'], 40),
      spec('Taglia', ['S', 'M', 'L'], 40),
    ])
    expect(out.map((s) => s.name)).toEqual(['Tipo di prodotto', 'Taglia'])
  })

  it('drops the stray regardless of its position and preserves survivor order', () => {
    const out = dedupeSpecsByValueFingerprint([
      spec('Colore', ['Nero', 'Blu'], 40),
      spec('Team Name', ['Giacca', 'Pantaloni'], 24),
      spec('Tipo di prodotto', ['Giacca', 'Pantaloni'], 40),
      spec('Taglia', ['S', 'M'], 40),
    ])
    expect(out.map((s) => s.name)).toEqual(['Colore', 'Tipo di prodotto', 'Taglia'])
  })

  it('keeps the incumbent on a coverage tie (eBay-locale-name-wins preserved)', () => {
    // Colore is written first (eBay itemSpecifics); Color is the English alias.
    const out = dedupeSpecsByValueFingerprint([
      spec('Colore', ['Nero', 'Blu'], 40),
      spec('Color', ['Nero', 'Blu'], 40),
    ])
    expect(out.map((s) => s.name)).toEqual(['Colore'])
  })

  it('does not collapse axes that carry different value sets', () => {
    const out = dedupeSpecsByValueFingerprint([
      spec('Colore', ['Nero', 'Blu'], 40),
      spec('Taglia', ['S', 'M', 'L'], 40),
    ])
    expect(out.map((s) => s.name)).toEqual(['Colore', 'Taglia'])
  })

  it('fingerprints values case-insensitively', () => {
    const out = dedupeSpecsByValueFingerprint([
      spec('B', ['giacca', 'PANTALONI'], 10),
      spec('A', ['Giacca', 'Pantaloni'], 30),
    ])
    expect(out.map((s) => s.name)).toEqual(['A'])
  })

  it('is a no-op when there are no collisions', () => {
    const input = [
      spec('Tipo di prodotto', ['Giacca', 'Pantaloni'], 40),
      spec('Colore', ['Nero', 'Blu'], 40),
      spec('Taglia', ['S', 'M', 'L'], 40),
    ]
    const out = dedupeSpecsByValueFingerprint(input)
    expect(out).toEqual(input)
  })
})
