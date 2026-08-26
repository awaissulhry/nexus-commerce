/** NEG.X — READ BACK from Amazon: does `protezioni` exist as a negative in the 3 ad groups?
 *  READ-ONLY against Amazon. This is ground truth; the local row is not. */
import '../src/env.js'
const { listNegativeKeywords, adsMode } = await import('../src/services/advertising/ads-api-client.js')
const { default: prisma } = await import('../src/db.js')

console.log(`ads mode: ${adsMode()}`)
const rows = await prisma.adTarget.findMany({
  where: { isNegative: true, expressionValue: 'protezioni' },
  select: { id: true, externalTargetId: true, adGroup: { select: { externalAdGroupId: true, name: true, campaign: { select: { name: true, externalCampaignId: true, marketplace: true } } } } },
})
const markets = [...new Set(rows.map(r => r.adGroup?.campaign?.marketplace).filter(Boolean))] as string[]
for (const mk of markets) {
  const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace: mk, isActive: true }, select: { profileId: true } })
  if (!conn) { console.log(`no connection for ${mk}`); continue }
  const campIds = [...new Set(rows.filter(r => r.adGroup?.campaign?.marketplace === mk).map(r => r.adGroup!.campaign!.externalCampaignId!).filter(Boolean))]
  const live = await listNegativeKeywords({ profileId: conn.profileId, region: 'EU' } as never, { campaignIds: campIds })
  console.log(`\n${mk}: Amazon returned ${live.length} negative keyword(s) across ${campIds.length} campaign(s)`)
  const mine = live.filter(k => (k.keywordText ?? '').toLowerCase() === 'protezioni')
  console.log(`  of those, keywordText === "protezioni": ${mine.length}`)
  for (const k of mine) console.log(`    adGroup ${k.adGroupId} · ${k.matchType} · ${k.state} · id ${k.keywordId ?? k.negativeKeywordId}`)
  for (const r of rows.filter(r => r.adGroup?.campaign?.marketplace === mk)) {
    const hit = mine.find(k => k.adGroupId === r.adGroup?.externalAdGroupId)
    console.log(`  ${r.adGroup?.campaign?.name} › ${r.adGroup?.name}: ${hit ? `✓ EXISTS at Amazon (id ${hit.keywordId ?? hit.negativeKeywordId})` : '🔴 NOT at Amazon'}`)
  }
}
await prisma.$disconnect()
