/** One-time: reconcile the 4 adopted GALE listings against live eBay truth. */
process.env.NEXUS_EBAY_REAL_API = 'true' // GetItem reads only; writes go to OUR DB
const { default: Fastify } = await import('fastify')
const { default: routes } = await import('../src/routes/ebay-flat-file.routes.js')
const app = Fastify({ logger: false })
await app.register(routes)
await app.ready()
for (const itemId of ['256564203510', '256566101420', '256566102729', '256566103703']) {
  const r = await app.inject({
    method: 'POST', url: '/ebay/flat-file/reconcile-item',
    payload: { itemId, marketplace: 'IT' },
  })
  const d = r.json() as any
  if (d.error) console.log(`${itemId}: ERROR ${String(d.error).slice(0, 200)}`)
  else console.log(`${itemId}: live=${d.liveVariations} matched=${d.matched} rewired=${d.rewritten} staleRemoved=${d.removedStale}${d.unmatched?.length ? ` unmatched=[${d.unmatched.join(', ')}]` : ''}`)
}
// Verify end state
const v = await app.inject({ method: 'GET', url: '/ebay/flat-file/verify-item?itemId=256566101420&marketplace=IT' })
const vd = v.json() as any
console.log(`post-check 256566101420: variants=${vd.ebayVariantCount} memberships=${vd.memberships} matched=${vd.matched} unlinked=${(vd.unlinked ?? []).length}`)
await app.close()
process.exit(0)
