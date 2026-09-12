import { config as loadEnv } from 'dotenv'
loadEnv({ path: new URL('../../../.env', import.meta.url).pathname })
import prisma from '../src/db.js'
const before = await prisma.auditLog.findMany({
  where: { action: 'formula.pinned' },
  select: { id: true, entityId: true, createdAt: true, userId: true },
})
console.log('formula.pinned rows before:', before.length)
for (const r of before) console.log(`  ${r.createdAt.toISOString()} entity=${r.entityId} user=${r.userId ?? 'null'}`)
// Every one of these was written by this session's verification (action introduced today).
const del = await prisma.auditLog.deleteMany({ where: { action: 'formula.pinned' } })
console.log('deleted:', del.count)
console.log('formula.pinned rows after :', await prisma.auditLog.count({ where: { action: 'formula.pinned' } }))
console.log('CellFormula rows          :', await prisma.cellFormula.count())
console.log('MasterFieldRule rows      :', await prisma.masterFieldRule.count())
console.log('MasterFieldRuleRevision   :', await prisma.masterFieldRuleRevision.count())
await prisma.$disconnect()
