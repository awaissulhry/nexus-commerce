/**
 * MA.1 — master attribute schema build verifier (pure buildMasterAttributes).
 * prisma + field-registry stubbed at module load.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

import { buildMasterAttributes } from '../pim/master-schema.service.js'

const fd = (over: Record<string, unknown>) =>
  ({ id: 'attr_x', label: 'X', type: 'text', category: 'category', editable: true, ...over }) as any

describe('buildMasterAttributes', () => {
  it('strips attr_ → master key, maps type + options + required (source=schema)', () => {
    const attrs = buildMasterAttributes(
      [
        fd({ id: 'attr_material_type', label: 'Material', type: 'select', options: ['Leather', 'Textile'], required: true }),
        fd({ id: 'attr_color', label: 'Color', type: 'text' }),
      ],
      [],
    )
    expect(attrs.find((a) => a.key === 'material_type')).toMatchObject({
      key: 'material_type',
      label: 'Material',
      type: 'select',
      allowedValues: ['Leather', 'Textile'],
      required: true,
      source: 'schema',
    })
    expect(attrs.find((a) => a.key === 'color')!.type).toBe('text')
  })

  it('sorts required-first, then alpha', () => {
    const attrs = buildMasterAttributes(
      [fd({ id: 'attr_zeta', label: 'Zeta' }), fd({ id: 'attr_alpha', label: 'Alpha' }), fd({ id: 'attr_req', label: 'Req', required: true })],
      [],
    )
    expect(attrs.map((a) => a.key)).toEqual(['req', 'alpha', 'zeta'])
  })

  it('adds mapping-rule categoryAttributes.* sources not already in schema', () => {
    const attrs = buildMasterAttributes(
      [fd({ id: 'attr_color', label: 'Color' })],
      ['categoryAttributes.care_instructions', 'title', 'categoryAttributes.color'],
    )
    expect(attrs.find((a) => a.key === 'care_instructions')).toMatchObject({
      key: 'care_instructions',
      source: 'mapping',
      label: 'Care Instructions',
    })
    // color already in schema → not duplicated, stays schema-sourced
    expect(attrs.filter((a) => a.key === 'color')).toHaveLength(1)
    expect(attrs.find((a) => a.key === 'color')!.source).toBe('schema')
    // non-categoryAttributes source ignored
    expect(attrs.find((a) => a.key === 'title')).toBeUndefined()
  })
})
