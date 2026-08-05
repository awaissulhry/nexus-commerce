/**
 * ACR.3 — the last consolidation target. Its campaign (IT_Exact_Gale_SV=2k+_Key=1) carries a
 * maxBidChangePct=25 guardrail, so the ordinary write path clamped 5¢ to a 25% step three times
 * (45→34→26→20). `force` is the designed bypass for deliberate bid suppression (NP pattern).
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { updateAdTargetWithSync } = await import('../src/services/advertising/ads-mutation.service.js')
const res = await updateAdTargetWithSync({
  adTargetId: 'cmpsr2j4j01r7ry01lenuh91c',
  patch: { bidCents: 5 },
  actor: 'user:operator-acr3-consolidation',
  reason: 'Consolidation (operator-approved): "giacca moto" [EXACT] championed by GALE | IT | Exact | Category — forced past the campaign maxBidChangePct clamp (deliberate suppression)',
  evidence: {
    metric: 'consolidation_champion',
    observed: 'clamp walked 45→34→26→20 over three writes; force completes the approved floor',
    threshold: 'lowest ACOS → highest spend → traffic (engine ordering)',
    windowDays: 30,
  } as never,
  applyImmediately: true,
  force: true,
  changeSetId: 'acr3-gale-consolidation-20260805',
})
console.log('write result:', JSON.stringify({ ok: res.ok, error: res.error, queue: res.outboundQueueId }))
const t = await prisma.adTarget.findUnique({ where: { id: 'cmpsr2j4j01r7ry01lenuh91c' }, select: { bidCents: true } })
console.log('bid now:', t?.bidCents)
await prisma.$disconnect()
process.exit(0)
