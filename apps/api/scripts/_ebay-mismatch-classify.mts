/** READ-ONLY: classify eBay qty mismatches — is the heal-immune class real?
 *  Class A: lastQtyPushed == intended ≠ eBay-actual → fan-out no-op drop eats
 *           every heal (the owner-visible persistent difference).
 *  Class B: lastQtyPushed ≠ intended → normal heal applies (should converge).
 */
const { default: prisma } = await import('../src/db.js')

const trend = await prisma.cronRun.findMany({
  where: { jobName: 'ebay-readback' },
  orderBy: { startedAt: 'desc' },
  take: 8,
  select: { startedAt: true, outputSummary: true },
})
console.log('== readback trend ==')
for (const r of trend) console.log(`  ${r.startedAt.toISOString().slice(11, 19)} ${(r.outputSummary ?? '').replace(/^.*trading /, 'trading ').slice(0, 110)}`)

const flagged = await prisma.syncHealthLog.findMany({
  where: { channel: 'EBAY', conflictType: 'CHANNEL_QTY_READBACK', createdAt: { gte: new Date(Date.now() - 24 * 3600e3) } },
  orderBy: { createdAt: 'desc' },
  select: { createdAt: true, errorMessage: true, conflictData: true, productId: true },
})
console.log(`== flagged EBAY mismatches last 24h: ${flagged.length} ==`)

let classA = 0
let classB = 0
let other = 0
const samples: string[] = []
for (const f of flagged) {
  const data = f.conflictData as { local?: { intendedQty?: number }; remote?: { ebayQty?: number; itemId?: string } } | null
  const intended = data?.local?.intendedQty
  const ebayQty = data?.remote?.ebayQty
  const itemId = data?.remote?.itemId
  const m = f.errorMessage?.match(/for (\S+) \(item/)
  const sku = m?.[1]
  if (!sku || !itemId || intended === undefined || ebayQty === undefined) {
    other++
    continue
  }
  const memb = await prisma.sharedListingMembership.findFirst({
    where: { itemId, sku },
    select: { lastQtyPushed: true, lastPushedAt: true, status: true },
  })
  const lp = memb?.lastQtyPushed
  const cls = lp === intended ? 'A-HEAL-IMMUNE' : 'B-heals'
  if (lp === intended) classA++
  else classB++
  if (samples.length < 14)
    samples.push(
      `${cls.padEnd(14)} ${sku} item=${itemId} pool=${intended} ebay=${ebayQty} lastPushed=${lp ?? 'null'} status=${memb?.status} pushedAt=${memb?.lastPushedAt?.toISOString().slice(5, 16) ?? '-'}`,
    )
}
console.log(`classA(heal-immune: lastPushed==pool≠ebay)=${classA}  classB(normal)=${classB}  other=${other}`)
for (const s of samples) console.log('  ' + s)

// Cross-listing view: same SKU on multiple itemIds — do listings disagree with EACH OTHER?
const skuCounts = await prisma.sharedListingMembership.groupBy({
  by: ['sku'],
  where: { status: 'ACTIVE' },
  _count: true,
  having: { sku: { _count: { gt: 1 } } },
})
console.log(`== SKUs on 2+ listings: ${skuCounts.length} ==`)
await prisma.$disconnect()
process.exit(0)
