const { default: prisma } = await import('../src/db.js')
const { default: Fastify } = await import('fastify')
const { default: routes } = await import('../src/routes/ebay-flat-file.routes.js')
const app = Fastify({ logger: false })
await app.register(routes)
await app.ready()
for (const mp of ['IT','DE']) {
  const r = await app.inject({ method: 'GET', url: `/ebay/flat-file/rows?scope=listed&marketplace=${mp}` })
  const rows = (r.json() as any).rows ?? []
  const cats = [...new Set(rows.map((x:any)=>String(x.category_id ?? '').trim()).filter(Boolean))]
  // union of schema ids for those cats
  const union = new Set<string>()
  for (const c of cats) {
    const s = await prisma.categorySchema.findFirst({ where: { channel:'EBAY', marketplace: `EBAY_${mp}`, productType: c, isActive: true }, orderBy: { fetchedAt: 'desc' } })
    if (!s) { console.log(`  !! no stored schema for ${mp}/${c}`); continue }
    for (const a of ((s.schemaDefinition as any)?.aspects ?? [])) union.add(String(a.id).toLowerCase())
  }
  // aspect key signature (non-empty only)
  const byLower = new Map<string,string>()
  for (const row of rows) for (const [k,v] of Object.entries(row as Record<string,unknown>)) {
    if (!k.startsWith('aspect_') || k==='aspect_') continue
    if (v===null||v===undefined||v==='') continue
    byLower.set(k.toLowerCase(), k)
  }
  const ghosts = [...byLower.entries()].filter(([lo])=>!union.has(lo)).map(([,k])=>k).sort()
  console.log(`\n### ${mp}: rows=${rows.length} cats=${cats.join(',')} schemaIds=${union.size} aspectKeys=${byLower.size}`)
  console.log(`GHOST COLUMNS the operator sees (${ghosts.length}):`)
  for (const g of ghosts) console.log('   ⚠ ' + g.slice('aspect_'.length).replace(/_/g,' '))
  console.log('non-ghost (real schema) keys present:', [...byLower.values()].filter(k=>union.has(k.toLowerCase())).sort().join(', '))
}
await app.close(); process.exit(0)
