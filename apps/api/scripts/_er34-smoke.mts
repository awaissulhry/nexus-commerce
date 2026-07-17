/**
 * ER3.4 smoke — /products rows carry campaigns[] (cross-checked vs EbayAd);
 * /actions rows carry campaignName + source (cross-checked vs userId/_mode),
 * actionType filter narrows, before-cursor pages. Read-only.
 */
import Fastify from 'fastify'

const routes = (await import('/Users/awais/nexus-commerce/apps/api/src/routes/ebay-ads.routes.js')).default
const prisma = (await import('/Users/awais/nexus-commerce/apps/api/src/db.js')).default
const app = Fastify()
await app.register(routes, { prefix: '/api' })

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ── products: campaigns[] ─────────────────────────────────────────────────────
const pr = await app.inject({ method: 'GET', url: '/api/ebay-ads/products?preset=last30' })
const pj = pr.json() as { products: Array<{ listings: Array<{ itemId: string; campaigns: Array<{ id: string; name: string; fundingModel: string; adHidden: boolean }> }> }>; unmatchedListings: Array<{ itemId: string; campaigns: unknown[] }> }
const allListings = [...pj.products.flatMap((p) => p.listings), ...pj.unmatchedListings] as Array<{ itemId: string; campaigns: Array<{ id: string; adHidden: boolean }> }>
check('products 200, every row carries campaigns[]', pr.statusCode === 200 && allListings.every((l) => Array.isArray(l.campaigns)), `${allListings.length} listings`)
const promotedRows = allListings.filter((l) => l.campaigns.length > 0)
const dbAds = await prisma.ebayAd.findMany({ where: { listingId: { not: null }, status: { notIn: ['STALE'] }, campaign: { status: { in: ['RUNNING', 'PAUSED'] } } }, select: { listingId: true, hiddenReason: true } })
const dbPromoted = new Set(dbAds.map((a) => a.listingId!))
const payloadPromoted = new Set(promotedRows.map((l) => l.itemId))
const missing = [...dbPromoted].filter((id) => !payloadPromoted.has(id) && allListings.some((l) => l.itemId === id))
check('promoted sets match DB (for indexed live listings)', missing.length === 0, `payload=${payloadPromoted.size} db=${dbPromoted.size} missingFromPayload=${missing.length}`)
const perListing = allListings.find((l) => l.campaigns.length > 0)
if (perListing) {
  const dbCount = await prisma.ebayAd.count({ where: { listingId: perListing.itemId, status: { notIn: ['STALE'] }, campaign: { status: { in: ['RUNNING', 'PAUSED'] } } } })
  check('per-listing campaign count matches DB', perListing.campaigns.length === dbCount, `${perListing.itemId}: ${perListing.campaigns.length} vs ${dbCount}`)
} else check('per-listing campaign count matches DB', false, 'no promoted listing found')
const hiddenDb = dbAds.filter((a) => a.hiddenReason != null).length
const hiddenPayload = allListings.reduce((n, l) => n + l.campaigns.filter((c) => c.adHidden).length, 0)
check('adHidden count matches DB', hiddenPayload === hiddenDb, `${hiddenPayload} vs ${hiddenDb}`)

// ── actions: name + source + filter + cursor ─────────────────────────────────
const ar = await app.inject({ method: 'GET', url: '/api/ebay-ads/actions?limit=200' })
const actions = (ar.json() as { actions: Array<{ id: string; actionType: string; userId: string | null; campaignId: string | null; campaignName: string | null; source: string; createdAt: string; entityType: string; payloadAfter: { _mode?: string } | null }> }).actions
check('actions 200 with rows', ar.statusCode === 200 && actions.length > 0, `${actions.length} rows`)
check('every row classified', actions.every((a) => ['automation', 'operator', 'external_accepted'].includes(a.source)))
const misAuto = actions.filter((a) => a.userId === 'automation:ebay-ads' && a.payloadAfter?._mode !== 'accept' && a.source !== 'automation').length
const misAccept = actions.filter((a) => a.payloadAfter?._mode === 'accept' && a.source !== 'external_accepted').length
check('source matches recorded actors', misAuto === 0 && misAccept === 0, `misclassified auto=${misAuto} accept=${misAccept}`)
const campaignRows = actions.filter((a) => a.entityType === 'CAMPAIGN')
const named = campaignRows.filter((a) => a.campaignName != null).length
check('campaign rows resolve names (existing campaigns)', named > 0, `${named}/${campaignRows.length} named (unnamed = deleted/unsynced campaigns)`)
const types = [...new Set(actions.map((a) => a.actionType))]
const ft = await app.inject({ method: 'GET', url: `/api/ebay-ads/actions?actionType=${encodeURIComponent(types[0])}&limit=200` })
const fRows = (ft.json() as { actions: Array<{ actionType: string }> }).actions
check('actionType filter narrows', ft.statusCode === 200 && fRows.length > 0 && fRows.every((a) => a.actionType === types[0]), `${types[0]}: ${fRows.length} rows`)
if (actions.length >= 2) {
  const cur = await app.inject({ method: 'GET', url: `/api/ebay-ads/actions?limit=1&before=${encodeURIComponent(actions[0].createdAt)}` })
  const cRows = (cur.json() as { actions: Array<{ id: string }> }).actions
  check('before-cursor pages', cur.statusCode === 200 && cRows.length === 1 && cRows[0].id !== actions[0].id)
} else check('before-cursor pages', true, 'only one row — vacuous')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
