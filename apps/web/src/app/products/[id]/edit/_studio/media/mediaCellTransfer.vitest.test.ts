import { describe, expect, it } from 'vitest'
import { assertMediaSnapshot, mediaClipboardValue, readMediaClipboard, type MediaCellSnapshot } from './mediaCellTransfer'
import { mediaGridTransfer } from './mediaGridTransfer'
import { formulaTransfer } from '@/design-system/grid/editors/formulaTransfer'
import type { ProductMediaWorkspace } from '@nexus/shared/product-media'
import type { MediaCellActions } from './useMediaCellActions'

const value: MediaCellSnapshot = { productId: 'jacket', context: { scope: 'FUTURE_STORE', accountId: 'store-a', aliasKey: '', market: 'IT', locale: 'it' }, items: [{ id: 'video', type: 'VIDEO', alt: 'Vista della giacca' }] }
describe('Typed media cell transfers', () => {
  it('round-trips the exact destination and visible media without treating plain text or arbitrary URLs as galleries', () => {
    expect(readMediaClipboard(mediaClipboardValue(value))).toEqual(value)
    for (const invalid of ['Front view, VIDEO', '=IMAGE("url")', 'https://example.com/file.mp4', 'NEXUS_PRODUCT_MEDIA_V1:{}']) expect(readMediaClipboard(invalid)).toBeNull()
    expect(readMediaClipboard(mediaClipboardValue({ ...value, context: { ...value.context, accountId: undefined } }))).toBeNull()
  })
  it('refuses source or destination snapshots whose visible content changed', () => {
    const actual = { assets: [{ id: 'video', type: 'VIDEO', alt: 'Original', preview: null }], collection: {version:1, items:[{assetId:'video',alt:'Vista della giacca'}]} } as ProductMediaWorkspace
    expect(() => assertMediaSnapshot(value, actual)).not.toThrow()
    expect(() => assertMediaSnapshot(value, {...actual,collection:{version:1,items:[]}})).toThrow(/changed/)
    expect(() => assertMediaSnapshot(value, {...actual,collection:{version:1,items:[{assetId:'video',alt:'Changed'}]}})).toThrow(/changed/)
  })
  const mediaColumn = {getColId:()=> 'productMedia'}, textColumn = {getColId:()=> 'name'}
  const rows = [{id:'first'}, {id:'second'}, {id:'third'}]
  const api = {getAllDisplayedColumns:()=>[mediaColumn,textColumn], getDisplayedRowAtIndex:(index:number)=>({data:rows[index]}), getCellValue:()=> 'Previous value'}
  const actions = {value:(row:{id:string})=>mediaClipboardValue({...value,productId:row.id})} as MediaCellActions
  const base = formulaTransfer<{id:string}>({exprFor:(_row,col)=>col==='name'?'$brand':null})
  const transfer = mediaGridTransfer(base, actions)
  it('fills media vertically in displayed order and blocks incompatible horizontal fills', () => {
    const p = {api,column:mediaColumn,rowNode:{rowIndex:1,data:rows[1]},initialValues:['one'],currentIndex:0,direction:'down',currentCellValue:'existing'}
    expect(readMediaClipboard(transfer.cellSelection.handle.setFillValue(p as never))?.productId).toBe('first')
    expect(transfer.cellSelection.handle.setFillValue({...p,column:textColumn,direction:'right'} as never)).toBe('existing')
    expect(transfer.cellSelection.handle.setFillValue({...p,column:mediaColumn,initialValues:['text'],direction:'left'} as never)).toBe('existing')
  })
  it('preserves normal formula copying and rejects a media token pasted into a text column', () => {
    const p = {api,column:textColumn,node:{data:rows[0]},value:mediaClipboardValue(value),formatValue:()=> 'label'}
    expect(transfer.processCellForClipboard(p as never)).toBe('=$brand')
    expect(transfer.processCellFromClipboard(p as never)).toBe('Previous value')
    expect(transfer.processCellForClipboard({...p,column:mediaColumn} as never)).toBe(p.value)
  })
})
