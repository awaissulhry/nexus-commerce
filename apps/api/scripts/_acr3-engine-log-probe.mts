import '../src/env.js'
const { getCoverageEngineLog } = await import('../src/services/advertising/ads-coverage-engine.service.js')
const rows = await getCoverageEngineLog(14)
console.log(`engine log rows (14d): ${rows.length}`)
for (const r of rows.slice(0, 5)) console.log(` ${r.at} ${r.kind} ${r.action} "${r.term}" ${r.fromCents}→${r.toCents} (${r.reason})`)
const { default: prisma } = await import('../src/db.js')
await prisma.$disconnect()
process.exit(0)
