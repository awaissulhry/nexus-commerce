import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
await prisma.product.update({ where: { id: 'cmr1b1yxl0000s4rcvopsqv42' }, data: { description: 'Edited by another operator at ' + new Date().toISOString() } })
console.log('description changed under the draft')
await prisma.$disconnect()
