/* read-only probe: per-product vs per-family drift on the sync-control row set */
const { default: prisma } = await import('../src/db.js')
const { resolveIntendedQuantity, resolveMembershipIntended } = await import('../src/services/sync-control-core.js')
const { loadChannelPolicies, policyFor } = await import('../src/services/sync-control-policy.service.js')

const [listings, memberships, policies] = await Promise.all([
  prisma.channelListing.findMany({
    where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
    select: {
      productId: true, channel: true, marketplace: true, quantity: true, stockBuffer: true,
      followMasterQuantity: true, fulfillmentMethod: true, syncPaused: true, sourceLocationCodes: true,
      product: { select: { sku: true, fulfillmentMethod: true, parentId: true, name: true } },
    },
  }),
  prisma.sharedListingMembership.findMany({
    where: { status: 'ACTIVE' },
    select: { sku: true, itemId: true, marketplace: true, productId: true, lastQtyPushed: true, followPool: true, stockBuffer: true },
  }),
  loadChannelPolicies(),
])

const productIds = [...new Set([...listings.map(l => l.productId), ...memberships.map(m => m.productId).filter(Boolean) as string[]])]
const levels = await prisma.stockLevel.findMany({
  where: { productId: { in: productIds }, location: { type: 'WAREHOUSE' } },
  select: { productId: true, available: true, location: { select: { code: true, syncRoutes: true } } },
})
const ledgers = new Map<string, any[]>()
for (const l of levels) {
  const arr = ledgers.get(l.productId) ?? []
  arr.push({ locationCode: l.location?.code ?? '?', available: l.available, syncRoutes: l.location?.syncRoutes ?? [] })
  ledgers.set(l.productId, arr)
}

const prodMeta = new Map((await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, parentId: true, sku: true, name: true } })).map(p => [p.id, p]))

type R = { master: string; channel: string; marketplace: string; itemId?: string | null; mode: string; intended: number | null; live: number | null; sku: string }
const rows: R[] = []

for (const cl of listings) {
  const isFba = cl.fulfillmentMethod === 'FBA' || (cl.fulfillmentMethod == null && cl.product?.fulfillmentMethod === 'FBA') || cl.product?.fulfillmentMethod === 'FBA'
  const r = resolveIntendedQuantity({
    channel: cl.channel, marketplace: cl.marketplace, isFba,
    followMasterQuantity: cl.followMasterQuantity, syncPaused: cl.syncPaused,
    pinnedQuantity: cl.quantity, stockBuffer: cl.stockBuffer ?? 0,
    sourceLocationCodes: cl.sourceLocationCodes ?? [],
    channelPolicy: policyFor(policies, cl.channel, cl.marketplace),
    ledger: ledgers.get(cl.productId) ?? [],
  } as any)
  const meta = prodMeta.get(cl.productId)
  rows.push({
    master: meta?.parentId ?? cl.productId, channel: cl.channel, marketplace: cl.marketplace,
    mode: r.kind, intended: r.kind === 'FOLLOW' || r.kind === 'PINNED' ? (r as any).quantity : null,
    live: cl.quantity, sku: cl.product?.sku ?? '?',
  })
}
for (const m of memberships) {
  const r = resolveMembershipIntended({
    marketplace: m.marketplace, followPool: m.followPool ?? true, stockBuffer: m.stockBuffer ?? 0,
    channelPolicy: policyFor(policies, 'EBAY', m.marketplace),
    ledger: m.productId ? (ledgers.get(m.productId) ?? []) : [],
  } as any)
  const meta = m.productId ? prodMeta.get(m.productId) : null
  rows.push({
    master: meta?.parentId ?? m.productId ?? '?', channel: 'EBAY', marketplace: m.marketplace, itemId: m.itemId,
    mode: r.kind, intended: r.kind === 'FOLLOW' ? (r as any).quantity : null, live: m.lastQtyPushed, sku: m.sku,
  })
}

const isDrift = (r: R) => r.mode !== 'FBA_EXCLUDED' && r.intended != null && r.live != null && r.intended !== r.live
const famKey = (r: R) => (r.itemId ? `${r.channel}:${r.marketplace}:${r.itemId}` : `${r.channel}:${r.marketplace}`)

const byMaster = new Map<string, R[]>()
for (const r of rows) {
  const a = byMaster.get(r.master) ?? []
  a.push(r); byMaster.set(r.master, a)
}

let multiFam = 0, hits = 0
for (const [mid, rs] of byMaster) {
  const fams = new Map<string, R[]>()
  for (const r of rs) { const a = fams.get(famKey(r)) ?? []; a.push(r); fams.set(famKey(r), a) }
  if (fams.size < 2) continue
  multiFam++
  const prodDrift = rs.filter(isDrift).length
  if (prodDrift === 0) continue
  const clean = [...fams.entries()].filter(([, v]) => v.filter(isDrift).length === 0)
  if (clean.length === 0) continue
  hits++
  const meta = prodMeta.get(mid)
  console.log(`\nMASTER ${meta?.sku ?? mid} (${meta?.name ?? ''}) — product drift=${prodDrift}, families=${fams.size}`)
  for (const [k, v] of fams) console.log(`   ${k.padEnd(40)} listings=${String(v.length).padStart(3)} drift=${v.filter(isDrift).length}`)
}
console.log(`\nmasters total=${byMaster.size} multiFamily=${multiFam} failureScenarioHits=${hits}`)
await prisma.$disconnect()
