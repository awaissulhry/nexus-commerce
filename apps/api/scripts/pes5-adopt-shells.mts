/**
 * PES.5 — adopt the 22 `EBAY_LISTING_SHELL` phantom products as real listing
 * aliases. DRY-RUN BY DEFAULT; `--apply` is required to write anything.
 *
 * Each shell is a fake parent Product (basePrice 0, no children, no link back to
 * the product it duplicates) holding ONE eBay ChannelListing with a real ItemID.
 * They exist because the schema had nowhere to put a second listing of one
 * product on one coordinate. `ProductListingAlias` is that place.
 *
 * Per Owner ruling (hub #18): ADOPT ALL 22, END NOTHING. A qty-0 listing cannot
 * oversell, and ending a live marketplace listing is destructive and would need
 * its own explicit decision. This script makes ZERO eBay calls — it only
 * re-points local rows.
 *
 * What one adoption does, in a transaction:
 *   1. create a ProductListingAlias on the MASTER (adoptedFromProductId = shell)
 *   2. re-point the shell's ChannelListing at the master + that alias
 *   3. SOFT-delete the shell Product (deletedAt), never a hard delete
 * All three are reversible.
 *
 * ⚠ Requires PES.5-ii (the old 4-column unique indexes dropped) — until then a
 * second listing row on one coordinate violates them. The script refuses to
 * apply while they stand and says so.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const APPLY = process.argv.includes('--apply')

/**
 * Owner rulings on the two shells whose SKU does not resolve to a master on its
 * own (hub #23, quoting the Owner):
 *
 *   IT-GALE-JACKET             -> adopt as an alias of GALE-JACKET. "name and
 *                                 coordinate (eBay·IT) both point there, and
 *                                 adoption is reversible."
 *   WATERPROOF-OVERJACKET-ALT1 -> leave unadopted, flag the missing master for
 *                                 investigation. "I won't guess a master for a
 *                                 live-linked listing."
 *
 * Encoded here rather than applied by hand so the decision is reviewable, and so
 * a re-run cannot quietly do something different from what was approved.
 */
const OWNER_RULINGS: Record<string, { master: string | null; note: string }> = {
  'IT-GALE-JACKET': { master: 'GALE-JACKET', note: 'Owner ruling: name + eBay·IT coordinate both point at GALE-JACKET' },
  'WATERPROOF-OVERJACKET-ALT1': { master: null, note: 'Owner ruling: master missing — do NOT guess; flagged for investigation' },
}

/** `GALE-JACKET-ALT1` -> `GALE-JACKET`. Returns null when there is no suffix to strip. */
function stemOf(sku: string): string | null {
  const m = /^(.*?)-ALT\d+$/i.exec(sku)
  return m ? m[1] : null
}

const shells = await prisma.product.findMany({
  where: { productType: 'EBAY_LISTING_SHELL', deletedAt: null },
  select: { id: true, sku: true, name: true, createdAt: true },
  orderBy: { sku: 'asc' },
})

const listings = await prisma.channelListing.findMany({
  where: { productId: { in: shells.map((s) => s.id) } },
  select: { id: true, productId: true, channel: true, marketplace: true, listingStatus: true, externalListingId: true, quantity: true, channelConnectionId: true, aliasId: true },
})
const listingsByShell = new Map<string, typeof listings>()
for (const l of listings) {
  const arr = listingsByShell.get(l.productId) ?? []
  arr.push(l)
  listingsByShell.set(l.productId, arr)
}

interface Plan {
  shellSku: string; shellId: string
  masterSku?: string; masterId?: string
  channel?: string; marketplace?: string
  itemId?: string | null; listingStatus?: string; qty?: number | null
  listingCount: number
  ok: boolean; reason?: string
}

const plans: Plan[] = []
for (const shell of shells) {
  const mine = listingsByShell.get(shell.id) ?? []
  const ruling = OWNER_RULINGS[shell.sku]

  // An explicit Owner ruling to LEAVE a shell alone wins over any stem match.
  if (ruling && ruling.master === null) {
    plans.push({ shellSku: shell.sku, shellId: shell.id, listingCount: mine.length, ok: false, reason: ruling.note })
    continue
  }

  const stem = ruling?.master ?? stemOf(shell.sku)
  if (!stem) {
    plans.push({ shellSku: shell.sku, shellId: shell.id, listingCount: mine.length, ok: false, reason: 'SKU has no -ALTn suffix — no stem to match a master by' })
    continue
  }
  const master = await prisma.product.findFirst({
    where: { sku: stem, deletedAt: null },
    select: { id: true, sku: true, productType: true },
  })
  if (!master) {
    plans.push({ shellSku: shell.sku, shellId: shell.id, listingCount: mine.length, ok: false, reason: `no product with SKU "${stem}"` })
    continue
  }
  if (mine.length !== 1) {
    plans.push({ shellSku: shell.sku, shellId: shell.id, masterSku: master.sku, masterId: master.id, listingCount: mine.length, ok: false, reason: `expected exactly 1 listing, found ${mine.length}` })
    continue
  }
  const l = mine[0]
  plans.push({
    shellSku: shell.sku, shellId: shell.id,
    masterSku: master.sku, masterId: master.id,
    channel: l.channel, marketplace: l.marketplace,
    itemId: l.externalListingId, listingStatus: l.listingStatus, qty: l.quantity,
    listingCount: 1, ok: true,
  })
}

const good = plans.filter((p) => p.ok)
const bad = plans.filter((p) => !p.ok)

console.log(`\nPES.5 shell adoption — ${APPLY ? 'APPLY' : 'DRY RUN'}`)
console.log(`shells found: ${shells.length} | matched: ${good.length} | unmatched: ${bad.length}\n`)
console.log('  SHELL                          ->  MASTER              COORD      ITEM ID        STATUS  QTY')
for (const p of good) {
  console.log(`  ${p.shellSku.padEnd(30)} ->  ${(p.masterSku ?? '').padEnd(18)} ${`${p.channel}:${p.marketplace}`.padEnd(10)} ${(p.itemId ?? '—').padEnd(14)} ${(p.listingStatus ?? '').padEnd(7)} ${p.qty ?? '—'}`)
}
if (bad.length) {
  console.log('\n  NEEDS A DECISION (nothing will be done to these):')
  for (const p of bad) console.log(`  ${p.shellSku.padEnd(30)} -> ${p.reason}`)
}

// Distinct masters gaining aliases, and how many each gains.
const byMaster = new Map<string, number>()
for (const p of good) byMaster.set(p.masterSku!, (byMaster.get(p.masterSku!) ?? 0) + 1)
console.log('\n  aliases per master after adoption:')
for (const [sku, n] of [...byMaster].sort()) console.log(`    ${sku.padEnd(20)} +${n}`)

const legacy = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
  `SELECT count(*)::int AS n FROM pg_indexes WHERE tablename='ChannelListing'
     AND indexname IN ('ChannelListing_productId_channelMarket_conn_key','ChannelListing_productId_channel_marketplace_conn_key')`,
)
const blocked = Number(legacy[0]?.n ?? 0) > 0
console.log(`\n  PES.5-ii applied? ${blocked ? 'NO — old unique indexes still present' : 'yes'}`)

if (!APPLY) {
  console.log('\n  DRY RUN — nothing written. Re-run with --apply once this output has been approved.')
  await prisma.$disconnect()
  process.exit(0)
}
if (blocked) {
  console.error('\n  REFUSING TO APPLY: the pre-alias unique indexes are still in place, so a second')
  console.error('  listing row on one coordinate would be rejected. Land PES.5-ii first.')
  await prisma.$disconnect()
  process.exit(1)
}

let done = 0
for (const p of good) {
  await prisma.$transaction(async (tx) => {
    const highest = await tx.productListingAlias.findFirst({
      where: { productId: p.masterId!, channel: p.channel!, marketplace: p.marketplace! },
      orderBy: { position: 'desc' }, select: { position: true },
    })
    const alias = await tx.productListingAlias.create({
      data: {
        productId: p.masterId!, channel: p.channel!, marketplace: p.marketplace!,
        label: p.shellSku, position: (highest?.position ?? 0) + 1,
        adoptedFromProductId: p.shellId, createdBy: 'pes5-adopt-shells',
      },
    })
    await tx.channelListing.updateMany({
      where: { productId: p.shellId },
      data: { productId: p.masterId!, aliasId: alias.id },
    })
    // SOFT delete: the shell stays recoverable and the adoption reversible.
    await tx.product.update({ where: { id: p.shellId }, data: { deletedAt: new Date() } })
  })
  done++
  console.log(`  adopted ${p.shellSku} -> ${p.masterSku}`)
}
console.log(`\n  ${done} shells adopted. ${bad.length} left untouched for a decision.`)
await prisma.$disconnect()
