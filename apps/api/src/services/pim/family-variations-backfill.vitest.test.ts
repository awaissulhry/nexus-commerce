/** VTR step 1a — the backfill report loads roots + variants + dictionary and totals the planner's issues; it never writes. */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

import { readFamilyVariationsReport } from './family-variations-backfill.js'

const option = (code: string, label: string) => ({ id: `o-${code}`, code, label, metadata: null, synonyms: [], sortOrder: 0, archivedAt: null })
const db = {
  customAttribute: { findMany: vi.fn(async () => [
    { id: 'a1', code: 'color', label: 'Color', semanticKey: 'color', archivedAt: null, options: [option('black', 'Black')] },
  ]) },
  product: { findMany: vi.fn(async () => [
    { id: 'f1', sku: 'FAM', variationAxes: ['Colore'], variationTheme: null, children: [
      { id: 'c1', sku: 'FAM-1', categoryAttributes: { variations: { Color: 'Black' } }, variantAttributes: null },
      { id: 'c2', sku: 'FAM-2', categoryAttributes: { variations: { Color: 'Verde' } }, variantAttributes: null },
      { id: 'c3', sku: 'FAM-3', categoryAttributes: {}, variantAttributes: null },
    ] },
    { id: 'f3', sku: 'FAM2', variationAxes: ['Colore'], variationTheme: null, children: [
      { id: 'd1', sku: 'FAM2-1', categoryAttributes: { variations: { Colore: 'verde' } }, variantAttributes: null },
    ] },
    { id: 'f2', sku: 'XRACING', variationAxes: [], variationTheme: 'Fit Type / Size Name', children: [] },
  ]), update: vi.fn(), updateMany: vi.fn() },
}

describe('readFamilyVariationsReport', () => {
  it('reports per family and in total, and never writes', async () => {
    const report = await readFamilyVariationsReport(db as never)
    // 'Verde' (FAM) and 'verde' (FAM2) are ONE option to create, counted once.
    expect(report.totals).toEqual({ families: 3, variants: 4, optionsToCreate: 1,
      issues: { 'theme-without-axes': 1, 'axis-without-attribute': 0, empty: 1, 'new-option': 2, 'store-conflict': 0, 'store-legacy-only': 0, duplicate: 0 } })
    expect(report.families[0].variants[1].values.color).toMatchObject({ text: 'Verde', option: null, newOption: 'verde' })
    expect(db.product.update).not.toHaveBeenCalled()
    expect(db.product.updateMany).not.toHaveBeenCalled()
  })
})
