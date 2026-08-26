/** NEG.5 — remove every row this session's production click-through created. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rev = await prisma.adNegativeReview.deleteMany({})
const prot = await prisma.adKeywordProtection.deleteMany({ where: { term: 'neg5probe' } })
console.log(`review rows removed: ${rev.count}`)
console.log(`neg5probe protections removed: ${prot.count}`)
const left = await prisma.adNegativeReview.count()
const prots = await prisma.adKeywordProtection.count()
console.log(`AdNegativeReview now: ${left}  (expect 0)`)
console.log(`AdKeywordProtection now: ${prots}  (expect 10)`)
await prisma.$disconnect()
process.exit(left === 0 && prots === 10 ? 0 : 1)
