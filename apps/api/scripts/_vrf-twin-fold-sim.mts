/**
 * READ-ONLY verification: apply canonicalizeRowAspects to the ACTUAL stored
 * snapshots and see which English twin keys SURVIVE the GET-side fold.
 */
const { default: prisma } = await import('../src/db.js')
const { canonicalizeRowAspects } = await import('../src/services/ebay-theme-axes.js')

const TWIN_EN = ['aspect_Color','aspect_Size','aspect_Brand','aspect_Colour','aspect_Season','aspect_Style','aspect_Material','aspect_Gender','aspect_Department','aspect_Fit','aspect_Condition','aspect_Jacket_type','aspect_Product_type']

const survivors = new Map<string, number>()
const foldedAway = new Map<string, number>()

function run(label: string, row: Record<string, unknown>) {
  const before = Object.keys(row).filter(k => TWIN_EN.includes(k))
  if (!before.length) return
  canonicalizeRowAspects(row)
  const after = Object.keys(row).filter(k => TWIN_EN.includes(k))
  for (const k of before) {
    const key = `${label}::${k}`
    if (after.includes(k)) survivors.set(key, (survivors.get(key) ?? 0) + 1)
    else foldedAway.set(key, (foldedAway.get(key) ?? 0) + 1)
  }
}

// ── SLM (Lane B) ──
const mems = await prisma.sharedListingMembership.findMany({
  select: { marketplace: true, parentSku: true, sku: true, flatFileSnapshot: true },
})
for (const m of mems) {
  const s = m.flatFileSnapshot
  if (!s || typeof s !== 'object') continue
  run(`SLM ${m.marketplace}/${m.parentSku}`, { ...(s as Record<string, unknown>) })
}

// ── CL (Lane A): snapshot AND the itemSpecifics-derived row (buildFlatRow) ──
const cls = await prisma.channelListing.findMany({
  where: { channel: 'EBAY' },
  select: { marketplace: true, platformAttributes: true, flatFileSnapshot: true, product: { select: { sku: true } } },
})
for (const c of cls) {
  const s = c.flatFileSnapshot
  if (s && typeof s === 'object') run(`CL-snap ${c.marketplace}/${c.product?.sku}`, { ...(s as Record<string, unknown>) })
  const pa = c.platformAttributes as any
  const isp = pa?.itemSpecifics
  if (isp && typeof isp === 'object' && !Array.isArray(isp)) {
    // reproduce buildFlatRow's itemSpecifics → aspect_ emission
    const row: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(isp as Record<string, unknown>)) {
      if (!k) continue
      row[`aspect_${k.replace(/\s+/g, '_')}`] = v
    }
    run(`CL-isp ${c.marketplace}/${c.product?.sku}`, row)
  }
}

console.log('\n════ TWIN KEYS THAT SURVIVE THE GET FOLD (operator-visible ghost columns) ════')
for (const [k, n] of [...survivors.entries()].sort()) console.log(`  SURVIVES  ${k}  (rows=${n})`)
console.log(`\n  total surviving twin occurrences: ${[...survivors.values()].reduce((a,b)=>a+b,0)}`)

console.log('\n════ TWIN KEYS FOLDED AWAY (invisible to the operator) ════')
for (const [k, n] of [...foldedAway.entries()].sort()) console.log(`  folded    ${k}  (rows=${n})`)
console.log(`\n  total folded twin occurrences: ${[...foldedAway.values()].reduce((a,b)=>a+b,0)}`)

await prisma.$disconnect()
