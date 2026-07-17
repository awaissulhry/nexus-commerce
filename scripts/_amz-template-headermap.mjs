// Find the technical-header row + key content columns in any Amazon template format.
import { execSync } from 'child_process'
const file = process.argv[2]
const unzip=(e)=>execSync(`unzip -p "${file}" "${e}"`,{maxBuffer:1<<30}).toString()
const dec=(s)=>String(s).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#10;/g,'\n')
const ss=unzip('xl/sharedStrings.xml')
const strings=[...ss.matchAll(/<si>(.*?)<\/si>/gs)].map(m=>dec([...m[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map(t=>t[1]).join('')))
const wb=unzip('xl/workbook.xml')
const sheets=[...wb.matchAll(/<sheet [^>]*name="([^"]*)"[^>]*r:id="([^"]*)"[^>]*\/>/g)].map(m=>({name:m[1],rid:m[2]}))
const rels=unzip('xl/_rels/workbook.xml.rels')
const relMap=Object.fromEntries([...rels.matchAll(/<Relationship [^>]*Id="([^"]*)"[^>]*Target="([^"]*)"/g)].map(m=>[m[1],m[2]]))
const mod=sheets.find(s=>/^Modello$/i.test(s.name.trim()))??sheets.find(s=>/modello|template/i.test(s.name))
const sp=relMap[mod.rid].startsWith('/')?relMap[mod.rid].slice(1):'xl/'+relMap[mod.rid]
const sh=unzip(sp)
const colNum=(c)=>{let n=0;for(const ch of c)n=n*26+(ch.charCodeAt(0)-64);return n-1}
const rows=[]
for(const rm of sh.matchAll(/<row[^>]*r="(\d+)"[^>]*>(.*?)<\/row>/gs)){const cells=[];for(const cm of rm[2].matchAll(/<c r="([A-Z]+)\d+"(?:[^>]*t="([^"]*)")?[^>]*>(?:<v>(.*?)<\/v>|<is><t[^>]*>(.*?)<\/t><\/is>)?<\/c>/gs)){let v=cm[3]??cm[4]??'';if(cm[2]==='s')v=strings[+v]??'';else v=dec(v);cells[colNum(cm[1])]=v}rows[+rm[1]]=cells}
// find header row: contains item_sku or contribution_sku
let hdr=-1
for(let r=1;r<Math.min(rows.length,10);r++){ const vals=(rows[r]??[]).map(v=>String(v??'')); if(vals.some(v=>/^(item_sku|contribution_sku|feed_product_type)/.test(v))){hdr=r;break} }
console.log(`SHEET=${mod.name} sheetPath=${sp} rows=${rows.length} headerRow=${hdr}`)
if(hdr<0){ console.log('no header row found; dumping row2 sample:'); console.log((rows[2]??[]).slice(0,20)); process.exit(0) }
const tech=(rows[hdr]??[]).map(v=>String(v??''))
const find=(re)=>{const i=tech.findIndex(v=>re.test(v));return i}
const map={ sku:find(/^(item_sku|contribution_sku)/), ptype:find(/^(feed_product_type|product_type)/), name:find(/^item_name/),
  desc:find(/^product_description/), b1:find(/^bullet_point1?(\b|\[|#|$)/), parentage:find(/^parentage|^parent_child/), parent_sku:find(/parent_sku/) }
console.log('COLMAP:',JSON.stringify(map))
console.log('bullet cols:', tech.map((v,i)=>({v,i})).filter(x=>/^bullet_point/.test(x.v)).map(x=>`[${x.i}]${x.v.slice(0,18)}`).join(' '))
// first 2 real data rows (after header, skip example)
let shown=0
for(let r=hdr+1;r<rows.length&&shown<2;r++){ const row=rows[r]; if(!row)continue; const sku=String(row[map.sku]??'').trim(); if(!sku||/^ABC123$/i.test(sku))continue
  const desc=String(row[map.desc]??''); console.log(`DATA ${sku}: ptype=${row[map.ptype]} desc=${desc?('Y('+desc.length+')'):'∅'} bullet1=${String(row[map.b1]??'').slice(0,30)}`); shown++ }
