import { describe, expect, it } from 'vitest'

import { landingPreset, resolvePreset, type GridViewPreset } from './presets'

const PRICING: GridViewPreset = { id: 'pricing', label: 'Pricing', columns: ['basePrice', 'costPrice', 'minPrice', 'maxPrice'] }
const SPECS: GridViewPreset = { id: 'specs', label: 'Specs', columns: ['material', 'fabric_type', 'fit_type'] }

describe('resolvePreset', () => {
  it('keeps the preset’s ORDER, not the grid’s — a view that buries price is not a Pricing view', () => {
    const available = ['sku', 'maxPrice', 'material', 'basePrice', 'costPrice', 'minPrice']
    expect(resolvePreset(PRICING, available).columns).toEqual(['basePrice', 'costPrice', 'minPrice', 'maxPrice'])
  })

  /**
   * A union sheet's columns change with product type and market, so a preset naming `fabric_type`
   * is right for OUTERWEAR and meaningless elsewhere. `applyColumnState` ignores an unknown colId
   * silently, so an unfiltered preset would show fewer columns than it claims with nothing saying why.
   */
  it('drops columns this grid does not have, and REPORTS them', () => {
    const r = resolvePreset(SPECS, ['sku', 'material'])
    expect(r.columns).toEqual(['material'])
    expect(r.missing).toEqual(['fabric_type', 'fit_type'])
  })

  it('prepends the always-columns, ahead of the preset’s own', () => {
    const r = resolvePreset(PRICING, ['sku', 'product', 'basePrice', 'costPrice', 'minPrice', 'maxPrice'], ['product', 'sku'])
    expect(r.columns.slice(0, 2)).toEqual(['product', 'sku'])
  })

  it('de-duplicates when a preset also names an always-column, keeping the always position', () => {
    const p: GridViewPreset = { id: 'x', label: 'X', columns: ['basePrice', 'sku'] }
    const r = resolvePreset(p, ['sku', 'basePrice'], ['sku'])
    expect(r.columns).toEqual(['sku', 'basePrice'])
    // Naming it twice is not "missing" — it is present.
    expect(r.missing).toEqual([])
  })

  it('an always-column the grid does not have is skipped, not invented', () => {
    const r = resolvePreset(PRICING, ['basePrice'], ['product', 'sku'])
    expect(r.columns).toEqual(['basePrice'])
  })

  it('a preset naming nothing this grid has resolves to the always-columns alone', () => {
    const r = resolvePreset(SPECS, ['sku', 'basePrice'], ['sku'])
    expect(r.columns).toEqual(['sku'])
    expect(r.missing).toEqual(['material', 'fabric_type', 'fit_type'])
  })
})

describe('landingPreset', () => {
  const presets = [PRICING, SPECS]

  it('the operator’s last choice wins', () => {
    expect(landingPreset(presets, { lastUsedId: 'specs', defaultId: 'pricing' })?.id).toBe('specs')
  })

  it('then the surface’s declared default', () => {
    expect(landingPreset(presets, { defaultId: 'specs' })?.id).toBe('specs')
  })

  it('then the first preset — a grid must always land on SOME view', () => {
    expect(landingPreset(presets)?.id).toBe('pricing')
  })

  /** A preset renamed away, or a surface whose set changed, must not land the grid on nothing. */
  it('falls through a stale stored id rather than resolving to null', () => {
    expect(landingPreset(presets, { lastUsedId: 'deleted-view' })?.id).toBe('pricing')
    expect(landingPreset(presets, { lastUsedId: 'deleted-view', defaultId: 'specs' })?.id).toBe('specs')
  })

  it('a surface with no presets lands on null, and says so rather than throwing', () => {
    expect(landingPreset([], { defaultId: 'pricing' })).toBeNull()
  })
})
