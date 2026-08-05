import { streamWorkbook } from '../src/services/advertising/bulksheet/spreadsheet-adapter.js'
const want=['Start date','Targeting type','State','Match type','Bidding strategy','Placement','Percentage','Bid','Daily budget','ASIN (Informational only)','Impressions','Clicks','Click-through rate','Spend','Sales','ACOS','CPC','ROAS']
const byEntity=new Map<string,Record<string,string>>()
await streamWorkbook(process.argv[2]!, async (row) => {
  if (row.sheet!=='Sponsored Products Campaigns') return
  const e=row.cells['Entity']??''; if(!e||byEntity.has(e))return
  const o:Record<string,string>={}; for(const w of want) if(row.cells[w]) o[w]=row.cells[w]!
  byEntity.set(e,o)
})
for(const [e,o] of byEntity){ console.log(`\n${e}`); for(const [k,v] of Object.entries(o)) console.log(`   ${k.padEnd(26)} ${v}`) }
