import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

// Replicate POST /stock/sync-control/actions masterIds expansion for each group
// exactly as the grid sends it: [canonicalMasterId, ...memberMasterIds]
const groups: Record<string, string[]> = {
  'GALE-JACKET': ['GALE-JACKET', 'IT-GALE-JACKET', 'GALE-JACKET-ALT1', 'GALE-JACKET-ALT2', 'GALE-JACKET-ALT3'],
  'AIREON': ['AIREON', 'AIREON-ALT1', 'AIREON-ALT2', 'AIREON-ALT3'],
  'AIRMESH-JACKET': ['AIRMESH-JACKET', 'AIRMESH-JACKET-ALT1'],
  'VENTRA-JACKET': ['VENTRA-JACKET', 'VENTRA-JACKET-ALT1', 'VENTRA-JACKET-ALT2'],
  'xavia-knee-slider': ['xavia-knee-slider', 'xavia-knee-slider-ALT1', 'xavia-knee-slider-ALT2', 'xavia-knee-slider-ALT3', 'xavia-knee-slider-ALT4', 'xavia-knee-slider-ALT5'],
  'AIR-MESH-JACKET-MEN': ['AIR-MESH-JACKET-MEN'],
  'TEST': ['TEST'],
}
console.log('group'.padEnd(24), 'pids', 'listingTargets', 'membershipTargets', 'total', 'cap3000', ' -> shared-lane verdict')
for (const [g, skus] of Object.entries(groups)) {
  const ms = await prisma.product.findMany({ where: { sku: { in: skus } }, select: { id: true } })
  const masterIds = ms.map(m => m.id)
  const variants = await prisma.product.findMany({ where: { OR: [{ id: { in: masterIds } }, { parentId: { in: masterIds } }] }, select: { id: true } })
  const pids = variants.map(v => v.id)
  const cls = await prisma.channelListing.findMany({ where: { productId: { in: pids }, isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } }, select: { productId: true } })
  const mems = await prisma.sharedListingMembership.findMany({ where: { productId: { in: pids }, status: 'ACTIVE' }, select: { itemId: true } })
  const total = cls.length + mems.length
  console.log(
    g.padEnd(24),
    String(pids.length).padStart(4),
    String(cls.length).padStart(14),
    String(mems.length).padStart(17),
    String(total).padStart(5),
    (total > 3000 ? 'OVER-CAP-400' : 'ok').padStart(12),
    mems.length > 0 ? ' -> HTTP 400 for FOLLOW/PIN/PAUSE/RESUME/ZERO_PIN *after* listing writes' : ' -> ok',
  )
}
await prisma.$disconnect()
