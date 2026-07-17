// Extract key fields from an Amazon "Modello" template + diff vs Nexus IT rows.
import { execSync } from 'child_process'
const file = process.argv[2]
const unzip = (e) => execSync(`unzip -p "${file}" "${e}"`, { maxBuffer: 1<<30 }).toString('utf8')
const dec = (s) => String(s).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#10;/g,'\n').replace(/&apos;/g,"'")
const ss = unzip('xl/sharedStrings.xml')
const strings = [...ss.matchAll(/<si>(.*?)<\/si>/gs)].map(m => dec([...m[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map(t=>t[1]).join('')))
// find Modello sheet
const wb = unzip('xl/workbook.xml')
const sheets = [...wb.matchAll(/<sheet [^>]*name="([^"]*)"[^>]*r:id="([^"]*)"[^>]*\/>/g)].map(m=>({name:m[1],rid:m[2]}))
const rels = unzip('xl/_rels/workbook.xml.rels')
const relMap = Object.fromEntries([...rels.matchAll(/<Relationship [^>]*Id="([^"]*)"[^>]*Target="([^"]*)"/g)].map(m=>[m[1],m[2]]))
const mod = sheets.find(s=>/^Modello$/i.test(s.name.trim())) ?? sheets.find(s=>/modello|template/i.test(s.name))
const sheetPath = (relMap[mod.rid].startsWith('/')?relMap[mod.rid].slice(1):'xl/'+relMap[mod.rid])
const sh = unzip(sheetPath)
const colNum=(c)=>{let n=0;for(const ch of c)n=n*26+(ch.charCodeAt(0)-64);return n-1}
const rows=[]
for(const rm of sh.matchAll(/<row[^>]*r="(\d+)"[^>]*>(.*?)<\/row>/gs)){
  const cells=[]
  for(const cm of rm[2].matchAll(/<c r="([A-Z]+)\d+"(?:[^>]*t="([^"]*)")?[^>]*>(?:<v>(.*?)<\/v>|<is><t[^>]*>(.*?)<\/t><\/is>)?<\/c>/gs)){
    let v=cm[3]??cm[4]??''; if(cm[2]==='s')v=strings[+v]??''; else v=dec(v); cells[colNum(cm[1])]=v
  }
  rows[+rm[1]]=cells
}
// technical names in row 5 → build key→colIndex by matching a stem
const tech = (rows[5]??[]).map(v=>String(v??''))
const findCol = (re) => tech.findIndex(v=>re.test(v))
const C = {
  sku: findCol(/contribution_sku|^item_sku/),
  ptype: findCol(/^product_type#/),
  name: findCol(/^item_name\[/),
  brand: findCol(/^brand\[/),
  pid: findCol(/product_id_value|external_product_id#/),
  browse: findCol(/^recommended_browse_nodes\[/),
  our_price: findCol(/purchasable_offer.*our_price|purchasable_offer\[.*#1.*value_with_tax/),
  list_price: findCol(/^list_price\[/),
  desc: findCol(/^product_description\[/),
  bullet: findCol(/^bullet_point\[/),
  apparel_size: findCol(/^apparel_size\[.*\.size$/),
  bottoms_size: findCol(/^bottoms_size\[.*\.size$/),
  color: findCol(/^color\[.*\.value$/),
  parentage: findCol(/^parentage_level\[/),
  parent_sku: findCol(/child_parent_sku_relationship.*parent_sku/),
  theme: findCol(/^variation_theme#1\.name/),
}
const g=(row,i)=> i>=0 ? String(row[i]??'').trim() : ''
console.log('COLMAP', JSON.stringify(C))
console.log(`\nsku | parentage | ptype | parent_sku | color | size | price | desc? | bullets | browseNode`)
console.log('-'.repeat(110))
let firstData = 7
for (let r=firstData; r<rows.length; r++){
  const row=rows[r]; if(!row) continue
  const sku=g(row,C.sku); if(!sku) continue
  const pt=g(row,C.ptype)
  const size = g(row,C.apparel_size) || g(row,C.bottoms_size)
  const price = g(row,C.our_price) || g(row,C.list_price)
  const desc = g(row,C.desc)
  const bul = [C.bullet,C.bullet+1,C.bullet+2,C.bullet+3,C.bullet+4].map(i=>g(row,i)).filter(Boolean).length
  const browse = g(row,C.browse).slice(0,32)
  console.log(`${sku.slice(0,26).padEnd(26)} | ${g(row,C.parentage).slice(0,14).padEnd(14)} | ${pt.padEnd(9)} | ${g(row,C.parent_sku).slice(0,10).padEnd(10)} | ${g(row,C.color).slice(0,12).padEnd(12)} | ${size.padEnd(4)} | ${price.padEnd(7)} | ${desc?('Y('+desc.length+')'):'∅'} | ${bul} | ${browse}`)
}
