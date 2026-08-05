const { default: Fastify } = await import('fastify')
const { default: routes } = await import('../src/routes/ebay-flat-file.routes.js')
const app = Fastify({ logger: false })
await app.register(routes)
await app.ready()
// 1. GALE family file (the owner's exact link)
for (const [label, fid] of [
  ['GALE family file', 'cmokmy3a40078pm0p1fvnu523'],
  ['ALT1 family file (symmetric entry)', 'cmrp2jg640009pa01kq6iitx4'],
  ['AIRMESH family (no memberships — must be unchanged)', ''],
] as const) {
  if (label.startsWith('AIRMESH')) {
    const all = await app.inject({ method: 'GET', url: '/ebay/flat-file/rows?scope=listed&marketplace=IT' })
    const rowsAll = (all.json() as any).rows ?? []
    const am = rowsAll.find((r: any) => r.sku === 'AIR-MESH-JACKET-MEN')
    if (!am) { console.log('AIRMESH parent not found — skip'); continue }
    const r2 = await app.inject({ method: 'GET', url: `/ebay/flat-file/rows?familyId=${am._productId}&marketplace=IT` })
    const rows2 = (r2.json() as any).rows ?? []
    const parents2 = rows2.filter((x: any) => x._isParent === true).map((x: any) => x.sku)
    console.log(`${label}: rows=${rows2.length} parents=[${parents2.join(', ')}]`)
    continue
  }
  const r = await app.inject({ method: 'GET', url: `/ebay/flat-file/rows?familyId=${fid}&marketplace=IT` })
  const rows = (r.json() as any).rows ?? []
  const parents = rows.filter((x: any) => x._isParent === true).map((x: any) => x.sku)
  const shared = rows.filter((x: any) => x._shared === true).length
  console.log(`${label}: rows=${rows.length} parents=[${parents.join(', ')}] sharedChildren=${shared}`)
}
await app.close(); process.exit(0)
