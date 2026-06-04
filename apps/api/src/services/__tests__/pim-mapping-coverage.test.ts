/**
 * FM.13 — coverage stats verifier (pure statsFor). prisma stubbed.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

import { statsFor } from '../pim/mapping-coverage.service.js'

const fields = [
  { fieldKey: 'item_name', required: true },
  { fieldKey: 'product_description', required: false },
  { fieldKey: 'brand', required: true },
  { fieldKey: 'color', required: false },
]

describe('statsFor', () => {
  it('counts mapped / required / required-unmapped + pct', () => {
    const rules = { item_name: { source: 'title' }, color: { source: 'x' } }
    expect(statsFor(fields, rules)).toEqual({
      totalFields: 4,
      mappedFields: 2,
      requiredFields: 2,
      requiredUnmapped: 1, // brand required + unmapped
      coveragePct: 50,
    })
  })

  it('100% when all mapped, 0 required-unmapped', () => {
    const rules = Object.fromEntries(fields.map((f) => [f.fieldKey, { source: 'x' }]))
    expect(statsFor(fields, rules)).toMatchObject({ coveragePct: 100, requiredUnmapped: 0 })
  })

  it('0 mapped → 0% + all required unmapped', () => {
    expect(statsFor(fields, {})).toMatchObject({ mappedFields: 0, requiredUnmapped: 2, coveragePct: 0 })
  })

  it('handles an empty schema', () => {
    expect(statsFor([], {})).toMatchObject({ totalFields: 0, coveragePct: 0 })
  })
})
