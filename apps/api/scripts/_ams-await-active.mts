/** READ-ONLY: poll every production profile's AMS subscriptions until they
 *  all leave PENDING_CONFIRMATION, or time out. PENDING_CONFIRMATION means
 *  Amazon is still verifying it can write to our SQS queue — if it never
 *  clears, the queue policy does not grant that profile's marketplace. */
const prisma = (await import('../src/db.js')).default
const p = prisma as any
const L = (s = '') => console.log(s)
const { listAmsSubscriptions } = await import('../src/services/advertising/ads-marketing-stream.service.js')

const conns = await p.amazonAdsConnection.findMany({
  where: { isActive: true, mode: 'production' },
  select: { profileId: true, marketplace: true, region: true },
  orderBy: { marketplace: 'asc' },
})

const MAX_PASSES = 10
for (let pass = 1; pass <= MAX_PASSES; pass++) {
  const counts: string[] = []
  let pending = 0, active = 0, other = 0
  for (const c of conns) {
    try {
      const res = await listAmsSubscriptions(c.profileId, (c.region ?? 'EU') as 'EU') as { subscriptions?: Array<{ dataSetId: string; status: string }> }
      const subs = res.subscriptions ?? []
      const a = subs.filter((s) => s.status === 'ACTIVE').length
      const pd = subs.filter((s) => s.status === 'PENDING_CONFIRMATION').length
      const o = subs.length - a - pd
      active += a; pending += pd; other += o
      counts.push(`${c.marketplace}:${a}A/${pd}P${o ? `/${o}?` : ''}`)
      if (o) for (const s of subs.filter((s) => s.status !== 'ACTIVE' && s.status !== 'PENDING_CONFIRMATION')) counts.push(`  ⚠️ ${c.marketplace} ${s.dataSetId}=${s.status}`)
    } catch (e) { counts.push(`${c.marketplace}:ERR`) }
  }
  L(`pass ${String(pass).padStart(2)} — active=${active} pending=${pending} other=${other}  [${counts.join('  ')}]`)
  if (pending === 0) { L('\n✅ no subscriptions left in PENDING_CONFIRMATION'); break }
  if (pass === MAX_PASSES) { L('\n⚠️ still pending after all passes — SQS queue policy may not grant these marketplaces'); break }
  await new Promise((r) => setTimeout(r, 30_000))
}

await prisma.$disconnect()
