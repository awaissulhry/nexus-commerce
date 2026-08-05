const { default: prisma } = await import('../src/db.js')
const rows = await prisma.$queryRawUnsafe(`SELECT id, mode, status, "submittedAt", "completedAt", "errorMessage" FROM "EbayPushJob" ORDER BY "submittedAt" DESC LIMIT 8`) as Array<Record<string, unknown>>
for (const r of rows) console.log(`${new Date(String(r.submittedAt)).toISOString()}  ${r.mode}  ${r.status}  done=${r.completedAt ? new Date(String(r.completedAt)).toISOString() : '—'}  ${String(r.errorMessage ?? '').slice(0, 80)}`)
await prisma.$disconnect()
