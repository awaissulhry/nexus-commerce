import { describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ attributes: vi.fn(), family: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { customAttribute: { findMany: db.attributes } } }))
vi.mock('../family-hierarchy.service.js', () => ({ familyHierarchyService: { resolveEffectiveAttributes: db.family } }))
import { familySheetFields } from './family-sheet-schema.js'
import { buildSheetColumns } from './sheet-columns.service.js'
import { columnApplies, columnRequiredByAny } from '@nexus/shared/master-sheet'
import { buildCoordinateValidators, evaluateRow } from './readiness.service.js'
import { completenessFor } from './sheet-rows.service.js'
import { coerceForShape } from './sheet-values.js'
import { validateLocalizedPatch } from './localized-content.js'

describe('Master family contract', () => {
  it('retains per-family applicability, requiredness and ordering through the column and readiness contracts', async () => {
    db.attributes.mockResolvedValue([
      { id: 'a', code: 'lining', label: 'Lining', type: 'text', options: [], group: { code: 'specs', label: 'Specifications' }, validation: {}, scope: 'global' },
      { id: 'b', code: 'closure', label: 'Closure', type: 'text', options: [], group: { code: 'specs', label: 'Specifications' }, validation: {}, scope: 'global' },
    ])
    db.family.mockImplementation(async (id: string) => id === 'jacket' ? [
      { attributeId: 'a', required: true, sortOrder: 0 }, { attributeId: 'b', required: false, sortOrder: 9 },
    ] : [{ attributeId: 'a', required: false, sortOrder: 0 }])
    const fields = await familySheetFields(['jacket', 'glove'])
    const { columns } = buildSheetColumns({ fields, coordinates: [], scopeKind: 'master', familySchema: true })
    const jacket = { isParent: false, productType: null, familyId: 'jacket' }
    const glove = { ...jacket, familyId: 'glove' }
    const lining = columns.find(column => column.key === 'lining')!
    const closure = columns.find(column => column.key === 'closure')!
    expect(columnRequiredByAny(lining, jacket)).toBe(true)
    expect(columnRequiredByAny(lining, glove)).toBe(false)
    expect(columnApplies(closure, glove)).toBe(false)
    expect(columnApplies(closure, { ...glove, familyId: null })).toBe(false)
    const coordinate = { channel: 'MASTER' as any, marketplace: 'IT', label: 'Master', inMarket: true }
    expect(evaluateRow({}, buildCoordinateValidators(columns, coordinate, glove))).toEqual([])
    expect(evaluateRow({}, buildCoordinateValidators(columns, coordinate, jacket))).toEqual([expect.objectContaining({ field: 'lining', severity: 'error' })])
    expect(completenessFor(columns, glove, {}).required.total).toBe(0)
    const optional = buildSheetColumns({ fields: fields.map(field => ({ ...field, required: false })), coordinates: [], familySchema: true }).columns
    // VT.1 (2026-09-13, D-VT9): the engine-owned `variation_theme` column leads EVERY scope, so the family's own
    // columns follow it. The per-family ordering this test exists to pin is asserted on the spec's columns.
    expect(optional.map(column => column.key)).toEqual(['variation_theme', 'lining', 'closure'])
    expect(optional.filter(column => column.kind === 'variationTheme')).toHaveLength(1)
  })
})

describe('custom attribute constraints on every locale', () => {
  it('enforces the same localized text limit and format as a bulk attribute edit', () => {
    const facts = { kind: 'text', maxLength: 4, validation: { minLength: 2, pattern: '^[A-Z]+$' } }
    expect(coerceForShape(facts, 'AB').ok).toBe(true)
    for (const value of ['A', 'ABCDE', 'ab']) {
      expect(coerceForShape(facts, value).ok).toBe(false)
      expect(validateLocalizedPatch({ it: { finish: value } }, { finish: facts })).toHaveLength(1)
    }
    expect(validateLocalizedPatch({ it: { finish: null } }, { finish: facts })).toEqual([])
  })
  it('enforces numeric boundaries including zero and decimal steps', () => {
    const facts = { kind: 'number', validation: { minimum: 0, maximum: 2, multipleOf: 0.1 } }
    expect(coerceForShape(facts, '0')).toEqual({ ok: true, value: 0 })
    expect(coerceForShape(facts, '0.3').ok).toBe(true)
    for (const value of [-1, 3, 0.35]) expect(coerceForShape(facts, value).ok).toBe(false)
  })
  it('enforces per-item limits, cardinality and uniqueness without truncating', () => {
    const facts = { shape: 'list' as const, validation: { minItems: 2, maxItems: 3, maxLength: 4, uniqueItems: true } }
    expect(coerceForShape(facts, ['One', 'Two']).ok).toBe(true)
    for (const value of [['One'], ['One', 'One'], ['One', 'Longer'], ['1', '2', '3', '4']]) expect(coerceForShape(facts, value).ok).toBe(false)
  })
  it('surfaces configured constraints in readiness as well as write validation', () => {
    const columns = buildSheetColumns({ fields: [{ id: 'attr_score', label: 'Score', category: 'category', type: 'number', editable: true, validation: { maximum: 5 } }], coordinates: [], familySchema: true }).columns
    const validators = buildCoordinateValidators(columns, { channel: 'MASTER' as any, marketplace: 'IT', label: 'Master', inMarket: true }, { isParent: false, productType: null })
    expect(evaluateRow({ score: 6 }, validators)).toEqual([expect.objectContaining({ field: 'score', severity: 'error' })])
  })
})
