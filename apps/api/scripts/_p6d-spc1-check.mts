/** READ-ONLY. Before landing another session's orphaned ingest: does every column it WRITES
 *  actually exist in production? A write to a column that isn't there fails the nightly cron for
 *  the whole account, so this is the half worth checking rather than trusting. */
const { default: prisma } = await import('../src/db.js')
const WRITES = ['orders1d','orders14d','orders30d','units1d','units14d','units30d',
  'sales1dCents','sales30dCents','salesSameSku1dCents','salesSameSku7dCents','salesSameSku14dCents','salesSameSku30dCents',
  'ordersSameSku1d','ordersSameSku7d','ordersSameSku14d','ordersSameSku30d',
  'unitsSameSku1d','unitsSameSku7d','unitsSameSku14d','unitsSameSku30d',
  'topOfSearchIS','campaignBudgetCents','campaignBudgetType','campaignBiddingStrategy',
  'campaignRuleBasedBudgetCents','campaignBudgetRuleId','campaignBudgetRuleName','entityName','entityStatus']
const cols = await prisma.$queryRawUnsafe<Array<{ column_name: string; is_nullable: string }>>(
  `SELECT column_name::text AS column_name, is_nullable::text AS is_nullable FROM information_schema.columns WHERE table_name='AmazonAdsDailyPerformance'`)
const have = new Map(cols.map(c => [c.column_name, c.is_nullable]))
const missing = WRITES.filter(w => !have.has(w))
console.log(`columns the uncommitted ingest writes: ${WRITES.length}`)
console.log(`present in production:                ${WRITES.length - missing.length}`)
console.log(`MISSING (would fail the nightly cron): ${missing.length ? missing.join(', ') : 'none'}`)
const notNull = WRITES.filter(w => have.get(w) === 'NO')
console.log(`NOT NULL among them (a null write would fail): ${notNull.length ? notNull.join(', ') : 'none'}`)
console.log(`\nevidence the widened REQUEST already worked against Amazon:`)
const r = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
  `SELECT COUNT(*)::bigint AS rows_with_samesku, COUNT(DISTINCT "date")::bigint AS days, MIN("date")::text AS first, MAX("date")::text AS last
   FROM "AmazonAdsDailyPerformance" WHERE "salesSameSku7dCents" IS NOT NULL`)
console.log('  ', Object.entries(r[0]).map(([k,v]) => `${k}=${typeof v==='bigint'?Number(v):v}`).join('  '))
await prisma.$disconnect()
