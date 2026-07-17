/**
 * EV2 smoke — manual discovery sweep backfills imageUrl; /builder/listings
 * and /products serve it (with catalog fallback where the sweep has no
 * gallery image). Read-only apart from the sweep's own upserts.
 */
import Fastify from 'fastify'
const routes = (await import('/Users/awais/nexus-commerce/apps/api/src/routes/ebay-ads.routes.js')).default
const prisma = (await import('/Users/awais/nexus-commerce/apps/api/src/db.js')).default
const { discoverEbayListings } = await import('/Users/awais/nexus-commerce/apps/api/src/services/marketing/ebay-listing-index.service.js')
const app = Fastify()
await app.register(routes, { prefix: '/api' })
let fails = 0
const check = (l: string, ok: boolean, d = '') => { console.log(`${ok ? '✓' : '✗ FAIL'} ${l}${d ? ` — ${d}` : ''}`); if (!ok) fails++ }

const report = await discoverEbayListings()
console.log('sweep:', JSON.stringify({ fetchedActive: report.fetchedActive, upserted: report.upserted, detailFetched: report.detailFetched, errors: report.errors.slice(0, 2) }))

const total = await prisma.ebayListingIndex.count({ where: { endedAt: null } })
const withImg = await prisma.ebayListingIndex.count({ where: { endedAt: null, imageUrl: { not: null } } })
check('sweep backfilled gallery images', withImg > 0, `${withImg}/${total} live listings have imageUrl`)
const sample = await prisma.ebayListingIndex.findFirst({ where: { imageUrl: { not: null } }, select: { itemId: true, imageUrl: true } })
check('image URLs are ebayimg CDN links', !!sample && /^https:\/\/i\.ebayimg\.com\//.test(sample.imageUrl!), sample?.imageUrl?.slice(0, 60))

const bl = (await app.inject({ method: 'POST', url: '/api/ebay-ads/builder/listings', payload: { marketplace: 'EBAY_IT', strategy: 'CPS' } })).json() as { listings: Array<{ itemId: string; imageUrl: string | null; productId: string | null; productName: string | null }> }
check('/builder/listings serves imageUrl', bl.listings.length > 0 && bl.listings.some((l) => l.imageUrl), `${bl.listings.filter((l) => l.imageUrl).length}/${bl.listings.length} with images`)
check('/builder/listings serves grouping fields', bl.listings.some((l) => l.productId && l.productName))

const pr = (await app.inject({ method: 'GET', url: '/api/ebay-ads/products?preset=last30' })).json() as { products: Array<{ listings: Array<{ imageUrl?: string | null }> }>; unmatchedListings: Array<{ imageUrl?: string | null }> }
const allRows = [...pr.products.flatMap((p) => p.listings), ...pr.unmatchedListings]
check('/products serves imageUrl', allRows.some((l) => l.imageUrl), `${allRows.filter((l) => l.imageUrl).length}/${allRows.length} with images`)

console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
