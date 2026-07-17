/** FFP.1 — draft layer unit tests (pure merge + key building). */

import { describe, it, expect, beforeEach } from 'vitest'
import { draftKey, mergeDraftRows, writeDraft, readDraft, removeRowsFromDraft } from './draftStore'
import type { BaseRow } from '@/components/flat-file/FlatFileGrid.types'

const server = (o: Partial<BaseRow> & { _rowId: string }): BaseRow => ({
  _dirty: false,
  ...o,
}) as BaseRow

describe('draftKey', () => {
  it('is market-scoped', () => {
    expect(draftKey('IT')).toBe('ff-ebay-draft-IT')
    expect(draftKey('DE')).toBe('ff-ebay-draft-DE')
  })
  it('is family-scoped when familyId present', () => {
    expect(draftKey('IT', 'fam1')).toBe('ff-ebay-draft-IT-family-fam1')
    expect(draftKey('IT', null)).toBe('ff-ebay-draft-IT')
  })
})

describe('mergeDraftRows', () => {
  it('no drafts → server rows unchanged', () => {
    const rows = [server({ _rowId: 'a', sku: 'S1' })]
    const { rows: out, restored } = mergeDraftRows(rows, [])
    expect(out).toBe(rows)
    expect(restored).toBe(0)
  })

  it('draft content wins over server content (matched by sku)', () => {
    const rows = [server({ _rowId: 'a', sku: 'S1', title: 'server title', aspect_Colore: 'Nero' })]
    const draft = [server({ _rowId: 'a-old', sku: 'S1', title: 'MY EDIT', aspect_Colore: 'Rosso', _dirty: true })]
    const { rows: out, restored } = mergeDraftRows(rows, draft)
    expect(restored).toBe(1)
    expect(out[0].title).toBe('MY EDIT')
    expect(out[0].aspect_Colore).toBe('Rosso')
    expect(out[0]._dirty).toBe(true)
  })

  it('system fields always come from the server row', () => {
    const rows = [server({
      _rowId: 'a', sku: 'S1',
      ebay_item_id: 'LIVE-1', listing_status: 'ACTIVE', it_item_id: 'IT-1',
      _productId: 'prod-1', _isParent: false, platformProductId: 'parent-1',
    })]
    const draft = [server({
      _rowId: 'a', sku: 'S1', title: 'edit',
      ebay_item_id: 'STALE', listing_status: 'DRAFT', it_item_id: 'STALE-IT',
      _productId: 'stale', _isParent: true, platformProductId: 'stale-parent',
      _dirty: true,
    })]
    const { rows: out } = mergeDraftRows(rows, draft)
    expect(out[0].ebay_item_id).toBe('LIVE-1')
    expect(out[0].listing_status).toBe('ACTIVE')
    expect(out[0].it_item_id).toBe('IT-1')
    expect(out[0]._productId).toBe('prod-1')
    expect(out[0]._isParent).toBe(false)
    expect(out[0].platformProductId).toBe('parent-1')
  })

  it('typed price/qty stay from the draft (user intent)', () => {
    const rows = [server({ _rowId: 'a', sku: 'S1', it_price: 50, it_qty: 10 })]
    const draft = [server({ _rowId: 'a', sku: 'S1', it_price: 44.9, it_qty: 3, _dirty: true })]
    const { rows: out } = mergeDraftRows(rows, draft)
    expect(out[0].it_price).toBe(44.9)
    expect(out[0].it_qty).toBe(3)
  })

  it('keeps the SERVER _rowId for grid identity', () => {
    const rows = [server({ _rowId: 'server-id', sku: 'S1' })]
    const draft = [server({ _rowId: 'draft-id', sku: 'S1', _dirty: true })]
    const { rows: out } = mergeDraftRows(rows, draft)
    expect(out[0]._rowId).toBe('server-id')
    expect(out).toHaveLength(1)
  })

  it('unmatched draft rows (new, never persisted) are appended', () => {
    const rows = [server({ _rowId: 'a', sku: 'S1' })]
    const draft = [server({ _rowId: 'new-1', sku: 'NEW-SKU', title: 'brand new', _isNew: true, _dirty: true })]
    const { rows: out, restored } = mergeDraftRows(rows, draft)
    expect(out).toHaveLength(2)
    expect(out[1].sku).toBe('NEW-SKU')
    expect(out[1]._dirty).toBe(true)
    expect(restored).toBe(1)
  })

  it('blank-SKU draft rows match by _rowId, not by empty sku', () => {
    const rows = [
      server({ _rowId: 'a', sku: 'S1' }),
      server({ _rowId: 'blank-1', sku: '' }),
    ]
    const draft = [server({ _rowId: 'blank-1', sku: '', title: 'typed on blank row', _dirty: true })]
    const { rows: out } = mergeDraftRows(rows, draft)
    expect(out).toHaveLength(2)
    expect(out[1].title).toBe('typed on blank row')
    expect(out[0].title).toBeUndefined()
  })
})

describe('round-trip integrity — _shared rows are draft-protected', () => {
  const store: Record<string, string> = {}
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k]
    // minimal localStorage stub
    globalThis.localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v },
      removeItem: (k: string) => { delete store[k] },
    } as never
  })

  it('dirty _shared rows persist to the draft; plain _readonly rows still excluded', () => {
    writeDraft('k', [
      { _rowId: 'a', sku: 'SHARED-1', _dirty: true, _shared: true, _readonly: true, it_price: 106 },
      { _rowId: 'b', sku: 'RO-1', _dirty: true, _readonly: true, title: 'x' },
      { _rowId: 'c', sku: 'CLEAN', title: 'y' },
    ] as never)
    const draft = readDraft('k')
    expect(draft?.rows.map((r) => r.sku)).toEqual(['SHARED-1'])
  })
})

describe('removeRowsFromDraft — deletion purges draft twins', () => {
  beforeEach(() => {
    const store: Record<string, string> = {}
    globalThis.localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v },
      removeItem: (k: string) => { delete store[k] },
    } as never
  })

  it('removes by sku and rowId; empty draft is deleted entirely', () => {
    writeDraft('k', [
      { _rowId: 'a', sku: 'KEEP', _dirty: true, title: 'x' },
      { _rowId: 'b', sku: 'BY-SKU', _dirty: true, title: 'y' },
      { _rowId: 'c', sku: 'BY-ROWID', _dirty: true, title: 'z' },
    ] as never)
    const n = removeRowsFromDraft('k', { skus: ['BY-SKU'], rowIds: ['c'] })
    expect(n).toBe(2)
    expect(readDraft('k')?.rows.map((r) => r.sku)).toEqual(['KEEP'])
    expect(removeRowsFromDraft('k', { skus: ['KEEP'] })).toBe(1)
    expect(readDraft('k')).toBeNull()
  })

  it('no matches → draft untouched, returns 0', () => {
    writeDraft('k', [{ _rowId: 'a', sku: 'X', _dirty: true, title: 't' }] as never)
    expect(removeRowsFromDraft('k', { skus: ['NOPE'] })).toBe(0)
    expect(readDraft('k')?.rows).toHaveLength(1)
  })
})
