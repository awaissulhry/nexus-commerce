import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
// 30d settled window, >=2 orders per (query, adGroup) — where do harvestable terms convert?
const rows: Array<{ adGroupId: string; terms: bigint }> = await prisma.$queryRaw`
  SELECT "adGroupId", COUNT(*) AS terms FROM (
    SELECT "adGroupId", "query", SUM("orders7d") AS o
    FROM "AmazonAdsSearchTerm"
    WHERE "date" >= NOW() - INTERVAL '32 days' AND "date" < NOW() - INTERVAL '2 days'
      AND "adGroupId" IS NOT NULL
    GROUP BY 1, 2 HAVING SUM("orders7d") >= 2
  ) t GROUP BY 1 ORDER BY terms DESC LIMIT 8`
for (const r of rows) {
  const ag = await prisma.adGroup.findFirst({
    where: { externalAdGroupId: r.adGroupId },
    select: { id: true, name: true, campaign: { select: { name: true, marketplace: true, status: true } } },
  })
  console.log(`${r.terms} terms | ${ag?.campaign?.marketplace} ${ag?.campaign?.status} | ${ag?.campaign?.name} › ${ag?.name}`)
}
await prisma.$disconnect()
