// Dry-run probe for POST /ebay/flat-file/apply-variation-order — READ-ONLY:
// live GetItem per listing + reorder plan; no revise, no DB writes.
const { default: prisma } = await import('../src/db.js')
const { default: Fastify } = await import('fastify')
const { default: routes } = await import('../src/routes/ebay-flat-file.routes.js')

const candidates = await prisma.product.findMany({
  where: { sku: { contains: 'GALE' }, parentId: null, deletedAt: null },
  select: { id: true, sku: true, _count: { select: { children: true } } },
})
for (const c of candidates) console.log(`candidate: ${c.sku} children=${c._count.children}`)
const parent = candidates.sort((a, b) => b._count.children - a._count.children)[0]
if (!parent || parent._count.children === 0) { console.log('no real GALE family parent'); process.exit(1) }
console.log(`→ using: ${parent.sku} (${parent.id})`)

const app = Fastify({ logger: false })
await app.register(routes)
await app.ready()
const r = await app.inject({
  method: 'POST',
  url: '/ebay/flat-file/apply-variation-order',
  payload: { parentProductId: parent.id, marketplace: 'IT', dryRun: true },
})
console.log(`HTTP ${r.statusCode}`)
const body = r.json() as {
  storedAxes?: string[]
  hasStoredValueOrder?: boolean
  listings?: Array<{ itemId: string; title?: string; status: string; message?: string;
    axisOrder?: { from: string[]; to: string[] }
    valueChanges?: Array<{ axis: string; from: string[]; to: string[] }> }>
  error?: string
}
if (body.error) { console.log('ERROR:', body.error); process.exit(1) }
console.log(`storedAxes: ${JSON.stringify(body.storedAxes)}  hasStoredValueOrder: ${body.hasStoredValueOrder}`)
for (const l of body.listings ?? []) {
  console.log(`\n─ ${l.itemId}  [${l.status}]  ${l.title ?? ''}`)
  if (l.axisOrder && l.axisOrder.from.join('|') !== l.axisOrder.to.join('|'))
    console.log(`  axes: ${l.axisOrder.from.join(' · ')}  →  ${l.axisOrder.to.join(' · ')}`)
  for (const c of l.valueChanges ?? [])
    console.log(`  ${c.axis}: ${c.from.join(',')}  →  ${c.to.join(',')}`)
  if (l.message) console.log(`  msg: ${l.message}`)
}
process.exit(0)
