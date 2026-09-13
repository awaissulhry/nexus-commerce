/** VT.1 — the eBay precedence characterisation baseline: every PARENT listing's declared set, both readers. Read-only. */
const url = process.argv[2]
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient({ datasources: { db: { url } } })
const q = <T = any>(s: string, ...a: unknown[]) => p.$queryRawUnsafe<T[]>(s, ...a)
const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x))
const split = (v: unknown): string[] => {
  if (typeof v !== 'string') return []
  const out: string[] = []; const seen = new Set<string>()
  for (const raw of v.split(/[,/|;]/)) { const n = raw.trim(); if (!n) continue; const k = n.toLowerCase(); if (seen.has(k)) continue; seen.add(k); out.push(n); if (out.length >= 5) break }
  return out
}
const rows = await q(`SELECT pr.sku, pr."variationTheme" product_theme, cl."variationTheme" listing_theme, cl.id listing_id, cl."marketplace", cl."aliasId", cl."listingStatus", cl."externalListingId",
    cl."platformAttributes"->'_variationAxes' own_axes, cl."platformAttributes"->'_axisNameLabels' name_labels
  FROM "ChannelListing" cl JOIN "Product" pr ON pr.id = cl."productId"
  WHERE cl.channel='EBAY' AND pr."parentId" IS NULL ORDER BY pr.sku, cl."marketplace"`)
let same = 0, differ = 0, onlyProduct = 0, onlyOwn = 0, neither = 0
const diffs: string[] = []
for (const r of rows) {
  const own = Array.isArray(r.own_axes) ? (r.own_axes as unknown[]).filter((x) => typeof x === 'string' && x.trim()) as string[] : []
  const prod = split(r.product_theme)
  const today = prod.length > 0 ? prod : own            // readStoredMapping / push service today
  const after = own.length > 0 ? own : prod             // the flip
  if (own.length === 0 && prod.length === 0) { neither++; continue }
  if (own.length === 0) { onlyProduct++; continue }
  if (prod.length === 0) { onlyOwn++; continue }
  if (today.join('|') === after.join('|')) same++
  else { differ++; diffs.push(`${r.sku} ${r.marketplace} alias=${r.aliasId ?? ''} status=${r.listingStatus} id=${r.externalListingId ?? '-'} today=${j(today)} after=${j(after)}`) }
}
console.log(`eBay PARENT listing rows: ${rows.length}`)
console.log(`both stores present and IDENTICAL after the flip: ${same}`)
console.log(`both present and DIFFERENT after the flip: ${differ}`)
console.log(`product theme only (flip is a no-op): ${onlyProduct}`)
console.log(`coordinate axes only (flip is a no-op, and today's reader already falls back to them): ${onlyOwn}`)
console.log(`neither store set: ${neither}`)
for (const d of diffs) console.log('  DIFFERS: ' + d)

// ── the FAMILY-AXES read (ebay-family-axes.service.ts:232) — listing column first, then product, then own ──
let axSame = 0; const axDiff: string[] = []
for (const r of rows) {
  const own = Array.isArray(r.own_axes) ? (r.own_axes as unknown[]).filter((x) => typeof x === 'string' && x.trim()) as string[] : []
  const prod = split(r.product_theme)
  const lst = split(r.listing_theme)
  const todayRead = lst.length > 0 ? lst : prod.length > 0 ? prod : own     // family-axes TODAY
  const afterRead = own.length > 0 ? own : prod                             // the unified rule
  if (todayRead.join('|') === afterRead.join('|')) axSame++
  else axDiff.push(`${r.sku} ${r.marketplace} status=${r.listingStatus} id=${r.externalListingId ?? '-'} listingCol=${j(r.listing_theme)} today=${j(todayRead)} after=${j(afterRead)}`)
}
console.log(`\nFAMILY-AXES read: identical after the flip on ${axSame} of ${rows.length} rows; CHANGES on ${axDiff.length}`)
for (const d of axDiff) console.log('  READ CHANGES: ' + d)

console.log('\nfull table:')
for (const r of rows) {
  const own = Array.isArray(r.own_axes) ? r.own_axes : null
  console.log(`  ${r.sku} ${r.marketplace} status=${r.listingStatus} product=${j(r.product_theme)} own=${j(own)} names=${j(r.name_labels)}`)
}
await p.$disconnect()
