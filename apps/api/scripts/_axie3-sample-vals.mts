import { streamWorkbook } from '../src/services/advertising/bulksheet/spreadsheet-adapter.js'
const want = ['Click-through rate','Conversion rate','ACOS','ROAS','CPC','Spend','Sales','Impressions','Percentage','Bid','Daily budget','Start date','Targeting type','State','Match type','Bidding strategy','Placement','Eligibility status (Informational only)','ASIN (Informational only)']
const seen = new Map<string, Set<string>>()
let n = 0
await streamWorkbook(process.argv[2]!, async (row) => {
  if (row.sheet !== 'Sponsored Products Campaigns') return
  if (n++ > 4000) return
  for (const w of want) { const v = row.cells[w]; if (v) { if (!seen.has(w)) seen.set(w, new Set()); const s = seen.get(w)!; if (s.size < 4) s.add(v) } }
})
for (const w of want) console.log(`  ${w.padEnd(42)} ${[...(seen.get(w) ?? ['(never populated)'])].join('  |  ')}`)
