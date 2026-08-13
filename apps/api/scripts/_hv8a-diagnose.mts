/** HV.8a — WHY 0 of 20 campaign-scoped negatives ever reached Amazon. READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const int=(n:any)=>Number(n).toLocaleString('en-IE')

console.log('\n═══ 1 · the two scopes, recounted ═══')
const scopes = await prisma.$queryRaw<Array<{scope:string;n:bigint;landed:bigint;oldest:Date;newest:Date}>>`
  SELECT COALESCE("negativeLevel",'(null)') AS scope,
         COUNT(*)::bigint AS n,
         COUNT(*) FILTER (WHERE "externalTargetId" IS NOT NULL)::bigint AS landed,
         MIN("createdAt") AS oldest, MAX("createdAt") AS newest
  FROM "AdTarget" WHERE "isNegative" = true GROUP BY 1`
for (const s of scopes) console.log(`  ${s.scope.padEnd(9)} rows=${String(int(s.n)).padStart(6)} landed=${String(int(s.landed)).padStart(6)} (${(Number(s.landed)/Number(s.n)*100).toFixed(0)}%) ${s.oldest.toISOString().slice(0,10)} → ${s.newest.toISOString().slice(0,10)}`)

console.log('\n═══ 2 · the campaign-scoped rows, one by one ═══')
const rows = await prisma.$queryRaw<Array<{id:string;kw:string;mt:string;created:Date;ext:string|null;camp:string|null;mkt:string|null}>>`
  SELECT t.id, t."expressionValue" AS kw, t."expressionType" AS mt, t."createdAt" AS created,
         t."externalTargetId" AS ext, c.name AS camp, c.marketplace AS mkt
  FROM "AdTarget" t JOIN "AdGroup" g ON g.id = t."adGroupId" JOIN "Campaign" c ON c.id = g."campaignId"
  WHERE t."isNegative" = true AND t."negativeLevel" = 'CAMPAIGN' ORDER BY t."createdAt"`
const NEG0B = new Date('2026-08-12T00:00:00Z')
for (const r of rows) console.log(`  ${r.created.toISOString().slice(0,10)} ${r.created<NEG0B?'PRE ':'POST'} ${String(r.kw).slice(0,26).padEnd(28)} ${String(r.mt).padEnd(16)} ext=${r.ext??'—'} mkt=${r.mkt??'NULL'} camp=${String(r.camp??'—').slice(0,24)}`)
console.log(`  → ${rows.length} rows · created BEFORE NEG.0(b) (2026-08-12): ${rows.filter(r=>r.created<NEG0B).length} · after: ${rows.filter(r=>r.created>=NEG0B).length}`)
console.log(`  → rows whose campaign has NO marketplace: ${rows.filter(r=>!r.mkt).length}`)

console.log('\n═══ 3 · did anything ever enqueue or log for them? ═══')
const ids = rows.map(r=>r.id)
// OutboundSyncQueue is product/listing-oriented and has no entityId — negatives never traverse it;
// createNegative calls Amazon directly via liveCall. Nothing to check there.
const al = await prisma.$queryRaw<Array<{n:bigint;types:string;users:string}>>`SELECT COUNT(*)::bigint AS n, STRING_AGG(DISTINCT "actionType",',') AS types, STRING_AGG(DISTINCT "userId",',') AS users FROM "AdvertisingActionLog" WHERE "entityId" = ANY(${ids})`
console.log(`  AdvertisingActionLog rows for these 20: ${int(al[0].n)} types=${al[0].types ?? '(none)'} users=${al[0].users ?? '(none)'}`)
const lastSync = await prisma.$queryRaw<Array<{st:string|null;err:string|null;n:bigint}>>`
  SELECT "lastSyncStatus"::text AS st, "lastSyncError" AS err, COUNT(*)::bigint AS n
  FROM "AdTarget" WHERE "isNegative"=true AND "negativeLevel"='CAMPAIGN' GROUP BY 1,2`
for (const s of lastSync) console.log(`  lastSyncStatus=${s.st ?? 'NULL'} err=${s.err ?? 'NULL'} → ${int(s.n)} rows`)

console.log('\n═══ 4 · the live-mode question ═══')
console.log(`  NEXUS_AMAZON_ADS_MODE (this process) = ${JSON.stringify(process.env.NEXUS_AMAZON_ADS_MODE)} → adsMode=${process.env.NEXUS_AMAZON_ADS_MODE === 'live' ? 'live':'sandbox'}`)
const conns = await prisma.amazonAdsConnection.findMany({ where:{isActive:true}, select:{marketplace:true, profileId:true, mode:true, writesEnabledAt:true} })
for (const c of conns) console.log(`  conn ${c.marketplace} profile=${c.profileId} mode=${c.mode} writesEnabledAt=${c.writesEnabledAt?.toISOString().slice(0,10) ?? 'NULL — writes disabled'}`)

console.log('\n═══ 5 · when did AD_GROUP negatives start landing? ═══')
const ag = await prisma.$queryRaw<Array<{month:string;n:bigint;landed:bigint}>>`
  SELECT TO_CHAR("createdAt",'YYYY-MM') AS month, COUNT(*)::bigint AS n,
         COUNT(*) FILTER (WHERE "externalTargetId" IS NOT NULL)::bigint AS landed
  FROM "AdTarget" WHERE "isNegative"=true AND "negativeLevel"='AD_GROUP' GROUP BY 1 ORDER BY 1`
for (const m of ag) console.log(`  ${m.month} rows=${String(int(m.n)).padStart(6)} landed=${String(int(m.landed)).padStart(6)}`)

console.log('\n═══ 6 · the denominator reconciliation ═══')
const all = await prisma.automationRule.count()
const adv = await prisma.automationRule.count({ where:{ domain:'advertising' } })
const byDomain = await prisma.automationRule.groupBy({ by:['domain'], _count:{_all:true} })
console.log(`  rules total (all domains) = ${all}`)
console.log(`  by domain: ${byDomain.map((d:any)=>`${d.domain}=${d._count._all}`).join(' · ')}`)
const advRules: any[] = await prisma.automationRule.findMany({ where:{domain:'advertising'}, select:{id:true,name:true,actions:true} })
const HARVEST = new Set(['promote_to_exact','harvest_and_negate'])
const CREATING = new Set([...HARVEST,'add_negative_exact','add_negative_phrase','sync_negatives_across_campaigns'])
const h = advRules.filter(r=>((Array.isArray(r.actions)?r.actions:[]) as any[]).some(a=>HARVEST.has(a?.type)))
const c2 = advRules.filter(r=>((Array.isArray(r.actions)?r.actions:[]) as any[]).some(a=>CREATING.has(a?.type)))
console.log(`  advertising rules with a HARVEST action (promote_to_exact|harvest_and_negate) = ${h.length}`)
console.log(`  advertising rules with ANY CREATING action (+3 negative types)               = ${c2.length}`)
console.log(`  the extra ${c2.length-h.length}: ${c2.filter(r=>!h.includes(r)).map(r=>r.name).join(' · ')}`)
await prisma.$disconnect()
