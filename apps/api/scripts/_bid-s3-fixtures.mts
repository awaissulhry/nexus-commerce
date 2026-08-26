/** BID.S3 — resolve the six verification fixtures to concrete ids. READ-ONLY. */
import '../src/env.js'
const { getBidGrid, BID_MARKET_ALL } = await import('../src/services/advertising/bid-grid.service.js')
const { default: prisma } = await import('../src/db.js')
const base = { market: BID_MARKET_ALL, line: null, portfolio: null, campaign: null, view: 'targets' as const,
  status: 'all' as const, kind: [], match: [], band: null, measured: 'all' as const, q: null,
  windowDays: 30, sort: null, dir: 'desc' as const, limit: 5000 }
const g = await getBidGrid(base)
const rows = g.rows as Array<Record<string, any>>
const pick = (label: string, f: (r: any) => boolean, note: (r: any) => string) => {
  const hits = rows.filter(f)
  const r = hits[0]
  console.log(`\n${label}  (${hits.length} available)`)
  if (!r) { console.log('   🔴 NONE'); return }
  console.log(`   id=${r.id}`)
  console.log(`   ${note(r)}`)
  console.log(`   ?target=${r.id}`)
}
console.log(`\n═══ BID.S3 fixtures · ${new Date().toLocaleString('en-GB',{timeZone:'Europe/Rome'})} Rome ═══`)
const fx = await prisma.adTarget.findUnique({ where: { id: 'cmr28mgl50019qq010p4nqnhg' }, select: { bidCents: true, expressionValue: true } })
console.log(`\n1 · intended ≠ delivered  id=cmr28mgl50019qq010p4nqnhg`)
console.log(`   "${fx?.expressionValue}" live bid €${((fx?.bidCents??0)/100).toFixed(2)} — 33 FAILED cuts Jul, APPLIED from 03 Aug`)
pick('2 · unrecorded / dangling', (r) => r.unrecorded && r.lastAuditedCents != null,
  (r) => `"${r.label}" audited €${(r.lastAuditedCents/100).toFixed(2)} → live €${(r.bidCents/100).toFixed(2)}`)
pick('3 · empty curve (never written)', (r) => r.lastAuditedCents == null && r.status === 'ENABLED',
  (r) => `"${r.label}" bid €${(r.bidCents/100).toFixed(2)} · no audited write in 60 d`)
pick('4 · not in auction', (r) => r.status === 'ENABLED' && r.campaignStatus !== 'ENABLED',
  (r) => `"${r.label}" campaign ${r.campaignName} is ${r.campaignStatus}`)
pick('5 · unnamed', (r) => r.derived, (r) => `derived name "${r.label}" from ${r.match}`)
pick('6 · out of band', (r) => r.maxBidCents != null && r.bidCents > r.maxBidCents,
  (r) => `"${r.label}" bid €${(r.bidCents/100).toFixed(2)} vs ceiling €${(r.maxBidCents/100).toFixed(2)} · ${r.campaignName}`)
console.log('')
await prisma.$disconnect()
