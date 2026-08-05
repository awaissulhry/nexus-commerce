/** READ-ONLY: what does eBay hold for a single Nero SKU's inventory_item, vs
 * what the LISTING shows? Distinguishes "our PUT didn't replace" from
 * "eBay accumulates at listing level". */
process.env.NEXUS_EBAY_REAL_API = 'true'
const { default: prisma } = await import('../src/db.js')
const { ebayAuthService } = await import('../src/services/ebay-auth.service.js')
const conn = await prisma.channelConnection.findFirst({ where: { channelType: 'EBAY', isActive: true }, select: { id: true } })
const token = await ebayAuthService.getValidToken(conn!.id)
const base = process.env.EBAY_API_BASE || 'https://api.ebay.com'

for (const sku of ['GALE-JACKET-BLACK-MEN-M', 'GALE-JACKET-BLACK-MEN-L', 'GALE-JACKET-YELLOW-MEN-M']) {
  const res = await fetch(`${base}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
    headers: { Authorization: `Bearer ${token}`, 'Accept-Language': 'it-IT', 'Content-Language': 'it-IT', 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_IT' },
  })
  if (!res.ok) { console.log(`${sku}: HTTP ${res.status}`); continue }
  const j = await res.json() as { product?: { imageUrls?: string[] } }
  const urls = j.product?.imageUrls ?? []
  console.log(`\n${sku}: inventory_item has ${urls.length} imageUrls`)
  urls.forEach((u, i) => console.log(`   ${i + 1}. ${u.slice(-58)}`))
}
await prisma.$disconnect()
