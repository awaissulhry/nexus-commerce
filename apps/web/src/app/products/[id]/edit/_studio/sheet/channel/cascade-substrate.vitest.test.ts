/**
 * PES.3 — does the SUBSTRATE actually resolve the alias cascade?
 *
 * Hub ruling #16 closed PES.3's gap by adding `inheritedOverride` to PES.2's `classifyProvenance`.
 * This asserts that against the exact `StudioCellValue` shapes PES.5 §3.2 sends for a channel scope,
 * rather than trusting the ruling: the three levels of layout §1's cascade must land on three
 * distinguishable states, on both row kinds.
 *
 * It is a contract test across a lane boundary. If PES.2 or PES.5 changes the classification or the
 * `layer` vocabulary, this fails here rather than as a wrong glyph on an operator's screen.
 */
import { describe, expect, it } from 'vitest'

import { classifyProvenance, provenanceTooltip } from '@/design-system/grid/renderers/provenance'

import { cascadeIntent, cascadeOf } from './provenance'
import type { StudioCellValue, StudioLayer } from './types'

/** A cell as PES.5 §3.2 sends it. */
const cell = (over: Partial<StudioCellValue>): StudioCellValue => ({
  value: 'Giacca Moto',
  source: 'master',
  inheritedFrom: null,
  inherited: false,
  layer: 'master',
  pinned: false,
  follows: null,
  editable: true,
  linkGroupId: null,
  mapped: null,
  writeField: 'item_name',
  writeTarget: 'channelListing', writeVerb: 'channel',
  affectsAllChannels: false,
  writable: true,
  ...over,
})

/** The three levels of layout §1, as they arrive on a VARIANT row of a channel scope. */
const PINNED_HERE = cell({ layer: 'aliasVariant', pinned: true })
const FROM_ALIAS = cell({ layer: 'alias', inherited: true, inheritedFrom: 'cl-alias-2' })
const FROM_MASTER = cell({ layer: 'master', inherited: true, inheritedFrom: 'prod-parent' })

describe('the three cascade levels are three DISTINCT states', () => {
  it('classifies each level differently on a variant row', () => {
    const states = [PINNED_HERE, FROM_ALIAS, FROM_MASTER].map((c) => classifyProvenance(c, 'channel'))
    expect(states).toEqual(['pinned', 'inheritedOverride', 'inherited'])
    // The point of ruling #16: these are three, not two.
    expect(new Set(states).size).toBe(3)
  })

  it('no longer collapses alias-inherited onto master-inherited', () => {
    // The exact defect PES.3 reported. Guarded so it cannot silently return.
    expect(classifyProvenance(FROM_ALIAS, 'channel')).not.toBe(classifyProvenance(FROM_MASTER, 'channel'))
  })

  it('tells the operator where a reset actually lands', () => {
    const tip = provenanceTooltip(classifyProvenance(FROM_ALIAS, 'channel'), '② Bundle listing')
    expect(tip).toContain('② Bundle listing')
    expect(tip).toMatch(/not to the master/i)
  })
})

describe('the band row reads its own values as its own', () => {
  it('calls an alias-level value PINNED on the band, not inherited', () => {
    // Same `layer: 'alias'`, opposite meaning: on the band it IS this row's own value.
    const onBand = cell({ layer: 'alias', pinned: true })
    expect(classifyProvenance(onBand, 'channel')).toBe('pinned')
  })

  it('still calls master inherited on the band', () => {
    expect(classifyProvenance(FROM_MASTER, 'channel')).toBe('inherited')
  })
})

describe('a link group is an inheritance, never a pin', () => {
  it('classifies a linked value as inherited even on a channel scope', () => {
    const linked = cell({ layer: 'linked', linkGroupId: 'flg-1', inherited: true })
    expect(classifyProvenance(linked, 'channel')).toBe('inherited')
  })
})

describe('the lane WRITE ROUTING agrees with the substrate CLASSIFICATION', () => {
  // The two must never disagree: a cell drawn "inherited from the alias" whose click resets to the
  // master would do something other than what its own tooltip promised.
  const cases: Array<{ cell: StudioCellValue; kind: 'parent' | 'variant'; resetsTo: string }> = [
    { cell: PINNED_HERE, kind: 'variant', resetsTo: 'the alias' },
    { cell: FROM_ALIAS, kind: 'variant', resetsTo: 'nothing — it pins instead' },
    { cell: FROM_MASTER, kind: 'variant', resetsTo: 'nothing — it pins instead' },
  ]

  it('resets only what is pinned at this row, and pins everything inherited', () => {
    for (const c of cases) {
      const layer = cascadeOf(c.cell, c.kind)
      const intent = cascadeIntent(layer, c.kind, c.cell.value)
      const prov = classifyProvenance(c.cell, 'channel')
      if (prov === 'pinned') expect(intent?.action).toBe('reset')
      else expect(intent?.action).toBe('pin')
    }
  })

  it('routes a pin to the row that was clicked, never up the tree', () => {
    expect(cascadeIntent(cascadeOf(FROM_MASTER, 'variant'), 'variant', 'x')?.target).toBe('aliasVariant')
    expect(cascadeIntent(cascadeOf(FROM_MASTER, 'parent'), 'parent', 'x')?.target).toBe('alias')
  })

  it('every layer the server can send routes somewhere or is explicitly inert', () => {
    // A layer with no routing rule would be a dead click — silent, and impossible to notice.
    const ALL: StudioLayer[] = ['master', 'variant', 'alias', 'aliasVariant', 'channel', 'linked', 'default']
    for (const l of ALL) {
      const layer = cascadeOf(cell({ layer: l, inherited: l !== 'aliasVariant' }), 'variant')
      const intent = cascadeIntent(layer, 'variant', 'x')
      if (l === 'default') expect(intent).toBeNull()
      else expect(intent).not.toBeNull()
    }
  })
})
