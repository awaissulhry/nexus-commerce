/**
 * HV.5a — did HV.4's live write run, and did both halves reach Amazon? READ-ONLY.
 *
 * HV.4 built and deployed the paired write but the sandbox blocked the single live write, so this
 * script is written to be re-runnable: it reports "not yet" cleanly rather than failing.
 *
 * The proposed write was:
 *   term  motorradjacke 4xl (DE)
 *   from  DE_Auto_Close (AUTO)   to  DE_Exact_3_Keywords
 *   bid   EUR 0.61, unclamped    negate at source: yes
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const TERM = 'motorradjacke 4xl'
const DEST_AG = 'cmpedj42c04ypoj0144it19cz'   // DE_Exact_3_Keywords
const SRC_AG  = 'cmpedj35s04x9oj01x0zqvvhd'   // DE_Auto_Close (resolved below if wrong)

console.log('\n═══ HV.5a — did the paired write run? ═══\n')

// 1 · the stored destination HV.4 left behind
const dest = await prisma.adsHarvestDestination.findMany()
console.log(`AdsHarvestDestination rows: ${dest.length}`)
for (const d of dest) console.log(`  ${d.scopeGrain}/${d.scopeId}/${d.matchType} → adGroup ${d.adGroupId} · negateAtSource=${d.negateAtSource} · by ${d.updatedBy} · ${d.updatedAt.toISOString().slice(0,16)}`)

// 2 · the keyword
const kw = await prisma.adTarget.findMany({
  where: { isNegative: false, kind: 'KEYWORD', expressionValue: { equals: TERM, mode: 'insensitive' } },
  select: { id: true, adGroupId: true, expressionType: true, bidCents: true, externalTargetId: true, createdAt: true, status: true,
            adGroup: { select: { name: true, campaign: { select: { name: true, marketplace: true } } } } },
  orderBy: { createdAt: 'desc' },
})
console.log(`\npositive KEYWORD targets for "${TERM}": ${kw.length}`)
console.log(`${pad('created',18)} ${pad('ad group',26)} ${pad('campaign',24)} ${pad('bid',8)} ${pad('type',7)} externalTargetId`)
for (const k of kw) {
  console.log(`${pad(k.createdAt.toISOString().slice(0,16),18)} ${pad(k.adGroup?.name ?? '?',26)} ${pad(k.adGroup?.campaign?.name ?? '?',24)} ${pad(`€${(k.bidCents/100).toFixed(2)}`,8)} ${pad(k.expressionType,7)} ${k.externalTargetId ?? '🔴 NONE — local only'}`)
}
const atDest = kw.find(k => k.adGroupId === DEST_AG)
console.log(`\n  in the intended destination (DE_Exact_3_Keywords): ${atDest ? `YES · ${atDest.externalTargetId ? `✅ reached Amazon (${atDest.externalTargetId})` : '🔴 LOCAL ONLY'}` : 'not yet'}`)

// 3 · the isolation negative
const neg = await prisma.adTarget.findMany({
  where: { isNegative: true, expressionValue: { equals: TERM, mode: 'insensitive' } },
  select: { id: true, adGroupId: true, negativeLevel: true, expressionType: true, externalTargetId: true, createdAt: true,
            adGroup: { select: { name: true, campaign: { select: { name: true } } } } },
  orderBy: { createdAt: 'desc' },
})
console.log(`\nnegative targets for "${TERM}": ${neg.length}`)
for (const n of neg) {
  console.log(`  ${pad(n.createdAt.toISOString().slice(0,16),18)} ${pad(n.adGroup?.name ?? '?',26)} scope=${pad(n.negativeLevel ?? '?',9)} ${n.externalTargetId ?? '🔴 NONE — local only'}`)
}

// 4 · the audit row + its evidence (C9)
const logs = await prisma.advertisingActionLog.findMany({
  where: { actionType: { in: ['create_keyword','create_negative_keyword'] }, createdAt: { gte: new Date('2026-08-12T00:00:00Z') } },
  select: { actionType: true, userId: true, entityId: true, createdAt: true, payloadAfter: true, evidence: true },
  orderBy: { createdAt: 'desc' }, take: 10,
})
console.log(`\naudit rows since 2026-08-12: ${logs.length}`)
for (const l of logs) {
  console.log(`  ${l.createdAt.toISOString().slice(0,16)} ${pad(l.actionType,24)} by ${pad(l.userId ?? '(none)',22)}`)
  console.log(`     payload: ${JSON.stringify(l.payloadAfter).slice(0,140)}`)
  console.log(`     evidence: ${l.evidence ? JSON.stringify(l.evidence).slice(0,180) : '🔴 none'}`)
}
console.log(`\n⇒ ${atDest ? 'the write RAN' : 'the write has NOT run yet — nothing below it is verifiable'}`)
await prisma.$disconnect()
