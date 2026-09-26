/**
 * Progress columns (2026-09-26, colour rule A) — the OPTIONAL side of completeness, from the one completeness function
 * through the readiness index to the matrix the master sheet reads. Colour rule A needs it: yellow means "every required
 * field is filled, an optional one is empty", and without the optional side a bar could only guess between yellow and green.
 */
import { describe, expect, it, vi } from 'vitest'
vi.mock('./family-account.js', () => ({ readFamilyAccountId: async () => 'a' }))
vi.mock('./studio-sheet.service.js', () => ({ getStudioSheet: vi.fn() }))
vi.mock('./studio-columns.js', () => ({ getStudioColumns: vi.fn() }))
vi.mock('../../db.js', () => ({ default: {} }))
import { computeMasterCompleteness } from './master-completeness.service.js'
import { summarizeReadinessIndex } from './scope-readiness.service.js'
import { optionalColumns } from './readiness-index.service.js'
import { completenessFor } from './sheet-rows.service.js'

const attr = (key: string, required: boolean) => ({ key, label: key.toUpperCase(), type: 'text' as const, required, group: 'g', source: 'schema' as const })

describe('computeMasterCompleteness — the optional side', () => {
  it('names the empty optional attributes and keeps required + optional = overall', () => {
    const c = computeMasterCompleteness([attr('title', true), attr('brand', true), attr('colour', false), attr('material', false), attr('bullet', false)],
      { title: 'Giacca', colour: '', material: 'Poliestere', bullet: [] })
    expect(c.required).toEqual({ filled: 1, total: 2, missing: [{ key: 'brand', label: 'BRAND' }] })
    expect(c.optional).toEqual({ filled: 1, total: 3, missing: [{ key: 'colour', label: 'COLOUR' }, { key: 'bullet', label: 'BULLET' }] })
    expect(c.required.total + c.optional.total).toBe(c.overall.total)
    expect(c.required.filled + c.optional.filled).toBe(c.overall.filled)
  })
  it('a required field never appears in the optional list, filled or not', () => {
    const c = computeMasterCompleteness([attr('title', true)], {})
    expect(c.optional).toEqual({ filled: 0, total: 0, missing: [] })
  })
})

describe('optionalColumns — what the index stores', () => {
  it('stores counts and the empty names as { field, label }', () => {
    expect(optionalColumns({ optional: { filled: 2, total: 4, missing: [{ key: 'colour', label: 'Colour' }, { key: 'bullet1', label: 'Bullet 1' }] } }))
      .toEqual({ optionalFilled: 2, optionalTotal: 4, optionalMissing: [{ field: 'colour', label: 'Colour' }, { field: 'bullet1', label: 'Bullet 1' }] })
  })
  it('an older completeness with no optional side is NOT RECORDED (null), never 0 of 0', () => {
    const out = optionalColumns({})
    expect(out.optionalFilled).toBeNull()
    expect(out.optionalTotal).toBeNull()
  })
})

describe('summarizeReadinessIndex — the optional side of a coordinate', () => {
  const c = { channel: 'AMAZON', market: 'IT', accountId: 'a', aliasId: null }
  const row = (productId: string, extra: Record<string, unknown>) => ({ ...c, productId, pct: 100, state: 'ready', requiredFilled: 3, requiredTotal: 3,
    missing: [], computedAt: new Date('2026-09-26T10:00:00Z'), mappingRules: 1, ...extra })

  it('sums the counts and lists each empty field with its product', () => {
    const s = summarizeReadinessIndex([
      row('p1', { optionalFilled: 1, optionalTotal: 2, optionalMissing: [{ field: 'colour', label: 'Colour' }] }),
      row('p2', { optionalFilled: 2, optionalTotal: 2, optionalMissing: [] }),
    ] as never, c, 'it', 'Amazon · IT')
    expect(s.optional).toEqual({ filled: 3, total: 4 })
    expect(s.optionalMissing).toEqual([{ productId: 'p1', field: 'colour', label: 'Colour' }])
  })
  it('ONE row written before the columns existed makes the whole sum unknown — not a smaller known number', () => {
    const s = summarizeReadinessIndex([
      row('p1', { optionalFilled: 1, optionalTotal: 2, optionalMissing: [{ field: 'colour', label: 'Colour' }] }),
      row('p2', { optionalFilled: null, optionalTotal: null, optionalMissing: null }),
    ] as never, c, 'it', 'Amazon · IT')
    expect(s.optional).toBeNull()
    expect(s.optionalMissing).toEqual([])
  })
  it('no rows at all is not recorded either', () => {
    expect(summarizeReadinessIndex([], c, 'it', 'Amazon · IT').optional).toBeNull()
  })
})

describe('completenessFor — the variation theme is set on the parent', () => {
  const theme = { key: 'variation_theme', label: 'Variation theme', kind: 'variationTheme', group: 'Identity', scope: 'global', requiredBy: [] } as any
  const brand = { key: 'brand', label: 'Brand', kind: 'text', group: 'Identity', scope: 'global', requiredBy: [] } as any
  const cell = (value: unknown) => ({ value, source: 'master', inheritedFrom: null, inherited: false }) as any
  it('a CHILD does not count it — its cell does not apply there (the sheet hatches it)', () => {
    const c = completenessFor([theme, brand], { isParent: false, productType: null }, { brand: cell('Xavia') })
    expect(c.optional).toEqual({ filled: 1, total: 1, missing: [] })
  })
  it('the PARENT still counts it, filled or empty', () => {
    const c = completenessFor([theme, brand], { isParent: true, productType: null }, { brand: cell('Xavia') })
    expect(c.optional.missing).toEqual([{ key: 'variation_theme', label: 'Variation theme' }])
  })
})
