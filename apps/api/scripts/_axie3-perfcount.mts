import { streamWorkbook } from '../src/services/advertising/bulksheet/spreadsheet-adapter.js'
const byEntity=new Map<string,{tot:number;withPerf:number;sample?:string}>()
await streamWorkbook(process.argv[2]!, async (row) => {
  if (row.sheet!=='Sponsored Products Campaigns') return
  const e=row.cells['Entity']??''; if(!e)return
  let r=byEntity.get(e); if(!r){r={tot:0,withPerf:0};byEntity.set(e,r)}
  r.tot++
  if(row.cells['Impressions']){ r.withPerf++
    if(!r.sample) r.sample=`impr=${row.cells['Impressions']} clicks=${row.cells['Clicks']} spend=${row.cells['Spend']} sales=${row.cells['Sales']} acos=${row.cells['ACOS']} cpc=${row.cells['CPC']}` }
})
for(const [e,r] of [...byEntity].sort((a,b)=>b[1].tot-a[1].tot))
  console.log(`  ${e.padEnd(28)} ${String(r.withPerf).padStart(5)}/${String(r.tot).padEnd(6)} with perf   ${r.sample??''}`)
