import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const int = (n: number) => n.toLocaleString('en-IE')
const camps = await prisma.campaign.findMany({ select: { id: true, name: true, status: true, marketplace: true, liveBidWritesEnabled: true } })
const on = camps.filter((c) => c.liveBidWritesEnabled)
console.log(`campaigns: ${int(camps.length)} · on the live-write allowlist: ${int(on.length)}`)
for (const c of on) console.log(`  ✓ ${c.name} (${c.marketplace}, ${c.status})`)
const negs = await prisma.adTarget.findMany({
  where: { isNegative: true },
  select: { id: true, status: true, externalTargetId: true, negativeLevel: true, expressionValue: true,
    adGroup: { select: { campaign: { select: { id: true, name: true, status: true, liveBidWritesEnabled: true } } } } },
})
const writable = negs.filter((n) => n.adGroup?.campaign?.liveBidWritesEnabled)
console.log(`\nnegatives: ${int(negs.length)}`)
console.log(`  in an allowlisted campaign (a retirement could actually reach Amazon): ${int(writable.length)}`)
console.log(`  BLOCKED by campaign_allowlist: ${int(negs.length - writable.length)}`)
const atAmazon = writable.filter((n) => n.externalTargetId && n.status === 'ENABLED')
console.log(`  …of the writable ones, ENABLED and confirmed at Amazon: ${int(atAmazon.length)}`)
const byCamp = new Map<string, number>()
for (const n of writable) { const k = n.adGroup!.campaign!.name; byCamp.set(k, (byCamp.get(k) ?? 0) + 1) }
for (const [k, v] of byCamp) console.log(`    ${k}: ${v}`)
await prisma.$disconnect()
