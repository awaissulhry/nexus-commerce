/**
 * AX2.0 — mark the AdTarget/AdGroup rows Amazon has ALREADY told us are gone.
 *
 * Without this the fix still works, it just costs one more round of dead
 * letters: the next rank-defend push gets entityNotFoundError and the worker
 * stamps orphanedAt itself. This backfill uses the evidence we already have in
 * the dead-letter queue so those writes are never generated at all.
 *
 * Reversible: it only sets two nullable columns. `--undo` clears them.
 * Default is a DRY RUN — pass --apply to write.
 */
const prisma = (await import('../src/db.js')).default
const { isEntityGoneError, orphanReasonFrom } = await import('../src/services/ads-core/amazon-entity-gone.js')

const APPLY = process.argv.includes('--apply')
const UNDO = process.argv.includes('--undo')
const L = (s = '') => console.log(s)

if (UNDO) {
  const t = await prisma.adTarget.updateMany({ where: { orphanedAt: { not: null } }, data: { orphanedAt: null, orphanReason: null } })
  const g = await prisma.adGroup.updateMany({ where: { orphanedAt: { not: null } }, data: { orphanedAt: null, orphanReason: null } })
  L(`UNDO — cleared orphan marks: ${t.count} targets, ${g.count} ad groups`)
  await prisma.$disconnect()
  process.exit(0)
}

L(`── AX2.0 orphan backfill ${APPLY ? '(APPLY)' : '(DRY RUN — pass --apply to write)'} ──\n`)

// Evidence: dead-lettered AD_* writes whose error is an entity-gone error.
const dead = await prisma.outboundSyncQueue.findMany({
  where: { syncType: { startsWith: 'AD_' }, isDead: true },
  select: { payload: true, errorMessage: true, diedAt: true },
})
L(`dead-lettered AD_* rows examined: ${dead.length}`)

type Evidence = { entityType: string; entityId: string; externalId: string | null; reason: string; diedAt: Date | null }
const byEntity = new Map<string, Evidence>()
for (const d of dead) {
  if (!isEntityGoneError(d.errorMessage)) continue
  const p = (d.payload ?? {}) as { entityType?: string; entityId?: string; externalId?: string | null }
  if (!p.entityId || !p.entityType) continue
  const prev = byEntity.get(p.entityId)
  if (!prev || (d.diedAt && prev.diedAt && d.diedAt > prev.diedAt)) {
    byEntity.set(p.entityId, {
      entityType: p.entityType, entityId: p.entityId, externalId: p.externalId ?? null,
      reason: orphanReasonFrom(d.errorMessage), diedAt: d.diedAt,
    })
  }
}
L(`distinct entities Amazon says are gone: ${byEntity.size}\n`)

const targets = [...byEntity.values()].filter((e) => e.entityType === 'AD_TARGET')
const groups = [...byEntity.values()].filter((e) => e.entityType === 'AD_GROUP')
L(`  AD_TARGET: ${targets.length}`)
L(`  AD_GROUP : ${groups.length}`)
L(`  other    : ${byEntity.size - targets.length - groups.length}\n`)

// Only mark rows that STILL carry the external id Amazon rejected. If the id
// has since been re-resolved, the row is healthy and must be left alone.
let markedT = 0, skippedT = 0
for (const e of targets) {
  const row = await prisma.adTarget.findUnique({
    where: { id: e.entityId },
    select: { id: true, externalTargetId: true, expressionValue: true, orphanedAt: true },
  })
  if (!row) { skippedT++; continue }
  if (e.externalId && row.externalTargetId !== e.externalId) {
    L(`  ↷ skip ${row.expressionValue} — external id changed since (${e.externalId} → ${row.externalTargetId})`)
    skippedT++; continue
  }
  if (row.orphanedAt) { skippedT++; continue }
  L(`  ✓ ${row.expressionValue?.slice(0, 40).padEnd(42)} ${row.externalTargetId}`)
  if (APPLY) {
    await prisma.adTarget.update({ where: { id: row.id }, data: { orphanedAt: e.diedAt ?? new Date(), orphanReason: e.reason } })
  }
  markedT++
}

let markedG = 0
for (const e of groups) {
  const row = await prisma.adGroup.findUnique({ where: { id: e.entityId }, select: { id: true, name: true, externalAdGroupId: true, orphanedAt: true } })
  if (!row || row.orphanedAt) continue
  if (e.externalId && row.externalAdGroupId !== e.externalId) continue
  L(`  ✓ [ad group] ${row.name}`)
  if (APPLY) await prisma.adGroup.update({ where: { id: row.id }, data: { orphanedAt: e.diedAt ?? new Date(), orphanReason: e.reason } })
  markedG++
}

L(`\n${APPLY ? 'MARKED' : 'WOULD MARK'}: ${markedT} targets, ${markedG} ad groups   (skipped ${skippedT})`)
if (!APPLY) L('\nRe-run with --apply to write. Reverse any time with --undo.')

await prisma.$disconnect()
