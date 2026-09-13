import { renderToStaticMarkup } from 'react-dom/server'
import { buildMasterColumns } from './master/columns'
import { AttributeShapeEditor } from './AttributeShapeInput'
import { CellSaveTracker } from '@/design-system/grid'
import type { SheetColumn } from './master/types'
import { expect, it } from 'vitest'
import { groupLanguageColumns } from './buildSheetColumns'
it('groups adjacent languages by field while retaining the actual editor, setter and stable IDs', () => {
  const setter=()=>true, editor=()=>null
  const columns=[{key:'name@it',label:'Title',locale:'it',groupKey:'language:name'},{key:'name@de',label:'Title',locale:'de',groupKey:'language:name'},{key:'brand',label:'Brand'}]
  const defs=groupLanguageColumns(columns.map(c=>({colId:c.key,headerName:c.label,valueSetter:setter,cellEditor:editor})),columns)
  expect(defs).toHaveLength(2)
  expect(defs[0]).toMatchObject({groupId:'language:name',headerName:'Title',headerClass:'nds-ag-group-start',children:[{colId:'name@it',headerName:'Italian',valueSetter:setter,cellEditor:editor},{colId:'name@de',headerName:'German'}]})
  expect(defs[1]).toMatchObject({colId:'brand'})
})

it('keeps the bullet-list control and array clear on a qualified master column', () => {
  const column = { key:'bulletPoints@de', writeField:'bulletPoints', group:'Content', defaultVisible:true, label:'Bullet points', shape:'list', kind:'text', storage:'column', scope:'global', requiredBy:[], editable:true } as SheetColumn
  const [definition] = buildMasterColumns({columns:[column],tracker:new CellSaveTracker(),locale:'it'}, {current:[]})
  expect('cellEditor' in definition && definition.cellEditor).toBe(AttributeShapeEditor)
  const row = { id:'p', values:{'bulletPoints@de':{value:['One'],contentAddress:{tier:'language',language:'de'}}} }
  expect('valueSetter' in definition && (definition.valueSetter as Function)({data:row,newValue:[]})).toBe(true)
  expect(row.values['bulletPoints@de'].value).toEqual([])
  expect(row.values['bulletPoints@de'].contentAddress).toEqual({tier:'language',language:'de'})
})

it.each([
  ['inherited', 'Italian · source'], ['outdated', 'Italian · source'], ['pinned', 'German · shared'], ['ai', 'German · shared'],
])('paints the restored master renderer: %s glyph from the classifier, tooltip from the sheet source label (Owner revert 2026-09-13)', (member, from) => {
  const column = {key:'name@de',writeField:'name',group:'Content',defaultVisible:true,label:'Name',locale:'de',kind:'text',storage:'column',scope:'global',requiredBy:[],editable:true} as SheetColumn
  const [definition] = buildMasterColumns({columns:[column],tracker:new CellSaveTracker(),locale:'de'}, {current:[]})
  const row = {id:'gale',sku:'GALE-JACKET',values:{'name@de':{value:'Visible title',provenance:{member,from}}}}
  const html = renderToStaticMarkup(('cellRenderer' in definition ? definition.cellRenderer : null)({data:row,value:'Visible title'}))
  expect(html).toContain(`nds-cell-prov-${member}`)
  // The pre-language-axis glyph names the SHEET's source (the row the value came from), never the wire's tier label.
  expect(html).not.toContain(from)
  expect(html).toContain('Visible title')
  expect(html).not.toContain('nds-source-indicator')
})
