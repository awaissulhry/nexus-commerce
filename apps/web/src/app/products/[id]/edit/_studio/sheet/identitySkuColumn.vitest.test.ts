/**
 * S11 — the first column as a grid column (`identitySkuColumn.tsx`), the half both adapters spread into their tree column:
 * the value it shows and takes, which rows can be edited, the editor it opens (the DS value editor with the SKU cap and the
 * warning line), the keys (Enter opens the record on Shared, edits on a channel; Delete never clears a SKU), the tint and
 * the save marks, and the SKU node the band draws (the "differs from Shared" mark and its sentence).
 */
import { isValidElement, type ReactElement } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { CellSaveTracker, FormulaCellEditor, MarkedValue, SkuTag } from '@/design-system/grid'
import { identitySkuColumnDef, identitySkuNode, suppressIdentitySkuKeys } from './identitySkuColumn'
import { IDENTITY_SKU_COLUMN, type IdentitySkuFacts, type IdentitySkuRow, type IdentitySkuScope } from './identitySkuEdit'

const SHARED: IdentitySkuScope = { kind: 'shared' }
const AMAZON_DE: IdentitySkuScope = { kind: 'channel', channel: 'AMAZON', marketplace: 'DE' }
type Row = IdentitySkuRow & { id: string }
const facts = (over: Partial<IdentitySkuFacts> = {}): IdentitySkuFacts =>
  ({ wanted: 'GALE-M', source: 'product', live: null, liveConfirmed: false, differs: false, editable: true, reason: null, ...over })
const row = (over: Partial<Row> = {}): Row => ({ id: 'p1', sku: 'GALE-M', aliasId: null, skuFacts: facts(), ...over })
const column = (scope: IdentitySkuScope, tracker = new CellSaveTracker(), onSet = vi.fn()) =>
  ({ def: identitySkuColumnDef<Row>({ scope: () => scope, tracker, rowIdOf: r => r.id, onSet }), tracker, onSet })
const key = (k: string, editing = false, mods: Partial<KeyboardEvent> = {}) =>
  ({ event: { key: k, type: 'keydown', target: null, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...mods } as unknown as KeyboardEvent, editing })

describe('the value', () => {
  it('shows the product SKU on Shared and the listing\'s SKU on a channel', () => {
    expect(column(SHARED).def.valueGetter({ data: row({ skuFacts: facts({ wanted: 'X' }) }) })).toBe('GALE-M')
    expect(column(AMAZON_DE).def.valueGetter({ data: row({ skuFacts: facts({ wanted: 'GALE-M-DE', differs: true, source: 'channel' }) }) })).toBe('GALE-M-DE')
  })

  it('editable as the rule says: every Shared row; a channel row the server allows', () => {
    expect(column(SHARED).def.editable({ data: row() })).toBe(true)
    expect(column(AMAZON_DE).def.editable({ data: row({ skuFacts: facts({ editable: false, reason: 'No listing.' }) }) })).toBe(false)
    expect(column(AMAZON_DE).def.editable({ data: undefined })).toBe(false)
  })

  it('the setter shows a valid SKU on the row at once and says what it meant; a refused one is never applied', () => {
    const { def, onSet } = column(SHARED)
    const r = row()
    expect(def.valueSetter({ data: r, newValue: ' GALE-M2 ' } as never)).toBe(true)
    expect(r.sku).toBe('GALE-M2')
    expect(onSet).toHaveBeenLastCalledWith(r, { kind: 'rename', sku: 'GALE-M2' }, { sku: 'GALE-M', skuFacts: facts() })
    expect(def.valueSetter({ data: r, newValue: 'BAD SKU' } as never)).toBe(false)
    expect(r.sku).toBe('GALE-M2')
    expect(onSet).toHaveBeenLastCalledWith(r, { kind: 'refused', reason: 'Use only letters, numbers, dots (.), hyphens (-) and underscores (_). No spaces.' }, expect.anything())
    onSet.mockClear()
    expect(def.valueSetter({ data: r, newValue: 'GALE-M2' } as never)).toBe(false)
    expect(onSet).not.toHaveBeenCalled()
  })

  it('a channel setter changes the listing\'s SKU, never the product SKU', () => {
    const { def } = column(AMAZON_DE)
    const r = row()
    expect(def.valueSetter({ data: r, newValue: 'GALE-M-DE' } as never)).toBe(true)
    expect(r).toMatchObject({ sku: 'GALE-M', skuFacts: { wanted: 'GALE-M-DE', differs: true } })
  })
})

describe('the editor', () => {
  it('the DS value editor, formulas off, with the 100-character counter and the warning line', () => {
    const shared = column(SHARED).def.cellEditorSelector({ data: row() })
    expect(shared).toMatchObject({ component: FormulaCellEditor, popup: true, popupPosition: 'under',
      params: { formulas: false, commitKind: 'text', cellContext: { maxLength: 100, notice: { tone: 'info',
        text: 'Changes the SKU on every channel and market that follows it. Listings a channel still holds keep their current SKU.' } } } })
    expect(column(AMAZON_DE).def.cellEditorSelector({ data: row() }).params.cellContext.notice).toEqual({ tone: 'warning',
      text: 'This SKU is for Amazon · DE only. Other channels and markets keep GALE-M. To change it everywhere, edit it in the Shared view.' })
  })

  it('keys: Enter opens the record on Shared and edits on a channel; Delete and Backspace never clear a SKU; F2 and typing edit', () => {
    vi.stubGlobal('Element', class {})
    try {
      expect(suppressIdentitySkuKeys(key('Enter') as never, true)).toBe(true)
      expect(suppressIdentitySkuKeys(key('Enter') as never, false)).toBe(false)
      expect(suppressIdentitySkuKeys(key('Enter', false, { shiftKey: true }) as never, true)).toBe(false)
      expect(suppressIdentitySkuKeys(key('Delete') as never, false)).toBe(true)
      expect(suppressIdentitySkuKeys(key('Backspace') as never, true)).toBe(true)
      expect(suppressIdentitySkuKeys(key('F2') as never, true)).toBe(false)
      // While editing, Backspace is the editor's own text key, never kept from it.
      expect(suppressIdentitySkuKeys(key('Backspace', true) as never, true)).toBe(false)
      // The column wires the scope's rule.
      expect(column(SHARED).def.suppressKeyboardEvent(key('Enter') as never)).toBe(true)
      expect(column(AMAZON_DE).def.suppressKeyboardEvent(key('Enter') as never)).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('F3 — trying again after a refused save: the editor leads with the refusal, in full, then what the change reaches', () => {
    const { def, tracker } = column(AMAZON_DE)
    const refusal = 'Nexus cannot move a family\'s main listing on Amazon to a new SKU yet (GALE → GALE-IT): its variations hang under GALE. Delete the family here, then list it again.'
    tracker.set('p1', IDENTITY_SKU_COLUMN, 'refused', refusal)
    expect(def.cellEditorSelector({ data: row() }).params.cellContext.notice).toEqual({ tone: 'warning',
      text: `Not saved: ${refusal} This SKU is for Amazon · DE only. Other channels and markets keep GALE-M. To change it everywhere, edit it in the Shared view.` })
    // A save that is only on its way says nothing of a refusal.
    tracker.set('p1', IDENTITY_SKU_COLUMN, 'saving')
    expect(def.cellEditorSelector({ data: row() }).params.cellContext.notice?.text).not.toContain('Not saved')
  })

  it('F8 / F9 — an empty row: the editor says what typing creates; after a refused create, the refusal leads', () => {
    const CHANNEL: IdentitySkuScope = { kind: 'channel', channel: 'EBAY', marketplace: 'IT' }
    const empty = (kind: string, over: Record<string, unknown> = {}) => row({ id: 'new-row:1', sku: '', skuFacts: null, unsaved: true, unsavedReason: null, newRow: { kind, state: 'empty', reason: null, ...over } })
    expect(column(SHARED).def.cellEditorSelector({ data: empty('variation') }).params.cellContext.notice)
      .toEqual({ tone: 'info', text: 'Creates a new variation of this family: a draft, in Nexus only.' })
    expect(column(CHANNEL).def.cellEditorSelector({ data: empty('variation') }).params.cellContext.notice?.text).toBe('Creates a new variation of this family: a draft, in Nexus only.')
    expect(column(CHANNEL).def.cellEditorSelector({ data: empty('alias') }).params.cellContext.notice)
      .toEqual({ tone: 'info', text: 'Creates another listing of this product on eBay · IT with this SKU.' })
    expect(column(SHARED).def.cellEditorSelector({ data: empty('variation', { state: 'refused', reason: 'DEMO-JACKET-M is already in this family.' }) }).params.cellContext.notice)
      .toEqual({ tone: 'warning', text: 'Not saved: DEMO-JACKET-M is already in this family. Creates a new variation of this family: a draft, in Nexus only.' })
  })

  it('no fill handle: one SKU names one product', () => {
    expect(column(SHARED).def.suppressFillHandle).toBe(true)
  })
})

describe('the tint, the marks and the hover', () => {
  const classes = (def: ReturnType<typeof column>['def'], data: Row) => Object.entries(def.cellClassRules)
    .filter(([, rule]) => (rule as (p: unknown) => boolean)({ data, colDef: { colId: IDENTITY_SKU_COLUMN } })).map(([name]) => name)

  it('the "differs from Shared" tint on a channel SKU of its own, attention on no single SKU, none on Shared', () => {
    const differs = row({ skuFacts: facts({ wanted: 'GALE-M-DE', differs: true, source: 'channel' }) })
    expect(classes(column(AMAZON_DE).def, differs)).toEqual(['nds-cell-is-pinned'])
    expect(classes(column(AMAZON_DE).def, row({ skuFacts: facts({ wanted: null, source: null, differs: true }) }))).toEqual(['nds-cell-is-attention'])
    expect(classes(column(SHARED).def, differs)).toEqual([])
  })

  it('the save marks ride on the same cell id the writer uses', () => {
    const { def, tracker } = column(SHARED)
    tracker.set('p1', IDENTITY_SKU_COLUMN, 'refused', 'SKU "GALE-M2" is already used by another product')
    expect(classes(def, row())).toEqual(['nds-cell-is-refused'])
    expect(def.tooltipValueGetter({ data: row() })).toContain('SKU "GALE-M2" is already used by another product')
  })

  it('the hover says why a row cannot be edited', () => {
    expect(column(AMAZON_DE).def.tooltipValueGetter({ data: row({ skuFacts: facts({ editable: false, reason: 'This row is the extra listing “Bundle” itself.' }) }) }))
      .toContain('This row is the extra listing “Bundle” itself.')
    expect(column(AMAZON_DE).def.tooltipValueGetter({ data: row() })).toBe('')
  })

  it('the band\'s SKU: plain text when there is nothing to mark; the pinned mark with the Owner\'s sentence when it differs', () => {
    expect(identitySkuNode(SHARED, row(), undefined)).toBe('GALE-M')
    const plain = identitySkuNode(AMAZON_DE, row(), undefined) as ReactElement<{ children: string }>
    expect(plain.type).toBe(SkuTag)
    const marked = identitySkuNode(AMAZON_DE, row({ skuFacts: facts({ wanted: 'GALE-M-DE', differs: true, source: 'channel' }) }), undefined) as ReactElement<{ provenance: string; tooltip: string }>
    expect(isValidElement(marked) && marked.type).toBe(MarkedValue)
    expect(marked.props).toMatchObject({ provenance: 'pinned',
      tooltip: 'This SKU is for Amazon · DE only. Other channels and markets keep GALE-M. To change it everywhere, edit it in the Shared view.' })
    // A save under way draws the save marks even with no provenance mark.
    const saving = identitySkuNode(SHARED, row(), { state: 'saving', at: 0 }) as ReactElement<{ provenance: string }>
    expect(saving.type).toBe(MarkedValue)
    expect(saving.props.provenance).toBe('own')
  })
})

/* S11 follow-up — the hosts are hooks (no node render): their wiring is read from the source, as `slotListColumns` does. */
describe('the Status / Action labels name the listing\'s own SKU in a channel scope only (source read)', () => {
  const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
  it('a channel scope stages and announces each listing by `listingSkuLabel` (the SKU it holds, else the SKU Publish sends)', () => {
    // The channel sheet names each place by `listingSkuLabel`; the shared editing (also the Matrix's, 2026-10-07) stages and
    // announces each cell by the name its page gave it.
    const channel = read('./channel/useChannelSheetAdapter.tsx')
    expect(channel).toContain('rowId: row.rowId, colId: sheetPublishColumnOf(column), column, cell: publishCellOf(row), sku: listingSkuLabel(row),')
    expect(channel).toMatch(/label: \(listingId\) => \{[^\n]*listingSkuLabel\(row\)/)
    const editing = read('./usePublishCellEditing.ts')
    expect(editing).toContain('fence.stage({ column: place.column, listingId: place.cell?.listingId ?? null, sku: place.sku, input })')
    expect(editing).toContain('operationToast(outcomes, refused, at.label)')
  })
  it('the Shared scope keeps naming listings by the product SKU and its market', () => {
    const shared = read('./master/useMasterSheetAdapter.tsx')
    expect(shared).not.toContain('listingSkuLabel')
    expect(shared).toContain('sku: listingLabel(row.sku, cell)')
  })
})
