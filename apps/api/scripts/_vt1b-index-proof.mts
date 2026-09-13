/**
 * VT.1b items 3+4 — the end-to-end proof, on the LOCAL Docker DB only.
 *
 *   cd apps/api && npx tsx scripts/_vt1b-index-proof.mts [API_BASE]
 *
 * A fixture write creates a COLLISION on `VX-TEST-3AX` (announced in the ledger), the index is rebuilt, the row is read
 * back after 8 s, the catalogue filter returns the family server-side, the reset removes it, and an unrelated family is
 * asserted ABSENT in the same run as the positive control.
 *
 * The collision is written directly onto the coordinate's `variationTheme` rather than through
 * `PATCH /studio/projection`, for a reason worth stating: that endpoint now REFUSES this exact mapping with
 * `400 collision_unresolved` (VT.1's own keys-the-variants check), so the API cannot create the state its own filter is
 * supposed to find. A stored theme that drops an axis is how a real one arrives — from a publish, an import, or a rule.
 */
import '../src/env.js'
const API = process.argv[2] ?? 'http://127.0.0.1:8091'
const { default: p } = await import('../src/db.js')
const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const db = await p.$queryRawUnsafe<Array<{ db: string }>>(`SELECT current_database()::text AS db`)
const gale = await p.product.findFirst({ where: { sku: 'GALE-JACKET' }, select: { id: true, version: true } })
console.log(`DB ${j(db[0])} · DISCRIMINATOR GALE-JACKET Product.version ${gale!.version} (local 59 / Neon prod 51)`)

const fixture = await p.product.findFirstOrThrow({ where: { sku: 'VX-TEST-3AX' }, select: { id: true, variationAxes: true } })
const listing = await p.channelListing.findFirstOrThrow({
  where: { productId: fixture.id, channel: 'AMAZON', marketplace: 'IT' },
  select: { id: true, variationTheme: true, version: true, channelConnectionId: true },
})
console.log(`fixture ${fixture.id} axes ${j(fixture.variationAxes)} · AMAZON·IT listing ${listing.id} v${listing.version} theme ${j(listing.variationTheme)}`)

const { reconcileFamilyReadiness } = await import('../src/services/pim/readiness-index.service.js')
const indexRows = async (productId: string) => p.$queryRawUnsafe<Array<{ coordinateKey: string; variationSource: string | null; kinds: string | null }>>(
  `SELECT r."coordinateKey", r."variationSource",
          (SELECT string_agg(DISTINCT m->>'kind', ',') FROM jsonb_array_elements(r.missing) m WHERE m ? 'kind') AS kinds
     FROM "ReadinessIndex" r WHERE r."productId" = $1 AND r.channel = 'AMAZON' AND r.market = 'IT' ORDER BY r."coordinateKey"`,
  productId)
/** EVERY coordinate's provenance for one product — the filter is product-level, so this is what it actually sees. */
const allCoordinates = async (productId: string) => p.$queryRawUnsafe<Array<{ src: string | null; n: bigint; coords: string }>>(
  `SELECT r."variationSource" AS src, count(*)::bigint n,
          string_agg(DISTINCT coalesce(r.channel,'master') || '/' || coalesce(r.market,'-'), ', ' ORDER BY coalesce(r.channel,'master') || '/' || coalesce(r.market,'-')) AS coords
     FROM "ReadinessIndex" r WHERE r."productId" = $1 GROUP BY 1 ORDER BY 1 NULLS FIRST`, productId)
const filterIds = async (value: string) => {
  const res = await fetch(`${API}/api/products?limit=200&variationMapping=${encodeURIComponent(value)}`)
  const body = await res.json() as { products?: Array<{ id: string; sku: string }> }
  return { status: res.status, skus: (body.products ?? []).map((x) => x.sku) }
}

// ── BEFORE ───────────────────────────────────────────────────────────────────────────────────────
await reconcileFamilyReadiness(fixture.id)
await sleep(8500)
const before = await indexRows(fixture.id)
console.log(`\nBEFORE (theme ${j(listing.variationTheme)}) — ${before.length} AMAZON·IT index rows`)
console.log(`  parent row: ${j(before.find((r) => r.coordinateKey.includes('AMAZON')) ?? before[0])}`)
console.log(`  variationSource values: ${j([...new Set(before.map((r) => r.variationSource))])}`)
console.log(`  missing kinds: ${j([...new Set(before.map((r) => r.kinds).filter(Boolean))])}`)
// The POSITIVE CONTROL family: a second product carrying provenance, so `derived` matching is not "the only row there".
const controlSku = 'GALE-JACKET'
await reconcileFamilyReadiness(gale!.id)
await sleep(1000)
console.log(`  control family ${controlSku} coordinates: ${j(await allCoordinates(gale!.id))}`)
const beforeCollides = await filterIds('collides')
console.log(`  filter collides → ${beforeCollides.status} ${beforeCollides.skus.length} products; VX-TEST-3AX present: ${beforeCollides.skus.includes('VX-TEST-3AX')}`)

// ── the fixture write: a stored theme that DROPS the size axis ────────────────────────────────────
const COLLIDING = 'COLOR_NAME/SIZE_NAME'.replace('/SIZE_NAME', '')  // one segment: colour only, so size AND fit type drop
console.log(`\nPREDICTION: storing theme ${j(COLLIDING)} on AMAZON·IT drops 2 of 3 axes, so the 4 children collide;`)
console.log(`  the index row gains variationSource 'overridden' and a 'collision' kind, and the filter returns VX-TEST-3AX.`)
await p.channelListing.update({ where: { id: listing.id }, data: { variationTheme: COLLIDING } })
await reconcileFamilyReadiness(fixture.id)
await sleep(8500)
const after = await indexRows(fixture.id)
console.log(`\nAFTER — ${after.length} AMAZON·IT index rows`)
console.log(`  variationSource values: ${j([...new Set(after.map((r) => r.variationSource))])}`)
console.log(`  missing kinds: ${j([...new Set(after.map((r) => r.kinds).filter(Boolean))])}`)
console.log(`  ALL coordinates: ${j(await allCoordinates(fixture.id))}`)
const collides = await filterIds('collides')
const derived = await filterIds('derived')
const overridden = await filterIds('overridden')
const unsupported = await filterIds('teleport')
console.log(`  filter collides    → ${collides.status} ${collides.skus.length} products; VX-TEST-3AX present: ${collides.skus.includes('VX-TEST-3AX')}`)
console.log(`  filter overridden  → ${overridden.status} ${overridden.skus.length} products; VX-TEST-3AX present: ${overridden.skus.includes('VX-TEST-3AX')}`)
console.log(`  filter derived     → ${derived.status} ${derived.skus.length} products; VX-TEST-3AX present: ${derived.skus.includes('VX-TEST-3AX')} — it has OTHER coordinates that ARE derived (see ALL coordinates above), which is what a product-level filter means`)
console.log(`  POSITIVE CONTROL   → ${controlSku} under derived: ${derived.skus.includes(controlSku)} · under collides: ${collides.skus.includes(controlSku)} (must be true then false)`)
console.log(`  filter teleport    → ${unsupported.status} ${unsupported.skus.length} products (an unsupported word narrows to nothing, never widens)`)

// ── the reset ────────────────────────────────────────────────────────────────────────────────────
await p.channelListing.update({ where: { id: listing.id }, data: { variationTheme: listing.variationTheme } })
await reconcileFamilyReadiness(fixture.id)
await sleep(8500)
const restored = await indexRows(fixture.id)
const afterReset = await filterIds('collides')
console.log(`\nRESTORED (theme back to ${j(listing.variationTheme)})`)
console.log(`  variationSource values: ${j([...new Set(restored.map((r) => r.variationSource))])}`)
console.log(`  missing kinds: ${j([...new Set(restored.map((r) => r.kinds).filter(Boolean))])}`)
console.log(`  filter collides → ${afterReset.skus.length} products; VX-TEST-3AX present: ${afterReset.skus.includes('VX-TEST-3AX')}`)
const finalTheme = await p.channelListing.findUniqueOrThrow({ where: { id: listing.id }, select: { variationTheme: true } })
console.log(`VERDICT  the fixture's stored theme is back to its BEFORE value: ${finalTheme.variationTheme === listing.variationTheme} (${j(finalTheme.variationTheme)})`)
await p.$disconnect()
