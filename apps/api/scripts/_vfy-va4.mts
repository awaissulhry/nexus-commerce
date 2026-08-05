const { default: prisma } = await import('../src/db.js')
const ps = await prisma.product.findMany({ where: { sku: { in: ['GALE-JACKET-BLACK-MEN-XXS','GALE-JACKET-YELLOW-MEN-XXS'] } }, select: { sku:true, categoryAttributes:true, variantAttributes:true, deletedAt:true } })
for (const p of ps) {
  console.log(`\n=== ${p.sku} deleted=${!!p.deletedAt}`)
  console.log('  variantAttributes:', JSON.stringify(p.variantAttributes))
  const ca = p.categoryAttributes as any
  console.log('  categoryAttributes.variations:', JSON.stringify(ca?.variations))
  const v = ca?.variations ?? {}
  for (const [k,val] of Object.entries(v)) console.log(`    key=${JSON.stringify(k)} typeof=${typeof val} val=${JSON.stringify(val)}`)
}
await prisma.$disconnect()
