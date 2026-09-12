import prisma from '../src/db.js'
import { readdirSync } from 'node:fs'
const applied = await prisma.$queryRawUnsafe<any[]>(`SELECT migration_name::text AS n, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at DESC LIMIT 12`)
console.log('=== last 12 applied ===')
for (const r of applied) console.log(`  ${r.n}  finished=${r.finished_at?.toISOString?.().slice(0,16) ?? 'NULL'} ${r.rolled_back_at ? 'ROLLED BACK' : ''}`)
const onDisk = readdirSync('../../packages/database/prisma/migrations').filter(d => /^\d/.test(d))
const appliedAll = new Set((await prisma.$queryRawUnsafe<any[]>(`SELECT migration_name::text AS n FROM "_prisma_migrations"`)).map(r => r.n))
const pending = onDisk.filter(d => !appliedAll.has(d))
console.log(`\n=== PENDING (on disk, not applied): ${pending.length} ===`)
for (const p of pending) console.log('  ' + p)
const failed = await prisma.$queryRawUnsafe<any[]>(`SELECT migration_name::text AS n FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL`)
console.log(`\nfailed/rolled-back rows (block deploys): ${failed.length ? failed.map(f=>f.n).join(', ') : 'none'}`)
await prisma.$disconnect()
