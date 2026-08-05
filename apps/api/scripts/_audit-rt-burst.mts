const { default: prisma } = await import('../src/db.js')

const rows = await prisma.$queryRawUnsafe<any[]>(`
  SELECT date_trunc('minute', "createdAt") AS minute, COUNT(*)::int AS n,
         MIN("createdAt") AS first, MAX("createdAt") AS last
  FROM "ProductEvent"
  WHERE "eventType" = 'FLAT_FILE_IMPORTED'
  GROUP BY 1 ORDER BY n DESC LIMIT 12
`)
console.log('=== busiest FLAT_FILE_IMPORTED minutes (each row = 1 SSE product.updated) ===')
for (const r of rows) {
  const spanS = (new Date(r.last).getTime() - new Date(r.first).getTime()) / 1000
  console.log(new Date(r.minute).toISOString(), `n=${String(r.n).padStart(4)}`, `span=${spanS.toFixed(1)}s`, `avg gap=${(spanS / Math.max(1, r.n - 1) * 1000).toFixed(0)}ms`)
}

// Did the ALT masters themselves ever get an event?
const altIds = ['cmrp2jfyd0008pa01t3w6mi4h', 'cmrp2jg640009pa01kq6iitx4', 'cmrp2jgdw000apa01njru02tp', 'cmrp2jglx000bpa01arrdhywq']
const ev = await prisma.productEvent.groupBy({
  by: ['aggregateId', 'eventType'],
  where: { aggregateId: { in: altIds } },
  _count: { _all: true },
})
console.log('\n=== events for IT-GALE / ALT1 / ALT2 / ALT3 masters ===')
console.log(ev.length ? ev : 'NONE')
for (const id of altIds) {
  const n = await prisma.productEvent.count({ where: { aggregateId: id } })
  console.log(id, 'events =', n)
}
await prisma.$disconnect()
