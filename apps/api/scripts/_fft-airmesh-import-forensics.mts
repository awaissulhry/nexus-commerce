/** FFT-I3 — read-only forensics: why are currency/product_tax_code EMPTY on
 *  the never-listed AIRMESH sizes while our_price is filled?
 *  Compares a filled row vs a sparse row + parses the vault-captured file. */
const prisma = (await import('../src/db.js')).default

const FILLED = 'AIRMESH-JACKET-BLACK-MEN-M'
const SPARSE = 'AIRMESH-JACKET-BLACK-MEN-4XL'

for (const sku of [FILLED, SPARSE]) {
  const p = await prisma.product.findFirst({
    where: { sku, deletedAt: null },
    select: { id: true, createdAt: true, importedAt: true },
  })
  if (!p) { console.log(`${sku}: NO PRODUCT`); continue }
  const cl = await prisma.channelListing.findFirst({
    where: { productId: p.id, channel: 'AMAZON', marketplace: 'IT' },
    select: { externalListingId: true, isPublished: true, createdAt: true, updatedAt: true, flatFileSnapshot: true, platformAttributes: true },
  })
  if (!cl) { console.log(`${sku}: product ${p.createdAt.toISOString().slice(0, 10)} — NO AMAZON/IT CL`); continue }
  const snap = (cl.flatFileSnapshot ?? {}) as Record<string, unknown>
  const attrs = ((cl.platformAttributes as Record<string, unknown>)?.attributes ?? {}) as Record<string, unknown>
  const keys = Object.keys(snap)
  const interesting = ['purchasable_offer__currency', 'purchasable_offer__our_price', 'purchasable_offer__condition_type', 'product_tax_code', 'merchant_shipping_group', 'fulfillment_availability__quantity']
  console.log(`── ${sku} ──`)
  console.log(`  product created=${p.createdAt.toISOString().slice(0, 16)} importedAt=${p.importedAt ? p.importedAt.toISOString().slice(0, 16) : '-'}`)
  console.log(`  CL asin=${cl.externalListingId ?? '-'} published=${cl.isPublished} clCreated=${cl.createdAt.toISOString().slice(0, 16)} clUpdated=${cl.updatedAt.toISOString().slice(0, 16)}`)
  console.log(`  snapshot keys=${keys.length}`)
  for (const k of interesting) {
    const inSnap = k in snap ? JSON.stringify(snap[k])?.slice(0, 40) : '(ABSENT)'
    const attrKey = k.replace('purchasable_offer__', 'purchasable_offer.').replace('fulfillment_availability__', 'fulfillment_availability.')
    console.log(`    ${k}: snap=${inSnap} | attrs.product_tax_code=${k === 'product_tax_code' ? JSON.stringify(attrs.product_tax_code)?.slice(0, 60) : ''}`)
  }
  const po = attrs.purchasable_offer
  console.log(`  attrs.purchasable_offer=${JSON.stringify(po)?.slice(0, 160) ?? '(absent)'}`)
}

// The vault-captured family file (post-FFT.5a captures only)
const wb = await prisma.amazonFamilyWorkbook.findMany({
  where: { familyKey: { contains: 'AIRMESH' } },
  select: { familyKey: true, marketplace: true, filename: true, rowCount: true, capturedAt: true, bytes: true },
})
if (!wb.length) {
  console.log('vault: NO AIRMESH family workbook captured (import predates FFT.5a or multi-family file)')
} else {
  for (const w of wb) {
    console.log(`vault: ${w.familyKey} ${w.marketplace} ${w.filename} rows=${w.rowCount} captured=${w.capturedAt.toISOString().slice(0, 16)}`)
    const { detectAmazonTemplate } = await import('../src/services/amazon/template-workbook.js')
    const parsed = await detectAmazonTemplate(new Uint8Array(w.bytes))
    if (!parsed) { console.log('  (does not parse as template)'); continue }
    const currencyHeader = parsed.headers.find((h) => /currency$/i.test(h))
    const taxHeader = parsed.headers.find((h) => /product_tax_code/i.test(h))
    const priceHeader = parsed.headers.find((h) => /our_price.*value_with_tax$/i.test(h) || /value_with_tax$/i.test(h))
    const skuHeader = parsed.headers.find((h) => /(^|[.#\]])item_sku$/i.test(h)) ?? 'item_sku'
    console.log(`  headers: sku=${skuHeader} currency=${currencyHeader} tax=${taxHeader} price=${priceHeader}`)
    for (const target of [FILLED, SPARSE, 'AIRMESH-JACKET-YELLOW-MEN-XXS']) {
      const row = (parsed.rows as Array<Record<string, unknown>>).find((r) => String(r[skuHeader] ?? '').trim() === target)
      if (!row) { console.log(`  file row ${target}: NOT IN FILE`); continue }
      console.log(`  file row ${target}: currency='${currencyHeader ? row[currencyHeader] ?? '' : '?'}' tax='${taxHeader ? row[taxHeader] ?? '' : '?'}' price='${priceHeader ? row[priceHeader] ?? '' : '?'}'`)
    }
  }
}
await prisma.$disconnect()
process.exit(0)
