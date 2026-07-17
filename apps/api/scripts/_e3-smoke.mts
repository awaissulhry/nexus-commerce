import Fastify from 'fastify'
const routes = (await import('/Users/awais/nexus-commerce/apps/api/src/routes/ebay-ads.routes.js')).default
const app = Fastify()
await app.register(routes, { prefix: '/api' })
for (const url of [
  '/api/ebay-ads/summary?preset=last30',
  '/api/ebay-ads/trend?preset=last30',
  '/api/ebay-ads/campaigns?preset=last30',
  '/api/ebay-ads/products?preset=last30',
  '/api/ebay-ads/status',
]) {
  const r = await app.inject({ method: 'GET', url })
  const j = r.json()
  const brief =
    url.includes('summary') ? `fees=${j.current?.adFeesCents} sales=${j.current?.salesCents} acos=${j.current?.acosPct?.toFixed?.(1)} deltas.fees=${j.deltas?.adFeesPct?.toFixed?.(1)} eco=${JSON.stringify(j.economicsStatus)}` :
    url.includes('trend') ? `points=${j.points?.length} bucket=${j.window?.bucket} last=${JSON.stringify(j.points?.[j.points.length-1])}` :
    url.includes('campaigns') ? `campaigns=${j.campaigns?.length} first="${j.campaigns?.[0]?.name}" ads=${JSON.stringify(j.campaigns?.[0]?.ads)} metrics.fees=${j.campaigns?.[0]?.metrics?.adFeesCents}` :
    url.includes('products') ? `products=${j.products?.length} unmatched=${j.unmatchedListings?.length} firstProd=${j.products?.[0]?.sku} listings=${j.products?.[0]?.listings?.length}` :
    `counts=${JSON.stringify(j.counts)}`
  console.log(r.statusCode, url, '→', brief)
}
// detail: use first campaign id
const list = (await app.inject({ method: 'GET', url: '/api/ebay-ads/campaigns' })).json()
const cps = list.campaigns.find((c: any) => c.fundingModel === 'COST_PER_SALE')
const cpc = list.campaigns.find((c: any) => c.fundingModel === 'COST_PER_CLICK' && c.targetingType === 'MANUAL')
for (const c of [cps, cpc]) {
  if (!c) continue
  const r = await app.inject({ method: 'GET', url: `/api/ebay-ads/campaigns/${c.id}?preset=last30` })
  const j = r.json()
  console.log(r.statusCode, `detail[${c.fundingModel}] "${j.campaign?.name}" ads=${j.ads?.length} adGroups=${j.adGroups?.length} keywords=${j.keywords?.length} negatives=${j.negativeKeywords?.length} firstAd=${JSON.stringify({ rate: j.ads?.[0]?.bidPercentage, be: j.ads?.[0]?.breakEvenAdRatePct, ecoSt: j.ads?.[0]?.economicsStatus, title: (j.ads?.[0]?.title ?? '').slice(0, 25), fees: j.ads?.[0]?.metrics?.adFeesCents })}`)
}
process.exit(0)
