// E2 scratch runner: node --import tsx apps/api/scripts/_e2-run.mts <step>
// Steps: entities | discovery | schedule | poll | economics | resolver <productId>
const step = process.argv[2] ?? 'entities'

async function main() {
  if (step === 'entities') {
    const m = await import('../src/services/marketing/ebay-ads-entity-sync.service.js')
    console.log(JSON.stringify(await m.syncEbayAdsEntities(), null, 1))
  } else if (step === 'discovery') {
    const m = await import('../src/services/marketing/ebay-listing-index.service.js')
    console.log(JSON.stringify(await m.discoverEbayListings(), null, 1))
  } else if (step === 'schedule') {
    const m = await import('../src/services/marketing/ebay-ads-reports.service.js')
    console.log(JSON.stringify(await m.scheduleEbayReportTasks(), null, 1))
  } else if (step === 'poll') {
    const m = await import('../src/services/marketing/ebay-ads-reports.service.js')
    console.log(JSON.stringify(await m.pollAndIngestEbayReports(), null, 1))
  } else if (step === 'economics') {
    const m = await import('../src/services/ads-core/ebay-margin.js')
    console.log(JSON.stringify(await m.rebuildEbayListingEconomics(), null, 1))
  } else if (step === 'resolver') {
    const m = await import('../src/services/marketing/ebay-listing-index.service.js')
    console.log(JSON.stringify(await m.getLiveEbayItemIds(process.argv[3]!), null, 1))
  }
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
