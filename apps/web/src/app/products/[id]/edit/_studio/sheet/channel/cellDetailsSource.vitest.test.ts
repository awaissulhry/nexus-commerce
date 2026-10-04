import { describe, expect, it } from 'vitest'
import { provenanceLabel } from '@/design-system/grid/renderers/provenance'
import { describeValueSource } from './cellDetailsSource'
import { channelCellProvenance, SHOPIFY_DRAFT_WORDS } from './channelCellProvenance'
import type { StudioCellValue } from './types'
import { publishFullTime } from '@/design-system/grid/renderers/publishStatus'

/**
 * P1 — the words Cell details says about a cell's source (report 2 I-3, I-4). Since 2026-10-04 they word the member
 * the cell's mark draws (`channelCellProvenance`), so each case reads the verdict first, as the sheet does.
 */
const cell = (over: Partial<StudioCellValue> = {}): StudioCellValue => ({
  value: 'Giacca Moto Uomo e Donna - Giubbotto Impermeabile', source: 'channelSnapshot', inheritedFrom: 'listing', inherited: true,
  layer: 'channel', pinned: false, follows: true, editable: true, linkGroupId: null, writeField: 'name', writeTarget: 'channelListing',
  writeVerb: 'channel', affectsAllChannels: true, writable: true,
  // The capture on REGAL eBay IT: the mapping reads the old title through `title`, which is what said "Follows Shared".
  mapped: { value: 'Giacca Moto Uomo e Donna - Giubbotto Impermeabile', status: 'mapped', provenance: 'catalogRule', sourcePath: 'title',
    appliedTransforms: [], warnings: [], errors: [], autoCorrected: null, requiredByRule: true, overLimit: null },
  ...over,
})
const words = (c: StudioCellValue, refusedReason: string | null = null) => describeValueSource(c, channelCellProvenance(c, { refusedReason }), refusedReason)

describe('describeValueSource', () => {
  it('names an old listing text as the listing’s own value, never "Follows Shared"', () => {
    expect(channelCellProvenance(cell())).toBe('listingValue')
    expect(words(cell())).toEqual({ kind: 'channel', label: provenanceLabel('listingValue'),
      description: 'This listing still holds its own text, not the Shared product’s. The next change to the Shared product replaces it; Follow Shared uses the Shared product’s text now' })
  })
  it('still says "Follows Shared" for a value the mapping really takes from the Shared product — and the cell draws no mark', () => {
    const shared = cell({ source: 'masterColumn', layer: 'master' })
    expect(channelCellProvenance(shared)).toBe('own')
    expect(words(shared).label).toBe('Follows Shared')
  })
  it('names the channel adjustments of a plain path without calling it a mapping rule', () => {
    const adjusted = cell({ source: 'masterColumn', layer: 'master', mapped: { ...cell().mapped!, appliedTransforms: ['truncate'] } })
    expect(words(adjusted)).toMatchObject({ kind: 'master', label: 'Follows Shared' })
    expect(words(adjusted).description).toContain('Channel adjustments: truncate')
  })
  it('names a real transform with the mark’s own label', () => {
    const expression = cell({ source: 'masterColumn', layer: 'master', mapped: { ...cell().mapped!, usesExpression: true } })
    expect(channelCellProvenance(expression)).toBe('mapped')
    expect(words(expression)).toMatchObject({ kind: 'rule', label: provenanceLabel('mapped') })
  })
  it('a reusable rule is called a reusable rule', () => {
    const ruled = cell({ source: 'masterColumn', layer: 'master', mapped: { ...cell().mapped!, supplyingRule: { id: 'r1', name: 'Apparel brand', version: 3, href: '/r1' } } })
    expect(words(ruled).description).toBe('Supplied by the reusable rule Apparel brand · v3. Editing this reusable rule can affect other matching products')
  })
  it('a value the Shared product does not supply says so without "Master"', () => {
    const stored = cell({ source: 'channelExplicit', layer: 'channel', pinned: true, inherited: false, mapped: null })
    expect(describeValueSource(stored, 'own')).toEqual({ kind: 'channel', label: 'Channel value', description: 'The Shared product does not supply this value; it is stored for this channel' })
  })
  it('a variant’s own Shared value is Shared, not a listing override', () => {
    const own = cell({ source: 'variant', layer: 'variant', pinned: true, inherited: false, mapped: null, writeTarget: 'master' })
    expect(channelCellProvenance(own)).toBe('own')
    expect(words(own)).toMatchObject({ kind: 'master', label: 'Shared value' })
  })
})

describe('D9 = A — Amazon\'s report differs on the Fulfillment method cell', () => {
  it('says so as a warning, in the Matrix\'s words, and says the stock keeps syncing', () => {
    const reported = cell({ value: 'DEFAULT', fulfilmentReported: 'AFN' })
    expect(channelCellProvenance(reported)).toBe('attention')
    const source = words(reported)
    expect(source.kind).toBe('warning')
    expect(source.label).toBe(provenanceLabel('attention'))
    expect(source.description).toMatch(/^Amazon reports AFN — differs from Nexus\. Nexus sends FBM and keeps sending this listing's stock/)
  })
})

describe('a mapping error is the attention mark, and Cell details names it', () => {
  it('says "Mapping error" with every error, in the server’s order', () => {
    const broken = cell({ source: 'masterColumn', layer: 'master', mapped: { ...cell().mapped!, errors: ['Title is not compliant', 'Too long'], mappingErrors: ['Title is not compliant'] } })
    expect(channelCellProvenance(broken)).toBe('attention')
    expect(words(broken)).toEqual({ kind: 'warning', label: provenanceLabel('attention'), description: 'Mapping error: Title is not compliant · Too long' })
  })
})

/** Amazon sheet gaps (D4=B, D7=A) — a waiting offer change never reads as a live value: the Shopify draft's mark and detail. */
describe('describeValueSource — an Amazon offer change waiting for Publish', () => {
  const SAVED_AT = '2026-10-02T12:03:00.000Z'
  const waiting = (pending: Record<string, unknown> = {}, over: Partial<StudioCellValue> = {}) => cell({ value: [44.9], source: 'channelExplicit', layer: 'channel',
    pinned: true, inherited: false, mapped: null, writeField: 'attr_purchasable_offer__our_price',
    pendingPublish: { value: 44.9, live: 49.9, savedAt: SAVED_AT, savedBy: 'sheet@test', note: 'Saved — pins at 44.90 when you publish', sent: true, ...pending }, ...over } as never)
  it('shows the saved value, the live value, when it was saved — not "Listing override"', () => {
    expect(channelCellProvenance(waiting())).toBe('pending')
    expect(words(waiting())).toEqual({ kind: 'pending', label: provenanceLabel('pending'),
      description: `Saved — pins at 44.90 when you publish. Saved value: 44.90. Live until you publish: 49.90. Saved ${publishFullTime(SAVED_AT)} by sheet@test` })
  })
  it('D7 — says live changed since the save, and that Publish still sends the saved value', () => {
    const source = words(waiting({ live: 52, liveChangedSince: { from: 49.9, to: 52, note: 'Live changed since you saved: 49.90 → 52.00. Publish sends your saved value.' } }))
    expect(source.description).toContain('Live changed since you saved: 49.90 → 52.00. Publish sends your saved value. Saved value: 44.90. Live until you publish: 52')
  })
  it('a saved value that is not sent is a warning; a formula refusal still speaks first', () => {
    const notSent = waiting({ sent: false, note: 'Restock date has passed — not sent. Change it or discard it.' })
    expect(channelCellProvenance(notSent)).toBe('attention')
    expect(words(notSent)).toMatchObject({ kind: 'warning', label: provenanceLabel('attention') })
    expect(words(notSent).description).toMatch(/^Saved, not sent\. Restock date has passed — not sent/)
    expect(channelCellProvenance(waiting(), { refusedReason: 'The formula could not produce a value' })).toBe('refused')
    // The refusal's own label — never "Formula needs attention", which read like the "Needs attention" mark.
    expect(words(waiting(), 'The formula could not produce a value')).toMatchObject({ label: provenanceLabel('refused'), description: 'The formula could not produce a value' })
  })
})

describe('Shopify drafts', () => {
  const shopify = (over: Partial<StudioCellValue>) => cell({ source: 'channelExplicit', layer: 'channel', inherited: false, mapped: null, nexusDraft: true, ...over })
  it('a saved pin synchronization already sent is a listing pin, worded so it is true whether or not it was sent', () => {
    expect(channelCellProvenance(shopify({ pinned: true }))).toBe('pinned')
    expect(words(shopify({ pinned: true }))).toEqual({ kind: 'override', label: provenanceLabel('pinned'),
      description: 'Saved in Nexus for this Shopify listing. Changes to the Shared product do not replace it' })
  })
  it('an edit Shopify does not have yet waits (the server’s `unsentDraft`) — never drawn ✎ as if it were live', () => {
    expect(channelCellProvenance(shopify({ pinned: true, unsentDraft: true }))).toBe('pending')
    expect(words(shopify({ pinned: true, unsentDraft: true }))).toEqual({ kind: 'pending', label: provenanceLabel('pending'), description: SHOPIFY_DRAFT_WORDS })
  })
  it('a reset that has not reached Shopify waits — never drawn as a live value', () => {
    expect(channelCellProvenance(shopify({ pinned: false }))).toBe('pending')
    expect(words(shopify({ pinned: false }))).toMatchObject({ kind: 'pending', label: provenanceLabel('pending'), description: SHOPIFY_DRAFT_WORDS })
  })
})
