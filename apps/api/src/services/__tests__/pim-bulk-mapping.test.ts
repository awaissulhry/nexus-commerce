/**
 * BM.1 — bulk mapping merge/remove verifier (pure). prisma stubbed.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

import { mergeRulesIntoMapping, removeRulesFromMapping } from '../pim/schema-mapping.service.js'

describe('mergeRulesIntoMapping', () => {
  it('merges into the default bucket, preserving existing + immutable', () => {
    const current = { version: 1, fields: { title: { source: 'name' } } } as any
    const next = mergeRulesIntoMapping(current, [
      { fieldKey: 'brand', rule: { source: 'brand' } },
      { fieldKey: 'color', rule: { source: 'color' } },
    ])
    expect(next.fields.title).toEqual({ source: 'name' }) // preserved
    expect(next.fields.brand).toEqual({ source: 'brand' })
    expect(next.fields.color).toEqual({ source: 'color' })
    expect(next.version).toBe(1) // envelope preserved
    expect(current.fields.brand).toBeUndefined() // did not mutate input
  })

  it('merges into a productType overlay, preserving default + other types', () => {
    const current = {
      version: 1,
      fields: { title: { source: 'name' } },
      byProductType: { GLOVES: { size: { source: 'sz' } } },
    } as any
    const next = mergeRulesIntoMapping(current, [{ fieldKey: 'material', rule: { source: 'mat' } }], 'OUTERWEAR')
    expect(next.fields.title).toEqual({ source: 'name' }) // default preserved
    expect(next.byProductType.GLOVES.size).toEqual({ source: 'sz' }) // other type preserved
    expect(next.byProductType.OUTERWEAR.material).toEqual({ source: 'mat' })
  })
})

describe('removeRulesFromMapping', () => {
  it('removes from the default bucket', () => {
    const current = { version: 1, fields: { a: { source: 'x' }, b: { source: 'y' } } } as any
    const next = removeRulesFromMapping(current, ['a'])
    expect(next.fields.a).toBeUndefined()
    expect(next.fields.b).toEqual({ source: 'y' })
  })

  it('removes from a productType overlay, leaving default untouched', () => {
    const current = {
      version: 1,
      fields: { keep: { source: 'k' } },
      byProductType: { OUTERWEAR: { a: { source: 'x' }, b: { source: 'y' } } },
    } as any
    const next = removeRulesFromMapping(current, ['a'], 'OUTERWEAR')
    expect(next.byProductType.OUTERWEAR.a).toBeUndefined()
    expect(next.byProductType.OUTERWEAR.b).toEqual({ source: 'y' })
    expect(next.fields.keep).toEqual({ source: 'k' })
  })
})
