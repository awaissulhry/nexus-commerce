/** Stage 6 — do the legacy /marketing/advertising surfaces have any data behind them? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const q = async (label: string, sql: string) => {
  try {
    const r = await prisma.$queryRawUnsafe<{ n: bigint }[]>(sql)
    console.log(`  ${label.padEnd(34)} ${String(r[0]?.n ?? 0).padStart(8)}`)
  } catch (e) {
    console.log(`  ${label.padEnd(34)} ${'ERR'.padStart(8)}  ${(e as Error).message.split('\n')[0].slice(0, 90)}`)
  }
}

console.log('\n═ rows behind each legacy-only surface (prod)')
await q('Campaign type=DSP (dsp)', `SELECT COUNT(*) n FROM "Campaign" WHERE type = 'DSP'`)
await q('AdAudience (audiences)', 'SELECT COUNT(*) n FROM "AdAudience"')
await q('BudgetPool (budget-pools)', 'SELECT COUNT(*) n FROM "BudgetPool"')
await q('BudgetPoolAllocation', 'SELECT COUNT(*) n FROM "BudgetPoolAllocation"')
await q('ProductProfitDaily (profit)', 'SELECT COUNT(*) n FROM "ProductProfitDaily"')
await q('ProductProfitDaily last 30d', `SELECT COUNT(*) n FROM "ProductProfitDaily" WHERE date > NOW() - INTERVAL '30 days'`)
await q('FbaStorageAge (storage-age)', 'SELECT COUNT(*) n FROM "FbaStorageAge"')
await q('AdvertisingActionLog 30d (events)', `SELECT COUNT(*) n FROM "AdvertisingActionLog" WHERE "createdAt" > NOW() - INTERVAL '30 days'`)
await q('AutomationRuleExecution (executions)', 'SELECT COUNT(*) n FROM "AutomationRuleExecution"')
await q('AdvertisingActionLog', 'SELECT COUNT(*) n FROM "AdvertisingActionLog"')
await q('AmazonAdsSearchTerm (ngrams/terms)', 'SELECT COUNT(*) n FROM "AmazonAdsSearchTerm"')
await prisma.$disconnect()
