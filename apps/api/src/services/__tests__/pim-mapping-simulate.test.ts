/**
 * FM.14 — rule-change simulation verifier (pure per-candidate core).
 * prisma stubbed.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

import { simulateFieldForCandidate } from '../pim/mapping-simulate.service.js'
import type { ResolvedAttributes, ValueSource } from '../pim/attribute-resolver.js'

const PROD = { localizedContent: null, categoryAttributes: null, variantAttributes: null }

function attrs(map: Record<string, { value: unknown; source?: ValueSource }>): ResolvedAttributes {
  const out: ResolvedAttributes = {}
  for (const [k, v] of Object.entries(map)) out[k] = { value: v.value, source: v.source ?? 'master', inheritedFrom: null }
  return out
}

const base = {
  fieldKey: 'item_name',
  resolvedAttrs: attrs({ title: { value: 'Master Title' }, brand: { value: 'XAVIA' } }),
  product: PROD,
  locale: 'en',
}

describe('simulateFieldForCandidate', () => {
  it('flags a change when the proposed rule points to a different source', () => {
    const r = simulateFieldForCandidate({ ...base, currentRule: { source: 'title' }, proposedRule: { source: 'brand' } })
    expect(r).toMatchObject({ current: 'Master Title', proposed: 'XAVIA', changed: true })
  })

  it('no change when current and proposed resolve equal', () => {
    const r = simulateFieldForCandidate({ ...base, currentRule: { source: 'title' }, proposedRule: { source: 'title' } })
    expect(r.changed).toBe(false)
  })

  it('adding a brand-new rule (no current) counts as a change', () => {
    const r = simulateFieldForCandidate({ ...base, currentRule: undefined, proposedRule: { source: 'title' } })
    expect(r).toMatchObject({ current: undefined, proposed: 'Master Title', changed: true })
  })
})
