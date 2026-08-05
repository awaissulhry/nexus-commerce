/**
 * Follow-up to _deadletter-diag: every failing write is `entityNotFoundError` on an AD_TARGET bid.
 * That means we are pushing bids to targets Amazon does not have. This asks what those targets
 * look like LOCALLY — status, external id, when they were last synced — which decides whether the
 * fix is "our local state is stale" or "the external id is wrong".
 *
 * Read-only.
 */
import { PrismaClient } from '@prisma/client'

const p = new PrismaClient()
const since = new Date(Date.now() - 24 * 3600 * 1000)

const muts = await p.adMutation.findMany({
  where: { state: 'FAILED', updatedAt: { gte: since }, entityType: 'AD_TARGET' },
  select: { entityId: true, externalEntityId: true, intendedValue: true, previousValue: true, attempts: true, lastError: true },
})
const ids = [...new Set(muts.map((m) => m.entityId))]
console.log(`\n${muts.length} failed writes across ${ids.length} distinct AD_TARGETs\n`)

const targets = await p.adTarget.findMany({
  where: { id: { in: ids } },
  select: {
    id: true, externalTargetId: true, kind: true, expressionType: true, expressionValue: true,
    status: true, isNegative: true, bidCents: true, updatedAt: true,
    adGroup: { select: { id: true, name: true, externalAdGroupId: true, status: true, campaign: { select: { name: true, status: true, externalCampaignId: true } } } },
  },
})
const byId = new Map(targets.map((t) => [t.id, t]))

console.log('local status  ext-id?        kind      value                          bid   campaign / ad group')
console.log('-'.repeat(120))
const statusTally = new Map<string, number>()
let missingExt = 0
for (const id of ids) {
  const t = byId.get(id)
  if (!t) { console.log(`  (target ${id} NOT FOUND locally)`); statusTally.set('DELETED_LOCALLY', (statusTally.get('DELETED_LOCALLY') ?? 0) + 1); continue }
  statusTally.set(t.status, (statusTally.get(t.status) ?? 0) + 1)
  if (!t.externalTargetId) missingExt++
  console.log(
    `  ${t.status.padEnd(11)} ${(t.externalTargetId ? 'yes' : 'NULL').padEnd(13)} ${t.kind.padEnd(9)} ` +
    `${String(t.expressionValue ?? '').slice(0, 28).padEnd(29)} ${String(t.bidCents).padStart(4)}  ` +
    `${t.adGroup?.campaign?.name?.slice(0, 26) ?? '?'} / ${t.adGroup?.name?.slice(0, 22) ?? '?'}`,
  )
}

console.log('\n=== Local status of the targets Amazon says do not exist ===')
for (const [s, n] of [...statusTally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${s}`)
console.log(`  ${String(missingExt).padStart(3)}  with NULL externalTargetId`)

// Is this the whole ad group, or scattered targets? Tells us whether the ad group itself is gone.
const byAdGroup = new Map<string, { name: string; failing: number }>()
for (const id of ids) {
  const t = byId.get(id); if (!t?.adGroup) continue
  const e = byAdGroup.get(t.adGroup.id) ?? { name: `${t.adGroup.campaign?.name ?? '?'} / ${t.adGroup.name}`, failing: 0 }
  e.failing++; byAdGroup.set(t.adGroup.id, e)
}
console.log('\n=== Failing targets per ad group (vs how many that ad group holds) ===')
for (const [agId, e] of byAdGroup) {
  const total = await p.adTarget.count({ where: { adGroupId: agId } })
  const enabled = await p.adTarget.count({ where: { adGroupId: agId, status: 'ENABLED' } })
  console.log(`  ${e.failing}/${total} targets failing (${enabled} enabled) — ${e.name}`)
}

await p.$disconnect()
