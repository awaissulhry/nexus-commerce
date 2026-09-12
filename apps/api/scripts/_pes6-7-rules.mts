import prisma from '../src/db.js'
for (const code of ['DE','IT']) {
  const m = await prisma.marketplace.findUnique({ where: { channel_code: { channel: 'AMAZON', code } }, select: { schemaMapping: true } })
  const sm: any = m?.schemaMapping ?? {}
  console.log(`\n--- AMAZON ${code} ---`)
  console.log('fields (default bucket):', Object.keys(sm.fields ?? {}).length)
  for (const [pt, bucket] of Object.entries<any>(sm.byProductType ?? {})) {
    console.log(`overlay ${pt}: ${Object.keys(bucket).length} rules ->`, Object.keys(bucket).join(', '))
  }
}
await prisma.$disconnect()
