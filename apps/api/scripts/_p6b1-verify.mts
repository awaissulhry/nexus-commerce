/** ADM-P6/B1+B2 — exercise the REAL ingest route with a budget-usage record and prove it lands.
 *  Writes ONE row and deletes it again; the row is stamped in 2020 so that even in the seconds it
 *  exists it cannot fall inside any current budget day or alter a rendered column. */
import '../src/env.js'
import Fastify from 'fastify'
const { default: prisma } = await import('../src/db.js')
const app = Fastify({ logger: false })
const { default: advertisingRoutes } = await import('../src/routes/advertising.routes.js')
await app.register(advertisingRoutes, { prefix: '/api' })

const camp = await prisma.campaign.findFirst({ where: { externalCampaignId: { not: null }, adProduct: 'SPONSORED_PRODUCTS' }, select: { id: true, name: true, externalCampaignId: true } })
if (!camp) { console.log('no campaign'); process.exit(1) }
const STAMP = '2020-01-01T00:00:00.000Z'
const post = (body: unknown) => app.inject({ method: 'POST', url: '/api/advertising/marketing-stream/ingest', payload: body as object })

console.log('=== 1 · a BUDGET record now reaches its consumer (it used to be dropped here) ===')
let r = await post({ messages: [{ dataset_id: 'budget-usage', campaignId: camp.externalCampaignId, budgetUsagePercent: 100, usageUpdatedTimestamp: STAMP, budget: 1.74 }] })
console.log('   status', r.statusCode, r.body.slice(0, 300))

const row = await prisma.adBudgetUsageSample.findFirst({ where: { campaignId: camp.id, source: 'stream', usageUpdatedAt: new Date(STAMP) } })
console.log(`   row written: ${row ? 'YES' : 'NO'}${row ? `  percent=${row.percent} budgetCents=${row.budgetCents} profileId=${row.profileId}` : ''}`)

console.log('\n=== 2 · a redelivery refreshes the span, it does not duplicate the reading ===')
const before = row?.lastSeenAt
await post({ messages: [{ dataset_id: 'budget-usage', campaignId: camp.externalCampaignId, budgetUsagePercent: 100, usageUpdatedTimestamp: STAMP, budget: 1.74 }] })
const again = await prisma.adBudgetUsageSample.findMany({ where: { campaignId: camp.id, source: 'stream', usageUpdatedAt: new Date(STAMP) } })
console.log(`   rows for that reading: ${again.length} (want 1) · lastSeenAt moved: ${before && again[0] ? (again[0].lastSeenAt > before) : '?'}`)

console.log('\n=== 3 · a reading with no timestamp is REFUSED, not stamped with our clock ===')
r = await post({ messages: [{ dataset_id: 'budget-usage', campaignId: camp.externalCampaignId, budgetUsagePercent: 95 }] })
console.log('   ', JSON.parse(r.body).budget)

console.log('\n=== 4 · a CHANGE record reaches its consumer too (also dropped before) ===')
r = await post({ messages: [{ dataset_id: 'campaigns', campaignId: camp.externalCampaignId, state: 'ENABLED' }] })
console.log('   routed:', JSON.stringify(JSON.parse(r.body).routed), '· change:', JSON.stringify(JSON.parse(r.body).change))

console.log('\n=== 5 · performance records still behave exactly as before ===')
r = await post({ messages: [{ dataset_id: 'sp-traffic', campaign_id: camp.externalCampaignId, time_window_start: STAMP, impressions: 0, clicks: 0, cost: 0 }] })
const j5 = JSON.parse(r.body)
console.log(`   status ${r.statusCode} · top-level keys preserved: received=${j5.received} upserted=${j5.upserted} skipped=${j5.skipped}`)

console.log('\n=== 6 · an unrecognised dataset is counted, not silently eaten ===')
r = await post({ messages: [{ dataset_id: 'not-a-dataset', foo: 1 }] })
console.log('   routed:', JSON.stringify(JSON.parse(r.body).routed))

console.log('\n=== cleanup ===')
const del = await prisma.adBudgetUsageSample.deleteMany({ where: { source: 'stream', usageUpdatedAt: new Date(STAMP) } })
const perf = await prisma.amazonAdsHourlyPerformance.deleteMany({ where: { date: new Date('2020-01-01T00:00:00.000Z'), entityId: camp.externalCampaignId! } })
console.log(`   deleted ${del.count} sample row(s), ${perf.count} synthetic hourly row(s)`)
console.log(`   stream rows remaining in table: ${await prisma.adBudgetUsageSample.count({ where: { source: 'stream' } })} (want 0)`)
await app.close(); await prisma.$disconnect(); process.exit(0)
