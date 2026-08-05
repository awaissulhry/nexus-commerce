/**
 * DL.3 — requeue the targets stranded by the /sp/keywords routing bug.
 *
 * The routing is fixed and verified live (12 AUTO + 1 PRODUCT applied since deploy, 0 failures),
 * but the writes that failed under the old routing are already dead-lettered. They will not retry
 * on their own until rank-defend independently decides the same change again, which for a target
 * already sitting at its intended local value may be never — leaving Amazon permanently out of
 * step with what we believe we set.
 *
 * This re-pushes the LOCAL CURRENT bidCents for each stranded target, so Amazon converges on the
 * value we already hold. It does not invent a new bid, and it does not replay history.
 *
 * Dry-run by default. Pass `apply` to write.
 */
import prisma from '../src/db.js'

const APPLY = process.argv[2] === 'apply'
const since = new Date(Date.now() - 14 * 24 * 3600 * 1000)

const failed = await prisma.adMutation.findMany({
  where: { state: 'FAILED', entityType: 'AD_TARGET', createdAt: { gte: since } },
  select: { entityId: true, lastError: true },
})
const ids = [...new Set(failed.map((f) => f.entityId))]

const targets = await prisma.adTarget.findMany({
  where: { id: { in: ids } },
  select: {
    id: true, kind: true, expressionValue: true, bidCents: true, status: true, externalTargetId: true,
    suppressedFromBidCents: true,
    adGroup: { select: { name: true, campaign: { select: { id: true, name: true, marketplace: true, liveBidWritesEnabled: true, status: true } } } },
  },
})

/**
 * Targets that have ALREADY reconciled themselves since the routing fix deployed need nothing:
 * rank-defend re-decided their bid, the write went to the right endpoint, and Amazon took it.
 * Requeuing them would be a live Amazon write that changes nothing. Only the ones still stranded
 * are worth touching.
 */
const FIX_DEPLOYED_AT = new Date('2026-08-03T00:52:51Z')
const reconciled = new Set(
  (await prisma.adMutation.findMany({
    where: { entityType: 'AD_TARGET', state: 'APPLIED', entityId: { in: ids }, updatedAt: { gte: FIX_DEPLOYED_AT } },
    select: { entityId: true },
  })).map((m) => m.entityId),
)

// Only targets the routing fix actually unblocks, and only ones still worth pushing.
const eligible = targets.filter((t) =>
  (t.kind === 'PRODUCT' || t.kind === 'AUTO')
  && !!t.externalTargetId
  && t.status === 'ENABLED'
  && t.adGroup?.campaign?.status === 'ENABLED'
  && !reconciled.has(t.id),
)
console.log(`${reconciled.size} already reconciled by the cron since the fix — leaving those alone.`)

console.log(`\n${ids.length} stranded targets · ${eligible.length} eligible to requeue${APPLY ? '' : '   (DRY RUN — pass "apply" to write)'}\n`)
const skipped = targets.filter((t) => !eligible.includes(t))
if (skipped.length) {
  console.log(`skipping ${skipped.length}:`)
  for (const t of skipped) console.log(`  ${t.kind} ${t.expressionValue ?? ''} — kind/ext/status: ${t.kind}/${t.externalTargetId ? 'ok' : 'NULL'}/${t.status}, campaign ${t.adGroup?.campaign?.status}`)
  console.log()
}

for (const t of eligible) {
  const c = t.adGroup?.campaign
  console.log(`  ${t.kind.padEnd(8)} ${(t.expressionValue ?? '(auto clause)').padEnd(14)} bid=${String(t.bidCents).padStart(4)}  liveWrites=${c?.liveBidWritesEnabled ? 'ON' : 'OFF'}  ${c?.name?.slice(0, 28)}`)
}

if (!APPLY) { console.log('\nNothing written.\n'); await prisma.$disconnect(); process.exit(0) }

const { updateAdTargetWithSync } = await import('../src/services/advertising/ads-mutation.service.js')
let ok = 0, fail = 0
for (const t of eligible) {
  try {
    // Re-assert the value we already hold locally. `force` bypasses the no-op guard, because
    // local and intended already agree — that is precisely why nothing would re-push otherwise.
    const r = await updateAdTargetWithSync({
      adTargetId: t.id,
      patch: { bidCents: t.bidCents },
      actor: 'automation:dl-requeue',
      reason: 'DL.3 requeue after the /sp/keywords routing fix',
      applyImmediately: true,
      force: true,
      // `force` only bypasses the bid-change clamp. It does NOT push an unchanged value:
      // updateAdTargetWithSync builds a `changes` array and returns ok:true with an empty
      // queue when local already equals intended (38 -> 38), which is why the first two runs
      // reported ok=14 and enqueued nothing. `forceResync` is the flag built for exactly this.
      forceResync: true,
    } as never)
    if (r?.ok) { ok++; console.log(`  OK   ${t.kind} ${t.expressionValue ?? ''}`) }
    else { fail++; console.log(`  FAIL ${t.kind} ${t.expressionValue ?? ''}`) }
  } catch (e) { fail++; console.log(`  ERR  ${t.kind} ${t.expressionValue ?? ''} — ${(e as Error).message.slice(0, 120)}`) }
}
console.log(`\nrequeued ok=${ok} fail=${fail}\n`)
await prisma.$disconnect()
