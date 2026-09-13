/**
 * VT.4b — the catalogue filter narrows SERVER-SIDE, proven with both controls in one run.
 *
 *   cd apps/api && npx tsx scripts/_vt4b-filter-proof.mts
 *
 * Announced in `docs/pes-claims.md` before it ran. Local Docker DB only; every step reads back after 8 s and
 * the fixture is restored BY VALUE.
 */
import '../src/env.js'
const API = process.argv[2] ?? 'http://127.0.0.1:8091'
const { default: p } = await import('../src/db.js')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const j = (v: unknown) => JSON.stringify(v)

const db = await p.$queryRawUnsafe<Array<{ db: string }>>('SELECT current_database()::text AS db')
const gale = await p.product.findFirstOrThrow({ where: { sku: 'GALE-JACKET' }, select: { id: true, version: true } })
console.log(`DB ${j(db[0])} · DISCRIMINATOR GALE-JACKET Product.version ${gale.version} (local 59 / Neon prod 51)`)

const fixture = await p.product.findFirstOrThrow({ where: { sku: 'VX-TEST-3AX' }, select: { id: true, variationAxes: true } })
const listing = await p.channelListing.findFirstOrThrow({
  where: { productId: fixture.id, channel: 'AMAZON', marketplace: 'IT' },
  select: { id: true, variationTheme: true, version: true },
})
console.log(`fixture ${fixture.id} axes ${j(fixture.variationAxes)} · AMAZON·IT listing v${listing.version} theme ${j(listing.variationTheme)}`)
const { reconcileFamilyReadiness } = await import('../src/services/pim/readiness-index.service.js')

/** The FILTER, through the same predicate the grid POST reaches. */
const viaGet = async (value: string) => {
  const res = await fetch(`${API}/api/products?limit=400&variationMapping=${encodeURIComponent(value)}`)
  const body = await res.json() as { products?: Array<{ sku: string }>; total?: number }
  const skus = (body.products ?? []).map((x) => x.sku)
  return { status: res.status, n: skus.length, total: body.total, vx: skus.includes('VX-TEST-3AX'), gale: skus.includes('GALE-JACKET') }
}
const viaGrid = async (values: string[]) => {
  const res = await fetch(`${API}/api/products/grid`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      request: { startRow: 0, endRow: 100, sortModel: [], groupKeys: [], rowGroupCols: [], valueCols: [], pivotCols: [], pivotMode: false, filterModel: {} },
      context: { tile: null, familyId: null, salesDays: 7, filters: { stock: [], fulfillment: [], families: [], workflowStages: [], missingChannels: [], variationMapping: values } },
    }),
  })
  const body = await res.json() as { rows?: Array<{ sku: string }>; rowCount?: number; unsupported?: string[] }
  const skus = (body.rows ?? []).map((x) => x.sku)
  return { status: res.status, n: skus.length, rowCount: body.rowCount, unsupported: body.unsupported, vx: skus.includes('VX-TEST-3AX'), gale: skus.includes('GALE-JACKET') }
}
const indexOf = async (productId: string) => p.$queryRawUnsafe<Array<{ label: string; src: string | null; kinds: string | null }>>(
  `SELECT r.label, r."variationSource" AS src,
          (SELECT string_agg(DISTINCT m->>'kind', ',') FROM jsonb_array_elements(r.missing) m WHERE m ? 'kind') AS kinds
     FROM "ReadinessIndex" r WHERE r."productId" = $1 AND r.channel = 'AMAZON' AND r.market = 'IT'`, productId)

await reconcileFamilyReadiness(fixture.id)
await reconcileFamilyReadiness(gale.id)
await sleep(8000)
console.log('\n── BEFORE ──────────────────────────────────────────────────────')
console.log('  fixture AMAZON·IT index:', j(await indexOf(fixture.id)))
for (const v of ['derived', 'rule', 'overridden', 'unset', 'collides', 'teleport']) console.log(`  GET  ?variationMapping=${v.padEnd(10)} → ${j(await viaGet(v))}`)
console.log('  GRID ["collides"]          →', j(await viaGrid(['collides'])))
console.log('  GRID ["derived"]           →', j(await viaGrid(['derived'])))
console.log('  GRID ["teleport"]          →', j(await viaGrid(['teleport'])))
console.log('  GRID []  (inactive)        →', j(await viaGrid([])))

console.log('\nPREDICTION: storing theme "COLOR_NAME" on AMAZON·IT drops size AND fit type, so the 4 children collide;')
console.log('            the AMAZON·IT index row should flip to missing kind `collision`, and `collides` should return')
console.log('            exactly VX-TEST-3AX and NOT GALE-JACKET.')
await p.channelListing.update({ where: { id: listing.id }, data: { variationTheme: 'COLOR_NAME' } })
await reconcileFamilyReadiness(fixture.id)
await sleep(8000)
console.log('\n── AFTER the fixture write ─────────────────────────────────────')
console.log('  fixture AMAZON·IT index:', j(await indexOf(fixture.id)))
for (const v of ['collides', 'overridden', 'derived']) console.log(`  GET  ?variationMapping=${v.padEnd(10)} → ${j(await viaGet(v))}`)
console.log('  GRID ["collides"]          →', j(await viaGrid(['collides'])))

await p.channelListing.update({ where: { id: listing.id }, data: { variationTheme: listing.variationTheme } })
await reconcileFamilyReadiness(fixture.id)
await sleep(8000)
console.log('\n── RESTORED (by value) ─────────────────────────────────────────')
console.log('  fixture AMAZON·IT index:', j(await indexOf(fixture.id)))
console.log('  GET  ?variationMapping=collides →', j(await viaGet('collides')))
const final = await p.channelListing.findUniqueOrThrow({ where: { id: listing.id }, select: { variationTheme: true, version: true } })
console.log(`VERDICT theme back to its BEFORE value: ${final.variationTheme === listing.variationTheme} (${j(final.variationTheme)}) · listing v${listing.version} → v${final.version}`)
