/** READ-ONLY: exactly WHICH targets keep failing, their kind, and the raw Amazon error. */
const { default: prisma } = await import('../src/db.js')
const { isEntityGoneError } = await import('../src/services/ads-core/amazon-entity-gone.js')
const D7 = new Date(Date.now() - 7 * 24 * 3600 * 1000)
const rows = await prisma.adMutation.findMany({ where: { state: 'FAILED', updatedAt: { gte: D7 }, entityType: 'AD_TARGET' }, select: { entityId: true, externalEntityId: true, lastError: true, attempts: true, updatedAt: true, actor: true } })
const byEntity = new Map<string, { n: number; err: string; last: Date; actors: Set<string> }>()
for (const r of rows) {
  const c = byEntity.get(r.entityId)
  if (c) { c.n++; c.actors.add(r.actor); if (r.updatedAt > c.last) c.last = r.updatedAt }
  else byEntity.set(r.entityId, { n: 1, err: r.lastError ?? '', last: r.updatedAt, actors: new Set([r.actor]) })
}
console.log(`\ndistinct AdTargets failing: ${byEntity.size} (from ${rows.length} failed mutations in 7d)\n`)
const tg = await prisma.adTarget.findMany({ where: { id: { in: [...byEntity.keys()] } }, select: { id: true, kind: true, expressionType: true, expressionValue: true, externalTargetId: true, orphanedAt: true, orphanReason: true, status: true, isNegative: true, bidCents: true, suppressedFromBidCents: true, adGroup: { select: { name: true, campaign: { select: { name: true, marketplace: true } } } } } })
for (const t of tg) {
  const f = byEntity.get(t.id)!
  const gone = isEntityGoneError(f.err, { kind: t.kind })
  console.log(`${String(f.n).padStart(3)}× ${t.kind.padEnd(8)} ${(t.expressionType ?? '').padEnd(7)} ext=${t.externalTargetId ?? 'NULL'} orphaned=${t.orphanedAt ? 'YES' : 'no'} status=${t.status} bid=${t.bidCents} sup=${t.suppressedFromBidCents ?? '-'}`)
  console.log(`     ${t.adGroup?.campaign?.name} / ${t.adGroup?.name} · "${(t.expressionValue ?? '').slice(0, 40)}"`)
  console.log(`     isEntityGoneError(kind=${t.kind}) → ${gone}${gone ? '' : '   ← NEVER ORPHANED, so it retries forever'}`)
  console.log(`     err: ${f.err.replace(/\s+/g, ' ').slice(0, 300)}`)
}
await prisma.$disconnect()
