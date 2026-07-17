/** READ-ONLY: GetItem on each GALE listing — do live variations carry our SKUs? */
process.env.NEXUS_EBAY_REAL_API = 'true' // enables REAL Trading calls — GetItem only (read)
const { default: Fastify } = await import('fastify')
const { default: routes } = await import('../src/routes/ebay-flat-file.routes.js')
const app = Fastify({ logger: false })
await app.register(routes)
await app.ready()
for (const itemId of ['257584954808', '256564203510', '256566101420', '256566102729', '256566103703']) {
  const r = await app.inject({ method: 'GET', url: `/ebay/flat-file/verify-item?itemId=${itemId}&marketplace=IT` })
  const d = r.json() as any
  if (d.error) console.log(`${itemId}: ERROR ${String(d.error).slice(0, 160)}`)
  else console.log(`${itemId}: ${d.status} — eBay variants=${d.ebayVariantCount} memberships=${d.memberships} matched=${d.matched} missingOnEbay=${(d.missingOnEbay ?? []).length} extraOnEbay=${(d.extraOnEbay ?? []).slice(0,2).join(',')}${(d.extraOnEbay ?? []).length > 2 ? '…' : ''}`)
}
await app.close()
process.exit(0)
