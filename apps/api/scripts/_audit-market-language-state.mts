/** READ-ONLY audit: per-market aspect key language state. NO WRITES. */
const { default: prisma } = await import('../src/db.js')

const out: string[] = []
const p = (s: string) => out.push(s)

// ── 1. SharedListingMembership ───────────────────────────────────────────
const mems = await prisma.sharedListingMembership.findMany({
  select: { id: true, marketplace: true, sku: true, itemId: true, parentSku: true, status: true, productId: true, variationSpecifics: true, flatFileSnapshot: true },
})
p(`\n===== SharedListingMembership: ${mems.length} rows =====`)

type Agg = Map<string, { rows: number; skus: Set<string>; items: Set<string> }>
const memSnapKeys: Map<string, Agg> = new Map()
const memVarSpecKeys: Map<string, Agg> = new Map()

const bump = (m: Map<string, Agg>, mkt: string, key: string, sku: string, item: string) => {
  if (!m.has(mkt)) m.set(mkt, new Map())
  const a = m.get(mkt)!
  if (!a.has(key)) a.set(key, { rows: 0, skus: new Set(), items: new Set() })
  const e = a.get(key)!
  e.rows++; e.skus.add(sku); e.items.add(item)
}

for (const m of mems) {
  const snap = (m.flatFileSnapshot ?? {}) as Record<string, unknown>
  for (const k of Object.keys(snap)) if (k.startsWith('aspect_')) bump(memSnapKeys, m.marketplace, k, m.sku, m.itemId)
  const vs = (m.variationSpecifics ?? {}) as Record<string, unknown>
  for (const k of Object.keys(vs)) bump(memVarSpecKeys, m.marketplace, k, m.sku, m.itemId)
}

for (const [mkt, agg] of [...memSnapKeys].sort()) {
  p(`\n-- [SLM.flatFileSnapshot] marketplace=${mkt}`)
  for (const [k, e] of [...agg].sort((a, b) => b[1].rows - a[1].rows)) {
    p(`   ${k.padEnd(40)} rows=${String(e.rows).padStart(4)} items=${e.items.size} itemIds=[${[...e.items].slice(0, 8).join(',')}]`)
  }
}
for (const [mkt, agg] of [...memVarSpecKeys].sort()) {
  p(`\n-- [SLM.variationSpecifics] marketplace=${mkt}`)
  for (const [k, e] of [...agg].sort((a, b) => b[1].rows - a[1].rows)) {
    p(`   ${k.padEnd(40)} rows=${String(e.rows).padStart(4)} items=${e.items.size} itemIds=[${[...e.items].slice(0, 8).join(',')}]`)
  }
}

// ── 2. ChannelListing (eBay) ─────────────────────────────────────────────
const cls = await prisma.channelListing.findMany({
  where: { channel: 'EBAY' },
  select: {
    id: true, marketplace: true, region: true, channelMarket: true, productId: true,
    externalListingId: true, listingStatus: true, variationTheme: true,
    flatFileSnapshot: true, platformAttributes: true,
    product: { select: { sku: true, name: true, variationTheme: true, masterSku: true, isParent: true, parentId: true } },
  },
})
p(`\n\n===== ChannelListing(EBAY): ${cls.length} rows =====`)

const clSnapKeys: Map<string, Agg> = new Map()
const clSpecKeys: Map<string, Agg> = new Map()
for (const c of cls) {
  const sku = c.product?.sku ?? '(no product)'
  const snap = (c.flatFileSnapshot ?? {}) as Record<string, unknown>
  for (const k of Object.keys(snap)) if (k.startsWith('aspect_')) bump(clSnapKeys, c.marketplace, k, sku, c.externalListingId ?? '')
  const pa = (c.platformAttributes ?? {}) as Record<string, unknown>
  const isp = pa.itemSpecifics
  if (isp && typeof isp === 'object' && !Array.isArray(isp)) {
    for (const k of Object.keys(isp as Record<string, unknown>)) bump(clSpecKeys, c.marketplace, k, sku, c.externalListingId ?? '')
  } else if (Array.isArray(isp)) {
    for (const it of isp as Array<Record<string, unknown>>) {
      const n = String((it?.name ?? it?.Name ?? '') as string)
      if (n) bump(clSpecKeys, c.marketplace, n, sku, c.externalListingId ?? '')
    }
  }
}
for (const [mkt, agg] of [...clSnapKeys].sort()) {
  p(`\n-- [CL.flatFileSnapshot] marketplace=${mkt}`)
  for (const [k, e] of [...agg].sort((a, b) => b[1].rows - a[1].rows)) {
    p(`   ${k.padEnd(40)} rows=${String(e.rows).padStart(4)} skus=[${[...e.skus].slice(0, 10).join(', ')}]`)
  }
}
for (const [mkt, agg] of [...clSpecKeys].sort()) {
  p(`\n-- [CL.platformAttributes.itemSpecifics] marketplace=${mkt}`)
  for (const [k, e] of [...agg].sort((a, b) => b[1].rows - a[1].rows)) {
    p(`   ${k.padEnd(40)} rows=${String(e.rows).padStart(4)} skus=[${[...e.skus].slice(0, 10).join(', ')}]`)
  }
}

await prisma.$disconnect()
console.log(out.join('\n'))
