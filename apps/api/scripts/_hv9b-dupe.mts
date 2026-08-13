/** 🔴 HV.9b — did the read-back attribute ONE Amazon keyword to SEVERAL local rows? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.$queryRaw<Array<{ext:string;n:bigint;kw:string;ids:string}>>`
  SELECT t."externalTargetId" AS ext, COUNT(*)::bigint AS n, MIN(t."expressionValue") AS kw, STRING_AGG(t.id,',') AS ids
  FROM "AdTarget" t WHERE t."externalTargetId" IS NOT NULL AND t."isNegative"=false
  GROUP BY 1 HAVING COUNT(*) > 1 ORDER BY 2 DESC LIMIT 15`
console.log(`\n═══ Amazon ids attributed to MORE THAN ONE local row: ${rows.length} ═══`)
for (const r of rows) console.log(`  ×${Number(r.n)} ext=${r.ext} "${String(r.kw).slice(0,30)}"`)
const tot = await prisma.$queryRaw<Array<{n:bigint}>>`
  SELECT COUNT(*)::bigint AS n FROM (
    SELECT "externalTargetId" FROM "AdTarget" WHERE "externalTargetId" IS NOT NULL AND "isNegative"=false
    GROUP BY 1 HAVING COUNT(*)>1) x`
console.log(`  → ${Number(tot[0].n)} external ids are shared by more than one local row`)
console.log('\n═══ pushes in the last 30 min, by external id ═══')
const p = await prisma.$queryRaw<Array<{ext:string;n:bigint}>>`
  SELECT ("payloadAfter"->>'externalId') AS ext, COUNT(*)::bigint AS n
  FROM "AdvertisingActionLog" WHERE "actionType"='push_keyword' AND "createdAt" >= NOW() - INTERVAL '30 minutes'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 10`
for (const r of p) console.log(`  ×${Number(r.n)} ${r.ext}`)
const distinct = p.length, total = p.reduce((s,r)=>s+Number(r.n),0)
console.log(`  → ${total} pushes produced ${distinct}+ distinct ids (top 10 shown)`)
console.log('\n═══ how many pushes were RECOVERED by read-back vs clean? ═══')
const rb = await prisma.$queryRaw<Array<{rec:boolean|null;n:bigint}>>`
  SELECT ("payloadAfter"->>'recoveredByReadBack')::boolean AS rec, COUNT(*)::bigint AS n
  FROM "AdvertisingActionLog" WHERE "actionType"='push_keyword' AND "createdAt" >= NOW() - INTERVAL '30 minutes' GROUP BY 1`
for (const r of rb) console.log(`  recoveredByReadBack=${r.rec} → ${Number(r.n)}`)
await prisma.$disconnect()
