const { default: prisma } = await import('../src/db.js')
const { resolveMembershipIntended } = await import('../src/services/sync-control-core.js')
const { loadChannelPolicies, policyFor } = await import('../src/services/sync-control-policy.service.js')
const policies = await loadChannelPolicies()

const items = ['257584954808', '257611257473']
const mems = await prisma.sharedListingMembership.findMany({
  where: { itemId: { in: items }, status: 'ACTIVE' },
  select: { sku: true, itemId: true, marketplace: true, productId: true, lastQtyPushed: true, followPool: true, stockBuffer: true },
})
const pids = [...new Set(mems.map(m => m.productId).filter(Boolean))] as string[]
const levels = await prisma.stockLevel.findMany({
  where: { productId: { in: pids }, location: { type: 'WAREHOUSE' } },
  select: { productId: true, available: true, location: { select: { code: true, syncRoutes: true } } },
})
const led = new Map<string, any[]>()
for (const l of levels) {
  const a = led.get(l.productId) ?? []
  a.push({ locationCode: l.location?.code ?? '?', available: l.available, syncRoutes: l.location?.syncRoutes ?? [] })
  led.set(l.productId, a)
}
let drift = 0, ok = 0
for (const m of mems) {
  const r = resolveMembershipIntended({
    marketplace: m.marketplace, followPool: m.followPool ?? true, stockBuffer: m.stockBuffer ?? 0,
    channelPolicy: policyFor(policies, 'EBAY', m.marketplace), ledger: m.productId ? (led.get(m.productId) ?? []) : [],
  })
  const intended = r.kind === 'FOLLOW' ? r.quantity : null
  const live = m.lastQtyPushed
  const d = intended != null && live != null && intended !== live
  if (d) drift++; else ok++
  console.log(m.itemId, m.sku, '| kind=', r.kind, '| intended=', intended, '| SClive=', live, '| DRIFT=', d ? 'YES' : 'no')
}
console.log('\ndrift rows:', drift, ' non-drift:', ok)
await prisma.$disconnect()
