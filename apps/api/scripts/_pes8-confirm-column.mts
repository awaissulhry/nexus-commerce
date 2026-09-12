import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const cols = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
  `SELECT column_name::text AS column_name FROM information_schema.columns
   WHERE table_name = 'ProductAiDraft' AND column_name IN ('aliasLabel','aliasId')`)
console.log('alias column(s) in DB:', cols.map(c => c.column_name).join(', ') || '(none)')
// Prove the @map actually round-trips through the client, not just that it parses.
const probe = await prisma.productAiDraft.findMany({ select: { id: true, aliasId: true }, take: 1 })
console.log('client can select aliasId via @map:', 'ok (rows:', probe.length + ')')
await prisma.$disconnect()
