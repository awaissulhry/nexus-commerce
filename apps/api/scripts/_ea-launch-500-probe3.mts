// READ-ONLY: get the ACTUAL eBay error behind entity-sync "errors=11 ads=0"
// and behind the launch 500. GETs only — no campaign/ad is created or changed.
const api = await import('../src/services/marketing/ebay-ads-api.service.js')
const prisma = (await import('../src/db.js')).default

const auth = await api.getActiveEbayAdsAuth()
if (!auth) { console.log('no active eBay connection'); process.exit(1) }

const camps = await prisma.ebayCampaign.findMany({
  select: { externalCampaignId: true, name: true, status: true, fundingModel: true },
  orderBy: { createdAt: 'desc' },
})

console.log('\n── per-campaign sub-entity reads (this is what entity-sync does) ──\n')
for (const c of camps.slice(0, 6)) {
  const id = c.externalCampaignId
  console.log(`\n▸ ${id}  ${c.status}  ${c.fundingModel}  "${c.name}"`)
  for (const [label, fn] of [
    ['fetchAds', () => api.fetchAds(auth.token, id)],
    ['fetchAdGroups', () => api.fetchAdGroups(auth.token, id)],
  ] as const) {
    try {
      const rows = await fn()
      console.log(`   ✓ ${label}: ${rows.length}`)
    } catch (e) {
      console.log(`   ⛔ ${label}: ${(e as Error).message.slice(0, 260)}`)
    }
  }
}

await prisma.$disconnect()
console.log('\n── done (no writes performed) ──')
