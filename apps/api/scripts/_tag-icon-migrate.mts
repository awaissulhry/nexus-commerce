import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const sql = `ALTER TABLE "Tag" ADD COLUMN IF NOT EXISTS "icon" TEXT`
await prisma.$executeRawUnsafe(sql)
const cols = await prisma.$queryRawUnsafe<Array<{ column_name: string; data_type: string; is_nullable: string }>>(
  `SELECT column_name::text AS column_name, data_type::text AS data_type, is_nullable::text AS is_nullable FROM information_schema.columns WHERE table_name = 'Tag' ORDER BY ordinal_position`)
console.log('Tag columns:', cols.map((c) => `${c.column_name}:${c.data_type}${c.is_nullable === 'YES' ? '?' : ''}`).join(' '))
await prisma.$disconnect(); process.exit(0)
