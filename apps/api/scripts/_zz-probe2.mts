/** DL.1 LIVE PROBE — ONE product target, SAME bid, force + forceResync (the documented
 *  operator re-test path). Economically a no-op; proves the /sp/targets routing. */
const p = (await import('../src/db.js')).default
const { updateAdTargetWithSync } = await import('../src/services/advertising/ads-mutation.service.js')
const ids = [...new Set((await p.adMutation.findMany({ where: { state: 'FAILED', updatedAt: { gte: new Date(Date.now()-7*24*3600e3) } }, select: { entityId: true } })).map(x => x.entityId))]
const t = await p.adTarget.findFirst({ where: { id: { in: ids }, kind: 'PRODUCT' }, select: { id: true, kind: true, expressionValue: true, bidCents: true, orphanedAt: true, adGroup: { select: { campaign: { select: { name: true } } } } } })
if (!t) { console.log('none'); process.exit(0) }
console.log(`probe: ${t.expressionValue} (${t.kind}) · ${t.adGroup?.campaign?.name} · bid ${t.bidCents}c UNCHANGED · orphanedAt=${t.orphanedAt?.toISOString() ?? 'null'}`)
const r = await updateAdTargetWithSync({
  adTargetId: t.id, patch: { bidCents: t.bidCents }, actor: 'automation:dl1-routing-probe' as never,
  reason: 'DL.1 — verify /sp/targets routing; same bid, no economic change',
  applyImmediately: true, force: true, forceResync: true,
})
console.log('outcome:', JSON.stringify(r).slice(0, 200))
for (let i = 0; i < 12; i++) {
  await new Promise(res => setTimeout(res, 10000))
  const m = await p.adMutation.findFirst({ where: { entityId: t.id, actor: { contains: 'dl1-routing-probe' } }, orderBy: { createdAt: 'desc' }, select: { state: true, attempts: true, lastError: true } })
  if (m && ['APPLIED','FAILED'].includes(m.state)) { console.log(`\nRESULT: ${m.state} after ${m.attempts} attempt(s)`); if (m.lastError) console.log('error:', m.lastError.slice(0, 200)); break }
  if (i === 11) console.log('\nstill pending after 2 min — check AdMutation for actor dl1-routing-probe')
}
