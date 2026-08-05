/** ACR.6 — the suppression guard must change nothing today (the engine is dormant). READ-ONLY. */
import '../src/env.js'
const { previewBidOptimization } = await import('../src/services/advertising/ads-bid-optimizer.service.js')
const { default: prisma } = await import('../src/db.js')

const r = await previewBidOptimization({})
console.log(`\npreviewBidOptimization() → ${r.proposals.length} proposals (expected 0: spendCents is 0 on every row)`)

const before = await prisma.adTarget.count({ where: { status: 'ENABLED', isNegative: false, spendCents: { gt: 0 } } })
const after = await prisma.adTarget.count({ where: { status: 'ENABLED', isNegative: false, spendCents: { gt: 0 }, suppressedFromBidCents: null, bidCents: { gte: 5 } } })
console.log(`candidate rows without the guard: ${before}`)
console.log(`candidate rows with the guard:    ${after}`)
console.log(after === before ? '✅ guard excludes nothing that was reachable today' : `guard additionally excludes ${before - after}`)
await prisma.$disconnect()
