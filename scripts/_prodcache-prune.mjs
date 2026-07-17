// Delete ProductReadCache rows whose id has no matching Product (stale orphans
// left by hard-deletes/renames). Backup first. Apply only with argv[2]==='apply'.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'; import fs from 'fs'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url)); dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()
const APPLY = process.argv[2] === 'apply'
const prodIds = new Set((await prisma.product.findMany({ select: { id: true } })).map(p => p.id))
const orphans = (await prisma.productReadCache.findMany()).filter(c => !prodIds.has(c.id))
console.log(`orphaned cache rows to delete: ${orphans.length}`)
for (const o of orphans) console.log(`  ${o.sku}  (parentId=${o.parentId ?? '∅'})`)
if (!APPLY) { console.log('\nDRY-RUN (pass "apply").'); await prisma.$disconnect(); process.exit(0) }
fs.writeFileSync(path.join(here, `_backup-prodcache-orphans-${Date.now()}.json`), JSON.stringify(orphans, null, 2))
const r = await prisma.productReadCache.deleteMany({ where: { id: { in: orphans.map(o => o.id) } } })
console.log(`✅ Deleted ${r.count} orphaned cache rows.`)
await prisma.$disconnect()
