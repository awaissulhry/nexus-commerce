/** FFT-I3 — per-row file truth for the columns the operator reports partial. */
const prisma = (await import('../src/db.js')).default
const { detectAmazonTemplate } = await import('../src/services/amazon/template-workbook.js')

const w = await prisma.amazonFamilyWorkbook.findFirst({
  where: { familyKey: { contains: 'AIRMESH' } },
  select: { bytes: true },
})
if (!w) { console.log('no vault file'); process.exit(0) }
const parsed = await detectAmazonTemplate(new Uint8Array(w.bytes))!
if (!parsed) { console.log('unparseable'); process.exit(0) }
const H = parsed.headers
const h = (re: RegExp) => H.find((x) => re.test(x)) ?? ''
const SKU = h(/^contribution_sku/)
const TAX = h(/^product_tax_code/)
const OUR = h(/purchasable_offer.*our_price.*value_with_tax$/)
const LIST = h(/^list_price.*value_with_tax$/)
const SHIP = h(/^merchant_shipping_group/)
const QTY = h(/^fulfillment_availability#1\.quantity$/)
const REL = h(/^merchant_release_date/)
console.log(`cols: TAX=${!!TAX} OUR=${!!OUR} LIST=${!!LIST} SHIP=${!!SHIP} QTY=${!!QTY} REL=${!!REL}`)
for (const r of parsed.rows as Array<Record<string, unknown>>) {
  const v = (k: string) => String(r[k] ?? '').trim().slice(0, 24)
  console.log(`${v(SKU).padEnd(32)} tax='${v(TAX)}' our='${v(OUR)}' list='${v(LIST)}' ship='${v(SHIP).slice(0, 12)}' qty='${v(QTY)}' rel='${v(REL)}'`)
}
await prisma.$disconnect()
process.exit(0)
