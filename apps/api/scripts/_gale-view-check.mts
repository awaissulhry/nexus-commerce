const { default: Fastify } = await import('fastify')
const { default: routes } = await import('../src/routes/ebay-flat-file.routes.js')
const app = Fastify({ logger: false })
await app.register(routes)
await app.ready()
const r = await app.inject({ method: 'GET', url: '/ebay/flat-file/rows?scope=listed&marketplace=IT' })
const rows = (r.json() as any).rows ?? []
const gale = rows.filter((x: any) => String(x.sku ?? '').includes('GALE') || String(x.parent_sku ?? '').includes('GALE'))
const parents = gale.filter((x: any) => x._isParent === true)
console.log(`GALE rows in response: ${gale.length}; parents: ${parents.map((p: any) => p.sku).join(', ')}`)
const byParent = new Map<string, number>()
for (const g of gale) { const k = String(g.parent_sku || g.sku); if (g._isParent !== true) byParent.set(k, (byParent.get(k) ?? 0) + 1) }
console.log('children per family:', JSON.stringify([...byParent]))
await app.close(); process.exit(0)
