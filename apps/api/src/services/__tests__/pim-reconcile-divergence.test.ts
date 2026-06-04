/**
 * FM.12 — divergence reconciliation verifier (pure core).
 *
 * findCoordinateDivergences flags only fields the coordinate OVERRIDES
 * whose value differs from the master-resolved value. prisma is stubbed
 * (module imports it at load; the pure fn never touches it).
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

import { findCoordinateDivergences } from '../pim/reconcile-divergence.service.js'
import type { ResolvedAttributes, ValueSource } from '../pim/attribute-resolver.js'
import type { FieldMappingRule } from '../pim/schema-mapping.service.js'

const PROD = { localizedContent: null, categoryAttributes: null, variantAttributes: null }

function attrs(map: Record<string, { value: unknown; source?: ValueSource }>): ResolvedAttributes {
  const out: ResolvedAttributes = {}
  for (const [k, v] of Object.entries(map)) out[k] = { value: v.value, source: v.source ?? 'master', inheritedFrom: null }
  return out
}

const baseArgs = {
  channel: 'AMAZON',
  marketplace: 'DE',
  product: PROD,
  locale: 'en',
  links: [],
}

describe('findCoordinateDivergences', () => {
  const rules: Record<string, FieldMappingRule> = { item_name: { source: 'title' } }

  it('flags an override that differs from master', () => {
    const channelAttrs = attrs({ title: { value: 'Pinned DE title', source: 'channelExplicit' } })
    const masterAttrs = attrs({ title: { value: 'Master title', source: 'master' } })
    const out = findCoordinateDivergences({ ...baseArgs, rules, masterAttrs, channelAttrs })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      channel: 'AMAZON',
      marketplace: 'DE',
      fieldKey: 'item_name',
      overrideValue: 'Pinned DE title',
      masterValue: 'Master title',
    })
  })

  it('does NOT flag an override that equals master', () => {
    const channelAttrs = attrs({ title: { value: 'Same', source: 'channelOverride' } })
    const masterAttrs = attrs({ title: { value: 'Same', source: 'master' } })
    expect(findCoordinateDivergences({ ...baseArgs, rules, masterAttrs, channelAttrs })).toHaveLength(0)
  })

  it('does NOT flag a field that follows master (not an override)', () => {
    const channelAttrs = attrs({ title: { value: 'Inherited', source: 'master' } })
    const masterAttrs = attrs({ title: { value: 'Inherited', source: 'master' } })
    expect(findCoordinateDivergences({ ...baseArgs, rules, masterAttrs, channelAttrs })).toHaveLength(0)
  })

  it('only inspects mapped fields', () => {
    // rule maps item_name only; an unmapped override on `brand` is ignored.
    const channelAttrs = attrs({
      title: { value: 'Master title', source: 'master' },
      brand: { value: 'PinnedBrand', source: 'channelExplicit' },
    })
    const masterAttrs = attrs({ title: { value: 'Master title' }, brand: { value: 'XAVIA' } })
    expect(findCoordinateDivergences({ ...baseArgs, rules, masterAttrs, channelAttrs })).toHaveLength(0)
  })
})
