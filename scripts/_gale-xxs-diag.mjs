import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'; import { fileURLToPath } from 'node:url'; import { dirname, join } from 'node:path'
config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })
const p = new PrismaClient()
const J = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v } catch { return v } }

// 1) The Gale Jacket family
const fam = await p.product.findMany({
  where: { OR: [{ sku: { contains: 'GALE', mode: 'insensitive' } }, { name: { contains: 'Gale', mode: 'insensitive' } }], deletedAt: null },
  select: { id: true, sku: true, name: true, isParent: true, parentId: true, variationTheme: true, variantAttributes: true, categoryAttributes: true, fulfillmentMethod: true, amazonAsin: true, parentAsin: true, fnsku: true, status: true },
  orderBy: { sku: 'asc' },
})
console.log(`═══ Gale family: ${fam.length} products ═══`)
for (const x of fam) {
  const va = J(x.variantAttributes) || {}
  const cv = (J(x.categoryAttributes) || {}).variations || {}
  const size = va.Size ?? cv.Size ?? '—'
  const color = va.Color ?? cv.Color ?? '—'
  console.log(`${x.isParent ? '▣PARENT' : ' child '} ${x.sku.padEnd(28)} sz=${String(size).padEnd(5)} col=${String(color).padEnd(8)} asin=${x.amazonAsin ?? '—'} fnsku=${x.fnsku ?? '—'} fulfil=${x.fulfillmentMethod ?? '—'} parentId=${x.parentId ? x.parentId.slice(-6) : '—'} status=${x.status}`)
}

// 2) Focus: XXS variants (by size attr OR sku)
const xxs = fam.filter((x) => {
  const va = J(x.variantAttributes) || {}; const cv = (J(x.categoryAttributes) || {}).variations || {}
  return String(va.Size ?? cv.Size ?? '').toUpperCase() === 'XXS' || /XXS/i.test(x.sku)
})
console.log(`\n═══ XXS variant(s): ${xxs.length} ═══`)
for (const x of xxs) {
  console.log(`\n── ${x.sku} (id …${x.id.slice(-6)}) ──`)
  console.log(`   variantAttributes: ${JSON.stringify(J(x.variantAttributes))}`)
  console.log(`   categoryAttributes.variations: ${JSON.stringify((J(x.categoryAttributes)||{}).variations)}`)
  const listings = await p.channelListing.findMany({
    where: { productId: x.id, channel: 'AMAZON' },
    select: { marketplace: true, listingStatus: true, externalListingId: true, isPublished: true, platformAttributes: true, updatedAt: true },
  })
  for (const l of listings) {
    const attrs = (J(l.platformAttributes) || {}).attributes || {}
    const sizeAttr = JSON.stringify(attrs.size ?? attrs.apparel_size ?? attrs.size_name ?? '—')
    console.log(`   listing[${l.marketplace}] status=${l.listingStatus} pub=${l.isPublished} extId=${l.externalListingId ?? '—'} sizeAttr=${sizeAttr}`)
  }
  const issues = await p.listingIssue.findMany({ where: { channelListing: { productId: x.id }, resolvedAt: null }, select: { code: true, severity: true, message: true, attributeNames: true } }).catch(() => [])
  for (const i of issues) console.log(`   ISSUE [${i.severity}] ${i.code}: ${i.message} {${(i.attributeNames||[]).join(',')}}`)
  const sup = await p.amazonSuppression.findMany({ where: { channelListing: { productId: x.id }, resolvedAt: null }, select: { reasonCode: true, reasonText: true, severity: true } }).catch(() => [])
  for (const s of sup) console.log(`   SUPPRESSION [${s.severity}] ${s.reasonCode}: ${s.reasonText}`)
}

// 3) Recent feed jobs touching any Gale SKU — the actual submit error
const allSkus = new Set(fam.map((x) => x.sku))
const jobs = await p.amazonFlatFileFeedJob.findMany({ orderBy: { submittedAt: 'desc' }, take: 40, select: { feedId: true, marketplace: true, status: true, skus: true, resultSummary: true, perSkuResults: true, errorMessage: true, submittedAt: true } })
console.log(`\n═══ Recent feed jobs touching a Gale SKU ═══`)
let shown = 0
for (const j of jobs) {
  const js = J(j.skus) || []
  const hit = js.filter((s) => allSkus.has(s) || /GALE/i.test(String(s)))
  if (!hit.length) continue
  shown++
  console.log(`\nfeed ${j.feedId} [${j.marketplace}] ${j.status} @ ${new Date(j.submittedAt).toISOString().slice(0,16)}  skus=${hit.join(',')}`)
  if (j.errorMessage) console.log(`  FATAL: ${j.errorMessage}`)
  console.log(`  summary: ${JSON.stringify(J(j.resultSummary))}`)
  const psr = J(j.perSkuResults) || []
  for (const r of psr.filter((r) => /GALE/i.test(String(r.sku)) && r.status !== 'success')) {
    console.log(`  ✗ ${r.sku} [${r.status}] ${r.code ?? ''}: ${r.message ?? ''}`)
  }
  if (shown >= 6) break
}
if (!shown) console.log('  (no recent feed jobs reference a Gale SKU)')
await p.$disconnect()
