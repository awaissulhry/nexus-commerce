const url = process.argv[2]
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient({ datasources: { db: { url } } })
for (const mk of ['IT','DE']) {
  const r = (await p.$queryRawUnsafe<any[]>(`SELECT "schemaDefinition" def FROM "CategorySchema" WHERE channel='AMAZON' AND "productType"='OUTERWEAR' AND "marketplace"=$1 ORDER BY "fetchedAt" DESC LIMIT 1`, mk))[0]
  const req = r.def?.required ?? []
  console.log(mk, 'root.required:', JSON.stringify(req), '| contains variation_theme:', req.includes('variation_theme'))
}
await p.$disconnect()
