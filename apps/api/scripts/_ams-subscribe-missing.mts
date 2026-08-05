/**
 * Bring every PRODUCTION ads profile to Marketing Stream parity with IT.
 *
 * IT carries the 6 performance datasets (sp/sb/sd × traffic/conversion);
 * DE, FR and ES carry none, so those markets receive no hourly data at all.
 *
 * Idempotent: lists existing subscriptions per profile first and only creates
 * what is genuinely missing. Safe to re-run.
 *
 * Pass --apply to write. Without it this is a dry run.
 */
const prisma = (await import('../src/db.js')).default
const p = prisma as any
const L = (s = '') => console.log(s)
const APPLY = process.argv.includes('--apply')

const { listAmsSubscriptions, createAmsSubscription } = await import('../src/services/advertising/ads-marketing-stream.service.js')
const { AMS_PERFORMANCE_DATASETS } = await import('../src/services/ads-core/ams-dataset.js')

// Parity target = exactly what IT already runs. The change/budget streams are
// a separate decision and deliberately out of scope here — subscribing only
// DE/FR/ES to them would leave the estate inconsistent.
const TARGET: readonly string[] = AMS_PERFORMANCE_DATASETS

const ARN = process.env.NEXUS_AMS_DESTINATION_ARN
if (!ARN) { L('⛔ NEXUS_AMS_DESTINATION_ARN unset — cannot subscribe'); process.exit(1) }
L(`destination: ${ARN}`)
L(`target datasets: ${TARGET.join(', ')}`)
L(APPLY ? '\n*** APPLY MODE — will create subscriptions ***\n' : '\n(dry run — pass --apply to write)\n')

const conns = await p.amazonAdsConnection.findMany({
  where: { isActive: true, mode: 'production' },
  select: { profileId: true, marketplace: true, region: true },
  orderBy: { marketplace: 'asc' },
})

let created = 0, skipped = 0, failed = 0
for (const c of conns) {
  const region = (c.region ?? 'EU') as 'EU'
  let existing = new Set<string>()
  try {
    const res = await listAmsSubscriptions(c.profileId, region) as { subscriptions?: Array<{ dataSetId: string; status: string }> }
    // Only ACTIVE/PENDING count as present — an ARCHIVED one must be recreated.
    existing = new Set((res.subscriptions ?? []).filter((s) => s.status !== 'ARCHIVED').map((s) => s.dataSetId))
  } catch (e) {
    L(`  ${c.marketplace}: cannot list subscriptions — ${e instanceof Error ? e.message.slice(0, 120) : e}`)
    failed += 1
    continue
  }

  const missing = TARGET.filter((d) => !existing.has(d))
  L(`${c.marketplace} (${c.profileId}) — has ${existing.size}, missing ${missing.length}${missing.length ? `: ${missing.join(', ')}` : ''}`)
  if (!missing.length) { skipped += TARGET.length; continue }

  for (const dataSetId of missing) {
    if (!APPLY) { L(`    would create ${dataSetId}`); continue }
    try {
      const out = await createAmsSubscription({ profileId: c.profileId, region, dataSetId, destinationArn: ARN, notes: `Nexus AMS subscription (${c.marketplace})` })
      L(`    ✅ ${dataSetId} → ${JSON.stringify(out).slice(0, 160)}`)
      created += 1
    } catch (e) {
      L(`    ⛔ ${dataSetId} — ${e instanceof Error ? e.message.slice(0, 200) : e}`)
      failed += 1
    }
    // Space the creates; Amazon rate-limits this endpoint tightly.
    await new Promise((r) => setTimeout(r, 1200))
  }
}

L(`\ncreated=${created} alreadyPresent=${skipped} failed=${failed}`)

if (APPLY) {
  L('\n══ VERIFY — subscriptions per profile after the change ══════════')
  for (const c of conns) {
    try {
      const res = await listAmsSubscriptions(c.profileId, (c.region ?? 'EU') as 'EU') as { subscriptions?: Array<{ dataSetId: string; status: string }> }
      const subs = res.subscriptions ?? []
      L(`  ${c.marketplace}: ${subs.length} — ${subs.map((s) => `${s.dataSetId}(${s.status})`).join(' ')}`)
    } catch (e) { L(`  ${c.marketplace}: ERROR ${e instanceof Error ? e.message.slice(0, 120) : e}`) }
  }
}

await prisma.$disconnect()
