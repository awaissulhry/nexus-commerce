import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import ExcelJS from '/Users/awais/nexus-commerce/node_modules/exceljs/excel.js'
import { parseTransferRecords } from '/Users/awais/nexus-commerce/apps/api/src/services/pim/catalog-transfer-file.ts'
import { writeCatalogWorkbook, readCatalogWorkbook, type WorkbookScope, type WorkbookField } from '/Users/awais/nexus-commerce/apps/api/src/services/pim/catalog-workbook.ts'
import { formatReferenceSheet } from '/Users/awais/nexus-commerce/apps/api/src/services/pim/catalog-workbook-format.ts'

const root='/Users/awais/nexus-commerce'
const sourcePath='/Users/awais/Downloads/nexus-catalog-editing/nexus-catalog-editing-001.xlsx'
const referencePath=`${root}/outputs/gale-multimarket-2026-09-07/Gale-all-marketplaces.xlsx`
const output=`${root}/outputs/gale-workbook-functionality-2026-09-08/GALE-JACKET-functional-example.xlsx`
const sku='GALE-JACKET'
const source=new ExcelJS.Workbook(); await source.xlsx.readFile(sourcePath)
const reference=new ExcelJS.Workbook(); await reference.xlsx.readFile(referencePath)
const records: Record<string,string>[]=[]
for(const name of ['Products','Listings','Overrides']) {
  const sheet=source.getWorksheet(name)!, headers=sheet.getRow(1).values as string[]
  sheet.eachRow((row,index)=>{if(index>1 && row.getCell(headers.indexOf('sku')).text===sku) records.push(Object.fromEntries(headers.slice(1).map((key,i)=>[key,row.getCell(i+1).text])))})
}
const parsed=parseTransferRecords(records); assert.deepEqual(parsed.issues,[])
const signature=(s:{entity:string;channel:string;accountId:string;marketplace:string;locale:string})=>JSON.stringify([s.entity==='Products'?'Products':'Overrides',s.channel,s.accountId,s.marketplace,s.locale])
const manifest=reference.getWorksheet('Nexus workbook')!
const sourceScopes=new Map<string,{sheet:string;category:string}>()
manifest.eachRow((row,index)=>{if(index>=5 && row.getCell(1).text) sourceScopes.set(signature({entity:row.getCell(2).text,channel:row.getCell(3).text,accountId:row.getCell(4).text,marketplace:row.getCell(5).text,locale:row.getCell(6).text}),{sheet:row.getCell(1).text,category:row.getCell(7).text})})
const dictionary=new Map<string,WorkbookField>()
reference.getWorksheet('Dictionary')!.eachRow((row,index)=>{
  if(index===1)return
  const field:WorkbookField={field:row.getCell(2).text,label:row.getCell(3).text,type:row.getCell(4).text,required:row.getCell(5).text,editable:row.getCell(6).value!==false,maxLength:typeof row.getCell(7).value==='number'?row.getCell(7).value as number:null,unitOptions:JSON.parse(row.getCell(8).text||'[]'),schemaVersion:row.getCell(9).text,help:row.getCell(10).text,options:[]}
  dictionary.set(JSON.stringify([row.getCell(1).text,field.field]),field)
})
reference.getWorksheet('Valid values')!.eachRow((row,index)=>{if(index>1)dictionary.get(JSON.stringify([row.getCell(1).text,row.getCell(2).text]))?.options?.push(row.getCell(3).text)})
const scopes:WorkbookScope[]=[]
const missing:string[]=[]
for(const row of parsed.rows){
  let scope=scopes.find(s=>signature(s)===signature(row))
  if(!scope){const ref=sourceScopes.get(signature(row));assert.ok(ref,`Missing reference scope: ${signature(row)}`);scope={sheet:row.entity==='Products'?(row.locale?`Content ${row.locale}`:'Products'):`${row.channel} ${row.marketplace}`,entity:row.entity==='Products'?'Products':'Overrides',channel:row.channel,accountId:row.accountId,marketplace:row.marketplace,locale:row.locale,category:ref.category,fields:[],rows:[]};scopes.push(scope)}
  if(!scope.fields.some(f=>f.field===row.field)){
    const ref=sourceScopes.get(signature(row))!
    let field=dictionary.get(JSON.stringify([ref.sheet,row.field]))
    if(!field){
      missing.push(`${scope.sheet}/${row.field}`)
      const type=Array.isArray(row.value)?'list':typeof row.value==='number'?'number':typeof row.value==='boolean'?'boolean':row.value && typeof row.value==='object'?'json':'text'
      field={field:row.field,label:row.field,type,editable:false,required:'Guidance unavailable',help:'Present in the source export but absent from its saved field guidance. The original value is preserved for reference.'}
    }
    scope.fields.push({...field,...(row.field==='parentSku'?{editable:false,help:'Reference only. Manage product relationships in Nexus.'}:{})})
  }
  scope.rows.push(row)
}
const baseline={id:'format-example-gale-2026-09-08',scopes,aliasLabels:{'':'Primary listing'}}
await fs.writeFile('/tmp/nexus-gale-functional-baseline.json',JSON.stringify(baseline))
const bytes=await writeCatalogWorkbook(scopes,true,baseline)
const book=new ExcelJS.Workbook();await book.xlsx.load(bytes as never)
const instructions=book.getWorksheet('Instructions')!
instructions.getCell('B1').value='GALE-JACKET formatting example'
instructions.getCell('A4').value='3. Before importing'
instructions.getCell('B4').value='This example uses saved product data and is for inspecting the layout. Download a fresh editing workbook from the product editor before importing changes; this example has no live export baseline.'
instructions.addRow(['Source snapshots','Product values: nexus-catalog-editing-001.xlsx from Downloads, saved 5 September 2026. Attribute guidance and choices: Gale-all-marketplaces.xlsx, saved 7 September 2026. No values were invented or refreshed from the live catalog.'])
formatReferenceSheet(instructions,false)
const finalBytes=Buffer.from(await book.xlsx.writeBuffer());await fs.writeFile(output,finalBytes)
const reopened=new ExcelJS.Workbook();await reopened.xlsx.load(finalBytes as never)
const checked=readCatalogWorkbook(reopened,baseline)!;assert.deepEqual(checked.issues,[])
const stable=(r:any)=>JSON.stringify([r.entity,r.sku,r.channel,r.accountId,r.marketplace,r.aliasKey,r.locale,r.field,r.action,r.value,r.version])
assert.deepEqual(checked.rows.map(stable).sort(),parsed.rows.map(stable).sort())
for(const s of scopes)assert.ok(reopened.getWorksheet(s.sheet)!.autoFilter,'Header selector must remain present')
const report={product:sku,output,source:sourcePath,guidance:referencePath,bytes:finalBytes.length,attributeValues:parsed.rows.length,scopes:scopes.map(s=>({sheet:s.sheet,attributes:s.fields.length,aliases:[...new Set(s.rows.map(r=>r.aliasKey||'Primary listing'))]})),validValueRows:reopened.getWorksheet('Valid values')!.rowCount-1,roundtrip:'All source values, ownership, destinations and versions preserved',headerFilters:true,referenceFieldsWithoutGuidance:missing,liveBaseline:false}
await fs.writeFile(`${root}/outputs/gale-workbook-functionality-2026-09-08/verification.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report))
