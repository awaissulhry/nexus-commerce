/**
 * P0 RESTORE — Amazon FBM zero-inventory repair (2026-07-20).
 *
 * Root causes measured: (1) Amazon-first families' stock never entered the
 * WAREHOUSE ledger (pool=0 → our pushes carried 0); (2) rows imported from
 * live Amazon listings sat isPublished=false, so dispatch skipped their
 * pushes entirely.
 *
 * This script: parses the owner's OWN Amazon .xlsm files (Desktop LISTNGS
 * tree) → per-SKU quantities → seeds the ledger ONLY where the product's
 * ledger quantity is 0 and the file says >0 (additive-only; a positive pool
 * is owner-counted truth and is never touched) → marks Amazon rows whose
 * listingStatus came from Amazon (ACTIVE/BUYABLE/DISCOVERABLE) as
 * isPublished=true → recascades every touched product so real quantities
 * push out. DRY-RUN default; --apply executes. Fully audited via
 * StockMovement reason STOCKLEVEL_BACKFILL + notes carrying the source file.
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
const apply = process.argv.includes('--apply')
const { default: prisma } = await import('../src/db.js')
const { detectAmazonTemplate } = await import('../src/services/amazon/template-workbook.js')

const ROOT = '/Users/awais/Desktop/2026/LISTNGS/JACKETS'
const QTY_RE = /^fulfillment_availability\b.*\.quantity$/
const SKU_RES = [/^contribution_sku#?\d*\.value$/, /^item_sku$/]
const CHANNEL_RE = /^fulfillment_availability\b.*channel_code$/
const FBA_RE = /amazon|amzn|afn/i

const files: string[] = []
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('~$') || name.startsWith('.')) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (/BLANK TEMPLATES/i.test(name)) continue
      walk(p)
    } else if (/\.xlsm$/i.test(name) && /amazon/i.test(p)) {
      files.push(p)
    }
  }
}
walk(ROOT)
console.log(`Amazon workbooks found: ${files.length}`)

const truth = new Map<string, { qty: number; src: string }>()
for (const f of files) {
  try {
    const parsed = await detectAmazonTemplate(new Uint8Array(readFileSync(f)))
    if (!parsed) { console.log(`  (not an Amazon template) ${f}`); continue }
    const skuH = parsed.headers.find((h: string) => SKU_RES.some((re) => re.test(h)))
    const qtyH = parsed.headers.find((h: string) => QTY_RE.test(h))
    const chH = parsed.headers.find((h: string) => CHANNEL_RE.test(h))
    if (!skuH || !qtyH) { console.log(`  (no sku/qty headers) ${f.split('/').slice(-2).join('/')}`); continue }
    let picked = 0
    for (const row of parsed.rows as Array<Record<string, unknown>>) {
      const sku = String(row[skuH] ?? '').trim()
      const qty = Math.trunc(Number(row[qtyH] ?? NaN))
      const ch = String(chH ? row[chH] ?? '' : '')
      if (!sku || Number.isNaN(qty) || qty <= 0) continue
      if (FBA_RE.test(ch)) continue // FBA rows: Amazon-managed, never seed warehouse
      const cur = truth.get(sku)
      if (!cur || qty > cur.qty) truth.set(sku, { qty, src: f.split('/').slice(-2).join('/') })
      picked++
    }
    console.log(`  parsed ${f.split('/').slice(-3).join('/')} → ${picked} qty rows`)
  } catch (err) {
    console.log(`  PARSE FAIL ${f.split('/').slice(-2).join('/')}: ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`)
  }
}
console.log(`distinct SKUs with file quantities: ${truth.size}`)

// Current ledger per product
const products = await prisma.product.findMany({
  where: { sku: { in: [...truth.keys()] } },
  select: { id: true, sku: true, totalStock: true, fulfillmentMethod: true },
})
const bySku = new Map(products.map((p) => [p.sku, p]))
const ledger = await prisma.stockLevel.groupBy({
  by: ['productId'],
  where: { productId: { in: products.map((p) => p.id) }, location: { type: 'WAREHOUSE' } },
  _sum: { quantity: true },
})
const ledgerBy = new Map(ledger.map((l) => [l.productId, l._sum.quantity ?? 0]))

const seeds: Array<{ sku: string; productId: string; qty: number; src: string }> = []
let skippedCounted = 0, skippedFba = 0, missingProduct = 0
for (const [sku, t] of truth) {
  const p = bySku.get(sku)
  if (!p) { missingProduct++; continue }
  if (String(p.fulfillmentMethod ?? '').toUpperCase() === 'FBA') { skippedFba++; continue }
  const cur = ledgerBy.get(p.id) ?? 0
  if (cur > 0) { skippedCounted++; continue } // owner-counted pool — untouchable
  seeds.push({ sku, productId: p.id, qty: t.qty, src: t.src })
}
console.log(`\nseed plan: ${seeds.length} products (ledger=0 → file qty) | skipped: counted-pool=${skippedCounted} fba=${skippedFba} product-missing=${missingProduct}`)
const famAgg = new Map<string, { n: number; units: number }>()
for (const s of seeds) {
  const f = (s.sku.match(/^([A-Za-z]+)/)?.[1] ?? s.sku).toUpperCase()
  const a = famAgg.get(f) ?? { n: 0, units: 0 }
  a.n++; a.units += s.qty
  famAgg.set(f, a)
}
for (const [f, a] of [...famAgg.entries()].sort((x, y) => y[1].n - x[1].n)) console.log(`  ${f}: ${a.n} SKUs, ${a.units} units`)
for (const s of seeds.slice(0, 8)) console.log(`  e.g. ${s.sku} → ${s.qty} (${s.src})`)

// Publish-flag repair set
const unpublished = await prisma.channelListing.findMany({
  where: {
    channel: 'AMAZON', isPublished: false,
    listingStatus: { in: ['ACTIVE', 'BUYABLE', 'DISCOVERABLE'] },
  },
  select: { id: true, productId: true },
})
console.log(`\nisPublished=false rows with live-on-Amazon status: ${unpublished.length} → will set isPublished=true`)

if (!apply) { console.log('\nDRY-RUN — --apply to execute.'); await prisma.$disconnect(); process.exit(0) }

const { applyStockMovement, recascadeProduct } = await import('../src/services/stock-movement.service.js')

let seeded = 0, seedFail = 0
for (const s of seeds) {
  try {
    await applyStockMovement({
      productId: s.productId,
      change: s.qty,
      reason: 'STOCKLEVEL_BACKFILL',
      referenceType: 'P0_ZERO_RESTORE',
      referenceId: s.sku,
      actor: 'p0-restore-stock',
      notes: `restore from owner file ${s.src} (Amazon FBM zero-inventory incident 2026-07-20)`,
    })
    seeded++
  } catch (err) {
    seedFail++
    console.log(`  seed FAIL ${s.sku}: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`)
  }
}
console.log(`seeded: ${seeded} ok, ${seedFail} failed`)

const pub = await prisma.channelListing.updateMany({
  where: { id: { in: unpublished.map((u) => u.id) } },
  data: { isPublished: true },
})
console.log(`isPublished repaired: ${pub.count}`)

// Recascade every touched product (publish-repaired ∪ seeded — seeded already
// cascaded inside applyStockMovement; the publish-repaired need one).
const touched = [...new Set(unpublished.map((u) => u.productId))]
let rc = 0, rcRefused = 0, rcFail = 0
for (const pid of touched) {
  try {
    const r = await recascadeProduct(pid, { reason: 'SYNC_RECONCILIATION', referenceType: 'P0_ZERO_RESTORE', actor: 'p0-restore-stock' })
    if (r.ok === false) rcRefused++
    else rc++
  } catch { rcFail++ }
}
console.log(`recascaded: ${rc} ok, refused(NO_LEDGER)=${rcRefused}, failed=${rcFail}`)
await prisma.$disconnect()
process.exit(0)
