import { describe, expect, it } from 'vitest'
import { describeValueSource, isRoutineSource, sourceHoverText } from './cellDetailsSource'
import type { StudioCellValue } from './types'
import { publishFullTime } from '@/design-system/grid/renderers/publishStatus'

/** P1 — the words a cell's source mark and its Cell details say (report 2 I-3, I-4). */
const cell = (over: Partial<StudioCellValue> = {}): StudioCellValue => ({
  value: 'Giacca Moto Uomo e Donna - Giubbotto Impermeabile', source: 'channelSnapshot', inheritedFrom: 'listing', inherited: true,
  layer: 'channel', pinned: false, follows: true, editable: true, linkGroupId: null, writeField: 'name', writeTarget: 'channelListing',
  writeVerb: 'channel', affectsAllChannels: true, writable: true,
  // The capture on REGAL eBay IT: the mapping reads the old title through `title`, which is what said "Follows Shared".
  mapped: { value: 'Giacca Moto Uomo e Donna - Giubbotto Impermeabile', status: 'mapped', provenance: 'catalogRule', sourcePath: 'title',
    appliedTransforms: [], warnings: [], errors: [], autoCorrected: null, requiredByRule: true, overLimit: null },
  ...over,
})

describe('describeValueSource', () => {
  it('names an old listing text as the listing’s own value, never "Follows Shared"', () => {
    const source = describeValueSource(cell(), 'inherited')
    expect(source).toEqual({ kind: 'channel', label: 'Listing value',
      description: 'This listing still holds its own text, not the Shared product’s. The next change to the Shared product replaces it; Follow Shared uses the Shared product’s text now' })
  })
  it('still says "Follows Shared" for a value the mapping really takes from Master', () => {
    expect(describeValueSource(cell({ source: 'masterColumn', layer: 'master' }), 'inherited').label).toBe('Follows Shared')
  })
})

describe('D9 = A — Amazon\'s report differs on the Fulfillment method cell', () => {
  it('says so as a warning, in the Matrix\'s words, and says the stock keeps syncing', () => {
    const source = describeValueSource(cell({ value: 'DEFAULT', fulfilmentReported: 'AFN' }), 'pinned')
    expect(source.kind).toBe('warning')
    expect(source.label).toBe('Amazon reports AFN — differs from Nexus')
    expect(source.description).toMatch(/keeps sending this listing's stock/)
    expect(isRoutineSource(source.kind)).toBe(false)
  })
})

describe('the mark at rest', () => {
  it('draws only the sources that follow somewhere else quieter', () => {
    expect(['master', 'linked', 'default', 'rule', 'missing'].every(kind => isRoutineSource(kind as never))).toBe(true)
    expect(['override', 'channel', 'formula', 'ai', 'warning'].some(kind => isRoutineSource(kind as never))).toBe(false)
  })
  it('names the source on hover, and keeps a formula refusal in the server’s words', () => {
    const source = describeValueSource(cell(), 'inherited')
    expect(sourceHoverText(source, source.description)).toBe(`Listing value. ${source.description}`)
    expect(sourceHoverText(source, source.description, 'Brand must be one of the options.')).toBe('Brand must be one of the options.')
  })
})

/** Amazon sheet gaps (D4=B, D7=A) — a waiting offer change never reads as a live value: the Shopify draft's mark and detail. */
describe('describeValueSource — an Amazon offer change waiting for Publish', () => {
  const SAVED_AT = '2026-10-02T12:03:00.000Z'
  const waiting = (pending: Record<string, unknown> = {}, over: Partial<StudioCellValue> = {}) => cell({ value: [44.9], source: 'channelExplicit', layer: 'channel',
    pinned: true, inherited: false, mapped: null, writeField: 'attr_purchasable_offer__our_price',
    pendingPublish: { value: 44.9, live: 49.9, savedAt: SAVED_AT, savedBy: 'sheet@test', note: 'Saved — pins at 44.90 when you publish', sent: true, ...pending }, ...over } as never)
  it('shows the saved value, the live value, when it was saved — not "Listing override"', () => {
    expect(describeValueSource(waiting(), 'pinned')).toEqual({ kind: 'pending', label: 'Waits for Publish',
      description: `Saved — pins at 44.90 when you publish. Saved value: 44.90. Live until you publish: 49.90. Saved ${publishFullTime(SAVED_AT)} by sheet@test` })
    expect(isRoutineSource(describeValueSource(waiting(), 'inherited').kind)).toBe(false)
  })
  it('D7 — says live changed since the save, and that Publish still sends the saved value', () => {
    const source = describeValueSource(waiting({ live: 52, liveChangedSince: { from: 49.9, to: 52, note: 'Live changed since you saved: 49.90 → 52.00. Publish sends your saved value.' } }), 'pinned')
    expect(source.description).toContain('Live changed since you saved: 49.90 → 52.00. Publish sends your saved value. Saved value: 44.90. Live until you publish: 52')
  })
  it('a saved value that is not sent is a warning; a formula refusal still speaks first', () => {
    expect(describeValueSource(waiting({ sent: false, note: 'Restock date has passed — not sent. Change it or discard it.' }), 'pinned')).toMatchObject({ kind: 'warning', label: 'Saved, not sent' })
    expect(describeValueSource(waiting(), 'refused', 'The formula could not produce a value').label).toBe('Formula needs attention')
  })
})
