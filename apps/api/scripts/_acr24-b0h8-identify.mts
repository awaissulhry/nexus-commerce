/** ACR.2.4c — identify the B0H8* ASINs (read-only). One searchCatalogItems call per ASIN —
 *  the multi-identifier form never reaches Amazon intact through this lib version. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { AmazonService, AMAZON_MARKETPLACE_CODE_TO_ID } = await import('../src/services/marketplaces/amazon.service.js')

const rows = await prisma.$queryRawUnsafe<{ asin: string }[]>(`
  SELECT DISTINCT pa.asin FROM "AdProductAd" pa
  JOIN "AdGroup" g ON g.id = pa."adGroupId" JOIN "Campaign" c ON c.id = g."campaignId"
  WHERE UPPER(c.name) LIKE '%AIREON%' AND pa.asin LIKE 'B0H8%'`)
const asins = rows.map((r) => r.asin)

const svc = new AmazonService()
const sp = await (svc as unknown as { getClient: () => Promise<unknown> }).getClient()
let returned = 0
for (const asin of asins) {
  try {
    const res = await (sp as { callAPI: (a: unknown, o?: unknown) => Promise<unknown> }).callAPI({
      operation: 'searchCatalogItems',
      endpoint: 'catalogItems',
      version: '2022-04-01',
      query: {
        marketplaceIds: [AMAZON_MARKETPLACE_CODE_TO_ID.IT],
        identifiers: [asin],
        identifiersType: 'ASIN',
        includedData: ['summaries'],
      },
      // The lib's callAPI takes ONE argument; version selection lives at
      // req_params.options.version — a top-level `version` key is ignored
      // and the endpoint's OLDEST version (2020-12-01, keywords-only) is used.
      options: { version: '2022-04-01' },
    }) as { items?: Array<{ asin?: string; summaries?: Array<{ itemName?: string; brand?: string; colorName?: string; sizeName?: string }> }> }
    const item = res.items?.[0]
    if (!item) { console.log(`${asin} · NOT FOUND on IT`) ; continue }
    const s = item.summaries?.[0]
    console.log(`${asin} · ${s?.brand ?? '—'} · ${s?.colorName ?? '—'} / ${s?.sizeName ?? '—'} · ${s?.itemName?.slice(0, 80) ?? '—'}`)
    returned += 1
  } catch (e) { console.log(`${asin} · ERROR ${(e as Error).message.slice(0, 60)}`) }
}
console.log(`\nfound ${returned} of ${asins.length}`)
await prisma.$disconnect()
process.exit(0)
