/** ACR.5 — the priced proposal queue against prod. READ-ONLY. */
import '../src/env.js'
const { pricePendingProposals } = await import('../src/services/advertising/ads-proposal-pricing.service.js')
const r = await pricePendingProposals(15)
const eur = (c: number | null) => (c == null ? '—' : `€${(c / 100).toFixed(2)}`)
console.log(`\n${r.pending} pending · ${r.priced} priced`)
console.log(`Spend at stake (reduce-direction): ${eur(r.spendAtStakeCents)}`)
console.log(`  of which produced NO sales     : ${eur(r.recoverableCents)}\n`)
console.log(`  ${'rule'.padEnd(34)}${'what'.padEnd(20)}${'stake'.padStart(10)}${'sales'.padStart(10)}  term`)
for (const p of r.top) {
  console.log(`  ${(p.ruleName ?? '—').slice(0, 33).padEnd(34)}${p.proposedKey.slice(0, 19).padEnd(20)}${eur(p.spendAtStakeCents).padStart(10)}${eur(p.salesAtStakeCents).padStart(10)}  ${p.recoverable ? '♦ ' : '  '}${(p.entityLabel ?? '').slice(0, 34)}`)
}
const { default: prisma } = await import('../src/db.js')
await prisma.$disconnect()
console.log('\n♦ = spend that produced nothing\n')
