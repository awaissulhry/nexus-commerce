/** READ-ONLY: ad-product coverage across the mirror. */
const prisma = (await import('../src/db.js')).default
const p = prisma as any
const L = (s = '') => console.log(s)

L('══ CAMPAIGN MIRROR by ad product / marketplace ══════════════════════')
const rows = await p.$queryRawUnsafe(`SELECT "type"::text AS t,"marketplace", COUNT(*)::int AS n, MAX("lastSyncedAt")::text AS last FROM "Campaign" GROUP BY 1,2 ORDER BY 1,2`)
for (const r of rows as any[]) L(`  ${String(r.t ?? '(null)').padEnd(24)} ${String(r.marketplace ?? '?').padEnd(4)} ${String(r.n).padStart(5)}  last sync ${String(r.last).slice(0, 19)}`)

L('')
L('══ DAILY PERF by ad product ═════════════════════════════════════════')
const perf = await p.$queryRawUnsafe(`SELECT "adProduct", COUNT(*)::int AS n, MAX("date")::text AS last FROM "AmazonAdsDailyPerformance" GROUP BY 1 ORDER BY 1`)
for (const r of perf as any[]) L(`  ${String(r.adProduct).padEnd(20)} ${String(r.n).padStart(7)}  latest ${String(r.last).slice(0, 10)}`)

L('')
L('══ DSP / Sponsored TV present in the mirror? ════════════════════════')
const dsp = await p.$queryRawUnsafe(`SELECT "type", COUNT(*)::int AS n FROM "Campaign" GROUP BY 1 ORDER BY 2 DESC`)
for (const r of dsp as any[]) L(`  type=${String(r.type).padEnd(24)} ${String(r.n).padStart(5)}`)

await prisma.$disconnect()
