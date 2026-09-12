import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const P='cmr1b1yxl0000s4rcvopsqv42'
const t = await prisma.productTranslation.findUnique({ where:{ productId_language:{ productId:P, language:'de' } } })
const p = await prisma.product.findUnique({ where:{id:P}, select:{description:true} })
console.log('de translation row:', t ? 'STILL PRESENT' : 'removed')
console.log('Product.description:', JSON.stringify(p?.description))
console.log('drafts in table:', await prisma.productAiDraft.count())
await prisma.$disconnect()
