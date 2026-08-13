/**
 * HV.9a — WRITE 1. HV.4's path: promote + negate-at-source as ONE transaction.
 *
 * 🔴 THIS WRITES TO AMAZON. Operator-authorised, one row, guarded on every number that was posted
 * before approval. Any drift and it refuses rather than writing something that was not agreed.
 *
 * Run with:  railway run npx tsx scripts/_hv9a-write1.mts
 */
import '../src/env.js'
const { adsMode } = await import('../src/services/advertising/ads-api-client.js')
const { planPromotion, promoteCandidates } = await import('../src/services/advertising/harvest-promote.service.js')
const { default: prisma } = await import('../src/db.js')

const ID   = 'DE|115625353077718|425987969360011|motorradjacke 4xl'
const CAMP = 'cmpedj38b04xdoj01g9mxye1y'   // DE_Auto_Close — the scope the destination is stored against
const EXPECT = { bidCents: 61, dest: 'DE_Exact_3_Keywords', negate: true }
const die = (m: string) => { console.error(`\n🔴 REFUSING TO WRITE — ${m}\n`); process.exit(1) }

console.log(`\n═══ HV.9a write 1 — pre-flight ═══`)
console.log(`  adsMode = ${adsMode()}`)
if (adsMode() !== 'live') die(`adsMode is "${adsMode()}", not "live". A sandbox write proves nothing. Run under \`railway run\`.`)

const plan = await planPromotion({ market: 'DE', candidateIds: [ID], campaign: CAMP } as never)
if (plan.rows.length !== 1) die(`plan returned ${plan.rows.length} rows, expected exactly 1`)
const r: any = plan.rows[0]
console.log(`  term        ${r.term}`)
console.log(`  source      ${r.sourceAdGroupName}`)
console.log(`  destination ${r.destinationCampaignName} › ${r.destinationAdGroupName}`)
console.log(`  bid         ${r.bidCents}c (observed CPC ${r.observedCpcCents?.toFixed(2)}c, clamped=${JSON.stringify(r.clamped)})`)
console.log(`  negate      ${r.wouldNegateAtSource}`)
console.log(`  blocked     ${JSON.stringify(r.blocked)}`)
console.log(`  evidence    ${r.evidence?.note}`)

if (!r.promotable)                          die('the row is not promotable')
if (r.bidCents !== EXPECT.bidCents)         die(`bid drifted: ${r.bidCents}c, approved ${EXPECT.bidCents}c`)
if (r.destinationAdGroupName !== EXPECT.dest) die(`destination drifted: "${r.destinationAdGroupName}", approved "${EXPECT.dest}"`)
if (r.wouldNegateAtSource !== EXPECT.negate) die(`negate-at-source is ${r.wouldNegateAtSource}, approved ${EXPECT.negate}`)
if (r.clamped)                               die(`bid would be clamped: ${JSON.stringify(r.clamped)} — approved as unclamped`)
if (r.blocked)                               die(`gate blocked: ${JSON.stringify(r.blocked)}`)

console.log(`\n  ✅ every approved value matches. WRITING.\n`)
const res = await promoteCandidates({ market: 'DE', candidateIds: [ID], userId: 'operator:awais', campaign: CAMP } as never)
console.log(`═══ result ═══`)
console.log(`  batchId=${res.batchId} acted=${res.acted} refused=${res.refused} failed=${res.failed}`)
console.log(JSON.stringify(res.outcomes, null, 1))

// read back from OUR side; the Amazon read-back is a separate script
const o: any = res.outcomes[0]
if (o?.targetId) {
  const t = await prisma.adTarget.findUnique({ where:{ id:o.targetId }, select:{ id:true, expressionValue:true, expressionType:true, bidCents:true, externalTargetId:true, adGroup:{ select:{ name:true, campaign:{ select:{ name:true } } } } } })
  console.log(`\n  local row: ${t?.adGroup?.campaign?.name} › ${t?.adGroup?.name} · ${t?.expressionValue} ${t?.expressionType} bid=${t?.bidCents}c ext=${t?.externalTargetId ?? '🔴 NULL — did not reach Amazon'}`)
}
await prisma.$disconnect()
