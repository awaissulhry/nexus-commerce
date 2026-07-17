// FFC end-to-end verification against the REAL prod schema, in a transaction that
// ROLLS BACK so nothing persists. Uses the actual buildProductCreateInput from
// the built dist. Proves the new create logic produces schema-valid, accurate
// records across every product-edit tab's data source.
import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
config({ path: join(here, '..', '.env') })
const { buildProductCreateInput } = await import('../apps/api/dist/services/amazon/flat-file.service.js')
const prisma = new PrismaClient()

const ts = Date.now()
const standalone = {
  item_sku: `FFC-TEST-STD-${ts}`, item_name: 'FFC Test Jacket', brand: 'Xavia', manufacturer: 'Xavia Srl',
  product_type: 'OUTERWEAR', purchasable_offer__our_price: '129,90', fulfillment_availability__quantity: '5',
  gtin: '4006381333931', main_product_image_locator: 'https://example.com/main.jpg',
  other_product_image_locator_1: 'https://example.com/alt1.jpg',
  bullet_point_1: 'Waterproof', bullet_point_2: 'CE armor', product_description: 'Test description',
}
const parent = { item_sku: `FFC-TEST-PAR-${ts}`, item_name: 'FFC Test Parent', product_type: 'OUTERWEAR', parentage_level: 'parent', variation_theme: 'SIZE_COLOR' }
const child = { item_sku: `FFC-TEST-CHD-${ts}`, item_name: 'FFC Test Child', product_type: 'OUTERWEAR', parentage_level: 'child', parent_sku: parent.item_sku, color: 'Black', apparel_size: 'XL', purchasable_offer__our_price: '99,90', fulfillment_availability__quantity: '3' }

async function createProduct(tx, row, opts) {
  const p = await tx.product.create({ data: { ...buildProductCreateInput(row, opts), importedAt: new Date() } })
  // mirror createProductImagesFromRow
  const urls = []
  const main = String(row.main_product_image_locator ?? '').trim(); if (main) urls.push(main)
  for (let i = 1; i <= 8; i++) { const u = String(row[`other_product_image_locator_${i}`] ?? '').trim(); if (u && !urls.includes(u)) urls.push(u) }
  if (urls.length) await tx.productImage.createMany({ data: urls.map((url, idx) => ({ productId: p.id, url, type: idx === 0 ? 'MAIN' : 'ALT', isPrimary: idx === 0, sortOrder: idx })) })
  return p
}

const checks = []
const ck = (name, ok) => checks.push([name, !!ok])

try {
  await prisma.$transaction(async (tx) => {
    const std = await createProduct(tx, standalone, { languageTag: 'it_IT' })
    const par = await createProduct(tx, parent, { languageTag: 'it_IT' })
    const chd = await createProduct(tx, child, { languageTag: 'it_IT', parentId: par.id })

    const stdBack = await tx.product.findUnique({ where: { id: std.id }, include: { images: true } })
    const parBack = await tx.product.findUnique({ where: { id: par.id } })
    const chdBack = await tx.product.findUnique({ where: { id: chd.id } })

    // Standalone — Master/Pricing/Images/Locales tab sources
    ck('standalone exists + name', stdBack?.name === 'FFC Test Jacket')
    ck('standalone basePrice (129,90→129.9)', Number(stdBack.basePrice) === 129.9)
    ck('standalone totalStock', stdBack.totalStock === 5)
    ck('standalone brand/manufacturer', stdBack.brand === 'Xavia' && stdBack.manufacturer === 'Xavia Srl')
    ck('standalone gtin', stdBack.gtin === '4006381333931')
    ck('standalone productType', stdBack.productType === 'OUTERWEAR')
    ck('standalone bulletPoints', Array.isArray(stdBack.bulletPoints) && stdBack.bulletPoints.length === 2)
    ck('standalone localizedContent.it.name (Locales tab)', stdBack.localizedContent?.it?.name === 'FFC Test Jacket')
    ck('standalone importSource', stdBack.importSource === 'FLAT_FILE')
    ck('standalone images: 1 MAIN(primary) + 1 ALT (Images tab)', stdBack.images.length === 2 && stdBack.images.find((i) => i.type === 'MAIN' && i.isPrimary) && stdBack.images.find((i) => i.type === 'ALT'))

    // Parent — Variations/Matrix tab sources
    ck('parent isParent=true', parBack.isParent === true)
    ck('parent variationAxes [Size,Color]', JSON.stringify(parBack.variationAxes) === JSON.stringify(['Size', 'Color']))

    // Child — Variations/Matrix + variant accuracy
    ck('child parentId links to parent', chdBack.parentId === par.id)
    ck('child isMasterProduct=false', chdBack.isMasterProduct === false)
    ck('child variantAttributes {Color:Black,Size:XL}', chdBack.variantAttributes?.Color === 'Black' && chdBack.variantAttributes?.Size === 'XL')
    ck('child categoryAttributes.variations mirror (legacy readers)', chdBack.categoryAttributes?.variations?.Color === 'Black' && chdBack.categoryAttributes?.variations?.Size === 'XL')

    throw new Error('__ROLLBACK__')
  }, { timeout: 20000 })
} catch (e) {
  if (e.message !== '__ROLLBACK__') console.error('\nTX ERROR (not a rollback):', e.message)
}

let pass = 0, fail = 0
for (const [name, ok] of checks) { console.log(`  ${ok ? '✓' : '✗'} ${name}`); ok ? pass++ : fail++ }
console.log(`\n${pass} passed, ${fail} failed — rolled back, nothing persisted in prod.`)
await prisma.$disconnect()
process.exitCode = fail ? 1 : 0
