import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CellSaveTracker } from '@/design-system/grid'
import { buildChannelColumns, type BuildChannelColumnsOptions } from './channelColumns'

const base = { key: 'title', label: 'German title', writeField: 'name', group: 'Content', kind: 'longtext',
  storage: 'column', scope: 'global', requiredBy: [], editable: true, width: 380 } as const
function setup(columns: unknown[] = [base], tracker = new CellSaveTracker()) {
  const opts = { data: { scope: { channel: 'AMAZON', marketplace: 'DE', label: 'Amazon · DE' } },
    gridColumns: columns, formulaWiring: { exprFor: () => null, errorFor: () => null },
    openCellDetails: () => {}, productLevelOnly: false, refusedReasonFor: () => null,
    tracker, activeCellsRef: { current: null }, viewCtx: { locale: 'de', variationAxes: [], flaggedKeys: [] },
    mediaEditor: { open: () => {}, actions: {} }, shopifyEditor: { open: () => {} }, auth: { has: () => true },
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

it.each(['saving', 'waiting', 'unknown', 'refused', 'saved'] as const)('renders the actual channel cell save state %s without changing its source', state => {
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

it.each([
  ['inherited', 'German · shared', true, 'rule'],
  ['pinned', 'Dutch · Amazon · BE · pin', false, 'rule'],
  ['inherited', 'Dutch · Amazon · BE · following snapshot', true, 'rule'],
  ['outdated', 'Italian · source', true, 'rule'],
  ['aiStale', 'French · shared', true, 'ai'],
])('paints the restored channel renderer for %s: the per-cell source indicator with its details action, no bare glyph (Owner revert 2026-09-13)', (member, from, follows, kind) => {
  const [definition] = setup([{...base, kind:'text'}])
  const data = { id:'gale', rowId:'primary:gale', sku:'GALE-JACKET', rowKind:'variant', isParent:false,
    values:{title:{value:'Visible title', provenance:{member,from}, follows, mapped:{status:'mapped',derived:false,errors:[],warnings:[]}}} }
  const html = renderToStaticMarkup(createElement(definition.cellRenderer, { ...definition.cellRendererParams, data, value:'Visible title', node:{} }))
  expect(html).toContain('nds-source-indicator')
  expect(html).toContain(`data-value-source="${kind}"`)
  expect(html).toContain('Show cell details: GALE-JACKET, German title')
  expect(html).toContain('Visible title')
  expect(html).not.toContain('nds-cell-prov-')
})
