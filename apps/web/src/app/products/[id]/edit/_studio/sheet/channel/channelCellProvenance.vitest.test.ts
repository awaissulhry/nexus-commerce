/**
 * 2026-10-04 (channel cell marks) — the channel sheet's ONE verdict, row by row of its order, on cells shaped as the
 * API sends them (`studio-sheet.service.ts`, `channel-sheet-projection.ts`, `amazon-offer-cells.ts`).
 *
 * The rule: no mark on a cell that simply follows the Shared product; a mark only where it differs or the next action
 * differs. And Cell details (`describeValueSource`) words the SAME member — the parity block at the bottom.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { classifyProvenance, provenanceLabel, PROVENANCE_PRECEDENCE, type CellProvenance } from '@/design-system/grid/renderers/provenance'
import { ProvenanceMark } from '@/design-system/grid/renderers/provenanceMark'
import { attentionSentence, channelCellDrawsRequired, channelCellFrom, channelCellMark, channelCellProvenance, isRequiredSentence, listingName, requiredErrorsOf, SHOPIFY_DRAFT_WORDS,
  type ChannelCellVerdictOptions } from './channelCellProvenance'
import { cellDetailsActionKind, describeValueSource } from './cellDetailsSource'
import type { AmazonOfferPending, MappedCell, StudioCellValue } from './types'

const NOW = Date.parse('2026-10-04T10:00:00.000Z')
const SAVED_AT = '2026-10-02T12:03:00.000Z'

/** A plain mapping result: the rule copies the Shared field `title` (the common case on every channel). */
const plainMapping = (over: Partial<MappedCell> = {}): MappedCell => ({
  value: 'Giacca Moto', derived: true, status: 'mapped', provenance: 'catalogRule', sourcePath: 'title', fallbackPath: null,
  usesExpression: false, legacySource: 'source', appliedTransforms: [], warnings: [], errors: [], mappingErrors: [],
  autoCorrected: null, requiredByRule: false, overLimit: null, ...over,
})

/** A channel cell that follows the Shared product through a plain mapping — the routine cell, no mark. */
const cell = (over: Partial<StudioCellValue> = {}): StudioCellValue => ({
  value: 'Giacca Moto', source: 'masterColumn', inheritedFrom: 'prod-gale', inherited: true, layer: 'master', pinned: false,
  follows: true, editable: true, linkGroupId: null, writeField: 'name', writeTarget: 'channelListing', writeVerb: 'channel',
  affectsAllChannels: false, writable: true, mapped: plainMapping(),
  ...over,
})
/** The resolver's content answer for a mapped content path: tier computed, member `mapped` (`resolve-channel-field.ts`). */
const MAPPED_CONTENT = { tier: 'computed', provenance: { member: 'mapped', from: 'Italian · source' } } as const

const ROW = { aliasPosition: 1, sku: 'GALE-JACKET-S', rowKind: 'variant' as const, aliasId: 'alias-1' }

/**
 * An EMPTY channel cell as `resolve-batch.service.ts` builds it when no rule maps the field and the listing stores nothing
 * (`status: 'unmapped'`), and the category schema check (`schema-requirements.ts`) then adds its sentence — the shape
 * `studio-sheet.service.ts` puts on the wire (`derived: false`, `sourcePath: null`, `requiredByRule` = the resolver's
 * `required`).
 */
const emptyRequired = (errors: string[], over: Partial<MappedCell> = {}): StudioCellValue => cell({ value: null, source: null as never, inheritedFrom: null,
  inherited: false, layer: 'default', pinned: false, follows: null as never, mapped: plainMapping({ value: null, derived: false, status: 'unmapped', provenance: null,
    sourcePath: null, legacySource: 'missing', errors, mappingErrors: [], ...over }) })
/** Amazon IT, GALE-JACKET: the issue is `required: true`, so the resolver marks the cell required (`requiredByRule`). */
const AMAZON_CONDITIONAL = emptyRequired(["Required by the category's condition for this product: External Product ID."], { requiredByRule: true })
/** Etsy, GALE-JACKET: Etsy fields are `requiredInParent: false`, so the schema check words the requirement as an envelope
 *  ("the taxonomy_id attribute") and leaves `required` false — only the sentence says it. A channel-only field. */
const ETSY_SCHEMA = emptyRequired(['Required by the category schema: the taxonomy_id attribute.'],
  { sourceOwner: { kind: 'listing', label: 'Etsy category selection', path: 'listing.platformAttributes.taxonomy_id' } })
const waiting = (over: Partial<AmazonOfferPending> = {}): AmazonOfferPending => ({ value: 44.9, live: 49.9, savedAt: SAVED_AT, savedBy: 'sheet@test',
  note: 'Saved — pins at 44.90 when you publish', sent: true, ...over })

interface Case {
  name: string
  cell: StudioCellValue | undefined
  options?: ChannelCellVerdictOptions
  member: CellProvenance
  /** The mark's `from` — the source's name, or the whole sentence for refused / pending / attention. */
  from?: string | null
}

const CASES: Case[] = [
  // ── refused ────────────────────────────────────────────────────────────────────────────────────────────────
  { name: 'a formula the server refused (the formula batch)', cell: cell({ value: null }), options: { refusedReason: 'Brand must be one of: Xavia, Gale.' },
    member: 'refused', from: 'Brand must be one of: Xavia, Gale.' },
  { name: 'a formula refused on the wire (`provenance.member`)', cell: cell({ value: null, provenance: { member: 'refused', from: 'Size is not a number.' } }),
    member: 'refused', from: 'Size is not a number.' },
  { name: 'a refusal outranks a mapping error', cell: cell({ mapped: plainMapping({ errors: ['Title is not compliant'] }) }), options: { refusedReason: 'No value.' },
    member: 'refused', from: 'No value.' },
  // ── attention ──────────────────────────────────────────────────────────────────────────────────────────────
  { name: 'a saved offer change Publish will not send', cell: cell({ source: 'channelExplicit', layer: 'channel', pinned: true, inherited: false, mapped: null,
    pendingPublish: waiting({ sent: false, note: 'Restock date has passed — not sent. Change it or discard it.' }) }), member: 'attention' },
  { name: 'Amazon reports FBA while Nexus sends FBM', cell: cell({ value: 'DEFAULT', source: 'channelExplicit', layer: 'channel', pinned: true, inherited: false, mapped: null, fulfilmentReported: 'AFN' }),
    member: 'attention', from: 'Amazon reports AFN — differs from Nexus' },
  { name: 'a mapping error (the old red "!")', cell: cell({ mapped: plainMapping({ errors: ['Title is not compliant'], mappingErrors: ['Title is not compliant'] }) }),
    member: 'attention', from: 'Mapping error: Title is not compliant' },
  { name: 'a validation error on a stored listing value', cell: cell({ source: 'channelExplicit', layer: 'channel', pinned: true, inherited: false,
    mapped: plainMapping({ provenance: 'override', errors: ['Colour must be one of: Black, Red.'], mappingErrors: [] }) }),
    member: 'attention', from: 'Field validation: Colour must be one of: Black, Red.' },
  { name: 'a required error on an empty cell that does not say "required" (never hidden)', cell: cell({ value: null, mapped: plainMapping({ value: null, provenance: 'missing', legacySource: 'missing', errors: ["Field 'Brand' is required."] }) }),
    member: 'attention', from: "Field validation: Field 'Brand' is required." },
  { name: 'a cell that shows one value and publishes another', cell: cell({ divergence: { publishesAs: 'Xavia', note: 'An attribute of the same name holds "Xavia", and that is what publishes.' } }),
    member: 'attention', from: 'An attribute of the same name holds "Xavia", and that is what publishes.' },
  // ── pending ────────────────────────────────────────────────────────────────────────────────────────────────
  { name: 'an Amazon offer change waiting for Publish', cell: cell({ value: [44.9], source: 'channelExplicit', layer: 'channel', pinned: true, inherited: false, mapped: null,
    pendingPublish: waiting() }), member: 'pending' },
  { name: 'a Shopify edit Shopify does not have yet (`unsentDraft`, pinned)', cell: cell({ nexusDraft: true, unsentDraft: true, source: 'channelExplicit', layer: 'channel',
    pinned: true, inherited: false, mapped: null }), member: 'pending', from: SHOPIFY_DRAFT_WORDS },
  { name: 'a Shopify reset not on Shopify yet (`unsentDraft`, not pinned)', cell: cell({ nexusDraft: true, unsentDraft: true, pinned: false, layer: 'master', mapped: plainMapping() }),
    member: 'pending', from: SHOPIFY_DRAFT_WORDS },
  { name: 'a Shopify reset draft without the flag (`nexusDraft`, not pinned: unsent by construction)', cell: cell({ nexusDraft: true, pinned: false, layer: 'master', mapped: plainMapping() }),
    member: 'pending', from: SHOPIFY_DRAFT_WORDS },
  // ── AI · outdated · formula ────────────────────────────────────────────────────────────────────────────────
  { name: 'an AI translation not reviewed', cell: cell({ tier: 'language', translation: { source: 'ai', reviewedAt: null, outdated: false } }), member: 'ai' },
  { name: 'an AI translation of an older source', cell: cell({ tier: 'language', translation: { source: 'ai', reviewedAt: null, outdated: true } }), member: 'aiStale' },
  { name: 'a translation whose source changed', cell: cell({ tier: 'language', translation: { source: 'manual', reviewedAt: '2026-09-01T00:00:00Z', outdated: true } }), member: 'outdated' },
  { name: 'a cell formula', cell: cell({ provenance: { member: 'formula', from: 'Italian · source' } }), member: 'formula', from: null },
  // ── listingLevel · listingValue ────────────────────────────────────────────────────────────────────────────
  { name: 'an eBay item specific on a variation row (one value per listing)', cell: cell({ writeField: 'attr_brand',
    mapped: plainMapping({ listingLevel: { productId: 'prod-gale', sku: 'GALE-JACKET', variation: true } }) }), member: 'listingLevel', from: 'GALE-JACKET' },
  { name: 'an old listing text (`channelSnapshot`) — never 🔗, though the wire says "inherited"', cell: cell({ value: 'Old eBay title', source: 'channelSnapshot',
    layer: 'channel', pinned: false, follows: true, inherited: false, tier: 'pin', provenance: { member: 'inherited', from: 'Italian · eBay · IT · following snapshot' },
    mapped: plainMapping({ value: 'Old eBay title', derived: false }) }),
    member: 'listingValue', from: null },
  { name: 'an old listing text just typed over (optimistic pin) reads pinned', cell: cell({ value: 'New title', source: 'channelSnapshot', layer: 'aliasVariant',
    pinned: true, follows: true, inherited: false }), member: 'pinned', from: 'the Shared product' },
  // ── mapped (a REAL transform only) ─────────────────────────────────────────────────────────────────────────
  { name: 'a mapping expression', cell: cell({ mapped: plainMapping({ usesExpression: true }) }), member: 'mapped', from: 'the Shared product' },
  { name: 'a product-grain mapping run', cell: cell({ mapped: plainMapping({ usesExpression: true }) }), options: { productLevelOnly: true }, member: 'mappedShared' },
  // The rule is the sentence's author (`channelCellBy`); `from` stays the source it reads.
  { name: 'a reusable shared rule', cell: cell({ mapped: plainMapping({ supplyingRule: { id: 'r1', name: 'Apparel brand', version: 3, href: '/rules/r1' } }) }),
    member: 'mapped', from: 'the Shared product' },
  { name: 'a channel default', cell: cell({ value: 'New', mapped: plainMapping({ value: 'New', provenance: 'default', sourcePath: 'condition', appliedTransforms: ['default'] }) }),
    member: 'mapped', from: 'the channel default' },
  { name: 'a constant rule (no source path)', cell: cell({ value: 'EU', mapped: plainMapping({ value: 'EU', sourcePath: '' }) }), member: 'mapped', from: null },
  // A transform that ADDS or REWRITES content, when it ran, makes the value differ from the Shared product (lead, 2026-10-04).
  ...(['template', 'prepend', 'append', 'replace'] as const).map((transform): Case => ({ name: `a rule whose ${transform} transform ran`,
    cell: cell({ value: 'Giacca Moto — Xavia', mapped: plainMapping({ value: 'Giacca Moto — Xavia', appliedTransforms: ['truncate', transform] }) }), member: 'mapped', from: 'the Shared product' })),
  // ── own: follows the Shared product ────────────────────────────────────────────────────────────────────────
  { name: 'a plain path that copies the Shared field — no Σ although the server says derived', cell: cell(MAPPED_CONTENT), member: 'own' },
  { name: 'a plain path with channel adjustments', cell: cell({ mapped: plainMapping({ appliedTransforms: ['truncate', 'titleCase'] }) }), member: 'own' },
  // A vocabulary or format conversion says the same fact in the channel's words: no mark (Cell details lists it).
  ...(['valueMap', 'sizeScale', 'unit', 'numberFormat', 'titleCase', 'lowerCase', 'upperCase', 'truncate', 'channelLimit'] as const).map((transform): Case => ({
    name: `a plain path whose ${transform} conversion ran`, cell: cell({ mapped: plainMapping({ appliedTransforms: [transform] }) }), member: 'own' })),
  { name: 'a plain fallback path', cell: cell({ mapped: plainMapping({ sourcePath: 'subtitle', fallbackPath: 'name', legacySource: 'fallback', provenance: 'fallback' }) }), member: 'own' },
  { name: 'Shared text with no rule (a content value)', cell: cell({ tier: 'source', provenance: { member: 'inherited', from: 'Italian · source' },
    mapped: plainMapping({ derived: false, sourcePath: null }) }), member: 'own' },
  { name: 'an identity field locked to the Shared product', cell: cell({ mapped: plainMapping({ provenance: 'locked', sourcePath: 'gtin' }) }), member: 'own' },
  { name: 'a variant’s own Shared value — no ✎ although the server sends `pinned`', cell: cell({ source: 'variant', layer: 'variant', pinned: true, inherited: false, mapped: null }),
    member: 'own' },
  { name: 'the parent’s Shared value on a variation', cell: cell({ mapped: null }), member: 'own' },
  { name: 'a reviewed translation', cell: cell({ mapped: null, tier: 'language', language: 'de', requested: 'de', provenance: { member: 'inherited', from: 'German · shared' },
    translation: { source: 'manual', reviewedAt: '2026-09-01T00:00:00Z', outdated: false } }), member: 'own' },
  /* A channel-only field as the server sends a STORED listing value of it (the wire fixture in
     `packages/shared/sheet-cell-wire.vitest.test.ts`): `pinned: true`, `provenance: 'override'`, `sourceOwner` set. There
     is nothing in the Shared product for it to follow — no ✎. */
  { name: 'a channel-only field (a stored listing value)', cell: cell({ value: 'Returns accepted', source: 'channelExplicit', layer: 'channel', pinned: true, inherited: false,
    follows: false, inheritedFrom: null, mapped: plainMapping({ value: 'Returns accepted', derived: false, provenance: 'override', sourcePath: null,
      sourceOwner: { kind: 'listing', label: 'Listing settings', path: 'listing.platformAttributes.returnPolicyId' } }) }), member: 'own' },
  { name: 'a channel-only field on a variation row (its own listing’s value; no band value to override)', cell: cell({ value: 'Nuovo', source: 'channelExplicit', layer: 'alias',
    pinned: true, inherited: false, follows: false, inheritedFrom: null, mapped: plainMapping({ value: 'Nuovo', derived: false, provenance: 'override', sourcePath: null,
      sourceOwner: { kind: 'listing', label: 'eBay listing value', path: 'itemSpecifics.Condizione' } }) }), member: 'own' },
  { name: 'a channel-only field just typed (optimistic pin)', cell: cell({ value: 'New policy', source: 'channelExplicit', layer: 'aliasVariant', pinned: true, inherited: false,
    mapped: plainMapping({ derived: false, provenance: 'override', sourcePath: null, sourceOwner: { kind: 'listing', label: 'Listing settings', path: 'x' } }) }), member: 'own' },
  { name: 'an unmapped field', cell: cell({ value: null, mapped: plainMapping({ value: null, status: 'unmapped', provenance: null, sourcePath: null }) }), member: 'own' },
  { name: 'a rule that produces nothing', cell: cell({ value: null, mapped: plainMapping({ value: null, provenance: 'missing', legacySource: 'missing' }) }), member: 'own' },
  { name: 'an empty cell', cell: cell({ value: null, source: 'default', layer: 'default', inherited: false, mapped: null }), member: 'own' },
  { name: 'a required empty cell that already says "required"', cell: cell({ value: null, mapped: plainMapping({ value: null, provenance: 'missing', errors: ["Field 'Brand' is required."] }) }),
    options: { drawsRequired: true }, member: 'own' },
  /* 2026-10-04 (fix C) — the real wire of the two cases measured on GALE-JACKET (`emptyRequired` below). */
  { name: 'Amazon: an empty cell the category’s condition requires (draws "⚠ required")', cell: AMAZON_CONDITIONAL, options: { drawsRequired: true }, member: 'own' },
  { name: 'Etsy: an empty cell the category schema requires (draws "⚠ required")', cell: ETSY_SCHEMA, options: { drawsRequired: true }, member: 'own' },
  { name: 'an empty required cell with another error beside the required one', cell: emptyRequired(["Required by the category's condition for this product: External Product ID.",
    'Category requirement validation is unavailable: The category validation schema is unavailable.'], { requiredByRule: true }), options: { drawsRequired: true },
    member: 'attention', from: 'Field validation: Category requirement validation is unavailable: The category validation schema is unavailable.' },
  { name: 'an empty cell whose only error is an alternative (not a requirement of this field)', cell: emptyRequired(['The category requires an allowed alternative; this option needs: External Product ID.']),
    member: 'attention', from: 'Field validation: The category requires an allowed alternative; this option needs: External Product ID.' },
  { name: 'a FILLED cell whose error says "required"', cell: cell({ mapped: plainMapping({ errors: ["Required by the category's condition for this product: External Product ID."], requiredByRule: true }) }),
    member: 'attention', from: "Field validation: Required by the category's condition for this product: External Product ID." },
  { name: 'no cell at all', cell: undefined, member: 'own' },
  // ── inheritedOverride · inherited ──────────────────────────────────────────────────────────────────────────
  { name: 'a variation inheriting its alias band’s value', cell: cell({ source: 'aliasExplicit', layer: 'alias', inherited: true, inheritedFrom: 'cl-alias-1', mapped: null }),
    member: 'inheritedOverride', from: 'the Bundle listing' },
  { name: 'a linked field', cell: cell({ layer: 'linked', linkGroupId: 'flg-1', mapped: null }), member: 'inherited', from: 'a linked field' },
  { name: 'a Shopify sharing rule (follows its source product)', cell: cell({ layer: 'linked', inherited: true, follows: true, source: 'channelExplicit', mapped: null }),
    member: 'inherited', from: 'a linked field' },
  /* The real wire (`studio-content-wire.ts`): an eBay DE title showing the Italian text arrives `language: 'it'`,
     `requested: 'de'`, `provenance.member: 'inherited'`. */
  { name: 'a language fallback (an eBay DE title showing the Italian text)', cell: cell({ value: 'Giacca Moto', mapped: null, tier: 'source', language: 'it', requested: 'de',
    provenance: { member: 'inherited', from: 'Italian · source' } }), member: 'inherited', from: 'the Italian text' },
  { name: 'a language fallback through a plain mapped path', cell: cell({ tier: 'computed', language: 'it', requested: 'de', provenance: { member: 'mapped', from: 'Italian · source' } }),
    member: 'inherited', from: 'the Italian text' },
  { name: 'the requested language under a regional tag is no fallback', cell: cell({ mapped: null, tier: 'language', language: 'de', requested: 'de-AT',
    provenance: { member: 'inherited', from: 'German · shared' } }), member: 'own' },
  { name: 'an empty cell is no language fallback', cell: cell({ value: null, mapped: null, tier: 'computed', language: 'it', requested: 'de', provenance: { member: 'inherited', from: null } }),
    member: 'own' },
  // ── pinned ─────────────────────────────────────────────────────────────────────────────────────────────────
  { name: 'a listing override (the mapping reads the listing’s own value)', cell: cell({ source: 'channelExplicit', layer: 'channel', pinned: true, inherited: false,
    mapped: plainMapping({ provenance: 'override' }) }), member: 'pinned', from: 'the Shared product' },
  { name: 'a value pinned on this variation × alias', cell: cell({ source: 'channelExplicit', layer: 'aliasVariant', pinned: true, inherited: false, mapped: null }), member: 'pinned',
    from: 'the Shared product' },
  /* A pin over a mapping with no plain Shared source: its reset uses "the configured mapping or default"
     (`resetSourceLabel`), so the mark names no source and says "the layer above". */
  { name: 'a listing override of a constant rule', cell: cell({ value: 'EU', source: 'channelExplicit', layer: 'channel', pinned: true, inherited: false,
    mapped: plainMapping({ value: 'EU', provenance: 'override', sourcePath: null }) }), member: 'pinned', from: null },
  { name: 'an alias band’s own value, on the band', cell: cell({ source: 'aliasExplicit', layer: 'alias', pinned: true, inherited: false, mapped: null }), member: 'pinned' },
  { name: 'a deliberately cleared override', cell: cell({ value: null, source: 'channelExplicit', layer: 'channel', pinned: true, inherited: false, mapped: null }), member: 'pinned' },
  /* A saved Shopify pin synchronization already sent (`nexusDraft`, pinned, no `unsentDraft`) arrives `mapped: null`
     (`channel-sheet-projection.ts`). Over a Shared mapping, its reset returns the Shared value: ✎ "no longer follows the
     Shared product" is true. On a field the Shared product supplies nothing for (`channelOnly`), its reset returns
     Shopify's own value: a channel-only field, no mark. */
  { name: 'a saved Shopify pin over a Shared mapping (synchronization already sent)', cell: cell({ nexusDraft: true, source: 'channelExplicit', layer: 'channel',
    pinned: true, inherited: false, mapped: null }), member: 'pinned', from: 'the Shared product' },
  { name: 'a saved Shopify pin on a field the Shared product supplies nothing for (`channelOnly`)', cell: cell({ nexusDraft: true, channelOnly: true,
    source: 'channelExplicit', layer: 'channel', pinned: true, inherited: false, inheritedFrom: null, follows: false, mapped: null }), member: 'own' },
  { name: 'a Shopify listing pin from the studio read on a field the Shared product supplies nothing for', cell: cell({ channelOnly: true,
    source: 'channelExplicit', layer: 'channel', pinned: true, inherited: false, inheritedFrom: null, follows: false, mapped: null }), member: 'own' },
  { name: 'a Shopify edit not sent yet, on a field the Shared product supplies nothing for (`channelOnly`) — still waits', cell: cell({ nexusDraft: true,
    unsentDraft: true, channelOnly: true, source: 'channelExplicit', layer: 'channel', pinned: true, inherited: false, mapped: null }),
    member: 'pending', from: SHOPIFY_DRAFT_WORDS },
  /* "Has a value" by the cell's own rule (`channelCellPresent`): a list of blanks draws empty, so it wears no 🔗 or
     "Listing value" beside it. */
  { name: 'a linked list of blanks', cell: cell({ value: ['', ''], layer: 'linked', linkGroupId: 'flg-1', mapped: null }), options: { shape: 'list' }, member: 'own' },
  { name: 'an old listing list of blanks', cell: cell({ value: ['  '], source: 'channelSnapshot', layer: 'channel', pinned: false, inherited: false,
    mapped: plainMapping({ value: [''], derived: false }) }), options: { shape: 'list' }, member: 'own' },
  { name: 'a linked list with one filled position', cell: cell({ value: ['', 'Waterproof'], layer: 'linked', linkGroupId: 'flg-1', mapped: null }), options: { shape: 'list' },
    member: 'inherited', from: 'a linked field' },
]

const context = (c: Case) => ({ refusedReason: c.options?.refusedReason ?? null, row: ROW, aliasLabel: 'Bundle listing', drawsRequired: c.options?.drawsRequired, now: NOW })

describe('channelCellProvenance — one member per cell state, in the order of the next action', () => {
  it.each(CASES.map(c => [c.name, c] as const))('%s', (_, c) => {
    const member = channelCellProvenance(c.cell, c.options)
    expect(member).toBe(c.member)
    if (c.from !== undefined) expect(channelCellFrom(c.cell, member, context(c))).toBe(c.from)
  })

  it('names nothing for a cell with no mark', () => {
    for (const c of CASES.filter(x => x.member === 'own')) expect(channelCellProvenance(c.cell, c.options)).toBe('own')
  })
})

describe('the mark’s one text (its hover and its accessible name), as the cell renders it', () => {
  const hover = (c: Case) => {
    const member = channelCellProvenance(c.cell, c.options)
    if (member === 'own') return ''
    // What `CascadeCell` gives the mark: `from` — and the whole sentence when a reusable rule authors the value.
    const mark = channelCellMark(c.cell, member, context(c))
    const html = renderToStaticMarkup(createElement(ProvenanceMark, { provenance: member, from: mark.from, tooltip: mark.tooltip }))
    const title = /title="([^"]*)"/.exec(html)?.[1] ?? ''
    expect(/aria-label="([^"]*)"/.exec(html)?.[1]).toBe(title)
    return title.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  }
  const byName = (name: string) => CASES.find(c => c.name.startsWith(name))!

  it('a refusal says the server’s reason and nothing else (#780)', () => {
    expect(hover(byName('a formula the server refused'))).toBe('Brand must be one of: Xavia, Gale.')
  })
  it('a waiting offer change says the saved value, the live value and when — the words Cell details shows', () => {
    const text = hover(byName('an Amazon offer change waiting'))
    expect(text).toContain('Saved — pins at 44.90 when you publish')
    expect(text).toContain('Live until you publish: 49.90')
  })
  it('a saved change Publish will not send says so, in the server’s words', () => {
    expect(hover(byName('a saved offer change Publish will not send'))).toContain('Restock date has passed — not sent.')
  })
  it('a mapping error says the mapping note', () => {
    expect(hover(byName('a mapping error'))).toBe('Mapping error: Title is not compliant')
    expect(attentionSentence(byName('a mapping error').cell!)).toBe('Mapping error: Title is not compliant')
  })
  it('an old listing text names the listing’s own text, never "Inherited"', () => {
    const text = hover(byName('an old listing text (`channelSnapshot`)'))
    expect(text).toMatch(/own text/)
    expect(text).not.toMatch(/^Inherited/)
  })
  it('a listing-level value names the listing’s SKU — never the row’s own', () => {
    expect(hover(byName('an eBay item specific'))).toContain('GALE-JACKET')
    const own = byName('an eBay item specific').cell!
    expect(channelCellFrom(own, 'listingLevel', { row: { ...ROW, sku: 'GALE-JACKET' } })).toBeNull()
  })
  it('a Shopify edit Shopify does not have yet says so, in plain words', () => {
    expect(hover(byName('a Shopify edit Shopify does not have yet'))).toBe('Saved in Nexus — not sent to Shopify yet. Review synchronization to send it')
  })
  it('a language fallback names the language, never its code', () => {
    expect(hover(byName('a language fallback (an eBay DE title'))).toBe('Inherited from the Italian text — edit to give this row its own value')
  })
  /* 2026-10-04 (fix C) — ONE sentence per mark, the Shared scope's words: `from` is what the value follows, came from or
     no longer follows. "Pinned — Bundle listing" named where the pin lives; on Shared the same pattern named what it follows. */
  it('a member both scopes draw reads the Shared scope’s one sentence, `from` naming what the value follows', () => {
    expect(hover(byName('a listing override'))).toBe('Pinned on this row — it no longer follows the Shared product')
    expect(hover(byName('a listing override of a constant rule'))).toBe('Pinned on this row — it no longer follows the layer above')
    expect(hover(byName('a variation inheriting its alias band'))).toBe(
      'Inherited from the Bundle listing, which itself overrides the Shared product — resetting returns it to the Bundle listing, not to the Shared product')
    expect(hover(byName('a linked field'))).toBe('Inherited from a linked field — edit to give this row its own value')
    expect(hover(byName('a reusable shared rule'))).toBe('Derived by the reusable rule “Apparel brand” from the Shared product')
    expect(hover(byName('a channel default'))).toBe('Derived by a mapping rule from the channel default')
    expect(hover(byName('a cell formula'))).toBe('Calculated by a formula on this cell — edit the cell to change the formula')
  })
  it('names an alias as a listing — by its label, else its position — never a bare label, "label not reported" or its glyph', () => {
    const c = byName('a variation inheriting its alias band')
    expect(channelCellFrom(c.cell, 'inheritedOverride', { row: { ...ROW, aliasPosition: 0 }, aliasLabel: 'Primary' })).toBe('the Primary listing')
    expect(channelCellFrom(c.cell, 'inheritedOverride', { row: { ...ROW, aliasPosition: 0 }, aliasLabel: null })).toBe('the Main listing')
    expect(channelCellFrom(c.cell, 'inheritedOverride', { row: { ...ROW, aliasPosition: 2 }, aliasLabel: '  ' })).toBe('listing alias 2')
    expect(listingName('Bundle listing', 1)).toBe('the Bundle listing')
    expect(listingName('The outlet', 3)).toBe('The outlet listing')
  })
  it('no accessible name carries an alias glyph (a screen reader says "black star" for ★)', () => {
    for (const c of CASES) expect(hover(c)).not.toMatch(/[★①②③④⑤⑥⑦⑧⑨]/)
  })
  it('looks the alias label up only for a member that names the listing — never for a cell with no mark', () => {
    let lookups = 0
    const aliasLabel = () => { lookups++; return 'Bundle listing' }
    for (const c of CASES.filter(x => x.member === 'own')) channelCellFrom(c.cell, channelCellProvenance(c.cell, c.options), { row: ROW, aliasLabel })
    expect(lookups).toBe(0)
    // A pin names what it no longer follows (the Shared product), not the listing: no lookup.
    expect(channelCellFrom(byName('a listing override').cell, 'pinned', { row: ROW, aliasLabel })).toBe('the Shared product')
    expect(lookups).toBe(0)
    // An old listing text: the DS sentence names no listing, so nothing is looked up.
    expect(channelCellFrom(byName('an old listing text (`channelSnapshot`)').cell, 'listingValue', { row: ROW, aliasLabel })).toBeNull()
    expect(lookups).toBe(0)
    expect(channelCellFrom(byName('a variation inheriting its alias band').cell, 'inheritedOverride', { row: ROW, aliasLabel })).toBe('the Bundle listing')
    expect(lookups).toBe(1)
  })
  it('never shows a raw server tier string', () => {
    for (const c of CASES) expect(hover(c)).not.toMatch(/ · (pin|following snapshot|source|shared)$/)
  })
})

describe('the precedence is the DS’s, defined once', () => {
  it('a cell holding several facts wears the strongest by PROVENANCE_PRECEDENCE', () => {
    // A waiting offer change on a listing pin with a mapping error: attention › pending › pinned.
    const many = cell({ source: 'channelExplicit', layer: 'channel', pinned: true, inherited: false, pendingPublish: waiting(),
      mapped: plainMapping({ provenance: 'override', errors: ['Price is below the floor'] }) })
    expect(channelCellProvenance(many)).toBe('attention')
    expect(PROVENANCE_PRECEDENCE.indexOf('attention')).toBeLessThan(PROVENANCE_PRECEDENCE.indexOf('pending'))
    expect(channelCellProvenance({ ...many, mapped: plainMapping({ provenance: 'override' }) })).toBe('pending')
  })
})

describe('why the DS classifier is not the channel verdict (it still serves the Variants tab)', () => {
  it('the three cases it gets wrong on this sheet', () => {
    const plain = CASES.find(c => c.name.startsWith('a plain path that copies'))!.cell
    const variantOwn = CASES.find(c => c.name.startsWith('a variant’s own Shared value'))!.cell
    const snapshot = CASES.find(c => c.name.startsWith('an old listing text (`channelSnapshot`)'))!.cell
    expect(classifyProvenance(plain, 'channel')).toBe('mapped')
    expect(channelCellProvenance(plain)).toBe('own')
    expect(classifyProvenance(variantOwn, 'channel')).toBe('pinned')
    expect(channelCellProvenance(variantOwn)).toBe('own')
    expect(classifyProvenance(snapshot, 'channel')).toBe('inherited')
    expect(channelCellProvenance(snapshot)).toBe('listingValue')
  })
})

/** Cell details words the SAME member the mark draws — the two can never disagree. */
const KINDS: Record<CellProvenance, readonly string[]> = {
  refused: ['warning'], attention: ['warning'], pending: ['pending'], ai: ['ai'], aiStale: ['ai'], outdated: ['warning'],
  formula: ['formula'], listingLevel: ['channel'], listingValue: ['channel'], mapped: ['rule', 'default'], mappedShared: ['rule', 'default'],
  inheritedOverride: ['linked'], inherited: ['linked', 'warning'], pinned: ['override'], own: ['master', 'channel', 'missing'],
}

/** Every mark's label — Cell details never uses one for a cell drawn with no mark. */
const MARK_LABELS = PROVENANCE_PRECEDENCE.filter(m => m !== 'own').map(provenanceLabel)

describe('Cell details agrees with the mark (parity)', () => {
  it.each(CASES.map(c => [c.name, c] as const))('%s', (_, c) => {
    const member = channelCellProvenance(c.cell, c.options)
    const words = describeValueSource(c.cell, member, c.options?.refusedReason ?? null, c.options?.drawsRequired)
    expect(KINDS[member]).toContain(words.kind)
    // A marked cell: Cell details names it with the mark's own label; a cell with no mark never borrows one.
    if (member === 'own') expect(MARK_LABELS).not.toContain(words.label)
    else expect(words.label).toBe(provenanceLabel(member))
    expect(words.description).not.toMatch(/Master/)
  })

  it('explains an attention cell by the cause that raised it, not by a filtered-out required error', () => {
    const c = cell({ value: null, mapped: plainMapping({ value: null, provenance: 'missing', errors: ["Field 'Brand' is required."] }),
      divergence: { publishesAs: 'Xavia', note: 'Xavia is what publishes.' } })
    expect(channelCellProvenance(c, { drawsRequired: true })).toBe('attention')
    expect(describeValueSource(c, 'attention', null, true)).toEqual({ kind: 'warning', label: provenanceLabel('attention'), description: 'Publishes another value: Xavia is what publishes.' })
  })

  it('names a language fallback’s languages by name, never by code', () => {
    const c = byCase('a language fallback (an eBay DE title')
    expect(describeValueSource(c, 'inherited').description).toBe('Showing the Italian text: there is no German text yet. This value does not count as translated content')
  })

  it('names the content transforms that made a mapped value differ, and lists conversions as channel adjustments', () => {
    expect(describeValueSource(byCase('a rule whose append transform ran'), 'mapped').description).toContain('changed by append, so it differs from the Shared product')
    expect(describeValueSource(byCase('a plain path whose valueMap conversion ran'), 'own').description).toContain('Channel adjustments: valueMap')
  })

  it('🔴 offers the actions of what the value IS underneath — an attention mark on top does not take "Keep as listing override" away', () => {
    // A plain inherited (Shared-following) value with a mapping error: the mark and Cell details' words say the error…
    const inheritedWithError = cell({ mapped: plainMapping({ errors: ['Title is not compliant'], mappingErrors: ['Title is not compliant'] }) })
    expect(channelCellProvenance(inheritedWithError)).toBe('attention')
    expect(describeValueSource(inheritedWithError, 'attention')).toMatchObject({ kind: 'warning', description: 'Mapping error: Title is not compliant' })
    // …and the actions follow the inherited value: not a kind that withholds them (formula, warning, ai).
    expect(cellDetailsActionKind(inheritedWithError)).toBe('master')
    // The same for a linked value that publishes another value, and for a listing pin with a validation error.
    const linkedDivergent = cell({ layer: 'linked', linkGroupId: 'flg-1', mapped: null, divergence: { publishesAs: 'Xavia', note: 'Xavia is what publishes.' } })
    expect(channelCellProvenance(linkedDivergent)).toBe('attention')
    expect(cellDetailsActionKind(linkedDivergent)).toBe('linked')
    expect(cellDetailsActionKind(byCase('a validation error on a stored listing value'))).toBe('override')
    // A pending mark too: an Amazon offer change waiting for Publish sits on a listing pin.
    expect(cellDetailsActionKind(byCase('an Amazon offer change waiting for Publish'))).toBe('override')
    // What withheld them before still does: a language fallback, a refusal, a formula — and, kept on purpose, an offer
    // change Publish will not send and a listing Amazon reports as FBA (the FBA boundary: no Keep / Reset from here).
    expect(cellDetailsActionKind(byCase('a language fallback (an eBay DE title'))).toBe('warning')
    expect(cellDetailsActionKind(cell({ layer: 'channel', pinned: true, fulfilmentReported: 'AMAZON_EU' } as never))).toBe('warning')
    expect(cellDetailsActionKind(byCase('a saved offer change Publish will not send'))).toBe('warning')
    expect(cellDetailsActionKind(cell(), { refusedReason: 'No value.' })).toBe('warning')
    expect(cellDetailsActionKind(byCase('a cell formula'))).toBe('formula')
  })

  it('words a Shopify pin truthfully whether or not synchronization has sent it', () => {
    const words = describeValueSource(byCase('a saved Shopify pin'), 'pinned')
    expect(words.label).toBe(provenanceLabel('pinned'))
    expect(words.description).not.toMatch(/sent|synchroni/i)
  })

  it('words a product-grain mapping by its scope: editing one changes all of them', () => {
    expect(describeValueSource(byCase('a mapping expression'), 'mappedShared').description).toContain('editing one changes all of them')
  })
})

function byCase(name: string): StudioCellValue {
  return CASES.find(c => c.name.startsWith(name))!.cell!
}

/**
 * 2026-10-04 (fix C) — an EMPTY channel cell whose only server errors say the channel requires a value draws `⚠ required`
 * and no mark, as the Shared scope draws it. Measured on GALE-JACKET before: 341 of Amazon IT's 366 `attention` marks and
 * Etsy's 105 were exactly this.
 */
describe('an empty cell the channel requires: "⚠ required", no mark', () => {
  const column = { key: 'external_product_id', label: 'External Product ID', shape: 'scalar', kind: 'text', scope: 'global', requiredBy: [] } as never
  const requiredColumn = { key: 'title', label: 'Title', shape: 'scalar', kind: 'text', scope: 'global', requiredBy: ['Amazon · IT'] } as never
  const row = { id: 'p', rowId: 'p', sku: 'GALE-JACKET-S', isParent: false, productType: null, familyId: null, values: {} } as never

  it('recognises the server’s own required sentences — and nothing that asks for a different action', () => {
    for (const sentence of ["Field 'Brand' is required.", "Field 'Men's size' is required.",
      "Required by the category's condition for this product: External Product ID.", 'Required by the category schema: Brand.',
      'Required by the category schema: the taxonomy_id attribute.']) expect([sentence, isRequiredSentence(sentence)]).toEqual([sentence, true])
    for (const sentence of ['The category requires an allowed alternative; this option needs: External Product ID.',
      'Required by the category schema: the item_weight attribute needs unit.', 'Translation into de is pending.',
      'Showing it fallback; de content is missing.', 'Category requirement validation is unavailable: x', 'Colour must be one of: Black, Red.',
      'This rule targets a field absent from the selected category schema. Review the rule or refresh the schema.'])
      expect([sentence, isRequiredSentence(sentence)]).toEqual([sentence, false])
  })

  it('draws "⚠ required" by the resolver’s verdict (Amazon), by the sentence alone (Etsy) or by the Shared rule', () => {
    expect(channelCellDrawsRequired(column, row, AMAZON_CONDITIONAL)).toBe(true)
    expect(channelCellDrawsRequired(column, row, ETSY_SCHEMA)).toBe(true)
    expect(channelCellDrawsRequired(requiredColumn, row, emptyRequired([]))).toBe(true)
    // The resolver's structured verdict alone, whatever words travel with it.
    expect(channelCellDrawsRequired(column, row, emptyRequired(['Translation into de is pending.'], { requiredByRule: true }))).toBe(true)
    // Nothing requires it: `—`.
    expect(channelCellDrawsRequired(column, row, emptyRequired([]))).toBe(false)
    expect(channelCellDrawsRequired(column, row, emptyRequired(['The category requires an allowed alternative; this option needs: External Product ID.']))).toBe(false)
    // A value is there: never "required", whatever the errors say.
    expect(channelCellDrawsRequired(column, row, { ...AMAZON_CONDITIONAL, value: 'B0FXTEST01' })).toBe(false)
  })

  it('wears no mark once it draws "⚠ required", and Cell details still has the whole server sentence', () => {
    for (const c of [AMAZON_CONDITIONAL, ETSY_SCHEMA]) {
      const drawsRequired = channelCellDrawsRequired(column, row, c)
      expect(channelCellProvenance(c, { drawsRequired })).toBe('own')
      // The sentence stays on the cell: Cell details' notes list `mapped.errors` (`openCellDetails`).
      expect(requiredErrorsOf(c)).toEqual(c.mapped!.errors)
    }
  })

  it('keeps `attention` — named by the OTHER cause — when an error that is not a requirement stands beside it', () => {
    const c = emptyRequired(["Required by the category's condition for this product: External Product ID.", 'Translation into de is pending.'], { requiredByRule: true })
    const drawsRequired = channelCellDrawsRequired(column, row, c)
    expect(drawsRequired).toBe(true)
    expect(channelCellProvenance(c, { drawsRequired })).toBe('attention')
    expect(attentionSentence(c, drawsRequired)).toBe('Field validation: Translation into de is pending.')
    expect(describeValueSource(c, 'attention', null, drawsRequired).description).toBe('Field validation: Translation into de is pending.')
  })
})
