import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const s = await prisma.agentScorecard.findMany({
  orderBy: { periodEnd: 'desc' }, take: 20,
  select: { charterKey: true, grade: true, promotionEligible: true, periodEnd: true,
            findings: true, approved: true, rejected: true, acceptanceRate: true },
})
console.log('SCORECARDS')
for (const r of s) console.log(' ', r.charterKey, 'grade=' + r.grade, 'elig=' + r.promotionEligible,
  r.periodEnd.toISOString().slice(0, 10), 'f=' + r.findings, 'a=' + r.approved, 'r=' + r.rejected)
const st = await prisma.agentFleetState.findFirst()
console.log('STATE', JSON.stringify(st))
await prisma.$disconnect()
