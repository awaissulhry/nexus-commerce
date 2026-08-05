import { runAdsRetentionOnce, RETENTION_DAYS } from '../src/jobs/ads-retention.job.js'
console.log('policy (days):', JSON.stringify(RETENTION_DAYS))
const r = await runAdsRetentionOnce({ dryRun: true })
console.log('\nDRY RUN — would delete:')
for (const [k, v] of Object.entries(r.deleted)) console.log(`  ${String(v).padStart(6)}  ${k}`)
console.log(`\n  TOTAL: ${r.total}${r.cappedTables.length ? `  (more than one batch pending in: ${r.cappedTables.join(', ')})` : ''}`)
process.exit(0)
