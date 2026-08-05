/** READ-ONLY: how is existing hourly AMS data attributed, and which
 *  profiles have which subscriptions? Run before adding subscriptions. */
const prisma = (await import('../src/db.js')).default
const p = prisma as any
const L = (s = '') => console.log(s)
const { listAmsSubscriptions } = await import('../src/services/advertising/ads-marketing-stream.service.js')

L('══ EXISTING HOURLY ROWS — attribution ════════════════════════════')
const byAttr = await p.$queryRawUnsafe(`SELECT "profileId","marketplace","adProduct", COUNT(*)::int AS n, MAX("date")::text AS last FROM "AmazonAdsHourlyPerformance" GROUP BY 1,2,3 ORDER BY 4 DESC`)
for (const r of byAttr as any[]) L(`  profileId=${String(r.profileId).padEnd(18)} mkt=${String(r.marketplace).padEnd(16)} ${String(r.adProduct).padEnd(20)} ${String(r.n).padStart(6)} rows  last ${r.last}`)

L('\n══ SUBSCRIPTIONS PER PRODUCTION PROFILE ══════════════════════════')
const conns = await p.amazonAdsConnection.findMany({
  where: { isActive: true, mode: 'production' },
  select: { profileId: true, marketplace: true, region: true },
  orderBy: { marketplace: 'asc' },
})
for (const c of conns) {
  try {
    const res = await listAmsSubscriptions(c.profileId, (c.region ?? 'EU') as 'EU') as { subscriptions?: Array<{ dataSetId: string; status: string; destinationArn: string }> }
    const subs = res.subscriptions ?? []
    L(`  ${c.marketplace} (${c.profileId}): ${subs.length} subscription(s)`)
    for (const s of subs) L(`      ${String(s.dataSetId).padEnd(16)} ${s.status.padEnd(10)} ${s.destinationArn}`)
  } catch (e) {
    L(`  ${c.marketplace} (${c.profileId}): ERROR ${e instanceof Error ? e.message.slice(0, 140) : e}`)
  }
}

L('\n══ DESTINATION ARN CONFIGURED ════════════════════════════════════')
L(`  NEXUS_AMS_DESTINATION_ARN = ${process.env.NEXUS_AMS_DESTINATION_ARN || '(unset)'}`)

await prisma.$disconnect()
