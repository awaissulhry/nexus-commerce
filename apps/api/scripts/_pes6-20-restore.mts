import { config as loadEnv } from 'dotenv'
loadEnv({ path: new URL('../../../.env', import.meta.url).pathname })
import prisma from '../src/db.js'

const CANON = 'XAVIA GALE Giacca Da Moto Da Uomo - Giubbotto Moto Impermeabile E Ventilata Con Protezione Di Livello 2 | Per Tutte Le Stagioni'

const me = await prisma.product.findFirst({
  where: { sku: 'GALE-JACKET-BLACK-MEN-L' },
  select: { id: true, parentId: true, name: true, description: true },
})
// Only proceed if the row is still the damaged one — never overwrite a good value.
if (me!.name !== 'CHANGED XAVIA') {
  console.log('🔴 name is not the damaged value; refusing to touch it. Current:', JSON.stringify(me!.name))
  process.exit(1)
}
// Corroborate the canonical string against the 17 normal-size siblings before writing it.
const agree = await prisma.product.count({ where: { parentId: me!.parentId, name: CANON, deletedAt: null } })
console.log(`siblings carrying the canonical name: ${agree} (expect 17)`)
if (agree < 10) { console.log('🔴 not enough corroboration; aborting'); process.exit(1) }

await prisma.product.update({ where: { id: me!.id }, data: { name: CANON, description: null } })
const del = await prisma.auditLog.deleteMany({ where: { entityId: me!.id, action: 'formula.pinned' } })
const cf = await prisma.cellFormula.deleteMany({ where: { productId: me!.id } })

const after = await prisma.product.findUnique({ where: { id: me!.id }, select: { name: true, description: true } })
console.log('\nrestored:')
console.log('  name        :', JSON.stringify(after!.name))
console.log('  matches 17 siblings exactly:', after!.name === CANON)
console.log('  description :', after!.description)
console.log('  audit rows deleted:', del.count, '| formula rows deleted:', cf.count)
console.log('\nglobal leftovers:')
console.log('  CellFormula anywhere      :', await prisma.cellFormula.count())
console.log('  formula.pinned audit rows :', await prisma.auditLog.count({ where: { action: 'formula.pinned' } }))
console.log('  MasterFieldRule rows      :', await prisma.masterFieldRule.count())
await prisma.$disconnect()
