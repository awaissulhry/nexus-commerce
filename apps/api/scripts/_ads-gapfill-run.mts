import { runGapFillCycle } from '../src/services/advertising/ads-report-gapfill.service.js'
const dryRun = !process.argv.includes('--live')
const r = await runGapFillCycle({ lookbackDays: 14, maxJobs: 30, dryRun })
console.log(dryRun ? '*** DRY RUN ***' : '*** LIVE ***')
console.log('gaps found:', r.gapsFound)
const byMarket: Record<string, string[]> = {}
for (const g of r.gaps) (byMarket[g.marketplace] ??= []).push(g.date)
for (const [m, days] of Object.entries(byMarket)) console.log(`  ${m}: ${days.length} — ${days.join(' ')}`)
console.log('created:', r.jobsCreated, 'skipped:', r.jobsSkipped, 'errors:', r.errors.length)
for (const e of r.errors.slice(0, 5)) console.log('  !', e)
process.exit(0)
