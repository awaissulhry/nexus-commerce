/**
 * VT.4b — arm or restore the fixture collision for the BROWSER reading. Announced in `docs/pes-claims.md`.
 *   cd apps/api && npx tsx scripts/_vt4b-arm.mts arm|restore
 * `VX-TEST-3AX` is DRAFT with no external id on any coordinate, so no push path can see this.
 */
import '../src/env.js'
const mode = process.argv[2]
if (mode !== 'arm' && mode !== 'restore') { console.error('usage: _vt4b-arm.mts arm|restore'); process.exit(64) }
const { default: p } = await import('../src/db.js')
const db = await p.$queryRawUnsafe<Array<{ db: string }>>('SELECT current_database()::text AS db')
const gale = await p.product.findFirstOrThrow({ where: { sku: 'GALE-JACKET' }, select: { version: true } })
if (db[0].db !== 'nexus_development') { console.error(`REFUSED: current_database() = ${db[0].db}`); process.exit(1) }
console.log(`DB ${db[0].db} · GALE-JACKET Product.version ${gale.version} (local 59 / Neon prod 51)`)
const fixture = await p.product.findFirstOrThrow({ where: { sku: 'VX-TEST-3AX' }, select: { id: true } })
const listing = await p.channelListing.findFirstOrThrow({
  where: { productId: fixture.id, channel: 'AMAZON', marketplace: 'IT' }, select: { id: true, variationTheme: true },
})
const { reconcileFamilyReadiness } = await import('../src/services/pim/readiness-index.service.js')
await p.channelListing.update({ where: { id: listing.id }, data: { variationTheme: mode === 'arm' ? 'COLOR_NAME' : null } })
await reconcileFamilyReadiness(fixture.id)
await new Promise((r) => setTimeout(r, 8000))
const after = await p.$queryRawUnsafe<Array<{ src: string | null; kinds: string | null }>>(
  `SELECT r."variationSource" AS src, (SELECT string_agg(DISTINCT m->>'kind', ',') FROM jsonb_array_elements(r.missing) m WHERE m ? 'kind') AS kinds
     FROM "ReadinessIndex" r WHERE r."productId" = $1 AND r.channel = 'AMAZON' AND r.market = 'IT'`, fixture.id)
const theme = await p.channelListing.findUniqueOrThrow({ where: { id: listing.id }, select: { variationTheme: true } })
console.log(`${mode.toUpperCase()} → theme ${JSON.stringify(theme.variationTheme)} · AMAZON·IT index ${JSON.stringify(after)}`)
