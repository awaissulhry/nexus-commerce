/** READ-ONLY on the DB: generate Seller-Central Price&Quantity upload files
 *  (sku / price-blank / quantity) per marketplace from pool-intended state.
 *  FBA exclusion mirrors the vetted read-back filter, then double-excludes any
 *  SKU that also exists as an FBA listing anywhere (paranoia: a P&Q upload must
 *  never be able to touch an Amazon-managed offer). */
import { mkdirSync, writeFileSync } from 'node:fs'
const { default: prisma } = await import('../src/db.js')

const OUT = `/Users/awais/Desktop/amazon-quantities-2026-07-20`
mkdirSync(OUT, { recursive: true })

// Every SKU that is FBA anywhere — hard exclusion set.
const fbaListings = await prisma.channelListing.findMany({
  where: {
    channel: 'AMAZON',
    OR: [{ fulfillmentMethod: 'FBA' }, { product: { fulfillmentMethod: 'FBA' } }],
  },
  select: { product: { select: { sku: true } } },
})
const fbaSkus = new Set(fbaListings.map((l) => l.product?.sku).filter(Boolean))

// P0 uncounted-guard parity: a product with ZERO warehouse ledger rows was
// never counted — its 0 is "unknown", not truth. The cascade refuses to push
// those; this file must refuse to carry them (an upload row of 0 could zero a
// hand-set Seller Central value — the exact incident class this system bans).
const counted = await prisma.stockLevel.findMany({
  where: { location: { type: 'WAREHOUSE' } },
  select: { productId: true },
  distinct: ['productId'],
})
const countedProducts = new Set(counted.map((c) => c.productId))

const MARKETS = ['IT', 'DE', 'ES'] as const // FR: Amazon report empty — no live FR listings to update
const summary: string[] = []
for (const mp of MARKETS) {
  const rows = await prisma.channelListing.findMany({
    where: {
      channel: 'AMAZON',
      marketplace: mp,
      isPublished: true,
      listingStatus: { notIn: ['ENDED', 'REMOVED'] },
      quantity: { not: null },
      OR: [{ fulfillmentMethod: 'FBM' }, { fulfillmentMethod: null, product: { fulfillmentMethod: { not: 'FBA' } } }],
    },
    select: { quantity: true, productId: true, product: { select: { sku: true, fulfillmentMethod: true } } },
  })
  const lines: string[] = ['sku\tprice\tquantity']
  let skippedFba = 0
  let skippedUncounted = 0
  for (const r of rows) {
    const sku = r.product?.sku
    if (!sku || r.quantity == null) continue
    // Double exclusion: product-level FBA or the SKU appearing as FBA anywhere.
    if (r.product?.fulfillmentMethod === 'FBA' || fbaSkus.has(sku)) {
      skippedFba++
      continue
    }
    if (!countedProducts.has(r.productId)) {
      skippedUncounted++
      continue
    }
    lines.push(`${sku}\t\t${r.quantity}`)
  }
  const file = `${OUT}/amazon-quantity-${mp}.txt`
  writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  summary.push(`${mp}: ${lines.length - 1} SKUs → ${file} (fba-excluded=${skippedFba}, uncounted-excluded=${skippedUncounted})`)
}

writeFileSync(
  `${OUT}/README.txt`,
  [
    'Seller Central quantity upload — generated from the Nexus pool 2026-07-20',
    '',
    'One file per marketplace (IT/DE/ES). Format: Price & Quantity template',
    '(tab-separated: sku, price, quantity; price left blank = unchanged).',
    'FBA SKUs are excluded twice over — these files contain merchant (FBM) offers only.',
    '',
    'Upload per marketplace in Seller Central:',
    '  Catalog/Inventory → Add Products via Upload → Upload your inventory file',
    '  → file type "Price and Quantity" → choose the marketplace → upload the matching file.',
    '',
    'After processing (usually minutes), Manage Inventory shows these quantities.',
    'The Nexus read-back then verifies them against the pool automatically.',
  ].join('\n'),
  'utf8',
)

console.log(summary.join('\n'))
await prisma.$disconnect()
process.exit(0)
