import { describe, expect, it } from 'vitest'
import { diffSavedRowsAgainstServer } from './saveVerify.pure'

const saved = (over: Record<string, unknown>) => ({
  _rowId: 'r1', sku: 'SKU-1', parent_sku: 'PARENT', parentage: 'child',
  title: 'My Title', aspect_Colore: 'Nero', ...over,
})
const server = (over: Record<string, unknown>) => ({
  _rowId: 'r1', sku: 'SKU-1', parent_sku: 'PARENT', parentage: 'child',
  title: 'My Title', aspect_Colore: 'Nero', it_item_id: '123', it_status: 'ACTIVE', ...over,
})

describe('diffSavedRowsAgainstServer (FFT.2 Z2)', () => {
  it('clean when every saved field reads back verbatim', () => {
    const r = diffSavedRowsAgainstServer([saved({})], [server({})])
    expect(r.mismatches).toEqual([])
    expect(r.missingRows).toEqual([])
  })

  it('reports a field that reads back differently', () => {
    const r = diffSavedRowsAgainstServer([saved({ title: 'Edited' })], [server({ title: 'Old' })])
    expect(r.mismatches).toEqual([{ sku: 'SKU-1', field: 'title', saved: 'Edited', readBack: 'Old' }])
  })

  it('reports a saved row entirely missing from the read-back', () => {
    const r = diffSavedRowsAgainstServer([saved({ _rowId: 'gone', sku: 'SKU-GONE' })], [server({})])
    expect(r.missingRows).toEqual(['SKU-GONE'])
  })

  it('excludes live/system/tree fields and Action-removed rows', () => {
    const r = diffSavedRowsAgainstServer(
      [
        saved({ it_price: '9.99', it_qty: '5', parent_sku: 'OTHER', variation_theme: 'colore,taglia' }),
        saved({ _rowId: 'r2', sku: 'SKU-2', action: 'end', title: 'whatever' }),
      ],
      [server({ it_price: '11.00', it_qty: '0', variation_theme: 'Colore,Taglia' })],
    )
    expect(r.mismatches).toEqual([])
    expect(r.missingRows).toEqual([])
  })

  it('folds aspect key language + casing (typed English column reads back localized)', () => {
    const r = diffSavedRowsAgainstServer(
      [saved({ aspect_Colore: undefined, aspect_Color: 'Giallo' })],
      [server({ aspect_Colore: 'Giallo' })],
    )
    expect(r.mismatches).toEqual([])
  })

  it('matches by family+sku when the row identity flipped at publish', () => {
    const r = diffSavedRowsAgainstServer(
      [saved({ _rowId: 'planned::PARENT::SKU-1', subtitle: 'sub' })],
      [server({ _rowId: 'shared::999::SKU-1', subtitle: 'sub' })],
    )
    expect(r.mismatches).toEqual([])
    expect(r.missingRows).toEqual([])
  })

  it('tolerates numeric formatting differences (comma vs dot)', () => {
    const r = diffSavedRowsAgainstServer(
      [saved({ package_weight: '2,5' })],
      [server({ package_weight: '2.5' })],
    )
    expect(r.mismatches).toEqual([])
  })
})
