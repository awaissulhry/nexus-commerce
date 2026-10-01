import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CellSaveTracker } from '@/design-system/grid'
import { buildChannelColumns, type BuildChannelColumnsOptions } from './channelColumns'

const base = { key: 'title', label: 'German title', writeField: 'name', group: 'Content', kind: 'longtext',
  storage: 'column', scope: 'global', requiredBy: [], editable: true, width: 380 } as const
function setup(columns: unknown[] = [base], tracker = new CellSaveTracker(), overrides: Partial<BuildChannelColumnsOptions> = {}) {
  const opts = { data: { scope: { channel: 'AMAZON', marketplace: 'DE', label: 'Amazon · DE' } },
    gridColumns: columns, formulaWiring: { exprFor: () => null, errorFor: () => null },
    openCellDetails: () => {}, productLevelOnly: false, refusedReasonFor: () => null,
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

it.each(['saving', 'waiting', 'unknown', 'refused', 'saved'] as const)('renders the actual channel cell save state %s beside its source', state => {
  const tracker = new CellSaveTracker()
  tracker.set('alias:gale', 'title', state, 'The server has not confirmed this value.')
  const [definition] = setup([{ ...base, kind: 'text' }], tracker)
  const data = { id: 'gale', rowId: 'alias:gale', sku: 'GALE-JACKET', rowKind: 'variant', isParent: false,
    values: { title: { value: 'Visible title', mapped: { status: 'mapped', derived: false, errors: [], warnings: [] } } } }
  const html = renderToStaticMarkup(createElement(definition.cellRenderer, { ...definition.cellRendererParams, data, value: 'Visible title', node: {} }))
  expect(html).toContain('nds-source-indicator')
  expect(html).toContain('The server has not confirmed this value.')
  if (state === 'saving' || state === 'waiting' || state === 'unknown') {
    expect(html).toContain(`data-state="${state}"`)
    expect(html).toContain('role="img"')
  } else expect(html).not.toContain('nds-save-mark')
})

describe.each(['EBAY', 'AMAZON', 'SHOPIFY'])('%s scope indicators', channel => {
  const scope = { data: { scope: { channel, marketplace: 'DE', label: `${channel} · DE` } } } as BuildChannelColumnsOptions
  it.each([
    ['inherited', 'German · shared', true],
    ['pinned', 'Dutch · Amazon · BE · pin', false],
    ['inherited', 'Dutch · Amazon · BE · following snapshot', true],
    ['outdated', 'Italian · source', true],
    ['aiStale', 'French · shared', true],
  ])('names the source of the %s value at rest and on hover (P1: it was hidden here)', (member, from, follows) => {
    const [definition] = setup([{...base, kind:'text'}], undefined, scope)
    const data = { id:'gale', rowId:'primary:gale', sku:'GALE-JACKET', rowKind:'variant', isParent:false,
      values:{title:{value:'Visible title', provenance:{member,from}, follows, mapped:{status:'mapped',derived:false,errors:[],warnings:[]}}} }
    const html = renderToStaticMarkup(createElement(definition.cellRenderer, { ...definition.cellRendererParams, data, value:'Visible title', node:{} }))
    expect(html).toContain('nds-source-indicator')
    // The channel grid turns portal hints off, so the mark's own native title is its hover text.
    expect(html).toMatch(/class="[^"]*nds-source-indicator[^"]*"[^>]*title="[^"]+"|title="[^"]+"[^>]*class="[^"]*nds-source-indicator/)
    expect(html).toContain('Visible title')
    expect(html).not.toContain('nds-cell-prov-')
  })

  it.each([
    [{ layer: 'master' }, 'master', true],
    [{ layer: 'aliasVariant', pinned: true, inherited: false }, 'override', false],
    [{ layer: 'linked', linkGroupId: 'shared-title' }, 'linked', true],
    [{ layer: 'channel', nexusDraft: true }, 'override', false],
  ] as const)('shows the source of %o, quieter only where it follows somewhere else', (cell, kind, quiet) => {
    const [definition] = setup([{ ...base, kind: 'text' }], undefined, scope)
    const data = { rowId: 'primary:gale', sku: 'GALE-JACKET', values: { title: { value: 'Visible title', ...cell } } }
    const html = renderToStaticMarkup(createElement(definition.cellRenderer, { ...definition.cellRendererParams, data, value: 'Visible title', node: {} }))
    expect(html).toContain('Visible title')
    expect(html).toContain(`data-value-source="${kind}"`)
    expect(html.includes('nds-source-indicator--quiet')).toBe(quiet)
    expect(html).toContain('Show cell details: GALE-JACKET, German title')
  })

  it('says an old listing text is the listing’s own value, not "Follows Shared" (report 2 I-3)', () => {
    const [definition] = setup([{ ...base, kind: 'text' }], undefined, scope)
    const data = { rowId: 'primary:gale', sku: 'GALE-JACKET', rowKind: 'variant', values: { title: { value: 'Old eBay title',
      source: 'channelSnapshot', layer: 'channel', pinned: false, follows: true, provenance: { member: 'inherited', from: 'Italian · eBay · IT · following snapshot' },
      mapped: { status: 'mapped', provenance: 'catalogRule', sourcePath: 'title', derived: false, usesExpression: false, errors: [], warnings: [], appliedTransforms: [] } } } }
    const html = renderToStaticMarkup(createElement(definition.cellRenderer, { ...definition.cellRendererParams, data, value: 'Old eBay title', node: {} }))
    expect(html).toContain('title="Listing value. This listing still holds its own text, not the Shared product’s')
    expect(html).not.toContain('Follows Shared')
    expect(html).not.toContain('nds-source-indicator--quiet')
  })

  it.each([
    { needsTranslation: true, effectiveLocale: 'en', requestedLocale: 'de' },
    { translationState: 'fallback', effectiveLocale: 'en', requestedLocale: 'de' },
  ])('keeps language warning indicators and their details action', cell => {
    const [definition] = setup([{ ...base, kind: 'text' }], undefined, scope)
    const data = { rowId: 'primary:gale', sku: 'GALE-JACKET', values: { title: { value: 'Visible title', layer: 'master', ...cell } } }
    const html = renderToStaticMarkup(createElement(definition.cellRenderer, { ...definition.cellRendererParams, data, value: 'Visible title', node: {} }))
    expect(html).toContain('data-value-source="warning"')
    expect(html).toContain('Show cell details: GALE-JACKET, German title')
  })

  it('keeps blocking mapping errors visible', () => {
    const [definition] = setup([{ ...base, kind: 'text' }], undefined, scope)
    const data = { rowId: 'primary:gale', sku: 'GALE-JACKET', values: { title: { value: 'Invalid title',
      mapped: { status: 'mapped', errors: ['Title is not compliant'], warnings: [] } } } }
    const html = renderToStaticMarkup(createElement(definition.cellRenderer, { ...definition.cellRendererParams, data, value: 'Invalid title', node: {} }))
    expect(html).toContain('nds-cascade-maperr')
    expect(html).toContain('aria-label="Mapping error: Title is not compliant"')
  })

  it('keeps formula refusal warnings and their reason', () => {
    const [definition] = setup([{ ...base, kind: 'text' }], undefined, { ...scope, refusedReasonFor: () => 'Missing formula input' })
    const data = { rowId: 'primary:gale', sku: 'GALE-JACKET', values: { title: { value: null } } }
    const html = renderToStaticMarkup(createElement(definition.cellRenderer, { ...definition.cellRendererParams, data, node: {} }))
    expect(html).toContain('data-value-source="warning"')
    expect(html).toContain('Missing formula input')
  })
})

it('preserves source indicators on other channel scopes', () => {
  const [definition] = setup([{ ...base, kind: 'text' }], undefined, { data: { scope: { channel: 'ETSY' } } } as BuildChannelColumnsOptions)
  const data = { rowId: 'primary:gale', sku: 'GALE-JACKET', values: { title: { value: 'Visible title', layer: 'master' } } }
  const html = renderToStaticMarkup(createElement(definition.cellRenderer, { ...definition.cellRendererParams, data, value: 'Visible title', node: {} }))
  expect(html).toContain('data-value-source="master"')
  expect(html).toContain('Show cell details: GALE-JACKET, German title')
})
