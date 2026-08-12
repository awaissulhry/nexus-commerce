/** HV.6 — four outcome words per actor, + the match-type NULL question. READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const int = (n: any) => Number(n).toLocaleString('en-IE')

console.log('\n═══ 1 · matchType distribution on AmazonAdsSearchTerm (last 30d) ═══')
const mt = await prisma.$queryRaw<Array<{ matchType: string | null; n: bigint }>>`
  SELECT "matchType", COUNT(*)::bigint AS n FROM "AmazonAdsSearchTerm"
  WHERE date >= NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY 2 DESC`
for (const r of mt) console.log(`  ${String(r.matchType ?? 'NULL').padEnd(34)} ${int(r.n)}`)
const mtAll = await prisma.$queryRaw<Array<{ matchType: string | null; n: bigint }>>`
  SELECT "matchType", COUNT(*)::bigint AS n FROM "AmazonAdsSearchTerm" GROUP BY 1 ORDER BY 2 DESC`
console.log('  --- all time ---')
for (const r of mtAll) console.log(`  ${String(r.matchType ?? 'NULL').padEnd(34)} ${int(r.n)}`)

console.log('\n═══ 2 · action-log outcomes per rule (all time) ═══')
const byRule = await prisma.$queryRaw<Array<{ ruleId: string | null; status: string | null; err: string | null; n: bigint; newest: Date }>>`
  SELECT "ruleId", status, "errorMessage" AS err, COUNT(*)::bigint AS n, MAX("startedAt") AS newest
  FROM "AutomationRuleExecution" GROUP BY 1,2,3 ORDER BY 1, 4 DESC`
const names = new Map((await prisma.automationRule.findMany({ select: { id: true, name: true } })).map((r: any) => [r.id, r.name]))
let cur = ''
for (const r of byRule) {
  if (r.ruleId !== cur) { cur = r.ruleId!; console.log(`\n  ── ${names.get(cur) ?? cur}`) }
  console.log(`     status=${String(r.status).padEnd(10)} err=${String(r.err ?? 'null').slice(0,34).padEnd(36)} ${String(int(r.n)).padStart(7)}  newest=${r.newest?.toISOString().slice(0,10)}`)
}

console.log('\n═══ 3 · DAILY_CAP_EXCEEDED — is it a live brake? ═══')
const cap = await prisma.$queryRaw<Array<{ n: bigint; oldest: Date; newest: Date }>>`
  SELECT COUNT(*)::bigint AS n, MIN("startedAt") AS oldest, MAX("startedAt") AS newest
  FROM "AutomationRuleExecution" WHERE "errorMessage" = 'DAILY_CAP_EXCEEDED'`
console.log(`  rows=${int(cap[0].n)} oldest=${cap[0].oldest?.toISOString().slice(0,10)} newest=${cap[0].newest?.toISOString().slice(0,10)}`)

console.log('\n═══ 4 · the NULL-branch trap: NOT vs OR on a nullable column ═══')
const wrong = await prisma.automationRuleExecution.count({ where: { NOT: { errorMessage: 'DAILY_CAP_EXCEEDED' } } })
const right = await prisma.automationRuleExecution.count({ where: { OR: [{ errorMessage: null }, { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } }] } })
const total = await prisma.automationRuleExecution.count()
console.log(`  total=${int(total)}  NOT{...}=${int(wrong)}  OR[null, not]=${int(right)}  → NOT loses ${int(right - wrong)} rows`)

console.log('\n═══ 5 · writes by actor (create_keyword / create_negative), all time ═══')
const writes = await prisma.$queryRaw<Array<{ actionType: string; userId: string | null; status: string; n: bigint; landed: bigint }>>`
  SELECT "actionType", "userId", COALESCE("amazonResponseStatus",'(null)') AS status, COUNT(*)::bigint AS n,
         COUNT(*) FILTER (WHERE "amazonResponseStatus"='SUCCESS')::bigint AS landed
  FROM "AdvertisingActionLog" WHERE "actionType" IN ('create_keyword','create_negative')
  GROUP BY 1,2,3 ORDER BY 4 DESC`
for (const r of writes) console.log(`  ${r.actionType.padEnd(16)} ${String(r.userId).padEnd(30)} ${r.status.padEnd(9)} n=${String(int(r.n)).padStart(6)} landed=${int(r.landed)}`)
await prisma.$disconnect()

console.log('\n═══ 6 · the harvest rules ONLY — four outcome words ═══')
const HARVEST_IDS = ['cmpuhjzo50002pk01y1mivhvx','cmpujofbx000vrv01spm94f42','cmpujofce000wrv01g1wyr9ui','cmpujofcv000xrv01ndwcm7rw','cmpujofh20016rv015f4pejc4','cmpujofje001brv01p83hbrx4','cmpuk99y40036pg01aohluq41']
const four = await prisma.$queryRaw<Array<{ ruleId: string; status: string; err: string|null; n: bigint; newest: Date }>>`
  SELECT "ruleId", status, "errorMessage" AS err, COUNT(*)::bigint AS n, MAX("startedAt") AS newest
  FROM "AutomationRuleExecution" WHERE "ruleId" = ANY(${HARVEST_IDS}) GROUP BY 1,2,3 ORDER BY 1,4 DESC`
let c2 = ''
for (const r of four) {
  if (r.ruleId !== c2) { c2 = r.ruleId; console.log(`\n  ── ${names.get(c2) ?? c2}`) }
  console.log(`     ${String(r.status).padEnd(9)} err=${String(r.err ?? 'null').slice(0,30).padEnd(32)} ${String(int(r.n)).padStart(7)} newest=${r.newest?.toISOString().slice(0,10)}`)
}

console.log('\n═══ 7 · did ANY harvest rule ever produce a real write? ═══')
const realWrites = await prisma.$queryRaw<Array<{ n: bigint }>>`
  SELECT COUNT(*)::bigint AS n FROM "AdvertisingActionLog" l
  WHERE l."actionType" IN ('create_keyword','create_negative')
    AND l."userId" LIKE 'automation:%'`
console.log(`  action-log rows from automation:*  = ${int(realWrites[0].n)}`)
const byActor = await prisma.$queryRaw<Array<{ userId: string|null; actionType: string; n: bigint; newest: Date }>>`
  SELECT "userId","actionType",COUNT(*)::bigint AS n, MAX("createdAt") AS newest FROM "AdvertisingActionLog"
  WHERE "actionType" IN ('create_keyword','create_negative') GROUP BY 1,2 ORDER BY 3 DESC`
for (const r of byActor) console.log(`  ${String(r.userId).padEnd(34)} ${r.actionType.padEnd(16)} ${String(int(r.n)).padStart(6)} newest=${r.newest?.toISOString().slice(0,10)}`)

console.log('\n═══ 8 · account-wide: how many writes did RULES make? ═══')
const tot = await prisma.advertisingActionLog.count()
const ruleW = await prisma.advertisingActionLog.count({ where: { userId: { startsWith: 'automation:' } } })
console.log(`  AdvertisingActionLog total=${int(tot)}  from automation:*=${int(ruleW)}  (${(ruleW/tot*100).toFixed(1)}%)`)

console.log('\n═══ 9 · observed CPC median (harvest-relevant search terms) ═══')
const cpc = await prisma.$queryRaw<Array<{ median: number; n: bigint }>>`
  SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (("costMicros"/1e4)/NULLIF(clicks,0))) AS median, COUNT(*)::bigint AS n
  FROM "AmazonAdsSearchTerm" WHERE clicks > 0 AND date >= NOW() - INTERVAL '60 days'`
console.log(`  median observed CPC = €${(Number(cpc[0].median)/100).toFixed(2)} over ${int(cpc[0].n)} rows with clicks>0`)
