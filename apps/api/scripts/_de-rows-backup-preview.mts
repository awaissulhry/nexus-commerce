/** STEP 1 — BACKUP + PREVIEW (no deletes). Captures every eBay/DE ChannelListing
 * row and its dependent OutboundSyncQueue rows to a JSON file, and prints the
 * exact blast radius plus the IT baseline that must be identical afterwards. */
import { writeFileSync } from 'node:fs'
const { default: prisma } = await import('../src/db.js')

const OUT = '/private/tmp/claude-501/-Users-awais-nexus-commerce/d027119c-29ec-42b4-9052-5dab9e08b3ce/scratchpad/de-listings-backup.json'

// The ONLY correct predicate (listingStatus='DRAFT' catches 2/12; externalListingId IS NULL catches 0/12).
const WHERE = { channel: 'EBAY', marketplace: 'DE' } as const

const rows = await prisma.channelListing.findMany({ where: WHERE })
const ids = rows.map((r) => r.id)
const queue = ids.length
  ? await prisma.outboundSyncQueue.findMany({ where: { channelListingId: { in: ids } } })
  : []

writeFileSync(OUT, JSON.stringify({ takenAt: '2026-07-25', where: WHERE, rows, queue }, null, 2))
console.log('✔ backup written:', OUT)
console.log(`  ChannelListing rows: ${rows.length}   OutboundSyncQueue rows: ${queue.length}`)

// ---- what exactly goes ----
console.log('\n=== DE ChannelListing rows to delete ===')
for (const r of rows) {
  const p = await prisma.product.findUnique({ where: { id: r.productId }, select: { sku: true } })
  console.log(`  ${p?.sku ?? r.productId}  status=${r.listingStatus || '(empty)'}  itemId=${r.externalListingId === null ? 'NULL' : `'${r.externalListingId}'`}`)
}

// ---- in-flight guard ----
const inflight = queue.filter((q) => q.syncStatus === 'PENDING' || q.syncStatus === 'IN_PROGRESS')
console.log(`\nin-flight queue rows (must be 0): ${inflight.length}`)
const byStatus: Record<string, number> = {}
for (const q of queue) byStatus[q.syncStatus] = (byStatus[q.syncStatus] || 0) + 1
console.log('queue by status:', JSON.stringify(byStatus))

// ---- things that must NOT change ----
const itListings = await prisma.channelListing.count({ where: { channel: 'EBAY', marketplace: 'IT' } })
const itLiveItemIds = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', marketplace: 'IT', externalListingId: { not: null } },
  select: { externalListingId: true },
})
const memberships = await prisma.sharedListingMembership.count()
const deMemberships = await prisma.sharedListingMembership.count({ where: { marketplace: 'DE' } })
const products = await prisma.product.count({ where: { deletedAt: null } })
console.log('\n=== IT BASELINE (must be identical after the delete) ===')
console.log(`  IT eBay listing rows      : ${itListings}`)
console.log(`  IT distinct live ItemIDs  : ${new Set(itLiveItemIds.map((l) => l.externalListingId)).size}`)
console.log(`  SharedListingMembership   : ${memberships}  (DE: ${deMemberships})`)
console.log(`  live products             : ${products}`)
await prisma.$disconnect()
