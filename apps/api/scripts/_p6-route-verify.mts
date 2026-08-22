/** READ-ONLY. Register the REAL advertising routes plugin and call the REAL campaigns handler
 *  against prod data, so the P6 fields are proven by the route, not by the service beneath it. */
import '../src/env.js'
import Fastify from 'fastify'
await import('../src/db.js')
const app = Fastify({ logger: false })
const { default: advertisingRoutes } = await import('../src/routes/advertising.routes.js')
await app.register(advertisingRoutes, { prefix: '/api' })
const res = await app.inject({ method: 'GET', url: '/api/advertising/campaigns?preset=last7&limit=250' })
console.log('status', res.statusCode)
if (res.statusCode !== 200) { console.log(res.body.slice(0, 600)); process.exit(1) }
const j = JSON.parse(res.body) as { items: Array<Record<string, unknown>>; count: number }
const items = j.items
console.log('items', items.length)
const newKeys = Object.keys(items[0] ?? {}).filter(k => /curBudgetUtil|Hours|usageSince/.test(k))
console.log('P6 keys on the wire:', newKeys.join(', ') || '(NONE — the route did not add them)')
const census: Record<string, number> = {}
for (const it of items) { const s = String(it.curBudgetUtilState ?? 'MISSING'); census[s] = (census[s] ?? 0) + 1 }
console.log('state census:', JSON.stringify(census))
console.log('usageSince   :', items[0]?.usageSince)
console.log('\ntop readings on the wire:')
for (const it of items.filter(i => typeof i.curBudgetUtil === 'number' && (i.curBudgetUtil as number) > 0)
  .sort((a, b) => (b.curBudgetUtil as number) - (a.curBudgetUtil as number)).slice(0, 10)) {
  console.log(`   ${String(it.name).slice(0, 30).padEnd(32)} ${((it.curBudgetUtil as number) * 100).toFixed(1).padStart(6)}%  of EUR${it.curBudgetUtilBudget}  asOf=${it.curBudgetUtilAsOf}  obs=${it.hoursObserved}h oob=${it.oobHours} act=${it.actBidHours}`)
}
console.log('\na campaign the SP endpoint does not cover:')
const uns = items.find(i => i.curBudgetUtilState === 'unsupported')
console.log('  ', uns ? `${String(uns.name).slice(0,30)} adProduct=${uns.adProduct} curBudgetUtil=${uns.curBudgetUtil} oobHours=${uns.oobHours} actBidHours=${uns.actBidHours}` : '(none)')
await app.close()
process.exit(0)
