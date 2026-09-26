/** Owner decision: pool SKUs on all listings. Live ReviseFixedPriceItem ×4 + verify. */
process.env.NEXUS_EBAY_REAL_API = 'true'
const { default: Fastify } = await import('fastify')
const { default: routes } = await import('../src/routes/ebay-flat-file.routes.js')
const app = Fastify({ logger: false })
await app.register(routes)
await app.ready()
for (const itemId of ['913270132587', '949285812839', '910932382515', '950640873955']) {
  const r = await app.inject({ method: 'POST', url: '/ebay/flat-file/relabel-item', payload: { itemId, marketplace: 'IT' } })
  const d = r.json() as any
  console.log(d.error
    ? `${itemId}: ERROR ${String(d.error).slice(0, 220)}`
    : `${itemId}: planned=${d.planned} relabeled=${d.membershipsRewritten} alreadyPool=${d.alreadyPool} ack=${d.ebayAck}${d.unmapped?.length ? ` unmapped=[${d.unmapped.join(',')}]` : ''}`)
}
console.log('--- read-back verification ---')
for (const itemId of ['938554736087', '913270132587', '949285812839', '910932382515', '950640873955']) {
  const v = await app.inject({ method: 'GET', url: `/ebay/flat-file/verify-item?itemId=${itemId}&marketplace=IT` })
  const d = v.json() as any
  console.log(`${itemId}: ${d.status} variants=${d.ebayVariantCount} matched=${d.matched}/${d.memberships} missing=${(d.missingOnEbay ?? []).length} extra=${(d.extraOnEbay ?? []).slice(0, 2).join(',') || 'none'}`)
}
await app.close(); process.exit(0)
