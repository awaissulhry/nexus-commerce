/** READ-ONLY. MAP.6 must be invisible with one account: for every itemId the flat
 *  file can act on, the DERIVED path and the DECLARED fallback must resolve to the
 *  same connection. Checked on every distinct itemId, not a sample. */
const { default: prisma } = await import('../src/db.js')
const { tryResolveConnection } = await import('../src/services/connection-resolver.service.js')

const declared = await tryResolveConnection({ channel: 'EBAY', primary: true })
console.log('DECLARED (primary eBay):', declared?.id)

const items = await prisma.sharedListingMembership.groupBy({ by: ['itemId', 'marketplace'] })
console.log(`distinct (itemId, marketplace) pairs: ${items.length}`)

let same = 0, differ = 0, missed = 0
const bad: string[] = []
for (const it of items) {
  const derived = await tryResolveConnection({ itemId: it.itemId, marketplace: it.marketplace })
  const effective = derived ?? declared
  if (!derived) missed++
  if (effective?.id === declared?.id) same++
  else { differ++; bad.push(`${it.itemId}/${it.marketplace} -> ${effective?.id}`) }
}
console.log(`\nresolve to the SAME connection as today: ${same}/${items.length}`)
console.log(`  derived returned nothing (fallback used): ${missed}`)
console.log(`  DIFFERENT connection: ${differ}${bad.length ? ' -> ' + bad.slice(0,5).join(', ') : ''}`)

// And the adoption case the fallback exists for: an itemId with no membership.
const orphan = await tryResolveConnection({ itemId: '999999999999' })
console.log(`\nunknown itemId derives to: ${orphan?.id ?? 'null'}  -> falls back to ${declared?.id} (route still works)`)
await prisma.$disconnect()
