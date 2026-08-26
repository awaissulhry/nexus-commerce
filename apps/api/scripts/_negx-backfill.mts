/** NEG.X — backfill the 3 Amazon ids the create parser dropped. Local correction to match Amazon,
 *  which was read back live; no Amazon write. */
import '../src/env.js'
const { listNegativeKeywords, adsMode } = await import('../src/services/advertising/ads-api-client.js')
const { default: prisma } = await import('../src/db.js')
if (adsMode() !== 'live') { console.log('🔴 not live — refusing to backfill from an empty read'); await prisma.$disconnect(); process.exit(1) }

const rows = await prisma.adTarget.findMany({
  where: { isNegative: true, expressionValue: 'protezioni', externalTargetId: null },
  select: { id: true, adGroup: { select: { externalAdGroupId: true, name: true, campaign: { select: { name: true, externalCampaignId: true, marketplace: true } } } } },
})
console.log(`rows missing an Amazon id: ${rows.length}`)
let fixed = 0
for (const mk of [...new Set(rows.map(r => r.adGroup?.campaign?.marketplace).filter(Boolean))] as string[]) {
  const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace: mk, isActive: true }, select: { profileId: true } })
  if (!conn) continue
  const campIds = [...new Set(rows.filter(r => r.adGroup?.campaign?.marketplace === mk).map(r => r.adGroup!.campaign!.externalCampaignId!))]
  const live = await listNegativeKeywords({ profileId: conn.profileId, region: 'EU' } as never, { campaignIds: campIds })
  for (const r of rows.filter(r => r.adGroup?.campaign?.marketplace === mk)) {
    const hit = live.find(k => k.adGroupId === r.adGroup?.externalAdGroupId && (k.keywordText ?? '').toLowerCase() === 'protezioni')
    const id = hit?.keywordId ?? hit?.negativeKeywordId
    if (!id) { console.log(`  🔴 ${r.adGroup?.campaign?.name}: no match at Amazon — leaving null (it is genuinely not there)`); continue }
    await prisma.adTarget.update({ where: { id: r.id }, data: { externalTargetId: String(id) } })
    console.log(`  ✓ ${r.adGroup?.campaign?.name} › ${r.adGroup?.name} → ${id}`)
    fixed++
  }
}
const left = await prisma.adTarget.count({ where: { isNegative: true, expressionValue: 'protezioni', externalTargetId: null } })
const orph = await prisma.adTarget.count({ where: { isNegative: true, orphanedAt: { not: null } } })
console.log(`\nbackfilled ${fixed} · still missing an id ${left} · orphaned ${orph}`)
await prisma.$disconnect()
