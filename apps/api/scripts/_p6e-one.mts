const { default: prisma } = await import('../src/db.js')
const c = await prisma.campaign.findFirst({ where: { name: 'GALE BROAD IT' }, select: { id: true, externalCampaignId: true } })
const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT "reportRunId", "adProduct", COUNT(*)::bigint AS rows,
         COALESCE(SUM("sales7dCents"),0)::bigint AS sum7d,
         COALESCE(SUM("sales14dCents"),0)::bigint AS sum14d
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType"='CAMPAIGN' AND "localEntityId"=$1
    AND "date" >= '2026-07-24'::date AND "date" <= '2026-08-22'::date
  GROUP BY 1,2 ORDER BY 3 DESC`, c!.id)
console.log('by reportRunId, localEntityId bucket:')
for (const r of rows) console.log(`  runId=${String(r.reportRunId).slice(0,24).padEnd(26)} ${r.adProduct} rows=${Number(r.rows as bigint)} sum7d=${Number(r.sum7d as bigint)/100} sum14d=${Number(r.sum14d as bigint)/100}`)
const ext = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
  SELECT COUNT(*)::bigint AS rows, COALESCE(SUM("sales7dCents"),0)::bigint AS sum7d
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType"='CAMPAIGN' AND "entityId"=$1 AND "localEntityId" IS NULL
    AND "date" >= '2026-07-24'::date AND "date" <= '2026-08-22'::date`, c!.externalCampaignId)
console.log('external fallback bucket:', JSON.stringify(ext[0]))
await prisma.$disconnect()
