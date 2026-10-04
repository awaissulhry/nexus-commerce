/**
 * 2026-10-04 (shared Cell details) — the channel window did not change when it moved into the shared control.
 *
 * `channelCellDetails` is the channel adapter's `openCellDetails` content, moved as is. The GOLDEN below was produced by
 * running that adapter code (6f28ee119, `useChannelSheetAdapter.tsx` 906-939) on these same cells before the move; the
 * moved function must say it byte for byte: title, value, notes and the one action's label and description. The action
 * still runs the same writer it ran: the control's reset, or the channel pin / reset (`onCascade`). One case is changed
 * on purpose — "a machine translation not reviewed yet" drops advice the sheet cannot follow (see that case).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CellSaveTracker } from '@/design-system/grid'
import { publishFullTime } from '@/design-system/grid/renderers/publishStatus'
import type { CellDetailsContent } from '../cellDetails'
import { channelCellDetails, type ChannelCellDetailsContext } from './channelCellDetails'
import type { AmazonOfferPending, ChannelSheetRow, MappedCell, SheetColumn, StudioCellValue } from './types'

const NOW = Date.parse('2026-10-04T10:00:00.000Z')
const SAVED_AT = '2026-10-02T12:03:00.000Z'
const LONG = 'Giacca da moto. '.repeat(40).trim()

const plainMapping = (over: Partial<MappedCell> = {}): MappedCell => ({
  value: 'Giacca Moto', derived: true, status: 'mapped', provenance: 'catalogRule', sourcePath: 'title', fallbackPath: null,
  usesExpression: false, legacySource: 'source', appliedTransforms: [], warnings: [], errors: [], mappingErrors: [],
  autoCorrected: null, requiredByRule: false, overLimit: null, ...over,
})
/** A channel cell that follows the Shared product through a plain mapping. */
const cell = (over: Partial<StudioCellValue> = {}): StudioCellValue => ({
  value: 'Giacca Moto', source: 'masterColumn', inheritedFrom: 'prod-gale', inherited: true, layer: 'master', pinned: false,
  follows: true, editable: true, linkGroupId: null, writeField: 'name', writeTarget: 'channelListing', writeVerb: 'channel',
  affectsAllChannels: false, writable: true, mapped: plainMapping(), ...over,
})
/** A value stored for this SKU and listing (a listing override). */
const pinned = (over: Partial<StudioCellValue> = {}) => cell({ source: 'channelExplicit', inheritedFrom: null, inherited: false, layer: 'channel',
  pinned: true, follows: false, mapped: null, ...over })
const column = (over: Partial<SheetColumn> = {}): SheetColumn => ({ key: 'name', writeField: 'name', label: 'Title', group: 'Content', kind: 'text',
  storage: 'column', scope: 'per_variant', requiredBy: [], editable: true, defaultVisible: true, ...over }) as SheetColumn
const row = (values: Record<string, StudioCellValue>, over: Record<string, unknown> = {}): ChannelSheetRow => ({ id: 'p-gale-s', rowId: 'alias-1:p-gale-s',
  sku: 'GALE-JACKET-S', rowKind: 'variant', aliasId: 'alias-1', aliasPosition: 1, productType: 'JACKET', values, ...over }) as unknown as ChannelSheetRow
const waiting = (over: Partial<AmazonOfferPending> = {}): AmazonOfferPending => ({ value: 44.9, live: 49.9, savedAt: SAVED_AT, savedBy: 'sheet@test',
  note: 'Saved — pins at 44.90 when you publish', sent: true, ...over })

interface Case {
  name: string
  row: ChannelSheetRow
  column: SheetColumn
  formula?: string
  refused?: string
  saved?: string
  productLevelOnly?: boolean
}

const CASES: Case[] = [
  { name: 'a value that follows the Shared product', row: row({ name: cell() }), column: column() },
  { name: 'a listing override on a variation', row: row({ name: pinned({ value: 'Giacca Custom' }) }), column: column() },
  { name: 'an old listing text', row: row({ name: cell({ source: 'channelSnapshot', value: 'Giacca Moto Uomo e Donna' }) }), column: column() },
  { name: 'a listing override with a stored formula', row: row({ name: pinned({ value: 'GIACCA' }) }), column: column(), formula: '=UPPER(title)' },
  { name: 'a formula the server refused', row: row({ name: pinned({ value: 'GIACCA' }) }), column: column(), refused: 'The formula could not produce a value: unknown field "colour".' },
  { name: 'an Amazon offer change waiting for Publish', row: row({ price: pinned({ value: [44.9], writeField: 'price', pendingPublish: waiting() }) }),
    column: column({ key: 'price', writeField: 'price', label: 'Your price', kind: 'number' }) },
  { name: 'an empty required read-only cell with mapping errors and warnings',
    row: row({ external_product_id: cell({ value: null, editable: false, writable: false, source: null as never, inheritedFrom: null, inherited: false, layer: 'default',
      mapped: plainMapping({ value: null, derived: false, status: 'unmapped', provenance: null, sourcePath: null, legacySource: 'missing', requiredByRule: true,
        errors: ["Required by the category's condition for this product: External Product ID."], warnings: ['Amazon recommends a GTIN.'] }) }) }),
    column: column({ key: 'external_product_id', writeField: 'attr_external_product_id', label: 'External Product ID', editable: false }) },
  { name: 'a measure value whose save the channel refused', row: row({ item_weight: pinned({ value: { value: 2, unit: 'kg' }, writeField: 'attr_item_weight' }) }),
    column: column({ key: 'item_weight', writeField: 'attr_item_weight', label: 'Item weight', kind: 'number', shape: 'measure', unitOptions: ['kg', 'g'] }),
    saved: 'Amazon refused the unit.' },
  { name: 'a cell the row does not hold', row: row({}), column: column({ key: 'brand', writeField: 'attr_brand', label: 'Brand' }) },
  { name: 'a select with option labels and help text', row: row({ colour: pinned({ value: 'BLK', writeField: 'attr_colour' }) }),
    column: column({ key: 'colour', writeField: 'attr_colour', label: 'Colour', kind: 'select', options: ['BLK', 'RED'], optionLabels: { BLK: 'Black', RED: 'Red' },
      helpText: 'The colour buyers search for.' }) },
  { name: 'a long description that follows the Shared product', row: row({ description: cell({ value: LONG, writeField: 'description' }) }),
    column: column({ key: 'description', writeField: 'description', label: 'Description', kind: 'longtext', maxLength: 2000 }) },
  { name: 'an alias band value', row: row({ name: pinned({ layer: 'alias', value: 'Giacca Band' }) }, { rowKind: 'parent', sku: 'GALE-JACKET', rowId: 'alias-1:p-gale' }),
    column: column() },
  { name: 'a whole-list position', row: row({ imageUrls_2: pinned({ value: 'https://img.example/2.jpg', writeField: 'imageUrls[2]' }) }),
    column: column({ key: 'imageUrls_2', writeField: 'imageUrls[2]', label: 'Image 2' }) },
  { name: 'a product-level-only scope on a variation', row: row({ name: cell() }), column: column(), productLevelOnly: true },
  { name: 'a machine translation not reviewed yet', row: row({ name: pinned({ value: 'Motorradjacke', tier: 'pin', provenance: { member: 'ai', from: 'German · eBay · DE · pin' },
    translation: { source: 'ai', reviewedAt: null, outdated: false } } as never) }), column: column() },
]

type Shown = { title: string; value: string; notes: string; action: { label: string; description: string } | undefined }

/** Produced by the adapter's code before the move (see the header). A waiting change's clock is local time: named, not printed. */
const GOLDEN: Record<string, Shown> = {
  'a value that follows the Shared product': {
    title: 'Title: GALE-JACKET-S',
    value: 'Giacca Moto',
    notes: 'Follows Shared. Uses the Shared product’s title for this product and content language',
    action: { label: 'Keep as listing override',
      description: 'Keep the current value for GALE-JACKET-S · Main listing on this channel and market.' },
  },
  'a listing override on a variation': {
    title: 'Title: GALE-JACKET-S',
    value: 'Giacca Custom',
    notes: 'Pinned. Stored for this SKU and listing on this channel and market; changes to the Shared product do not replace it',
    action: { label: 'Reset to inherited',
      description: 'Remove this listing override and use the configured mapping or default; the field may become empty if none is configured.' },
  },
  'an old listing text': {
    title: 'Title: GALE-JACKET-S',
    value: 'Giacca Moto Uomo e Donna',
    notes: 'Listing value. This listing still holds its own text, not the Shared product’s. The next change to the Shared product replaces it; Follow Shared uses the Shared product’s text now',
    action: { label: 'Follow Shared',
      description: 'Stop using this listing’s own text for GALE-JACKET-S · Main listing and follow the Shared product.' },
  },
  'a listing override with a stored formula': {
    title: 'Title: GALE-JACKET-S',
    value: 'GIACCA',
    notes: 'Pinned. Stored for this SKU and listing on this channel and market; changes to the Shared product do not replace it',
    action: { label: 'Remove formula and reset to inherited',
      description: 'Remove this cell’s formula (its last value is kept), then: Remove this listing override and use the configured mapping or default; the field may become empty if none is configured.' },
  },
  'a formula the server refused': {
    title: 'Title: GALE-JACKET-S',
    value: 'GIACCA',
    notes: 'The formula produced no value. The formula could not produce a value: unknown field "colour".',
    action: { label: 'Remove formula and reset to inherited',
      description: 'Remove this cell’s formula (its last value is kept), then: Remove this listing override and use the configured mapping or default; the field may become empty if none is configured.' },
  },
  'an Amazon offer change waiting for Publish': {
    title: 'Your price: GALE-JACKET-S',
    value: '[\n  44.9\n]',
    notes: 'Waits for Publish. Saved — pins at 44.90 when you publish. Saved value: 44.90. Live until you publish: 49.90. Saved <saved at> by sheet@test',
    action: { label: 'Discard saved change (live: 49.90)',
      description: 'The saved change goes and the cell shows the live value again. Nothing is sent to Amazon · IT.' },
  },
  'an empty required read-only cell with mapping errors and warnings': {
    title: 'External Product ID: GALE-JACKET-S',
    value: 'Empty',
    notes: 'Required by the category\'s condition for this product: External Product ID.\n\nAmazon recommends a GTIN.\n\nNo mapping. No rule connects this channel attribute to the Shared product; configure a mapping or enter a listing value',
    action: undefined,
  },
  'a measure value whose save the channel refused': {
    title: 'Item weight: GALE-JACKET-S',
    value: '{\n  "value": 2,\n  "unit": "kg"\n}',
    notes: 'Amazon refused the unit.\n\nPinned. Stored for this SKU and listing on this channel and market; changes to the Shared product do not replace it\n\n2 kg · units: kg, g',
    action: { label: 'Reset to inherited',
      description: 'Remove this listing override and use the configured mapping or default; the field may become empty if none is configured.' },
  },
  'a cell the row does not hold': {
    title: 'Brand: GALE-JACKET-S',
    value: 'Empty',
    notes: 'No value. No source information is available',
    action: undefined,
  },
  'a select with option labels and help text': {
    title: 'Colour: GALE-JACKET-S',
    value: 'BLK',
    notes: 'Pinned. Stored for this SKU and listing on this channel and market; changes to the Shared product do not replace it\n\nBlack\nID: BLK\n\nThe colour buyers search for.',
    action: { label: 'Reset to inherited',
      description: 'Remove this listing override and use the configured mapping or default; the field may become empty if none is configured.' },
  },
  'a long description that follows the Shared product': {
    title: 'Description: GALE-JACKET-S',
    value: LONG,
    notes: 'Follows Shared. Uses the Shared product’s title for this product and content language\n\n639 of 2000 characters (cap source not stated)',
    action: { label: 'Keep as listing override',
      description: 'Keep the current value for GALE-JACKET-S · Main listing on this channel and market.' },
  },
  'an alias band value': {
    title: 'Title: GALE-JACKET',
    value: 'Giacca Band',
    notes: 'Pinned. Stored for this SKU and listing on this channel and market; changes to the Shared product do not replace it',
    action: { label: 'Reset to inherited',
      description: 'Remove this listing override and use the configured mapping or default; the field may become empty if none is configured.' },
  },
  'a whole-list position': {
    title: 'Image 2: GALE-JACKET-S',
    value: 'https://img.example/2.jpg',
    notes: 'Pinned. Stored for this SKU and listing on this channel and market; changes to the Shared product do not replace it',
    action: { label: 'Reset list to inherited…',
      description: 'Remove this whole list’s override and use the configured mapping or default; the field may become empty if none is configured.' },
  },
  'a product-level-only scope on a variation': {
    title: 'Title: GALE-JACKET-S',
    value: 'Giacca Moto',
    notes: 'Follows Shared. Uses the Shared product’s title for this product and content language',
    action: { label: 'Keep as listing override',
      description: 'Keep the current value for GALE-JACKET-S · Main listing on this channel and market.' },
  },
  /* The ONE intended channel change in this PR (honest words, `docs/shared-cell-details/PLAN.md`): the adapter said
     "… not reviewed yet. Review it before it counts as confirmed", advising a review the sheet cannot do on any scope.
     The fact stays; the advice is gone. Every other case here is the adapter's output byte for byte. */
  'a machine translation not reviewed yet': {
    title: 'Title: GALE-JACKET-S',
    value: 'Motorradjacke',
    notes: 'AI-drafted. Translated by machine and not reviewed yet',
    action: { label: 'Reset to inherited',
      description: 'Remove this listing override and use the configured mapping or default; the field may become empty if none is configured.' },
  },
}

const ctxOf = (c: Case) => {
  const tracker = new CellSaveTracker()
  if (c.saved) tracker.set(c.row.rowId, c.column.key, 'refused', c.saved)
  const reset = vi.fn(async () => undefined)
  const cascade = vi.fn(async () => undefined)
  const aliasLabel = (aliasId: string | null) => (aliasId === 'alias-1' ? 'Main listing' : 'Listing alias label not reported')
  const ctx: ChannelCellDetailsContext = {
    productLevelOnly: c.productLevelOnly ?? false, scopeLabel: 'Amazon · IT', channel: 'AMAZON', marketplace: 'IT',
    refusedReasonFor: () => c.refused ?? null, exprFor: () => c.formula ?? null, tracker, aliasLabel, reset, cascade,
  }
  return { ctx, reset, cascade }
}
const shown = (content: CellDetailsContent): Shown => ({
  title: content.title, value: content.value, notes: content.notes.replace(publishFullTime(SAVED_AT, NOW), '<saved at>'),
  action: content.action ? { label: content.action.label, description: content.action.description } : undefined,
})
const byName = (name: string) => CASES.find(c => c.name === name)!

beforeAll(() => { vi.useFakeTimers({ now: NOW, toFake: ['Date'] }) })
afterAll(() => { vi.useRealTimers() })

describe('channelCellDetails says what the channel window said before the move', () => {
  it('covers every golden case', () => {
    expect(CASES.map(c => c.name).sort()).toEqual(Object.keys(GOLDEN).sort())
  })
  for (const c of CASES) {
    it(c.name, () => {
      expect(shown(channelCellDetails(c.row, c.column, ctxOf(c).ctx))).toEqual(GOLDEN[c.name])
    })
  }
})

describe('the action runs the writer it ran before', () => {
  it('Keep as listing override pins through the channel cascade', () => {
    const c = byName('a value that follows the Shared product'), { ctx, reset, cascade } = ctxOf(c)
    channelCellDetails(c.row, c.column, ctx).action!.run()
    expect(cascade).toHaveBeenCalledWith(c.row, c.row.values.name, { action: 'pin', target: 'aliasVariant', value: 'Giacca Moto' })
    expect(reset).not.toHaveBeenCalled()
  })
  it('a listing override resets through the channel cascade (its whole-list review included)', () => {
    for (const name of ['a listing override on a variation', 'a whole-list position']) {
      const c = byName(name), { ctx, reset, cascade } = ctxOf(c)
      channelCellDetails(c.row, c.column, ctx).action!.run()
      expect(cascade).toHaveBeenCalledWith(c.row, c.row.values[c.column.key], expect.objectContaining({ action: 'reset' }))
      expect(reset).not.toHaveBeenCalled()
    }
  })
  it('a formula cell resets through the control, formula first', () => {
    const c = byName('a listing override with a stored formula'), { ctx, reset, cascade } = ctxOf(c)
    channelCellDetails(c.row, c.column, ctx).action!.run()
    expect(reset).toHaveBeenCalledWith([{ rowId: 'alias-1:p-gale-s', colId: 'name', intent: 'reset', formula: true }])
    expect(cascade).not.toHaveBeenCalled()
  })
  it('a waiting offer change is discarded through the control', () => {
    const c = byName('an Amazon offer change waiting for Publish'), { ctx, reset, cascade } = ctxOf(c)
    channelCellDetails(c.row, c.column, ctx).action!.run()
    expect(reset).toHaveBeenCalledWith([{ rowId: 'alias-1:p-gale-s', colId: 'price', intent: 'reset', formula: false }])
    expect(cascade).not.toHaveBeenCalled()
  })
  it('a read-only cell and a cell the row does not hold offer no action', () => {
    for (const name of ['an empty required read-only cell with mapping errors and warnings', 'a cell the row does not hold'])
      expect(channelCellDetails(byName(name).row, byName(name).column, ctxOf(byName(name)).ctx).action).toBeUndefined()
  })
})
