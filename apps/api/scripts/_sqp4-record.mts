/** SQP.4 §8 — the record-don't-fix items, measured today so the numbers are ours. */
import prisma from '../src/db.js'

const at2c = await prisma.adTarget.count({ where: { bidCents: 2 } })
const at2cNoFlag = await prisma.adTarget.count({ where: { bidCents: 2, suppressedFromBidCents: null } })
const at2cFlag = await prisma.adTarget.count({ where: { bidCents: 2, suppressedFromBidCents: { not: null } } })
console.log(`2¢ targets: ${at2c} total · ${at2cNoFlag} with suppressedFromBidCents NULL (unrestorable) · ${at2cFlag} flagged`)

const actorRows: any[] = await prisma.$queryRawUnsafe(`
  SELECT CASE
    WHEN "userId" IS NULL THEN 'null'
    WHEN "userId" ~ '^user:[^@]+@' THEN 'user:<email>'
    WHEN "userId" = 'user:operator' THEN 'user:operator'
    WHEN "userId" ~ '^user:c[a-z0-9]{20,}$' THEN 'user:<cuid>'
    WHEN "userId" LIKE 'user:%' THEN 'user:<other>'
    ELSE 'non-user' END AS shape,
    count(*)::int AS n, count(DISTINCT "userId")::int AS distinct_actors
  FROM "AdvertisingActionLog" GROUP BY 1 ORDER BY 2 DESC`)
console.log(`actor vocabularies: ${actorRows.map((r) => `${r.shape}=${r.n} (${r.distinct_actors} distinct)`).join(' · ')}`)

// §8's claim that the ledger carries no readable per-report row count
const cols: any[] = await prisma.$queryRawUnsafe(
  `SELECT column_name::text AS c FROM information_schema.columns WHERE table_name='SqpReportRequest' ORDER BY ordinal_position`)
console.log(`\nSqpReportRequest columns: ${cols.map((c) => c.c).join(', ')}`)
const nn = await prisma.sqpReportRequest.count({ where: { rowsParsed: { not: null } } })
const tot = await prisma.sqpReportRequest.count()
console.log(`🔴 §8 says the ledger carries no per-report row count. It does: rowsParsed is non-null on ${nn} of ${tot} rows,`)
console.log(`   plus rowsUpserted and (SQP.3) rowsChanged. The yield curve IS re-derivable from the ledger alone.`)

// the NULL-exclusion complement, re-measured
const capped = await prisma.adRuleExecution.count({ where: { errorMessage: 'DAILY_CAP_EXCEEDED' } })
const wrong = await prisma.adRuleExecution.count({ where: { NOT: { errorMessage: 'DAILY_CAP_EXCEEDED' } } })
const right = await prisma.adRuleExecution.count({ where: { OR: [{ errorMessage: null }, { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } }] } })
console.log(`\nNOT-excludes-NULL, re-measured: total capped ${capped} · bare NOT → ${wrong} · null-safe OR → ${right}`)
await prisma.$disconnect()
