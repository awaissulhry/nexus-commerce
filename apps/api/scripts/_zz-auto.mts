const p = (await import('../src/db.js')).default
const { updateAdTargetWithSync } = await import('../src/services/advertising/ads-mutation.service.js')
const ids = [...new Set((await p.adMutation.findMany({ where: { state: 'FAILED', updatedAt: { gte: new Date(Date.now()-7*24*3600e3) } }, select: { entityId: true } })).map(x => x.entityId))]
const t = await p.adTarget.findFirst({ where: { id: { in: ids }, kind: 'AUTO' }, select: { id: true, kind: true, expressionType: true, bidCents: true, adGroup: { select: { campaign: { select: { name: true } } } } } })
if (!t) { console.log('NONE'); process.exit(0) }
console.error(`PROBE ${t.expressionType} (${t.kind}) · ${t.adGroup?.campaign?.name} · bid ${t.bidCents}c UNCHANGED`)
await updateAdTargetWithSync({ adTargetId: t.id, patch: { bidCents: t.bidCents }, actor: 'automation:dl1-auto-probe' as never, reason: 'DL.1 — verify /sp/targets routing for AUTO; same bid', applyImmediately: true, force: true, forceResync: true })
for (let i = 0; i < 15; i++) {
  await new Promise(r => setTimeout(r, 8000))
  const m = await p.adMutation.findFirst({ where: { actor: { contains: 'dl1-auto-probe' } }, orderBy: { createdAt: 'desc' }, select: { state: true, attempts: true, lastError: true } })
  if (m && ['APPLIED','FAILED'].includes(m.state)) { console.error(`RESULT ${t.expressionType}: ${m.state} after ${m.attempts} attempt(s) ${m.lastError ? '| '+m.lastError.slice(0,120) : '| no error'}`); break }
}
