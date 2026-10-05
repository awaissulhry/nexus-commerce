import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CellSaveTracker } from '@/design-system/grid'
import { buildChannelColumns, type BuildChannelColumnsOptions } from './channelColumns'
import { channelCellProvenance } from '../channel/channelCellProvenance'
import { GALE_AMAZON_DE_DERIVED } from '../../../../../../../../../../docs/fixtures/vt1/fixtures'

const base = { key: 'title', label: 'German title', writeField: 'name', group: 'Content', kind: 'longtext',
  storage: 'column', scope: 'global', requiredBy: [], editable: true, width: 380 } as const
function setup(columns: unknown[] = [base], tracker = new CellSaveTracker(), overrides: Partial<BuildChannelColumnsOptions> = {}) {
  const opts = { data: { scope: { channel: 'AMAZON', marketplace: 'DE', label: 'Amazon · DE' } },
    gridColumns: columns, formulaWiring: { exprFor: () => null, errorFor: () => null },
    productLevelOnly: false, refusedReasonFor: () => null,
    tracker, activeCellsRef: { current: null }, viewCtx: { locale: 'de', variationAxes: [], flaggedKeys: [] },
    mediaEditor: { open: () => {}, actions: {} }, shopifyEditor: { open: () => {} }, auth: { has: () => true }, ...overrides,
  } as unknown as BuildChannelColumnsOptions
  return buildChannelColumns(opts)
}
describe('LX.11 hoisted channel column factory', () => {
  it('builds hidden columns too and keeps contract widths and labels', () => {
    const defs = setup([base, { ...base, key: 'hidden', defaultVisible: false, width: 123 }])
    expect(defs.map(c => [c.colId, c.headerName, c.width])).toEqual([['title', 'German title', 380], ['hidden', 'German title', 123]])
  })
  it('preserves writable veto and mutates the actual row while retaining the content address', () => {
    const [col] = setup()
    const address = { tier: 'pin', language: 'de', coordinate: { channel: 'AMAZON', market: 'DE' } }
    const data = { rowKind: 'variant', values: { title: { value: 'Before', writable: false, contentAddress: address } } }
    expect((col.editable as Function)({ data })).toBe(false)
    data.values.title.writable = true
    expect((col.editable as Function)({ data })).toBe(true)
    expect((col.valueSetter as Function)({ data, newValue: 'After' })).toBe(true)
    expect(data.values.title.value).toBe('After'); expect(data.values.title.contentAddress).toEqual(address)
    expect((col.valueGetter as Function)({ data })).toBe('After')
  })
  it('uses the shared list editor without flattening an explicit clear', () => {
    const [col] = setup([{ ...base, key: 'bullets', kind: 'text', shape: 'list', cardinality: { min: 0, max: null } }])
    const data = { values: { bullets: { value: ['One'] } } }
    expect((col.valueSetter as Function)({ data, newValue: [] })).toBe(true)
    expect(data.values.bullets.value).toEqual([])
    expect(col.cellEditorSelector).toBeTypeOf('function')
  })
})

it.each(['saving', 'waiting', 'unknown', 'refused', 'saved'] as const)('renders the actual channel cell save state %s beside its value', state => {
  const tracker = new CellSaveTracker()
  tracker.set('alias:gale', 'title', state, 'The server has not confirmed this value.')
  const [definition] = setup([{ ...base, kind: 'text' }], tracker)
  const data = { id: 'gale', rowId: 'alias:gale', sku: 'GALE-JACKET', rowKind: 'variant', isParent: false,
    values: { title: { value: 'Visible title', mapped: { status: 'mapped', derived: false, errors: [], warnings: [] } } } }
  const html = renderToStaticMarkup(createElement(definition.cellRenderer, { ...definition.cellRendererParams, data, value: 'Visible title', node: {} }))
  // The Shared scope's layout: mark slot, text, save marks — one part for both scopes.
  expect(html).toMatch(/^<span class="nds-cell-value"><span class="nds-cell-value-text">Visible title<\/span>/)
  expect(html).toContain('The server has not confirmed this value.')
  if (state === 'saving' || state === 'waiting' || state === 'unknown') {
    expect(html).toContain(`data-state="${state}"`)
    expect(html).toContain('role="img"')
  } else expect(html).not.toContain('nds-save-mark')
})

/**
 * 2026-10-04 (channel cell marks) — the Shared scope's rule on every channel: no mark where a cell simply follows the
 * Shared product, a mark only where it differs or its next action differs. The old always-on source indicator is gone.
 */
const render = (definition: ReturnType<typeof setup>[number], data: unknown, value: unknown = 'Visible title') =>
  renderToStaticMarkup(createElement(definition.cellRenderer, { ...definition.cellRendererParams, data, value, node: {} }))
const markOf = (html: string) => /nds-cell-prov-([a-z-]+)/.exec(html)?.[1] ?? null
const titleOf = (html: string) => /class="nds-cell-prov[^"]*"[^>]*title="([^"]*)"/.exec(html)?.[1]?.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&') ?? null
const plain = { status: 'mapped', provenance: 'catalogRule', sourcePath: 'title', derived: true, usesExpression: false, legacySource: 'source', errors: [], warnings: [], appliedTransforms: [] }

describe.each(['EBAY', 'AMAZON', 'SHOPIFY', 'ETSY'])('%s scope marks', channel => {
  const scope = { data: { scope: { channel, marketplace: 'DE', label: `${channel} · DE` } } } as BuildChannelColumnsOptions
  const cellOf = (cell: Record<string, unknown>) => ({ id: 'gale', rowId: 'primary:gale', sku: 'GALE-JACKET', rowKind: 'variant', isParent: false, aliasPosition: 0,
    values: { title: { value: 'Visible title', source: 'masterColumn', layer: 'master', inherited: true, pinned: false, follows: true, mapped: null, ...cell } } })
  const [definition] = setup([{ ...base, kind: 'text' }], undefined, scope)

  it.each([
    ['a plain mapped path — no Σ, though the server says derived', { mapped: plain, tier: 'computed', provenance: { member: 'mapped', from: 'German · source' } }],
    ['the Shared value', {}],
    ['a variant’s own Shared value — no ✎, though the server sends pinned', { source: 'variant', layer: 'variant', pinned: true, inherited: false }],
    // As the server sends a stored listing value of a channel-only field: pinned, `provenance: 'override'`, `sourceOwner`.
    ['a channel-only field', { source: 'channelExplicit', layer: 'channel', inherited: false, pinned: true, follows: false,
      mapped: { ...plain, derived: false, provenance: 'override', sourcePath: null, sourceOwner: { kind: 'listing', label: 'Listing settings', path: 'x' } } }],
    ['a value-map conversion (the channel’s words for the same fact)', { mapped: { ...plain, appliedTransforms: ['valueMap'] } }],
    ['a translation the content resolver marks inherited', { tier: 'source', provenance: { member: 'inherited', from: 'German · shared' } }],
  ])('draws no mark for %s', (_, cell) => {
    const html = render(definition, cellOf(cell))
    expect(html).toContain('Visible title')
    expect(html).not.toContain('nds-cell-prov')
    expect(html).not.toContain('nds-source-indicator')
  })

  /* 2026-10-04 (fix C) — ONE sentence per mark, and `from` means what the value follows / came from on every scope:
     "label — from" said "Pinned — Main listing" here (where the pin lives) and "Inherited — GALE-JACKET" on Shared (what
     it follows). */
  it.each([
    ['a listing override', { source: 'channelExplicit', layer: 'aliasVariant', pinned: true, inherited: false }, 'pinned',
      'Pinned on this row — it no longer follows the Shared product'],
    ['a value inherited from the alias band', { source: 'aliasExplicit', layer: 'alias', inherited: true }, 'inherited',
      'Inherited from the Main listing, which itself overrides the Shared product — resetting returns it to the Main listing, not to the Shared product'],
    ['a linked field', { layer: 'linked', linkGroupId: 'shared-title' }, 'inherited', 'Inherited from a linked field — edit to give this row its own value'],
    ['a mapping expression', { mapped: { ...plain, usesExpression: true } }, 'mapped', 'Derived by a mapping rule from the Shared product'],
    ['a rule that appended text', { mapped: { ...plain, appliedTransforms: ['append'] } }, 'mapped', 'Derived by a mapping rule from the Shared product'],
    ['a Shopify edit Shopify does not have yet', { source: 'channelExplicit', layer: 'channel', pinned: true, inherited: false, nexusDraft: true, unsentDraft: true },
      'pending', 'Saved in Nexus — not sent to Shopify yet. Use Review and synchronize… to send it'],
    ['an AI translation not reviewed', { translation: { source: 'ai', reviewedAt: null, outdated: false } }, 'ai',
      'Translated by machine and not reviewed yet'],
    ['an out-of-date translation', { translation: { source: 'manual', reviewedAt: null, outdated: true } }, 'outdated',
      'Out of date — the source changed after this translation was written'],
    ['a language fallback (German asked, Italian shown)', { tier: 'source', language: 'it', requested: 'de', provenance: { member: 'inherited', from: 'Italian · source' } },
      'inherited', 'Inherited from the Italian text — edit to give this row its own value'],
  ])('marks %s, in the one sentence both scopes read', (_, cell, mark, sentence) => {
    const html = render(definition, cellOf(cell))
    expect(markOf(html)).toBe(mark)
    expect(titleOf(html)).toBe(sentence)
  })

  it('says an old listing text is the listing’s own value — never "Inherited" (report 2 I-3)', () => {
    const html = render(definition, cellOf({ value: 'Old eBay title', source: 'channelSnapshot', layer: 'channel', pinned: false, follows: true, inherited: false,
      tier: 'pin', provenance: { member: 'inherited', from: 'Italian · eBay · IT · following snapshot' }, mapped: { ...plain, derived: false } }), 'Old eBay title')
    expect(html).toContain('nds-cell-prov-listing')
    expect(html).not.toContain('nds-cell-prov-inherited')
    expect(titleOf(html)).toContain('This listing still holds its own text')
    expect(html).not.toContain('following snapshot')
  })

  it('turns a blocking mapping error into the attention mark with the mapping note (the red "!" pill is gone)', () => {
    const html = render(definition, cellOf({ value: 'Invalid title', mapped: { ...plain, errors: ['Title is not compliant'], mappingErrors: ['Title is not compliant'] } }), 'Invalid title')
    expect(markOf(html)).toBe('attention')
    expect(titleOf(html)).toBe('Mapping error: Title is not compliant')
    expect(html).not.toContain('nds-cascade-maperr')
  })

  it('adds no mark to an empty required cell that already says "required"', () => {
    const required = setup([{ ...base, kind: 'text', requiredBy: [`${channel} · DE`] }], undefined, scope)[0]
    const html = render(required, cellOf({ value: null, mapped: { ...plain, provenance: 'missing', errors: ["Field 'Title' is required."] } }), null)
    expect(html).toContain('⚠ required')
    expect(html).not.toContain('nds-cell-prov')
  })

  /* 2026-10-04 (fix C) — measured on GALE-JACKET: 341 of Amazon IT's 366 `attention` marks and Etsy's 105 sat on EMPTY
     cells whose only error said the category requires a value. Shapes as `resolve-batch.service.ts` builds them: no rule
     and nothing stored → `unmapped`; the category schema check (`schema-requirements.ts`) adds its sentence. */
  const emptyRequired = (errors: string[], over: Record<string, unknown> = {}) => cellOf({ value: null, source: null, layer: 'default', inherited: false,
    inheritedFrom: null, follows: null, mapped: { value: null, derived: false, status: 'unmapped', provenance: null, sourcePath: null, fallbackPath: null,
      usesExpression: false, legacySource: 'missing', appliedTransforms: [], warnings: [], errors, mappingErrors: [], autoCorrected: null,
      requiredByRule: false, overLimit: null, ...over } })
  it('draws Amazon’s conditional requirement on an empty cell as "⚠ required", with no mark (the column alone does not require it)', () => {
    // `required: true` on the issue → the resolver's `required` → `requiredByRule` on the wire.
    const html = render(definition, emptyRequired(["Required by the category's condition for this product: External Product ID."], { requiredByRule: true }), null)
    expect(html).toContain('⚠ required')
    expect(html).not.toContain('nds-cell-prov')
  })
  it('draws Etsy’s schema requirement on an empty cell as "⚠ required", with no mark — although it arrives with requiredByRule false', () => {
    // Etsy fields are `requiredInParent: false`, so the schema check words it as an envelope ("the … attribute") and leaves
    // `required` false: only the sentence says it.
    const html = render(definition, emptyRequired(['Required by the category schema: the taxonomy_id attribute.'],
      { sourceOwner: { kind: 'listing', label: 'Etsy category selection', path: 'listing.platformAttributes.taxonomy_id' } }), null)
    expect(html).toContain('⚠ required')
    expect(html).not.toContain('nds-cell-prov')
  })
  it('keeps the attention mark on an empty cell when another error stands beside the required one', () => {
    for (const other of ['The category requires an allowed alternative; this option needs: External Product ID.',
      'Category requirement validation is unavailable: The category validation schema is unavailable.',
      'Translation into de is pending.']) {
      const html = render(definition, emptyRequired(["Required by the category's condition for this product: External Product ID.", other], { requiredByRule: true }), null)
      expect(html).toContain('⚠ required')
      expect(markOf(html)).toBe('attention')
      // The mark names the cause it is drawn for; the cell already says "required" (Cell details keeps every sentence).
      expect(titleOf(html)).toBe(`Field validation: ${other}`)
    }
  })
  it('keeps the attention mark on a FILLED cell whose error says "required" (the value is there; something else is wrong)', () => {
    const html = render(definition, cellOf({ value: 'X', mapped: { ...plain, errors: ["Required by the category's condition for this product: External Product ID."], requiredByRule: true } }), 'X')
    expect(html).not.toContain('⚠ required')
    expect(markOf(html)).toBe('attention')
  })
  it('an empty cell whose only error is not a requirement draws "—" and the attention mark', () => {
    const html = render(definition, emptyRequired(['The category requires an allowed alternative; this option needs: External Product ID.']), null)
    expect(html).not.toContain('⚠ required')
    expect(markOf(html)).toBe('attention')
  })

  it('keeps a formula refusal in the server’s words as the whole hover text', () => {
    const [refusing] = setup([{ ...base, kind: 'text' }], undefined, { ...scope, refusedReasonFor: () => 'Missing formula input' })
    const html = render(refusing, cellOf({ value: null }), null)
    expect(markOf(html)).toBe('refused')
    expect(titleOf(html)).toBe('Missing formula input')
  })

  it('marks an Amazon offer change waiting for Publish with the clock and its saved and live values', () => {
    const html = render(definition, cellOf({ value: 44.9, source: 'channelExplicit', layer: 'channel', pinned: true, inherited: false,
      pendingPublish: { value: 44.9, live: 49.9, savedAt: '2026-10-02T12:03:00.000Z', savedBy: 'sheet@test', note: 'Saved — pins at 44.90 when you publish', sent: true } }), 44.9)
    expect(markOf(html)).toBe('pending')
    expect(titleOf(html)).toContain('Saved — pins at 44.90 when you publish. Saved value: 44.90. Live until you publish: 49.90')
  })

  it('marks an eBay item specific on a variation row as one value for the listing, naming its SKU', () => {
    const html = render(definition, cellOf({ mapped: { ...plain, listingLevel: { productId: 'gale-family', sku: 'GALE-FAMILY', variation: true } } }))
    expect(markOf(html)).toBe('listing-level')
    expect(titleOf(html)).toContain('GALE-FAMILY')
    // The row's own SKU names nothing: the sentence then says only what the mark means.
    const own = render(definition, cellOf({ mapped: { ...plain, listingLevel: { productId: 'gale', sku: 'GALE-JACKET', variation: true } } }))
    expect(titleOf(own)).toBe('One value for the whole listing — setting or clearing it here sets it for every variation')
  })
})

it('reveals a Shopify cell’s action on hover or focus of the cell (`nds-reveal-row` on the cell)', () => {
  const column = { ...base, kind: 'text', shopifyField: { id: 'vendor', type: 'single_line_text_field', owner: 'PRODUCT' } }
  const [definition] = setup([column], undefined, { shopifySchema: {} } as never)
  expect(String(definition.cellClass)).toContain('nds-reveal-row')
  expect(String(definition.cellClass)).toContain('nds-ag-cell')
  const [other] = setup([{ ...base, kind: 'text' }])
  expect(String(other.cellClass)).not.toContain('nds-reveal-row')
})

it('tints a cell from the SAME verdict the mark draws', () => {
  const [definition] = setup([{ ...base, kind: 'text' }])
  const rules = definition.cellClassRules as Record<string, (p: unknown) => boolean>
  const params = (cell: Record<string, unknown>) => ({ data: { rowId: 'r', values: { title: { value: 'v', layer: 'master', ...cell } } }, colDef: { colId: 'title' } })
  // A plain mapped path: no tint (the DS classifier would have painted it "mapped").
  expect(rules['nds-cell-is-mapped'](params({ mapped: plain }))).toBe(false)
  // A variant's own Shared value: no pinned tint.
  expect(rules['nds-cell-is-pinned'](params({ layer: 'variant', pinned: true, inherited: false }))).toBe(false)
  // A listing override: pinned tint.
  expect(rules['nds-cell-is-pinned'](params({ layer: 'channel', pinned: true, inherited: false }))).toBe(true)
  // A channel-only field's stored value: no pinned tint (nothing in the Shared product to follow).
  expect(rules['nds-cell-is-pinned'](params({ layer: 'channel', pinned: true, inherited: false,
    mapped: { ...plain, derived: false, provenance: 'override', sourcePath: null, sourceOwner: { kind: 'listing', label: 'Listing settings', path: 'x' } } }))).toBe(false)
})

it('classifies a cell once per render pass, however many class keys ask (and again when what it reads changes)', () => {
  let refusal: string | null = null
  const [definition] = setup([{ ...base, kind: 'text' }], undefined, { refusedReasonFor: () => refusal } as Partial<BuildChannelColumnsOptions>)
  const byName = definition.cellClassRules as Record<string, (p: unknown) => boolean>
  const rules = Object.values(byName)
  // Count the classifications by a field the verdict reads a fixed number of times per classification.
  let reads = 0
  const counted = (cell: Record<string, unknown>) => new Proxy(cell, { get: (target, key) => { if (key === 'pendingPublish') reads++; return Reflect.get(target, key) } })
  const once = (() => { reads = 0; channelCellProvenance(counted({ value: 'v', layer: 'channel', pinned: true, inherited: false }) as never); return reads })()
  expect(once).toBeGreaterThan(0)
  const cell = counted({ value: 'v', layer: 'channel', pinned: true, inherited: false })
  const row = { rowId: 'r', values: { title: cell } }
  reads = 0
  for (const rule of rules) rule({ data: row, colDef: { colId: 'title' } })
  expect(rules.length).toBeGreaterThan(10)
  expect(reads).toBe(once)
  // A formula refusal that arrives later is a new question: the cell is classified again, and the tint follows.
  refusal = 'Missing formula input'
  expect(byName['nds-cell-is-formula-refused']({ data: row, colDef: { colId: 'title' } })).toBe(true)
  // A save replaces the row's values: classified again.
  reads = 0
  row.values = { title: cell }
  byName['nds-cell-is-pinned']({ data: row, colDef: { colId: 'title' } })
  expect(reads).toBe(once)
})

/**
 * 2026-10-04 (channel cell marks, review D) — the Variation theme cell on a channel scope wears the SHEET's verdict; when
 * that verdict names a cause (a mapping error), its words are the sheet's sentence — the one Cell details and every other
 * cell's mark say — not the theme's source sentence.
 */
describe('the Variation theme cell: the icon and its words agree', () => {
  const theme = { ...base, key: 'variationTheme', label: 'Variation theme', kind: 'variationTheme', shape: 'axes', storage: 'categoryAttributes' }
  const render = (over: Record<string, unknown>) => {
    const [definition] = setup([theme])
    const data = { id: 'gale', rowId: 'primary:gale', sku: 'GALE-JACKET', rowKind: 'parent', isParent: true, aliasId: null, aliasPosition: 0, productType: null,
      values: { variationTheme: { value: GALE_AMAZON_DE_DERIVED, source: 'master', inheritedFrom: null, inherited: true, layer: 'master', pinned: false, follows: true,
        editable: true, linkGroupId: null, writeField: 'variationTheme', writeTarget: 'channelListing', writeVerb: 'channel', affectsAllChannels: false, writable: true,
        mapped: null, ...over } } }
    const html = renderToStaticMarkup(createElement(definition.cellRenderer as never, { ...definition.cellRendererParams, data, value: GALE_AMAZON_DE_DERIVED, node: {} }))
    return { html, title: /class="nds-cell-prov[^"]*"[^>]*title="([^"]*)"/.exec(html)?.[1]?.replace(/&quot;/g, '"').replace(/&#x27;/g, "'") ?? null }
  }
  it('a mapping error reads its own sentence', () => {
    const out = render({ mapped: { value: null, derived: false, status: 'mapped', provenance: 'catalogRule', sourcePath: 'variationTheme', appliedTransforms: [],
      warnings: [], errors: ['Theme COLOR/SIZE is not allowed for this category.'], mappingErrors: ['Theme COLOR/SIZE is not allowed for this category.'],
      autoCorrected: null, requiredByRule: false, overLimit: null } })
    expect(out.html).toContain('nds-cell-prov-attention')
    expect(out.title).toBe('Mapping error: Theme COLOR/SIZE is not allowed for this category.')
  })
  it('a theme that follows the Shared product wears no mark', () => {
    expect(render({}).html).not.toContain('nds-cell-prov')
  })
})
