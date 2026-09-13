const url = process.argv[2]
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient({ datasources: { db: { url } } })
const r = (await p.$queryRawUnsafe<any[]>(`SELECT "schemaDefinition" def FROM "CategorySchema" WHERE channel='AMAZON' AND "productType"='OUTERWEAR' AND "marketplace"='IT' ORDER BY "fetchedAt" DESC LIMIT 1`))[0]
const nm = r.def?.properties?.variation_theme?.items?.properties?.name
console.log('$lifecycle:', JSON.stringify(nm.$lifecycle).slice(0, 1200))
console.log('description:', JSON.stringify(nm.description))
console.log('hidden/editable:', nm.hidden, nm.editable)
await p.$disconnect()
