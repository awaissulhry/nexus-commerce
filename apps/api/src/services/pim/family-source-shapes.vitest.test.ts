import { expect, it, vi } from 'vitest'
vi.mock('../../db.js', () => ({ default: { customAttribute: { findMany: async () => [
  { id: 'features', code: 'features', label: 'Features', type: 'text', validation: { shape: 'list' }, options: [], group: { code: 'specifications', label: 'Specifications' } },
  { id: 'numbers', code: 'numbers', label: 'Numbers', type: 'number', validation: { shape: 'list' }, options: [], group: { code: 'specifications', label: 'Specifications' } },
] } } }))
vi.mock('../family-hierarchy.service.js', () => ({ familyHierarchyService: { resolveEffectiveAttributes: async () => [
  { attributeId: 'features', required: false, sortOrder: 1 }, { attributeId: 'numbers', required: false, sortOrder: 2 },
] } }))
import { familySheetFields } from './family-sheet-schema.js'
import { buildSheetColumns } from './sheet-columns.service.js'
import { coerceForShape } from './sheet-values.js'
it('keeps open typed Master lists editable without inventing a closed channel option list', async () => {
  const fields = await familySheetFields(['family'])
  const { columns } = buildSheetColumns({ fields, coordinates: [], scopeKind: 'master', familySchema: true })
  const features = columns.find(c => c.key === 'features')!, numbers = columns.find(c => c.key === 'numbers')!
  expect(features).toMatchObject({ shape: 'list', kind: 'text', editable: true })
  expect(coerceForShape(features, ['Waterproof', 'Ventilated'])).toMatchObject({ ok: true, value: ['Waterproof', 'Ventilated'] })
  expect(numbers).toMatchObject({ shape: 'list', kind: 'number' })
  expect(coerceForShape(numbers, [0, '2'])).toMatchObject({ ok: true, value: [0, 2] })
  expect(coerceForShape(numbers, [0, 'wrong'])).toMatchObject({ ok: false })
  expect(coerceForShape({ shape: 'list', kind: 'boolean' }, [false, 'true'])).toMatchObject({ ok: true, value: [false, true] })
  expect(coerceForShape({ shape: 'list', kind: 'boolean' }, ['yes'])).toMatchObject({ ok: false })
})
