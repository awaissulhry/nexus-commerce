/** READ-ONLY: what GET /rows actually returns for the AIRMESH family now. */
const { default: prisma } = await import('../src/db.js')
const { default: Fastify } = await import('fastify')
const { default: routes } = await import('../src/routes/ebay-flat-file.routes.js')
const app = Fastify({ logger: false })
await app.register(routes)
await app.ready()

const parent = await prisma.product.findFirst({ where: { sku: 'AIRMESH-JACKET', deletedAt: null }, select: { id: true } })
const r = await app.inject({ method: 'GET', url: `/ebay/flat-file/rows?familyId=${parent!.id}&marketplace=IT` })
console.log('HTTP', r.statusCode)
const rows = (r.json() as { rows?: Array<Record<string, unknown>> }).rows ?? []
console.log('rows:', rows.length)
const alt1 = rows.filter((x) => String(x.parent_sku) === 'AIRMESH-JACKET-ALT1' || String(x.sku) === 'AIRMESH-JACKET-ALT1')
console.log('ALT1 rows:', alt1.length)
for (const row of alt1.slice(0, 4)) {
  console.log(JSON.stringify({
    rowId: row._rowId, sku: row.sku, shared: row._shared,
    title: String(row.title ?? '').slice(0, 40),
    price: row.it_price, itemId: row.it_item_id,
    taglia: row.aspect_taglia, colore: row.aspect_colore,
    condition: row.condition,
  }))
}
const primo = rows.find((x) => String(x.sku) === 'AIRMESH-JACKET-BLACK-MEN-M' && x._shared !== true)
console.log('primary child sample:', JSON.stringify({ title: String(primo?.title ?? '').slice(0, 40), price: primo?.it_price, taglia: primo?.aspect_taglia }))
await prisma.$disconnect()
