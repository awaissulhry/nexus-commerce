/**
 * BM.4 — clone-mapping build verifier (pure buildClonedRules). prisma stubbed.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

import { buildClonedRules } from '../pim/schema-mapping.service.js'

describe('buildClonedRules', () => {
  it('filters to the target field catalog + counts skipped', () => {
    const { rules, skipped } = buildClonedRules(
      { item_name: { source: 'title' }, color: { source: 'color' } },
      new Set(['item_name']),
      false,
    )
    expect(rules).toEqual([{ fieldKey: 'item_name', rule: { source: 'title' } }])
    expect(skipped).toBe(1) // color absent in target
  })

  it('adds translate to text fields when addTranslate (not to non-text)', () => {
    const { rules } = buildClonedRules(
      { item_name: { source: 'title' }, color: { source: 'color' } },
      new Set(['item_name', 'color']),
      true,
    )
    expect(rules.find((r) => r.fieldKey === 'item_name')!.rule.transforms).toEqual([{ type: 'translate' }])
    expect(rules.find((r) => r.fieldKey === 'color')!.rule.transforms).toBeUndefined()
  })

  it('does not duplicate an existing translate transform', () => {
    const { rules } = buildClonedRules(
      { description: { source: 'description', transforms: [{ type: 'translate' }] } } as any,
      new Set(['description']),
      true,
    )
    expect(rules[0].rule.transforms).toEqual([{ type: 'translate' }])
  })
})
