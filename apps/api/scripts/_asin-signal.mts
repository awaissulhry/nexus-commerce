/** READ-ONLY: do naming-inconsistent "same" products share Amazon ASINs?
 *  A shared externalListingId (ASIN) = same catalog entry = robust group signal. */
const { default: prisma } = await import('../src/db.js')
async function asins(sku: string): Promise<Set<string>> {
  const p = await prisma.product.findFirst({ where: { sku }, select: { id: true } })
  if (!p) return new Set()
  const ids = [p.id, ...(await prisma.product.findMany({ where: { parentId: p.id }, select: { id: true } })).map(v=>v.id)]
  const cls = await prisma.channelListing.findMany({ where: { productId: { in: ids }, channel: 'AMAZON' }, select: { externalListingId: true } })
  return new Set(cls.map(c=>c.externalListingId).filter((x): x is string => !!x))
}
async function overlap(a: string, b: string) {
  const [sa, sb] = [await asins(a), await asins(b)]
  const shared = [...sa].filter(x=>sb.has(x))
  console.log(`${a} (${sa.size} ASINs) ∩ ${b} (${sb.size}) = ${shared.length} shared ${shared.length?'→ SAME catalog':'→ distinct catalog'}`)
}
await overlap('AIR-MESH-JACKET-MEN','AIRMESH-JACKET')
await overlap('WATERPROOF-OVERJACKET-BLACK-MEN','1-OVERJACKET-BLACK-MEN')
// and a KNOWN duplicate cluster for contrast — GALE main vs its ALT (ALT has no variants/ASINs)
await overlap('GALE-JACKET','GALE-JACKET-FBM')
await prisma.$disconnect()
