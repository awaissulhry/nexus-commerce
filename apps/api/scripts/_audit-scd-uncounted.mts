/** READ-ONLY: do UNCOUNTED rows coexist with a NON-ZERO warehouse pool?
 *  (checks the MODE_HELP.UNCOUNTED copy "No stock pool yet for this product"). */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const skus = ['AIR-MESH-JACKET-MEN', 'REGAL-JACKET', 'UD-LVLM-1H8T', '1J-EYE5-Y0TW']
for (const sku of skus) {
  const p = await prisma.product.findFirst({ where: { sku }, select: { id: true, sku: true } })
  if (!p) { console.log(sku, 'NOT FOUND'); continue }
  const kids = await prisma.product.findMany({ where: { parentId: p.id }, select: { id: true, sku: true } })
  const ids = [p.id, ...kids.map((k) => k.id)]
  const levels = await prisma.stockLevel.findMany({
    where: { productId: { in: ids } },
    select: { available: true, quantity: true, location: { select: { code: true, type: true, syncRoutes: true } } },
  })
  const wh = levels.filter((l) => l.location?.type === 'WAREHOUSE')
  console.log(`${sku}: variants=${kids.length} warehouseAvailable=${wh.reduce((s, l) => s + l.available, 0)} totalAvailable=${levels.reduce((s, l) => s + l.available, 0)}`)
  const byLoc = new Map<string, { avail: number; routes: string[] }>()
  for (const l of levels) {
    const k = `${l.location?.code}(${l.location?.type})`
    const e = byLoc.get(k) ?? { avail: 0, routes: l.location?.syncRoutes ?? [] }
    e.avail += l.available; byLoc.set(k, e)
  }
  for (const [k, v] of byLoc) console.log(`   ${k} avail=${v.avail} routes=[${v.routes.join(',')}]`)
}
await prisma.$disconnect()
