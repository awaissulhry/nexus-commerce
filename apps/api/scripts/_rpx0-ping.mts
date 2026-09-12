import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const r = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT current_database() AS db, now() AS ts`)
console.log(r)
await prisma.$disconnect()
