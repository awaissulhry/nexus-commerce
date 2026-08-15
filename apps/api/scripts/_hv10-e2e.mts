/** HV.10 — the comma list against real data. READ-ONLY. */
import '../src/env.js'
const { getKeywordHarvest } = await import('../src/services/advertising/keyword-harvest.service.js')
for (const m of ['all','IT','DE','IT,DE','DE,ES','ZZ,IT']) {
  const p = await getKeywordHarvest({ market: m })
  const mkts=[...new Set(p.rows.map((r:any)=>r.market))].sort().join(',')
  console.log(`  market=${String(m).padEnd(7)} candidates=${String(p.census.candidates).padStart(2)} rows=${String(p.rows.length).padStart(2)} markets=[${mkts||'—'}]`)
}
process.exit(0)
