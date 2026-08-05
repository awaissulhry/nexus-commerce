// READ-ONLY: what is eBay's actual state, and are the ads crons erroring?
// No writes. The only outbound calls are GETs through the metered client.
const prisma = (await import('../src/db.js')).default

console.log('── recent ads CronRun outcomes ─────────────────────────────────\n')
const runs = await prisma.cronRun.findMany({
  where: { jobName: { contains: 'ebay-ads' } },
  orderBy: { startedAt: 'desc' },
  take: 14,
  select: { jobName: true, startedAt: true, status: true, errorMessage: true, outputSummary: true },
})
for (const r of runs) {
  console.log(`${r.startedAt.toISOString()}  ${r.jobName.padEnd(28)} ${String(r.status).padEnd(8)} ${(r.errorMessage ?? JSON.stringify(r.outputSummary ?? '') ?? '').slice(0, 130)}`)
}
if (!runs.length) console.log('(no ebay-ads CronRun rows)')

const quotaErrs = runs.filter((r) => /quota/i.test(`${r.errorMessage ?? ''}${JSON.stringify(r.outputSummary ?? '')}`))
console.log(quotaErrs.length ? `\n⚠️  ${quotaErrs.length} run(s) mention quota` : '\n✓ no quota errors in recent runs')

console.log('\n── EbayCampaign rows (name collisions matter: eBay rejects dupes) ──\n')
const camps = await prisma.ebayCampaign.findMany({
  orderBy: { createdAt: 'desc' },
  select: { name: true, status: true, marketplace: true, externalCampaignId: true, fundingModel: true, createdAt: true },
})
for (const c of camps) {
  console.log(`${c.createdAt.toISOString().slice(0, 10)}  ${String(c.status).padEnd(10)} ${String(c.fundingModel ?? '').padEnd(14)} ${c.externalCampaignId.padEnd(22)} ${c.name}`)
}

console.log('\n── live eBay campaigns (read-only GET via the metered client) ──\n')
try {
  const api = await import('../src/services/marketing/ebay-ads-api.service.js')
  const auth = await api.getActiveEbayAdsAuth()
  if (!auth) { console.log('no active eBay connection'); }
  else {
    const live = await api.fetchCampaigns(auth.token)
    console.log(`eBay returned ${live.length} campaigns:`)
    for (const c of live) {
      console.log(`  ${String(c.campaignStatus ?? '?').padEnd(10)} ${String(c.campaignId).padEnd(20)} ${c.campaignName ?? ''}`)
    }
  }
} catch (e) {
  console.log(`⛔ live fetch FAILED: ${(e as Error).message}`)
  console.log('   (this is the same client the launch path uses — a failure here explains the 500)')
}

await prisma.$disconnect()
console.log('\n── done (no writes performed) ──')
