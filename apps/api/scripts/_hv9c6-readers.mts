/** HV.9c.6 §4.3 — does ARCHIVED actually stop the bleeding? READ-ONLY, empirical. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const int=(n:any)=>Number(n).toLocaleString('en-IE')
console.log('\n═══ 1 · AdTarget status distribution ═══')
const st = await prisma.adTarget.groupBy({ by:['status'], _count:{_all:true} })
for (const s of st) console.log(`  ${String(s.status).padEnd(10)} ${int(s._count._all)}`)

console.log('\n═══ 2 · 🔴 do ARCHIVED targets still receive bid writes? ═══')
const arch = await prisma.$queryRaw<Array<{n:bigint;targets:bigint;newest:Date|null}>>`
  SELECT COUNT(*)::bigint AS n, COUNT(DISTINCT l."entityId")::bigint AS targets, MAX(l."createdAt") AS newest
  FROM "AdvertisingActionLog" l JOIN "AdTarget" t ON t.id=l."entityId"
  WHERE l."actionType"='AD_BID_UPDATE' AND t.status='ARCHIVED'`
const a=arch[0]
console.log(`  bid writes against ARCHIVED targets: ${int(a.n)} across ${int(a.targets)} targets · newest ${a.newest?.toISOString().slice(0,16) ?? '—'}`)
const arch30 = await prisma.$queryRaw<Array<{n:bigint}>>`
  SELECT COUNT(*)::bigint AS n FROM "AdvertisingActionLog" l JOIN "AdTarget" t ON t.id=l."entityId"
  WHERE l."actionType"='AD_BID_UPDATE' AND t.status='ARCHIVED' AND l."createdAt" >= NOW() - INTERVAL '30 days'`
console.log(`  … in the last 30 days: ${int(arch30[0].n)}`)
const en30 = await prisma.$queryRaw<Array<{n:bigint}>>`
  SELECT COUNT(*)::bigint AS n FROM "AdvertisingActionLog" l JOIN "AdTarget" t ON t.id=l."entityId"
  WHERE l."actionType"='AD_BID_UPDATE' AND t.status<>'ARCHIVED' AND l."createdAt" >= NOW() - INTERVAL '30 days'`
console.log(`  vs non-ARCHIVED in the last 30 days: ${int(en30[0].n)}`)
const nArch = st.find(s=>String(s.status)==='ARCHIVED')?._count._all ?? 0
console.log(`\n  → ${nArch} ARCHIVED targets exist. If they were being bid-written we would see it above.`)

console.log('\n═══ 3 · does the harvest page itself exclude ARCHIVED? ═══')
const { getKeywordHarvest } = await import('../src/services/advertising/keyword-harvest.service.js')
const p = await getKeywordHarvest({ market:'all' })
console.log(`  candidates: ${p.census.candidates} · rows: ${p.rows.length}`)
console.log(`  (re-run after archiving; the count must not change, because candidates come from search terms, not AdTarget rows)`)
await prisma.$disconnect()
