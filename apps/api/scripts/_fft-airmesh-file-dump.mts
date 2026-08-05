/** FFT-I3 — dump the vault-captured AIRMESH file's real structure. */
const prisma = (await import('../src/db.js')).default
const { detectAmazonTemplate } = await import('../src/services/amazon/template-workbook.js')

const w = await prisma.amazonFamilyWorkbook.findFirst({
  where: { familyKey: { contains: 'AIRMESH' } },
  select: { familyKey: true, filename: true, bytes: true, capturedAt: true },
})
if (!w) { console.log('no vault file'); process.exit(0) }
const parsed = await detectAmazonTemplate(new Uint8Array(w.bytes))
if (!parsed) { console.log('unparseable'); process.exit(0) }
console.log(`file=${w.filename} captured=${w.capturedAt.toISOString()}`)
console.log(`meta=${JSON.stringify({ ...parsed.meta, labels: undefined }).slice(0, 300)}`)
console.log(`headers=${parsed.headers.length}`)
const interesting = parsed.headers.filter((h) => /sku|price|currency|tax|quantity|merchant|parent/i.test(h))
console.log('interesting headers:')
for (const h of interesting) console.log(`  ${h}`)
const rows = parsed.rows as Array<Record<string, unknown>>
console.log(`rows=${rows.length}; first row non-empty cells:`)
const r0 = rows[0] ?? {}
for (const [k, v] of Object.entries(r0)) {
  const s = String(v ?? '').trim()
  if (s) console.log(`  ${k} = ${s.slice(0, 60)}`)
}
console.log('row 5 (child) non-empty sku/price/tax/currency-ish:')
const r5 = rows[5] ?? {}
for (const [k, v] of Object.entries(r5)) {
  if (!/sku|price|currency|tax|quantity/i.test(k)) continue
  console.log(`  ${k} = ${String(v ?? '').slice(0, 60)}`)
}
await prisma.$disconnect()
process.exit(0)
