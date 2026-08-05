const { default: prisma } = await import('../src/db.js')
const g = await prisma.adTarget.groupBy({ by: ['kind', 'isNegative', 'negativeLevel'], _count: { _all: true } })
for (const r of g) console.log(`kind=${r.kind} negative=${r.isNegative} level=${r.negativeLevel ?? '-'}  n=${r._count._all}`)
console.log('productAds =', await prisma.adProductAd.count())
