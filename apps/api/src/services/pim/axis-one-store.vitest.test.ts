/**
 * Step 2.6a (A-27, R-23) — a child's size and colour live in ONE store: `categoryAttributes.variations`.
 *
 * Two halves, one claim: the sheet shows what the publishers send, and a sheet edit lands where they read.
 * - READ: the master cell is the resolver; every publisher reads `storedVariationValues`
 *   (`variations`, then `variantAttributes`). Measured on production 2026-09-23: the flat
 *   `categoryAttributes.size` key holds 0 values, and one child (`xriser-bla-l`, local) carries
 *   `size: null` over a stored `Size: 'L'` — the sheet showed it empty while eBay was sent `L`.
 * - WRITE: the sheet mirrored an axis edit into `variations` only for a DECLARED axis. `xracing` declares
 *   none, so a size edit there landed in the flat key only — shown, never published.
 *
 * The end-to-end arms (real PostgreSQL through `applyProductBulkEdits`) are in `variation-one-writer.vitest.test.ts`.
 */
import { describe, expect, it } from 'vitest'

import { resolveAttributes } from './attribute-resolver.js'
import { storedVariationValues } from './stored-variation-projection.js'
import { variationAttributePatch } from './shared-variation-values.js'


type Bags = { categoryAttributes?: Record<string, unknown>; variantAttributes?: Record<string, unknown> }
const parent = { id: 'parent', parentId: null, localizedContent: {}, variantAttributes: {}, categoryAttributes: { size: 'Parent size' } }
const child = ({ categoryAttributes = {}, variantAttributes = {} }: Bags) =>
  ({ ...parent, id: 'child', parentId: parent.id, categoryAttributes, variantAttributes })
/** What the sheet shows, next to what every publisher sends. */
const shownAndSent = (bags: Bags, axis = 'Size') => {
  const product = child(bags)
  const resolved = resolveAttributes({ product: product as any, parent: parent as any })
  return { shown: resolved.size?.value, color: resolved.color, sent: storedVariationValues(product, [axis])[axis] }
}

describe('READ — the sheet shows the store the publishers send', () => {
  it('an empty flat key no longer hides the stored size (xriser-bla-l, measured)', () => {
    const r = shownAndSent({ categoryAttributes: { size: null, variations: { Size: 'L', Color: 'Nero' } } })
    expect(r).toMatchObject({ shown: 'L', sent: 'L' })
  })
  it('a flat value that disagrees loses to the store', () => {
    expect(shownAndSent({ categoryAttributes: { size: 'M', variations: { Size: 'L' } } })).toMatchObject({ shown: 'L', sent: 'L' })
  })
  it('the legacy bag still answers when variations has no value (as storedVariationValues does)', () => {
    expect(shownAndSent({ categoryAttributes: { size: 'M' }, variantAttributes: { Taglia: 'XS' } }, 'Taglia')).toMatchObject({ shown: 'XS', sent: 'XS' })
  })
  it('the store beats the legacy bag when they disagree (AIR-MESH-JACKET-MEN-XXL-BLACK, production)', () => {
    expect(shownAndSent({ categoryAttributes: { variations: { Size: 'XXL' } }, variantAttributes: { Taglia: 'XS' } }, 'Size'))
      .toMatchObject({ shown: 'XXL', sent: 'XXL' })
  })
  it('control — a plain attribute: no axis value anywhere, the flat key is read', () => {
    expect(shownAndSent({ categoryAttributes: { size: 'M' } }).shown).toBe('M')
  })
  it('control — nothing on the child: the parent value still inherits', () => {
    expect(shownAndSent({}).shown).toBe('Parent size')
  })
  it('a conflict in the store is shown as a conflict, never hidden by the flat key', () => {
    const r = shownAndSent({ categoryAttributes: { color: 'Rosso', variations: { Color: 'Nero', Colore: 'Black' } } })
    expect(r.color?.value).toBeNull()
    expect(r.color?.warnings?.join(' ')).toContain('Conflicting variant attributes')
  })
})

describe('WRITE — a sheet edit lands in the store', () => {
  const held = { categoryAttributes: { variations: { Size: 'L' } }, variantAttributes: {} }
  it('an axis the child already holds is written even when the family declares none (xracing)', () => {
    expect(variationAttributePatch(held, [], { size: 'XL' }, [])).toEqual({ changed: true, set: { Size: 'XL' }, unset: [], legacyDrop: [] })
    expect(variationAttributePatch(held, [], {}, ['size'])).toEqual({ changed: true, set: {}, unset: ['Size'], legacyDrop: [] })
  })
  it('control — a plain attribute (no declared axis, nothing held) stays out of the store', () => {
    expect(variationAttributePatch({ categoryAttributes: { variations: {} }, variantAttributes: {} }, [], { size: 'XL' }, []).changed).toBe(false)
  })
  it('control — a size edit never touches a colour the child holds', () => {
    expect(variationAttributePatch({ categoryAttributes: { variations: { Color: 'Nero' } }, variantAttributes: {} }, [], { size: 'XL' }, []).changed).toBe(false)
  })
})

// The end-to-end arms (real PostgreSQL through applyProductBulkEdits) live in variation-one-writer.vitest.test.ts,
// which holds every real-PostgreSQL arm of Step 2.6 in one throwaway database.
