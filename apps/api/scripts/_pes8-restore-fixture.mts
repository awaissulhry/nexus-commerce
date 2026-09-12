// PES.8 — put the XAVIA fixtures back exactly as the walk found them.
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const AIREON = 'cmr1b1yxl0000s4rcvopsqv42'
const AIRMESH = 'cmonjewg10001o701j5cqpfzs'

// description: was NULL on both before the walk (confirmed at seed time — baseValue was null).
for (const id of [AIREON, AIRMESH]) {
  await prisma.product.update({ where: { id }, data: { description: null } })
}
// material: absent on AIREON before the walk. Remove the key rather than set it empty.
const p = await prisma.product.findUnique({ where: { id: AIREON }, select: { categoryAttributes: true } })
const attrs = { ...((p?.categoryAttributes as Record<string, unknown> | null) ?? {}) }
delete attrs.material
await prisma.product.update({ where: { id: AIREON }, data: { categoryAttributes: attrs } })

const drafts = await prisma.productAiDraft.deleteMany({ where: { runId: { startsWith: 'pes8-' } } })
console.log('drafts removed:', drafts.count)

const a = await prisma.product.findUnique({ where: { id: AIREON }, select: { description: true, categoryAttributes: true } })
const b = await prisma.product.findUnique({ where: { id: AIRMESH }, select: { description: true } })
console.log('AIREON  description:', JSON.stringify(a?.description), ' material:', JSON.stringify((a?.categoryAttributes as Record<string, unknown>)?.material))
console.log('AIRMESH description:', JSON.stringify(b?.description))
console.log('drafts left in table:', await prisma.productAiDraft.count())
await prisma.$disconnect()
