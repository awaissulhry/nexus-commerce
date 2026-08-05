/** READ-ONLY baseline: what resolveFamilyAxes returns TODAY (pre-Phase-1) for the
 * key families. Captures the "before" so the Phase-1 whitelist change is provable,
 * and confirms GALE (the only Inventory-managed push) resolves to Size/Color. */
const { default: prisma } = await import('../src/db.js')
const { resolveFamilyAxes } = await import('../src/services/ebay-family-axes.service.js')

const SKUS = ['VENTRA-JACKET', 'AIREON', 'GALE-JACKET', 'IT-GALE-JACKET', 'AIRMESH-JACKET', 'IT-MOSS-JACKET', 'xavia-knee-slider']
for (const sku of SKUS) {
  const p = await prisma.product.findFirst({ where: { sku, deletedAt: null }, select: { id: true, variationTheme: true } })
  if (!p) { console.log(`\n${sku}: NOT FOUND`); continue }
  try {
    const r = await resolveFamilyAxes(p.id, 'IT')
    console.log(`\n${sku}  theme=${JSON.stringify(p.variationTheme)}`)
    console.log(`   AXES: ${JSON.stringify(r.axes.map((a: { name: string; values: string[] }) => `${a.name}(${a.values.length})`))}`)
    for (const a of r.axes as Array<{ name: string; values: string[] }>) {
      if (/colo|gener|sesso|adatto|tipo|athlete|team|body/i.test(a.name)) console.log(`      ${a.name}: ${JSON.stringify(a.values)}`)
    }
    console.log(`   warnings=${JSON.stringify(r.warnings)}`)
    console.log(`   suppressed=${JSON.stringify(r.suppressed)}`)
    const cand = (r as { candidates?: unknown }).candidates
    if (cand) console.log(`   candidates=${JSON.stringify(cand)}`)
  } catch (e) {
    console.log(`\n${sku}: ERROR ${(e as Error).message}`)
  }
}
await prisma.$disconnect()
