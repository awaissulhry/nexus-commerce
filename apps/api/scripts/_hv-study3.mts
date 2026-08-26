/** HV part 3 — are AdTarget metrics populated at all? And what are the duplicates? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')

const all = await prisma.adTarget.findMany({
  where: { kind: 'KEYWORD', isNegative: false },
  select: { createdAt: true, impressions: true, clicks: true, spendCents: true, salesCents: true, externalTargetId: true, lastSyncedAt: true },
})
console.log(`\n── AdTarget (positive keywords): ${int(all.length)} ──`)
console.log(`  with impressions > 0 : ${int(all.filter((a) => a.impressions > 0).length)}`)
console.log(`  with spend > 0       : ${int(all.filter((a) => a.spendCents > 0).length)}`)
console.log(`  with an externalTargetId (exists on Amazon): ${int(all.filter((a) => a.externalTargetId).length)}`)
console.log(`  ever synced          : ${int(all.filter((a) => a.lastSyncedAt).length)}`)
const cut = new Date(Date.now() - 60 * 86_400_000)
const old = all.filter((a) => a.createdAt < cut), fresh = all.filter((a) => a.createdAt >= cut)
const pct = (arr: typeof all, f: (x: typeof all[number]) => boolean) => arr.length ? `${((arr.filter(f).length / arr.length) * 100).toFixed(0)}%` : '—'
console.log(`\n  OLDER than 60d (${int(old.length)}): impressions ${pct(old, (a) => a.impressions > 0)} · external id ${pct(old, (a) => !!a.externalTargetId)} · synced ${pct(old, (a) => !!a.lastSyncedAt)}`)
console.log(`  CREATED in 60d (${int(fresh.length)}): impressions ${pct(fresh, (a) => a.impressions > 0)} · external id ${pct(fresh, (a) => !!a.externalTargetId)} · synced ${pct(fresh, (a) => !!a.lastSyncedAt)}`)
console.log(`\n  → if BOTH cohorts are ~0% on impressions, AdTarget metrics simply are not populated`)
console.log(`    and "new keywords got no impressions" is unmeasurable from this table.`)

// Where do keyword metrics actually live?
const dailyKw = await prisma.amazonAdsDailyPerformance.groupBy({
  by: ['entityType'], where: { date: { gte: cut } }, _count: { _all: true },
}).catch(() => [])
console.log(`\n── AmazonAdsDailyPerformance by entityType, 60d ──`)
for (const d of dailyKw) console.log(`  ${pad(String(d.entityType), 16)} ${int(d._count._all)}`)

// duplicates — are they local-only or real?
const dup = await prisma.$queryRaw<Array<{ v: string; ag: string; n: bigint; ext: bigint }>>`
  SELECT lower(trim("expressionValue")) AS v, "adGroupId" AS ag, COUNT(*)::bigint AS n,
         COUNT("externalTargetId")::bigint AS ext
  FROM "AdTarget" WHERE kind='KEYWORD' AND "isNegative"=false AND "expressionValue" IS NOT NULL
  GROUP BY 1,2 HAVING COUNT(*) > 1 ORDER BY 3 DESC LIMIT 8`
console.log(`\n── the duplicate groups: how many rows carry an Amazon id? ──`)
for (const d of dup) console.log(`  ${pad(d.v, 40)} ${Number(d.n)} rows · ${Number(d.ext)} with an Amazon id`)
console.log(`  → rows WITHOUT an Amazon id never reached Amazon; they are local duplicates.`)

const totalDup = await prisma.$queryRaw<Array<{ groups: bigint; extra: bigint }>>`
  SELECT COUNT(*)::bigint AS groups, SUM(n - 1)::bigint AS extra FROM (
    SELECT COUNT(*) AS n FROM "AdTarget"
    WHERE kind='KEYWORD' AND "isNegative"=false AND "expressionValue" IS NOT NULL
    GROUP BY lower(trim("expressionValue")), "adGroupId" HAVING COUNT(*) > 1) t`
console.log(`\n  duplicate groups: ${Number(totalDup[0]?.groups ?? 0)} · redundant rows: ${Number(totalDup[0]?.extra ?? 0)}`)
await prisma.$disconnect()
