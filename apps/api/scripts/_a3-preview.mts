/** ADX A3 — what would happen if we armed the two guards. READ-ONLY: pure preview fns. */
import './../src/env.js'
const { analyzeRetailReadiness } = await import('../src/services/advertising/ads-retail-readiness.service.js')
const { computeBudgetEnforcement } = await import('../src/services/advertising/ads-budget-enforce.service.js')

console.log('\n=== RETAIL GUARD — what it would suppress ===')
const ra = await analyzeRetailReadiness({})
const byVerdict = new Map<string, number>()
for (const c of ra.campaigns) byVerdict.set(c.verdict, (byVerdict.get(c.verdict) ?? 0) + 1)
console.log('campaigns analysed:', ra.campaigns.length, '· verdicts:', JSON.stringify(Object.fromEntries(byVerdict)))
const toPause = ra.campaigns.filter((c) => c.verdict === 'pause')
console.log(`WOULD SUPPRESS (bids → ~2¢, restorable): ${toPause.length}`)
for (const c of toPause.slice(0, 12)) console.log(`  · ${(c as { name?: string }).name ?? c.campaignId} — ${JSON.stringify((c as { reasons?: unknown }).reasons ?? (c as { reason?: unknown }).reason ?? '')}`)

console.log('\n=== BUDGET ENFORCE — what it would change ===')
try {
  const be = await computeBudgetEnforcement()
  const rows = (be as { decisions?: unknown[] }).decisions ?? (Array.isArray(be) ? be : [])
  const list = rows as Array<{ name: string; currentDailyCents: number; targetDailyCents: number | null; deltaCents: number; clamp: string | null; suppress: boolean; restore: boolean }>
  const changing = list.filter((d) => d.deltaCents !== 0 || d.suppress || d.restore)
  console.log(`campaigns evaluated: ${list.length} · would change: ${changing.length}`)
  for (const d of changing.slice(0, 15)) {
    console.log(`  · ${d.name}: €${(d.currentDailyCents/100).toFixed(2)} → €${((d.targetDailyCents ?? d.currentDailyCents)/100).toFixed(2)} (Δ€${(d.deltaCents/100).toFixed(2)})${d.clamp?` clamp=${d.clamp}`:''}${d.suppress?' SUPPRESS':''}${d.restore?' RESTORE':''}`)
  }
} catch (e) { console.log('budget enforce preview failed:', (e as Error).message) }
process.exit(0)
