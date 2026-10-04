/**
 * 2026-10-04 (fix C) — every mark's ONE sentence, on BOTH scopes, read off the real cell renderers (the Shared scope's
 * `withMark`, the channel scopes' `CascadeCell`) for cells shaped as the API sends them.
 *
 * The rule this table holds: a mark's hover AND its accessible name are one sentence, `provenanceTooltip(member, from)`,
 * and `from` means ONE thing on every scope — the layer or source the value follows, came from, or no longer follows.
 * Before, the mark read "<label> — <from>", and the same pattern meant two things: "Inherited — GALE-JACKET" on Shared
 * (what it follows), "Pinned — Primary" on a channel (where the pin lives), and a Shared pin said a bare "Pinned".
 *
 * Members a scope never produces are not rows here: the Shared scope draws no mapped / mappedShared / pending /
 * attention / listingValue / listingLevel (channel facts), and no inheritedOverride (its cells inherit only from the
 * Shared parent, `layer: 'master'`).
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CellSaveTracker } from '@/design-system/grid'
import { buildMasterColumns } from './master/columns'
import { buildChannelColumns, type BuildChannelColumnsOptions } from './master/channelColumns'
import type { SheetColumn } from './master/types'

const titleOf = (html: string) => /class="nds-cell-prov[^"]*"[^>]*title="([^"]*)"/.exec(html)?.[1]
  ?.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&') ?? null
const ariaOf = (html: string) => /class="nds-cell-prov[^"]*"[^>]*aria-label="([^"]*)"/.exec(html)?.[1]
  ?.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&') ?? null
const memberOf = (html: string) => /nds-cell-prov-([a-z-]+)/.exec(html)?.[1] ?? null

/* ── the Shared scope ─────────────────────────────────────────────────────────────────────────────────────────── */

const PARENT = { id: 'gale', sku: 'GALE-JACKET', parentId: null, parentSku: null, isParent: true, values: {} }
const CHILD = { id: 'gale-s', sku: 'GALE-JACKET-S', parentId: 'gale', parentSku: 'GALE-JACKET', isParent: false, values: {} }

function sharedTitle(row: typeof PARENT | typeof CHILD, cell: Record<string, unknown>, opts: { locale?: string; expr?: string; refused?: string } = {}) {
  const key = opts.locale ? `name@${opts.locale}` : 'brand'
  const column = { key, writeField: opts.locale ? 'name' : 'brand', group: 'Content', defaultVisible: true, label: 'Brand', kind: 'text',
    storage: opts.locale ? 'column' : 'categoryAttributes', scope: 'global', requiredBy: [], editable: true, ...(opts.locale ? { locale: opts.locale } : {}) } as SheetColumn
  const formula = { exprFor: () => opts.expr ?? null, errorFor: () => opts.refused ?? null, candidatesFor: () => [], preview: async () => ({}), functions: () => [],
    colIdOfRef: () => null } as never
  const data = { ...row, values: { [key]: { value: 'Rosso', source: 'master', inheritedFrom: null, inherited: false, ...cell } } }
  const [definition] = buildMasterColumns({ columns: [column], tracker: new CellSaveTracker(), locale: opts.locale ?? 'it', formula }, { current: [PARENT, CHILD, data] as never })
  const html = renderToStaticMarkup(('cellRenderer' in definition ? definition.cellRenderer : null)({ data, value: 'Rosso' }))
  expect(ariaOf(html)).toBe(titleOf(html))
  return { member: memberOf(html), sentence: titleOf(html) }
}

const SHARED: [string, () => ReturnType<typeof sharedTitle>, string, string][] = [
  ['a variation inheriting the parent’s value', () => sharedTitle(CHILD, { inheritedFrom: 'gale', inherited: true, layer: 'master' }),
    'inherited', 'Inherited from GALE-JACKET — edit to give this row its own value'],
  /* A field nobody filled, on a variation: the wire names the variation itself (`content-read.ts`), and the variation
     follows its parent, which holds nothing either — the muted 🔗 "follows an empty parent" (2026-09-26), named by it. */
  ['a variation following an empty parent', () => sharedTitle(CHILD, { value: null, source: 'default', inheritedFrom: 'gale-s', inherited: true, tier: 'computed',
    language: 'it', requested: 'it', provenance: { member: 'inherited', from: null } }),
    'inherited', 'Inherited from GALE-JACKET — edit to give this row its own value'],
  ['a German cell showing the Italian text', () => sharedTitle(CHILD, { tier: 'source', language: 'it', requested: 'de', inheritedFrom: 'gale',
    provenance: { member: 'inherited', from: 'Italian · source' } }, { locale: 'de' }),
    'inherited', 'Inherited from the Italian text — edit to give this row its own value'],
  ['a variation’s own value (the server sends `pinned`)', () => sharedTitle(CHILD, { source: 'variant', inheritedFrom: 'gale-s', layer: 'variant', pinned: true }),
    'pinned', 'Pinned on this row — it no longer follows GALE-JACKET'],
  ['a cell formula', () => sharedTitle(PARENT, {}, { expr: 'UPPER(brand)' }),
    'formula', 'Calculated by a formula on this cell — edit the cell to change the formula'],
  ['a formula the server refused', () => sharedTitle(PARENT, { value: null }, { expr: 'UPPER(brand)', refused: 'Brand must be one of: Xavia, Gale.' }),
    'refused', 'Brand must be one of: Xavia, Gale.'],
  ['a translation older than its source', () => sharedTitle(PARENT, { tier: 'language', language: 'de', requested: 'de',
    translation: { source: 'manual', reviewedAt: '2026-09-01T00:00:00Z', outdated: true } }, { locale: 'de' }),
    'outdated', 'Out of date — the source changed after this translation was written. Compare with the source; translate again or mark reviewed'],
  ['a machine translation not reviewed', () => sharedTitle(PARENT, { tier: 'language', language: 'de', requested: 'de',
    translation: { source: 'ai', reviewedAt: null, outdated: false } }, { locale: 'de' }),
    'ai', 'Drafted by AI and not yet approved — review before it counts as confirmed'],
  ['a machine translation of an older source', () => sharedTitle(PARENT, { tier: 'language', language: 'de', requested: 'de',
    translation: { source: 'ai', reviewedAt: null, outdated: true } }, { locale: 'de' }),
    'ai', 'Drafted by AI from an older value — the source text has changed since. Compare with it before approving'],
]

describe('the Shared scope: one sentence per mark', () => {
  it.each(SHARED)('%s', (_, read, member, sentence) => {
    const out = read()
    expect(out.member).toBe(member)
    expect(out.sentence).toBe(sentence)
  })
  it('🔴 no mark on a parent row’s field nobody filled — a row never inherits from itself', () => {
    // GALE-JACKET in Italian drew 🔗 "Inherited" on 61 such cells: the wire names the row itself as the source.
    expect(sharedTitle(PARENT, { value: null, source: 'default', inheritedFrom: 'gale', inherited: true, tier: 'computed', language: 'it', requested: 'it',
      provenance: { member: 'inherited', from: null } })).toEqual({ member: null, sentence: null })
  })
})

/* ── the channel scopes ───────────────────────────────────────────────────────────────────────────────────────── */

const plain = { value: 'Xavia', derived: true, status: 'mapped', provenance: 'catalogRule', sourcePath: 'brand', fallbackPath: null, usesExpression: false,
  legacySource: 'source', appliedTransforms: [], warnings: [], errors: [], mappingErrors: [], autoCorrected: null, requiredByRule: false, overLimit: null }

function channelTitle(cell: Record<string, unknown>, opts: { productLevelOnly?: boolean; refused?: string; row?: Record<string, unknown> } = {}) {
  const column = { key: 'brand', writeField: 'attr_brand', label: 'Brand', group: 'Item specifics', kind: 'text', storage: 'categoryAttributes', scope: 'global',
    requiredBy: [], editable: true }
  const [definition] = buildChannelColumns({ data: { scope: { channel: 'AMAZON', marketplace: 'IT', label: 'Amazon · IT' } }, gridColumns: [column],
    formulaWiring: { exprFor: () => null, errorFor: () => null }, productLevelOnly: opts.productLevelOnly ?? false, refusedReasonFor: () => opts.refused ?? null,
    aliasLabelOf: () => 'Primary', tracker: new CellSaveTracker(), activeCellsRef: { current: null }, viewCtx: { locale: 'it', variationAxes: [], flaggedKeys: [] },
    mediaEditor: { open: () => {}, actions: {} }, shopifyEditor: { open: () => {} }, auth: { has: () => true } } as unknown as BuildChannelColumnsOptions)
  const data = { id: 'gale-s', rowId: 'primary:gale-s', sku: 'GALE-JACKET-S', rowKind: 'variant', isParent: false, aliasId: null, aliasPosition: 0, productType: null,
    ...opts.row, values: { brand: { value: 'Xavia', source: 'master', inheritedFrom: 'gale', inherited: true, layer: 'master', pinned: false, follows: true,
      editable: true, linkGroupId: null, writeField: 'attr_brand', writeTarget: 'channelListing', writeVerb: 'channel', affectsAllChannels: false, writable: true,
      mapped: plain, ...cell } } }
  const html = renderToStaticMarkup(createElement(definition.cellRenderer, { ...definition.cellRendererParams, data, value: data.values.brand.value, node: {} }))
  expect(ariaOf(html)).toBe(titleOf(html))
  return { member: memberOf(html), sentence: titleOf(html) }
}

/** A Shopify value Nexus holds arrives `mapped: null` (`channel-sheet-projection.ts`); `channelOnly` says the Shared product supplies nothing. */
const shopifyPin = { source: 'channelExplicit', layer: 'channel', pinned: true, inherited: false, inheritedFrom: null, follows: false, mapped: null, nexusDraft: true }

const listingOverride = { source: 'channelExplicit', layer: 'channel', pinned: true, inherited: false, inheritedFrom: null, follows: false }

/* A RegExp where the sentence carries a clock time in the runner's time zone. */
const CHANNEL: [string, () => ReturnType<typeof channelTitle>, string, string | RegExp][] = [
  ['a listing override (Amazon IT, the Primary listing)', () => channelTitle({ ...listingOverride, value: 'Gale', mapped: { ...plain, value: 'Gale', provenance: 'override' } }),
    'pinned', 'Pinned on this row — it no longer follows the Shared product'],
  ['a listing override of a constant rule (its reset uses the mapping, not the Shared product)', () => channelTitle({ ...listingOverride, value: 'EU',
    mapped: { ...plain, value: 'EU', provenance: 'override', sourcePath: null } }),
    'pinned', 'Pinned on this row — it no longer follows the layer above'],
  ['a variation inheriting its listing band’s value', () => channelTitle({ source: 'aliasExplicit', layer: 'alias', inherited: true, inheritedFrom: 'cl-band', mapped: null }),
    'inherited', 'Inherited from the Primary listing, which itself overrides the Shared product — resetting returns it to the Primary listing, not to the Shared product'],
  ['a linked field', () => channelTitle({ layer: 'linked', linkGroupId: 'flg-1', mapped: null }),
    'inherited', 'Inherited from a linked field — edit to give this row its own value'],
  ['an eBay DE title showing the Italian text', () => channelTitle({ tier: 'source', language: 'it', requested: 'de', mapped: null,
    provenance: { member: 'inherited', from: 'Italian · source' } }),
    'inherited', 'Inherited from the Italian text — edit to give this row its own value'],
  ['a mapping expression', () => channelTitle({ mapped: { ...plain, usesExpression: true } }),
    'mapped', 'Derived by a mapping rule from the Shared product'],
  ['a product-grain mapping run', () => channelTitle({ mapped: { ...plain, usesExpression: true } }, { productLevelOnly: true }),
    'mapped', 'Derived per product from the Shared product — every alias of this product shares this value, so editing one changes all of them'],
  ['a channel default', () => channelTitle({ value: 'New', mapped: { ...plain, value: 'New', provenance: 'default', appliedTransforms: ['default'] } }),
    'mapped', 'Derived by a mapping rule from the channel default'],
  ['a reusable rule (an eBay description theme)', () => channelTitle({ mapped: { ...plain, supplyingRule: { id: 'r1', name: 'Racing theme', version: 2, href: '/r1' } } }),
    'mapped', 'Derived by the reusable rule “Racing theme” from the Shared product'],
  ['a reusable constant rule (no Shared source)', () => channelTitle({ value: 'EU', mapped: { ...plain, value: 'EU', sourcePath: null,
    supplyingRule: { id: 'r2', name: 'EU origin', version: 1, href: '/r2' } } }),
    'mapped', 'Derived by the reusable rule “EU origin”'],
  ['an eBay item specific on a variation row', () => channelTitle({ mapped: { ...plain, listingLevel: { productId: 'gale', sku: 'GALE-JACKET', variation: true } } }),
    'listing-level', 'One value for the whole listing, from GALE-JACKET — setting or clearing it here sets it for every variation'],
  ['an old listing text', () => channelTitle({ value: 'Old eBay title', source: 'channelSnapshot', layer: 'channel', inherited: false, tier: 'pin',
    provenance: { member: 'inherited', from: 'Italian · eBay · IT · following snapshot' }, mapped: { ...plain, value: 'Old eBay title', derived: false } }),
    'listing', 'This listing still holds its own text, not the Shared product’s — the next change to the Shared product replaces it; Follow Shared uses the Shared product’s text now'],
  ['an Amazon offer change waiting for Publish', () => channelTitle({ ...listingOverride, value: 44.9, mapped: null,
    pendingPublish: { value: 44.9, live: 49.9, savedAt: '2026-10-02T12:03:00.000Z', savedBy: 'sheet@test', note: 'Saved — pins at 44.90 when you publish', sent: true } }),
    'pending', /^Saved — pins at 44\.90 when you publish\. Saved value: 44\.90\. Live until you publish: 49\.90\. Saved 2 Oct, \d\d:03 by sheet@test$/],
  ['a Shopify edit Shopify does not have yet', () => channelTitle({ ...listingOverride, mapped: null, nexusDraft: true, unsentDraft: true }),
    'pending', 'Saved in Nexus — not sent to Shopify yet. Review synchronization to send it'],
  ['a Shopify edit Shopify does not have yet, on a field the Shared product supplies nothing for', () => channelTitle({ ...shopifyPin, unsentDraft: true, channelOnly: true }),
    'pending', 'Saved in Nexus — not sent to Shopify yet. Review synchronization to send it'],
  ['a saved Shopify pin over a Shared mapping (its reset returns the Shared value)', () => channelTitle(shopifyPin),
    'pinned', 'Pinned on this row — it no longer follows the Shared product'],
  ['a validation error on a stored listing value', () => channelTitle({ ...listingOverride, value: 'Viola',
    mapped: { ...plain, value: 'Viola', provenance: 'override', errors: ['Colour must be one of: Black, Red.'] } }),
    'attention', 'Field validation: Colour must be one of: Black, Red.'],
  ['Amazon reports FBA while Nexus sends FBM', () => channelTitle({ ...listingOverride, value: 'DEFAULT', mapped: null, fulfilmentReported: 'AFN' }),
    'attention', 'Amazon reports AFN — differs from Nexus'],
  ['a formula the server refused', () => channelTitle({ value: null }, { refused: 'Brand must be one of: Xavia, Gale.' }),
    'refused', 'Brand must be one of: Xavia, Gale.'],
  ['a cell formula', () => channelTitle({ formula: 'UPPER(brand)' }),
    'formula', 'Calculated by a formula on this cell — edit the cell to change the formula'],
  ['a translation older than its source', () => channelTitle({ tier: 'language', mapped: null, translation: { source: 'manual', reviewedAt: '2026-09-01T00:00:00Z', outdated: true } }),
    'outdated', 'Out of date — the source changed after this translation was written. Compare with the source; translate again or mark reviewed'],
  ['a machine translation not reviewed', () => channelTitle({ tier: 'language', mapped: null, translation: { source: 'ai', reviewedAt: null, outdated: false } }),
    'ai', 'Drafted by AI and not yet approved — review before it counts as confirmed'],
  ['a machine translation of an older source', () => channelTitle({ tier: 'language', mapped: null, translation: { source: 'ai', reviewedAt: null, outdated: true } }),
    'ai', 'Drafted by AI from an older value — the source text has changed since. Compare with it before approving'],
]

describe('the channel scopes: one sentence per mark, `from` meaning what the Shared scope means', () => {
  it.each(CHANNEL)('%s', (_, read, member, sentence) => {
    const out = read()
    expect(out.member).toBe(member)
    if (sentence instanceof RegExp) expect(out.sentence).toMatch(sentence)
    else expect(out.sentence).toBe(sentence)
  })
  it('🔴 no mark on a saved Shopify value the Shared product supplies nothing for — never "no longer follows the Shared product"', () => {
    // Its reset returns Shopify's own value: a channel-only field, as on every other channel.
    expect(channelTitle({ ...shopifyPin, channelOnly: true })).toEqual({ member: null, sentence: null })
    // A listing pin the studio read sent, on a field with no Shared mapping (`!rule && !saved && base.pinned`).
    expect(channelTitle({ ...shopifyPin, nexusDraft: false, channelOnly: true })).toEqual({ member: null, sentence: null })
  })
})

describe('one meaning of the source on both scopes', () => {
  it('no sentence is "label — source", and none names a listing by its bare label or its glyph', () => {
    for (const [name, read] of [...SHARED, ...CHANNEL]) {
      const { sentence } = read()
      expect([name, sentence]).not.toEqual([name, null])
      expect([name, /^(Inherited|Pinned|Derived by a mapping rule|Calculated by a formula|AI-drafted|Out of date) — [A-Z]/.test(sentence!)]).toEqual([name, false])
      expect([name, /[★①②③]|follows Primary\b|— Primary$/.test(sentence!)]).toEqual([name, false])
    }
  })
})
