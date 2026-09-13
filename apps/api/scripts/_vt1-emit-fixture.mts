/** VT.1 — emit the REAL OUTERWEAR theme facts as a TypeScript fixture for the unit tests. Read-only. */
const url = process.argv[2]
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient({ datasources: { db: { url } } })
const out: string[] = []
for (const mk of ['IT', 'DE']) {
  const r = (await p.$queryRawUnsafe<any[]>(`SELECT "schemaDefinition" def, "fetchedAt" FROM "CategorySchema" WHERE channel='AMAZON' AND "productType"='OUTERWEAR' AND "marketplace"=$1 ORDER BY "fetchedAt" DESC LIMIT 1`, mk))[0]
  const props = r.def?.properties ?? {}
  const name = props?.variation_theme?.items?.properties?.name ?? {}
  const titles: Record<string, { title?: string }> = {}
  for (const k of Object.keys(props)) {
    if (k.startsWith('__')) continue
    const t = props[k]?.title
    titles[k] = typeof t === 'string' ? { title: t } : {}
  }
  out.push(`export const OUTERWEAR_${mk} = {`)
  out.push(`  fetchedAt: ${JSON.stringify(r.fetchedAt.toISOString())},`)
  out.push(`  themes: ${JSON.stringify(name.enum ?? [])},`)
  out.push(`  deprecated: ${JSON.stringify(name.$lifecycle?.enumDeprecated ?? [])},`)
  out.push(`  propertyNames: ${JSON.stringify(Object.keys(titles))},`)
  out.push(`  properties: ${JSON.stringify(titles)},`)
  out.push(`} as const`)
}
console.log(out.join('\n'))
await p.$disconnect()
