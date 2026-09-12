import prisma from '../src/db.js'
// Did the clone change anything on BE?
const be = await prisma.marketplace.findUnique({ where: { channel_code: { channel: 'AMAZON', code: 'BE' } }, select: { schemaMapping: true } })
const sm: any = be?.schemaMapping ?? {}
console.log('AMAZON·BE fields:', Object.keys(sm.fields ?? {}).length, '| overlays:', Object.keys(sm.byProductType ?? {}))
// WHY nothing landed: does BE have any ChannelSchema rows to land into?
const counts = await prisma.channelSchema.groupBy({ by: ['marketplace'], where: { channel: 'AMAZON' }, _count: { fieldKey: true } })
console.log('\nAMAZON ChannelSchema rows per marketplace:')
for (const c of counts.sort((a,b)=>String(a.marketplace).localeCompare(String(b.marketplace)))) {
  console.log(`  ${String(c.marketplace ?? '(null = all markets)').padEnd(22)} ${c._count.fieldKey}`)
}
const revs = await prisma.mappingRevision.count({ where: { channel: 'AMAZON', code: 'BE' } })
console.log('\nMappingRevision rows on BE (snapshot taken before the clone):', revs)
await prisma.$disconnect()
