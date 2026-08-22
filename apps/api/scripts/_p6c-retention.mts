/** READ-ONLY (dryRun). Prove the new sweep is wired and prunes nothing yet. */
import '../src/env.js'
const { runAdsRetentionOnce, RETENTION_DAYS } = await import('../src/jobs/ads-retention.job.js')
const { default: prisma } = await import('../src/db.js')
console.log('window (days):', RETENTION_DAYS.budgetUsageSample)
const r = await runAdsRetentionOnce({ dryRun: true })
console.log('dryRun:', r.dryRun, '· would delete:', JSON.stringify(r.deleted))
console.log('adBudgetUsageSample present in the sweep:', Object.prototype.hasOwnProperty.call(r.deleted, 'adBudgetUsageSample'))
console.log('rows currently in the table:', await prisma.adBudgetUsageSample.count())
console.log('oldest lastSeenAt:', (await prisma.adBudgetUsageSample.aggregate({ _min: { lastSeenAt: true } }))._min.lastSeenAt?.toISOString())
await prisma.$disconnect()
