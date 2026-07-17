// Reusable Amazon-template importer. Auto-detects format (unified vs older),
// extracts per-SKU product_description + bullets, and fills ONLY where Nexus IT
// is empty (fill-only, into snapshot if present else platformAttributes).
// Usage: node scripts/_template-import.mjs "<file.xlsm>" [apply]
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'; import fs from 'fs'
import { execSync } from 'child_process'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()
const API='https://nexusapi-production-b7bb.up.railway.app'
const file=process.argv[2]; const APPLY=process.argv[3]==='apply'
const nz=(v)=>v!=null&&String(v).trim()!==''

// ---- parse template ----
const unzip=(e)=>execSync(`unzip -p "${file}" "${e}"`,{maxBuffer:1<<30}).toString()
const dec=(s)=>String(s).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#10;/g,'\n').replace(/&apos;/g,"'")
const strings=[...unzip('xl/sharedStrings.xml').matchAll(/<si>(.*?)<\/si>/gs)].map(m=>dec([...m[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map(t=>t[1]).join('')))
const wb=unzip('xl/workbook.xml')
const sheets=[...wb.matchAll(/<sheet [^>]*name="([^"]*)"[^>]*r:id="([^"]*)"[^>]*\/>/g)].map(m=>({name:m[1],rid:m[2]}))
const relMap=Object.fromEntries([...unzip('xl/_rels/workbook.xml.rels').matchAll(/<Relationship [^>]*Id="([^"]*)"[^>]*Target="([^"]*)"/g)].map(m=>[m[1],m[2]]))
const mod=sheets.find(s=>/^Modello$/i.test(s.name.trim()))??sheets.find(s=>/modello|template/i.test(s.name))
const sp=relMap[mod.rid].startsWith('/')?relMap[mod.rid].slice(1):'xl/'+relMap[mod.rid]
const sh=unzip(sp)
const colNum=(c)=>{let n=0;for(const ch of c)n=n*26+(ch.charCodeAt(0)-64);return n-1}
const rows=[]
for(const rm of sh.matchAll(/<row[^>]*r="(\d+)"[^>]*>(.*?)<\/row>/gs)){const cells=[];for(const cm of rm[2].matchAll(/<c r="([A-Z]+)\d+"(?:[^>]*t="([^"]*)")?[^>]*>(?:<v>(.*?)<\/v>|<is><t[^>]*>(.*?)<\/t><\/is>)?<\/c>/gs)){let v=cm[3]??cm[4]??'';if(cm[2]==='s')v=strings[+v]??'';else v=dec(v);cells[colNum(cm[1])]=v}rows[+rm[1]]=cells}
let hdr=-1
for(let r=1;r<Math.min(rows.length,12);r++){const vals=(rows[r]??[]).map(v=>String(v??''));if(vals.some(v=>/^(item_sku|contribution_sku)/.test(v))){hdr=r;break}}
if(hdr<0){console.error('no header row');process.exit(1)}
const tech=(rows[hdr]??[]).map(v=>String(v??''))
const findAll=(re)=>tech.map((v,i)=>({v,i})).filter(x=>re.test(x.v)).map(x=>x.i)
const C={ sku:findAll(/^(item_sku|contribution_sku)/)[0], desc:findAll(/^product_description/)[0], bullets:findAll(/^bullet_point/).slice(0,5) }
const tmpl=new Map()
for(let r=hdr+1;r<rows.length;r++){const row=rows[r];if(!row)continue;const sku=String(row[C.sku]??'').trim();if(!sku||/^ABC123$/i.test(sku))continue
  const desc=String(row[C.desc]??'').trim(); const bullets=C.bullets.map(i=>String(row[i]??'').trim()).filter(Boolean)
  tmpl.set(sku,{desc,bullets})}
console.log(`TEMPLATE ${path.basename(file)}  format-header-row=${hdr}  SKUs=${tmpl.size}  (desc col=${C.desc}, bullet cols=${C.bullets.join(',')})`)

// ---- current Nexus IT state ----
const {rows:cur}=await(await fetch(`${API}/api/amazon/flat-file/rows?marketplace=IT`)).json()
const curBySku=new Map(cur.map(r=>[r.item_sku,r]))
const bulletsOf=(r)=>[r.bullet_point,r.bullet_point_1,r.bullet_point_2,r.bullet_point_3,r.bullet_point_4,r.bullet_point_5].filter(nz)
const skus=[...tmpl.keys()]
const products=await prisma.product.findMany({where:{sku:{in:skus}},select:{id:true,sku:true}})
const pidBySku=new Map(products.map(p=>[p.sku,p.id])); const skuByPid=new Map(products.map(p=>[p.id,p.sku]))
const listings=await prisma.channelListing.findMany({where:{channel:'AMAZON',channelMarket:'AMAZON_IT',productId:{in:products.map(p=>p.id)}},select:{id:true,productId:true,platformAttributes:true,flatFileSnapshot:true}})

const backup=[],plan=[]
for(const l of listings){
  const sku=skuByPid.get(l.productId); const t=tmpl.get(sku); const c=curBySku.get(sku); if(!t||!c)continue
  const hasSnap=l.flatFileSnapshot&&typeof l.flatFileSnapshot==='object'&&Object.keys(l.flatFileSnapshot).length>0
  const snap=hasSnap?{...l.flatFileSnapshot}:null
  const pa=(l.platformAttributes&&typeof l.platformAttributes==='object')?{...l.platformAttributes}:{}
  const attrs={...(pa.attributes??{})}
  const fills=[]
  if(!nz(c.product_description)&&nz(t.desc)){ if(snap)snap.product_description=t.desc; else attrs.product_description=[{value:t.desc}]; fills.push(`desc(${t.desc.length})`) }
  if(bulletsOf(c).length===0&&t.bullets.length>0){ if(snap)t.bullets.forEach((b,i)=>snap[`bullet_point_${i+1}`]=b); else attrs.bullet_point=t.bullets.map(b=>({value:b})); fills.push(`bullets(${t.bullets.length})`) }
  if(!fills.length)continue
  backup.push({listingId:l.id,sku,before:{platformAttributes:l.platformAttributes,flatFileSnapshot:l.flatFileSnapshot}})
  const data=snap?{flatFileSnapshot:snap}:{platformAttributes:{...pa,attributes:attrs}}
  plan.push({listingId:l.id,sku,fills,data,target:snap?'snap':'attrs'})
}
console.log(`Listings to fill: ${plan.length}`)
for(const p of plan.slice(0,8))console.log(`  ${p.sku.padEnd(30)} ${p.fills.join(',')} -> ${p.target}`)
if(plan.length>8)console.log(`  … +${plan.length-8} more`)
if(!APPLY){console.log('\nDRY-RUN (add "apply" to write).');await prisma.$disconnect();process.exit(0)}
const bf=path.join(here,`_backup-tmplimport-${path.basename(file).replace(/\W+/g,'_')}-${Date.now()}.json`)
fs.writeFileSync(bf,JSON.stringify(backup)); console.log(`Backup: ${bf}`)
let n=0;for(const p of plan){await prisma.channelListing.update({where:{id:p.listingId},data:p.data});n++}
console.log(`✅ Updated ${n} listings.`)
await prisma.$disconnect()
